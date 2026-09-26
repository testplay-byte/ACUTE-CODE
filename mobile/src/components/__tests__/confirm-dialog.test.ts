/**
 * confirm-dialog.test.ts — the R118-D centered-dialog primitive's contract
 * (spec-d-session.md §2.3), pinned in the chart-donut.test.ts idiom: the
 * PROP surface is TYPE-ONLY (erased at runtime — typecheck is the gate that
 * runs it), the GEOMETRY + motion constants are VALUE imports (the
 * native-heavy leaves — reanimated, lucide, expo-haptics — jest-mocked,
 * never loaded).
 *
 * What is pinned: the exact prop surface the stop-confirm wiring rides
 * ({open, title, body?, confirmLabel, cancelLabel, destructive?,
 * onConfirm, onCancel, testID}), and the card's geometry arithmetic —
 * width min(320, windowWidth − 40), the 46px button row, the 160ms scrim
 * fade (the sheet tokens' own), the 120ms exit fade, the 0.96 entrance
 * scale floor (origin center — a centered dialog grows from its middle).
 */

import { describe, expect, it, jest } from "@jest/globals";

jest.mock("react-native-reanimated", () => ({
  __esModule: true,
  default: { createAnimatedComponent: () => () => null, View: () => null },
  // R129-M — hardening: any module-scope Easing construction (the
  // disclosure/transcript COLLAPSE_EASING idiom) survives this mock too.
  Easing: { out: (e: unknown) => e, quad: { quad: true } },
  runOnJS: (fn: unknown) => fn,
  useAnimatedStyle: (fn: () => unknown) => fn(),
  useReducedMotion: () => true,
  useSharedValue: (initial: number) => ({ value: initial }),
  withSpring: (v: number) => v,
  withTiming: (v: number) => v,
}));
jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));
jest.mock("expo-haptics", () => ({
  selectionAsync: async () => undefined,
  successAsync: async () => undefined,
  warningAsync: async () => undefined,
}));

import {
  DIALOG_BUTTON_MIN_HEIGHT,
  DIALOG_CARD_MIN_WIDTH,
  DIALOG_ENTRANCE_SCALE,
  DIALOG_EXIT_FADE_MS,
  DIALOG_SCRIM_MS,
  DIALOG_SCREEN_MARGIN,
  ConfirmDialogProps,
  dialogCardWidth,
} from "@/components/confirm-dialog";

// The whole vocabulary — no accidental API creep beyond the spec's surface
// (a confirm dialog is a sentence + two buttons, never a form container:
// sheets own forms).
type ExpectedKeys =
  | "open"
  | "title"
  | "body"
  | "confirmLabel"
  | "cancelLabel"
  | "destructive"
  | "onConfirm"
  | "onCancel"
  | "testID";
type PropKeys = keyof ConfirmDialogProps;
type NoVocabularyDrift = Exclude<PropKeys, ExpectedKeys> extends never
  ? Exclude<ExpectedKeys, PropKeys> extends never
    ? true
    : never
  : never;
const vocabularyPinned: NoVocabularyDrift = true;

// The required core: open/title/confirmLabel/cancelLabel/onConfirm/onCancel/
// testID — everything a caller must own. body + destructive are the only
// optional refinements.
type OptionalKeys = "body" | "destructive";
type RequiredCorePinned = Exclude<ExpectedKeys, OptionalKeys> extends keyof ConfirmDialogProps ? true : never;
const requiredCore: RequiredCorePinned = true;
type OnlyBodyAndDestructiveOptional =
  undefined extends ConfirmDialogProps["body"]
    ? undefined extends ConfirmDialogProps["destructive"]
      ? true
      : never
    : never;
const optionalPair: OnlyBodyAndDestructiveOptional = true;

// testID is REQUIRED (the centered confirm is always addressable — the
// stop wiring's automation reads it).
type TestIdIsRequired = undefined extends ConfirmDialogProps["testID"] ? never : true;
const testIdRequired: TestIdIsRequired = true;

describe("ConfirmDialog — the prop surface (spec §2.3)", () => {
  it("the vocabulary is exactly the spec's nine fields", () => {
    // The runtime mirror of the compile-time pins above (both would fail to
    // COMPILE first — that is the point: typecheck is the gate that runs them).
    expect(vocabularyPinned).toBe(true);
    expect(requiredCore).toBe(true);
    expect(optionalPair).toBe(true);
    expect(testIdRequired).toBe(true);
  });
});

describe("ConfirmDialog — the geometry arithmetic (spec §2.3)", () => {
  it("the card's width is min(320, windowWidth − 40) — the gutter never inverts it", () => {
    expect(DIALOG_CARD_MIN_WIDTH).toBe(320);
    expect(DIALOG_SCREEN_MARGIN).toBe(40);
    // wide screens: the floor wins
    expect(dialogCardWidth(1080)).toBe(320);
    expect(dialogCardWidth(360)).toBe(320);
    // narrow screens: the gutter wins (360 − 40 = 320 exactly on the seam)
    expect(dialogCardWidth(300)).toBe(260);
    expect(dialogCardWidth(100)).toBe(60);
    // degenerate: clamped at zero, never negative
    expect(dialogCardWidth(20)).toBe(0);
    expect(dialogCardWidth(0)).toBe(0);
  });

  it("the button row's floor is 46 (the taller, calmer CTA)", () => {
    expect(DIALOG_BUTTON_MIN_HEIGHT).toBe(46);
  });

  it("the motion constants: 160ms scrim (the sheet tokens' own), 120ms exit fade, 0.96 entrance", () => {
    expect(DIALOG_SCRIM_MS).toBe(160);
    expect(DIALOG_EXIT_FADE_MS).toBe(120);
    expect(DIALOG_ENTRANCE_SCALE).toBe(0.96);
  });
});
