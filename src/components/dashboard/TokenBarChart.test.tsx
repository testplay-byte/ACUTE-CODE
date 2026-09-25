// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TokenBarChart } from "./TokenBarChart";
import { deriveThemeStyles } from "../../lib/themes";
import type { UsageDayBucket } from "../../lib/api";

/** R127-W3 — the ROUND-127 chart-interaction laws (COMPONENTS §6) pinned at
 *  the dashboard's own series: the full-column hit-testing law + the tooltip
 *  edge law. Geometry facts the pins ride on: 14 buckets × (20px bar + 6px
 *  gap) − 6 = a 358px chart; bar centers at i×26+10; the w-44 tooltip is
 *  176px wide; clampTooltipX's inset is 8px → the clamped ends sit at left
 *  8px / 174px (174 + 176 = 350 = 358 − 8 — inside the chart's content box).
 *
 *  The real-browser half of the hit-testing law (the pointer falling through
 *  a pointer-events:none painted bar onto the column UNDERNEATH) is DOM
 *  hit-testing the happy-dom env cannot synthesize — the pins below assert
 *  the law's spelling (the painted rects are display-only and carry no bar
 *  index; the column owns the hit and spans the full plot height) + the
 *  behavioral reads through the column rects. The live pointer pass is the
 *  orchestrator's consolidated post-wave browser sweep. */

const BAR_PITCH = 26; // BAR_WIDTH 20 + BAR_GAP 6
const CHART_WIDTH = 14 * BAR_PITCH - 6; // 358
const TOOLTIP_W = 176; // the tooltip card's w-44 class
const TOOLTIP_INSET = 8; // clampTooltipX's TOOLTIP_EDGE_INSET_PX

// The dashboard's default theme (resetTestState's nova/dark pair).
const styles = deriveThemeStyles("nova", true);

// Vitest globals are off, so RTL's auto-cleanup does not hook in — do it by hand.
afterEach(cleanup);

function makeDays(): UsageDayBucket[] {
  return Array.from({ length: 14 }, (_, i) => ({
    date: `2026-08-${String(9 + i).padStart(2, "0")}`,
    inputTokens: 1_000 * (i + 1),
    outputTokens: 500,
    requests: i + 1,
    costUsd: 0.01 * (i + 1),
  }));
}

function renderChart() {
  return render(
    <TokenBarChart days={makeDays()} isPending={false} isError={false} styles={styles} />,
  );
}

/** The hover tooltip's positioning wrapper — the ONE pointer-events-none div
 *  in the chart (the painted bars are SVG rects, not divs). */
function tooltipEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>("div.pointer-events-none");
}

describe("TokenBarChart (R127 chart-interaction laws)", () => {
  it("full-column hit-testing: the painted bars are display-only — the transparent data-bar-idx column owns the hit", () => {
    renderChart();

    // The chart's own svg (role="img") — the card header's Zap glyph is also
    // an svg, but it carries no bars.
    const svg = document.querySelector('svg[role="img"]');
    expect(svg).not.toBeNull();
    const columns = svg!.querySelectorAll("rect[data-bar-idx]");
    expect(columns).toHaveLength(14);
    const painted = svg!.querySelectorAll('rect[rx="6"]');
    expect(painted).toHaveLength(14);

    // THE FULL-COLUMN LAW: every PAINTED bar renders pointer-events:none
    // (display-only — hovering the bar BODY resolves through the transparent
    // column underneath, not the painted rect that renders after it), and
    // none of them carries a data-bar-idx of its own — the ONE hit surface
    // per bar is the column.
    for (const bar of Array.from(painted)) {
      expect((bar as SVGElement).style.pointerEvents).toBe("none");
      expect(bar.hasAttribute("data-bar-idx")).toBe(false);
    }

    // The column spans the FULL plot height from y=0 (140px) — the body,
    // the cap, and the empty air beside the bar all resolve the same bar
    // (the owner's "hover only works at the top area" defect's remedy).
    for (const column of Array.from(columns)) {
      expect(column.getAttribute("height")).toBe("140");
      expect(column.getAttribute("y")).toBe("0");
    }
  });

  it("tooltip edge law: centers mid-series, clamps inside the chart at the first/last bars", async () => {
    renderChart();
    const columns = document.querySelectorAll<SVGElement>("svg rect[data-bar-idx]");

    // Middle bar (i=6, center x=166): the tooltip CENTERS on its bar —
    // left is the bar's center, the -50% shift does the centering.
    fireEvent.pointerMove(columns[6]);
    let tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("166px");
    expect(screen.getByText("7,500")).toBeTruthy(); // 6.5k in + 0.5k out

    // LAST bar (i=13, center x=348): a centered 176px tooltip would overflow
    // the 358px chart's right edge — the clamp aligns its near edge inside
    // (358 − 176 − 8 = 174px; 174 + 176 = 350 = the content box's edge).
    fireEvent.pointerMove(columns[13]);
    tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("174px");
    expect(Number.parseFloat(tip!.style.left) + TOOLTIP_W).toBeLessThanOrEqual(
      CHART_WIDTH - TOOLTIP_INSET,
    );
    expect(screen.getByText("14,500")).toBeTruthy();

    // FIRST bar (i=0, center x=10): the mirror clamp at the left end — the
    // 8px inset, never a translateX(-50%) that pushes the card off-chart.
    fireEvent.pointerMove(columns[0]);
    tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("8px");
    expect(screen.getByText("1,500")).toBeTruthy();
  });

  it("the R121-d single pointer read: one onPointerMove resolves the bar; leaving the bars clears the tooltip", async () => {
    renderChart();
    const columns = document.querySelectorAll<SVGElement>("svg rect[data-bar-idx]");

    // The single pointer read resolves through the column (the R5 law — no
    // per-bar hover pair anywhere in the chart).
    fireEvent.pointerMove(columns[5]);
    expect(tooltipEl()).not.toBeNull();

    // Moving onto the chart container itself (no data-bar-idx ancestor)
    // resolves NO bar → the tooltip exits (AnimatePresence removes it after
    // the exit fade — wait for the removal, never assert mid-fade).
    const container = columns[0].closest("div")!;
    fireEvent.pointerMove(container);
    await waitFor(() => expect(screen.queryByText("Input")).toBeNull());
  });

  it("14 days label every bar — the sparse-tick law does not engage at this density", () => {
    renderChart();

    // 14 bars at a 26px pitch ≈ 358px: the 3-char weekday labels fit an
    // every-bar band with room (COMPONENTS §6's dense-series rule engages
    // only when they don't — no sparse ticks on the dashboard's fixed
    // 14-day window).
    expect(document.querySelectorAll("svg text")).toHaveLength(14);
  });
});
