// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UsageActivityChart } from "./UsageActivityChart";
import { deriveThemeStyles } from "../../lib/themes";
import { utcDateLabel } from "../dashboard/helpers";
import type { UsageDayBucket } from "../../lib/api";

/** R127-W2 — the ROUND-127 chart-interaction laws (COMPONENTS §6) pinned at
 *  the usage screen's own activity chart, plus the HOURLY VIEW contract
 *  (the owner's "seven days… a much better kind of view, like hourly based"
 *  ask):
 *   · the full-column hit-testing law (painted bars display-only);
 *   · the tooltip edge law (clampTooltipX at the first/last bars);
 *   · the hour mode (6px geometry, sparse "HH:00" ticks + day-boundary
 *     labels, hour tooltip headers, the aria/kicker copy);
 *   · the newest-end law (the overflow scroller mounts/lands at the newest
 *     end — pinned via the effect's data hook + a stubbed scroll geometry,
 *     since happy-dom reports 0/0).
 *
 *  Geometry facts the pins ride on: DAY mode = 20px bars + 6px gaps (26px
 *  pitch); 10 buckets → a 254px chart, centers at i×26+10, the w-44 tooltip
 *  is 176px, the clamp inset is 8px (mid i=4 centers at 114; last clamps to
 *  70; first clamps to 8). HOUR mode = 6px bars + 2px gaps (8px pitch);
 *  168 buckets (7×24) → a 1342px chart, centers at i×8+3 (last i=167 →
 *  1339; clamps to 1158; first clamps to 8; i=84 centers at 675).
 *
 *  The real-browser half of the hit-testing law (the pointer falling through
 *  a pointer-events:none painted bar onto the column UNDERNEATH) is DOM
 *  hit-testing the happy-dom env cannot synthesize — the pins below assert
 *  the law's spelling (the painted rects are display-only and carry no bar
 *  index; the column owns the hit and spans the full plot height) + the
 *  behavioral reads through the column rects. The live pointer pass is the
 *  orchestrator's consolidated post-wave browser sweep. */

const DAY_PITCH = 26; // DAY_BAR_WIDTH 20 + DAY_BAR_GAP 6
const DAY_CHART_WIDTH = 10 * DAY_PITCH - 6; // 254
const HOUR_PITCH = 8; // HOUR_BAR_WIDTH 6 + HOUR_BAR_GAP 2
const HOUR_CHART_WIDTH = 168 * HOUR_PITCH - 2; // 1342
const TOOLTIP_W = 176; // the tooltip card's w-44 class
const TOOLTIP_INSET = 8; // clampTooltipX's TOOLTIP_EDGE_INSET_PX

// The dashboard's default theme pair (resetTestState's nova/dark).
const styles = deriveThemeStyles("nova", true);

// Vitest globals are off, so RTL's auto-cleanup does not hook in — do it by hand.
afterEach(cleanup);

function makeDays(count = 10): UsageDayBucket[] {
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-08-${String(9 + i).padStart(2, "0")}`,
    inputTokens: 1_000 * (i + 1),
    outputTokens: 500,
    requests: i + 1,
    costUsd: 0.01 * (i + 1),
  }));
}

/** 168 hour buckets over 7 UTC days ("2026-08-16T00" … "2026-08-22T23") —
 *  the granularity=hour series shape from GET /usage/detailed. */
function makeHourDays(): UsageDayBucket[] {
  const out: UsageDayBucket[] = [];
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      out.push({
        date: `2026-08-${String(16 + d).padStart(2, "0")}T${String(h).padStart(2, "0")}`,
        inputTokens: 100,
        outputTokens: 50,
        requests: 1,
        costUsd: 0.001,
      });
    }
  }
  return out;
}

/** The hover tooltip's positioning wrapper — the ONE pointer-events-none div
 *  in the chart (the painted bars are SVG rects, not divs). */
function tooltipEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>("div.pointer-events-none");
}

describe("UsageActivityChart (R127-W2 chart-interaction laws — day mode)", () => {
  it("full-column hit-testing: the painted bars are display-only — the transparent data-bar-idx column owns the hit", () => {
    render(
      <UsageActivityChart days={makeDays()} dayCount={10} isPending={false} isError={false} styles={styles} />,
    );

    const svg = document.querySelector('svg[role="img"]');
    expect(svg).not.toBeNull();
    const columns = svg!.querySelectorAll("rect[data-bar-idx]");
    expect(columns).toHaveLength(10);
    const painted = svg!.querySelectorAll('rect[rx="6"]');
    expect(painted).toHaveLength(10);

    // THE FULL-COLUMN LAW: every PAINTED bar renders pointer-events:none
    // (display-only — hovering the bar BODY resolves through the transparent
    // column underneath, not the painted rect that renders after it), and
    // none of them carries a data-bar-idx of its own — the ONE hit surface
    // per bar is the column (the owner's "hover only works at the top area"
    // complaint's remedy).
    for (const bar of Array.from(painted)) {
      expect((bar as SVGElement).style.pointerEvents).toBe("none");
      expect(bar.hasAttribute("data-bar-idx")).toBe(false);
    }

    // The column spans the FULL plot height from y=0 (140px) — the body,
    // the cap, and the empty air beside the bar all resolve the same bar.
    for (const column of Array.from(columns)) {
      expect(column.getAttribute("height")).toBe("140");
      expect(column.getAttribute("y")).toBe("0");
    }
  });

  it("tooltip edge law: centers mid-series, clamps inside the chart at the first/last bars", () => {
    render(
      <UsageActivityChart days={makeDays()} dayCount={10} isPending={false} isError={false} styles={styles} />,
    );
    const columns = document.querySelectorAll<SVGElement>("svg rect[data-bar-idx]");

    // Middle bar (i=4, center x=114): the tooltip CENTERS on its bar —
    // left is the bar's center, the -50% shift does the centering.
    fireEvent.pointerMove(columns[4]);
    let tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("114px");
    expect(screen.getByText("5,500")).toBeTruthy(); // 5k in + 0.5k out

    // LAST bar (i=9, center x=244): a centered 176px tooltip would overflow
    // the 254px chart's right edge — the clamp aligns its near edge inside
    // (254 − 176 − 8 = 70px; 70 + 176 = 246 = the content box's edge).
    fireEvent.pointerMove(columns[9]);
    tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("70px");
    expect(Number.parseFloat(tip!.style.left) + TOOLTIP_W).toBeLessThanOrEqual(
      DAY_CHART_WIDTH - TOOLTIP_INSET,
    );
    expect(screen.getByText("10,500")).toBeTruthy();

    // FIRST bar (i=0, center x=10): the mirror clamp at the left end — the
    // 8px inset, never a translateX(-50%) that pushes the card off-chart.
    fireEvent.pointerMove(columns[0]);
    tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("8px");
    expect(screen.getByText("1,500")).toBeTruthy();
  });

  it("the R121-d single pointer read: one onPointerMove resolves the bar; leaving the bars clears the tooltip", async () => {
    render(
      <UsageActivityChart days={makeDays()} dayCount={10} isPending={false} isError={false} styles={styles} />,
    );
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

  it("10 day buckets label every bar through the day branch (shortUtcDay)", () => {
    render(
      <UsageActivityChart days={makeDays()} dayCount={10} isPending={false} isError={false} styles={styles} />,
    );
    // The day view keeps its every-bar weekday band (the sparse-tick law
    // engages only in the hour mode / wider scrolling windows).
    expect(document.querySelectorAll("svg text")).toHaveLength(10);
  });
});

describe("UsageActivityChart (R127-W2 — the HOURLY view)", () => {
  function renderHourChart() {
    return render(
      <UsageActivityChart
        days={makeHourDays()}
        dayCount={7}
        granularity="hour"
        isPending={false}
        isError={false}
        styles={styles}
      />,
    );
  }

  it("hour geometry: 6px bars at a 2px gap — 168 buckets ≈ 1.34Kpx of scrolling chart (no empty-sides view)", () => {
    renderHourChart();
    const svg = document.querySelector('svg[role="img"]');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("width")).toBe(String(HOUR_CHART_WIDTH));
    const columns = svg!.querySelectorAll("rect[data-bar-idx]");
    expect(columns).toHaveLength(168);
    for (const column of Array.from(columns)) {
      expect(column.getAttribute("width")).toBe("6");
      expect(column.getAttribute("height")).toBe("140");
    }
    const painted = svg!.querySelectorAll('rect[rx="2"]');
    expect(painted).toHaveLength(168);
    // The full-column law holds in the hour mode too.
    for (const bar of Array.from(painted)) {
      expect((bar as SVGElement).style.pointerEvents).toBe("none");
      expect(bar.hasAttribute("data-bar-idx")).toBe(false);
    }
  });

  it("the alternating label band: sparse HH:00 ticks + DAY-BOUNDARY labels — hour keys never reach the day helpers", () => {
    renderHourChart();
    const svg = document.querySelector('svg[role="img"]')!;

    // The day boundaries carry the day label (utcDateLabel on the 10-char
    // DAY key — day 2's first bucket is index 24) at the 600 weight…
    const dayLabel = screen.getByText(utcDateLabel("2026-08-17"));
    expect(dayLabel.getAttribute("font-weight")).toBe("600");
    // …every one of the 7 days gets its boundary label…
    for (const d of [16, 17, 18, 19, 20, 21, 22]) {
      expect(screen.getByText(utcDateLabel(`2026-08-${String(d).padStart(2, "0")}`))).toBeTruthy();
    }
    // …and the sparse hour ticks carry "HH:00" between them (bucket 28 =
    // day 1's 04:00; bucket 111 = day 5's 15:00).
    expect(screen.getByText("04:00")).toBeTruthy();
    expect(screen.getByText("15:00")).toBeTruthy();

    // The band stays SPARSE (≤7 hour ticks + ≤7 day boundaries — never 168
    // labels) and NEVER renders an Invalid Date (the hour-key-through-
    // utcDateLabel trap the R127-Rb research flagged).
    const labels = svg.querySelectorAll("text");
    expect(labels.length).toBeLessThanOrEqual(14);
    expect(svg.textContent).not.toContain("Invalid Date");
    expect(svg.textContent).not.toContain("NaN");
  });

  it("the copy laws: the Kicker carries the '· hourly' suffix; the aria-label reads per hour", () => {
    renderHourChart();
    expect(screen.getByText("Token Activity · 7 days · hourly")).toBeTruthy();
    const svg = document.querySelector('svg[role="img"]')!;
    expect(svg.getAttribute("aria-label")).toBe("Token usage per hour, 25,200 tokens over 168 hours");
  });

  it("the hour tooltip: header reads hourBucketLabel ('Mon DD · HH:00') + the same edge clamp", () => {
    renderHourChart();
    const columns = document.querySelectorAll<SVGElement>("svg rect[data-bar-idx]");

    // Middle bucket (i=84, center x=675): centers on its bar.
    fireEvent.pointerMove(columns[84]);
    let tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("675px");
    expect(screen.getByText("Aug 19 · 12:00")).toBeTruthy(); // hourBucketLabel
    expect(screen.getByText("150")).toBeTruthy(); // 100 in + 50 out

    // LAST bucket (i=167, center x=1339): clamps inside the 1342px chart
    // (1342 − 176 − 8 = 1158; 1158 + 176 = 1334 = the content box's edge).
    fireEvent.pointerMove(columns[167]);
    tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("1158px");
    expect(Number.parseFloat(tip!.style.left) + TOOLTIP_W).toBeLessThanOrEqual(
      HOUR_CHART_WIDTH - TOOLTIP_INSET,
    );
    expect(screen.getByText("Aug 22 · 23:00")).toBeTruthy();

    // FIRST bucket (i=0, center x=3): the mirror clamp at the 8px inset.
    fireEvent.pointerMove(columns[0]);
    tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("8px");
    expect(screen.getByText("Aug 16 · 00:00")).toBeTruthy();
  });

  it("the newest-end law: the overflow scroller mounts at the newest end (scrollLeft = scrollWidth)", () => {
    // The mount pass: the ready chart's overflow-x-auto scroller carries the
    // effect's data hook (happy-dom reports 0/0 scroll geometry — the pin
    // reads the hook, then drives the effect's CONTRACT through a stubbed
    // element on the granularity swap).
    const { rerender } = render(
      <UsageActivityChart days={makeDays()} dayCount={10} isPending={false} isError={false} styles={styles} />,
    );
    const scroller = document.querySelector<HTMLElement>("[data-scrolled-to-latest]");
    expect(scroller).not.toBeNull();
    expect(scroller!.className).toContain("overflow-x-auto");

    // The swap pass: stub the scroller's geometry, swap day→hour — the
    // effect re-runs and lands the scroll at the newest end.
    let assigned = -1;
    Object.defineProperty(scroller, "scrollWidth", { configurable: true, get: () => HOUR_CHART_WIDTH });
    Object.defineProperty(scroller, "scrollLeft", {
      configurable: true,
      get: () => 0,
      set: (v: number) => {
        assigned = v;
      },
    });
    rerender(
      <UsageActivityChart
        days={makeHourDays()}
        dayCount={7}
        granularity="hour"
        isPending={false}
        isError={false}
        styles={styles}
      />,
    );
    expect(assigned).toBe(HOUR_CHART_WIDTH);
  });
});
