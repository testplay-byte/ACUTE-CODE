// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ModelStackChart } from "./ModelStackChart";
import { deriveThemeStyles } from "../../lib/themes";
import { utcDateLabel } from "../dashboard/helpers";
import { sparseTickIndices } from "./usage-helpers";
import type { UsageStatsDayBucket, UsageStatsModel } from "../../lib/api";

/** R127-W2 — the ROUND-127 chart-interaction laws (COMPONENTS §6) pinned at
 *  the MODEL MIX stacked chart (both owner complaints were named on this
 *  chart: the body-hover miss + the right-edge tooltip overflow):
 *   · the full-column hit-testing law (painted stacked segments
 *     display-only — the transparent data-bar-idx column owns the hit);
 *   · the tooltip edge law (clampTooltipX against the svg's Y_AXIS-offset
 *     coordinate space, the w-52 tooltip at 208px);
 *   · the newest-end law (the overflow scroller mounts/lands at the newest
 *     end — pinned via the effect's data hook + a stubbed scroll geometry,
 *     since happy-dom reports 0/0);
 *   · the sparse-tick law through the SHARED sparseTickIndices (ONE
 *     spelling of the 4-tick idiom this chart invented) + the range slices
 *     stay DAILY (no hourly mode on the mix — the hour law is the activity
 *     chart's).
 *
 *  Geometry facts the pins ride on: the default 30-day range at 14px bars +
 *  5px gaps (19px pitch) → a 565px chart + the 36px Y_AXIS = a 601px svg;
 *  bar centers at 36 + i×19 + 7; the w-52 tooltip is 208px; the clamp inset
 *  is 8px (mid i=14 centers at 309; last i=29 clamps to 385 =
 *  601 − 208 − 8; first clamps to 8). */

const SVG_WIDTH = 601; // Y_AXIS 36 + the 565px chart at the 30-day range
const TOOLTIP_W = 208; // the tooltip card's w-52 class
const TOOLTIP_INSET = 8; // clampTooltipX's TOOLTIP_EDGE_INSET_PX

const styles = deriveThemeStyles("nova", true);

// Vitest globals are off, so RTL's auto-cleanup does not hook in — do it by hand.
afterEach(cleanup);

const MODELS: UsageStatsModel[] = [
  {
    model: "z-ai/glm-5.2:free",
    inputTokens: 2_000,
    outputTokens: 1_000,
    tokens: 3_000,
    costUsd: 1,
    calls: 20,
    requests: 18,
    providers: ["z-ai"],
  },
  {
    model: "openai/gpt-4o",
    inputTokens: 1_000,
    outputTokens: 500,
    tokens: 1_500,
    costUsd: 2,
    calls: 10,
    requests: 9,
    providers: ["openai"],
  },
];

function makeDays(count = 30): UsageStatsDayBucket[] {
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-05-${String(1 + i).padStart(2, "0")}`,
    byModel: { "z-ai/glm-5.2:free": 100, "openai/gpt-4o": 50 },
  }));
}

function renderChart(days = makeDays()) {
  return render(<ModelStackChart days={days} models={MODELS} styles={styles} />);
}

/** The hover tooltip's positioning wrapper — the ONE pointer-events-none div
 *  in the chart (the painted segments are SVG rects, not divs). */
function tooltipEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>("div.pointer-events-none");
}

describe("ModelStackChart (R127-W2 chart-interaction laws)", () => {
  it("full-column hit-testing: the painted stacked segments are display-only — the transparent data-bar-idx column owns the hit", () => {
    renderChart();

    const svg = document.querySelector('svg[role="img"]');
    expect(svg).not.toBeNull();
    const columns = svg!.querySelectorAll("rect[data-bar-idx]");
    expect(columns).toHaveLength(30);
    // THE FULL-COLUMN LAW: every PAINTED segment renders pointer-events:none
    // (display-only — hovering a colored segment's BODY resolves through the
    // transparent column underneath), and none of them carries a
    // data-bar-idx of its own — the ONE hit surface per bar is the column
    // (the owner's "hover only works at the top area" complaint, named on
    // this chart).
    const painted = svg!.querySelectorAll("rect[data-stack-model]");
    expect(painted).toHaveLength(60); // 2 models × 30 days
    for (const seg of Array.from(painted)) {
      expect((seg as SVGElement).style.pointerEvents).toBe("none");
      expect(seg.hasAttribute("data-bar-idx")).toBe(false);
    }
    // The column spans the FULL plot height from y=0 (150px).
    for (const column of Array.from(columns)) {
      expect(column.getAttribute("height")).toBe("150");
      expect(column.getAttribute("y")).toBe("0");
    }
  });

  it("tooltip edge law: centers mid-series, clamps inside the svg at the first/last bars (the right-side-entry complaint)", () => {
    renderChart();
    const columns = document.querySelectorAll<SVGElement>("svg rect[data-bar-idx]");

    // Middle bar (i=14, center x=309): the tooltip CENTERS on its bar.
    fireEvent.pointerMove(columns[14]);
    let tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("309px");
    expect(screen.getByText(utcDateLabel("2026-05-15"))).toBeTruthy();
    // The day's stacked total (scoped to the tooltip — the y-axis band also
    // labels the 150 max).
    expect(within(tip!).getByText("150")).toBeTruthy();

    // LAST bar (i=29, center x=594): a centered 208px tooltip would overflow
    // the 601px svg's right edge — the clamp aligns its near edge inside
    // (601 − 208 − 8 = 385; 385 + 208 = 593 = the content box's edge). This
    // is the owner's "very right side entry… no place to view them" case.
    fireEvent.pointerMove(columns[29]);
    tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("385px");
    expect(Number.parseFloat(tip!.style.left) + TOOLTIP_W).toBeLessThanOrEqual(
      SVG_WIDTH - TOOLTIP_INSET,
    );

    // FIRST bar (i=0, center x=43): the mirror clamp at the 8px inset.
    fireEvent.pointerMove(columns[0]);
    tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("8px");
  });

  it("hovering a segment's BODY resolves through the column — the tooltip reads the hovered day's models", async () => {
    renderChart();
    const columns = document.querySelectorAll<SVGElement>("svg rect[data-bar-idx]");

    // The pointer lands on the COLUMN (the painted segment above it is
    // pointer-events:none — the DOM hit-test fall-through is the browser
    // pass's half; the behavioral read through the column is this pin).
    fireEvent.pointerMove(columns[21]);
    const tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(within(tip!).getByText("z-ai/glm-5.2:free")).toBeTruthy();
    expect(within(tip!).getByText("openai/gpt-4o")).toBeTruthy();
    expect(within(tip!).getByText("2 models")).toBeTruthy();

    // Leaving the bars clears the tooltip (the R121-d single pointer read —
    // no per-segment hover pair anywhere).
    const container = columns[0].closest("div")!;
    fireEvent.pointerMove(container);
    await waitFor(() => expect(screen.queryByText("2 models")).toBeNull());
  });

  it("the sparse 4-tick idiom reads the SHARED sparseTickIndices (ONE spelling)", () => {
    renderChart();
    const svg = document.querySelector('svg[role="img"]')!;
    const ticks = sparseTickIndices(30, 4);
    expect(ticks).toEqual([0, 10, 19, 29]);

    const labels = svg.querySelectorAll("text");
    // The x-axis band is the y-axis pair + exactly the 4 sparse ticks.
    expect(labels.length).toBe(4 + 2); // + the two y-axis value labels
    for (const tick of ticks) {
      expect(screen.getByText(utcDateLabel(`2026-05-${String(1 + tick).padStart(2, "0")}`))).toBeTruthy();
    }
  });

  it("the range slices stay DAILY — no hourly mode on the mix (the hour law is the activity chart's)", async () => {
    renderChart();
    expect(screen.getByText("Model Mix · 30 days")).toBeTruthy();

    // A range swap re-slices the tail (7 fat 24px bars) — never an hourly
    // suffix on this chart's header.
    fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
    expect(await screen.findByText("Model Mix · 7 days")).toBeTruthy();
    expect(screen.queryByText(/hourly/)).toBeNull();
  });

  it("the newest-end law: the overflow scroller mounts at the newest end + re-lands on every range swap", () => {
    // The mount pass: the ready chart's overflow-x-auto scroller carries the
    // effect's data hook (happy-dom reports 0/0 scroll geometry — the pin
    // reads the hook, then drives the effect's CONTRACT through a stubbed
    // element on the range swap).
    renderChart();
    const scroller = document.querySelector<HTMLElement>("[data-scrolled-to-latest]");
    expect(scroller).not.toBeNull();
    expect(scroller!.className).toContain("overflow-x-auto");

    // The swap pass: stub the scroller's geometry, swap the range 30→90 —
    // the effect re-runs and lands the scroll at the newest end (the
    // owner's "same goes for the other areas" report).
    let assigned = -1;
    Object.defineProperty(scroller, "scrollWidth", { configurable: true, get: () => 1_459 });
    Object.defineProperty(scroller, "scrollLeft", {
      configurable: true,
      get: () => 0,
      set: (v: number) => {
        assigned = v;
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Last 90 days" }));
    expect(assigned).toBe(1_459);
  });
});
