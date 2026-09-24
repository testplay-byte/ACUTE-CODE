/**
 * usage-format.test.ts — the R118-C pure module's pin suite (spec §5.1):
 * the number ladder (formatTokens/formatUsd/formatCount), the calendar-LOCAL
 * dates (shortDate/formatClock/localDateString), the relative-time
 * vocabulary (timeAgoFromIso — `now` injected so the table is
 * deterministic), and the two session laws: sessionStatusBadge (the honest
 * status tag — queued shows NOTHING) and sessionLastActivityIso
 * (endedAt ?? startedAt). PERIOD_OPTIONS pins the selector's keys/labels
 * (≤4 chars — the segmented control's tier). R124 adds chartAxisTicks —
 * the redesigned daily chart's date-tick index ladder.
 *
 * The module under test is PURE (zero React Native imports — the mobile
 * suite's pure-logic convention, jest.config.js), so no mocks are needed;
 * time formatting uses Z-less ISO strings so the expectations hold in any
 * timezone (they parse calendar-LOCAL, like the app itself does).
 */

import { describe, expect, it } from "@jest/globals";

import {
  chartAxisTicks,
  formatClock,
  formatCount,
  formatTokens,
  formatUsd,
  localDateString,
  PERIOD_OPTIONS,
  sessionLastActivityIso,
  sessionStatusBadge,
  shortDate,
  timeAgoFromIso,
} from "../usage-format";

describe("formatTokens — the compact token ladder", () => {
  it.each([
    [999, "999"],
    [1234, "1.2k"],
    [3_400_000, "3.4M"],
    [15_400_000, "15.4M"],
    [2_100_000_000, "2.1B"],
    [0, "0"],
    [Number.NaN, "—"],
  ])("%d → %s", (value, expected) => {
    expect(formatTokens(value)).toBe(expected);
  });
});

describe("formatUsd — the 2-vs-3/4-decimal honesty", () => {
  it.each([
    [0, "$0.00"],
    [0.03, "$0.030"],
    [0.5, "$0.500"],
    [1.2, "$1.20"],
    [12.345, "$12.35"],
    [Number.NaN, "—"],
  ])("%d → %s", (value, expected) => {
    expect(formatUsd(value)).toBe(expected);
  });
});

describe("formatCount — deterministic en-US grouping", () => {
  it.each([
    [0, "0"],
    [1234, "1,234"],
    [1_234_567, "1,234,567"],
    [Number.NaN, "—"],
  ])("%d → %s", (value, expected) => {
    expect(formatCount(value)).toBe(expected);
  });
});

describe("shortDate — the calendar-LOCAL month-day cut", () => {
  it.each([
    ["2026-09-01", "Sep 1"],
    ["2026-12-05", "Dec 5"],
    ["2026-01-31", "Jan 31"],
  ])("%s → %s", (date, expected) => {
    expect(shortDate(date)).toBe(expected);
  });
});

describe("formatClock — the footer's clock", () => {
  it("renders the hour:minute with the AM/PM marker (local-calendar parse)", () => {
    // Z-less ISO parses calendar-LOCAL; the leading zero on the hour varies
    // across ICU builds ("3:42 PM" / "03:42 PM") — both are the same clock.
    expect(formatClock("2026-09-01T15:42:00")).toMatch(/^0?3:42\s?[AP]M$/i);
  });

  it("an unparseable ISO passes through untouched", () => {
    expect(formatClock("not-a-clock")).toBe("not-a-clock");
  });
});

describe("localDateString — the today-anchor's comparison key", () => {
  it("formats the device's own calendar day as YYYY-MM-DD", () => {
    expect(localDateString(new Date(2026, 8, 1))).toBe("2026-09-01");
    expect(localDateString(new Date(2026, 10, 25))).toBe("2026-11-25");
  });

  it("zero-pads single-digit months and days", () => {
    expect(localDateString(new Date(2026, 0, 3))).toBe("2026-01-03");
  });
});

describe("timeAgoFromIso — the shared relative-time vocabulary", () => {
  // A fixed anchor parsed calendar-LOCAL, so `now` arithmetic is timezone-free.
  const anchor = "2026-09-01T12:00:00";
  const at = (offsetMs: number): number => Date.parse(anchor) + offsetMs;

  it.each([
    [0, "just now"],
    [44_000, "just now"],
    [59_000, "just now"],
    [5 * 60_000, "5m ago"],
    [59 * 60_000, "59m ago"],
    [3 * 3_600_000, "3h ago"],
    [23 * 3_600_000, "23h ago"],
    [3 * 86_400_000, "3d ago"],
  ])("%dms past the anchor → %s", (offsetMs, expected) => {
    expect(timeAgoFromIso(anchor, at(offsetMs))).toBe(expected);
  });

  it("an unparseable ISO passes through untouched", () => {
    expect(timeAgoFromIso("never", at(0))).toBe("never");
  });
});

describe("sessionStatusBadge — the honest status law (§2.6)", () => {
  it.each([
    ["queued", null],
    ["running", { label: "running", tone: "warning" }],
    ["completed", { label: "done", tone: "success" }],
    ["failed", { label: "failed", tone: "danger" }],
    ["cancelled", { label: "stopped", tone: "danger" }],
  ])("%s → %s", (status, expected) => {
    expect(sessionStatusBadge(status)).toEqual(expected);
  });

  it("queued shows NOTHING — the absence of a badge is the information", () => {
    expect(sessionStatusBadge("queued")).toBeNull();
  });

  it("an unknown RAW wire status badges neutral under its own spelling", () => {
    expect(sessionStatusBadge("paused")).toEqual({ label: "paused", tone: "neutral" });
  });

  it("an empty status string renders no badge at all", () => {
    expect(sessionStatusBadge("")).toBeNull();
  });
});

describe("sessionLastActivityIso — endedAt ?? startedAt", () => {
  it("prefers the end, falls back to the start, null only when both are", () => {
    expect(sessionLastActivityIso({ endedAt: "2026-09-01T10:00:00Z", startedAt: "2026-08-31T09:00:00Z" })).toBe(
      "2026-09-01T10:00:00Z",
    );
    expect(sessionLastActivityIso({ endedAt: null, startedAt: "2026-08-31T09:00:00Z" })).toBe(
      "2026-08-31T09:00:00Z",
    );
    expect(sessionLastActivityIso({ endedAt: null, startedAt: null })).toBeNull();
  });
});

describe("PERIOD_OPTIONS — the selector's vocabulary (§2.1)", () => {
  it("carries exactly the three windows, in order", () => {
    expect(PERIOD_OPTIONS.map((option) => option.key)).toEqual(["14d", "30d", "3mo"]);
  });

  it("every key and label is ≤4 chars (the segmented control's terse tier)", () => {
    for (const option of PERIOD_OPTIONS) {
      expect(option.key.length).toBeLessThanOrEqual(4);
      expect(option.label.length).toBeLessThanOrEqual(4);
    }
  });

  it("every option carries a full accessibility label for screen readers", () => {
    for (const option of PERIOD_OPTIONS) {
      expect(option.accessibilityLabel.length).toBeGreaterThan(4);
    }
  });
});

// ── R124 — the daily chart's date-tick ladder (the redesigned chart's axis) ──
// The owner's round-124 verdict retired the weekday-tick row ("Mon"-style
// labels every 2nd column, 14-day window only) in favor of ONE date-tick
// grammar across all three windows: ≤5 evenly spaced labels, first + last
// always present (the last doubles as the "today" edge), zero repeats.

describe("chartAxisTicks — the date-tick index ladder (R124)", () => {
  it.each([
    { dayCount: 14, expected: [0, 3, 7, 10, 13] },
    { dayCount: 30, expected: [0, 7, 15, 22, 29] },
    { dayCount: 90, expected: [0, 22, 45, 67, 89] },
  ])("$dayCount days → $expected", ({ dayCount, expected }) => {
    expect(chartAxisTicks(dayCount, 5)).toEqual(expected);
  });

  it("a short window labels every day (no dedupe needed)", () => {
    expect(chartAxisTicks(4, 5)).toEqual([0, 1, 2, 3]);
    expect(chartAxisTicks(5, 5)).toEqual([0, 1, 2, 3, 4]);
  });

  it("the first and last indices are ALWAYS included — the today edge survives", () => {
    for (const dayCount of [6, 13, 14, 30, 45, 90]) {
      const ticks = chartAxisTicks(dayCount, 5);
      expect(ticks[0]).toBe(0);
      expect(ticks[ticks.length - 1]).toBe(dayCount - 1);
      expect(ticks.length).toBeLessThanOrEqual(5);
    }
  });

  it("never repeats an index and stays strictly ascending", () => {
    for (const dayCount of [2, 3, 7, 14, 29, 30, 90, 365]) {
      const ticks = chartAxisTicks(dayCount, 5);
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
      }
      for (const tick of ticks) {
        expect(tick).toBeGreaterThanOrEqual(0);
        expect(tick).toBeLessThan(dayCount);
      }
    }
  });

  it("degenerate inputs answer honestly (empty, no ticks, negative, non-finite)", () => {
    expect(chartAxisTicks(0, 5)).toEqual([]);
    expect(chartAxisTicks(-3, 5)).toEqual([]);
    expect(chartAxisTicks(Number.NaN, 5)).toEqual([]);
    expect(chartAxisTicks(Number.POSITIVE_INFINITY, 5)).toEqual([]);
    // A maxTicks under 2 floors to 2 — one label is not a scale.
    expect(chartAxisTicks(30, 1)).toEqual([0, 29]);
    expect(chartAxisTicks(30, 0)).toEqual([0, 29]);
  });

  it("non-integer counts floor before laddering (a 13.9-day series is 13 days)", () => {
    expect(chartAxisTicks(13.9, 5)).toEqual(chartAxisTicks(13, 5));
  });
});
