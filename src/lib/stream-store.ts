import { create } from "zustand";
import {
  streamSessionMessage,
  stopSessionTurn,
  type StreamTurnEvent,
  type SubAgentInnerEvent,
  type ToolUseEntry,
  type WorkingEntry,
} from "./api";
import { useActiveStreams } from "./active-streams";
import { getQueryClient } from "./query-client";

/**
 * ROUND-39 (owner: "It should keep the sessions going in the background even
 * if I change any pages or anything like that. If I go to the settings page,
 * if I go to some other projects page or anything like that, the session
 * should continue to work."). The streaming state previously lived in
 * AgentChatPanel component state — when the panel unmounted (project switch,
 * settings nav), the stream's UI state was destroyed and the live progress
 * was lost on return. This module-level store LIFTS the streaming state out
 * of the component lifecycle: the fetch + state updates run regardless of
 * which panel is mounted, so a session keeps streaming in the background and
 * the user returns to its current live progress.
 *
 * Keyed by sessionId — each session has its own liveTurn/streamBusy/etc.
 * The panel reads its session's slice; multiple sessions can stream in
 * parallel (different projects' active sessions). The AbortController lives
 * in a module-level Map (not React state) so it survives remounts.
 */

/** The live turn state — same shape the folded log produces. */
export interface LiveTurn {
  startedAtMs: number;
  /** Completed working entries (thoughts done, narration flushed in, tools). */
  working: WorkingEntry[];
  /** The presumptive-FINAL text streaming below the section. */
  streamText: string;
  /** The in-flight thought (auto-expanded row in the section). */
  streamThinking: string;
  /** Terminal state after a stream error — frozen "Stopped" section. */
  stopped: boolean;
}

/**
 * ROUND-43: a turn-level failure (provider error, internal crash, or the
 * stream dying mid-flight). Rendered as the timeline error card while the
 * refetched event log catches up — the persisted `turn.error` event then
 * takes over the render, so the card survives reloads.
 */
export interface TurnErrorInfo {
  code: string;
  message: string;
  status?: number;
  model?: string;
  providerError?: string;
  /** The ts of the PERSISTED turn.error event, when the backend recorded
   * one — used to swap the live card for the folded one without a flash or
   * a duplicate. */
  errorTs?: string;
  ts: string;
}

/**
 * ROUND-48 (R48-e2, owner: the Delegated card "was just saying Running
 * Running Running with no progress and nothing clickable"): the LIVE
 * sub-agent map. Every `subagent-status` SSE frame on the parent's stream
 * upserts one entry per child (keyed by the child session id); wrapped
 * tool-call/tool-result events refresh `lastActivity` so the Delegated
 * card's rows show what the child is doing RIGHT NOW without waiting for
 * the next poll. The polled GET /sessions/:id/subagents query remains the
 * source of truth for tokens/report/error — the map is the freshest
 * status/activity snapshot + the code/role used for approval attribution.
 */
export interface SubAgentLiveEntry {
  childSessionId: string;
  parentSessionId: string;
  /** Deterministic 4-char [A-Z0-9] code (same as the /subagents row). */
  code: string;
  role: string;
  task: string;
  status: "queued" | "running" | "completed" | "failed";
  todosDone?: number;
  todosTotal?: number;
  /** Human summary of the child's latest tool step (tool name + arg/output
   * snippet) — the Delegated row's activity line. */
  lastActivity?: string;
  /** Wall-clock ms of the last live update (frame ordering/debug aid). */
  updatedAtMs: number;
}

export interface StreamSessionState {
  liveTurn: LiveTurn | null;
  streamBusy: boolean;
  sendError: string | null;
  /** ROUND-43: the LIVE turn error (renders the error card immediately —
   * cleared once the folded event log carries the persisted turn.error). */
  liveError: TurnErrorInfo | null;
  pendingEcho: string | null;
  /** When the last live turn ended (for collapseHints). */
  lastLiveEndMs: number;
}

interface StreamStore {
  bySession: Record<string, StreamSessionState>;
  /** ROUND-48 (R48-e2): live sub-agent map, keyed by CHILD session id —
   * upserted from subagent-status frames + tool-call/tool-result inner
   * events (see SubAgentLiveEntry). Independent of bySession so it keeps
   * working across panel remounts, exactly like the rest of the store. */
  subagentsLive: Record<string, SubAgentLiveEntry>;
  /** Start a streamed turn — runs in the background; resolves on end/abort. */
  startStream: (
    sessionId: string,
    text: string,
    opts?: { model?: string },
  ) => Promise<void>;
  /** User clicked Stop — aborts the in-flight fetch. */
  abortStream: (sessionId: string) => void;
  /** Clear state for a session (new session / explicit reset). */
  clearStream: (sessionId: string) => void;
  /** Resolve a live approval row (decision landed). */
  resolveApprovalInLiveTurn: (
    sessionId: string,
    approvalId: string,
    decision: "approved" | "denied" | "expired",
    remember?: "once" | "always",
  ) => void;
  /** Set/clear a pending echo (the user message bubble shown before the
   * stream's first event lands). */
  setPendingEcho: (sessionId: string, text: string | null) => void;
  /** Set/clear a send error (shown in the error banner). */
  setSendError: (sessionId: string, msg: string | null) => void;
  /** ROUND-43: clear the live turn-error card (the persisted turn.error
   * event now renders from the folded log — no duplicates). */
  clearLiveError: (sessionId: string) => void;
}

/** Module-level controllers + seq counters (NOT React state — they don't
 * trigger renders; they survive remounts). */
const controllers = new Map<string, AbortController>();
const seqCounters = new Map<string, number>();

function getSeq(sessionId: string): number {
  const cur = seqCounters.get(sessionId) ?? -1;
  const next = cur - 1;
  seqCounters.set(sessionId, next);
  return next;
}

function emptyState(): StreamSessionState {
  return {
    liveTurn: null,
    streamBusy: false,
    sendError: null,
    liveError: null,
    pendingEcho: null,
    lastLiveEndMs: 0,
  };
}

/** Apply a partial patch to a session's slice (creates the slice on first
 * access). Uses the singleton's setState so it works from any code path. */
function patchSession(sessionId: string, patch: Partial<StreamSessionState>): void {
  useStreamStore.setState((s) => {
    const cur = s.bySession[sessionId] ?? emptyState();
    return {
      bySession: { ...s.bySession, [sessionId]: { ...cur, ...patch } },
    };
  });
}

/** ROUND-48 (R48-e2): append a pending approval entry to the session's live
 * turn (the approvals queue the ApprovalCards render from). Used by BOTH the
 * main agent's top-level approval.requested frames (no subAgentId — behavior
 * unchanged) and the child-approval routing below (subAgentId set → the card
 * renders the "Sub-agent {code} · {role}" attribution prefix). */
function appendLiveApproval(
  sessionId: string,
  fields: {
    approvalId: string;
    toolName: string;
    argsSummary: string;
    category: string;
    subAgentId?: string;
  },
): void {
  const cur = useStreamStore.getState().bySession[sessionId];
  if (!cur || cur.liveTurn === null) return;
  patchSession(sessionId, {
    liveTurn: {
      ...cur.liveTurn,
      working: [
        ...cur.liveTurn.working,
        {
          type: "approval" as const,
          approvalId: fields.approvalId,
          toolName: fields.toolName,
          argsSummary: fields.argsSummary,
          category: fields.category,
          status: "pending" as const,
          ...(fields.subAgentId !== undefined ? { subAgentId: fields.subAgentId } : {}),
          ts: new Date().toISOString(),
        },
      ],
    },
  });
}

/** ROUND-48 (R48-e2): resolve an approval row in the live turn (decision
 * landed) — shared by the top-level approval.resolved frame and the child
 * approval.resolved inner event. */
function patchLiveApproval(
  sessionId: string,
  approvalId: string,
  decision: "approved" | "denied" | "expired",
  remember?: "once" | "always",
): void {
  const cur = useStreamStore.getState().bySession[sessionId];
  if (!cur || cur.liveTurn === null) return;
  const working = cur.liveTurn.working.map((entry) => {
    if (entry.type !== "approval" || entry.approvalId !== approvalId) return entry;
    return {
      ...entry,
      status:
        decision === "approved"
          ? ("approved" as const)
          : decision === "denied"
            ? ("denied" as const)
            : ("expired" as const),
      ...(remember ? { remember } : {}),
    };
  });
  patchSession(sessionId, { liveTurn: { ...cur.liveTurn, working } });
}

// ─── ROUND-48 (R48-e2): sub-agent frames on the PARENT's stream ────────────

/** `subagent-status` → upsert the live map entry + invalidate the polled
 * ["subagents", parentSessionId] query so the Delegated card's rows and the
 * New-Tab picker converge on the fresh status immediately. */
function handleSubAgentStatus(
  event: Extract<StreamTurnEvent, { type: "subagent-status" }>,
): void {
  useStreamStore.setState((s) => {
    const prev = s.subagentsLive[event.sessionId];
    const next: SubAgentLiveEntry = {
      childSessionId: event.sessionId,
      parentSessionId: event.parentSessionId,
      code: event.code,
      role: event.role,
      task: event.task,
      status: event.status,
      ...(event.todosDone !== undefined
        ? { todosDone: event.todosDone }
        : prev?.todosDone !== undefined
          ? { todosDone: prev.todosDone }
          : {}),
      ...(event.todosTotal !== undefined
        ? { todosTotal: event.todosTotal }
        : prev?.todosTotal !== undefined
          ? { todosTotal: prev.todosTotal }
          : {}),
      ...(prev?.lastActivity !== undefined ? { lastActivity: prev.lastActivity } : {}),
      updatedAtMs: Date.now(),
    };
    return { subagentsLive: { ...s.subagentsLive, [event.sessionId]: next } };
  });
  const qc = getQueryClient();
  if (qc) {
    void qc.invalidateQueries({ queryKey: ["subagents", event.parentSessionId] });
  }
}

/** Human one-line summary of the child's latest tool step (the Delegated
 * row's activity line — tool name + args/output snippet, bounded length). */
function summarizeToolActivity(
  inner: Extract<SubAgentInnerEvent, { type: "tool-call" | "tool-result" }>,
): string {
  if (inner.type === "tool-call") {
    const args = inner.argsSummary.trim();
    return `${inner.toolName}${args !== "" ? ` ${args}` : ""}`.slice(0, 72);
  }
  const out = (inner.outputSummary ?? "").trim();
  const mark = inner.ok ? "✓" : "✗";
  return out !== "" ? `${inner.toolName} ${mark} ${out}`.slice(0, 72) : `${inner.toolName} ${mark}`;
}

/** `subagent-event` → unwrap the inner frame:
 *  - approval.requested/resolved route into the EXISTING approvals queue
 *    (the live turn's working entries) WITH subAgentId so the ApprovalCard
 *    renders its "Sub-agent {code} · {role}" attribution;
 *  - tool-call/tool-result refresh the live map's lastActivity;
 *  - everything else is ignored — text-delta/finish (the right-sidebar panel
 *    polls the child's own event log for its transcript) and the child's
 *    forwarded meta.* bookkeeping frames (compaction/context/request limits —
 *    see SubAgentInnerEvent's doc; no branch matches, so they fall through). */
function handleSubAgentEvent(
  parentTurnSessionId: string,
  event: Extract<StreamTurnEvent, { type: "subagent-event" }>,
): void {
  const inner = event.inner;
  if (inner.type === "approval.requested") {
    appendLiveApproval(parentTurnSessionId, {
      approvalId: inner.approvalId,
      toolName: inner.toolName,
      argsSummary: inner.argsSummary,
      category: inner.category,
      subAgentId: event.sessionId,
    });
    return;
  }
  if (inner.type === "approval.resolved") {
    patchLiveApproval(parentTurnSessionId, inner.approvalId, inner.decision, inner.remember);
    return;
  }
  if (inner.type === "tool-call" || inner.type === "tool-result") {
    useStreamStore.setState((s) => {
      const prev = s.subagentsLive[event.sessionId];
      if (prev === undefined) return s;
      return {
        subagentsLive: {
          ...s.subagentsLive,
          [event.sessionId]: {
            ...prev,
            lastActivity: summarizeToolActivity(inner),
            updatedAtMs: Date.now(),
          },
        },
      };
    });
  }
  // text-delta / finish / meta.* — nothing to mutate here (see the doc above).
}

/** Tools that mutate the project's file tree — when they complete, refresh
 * the explorer + open-file queries so a background session's writes show up
 * even when no panel is mounted. */
const FILE_MUTATING_TOOLS = new Set([
  "write_file",
  "edit_file",
  "create_dir",
  "delete_file",
]);

export const useStreamStore = create<StreamStore>((set, get) => ({
  bySession: {},
  subagentsLive: {},

  startStream: async (sessionId, text, opts) => {
    // Already streaming? Refuse (the panel should guard too).
    const existing = get().bySession[sessionId];
    if (existing?.streamBusy) return;

    // Mark active in the sidebar animation store (so the pixelated bars spin
    // even when no panel is mounted).
    useActiveStreams.getState().start(sessionId);

    const startedAtMs = Date.now();
    patchSession(sessionId, {
      liveTurn: {
        startedAtMs,
        working: [],
        streamText: "",
        streamThinking: "",
        stopped: false,
      },
      streamBusy: true,
      sendError: null,
      // ROUND-43: a fresh turn clears any stale live error card.
      liveError: null,
    });

    const controller = new AbortController();
    controllers.set(sessionId, controller);

    // Track whether the stream errored (vs ran cleanly to completion). On
    // error the panel freezes the liveTurn as "Stopped" so the partial work
    // stays visible; on success the panel clears it (the folded turn owns
    // the render via queryClient invalidation).
    let errored = false;

    try {
      await streamSessionMessage(
        sessionId,
        text,
        (event: StreamTurnEvent) => {
          handleStreamEvent(sessionId, event);
        },
        { model: opts?.model, signal: controller.signal },
      );
    } catch (err) {
      errored = true;
      // Network/CORS/abort — surface as a send error.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== "The user aborted a request.") {
        // ROUND-43: the fetch itself failed (never reached SSE) — show the
        // live error card too. A user stop is excluded: stops aren't errors.
        patchSession(sessionId, {
          sendError: msg,
          liveError: {
            code: "NETWORK_ERROR",
            message: msg,
            ts: new Date().toISOString(),
          },
        });
      }
    } finally {
      controllers.delete(sessionId);
      const cur = get().bySession[sessionId];
      if (cur) {
        patchSession(sessionId, {
          streamBusy: false,
          lastLiveEndMs: Date.now(),
          // On error: freeze the live section as Stopped so the partial
          // work stays visible. On success: leave liveTurn as-is so the
          // panel can clear it after queryClient invalidation runs (the
          // folded turn renders from the event log).
          liveTurn:
            errored && cur.liveTurn !== null && !cur.liveTurn.stopped
              ? { ...cur.liveTurn, stopped: true }
              : cur.liveTurn,
        });
      }
      // ROUND-42: invalidate from the STORE (not just the panel). A session
      // that completes while its panel is UNMOUNTED (background session —
      // the user switched projects/settings) previously left the sidebar
      // showing the STALE session list, so the auto-renamed title (and the
      // folded turn's arrival) never appeared until a manual refetch. The
      // panel-mounted path also invalidates (AgentChatPanel.runTurn) —
      // duplicate invalidation is a cheap no-op for react-query.
      const qc = getQueryClient();
      if (qc) {
        void qc.invalidateQueries({ queryKey: ["sessions"] });
        void qc.invalidateQueries({ queryKey: ["session"] });
        void qc.invalidateQueries({ queryKey: ["usage"] });
        void qc.invalidateQueries({ queryKey: ["subagents"] });
      }
      // Stop the sidebar animation now that the stream has ended — this
      // fires regardless of whether any panel is mounted (so a background
      // session that completes while the user is on Settings also clears
      // its animation). If the panel is still mounted, its isRunning effect
      // also fires stop (idempotent).
      useActiveStreams.getState().stop(sessionId);
    }
  },

  abortStream: (sessionId) => {
    // ROUND-42: turns now survive client disconnects (they complete in the
    // background + notify via Web Push) — so Stop must EXPLICITLY abort the
    // server-side turn, not just kill the local fetch.
    void stopSessionTurn(sessionId);
    const c = controllers.get(sessionId);
    if (c) {
      c.abort();
      controllers.delete(sessionId);
    }
    // Mark the live turn as stopped so the UI shows "Stopped".
    const cur = get().bySession[sessionId];
    if (cur?.liveTurn) {
      patchSession(sessionId, {
        liveTurn: { ...cur.liveTurn, stopped: true },
      });
    }
  },

  clearStream: (sessionId) => {
    controllers.delete(sessionId);
    seqCounters.delete(sessionId);
    set((s) => {
      const next = { ...s.bySession };
      delete next[sessionId];
      return { bySession: next };
    });
    useActiveStreams.getState().stop(sessionId);
  },

  resolveApprovalInLiveTurn: (sessionId, approvalId, decision, remember) => {
    const cur = get().bySession[sessionId];
    if (!cur?.liveTurn) return;
    const working = cur.liveTurn.working.map((entry) => {
      if (entry.type !== "approval" || entry.approvalId !== approvalId) return entry;
      return {
        ...entry,
        status:
          decision === "approved"
            ? ("approved" as const)
            : decision === "denied"
              ? ("denied" as const)
              : ("expired" as const),
        ...(remember ? { remember } : {}),
      };
    });
    patchSession(sessionId, {
      liveTurn: { ...cur.liveTurn, working },
    });
  },

  setPendingEcho: (sessionId, text) => {
    patchSession(sessionId, { pendingEcho: text });
  },

  setSendError: (sessionId, msg) => {
    patchSession(sessionId, { sendError: msg });
  },

  clearLiveError: (sessionId) => {
    const cur = get().bySession[sessionId];
    if (cur !== undefined && cur.liveError !== null) {
      patchSession(sessionId, { liveError: null });
    }
  },
}));

/** Apply a single SSE event to the session's liveTurn (mirrors the prior
 * inline handler in AgentChatPanel — extracted here so the store can run it
 * even when no panel is mounted). */
function handleStreamEvent(
  sessionId: string,
  event: StreamTurnEvent,
): void {
  // ROUND-48 (R48-e2): sub-agent frames are handled BEFORE the liveTurn
  // guard — the live map is turn-independent (it feeds the Delegated card,
  // the picker attribution and post-turn lookups). The approval routing
  // inside handleSubAgentEvent still no-ops safely when no live turn exists.
  if (event.type === "subagent-status") {
    handleSubAgentStatus(event);
    return;
  }
  if (event.type === "subagent-event") {
    handleSubAgentEvent(sessionId, event);
    return;
  }

  const cur = useStreamStore.getState().bySession[sessionId];
  if (!cur || cur.liveTurn === null) return;
  const liveTurn = cur.liveTurn;

  if (event.type === "text-delta") {
    // Text starting = the in-flight thought is COMPLETE.
    const working =
      liveTurn.streamThinking.trim() !== ""
        ? [
            ...liveTurn.working,
            {
              type: "thinking" as const,
              text: liveTurn.streamThinking,
              ts: new Date().toISOString(),
            },
          ]
        : liveTurn.working;
    patchSession(sessionId, {
      liveTurn: {
        ...liveTurn,
        working,
        streamThinking: "",
        streamText: liveTurn.streamText + event.delta,
      },
    });
    return;
  }

  if (event.type === "thinking-delta") {
    patchSession(sessionId, {
      liveTurn: {
        ...liveTurn,
        streamThinking: liveTurn.streamThinking + event.delta,
      },
    });
    return;
  }

  if (event.type === "tool-call") {
    const entry: ToolUseEntry = {
      seq: getSeq(sessionId),
      toolName: event.toolName,
      argsSummary: event.argsSummary,
      ok: null,
      ts: new Date().toISOString(),
    };
    const working: WorkingEntry[] = [
      ...liveTurn.working,
      ...(liveTurn.streamThinking.trim() !== ""
        ? [
            {
              type: "thinking" as const,
              text: liveTurn.streamThinking,
              ts: new Date().toISOString(),
            },
          ]
        : []),
      ...(liveTurn.streamText.trim() !== ""
        ? [
            {
              type: "text" as const,
              content: liveTurn.streamText,
              ts: new Date().toISOString(),
            },
          ]
        : []),
      { type: "tool" as const, tool: entry },
    ];
    patchSession(sessionId, {
      liveTurn: { ...liveTurn, working, streamThinking: "", streamText: "" },
    });
    return;
  }

  if (event.type === "tool-result") {
    // Attach the result to the matching in-flight row (last null-ok tool entry).
    const flat = liveTurn.working.flatMap((e) => (e.type === "tool" ? [e.tool] : []));
    const idx = [...flat].reverse().findIndex(
      (x) => x.toolName === event.toolName && x.ok === null,
    );
    if (idx === -1) {
      // No matching in-flight row — append a completed entry.
      const entry: ToolUseEntry = {
        seq: getSeq(sessionId),
        toolName: event.toolName,
        argsSummary: event.argsSummary,
        ok: event.ok,
        ts: new Date().toISOString(),
        ...(event.outputSummary ? { outputSummary: event.outputSummary } : {}),
      };
      patchSession(sessionId, {
        liveTurn: {
          ...liveTurn,
          working: [...liveTurn.working, { type: "tool", tool: entry }],
        },
      });
      return;
    }
    const matched = flat.length - 1 - idx;
    let consumed = 0;
    const working = liveTurn.working.map((entry) => {
      if (entry.type !== "tool") return entry;
      const index = consumed;
      consumed += 1;
      if (index === matched) {
        return {
          ...entry,
          tool: {
            ...entry.tool,
            ok: event.ok,
            ...(event.outputSummary ? { outputSummary: event.outputSummary } : {}),
          },
        };
      }
      return entry;
    });
    patchSession(sessionId, { liveTurn: { ...liveTurn, working } });
    // ROUND-39: file mutations refresh the explorer + open file even when
    // no panel is mounted (background session writes show up live). The
    // queryClient singleton is set at boot by main.tsx.
    if (FILE_MUTATING_TOOLS.has(event.toolName)) {
      const qc = getQueryClient();
      if (qc) {
        void qc.invalidateQueries({ queryKey: ["project-tree"] });
        void qc.invalidateQueries({ queryKey: ["project-file"] });
      }
    }
    return;
  }

  if (event.type === "approval.requested") {
    appendLiveApproval(sessionId, {
      approvalId: event.approvalId,
      toolName: event.toolName,
      argsSummary: event.argsSummary,
      category: event.category,
    });
    return;
  }

  if (event.type === "approval.resolved") {
    patchLiveApproval(sessionId, event.approvalId, event.decision, event.remember);
    return;
  }

  if (event.type === "error") {
    // ROUND-43: a turn-level failure. The timeline error card (rendered from
    // this live state, then from the persisted turn.error event after the
    // refetch) is THE surface — the old sendError banner only showed while
    // the panel stayed mounted with lastSent set, so reloads lost it (the
    // owner saw nothing). {type:"stopped"} never reaches here — a stop is
    // not an error and renders no card.
    const details =
      event.details && typeof event.details === "object"
        ? (event.details as Record<string, unknown>)
        : undefined;
    const model = details && typeof details.model === "string" ? details.model : undefined;
    const providerError =
      details && typeof details.providerError === "string" ? details.providerError : undefined;
    const errorTs = details && typeof details.errorTs === "string" ? details.errorTs : undefined;
    patchSession(sessionId, {
      liveError: {
        code: event.code,
        message: event.message,
        ...(event.status !== 0 ? { status: event.status } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(providerError !== undefined ? { providerError } : {}),
        ...(errorTs !== undefined ? { errorTs } : {}),
        ts: new Date().toISOString(),
      },
    });
    return;
  }

  // text-delta / thinking-delta / tool-call / tool-result / approval.* / error
  // handled above. subagent-status / subagent-event are handled at the top of
  // this function (R48-e2 live map + approval routing). finish / done /
  // meta.continuation don't need to mutate the live turn state (the panel
  // invalidates the session query on done and the folded turn renders from
  // the event log).
}

// ─── ROUND-48 (R48-e2): live sub-agent map selectors ────────────────────────

/** Reactive selector for the live sub-agent map — the zustand selector
 * pattern the panels already use (`useStreamStore(selectSubAgentsLive)`).
 * Keyed by CHILD session id; entries appear on the first subagent-status
 * frame and persist for the session's lifetime (statuses go terminal, so
 * post-turn lookups stay accurate). */
export function selectSubAgentsLive(
  s: { subagentsLive: Record<string, SubAgentLiveEntry> },
): Record<string, SubAgentLiveEntry> {
  return s.subagentsLive;
}

/** Non-reactive single-child lookup (event handlers / imperative code —
 * components should use the selector above). */
export function getSubAgentLiveEntry(
  childSessionId: string,
): SubAgentLiveEntry | undefined {
  return useStreamStore.getState().subagentsLive[childSessionId];
}
