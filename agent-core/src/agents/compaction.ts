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
 */
import type Database from "better-sqlite3";
import { appendSessionEvent, listSessionEvents, type SessionEvent } from "../storage/sessions.js";
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
}

/** The compaction event type name (appendSessionEvent accepts any string;
 * readers that don't know the type skip it — the UI event filters only
 * render known types, so no frontend change is required). */
export const COMPACTION_EVENT_TYPE = "context.compact";

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
 * Plan a NEW compaction when the history is over budget. Keeps the newest
 * messages that fit within ~60% of the available budget (so the next
 * compaction is far away, not imminent); the head beyond that is what the
 * summarizer receives. Always keeps at least the final message. Returns null
 * when nothing needs compacting (under budget) or there is nothing to
 * summarize.
 */
export function planCompaction(
  messages: readonly SeqMessage[],
  budget: ContextBudget,
): { toSummarize: SeqMessage[]; keep: SeqMessage[]; targetThroughSeq: number } | null {
  const available = budget.contextWindow - budget.maxOutputTokens - budget.margin;
  const total = estimateMessageTokens(messages.map(({ role, content }) => ({ role, content })));
  if (total <= available) return null;
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
  if (toSummarize.length === 0) return null;
  return {
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
 */
export async function assembleWithCompaction(
  seqMessages: readonly SeqMessage[],
  budget: ContextBudget,
  deps: CompactionDeps,
): Promise<CompactionOutcome> {
  const events = listSessionEvents(deps.db, deps.sessionId);
  const latest = findLatestCompaction(events);
  const applied: SeqMessage[] = latest ? applyCompaction(seqMessages, latest) : [...seqMessages];

  const plan = planCompaction(applied, budget);
  if (plan === null) {
    // Within budget (with any prior compaction applied): use as-is. If some
    // prior trim marker is already inside `applied` it stays — nothing to do.
    return { messages: applied.map(({ role, content }) => ({ role, content })), compacted: false };
  }

  let summary = "";
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
  } catch {
    summary = "";
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

  return { messages: finalMessages.map(({ role, content }) => ({ role, content })), compacted: true, detail: compact };
}
