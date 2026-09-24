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
 * comments). The COMPACT side is the old plan plus the same fields. */
export type CompactionPlan =
  | (CompactionDecisionFields & { decision: "skip" })
  | (CompactionDecisionFields & {
      decision: "compact";
      toSummarize: SeqMessage[];
      keep: SeqMessage[];
      targetThroughSeq: number;
    });

/** The compaction event type name (appendSessionEvent accepts any string;
 * readers that don't know the type skip it — the UI event filters only
 * render known types, so no frontend change is required). */
export const COMPACTION_EVENT_TYPE = "context.compact";

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
 * throughSeq, prepend the summary message. Pure — no DB access. */
export function applyCompaction(messages: readonly SeqMessage[], compact: CompactionPayload): SeqMessage[] {
  const kept = messages.filter((m) => m.throughSeq > compact.throughSeq);
  return [summaryMessage(compact), ...kept];
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
 * PURE (events + messages in, number out) — pinnable without a DB. The
 * anchor deliberately over-triggers rather than under-triggers in one known
 * window: after a compaction lands but before the next successful provider
 * reply re-anchors, the stale provider number still counts messages the new
 * summary replaced (ZCode zeroes such anchors via
 * invalidateRuntimeTokenUsage — the research doc's D3, queued, not this
 * round). The self-healing law: any successful provider call after a
 * compaction re-anchors exactly.
 */
export function providerUsageAnchor(
  events: readonly SessionEvent[],
  messages: readonly SeqMessage[],
): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type !== "message.assistant") continue;
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
 */
export function planCompaction(
  messages: readonly SeqMessage[],
  budget: ContextBudget,
  force = false,
  opts?: { tokenOverride?: number },
): CompactionPlan {
  const available = budget.contextWindow - budget.maxOutputTokens - budget.margin;
  const total = estimateMessageTokens(messages.map(({ role, content }) => ({ role, content })));
  // R125-C (D1): a non-finite / non-positive override is garbage, not an
  // anchor — the estimate wins (the helper's own guard, re-checked here so
  // planCompaction stays safe against raw caller input).
  const override = opts?.tokenOverride;
  const anchored = typeof override === "number" && Number.isFinite(override) && override > 0;
  const tokenCount = anchored ? (override as number) : total;
  const tokenSource: CompactionTokenSource = anchored ? "provider-anchored" : "estimated";
  if (!force && tokenCount <= available) {
    return {
      decision: "skip",
      tokenCount,
      tokenSource,
      estimatedTokens: total,
      threshold: available,
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
  const toSummarize = messages.slice(0, boundary);
  if (toSummarize.length === 0) {
    return {
      decision: "skip",
      tokenCount,
      tokenSource,
      estimatedTokens: total,
      threshold: available,
      reason: "empty_to_summarize",
    };
  }
  return {
    decision: "compact",
    tokenCount,
    tokenSource,
    estimatedTokens: total,
    threshold: available,
    // R125-C (D2): "forced" wins the vocabulary whenever force carried the
    // decision past the gate — the numbers are on the decision either way.
    reason: force ? "forced" : "above_threshold",
    toSummarize,
    keep: messages.slice(boundary),
    targetThroughSeq: toSummarize[toSummarize.length - 1].throughSeq,
  };
}

/** The summarizer's system prompt: dense, factual, third-person, no fluff. */
export const SUMMARIZER_SYSTEM_PROMPT = [
  "You are a context-compaction engine for a coding agent. The transcript below is the EARLY part of an ongoing session that no longer fits the model's context window.",
  "Summarize it into a dense factual briefing that preserves EVERYTHING the agent still needs to continue:",
  "- the user's original task and any requirement changes",
  "- key decisions made and why",
  "- files created/edited/deleted (exact paths) and tools run with their outcomes",
  "- errors encountered and how they were resolved",
  "- explicit follow-up steps, open questions, and the todo state",
  "Write in third person about 'the user' and 'the agent'. Tight bullet points. No preamble, no closing remarks. Maximum ~600 words.",
].join("\n");

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
  };
  const finalMessages: SeqMessage[] = [summaryMessage(compact), ...plan.keep];
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
