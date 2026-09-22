/**
 * error-card.test.ts — the R119-P error card's BODY SELECTION pins
 * (round-119 §1 item F / §2 Track P): the owner's TokenHarbor report — a
 * region_blocked provider answer read as an unexplained generic failure on
 * the phone because BOTH mobile reducers dropped the wire's providerError
 * while the PC's TurnErrorCard showed it. The selection now lives in the
 * exported pure helper `errorCardLines` (transcript.tsx): the RAW provider
 * text is the PRIMARY headline when present; the generic machine message
 * demotes to the dim secondary line; no providerError → the generic line
 * stays the only body (older sidecars, validation refusals).
 *
 * The component module's import graph is jest-mocked the
 * transcript-delivery.test.ts way (reanimated, lucide, router/clipboard,
 * the markdown/image deep chain) — the VALUE under test is a pure export.
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

import { errorCardLines } from "@/components/transcript";

describe("the error card's body selection — errorCardLines (R119-P)", () => {
  it("a providerError present becomes the PRIMARY (the honest raw line) with the generic message demoted to the secondary", () => {
    expect(
      errorCardLines(
        "region_blocked: your region is not supported by tokenharbor.ai",
        "provider 'tokenharbor' call failed for session sess_1 (class: region)",
      ),
    ).toEqual({
      primary: "region_blocked: your region is not supported by tokenharbor.ai",
      secondary: "provider 'tokenharbor' call failed for session sess_1 (class: region)",
    });
  });

  it("no providerError → the generic message stays the ONLY body (older sidecars, validation refusals)", () => {
    expect(errorCardLines(null, "the turn failed")).toEqual({
      primary: "the turn failed",
      secondary: null,
    });
    expect(errorCardLines(undefined, "the turn failed")).toEqual({
      primary: "the turn failed",
      secondary: null,
    });
  });

  it("a BLANK providerError is treated as absent — never an empty headline", () => {
    expect(errorCardLines("", "the generic line")).toEqual({
      primary: "the generic line",
      secondary: null,
    });
    expect(errorCardLines("   ", "the generic line")).toEqual({
      primary: "the generic line",
      secondary: null,
    });
  });

  it("the primary is TRIMMED — wire whitespace never pads the headline", () => {
    expect(errorCardLines("  raw provider text  ", "the generic line")).toEqual({
      primary: "raw provider text",
      secondary: "the generic line",
    });
  });
});
