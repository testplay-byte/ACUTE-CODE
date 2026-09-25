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
  USAGE_BAR_LABEL_MIN_FRAC,
  USAGE_CARD_CHROME_PX,
  USAGE_CONTEXT_BAR_PX,
  USAGE_HERO_BIG_PX,
  USAGE_HERO_BUDGET_PX,
  USAGE_HERO_GAP_PX,
  USAGE_HERO_META_PX,
  USAGE_HERO_PCT_PX,
  USAGE_HERO_RING_PX,
  USAGE_LEGEND_HINT_PX,
  USAGE_LEGEND_ROW_PX,
  USAGE_LINE_PX,
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
      // R126-3h: the deep-tier/badge-tone/clay legs (MenuTheme grew them —
      // the JSON-safety pin below covers the whole payload).
      accentDeep: "#1d4ed8",
      accentTint: "#e6eefa",
      clayRim: "#e8e7e4",
      claySheetShadow: "0px -2px 6px rgba(38,34,28,0.12)",
      badgeNeutralBg: "#f4f1ee",
      badgeNeutralFg: "rgba(0,0,0,0.62)",
      successDeep: "#15803d",
      runningDeep: "#1d4ed8",
      warningDeep: "#b45309",
      dangerDeep: "#dc2626",
    },
  };
}

describe("ROUND-96 (R96-G) + ROUND-99 (R99-D) — the usage payload contract", () => {
  it("the payload is JSON-safe: the string round-trips into the same shape (it crosses the window boundary as one JSON string)", () => {
    const payload = usagePayload([section("Cache", 1), section("Session totals", 0)]);
    payload.contextBar = {
      usedTokens: 40_000,
      windowTokens: 200_000,
      reservedTokens: 16_000,
      usedPct: 20,
      segments: [
        { label: "Messages", tokens: 34_500, color: "accent", tokensLabel: "34.5k", pctOfUsed: "86%" },
        {
          label: "System prompt",
          tokens: 2_000,
          color: "blue",
          tokensLabel: "2k",
          pctOfUsed: "5%",
          manage: { target: "/settings?tab=prompts", title: "Manage the prompt sections — Settings → Prompts" },
        },
        { label: "System tools", tokens: 1_000, color: "teal", tokensLabel: "1k", pctOfUsed: "3%" },
        { label: "MCP tools", tokens: 1_500, color: "violet", tokensLabel: "1.5k", pctOfUsed: "4%", manage: { target: "/settings?tab=mcp", title: "Manage MCP servers — Settings → MCP Servers" } },
        { label: "Memory & skills", tokens: 500, color: "amber", tokensLabel: "500", pctOfUsed: "1%", manage: { target: "/settings?tab=prompts", title: "Manage skills & prompt sections — Settings → Prompts" } },
        { label: "Meta & project", tokens: 500, color: "rose", tokensLabel: "500", pctOfUsed: "1%" },
      ],
    };
    payload.overview = {
      used: 40_000,
      limit: 200_000,
      markerFrac: 0.8,
      ringColor: "accent",
      bigUsed: "40k",
      bigLimit: "200k",
      pctLine: "~20% projected",
      meta: [
        { id: "measured", label: "measured at last request", value: "45k", title: "45k tokens · 9/13/2026" },
        { id: "model", label: "model", value: "z-ai/glm-5.2:free" },
        { id: "window", label: "window", value: "200k · catalog default" },
      ],
      budgetLine: "compaction line 159k · reserve 33k output",
      compactedBadge: { label: "Context compacted", detail: "12 messages summarized · ~18.4k saved" },
    };
    const json = JSON.stringify(payload);
    expect(json.length).toBeGreaterThan(200); // a real card, not a stub
    const back = JSON.parse(json) as UsageCardPayload;
    expect(back.kind).toBe("usage");
    expect(back.sections).toHaveLength(2);
    expect(back.overview?.pctLine).toBe("~20% projected");
    expect(back.overview?.compactedBadge?.detail).toContain("12 messages summarized");
    // Every field the overlay page paints is a JSON-safe string.
    for (const seg of back.contextBar?.segments ?? []) {
      expect(typeof seg.label).toBe("string");
      expect(typeof seg.tokensLabel).toBe("string");
      expect(typeof seg.pctOfUsed).toBe("string");
      expect(seg.manage === undefined || typeof seg.manage.target === "string").toBe(true);
    }
    for (const m of back.overview?.meta ?? []) {
      expect(typeof m.label).toBe("string");
      expect(typeof m.value).toBe("string");
    }
    for (const s of back.sections) {
      expect(typeof s.title).toBe("string");
      for (const l of s.lines) {
        expect(typeof l.label).toBe("string");
        expect(typeof l.value).toBe("string");
        expect(l.note === undefined || typeof l.note === "string").toBe(true);
      }
    }
  });

  it("R99-D: the estimator sums the contract — chrome + the unboxed overview hero (big/%/meta rows vs the ring floor + the budget line + the block gap) + every pane (overhead + label) + the bar/hint/legend rows + the lines + the table, floored at the Rust command's 40px minimum", () => {
    const twoSections = usagePayload([section("Cache", 1), section("Report", 2)]);
    // No overview / no contextBar → no hero, no bar pane: chrome + the two
    // section panes + their lines.
    expect(estimateUsageCardHeight(twoSections)).toBe(
      USAGE_CARD_CHROME_PX + 2 * (USAGE_PANE_PX + USAGE_SECTION_TITLE_PX) + 3 * USAGE_LINE_PX,
    );
    // The floor: a degenerate card never asks for a sub-40px window (the
    // Rust clamp would refuse it anyway). R98-C3: the sectioned chrome
    // (55px) alone exceeds the Rust floor — an empty card IS the chrome.
    expect(estimateUsageCardHeight(usagePayload([]))).toBe(USAGE_CARD_CHROME_PX);
    expect(USAGE_CARD_CHROME_PX).toBeGreaterThanOrEqual(40);

    // The full R99-D card: hero (3 meta pairs + the budget line) + the
    // bar pane (6 legend rows) + the Cache pane (one line) + the session
    // table pane.
    const hero = {
      ...usagePayload([
        section("Cache", 1),
        {
          ...section("Session totals", 0),
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
      overview: {
        used: 40_000,
        limit: 200_000,
        markerFrac: 0.8,
        ringColor: "accent" as const,
        bigUsed: "40k",
        bigLimit: "200k",
        pctLine: "~20% projected",
        meta: [
          { id: "measured", label: "measured at last request", value: "45k" },
          { id: "model", label: "model", value: "z-ai/glm-5.2:free" },
          { id: "window", label: "window", value: "200k · catalog default" },
        ],
        budgetLine: "compaction line 159k · reserve 33k output",
      },
      contextBar: {
        usedTokens: 40_000,
        windowTokens: 200_000,
        reservedTokens: 16_000,
        usedPct: 20,
        segments: Array.from({ length: 6 }, (_, i) => ({
          label: `S${i}`,
          tokens: 1_000,
          color: "accent" as const,
          tokensLabel: "1k",
          pctOfUsed: "5%",
        })),
      },
    } satisfies UsageCardPayload;
    expect(estimateUsageCardHeight(hero)).toBe(
      USAGE_CARD_CHROME_PX +
        Math.max(
          USAGE_HERO_RING_PX,
          USAGE_HERO_BIG_PX + USAGE_HERO_PCT_PX + 3 * USAGE_HERO_META_PX,
        ) +
        USAGE_HERO_BUDGET_PX +
        USAGE_HERO_GAP_PX +
        // three panes: the bar pane + Cache + Session totals
        3 * (USAGE_PANE_PX + USAGE_SECTION_TITLE_PX) +
        USAGE_CONTEXT_BAR_PX +
        USAGE_LEGEND_HINT_PX +
        6 * USAGE_LEGEND_ROW_PX +
        USAGE_LINE_PX +
        USAGE_TABLE_HEAD_PX +
        3 * USAGE_TABLE_ROW_PX,
    );
    // A hero with FEW meta rows floors at the 46px ring block; no budget
    // line → no budget row.
    const sparse = {
      ...hero,
      overview: { ...hero.overview, meta: hero.overview.meta.slice(0, 1), budgetLine: undefined },
    } satisfies UsageCardPayload;
    expect(estimateUsageCardHeight(sparse)).toBe(
      estimateUsageCardHeight(hero) - 2 * USAGE_HERO_META_PX - USAGE_HERO_BUDGET_PX,
    );
  });

  it("R99-D: USAGE_BAR_LABEL_MIN_FRAC is the one shared label gate (both legs label segments at/above it)", () => {
    expect(USAGE_BAR_LABEL_MIN_FRAC).toBe(0.12);
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
