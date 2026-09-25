// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ModelStackChart } from "./ModelStackChart";
import { deriveThemeStyles } from "../../lib/themes";
import { utcDateLabel } from "../dashboard/helpers";
import { sparseTickIndices, STAGGER_CAP_S } from "./usage-helpers";
import type { UsageStatsDayBucket, UsageStatsModel } from "../../lib/api";

/** R127-W2 → R128-W2 — the chart-interaction laws (COMPONENTS §6) pinned at
 *  the MODEL MIX stacked chart (both owner complaints were named on this
 *  chart: the body-hover miss + the right-edge tooltip overflow):
 *   · the full-column hit-testing law (painted stacked segments
 *     display-only — R127, kept);
 *   · the side-placement tooltip law (R128 — the R127 center-on-bar pins
 *     are RE-PINNED to the beside values);
 *   · the newest-end law (R128: useLayoutEffect + the DATA-IDENTITY key —
 *     the months-window swap with an identical visible tail re-lands too);
 *   · the stagger cap (R128: min(i × 12ms, 0.4s) — data-entry-delay is the
 *     observable hook);
 *   · the fill law (R128: a fitting chart bumps to the widest geometry
 *     tier that still fits the measured scroller);
 *   · the sparse-tick law through the SHARED sparseTickIndices + the range
 *     slices stay DAILY (no hourly mode on the mix).
 *
 *  Geometry facts the pins ride on (the UNSTRETCHED natural tier — happy-dom
 *  reports clientWidth 0, so the un-measured frame keeps the natural
 *  geometry; the fill-law tests stub the ResizeObserver): the default
 *  30-day range at 14px bars + 5px gaps (19px pitch) → a 565px chart + the
 *  36px Y_AXIS = a 601px svg; columns at [36+i×19, 36+i×19+14]; the w-52
 *  tooltip is 208px; the inset is 8px, the beside-gap 8px → i=0 (left half)
 *  → side right at 50+8 = 58px; i=14 (right half) → side left at
 *  302−216 = 86px; i=29 (right half) → side left at 587−216 = 371px. */

const SVG_WIDTH = 601; // Y_AXIS 36 + the 565px chart at the 30-day range (natural)
const TOOLTIP_W = 208; // the tooltip card's w-52 class
const TOOLTIP_INSET = 8; // placeTooltipBeside's TOOLTIP_EDGE_INSET_PX
const BESIDE_GAP = 8; // placeTooltipBeside's default gap
const Y_AXIS = 36; // the svg's y-axis band width
const DAY_PITCH = 19; // 14px bar + 5px gap (the natural 30-day tier)

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

/** 90+ consecutive UTC day buckets from 2026-02-01 (multi-month, every
 *  date valid — makeDays' single-March template only covers 30). */
function makeLongDays(count = 90): UsageStatsDayBucket[] {
  const start = Date.UTC(2026, 1, 1);
  return Array.from({ length: count }, (_, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
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

  it("R128 side-placement law: the tooltip renders BESIDE the hovered column — no -50% centering, no overlap (the right-side-entry complaint)", () => {
    renderChart();
    const columns = document.querySelectorAll<SVGElement>("svg rect[data-bar-idx]");

    // Middle bar (i=14, column [302, 316], center 309 in the right half): the
    // tooltip sits to the column's LEFT — left = 302 − 208 − 8 = 86px; its
    // right edge (294) stops a full gap short of the column's left edge
    // (302). The transform carries NO -50% translation (the retired R127
    // center-on-bar spelling — the owner's exact complaint on this chart).
    fireEvent.pointerMove(columns[14]);
    let tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("86px");
    expect(tip!.style.transform).not.toContain("-50%");
    expect(screen.getByText(utcDateLabel("2026-05-15"))).toBeTruthy();
    // The day's stacked total (scoped to the tooltip — the y-axis band also
    // labels the 150 max).
    expect(within(tip!).getByText("150")).toBeTruthy();

    // LAST bar (i=29, column [587, 601], right half): side left — left =
    // 587 − 216 = 371px; its right edge (579) stops a full gap short of the
    // column's left edge (587). This is the owner's "very right side entry…
    // no place to view them" case: the tooltip is INSIDE the svg's content
    // box AND beside the bar, never centered over it.
    fireEvent.pointerMove(columns[29]);
    tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("371px");
    expect(tip!.style.transform).not.toContain("-50%");
    expect(Number.parseFloat(tip!.style.left) + TOOLTIP_W).toBeLessThanOrEqual(
      SVG_WIDTH - TOOLTIP_INSET,
    );
    expect(Number.parseFloat(tip!.style.left) + TOOLTIP_W).toBeLessThanOrEqual(
      Y_AXIS + 29 * DAY_PITCH - BESIDE_GAP,
    );

    // FIRST bar (i=0, column [36, 50], left half): side right — left =
    // 50 + 8 = 58px, one beside-gap past the column's right edge.
    fireEvent.pointerMove(columns[0]);
    tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("58px");
    expect(tip!.style.transform).not.toContain("-50%");
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

  it("R128 months-swap re-land: a LONGER series with the IDENTICAL visible tail re-lands at the newest end", () => {
    // R128: the R127 effect keyed on [range, visible.length] — the panel's
    // months picker (6/12/24) re-fetches a LONGER series while `range` (30)
    // and the visible tail stay byte-identical, so the old key never
    // re-ran. The data-identity key includes the FULL series' length +
    // first/last dates, so the 12→24-month shape re-lands.
    const { rerender } = renderChart();
    const scroller = document.querySelector<HTMLElement>("[data-scrolled-to-latest]");
    expect(scroller).not.toBeNull();

    let assigned = -1;
    Object.defineProperty(scroller, "scrollWidth", { configurable: true, get: () => SVG_WIDTH });
    Object.defineProperty(scroller, "scrollLeft", {
      configurable: true,
      get: () => 0,
      set: (v: number) => {
        assigned = v;
      },
    });
    // The 24-month shape: 30 April days PREPENDED to the same May series —
    // the visible tail (May 1–30 at range 30) is byte-identical, the full
    // series grew 30→60.
    const longer: UsageStatsDayBucket[] = [
      ...Array.from({ length: 30 }, (_, i) => ({
        date: `2026-04-${String(1 + i).padStart(2, "0")}`,
        byModel: { "z-ai/glm-5.2:free": 100, "openai/gpt-4o": 50 } as Record<string, number>,
      })),
      ...makeDays(),
    ];
    rerender(<ModelStackChart days={longer} models={MODELS} styles={styles} />);
    // The visible window itself is unchanged (same 30 May days)…
    expect(screen.getByText("Model Mix · 30 days")).toBeTruthy();
    // …but the series identity changed, so the newest-end law re-landed.
    expect(assigned).toBe(SVG_WIDTH);
  });

  it("R128 stagger cap: the LAST bar's entrance delay never exceeds 0.4s (data-entry-delay is the observable hook)", async () => {
    // 90 real days of series: the default 30-day range slices the tail; the
    // 90-day range click widens the visible window to the full 90.
    render(<ModelStackChart days={makeLongDays(90)} models={MODELS} styles={styles} />);
    // At the 30-day range the last bar (i=29) is uncapped: 29 × 12ms = 0.348.
    let segments = document.querySelectorAll<SVGElement>("rect[data-entry-delay]");
    expect(segments.length).toBe(60); // 2 models × 30 days
    expect(segments[0]!.getAttribute("data-entry-delay")).toBe("0.000");
    expect(segments[segments.length - 1]!.getAttribute("data-entry-delay")).toBe("0.348");

    // At the 90-day range the uncapped delay would be 89 × 12ms = 1.068s —
    // the 4.38s-at-365 sweep the owner read as "starts from the oldest
    // month"; the cap holds the tail at STAGGER_CAP_S (0.400).
    fireEvent.click(screen.getByRole("button", { name: "Last 90 days" }));
    await screen.findByText("Model Mix · 90 days");
    segments = document.querySelectorAll<SVGElement>("rect[data-entry-delay]");
    const lastDelay = Number.parseFloat(
      segments[segments.length - 1]!.getAttribute("data-entry-delay") ?? "0",
    );
    expect(lastDelay).toBe(STAGGER_CAP_S);
    expect(lastDelay).toBeLessThanOrEqual(0.4);
    // Every bar's delay respects the cap.
    for (const seg of Array.from(segments)) {
      expect(Number.parseFloat(seg.getAttribute("data-entry-delay") ?? "0")).toBeLessThanOrEqual(
        STAGGER_CAP_S,
      );
    }
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

describe("ModelStackChart (R128-W2 — the fill law, the width-based tier leg)", () => {
  beforeEach(() => {
    MockResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("a fitting chart bumps to the widest geometry tier that still fits (30 days → 24px bars in a wide card)", () => {
    renderChart();
    // A 1100px scroller: the natural {14,5} tier (601px svg) fits with dead
    // space, and the widest {24,8} tier needs 36 + 30×32 − 8 = 988 ≤ 1100 —
    // the fill law bumps the tier (the dead margins die).
    act(() => MockResizeObserver.fire(1100));
    const svg = document.querySelector('svg[role="img"]');
    expect(svg!.getAttribute("width")).toBe("988");
    for (const column of Array.from(svg!.querySelectorAll("rect[data-bar-idx]"))) {
      expect(column.getAttribute("width")).toBe("24");
    }
  });

  it("a scroller too narrow for the next tier keeps the natural tier (still centered, never overflowing)", () => {
    renderChart();
    // A 700px scroller: {24,8} needs 988 > 700 — no bump; the natural
    // {14,5} tier's 601px chart stays (mx-auto centered, no overflow).
    act(() => MockResizeObserver.fire(700));
    const svg = document.querySelector('svg[role="img"]');
    expect(svg!.getAttribute("width")).toBe(String(SVG_WIDTH));
    for (const column of Array.from(svg!.querySelectorAll("rect[data-bar-idx]"))) {
      expect(column.getAttribute("width")).toBe("14");
    }
  });

  it("an OVERFLOWING scroller keeps the natural tier (the fill law never shrinks — the newest-end law owns it)", () => {
    renderChart();
    // A 400px scroller: the natural 601px svg overflows → natural tier.
    act(() => MockResizeObserver.fire(400));
    const svg = document.querySelector('svg[role="img"]');
    expect(svg!.getAttribute("width")).toBe(String(SVG_WIDTH));
    for (const column of Array.from(svg!.querySelectorAll("rect[data-bar-idx]"))) {
      expect(column.getAttribute("width")).toBe("14");
    }
  });

  it("the fill law respects the tier LADDER at the 90-day window too (7px bars stay 7px unless {14,5} fits)", async () => {
    render(<ModelStackChart days={makeLongDays(90)} models={MODELS} styles={styles} />);
    fireEvent.click(screen.getByRole("button", { name: "Last 90 days" }));
    await screen.findByText("Model Mix · 90 days");
    // The 90-day window's natural tier is {7,2} → 36 + 90×9 − 2 = 848px.
    // A 2000px scroller fits the {14,5} tier (36 + 90×19 − 5 = 1741) — bump;
    // the {24,8} tier (36 + 90×32 − 8 = 2908) does not.
    act(() => MockResizeObserver.fire(2000));
    const svg = document.querySelector('svg[role="img"]');
    expect(svg!.getAttribute("width")).toBe("1741");
    for (const column of Array.from(svg!.querySelectorAll("rect[data-bar-idx]"))) {
      expect(column.getAttribute("width")).toBe("14");
    }
  });
});
