// @vitest-environment node
//
// ROUND-64 (R64-e, owner: "I feel like the calculations are a bit inaccurate,
// like the token counting system… I do want a rough estimate to be somewhat
// of an accurate one."): calibration table for context.ts estimateTokens —
// the GPT-style BPE approximation that replaced Math.ceil(chars / 4).
//
// CALIBRATION METHOD, HONESTLY: tiktoken is NOT available in this sandbox
// (no new dependencies allowed), so the `reference` column below is NOT a
// live tiktoken measurement. Each number is derived from well-documented
// cl100k/o200k tokenizer behavior (the ratios OpenAI publishes + the
// pre-tokenization rules the estimator models):
//   · English words with a leading space are usually ONE token (the
//     pangram's nine words + "." = 10).
//   · digits split into ≤3-digit groups ("1234567890" → 4).
//   · CJK ≈ 1 token per character; fullwidth punctuation is 1 each.
//   · JSON quotes/colons merge into pairs (`{"`, `":`) → ~13 for the sample.
//   · URLs merge domain pieces (".com", "/docs") → ~10-14.
//   · "\n\n" and 2-4-space runs are 1-2 tokens.
// The ±15% band is the tolerance the owner asked a "somewhat accurate rough
// estimate" to hold; chars/4 is asserted alongside where its bias is the
// point (CJK: chars/4 is off by 3-4×; digits: by ~60%).
import { describe, expect, it } from "vitest";
import { estimateTokens, estimateMessageTokens, assembleWithinBudget } from "../src/context";

interface Sample {
  name: string;
  text: string;
  /** Approximate cl100k count derived from known tokenizer ratios (above). */
  reference: number;
  /** Documented derivation of the reference, per-sample. */
  why: string;
}

const SAMPLES: Sample[] = [
  {
    name: "empty string",
    text: "",
    reference: 0,
    why: "no tokens — the estimator's hard 0 case",
  },
  {
    name: "single common word",
    text: "hello",
    reference: 1,
    why: "cl100k holds 'hello' as one token",
  },
  {
    name: "pangram sentence",
    text: "The quick brown fox jumps over the lazy dog.",
    reference: 10,
    why: "9 space-prefixed common words (1 each) + '.' — all in the cl100k vocab",
  },
  {
    name: "english prose",
    text: "The usage screen now shows one card for every API key the owner configured, with the masked preview, requests, tokens and cost for each key.",
    reference: 28,
    why: "25 common words (1 each) + 2 commas + 1 period ≈ 28",
  },
  {
    name: "long-worded prose (word-heuristic territory)",
    text: "Estimation algorithms approximating subword segmentation demonstrate meaningful measurement characteristics across representative documentation collections.",
    reference: 31,
    why: "15 words averaging ~9.5 chars split into ~2-3 BPE pieces each (≈2.1 tokens/word) + period",
  },
  {
    name: "digit run",
    text: "1234567890",
    reference: 4,
    why: "cl100k's \\p{N}{1,3} split: '123' '456' '789' '0'",
  },
  {
    name: "digits in prose",
    text: "Version 3.14 shipped with 25000 tokens and 40 fixes.",
    reference: 13,
    why: "10 words (1 each) + '3' '.' '14' '25' '000' '40' ≈ 13 small pieces",
  },
  {
    name: "CJK text",
    text: "你好，世界！机器学习",
    reference: 10,
    why: "8 han characters (≈1 each) + fullwidth ，and ！ (1 each)",
  },
  {
    name: "JSON object",
    text: '{"name": "Alice", "age": 30, "active": true}',
    reference: 13,
    why: 'merge pairs `{"` `":` `",` + 5 word/number values ≈ 13',
  },
  {
    name: "URL-heavy line",
    text: "https://example.com/docs/page?ref=abc",
    reference: 10,
    why: "'https' '://' 'example' '.com' '/docs' '/page' '?ref' '=' 'abc' ≈ 10",
  },
  {
    name: "longer URL",
    text: "https://api.openai.com/v1/chat/completions?model=gpt-4",
    reference: 14,
    why: "'https' '://' 'api' '.openai' '.com' '/v1' '/chat' '/completions' '?model' '=' 'gpt' '-' '4' ≈ 13-15",
  },
  {
    name: "code line",
    text: "const total = estimateTokens(input);",
    reference: 10,
    why: "'const' ' total' ' =' ' estimate' 'Tokens' '(' 'input' ')' ';' ≈ 9-10",
  },
  {
    name: "code snippet",
    text: 'export function estimateTokens(text: string): number {\n  if (text === "") return 0;\n  return Math.max(1, Math.round(text.length / 4));\n}',
    reference: 37,
    why: "3 lines ≈ 10+9+10 tokens + 3 newlines + '}' ≈ 36-40",
  },
  {
    name: "identifier with underscores",
    text: "keySlot_provider2",
    reference: 5,
    why: "'key' 'Slot' '_' 'provider' '2' ≈ 5",
  },
  {
    name: "whitespace-only",
    text: "   \n\n  ",
    reference: 3,
    why: "'   ' '\\n\\n' '  ' — 3 mergeable whitespace tokens",
  },
];

describe("estimateTokens (ROUND-64 R64-e) — calibration table", () => {
  for (const sample of SAMPLES) {
    it(`${sample.name}: within ±15% of the documented cl100k reference`, () => {
      const estimate = estimateTokens(sample.text);
      // Reference derivation: ${sample.why}
      expect(estimate).toBeGreaterThanOrEqual(0); // never negative
      if (sample.reference === 0) {
        expect(estimate).toBe(0);
        return;
      }
      const tolerance = sample.reference * 0.15;
      expect(Math.abs(estimate - sample.reference)).toBeLessThanOrEqual(tolerance);
    });
  }

  it("fixes the chars/4 biases the owner reported: CJK and digit runs", () => {
    // CJK: cl100k ≈ 1 token/char; chars/4 undercounts 3-4×.
    const cjk = "你好，世界！机器学习";
    expect(estimateTokens(cjk)).toBeGreaterThanOrEqual(Math.ceil(cjk.length / 4));
    expect(estimateTokens(cjk)).toBeGreaterThanOrEqual(8); // ~1 per han char
    // Digits: 4 real tokens for 10 digits; chars/4 says 3.
    expect(estimateTokens("1234567890")).toBe(4);
    expect(estimateTokens("1234567890")).toBeGreaterThan(Math.ceil(10 / 4));
  });

  it("is strictly closer than chars/4 to the words×1.3 heuristic on long-worded prose", () => {
    // The word-count heuristic (words × 1.3) tracks cl100k best when words
    // are long enough to split (~1.3 tokens/word); on such prose the new
    // estimate must beat the chars/4 baseline, which overshoots (≈1.8
    // tokens/word here) as word length grows.
    const text = SAMPLES.find((s) => s.name === "long-worded prose (word-heuristic territory)")!.text;
    const words = text.trim().split(/\s+/).length;
    const heuristic = words * 1.3;
    const estimate = estimateTokens(text);
    const baseline = Math.ceil(text.length / 4);
    expect(Math.abs(estimate - heuristic)).toBeLessThan(Math.abs(baseline - heuristic));
  });

  it("never returns less than the chars/4 baseline on code and CJK", () => {
    for (const name of ["code snippet", "code line", "CJK text"]) {
      const text = SAMPLES.find((s) => s.name === name)!.text;
      expect(estimateTokens(text)).toBeGreaterThanOrEqual(Math.ceil(text.length / 4));
    }
  });
});

describe("estimateTokens (ROUND-64 R64-e) — contract invariants", () => {
  it("is pure and deterministic (same input → same output)", () => {
    const text = SAMPLES[3].text;
    expect(estimateTokens(text)).toBe(estimateTokens(text));
    expect(estimateTokens(text)).toBe(estimateTokens(`${text}`));
  });

  it("returns 0 only for the empty string; ≥1 for anything else", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens(" ")).toBe(1);
    expect(estimateTokens(".")).toBe(1);
    expect(estimateTokens("你")).toBe(1);
  });

  it("handles pathological input in bounded time (no unbounded loops)", () => {
    // 1MB of mixed pathological content — the single regex pass + linear
    // reduce is O(n); this guards against accidental backtracking blowups.
    const chunk = "aaaa…12345678901234 你好世界   {}();=>—".repeat(100);
    const big = chunk.repeat(50);
    const startedAt = Date.now();
    const tokens = estimateTokens(big);
    expect(tokens).toBeGreaterThan(0);
    expect(Date.now() - startedAt).toBeLessThan(2000); // generous CI ceiling
  });

  it("estimateMessageTokens keeps the +8 per-message overhead and exact signature", () => {
    expect(
      estimateMessageTokens([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ]),
    ).toBe(estimateTokens("hello") + estimateTokens("hi") + 16);
  });

  it("assembleWithinBudget still trims with the new estimator (compaction parity)", () => {
    // 200 short messages ≫ a tiny budget → the head is dropped, marker lands.
    const messages = Array.from({ length: 200 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `message number ${i} with some words to count`,
    }));
    const result = assembleWithinBudget(messages, {
      contextWindow: 2_000,
      maxOutputTokens: 500,
      margin: 200,
    });
    expect(result.wasTrimmed).toBe(true);
    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.messages[0].content).toContain("[Earlier conversation was trimmed");
    expect(result.usedTokens).toBeLessThanOrEqual(2_000 - 500 - 200 + 30);
  });
});
