// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TokenBarChart } from "./TokenBarChart";
import { deriveThemeStyles } from "../../lib/themes";
import type { UsageDayBucket } from "../../lib/api";

/** R127-W3 → R128-W2 — the chart-interaction laws (COMPONENTS §6) pinned at
 *  the dashboard's own series: the full-column hit-testing law (R127, kept)
 *  + the side-placement tooltip law + the fill law (R128 — the R127
 *  center-on-bar tooltip pins are RE-PINNED to the beside values).
 *
 *  Geometry facts the pins ride on (the UNSTRETCHED natural pitch — happy-dom
 *  reports clientWidth 0, so the un-measured frame keeps the natural
 *  geometry; the fill-law tests stub the ResizeObserver): 14 buckets ×
 *  (20px bar + 6px gap) − 6 = a 358px chart; columns at [i×26, i×26+20];
 *  the w-44 tooltip is 176px wide; placeTooltipBeside's inset is 8px and its
 *  beside-gap is 8px →
 *    · i=0 (left half) → side right, left = 20+8 = 28px;
 *    · i=6 (center 166 < 179 → right, ideal 184 clamps to maxLeft 174 — the
 *      358px plot cannot host 176px beside a column at 156, the near-
 *      degenerate case; the flip keeps the roomier right side) = 174px;
 *    · i=13 (right half) → side left, left = 338−176−8 = 154px, right edge
 *      330 stops a full gap short of the column's 338 left edge.
 *
 *  The real-browser half of the hit-testing law (the pointer falling through
 *  a pointer-events:none painted bar onto the column UNDERNEATH) is DOM
 *  hit-testing the happy-dom env cannot synthesize — the pins below assert
 *  the law's spelling (the painted rects are display-only and carry no bar
 *  index; the column owns the hit and spans the full plot height) + the
 *  behavioral reads through the column rects. The live pointer pass is the
 *  orchestrator's consolidated post-wave browser sweep. */

const BAR_PITCH = 26; // BAR_WIDTH 20 + BAR_GAP 6 (the natural, unstretched pitch)
const CHART_WIDTH = 14 * BAR_PITCH - 6; // 358 (natural)
const TOOLTIP_W = 176; // the tooltip card's w-44 class
const TOOLTIP_INSET = 8; // placeTooltipBeside's TOOLTIP_EDGE_INSET_PX
const BESIDE_GAP = 8; // placeTooltipBeside's default gap

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

  it("R128 side-placement law: the tooltip renders BESIDE the hovered column — no -50% centering, no overlap at the ends", async () => {
    renderChart();
    const columns = document.querySelectorAll<SVGElement>("svg rect[data-bar-idx]");

    // FIRST bar (i=0, column [0, 20], center in the left half): the tooltip
    // sits to the column's RIGHT, one beside-gap past its right edge —
    // left = 20 + 8 = 28px. NEVER a translateX(-50%) centered on the bar
    // (the retired R127 spelling the owner's "centered on it" complaint
    // killed — the transform carries no -50% translation).
    fireEvent.pointerMove(columns[0]);
    let tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("28px");
    expect(tip!.style.transform).not.toContain("-50%");
    expect(screen.getByText("1,500")).toBeTruthy();

    // LAST bar (i=13, column [338, 358], center in the right half): the
    // tooltip sits to the column's LEFT — left = 338 − 176 − 8 = 154px; its
    // right edge (330) stops a full gap short of the column's left edge
    // (338) — BESIDE the bar, never covering it.
    fireEvent.pointerMove(columns[13]);
    tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("154px");
    expect(tip!.style.transform).not.toContain("-50%");
    expect(Number.parseFloat(tip!.style.left) + TOOLTIP_W).toBeLessThanOrEqual(
      13 * BAR_PITCH - BESIDE_GAP,
    );
    expect(screen.getByText("14,500")).toBeTruthy();

    // MIDDLE bar (i=6, column [156, 176], center 166 in the left half): side
    // right, ideal 184 clamps to maxLeft 174 (358 − 176 − 8). A 358px plot
    // cannot host the 176px tooltip beside a column at 156 on either side —
    // the near-degenerate case; placeTooltipBeside's overlap net keeps the
    // roomier right side and clamps to its edge (174). The tooltip still
    // stays inside the content box's inset.
    fireEvent.pointerMove(columns[6]);
    tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("174px");
    expect(Number.parseFloat(tip!.style.left) + TOOLTIP_W).toBeLessThanOrEqual(
      CHART_WIDTH - TOOLTIP_INSET,
    );
    expect(screen.getByText("7,500")).toBeTruthy(); // 7k in + 0.5k out
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

/** ResizeObserver stub whose callbacks the test fires with synthetic widths
 *  (the ChatFocusLayout.test.tsx pattern — happy-dom reports clientWidth 0
 *  and its own ResizeObserver never fires, so the fill law's measured-width
 *  leg is driven through this stub exactly like the established seam). */
class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    MockResizeObserver.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  static fire(width: number): void {
    for (const inst of MockResizeObserver.instances) {
      inst.cb(
        [{ contentRect: { width } } as unknown as ResizeObserverEntry],
        inst as unknown as ResizeObserver,
      );
    }
  }
}

describe("TokenBarChart (R128-W2 — the fill law)", () => {
  beforeEach(() => {
    MockResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("a fitting 14-day series stretches its pitch to FILL the measured card (no dead margins)", () => {
    renderChart();
    // A 716px card: the natural 358px chart doubles exactly — 40px bars +
    // 12px gaps at a 52px pitch (716 = 14 × 52 − 12), the svg fills the card.
    act(() => MockResizeObserver.fire(716));
    const svg = document.querySelector('svg[role="img"]');
    expect(svg!.getAttribute("width")).toBe("716");
    for (const column of Array.from(svg!.querySelectorAll("rect[data-bar-idx]"))) {
      expect(column.getAttribute("width")).toBe("40");
    }
  });

  it("the stretch is CAPPED at 42px bars however wide the card", () => {
    renderChart();
    // A 1000px card wants factor 2.79; the cap is min(42/20, 16/6) = 2.1 →
    // 42px bars / 12.6px gaps → 14 × 54.6 − 12.6 = 751.8px of chart.
    act(() => MockResizeObserver.fire(1000));
    const svg = document.querySelector('svg[role="img"]');
    expect(svg!.getAttribute("width")).toBe("751.8");
    for (const column of Array.from(svg!.querySelectorAll("rect[data-bar-idx]"))) {
      expect(column.getAttribute("width")).toBe("42");
    }
  });

  it("an overflowing card keeps the natural 20px pitch (the fill law never shrinks)", () => {
    renderChart();
    // A 200px card: the natural 358px chart overflows → natural geometry.
    act(() => MockResizeObserver.fire(200));
    const svg = document.querySelector('svg[role="img"]');
    expect(svg!.getAttribute("width")).toBe(String(CHART_WIDTH));
    for (const column of Array.from(svg!.querySelectorAll("rect[data-bar-idx]"))) {
      expect(column.getAttribute("width")).toBe("20");
    }
  });

  it("the chart keeps its fixed height under the stretch (no vertical fill)", () => {
    renderChart();
    act(() => MockResizeObserver.fire(716));
    const svg = document.querySelector('svg[role="img"]');
    expect(svg!.getAttribute("height")).toBe("168"); // 140 plot + 28 label band
  });
});
