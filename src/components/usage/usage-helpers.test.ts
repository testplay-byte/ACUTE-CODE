/**
 * ROUND-127 (the chart-interaction laws — COMPONENTS §6): the shared
 * helpers' pins. The owner's complaints as pure laws:
 *   · the tooltip edge law — a tooltip NEVER overflows the chart's content
 *     box (the "details show where there is no place to view them" report);
 *   · the hour laws — hour buckets label through the DEDICATED branches and
 *     never reach the day-label helpers (the Invalid-Date trap);
 *   · the sparse-tick law — dense series thin to ≤maxTicks even ticks.
 */
import { describe, expect, it } from "vitest";
import {
  TOOLTIP_EDGE_INSET_PX,
  clampTooltipX,
  hourBucketDay,
  hourBucketLabel,
  hourTickLabel,
  isHourBucket,
  sparseTickIndices,
} from "./usage-helpers";

describe("R127 clampTooltipX — the tooltip edge law", () => {
  const W = 640;
  const TIP = 208; // the w-52 tooltip

  it("a bar near the CENTER keeps its centered placement (no clamp)", () => {
    const r = clampTooltipX(W / 2, W, TIP);
    expect(r.clamped).toBe(false);
    expect(r.left).toBe(W / 2);
  });

  it("a bar at the FAR LEFT clamps the tooltip's left edge to the inset", () => {
    const r = clampTooltipX(40, W, TIP);
    expect(r.clamped).toBe(true);
    expect(r.left).toBe(TOOLTIP_EDGE_INSET_PX);
  });

  it("a bar at the FAR RIGHT clamps so the tooltip's RIGHT edge stays inside (the owner's exact complaint)", () => {
    const r = clampTooltipX(W - 40, W, TIP);
    expect(r.clamped).toBe(true);
    // left + width + inset ≤ container
    expect(r.left + TIP + TOOLTIP_EDGE_INSET_PX).toBeLessThanOrEqual(W);
    expect(r.left).toBe(W - TIP - TOOLTIP_EDGE_INSET_PX);
  });

  it("a tooltip WIDER than the container degenerates to the min inset (never negative)", () => {
    const r = clampTooltipX(40, 120, 208);
    expect(r.clamped).toBe(true);
    expect(r.left).toBe(TOOLTIP_EDGE_INSET_PX);
  });
});

describe("R127 hour-bucket labels — the dedicated branches", () => {
  it("isHourBucket recognizes the 13-char hour key and rejects day keys", () => {
    expect(isHourBucket("2025-06-15T14")).toBe(true);
    expect(isHourBucket("2025-06-15")).toBe(false);
    expect(isHourBucket("2025-06-15T14:32:07.123Z")).toBe(false);
  });

  it("hourBucketLabel renders 'Mon DD · HH:00' with the UTC month abbreviation", () => {
    expect(hourBucketLabel("2025-06-15T14")).toBe("Jun 15 · 14:00");
    expect(hourBucketLabel("2025-01-03T00")).toBe("Jan 3 · 00:00");
  });

  it("hourTickLabel renders the 'HH:00' tick; garbage passes through unchanged", () => {
    expect(hourTickLabel("2025-06-15T14")).toBe("14:00");
    expect(hourTickLabel("nope")).toBe("nope");
  });

  it("hourBucketDay slices the day prefix (the day-boundary divider key)", () => {
    expect(hourBucketDay("2025-06-15T14")).toBe("2025-06-15");
  });
});

describe("R127 sparseTickIndices — the dense-series law", () => {
  it("count ≤ maxTicks returns every index", () => {
    expect(sparseTickIndices(3, 4)).toEqual([0, 1, 2]);
  });

  it("count > maxTicks thins to the even spread (first, ~⅓, ~⅔, last at 4 — the ModelStackChart idiom)", () => {
    expect(sparseTickIndices(7, 4)).toEqual([0, 2, 4, 6]);
    expect(sparseTickIndices(90, 4)).toEqual([0, 30, 59, 89]);
  });

  it("168 hourly buckets thin to 6 ticks including both ends", () => {
    const ticks = sparseTickIndices(168, 6);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(167);
    expect(ticks.length).toBeLessThanOrEqual(6);
    // strictly increasing (the Set dedupe never collapses the spread)
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
    }
  });

  it("zero buckets → no ticks; degenerate maxTicks=1 → just the first", () => {
    expect(sparseTickIndices(0, 4)).toEqual([]);
    expect(sparseTickIndices(50, 1)).toEqual([0]);
  });
});
