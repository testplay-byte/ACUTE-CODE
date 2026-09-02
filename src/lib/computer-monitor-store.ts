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
 *      pushLiveEvent here — the panel + mini window update mid-turn,
 *      with zero polling latency).
 *   2. POLLED session state — GET /computer-use/session returns the
 *      sidecar's authoritative ring (labels + stats + kill-switch state);
 *      refreshFromServer() syncs it (the panel polls 2s while active).
 *
 * The store keeps a capped local ring (newest-first, 200 — same cap as the
 * server) so a freshly mounted panel/mini-window has history without
 * waiting for a poll. The mini window's open/closed + drag position live
 * here too (persisted separately by the component — position is a UI
 * concern, this store keeps the transient state).
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
  /** The floating mini window. */
  miniWindowOpen: boolean;
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
  setMiniWindowOpen: (open: boolean) => void;
  setLiveActivity: (active: boolean) => void;
  setError: (error: string | null) => void;
  /** Test/reset hook (also used when a new control session starts). */
  clear: () => void;
}

const RING_CAP = 200;
let nextLocalId = 1;

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
  miniWindowOpen: false,
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
    set({
      events,
      liveActivity: true,
      // A session_stop frame means the control session ended — flip
      // liveActivity off after a beat (the caller's turn may continue).
      ...(frame.kind === "session_stop" ? {} : {}),
    });
    if (frame.kind === "session_stop") {
      // Keep the ring; the "live" badge rests until the next activity.
      set({ liveActivity: false });
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

  setMiniWindowOpen: (open) => set({ miniWindowOpen: open }),
  setLiveActivity: (active) => set({ liveActivity: active }),
  setError: (error) => set({ error }),
  clear: () => set({ events: [], session: null, liveActivity: false, error: null }),
}));

/** Test-only: reset the local id counter (stable snapshots across tests). */
export function resetComputerMonitorForTests(): void {
  nextLocalId = 1;
  useComputerMonitorStore.getState().clear();
  useComputerMonitorStore.setState({ miniWindowOpen: false });
}
