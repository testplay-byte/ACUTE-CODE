/**
 * rhythm.test.ts — the 12/32 list cadence (R117-g2, AMENDMENT 5 of
 * round-117-elevation.md §2.1), pinned as pure token arithmetic: the mobile
 * suite stays pure-logic (nothing imports react-native at test time), so the
 * LAYOUT contract is pinned through the tokens the implementation composes —
 * ScreenScaffold.bodyContent's `gap: spacing.md` + SectionHeader's
 * `marginTop: spacing.xl` are the two halves, and their sum must be the
 * ladder's own 32 (spacing.xxxl).
 *
 * The old beat was a uniform 16 (spacing.lg) between everything; §1.8's
 * diagnosis called it monotony of rhythm. These pins make the collapse back
 * to a single beat — or the drift of the section break off 32 — a CI
 * failure.
 */
import { describe, expect, it } from "@jest/globals";

import { resolveTheme, spacing } from "../tokens";

describe("the 12/32 list rhythm (R117-g2, AMENDMENT 5)", () => {
  it("the intra-group beat is spacing.md (12) — the scaffold's bodyContent gap", () => {
    expect(spacing.md).toBe(12);
  });

  it("the section break composes: SectionHeader's marginTop (20) + the 12 gap = 32", () => {
    expect(spacing.xl).toBe(20);
    expect(spacing.xl + spacing.md).toBe(spacing.xxxl);
    expect(spacing.xxxl).toBe(32);
  });

  it("gutters stay 16 — the body padding is not part of the rhythm change", () => {
    expect(spacing.lg).toBe(16);
  });
});

// ── R118-B — the STRONG divider (spec §5.3, the same token-pinning pattern) ─

describe("the STRONG divider (R118-B — the visible clay divider)", () => {
  // Hairline strong renders a FULL 1dp line in borderStrong (primitives.tsx:
  // `height: strong ? 1 : StyleSheet.hairlineWidth`) — the RN-locked half
  // lives in the primitive; the jest sandbox pins the TOKEN half here: the
  // strong tier is a full 18% ink line in BOTH modes — 3× the subtle
  // hairline's 6%, which at StyleSheet.hairlineWidth (~0.33dp on a 3×
  // screen) is arithmetically invisible (spec §1.8's diagnosis).
  it("borderStrong is 18% ink in both modes — 3× the subtle hairline's 6%", () => {
    const light = resolveTheme("clay", false);
    const dark = resolveTheme("clay", true);
    expect(light.borderStrong).toBe("rgba(0,0,0,0.18)");
    expect(dark.borderStrong).toBe("rgba(255,255,255,0.18)");
    expect(light.borderSubtle).toBe("rgba(0,0,0,0.06)");
    expect(dark.borderSubtle).toBe("rgba(255,255,255,0.06)");
  });

  it("the strong tier is a DIFFERENT token from the card rim — the divider is not a border reuse", () => {
    const light = resolveTheme("clay", false);
    const dark = resolveTheme("clay", true);
    expect(light.borderStrong).not.toBe(light.clayRim);
    expect(dark.borderStrong).not.toBe(dark.clayRim);
  });

  it("the row-knit recipe composes: inset spacing.md (12) — the divider breathes with the rows", () => {
    expect(spacing.md).toBe(12);
  });
});
