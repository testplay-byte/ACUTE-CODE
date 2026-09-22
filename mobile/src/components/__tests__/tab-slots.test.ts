/**
 * tab-slots.test.ts — the R118-B adaptive slot algorithm (spec-b §5.1), all
 * seven cases, pure arithmetic against tab-slots.ts (the extracted pure
 * module — the mobile suite's convention keeps react-native out of the jest
 * sandbox, so the algorithm lives beside the bar, not inside it).
 *
 * The geometry under test (360dp phone → barWidth 336): the selected slot
 * grows to its chip's natural width + the pill's 12dp breathing pair, the
 * neighbors rebalance to the equal split of what remains (capped at the
 * legacy barWidth/N), the pill centers inside the selected slot — the old
 * edge clamp (which capped the FIRST/LAST pill to ~1px off the edge and
 * starved "Approvals" to a 67dp slot) is unreachable by construction.
 */
import { describe, expect, it } from "@jest/globals";

import {
  computeTabSlots,
  LABEL_EPSILON,
  PILL_PAD_X,
  TAB_CHIP_GAP,
  TAB_ICON_SIZE,
  TAB_ICON_SIZE_ACTIVE,
  TAB_INSET_X,
} from "../tab-slots";

/** The five tab labels' measured widths on a 360dp phone (Manrope 11.5 bold,
 *  approximately) — only the ACTIVE tab's value matters to the algorithm. */
const LABELS = [36, 44, 62, 48, 38];

/** 360dp window − 2×BAR_MARGIN 12 — the spec's own worked barWidth. */
const BAR_360 = 336;
/** 320dp small phone. */
const BAR_320 = 296;
/** 411dp common phone. */
const BAR_411 = 387;

const FLOOR = TAB_ICON_SIZE_ACTIVE + PILL_PAD_X * 2;

describe("computeTabSlots — the R118-B adaptive slot algorithm", () => {
  it("case 1 — the selected slot arithmetic: chip + the pill's padding pair", () => {
    // Home selected, labelWidth 36: label 38, chip 23+6+38 = 67 → 67 + 24 = 91
    // (the spec's own worked number).
    const home = computeTabSlots({ barWidth: BAR_360, tabCount: 5, activeIndex: 0, labelWidths: LABELS });
    expect(home.slots[0]).toBe(91);
    expect(home.slots[0]).toBe(
      TAB_ICON_SIZE_ACTIVE + TAB_CHIP_GAP + (LABELS[0] ?? 0) + LABEL_EPSILON + PILL_PAD_X * 2,
    );
    // The pill wraps the chip at its natural width (no clamp binds here).
    expect(home.pillWidth).toBe(TAB_ICON_SIZE_ACTIVE + TAB_CHIP_GAP + 38 + PILL_PAD_X * 2);
    // Approvals selected, labelWidth 62: label 64 → chip 93 → slot 117.
    const approvals = computeTabSlots({
      barWidth: BAR_360,
      tabCount: 5,
      activeIndex: 2,
      labelWidths: LABELS,
    });
    expect(approvals.slots[2]).toBe(117);
  });

  it("case 2 — every unselected slot ≤ the legacy equal width (barWidth/N)", () => {
    for (const activeIndex of [0, 1, 2, 3, 4]) {
      const layout = computeTabSlots({
        barWidth: BAR_360,
        tabCount: 5,
        activeIndex,
        labelWidths: LABELS,
      });
      const equal = BAR_360 / 5;
      for (let i = 0; i < 5; i += 1) {
        if (i === activeIndex) continue;
        expect(layout.slots[i]).toBeLessThanOrEqual(equal);
      }
    }
  });

  it("case 3 — the slots + the insets exactly fill the bar (the fill rule binds on phones)", () => {
    for (const barWidth of [BAR_320, BAR_360, BAR_411]) {
      for (const activeIndex of [0, 2, 4]) {
        const layout = computeTabSlots({ barWidth, tabCount: 5, activeIndex, labelWidths: LABELS });
        const sum = layout.slots.reduce((a, b) => a + b, 0);
        expect(sum + TAB_INSET_X * 2).toBe(barWidth);
      }
    }
  });

  it("case 4 — the pill sits ≥ 12dp inside BOTH bar edges for tabs 0 and N−1", () => {
    for (const barWidth of [BAR_320, BAR_360, BAR_411]) {
      for (const activeIndex of [0, 4]) {
        const layout = computeTabSlots({ barWidth, tabCount: 5, activeIndex, labelWidths: LABELS });
        const center = layout.centers[activeIndex] ?? 0;
        const left = center - layout.pillWidth / 2;
        const right = center + layout.pillWidth / 2;
        expect(left).toBeGreaterThanOrEqual(TAB_INSET_X);
        expect(barWidth - right).toBeGreaterThanOrEqual(TAB_INSET_X);
        // More's pill sits exactly 12dp off the edge at 360dp (was ~1px).
        if (barWidth === BAR_360 && activeIndex === 4) {
          expect(barWidth - right).toBe(TAB_INSET_X);
        }
      }
    }
  });

  it("case 5 — every slot ≥ the icon at 320/360/411dp (the 22dp floor)", () => {
    // At 320dp every UNSELECTED slot still ≥ 38 (the spec's own bound).
    const small = computeTabSlots({ barWidth: BAR_320, tabCount: 5, activeIndex: 2, labelWidths: LABELS });
    for (const slot of small.slots) expect(slot).toBeGreaterThanOrEqual(TAB_ICON_SIZE);
    for (const [i, slot] of small.slots.entries()) {
      if (i !== 2) expect(slot).toBeGreaterThanOrEqual(38);
    }
    for (const barWidth of [BAR_360, BAR_411]) {
      const layout = computeTabSlots({ barWidth, tabCount: 5, activeIndex: 2, labelWidths: LABELS });
      for (const slot of layout.slots) expect(slot).toBeGreaterThanOrEqual(TAB_ICON_SIZE);
    }
  });

  it("case 6 — the 62px Approvals label leaves ≥ 26dp slack inside its slot", () => {
    const layout = computeTabSlots({ barWidth: BAR_360, tabCount: 5, activeIndex: 2, labelWidths: LABELS });
    const slack = (layout.slots[2] ?? 0) - TAB_ICON_SIZE_ACTIVE - TAB_CHIP_GAP - (LABELS[2] ?? 0);
    // The invariant: LABEL_EPSILON + 2*PILL_PAD_X whenever the cap doesn't
    // bind — the label's budget clears the measurement by exactly the pill's
    // own padding pair plus the rounding slack ("Approvals" fits, 26 spare).
    expect(slack).toBeGreaterThanOrEqual(26);
    expect(LABEL_EPSILON + PILL_PAD_X * 2).toBe(26);
  });

  it("case 7 — the unmeasured mount pose: the selected slot at its floor, the others at the equal split", () => {
    const pose = computeTabSlots({
      barWidth: BAR_360,
      tabCount: 5,
      activeIndex: 0,
      labelWidths: [0, 0, 0, 0, 0],
    });
    expect(pose.slots[0]).toBe(FLOOR); // ICON_SIZE_ACTIVE + 2*PILL_PAD_X = 47
    expect(FLOOR).toBe(47);
    for (const [i, slot] of pose.slots.entries()) {
      if (i !== 0) expect(slot).toBe(BAR_360 / 5);
    }
    // The pill rides the selected slot's own width — icon-centered, no flash.
    expect(pose.pillWidth).toBe(FLOOR);
    expect(pose.centers[0]).toBe(TAB_INSET_X + FLOOR / 2);
  });

  it("the degenerate guards: empty bar and single tab", () => {
    expect(computeTabSlots({ barWidth: 336, tabCount: 0, activeIndex: 0, labelWidths: [] })).toEqual({
      slots: [],
      centers: [],
      pillWidth: 0,
    });
    expect(computeTabSlots({ barWidth: 0, tabCount: 5, activeIndex: 0, labelWidths: LABELS }).slots).toEqual([]);
    // One tab owns the whole padded row.
    const lone = computeTabSlots({ barWidth: BAR_360, tabCount: 1, activeIndex: 0, labelWidths: [62] });
    expect(lone.slots).toHaveLength(1);
    expect(lone.slots[0]).toBeLessThanOrEqual(BAR_360 - TAB_INSET_X * 2);
  });

  it("an out-of-range active index clamps into the row (never a NaN slot)", () => {
    const layout = computeTabSlots({ barWidth: BAR_360, tabCount: 5, activeIndex: 9, labelWidths: LABELS });
    expect(layout.slots).toHaveLength(5);
    expect(layout.slots.every((s) => Number.isFinite(s))).toBe(true);
    expect(layout.slots[4]).toBe(
      TAB_ICON_SIZE_ACTIVE + TAB_CHIP_GAP + (LABELS[4] ?? 0) + LABEL_EPSILON + PILL_PAD_X * 2,
    );
  });
});
