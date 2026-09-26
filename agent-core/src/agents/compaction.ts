/**
 * ROUND-46 (R46-b): context compaction — summarize, don't silently drop.
 *
 * Before this round the context overflow path was a HARD trim
 * (assembleWithinBudget drops the oldest user/assistant pairs and inserts a
 * generic "[Earlier conversation was trimmed…]" marker). That destroys
 * information the agent still needs: the original task, decisions made,
 * files touched, errors fixed. Top-tier coding agents COMPACT instead — an
 * LLM call summarizes the over-budget head into a dense briefing, and the
 * summary replaces it.
 *
 * Design:
 *   - A compaction is persisted as a `context.compact` session event
 *     { summary, throughSeq, droppedMessages, tokensSaved } — append-only
 *     like every other event (ADR-0010), so fork/revert inherit it for free:
 *     reverting past the event resurrects the original messages; forking
 *     copies the compacted log verbatim.
 *   - Assembly is PURE: assembleHistory annotates each message with the seq
 *     of the last event that contributed to it; the newest context.compact
 *     event filters messages covered by its throughSeq and prepends the
 *     summary message.
 *   - Compaction runs only when the assembled history (with any existing
 *     compaction applied) STILL exceeds the budget — so it never fires on
 *     normal sessions, and a compacted session does not re-summarize on
 *     every outer-loop iteration (the event is reused until it overflows
 *     again, at which point a round-2 compaction folds the old summary +
 *     newer messages into a fresh one).
 *   - Summarizer failure degrades to the old hard trim — compaction is a
 *     quality upgrade, never a new failure mode.
 *
 * ROUND-125 (R125-C, D1+D2 — the ZCode adoption; owner directive: "You never
 * refer to the reference projects which I highlighted with you a lot of the
 * times"): the study's TOP TWO recommendations
 * (agent-ctx/research/zcode-context-compression.md §D1/§D2), mirrored from
 * ZCode's compact/policy.ts + runtime/methods/compact.ts:
 *   - D1 PROVIDER-USAGE TOKEN ANCHORING: the over-budget gate now prefers
 *     the PROVIDER'S own reported inputTokens (the newest usage-bearing
 *     assistant event) plus the locally estimated tail AFTER it, over the
 *     fresh whole-list estimate — ZCode methods/compact.ts
 *     buildProviderUsageTokenOverride, the same anchor law (see
 *     providerUsageAnchor below). The local estimate stays the fallback:
 *     a session with no usage row yet behaves byte-identically to pre-R125.
 *     Both numbers are reported (ZCode's estimatedTokenCount/tokenCount
 *     pair) so a bad provider number is visible, not silent.
 *   - D2 TYPED DECISION: planCompaction returns the decision itself —
 *     { decision, tokenCount, tokenSource, estimatedTokens, threshold,
 *     reason } on EVERY path, skip included (ZCode compact/policy.ts
 *     AutoCompactDecision's twin; the reason vocabulary is ACUTE's own:
 *     forced | above_threshold | below_threshold | empty_to_summarize). The
 *     context.compact EVENT payload and the streamed meta.compaction frame
 *     carry the numbers + reason as ADDITIVE optional fields — pre-R125
 *     events simply lack them and every reader ignores unknown fields.
 *
 * ROUND-128 (R128-W8, D3+D5 — the ZCode adoption round's compaction wave;
 * study §D3/§D5, mirrored from ZCode compact/rounds.ts +
 * agent/message-history.ts invalidateRuntimeTokenUsage +
 * turn-loop-state.ts evaluateRapidRefill):
 *   - D3a ROUND-ALIGNED SELECTION: the keep/summarize boundary never splits
 *     an assistant's tool exchange. The head is grouped into assistant-
 *     STARTED rounds (groupByAssistantStartedRounds — ZCode compact/rounds
 *     groupByAssistantStartedRounds's twin: an assistant message + its
 *     trailing tool_results/user messages until the next assistant; leading
 *     user messages form their own head group); after the 60%-budget byte
 *     cut, the boundary walks BACK to the start of the oldest kept
 *     assistant round, and everything before that round start is summarized
 *     (the newest exchange rides verbatim — never a summarized tool_call
 *     whose tool_result survives in the tail). Honest guard: when the
 *     extension would push the keep set past 125% of the 60% keep-target
 *     (= 75% of `available`), the byte-budget cut stands instead and the
 *     plan says roundAligned:false (a single gigantic round must not
 *     consume the whole window). ADDITIVE decision fields on the plan and
 *     the persisted event: roundAligned + preservedRounds.
 *   - D3b ANCHOR INVALIDATION (providerUsageAnchor): a compaction boundary
 *     invalidates every provider-usage anchor at or before it — those
 *     inputTokens measured the PRE-compaction serialization (the documented
 *     stale-anchor over-trigger window: right after a compaction, before
 *     the next successful provider reply re-anchors). The scan skips
 *     usage-bearing assistant events older than the newest compaction
 *     EVENT (the keep-set assistants included — ZCode's
 *     invalidateRuntimeTokenUsage zeroes exactly those preserved-tail
 *     anchors), returning null when nothing post-boundary exists yet: the
 *     honest "no anchor" the estimate fallback already handles.
 *   - D5 RAPID-REFILL CIRCUIT BREAKER: when the last 3 compactions EACH
 *     landed with fewer than 3 tool turns (tool.use events) since the
 *     previous one, the next AUTO compaction is BLOCKED — the session is
 *     compacting faster than it fills (a runaway tool-output loop would
 *     otherwise re-compact every iteration). A persisted turn.warning
 *     (kind "compaction_rapid_refill", one per episode) carries the
 *     teaching copy. The breaker MUST NOT (and does not) block the manual
 *     compact route, the overflow-recovery force path, or the
 *     summarizer-failure hard-trim fallback — all of those ride
 *     opts.force. The block lifts once a compaction is followed by ≥3
 *     tool turns (the counter reset).
 */
import type Database from "better-sqlite3";
import { appendSessionEvent, getSession, listSessionEvents, recordUsage, type SessionEvent } from "../storage/sessions.js";
import { lookupPricing } from "../storage/models.js";
import { getMemorySettings } from "../storage/settings.js";
import { saveMemoryWithDedup } from "../storage/memory.js";
import { assembleWithinBudget, estimateMessageTokens, type ContextBudget } from "../context.js";
import type { ChatFn, ChatTurnMessage } from "./chat.js";

/** A model-facing message annotated with the seq of the last session event
 * that contributed to it (tool_results blocks carry the seq of the final
 * tool.use event folded into the block). */
export interface SeqMessage {
  role: "user" | "assistant";
  content: string;
  throughSeq: number;
}

/** R129-CTX2 (round-129.md §4 stage 3 — the 90% law, the owner's exact
 * words: "if… the context window has been utilized about 90%… then it will
 * auto-start the compression without performing any of the next tasks").
 * The AUTO-compaction gate fires when the anchored/estimated count reaches
 * this fraction of `available` — BEFORE the provider call the turn loop is
 * about to make (assembleWithCompaction is awaited inside the loop, so the
 * compression literally happens instead of the next task, not after it).
 * ZCode compact/policy.ts lands at 83% (window − min(reserve,21K) − 13K);
 * cline's current main triggers at 90% of usable; kilocode preflights at
 * ~80% configurable. 0.9 rides the owner's own number. The overflow FORCE
 * path (the provider itself rejecting the request) and the rapid-refill
 * breaker are untouched — this only moves the AUTO line earlier (it was
 * 100% of `available`, an overflow-shaped gate that left no headroom). */
export const AUTO_COMPACT_RATIO = 0.9;

/** Payload of a `context.compact` event (also the wire shape for the
 * meta.compaction SSE event's details). */
export interface CompactionPayload {
  summary: string;
  throughSeq: number;
  droppedMessages: number;
  tokensSaved: number;
  /* ROUND-125 (R125-C, D2): the typed decision that produced this event —
   * additive optional; pre-R125 events simply lack the fields and every
   * reader (findLatestCompaction guards, applyCompaction/summaryMessage's
   * Pick<..., "summary" | "droppedMessages">) ignores them. */
  /** The count the threshold gate used — the D1 anchor when one existed,
   * the local estimate otherwise. */
  tokenCount?: number;
  /** Where tokenCount came from — "provider-anchored" (the provider's own
   * number won) or "estimated" (the local BPE-approx estimator). */
  tokenSource?: CompactionTokenSource;
  /** The local estimate of the whole list — the OTHER half of the dual
   * number pair (ZCode reports estimatedTokenCount alongside tokenCount so
   * a provider number that disagrees with reality is visible). */
  estimatedTokens?: number;
  /** The available budget the gate compared against (window − output
   * reserve − margin — the same `available` planCompaction computes). */
  threshold?: number;
  /** Why the compaction fired (the D2 vocabulary). */
  reason?: CompactionDecisionReason;
  /* ROUND-128 (R128-W8, D3a): the round-aligned selection's additive
   * fields — same contract as the R125-C fields above (old events simply
   * lack them; every reader ignores unknown fields). */
  /** True when the keep/summarize boundary sits on an assistant-round
   * start (no assistant's tool exchange was split). False only on the
   * materiality-guard fallback, where the byte-budget cut stood. */
  roundAligned?: boolean;
  /** How many whole assistant-started rounds the keep set preserves
   * verbatim. */
  preservedRounds?: number;
  /* ROUND-129 (R129-CTX2, ZCode D4 — the post-compact re-injection): the
   * ≤5 file paths the model most recently READ in the now-summarized
   * region — "what was in the model's hands when the cut happened". On
   * every applyCompaction these ride a pointer-line reminder note right
   * after the summary, so the agent can re-open its working files without
   * guessing names. Additive: old events lack the field and render exactly
   * as before. */
  reinjectedPaths?: string[];
}

/** ROUND-125 (R125-C, D2): why planCompaction decided what it decided —
 * ZCode compact/policy.ts AutoCompactDecision.reason's ACUTE twin (their
 * disabled|not_enough_messages|circuit_breaker|below_threshold|
 * above_threshold vocabulary maps onto our paths: ACUTE has no compact
 * disable switch, no failure circuit breaker yet (D5, queued), and its
 * "nothing to summarize" shape is the empty head, hence our four).
 *   · "forced"          — opts.force carried the decision past the gate
 *                          (the R71-e2 overflow-recovery path; the provider
 *                          itself rejected the request as too large).
 *   · "above_threshold"  — the gated count exceeded `available`.
 *   · "below_threshold"  — the gated count fit (the skip).
 *   · "empty_to_summarize" — nothing to summarize (the old null-return
 *                          case: a session too short to compact).
 */
export type CompactionDecisionReason = "forced" | "above_threshold" | "below_threshold" | "empty_to_summarize";

/** ROUND-125 (R125-C, D1): which number won the threshold gate. */
export type CompactionTokenSource = "provider-anchored" | "estimated";

/** ROUND-125 (R125-C, D2): the decision data attached to EVERY planCompaction
 * result (compact and skip alike) — the observability half of the ZCode
 * adoption: "why did/didn't it compact" is now a typed field, not a guess
 * reconstructed from estimate arithmetic. */
export interface CompactionDecisionFields {
  decision: "compact" | "skip";
  /** The number the threshold gate used: the D1 anchor when a valid
   * tokenOverride was passed, the local estimate otherwise. */
  tokenCount: number;
  tokenSource: CompactionTokenSource;
  /** The local estimate of the whole list — always reported (the dual-number
   * pair; equals tokenCount whenever tokenSource is "estimated"). */
  estimatedTokens: number;
  /** The available budget the gate compared against. */
  threshold: number;
  reason: CompactionDecisionReason;
}

/** ROUND-125 (R125-C, D2): planCompaction's result union — the SKIP side
 * carries the typed decision (the pre-R125 `null` returns became
 * { decision: "skip", reason: "below_threshold" | "empty_to_summarize" }
 * objects; the two test pins that asserted null were updated with
 * comments). The COMPACT side is the old plan plus the same fields, plus
 * the R128-W8 (D3a) round-alignment fields. */
export type CompactionPlan =
  | (CompactionDecisionFields & { decision: "skip" })
  | (CompactionDecisionFields & {
      decision: "compact";
      toSummarize: SeqMessage[];
      keep: SeqMessage[];
      targetThroughSeq: number;
      /* ROUND-128 (R128-W8, D3a): the selection's shape — additive on the
       * COMPACT side only (a skip made no selection). roundAligned is
       * false ONLY when the materiality guard kept the byte-budget cut
       * (a round WAS split — the honest fallback); a boundary that splits
       * no assistant round is true, extension or not. */
      roundAligned: boolean;
      /** Whole assistant-started rounds preserved verbatim in `keep`. */
      preservedRounds: number;
    });

/** The compaction event type name (appendSessionEvent accepts any string;
 * readers that don't know the type skip it — the UI event filters only
 * render known types, so no frontend change is required). */
export const COMPACTION_EVENT_TYPE = "context.compact";

/** R128-W8 (D3a): the materiality guard on the round-boundary extension —
 * the extended keep set may grow past the 60% keep-target by at most this
 * factor (1.25 → at most 75% of `available`); beyond it the byte-budget
 * cut stands and the plan reports roundAligned:false. Keeps a single
 * gigantic assistant round from consuming the window the compaction
 * exists to free. */
export const ROUND_EXTENSION_TOLERANCE = 1.25;

/* ── ROUND-128 (R128-W8, D5): the rapid-refill circuit breaker ────────── */

/** R128-W8 (D5): a compaction is a RAPID REFILL when fewer than this many
 * tool turns (persisted tool.use events) passed since the previous one —
 * the session is compacting faster than it fills (ZCode
 * turn-loop-state.ts RAPID_REFILL_TOOL_TURN_THRESHOLD's twin). */
export const RAPID_REFILL_TOOL_TURN_THRESHOLD = 3;

/** R128-W8 (D5): this many consecutive rapid refills trip the breaker —
 * the next AUTO compaction is blocked for the session (ZCode
 * turn-loop-state.ts MAX_CONSECUTIVE_RAPID_REFILLS's twin; ACUTE derives
 * the count from the durable event log instead of in-memory turn state,
 * so the block survives restarts). */
export const MAX_CONSECUTIVE_RAPID_REFILLS = 3;

/** The persisted turn.warning's kind for a tripped rapid-refill breaker
 * (the runtime loop-guard warnings' payload shape: {kind, message, …} —
 * diagnostics only, never args/outputs/secrets). */
export const RAPID_REFILL_WARNING_KIND = "compaction_rapid_refill";

/** The breaker's teaching copy — one pinned string, surfaced verbatim as
 * the turn.warning's message (the phone's transcript renders it as a meta
 * line; the desktop log-fold skips the type safely). */
export const RAPID_REFILL_WARNING_MESSAGE =
  "Auto-compaction is paused for this session: it is compacting faster than the conversation fills " +
  "(several compactions in a row with fewer than 3 tool calls between them — likely a runaway tool-output loop). " +
  "Force a compaction with POST /sessions/:id/compact, or trim the oversized tool output; " +
  "auto-compaction resumes after 3+ tool calls pass without a compaction.";

/** R128-W8 (D5): the rapid-refill breaker's verdict over an event log.
 * PURE — derived entirely from the persisted events, pinnable without a
 * DB. */
export interface RapidRefillBreakerDecision {
  /** True when the next AUTO compaction must be blocked. */
  blocked: boolean;
  /** How many context.compact events have landed (any payload shape — the
   * cadence signal is the event's existence). */
  compactions: number;
  /** tool.use counts between consecutive compactions, oldest → newest.
   * gaps[0] counts from the LOG'S START to the first compaction (the
   * honest durable twin of ZCode's undefined-tracking ≡ 0 baseline); the
   * would-be gap of the NEXT compaction is NOT in here — it is
   * toolUsesSinceLastCompact. */
  gaps: number[];
  /** tool.use events since the LAST compaction (since the log's start when
   * none has landed yet) — the would-be next gap. ≥ threshold means the
   * streak already reset ("a compaction followed by ≥3 tool turns"). */
  toolUsesSinceLastCompact: number;
  /** How many TRAILING compactions were each rapid (their gap since the
   * previous compaction was < RAPID_REFILL_TOOL_TURN_THRESHOLD). */
  consecutiveRapidRefills: number;
}

/**
 * R128-W8 (D5): evaluate the rapid-refill circuit breaker over a session
 * event log — ZCode turn-loop-state.ts evaluateRapidRefill's durable ACUTE
 * twin (the study's §D5).
 *
 * The law: BLOCK the next auto compaction when the last
 * MAX_CONSECUTIVE_RAPID_REFILLS compactions EACH landed with fewer than
 * RAPID_REFILL_TOOL_TURN_THRESHOLD tool turns since the previous one AND
 * the current stretch since the last compaction is still under the
 * threshold (the reset: a compaction followed by ≥3 tool turns breaks the
 * streak — a session that recovered does not get punished for its past).
 * The manual compact route and the overflow-recovery force path bypass
 * the breaker by construction (they ride opts.force; the check runs on
 * the AUTO path only).
 *
 * PURE (events in, decision out) — the decision table is unit-pinned in
 * tests/r128-compaction-d3d5.test.ts.
 */
export function evaluateRapidRefill(events: readonly SessionEvent[]): RapidRefillBreakerDecision {
  let compactions = 0;
  let toolUses = 0;
  const gaps: number[] = [];
  for (const ev of events) {
    if (ev.type === "tool.use") {
      toolUses += 1;
      continue;
    }
    if (ev.type === COMPACTION_EVENT_TYPE) {
      compactions += 1;
      gaps.push(toolUses);
      toolUses = 0;
    }
  }
  let consecutiveRapidRefills = 0;
  for (let i = gaps.length - 1; i >= 0; i--) {
    if (gaps[i] < RAPID_REFILL_TOOL_TURN_THRESHOLD) consecutiveRapidRefills += 1;
    else break;
  }
  const toolUsesSinceLastCompact = toolUses;
  const blocked =
    consecutiveRapidRefills >= MAX_CONSECUTIVE_RAPID_REFILLS &&
    toolUsesSinceLastCompact < RAPID_REFILL_TOOL_TURN_THRESHOLD;
  return { blocked, compactions, gaps, toolUsesSinceLastCompact, consecutiveRapidRefills };
}

/** R128-W8 (D5): has a rapid-refill warning already been sent for the
 * CURRENT episode? True when the newest rapid-refill turn.warning is
 * newer than the newest compaction (one warning per streak — a blocked
 * session re-checked every outer-loop iteration must not spam identical
 * rows; the next compaction closes the episode and re-arms the warning).
 * PURE. */
function rapidRefillWarningAlreadySent(events: readonly SessionEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === COMPACTION_EVENT_TYPE) return false;
    if (ev.type === "turn.warning") {
      const payload = ev.payload !== null && typeof ev.payload === "object" ? (ev.payload as Record<string, unknown>) : {};
      if (payload.kind === RAPID_REFILL_WARNING_KIND) return true;
    }
  }
  return false;
}

/** R128-W8 (D5): persist the breaker's loud warning — a turn.warning
 * session event in the runtime loop-guard warnings' own payload shape
 * ({kind, message, …counts}; agentId null like every compaction-owned
 * event). Best-effort by construction (the persistLoopWarning idiom: the
 * durable, reload-safe record; a write failure must never fail the
 * assembly). */
function persistRapidRefillWarning(
  db: Database.Database,
  sessionId: string,
  decision: RapidRefillBreakerDecision,
): void {
  try {
    appendSessionEvent(db, sessionId, {
      type: "turn.warning",
      agentId: null,
      payload: {
        kind: RAPID_REFILL_WARNING_KIND,
        message: RAPID_REFILL_WARNING_MESSAGE,
        consecutiveRapidRefills: decision.consecutiveRapidRefills,
        toolTurnsSinceLastCompact: decision.toolUsesSinceLastCompact,
        compactions: decision.compactions,
      },
    });
  } catch {
    // Best-effort — the blocked skip below is the real contract; the
    // warning is the story on top of it.
  }
}

/** How much of a compact summary rides into the persisted memory row (the
 * task's 400-char slice — a memory is a POINTER + a taste, not a second
 * copy of the summary; the full summary stays in the session's own event
 * log). */
const MEMORY_SUMMARY_SLICE_CHARS = 400;

/**
 * ROUND-117 (R117-b): COMPACTION → MEMORY — the episodic bridge. When a
 * compaction summarizes a session's head, the summary is ALSO persisted
 * into the project's memory (kind 'note', source 'system', content
 * "Session summary ({session title}): {first 400 chars}") so FUTURE
 * sessions start knowing what past sessions did — this is the honest,
 * deterministic auto-memory-formation step (no extra LLM call; the summary
 * was already paid for). Dedup rides saveMemoryWithDedup: a re-compact
 * producing identical summary text REFRESHES the existing row instead of
 * inserting a twin. Best-effort by construction (every failure path is a
 * no-op — a memory write can never fail the compaction itself). Skips
 * honestly when the session has no bound project or the memory master
 * switch is off (nothing to write to, nowhere to recall from).
 */
function persistCompactionSummaryToMemory(
  db: Database.Database,
  sessionId: string,
  summary: string,
): void {
  try {
    const session = getSession(db, sessionId);
    if (session?.projectId === null || session === undefined) return;
    if (!getMemorySettings(db).enabled) return;
    const title = session.title ?? "Untitled session";
    saveMemoryWithDedup(db, {
      projectId: session.projectId,
      kind: "note",
      content: `Session summary (${title}): ${summary.slice(0, MEMORY_SUMMARY_SLICE_CHARS)}`,
      source: "system",
    });
  } catch {
    // Best-effort — never a compaction failure mode (the round-46 contract).
  }
}

/** Find the newest context.compact payload in the event log (or null). A
 * malformed payload (empty summary / non-positive throughSeq) is treated as
 * absent — assembly falls back to raw messages, never crashes. */
export function findLatestCompaction(events: readonly SessionEvent[]): CompactionPayload | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type !== COMPACTION_EVENT_TYPE) continue;
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
    const throughSeq = typeof payload.throughSeq === "number" ? payload.throughSeq : 0;
    if (summary === "" || throughSeq <= 0) return null;
    return {
      summary,
      throughSeq,
      droppedMessages: typeof payload.droppedMessages === "number" ? payload.droppedMessages : 0,
      tokensSaved: typeof payload.tokensSaved === "number" ? payload.tokensSaved : 0,
      // ROUND-125 (R125-C, D2): the typed-decision fields ride the fold
      // verbatim when present — the same typed guards as the fields above;
      // a pre-R125 event yields undefined for each (the additive contract:
      // old events simply lack them).
      tokenCount: typeof payload.tokenCount === "number" ? payload.tokenCount : undefined,
      tokenSource:
        payload.tokenSource === "provider-anchored" || payload.tokenSource === "estimated"
          ? payload.tokenSource
          : undefined,
      estimatedTokens: typeof payload.estimatedTokens === "number" ? payload.estimatedTokens : undefined,
      threshold: typeof payload.threshold === "number" ? payload.threshold : undefined,
      reason:
        payload.reason === "forced" ||
        payload.reason === "above_threshold" ||
        payload.reason === "below_threshold" ||
        payload.reason === "empty_to_summarize"
          ? payload.reason
          : undefined,
      // ROUND-128 (R128-W8, D3a): the round-alignment fields fold verbatim
      // when present — the same typed-guard discipline as the fields above;
      // a pre-R128 event yields undefined for each (the additive contract:
      // old events simply lack them).
      roundAligned: typeof payload.roundAligned === "boolean" ? payload.roundAligned : undefined,
      preservedRounds:
        typeof payload.preservedRounds === "number" &&
        Number.isFinite(payload.preservedRounds) &&
        payload.preservedRounds >= 0
          ? payload.preservedRounds
          : undefined,
      // R129-CTX2 (ZCode D4): the re-injection paths fold verbatim when
      // present — the same typed-guard discipline; a pre-R129 event yields
      // undefined (the additive contract: old events simply lack them).
      reinjectedPaths:
        Array.isArray(payload.reinjectedPaths) &&
        payload.reinjectedPaths.every((p) => typeof p === "string")
          ? (payload.reinjectedPaths as string[])
          : undefined,
    };
  }
  return null;
}

/** Render the compact summary as the leading user message the model sees. */
export function summaryMessage(compact: Pick<CompactionPayload, "summary" | "droppedMessages">): SeqMessage {
  return {
    role: "user",
    content:
      `[Earlier conversation compacted (${compact.droppedMessages} messages summarized — ` +
      `the summary below is the authoritative record of that work; treat it as fact).]\n${compact.summary}`,
    throughSeq: 0,
  };
}

/** Apply a compaction to seq-annotated messages: drop everything covered by
 * throughSeq, prepend the summary message. Pure — no DB access.
 * R129-CTX2 (ZCode D4): when the payload carries reinjectedPaths, the
 * reminder note rides right after the summary — the model-facing list is
 * [summary, reminder, …kept]. Old events without the field render exactly
 * as before (the additive contract). */
export function applyCompaction(messages: readonly SeqMessage[], compact: CompactionPayload): SeqMessage[] {
  const kept = messages.filter((m) => m.throughSeq > compact.throughSeq);
  const reminder =
    compact.reinjectedPaths !== undefined && compact.reinjectedPaths.length > 0
      ? [reinjectionNoteMessage(compact.reinjectedPaths)]
      : [];
  return [summaryMessage(compact), ...reminder, ...kept];
}

/**
 * ROUND-125 (R125-C, D1): the provider-usage token anchor — ZCode
 * runtime/methods/compact.ts buildProviderUsageTokenOverride's ACUTE twin.
 *
 * Walks the event log NEWEST → OLDEST for the LAST persisted
 * message.assistant event whose payload.usage.inputTokens is a finite
 * positive number (the runtime persists one per assistant reply — sync path
 * runtime.ts `usage: { inputTokens, outputTokens }`, streamed path
 * flushSegment's stats + the stats-carrier event), and returns:
 *
 *   anchor = provider inputTokens + estimate(messages AFTER that event)
 *
 * The provider's number is GROUND TRUTH for everything it had been sent when
 * it reported it (our R64 estimator is the ±15% guess); the tail — the
 * model-facing messages whose throughSeq is GREATER than the event's seq —
 * is exactly what the provider had NOT yet seen: assembleHistory annotates
 * every SeqMessage with the seq of the LAST event that contributed to it
 * (message events carry their own seq; a <tool_results> block carries the
 * final tool.use seq folded into it), so `throughSeq > anchorSeq` selects
 * precisely the post-anchor messages. ZCode's twin nuance
 * (incrementalStartIndex at vs after the anchor message) resolves here to
 * strictly-after: our persisted inputTokens covers the request INPUT only —
 * the anchor assistant's own text was its OUTPUT, not input, so the honest
 * blind spot is that ONE message's tokens (bounded by a single reply,
 * absorbed by the budget margin; the R71-e2 force path catches any real
 * overflow reactively). Returns null when no usage-bearing assistant event
 * exists — the caller falls back to the pure local estimate and behaves
 * byte-identically to pre-R125.
 *
 * PURE (events + messages in, number out) — pinnable without a DB.
 *
 * ROUND-128 (R128-W8, D3b) — ANCHOR INVALIDATION, ZCode
 * agent/message-history.ts invalidateRuntimeTokenUsage's law: a compaction
 * boundary invalidates every usage anchor at or before it. A provider
 * inputTokens row measures the serialization of the request THAT PRODUCED
 * it — and every assistant event persisted BEFORE the compaction event
 * landed (the summarized head AND the preserved keep-set tail alike: both
 * existed pre-compaction) replied to requests that contained the raw,
 * un-summarized history. The pre-R128 stale-anchor over-trigger window —
 * "after a compaction lands but before the next successful provider reply
 * re-anchors, the stale provider number still counts messages the new
 * summary replaced" — is closed here: the scan finds the NEWEST valid
 * context.compact event (same malformed-payload guard as
 * findLatestCompaction — a malformed newest compaction poisons the boundary
 * to absent, exactly as the fold treats it) and returns null unless a
 * usage-bearing assistant event exists STRICTLY AFTER it. The self-healing
 * law stands: any successful provider call after a compaction re-anchors
 * exactly (its reply persists after the compaction event by construction —
 * the turn loop assembles the post-compaction list for that very call).
 */
export function providerUsageAnchor(
  events: readonly SessionEvent[],
  messages: readonly SeqMessage[],
): number | null {
  // R128-W8 (D3b): the compaction boundary — the newest VALID
  // context.compact event's own seq. Everything at-or-before it measured
  // the pre-compaction serialization and is not an honest anchor for the
  // current (summary + tail) request.
  let compactEventSeq: number | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type !== COMPACTION_EVENT_TYPE) continue;
    const payload = ev.payload !== null && typeof ev.payload === "object" ? (ev.payload as Record<string, unknown>) : {};
    const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
    const throughSeq = typeof payload.throughSeq === "number" ? payload.throughSeq : 0;
    // findLatestCompaction's exact law: a malformed NEWEST compaction is
    // treated as absent (return null there too — an older valid event must
    // not become a boundary the fold itself refuses).
    if (summary === "" || throughSeq <= 0) break;
    compactEventSeq = ev.seq;
    break;
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type !== "message.assistant") continue;
    // R128-W8 (D3b): the walk is newest→oldest over seq-ordered events, so
    // the FIRST assistant event found below the boundary means every
    // remaining (older) candidate is pre-boundary too — the honest "no
    // anchor" (the estimate fallback; callers already handle null for the
    // no-usage-row case).
    if (compactEventSeq !== null && ev.seq < compactEventSeq) return null;
    const payload =
      ev.payload !== null && typeof ev.payload === "object" ? (ev.payload as Record<string, unknown>) : null;
    const usage =
      payload !== null && typeof payload.usage === "object" ? (payload.usage as Record<string, unknown>) : null;
    const inputTokens = usage?.inputTokens;
    // Garbage rows (NaN / 0 / negative / non-number) are skipped, not trusted
    // — the walk continues to the next older usage-bearing event (the
    // "LAST event whose inputTokens is a finite number > 0" law).
    if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens) || inputTokens <= 0) continue;
    const tail = messages.filter((m) => m.throughSeq > ev.seq);
    const tailTokens = estimateMessageTokens(tail.map(({ role, content }) => ({ role, content })));
    return inputTokens + tailTokens;
  }
  return null;
}

/** One round of the conversation — a group of contiguous messages produced
 * by one assistant exchange (see groupByAssistantStartedRounds). */
export interface MessageRoundGroup {
  /** The group's messages, in conversation order. */
  messages: SeqMessage[];
  /** True when this group was STARTED by an assistant message beginning a
   * new round. The FIRST group is the head group — leading user messages
   * before the first assistant (a degenerate assistant-first list's opening
   * segment functions as the head too, ZCode compact/rounds.ts's own law:
   * its `current.length > 0` guard merges the opening assistant into the
   * first group) — and carries false. */
  assistantStarted: boolean;
}

/**
 * ROUND-128 (R128-W8, D3a): group a message list into ASSISTANT-STARTED
 * ROUNDS — ZCode compact/rounds.ts groupByAssistantStartedRounds's ACUTE
 * twin (the selection half of the study's D3).
 *
 * A ROUND starts at each assistant-role message and extends through the
 * subsequent tool/user messages (an assembled <tool_results> block is a
 * user-role message, so an assistant's tool exchange is exactly one round)
 * until the next assistant message. Leading user messages before the first
 * assistant form their own HEAD group. Consecutive assistant messages each
 * start their own round (ACUTE persists no assistant-id at this seam to
 * merge streaming segments — each persisted assistant event is a round
 * start, the honest granularity for never splitting an exchange).
 *
 * PURE (messages in, groups out) — pinnable without a DB. The boundary math
 * in planCompaction consumes the group START indices; the keep/summarize
 * split always lands ON one so no assistant's tool_call is ever summarized
 * while its tool_result survives verbatim in the tail (or vice versa).
 */
export function groupByAssistantStartedRounds(messages: readonly SeqMessage[]): MessageRoundGroup[] {
  const groups: MessageRoundGroup[] = [];
  let current: SeqMessage[] = [];
  let currentAssistantStarted = false;
  for (const message of messages) {
    if (message.role === "assistant" && current.length > 0) {
      groups.push({ messages: current, assistantStarted: currentAssistantStarted });
      current = [message];
      currentAssistantStarted = true;
    } else {
      current.push(message);
    }
  }
  if (current.length > 0) {
    groups.push({ messages: current, assistantStarted: currentAssistantStarted });
  }
  return groups;
}

/**
 * Plan a NEW compaction when the history is over budget. Keeps the newest
 * messages that fit within ~60% of the available budget (so the next
 * compaction is far away, not imminent); the head beyond that is what the
 * summarizer receives. Always keeps at least the final message. Returns the
 * SKIP decision when nothing needs compacting (under budget) or there is
 * nothing to summarize.
 *
 * ROUND-71 (R71-e2, D5): `force` skips the "under budget → nothing to do"
 * gate — armed by the runtime's overflow-recovery path when the PROVIDER
 * ITSELF rejected the request as too large (a context_window_exceeded
 * classification is ground truth; the ±15% token estimate is the guess that
 * missed it). The empty-to-summarize check still skips: a session with a
 * single message has nothing to compact and the recovery must fail honestly
 * instead of pretending otherwise.
 *
 * ROUND-125 (R125-C, D1): `opts.tokenOverride` — the provider-usage anchor
 * (see providerUsageAnchor). When it is a finite positive number it REPLACES
 * the fresh whole-list estimate in the over-budget gate (the provider's own
 * number is the truth; the estimate stays the fallback and BOTH are
 * reported on the decision). ZCode compact/policy.ts shouldAutoCompact's
 * `tokenOverride?.tokenCount ?? estimatedTokenCount`, the same law.
 *
 * ROUND-125 (R125-C, D2): the return is the TYPED decision on every path —
 * { decision: "skip", reason: "below_threshold" | "empty_to_summarize", … }
 * where pre-R125 returned null, and the compact plan carries the same
 * fields (ZCode AutoCompactDecision's twin).
 *
 * ROUND-128 (R128-W8, D3a): ROUND-ALIGNED SELECTION — the study's D3
 * selection half, ZCode compact/rounds.ts + helpers/compact-selection.ts's
 * "preserve the last round verbatim" law wearing ACUTE's 60% keep-window
 * shape. After the byte-budget cut computes `boundary`, the boundary walks
 * BACK to the start of the oldest kept assistant round
 * (groupByAssistantStartedRounds): the whole partial round joins the keep
 * set, and the summarize set is everything before that round start — an
 * assistant's tool_call is never summarized while its tool_result rides in
 * the tail. Materiality guard (the honest fallback): when the extension
 * would push the keep set past 125% of the 60% keep-target — i.e. past 75%
 * of `available` — the byte-budget cut stands instead and the plan reports
 * roundAligned:false (a single gigantic round must not consume the window
 * the compaction exists to free). A boundary that already splits no
 * assistant round (it sits ON a round start, or inside the head group —
 * leading user prose is not a round) is round-aligned with no extension.
 */
export function planCompaction(
  messages: readonly SeqMessage[],
  budget: ContextBudget,
  force = false,
  opts?: { tokenOverride?: number },
): CompactionPlan {
  const available = budget.contextWindow - budget.maxOutputTokens - budget.margin;
  // R129-CTX2 (the 90% law — see AUTO_COMPACT_RATIO's header): the AUTO
  // gate line the count is compared against. Pre-R129 this was `available`
  // itself (fire only at overflow); now the auto-compaction starts with
  // headroom — BEFORE the request that would have overflowed, awaited in
  // the turn loop, exactly the owner's "auto-start the compression without
  // performing any of the next tasks". The keep-target below stays 60% of
  // `available`, so a fresh compaction lands at ~60% — a 30-point refill
  // runway before the next auto fire (the R128-W8 rapid-refill breaker
  // still guards the pathological refill case).
  const autoCompactAt = Math.max(1, Math.floor(available * AUTO_COMPACT_RATIO));
  const total = estimateMessageTokens(messages.map(({ role, content }) => ({ role, content })));
  // R125-C (D1): a non-finite / non-positive override is garbage, not an
  // anchor — the estimate wins (the helper's own guard, re-checked here so
  // planCompaction stays safe against raw caller input).
  const override = opts?.tokenOverride;
  const anchored = typeof override === "number" && Number.isFinite(override) && override > 0;
  const tokenCount = anchored ? (override as number) : total;
  const tokenSource: CompactionTokenSource = anchored ? "provider-anchored" : "estimated";
  if (!force && tokenCount <= autoCompactAt) {
    return {
      decision: "skip",
      tokenCount,
      tokenSource,
      estimatedTokens: total,
      // R129-CTX2: the threshold field reports the number the gate ACTUALLY
      // compared against — the 90% auto line (the semantic is unchanged:
      // "the budget the gate compared against"; only its value moved).
      threshold: autoCompactAt,
      reason: "below_threshold",
    };
  }
  const target = Math.max(1, Math.floor(available * 0.6));
  let acc = 0;
  let boundary = messages.length; // sentinel: nothing fits
  for (let i = messages.length - 1; i > 0; i--) {
    const cost = estimateMessageTokens([{ role: messages[i].role, content: messages[i].content }]);
    if (acc + cost > target) break;
    acc += cost;
    boundary = i;
  }
  // Never keep nothing: if even the last message overflows the target alone,
  // keep just it.
  if (boundary > messages.length - 1) boundary = messages.length - 1;

  // R128-W8 (D3a): round-align the boundary. Round starts are the indices
  // where an assistant message began a NEW group (≥ 1 by construction — a
  // new round requires an open group); the head group's interior and start
  // are never round starts, so a boundary inside the head group cannot (and
  // must not) extend: no assistant round is split there.
  const roundStarts = new Set<number>();
  {
    let index = 0;
    for (const group of groupByAssistantStartedRounds(messages)) {
      if (group.assistantStarted) roundStarts.add(index);
      index += group.messages.length;
    }
  }
  let roundAligned = true;
  let selectionBoundary = boundary;
  if (!roundStarts.has(boundary)) {
    let roundStart = -1;
    for (let i = boundary; i >= 0; i--) {
      if (roundStarts.has(i)) {
        roundStart = i;
        break;
      }
    }
    if (roundStart >= 0) {
      // The whole round containing `boundary` joins the keep set. Materiality
      // guard: the extension must not push the keep set past 125% of the
      // keep-target (75% of available) — else the byte cut stands, honestly
      // split (roundAligned:false).
      const extendedKeepTokens = estimateMessageTokens(
        messages.slice(roundStart).map(({ role, content }) => ({ role, content })),
      );
      if (extendedKeepTokens <= target * ROUND_EXTENSION_TOLERANCE) {
        selectionBoundary = roundStart;
      } else {
        roundAligned = false;
      }
    }
  }

  // R128-W8 (D3a): preservedRounds — the whole assistant-started rounds in
  // the FINAL keep set (a group split by the boundary does not count).
  let preservedRounds = 0;
  {
    let index = 0;
    for (const group of groupByAssistantStartedRounds(messages)) {
      if (group.assistantStarted && index >= selectionBoundary) preservedRounds += 1;
      index += group.messages.length;
    }
  }

  const toSummarize = messages.slice(0, selectionBoundary);
  if (toSummarize.length === 0) {
    return {
      decision: "skip",
      tokenCount,
      tokenSource,
      estimatedTokens: total,
      // R129-CTX2: the 90% auto line (the gate's own number).
      threshold: autoCompactAt,
      reason: "empty_to_summarize",
    };
  }
  return {
    decision: "compact",
    tokenCount,
    tokenSource,
    estimatedTokens: total,
    // R129-CTX2: the 90% auto line (the gate's own number — the count that
    // reached it is the compaction's cause, forced or auto alike).
    threshold: autoCompactAt,
    // R125-C (D2): "forced" wins the vocabulary whenever force carried the
    // decision past the gate — the numbers are on the decision either way.
    reason: force ? "forced" : "above_threshold",
    toSummarize,
    // R128-W8 (D3a): the ROUND-ALIGNED selection — the keep set starts at
    // the round boundary (extended back from the byte cut when the guard
    // allowed it), so no assistant's tool exchange is split; the additive
    // fields tell the log which shape won.
    keep: messages.slice(selectionBoundary),
    targetThroughSeq: toSummarize[toSummarize.length - 1].throughSeq,
    roundAligned,
    preservedRounds,
  };
}

/** The summarizer's system prompt — R129-CTX2 (round-129.md §4 stage 4):
 * THE ANCHORED TEMPLATE (the convergent finding of all five reference
 * studies — opencode/kilocode/zcode's fixed-section summary, cline's
 * Goal/State/Highlights/Next/Files structure, omp's UPDATE-prompt merge
 * rules — replacing the pre-R129 free-form ~600-word ask). The fixed
 * sections make the summary STATE, not prose: a long-horizon task's
 * "where was I" reads from headers, not from narrative recall (the
 * owner's "cannot handle long horizon tasks… keeps hallucinating").
 * Section laws: exact strings survive verbatim (paths, commands, error
 * messages — the hallucination vector); the Work State split is
 * exhaustive; ## Files is deterministically APPENDED by
 * buildFilesAppendix below if the model omits it (cline's guaranteed
 * Files section); the merge rules make chained compactions
 * summary-of-summaries honest ("anything not carried forward is lost"). */
export const SUMMARIZER_SYSTEM_PROMPT = [
  "You are a context-compaction engine for a coding agent. The transcript below is the EARLY part of an ongoing session; your summary replaces it, so the agent continues from YOUR WORDS alone.",
  "Produce EXACTLY these sections, in this order, as markdown headers:",
  "",
  "## Objective",
  "The user's original task and every requirement change since (one tight paragraph; quote requirements verbatim when they were exact).",
  "",
  "## Key decisions",
  "Each decision made and why (one bullet each; include rejected alternatives only when they were explicitly discussed).",
  "",
  "## Work state",
  "Three subsections: **Completed** (done + verified), **Active** (in flight when the transcript ends — the exact file/step mid-work), **Blocked** (unresolved errors/open questions, each with the exact error string).",
  "",
  "## Relevant files",
  "The files/tools that mattered, one bullet each: exact path + what happened to it.",
  "",
  "## Next move",
  "The single next action the agent should take, per the transcript's own trajectory (never invent one).",
  "",
  "Laws: preserve exact file paths, commands, identifiers, and error strings VERBATIM (never paraphrase them); write in third person about 'the user' and 'the agent'; no preamble, no closing remarks; if a prior summary appears in the transcript, fold it in — anything you drop from it is lost forever; when the transcript contradicts a prior summary, THE TRANSCRIPT WINS. Maximum ~600 words.",
].join("\n");

/* ── R129-CTX2: the deterministic Files appendix + the re-injection paths ── */

/** The tool families whose args carry the PATH the call touched — the
 * appendix + re-injection parse these from the rendered tool lines (the
 * same `toolName(argsSummary) → …` lines assembleHistory renders). */
const FILES_APPENDIX_TOOLS = new Set([
  "read_file",
  "list_dir",
  "write_file",
  "edit_file",
  "create_file",
  "delete_file",
  "create_dir",
]);

/** The appendix's cap — the deterministic list stays glanceable (the
 * model can re-read anything; the summary's own prose carries the rest). */
const FILES_APPENDIX_MAX = 30;

/** R129-CTX2: parse ONE `path: …` segment out of a tool line's args
 * (pathFromArgsSummary's compaction-local twin — runtime.ts cannot be
 * imported from here (cycle), and the regex is one line). */
function pathSegmentOf(toolLine: string): string | null {
  const match = /(?:^|,\s*)path:\s*([^,)]+)/.exec(toolLine);
  const path = match?.[1]?.trim();
  return path !== undefined && path !== "" ? path : null;
}

/** R129-CTX2: parse ONE `cmd: …` segment out of a run_command line's args
 * (the terminal family's key — the appendix's Commands run section). */
function cmdSegmentOf(toolLine: string): string | null {
  const match = /(?:^|,\s*)cmd:\s*([^,)]+)/.exec(toolLine);
  const cmd = match?.[1]?.trim();
  return cmd !== undefined && cmd !== "" ? cmd : null;
}

interface ParsedToolTouch {
  toolName: string;
  path: string | null;
  command: string | null;
}

/** R129-CTX2: parse the `toolName(argsSummary) → …` lines out of the
 * messages-to-summarize (they live inside <tool_results> blocks the same
 * way assembleHistory renders them). Pure. */
function parseToolTouches(messages: readonly SeqMessage[]): ParsedToolTouch[] {
  const touches: ParsedToolTouch[] = [];
  for (const message of messages) {
    if (!message.content.includes("<tool_results>")) continue;
    for (const line of message.content.split("\n")) {
      const match = /^([a-z_]+)\((.*)\) → /.exec(line);
      if (match === null) continue;
      const toolName = match[1];
      const argsSummary = match[2];
      const path = FILES_APPENDIX_TOOLS.has(toolName) ? pathSegmentOf(argsSummary) : null;
      const command = toolName === "run_command" ? cmdSegmentOf(argsSummary) : null;
      touches.push({ toolName, path, command: command !== null ? command : null });
    }
  }
  return touches;
}

/** R129-CTX2 (cline's guaranteed ## Files section — the deterministic half):
 * the file paths + commands the summarized region touched, in first-touch
 * order, deduped, capped. When the model's own summary omits (or thins)
 * ## Relevant files / ## Files, runCompaction APPENDS this verbatim — a
 * hallucinated path can never displace the log's own record. */
export function buildFilesAppendix(messages: readonly SeqMessage[]): string {
  const seen = new Set<string>();
  const files: string[] = [];
  const commands: string[] = [];
  for (const touch of parseToolTouches(messages)) {
    if (touch.path !== null && !seen.has(touch.path)) {
      seen.add(touch.path);
      files.push(touch.path);
    } else if (touch.command !== null && !seen.has(`cmd:${touch.command}`)) {
      seen.add(`cmd:${touch.command}`);
      commands.push(touch.command);
    }
  }
  const cappedFiles = files.slice(0, FILES_APPENDIX_MAX);
  const cappedCommands = commands.slice(0, 10);
  if (cappedFiles.length === 0 && cappedCommands.length === 0) return "";
  const parts: string[] = [];
  if (cappedFiles.length > 0) {
    parts.push("## Files (complete, from the event log)");
    for (const path of cappedFiles) parts.push(`- ${path}`);
    if (files.length > FILES_APPENDIX_MAX) parts.push(`- …+${files.length - FILES_APPENDIX_MAX} more`);
  }
  if (cappedCommands.length > 0) {
    parts.push("## Commands run");
    for (const command of cappedCommands) parts.push(`- ${command}`);
    if (commands.length > 10) parts.push(`- …+${commands.length - 10} more`);
  }
  return parts.join("\n");
}

/** R129-CTX2 (ZCode D4 — the re-injection paths): the ≤5 MOST RECENTLY READ
 * distinct paths in the summarized region — the files that were literally
 * in the model's hands when the cut happened. These ride the event payload
 * (reinjectedPaths) and every applyCompaction renders the reminder note. */
export function recentReadPaths(messages: readonly SeqMessage[], max = 5): string[] {
  const touches = parseToolTouches(messages);
  const byPath = new Map<string, number>();
  for (let i = 0; i < touches.length; i++) {
    const touch = touches[i];
    if (touch.toolName !== "read_file" && touch.toolName !== "list_dir") continue;
    if (touch.path === null) continue;
    byPath.set(touch.path, i); // later reads overwrite earlier indices
  }
  return [...byPath.entries()]
    .sort((a, b) => b[1] - a[1]) // newest read first
    .slice(0, max)
    .map(([path]) => path);
}

/** R129-CTX2 (ZCode D4): the reminder note applyCompaction appends after
 * the summary when the payload carries reinjectedPaths — the model's
 * "you were holding these files" pointer, so post-compaction it re-opens
 * its working set by name instead of guessing. */
export function reinjectionNoteMessage(paths: readonly string[]): SeqMessage {
  return {
    role: "user",
    content:
      `[context reminder] The files you were most recently reading before the conversation was compacted: ` +
      `${paths.join(", ")}. Re-read any of them you still need.`,
    throughSeq: 0,
  };
}

/** Render the messages-to-summarize as a transcript for the summarizer. */
export function renderTranscript(messages: readonly SeqMessage[]): string {
  return messages
    .map((m) => `${m.role === "user" ? "USER" : "AGENT"}: ${m.content}`)
    .join("\n\n");
}

export interface CompactionDeps {
  db: Database.Database;
  sessionId: string;
  chat: ChatFn;
  provider: { id: string; baseUrl: string | null; apiFormat?: string };
  apiKey: string;
  model: string;
}

export interface CompactionOutcome {
  /** The final model-facing message list (compacted or verbatim). */
  messages: ChatTurnMessage[];
  /** True when a NEW compaction was performed this call (event appended). */
  compacted: boolean;
  /** Details of the compaction performed (present iff compacted). */
  detail?: CompactionPayload;
}

/**
 * Assemble the model-facing messages for one outer-loop iteration with
 * compaction. Reads the newest context.compact event (reuses it — no
 * re-summarization while it holds), plans a fresh compaction only if the
 * budget still overflows, runs the summarizer (same provider/model, NO
 * tools, maxTurns 1), persists the event, and returns the message list.
 * Any summarizer failure falls back to the legacy hard trim
 * (assembleWithinBudget) — compaction never becomes a new failure mode.
 *
 * ROUND-71 (R71-e2, D5): `opts.force` plans a compaction even when the
 * token ESTIMATE says the history fits — the overflow-recovery path (a
 * provider-side context_window_exceeded rejection) calls with it; the
 * summarize → persist → reuse pipeline below is exactly the same, and the
 * summarizer-failure hard-trim fallback still applies (a recovery attempt
 * is a recovery attempt — the retry will honestly fail if it wasn't enough).
 *
 * ROUND-125 (R125-C, D1): `opts.tokenOverride` — the provider-usage anchor
 * (providerUsageAnchor), built by the runtime at its call sites from the
 * last persisted usage-bearing assistant event and threaded down here.
 * It replaces the local estimate in planCompaction's over-budget gate and
 * rides the persisted event payload as the typed decision fields (D2), so
 * the log answers “why did it compact, and on whose numbers”.
 *
 * ROUND-128 (R128-W8, D3a/D5): the persisted event carries the
 * round-alignment fields additively (roundAligned + preservedRounds — old
 * events and readers simply lack/ignore them), and the AUTO path runs the
 * rapid-refill circuit breaker BEFORE the summarizer fires: when the last
 * MAX_CONSECUTIVE_RAPID_REFILLS compactions each landed with fewer than
 * RAPID_REFILL_TOOL_TURN_THRESHOLD tool turns since the previous one (and
 * the current stretch is still under the threshold), the compaction is
 * SKIPPED — the raw (prior-compaction-applied) messages ride on, a
 * turn.warning (kind "compaction_rapid_refill", one per episode) carries
 * the teaching copy, and no context.compact event lands. NEVER blocked: the
 * manual compact route and the overflow-recovery force path (both ride
 * opts.force — the provider itself said the request was too large; a
 * recovery attempt is a recovery attempt) and the summarizer-failure
 * hard-trim fallback (it runs after the breaker allowed the attempt).
 */
export async function assembleWithCompaction(
  seqMessages: readonly SeqMessage[],
  budget: ContextBudget,
  deps: CompactionDeps,
  opts?: { force?: boolean; tokenOverride?: number },
): Promise<CompactionOutcome> {
  const events = listSessionEvents(deps.db, deps.sessionId);
  const latest = findLatestCompaction(events);
  const applied: SeqMessage[] = latest ? applyCompaction(seqMessages, latest) : [...seqMessages];

  // R125-C (D1): the anchor is threaded (not recomputed here) so the pure
  // helper stays caller-owned and jest-pinnable; a manual/force caller (the
  // R83 compact route) simply omits it and keeps the estimate-only gate.
  const plan = planCompaction(applied, budget, opts?.force === true, { tokenOverride: opts?.tokenOverride });
  if (plan.decision === "skip") {
    // Within budget (with any prior compaction applied): use as-is. If some
    // prior trim marker is already inside `applied` it stays — nothing to do.
    return { messages: applied.map(({ role, content }) => ({ role, content })), compacted: false };
  }

  // R128-W8 (D5): the rapid-refill circuit breaker — the AUTO path only
  // (opts.force is the manual route / the overflow-recovery path; both
  // bypass by construction). Blocked → skip the compaction entirely: the
  // raw messages go out (they fit or the provider rejects and the FORCE
  // path recovers), the teaching warning persists once per episode, and no
  // event lands (the next iteration re-plans from raw events).
  if (opts?.force !== true) {
    const breaker = evaluateRapidRefill(events);
    if (breaker.blocked) {
      if (!rapidRefillWarningAlreadySent(events)) {
        persistRapidRefillWarning(deps.db, deps.sessionId, breaker);
      }
      return { messages: applied.map(({ role, content }) => ({ role, content })), compacted: false };
    }
  }

  let summary = "";
  // ROUND-83 (R83): the summarizer's own spend — a REAL provider call over
  // the full over-budget transcript that previously appeared NOWHERE (the
  // audit's §2.12: unbilled hidden calls). Recorded with origin
  // "compaction" + agentId null; best-effort (a recording failure must
  // never fail the compaction itself).
  let summarizerUsage:
    | { inputTokens: number; outputTokens: number; cachedInputTokens: number | null }
    | null = null;
  try {
    const result = await deps.chat({
      provider: deps.provider,
      apiKey: deps.apiKey,
      model: deps.model,
      system: SUMMARIZER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: renderTranscript(plan.toSummarize) }],
      temperature: 0,
      maxTurns: 1,
      // No tools: the summarizer must never act, only read.
    });
    summary = result.text.trim();
    summarizerUsage = {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedInputTokens: typeof result.usage.cachedInputTokens === "number" ? result.usage.cachedInputTokens : null,
    };
  } catch {
    summary = "";
  }
  if (summarizerUsage !== null && (summarizerUsage.inputTokens > 0 || summarizerUsage.outputTokens > 0)) {
    try {
      // Mirrors runtime.ts computeCost's R62 per-side-independent pricing
      // (compaction.ts cannot import runtime.ts — cycle); lookupPricing is
      // the same source of truth.
      const pricing = lookupPricing(deps.db, deps.provider.id, deps.model);
      const inputCost =
        pricing.inputPricePerMtok === null ? 0 : (summarizerUsage.inputTokens / 1_000_000) * pricing.inputPricePerMtok;
      const outputCost =
        pricing.outputPricePerMtok === null ? 0 : (summarizerUsage.outputTokens / 1_000_000) * pricing.outputPricePerMtok;
      recordUsage(
        deps.db,
        {
          agentId: null,
          sessionId: deps.sessionId,
          provider: deps.provider.id,
          model: deps.model,
          inputTokens: summarizerUsage.inputTokens,
          outputTokens: summarizerUsage.outputTokens,
          cachedInputTokens: summarizerUsage.cachedInputTokens,
          costUsd: inputCost + outputCost,
          ts: new Date().toISOString(),
        },
        0,
        { providerCalls: 1, origin: "compaction" },
      );
    } catch {
      // Best-effort accounting — never a compaction failure mode.
    }
  }

  if (summary === "") {
    // Fallback: the legacy hard trim (marker message + newest messages that
    // fit). No event appended — next iteration re-plans from raw events.
    const { messages } = assembleWithinBudget(
      applied.map(({ role, content }) => ({ role, content })),
      budget,
    );
    return { messages, compacted: false };
  }

  // R129-CTX2 (cline's guaranteed ## Files section — the deterministic
  // half): when the model's own summary omits the files section, the
  // event-log-derived appendix rides verbatim — a hallucinated (or
  // forgotten) path can never displace the log's own record. When the
  // model DID write one, its section stands (the model had the full
  // transcript in front of it; the duplicate would only add weight).
  const hasFilesSection = /## (Relevant )?[Ff]iles/.test(summary);
  if (!hasFilesSection) {
    const appendix = buildFilesAppendix(plan.toSummarize);
    if (appendix !== "") {
      summary = `${summary}\n\n${appendix}`;
    }
  }

  // R129-CTX2 (ZCode D4): the re-injection paths — the ≤5 most-recently-read
  // files of the summarized region, persisted on the event so every future
  // applyCompaction (restart, fork, the meter) renders the reminder.
  const reinjectedPaths = recentReadPaths(plan.toSummarize);

  const beforeTokens = estimateMessageTokens(applied.map(({ role, content }) => ({ role, content })));
  const compact: CompactionPayload = {
    summary,
    throughSeq: plan.targetThroughSeq,
    droppedMessages: plan.toSummarize.length,
    tokensSaved: 0,
    // R125-C (D2): the typed decision rides the persisted event — additive
    // fields (ZCode's AutoCompactDecision observability: tokenCount /
    // tokenSource / estimatedTokens / threshold / reason). Old readers and
    // the fold paths ignore them; old EVENTS simply lack them.
    tokenCount: plan.tokenCount,
    tokenSource: plan.tokenSource,
    estimatedTokens: plan.estimatedTokens,
    threshold: plan.threshold,
    reason: plan.reason,
    // R128-W8 (D3a): the round-alignment fields ride the persisted event —
    // same additive contract (old events simply lack them; the fold's typed
    // guards keep them honest on the read side).
    roundAligned: plan.roundAligned,
    preservedRounds: plan.preservedRounds,
    // R129-CTX2 (D4): the reminder's source of truth — additive (old events
    // lack the field; applyCompaction renders the note only when present).
    ...(reinjectedPaths.length > 0 ? { reinjectedPaths } : {}),
  };
  const finalMessages: SeqMessage[] = [
    summaryMessage(compact),
    // R129-CTX2 (D4): the reminder rides the immediate post-compaction list
    // too (applyCompaction adds it on every FUTURE assembly; this is the
    // turn's own first use of the new shape).
    ...(compact.reinjectedPaths !== undefined ? [reinjectionNoteMessage(compact.reinjectedPaths)] : []),
    ...plan.keep,
  ];
  compact.tokensSaved = Math.max(
    0,
    beforeTokens - estimateMessageTokens(finalMessages.map(({ role, content }) => ({ role, content }))),
  );

  appendSessionEvent(deps.db, deps.sessionId, {
    type: COMPACTION_EVENT_TYPE,
    agentId: null,
    payload: { ...compact },
  });
  // ROUND-117 (R117-b): the episodic bridge — the summary that just landed
  // in the event log also lands in the project's MEMORY (see
  // persistCompactionSummaryToMemory above).
  persistCompactionSummaryToMemory(deps.db, deps.sessionId, summary);

  return { messages: finalMessages.map(({ role, content }) => ({ role, content })), compacted: true, detail: compact };
}
