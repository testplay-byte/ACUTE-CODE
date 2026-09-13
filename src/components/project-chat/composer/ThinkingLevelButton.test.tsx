// @vitest-environment happy-dom
/**
 * ROUND-95 (R95-E) → ROUND-96 (R96-F) tests — the MODEL-AWARE
 * thinking-level button.
 *
 * The owner's two reports, verbatim:
 *  (1) R95: "The reasoning level… was supposed to be model-specific.
 *      Multiple models have different thinking levels so our thinking levels
 *      were supposed to be managed based on it… Our program should be able
 *      to properly detect the models' thinking options, like which options it
 *      supports and such." R95-B stored the detected capability
 *      (ModelReasoningSupport); these tests pin the CONSUMING side.
 *  (2) R96-F: "I tested a model which supported high and max but it
 *      apparently did not detect that properly and was showing the default
 *      options. This should not happen. It needs to be improved and handled
 *      better." — the detection is now VISIBLE and lossless: the rungs ride
 *      verbatim (X-High appears, Max only when the ladder holds max), the
 *      footer names its source ("detected from provider: …"), and the
 *      model's own default rung carries a quiet mark.
 *
 * Coverage:
 *  · the pure derivation (thinkingMenuSpec): UNKNOWN support → the classic
 *    R50 four + the honest "capabilities unknown" footer; supported:false →
 *    an unsupported (disabled) verdict; a detected ladder → the model's
 *    ACTUAL rungs ([low, medium] offers Default/Low/Medium; [max, high, low]
 *    offers Default/Low/High/Max + the detected note — the owner's exact
 *    case, indistinguishable from the unknown default under the R95 fold);
 *    [xhigh, high] offers Default/High/X-High.
 *  · the stored-level fallback (displayThinkingLevel): a stored level the
 *    model doesn't support falls back VISUALLY to the nearest supported one
 *    (the wire-side mapping in chat.ts is the safety net — pinned there).
 *  · the rendered button (web-mode DOM leg — no Tauri bridge in tests):
 *    unknown → 4 options + footer; unsupported → disabled "No thinking"
 *    with the honest tooltip and no menu; the detected note + the quiet
 *    default-rung mark render; picking a row reports the picked level
 *    verbatim (xhigh included).
 *  · the localStorage round-trip admits "medium" and "xhigh" (the widened
 *    shared vocabulary — additive, old stored values stay valid).
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

describe("R95-E → R96-F: thinkingMenuSpec (the support-aware option set)", () => {
  it("UNKNOWN support (null) → the R50 classic four + the honest footer note", () => {
    const spec = thinkingMenuSpec(null);
    expect(spec.unsupported).toBe(false);
    expect(spec.options.map((o) => o.id)).toEqual(["default", "low", "high", "max"]);
    expect(spec.note).toBe("capabilities unknown for this model");
    expect(spec.defaultRow).toBeNull();
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

  it("R96-F (the owner's case): efforts [max, high, low] → Default/Low/High/Max + the DETECTED note (visible detection)", () => {
    // deepseek-v4.1-flash's live ladder — under the R95 fold this rendered
    // EXACTLY like the unknown default (the owner: "was showing the default
    // options. This should not happen").
    const spec = thinkingMenuSpec({ supported: true, efforts: ["low", "high", "max"] });
    expect(spec.options.map((o) => o.id)).toEqual(["default", "low", "high", "max"]);
    expect(spec.note).toBe("detected from provider: low, high, max");
    expect(spec.defaultRow).toBeNull();
    // The published default rides the note + marks its row.
    const withDefault = thinkingMenuSpec({
      supported: true,
      efforts: ["low", "high", "max"],
      defaultEffort: "max",
    });
    expect(withDefault.note).toBe("detected from provider: low, high, max (model default: max)");
    expect(withDefault.defaultRow).toBe("max");
  });

  it("efforts [xhigh, high] → Default/High/X-HIGH + the detected note (z-ai/glm-5.2's live ladder)", () => {
    const spec = thinkingMenuSpec({ supported: true, efforts: ["high", "xhigh"], defaultEffort: "high" });
    expect(spec.options.map((o) => o.id)).toEqual(["default", "high", "xhigh"]);
    expect(spec.note).toBe("detected from provider: high, xhigh (model default: high)");
    expect(spec.defaultRow).toBe("high");
  });

  it("efforts [low, medium] → Default/Low/MEDIUM (High/Max hidden — the ladder is the honest cap)", () => {
    const spec = thinkingMenuSpec({ supported: true, efforts: ["low", "medium"], defaultEffort: "medium" });
    expect(spec.options.map((o) => o.id)).toEqual(["default", "low", "medium"]);
    expect(spec.note).toBe("detected from provider: low, medium (model default: medium)");
    expect(spec.defaultRow).toBe("medium");
  });

  it("efforts [minimal, low] → Default/Low (minimal counts as a Low rung and its default marks the Low row)", () => {
    const spec = thinkingMenuSpec({ supported: true, efforts: ["minimal", "low"], defaultEffort: "minimal" });
    expect(spec.options.map((o) => o.id)).toEqual(["default", "low"]);
    expect(spec.note).toBe("detected from provider: minimal, low (model default: minimal)");
    expect(spec.defaultRow).toBe("low");
  });

  it("a provider default outside the offered rows gets NO row mark (the note still carries it)", () => {
    const spec = thinkingMenuSpec({ supported: true, efforts: ["low", "medium"], defaultEffort: "xhigh" });
    expect(spec.defaultRow).toBeNull();
    expect(spec.note).toBe("detected from provider: low, medium (model default: xhigh)");
  });

  it("efforts [low, medium, high] → Default/Low/Medium/High — NO Max row (max is a rung now; this ladder lacks it)", () => {
    const spec = thinkingMenuSpec({ supported: true, efforts: ["low", "medium", "high"] });
    expect(spec.options.map((o) => o.id)).toEqual(["default", "low", "medium", "high"]);
    expect(spec.note).toBe("detected from provider: low, medium, high");
  });

  it("the full ladder [minimal…max] → every rung verbatim + the detected note", () => {
    const spec = thinkingMenuSpec({
      supported: true,
      efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
    });
    expect(spec.options.map((o) => o.id)).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
    expect(spec.note).toBe(
      "detected from provider: minimal, low, medium, high, xhigh, max (model default: high)",
    );
    expect(spec.defaultRow).toBe("high");
  });
});

/* ── The stored-level fallback: displayThinkingLevel ──────────────────────── */

describe("R95-E: displayThinkingLevel (a stored level the model doesn't support)", () => {
  const ids = (spec: ReturnType<typeof thinkingMenuSpec>): ThinkingLevel[] => spec.options.map((o) => o.id);

  it("a level the menu offers displays as itself; R96: unoffered rungs step DOWN, not ghost", () => {
    // ROUND-96 (R96-F): the menu offers ONLY the model's own rungs — a
    // [low, medium, high] ladder offers Default/Low/Medium/High (NO Max:
    // max is not in the ladder). A stored Max displays as the nearest
    // supported rung at-or-below (high), never a ghost label.
    const spec = thinkingMenuSpec({ supported: true, efforts: ["low", "medium", "high"] });
    for (const level of ["default", "low", "medium", "high"] as const) {
      expect(displayThinkingLevel(level, spec.options)).toBe(level);
    }
    expect(displayThinkingLevel("max", spec.options)).toBe("high");
    // A ladder that DOES carry max keeps it.
    const maxSpec = thinkingMenuSpec({ supported: true, efforts: ["low", "high", "max"] });
    expect(displayThinkingLevel("max", maxSpec.options)).toBe("max");
  });

  it("stored High on a [low, medium] model displays Medium (nearest supported below)", () => {
    const spec = thinkingMenuSpec({ supported: true, efforts: ["low", "medium"] });
    expect(ids(spec)).toEqual(["default", "low", "medium"]);
    expect(displayThinkingLevel("high", spec.options)).toBe("medium");
    expect(displayThinkingLevel("max", spec.options)).toBe("medium");
  });

  it("R96-F: stored Max on an [xhigh, high] model displays X-HIGH (the nearest supported below max)", () => {
    const spec = thinkingMenuSpec({ supported: true, efforts: ["high", "xhigh"] });
    expect(displayThinkingLevel("max", spec.options)).toBe("xhigh");
    expect(displayThinkingLevel("xhigh", spec.options)).toBe("xhigh");
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

/* ── The persisted level admits "medium" and "xhigh" (the widened vocabulary) ──────────── */

describe("R95-E → R96-F: the per-session level round-trips the widened vocabulary", () => {
  it("THINKING_OPTIONS carries all six vocabulary levels (X-High between High and Max)", () => {
    expect(THINKING_OPTIONS.map((o) => o.id)).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
    expect(THINKING_OPTIONS.find((o) => o.id === "xhigh")?.label).toBe("X-High");
  });

  it("save + load round-trips medium and xhigh; an invalid value still falls back to default", () => {
    saveThinkingLevel("ses-r96f", "medium");
    expect(loadThinkingLevel("ses-r96f")).toBe("medium");
    saveThinkingLevel("ses-r96f", "xhigh");
    expect(loadThinkingLevel("ses-r96f")).toBe("xhigh");
    window.localStorage.setItem("acute-thinking:ses-r96f", "ultra");
    expect(loadThinkingLevel("ses-r96f")).toBe("default");
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
    // ROUND-96 (R96-F): the note NAMES THE SOURCE — "detected from
    // provider: low, medium". The detected list IS the honest cap note
    // (the old separate "caps reasoning at medium" wording retired).
    expect(document.querySelector("[data-thinking-menu-note]")?.textContent).toBe(
      "detected from provider: low, medium",
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Medium/ }));
    expect(onChange).toHaveBeenCalledWith("medium");
  });

  it("efforts [low, medium, high] → Default/Low/Medium/High (NO Max — the ladder lacks it) + the DETECTED note (R96-F)", () => {
    // ROUND-96 (R96-F): the menu offers ONLY the model's own rungs — max is
    // a real rung now, so a ladder without it must NOT offer it — and the
    // note NAMES THE SOURCE ("detected from provider: …"), making the
    // detection VISIBLE (the owner: "it apparently did not detect that
    // properly and was showing the default options").
    const support: ModelReasoningSupport = { supported: true, efforts: ["low", "medium", "high"] };
    render(<ThinkingLevelButton level="low" onChange={() => {}} reasoningSupport={support} />);
    fireEvent.click(screen.getByRole("button", { name: "Thinking level: Low" }));
    expect(optionLabels().map((l) => l.replace(/(The model's own reasoning default\.|Light reasoning — fastest replies\.|Balanced reasoning effort\.|Deeper reasoning for complex work\.|Maximum reasoning effort\.)$/, ""))).toEqual([
      "Default",
      "Low",
      "Medium",
      "High",
    ]);
    expect(document.querySelector("[data-thinking-menu-note]")?.textContent).toBe(
      "detected from provider: low, medium, high",
    );
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
