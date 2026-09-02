/**
 * Context-window management (round-25: Kilo Code parity).
 * Estimates token counts, enforces a budget, and trims the oldest messages
 * when the conversation exceeds the context window.
 */

// ── ROUND-64 (R64-e, owner: "I feel like the calculations are a bit
//    inaccurate, like the token counting system… Maybe try improving it and
//    utilizing the most modern ones… I know it's just a rough estimate kind
//    of thing but I do want a rough estimate to be somewhat of an accurate
//    one.") — a GPT-style BPE approximation replacing chars/4. ──────────────
//
// The old `Math.ceil(text.length / 4)` heuristic is right ON AVERAGE for
// English prose (~4 chars/token) but systematically wrong at the extremes:
// CJK text is ~1-2 tokens PER CHARACTER (chars/4 undercounts 4-8×), digit
// runs split into ≤3-digit pieces, punctuation is ~1 token per 1-2 chars,
// and single spaces merge into the following word's token. This estimator
// models how cl100k/o200k actually pre-tokenize — one regex segmentation
// pass (their contraction/word/number/punct/space split, simplified) plus
// one linear reduce with empirically calibrated per-segment costs:
//
//   · CJK ideographs/kana/hangul      1 token per char (they are rarely
//                                      merged; the honest floor).
//   · letter runs (incl. `_`, which   L/4.5 + 0.1 — cl100k packs common
//     joins identifiers like _slot)    words tighter than L/4 but splits
//                                      long/rare ones into ~4.5-char pieces.
//   · digit groups of ≤3              1 token each — the cl100k
//                                      `\p{N}{1,3}` pre-token split.
//   · common ASCII punctuation        0.5 per char — averages the frequent
//                                      2-char merges ("=>", "==", "://",
//                                      `":`) against lone tokens; a lone
//                                      punct char directly before a WORD
//                                      refunds to 0.25 (".com", "/docs",
//                                      "?ref" ride the word pre-token).
//   · CJK/fullwidth punctuation +     1 token each (、。，！—… are single
//     dashes/curly quotes               cl100k tokens).
//   · other symbols (non-ASCII,      1.5 each — a middle ground between
//     non-CJK — emoji, arrows, …)      single-token symbols and 2-3-token
//                                      astral/rare codepoints.
//   · whitespace                      a single leading space merges into the
//                                      next segment (free — GPT's ` word`
//                                      pre-token); any other whitespace run
//                                      costs ceil(N/3) (runs of 2-4 spaces,
//                                      "\n\n" are 1-2 real tokens).
//
// CALIBRATION METHOD (honest): tiktoken is not available in this sandbox
// (no new deps allowed), so the reference cl100k counts in
// tests/context-estimator.test.ts come from known tokenizer ratios —
// documented per-sample there — not from a live tiktoken run. The constants
// above were tuned so realistic English prose, code, JSON, URLs and CJK all
// land within ±15% of those references (chars/4 misses CJK by 4-8× and
// digits by ~60%). Worst known biases, accepted: URL/JSON punctuation
// merges are modeled as a flat average (±15% on punct-dense lines), and
// random base64-ish blobs tokenize ~2.7 chars/token in cl100k (this
// undercounts them like chars/4 does, but never more).
//
// SHAPE: pure, synchronous, one regex pass + one reduce, O(n) — no
// unbounded loops on pathological input; every consumer
// (estimateMessageTokens, the context report, compaction budgets) keeps
// its exact signature.

/** CJK blocks that tokenize ~1 token per character in cl100k/o200k. */
const CJK_RE = /[\u1100-\u11FF\u3040-\u30FF\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/;
/**
 * GPT-style pre-tokenization, simplified: CJK singles, identifier-ish
 * letter runs (underscores join — `_slot` rides `key`), ≤3-digit groups,
 * whitespace runs, everything else as single "symbol" codepoints. The `u`
 * flag keeps surrogate pairs (emoji) as single segments.
 */
const SEGMENT_RE = new RegExp(
  "[\\u1100-\\u11FF\\u3040-\\u30FF\\u3130-\\u318F\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF]" +
    "|[A-Za-z_]+" +
    "|\\d{1,3}" +
    "|\\s+" +
    "|[^\\sA-Za-z\\d]",
  "gu",
);
/** ASCII punctuation/symbols that cl100k merges aggressively (0.5/char). */
const COMMON_ASCII_PUNCT = /[!-\/:-@\[-`{-~]/;
/** Punctuation that cl100k holds as single tokens (1/char). */
const CJK_WIDTH_PUNCT = /[\u2010-\u2027\u3000-\u303F\uFF01-\uFF60]/;

/**
 * Token estimate calibrated to GPT tokenizer behavior (see the ROUND-64
 * header above). 0 for the empty string; ≥1 for anything else.
 */
export function estimateTokens(text: string): number {
  if (text === "") return 0;
  // The symbol alternative matches any codepoint, so match() never misses;
  // the null check is pure defensiveness for exotic engines.
  const segments = text.match(SEGMENT_RE);
  if (segments === null) return Math.max(1, Math.ceil(text.length / 4));
  let total = 0;
  let pendingSpace = false; // one unconsumed single space (GPT's ` word` merge)
  let punctPending = false; // previous segment: a lone common ASCII punct char
  for (const segment of segments) {
    if (segment.length === 1 && segment === " ") {
      pendingSpace = true; // merges into the next segment — free
      punctPending = false;
      continue;
    }
    pendingSpace = false;
    const head = segment[0];
    if (/\s/.test(head)) {
      // A newline/tab alone, or a whitespace run ≥2 (indent, blank line):
      // "\n" is its own token; "  "/"    "/"\n\n" are 1-2 tokens.
      total += segment.length === 1 ? 1 : Math.ceil(segment.length / 3);
      punctPending = false;
      continue;
    }
    if (CJK_RE.test(head)) {
      total += segment.length; // 1 per CJK char (single-char segments anyway)
      punctPending = false;
      continue;
    }
    if (/[A-Za-z_]/.test(head)) {
      // cl100k's word pre-token takes ONE leading non-letter char — a lone
      // common punct char directly before a word rides it as a cheap prefix
      // (".com", "/docs", "?ref" are single pre-tokens BPE merges often
      // keep whole), so the punct already counted at 0.5 refunds 0.25.
      if (punctPending) total -= 0.25;
      total += segment.length / 4.5 + 0.1;
      punctPending = false;
      continue;
    }
    if (/\d/.test(head)) {
      total += 1; // each ≤3-digit group is one cl100k pre-token
      punctPending = false;
      continue;
    }
    const cost = COMMON_ASCII_PUNCT.test(head) ? 0.5 : CJK_WIDTH_PUNCT.test(head) ? 1 : 1.5;
    total += cost;
    punctPending = cost === 0.5; // only common ASCII punct can ride a word
  }
  if (pendingSpace) total += 1; // trailing lone space is its own token
  return Math.max(1, Math.round(total));
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
