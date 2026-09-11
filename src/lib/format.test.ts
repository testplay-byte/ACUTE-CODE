/**
 * R91-H — the MILLION tier of the shared token formatters (the owner: "the
 * total amount of tokens used can be shown in millions too. If the user has
 * used 300 million tokens, then it will show 300m instead of showing 300 and
 * then more zeros"). One file for BOTH helpers — they are documented twins
 * (identical math, different case), so the pins must never drift.
 */
import { describe, expect, it } from "vitest";
import { fmtTokens, formatTokenCount } from "./format";

describe("formatTokenCount (the dashboard/usage stat-card formatter)", () => {
  it("renders whole millions without the trailing .0 — the owner's exact example", () => {
    expect(formatTokenCount(300_000_000)).toBe("300M");
    expect(formatTokenCount(1_000_000)).toBe("1M");
    expect(formatTokenCount(42_000_000)).toBe("42M");
  });

  it("keeps ONE decimal for fractional millions below 10M", () => {
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
    expect(formatTokenCount(2_400_000)).toBe("2.4M");
    expect(formatTokenCount(9_950_000)).toBe("9.9M");
    expect(formatTokenCount(10_000_000)).toBe("10M"); // the whole-number tier begins
  });

  it("keeps the pre-R91 tiers byte-identical below a million", () => {
    expect(formatTokenCount(850)).toBe("850");
    expect(formatTokenCount(12_000)).toBe("12K");
    expect(formatTokenCount(1_300)).toBe("1.3K");
    expect(formatTokenCount(420_000)).toBe("420K");
  });
});

describe("fmtTokens (the composer's lowercase twin)", () => {
  it("mirrors the million tier in lowercase", () => {
    expect(fmtTokens(300_000_000)).toBe("300m");
    expect(fmtTokens(1_000_000)).toBe("1m");
    expect(fmtTokens(1_500_000)).toBe("1.5m");
    expect(fmtTokens(420_000)).toBe("420k");
    expect(fmtTokens(9_000)).toBe("9.0k"); // the pinned K-tier decimal (donut rows)
  });
});
