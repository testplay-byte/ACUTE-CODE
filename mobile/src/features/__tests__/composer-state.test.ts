/**
 * composer-state.test.ts — the composer's PURE control-row state (R113-c):
 * the operating-mode vocabulary (the desktop's MODE_OPTIONS, verbatim
 * semantics), the thinking-level menu spec a model's DETECTED reasoning
 * capability yields (ported from the desktop composer-utils — the same
 * four arms + the R96-F verbatim-rung rule), the display fallback for a
 * stored pick the current menu doesn't offer, and the model label. Zero
 * React Native.
 */

import { describe, expect, it } from "@jest/globals";

import {
  CLASSIC_THINKING_OPTIONS,
  MODE_OPTIONS,
  THINKING_OPTIONS,
  displayThinkingLevel,
  modeOption,
  modelLabel,
  thinkingMenuSpec,
  thinkingOption,
} from "../composer-state";

// ── the operating modes (R81's unified picker — 3 rows, ask is the default) ──

describe("composer-state — the operating modes", () => {
  it("offers exactly the desktop's three, ids matching the PATCH vocabulary", () => {
    expect(MODE_OPTIONS.map((option) => option.id)).toEqual(["full", "ask", "plan"]);
    for (const option of MODE_OPTIONS) {
      expect(option.label).toBeTruthy();
      expect(option.description).toBeTruthy();
    }
  });

  it("modeOption falls back to ask for stale/unknown ids (the backend remaps rows the same way)", () => {
    expect(modeOption("ask").id).toBe("ask");
    expect(modeOption("editor").id).toBe("ask"); // retired R81 value
    expect(modeOption("full").id).toBe("full");
    expect(modeOption("plan").id).toBe("plan");
  });
});

// ── the thinking vocabulary ──────────────────────────────────────────────────

describe("composer-state — the thinking vocabulary", () => {
  it("carries the FULL accepted six (the backend's THINKING_LEVELS, 1:1)", () => {
    expect(THINKING_OPTIONS.map((option) => option.id)).toEqual([
      "default",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("thinkingOption falls back to Default for unknown ids", () => {
    expect(thinkingOption("high").id).toBe("high");
    expect(thinkingOption("nonsense").id).toBe("default");
  });
});

// ── thinkingMenuSpec — the model-aware menu (the R95-E/R96-F arms) ──────────

describe("composer-state — thinkingMenuSpec (the desktop's exact arms)", () => {
  it("null/absent support → the classic R50 four + the honest unknown note", () => {
    const spec = thinkingMenuSpec(null);
    expect(spec.options.map((option) => option.id)).toEqual(CLASSIC_THINKING_OPTIONS.map((option) => option.id));
    expect(spec.unsupported).toBe(false);
    expect(spec.defaultRow).toBeNull();
    expect(spec.note).toBe("capabilities unknown for this model");
    expect(thinkingMenuSpec(undefined).note).toBe("capabilities unknown for this model");
  });

  it("supported: false → unsupported (no menu at all)", () => {
    const spec = thinkingMenuSpec({ supported: false, efforts: [] });
    expect(spec.options).toEqual([]);
    expect(spec.unsupported).toBe(true);
    expect(spec.note).toBeNull();
    expect(spec.defaultRow).toBeNull();
  });

  it("supported with NO discrete efforts → the classic four + the naming note", () => {
    const spec = thinkingMenuSpec({ supported: true, efforts: [] });
    expect(spec.options.map((option) => option.id)).toEqual(CLASSIC_THINKING_OPTIONS.map((option) => option.id));
    expect(spec.unsupported).toBe(false);
    expect(spec.note).toBe("this model supports reasoning; no discrete efforts listed");
  });

  it("a detected ladder offers Default + ONLY its rungs, VERBATIM (R96-F)", () => {
    // the owner's report: a model supporting high and max must show both
    const spec = thinkingMenuSpec({ supported: true, efforts: ["max", "high", "low"] });
    expect(spec.options.map((option) => option.id)).toEqual(["default", "low", "high", "max"]);
    expect(spec.note).toBe("detected from provider: max, high, low");

    // the 2026-09 live-catalog shape: xhigh exists and rides verbatim
    const xhigh = thinkingMenuSpec({ supported: true, efforts: ["xhigh", "high", "medium", "low"] });
    expect(xhigh.options.map((option) => option.id)).toEqual([
      "default",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(xhigh.unsupported).toBe(false);

    // a ladder that tops out below high offers no high rung
    const narrow = thinkingMenuSpec({ supported: true, efforts: ["low", "medium"] });
    expect(narrow.options.map((option) => option.id)).toEqual(["default", "low", "medium"]);
  });

  it("'minimal' rides the Low row; the defaultRow mark lands only on offered rows", () => {
    const minimal = thinkingMenuSpec({ supported: true, efforts: ["minimal", "high"], defaultEffort: "minimal" });
    expect(minimal.options.map((option) => option.id)).toEqual(["default", "low", "high"]);
    expect(minimal.defaultRow).toBe("low");
    expect(minimal.note).toBe("detected from provider: minimal, high (model default: minimal)");

    const named = thinkingMenuSpec({ supported: true, efforts: ["low", "high", "max"], defaultEffort: "high" });
    expect(named.defaultRow).toBe("high");

    // a provider default OUTSIDE its own ladder gets no mark
    const offLadder = thinkingMenuSpec({ supported: true, efforts: ["low"], defaultEffort: "max" });
    expect(offLadder.defaultRow).toBeNull();

    // no published default → no mark
    expect(thinkingMenuSpec({ supported: true, efforts: ["low"] }).defaultRow).toBeNull();
  });
});

// ── displayThinkingLevel — the honest display fallback ─────────────────────

describe("composer-state — displayThinkingLevel", () => {
  const classic = thinkingMenuSpec(null).options;

  it("returns the stored level when the menu offers it", () => {
    expect(displayThinkingLevel("high", classic)).toBe("high");
    expect(displayThinkingLevel("default", classic)).toBe("default");
  });

  it("falls back to the nearest supported rung BELOW the stored pick", () => {
    // xhigh stored (a previous model), the classic four offered → high
    expect(displayThinkingLevel("xhigh", classic)).toBe("high");
    // medium stored, classic four (no medium) → low
    expect(displayThinkingLevel("medium", classic)).toBe("low");
  });

  it("falls back to the LOWEST offered when nothing sits below", () => {
    // max stored, a low-only ladder → low
    const lowOnly = thinkingMenuSpec({ supported: true, efforts: ["low"] }).options;
    expect(displayThinkingLevel("max", lowOnly)).toBe("low");
  });

  it("an empty menu (unsupported) displays Default", () => {
    expect(displayThinkingLevel("high", [])).toBe("default");
  });
});

// ── the model label ──────────────────────────────────────────────────────────

describe("composer-state — modelLabel", () => {
  it("prefers the display name, else the bare model id", () => {
    expect(modelLabel({ modelId: "z-ai/glm-5.2:free", displayName: "GLM 5.2" })).toBe("GLM 5.2");
    expect(modelLabel({ modelId: "z-ai/glm-5.2:free", displayName: null })).toBe(
      "z-ai/glm-5.2:free",
    );
    expect(modelLabel({ modelId: "z-ai/glm-5.2:free", displayName: "   " })).toBe(
      "z-ai/glm-5.2:free",
    );
  });
});
