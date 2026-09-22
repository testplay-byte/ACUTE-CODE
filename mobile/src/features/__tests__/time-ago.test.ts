/**
 * time-ago.test.ts — the short relative time the list rows share (R118-E,
 * hoisted verbatim from projects.tsx so the key meta line and any future
 * row reuse ONE spelling). The table pins the s/m/h/d ladder and the
 * clamps. Pure-logic only — zero React Native.
 */

import { describe, expect, it } from "@jest/globals";

import { timeAgoShort } from "@/lib/time-ago";

describe("timeAgoShort — the s/m/h/d ladder", () => {
  const NOW = 1_800_000_000_000;

  const TABLE: ReadonlyArray<{ then: number; expected: string }> = [
    // Under a MINUTE → "just now" (R118-review WARN 2: one law across all
    // three spellings — and the minutes band starts at 1, never "0m ago").
    { then: NOW, expected: "just now" },
    { then: NOW - 1_000, expected: "just now" },
    { then: NOW - 44_000, expected: "just now" },
    { then: NOW - 59_000, expected: "just now" },
    // Minutes.
    { then: NOW - 60_000, expected: "1m ago" },
    { then: NOW - 5 * 60_000, expected: "5m ago" },
    // The TOP of the minutes band — 59m 59.999s still says 59m.
    { then: NOW - 60 * 60_000 + 1, expected: "59m ago" },
    // Hours.
    { then: NOW - 60 * 60_000, expected: "1h ago" },
    { then: NOW - 3.5 * 60 * 60_000, expected: "3h ago" },
    { then: NOW - 23 * 60 * 60_000, expected: "23h ago" },
    // Days (honest beyond a day — never a fake date).
    { then: NOW - 24 * 60 * 60_000, expected: "1d ago" },
    { then: NOW - 14 * 24 * 60 * 60_000, expected: "14d ago" },
    // A future timestamp clamps to "just now" — never a negative age.
    { then: NOW + 5 * 60_000, expected: "just now" },
  ];

  it.each(TABLE)("timeAgoShort(then, now) → %s", ({ then, expected }) => {
    expect(timeAgoShort(then, NOW)).toBe(expected);
  });

  it("the default `now` is Date.now() (the injectable leg stays callable bare)", () => {
    expect(timeAgoShort(Date.now() - 2 * 60_000)).toBe("2m ago");
    expect(timeAgoShort(Date.now())).toBe("just now");
  });
});
