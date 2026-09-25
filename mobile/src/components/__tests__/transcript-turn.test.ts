/**
 * transcript-turn.test.ts — R123-W-m: the MOBILE TRANSCRIPT REDESIGN's pure
 * anatomy pins (the owner's 7 reference screenshots + his report). Two laws
 * live in transcript.tsx as pure exports so jest can pin what the owner
 * demanded:
 *   · userBubbleBodyPlan — IMAGES RIDE ABOVE THE TEXT in the user bubble
 *     (the owner: "the image was supposed to be shown at the top of the
 *     text, but it was shown below the text. In the PC, it was shown
 *     properly"), with the file chips staying below the text (chat.md's
 *     own law). The component renders the plan's order verbatim.
 *   · wellDefaultOpen — the ACTIVITY WELL's default is OPEN for every turn
 *     whose well renders TOOL ROWS (the owner: "No tool calls were shown to
 *     me, or anything like that. No file writes were shown to me" — the
 *     R119 settle-collapse hid every row behind the one-line rail the
 *     moment a turn settled). Live turns keep the open behavior; tool-less
 *     turns (the pref's hidden rung, thinking-only turns) keep the R119
 *     collapsed default; a user's manual tap still wins for the block's
 *     lifetime (the component's userTouched discipline).
 *
 * The component module's import graph is jest-mocked the
 * transcript-delivery.test.ts way (reanimated, lucide, router/clipboard,
 * the markdown/image deep chain) — the VALUES under test are pure exports.
 */

import { afterEach, describe, expect, it, jest } from "@jest/globals";

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
  TOOLS_HIDDEN_HINT_COPY,
  acquireToolsHiddenHint,
  dismissToolsHiddenHint,
  mountToolsHiddenHintBlock,
  releaseToolsHiddenHintBlock,
  resetToolsHiddenHintForTest,
  toolStatusWord,
  userBubbleBodyPlan,
  wellDefaultOpen,
} from "@/components/transcript";
import type { AttachmentView } from "@/features/sessions";

function attachment(name: string, path?: string): AttachmentView {
  return { name, ...(path !== undefined ? { path } : {}), size: 1024 };
}

describe("R123-W-m — userBubbleBodyPlan (the images-ABOVE-the-text contract)", () => {
  it("an image + text + file message plans images FIRST, the text BETWEEN, the file chips LAST (the PC's ordering)", () => {
    const plan = userBubbleBodyPlan([
      attachment("shot.png", "attachments/shot.png"),
      attachment("notes.md", "attachments/notes.md"),
    ]);
    expect(plan.map((part) => part.role)).toEqual(["images", "text", "files"]);
    const images = plan[0];
    if (images?.role !== "images") throw new Error("expected the images part first");
    expect(images.attachments.map((a) => a.name)).toEqual(["shot.png"]);
    const files = plan[2];
    if (files?.role !== "files") throw new Error("expected the files part last");
    expect(files.attachments.map((a) => a.name)).toEqual(["notes.md"]);
  });

  it("the image test reads the name OR the persisted path (the extension on either wins; neither means a file chip)", () => {
    // the name carries no extension but the PATH does — still an image
    const viaPath = userBubbleBodyPlan([
      attachment("blob", "cache/photo.jpeg"),
      attachment("photo", "no-extension"),
    ]);
    expect(viaPath.map((part) => part.role)).toEqual(["images", "text", "files"]);
    const images = viaPath[0];
    if (images?.role !== "images") throw new Error("expected the images part first");
    expect(images.attachments.map((a) => a.name)).toEqual(["blob"]);
    const files = viaPath[2];
    if (files?.role !== "files") throw new Error("expected the files part last");
    expect(files.attachments.map((a) => a.name)).toEqual(["photo"]);
    // a name-only image attachment is still an image
    const named = userBubbleBodyPlan([attachment("wallpaper.webp")]);
    expect(named.map((part) => part.role)).toEqual(["images", "text"]);
  });

  it("a text-only message plans just the text; a null attachments field plans just the text", () => {
    expect(userBubbleBodyPlan(null).map((part) => part.role)).toEqual(["text"]);
    expect(userBubbleBodyPlan([]).map((part) => part.role)).toEqual(["text"]);
  });

  it("an images-only message plans the images above the (empty) text — never the old text-first shape", () => {
    const plan = userBubbleBodyPlan([attachment("a.png"), attachment("b.gif")]);
    expect(plan.map((part) => part.role)).toEqual(["images", "text"]);
    const images = plan[0];
    if (images?.role !== "images") throw new Error("expected the images part first");
    expect(images.attachments.map((a) => a.name)).toEqual(["a.png", "b.gif"]);
  });
});

describe("R123-W-m — wellDefaultOpen (the well's default-OPEN law)", () => {
  it("a SETTLED turn with tool rows defaults OPEN — the rows stay visible (the owner's report)", () => {
    expect(wellDefaultOpen(false, 1)).toBe(true);
    expect(wellDefaultOpen(false, 7)).toBe(true);
  });

  it("a LIVE turn defaults OPEN (today's behavior, unchanged)", () => {
    expect(wellDefaultOpen(true, 0)).toBe(true);
    expect(wellDefaultOpen(true, 3)).toBe(true);
  });

  it("a turn with NO tool rows keeps the R119 collapsed default — the thinking-only well and the hidden pref's clean document", () => {
    expect(wellDefaultOpen(false, 0)).toBe(false);
  });
});

// ── R127-W8 — the tools-hidden hint (once per session screen mount) ────────
// The TurnBlock renders the line; THESE exports are the state machine it
// drives, so the pins drive them directly (the transcript suite's own
// precedent — pure exports, no component rendering).
describe("R127-W8 — the tools-hidden hint's once-per-mount law", () => {
  const ownerA = {};
  const ownerB = {};
  const ownerC = {};

  afterEach(() => {
    resetToolsHiddenHintForTest();
  });

  it("the first qualifying block claims the hint; a second block never gets it (ONCE)", () => {
    expect(acquireToolsHiddenHint(ownerA, true, 2)).toBe(true);
    expect(acquireToolsHiddenHint(ownerB, true, 3)).toBe(false);
    expect(acquireToolsHiddenHint(ownerC, true, 1)).toBe(false);
  });

  it("the OWNER keeps the hint across its own re-renders while it still qualifies", () => {
    expect(acquireToolsHiddenHint(ownerA, true, 2)).toBe(true);
    expect(acquireToolsHiddenHint(ownerA, true, 2)).toBe(true); // re-render
    expect(acquireToolsHiddenHint(ownerA, true, 5)).toBe(true); // tool rows grew
  });

  it("the claim dies with the fix — once hidden flips false (setToolActivity('detailed')), the line is gone", () => {
    expect(acquireToolsHiddenHint(ownerA, true, 2)).toBe(true);
    expect(acquireToolsHiddenHint(ownerA, false, 2)).toBe(false); // the tap landed
  });

  it("a turn with NOTHING to hide never claims — the hint needs hidden + tool items", () => {
    expect(acquireToolsHiddenHint(ownerA, false, 3)).toBe(false); // pref not hidden
    expect(acquireToolsHiddenHint(ownerB, true, 0)).toBe(false); // no tool items
    // And it did not steal the claim from a later qualifying block:
    expect(acquireToolsHiddenHint(ownerC, true, 1)).toBe(true);
  });

  it("the agreed one-liner is the spec's exact copy (the pinned string)", () => {
    expect(TOOLS_HIDDEN_HINT_COPY).toBe("Tool activity is hidden — tap to show");
  });

  it("dismissal silences the hint for the WHOLE generation — both the owner and later blocks", () => {
    expect(acquireToolsHiddenHint(ownerA, true, 2)).toBe(true);
    dismissToolsHiddenHint(); // the ✕ (or the fix-tap — same leg)
    expect(acquireToolsHiddenHint(ownerA, true, 2)).toBe(false);
    expect(acquireToolsHiddenHint(ownerB, true, 4)).toBe(false);
  });

  it("a fresh session screen mount (all blocks unmounted) re-opens the generation", () => {
    mountToolsHiddenHintBlock(); // block A mounts
    mountToolsHiddenHintBlock(); // block B mounts
    expect(acquireToolsHiddenHint(ownerA, true, 2)).toBe(true);

    releaseToolsHiddenHintBlock(); // A unmounts — B still holds the screen
    expect(acquireToolsHiddenHint(ownerB, true, 2)).toBe(false); // still once

    releaseToolsHiddenHintBlock(); // the LAST block unmounts — screen gone
    expect(acquireToolsHiddenHint(ownerB, true, 2)).toBe(true); // fresh mount claims
  });

  it("a mid-generation dismissal does NOT outlive the screen — the next mount says it again", () => {
    mountToolsHiddenHintBlock();
    expect(acquireToolsHiddenHint(ownerA, true, 2)).toBe(true);
    dismissToolsHiddenHint();
    expect(acquireToolsHiddenHint(ownerA, true, 2)).toBe(false);
    releaseToolsHiddenHintBlock(); // the screen unmounts
    expect(acquireToolsHiddenHint(ownerB, true, 2)).toBe(true); // fresh generation
  });
});

// ── R128-W6 — the settled tool row's status word (the chip + a11y vocabulary) ──

describe("R128-W6 — toolStatusWord (the quiet chip's one vocabulary)", () => {
  it("running while the call runs, null on success, failed on a plain failure", () => {
    expect(toolStatusWord({ ok: null })).toBe("running");
    expect(toolStatusWord({ ok: true })).toBeNull(); // the result rides the head line
    expect(toolStatusWord({ ok: false })).toBe("failed");
  });

  it("INTERRUPTED: a settled call carrying the marker reads as interrupted — the turn ended underneath it", () => {
    // The live overlay's honest settle (sessions.ts's R128-W6 terminal-frame
    // settle): ok:false + the additive marker renders NEUTRAL, not failed.
    expect(toolStatusWord({ ok: false, interrupted: true })).toBe("interrupted");
    // The marker never masquerades as running or success.
    expect(toolStatusWord({ ok: null, interrupted: true })).toBe("running"); // not a state we emit
    expect(toolStatusWord({ ok: true, interrupted: true })).toBeNull();
  });
});
