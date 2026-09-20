/**
 * chat-prefs.test.ts — R114-d: the appearance domain's four chat prefs,
 * mapped to the pure numbers/folds the transcript consumes (features/
 * chat-prefs.ts — the useChatPrefs hook resolves the synced values; these
 * are the render contracts they drive). Zero React Native.
 */

import { describe, expect, it } from "@jest/globals";

import {
  densityVerticalPadding,
  foldToolActivity,
  messageClock,
  textSizeScale,
  timestampsVisible,
  toolActivityVisibility,
} from "../chat-prefs";
import type { TranscriptItem } from "../sessions";

// ── density / text size / timestamps ────────────────────────────────────────

describe("chat-prefs — density + text size + timestamps", () => {
  it("comfortable keeps the house card padding; compact halves it", () => {
    expect(densityVerticalPadding("comfortable")).toBe(12);
    expect(densityVerticalPadding("compact")).toBe(6);
  });

  it("the text-size ladder scales the body (small 0.92 · medium 1.0 · large 1.08)", () => {
    expect(textSizeScale("small")).toBe(0.92);
    expect(textSizeScale("medium")).toBe(1);
    expect(textSizeScale("large")).toBe(1.08);
  });

  it("timestamps render only in hover mode (hidden omits entirely)", () => {
    expect(timestampsVisible("hover")).toBe(true);
    expect(timestampsVisible("hidden")).toBe(false);
  });

  it("messageClock answers the hour:minute or nothing (never a guess, never a crash)", () => {
    expect(messageClock(null)).toBeNull();
    expect(messageClock("  ")).toBeNull();
    expect(messageClock("not a date")).toBeNull();
    const clock = messageClock("2026-09-18T11:04:00Z");
    expect(clock).not.toBeNull();
    expect(clock ?? "").toMatch(/^\d{1,2}:\d{2}/);
  });
});

// ── tool activity ───────────────────────────────────────────────────────────

describe("chat-prefs — toolActivity visibility", () => {
  it("detailed → expandable cards; compact → always-collapsed rows; hidden → folded away", () => {
    expect(toolActivityVisibility("detailed")).toEqual({
      expandable: true,
      collapsedRows: false,
      hidden: false,
    });
    expect(toolActivityVisibility("compact")).toEqual({
      expandable: false,
      collapsedRows: true,
      hidden: false,
    });
    expect(toolActivityVisibility("hidden")).toEqual({
      expandable: false,
      collapsedRows: false,
      hidden: true,
    });
  });
});

function toolItem(key: string, ok: boolean | null): TranscriptItem {
  return {
    kind: "tool",
    key,
    toolName: "run_command",
    argsSummary: "command: pnpm test",
    ok,
    outputSummary: null,
    outputTail: null,
    live: ok === null,
    toolCallId: null,
    inputRaw: null,
  };
}

describe("chat-prefs — foldToolActivity (the hidden fold)", () => {
  const items: TranscriptItem[] = [
    { kind: "user", key: "u1", content: "go", queued: false, attachments: null, ts: null },
    toolItem("t1", true),
    toolItem("t2", true),
    toolItem("t3", null), // still running
    { kind: "assistant", key: "a1", content: "done", thinking: null, model: null, chunks: null, live: false, ts: null },
    toolItem("t4", false),
  ];

  it("detailed + compact pass the items through UNCHANGED (the cards render them)", () => {
    expect(foldToolActivity(items, "detailed")).toBe(items);
    expect(foldToolActivity(items, "compact")).toBe(items);
  });

  it("hidden folds each RUN of consecutive tools into ONE quiet meta line", () => {
    const folded = foldToolActivity(items, "hidden");
    expect(folded.map((item) => item.kind)).toEqual(["user", "meta", "assistant", "meta"]);
    const first = folded[1];
    expect(first?.kind === "meta" && first.text).toBe("· 3 tool calls · running");
    const second = folded[3];
    expect(second?.kind === "meta" && second.text).toBe("· 1 tool call");
  });

  it("the running marker is honest — a fully settled run reads plain", () => {
    const settled: TranscriptItem[] = [toolItem("t1", true), toolItem("t2", false)];
    const folded = foldToolActivity(settled, "hidden");
    expect(folded).toHaveLength(1);
    expect(folded[0]?.kind === "meta" && folded[0].text).toBe("· 2 tool calls");
  });

  it("non-tool items never merge, and an empty list stays empty", () => {
    const mixed: TranscriptItem[] = [
      toolItem("t1", true),
      { kind: "meta", key: "m1", text: "round 2" },
      toolItem("t2", true),
    ];
    const folded = foldToolActivity(mixed, "hidden");
    expect(folded.map((item) => item.kind)).toEqual(["meta", "meta", "meta"]);
    expect(folded[0]?.kind === "meta" && folded[0].text).toBe("· 1 tool call");
    expect(folded[2]?.kind === "meta" && folded[2].text).toBe("· 1 tool call");
    expect(foldToolActivity([], "hidden")).toEqual([]);
  });
});
