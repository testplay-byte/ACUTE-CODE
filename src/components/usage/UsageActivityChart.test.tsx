// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UsageActivityChart } from "./UsageActivityChart";
import { deriveThemeStyles } from "../../lib/themes";
import { utcDateLabel } from "../dashboard/helpers";
import type { UsageDayBucket } from "../../lib/api";

/** R127-W2 → R128-W2 — the chart-interaction laws (COMPONENTS §6) pinned at
 *  the usage screen's own activity chart, plus the HOURLY VIEW contract
 *  (the owner's "seven days… a much better kind of view, like hourly based"
 *  ask):
 *   · the full-column hit-testing law (painted bars display-only — R127, kept);
 *   · the side-placement tooltip law (R128 — the R127 center-on-bar pins are
 *     RE-PINNED to the beside values);
 *   · the hour mode (6px geometry, sparse "HH:00" ticks + day-boundary
 *     labels, hour tooltip headers, the aria/kicker copy);
 *   · the newest-end law (R128: useLayoutEffect + the DATA-IDENTITY key — a
 *     same-length window swap re-lands too);
 *   · the fill law (R128: a fitting day view stretches to the measured
 *     scroller; hour geometry stays fixed).
 *
 *  Geometry facts the pins ride on (the UNSTRETCHED natural pitch — happy-dom
 *  reports clientWidth 0, so the un-measured frame keeps the natural
 *  geometry; the fill-law tests stub the ResizeObserver): DAY mode = 20px
 *  bars + 6px gaps (26px pitch); 10 buckets → a 254px chart, columns at
 *  [i×26, i×26+20], the w-44 tooltip is 176px, the inset is 8px, the
 *  beside-gap is 8px → i=0 → side right at 28px; i=4 (center 114 < 127 →
 *  right, ideal 132 clamps to maxLeft 70 — a 254px plot cannot host 176px
 *  beside a column at 104, the near-degenerate case) = 70px; i=9 (right
 *  half) → side left at 234−184 = 50px. HOUR mode = 6px bars + 2px gaps
 *  (8px pitch); 168 buckets (7×24) → a 1342px chart, columns at [i×8, i×8+6]
 *  → i=84 (right half) → side left at 672−184 = 488px; i=167 → side left at
 *  1336−184 = 1152px; i=0 → side right at 6+8 = 14px.
 *
 *  The real-browser half of the hit-testing law (the pointer falling through
 *  a pointer-events:none painted bar onto the column UNDERNEATH) is DOM
 *  hit-testing the happy-dom env cannot synthesize — the pins below assert
 *  the law's spelling (the painted rects are display-only and carry no bar
 *  index; the column owns the hit and spans the full plot height) + the
 *  behavioral reads through the column rects. The live pointer pass is the
 *  orchestrator's consolidated post-wave browser sweep. */

const DAY_PITCH = 26; // DAY_BAR_WIDTH 20 + DAY_BAR_GAP 6 (the natural pitch)
const DAY_CHART_WIDTH = 10 * DAY_PITCH - 6; // 254 (natural)
const HOUR_PITCH = 8; // HOUR_BAR_WIDTH 6 + HOUR_BAR_GAP 2
const HOUR_CHART_WIDTH = 168 * HOUR_PITCH - 2; // 1342
const TOOLTIP_W = 176; // the tooltip card's w-44 class
const TOOLTIP_INSET = 8; // placeTooltipBeside's TOOLTIP_EDGE_INSET_PX
const BESIDE_GAP = 8; // placeTooltipBeside's default gap

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

  it("R128 side-placement law: the tooltip renders BESIDE the hovered column — no -50% centering, no overlap at the ends", () => {
    render(
      <UsageActivityChart days={makeDays()} dayCount={10} isPending={false} isError={false} styles={styles} />,
    );
    const columns = document.querySelectorAll<SVGElement>("svg rect[data-bar-idx]");

    // FIRST bar (i=0, column [0, 20], left half): the tooltip sits to the
    // column's RIGHT — left = 20 + 8 = 28px. The transform carries NO -50%
    // translation (the retired R127 center-on-bar spelling is gone).
    fireEvent.pointerMove(columns[0]);
    let tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("28px");
    expect(tip!.style.transform).not.toContain("-50%");
    expect(screen.getByText("1,500")).toBeTruthy();

    // LAST bar (i=9, column [234, 254], right half): the tooltip sits to
    // the column's LEFT — left = 234 − 176 − 8 = 50px; its right edge (226)
    // stops a full gap short of the column's left edge (234) — BESIDE the
    // bar, never covering it.
    fireEvent.pointerMove(columns[9]);
    tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("50px");
    expect(tip!.style.transform).not.toContain("-50%");
    expect(Number.parseFloat(tip!.style.left) + TOOLTIP_W).toBeLessThanOrEqual(
      9 * DAY_PITCH - BESIDE_GAP,
    );
    expect(screen.getByText("10,500")).toBeTruthy();

    // MIDDLE bar (i=4, column [104, 124], center 114 in the left half): side
    // right, ideal 132 clamps to maxLeft 70 (254 − 176 − 8). A 254px plot
    // cannot host the 176px tooltip beside a column at 104 on either side —
    // the near-degenerate case; placeTooltipBeside's overlap net keeps the
    // roomier right side and clamps to its edge (70). Inside the inset.
    fireEvent.pointerMove(columns[4]);
    tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("70px");
    expect(Number.parseFloat(tip!.style.left) + TOOLTIP_W).toBeLessThanOrEqual(
      DAY_CHART_WIDTH - TOOLTIP_INSET,
    );
    expect(screen.getByText("5,500")).toBeTruthy(); // 5k in + 0.5k out
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

  it("the hour tooltip: header reads hourBucketLabel ('Mon DD · HH:00') + the side placement", () => {
    renderHourChart();
    const columns = document.querySelectorAll<SVGElement>("svg rect[data-bar-idx]");

    // Middle bucket (i=84, column [672, 678], center 675 in the right half):
    // the tooltip sits to the bucket's LEFT — left = 672 − 176 − 8 = 488px,
    // no -50% centering.
    fireEvent.pointerMove(columns[84]);
    let tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("488px");
    expect(tip!.style.transform).not.toContain("-50%");
    expect(screen.getByText("Aug 19 · 12:00")).toBeTruthy(); // hourBucketLabel
    expect(screen.getByText("150")).toBeTruthy(); // 100 in + 50 out

    // LAST bucket (i=167, column [1336, 1342], right half): side left —
    // left = 1336 − 184 = 1152px; its right edge (1328) stops a full gap
    // short of the bucket's left edge (1336).
    fireEvent.pointerMove(columns[167]);
    tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("1152px");
    expect(tip!.style.transform).not.toContain("-50%");
    expect(Number.parseFloat(tip!.style.left) + TOOLTIP_W).toBeLessThanOrEqual(
      HOUR_CHART_WIDTH - TOOLTIP_INSET,
    );
    expect(Number.parseFloat(tip!.style.left) + TOOLTIP_W).toBeLessThanOrEqual(
      167 * HOUR_PITCH - BESIDE_GAP,
    );
    expect(screen.getByText("Aug 22 · 23:00")).toBeTruthy();

    // FIRST bucket (i=0, column [0, 6], left half): side right — left =
    // 6 + 8 = 14px, one beside-gap past the bucket's right edge.
    fireEvent.pointerMove(columns[0]);
    tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("14px");
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

  it("R128 data-identity re-land: a SAME-LENGTH day-window swap re-lands at the newest end (the rolled-over window)", () => {
    // R128: the R127 effect keyed on days.length — a 10-bucket window whose
    // first/last dates changed (the day rolled over, or keepPreviousData
    // served the refetched window) did NOT re-run. The data-identity key
    // (granularity:length:first:last) must re-land it.
    const { rerender } = render(
      <UsageActivityChart days={makeDays()} dayCount={10} isPending={false} isError={false} styles={styles} />,
    );
    const scroller = document.querySelector<HTMLElement>("[data-scrolled-to-latest]");
    expect(scroller).not.toBeNull();

    let assigned = -1;
    Object.defineProperty(scroller, "scrollWidth", { configurable: true, get: () => DAY_CHART_WIDTH });
    Object.defineProperty(scroller, "scrollLeft", {
      configurable: true,
      get: () => 0,
      set: (v: number) => {
        assigned = v;
      },
    });
    // The same 10-bucket length, every date shifted one day forward —
    // identical geometry, DIFFERENT data identity.
    rerender(
      <UsageActivityChart
        days={makeDays().map((d) => ({ ...d, date: `2026-08-${String(10 + Number(d.date.slice(-2))).padStart(2, "0")}` }))}
        dayCount={10}
        isPending={false}
        isError={false}
        styles={styles}
      />,
    );
    expect(assigned).toBe(DAY_CHART_WIDTH);
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

describe("UsageActivityChart (R128-W2 — the fill law)", () => {
  beforeEach(() => {
    MockResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("a fitting DAY view stretches its pitch to FILL the measured scroller (no dead margins)", () => {
    render(
      <UsageActivityChart days={makeDays()} dayCount={10} isPending={false} isError={false} styles={styles} />,
    );
    // A 508px scroller: the natural 254px day chart doubles exactly — 40px
    // bars + 12px gaps (508 = 10 × 52 − 12).
    act(() => MockResizeObserver.fire(508));
    const svg = document.querySelector('svg[role="img"]');
    expect(svg!.getAttribute("width")).toBe("508");
    for (const column of Array.from(svg!.querySelectorAll("rect[data-bar-idx]"))) {
      expect(column.getAttribute("width")).toBe("40");
    }
  });

  it("the DAY stretch is CAPPED at 42px bars however wide the scroller", () => {
    render(
      <UsageActivityChart days={makeDays()} dayCount={10} isPending={false} isError={false} styles={styles} />,
    );
    // A 1000px scroller wants factor 3.94; the cap is min(42/20, 16/6) = 2.1
    // → 42px bars / 12.6px gaps → 10 × 54.6 − 12.6 = 533.4px of chart.
    act(() => MockResizeObserver.fire(1000));
    const svg = document.querySelector('svg[role="img"]');
    expect(svg!.getAttribute("width")).toBe("533.4");
    for (const column of Array.from(svg!.querySelectorAll("rect[data-bar-idx]"))) {
      expect(column.getAttribute("width")).toBe("42");
    }
  });

  it("an OVERFLOWING day window keeps the natural pitch (the fill law never shrinks)", () => {
    render(
      <UsageActivityChart days={makeDays()} dayCount={10} isPending={false} isError={false} styles={styles} />,
    );
    // A 200px scroller: the natural 254px chart overflows → natural geometry.
    act(() => MockResizeObserver.fire(200));
    const svg = document.querySelector('svg[role="img"]');
    expect(svg!.getAttribute("width")).toBe(String(DAY_CHART_WIDTH));
    for (const column of Array.from(svg!.querySelectorAll("rect[data-bar-idx]"))) {
      expect(column.getAttribute("width")).toBe("20");
    }
  });

  it("the HOUR geometry stays FIXED however wide the scroller (hour views always scroll)", () => {
    render(
      <UsageActivityChart
        days={makeHourDays()}
        dayCount={7}
        granularity="hour"
        isPending={false}
        isError={false}
        styles={styles}
      />,
    );
    act(() => MockResizeObserver.fire(1000));
    const svg = document.querySelector('svg[role="img"]');
    expect(svg!.getAttribute("width")).toBe(String(HOUR_CHART_WIDTH));
    for (const column of Array.from(svg!.querySelectorAll("rect[data-bar-idx]"))) {
      expect(column.getAttribute("width")).toBe("6");
    }
  });

  it("the stretched day view's tooltip still places BESIDE the (wider) hovered column", () => {
    render(
      <UsageActivityChart days={makeDays()} dayCount={10} isPending={false} isError={false} styles={styles} />,
    );
    act(() => MockResizeObserver.fire(508)); // 40px bars / 12px gaps
    const columns = document.querySelectorAll<SVGElement>("svg rect[data-bar-idx]");

    // LAST bar (i=9, column [468, 508], right half): side left — left =
    // 468 − 176 − 8 = 284px; its right edge (460) stops a full gap short of
    // the column's left edge (468).
    fireEvent.pointerMove(columns[9]);
    const tip = tooltipEl();
    expect(tip).not.toBeNull();
    expect(tip!.style.left).toBe("284px");
    expect(Number.parseFloat(tip!.style.left) + TOOLTIP_W).toBeLessThanOrEqual(
      9 * 52 - BESIDE_GAP,
    );
    expect(tip!.style.transform).not.toContain("-50%");
  });
});
