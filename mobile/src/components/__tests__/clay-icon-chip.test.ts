/**
 * clay-icon-chip.test.ts — the R117-g2 primitive's contract, pinned in the
 * screen-scaffold.test.ts idiom: TYPE-ONLY imports (erased at runtime — the
 * mobile suite stays pure-logic, nothing pulls react-native into the jest
 * sandbox), so `npx tsc --noEmit` is the assertion's execution engine: if
 * the prop surface drifts, THIS file stops compiling.
 *
 * What is pinned (round-117-elevation.md §2.2): the chip takes the GLYPH
 * component + the glyph's size + the chip edge (exactly 40/44/48 — the
 * spec's r 14/15/16 ladder) and nothing else beyond the overlay slot +
 * style/testID plumbing. The COLOR contract (accentTint fill, clayRim
 * hairline, clayShadowSm, the accentDeep strokeWidth-2.2 glyph) is owned
 * INSIDE the primitive off the resolved theme — a caller can never
 * hand-roll a ghost chip through it.
 */
import { describe, expect, it } from "@jest/globals";

import type { ClayIconChipProps } from "@/design/primitives";

// The chip's whole vocabulary — no accidental API creep beyond the spec.
type ExpectedKeys = "icon" | "iconSize" | "size" | "children" | "style" | "testID";
type PropKeys = keyof ClayIconChipProps;
type NoVocabularyDrift = Exclude<PropKeys, ExpectedKeys> extends never ? true : never;
const vocabularyPinned: NoVocabularyDrift = true;

// The size union is EXACTLY the spec's 40/44/48 ladder (r 14/15/16) — both
// directions, so neither a missing nor an extra edge can slip in.
type SizeUnion = NonNullable<ClayIconChipProps["size"]>;
type SizeIsTheSpecLadder = 40 | 44 | 48 extends SizeUnion
  ? Exclude<SizeUnion, 40 | 44 | 48> extends never
    ? true
    : never
  : never;
const sizePinned: SizeIsTheSpecLadder = true;

// `iconSize` is REQUIRED — the caller owns the glyph's size (17–24 across
// the six migrated sites); a silent default would drift the migrations.
type IconSizeIsRequired = undefined extends ClayIconChipProps["iconSize"] ? never : true;
const iconSizeRequired: IconSizeIsRequired = true;

// `size` is OPTIONAL with the spec's 40 default at the call sites — the
// smallest identity chip is the resting default.
type SizeIsOptional = undefined extends ClayIconChipProps["size"] ? true : never;
const sizeOptional: SizeIsOptional = true;

describe("ClayIconChip — the tinted identity chip (R117-g2 §2.2)", () => {
  it("the prop surface is exactly the spec's vocabulary", () => {
    // The runtime mirror of the compile-time pins above (both would fail to
    // COMPILE first — that is the point: typecheck is the gate that runs them).
    expect(vocabularyPinned).toBe(true);
  });

  it("the size ladder is exactly 40 / 44 / 48 (r 14 / 15 / 16)", () => {
    expect(sizePinned).toBe(true);
  });

  it("iconSize is required; size is optional", () => {
    expect(iconSizeRequired).toBe(true);
    expect(sizeOptional).toBe(true);
  });
});
