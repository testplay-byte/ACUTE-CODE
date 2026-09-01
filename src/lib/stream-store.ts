import { create } from "zustand";
import type { MessageAttachment, ThinkingLevel } from "shared";
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
  /** ROUND-58 (R58-cf): the turn ended because the USER stopped it (the Stop
   * button / the server's {type:"stopped"} frame). NOT an error: the panel
   * renders the quiet "Stopped by user" card + the composer's Continue
   * affordance, and the live turn is handed to the folded log on refetch
   * (the backend flushes the partial text on stop). Set IMMEDIATELY by
   * abortStream so the UI can render the stopped state before any frame
   * arrives. */
  stoppedByUser: boolean;
  /** ROUND-58 (R58-cf): in-flight tool-call ARGUMENT streaming — one entry
   * per `tool-input-start` frame, grown by the matching tool-input-delta
   * chunks. Removed the moment the final tool-call frame lands (the raw is
   * attached to the pending ToolUseEntry as liveInput) or the tool-result
   * settles it. WorkingSection renders live write previews from these. */
  streamingToolInputs: StreamingToolInput[];
  /** ROUND-59 (R59-D): the seq of the turn's LAST non-empty assistant text
   * event, set from the done frame's assistantMessage.seq — the RATING KEY
   * (same value the folded AssistantTurnItem carries, so a live-completed
   * turn can be rated immediately instead of waiting for the refetch).
   * Absent while the turn is still in flight (nothing to rate yet). */
  lastAssistantSeq?: number;
}

/** ROUND-58 (R58-cf): one accumulating tool-args JSON raw (see LiveTurn.streamingToolInputs). */
export interface StreamingToolInput {
  toolCallId: string;
  toolName: string;
  /** Concatenated tool-input-delta fragments — a PREFIX of the call's JSON
   * args (capped at MAX_STREAMING_INPUT_BYTES, head-kept: `path` precedes
   * `content` in write_file/edit_file args, so the head carries the path). */
  raw: string;
}

/** ROUND-58 (R58-cf): defensive cap on an accumulated tool-args raw (~256KB —
 * the extractor only reads path/content/newString; anything past this is
 * pathological model output, never a real file preview). */
const MAX_STREAMING_INPUT_BYTES = 256 * 1024;

/** Append one tool-input delta to an accumulating raw, keeping the HEAD past
 * the cap (unlike the live terminal tail, the path argument sits at the head
 * of the JSON — tail-keeping would orphan it). */
function appendStreamingInput(prev: string, delta: string): string {
  if (prev.length >= MAX_STREAMING_INPUT_BYTES) return prev;
  const next = prev + delta;
  return next.length > MAX_STREAMING_INPUT_BYTES
    ? next.slice(0, MAX_STREAMING_INPUT_BYTES)
    : next;
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
  /** ROUND-50 (R50-b, owner: "I was still not seeing the actual live
   * responses from it, like the actual raw data, the raw thinking, the raw
   * text of it"): the child's LIVE raw-stream state, accumulated from the
   * inner frames of its subagent-event envelopes. RESET RULE: a
   * `subagent-status` frame with status "running" clears the transcript
   * accumulators (liveText / liveThinking / liveToolCalls / liveSteps) — a
   * retry RE-STARTS the child, so the live view must start fresh too. Token
   * counters are deliberately NOT reset: they follow the usage ledger's SUM
   * semantics (usage_events accumulate across attempts, and so does the
   * polled /subagents row they feed), keeping the live→final handoff
   * monotone. */
  /** Concatenated raw text of the CURRENT attempt (inner text-delta frames —
   * streamed `delta` tokens or sync-path step snapshots). */
  liveText: string;
  /** Concatenated raw thinking of the CURRENT attempt (inner thinking-delta
   * frames — streamed children only). */
  liveThinking: string;
  /** Count of inner tool-call frames in the CURRENT attempt. */
  liveToolCalls: number;
  /** Live token counters, accumulated from inner `finish` events (ALL
   * attempts — see the reset rule above). */
  inputTokens: number;
  outputTokens: number;
  /** Wall-clock ms of the last live INNER frame (deltas/tools/finish) — the
   * stats footer's freshness stamp. */
  lastActivityTs: number;
  /** The model the child runs on (from subagent-status frames — the stats
   * footer's model line before the polled row lands). */
  model?: string;
  /** Ordered interleaved log of the current attempt (thinking → text → tool
   * rows in true arrival order) — the panel's live segment renders this so
   * tool rows appear BETWEEN the text they interrupt, exactly like the main
   * chat's WorkingSection. Bounded (the newest MAX_LIVE_STEPS entries). */
  liveSteps: SubAgentLiveStep[];
  /** Wall-clock ms the current attempt's live view started (set when the
   * entry is created / re-anchored on the running status frame) — the live
   * footer's clock anchor while the stream is in flight. */
  startedAtMs: number;
  /** ROUND-52 (R52-b): the supervisor's LATEST heartbeat sample (running
   * frames only, every childWatchdogMs) — the sub-agent panel's live
   * "what is it doing" watch line. A new attempt clears the stale one. */
  watch?: SubAgentWatchInfo;
  /** ROUND-52 (R52-b): WHY the terminal frame fired — "stopped by the
   * owner", "stalled — no activity for Ns (last: …); the supervisor
   * stopped it" — rendered as the panel's status line instead of a bare
   * "failed". Cleared when a new attempt starts. */
  detail?: string;
}

/** One ordered entry of a child's live attempt log (see liveSteps). */
export interface SubAgentLiveStep {
  type: "thinking" | "text" | "tool";
  /** thinking/text: the accumulated raw text; tool: unused. */
  text?: string;
  /** tool rows only. `liveOutput` (ROUND-52 R52-c) is the live terminal
   * tail of an in-flight run_command — stripped the moment its inner
   * tool-result settles the step. */
  tool?: {
    toolName: string;
    argsSummary: string;
    ok: boolean | null;
    outputSummary?: string;
    liveOutput?: string;
  };
}

/** Cap on the ordered live log (a runaway child must not grow the store
 * unbounded; the tail is what the panel streams anyway). */
const MAX_LIVE_STEPS = 400;

/**
 * ROUND-52 (R52-b): the supervisor's heartbeat sample of a running child —
 * mirrored locally from the subagent-status frame's `watch` payload (api.ts
 * types that shape INLINE on the SSE variant, so the store re-declares it
 * here to carry it on the live map without widening api.ts).
 */
export interface SubAgentWatchInfo {
  /** ms since the child's last persisted event — the stall signal. */
  lastEventAgeMs: number;
  /** The child's last tool call ("run_command …") or message kind. */
  lastActivity: string;
  /** Total tool calls so far this attempt. */
  toolCount: number;
  todosDone: number;
  todosTotal: number;
  /** Wall-clock ms since the attempt started. */
  elapsedMs: number;
  /** True when lastEventAgeMs passed the stall threshold — the frame that
   * carries this is a warning (amber watch line in the panel). */
  stalled: boolean;
}

/**
 * ROUND-52 (R52-c): a ToolUseEntry carrying the LIVE terminal tail of an
 * in-flight run_command call. Defined LOCALLY (api.ts is frozen this round):
 * structurally assignable to ToolUseEntry, so the working entries stay
 * typed as-is and only the store/WorkingSection read the extra field.
 *
 * ROUND-58 (R58-cf): `liveInput` is the accumulated tool-args JSON raw of an
 * in-flight write_file/edit_file call (attached when the final tool-call
 * frame arrives; stripped by the tool-result — the diff card takes over).
 */
export type LiveToolUseEntry = ToolUseEntry & {
  liveOutput?: string;
  liveInput?: string;
};

/** ROUND-52 (R52-c): cap on the accumulated live output tail (~4KB — the
 * display slices the last lines anyway; the store keeps the tail). */
const MAX_LIVE_OUTPUT_BYTES = 4096;

/** Append one output chunk to a live tail, keeping the LAST bytes past the
 * cap (streaming commands can emit megabytes — only the tail matters). */
function appendLiveOutput(prev: string | undefined, chunk: string): string {
  const next = (prev ?? "") + chunk;
  return next.length > MAX_LIVE_OUTPUT_BYTES
    ? next.slice(next.length - MAX_LIVE_OUTPUT_BYTES)
    : next;
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
  /** ROUND-58 (R58-cf): the last live turn ended because the user stopped
   * it — survives the live-turn clear (the folded log owns the partial's
   * render after the refetch) so the "Stopped by user" card + the
   * composer's Continue affordance persist until the next send. Reset by
   * startStream. */
  lastTurnStoppedByUser: boolean;
  /** When the user stop landed (the card's timestamp). */
  lastTurnStoppedTs: string | null;
}

interface StreamStore {
  bySession: Record<string, StreamSessionState>;
  /** ROUND-48 (R48-e2): live sub-agent map, keyed by CHILD session id —
   * upserted from subagent-status frames + tool-call/tool-result inner
   * events (see SubAgentLiveEntry). Independent of bySession so it keeps
   * working across panel remounts, exactly like the rest of the store. */
  subagentsLive: Record<string, SubAgentLiveEntry>;
  /** Start a streamed turn — runs in the background; resolves on end/abort.
   *
   * ROUND-50 (R50-c2): `opts` additively carries the composer's per-send
   * extras (`thinkingLevel`, `attachments`) straight through to
   * streamSessionMessage — api.ts already threads them into the POST body
   * (R50-c1). Purely optional: existing callers that pass only `model` (or
   * nothing) behave exactly as before. */
  startStream: (
    sessionId: string,
    text: string,
    opts?: {
      model?: string;
      thinkingLevel?: ThinkingLevel;
      attachments?: MessageAttachment[];
    },
  ) => Promise<void>;
  /** ROUND-58 (R58-cf): the user clicked Stop — a DELIBERATE stop, not an
   * abort-and-pray. (i) marks the live turn stopped-by-user IMMEDIATELY (the
   * UI renders the stopped state before any frame arrives); (ii) tells the
   * SIDECAR to stop the turn (POST /sessions/:id/stop — turns survive client
   * disconnects, so the server must resolve the turn itself; fire-and-forget);
   * (iii) does NOT touch the local fetch — the server's {type:"stopped"} frame
   * ends the stream cleanly. The PANEL schedules hardAbortStream as a ~2.5s
   * grace net for a server that never answers (useTimeoutClear owns the timer
   * — the store is not a React component). */
  abortStream: (sessionId: string) => void;
  /** ROUND-58 (R58-cf): the grace-net local abort (the panel's delayed Stop
   * callback). Aborts the local controller ONLY when the session's live turn
   * is still the user-stopped one and still in flight — a no-op once the
   * stream ended (the controller map entry is gone) or a NEW turn replaced
   * the stopped one (the stoppedByUser guard prevents cross-turn damage). */
  hardAbortStream: (sessionId: string) => void;
  /** ROUND-58 (R58-cf): set/clear the "last turn ended by user stop" signal
   * (the quiet Stopped card + the composer's Continue affordance). */
  setLastTurnStoppedByUser: (sessionId: string, stopped: boolean) => void;
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
    lastTurnStoppedByUser: false,
    lastTurnStoppedTs: null,
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
 * New-Tab picker converge on the fresh status immediately.
 *
 * ROUND-50 (R50-b): the entry also carries the child's live raw-stream state
 * (liveText/liveThinking/liveSteps/token counters — see SubAgentLiveEntry).
 * The RESET RULE: a "running" frame clears the transcript accumulators (a
 * retry re-starts the child → the live view starts fresh) while tokens are
 * carried forward (SUM semantics — see the entry doc). */
function handleSubAgentStatus(
  event: Extract<StreamTurnEvent, { type: "subagent-status" }>,
): void {
  useStreamStore.setState((s) => {
    const prev = s.subagentsLive[event.sessionId];
    // A (re)start of the child's turn: the live transcript begins anew.
    const restarted = event.status === "running";
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
      ...(event.model !== undefined ? { model: event.model } : prev?.model !== undefined ? { model: prev.model } : {}),
      // Transcript accumulators: reset on running, carried otherwise (the
      // frozen live view bridges the poll-lag gap when the child turns
      // completed/failed — the panel hides it once the polled transcript
      // catches up, see SubAgentPanel).
      liveText: restarted ? "" : prev?.liveText ?? "",
      liveThinking: restarted ? "" : prev?.liveThinking ?? "",
      liveToolCalls: restarted ? 0 : prev?.liveToolCalls ?? 0,
      liveSteps: restarted ? [] : prev?.liveSteps ?? [],
      // Tokens are never reset (SUM semantics across attempts).
      inputTokens: prev?.inputTokens ?? 0,
      outputTokens: prev?.outputTokens ?? 0,
      lastActivityTs: prev?.lastActivityTs ?? 0,
      // The attempt's clock anchor: the running frame (or the first inner
      // frame for entries born mid-stream — see handleSubAgentEvent).
      startedAtMs: restarted || prev === undefined ? Date.now() : prev.startedAtMs,
      // ROUND-52 (R52-b): the heartbeat sample rides running frames every
      // childWatchdogMs; a (re)start clears the stale sample of the previous
      // attempt.
      ...(event.watch !== undefined
        ? { watch: event.watch }
        : prev?.watch !== undefined && !restarted
          ? { watch: prev.watch }
          : {}),
      // ROUND-52 (R52-b): WHY a terminal frame fired; a new attempt
      // (queued/running/completed) clears it.
      ...(event.detail !== undefined
        ? { detail: event.detail }
        : event.status === "failed" && prev?.detail !== undefined
          ? { detail: prev.detail }
          : {}),
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
 *  - ROUND-52 (R52-c): inner tool-output chunks append to the matching
 *    in-flight run_command live step (the live terminal tail);
 *  - ROUND-50 (R50-b): text-delta / thinking-delta / tool frames accumulate
 *    the child's LIVE raw-stream state (liveText / liveThinking /
 *    liveSteps — the sub-agent panel's live segment) and inner `finish`
 *    events accumulate the live token counters (the stats footer);
 *  - the child's forwarded meta.* bookkeeping frames (compaction/context/
 *    request limits) still fall through untouched (no branch matches). */
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

  if (
    inner.type === "text-delta" ||
    inner.type === "thinking-delta" ||
    inner.type === "tool-call" ||
    inner.type === "tool-result" ||
    inner.type === "tool-output" ||
    inner.type === "finish"
  ) {
    useStreamStore.setState((s) => {
      const prev = s.subagentsLive[event.sessionId];
      if (prev === undefined) return s;
      // ROUND-50: the live raw-stream patch for THIS child (the `??` fallbacks
      // keep a partial/stale entry — one written by an older store shape —
      // from poisoning the accumulators with undefined).
      const baseText = prev.liveText ?? "";
      const baseThinking = prev.liveThinking ?? "";
      const baseToolCalls = prev.liveToolCalls ?? 0;
      const baseIn = prev.inputTokens ?? 0;
      const baseOut = prev.outputTokens ?? 0;
      let liveSteps = prev.liveSteps ?? [];
      let liveText = baseText;
      let liveThinking = baseThinking;
      let liveToolCalls = baseToolCalls;
      let inputTokens = baseIn;
      let outputTokens = baseOut;

      if (inner.type === "text-delta") {
        // Streamed children send token-level `delta`s; the sync path sends
        // per-step snapshots as `text` (a call's frames concatenate to the
        // reply either way — accumulate whichever the frame carries).
        const chunk = inner.delta ?? inner.text ?? "";
        liveText = baseText + chunk;
        liveSteps = appendLiveStep(liveSteps, "text", chunk);
      } else if (inner.type === "thinking-delta") {
        liveThinking = baseThinking + inner.delta;
        liveSteps = appendLiveStep(liveSteps, "thinking", inner.delta);
      } else if (inner.type === "tool-call") {
        liveToolCalls = baseToolCalls + 1;
        liveSteps = appendLiveStep(liveSteps, "tool", undefined, {
          toolName: inner.toolName,
          argsSummary: inner.argsSummary,
          ok: null,
        });
      } else if (inner.type === "tool-result") {
        // Attach the result to the matching in-flight live step (the last
        // tool step with the same name + a pending ok).
        liveSteps = [...liveSteps];
        for (let i = liveSteps.length - 1; i >= 0; i -= 1) {
          const step = liveSteps[i];
          if (step.type === "tool" && step.tool?.toolName === inner.toolName && step.tool.ok === null) {
            // ROUND-52 (R52-c): strip the live tail — the settled row shows
            // the FINAL output (outputSummary), never both.
            const { liveOutput: _cleared, ...settled } = step.tool;
            liveSteps[i] = {
              ...step,
              tool: {
                ...settled,
                ok: inner.ok,
                ...(inner.outputSummary !== undefined ? { outputSummary: inner.outputSummary } : {}),
              },
            };
            break;
          }
        }
      } else if (inner.type === "tool-output") {
        // ROUND-52 (R52-c): live terminal output of the child's RUNNING
        // run_command — chunks append to the matching in-flight live step
        // (same last-pending-match rule as tool-result); the panel's live
        // tool rows render the streaming tail under the pill.
        liveSteps = [...liveSteps];
        for (let i = liveSteps.length - 1; i >= 0; i -= 1) {
          const step = liveSteps[i];
          if (step.type === "tool" && step.tool?.toolName === inner.toolName && step.tool.ok === null) {
            liveSteps[i] = {
              ...step,
              tool: {
                ...step.tool,
                liveOutput: appendLiveOutput(step.tool.liveOutput, inner.chunk),
              },
            };
            break;
          }
        }
      } else if (inner.type === "finish" && inner.usage !== undefined) {
        // ROUND-50: live token counters — the stats footer while running.
        inputTokens = baseIn + inner.usage.inputTokens;
        outputTokens = baseOut + inner.usage.outputTokens;
      }

      const next: SubAgentLiveEntry = {
        ...prev,
        liveText,
        liveThinking,
        liveToolCalls,
        inputTokens,
        outputTokens,
        liveSteps,
        updatedAtMs: Date.now(),
        lastActivityTs: Date.now(),
        ...(inner.type === "tool-call" || inner.type === "tool-result"
          ? { lastActivity: summarizeToolActivity(inner) }
          : {}),
      };
      return { subagentsLive: { ...s.subagentsLive, [event.sessionId]: next } };
    });
    return;
  }
  // meta.* — nothing to mutate (see the doc above).
}

/** Append/merge one step onto the ordered live log: consecutive thinking
 * deltas merge into ONE thinking block (the main chat renders a single
 * "Thinking…" row per thought), consecutive text deltas merge into one text
 * run, tools always append. Bounded at MAX_LIVE_STEPS (newest kept). */
function appendLiveStep(
  steps: SubAgentLiveStep[],
  type: "thinking" | "text",
  chunk: string,
): SubAgentLiveStep[];
function appendLiveStep(
  steps: SubAgentLiveStep[],
  type: "tool",
  chunk: undefined,
  tool: { toolName: string; argsSummary: string; ok: boolean | null },
): SubAgentLiveStep[];
function appendLiveStep(
  steps: SubAgentLiveStep[],
  type: "thinking" | "text" | "tool",
  chunk?: string,
  tool?: { toolName: string; argsSummary: string; ok: boolean | null },
): SubAgentLiveStep[] {
  const last = steps[steps.length - 1];
  if ((type === "thinking" || type === "text") && last !== undefined && last.type === type) {
    const merged = [...steps];
    merged[merged.length - 1] = { type, text: (last.text ?? "") + (chunk ?? "") };
    return merged;
  }
  const next =
    type === "tool" && tool !== undefined
      ? [...steps, { type: "tool" as const, tool }]
      : [...steps, { type, text: chunk ?? "" } as SubAgentLiveStep];
  return next.length > MAX_LIVE_STEPS ? next.slice(next.length - MAX_LIVE_STEPS) : next;
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
        stoppedByUser: false,
        streamingToolInputs: [],
      },
      streamBusy: true,
      sendError: null,
      // ROUND-43: a fresh turn clears any stale live error card.
      liveError: null,
      // ROUND-58 (R58-cf): a fresh turn also clears the previous turn's
      // user-stop signal (the Stopped card + Continue affordance end here).
      lastTurnStoppedByUser: false,
      lastTurnStoppedTs: null,
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
        { model: opts?.model, signal: controller.signal, thinkingLevel: opts?.thinkingLevel, attachments: opts?.attachments },
      );
    } catch (err) {
      // ROUND-58 (R58-cf): a DELIBERATE user stop (abortStream marked the
      // live turn before the abort could possibly reach this catch — via the
      // grace hard-abort or the reader's abort rejection) is NOT an error:
      // no liveError, no sendError, no NETWORK_ERROR card. The stopped flag
      // was already set by abortStream; only the terminal slice signal needs
      // arming here (the server's confirmation frame may never arrive).
      // A non-deliberate failure (real network death, sync-path rejection)
      // keeps today's behavior: NETWORK_ERROR live card + send error.
      const deliberate = get().bySession[sessionId]?.liveTurn?.stoppedByUser === true;
      if (deliberate) {
        patchSession(sessionId, {
          lastTurnStoppedByUser: true,
          ...(get().bySession[sessionId]?.lastTurnStoppedTs === null
            ? { lastTurnStoppedTs: new Date().toISOString() }
            : {}),
        });
      } else {
        errored = true;
        // Network/CORS/abort — surface as a send error + the live error card
        // (ROUND-43). The old exact-string "The user aborted a request."
        // check is subsumed: ANY abort on a deliberate-stop turn is a stop,
        // and there is no other abort source.
        const msg = err instanceof Error ? err.message : String(err);
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
    // ROUND-58 (R58-cf, owner: stopping showed "Generation failed" + "body
    // stream buffer was aborted"): Stop is now a DELIBERATE two-step stop.
    // (i) Mark the live turn stopped-by-user IMMEDIATELY — the UI renders the
    // quiet stopped state before any frame arrives, and the catch above
    // classifies the eventual abort as a stop, never NETWORK_ERROR.
    // (ii) Tell the SIDECAR to resolve the turn (ROUND-42 semantics: turns
    // survive client disconnects) — fire-and-forget; the server answers with
    // {type:"stopped"} and closes the stream, which is the CLEAN end.
    // (iii) Do NOT abort the local fetch here — the panel's useTimeoutClear
    // grace timer calls hardAbortStream ~2.5s later only if the stream is
    // still open (a server that never answers).
    const cur = get().bySession[sessionId];
    if (cur?.liveTurn) {
      patchSession(sessionId, {
        liveTurn: { ...cur.liveTurn, stopped: true, stoppedByUser: true },
      });
    }
    patchSession(sessionId, {
      lastTurnStoppedByUser: true,
      lastTurnStoppedTs: new Date().toISOString(),
    });
    void stopSessionTurn(sessionId);
  },

  hardAbortStream: (sessionId) => {
    // ROUND-58 (R58-cf): the grace-net local abort. Only acts while the
    // session's live turn is STILL the user-stopped one and the controller
    // is still registered (stream open). Once the stream ended the finally
    // removed the controller → no-op; once a NEW turn started, the fresh
    // liveTurn is not stoppedByUser → no-op (never aborts the new turn).
    const cur = get().bySession[sessionId];
    if (cur?.liveTurn?.stoppedByUser !== true) return;
    const c = controllers.get(sessionId);
    if (c) {
      c.abort();
      controllers.delete(sessionId);
    }
  },

  setLastTurnStoppedByUser: (sessionId, stopped) => {
    patchSession(sessionId, {
      lastTurnStoppedByUser: stopped,
      lastTurnStoppedTs: stopped ? new Date().toISOString() : null,
    });
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

  // ── ROUND-58 (R58-cf): live tool-ARG streaming (the write preview source) ──

  if (event.type === "tool-input-start") {
    // A new accumulation buffer (idempotent on a replayed start frame).
    if (liveTurn.streamingToolInputs.some((s) => s.toolCallId === event.toolCallId)) {
      return;
    }
    patchSession(sessionId, {
      liveTurn: {
        ...liveTurn,
        streamingToolInputs: [
          ...liveTurn.streamingToolInputs,
          { toolCallId: event.toolCallId, toolName: event.toolName, raw: "" },
        ],
      },
    });
    return;
  }

  if (event.type === "tool-input-delta") {
    let matched = false;
    const inputs = liveTurn.streamingToolInputs.map((s) => {
      if (s.toolCallId !== event.toolCallId) return s;
      matched = true;
      return { ...s, raw: appendStreamingInput(s.raw, event.inputTextDelta) };
    });
    // Unknown id (a start frame we never saw — e.g. joined mid-call): grow
    // nothing; the final tool-call frame still renders the row.
    if (!matched) return;
    patchSession(sessionId, { liveTurn: { ...liveTurn, streamingToolInputs: inputs } });
    return;
  }

  if (event.type === "tool-call") {
    // ROUND-58 (R58-cf): the args are COMPLETE — the frame carries no
    // toolCallId, so the accumulated raw is matched to the LATEST unresolved
    // streaming-input entry with the same toolName and attached to the new
    // pending ToolUseEntry as liveInput (the live write preview renders from
    // it while ok === null; the tool-result strips it when the diff card
    // takes over). The streaming-input entry is consumed either way.
    const streamingIdx = [...liveTurn.streamingToolInputs]
      .reverse()
      .findIndex((s) => s.toolName === event.toolName);
    const matchedStreaming =
      streamingIdx === -1 ? null : liveTurn.streamingToolInputs[liveTurn.streamingToolInputs.length - 1 - streamingIdx];
    const streamingToolInputs =
      matchedStreaming === null
        ? liveTurn.streamingToolInputs
        : liveTurn.streamingToolInputs.filter((s) => s !== matchedStreaming);
    const entry: ToolUseEntry = {
      seq: getSeq(sessionId),
      toolName: event.toolName,
      argsSummary: event.argsSummary,
      ok: null,
      ts: new Date().toISOString(),
    };
    const liveEntry: LiveToolUseEntry =
      matchedStreaming !== null && matchedStreaming.raw !== ""
        ? { ...entry, liveInput: matchedStreaming.raw }
        : entry;
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
      { type: "tool" as const, tool: liveEntry },
    ];
    patchSession(sessionId, {
      liveTurn: { ...liveTurn, working, streamingToolInputs, streamThinking: "", streamText: "" },
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
        // ROUND-52 (R52-c): strip the live tail — the settled pill shows the
        // FINAL output (outputSummary), never both. ROUND-58 (R58-cf):
        // liveInput (the write preview's raw) is stripped the same way — the
        // final result/diff rendering takes over.
        const { liveOutput: _out, liveInput: _in, ...settled } = entry.tool as LiveToolUseEntry;
        return {
          ...entry,
          tool: {
            ...settled,
            ok: event.ok,
            ...(event.outputSummary ? { outputSummary: event.outputSummary } : {}),
          },
        };
      }
      return entry;
    });
    // ROUND-58 (R58-cf): a tool-result also settles any still-unresolved
    // streaming-input entry of the same tool (the final rendering owns the
    // args now) — the preview never outlives its tool.
    const streamingToolInputs = liveTurn.streamingToolInputs.filter(
      (s) => s.toolName !== event.toolName,
    );
    patchSession(sessionId, {
      liveTurn: {
        ...liveTurn,
        working,
        ...(streamingToolInputs.length !== liveTurn.streamingToolInputs.length
          ? { streamingToolInputs }
          : {}),
      },
    });
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

  if (event.type === "tool-output") {
    // ROUND-52 (R52-c, owner: "After running the commands, it should
    // actually show the terminal interface of those commands too"): live
    // terminal output of a RUNNING run_command — batched stdout+stderr
    // chunks append to the matching in-flight tool entry (last null-ok of
    // the same name); WorkingSection renders the capped tail under the
    // pill while ok === null. No matching in-flight row → ignore (the
    // backend always emits tool-call first).
    const flat = liveTurn.working.flatMap((e) => (e.type === "tool" ? [e.tool] : []));
    const idx = [...flat].reverse().findIndex(
      (x) => x.toolName === event.toolName && x.ok === null,
    );
    if (idx === -1) return;
    const matched = flat.length - 1 - idx;
    let consumed = 0;
    const working = liveTurn.working.map((entry) => {
      if (entry.type !== "tool") return entry;
      const index = consumed;
      consumed += 1;
      if (index === matched) {
        const live = entry.tool as LiveToolUseEntry;
        return {
          ...entry,
          tool: { ...live, liveOutput: appendLiveOutput(live.liveOutput, event.chunk) },
        };
      }
      return entry;
    });
    patchSession(sessionId, { liveTurn: { ...liveTurn, working } });
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
    // ROUND-58 (R58-cf): if a stop was ARMED but the turn actually FAILED
    // (the stop request raced the failure), the error verdict wins: retract
    // the stop signal so the quiet Stopped card never stacks under the error
    // card. The live turn keeps its frozen-stopped shape (the existing error
    // UX), minus the user-stop classification.
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
      ...(cur.lastTurnStoppedByUser || liveTurn.stoppedByUser
        ? {
            liveTurn: { ...liveTurn, stopped: true, stoppedByUser: false },
            lastTurnStoppedByUser: false,
            lastTurnStoppedTs: null,
          }
        : {}),
    });
    return;
  }

  if (event.type === "done") {
    // ROUND-58 (R58-cf): a normal COMPLETION is not a stop. If the user
    // clicked Stop a hair before the server finished (the race — the stop
    // POST lost to the turn's own completion), the flags abortStream armed
    // would otherwise render the quiet Stopped card + the Continue
    // affordance under a FULLY completed turn. The done frame is the turn's
    // own verdict: retract the stop so the folded turn owns the render
    // exactly like every normal completion.
    if (cur.lastTurnStoppedByUser || liveTurn.stoppedByUser) {
      patchSession(sessionId, {
        liveTurn: { ...liveTurn, stopped: false, stoppedByUser: false },
        lastTurnStoppedByUser: false,
        lastTurnStoppedTs: null,
      });
    }
    // ROUND-59 (R59-D): pin the rating key on the completed live turn — the
    // done frame's assistantMessage.seq IS the last non-empty assistant text
    // event (the runtime's lastAssistantEvent), identical to the folded
    // item's lastAssistantSeq. The panel can render the rating cluster
    // before the refetch lands.
    if (Number.isInteger(event.assistantMessage?.seq) && event.assistantMessage.seq > 0) {
      const fresh = useStreamStore.getState().bySession[sessionId]?.liveTurn;
      if (fresh !== undefined && fresh !== null) {
        patchSession(sessionId, { liveTurn: { ...fresh, lastAssistantSeq: event.assistantMessage.seq } });
      }
    }
    return;
  }

  if (event.type === "stopped") {
    // ROUND-58 (R58-cf): the server confirmed the deliberate stop (POST
    // /sessions/:id/stop resolved the turn + flushed the partial). Terminal
    // state on the live turn: frozen timer, quiet "Stopped by user" card,
    // and the persistent slice signal the composer's Continue affordance
    // reads. NOT an error — liveError is never set on this path.
    patchSession(sessionId, {
      liveTurn: { ...liveTurn, stopped: true, stoppedByUser: true },
      ...(cur.lastTurnStoppedByUser !== true || cur.lastTurnStoppedTs === null
        ? { lastTurnStoppedByUser: true, lastTurnStoppedTs: new Date().toISOString() }
        : {}),
    });
    return;
  }

  // text-delta / thinking-delta / tool-input-* / tool-call / tool-result /
  // tool-output / approval.* / error / stopped / done handled above.
  // subagent-status / subagent-event are handled at the top of this function
  // (R48-e2 live map + approval routing). finish / meta.continuation don't
  // need to mutate the live turn state (the panel invalidates the session
  // query on done and the folded turn renders from the event log).
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
