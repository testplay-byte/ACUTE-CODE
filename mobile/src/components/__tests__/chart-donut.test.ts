/**
 * chart-donut.test.ts — the R115-N donut math (the PC ModelDonut port),
 * table-driven: donutShares (the honest share-of-total), donutSegments (the
 * arc math: share/start/dash/rotation), shortModelName (the center
 * headline's tail/variant cut). The component half is untested surface per
 * the mobile suite's pure-logic convention (jest.config.js: "no screen
 * snapshots, no native bridge") — react-native-reanimated and
 * react-native-svg are MOCKED here so the file imports the real module
 * without pulling either library's native leg off the shelf.
 */

import { describe, expect, it, jest } from "@jest/globals";

jest.mock("react-native-reanimated", () => ({
  __esModule: true,
  default: { createAnimatedComponent: () => () => null },
  Easing: {
    inOut: () => (t: number) => t,
    out: () => (t: number) => t,
    sin: (t: number) => t,
    quad: (t: number) => t,
  },
  useAnimatedProps: (fn: () => unknown) => fn(),
  useReducedMotion: () => true,
  useSharedValue: (initial: number) => ({ value: initial }),
  withSpring: (v: number) => v,
  withTiming: (v: number) => v,
}));
jest.mock("react-native-svg", () => ({
  __esModule: true,
  default: () => null,
  Circle: () => null,
}));

import { donutSegments, donutShares, shortModelName } from "../chart-donut";
import type { DonutChartProps } from "../chart-donut";

describe("donutShares — the share-of-total math", () => {
  it.each([
    { values: [10, 30, 60], expected: [0.1, 0.3, 0.6] },
    { values: [100], expected: [1] },
    { values: [50, 0, 50], expected: [0.5, 0, 0.5] },
    { values: [0, 0], expected: [0, 0] },
    { values: [], expected: [] },
    { values: [-5, 5], expected: [0, 1] },
  ])("$values → $expected", ({ values, expected }) => {
    expect(donutShares(values)).toEqual(expected);
  });

  it("shares sum to 1 whenever the total is positive", () => {
    const shares = donutShares([3, 7, 11, 2]);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it("non-finite values contribute nothing (guarded, never NaN)", () => {
    expect(donutShares([Number.NaN, 50, Number.POSITIVE_INFINITY])).toEqual([0, 1, 0]);
  });
});

describe("donutSegments — the PC ModelDonut arc math", () => {
  // A round circumference keeps the table readable; the math is scale-free.
  const C = 100;

  it.each([
    {
      name: "three even-ish models",
      segments: [
        { label: "a", value: 50, hue: "#111111" },
        { label: "b", value: 25, hue: "#222222" },
        { label: "c", value: 25, hue: "#333333" },
      ],
      expected: [
        { share: 0.5, start: 0, dash: 50, rotation: -90 },
        { share: 0.25, start: 0.5, dash: 25, rotation: 90 },
        { share: 0.25, start: 0.75, dash: 25, rotation: 180 },
      ],
    },
    {
      name: "a zero-token model keeps its slot and shifts nobody",
      segments: [
        { label: "a", value: 50, hue: "#111111" },
        { label: "b", value: 0, hue: "#222222" },
        { label: "c", value: 50, hue: "#333333" },
      ],
      expected: [
        { share: 0.5, start: 0, dash: 50, rotation: -90 },
        { share: 0, start: 0.5, dash: 0, rotation: 90 },
        { share: 0.5, start: 0.5, dash: 50, rotation: 90 },
      ],
    },
    {
      name: "a lone model takes the whole ring",
      segments: [{ label: "solo", value: 100, hue: "#111111" }],
      expected: [{ share: 1, start: 0, dash: 100, rotation: -90 }],
    },
    {
      name: "no usage at all — every share collapses to 0",
      segments: [
        { label: "a", value: 0, hue: "#111111" },
        { label: "b", value: 0, hue: "#222222" },
      ],
      expected: [
        { share: 0, start: 0, dash: 0, rotation: -90 },
        { share: 0, start: 0, dash: 0, rotation: -90 },
      ],
    },
  ])("$name", ({ segments, expected }) => {
    const arcs = donutSegments(segments, C);
    expect(arcs.map(({ share, start, dash, rotation }) => ({ share, start, dash, rotation }))).toEqual(
      expected,
    );
    // The label + hue ride verbatim — the caller's rank hues ARE the ring's.
    arcs.forEach((arc, index) => {
      expect(arc.label).toBe(segments[index].label);
      expect(arc.hue).toBe(segments[index].hue);
      expect(arc.value).toBe(segments[index].value);
    });
  });

  it("start is exactly the sum of the shares before each arc (the chain property)", () => {
    const arcs = donutSegments(
      [
        { label: "a", value: 3, hue: "#111111" },
        { label: "b", value: 7, hue: "#222222" },
        { label: "c", value: 11, hue: "#333333" },
        { label: "d", value: 2, hue: "#444444" },
      ],
      2 * Math.PI * 57,
    );
    let cumulative = 0;
    for (const arc of arcs) {
      expect(arc.start).toBeCloseTo(cumulative, 9);
      cumulative += arc.share;
      expect(arc.dash).toBeCloseTo(2 * Math.PI * 57 * arc.share, 9);
      expect(arc.rotation).toBeCloseTo(-90 + arc.start * 360, 9);
    }
    expect(cumulative).toBeCloseTo(1, 9);
  });

  it("an empty input answers an empty ring", () => {
    expect(donutSegments([], C)).toEqual([]);
  });
});

describe("shortModelName — the center headline's cut", () => {
  it.each([
    ["z-ai/glm-5.2:free", "glm-5.2"],
    ["glm-5.2", "glm-5.2"],
    ["openai/gpt-4o:mini", "gpt-4o"],
    ["provider/model", "model"],
    ["provider/", "provider/"],
    [":free", ":free"],
    ["", ""],
  ])("%s → %s", (input, expected) => {
    expect(shortModelName(input)).toBe(expected);
  });
});

describe("DonutChart — the component surface (compile-time pins)", () => {
  it("keeps the R115-N prop contract (a removed prop breaks this file's compile)", () => {
    // The array literal is typed keyof DonutChartProps — deleting any prop
    // from the interface fails `npx tsc --noEmit` on THIS line.
    const contract: Array<keyof DonutChartProps> = [
      "segments",
      "size",
      "dataKey",
      "highlighted",
      "trackColor",
      "center",
      "accessibilityLabel",
      "testID",
    ];
    expect(contract).toHaveLength(8);
  });
});
