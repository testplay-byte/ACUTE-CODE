/**
 * capability-icons.test.ts — the R120-M capability icon vocabulary's
 * compile-time pins, in the clay-icon-chip.test.ts idiom: TYPE-ONLY imports
 * (erased at runtime — react-native-svg never enters the jest sandbox), so
 * `npx tsc --noEmit` is the assertion's execution engine: if the glyph
 * vocabulary drifts, THIS file stops compiling.
 *
 * What is pinned (round-120 §1 item 18 — "the input/output capabilities:
 * actual color-coded SVG icons, laid out on a single line"):
 *   · the glyph set is EXACTLY the eight capabilities the editor's rows
 *     and the fetch summary read — text, vision, audio, video, pdf, image,
 *     tools, reasoning (both directions: neither a missing nor an extra
 *     glyph can slip in);
 *   · the icon's props are exactly kind + size (defaulted) + color +
 *     testID — the COLOR always comes from the caller (capabilityHue
 *     resolves it off the theme; the icon set itself stays hue-agnostic).
 */
import { describe, expect, it } from "@jest/globals";

import type { CapabilityIconProps, CapabilityKind } from "@/components/capability-icons";

// The glyph vocabulary — EXACTLY the eight kinds, both directions.
type ExpectedKinds =
  | "text"
  | "vision"
  | "audio"
  | "video"
  | "pdf"
  | "image"
  | "tools"
  | "reasoning";
type KindUnion = CapabilityKind;
type VocabularyIsExact =
  | ExpectedKinds extends KindUnion
  ? Exclude<KindUnion, ExpectedKinds> extends never
    ? true
    : never
  : never;
const vocabularyPinned: VocabularyIsExact = true;

// The icon's prop surface — kind + the optional size + the caller's color.
type PropKeys = keyof CapabilityIconProps;
type NoPropDrift = Exclude<PropKeys, "kind" | "size" | "color" | "testID"> extends never
  ? true
  : never;
const propsPinned: NoPropDrift = true;

// `color` is REQUIRED — the color coding is the caller's resolution
// (capabilityHue off the resolved theme; never a hardcoded fill).
type ColorIsRequired = undefined extends CapabilityIconProps["color"] ? never : true;
const colorRequired: ColorIsRequired = true;

describe("CapabilityIcon — the R120-M glyph vocabulary (item 18)", () => {
  it("the glyph set is exactly the eight capabilities — text/vision/audio/video/pdf/image/tools/reasoning", () => {
    expect(vocabularyPinned).toBe(true);
  });

  it("the icon's props are exactly kind + size + color + testID", () => {
    expect(propsPinned).toBe(true);
  });

  it("color is required — the hue always comes from the caller's resolution", () => {
    expect(colorRequired).toBe(true);
  });
});
