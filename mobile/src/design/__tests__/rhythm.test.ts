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

import { PAGE_CTA_MIN_W, SHEET_CTA_MIN_W, spacing } from "../tokens";

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

// ── R118-E §5.5 — the registry screen's rhythm pins ────────────────────────

describe("the R118-E page rhythm pins (spec-e §2A/§2C)", () => {
  it("the page CTA minimum is 200 — the centered self-sized ChromeButton law", () => {
    expect(PAGE_CTA_MIN_W).toBe(200);
    expect(SHEET_CTA_MIN_W).toBe(200);
  });

  it("the providers TIER BREAK composes to ~65px (§2A3): the scaffold's 12px gap on BOTH sides + marginVertical 20×2 + the 1dp strong rule", () => {
    // The break between "Your providers" and the add CTA is the ONLY step
    // on the screen the 12px intra-group rhythm cannot imitate: the two
    // scaffold gaps (12 each), the Hairline strong's own marginVertical
    // (20 each), and the 1dp visible divider itself.
    expect(spacing.md * 2 + spacing.xl * 2 + 1).toBe(65);
  });
});
