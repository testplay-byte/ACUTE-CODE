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
  SHEET_SCRIM_OPEN_MS,
  SHEET_SHOW_ARM_FALLBACK_MS,
  SHEET_SPRING,
  sheetPanelTravelPx,
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

  it("the close departure is 220ms on BOTH legs — one exit, never a two-speed dissolve", () => {
    expect(SHEET_CLOSE_MS).toBe(220);
    // The dismissal is the snappier leg: closing never outlasts the open's
    // dim — the sheet leaves at least as promptly as it arrived.
    expect(SHEET_CLOSE_MS).toBeLessThan(SHEET_SCRIM_OPEN_MS);
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
