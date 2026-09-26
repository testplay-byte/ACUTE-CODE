/**
 * attachment-viewer.test.ts — the R120-P attachment VIEWER POP-UP's pure
 * surface (round-120.md §1 item 32 — the owner's ask: "tapping ANY
 * attachment opens a viewer pop-up — images: a large preview; text files:
 * a scrollable text view; non-previewable types get a sensible viewer").
 *
 * The component module's import graph is jest-mocked the error-card.test.ts
 * way (reanimated, lucide, the ImageViewer deep chain) — the VALUES under
 * test are the pure exports: the card's width ceiling (the ConfirmDialog
 * family's own gutter law, widened for a document surface), the scroll
 * body's height share, the honest size/kind captions, and the frozen
 * motion constants (the centered-dialog grammar: 160ms scrim, 120ms exit
 * fade, the 0.96 entrance floor).
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
jest.mock("@/components/image-viewer", () => ({ ImageViewer: () => null }));

import {
  VIEWER_BODY_HEIGHT_RATIO,
  VIEWER_CARD_MAX_WIDTH,
  VIEWER_ENTRANCE_SCALE,
  VIEWER_EXIT_FADE_MS,
  VIEWER_SCRIM_MS,
  VIEWER_SCREEN_MARGIN,
  viewerBodyMaxHeight,
  viewerCardWidth,
  viewerKindCaption,
  viewerSizeCaption,
  type AttachmentViewerProps,
} from "@/components/attachment-viewer";
import type { ComposerAttachment } from "@/features/attachments";

// The prop surface is exactly the caller's three — no API creep.
type ExpectedKeys = "chip" | "onClose" | "testID";
type PropKeys = keyof AttachmentViewerProps;
type NoVocabularyDrift = Exclude<PropKeys, ExpectedKeys> extends never
  ? Exclude<ExpectedKeys, PropKeys> extends never
    ? true
    : never
  : never;
const vocabularyPinned: NoVocabularyDrift = true;

function chip(overrides: Partial<ComposerAttachment>): ComposerAttachment {
  return {
    id: "x",
    name: "x.bin",
    size: 10,
    text: null,
    truncated: false,
    source: "picker",
    ...overrides,
  };
}

describe("AttachmentViewer — the R120-P card geometry (the dialog family, widened)", () => {
  it("the prop surface is exactly chip/onClose/testID", () => {
    expect(vocabularyPinned).toBe(true);
  });

  it("viewerCardWidth: min(520, windowWidth − 40), never negative", () => {
    expect(VIEWER_CARD_MAX_WIDTH).toBe(520);
    expect(VIEWER_SCREEN_MARGIN).toBe(40);
    // a phone column gutters to windowWidth − 40
    expect(viewerCardWidth(360)).toBe(320);
    expect(viewerCardWidth(412)).toBe(372);
    // a wide window caps at the 520 document ceiling
    expect(viewerCardWidth(700)).toBe(520);
    expect(viewerCardWidth(600)).toBe(520);
    // a degenerate tiny window clamps at 0, never negative
    expect(viewerCardWidth(20)).toBe(0);
    expect(viewerCardWidth(0)).toBe(0);
  });

  it("viewerBodyMaxHeight: 60% of the window height, rounded", () => {
    expect(VIEWER_BODY_HEIGHT_RATIO).toBe(0.6);
    expect(viewerBodyMaxHeight(800)).toBe(480);
    expect(viewerBodyMaxHeight(733)).toBe(440); // Math.round(439.8)
    expect(viewerBodyMaxHeight(0)).toBe(0);
  });
});

describe("AttachmentViewer — the honest captions (the info card never fakes pixels)", () => {
  it("viewerSizeCaption: the size, plus the head-cap note when the chip carries only the first 128 KB", () => {
    expect(viewerSizeCaption(chip({ size: 2048, text: "hi" }))).toBe("2 KB");
    expect(viewerSizeCaption(chip({ size: 2048, text: "hi", truncated: true }))).toBe("2 KB · first 128 KB");
    expect(viewerSizeCaption(chip({ size: 0, text: "hi", truncated: true }))).toBe("first 128 KB");
    // no size, no cap → the empty string (the caption row renders nothing)
    expect(viewerSizeCaption(chip({ size: 0, text: "hi" }))).toBe("");
  });

  it("viewerKindCaption: a binary stays a binary; a host-side image says where its bytes live", () => {
    expect(viewerKindCaption(chip({ name: "data.bin", text: null }))).toBe("binary file");
    expect(viewerKindCaption(chip({ name: "shot.png", text: null }))).toBe(
      "image · the bytes live on the host — no preview on this phone",
    );
    // a text-carrying chip never reads as the info card's kinds
    expect(viewerKindCaption(chip({ name: "notes.txt", text: "hi" }))).toBe("text file");
  });
});

describe("AttachmentViewer — the frozen motion constants (the centered-dialog grammar)", () => {
  it("the scrim fades 160ms in and out; the exit fade is the dialog's own 120ms", () => {
    expect(VIEWER_SCRIM_MS).toBe(160);
    expect(VIEWER_EXIT_FADE_MS).toBe(120);
    expect(VIEWER_ENTRANCE_SCALE).toBe(0.96);
  });
});
