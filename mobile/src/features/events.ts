/**
 * events.ts — the phone's LIVE VIEW (R113-e: "the content does not update in
 * live view"). The backend's events fan-out (R113-a, agent-core
 * lib/events-bus.ts + GET /api/v1/events/stream) mirrors EVERY process-wide
 * change to every connected watcher; the desktop consumes it (R113-b's
 * src/lib/events-stream.ts); THIS module is the phone's half:
 *
 *   EventsStore       — the pure state: the stream's health + the REFRESH
 *                       EPOCHS (sessions / projects / settings — a monotonic
 *                       counter per world; screens refetch when one moves)
 *   EventsController  — the runtime leg: opens the stream while connected +
 *                       foregrounded (the R42 discipline — the verbatim
 *                       activity.ts lifecycle), drops the handle on transport
 *                       blips without flipping the link (R110 #1e: the
 *                       manager's hysteresis owns the global status)
 *
 * Wire contract (R113-a, commit 84f846f — mirrored from
 * agent-core/src/lib/events-bus.ts, nothing invented):
 *   data: {"type":"hello"}                        — once, on every (re)connect;
 *                                                   semantics: "resync everything"
 *   data: {"type":"session","sessionId","projectId","kind":"event"|"status"|"created","seq?","status?"}
 *   data: {"type":"turn","sessionId","frame":<the exact StreamTurnEvent the
 *          initiating socket received — published pre-serialization>}
 *   data: {"type":"project","projectId","kind":"created"|"updated"}
 *   data: {"type":"settings","domain","value"}
 *   : ping                                       — comment heartbeat, 10s
 * NO server-side session filtering — frames are filtered by sessionId
 * client-side (the v1 rule).
 *
 * DISPATCH (the built-in side effects — the desktop's handleEventsFrame
 * semantics, translated from react-query invalidations to epoch bumps):
 *   hello    → resync: sessions + projects + settings epochs all move (the
 *              screens' refetch hooks fire; whatever landed between the last
 *              received frame and this reconnect is caught by this sweep)
 *   session  → DEBOUNCED (~1s trailing batch) sessions+projects bump (a
 *              streaming turn appends log rows continuously — one refetch
 *              after the burst, never a per-token storm; the open session
 *              screen rehydrates on its OWN 800ms debounce via the frame
 *              listener below)
 *   turn     → LISTENERS ONLY (the open session screen mirrors the remote
 *              turn through features/sessions.ts's applyLiveFrame — it knows
 *              its own live handle, so the initiator's frames are ignored)
 *   project  → projects bump (a new project appears in the registry tab)
 *   settings → settings bump (open settings screens refetch) + listeners
 *              (the appearance domain applies live through the theme
 *              provider's echo-guarded apply path)
 * Every parsed frame ALSO reaches subscribeFrames listeners verbatim — the
 * session screen, the appearance sync leg, and any future consumer filter
 * locally (the same v1 client-side rule).
 *
 * Pure TS at the core (unit-testable without React Native); the controller
 * takes its environment injected exactly like activity.ts's does.
 */

import { useEffect, useState } from "react";
import { mobLog, mobWarn } from "@/lib/log";
import { getLinkManager } from "@/link/runtime";
import type { ConnectionManager, ConnectionStatus } from "@/link/connection";

// ── the wire shapes (agent-core lib/events-bus.ts EventsBusFrame, 1:1) ──────

/** One frame off the events stream. `turn.frame` is untyped on the wire —
 * the bus publishes the exact StreamTurnEvent the initiating socket
 * received; consumers shape-check at dispatch (never a guess). */
export type EventsFrame =
  | { type: "hello" }
  | {
      type: "session";
      sessionId: string;
      projectId: string | null;
      kind: "event" | "status" | "created";
      seq?: number;
      status?: string;
    }
  | { type: "turn"; sessionId: string; frame: unknown }
  | { type: "project"; projectId: string; kind: "created" | "updated" }
  | { type: "settings"; domain: string; value: unknown };

/** Parse one `data:` frame — null when it is neither known shape (the same
 * honest-skip guard parseActivityFrame carries; a malformed frame never
 * kills the stream). Optional fields are omitted, never undefined. */
export function parseEventsFrame(raw: string): EventsFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  switch (obj.type) {
    case "hello":
      return { type: "hello" };
    case "session": {
      if (typeof obj.sessionId !== "string") return null;
      if (obj.kind !== "event" && obj.kind !== "status" && obj.kind !== "created") return null;
      return {
        type: "session",
        sessionId: obj.sessionId,
        projectId: typeof obj.projectId === "string" ? obj.projectId : null,
        kind: obj.kind,
        ...(typeof obj.seq === "number" ? { seq: obj.seq } : {}),
        ...(typeof obj.status === "string" ? { status: obj.status } : {}),
      };
    }
    case "turn": {
      if (typeof obj.sessionId !== "string") return null;
      return { type: "turn", sessionId: obj.sessionId, frame: obj.frame };
    }
    case "project": {
      if (typeof obj.projectId !== "string") return null;
      if (obj.kind !== "created" && obj.kind !== "updated") return null;
      return { type: "project", projectId: obj.projectId, kind: obj.kind };
    }
    case "settings": {
      if (typeof obj.domain !== "string") return null;
      return { type: "settings", domain: obj.domain, value: obj.value };
    }
    default:
      return null;
  }
}

/**
 * A `turn` frame's inner mirror, shape-checked into the record applyLiveFrame
 * consumes. The wire field is untyped by contract — a non-object or an
 * object without a string `type` is a malformed mirror, never a guess.
 * (The desktop inlines this check in handleEventsFrame; the phone shares
 * the verdict through one pure helper so the session screen and the tests
 * agree on it.)
 */
export function turnFrameRecord(frame: unknown): Record<string, unknown> | null {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return null;
  const record = frame as Record<string, unknown>;
  if (typeof record.type !== "string") return null;
  return record;
}

// ── the pure store ──────────────────────────────────────────────────────────

export interface EventsState {
  /** The live stream's health (for honest status lines). */
  streamLive: boolean;
  /** Moves when the sessions world changed (hello, a debounced session-frame
   *  batch) — the sessions lists refetch. */
  sessionsEpoch: number;
  /** Moves when the projects world changed (hello, session "created", a
   *  project frame, the debounced session batch — counts change). */
  projectsEpoch: number;
  /** Moves when a settings domain was PUT anywhere (hello included) — the
   *  open settings screens refetch. */
  settingsEpoch: number;
}

export class EventsStore {
  private state: EventsState = {
    streamLive: false,
    sessionsEpoch: 0,
    projectsEpoch: 0,
    settingsEpoch: 0,
  };
  private listeners = new Set<() => void>();
  private frameListeners = new Set<(frame: EventsFrame) => void>();

  getState(): EventsState {
    return this.state;
  }

  /** State (epoch) listeners — the screens' refetch triggers. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * RAW frame listeners — every parsed frame, verbatim. The open session
   * screen (remote turn mirrors, per-session rehydrates) and the appearance
   * sync leg (settings/appearance) filter locally. Subscriber throws are
   * logged + skipped — the events-bus contract (a watcher's bug must never
   * kill the stream for everyone else).
   */
  subscribeFrames(listener: (frame: EventsFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** Forward one parsed frame (the controller calls this after dispatch). */
  notifyFrame(frame: EventsFrame): void {
    for (const listener of this.frameListeners) {
      try {
        listener(frame);
      } catch (err) {
        mobWarn("events", "frame listener threw", {
          type: frame.type,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  setStreamLive(streamLive: boolean): void {
    if (this.state.streamLive === streamLive) return;
    this.state = { ...this.state, streamLive };
    this.emit();
  }

  /** hello — "resync everything": every world's screens refetch. */
  resync(): void {
    this.state = {
      ...this.state,
      sessionsEpoch: this.state.sessionsEpoch + 1,
      projectsEpoch: this.state.projectsEpoch + 1,
      settingsEpoch: this.state.settingsEpoch + 1,
    };
    this.emit();
  }

  /** A session-scoped change settled (the debounced batch): session lists
   * AND project counts move (a new session may belong to a project this
   * client doesn't know yet; running-session dots flip). */
  bumpSessions(): void {
    this.state = {
      ...this.state,
      sessionsEpoch: this.state.sessionsEpoch + 1,
      projectsEpoch: this.state.projectsEpoch + 1,
    };
    this.emit();
  }

  bumpProjects(): void {
    this.state = { ...this.state, projectsEpoch: this.state.projectsEpoch + 1 };
    this.emit();
  }

  bumpSettings(): void {
    this.state = { ...this.state, settingsEpoch: this.state.settingsEpoch + 1 };
    this.emit();
  }

  /** Test seam. */
  reset(): void {
    this.state = { streamLive: false, sessionsEpoch: 0, projectsEpoch: 0, settingsEpoch: 0 };
    this.emit();
  }
}

// ── the controller (the runtime leg) ────────────────────────────────────────

export interface EventsEnv {
  manager: ConnectionManager;
}

/**
 * Debounce window for `session` frames (ms) — the mobile counterpart of the
 * desktop's 300ms invalidation debounce, widened per the R113-e spec: a
 * streaming turn appends log rows continuously (every tool result, every
 * text event → a session frame), and collapsing the burst into ONE trailing
 * refetch keeps the stream from machine-gunning the sessions/projects lists
 * at per-token speed. 1s is long enough to swallow a fast tool loop's
 * frames, short enough that a turn's START still feels live on the lists
 * (the open session screen has its own faster 800ms path via the frame
 * listener — the lists are second-class here by design).
 */
const SESSION_REFRESH_DEBOUNCE_MS = 1_000;

export class EventsController {
  private store: EventsStore;
  private env: EventsEnv | null = null;
  private stream: { close(): void } | null = null;
  private started = false;
  private status: ConnectionStatus = "unpaired";
  private foreground = true;
  private sessionTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(store: EventsStore) {
    this.store = store;
  }

  start(env: EventsEnv): void {
    if (this.started) return;
    this.started = true;
    this.env = env;
    this.env.manager.subscribe(() => this.sync());
    mobLog("events", "controller started");
    this.sync();
  }

  /** The foreground poke (AppState active/inactive drives the R42 discipline). */
  setForeground(active: boolean): void {
    if (this.foreground === active) return;
    this.foreground = active;
    mobLog("events", `foreground → ${active}`);
    this.sync();
  }

  private sync(): void {
    if (!this.env) return;
    const status = this.env.manager.getStatus();
    const shouldHold = status === "connected" && this.foreground;
    if (status !== this.status) {
      this.status = status;
      mobLog("events", `link status → ${status}`);
    }
    if (shouldHold && this.stream === null) {
      this.openStream();
    } else if (!shouldHold && this.stream !== null) {
      this.closeStream("link state changed");
    }
  }

  private openStream(): void {
    if (!this.env) return;
    try {
      const stream = this.env.manager.sse("/api/v1/events/stream");
      mobLog("events", "stream opened");
      this.store.setStreamLive(true);
      stream.addEventListener("data", (ev) => {
        const frame = parseEventsFrame(ev.data);
        if (frame === null) return;
        this.handleFrame(frame);
      });
      stream.addEventListener("error", (err) => {
        // R110 #1e (the activity controller's exact discipline): the handle
        // is dead but the LINK verdict is NOT ours to flip — the manager's
        // hysteresis-verified probe owns the global status. Drop the handle
        // so the manager's next verified state change re-opens cleanly.
        mobWarn("events", "stream error", { kind: err.kind, message: err.message });
        this.stream = null;
        this.store.setStreamLive(false);
      });
      stream.addEventListener("close", () => {
        mobLog("events", "stream closed by host");
        this.store.setStreamLive(false);
        this.stream = null;
      });
      this.stream = stream;
    } catch (err) {
      mobWarn("events", "stream open failed", err instanceof Error ? err.message : err);
    }
  }

  private closeStream(reason: string): void {
    if (this.stream === null) return;
    mobLog("events", `stream closed (${reason})`);
    try {
      this.stream.close();
    } catch {
      // close() is documented safe-more-than-once; a throw is still honest to log.
    }
    this.stream = null;
    this.store.setStreamLive(false);
  }

  /**
   * The dispatch — one parsed frame → the store's epochs + the raw frame
   * listeners. Public on purpose: it is the seam the tests drive (and any
   * future in-process publisher), with zero transport in sight.
   */
  handleFrame(frame: EventsFrame): void {
    switch (frame.type) {
      case "hello": {
        // The resync sweep — hello means "you may have missed everything
        // while disconnected": all three worlds move at once.
        mobLog("events", "hello — resync");
        this.store.resync();
        break;
      }
      case "session": {
        this.scheduleSessionsRefresh();
        break;
      }
      case "turn": {
        // Listeners only — the open session screen owns the mirror (and
        // knows whether IT initiated the turn; a mirror of your own stream
        // would double every delta).
        break;
      }
      case "project": {
        this.store.bumpProjects();
        break;
      }
      case "settings": {
        this.store.bumpSettings();
        break;
      }
    }
    this.store.notifyFrame(frame);
  }

  /** Schedule the debounced sessions/projects refresh (the batch). */
  private scheduleSessionsRefresh(): void {
    if (this.sessionTimer !== undefined) clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = undefined;
      this.store.bumpSessions();
    }, SESSION_REFRESH_DEBOUNCE_MS);
  }

  /** Test seam: drop a pending debounced refresh (between test cases the
   * timer would otherwise fire into a detached store). */
  resetForTest(): void {
    if (this.sessionTimer !== undefined) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = undefined;
    }
  }
}

// ── the singletons + hooks ──────────────────────────────────────────────────

const eventsStore = new EventsStore();
const eventsController = new EventsController(eventsStore);

export function getEventsStore(): EventsStore {
  return eventsStore;
}

/**
 * Wire the controller to the app (the root layout calls this once, beside
 * startActivity). The stream lives while connected + foregrounded (the R42
 * discipline); the hello frame on every (re)open drives the resync.
 */
export function startEvents(): void {
  if (eventsStarted) return;
  eventsStarted = true;
  eventsController.start({ manager: getLinkManager() });
  const { AppState } = require("react-native") as typeof import("react-native");
  AppState.addEventListener("change", (state) => {
    eventsController.setForeground(state === "active");
  });
}

let eventsStarted = false;

/** The epoch hook — the refetch trigger the list screens consume. Returns
 *  a monotonic counter per world; an effect keyed on it refetches when the
 *  world changed (0 = "never moved" — the screens' own mount/connect loads
 *  cover that; skipping the initial epoch avoids a duplicate first fetch). */
export function useEventsEpoch(kind: "sessions" | "projects" | "settings"): number {
  const [epoch, setEpoch] = useState(() => eventsStore.getState()[`${kind}Epoch`]);
  useEffect(() => {
    setEpoch(eventsStore.getState()[`${kind}Epoch`]);
    return eventsStore.subscribe(() => {
      setEpoch(eventsStore.getState()[`${kind}Epoch`]);
    });
  }, [kind]);
  return epoch;
}
