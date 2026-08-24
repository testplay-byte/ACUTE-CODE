/**
 * Context-window management (round-25: Kilo Code parity).
 * Estimates token counts, enforces a budget, and trims the oldest messages
 * when the conversation exceeds the context window.
 */

/** Rough token estimate: ~4 chars per token for English/code. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimate the token cost of a message pair. */
export function estimateMessageTokens(messages: Array<{ role: string; content: string }>): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content) + 8; // +8 for role/formatting overhead
  }
  return total;
}

export interface ContextBudget {
  /** Total context window tokens (e.g. 1,000,000). */
  contextWindow: number;
  /** Max output tokens reserved (e.g. 32,768). */
  maxOutputTokens: number;
  /** Safety margin (e.g. 8,000 for system prompt + tool schemas). */
  margin: number;
}

export interface TrimResult {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  /** Tokens after trimming. */
  usedTokens: number;
  /** Number of messages dropped from the head. */
  droppedCount: number;
  /** True if trimming occurred. */
  wasTrimmed: boolean;
}

/**
 * Assemble messages within a token budget. Keeps the newest messages;
 * drops oldest user/assistant pairs when over budget. Inserts a trim marker
 * so the model knows context was cut.
 */
export function assembleWithinBudget(
  events: Array<{ role: "user" | "assistant"; content: string }>,
  budget: ContextBudget,
): TrimResult {
  const available = budget.contextWindow - budget.maxOutputTokens - budget.margin;
  let total = estimateMessageTokens(events);

  if (total <= available) {
    return { messages: events, usedTokens: total, droppedCount: 0, wasTrimmed: false };
  }

  // Drop oldest pairs (user + assistant together) until within budget
  const working = [...events];
  let dropped = 0;
  while (total > available && working.length > 2) {
    // Drop the oldest user message and the assistant that follows it
    const removed = working.splice(0, Math.min(2, working.length - 2));
    dropped += removed.length;
    total = estimateMessageTokens(working);
  }

  // Insert a trim marker at the head
  const marker = {
    role: "user" as const,
    content: "[Earlier conversation was trimmed to fit the context window. The most recent exchanges are preserved.]",
  };

  return {
    messages: [marker, ...working],
    usedTokens: estimateMessageTokens(working) + 30,
    droppedCount: dropped,
    wasTrimmed: true,
  };
}
