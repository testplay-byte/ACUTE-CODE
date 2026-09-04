import { create } from "zustand";

/**
 * ROUND-61 (R61): the COMPUTER-USE MONITOR — the live state behind the
 * right-sidebar Computer panel AND the floating mini window (the owner's
 * directive: "in a mini window it will show the details and their stats
 * while the agent is using computers… what it's about to do, how it's
 * thinking, the progress").
 *
 * FEED SOURCES (merged into one shape):
 *   1. LIVE SSE frames — every computer-use tool execution emits
 *      {type:"computer-use", kind, tool?, code?} at dispatch time (the
 *      stream-store intercepts them BEFORE the liveTurn guard and calls
 *      pushLiveEvent here — the floating monitor surfaces update mid-turn,
 *      with zero polling latency).
 *   2. POLLED session state — GET /computer-use/session returns the
 *      sidecar's authoritative ring (labels + stats + kill-switch state);
 *      refreshFromServer() syncs it (the web pill polls 2s while visible;
 *      the desktop mini window's page polls the engine itself in
 *      src/mini/mini-client.ts — R64).
 *
 * The store keeps a capped local ring (newest-first, 200 — same cap as the
 * server) so a freshly mounted surface has history without waiting for a
 * poll. (ROUND-64: the old `miniWindowOpen` flag + its setter are GONE —
 * the surface is no longer manually popped out of the deleted right-sidebar
 * Computer panel; ComputerMiniWindow now AUTO-shows on the `liveActivity`
 * edge and the always-on-top OS window owns its own lifecycle.)
 */

export interface ComputerMonitorEvent {
  /** Local sequence (server rows keep their own; live frames get Date.now-based ids). */
  id: number;
  ts: number;
  /** observation | action | refusal | vision | session_start | session_stop. */
  kind: string;
  /** Human label — the server rows carry it; live frames build one from kind+tool. */
  label: string;
  tool?: string;
  /** Refusal error code (host_policy_denied, element_stale, …). */
  code?: string;
}

interface ComputerMonitorState {
  /** Newest-first capped ring. */
  events: ComputerMonitorEvent[];
  /** The session_state() snapshot from the sidecar (null before first poll). */
  session: {
    active: boolean;
    killSwitch: boolean;
    backendKind: string;
    startedAt: number | null;
    stopReason: string | null;
    stats: {
      startedAt: number;
      actionsSent: number;
      actionsRefused: number;
      observations: number;
      visionCalls: number;
    };
  } | null;
  /** True while at least one live computer-use frame arrived this turn. */
  liveActivity: boolean;
  /** The last error from polling/stop (honest display, cleared on success). */
  error: string | null;

  /** A live SSE frame landed (stream-store calls this). */
  pushLiveEvent: (frame: { kind: string; tool?: string; code?: string }) => void;
  /** Poll result → replace session + merge the ring (server labels win). */
  refreshFromServer: (state: {
    active: boolean;
    killSwitch: boolean;
    backendKind: string;
    startedAt: number | null;
    stopReason: string | null;
    stats: ComputerMonitorState["session"] extends null ? never : NonNullable<ComputerMonitorState["session"]>["stats"];
    events: Array<{ seq: number; ts: number; kind: string; label: string; tool?: string; detail?: Record<string, unknown> }>;
  }) => void;
  setLiveActivity: (active: boolean) => void;
  setError: (error: string | null) => void;
  /** Test/reset hook (also used when a new control session starts). */
  clear: () => void;
}

const RING_CAP = 200;
let nextLocalId = 1;

/** ROUND-66 (R66, A1/B1): how long after the LAST real computer-use event
 * the surface stays "live". The old signal never decayed — a stale
 * `sessionActive` (the singleton session stays active while Computer Use is
 * merely ENABLED) pinned `live` true forever, so the edge-triggered
 * open_computer_mini never re-fired after the mini page self-closed, and
 * browser-only turns (whose only computer-use frame was the browser
 * screenshot record — removed this round) left "Agent is using your
 * computer" stuck on screen. Real control events keep re-arming the decay;
 * 6s of silence = the agent stopped driving the desktop = hide. */
const LIVE_DECAY_MS = 6_000;

/** The decay timer (module-level — the store is a singleton). */
let liveDecayTimer: ReturnType<typeof setTimeout> | null = null;

/** Kinds that are CONTROL (bump + re-arm the decay) vs LIFECYCLE (session
 * bookkeeping — recorded in the ring but they do NOT mark "the agent is
 * driving the desktop right now"). session_stop additionally rests the
 * signal immediately. */
const LIFECYCLE_KINDS = new Set(["session_start"]);

function armLiveDecay(): void {
  if (liveDecayTimer !== null) clearTimeout(liveDecayTimer);
  liveDecayTimer = setTimeout(() => {
    liveDecayTimer = null;
    useComputerMonitorStore.setState({ liveActivity: false });
  }, LIVE_DECAY_MS);
}

/** Test/inspection hook: the decay armed? (drives deterministic tests). */
export function computerMonitorDecayArmed(): boolean {
  return liveDecayTimer !== null;
}

/** Test hook: cancel the pending decay + rest the signal (between tests). */
export function resetComputerMonitorDecayForTest(): void {
  if (liveDecayTimer !== null) {
    clearTimeout(liveDecayTimer);
    liveDecayTimer = null;
  }
  useComputerMonitorStore.setState({ liveActivity: false });
}

function kindLabel(kind: string, tool?: string): string {
  switch (kind) {
    case "session_start":
      return "Control session started";
    case "session_stop":
      return "Control session stopped";
    case "observation":
      return tool === "screenshot" ? "Screenshot observation" : `Observation: ${tool ?? "state"}`;
    case "action":
      return `Action: ${tool ?? "?"}`;
    case "refusal":
      return `Refused: ${tool ?? "policy"}${tool === undefined ? "" : ""}`;
    case "vision":
      return "Vision description";
    default:
      return `${kind}${tool !== undefined ? ` · ${tool}` : ""}`;
  }
}

export const useComputerMonitorStore = create<ComputerMonitorState>((set, get) => ({
  events: [],
  session: null,
  liveActivity: false,
  error: null,

  pushLiveEvent: (frame) => {
    const event: ComputerMonitorEvent = {
      id: nextLocalId++,
      ts: Date.now(),
      kind: frame.kind,
      label: kindLabel(frame.kind, frame.tool),
      tool: frame.tool,
      ...(frame.code !== undefined ? { code: frame.code } : {}),
    };
    const events = [event, ...get().events];
    if (events.length > RING_CAP) events.length = RING_CAP;
    set({ events });
    // ROUND-66 (R66, A1/B1): ONLY real control events mark "live" — the
    // decay (6s) rests it; session_start is bookkeeping (the singleton
    // session starting does not mean the desktop is being driven);
    // session_stop rests it immediately.
    if (frame.kind === "session_stop") {
      if (liveDecayTimer !== null) {
        clearTimeout(liveDecayTimer);
        liveDecayTimer = null;
      }
      set({ liveActivity: false });
    } else if (!LIFECYCLE_KINDS.has(frame.kind)) {
      set({ liveActivity: true });
      armLiveDecay();
    }
  },

  refreshFromServer: (state) => {
    // Server rows are authoritative: rebuild the ring from them (their
    // labels carry real detail: "Vision (main): …", "Owner declined: …").
    const events: ComputerMonitorEvent[] = state.events.slice(0, RING_CAP).map((row) => ({
      id: -row.seq,
      ts: row.ts,
      kind: row.kind,
      label: row.label,
      tool: row.tool,
      ...(row.detail !== undefined &&
      typeof row.detail === "object" &&
      row.detail !== null &&
      "code" in row.detail &&
      typeof (row.detail as { code?: unknown }).code === "string"
        ? { code: (row.detail as { code: string }).code }
        : {}),
    }));
    set({
      session: {
        active: state.active,
        killSwitch: state.killSwitch,
        backendKind: state.backendKind,
        startedAt: state.startedAt,
        stopReason: state.stopReason,
        stats: state.stats,
      },
      events,
      error: null,
    });
  },

  setLiveActivity: (active) => {
    // ROUND-66: manual control (tests + the stream-store's session_stop
    // intercept) — cancels any pending decay when resting.
    if (!active && liveDecayTimer !== null) {
      clearTimeout(liveDecayTimer);
      liveDecayTimer = null;
    }
    set({ liveActivity: active });
  },
  setError: (error) => set({ error }),
  clear: () => {
    if (liveDecayTimer !== null) {
      clearTimeout(liveDecayTimer);
      liveDecayTimer = null;
    }
    set({ events: [], session: null, liveActivity: false, error: null });
  },
}));

/** Test-only: reset the local id counter (stable snapshots across tests). */
export function resetComputerMonitorForTests(): void {
  nextLocalId = 1;
  useComputerMonitorStore.getState().clear();
}
