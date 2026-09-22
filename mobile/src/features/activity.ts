/**
 * activity.ts — the LIVE notification feed (R109: "it should be live like a
 * WebSockets kind of experience... so that it is instantaneous").
 *
 * The desktop exposes GET /api/v1/notifications/stream — a global SSE
 * channel (hello frame `{type:"hello", unread}` then every published
 * notification record). This module owns the phone's end:
 *
 *   ActivityStore       — the pure state (unread count + the latest ring)
 *   ActivityController  — the runtime leg: opens the stream while
 *                         connected + foregrounded, closes it otherwise
 *                         (the R42 discipline), refreshes on reconnect,
 *                         owns mark-read calls
 *   useUnread()         — the badge hook (the bell + the tab bar)
 *   useActivityFeed()   — the activity screen's data hook
 *
 * R110 #1e (v0.106.0): a stream transport error no longer assumes the LINK
 * is down — the connection manager verifies with its probe ladder and its
 * HYSTERESIS owns the global status. The controller just drops the dead
 * handle (setStreamLive(false), this.stream = null) and lets the manager's
 * next verified state change re-open the stream: a transient blip heals
 * silently (probe succeeds → notify → re-open), a real outage flips offline
 * (notify → close) and the eventual reconnect refreshes + re-opens. With the
 * desktop's 10s SSE heartbeats (v0.106.0 server side) idle-time disconnects
 * disappear on their own; this side must simply not tear the state down on
 * blips.
 *
 * R116-f (round-116 §1.4 — the mark-all-read desync): the hello frame sets
 * the COUNT only, so the rows could sit read:0 while unread===0 (which hid
 * the button AND early-returned the mutation), and a failed clear-all was
 * silent. The store now RECONCILES: setUnread flips the ring's flags to
 * match the count (reconcileUnreadFlags), markAllRead has no unread===0
 * early-return, and the screen owns the honest failure note.
 *
 * Pure TS at the core (unit-testable without React Native); the controller
 * takes its environment injected the same way the link manager does.
 */

import { useEffect, useState } from "react";
import { apiJson } from "./api";
import { mobLog, mobWarn } from "@/lib/log";
import { getLinkManager } from "@/link/runtime";
import type { ConnectionManager, ConnectionStatus } from "@/link/connection";

// ── the wire shapes (server.ts /notifications routes, 1:1) ──────────────────

export interface NotificationRow {
  id: string;
  ts: string;
  kind: string;
  title: string;
  body: string;
  sessionId: string | null;
  projectId: string | null;
  read: 0 | 1;
}

export interface NotificationsPage {
  notifications: NotificationRow[];
  unread: number;
}

/** A parsed stream frame: hello | a notification record. */
export type ActivityFrame =
  | { type: "hello"; unread: number }
  | ({ type: "notification" } & NotificationRow);

/** Parse one `data:` frame — null when it is neither known shape (honest skip). */
export function parseActivityFrame(raw: string): ActivityFrame | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.type === "hello" && typeof obj.unread === "number") {
      return { type: "hello", unread: obj.unread };
    }
    if (
      typeof obj.id === "string" &&
      typeof obj.ts === "string" &&
      typeof obj.kind === "string" &&
      typeof obj.title === "string"
    ) {
      return {
        type: "notification",
        id: obj.id,
        ts: obj.ts,
        kind: obj.kind,
        title: obj.title,
        body: typeof obj.body === "string" ? obj.body : "",
        sessionId: typeof obj.sessionId === "string" ? obj.sessionId : null,
        projectId: typeof obj.projectId === "string" ? obj.projectId : null,
        read: obj.read === 1 || obj.read === true ? 1 : 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ── the pure store ──────────────────────────────────────────────────────────

export interface ActivityState {
  unread: number;
  /** The latest notifications, newest first (a small ring, max 30). */
  latest: NotificationRow[];
  /** The live stream's health (for honest status lines). */
  streamLive: boolean;
}

const RING_MAX = 30;

/**
 * R116-f (round-116 §1.4 — the mark-all-read desync): the SSE hello frame
 * carries ONLY the unread count, so the ring's row flags are reconciled to
 * it here, best effort:
 *
 *   · count 0     → every row reads read (the ring can never paint an unread
 *                   dot while the badge says zero — the desync the owner saw);
 *   · count N > 0 → the NEWEST N rows render unread and everything older
 *                   reads read. The desktop counts newest-first, so the
 *                   newest-N guess is the honest one; when N exceeds the
 *                   ring (max 30) everything we hold renders unread.
 *
 * A row already carrying the wanted flag keeps its object identity (a no-op
 * pass returns the SAME array, so setUnread emits nothing); this never
 * grows or reorders the ring — it only flips flags.
 */
function reconcileUnreadFlags(latest: NotificationRow[], unread: number): NotificationRow[] {
  let changed = false;
  const next = latest.map((row, index) => {
    const wantUnread = unread > 0 && index < unread;
    if (wantUnread ? row.read === 1 : row.read === 0) {
      changed = true;
      return { ...row, read: (wantUnread ? 0 : 1) as 0 | 1 };
    }
    return row;
  });
  return changed ? next : latest;
}

export class ActivityStore {
  private state: ActivityState = { unread: 0, latest: [], streamLive: false };
  private listeners = new Set<() => void>();

  getState(): ActivityState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  setUnread(unread: number): void {
    const next = Math.max(0, unread);
    // R116-f §1.4: the count RECONCILES the ring — after this call the row
    // flags and the badge can never disagree (the hello frame's count is
    // the server's truth; see reconcileUnreadFlags for the heuristic). A
    // true no-op (same count, no flips) stays quiet.
    const latest = reconcileUnreadFlags(this.state.latest, next);
    if (this.state.unread === next && latest === this.state.latest) return;
    this.state = { ...this.state, unread: next, latest };
    this.emit();
  }

  setStreamLive(streamLive: boolean): void {
    if (this.state.streamLive === streamLive) return;
    this.state = { ...this.state, streamLive };
    this.emit();
  }

  /** A page from GET /notifications (the refresh path). */
  applyPage(page: NotificationsPage): void {
    this.state = { ...this.state, unread: Math.max(0, page.unread), latest: page.notifications.slice(0, RING_MAX) };
    this.emit();
  }

  /** One live notification arrived off the stream. */
  applyLiveNotification(row: NotificationRow): void {
    const seen = this.state.latest.some((n) => n.id === row.id);
    const latest = [row, ...this.state.latest.filter((n) => n.id !== row.id)].slice(0, RING_MAX);
    // A re-delivered row never double-counts (the stream is at-least-once).
    const unread = row.read === 0 && !seen ? this.state.unread + 1 : this.state.unread;
    this.state = { ...this.state, latest, unread };
    this.emit();
  }

  markRead(id: string): void {
    let changed = false;
    const latest = this.state.latest.map((n) => {
      if (n.id === id && n.read === 0) {
        changed = true;
        return { ...n, read: 1 as const };
      }
      return n;
    });
    if (!changed) return;
    this.state = { ...this.state, latest, unread: Math.max(0, this.state.unread - 1) };
    this.emit();
  }

  markAllRead(): void {
    // R116-f §1.4: NO unread===0 early-return — the desync fix. The rows can
    // sit read:0 while unread===0 (a hello that only set the count, a page
    // whose rows carry stale flags), so the count alone must never gate the
    // mutation: always flip every row to read:1 and zero the count. A true
    // no-op (already zero AND every row already read) stays quiet —
    // subscribers only hear real changes.
    if (this.state.unread === 0 && this.state.latest.every((n) => n.read === 1)) return;
    this.state = {
      ...this.state,
      unread: 0,
      latest: this.state.latest.map((n) => ({ ...n, read: 1 as const })),
    };
    this.emit();
  }

  /** Test seam. */
  reset(): void {
    this.state = { unread: 0, latest: [], streamLive: false };
    this.emit();
  }
}

// ── the controller (the runtime leg) ────────────────────────────────────────

export interface ActivityEnv {
  manager: ConnectionManager;
}

export class ActivityController {
  private store: ActivityStore;
  private env: ActivityEnv | null = null;
  private stream: { close(): void } | null = null;
  private started = false;
  private status: ConnectionStatus = "unpaired";
  private foreground = true;

  constructor(store: ActivityStore) {
    this.store = store;
  }

  start(env: ActivityEnv): void {
    if (this.started) return;
    this.started = true;
    this.env = env;
    this.env.manager.subscribe(() => this.sync());
    mobLog("activity", "controller started");
    this.sync();
  }

  /** The foreground poke (AppState active/inactive drives the R42 discipline). */
  setForeground(active: boolean): void {
    if (this.foreground === active) return;
    this.foreground = active;
    mobLog("activity", `foreground → ${active}`);
    this.sync();
  }

  private sync(): void {
    if (!this.env) return;
    const status = this.env.manager.getStatus();
    const shouldHold = status === "connected" && this.foreground;
    const becameConnected = status === "connected" && this.status !== "connected";
    if (status !== this.status) {
      this.status = status;
      mobLog("activity", `link status → ${status}`);
    }
    // Every (re)connect re-reads the true unread page — the stream's hello
    // covers the steady state, this covers the gap while we were offline.
    if (becameConnected) {
      void this.refresh().catch(() => {});
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
      const stream = this.env.manager.sse("/api/v1/notifications/stream");
      mobLog("activity", "stream opened");
      this.store.setStreamLive(true);
      stream.addEventListener("data", (ev) => {
        const frame = parseActivityFrame(ev.data);
        if (frame === null) return;
        if (frame.type === "hello") {
          this.store.setUnread(frame.unread);
          mobLog("activity", "hello", { unread: frame.unread });
        } else {
          const { type: _type, ...row } = frame;
          this.store.applyLiveNotification(row);
          mobLog("activity", "notification", { kind: row.kind, title: row.title });
        }
      });
      stream.addEventListener("error", (err) => {
        // R110 #1e: the handle is dead but the LINK verdict is NOT ours to
        // flip — the manager's hysteresis-verified probe owns the global
        // status. Drop the handle so the manager's next verified state
        // change re-opens cleanly; the honest detail lands in the log.
        mobWarn("activity", "stream error", { kind: err.kind, message: err.message });
        this.stream = null;
        this.store.setStreamLive(false);
      });
      stream.addEventListener("close", () => {
        mobLog("activity", "stream closed by host");
        this.store.setStreamLive(false);
        this.stream = null;
      });
      this.stream = stream;
    } catch (err) {
      mobWarn("activity", "stream open failed", err instanceof Error ? err.message : err);
    }
  }

  private closeStream(reason: string): void {
    if (this.stream === null) return;
    mobLog("activity", `stream closed (${reason})`);
    try {
      this.stream.close();
    } catch {
      // close() is documented safe-more-than-once; a throw is still honest to log.
    }
    this.stream = null;
    this.store.setStreamLive(false);
  }

  /** The refresh path — GET /notifications (the page + the true unread). */
  async refresh(limit = 30): Promise<void> {
    if (!this.env) return;
    const outcome = await apiJson<NotificationsPage>(this.env.manager, `/notifications?limit=${limit}`);
    if (outcome.ok) {
      this.store.applyPage(outcome.data);
      mobLog("activity", "page refreshed", { unread: outcome.data.unread });
    } else {
      mobWarn("activity", "page refresh failed", { status: outcome.error.status, code: outcome.error.code });
    }
  }

  /** Mark one notification read (the row's tap-through). R118-B: the POST
   *  carries `bodyText: "{}"` — the Kotlin module's strict body rule rejects
   *  bodyless POSTs BEFORE any socket opens (AcuteNetModule.kt), which made
   *  every mark-read die instantly with zero network activity; this was one
   *  of the app's only two bodyless POST sites (the house pattern:
   *  sessions.ts's read routes). */
  async markRead(id: string): Promise<boolean> {
    if (!this.env) return false;
    const outcome = await apiJson<{ ok: boolean; unread: number }>(this.env.manager, `/notifications/${id}/read`, {
      method: "POST",
      bodyText: "{}",
    });
    if (outcome.ok) {
      this.store.markRead(id);
      return true;
    }
    mobWarn("activity", "mark read failed", { id, status: outcome.error.status });
    return false;
  }

  /** Mark everything read (the bell's clear-all). R118-B: same bodyText fix
   *  as markRead — the module rejected the bodyless POST instantly (the
   *  owner's "as soon as I clicked, it fails" mark-all-read bug). */
  async markAllRead(): Promise<boolean> {
    if (!this.env) return false;
    const outcome = await apiJson<{ ok: boolean; cleared: number }>(this.env.manager, "/notifications/read-all", {
      method: "POST",
      bodyText: "{}",
    });
    if (outcome.ok) {
      this.store.markAllRead();
      mobLog("activity", "all read", { cleared: outcome.data.cleared });
      return true;
    }
    mobWarn("activity", "mark all read failed", { status: outcome.error.status });
    return false;
  }
}

// ── the singletons + hooks ──────────────────────────────────────────────────

const activityStore = new ActivityStore();
const activityController = new ActivityController(activityStore);

export function getActivityStore(): ActivityStore {
  return activityStore;
}

/**
 * Wire the controller to the app (the root layout calls this once). The
 * stream lives while connected + foregrounded (the R42 discipline) and the
 * unread page refreshes on every (re)connect.
 */
export function startActivity(): void {
  if (activityStarted) return;
  activityStarted = true;
  activityController.start({ manager: getLinkManager() });
  // The LAZY require is deliberate (the header's "pure TS at the core"
  // posture — react-native must not load at module time, only when the app
  // actually boots the controller); events.ts rides the same seam.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AppState } = require("react-native") as typeof import("react-native");
  AppState.addEventListener("change", (state) => {
    activityController.setForeground(state === "active");
  });
  void activityController.refresh().catch(() => {});
}

let activityStarted = false;

/** The unread badge hook — the bell + the tab bar. */
export function useUnread(): number {
  const [unread, setUnread] = useState(activityStore.getState().unread);
  useEffect(() => {
    setUnread(activityStore.getState().unread);
    return activityStore.subscribe(() => {
      setUnread(activityStore.getState().unread);
    });
  }, []);
  return unread;
}

/** The activity screen's data hook. */
export function useActivityFeed(): {
  state: ActivityState;
  refresh: () => Promise<void>;
  markRead: (id: string) => Promise<boolean>;
  markAllRead: () => Promise<boolean>;
} {
  const [state, setState] = useState<ActivityState>(activityStore.getState());
  useEffect(() => {
    setState(activityStore.getState());
    return activityStore.subscribe(() => {
      setState(activityStore.getState());
    });
  }, []);
  return {
    state,
    refresh: () => activityController.refresh(),
    markRead: (id) => activityController.markRead(id),
    markAllRead: () => activityController.markAllRead(),
  };
}
