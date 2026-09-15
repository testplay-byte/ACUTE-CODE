// @vitest-environment happy-dom
/**
 * ROUND-96 (R96-G) tests — the menu-overlay bridge's USAGE rich card.
 *
 * The owner: "when I try to hover over the total number of token usage that
 * has been done, it apparently hides the browser and says, 'Browser paused
 * while the menu is open.' This is not a great experience." The ContextDonut
 * popover now rides the overlay OS window via a `kind: "usage"` payload —
 * these tests pin the BRIDGE half of that contract (the ContextDonut ladder
 * itself lives in ContextDonut.test.tsx):
 *
 *  · the payload type is JSON-safe (it crosses the window boundary as one
 *    JSON string — anything non-serializable breaks the show silently);
 *  · the window-height ESTIMATOR arithmetic (the main window sizes the OS
 *    window from the payload alone; the overlay page paints to the same px
 *    contract — a drift is clipped rows or dead card space);
 *  · web mode degrades exactly like the menus: no Tauri global → FALSE from
 *    showMenuOverlay (the DOM popover fallback), no-op subscriptions.
 */
import { describe, expect, it } from "vitest";
import {
  USAGE_CARD_CHROME_PX,
  USAGE_CONTEXT_BAR_PX,
  USAGE_DONUT_PX,
  USAGE_LINE_PX,
  USAGE_NOTE_PX,
  USAGE_PANE_PX,
  USAGE_SECTION_TITLE_PX,
  USAGE_TABLE_HEAD_PX,
  USAGE_TABLE_ROW_PX,
  estimateUsageCardHeight,
  onMenuOverlayClose,
  onMenuOverlayHover,
  onMenuOverlayPick,
  showMenuOverlay,
  usageSegmentHex,
  type UsageCardPayload,
  type UsageSectionPayload,
} from "./menu-overlay";

function section(title: string, lines: number): UsageSectionPayload {
  return {
    title,
    lines: Array.from({ length: lines }, (_, i) => ({ label: `L${i}`, value: `${i}` })),
  };
}

function usagePayload(sections: UsageSectionPayload[], note?: string): UsageCardPayload {
  return {
    kind: "usage",
    title: "Context window usage",
    width: 288,
    sections,
    ...(note !== undefined ? { note } : {}),
    theme: {
      card: "#ffffff",
      border: "#e5e7eb",
      softShadow: "0 8px 24px rgba(0,0,0,0.12)",
      text: "#111827",
      textSecondary: "#4b5563",
      textTertiary: "#9ca3af",
      accent: "#3b82f6",
      subtleHover: "rgba(0,0,0,0.05)",
      isDark: false,
    },
  };
}

describe("ROUND-96 (R96-G) — the usage payload contract", () => {
  it("the payload is JSON-safe: the string round-trips into the same shape (it crosses the window boundary as one JSON string)", () => {
    const payload = usagePayload(
      [section("Window", 4), section("Breakdown", 6), section("Cache", 2), section("Session", 3)],
      "compacted · 12 messages summarized · ~18.4k saved",
    );
    const json = JSON.stringify(payload);
    expect(json.length).toBeGreaterThan(200); // a real card, not a stub
    const back = JSON.parse(json) as UsageCardPayload;
    expect(back.kind).toBe("usage");
    expect(back.sections).toHaveLength(4);
    expect(back.sections[0]?.lines[0]?.label).toBe("L0");
    expect(back.note).toBe("compacted · 12 messages summarized · ~18.4k saved");
    // Every field the overlay page paints is a JSON-safe string.
    for (const s of back.sections) {
      expect(typeof s.title).toBe("string");
      for (const l of s.lines) {
        expect(typeof l.label).toBe("string");
        expect(typeof l.value).toBe("string");
        expect(l.note === undefined || typeof l.note === "string").toBe(true);
      }
    }
  });

  it("the estimator sums the contract: chrome + every pane (overhead + label) + every line (+ the note), floored at the Rust command's 40px minimum", () => {
    const twoSections = usagePayload([section("Window", 4), section("Session", 3)]);
    // R98-C3: every visual block is a PANE now — the per-pane overhead
    // (USAGE_PANE_PX: border + padding + the gap below) + the pane's label
    // row (USAGE_SECTION_TITLE_PX) + the content lines.
    expect(estimateUsageCardHeight(twoSections)).toBe(
      USAGE_CARD_CHROME_PX + 2 * (USAGE_PANE_PX + USAGE_SECTION_TITLE_PX) + 7 * USAGE_LINE_PX,
    );
    // The note adds its row only when non-empty.
    const withNote = usagePayload([section("Window", 4)], "200k window · catalog default");
    expect(estimateUsageCardHeight(withNote)).toBe(
      USAGE_CARD_CHROME_PX + (USAGE_PANE_PX + USAGE_SECTION_TITLE_PX) + 4 * USAGE_LINE_PX + USAGE_NOTE_PX,
    );
    const emptyNote = usagePayload([section("Window", 4)], "");
    expect(estimateUsageCardHeight(emptyNote)).toBe(
      USAGE_CARD_CHROME_PX + (USAGE_PANE_PX + USAGE_SECTION_TITLE_PX) + 4 * USAGE_LINE_PX,
    );
    // The floor: a degenerate card never asks for a sub-40px window (the
    // Rust clamp would refuse it anyway). R98-C3: the sectioned chrome
    // (55px) alone exceeds the Rust floor — an empty card IS the chrome.
    expect(estimateUsageCardHeight(usagePayload([]))).toBe(USAGE_CARD_CHROME_PX);
    expect(USAGE_CARD_CHROME_PX).toBeGreaterThanOrEqual(40);
  });

  it("R97-C: the estimator sums the context bar + the donut header + the session table", () => {
    const visual = {
      ...usagePayload([
        {
          ...section("Session", 0),
          table: {
            columns: ["Group", "Turns", "Calls", "Sent ↑", "Received ↓", "Cost"],
            rows: [
              { label: "Main agent", cells: ["3", "7", "45.2K ↑", "900 ↓", "$0.0123"] },
              { label: "Sub-agents", cells: ["1", "—", "1K ↑", "200 ↓", "—"] },
              { label: "Combined", cells: ["4", "9", "46.2K ↑", "1.1K ↓", "$0.0123"], strong: true },
            ],
          },
        },
      ]),
      contextBar: {
        usedTokens: 40_000,
        windowTokens: 200_000,
        reservedTokens: 16_000,
        usedPct: 20,
        segments: [],
      },
      donut: {
        used: 40_000,
        limit: 200_000,
        markerFrac: 0.8,
        ringColor: "accent" as const,
        lines: [
          { label: "Projected", value: "~20%", strong: true },
          { label: "Estimated", value: "40K / 200K", note: "of window" },
          { label: "Measured", value: "45.2K", note: "at last request", strong: true },
          { label: "Model", value: "z-ai/glm-5.2:free" },
          { label: "Session cost", value: "$0.0123", note: "4 turns · 9 provider calls" },
        ],
      },
    } satisfies UsageCardPayload;
    expect(estimateUsageCardHeight(visual)).toBe(
      USAGE_CARD_CHROME_PX +
        // R98-C3: three panes (donut + bar + the one section) each pay the
        // pane overhead + the label row.
        3 * (USAGE_PANE_PX + USAGE_SECTION_TITLE_PX) +
        USAGE_CONTEXT_BAR_PX +
        // the donut content: 5 header lines (5*17=85) beat the 54px floor
        5 * USAGE_LINE_PX + 10 +
        USAGE_TABLE_HEAD_PX +
        3 * USAGE_TABLE_ROW_PX,
    );
    // A donut with FEW lines still reserves the 54px ring block.
    const small = {
      ...visual,
      donut: { ...visual.donut, lines: visual.donut.lines.slice(0, 2) },
    } satisfies UsageCardPayload;
    expect(estimateUsageCardHeight(small)).toBe(
      USAGE_CARD_CHROME_PX +
        3 * (USAGE_PANE_PX + USAGE_SECTION_TITLE_PX) +
        USAGE_CONTEXT_BAR_PX +
        USAGE_DONUT_PX +
        USAGE_TABLE_HEAD_PX +
        3 * USAGE_TABLE_ROW_PX,
    );
  });

  it("R97-C: usageSegmentHex resolves the palette (accent passes through; the fixed hues are theme-aware)", () => {
    expect(usageSegmentHex("accent", true, "#ff6b35")).toBe("#ff6b35");
    expect(usageSegmentHex("accent", false, "#ff6b35")).toBe("#ff6b35");
    // The fixed hues pick their light/dark variants.
    expect(usageSegmentHex("blue", false, "#ff6b35")).toBe("#3b82f6");
    expect(usageSegmentHex("blue", true, "#ff6b35")).toBe("#60a5fa");
    expect(usageSegmentHex("reserved", false, "#ff6b35")).toBe("#9ca3af");
    expect(usageSegmentHex("rose", true, "#ff6b35")).toBe("#fb7185");
  });

  it("web mode: showMenuOverlay resolves FALSE (the DOM popover fallback) and the subscriptions are no-ops", async () => {
    // happy-dom carries no window.__TAURI__ — the whole point of this leg.
    expect((window as unknown as { __TAURI__?: unknown }).__TAURI__).toBeUndefined();
    await expect(
      showMenuOverlay({ left: 10, top: 10, width: 300, height: 200 }, usagePayload([section("Window", 2)])),
    ).resolves.toBe(false);
    // The subscriptions install, never fire, and unlisten cleanly.
    const offPick = onMenuOverlayPick(() => {
      throw new Error("no picks outside Tauri");
    });
    const offClose = onMenuOverlayClose(() => {
      throw new Error("no closes outside Tauri");
    });
    const offHover = onMenuOverlayHover(() => {
      throw new Error("no hovers outside Tauri");
    });
    expect(typeof offPick).toBe("function");
    expect(typeof offClose).toBe("function");
    expect(typeof offHover).toBe("function");
    offPick();
    offClose();
    offHover();
  });
});
