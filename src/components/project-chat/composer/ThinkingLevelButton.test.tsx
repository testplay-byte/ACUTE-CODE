// @vitest-environment happy-dom
/**
 * ROUND-95 (R95-E) tests — the MODEL-AWARE thinking-level button.
 *
 * The owner's report, verbatim: "The reasoning level… was supposed to be
 * model-specific. Multiple models have different thinking levels so our
 * thinking levels were supposed to be managed based on it… Our program
 * should be able to properly detect the models' thinking options, like
 * which options it supports and such." R95-B stored the detected
 * capability (ModelReasoningSupport); these tests pin the CONSUMING side:
 *
 *  · the pure derivation (thinkingMenuSpec): UNKNOWN support → the classic
 *    R50 four + the honest "capabilities unknown" footer; supported:false →
 *    an unsupported (disabled) verdict; a detected ladder → ONLY the rungs
 *    the model actually supports ([low, medium] offers Default/Low/Medium
 *    with the cap note; a high-capable ladder keeps every rung + Max).
 *  · the stored-level fallback (displayThinkingLevel): a stored level the
 *    model doesn't support falls back VISUALLY to the nearest supported one
 *    (the wire-side mapping in chat.ts is the safety net — pinned there).
 *  · the rendered button (web-mode DOM leg — no Tauri bridge in tests):
 *    unknown → 4 options + footer; unsupported → disabled "No thinking"
 *    with the honest tooltip and no menu; [low, medium] → Default/Low/Medium;
 *    [low, medium, high] → every supported rung + Max, no footer; a stored
 *    "high" on a [low, medium] model DISPLAYS "Medium" and picking a row
 *    reports the picked level verbatim.
 *  · the localStorage round-trip now admits "medium" (the widened shared
 *    vocabulary — additive, old stored values stay valid).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ModelReasoningSupport, ThinkingLevel } from "shared";
import { ThinkingLevelButton } from "./ThinkingLevelButton";
import {
  displayThinkingLevel,
  loadThinkingLevel,
  saveThinkingLevel,
  THINKING_OPTIONS,
  thinkingMenuSpec,
} from "./composer-utils";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ── The pure derivation: thinkingMenuSpec ─────────────────────────────────── */

describe("R95-E: thinkingMenuSpec (the support-aware option set)", () => {
  it("UNKNOWN support (null) → the R50 classic four + the honest footer note", () => {
    const spec = thinkingMenuSpec(null);
    expect(spec.unsupported).toBe(false);
    expect(spec.options.map((o) => o.id)).toEqual(["default", "low", "high", "max"]);
    expect(spec.note).toBe("capabilities unknown for this model");
  });

  it("absent support (undefined) behaves exactly like null — never blocked on", () => {
    const spec = thinkingMenuSpec(undefined);
    expect(spec.options.map((o) => o.id)).toEqual(["default", "low", "high", "max"]);
    expect(spec.unsupported).toBe(false);
  });

  it("supported: false → the unsupported verdict (the button disables; no options)", () => {
    const spec = thinkingMenuSpec({ supported: false, efforts: [] });
    expect(spec.unsupported).toBe(true);
    expect(spec.options).toEqual([]);
    expect(spec.note).toBeNull();
  });

  it("supported with NO discrete efforts → the classic four + the no-efforts note", () => {
    const spec = thinkingMenuSpec({ supported: true, efforts: [] });
    expect(spec.unsupported).toBe(false);
    expect(spec.options.map((o) => o.id)).toEqual(["default", "low", "high", "max"]);
    expect(spec.note).toBe("this model supports reasoning; no discrete efforts listed");
  });

  it("efforts [low, medium] → Default/Low/MEDIUM + the cap note (High/Max hidden, never broken)", () => {
    const spec = thinkingMenuSpec({ supported: true, efforts: ["low", "medium"] });
    expect(spec.options.map((o) => o.id)).toEqual(["default", "low", "medium"]);
    expect(spec.note).toBe("this model caps reasoning at medium");
  });

  it("efforts [minimal, low] → Default/Low with the cap note (minimal counts as a Low rung)", () => {
    const spec = thinkingMenuSpec({ supported: true, efforts: ["minimal", "low"] });
    expect(spec.options.map((o) => o.id)).toEqual(["default", "low"]);
    expect(spec.note).toBe("this model caps reasoning at low");
  });

  it("efforts [low] alone → Default/Low", () => {
    const spec = thinkingMenuSpec({ supported: true, efforts: ["low"] });
    expect(spec.options.map((o) => o.id)).toEqual(["default", "low"]);
    expect(spec.note).toBe("this model caps reasoning at low");
  });

  it("efforts [low, medium, high] → every supported rung + Max (max rides high), NO note", () => {
    // The spec: keep Default + the SUPPORTED levels — medium ∈ efforts
    // means the model genuinely offers a Medium rung, so it IS offered
    // (the classic four is only the UNKNOWN-support set). Max rides high.
    const spec = thinkingMenuSpec({ supported: true, efforts: ["low", "medium", "high"] });
    expect(spec.options.map((o) => o.id)).toEqual(["default", "low", "medium", "high", "max"]);
    expect(spec.note).toBeNull();
  });

  it("efforts [medium, high] → Default/Medium/High/Max (Low hidden — the model cannot go that low)", () => {
    const spec = thinkingMenuSpec({ supported: true, efforts: ["medium", "high"] });
    expect(spec.options.map((o) => o.id)).toEqual(["default", "medium", "high", "max"]);
    expect(spec.note).toBeNull();
  });

  it("the full ladder [minimal, low, medium, high] → every rung + Max, no note", () => {
    // minimal rides Low (the vocabulary mapping); medium is offered.
    const spec = thinkingMenuSpec({ supported: true, efforts: ["minimal", "low", "medium", "high"] });
    expect(spec.options.map((o) => o.id)).toEqual(["default", "low", "medium", "high", "max"]);
    expect(spec.note).toBeNull();
  });
});

/* ── The stored-level fallback: displayThinkingLevel ──────────────────────── */

describe("R95-E: displayThinkingLevel (a stored level the model doesn't support)", () => {
  const ids = (spec: ReturnType<typeof thinkingMenuSpec>): ThinkingLevel[] => spec.options.map((o) => o.id);

  it("a level the menu offers displays as itself", () => {
    const spec = thinkingMenuSpec({ supported: true, efforts: ["low", "medium", "high"] });
    for (const level of ["default", "low", "high", "max"] as const) {
      expect(displayThinkingLevel(level, spec.options)).toBe(level);
    }
  });

  it("stored High on a [low, medium] model displays Medium (nearest supported below)", () => {
    const spec = thinkingMenuSpec({ supported: true, efforts: ["low", "medium"] });
    expect(ids(spec)).toEqual(["default", "low", "medium"]);
    expect(displayThinkingLevel("high", spec.options)).toBe("medium");
    expect(displayThinkingLevel("max", spec.options)).toBe("medium");
  });

  it("stored Max on a [low] model displays Low", () => {
    const spec = thinkingMenuSpec({ supported: true, efforts: ["low"] });
    expect(displayThinkingLevel("max", spec.options)).toBe("low");
  });

  it("stored Low on a [medium, high] model displays Medium (no lower rung — the lowest stands in, chat.ts's twin)", () => {
    const spec = thinkingMenuSpec({ supported: true, efforts: ["medium", "high"] });
    expect(displayThinkingLevel("low", spec.options)).toBe("medium");
  });

  it("unknown support keeps every classic level (no fallback needed)", () => {
    const spec = thinkingMenuSpec(null);
    expect(displayThinkingLevel("max", spec.options)).toBe("max");
  });
});

/* ── The persisted level admits "medium" (the widened vocabulary) ──────────── */

describe("R95-E: the per-session level round-trips medium", () => {
  it("THINKING_OPTIONS carries all five vocabulary levels", () => {
    expect(THINKING_OPTIONS.map((o) => o.id)).toEqual(["default", "low", "medium", "high", "max"]);
  });

  it("save + load round-trips medium; an invalid value still falls back to default", () => {
    saveThinkingLevel("ses-r95e", "medium");
    expect(loadThinkingLevel("ses-r95e")).toBe("medium");
    window.localStorage.setItem("acute-thinking:ses-r95e", "ultra");
    expect(loadThinkingLevel("ses-r95e")).toBe("default");
  });
});

/* ── The rendered button (web-mode DOM leg) ────────────────────────────────── */

function optionLabels(): string[] {
  return screen.getAllByRole("menuitemradio").map((o) => o.textContent ?? "");
}

describe("R95-E: ThinkingLevelButton (model-aware rendering)", () => {
  it("UNKNOWN support → the classic four options + the capabilities-unknown footer note", () => {
    render(<ThinkingLevelButton level="default" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Thinking level: Default" }));
    expect(optionLabels()).toEqual([
      "DefaultThe model's own reasoning default.",
      "LowLight reasoning — fastest replies.",
      "HighDeeper reasoning for complex work.",
      "MaxMaximum reasoning effort.",
    ]);
    const note = document.querySelector("[data-thinking-menu-note]");
    expect(note?.textContent).toBe("capabilities unknown for this model");
  });

  it("supported: false → DISABLED, labeled No thinking, honest tooltip, and clicking opens NO menu", () => {
    const onChange = vi.fn();
    const support: ModelReasoningSupport = { supported: false, efforts: [] };
    render(<ThinkingLevelButton level="high" onChange={onChange} reasoningSupport={support} />);
    const button = screen.getByRole("button", { name: "Thinking level: No thinking" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe("This model does not support reasoning");
    expect(button.textContent).toContain("No thinking");
    fireEvent.click(button);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("efforts [low, medium] → Default/Low/Medium with the cap note; picking reports the picked level", () => {
    const onChange = vi.fn();
    const support: ModelReasoningSupport = { supported: true, efforts: ["low", "medium"] };
    render(<ThinkingLevelButton level="default" onChange={onChange} reasoningSupport={support} />);
    fireEvent.click(screen.getByRole("button", { name: "Thinking level: Default" }));
    expect(optionLabels()).toEqual([
      "DefaultThe model's own reasoning default.",
      "LowLight reasoning — fastest replies.",
      "MediumBalanced reasoning effort.",
    ]);
    expect(document.querySelector("[data-thinking-menu-note]")?.textContent).toBe(
      "this model caps reasoning at medium",
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Medium/ }));
    expect(onChange).toHaveBeenCalledWith("medium");
  });

  it("efforts [low, medium, high] → Default/Low/Medium/High/Max and NO footer note", () => {
    const support: ModelReasoningSupport = { supported: true, efforts: ["low", "medium", "high"] };
    render(<ThinkingLevelButton level="low" onChange={() => {}} reasoningSupport={support} />);
    fireEvent.click(screen.getByRole("button", { name: "Thinking level: Low" }));
    expect(optionLabels().map((l) => l.replace(/(The model's own reasoning default\.|Light reasoning — fastest replies\.|Balanced reasoning effort\.|Deeper reasoning for complex work\.|Maximum reasoning effort\.)$/, ""))).toEqual([
      "Default",
      "Low",
      "Medium",
      "High",
      "Max",
    ]);
    expect(document.querySelector("[data-thinking-menu-note]")).toBeNull();
  });

  it("a stored High on a [low, medium] model DISPLAYS Medium (the stored value is never rewritten here)", () => {
    const support: ModelReasoningSupport = { supported: true, efforts: ["low", "medium"] };
    render(<ThinkingLevelButton level="high" onChange={() => {}} reasoningSupport={support} />);
    // The button's label + tooltip read the DISPLAY level; the panel keeps
    // the stored "high" until the owner picks a supported one.
    const button = screen.getByRole("button", { name: "Thinking level: Medium" });
    expect(button.textContent).toContain("Medium");
    fireEvent.click(button);
    // The Medium row carries the check (the display level), not High.
    const checked = screen.getByRole("menuitemradio", { name: /Medium/ }) as HTMLButtonElement;
    expect(checked.getAttribute("aria-checked")).toBe("true");
  });
});
