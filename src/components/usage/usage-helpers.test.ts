/**
 * ROUND-127 (the chart-interaction laws — COMPONENTS §6): the shared
 * helpers' pins. The owner's complaints as pure laws:
 *   · the tooltip edge law — a tooltip NEVER overflows the chart's content
 *     box (the "details show where there is no place to view them" report);
 *   · the hour laws — hour buckets label through the DEDICATED branches and
 *     never reach the day-label helpers (the Invalid-Date trap);
 *   · the sparse-tick law — dense series thin to ≤maxTicks even ticks.
 *
 * ROUND-128 (R128-W2 — the amended laws): the side-placement law
 * (placeTooltipBeside) + the fill law (stretchDayBarGeometry). The R127
 * clampTooltipX pins STAY (the helper is back-compat-exported and its inset
 * law survives inside placeTooltipBeside); the new describe blocks pin the
 * amended behaviors.
 */
import { describe, expect, it } from "vitest";
import {
  DAY_FILL_MAX_BAR_PX,
  DAY_FILL_MAX_GAP_PX,
  TOOLTIP_EDGE_INSET_PX,
  clampTooltipX,
  hourBucketDay,
  hourBucketLabel,
  hourTickLabel,
  isHourBucket,
  placeTooltipBeside,
  sparseTickIndices,
  stretchDayBarGeometry,
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

describe("R128 placeTooltipBeside — the side-placement law", () => {
  const W = 640;
  const TIP = 208; // the w-52 tooltip
  const GAP = 8; // the helper's default beside-gap

  it("a LEFT-half column places the tooltip to its RIGHT, one gap away (never centered on the bar)", () => {
    // Column [40, 60], center 50 < 320 → side right: left = 60 + 8 = 68.
    const r = placeTooltipBeside(40, 20, W, TIP);
    expect(r.side).toBe("right");
    expect(r.left).toBe(60 + GAP);
    // Beside, not centered: the tooltip's left edge sits past the column's
    // right edge (the retired R127 centering would have put it at 50).
    expect(r.left).toBeGreaterThanOrEqual(60);
  });

  it("a RIGHT-half column places the tooltip to its LEFT, one gap away", () => {
    // Column [400, 420], center 410 ≥ 320 → side left: left = 400 − 208 − 8 = 184.
    const r = placeTooltipBeside(400, 20, W, TIP);
    expect(r.side).toBe("left");
    expect(r.left).toBe(400 - TIP - GAP);
    // The tooltip's right edge stops one gap short of the column.
    expect(r.left + TIP).toBeLessThanOrEqual(400 - GAP);
  });

  it("a mid-plot column never overlaps — the placement keeps a full gap of daylight on its side", () => {
    // Column [300, 320], center 310 < 320 → right: left = 328 (no clamp).
    const r = placeTooltipBeside(300, 20, W, TIP);
    expect(r).toEqual({ left: 328, side: "right" });
    expect(r.left).toBeGreaterThanOrEqual(320 + GAP);
  });

  it("edge clamping: a column whose right side leaves no room clamps to the plot's right inset (never overflows)", () => {
    // Column [210, 424] (a wide column in the left half): ideal 432 exceeds
    // maxLeft 640 − 208 − 8 = 424 → clamped to 424; the tooltip's right edge
    // lands exactly at the content box's inset edge.
    const r = placeTooltipBeside(210, 214, W, TIP);
    expect(r.side).toBe("right");
    expect(r.left).toBe(W - TIP - TOOLTIP_EDGE_INSET_PX);
    expect(r.left + TIP + TOOLTIP_EDGE_INSET_PX).toBeLessThanOrEqual(W);
  });

  it("overlap-avoidance flip: a clamped placement that would cover the column re-clamps to the roomier side's edge", () => {
    // Plot 460, tooltip 208 — column [100, 260]: side right (center 180 <
    // 230), ideal 268 clamps to maxLeft 244, which still overlaps the column.
    // Room right = 192 vs room left = 92 → the right side wins and clamps to
    // its edge: left = min(268, 244) = 244. (Both sides overlap here — the
    // plot is too narrow to host the tooltip beside this column at all; the
    // flip's job is the least-bad clamp, exactly per the law's letter.)
    const r = placeTooltipBeside(100, 160, 460, TIP);
    expect(r.side).toBe("right");
    expect(r.left).toBe(244);
  });

  it("overlap-avoidance flip can CHANGE the side when the rooms tie (the boundary column)", () => {
    // Plot 460, column [210, 250]: center 230 ≥ 230 → side LEFT, but the
    // ideal (−6) clamps to 8 and overlaps the column. Rooms tie at 202/202 →
    // the right side wins the tie and clamps to its edge (244).
    const r = placeTooltipBeside(210, 40, 460, TIP);
    expect(r.side).toBe("right");
    expect(r.left).toBe(244);
  });

  it("degenerate narrow plot: a tooltip wider than the usable plot parks at the inset, side unchanged", () => {
    // Plot 200: 208 ≥ 200 − 2×8 → degenerate. Column [90, 100], center 95 <
    // 100 → side stays "right".
    const r = placeTooltipBeside(90, 10, 200, TIP);
    expect(r.left).toBe(TOOLTIP_EDGE_INSET_PX);
    expect(r.side).toBe("right");
  });

  it("the side never overlaps the column when either side has room — a property sweep (the R127 law's real guarantee)", () => {
    // For a 20px column anywhere in a 640px plot with a 208px tooltip, the
    // placement is overlap-free whenever a beside fit exists at all (the
    // side-by-center choice picks the fitting side; overlap after clamping
    // is the too-narrow-plot case, where NO placement could avoid it).
    for (let colLeft = 8; colLeft <= W - 28; colLeft += 4) {
      const r = placeTooltipBeside(colLeft, 20, W, TIP);
      const overlaps = r.left < colLeft + 20 && r.left + TIP > colLeft;
      const leftSideCouldFit = colLeft >= TOOLTIP_EDGE_INSET_PX + TIP + GAP;
      const rightSideCouldFit = colLeft + 20 + GAP + TIP + TOOLTIP_EDGE_INSET_PX <= W;
      if (leftSideCouldFit || rightSideCouldFit) {
        expect(overlaps).toBe(false);
      }
      // Either way the tooltip stays inside the content box's inset.
      expect(r.left).toBeGreaterThanOrEqual(TOOLTIP_EDGE_INSET_PX);
      expect(r.left + TIP).toBeLessThanOrEqual(W - TOOLTIP_EDGE_INSET_PX);
    }
  });
});

describe("R128 stretchDayBarGeometry — the fill law", () => {
  it("an unmeasured container (0) keeps the natural pitch — the pre-observer frame never shrinks or grows", () => {
    expect(stretchDayBarGeometry(10, 20, 6, 0)).toEqual({ barWidth: 20, barGap: 6 });
  });

  it("a degenerate count keeps the natural pitch (never a negative-width stretch)", () => {
    expect(stretchDayBarGeometry(0, 20, 6, 900)).toEqual({ barWidth: 20, barGap: 6 });
  });

  it("an OVERFLOWING container keeps the natural pitch (the newest-end law owns that case)", () => {
    // 10 day buckets natural = 254px; a 200px scroller overflows → natural.
    expect(stretchDayBarGeometry(10, 20, 6, 200)).toEqual({ barWidth: 20, barGap: 6 });
  });

  it("a fitting container stretches the pitch to FILL it exactly (both width and gap scale by the same factor)", () => {
    // 254px natural into a 508px scroller → factor 2.0 → 40px bars / 12px
    // gaps; the recomputed chart width is exactly the measured 508.
    const r = stretchDayBarGeometry(10, 20, 6, 508);
    expect(r).toEqual({ barWidth: 40, barGap: 12 });
    expect(10 * (r.barWidth + r.barGap) - r.barGap).toBe(508);
  });

  it("the stretch is CAPPED: bars never exceed 42px and gaps never exceed 16px however wide the card", () => {
    // A 1000px scroller wants factor 3.94; the cap is min(42/20, 16/6) = 2.1.
    const r = stretchDayBarGeometry(10, 20, 6, 1000);
    expect(r.barWidth).toBe(DAY_FILL_MAX_BAR_PX);
    expect(r.barGap).toBeCloseTo(12.6, 10);
    expect(r.barWidth).toBeLessThanOrEqual(DAY_FILL_MAX_BAR_PX);
    expect(r.barGap).toBeLessThanOrEqual(DAY_FILL_MAX_GAP_PX);
  });
});
