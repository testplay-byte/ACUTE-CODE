/**
 * transcript-delivery.test.ts — the R118-D delivery treatments' contract
 * (spec-d-session.md §2.7): the tick ladder is RETIRED, the state rides the
 * message body. The pure pins live here — the rung words the a11y label
 * appends (deliveryVisualRung), the sending veil's opacity (0.12 — the
 * RN-honest "grayscale + slight blur"), the processing edge's breathing mix
 * depths (0.34 ↔ 0.62 at the house 550ms legs, the static 0.55
 * reduced-motion hold), and the failed tell's danger edge depth (0.22).
 *
 * The five-rung TYPE is pinned against features/sessions (the rung is one
 * status flip — the ladder's machine lives there and stays pinned by
 * sessions.test.ts). The component module's import graph is jest-mocked the
 * chart-donut.test.ts way (reanimated, lucide, router/clipboard, the
 * markdown/image deep chain) — the VALUES under test are pure exports.
 */

import { describe, expect, it, jest } from "@jest/globals";

jest.mock("react-native-reanimated", () => ({
  __esModule: true,
  default: { createAnimatedComponent: () => () => null, View: () => null },
  interpolateColor: (v: number, _range: number[], colors: string[]) => colors[v > 0 ? 1 : 0],
  runOnJS: (fn: unknown) => fn,
  useAnimatedStyle: (fn: () => unknown) => fn(),
  useReducedMotion: () => true,
  useSharedValue: (initial: number) => ({ value: initial }),
  withRepeat: (v: unknown) => v,
  withSequence: (...v: unknown[]) => v[0],
  withSpring: (v: number) => v,
  withTiming: (v: number) => v,
}));
jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));
jest.mock("expo-router", () => ({ useRouter: () => ({ back: () => {}, navigate: () => {} }) }));
jest.mock("expo-clipboard", () => ({ setStringAsync: async () => true }));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock("@/link/runtime", () => ({ getLinkManager: () => ({}) }));
jest.mock("@/components/markdown-text", () => ({ MarkdownText: () => null }));
jest.mock("@/components/image-viewer", () => ({ ImageViewer: () => null }));

import {
  DELIVERY_EDGE_HIGH,
  DELIVERY_EDGE_LOW,
  DELIVERY_EDGE_STATIC,
  DELIVERY_FAILED_EDGE,
  DELIVERY_VEIL_OPACITY,
  deliveryVisualRung,
} from "@/components/transcript";
import type { UserDeliveryStatus } from "@/features/sessions";

// The five-rung ladder, both directions — the "processing" rung is the
// R118-D addition (the PC has started WORKING), and nothing else moved.
type ExpectedRungs = "sending" | "sent" | "processing" | "delivered" | "failed";
type RungVocabularyPinned =
  Exclude<UserDeliveryStatus, ExpectedRungs> extends never
    ? Exclude<ExpectedRungs, UserDeliveryStatus> extends never
      ? true
      : never
    : never;
const rungVocabulary: RungVocabularyPinned = true;

describe("transcript — the delivery rung's a11y words (R118-D §2.7)", () => {
  it("the status vocabulary is exactly the five rungs", () => {
    // The runtime mirror of the compile-time pin above (it fails to COMPILE
    // first — that is the point: typecheck is the gate that runs it).
    expect(rungVocabulary).toBe(true);
  });

  it("deliveryVisualRung maps every rung to its word; undefined stays null (clean history)", () => {
    expect(deliveryVisualRung("sending")).toBe("sending");
    expect(deliveryVisualRung("sent")).toBe("sent");
    expect(deliveryVisualRung("processing")).toBe("processing");
    expect(deliveryVisualRung("delivered")).toBe("delivered");
    expect(deliveryVisualRung("failed")).toBe("failed");
    expect(deliveryVisualRung(undefined)).toBeNull();
  });
});

describe("transcript — the four body treatments' pinned depths (R118-D §2.7)", () => {
  it("(a) sending — the veil is bg at 0.12 over the whole bubble", () => {
    expect(DELIVERY_VEIL_OPACITY).toBe(0.12);
  });

  it("(c) processing — the breathing edge mixes 0.34 ↔ 0.62, static 0.55 (reduced motion)", () => {
    expect(DELIVERY_EDGE_LOW).toBe(0.34);
    expect(DELIVERY_EDGE_HIGH).toBe(0.62);
    expect(DELIVERY_EDGE_STATIC).toBe(0.55);
    // the static hold sits BETWEEN the breath's ends — the reduced-motion
    // frame reads as the pulse held mid-stride, not a third color
    expect(DELIVERY_EDGE_STATIC).toBeGreaterThan(DELIVERY_EDGE_LOW);
    expect(DELIVERY_EDGE_STATIC).toBeLessThan(DELIVERY_EDGE_HIGH);
  });

  it("(d) failed — the danger edge's mix depth over card is 0.22 (no glyph)", () => {
    expect(DELIVERY_FAILED_EDGE).toBe(0.22);
  });

  it("(b) sent/delivered — the resting tint is untouched by this wave (0.16/0.34, the R117-frozen pair)", () => {
    // The resting bubble's OWN constants live inline in UserBubble (the
    // R117-elevation §2.2 freeze — the do-not-touch list). What this wave
    // pins instead: the processing edge's LOW end is the SAME 0.34 the
    // resting edge uses — the breath starts from the settled color and
    // never darkens the resting shape below it.
    expect(DELIVERY_EDGE_LOW).toBe(0.34);
  });
});
