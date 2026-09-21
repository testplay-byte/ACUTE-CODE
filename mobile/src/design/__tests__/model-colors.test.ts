/**
 * model-colors.test.ts — R116-g: the PC palette port's pin suite. The
 * expected indices below were computed by running the PC's OWN
 * modelPaletteIndex (src/components/usage/usage-helpers.ts — the djb31-style
 * hash over the same 12-slot palette) on these exact names, so the port is
 * pinned to the desktop's behavior, not to its own re-implementation.
 */

import { describe, expect, it } from "@jest/globals";

import {
  MODEL_COLOR_PALETTE,
  MODEL_PALETTE_SIZE,
  modelColor,
  modelPaletteIndex,
} from "../model-colors";

/** Real model names from the household's providers, spelled as the wire
 * carries them (provider-prefixed, variant-suffixed, and bare). */
const KNOWN_NAMES: ReadonlyArray<readonly [string, number]> = [
  ["z-ai/glm-5.2:free", 10],
  ["anthropic/claude-sonnet-4-5", 2],
  ["openai/gpt-5", 2],
  ["google/gemini-2.5-pro", 3],
  ["glm-5.2", 0],
  ["claude-sonnet-4-5", 5],
  ["openrouter/auto", 5],
  ["deepseek/deepseek-chat-v3", 0],
  ["mistralai/mistral-large", 5],
  ["grok-4", 6],
];

describe("modelPaletteIndex (the PC's djb31 name hash)", () => {
  it.each(KNOWN_NAMES)("maps %s to the PC's slot %d", (name, expected) => {
    expect(modelPaletteIndex(name)).toBe(expected);
  });

  it("is deterministic — the same name always hashes to the same slot", () => {
    for (const [name] of KNOWN_NAMES) {
      const first = modelPaletteIndex(name);
      for (let i = 0; i < 5; i++) {
        expect(modelPaletteIndex(name)).toBe(first);
      }
    }
  });

  it("stays in bounds for arbitrary, empty, and unicode names", () => {
    const names = ["", "a", "A", "model", "0", "🤖-glm", "a very long model name with spaces", "@#$%"];
    for (const name of names) {
      const index = modelPaletteIndex(name);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(MODEL_PALETTE_SIZE);
      expect(Number.isInteger(index)).toBe(true);
    }
  });

  it("spells the palette exactly like the PC (12 hex pairs)", () => {
    expect(MODEL_PALETTE_SIZE).toBe(12);
    expect(MODEL_COLOR_PALETTE).toHaveLength(12);
    for (const pair of MODEL_COLOR_PALETTE) {
      expect(pair.light).toMatch(/^#[0-9a-f]{6}$/);
      expect(pair.dark).toMatch(/^#[0-9a-f]{6}$/);
      expect(pair.light).not.toBe(pair.dark);
    }
  });
});

describe("modelColor (one spelling everywhere)", () => {
  it("resolves the indexed pair's light/dark variant", () => {
    for (const [name] of KNOWN_NAMES) {
      const pair = MODEL_COLOR_PALETTE[modelPaletteIndex(name)];
      expect(modelColor(name, false)).toBe(pair.light);
      expect(modelColor(name, true)).toBe(pair.dark);
    }
  });

  it("same name ⇒ same color, in both modes", () => {
    expect(modelColor("z-ai/glm-5.2:free", false)).toBe(modelColor("z-ai/glm-5.2:free", false));
    expect(modelColor("z-ai/glm-5.2:free", true)).toBe(modelColor("z-ai/glm-5.2:free", true));
  });

  it("different names may share a slot — and then share the color (stable, never rank-based)", () => {
    // anthropic/claude-sonnet-4-5 and openai/gpt-5 both hash to slot 2 (the
    // PC's own distribution); the COLOR follows the NAME, not the ranking.
    expect(modelPaletteIndex("anthropic/claude-sonnet-4-5")).toBe(modelPaletteIndex("openai/gpt-5"));
    expect(modelColor("anthropic/claude-sonnet-4-5", false)).toBe(modelColor("openai/gpt-5", false));
  });

  it("the palette's head and tail match the PC verbatim", () => {
    expect(MODEL_COLOR_PALETTE[0]).toEqual({ light: "#2563eb", dark: "#60a5fa" }); // blue
    expect(MODEL_COLOR_PALETTE[11]).toEqual({ light: "#be185d", dark: "#ec4899" }); // rose
  });
});
