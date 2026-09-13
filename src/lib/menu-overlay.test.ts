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
  USAGE_LINE_PX,
  USAGE_NOTE_PX,
  USAGE_SECTION_TITLE_PX,
  estimateUsageCardHeight,
  onMenuOverlayClose,
  onMenuOverlayHover,
  onMenuOverlayPick,
  showMenuOverlay,
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

  it("the estimator sums the contract: chrome + every section title + every line (+ the note), floored at the Rust command's 40px minimum", () => {
    const twoSections = usagePayload([section("Window", 4), section("Session", 3)]);
    expect(estimateUsageCardHeight(twoSections)).toBe(
      USAGE_CARD_CHROME_PX + 2 * USAGE_SECTION_TITLE_PX + 7 * USAGE_LINE_PX,
    );
    // The note adds its row only when non-empty.
    const withNote = usagePayload([section("Window", 4)], "200k window · catalog default");
    expect(estimateUsageCardHeight(withNote)).toBe(
      USAGE_CARD_CHROME_PX + USAGE_SECTION_TITLE_PX + 4 * USAGE_LINE_PX + USAGE_NOTE_PX,
    );
    const emptyNote = usagePayload([section("Window", 4)], "");
    expect(estimateUsageCardHeight(emptyNote)).toBe(
      USAGE_CARD_CHROME_PX + USAGE_SECTION_TITLE_PX + 4 * USAGE_LINE_PX,
    );
    // The floor: a degenerate card never asks for a sub-40px window (the
    // Rust clamp would refuse it anyway).
    expect(estimateUsageCardHeight(usagePayload([]))).toBe(40);
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
