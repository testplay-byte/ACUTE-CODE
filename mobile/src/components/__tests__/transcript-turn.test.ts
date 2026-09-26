/**
 * transcript-turn.test.ts — R123-W-m: the MOBILE TRANSCRIPT REDESIGN's pure
 * anatomy pins (the owner's 7 reference screenshots + his report). The laws
 * that live in transcript.tsx as pure exports so jest can pin what the owner
 * demanded:
 *   · userBubbleBodyPlan — IMAGES RIDE ABOVE THE TEXT in the user bubble
 *     (the owner: "the image was supposed to be shown at the top of the
 *     text, but it was shown below the text. In the PC, it was shown
 *     properly"), with the file chips staying below the text (chat.md's
 *     own law). The component renders the plan's order verbatim.
 *
 * ROUND-129 (R129-M — the separated-elements rework): the R123 well's
 * container contracts were RE-PINNED to chat.md §Transcript's separated
 * grammar — `turnElementsPlan` (pure, exported) is the render contract the
 * component renders verbatim.
 *
 * ROUND-130 (R130 — the tool groups + the interleaving): the plan is
 * RE-PINNED to chat.md §Transcript R130's grammar: EMISSION-ORDER
 * INTERLEAVING (tool groups and text runs alternate in the order the work
 * happened — the R129 all-cards-above-one-reply-bottom shape is dead), the
 * TOOL GROUP (one clay card per RUN of consecutive calls, live-open →
 * 2.5s-hold → auto-collapse, failures stay open, collapsed when settled —
 * the R123-W-m open-by-default law RETIRED by the owner's own ask), and the
 * geometry renamed to the group's own fields. The content-logic pins
 * (toolStatusWord, the tools-hidden hint, the user bubble's plan) ride
 * untouched below.
 *
 * The component module's import graph is jest-mocked the
 * transcript-delivery.test.ts way (reanimated, lucide, router/clipboard,
 * the markdown/image deep chain) — the VALUES under test are pure exports.
 */

import { afterEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("react-native-reanimated", () => ({
  __esModule: true,
  default: { createAnimatedComponent: () => () => null, View: () => null },
  // R129-M — transcript.tsx builds its DisclosureClip easing at MODULE scope
  // (disclosure.tsx's own COLLAPSE_EASING idiom), so this mock needs the
  // Easing member or the import itself dies (header-dropdown.test.ts's own
  // pattern).
  Easing: { out: (e: unknown) => e, quad: { quad: true } },
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
  turnElementsPlan,
  userBubbleBodyPlan,
  type TurnElementsPlan,
} from "@/components/transcript";
import { groupDisplayRows, type ToolItem, type TurnGroup } from "@/features/turn-block";
import type { ToolActivity } from "@/design/theme";
import { spacing } from "@/design/tokens";
import type { AttachmentView, TranscriptItem } from "@/features/sessions";

function attachment(name: string, path?: string): AttachmentView {
  return { name, ...(path !== undefined ? { path } : {}), size: 1024 };
}

// ── R129-M fixtures (the separated plan's minimal honest item shapes) ──────

function assistantItem(
  key: string,
  overrides: Partial<{
    content: string;
    thinking: string | null;
    thinkingMs?: number | null;
    live: boolean;
    chunks: string[] | null;
  }> = {},
): TranscriptItem & { kind: "assistant" } {
  return {
    kind: "assistant",
    key,
    content: overrides.content ?? "",
    thinking: overrides.thinking ?? null,
    model: null,
    chunks: overrides.chunks ?? null,
    live: overrides.live ?? false,
    ts: null,
    ...(overrides.thinkingMs !== undefined ? { thinkingMs: overrides.thinkingMs } : {}),
  };
}

function toolItem(
  key: string,
  overrides: Partial<{
    toolName: string;
    argsSummary: string;
    ok: boolean | null;
    live: boolean;
  }> = {},
): ToolItem {
  return {
    kind: "tool",
    key,
    toolName: overrides.toolName ?? "run_command",
    argsSummary: overrides.argsSummary ?? "command: npm test",
    ok: overrides.ok === undefined ? true : overrides.ok,
    outputSummary: null,
    outputTail: null,
    live: overrides.live ?? false,
    toolCallId: null,
    inputRaw: null,
  };
}

/** Group the items and hand back THE one turn group (the real partition,
 *  exercised — the plan rides the same grouping the screen renders). */
function singleTurn(items: TranscriptItem[]): TurnGroup {
  const rows = groupDisplayRows(items);
  const only = rows[0];
  if (rows.length !== 1 || only === undefined || only.kind !== "turn") {
    throw new Error(`expected exactly one turn group, got ${rows.length} rows`);
  }
  return only;
}

/** The separated-elements plan off a real grouping + the pref. */
function planOf(items: TranscriptItem[], activity: ToolActivity = "detailed"): TurnElementsPlan {
  return turnElementsPlan(singleTurn(items), activity);
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

// ── R129-M/R130 — the separated-elements plan (the render contract) ───────

describe("R129-M/R130 — the text is FLAT (no container, no bubble, no surface)", () => {
  it("the turn container carries NO surface — the text elements ride the flat turn column", () => {
    const plan = planOf([
      assistantItem("a1", { thinking: "hmm", thinkingMs: 8_000 }),
      toolItem("t1"),
      assistantItem("a2", { content: "done" }),
    ]);
    expect(plan.containerSurface).toBeNull();
    const texts = plan.elements.filter((el) => el.element === "text");
    expect(texts.length).toBeGreaterThan(0);
  });

  it("a turn with NO text content renders NO text element (the thinking-only turn keeps its clean shape)", () => {
    const plan = planOf([assistantItem("a1", { thinking: "hmm", thinkingMs: 8_000 })]);
    expect(plan.elements.some((el) => el.element === "text")).toBe(false);
  });
});

describe("R129-M — the thinking row is its own SIBLING element (never nested with the tool groups)", () => {
  it("rail → thinking → tool group → text, all SIBLINGS in ONE flat element list — the owner's 'combined with the tool cards' verdict dies here", () => {
    const plan = planOf([
      assistantItem("a1", { thinking: "planning", thinkingMs: 3_000 }),
      toolItem("t1", { toolName: "write_file", argsSummary: "path: src/a.ts, content: x" }),
      toolItem("t2", { toolName: "run_command", argsSummary: "command: npm test" }),
      assistantItem("a2", { content: "done" }),
    ]);
    expect(plan.elements.map((el) => el.element)).toEqual([
      "rail",
      "thinking",
      "tool-group",
      "text",
    ]);
    // SIBLINGS by construction: every element rides the SAME flat list (the
    // plan's vocabulary carries no wrapper/well element at all), and the
    // thinking text lives OUTSIDE every tool group.
    const thinking = plan.elements.find((el) => el.element === "thinking");
    expect(thinking?.element === "thinking" && thinking.text).toBe("planning");
    const group = plan.elements.find((el) => el.element === "tool-group");
    expect(group?.keys).toEqual(["t1", "t2"]);
  });

  it("a turn with NO thinking renders NO thinking row (the groups render without one)", () => {
    const plan = planOf([toolItem("t1"), assistantItem("a1", { content: "done" })]);
    expect(plan.elements.map((el) => el.element)).toEqual(["rail", "tool-group", "text"]);
  });

  it("the label grammar — Thinking… live / Thought for 8s settled / Thought process when the wire carried no span", () => {
    const settled = planOf([assistantItem("a1", { thinking: "hmm", thinkingMs: 8_000 })]);
    const settledLabel = settled.elements.find((el) => el.element === "thinking");
    expect(settledLabel?.element === "thinking" && settledLabel.label).toBe("Thought for 8s");

    const noSpan = planOf([assistantItem("a1", { thinking: "hmm" })]);
    const noSpanLabel = noSpan.elements.find((el) => el.element === "thinking");
    expect(noSpanLabel?.element === "thinking" && noSpanLabel.label).toBe("Thought process");

    const live = planOf([assistantItem("a1", { thinking: "hmm", live: true, chunks: [] })]);
    const liveLabel = live.elements.find((el) => el.element === "thinking");
    expect(liveLabel?.element === "thinking" && liveLabel.label).toBe("Thinking…");
  });

  it("the thinking row's default open state: live-open (the stream IS the activity), settled-collapsed (the R124 wall verdict stands)", () => {
    const live = planOf([assistantItem("a1", { thinking: "hmm", live: true, chunks: [] })]);
    const liveRow = live.elements.find((el) => el.element === "thinking");
    expect(liveRow?.element === "thinking" && liveRow.defaultOpen).toBe(true);

    const settled = planOf([assistantItem("a1", { thinking: "hmm", thinkingMs: 8_000 })]);
    const settledRow = settled.elements.find((el) => el.element === "thinking");
    expect(settledRow?.element === "thinking" && settledRow.defaultOpen).toBe(false);
  });
});

describe("R130 — EMISSION-ORDER INTERLEAVING (the text renders WHERE IT WAS RECEIVED)", () => {
  it("text BETWEEN two tool runs renders BETWEEN them — never all tools at the top with the text at the bottom", () => {
    const plan = planOf([
      toolItem("t1", { toolName: "read_file", argsSummary: "path: src/a.ts" }),
      toolItem("t2", { toolName: "read_file", argsSummary: "path: src/b.ts" }),
      assistantItem("a1", { content: "I read both files." }),
      toolItem("t3", { toolName: "run_command", argsSummary: "command: npm test" }),
      assistantItem("a2", { content: "The tests pass." }),
    ]);
    expect(plan.elements.map((el) => el.element)).toEqual([
      "rail",
      "tool-group",
      "text",
      "tool-group",
      "text",
    ]);
    // The runs fold correctly: two consecutive read calls are ONE group;
    // the later command is its own group BETWEEN the two text runs.
    const [first, second] = plan.elements.filter((el) => el.element === "tool-group");
    expect(first?.keys).toEqual(["t1", "t2"]);
    expect(second?.keys).toEqual(["t3"]);
    // The meta line rides the FIRST text element only.
    const [textA, textB] = plan.elements.filter((el) => el.element === "text");
    expect(textA?.showMeta).toBe(true);
    expect(textB?.showMeta).toBe(false);
    expect(textA?.keys).toEqual(["a1"]);
    expect(textB?.keys).toEqual(["a2"]);
  });

  it("a thinking-only item neither starts a text run nor breaks a tool run — mid-turn thinking keeps the calls in ONE group", () => {
    const plan = planOf([
      toolItem("t1"),
      assistantItem("a-think", { thinking: "reconsidering" }),
      toolItem("t2"),
      assistantItem("a1", { content: "done" }),
    ]);
    const groups = plan.elements.filter((el) => el.element === "tool-group");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.keys).toEqual(["t1", "t2"]);
  });

  it("consecutive text segments fold into ONE text element (the segment keys in order)", () => {
    const plan = planOf([
      assistantItem("a1", { content: "first" }),
      assistantItem("a2", { content: "second" }),
    ]);
    const texts = plan.elements.filter((el) => el.element === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0]?.keys).toEqual(["a1", "a2"]);
  });
});

describe("R130 — the tool groups' geometry + lifecycle (the PC Working-fold grammar, ported)", () => {
  it("the house CARD padding (12 = spacing.md), the r12 radius, the 8px gaps between groups, and the 2.5s auto-collapse hold", () => {
    const plan = planOf([toolItem("t1"), toolItem("t2")]);
    expect(plan.toolGroupPadding).toBe(12);
    expect(plan.toolGroupPadding).toBe(spacing.md);
    expect(plan.toolGroupRadius).toBe(12);
    expect(plan.toolGroupGap).toBe(8);
    expect(plan.toolGroupGap).toBe(spacing.sm);
    expect(plan.toolGroupCollapseHoldMs).toBe(2500);
  });

  it("COLLAPSED when settled — the owner's explicit ask (the R123-W-m open-by-default law is retired)", () => {
    const plan = planOf([
      toolItem("t1"),
      toolItem("t2"),
      toolItem("t3"),
    ]);
    for (const group of plan.elements.filter((el) => el.element === "tool-group")) {
      if (group.element !== "tool-group") throw new Error("expected a tool-group element");
      expect(group.defaultOpen).toBe(false);
      expect(group.live).toBe(false);
    }
  });

  it("OPEN while the turn is live (the seeing, scoped to live)", () => {
    const plan = planOf([
      assistantItem("a1", { live: true, chunks: [] }),
      toolItem("t1", { ok: null, live: true }),
    ]);
    const group = plan.elements.find((el) => el.element === "tool-group");
    expect(group?.element === "tool-group" && group.defaultOpen).toBe(true);
    expect(group?.element === "tool-group" && group.live).toBe(true);
    expect(group?.element === "tool-group" && group.hasRunning).toBe(true);
  });

  it("a group holding a FAILED call stays open (failures never auto-collapse)", () => {
    const plan = planOf([
      toolItem("t1", { ok: false }),
      toolItem("t2", { ok: true }),
    ]);
    const group = plan.elements.find((el) => el.element === "tool-group");
    expect(group?.element === "tool-group" && group.hasFailed).toBe(true);
    expect(group?.element === "tool-group" && group.defaultOpen).toBe(true);
  });

  it("a thinking-only turn renders no groups — the thinking row keeps its own settled collapse (the R124 law stands)", () => {
    const plan = planOf([assistantItem("a1", { thinking: "hmm" })]);
    expect(plan.elements.some((el) => el.element === "tool-group")).toBe(false);
    const row = plan.elements.find((el) => el.element === "thinking");
    expect(row?.element === "thinking" && row.defaultOpen).toBe(false);
  });
});

describe("R129-M — the rail is a PLAIN line (no chevron, no expand, never a control)", () => {
  it("the rail carries the glance summary and NO control grammar — no chevron, not pressable, no expand of its own", () => {
    const plan = planOf([
      assistantItem("a1", { thinking: "hmm", thinkingMs: 8_000 }),
      toolItem("t1", { toolName: "write_file", argsSummary: "path: src/a.ts, content: x" }),
      toolItem("t2", { toolName: "run_command", argsSummary: "command: npm test" }),
    ]);
    const rail = plan.elements.find((el) => el.element === "rail");
    if (rail?.element !== "rail") throw new Error("expected the rail element");
    expect(rail.isControl).toBe(false);
    expect(rail.hasChevron).toBe(false);
    expect(rail.summary).toBe("Thought for 8s · 2 actions · src/a.ts, npm test");
  });

  it("a turn with NO activity at all renders NO rail (the clean document)", () => {
    const plan = planOf([assistantItem("a1", { content: "hi" })]);
    expect(plan.elements.some((el) => el.element === "rail")).toBe(false);
  });

  it("the rail breathes only while the turn WORKS — never once text streams (the shared LiveCaret owns the motion)", () => {
    const liveThinking = planOf([assistantItem("a1", { thinking: "hmm", live: true, chunks: [] })]);
    const breathing = liveThinking.elements.find((el) => el.element === "rail");
    expect(breathing?.element === "rail" && breathing.breathes).toBe(true);

    const liveWriting = planOf([assistantItem("a1", { live: true, chunks: ["done"] })]);
    const writing = liveWriting.elements.find((el) => el.element === "rail");
    expect(writing?.element === "rail" && writing.breathes).toBe(false);
    expect(writing?.element === "rail" && writing.summary).toBe("Writing…");

    const settled = planOf([assistantItem("a1", { thinking: "hmm", thinkingMs: 8_000 })]);
    const still = settled.elements.find((el) => el.element === "rail");
    expect(still?.element === "rail" && still.breathes).toBe(false);
  });

  it("the rail's LIVE states are unchanged — the RUNNING tool's verb owns the ONE line", () => {
    const plan = planOf([
      assistantItem("a1", { live: true, chunks: [] }),
      toolItem("t1", { toolName: "read_file", argsSummary: "path: src/a.ts", ok: null, live: true }),
    ]);
    const rail = plan.elements.find((el) => el.element === "rail");
    expect(rail?.element === "rail" && rail.summary).toBe("Reading src/a.ts…");
  });
});

describe("R129-M/R130 — the toolActivity pref matrix against the separated shapes", () => {
  it("detailed: the full anatomy — every group expandable, COLLAPSED when settled (the fold is a deliberate look)", () => {
    const plan = planOf([toolItem("t1"), assistantItem("a1", { content: "done" })], "detailed");
    const groups = plan.elements.filter((el) => el.element === "tool-group");
    expect(groups).toHaveLength(1);
    for (const group of groups) {
      if (group.element !== "tool-group") throw new Error("expected a tool-group element");
      expect(group.expandable).toBe(true);
      expect(group.defaultOpen).toBe(false);
    }
  });

  it("compact: ONE-LINE rows, no expansion — the details never render", () => {
    const plan = planOf([toolItem("t1"), assistantItem("a1", { content: "done" })], "compact");
    const groups = plan.elements.filter((el) => el.element === "tool-group");
    expect(groups).toHaveLength(1);
    for (const group of groups) {
      if (group.element !== "tool-group") throw new Error("expected a tool-group element");
      expect(group.expandable).toBe(false);
    }
  });

  it("hidden: NO tool groups at all — the rail only while thinking text exists (the clean document), the text stays flat and IN ORDER", () => {
    // With thinking: the rail reads the honest thinking word and never
    // teases a count the groups will not show.
    const withThinking = planOf(
      [
        assistantItem("a1", { thinking: "hmm", thinkingMs: 8_000 }),
        toolItem("t1"),
        assistantItem("a2", { content: "done" }),
      ],
      "hidden",
    );
    expect(withThinking.elements.map((el) => el.element)).toEqual(["rail", "thinking", "text"]);
    const rail = withThinking.elements.find((el) => el.element === "rail");
    expect(rail?.element === "rail" && rail.summary).toBe("Thought for 8s");
    // Without thinking: the clean document — no rail, no groups, no thinking
    // row; only the flat text.
    const clean = planOf([toolItem("t1"), assistantItem("a1", { content: "done" })], "hidden");
    expect(clean.elements.map((el) => el.element)).toEqual(["text"]);
    // Interleaved text under hidden merges into ONE flat element — the
    // invisible calls never break the text runs (the emission order never
    // collapses what the user can see; the segments keep their keys in
    // order, separated by the house segment gap at render).
    const interleaved = planOf(
      [toolItem("t1"), assistantItem("a1", { content: "first" }), toolItem("t2"), assistantItem("a2", { content: "second" })],
      "hidden",
    );
    expect(interleaved.elements.map((el) => el.element)).toEqual(["text"]);
    const texts = interleaved.elements.filter((el) => el.element === "text");
    expect(texts[0]?.keys).toEqual(["a1", "a2"]);
  });
});

describe("R130 — the tool group label's grammar (toolGroupLabel, pure)", () => {
  it("a single call speaks its own row title (the row IS the fold head)", () => {
    const plan = planOf([
      toolItem("t1", { toolName: "read_file", argsSummary: "path: src/a.ts" }),
    ]);
    const group = plan.elements.find((el) => el.element === "tool-group");
    expect(group?.element === "tool-group" && group.label).toBe("read file · src/a.ts");
  });

  it("a run of calls speaks the count + the family glance (top two families, plural counts)", () => {
    const plan = planOf([
      toolItem("t1", { toolName: "read_file", argsSummary: "path: src/a.ts" }),
      toolItem("t2", { toolName: "read_file", argsSummary: "path: src/b.ts" }),
      toolItem("t3", { toolName: "run_command", argsSummary: "command: npm test" }),
    ]);
    const group = plan.elements.find((el) => el.element === "tool-group");
    expect(group?.element === "tool-group" && group.label).toBe("3 calls · 2 read · run");
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
