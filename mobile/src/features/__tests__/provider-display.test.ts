/**
 * provider-display.test.ts — the provider detail page's pure display
 * derivations (R118-E §2B): the NAME-only model row label (displayName ??
 * cleanModelName — never the raw id), the facts line's honest-omission
 * table, the key pool row's ONE mono meta line (the mask · the last use,
 * with the older-sidecar degradation), and the hero card's apiFormatLabel
 * context line. Pure-logic only — zero React Native.
 */

import { describe, expect, it } from "@jest/globals";

import type { ModelRecord, ProviderKeySlot } from "../config";
import { TYPE_MONO } from "@/design/tokens";
import {
  apiFormatLabel,
  formatCompactCount,
  KEY_SLOT_MONO_LINE,
  KEY_SLOT_MONO_SIZE,
  keyReferenceText,
  keySlotMetaLine,
  modelFactsLine,
  modelRowLabel,
} from "../provider-display";

// ── fixtures ────────────────────────────────────────────────────────────────

/** The minimal ModelRecord a display derivation reads (the Pick surfaces). */
function model(partial: Partial<ModelRecord> & Pick<ModelRecord, "modelId" | "displayName">): ModelRecord {
  return {
    id: "mdl_test",
    providerId: "openrouter",
    contextWindow: null,
    maxOutputTokens: null,
    inputPricePerMtok: null,
    inputPriceCachedPerMtok: null,
    outputPricePerMtok: null,
    supportsThinking: null,
    supportsVision: null,
    supportsTools: null,
    supportsAudio: null,
    supportsVideo: null,
    supportsPdf: null,
    supportsTextOutput: null,
    supportsImageOutput: null,
    supportsVideoOutput: null,
    supportsAudioOutput: null,
    sizeLabel: null,
    reasoningSupport: null,
    hidden: false,
    createdAt: "2026-09-22T00:00:00.000Z",
    ...partial,
  };
}

/** A fixed `now` so the relative-age pins never depend on the clock. */
const NOW = Date.parse("2026-09-22T12:00:00.000Z");

// ── modelRowLabel — the NAME-only row (§2B3) ───────────────────────────────

describe("modelRowLabel — never the raw model id", () => {
  it("a set display name wins over everything", () => {
    expect(
      modelRowLabel(model({ modelId: "openrouter/z-ai/glm-4.7:free", displayName: "My daily driver" })),
    ).toBe("My daily driver");
  });

  it("a blank/whitespace display name falls to the humanized id — never the raw id", () => {
    expect(modelRowLabel(model({ modelId: "openrouter/z-ai/glm-4.7:free", displayName: null }))).toBe("GLM 4.7");
    expect(modelRowLabel(model({ modelId: "openrouter/z-ai/glm-4.7:free", displayName: "" }))).toBe("GLM 4.7");
    expect(modelRowLabel(model({ modelId: "openrouter/z-ai/glm-4.7:free", displayName: "   " }))).toBe("GLM 4.7");
  });

  it("the label NEVER equals the raw id on realistic ids (the owner's complaint)", () => {
    const TABLE: ReadonlyArray<string> = [
      "openrouter/z-ai/glm-4.7:free",
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-4o",
      "meta-llama/llama-3.3-70b-instruct",
      "z-ai/glm-5.2:free",
    ];
    for (const modelId of TABLE) {
      const label = modelRowLabel(model({ modelId, displayName: null }));
      expect(label).not.toBe(modelId);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("humanizes the last segment exactly like the house cleanModelName", () => {
    expect(modelRowLabel(model({ modelId: "anthropic/claude-sonnet-4-5", displayName: null }))).toBe(
      "Claude Sonnet 4 5",
    );
    expect(modelRowLabel(model({ modelId: "openai/gpt-4o", displayName: null }))).toBe("GPT 4o");
  });
});

// ── modelFactsLine — the quiet honesty table (§2B3 line 2) ─────────────────

describe("modelFactsLine — context always, the rest only when set", () => {
  it("context is ALWAYS present — an honest '—' when unknown, never a fabricated 0", () => {
    expect(modelFactsLine(model({ modelId: "m", displayName: null, contextWindow: null }))).toBe("— ctx");
    expect(modelFactsLine(model({ modelId: "m", displayName: null, contextWindow: 131_072 }))).toBe("131k ctx");
  });

  it("prices and max output appear ONLY when set (the PC's honest-omission discipline)", () => {
    expect(
      modelFactsLine(
        model({
          modelId: "m",
          displayName: null,
          contextWindow: 131_072,
          inputPricePerMtok: 0.14,
          outputPricePerMtok: 0.6,
          maxOutputTokens: 8192,
        }),
      ),
    ).toBe("131k ctx · $0.14 in · $0.6 out · 8.2k max out");
    // Every optional field omitted → just the context leg.
    expect(
      modelFactsLine(model({ modelId: "m", displayName: null, contextWindow: 200_000, maxOutputTokens: 4096 })),
    ).toBe("200k ctx · 4.1k max out");
  });

  it("a 0 price is a SET price — it renders (only null is unknown)", () => {
    expect(
      modelFactsLine(model({ modelId: "m", displayName: null, contextWindow: null, inputPricePerMtok: 0 })),
    ).toBe("— ctx · $0 in");
  });
});

// ── keySlotMetaLine — the pool row's ONE mono line (§2B2) ──────────────────

describe("keySlotMetaLine — the mask, plus the honest last use", () => {
  it("an empty slot renders the honest em dash", () => {
    const slot: ProviderKeySlot = { slot: 1, hasKey: false, masked: null };
    expect(keySlotMetaLine(slot, NOW)).toBe("—");
  });

  it("a held key renders its mask; a missing mask falls to the dots", () => {
    expect(keySlotMetaLine({ slot: 0, hasKey: true, masked: "abcd…wxyz" }, NOW)).toBe("abcd…wxyz");
    expect(keySlotMetaLine({ slot: 0, hasKey: true, masked: null }, NOW)).toBe("••••••••");
  });

  it("an older sidecar (no lastUsedAt) degrades to the mask-only line", () => {
    expect(keySlotMetaLine({ slot: 0, hasKey: true, masked: "abcd…wxyz" }, NOW)).toBe("abcd…wxyz");
    expect(keySlotMetaLine({ slot: 0, hasKey: true, masked: "abcd…wxyz", lastUsedAt: null }, NOW)).toBe(
      "abcd…wxyz",
    );
  });

  it("a reported last use appends ' · used {short}' (the timeAgoShort ladder)", () => {
    const hourAgo = NOW - 60 * 60 * 1000;
    expect(keySlotMetaLine({ slot: 0, hasKey: true, masked: "abcd…wxyz", lastUsedAt: new Date(hourAgo).toISOString() }, NOW)).toBe(
      "abcd…wxyz · used 1h ago",
    );
    const dayAgo = NOW - 26 * 60 * 60 * 1000;
    expect(keySlotMetaLine({ slot: 2, hasKey: true, masked: "sk-1…9", lastUsedAt: new Date(dayAgo).toISOString() }, NOW)).toBe(
      "sk-1…9 · used 1d ago",
    );
  });

  it("an unparseable lastUsedAt is OMITTED — never a garbage age", () => {
    expect(keySlotMetaLine({ slot: 0, hasKey: true, masked: "abcd…wxyz", lastUsedAt: "not-a-date" }, NOW)).toBe(
      "abcd…wxyz",
    );
  });
});

// ── apiFormatLabel — the hero's context line (§2B1) ────────────────────────

describe("apiFormatLabel — the human API-format names", () => {
  const TABLE: ReadonlyArray<{ format: string | null | undefined; expected: string }> = [
    { format: "chat-completions", expected: "Chat completions API" },
    { format: "anthropic-messages", expected: "Anthropic messages API" },
    { format: "responses", expected: "Responses API" },
    // Absent → the omitted line (the caller renders nothing).
    { format: undefined, expected: "" },
    { format: null, expected: "" },
    { format: "", expected: "" },
    { format: "   ", expected: "" },
    // An unknown future enum degrades to the omitted line — never the raw
    // machine token on the identity card.
    { format: "openai-realtime", expected: "" },
  ];

  it.each(TABLE)("apiFormatLabel(%j) → %j", ({ format, expected }) => {
    expect(apiFormatLabel(format)).toBe(expected);
  });
});

// ── the key-pool row's mono type cut (§5.5 rhythm pin) ─────────────────────

describe("KEY_SLOT_MONO — the key-pool meta line's type cut", () => {
  it("is 12/18 — one step below TypeMono's own 13/19 recipe (the mono caption size)", () => {
    expect(KEY_SLOT_MONO_SIZE).toBe(12);
    expect(KEY_SLOT_MONO_LINE).toBe(18);
    expect(KEY_SLOT_MONO_SIZE).toBe(TYPE_MONO - 1);
    expect(KEY_SLOT_MONO_LINE).toBe(19 - 1);
  });
});

// ── R120-M (round-120 §1): the two new pure seams ───────────────────────────

describe("R120-M: formatCompactCount — the sizing field's simplified BLUR form (item 17)", () => {
  it("the owner's own examples: 1000000 → 1M, 26000 → 26K, 1000 → 1K", () => {
    expect(formatCompactCount("1000000")).toBe("1M");
    expect(formatCompactCount("26000")).toBe("26K");
    expect(formatCompactCount("1000")).toBe("1K");
  });

  it("the B/M tiers with ≤2 decimals, trailing zeros stripped", () => {
    expect(formatCompactCount("1500")).toBe("1.5K");
    expect(formatCompactCount("1750000")).toBe("1.75M");
    expect(formatCompactCount("2000000000")).toBe("2B");
    expect(formatCompactCount("1050000")).toBe("1.05M");
    expect(formatCompactCount("260000")).toBe("260K");
  });

  it("below the K tier stays the raw digits", () => {
    expect(formatCompactCount("999")).toBe("999");
    expect(formatCompactCount("0")).toBe("0");
  });

  it("a non-numeric / blank / negative value passes through untouched — the blur display never invents", () => {
    expect(formatCompactCount("")).toBe("");
    expect(formatCompactCount("abc")).toBe("abc");
    expect(formatCompactCount("-5000")).toBe("-5000");
    expect(formatCompactCount("12,000")).toBe("12,000");
  });
});

describe("R120-M: keyReferenceText — the copyable key id (item 14's sensible extra)", () => {
  it("slot 0 reads 'primary key', pool slots read 'key N', the mask rides after a dot", () => {
    expect(keyReferenceText({ slot: 0, masked: "sk-a…z9" }, "openrouter")).toBe(
      "openrouter primary key · sk-a…z9",
    );
    expect(keyReferenceText({ slot: 3, masked: "sk-c…q1" }, "openrouter")).toBe(
      "openrouter key 3 · sk-c…q1",
    );
  });

  it("a missing mask degrades to the slot reference alone", () => {
    expect(keyReferenceText({ slot: 2, masked: null }, "z-ai")).toBe("z-ai key 2");
    expect(keyReferenceText({ slot: 2, masked: "" }, "z-ai")).toBe("z-ai key 2");
  });
});
