/**
 * disclosure-motion.test.ts — the R118-C motion split's pin suite (spec §5.2):
 * DISCLOSURE_SPRING is exactly {180, 24} and its damping ratio
 * ζ = damping/(2√stiffness) lands in (0.85, 1) — one soft settle, no jelly;
 * the collapse timings are 200ms (height) / 150ms (fade); and the three
 * named recipes the split must NOT disturb stay byte-identical
 * (SPRING {180,22} / SHEET_SPRING {210,30} / TAB_SPRING {200,26}).
 *
 * motion.ts is pure constants (its only reanimated import is a TYPE, erased
 * at runtime), so this file needs no mocks — the mobile suite's pure-logic
 * convention holds by construction.
 */

import { describe, expect, it } from "@jest/globals";

import {
  DISCLOSURE_COLLAPSE_MS,
  DISCLOSURE_FADE_MS,
  DISCLOSURE_SPRING,
  SHEET_SPRING,
  SPRING,
  TAB_SPRING,
} from "../../design/motion";

/** ζ = damping / (2√stiffness) — the damping ratio of a reanimated spring. */
function zeta(config: { stiffness?: number; damping?: number }): number {
  return Number(config.damping) / (2 * Math.sqrt(Number(config.stiffness)));
}

describe("DISCLOSURE_SPRING — the expand (R118-C §2.7)", () => {
  it("is the house spring one damping step up: exactly {stiffness: 180, damping: 24}", () => {
    expect(DISCLOSURE_SPRING).toEqual({ stiffness: 180, damping: 24 });
  });

  it("ζ = damping/(2√stiffness) lands in (0.85, 1) — one soft settle, no jelly", () => {
    const ratio = zeta(DISCLOSURE_SPRING);
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1);
    // The exact arithmetic, pinned: 24/(2√180) ≈ 0.894.
    expect(ratio).toBeCloseTo(0.894, 2);
  });

  it("is one damping step OVER the house spring (22 → 24), same stiffness", () => {
    expect(DISCLOSURE_SPRING.stiffness).toBe(SPRING.stiffness);
    expect(Number(DISCLOSURE_SPRING.damping)).toBe(Number(SPRING.damping) + 2);
  });
});

describe("the collapse timings — closing never bounces", () => {
  it("the height collapse is 200ms ease-out (a timing curve cannot overshoot)", () => {
    expect(DISCLOSURE_COLLAPSE_MS).toBe(200);
  });

  it("the content fade lands slightly ahead of the height: 150ms", () => {
    expect(DISCLOSURE_FADE_MS).toBe(150);
    expect(DISCLOSURE_FADE_MS).toBeLessThan(DISCLOSURE_COLLAPSE_MS);
  });
});

describe("the named recipes stay unchanged (the do-not-touch list)", () => {
  it("SPRING is still the one house spring {180, 22}", () => {
    expect(SPRING).toEqual({ stiffness: 180, damping: 22 });
  });

  it("SHEET_SPRING is still the no-overshoot panel pair {210, 30}", () => {
    expect(SHEET_SPRING).toEqual({ stiffness: 210, damping: 30 });
  });

  it("TAB_SPRING is still the calm indicator slide {200, 26}", () => {
    expect(TAB_SPRING).toEqual({ stiffness: 200, damping: 26 });
  });
});
