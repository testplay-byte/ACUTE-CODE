import { create } from "zustand";
import {
  streamSessionMessage,
  stopSessionTurn,
  type StreamTurnEvent,
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

export interface StreamSessionState {
  liveTurn: LiveTurn | null;
  streamBusy: boolean;
  sendError: string | null;
  pendingEcho: string | null;
  /** When the last live turn ended (for collapseHints). */
  lastLiveEndMs: number;
}

interface StreamStore {
  bySession: Record<string, StreamSessionState>;
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
        patchSession(sessionId, { sendError: msg });
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
}));

/** Apply a single SSE event to the session's liveTurn (mirrors the prior
 * inline handler in AgentChatPanel — extracted here so the store can run it
 * even when no panel is mounted). */
function handleStreamEvent(
  sessionId: string,
  event: StreamTurnEvent,
): void {
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
    patchSession(sessionId, {
      liveTurn: {
        ...liveTurn,
        working: [
          ...liveTurn.working,
          {
            type: "approval" as const,
            approvalId: event.approvalId,
            toolName: event.toolName,
            argsSummary: event.argsSummary,
            category: event.category,
            status: "pending" as const,
            ts: new Date().toISOString(),
          },
        ],
      },
    });
    return;
  }

  if (event.type === "approval.resolved") {
    const working = liveTurn.working.map((entry) => {
      if (entry.type !== "approval" || entry.approvalId !== event.approvalId) return entry;
      return {
        ...entry,
        status:
          event.decision === "approved"
            ? ("approved" as const)
            : event.decision === "denied"
              ? ("denied" as const)
              : ("expired" as const),
        ...(event.remember ? { remember: event.remember } : {}),
      };
    });
    patchSession(sessionId, { liveTurn: { ...liveTurn, working } });
    return;
  }

  if (event.type === "error") {
    patchSession(sessionId, { sendError: event.message });
    return;
  }

  // text-delta / thinking-delta / tool-call / tool-result / approval.* / error
  // handled above. finish / done / meta.continuation / subagent-status don't
  // need to mutate the live turn state (the panel invalidates the session
  // query on done and the folded turn renders from the event log).
}
