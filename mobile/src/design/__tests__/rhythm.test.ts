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

import { spacing } from "../tokens";

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
