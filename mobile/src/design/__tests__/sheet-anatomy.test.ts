/**
 * sheet-anatomy.test.ts — spec-A §5's drift-guards (R118-review WARN 1:
 * the W2 sheet rework landed without its own pins — the primitive is
 * correct, but nothing stopped a future `caption` prop creeping onto
 * SegmentedControl or a 32px QuietIconButton size sailing through every
 * gate). TYPE-ONLY imports in the clay-icon-chip idiom (erased at runtime;
 * `npx tsc --noEmit` is the vocabulary pins' execution engine) + the pure
 * token arithmetic pins off tokens.ts.
 */

import { describe, expect, it } from "@jest/globals";

import type { QuietIconButtonProps, SegmentedControlProps } from "@/design/primitives";
import type { SheetProps } from "@/components/sheet";
import * as MotionModule from "@/design/motion";
import {
  DISCLOSURE_SPRING,
  SHEET_CLOSE_MS,
  SHEET_DRAG_DISMISS_FRACTION,
  SHEET_DRAG_DISMISS_VELOCITY,
  SHEET_DRAG_RUBBER_PX,
  SHEET_SCRIM_OPEN_MS,
  SHEET_SHOW_ARM_FALLBACK_MS,
  SHEET_SPRING,
  sheetDismissOnRelease,
  sheetPanelTravelPx,
  sheetRubberBandPx,
} from "@/design/motion";
import {
  PAGE_CTA_MIN_W,
  SEGMENT_INSET,
  SEGMENT_TRACK_H,
  SHEET_CTA_MIN_W,
  SHEET_HEADER_ROW,
  spacing,
  TOUCH_TARGET,
} from "@/design/tokens";

// ── The Sheet's vocabulary: exactly the R118-A surface, nothing else ────────

type SheetKeys = keyof SheetProps;
type SheetVocabularyPinned = Exclude<SheetKeys, "open" | "onClose" | "title" | "children" | "maxHeightFraction" | "testID"> extends never
  ? true
  : never;
const sheetVocabulary: SheetVocabularyPinned = true;

// `title` is REQUIRED — the header row's TypeTitle is the sheet's headline
// (the R118-A anatomy; a caption-tier title would drift it back).
type SheetTitleRequired = undefined extends SheetProps["title"] ? never : true;
const sheetTitleRequired: SheetTitleRequired = true;

// ── SegmentedControl: the no-descriptions law, enforced ─────────────────────
// The spec's stated job for this pin: "a caption/description prop cannot
// creep in — this is the no-descriptions law, enforced." The vocabulary is
// {options, selectedId, onSelect, testID} and NOTHING else.

type SegmentKeys = keyof SegmentedControlProps<string>;
type SegmentVocabularyPinned = Exclude<SegmentKeys, "options" | "selectedId" | "onSelect" | "testID"> extends never
  ? true
  : never;
const segmentVocabulary: SegmentVocabularyPinned = true;

// The option items carry the full-name a11y slot and nothing beyond it.
type OptionKeys = keyof SegmentedControlProps<string>["options"][number];
type OptionVocabularyPinned = Exclude<OptionKeys, "id" | "label" | "accessibilityLabel"> extends never
  ? true
  : never;
const optionVocabulary: OptionVocabularyPinned = true;

// ── QuietIconButton: the 36/40/44 circle ladder, both directions ────────────

type QuietSizeUnion = NonNullable<QuietIconButtonProps["size"]>;
type QuietSizeIsTheLadder = 36 | 40 | 44 extends QuietSizeUnion
  ? Exclude<QuietSizeUnion, 36 | 40 | 44> extends never
    ? true
    : never
  : never;
const quietSizePinned: QuietSizeIsTheLadder = true;

// The vocabulary: the glyph + its size + the circle edge + the press + the
// plumbing — and nothing else (no tone, no fill override: the circle IS the
// grammar).
type QuietKeys = keyof QuietIconButtonProps;
type QuietVocabularyPinned = Exclude<QuietKeys, "icon" | "iconSize" | "onPress" | "accessibilityLabel" | "size" | "hitSlop" | "testID"> extends never
  ? true
  : never;
const quietVocabulary: QuietVocabularyPinned = true;

// `iconSize` is REQUIRED — the caller owns the glyph size (18 sheet close,
// 22 the back arrow).
type QuietIconSizeRequired = undefined extends QuietIconButtonProps["iconSize"] ? never : true;
const quietIconSizeRequired: QuietIconSizeRequired = true;

describe("the R118-A sheet anatomy — the drift-guards (spec-A §5)", () => {
  it("the Sheet's prop surface is exactly {open, onClose, title, children, maxHeightFraction, testID} — title required", () => {
    expect(sheetVocabulary).toBe(true);
    expect(sheetTitleRequired).toBe(true);
  });

  it("SegmentedControl's vocabulary is {options, selectedId, onSelect, testID} — the no-descriptions law, enforced", () => {
    expect(segmentVocabulary).toBe(true);
    expect(optionVocabulary).toBe(true);
  });

  it("QuietIconButton's size union is exactly 36|40|44 and its vocabulary carries no tone/fill escape hatch", () => {
    expect(quietSizePinned).toBe(true);
    expect(quietVocabulary).toBe(true);
    expect(quietIconSizeRequired).toBe(true);
  });

  it("SHEET_CHROME parity: header 48 + paddingTop sm 8 + content paddingTop xs 4 + buffer 4 === 64 (the R114 clamp preserved)", () => {
    expect(SHEET_HEADER_ROW + spacing.sm + spacing.xs + 4).toBe(64);
  });

  it("the segment track's inner height is the 44px touch law: SEGMENT_TRACK_H − 2×SEGMENT_INSET === TOUCH_TARGET", () => {
    expect(SEGMENT_TRACK_H - SEGMENT_INSET * 2).toBe(TOUCH_TARGET);
  });

  it("the CTA minimums: the centered never-full-width law at both scales (sheet 200, page 200)", () => {
    expect(SHEET_CTA_MIN_W).toBe(200);
    expect(PAGE_CTA_MIN_W).toBe(200);
  });

  it("three segments fit on one line at 360dp: (360 − 2×16 gutters − 2×4 inset) / 3 ≥ 90dp per segment", () => {
    const segmentWidth = (360 - spacing.lg * 2 - SEGMENT_INSET * 2) / 3;
    expect(segmentWidth).toBeGreaterThanOrEqual(90);
  });
});

// ── R120-S — the sheet motion retune #2 (the round's authority), pinned ─────
// The owner's round-120 verdict: the animations "look ugly, they are
// stuttering, and they do not play in the proper time when needed". The
// diagnosis found the START RACE (the entrance was armed before the Modal's
// Android window existed — the sheet surfaced mid-rise), the OVER-TRAVEL
// (maxHeightFraction x window + 48 ≈ 670dp against a settle tuned for
// 300-400dp), and the CLOSE LINGER (ease-in quad covered 2.7% of the travel
// in two frames; the content pre-blanked while the panel sat still). The
// spelling below is what sheet.tsx now rides — the docs wave codifies it.

describe("the R120-S sheet motion — one coordinated timeline (round-120 §1 C8)", () => {
  it("the spring VALUE stands: SHEET_SPRING is still the house DISCLOSURE settle {180, 24}", () => {
    expect(SHEET_SPRING).toEqual({ stiffness: 180, damping: 24 });
    // R119-P's equality law survives the retune: the panel grammar IS the
    // disclosure grammar (same spelling, two names — pinned by value).
    expect(SHEET_SPRING).toEqual(DISCLOSURE_SPRING);
  });

  it("the scrim's open fade is 240ms ease-out — frame one with the panel, completing as the settle lands (~300ms)", () => {
    expect(SHEET_SCRIM_OPEN_MS).toBe(240);
  });

  it("R124 SUPERSEDES the both-legs close law: SHEET_CLOSE_MS (220ms) now scopes the SCRIM's exit fade only — the panel's exit mirrors its rise on the SHEET spring (the R120-S ease-out-cubic panel leg is retired)", () => {
    expect(SHEET_CLOSE_MS).toBe(220);
    // The dismissal is still the snappier leg: closing never outlasts the
    // open's dim — the sheet leaves at least as promptly as it arrived.
    expect(SHEET_CLOSE_MS).toBeLessThan(SHEET_SCRIM_OPEN_MS);
    // The panel's exit rides the SAME spring the rise rides (one physical
    // material both ways — the R124 verdict: "the exit mirrors the enter").
    // The unmount owns itself via the spring's completion callback, so the
    // never-zombie law survives the supersession.
    expect(SHEET_SPRING).toEqual({ stiffness: 180, damping: 24 });
  });

  it("the onShow guard is 150ms — a platform that never fires onShow can never leave the sheet below the fold", () => {
    expect(SHEET_SHOW_ARM_FALLBACK_MS).toBe(150);
  });

  it("the R119 content ride is RETIRED — no SHEET_CONTENT_FADE_* constant exists (the fold reveals the body)", () => {
    expect(Object.keys(MotionModule)).not.toContain("SHEET_CONTENT_FADE_MS");
    expect(Object.keys(MotionModule)).not.toContain("SHEET_CONTENT_FADE_DELAY_MS");
  });

  it("the travel is the panel's MEASURED height — the settle never rides the maxHeightFraction over-travel", () => {
    // Measured wins the moment layout has reported: a 400dp panel travels
    // 400dp, never the ~670dp fraction bound.
    expect(sheetPanelTravelPx(400, 672)).toBe(400);
    expect(sheetPanelTravelPx(317.6, 672)).toBe(318);
    // The pre-layout fallback holds (fully below the fold either way) and
    // rounds honestly.
    expect(sheetPanelTravelPx(0, 672)).toBe(672);
    expect(sheetPanelTravelPx(0, 671.4)).toBe(671);
    // Degenerate measurements never travel sideways.
    expect(sheetPanelTravelPx(-1, 672)).toBe(672);
  });
});

// ── R124 — the sheet drag law (round-124 §2 — the drag-to-dismiss), pinned ───
// The owner's round-124 verdict: "the bottom up menus are most definitely not
// proper. They have bad animations." The drag law makes the sheet GENUINELY
// draggable: the header row (a real grab pill) feeds a dragY shared value —
// downward follows the finger 1:1, upward is the rubber band, and the release
// obeys the two-leg dismissal law. Both helpers are pure (zero reanimated
// imports) so they pin here like every other motion recipe.

describe("the R124 sheet drag law — sheetRubberBandPx (the upward ceiling)", () => {
  it("rest is rest: 0 and non-positive and non-finite pulls answer 0", () => {
    expect(sheetRubberBandPx(0)).toBe(0);
    expect(sheetRubberBandPx(-40)).toBe(0);
    expect(sheetRubberBandPx(Number.NaN)).toBe(0);
    expect(sheetRubberBandPx(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("the classic asymptote: half the ceiling at one-ceiling pull, never past the ceiling", () => {
    // pull = R → R × (1 − 1/2) = R/2 exactly.
    expect(sheetRubberBandPx(SHEET_DRAG_RUBBER_PX)).toBeCloseTo(SHEET_DRAG_RUBBER_PX / 2);
    // 4× the ceiling of pull → R × (1 − 1/5) = 0.8R.
    expect(sheetRubberBandPx(SHEET_DRAG_RUBBER_PX * 4)).toBeCloseTo(SHEET_DRAG_RUBBER_PX * 0.8);
  });

  it("monotone and bounded for every pull up to 8× the ceiling", () => {
    let previous = 0;
    for (let pull = 0; pull <= SHEET_DRAG_RUBBER_PX * 8; pull += 4) {
      const moved = sheetRubberBandPx(pull);
      expect(moved).toBeGreaterThanOrEqual(previous);
      expect(moved).toBeLessThanOrEqual(SHEET_DRAG_RUBBER_PX);
      expect(moved).toBeGreaterThanOrEqual(0);
      previous = moved;
    }
    // The asymptote stays honest: an enormous pull still never crosses the
    // ceiling (the panel is bottom-anchored — it cannot detach from the fold).
    expect(sheetRubberBandPx(10_000)).toBeLessThanOrEqual(SHEET_DRAG_RUBBER_PX);
  });
});

describe("the R124 sheet drag law — sheetDismissOnRelease (the two-leg dismissal)", () => {
  it("the thresholds stand: ≥ 900px/s downward flings, ≥ 40% of the travel", () => {
    expect(SHEET_DRAG_DISMISS_VELOCITY).toBe(900);
    expect(SHEET_DRAG_DISMISS_FRACTION).toBe(0.4);
    expect(SHEET_DRAG_RUBBER_PX).toBe(24);
  });

  it("a fling at ≥ 900px/s downward dismisses from ANY offset — the finger said away", () => {
    expect(sheetDismissOnRelease(0, 900, 400)).toBe(true);
    expect(sheetDismissOnRelease(0, 2_500, 400)).toBe(true);
    // Even from the rubber-banded-up pose (negative offset), a hard downward
    // fling still dismisses.
    expect(sheetDismissOnRelease(-20, 1_400, 400)).toBe(true);
    expect(sheetDismissOnRelease(0, 899.9, 400)).toBe(false);
    // An UPWARD fling never dismisses on the velocity leg alone.
    expect(sheetDismissOnRelease(0, -2_500, 400)).toBe(false);
  });

  it("a pull past 40% of the travel dismisses whatever the velocity", () => {
    expect(sheetDismissOnRelease(160, 0, 400)).toBe(true);
    expect(sheetDismissOnRelease(159.9, 0, 400)).toBe(false);
    // Most of the way gone + still moving up: the position leg owns it —
    // springing a nearly-dismissed sheet BACK reads as a refusal.
    expect(sheetDismissOnRelease(300, -2_000, 400)).toBe(true);
  });

  it("a shallow slow release springs home (the ordinary case — a peek, not a dismissal)", () => {
    expect(sheetDismissOnRelease(80, 300, 400)).toBe(false);
    expect(sheetDismissOnRelease(0, 0, 400)).toBe(false);
  });

  it("degenerate travel (≤ 0) dismisses on any positive offset — there is nothing to spring back to", () => {
    expect(sheetDismissOnRelease(1, 0, 0)).toBe(true);
    expect(sheetDismissOnRelease(0, 0, 0)).toBe(false);
    expect(sheetDismissOnRelease(5, 0, -10)).toBe(true);
    expect(sheetDismissOnRelease(0, 0, -10)).toBe(false);
  });

  it("non-finite inputs never dismiss (the guarded branch, not a NaN comparison)", () => {
    expect(sheetDismissOnRelease(Number.NaN, 1_000, 400)).toBe(false);
    expect(sheetDismissOnRelease(200, Number.NaN, 400)).toBe(false);
    expect(sheetDismissOnRelease(Number.POSITIVE_INFINITY, 0, 400)).toBe(false);
  });
});
