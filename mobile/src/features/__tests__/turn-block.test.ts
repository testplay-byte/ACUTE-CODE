/**
 * turn-block.test.ts — R119-A: the §N center rethink's display-layer pins
 * (features/turn-block.ts — the pure math behind ONE VISUAL TURN PER
 * EXCHANGE). The owner's verdict — thinking / tool call / failed tool call
 * "each get a proper card of itself, which makes the whole interface bad…
 * everything looks ugly" — dies in three pure laws, each pinned here:
 *   · orderDisplayItems — the QUEUED-AFTER-TURN LAW (round-119 §1 item 7):
 *     every STILL-QUEUED user row renders AFTER everything else — in
 *     particular after the in-progress turn's items — and delivered rows
 *     never move.
 *   · groupDisplayRows — the TURN PARTITION: consecutive assistant/thinking/
 *     tool items fold into ONE TurnGroup keyed by its FIRST item's key
 *     (stable inverted-list recycling); every other kind splits the run and
 *     renders as its own row.
 *   · activitySummary / turnActivityFacts / turnBlockA11yLabel — the rail's
 *     collapsed string table ("Thought for 8s · 3 actions", the live
 *     "Thinking…" / running-verb words, the failure count) + the block's ONE
 *     accessible container label, both pref-shaped (hidden never teases a
 *     count the well will not show).
 * Plus the tool-line word helpers the rail + the well's rows share
 * (humanizeToolName, writePath, writeLineDiff's +A/−B parser,
 * genericOneLineSummary, readTargetSegment, runningToolWord). Zero React
 * Native — the module is pure TypeScript, unit-tested directly.
 *
 * ROUND-123 (R123-W-m — the web families' honest rows): webTargetSegment /
 * browserTargetSegment + their toolRowTitle / runningToolWord / toolHint
 * pins — browser_control / web_search / web_fetch read their own
 * action/query/url targets, never the raw key:value dump (the shapeless
 * generic rendering behind the owner's "no tool calls were shown to me").
 */

import { describe, expect, it } from "@jest/globals";

import {
  activitySummary,
  browserTargetSegment,
  genericOneLineSummary,
  groupDisplayRows,
  humanizeToolName,
  orderDisplayItems,
  readTargetSegment,
  runningToolWord,
  thinkingRowLabel,
  TOOL_HINT_MAX,
  toolHint,
  toolHintList,
  toolRowTitle,
  turnActivityFacts,
  turnBlockA11yLabel,
  turnReplyText,
  turnThinkingText,
  turnThoughtMs,
  webTargetSegment,
  writeLineDiff,
  writePath,
  type ToolItem,
  type TurnActivityFacts,
  type TurnGroup,
} from "../turn-block";
import type { TranscriptItem } from "../sessions";

// ── fixtures (the item stream's minimal honest shapes) ──────────────────────

function userItem(
  key: string,
  overrides: Partial<{ content: string; queued: boolean }> = {},
): TranscriptItem {
  return {
    kind: "user",
    key,
    content: overrides.content ?? "do the thing",
    queued: overrides.queued ?? false,
    attachments: null,
    ts: null,
  };
}

function assistantItem(
  key: string,
  overrides: Partial<{
    content: string;
    thinking: string | null;
    thinkingMs?: number | null;
    model: string | null;
    chunks: string[] | null;
    live: boolean;
  }> = {},
): TranscriptItem & { kind: "assistant" } {
  return {
    kind: "assistant",
    key,
    content: overrides.content ?? "",
    thinking: overrides.thinking ?? null,
    model: overrides.model ?? null,
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
    outputSummary: string | null;
    outputTail: string | null;
    live: boolean;
    inputRaw: string | null;
  }> = {},
): ToolItem {
  return {
    kind: "tool",
    key,
    toolName: overrides.toolName ?? "run_command",
    argsSummary: overrides.argsSummary ?? "",
    // `?? true` would swallow an EXPLICIT ok:null (nullish) — the running
    // state — so the default only applies when the field is absent.
    ok: overrides.ok === undefined ? true : overrides.ok,
    outputSummary: overrides.outputSummary ?? null,
    outputTail: overrides.outputTail ?? null,
    live: overrides.live ?? false,
    toolCallId: null,
    inputRaw: overrides.inputRaw ?? null,
  };
}

/** The rail's facts, built directly (the string table's own input). */
function railFacts(overrides: Partial<TurnActivityFacts> = {}): TurnActivityFacts {
  return {
    thoughtMs: null,
    hasThinking: false,
    toolCount: 0,
    failedCount: 0,
    live: false,
    runningToolWord: null,
    writing: false,
    toolHints: [],
    ...overrides,
  };
}

/** Group the items and hand back THE one turn group (or throw — the pin
 * itself asserts the partition elsewhere; this keeps the narrowing honest). */
function singleTurn(items: TranscriptItem[]): TurnGroup {
  const rows = groupDisplayRows(items);
  const only = rows[0];
  if (rows.length !== 1 || only === undefined || only.kind !== "turn") {
    throw new Error(`expected exactly one turn group, got ${rows.length} rows`);
  }
  return only;
}

// ── the tool-line word helpers ──────────────────────────────────────────────

describe("turn-block — the tool-line word helpers", () => {
  it("humanizeToolName swaps every underscore for a space (the rows' leading verb)", () => {
    expect(humanizeToolName("run_command")).toBe("run command");
    expect(humanizeToolName("write_file")).toBe("write file");
    expect(humanizeToolName("read_skill_v2")).toBe("read skill v2");
    expect(humanizeToolName("bash")).toBe("bash");
    expect(humanizeToolName("")).toBe("");
  });

  it("writePath prefers the streaming raw's path arg, tolerates the file_path spelling, else the settled argsSummary's path segment", () => {
    // live: the raw carries the path before the args complete
    expect(
      writePath(toolItem("t1", { inputRaw: '{"path":"src/a.ts","content":"const x' })),
    ).toBe("src/a.ts");
    // live: the spec's file_path spelling answers too (the truth wins)
    expect(
      writePath(toolItem("t2", { inputRaw: '{"file_path":"src/b.ts","content":"' })),
    ).toBe("src/b.ts");
    // live but path-less raw → the settled summary's "path:" segment
    expect(
      writePath(toolItem("t3", { inputRaw: '{"content":"x"', argsSummary: "path: src/c.ts" })),
    ).toBe("src/c.ts");
    // settled: the argsSummary alone (path-first unchanged)
    expect(writePath(toolItem("t4", { argsSummary: "path: src/d.ts, mode: overwrite" }))).toBe(
      "src/d.ts",
    );
    // neither source carries a path → null (never a guess)
    expect(writePath(toolItem("t5", { argsSummary: "command: pnpm test" }))).toBeNull();
    expect(writePath(toolItem("t6", { inputRaw: '{"content":"x"' }))).toBeNull();
    // R128-W6 — a path segment that is NOT the summary's head now MATCHES
    // (the unanchored scan; the old ^ law is retired with the bug it hid).
    expect(writePath(toolItem("t7", { argsSummary: "command: ls, path: nope.ts" }))).toBe(
      "nope.ts",
    );
  });

  // R128-W6 — the writePath robustness pin: the server's summarizeArgs
  // orders its segments by the MODEL's JSON key order, so an edit_file
  // emitted as {oldString, newString, path} yields the path LAST — the row
  // used to lose its file name (the leading-`path:` requirement never fired).
  it("R128-W6: an edit_file emitted as {oldString, newString, path} still yields the path — the scan is unanchored", () => {
    // The exact summarizeArgs shape for that key order (values capped at 80
    // chars, content/newString rendered as "N chars").
    expect(
      writePath(
        toolItem("e1", {
          toolName: "edit_file",
          argsSummary: "oldString: const x = 1;, newString: 12 chars, path: src/a.ts",
        }),
      ),
    ).toBe("src/a.ts");
    // A longer, more realistic edit summary — the path still answers.
    expect(
      writePath(
        toolItem("e2", {
          toolName: "edit_file",
          argsSummary:
            "oldString: export function writePath(item: ToolItem): string | null {, newString: 180 chars, path: mobile/src/features/turn-block.ts",
        }),
      ),
    ).toBe("mobile/src/features/turn-block.ts");
    // First occurrence wins — a second "path:" segment never overrides it.
    expect(
      writePath(toolItem("e3", { argsSummary: "path: first.ts, mode: overwrite" })),
    ).toBe("first.ts");
    // The documented first-occurrence tolerance: "path:" embedded in a
    // LONGER lowercase key (filepath) still answers — and its value is the
    // path anyway (camelCase keys like newPath carry a capital P and never
    // match — the scan is case-sensitive like every segment helper here).
    expect(
      writePath(toolItem("e3b", { argsSummary: "filepath: src/renamed.ts, content: 12 chars" })),
    ).toBe("src/renamed.ts");
    expect(
      writePath(toolItem("e3c", { argsSummary: "newPath: src/renamed.ts, content: 12 chars" })),
    ).toBeNull();
    // No "path:" anywhere → null as today.
    expect(
      writePath(toolItem("e4", { argsSummary: "command: pnpm test, action: run" })),
    ).toBeNull();
  });

  it("writeLineDiff parses the server's own edit confirmation — the ASCII plus, the U+2212 minus, the pinned shape", () => {
    const edited = "Edited 'src/a.ts': 2 replacements, +12 −3 lines";
    expect(
      writeLineDiff(toolItem("t1", { ok: true, outputSummary: edited })),
    ).toEqual({ added: 12, removed: 3 });
    // the singular spelling rides the same shape
    expect(
      writeLineDiff(toolItem("t2", { ok: true, outputSummary: "1 replacement, +1 −1 lines" })),
    ).toEqual({ added: 1, removed: 1 });
    // a plain write never parses (the byte summary carries that story)
    expect(
      writeLineDiff(toolItem("t3", { ok: true, outputSummary: "wrote 120 bytes to 'src/a.ts'" })),
    ).toBeNull();
    // running / failed / summary-less calls never chip
    expect(writeLineDiff(toolItem("t4", { ok: null, outputSummary: edited }))).toBeNull();
    expect(writeLineDiff(toolItem("t5", { ok: false, outputSummary: edited }))).toBeNull();
    expect(writeLineDiff(toolItem("t6", { ok: true, outputSummary: null }))).toBeNull();
    // lookalikes never lie: an ASCII hyphen is NOT the server glyph…
    expect(
      writeLineDiff(toolItem("t7", { ok: true, outputSummary: "2 replacements, +12 -3 lines" })),
    ).toBeNull();
    // …and neither is a missing " lines" suffix or a shape-less fragment
    expect(
      writeLineDiff(toolItem("t8", { ok: true, outputSummary: "2 replacements, +12 −3" })),
    ).toBeNull();
    expect(
      writeLineDiff(toolItem("t9", { ok: true, outputSummary: "+12 −3 lines" })),
    ).toBeNull();
  });

  it("genericOneLineSummary strips the terminal family's command: prefix; every other family reads verbatim", () => {
    expect(
      genericOneLineSummary(toolItem("t1", { toolName: "run_command", argsSummary: "command: pnpm test" })),
    ).toBe("pnpm test");
    // the terminal family without the prefix falls back to the whole summary
    expect(
      genericOneLineSummary(toolItem("t2", { toolName: "bash", argsSummary: "ls -la" })),
    ).toBe("ls -la");
    // non-terminal: verbatim (the row adds its own verb)
    expect(genericOneLineSummary(toolItem("t3", { argsSummary: "path: src/a.ts" }))).toBe(
      "path: src/a.ts",
    );
    expect(genericOneLineSummary(toolItem("t4", { argsSummary: "" }))).toBe("");
  });

  it("readTargetSegment strips the first segment's key and trims (the read family's one-line target)", () => {
    expect(readTargetSegment(toolItem("t1", { argsSummary: "path: src/a.ts" }))).toBe("src/a.ts");
    expect(
      readTargetSegment(toolItem("t2", { argsSummary: "name: build.md, size: 2" })),
    ).toBe("build.md");
    // extra whitespace after the colon is tolerated
    expect(readTargetSegment(toolItem("t3", { argsSummary: "path:   spaced.ts" }))).toBe(
      "spaced.ts",
    );
    // no key at all → the segment itself (honest pass-through)
    expect(readTargetSegment(toolItem("t4", { argsSummary: "src/plain.ts" }))).toBe("src/plain.ts");
    expect(readTargetSegment(toolItem("t5", { argsSummary: "" }))).toBe("");
  });

  it("runningToolWord — the rail's LIVE verb per family (write keeps Writing/Editing, terminal leads with its command, read with its target, the web pair with its query/url, the browser with its url/action, else the humanized verb)", () => {
    expect(
      runningToolWord(
        toolItem("t1", { toolName: "write_file", ok: null, inputRaw: '{"path":"src/a.ts","content":"' }),
      ),
    ).toBe("Writing src/a.ts…");
    expect(
      runningToolWord(
        toolItem("t2", { toolName: "edit_file", ok: null, inputRaw: '{"path":"src/e.ts","newString":"' }),
      ),
    ).toBe("Editing src/e.ts…");
    // a write with no path yet stays honest — the bare verb
    expect(
      runningToolWord(toolItem("t3", { toolName: "write_file", ok: null, inputRaw: '{"content":"' })),
    ).toBe("Writing…");
    expect(
      runningToolWord(toolItem("t4", { toolName: "write_file", ok: null, argsSummary: "" })),
    ).toBe("Writing…");
    expect(
      runningToolWord(toolItem("t5", { toolName: "run_command", ok: null, argsSummary: "command: pnpm test" })),
    ).toBe("Running pnpm test…");
    expect(
      runningToolWord(toolItem("t6", { toolName: "bash", ok: null, argsSummary: "" })),
    ).toBe("Running…");
    expect(
      runningToolWord(toolItem("t7", { toolName: "read_file", ok: null, argsSummary: "path: src/a.ts" })),
    ).toBe("Reading src/a.ts…");
    expect(
      runningToolWord(toolItem("t8", { toolName: "read_skill", ok: null, argsSummary: "" })),
    ).toBe("Reading…");
    // R123-W-m — the web pair's own verbs (live off the raw, settled off the summary)
    expect(
      runningToolWord(
        toolItem("tw1", { toolName: "web_search", ok: null, inputRaw: '{"query":"rust async' }),
      ),
    ).toBe("Searching rust async…");
    expect(
      runningToolWord(toolItem("tw2", { toolName: "web_search", ok: null, argsSummary: "" })),
    ).toBe("Searching…");
    expect(
      runningToolWord(
        toolItem("tw3", { toolName: "web_fetch", ok: null, argsSummary: "url: https://docs.foo.dev" }),
      ),
    ).toBe("Fetching https://docs.foo.dev…");
    // R123-W-m — the browser family: the URL leads while one rides, else the action word
    expect(
      runningToolWord(
        toolItem("tb1", {
          toolName: "browser_control",
          ok: null,
          inputRaw: '{"action":"navigate","url":"https://exam',
        }),
      ),
    ).toBe("Browsing https://exam…");
    expect(
      runningToolWord(
        toolItem("tb2", { toolName: "browser_control", ok: null, argsSummary: "action: read_dom" }),
      ),
    ).toBe("read_dom…");
    expect(
      runningToolWord(toolItem("tb3", { toolName: "browser_control", ok: null, argsSummary: "" })),
    ).toBe("Browsing…");
    // the generic fallback — the humanized verb alone
    expect(
      runningToolWord(toolItem("t9", { toolName: "search_web", ok: null })),
    ).toBe("search web…");
  });

  it("R123-W-m — webTargetSegment / browserTargetSegment: the honest targets, live-first then settled, never a guess", () => {
    // web_search's query — live raw wins while one streams
    expect(
      webTargetSegment(
        toolItem("w1", { toolName: "web_search", inputRaw: '{"query":"tokio spawn"' }),
      ),
    ).toBe("tokio spawn");
    // settled: the argsSummary's own query segment (a later segment never bleeds in)
    expect(
      webTargetSegment(toolItem("w2", { toolName: "web_search", argsSummary: "query: react compiler, max: 8" })),
    ).toBe("react compiler");
    // web_fetch's url — settled, commas inside the value read WHOLE
    expect(
      webTargetSegment(
        toolItem("w3", { toolName: "web_fetch", argsSummary: "url: https://x.dev/a?b=1, c: no" }),
      ),
    ).toBe("https://x.dev/a?b=1");
    // neither source carries one → "" (never a guess)
    expect(webTargetSegment(toolItem("w4", { toolName: "web_search", argsSummary: "" }))).toBe("");
    expect(
      webTargetSegment(toolItem("w5", { toolName: "web_search", inputRaw: '{"max":' })),
    ).toBe("");
    // browser_control: action + url (live or settled)
    expect(
      browserTargetSegment(
        toolItem("b1", {
          toolName: "browser_control",
          inputRaw: '{"action":"navigate","url":"https://example.com",',
        }),
      ),
    ).toBe("navigate https://example.com");
    expect(
      browserTargetSegment(
        toolItem("b2", { toolName: "browser_control", argsSummary: "action: click, selector: #go" }),
      ),
    ).toBe("click");
    // no action anywhere → "" (the row falls back to the family noun)
    expect(browserTargetSegment(toolItem("b3", { toolName: "browser_control", argsSummary: "" }))).toBe("");
  });
});

// ── the turn partition ──────────────────────────────────────────────────────

describe("turn-block — groupDisplayRows (the turn partition)", () => {
  it("an empty stream groups into nothing", () => {
    expect(groupDisplayRows([])).toEqual([]);
  });

  it("ONE run of consecutive assistant/thinking/tool items becomes ONE TurnGroup — the §N verdict's whole answer", () => {
    const marker = { kind: "thinking" as const, key: "live-thinking", model: "glm-5.2" };
    const rows = groupDisplayRows([
      marker,
      toolItem("t1", { ok: true }),
      toolItem("t2", { ok: false }),
      assistantItem("a1", { content: "done" }),
    ]);
    expect(rows).toHaveLength(1);
    const group = rows[0];
    expect(group?.kind).toBe("turn");
    if (group?.kind !== "turn") return;
    // the group's key = its FIRST item's key (stable recycling across frames)
    expect(group.key).toBe("live-thinking");
    expect(group.items).toHaveLength(4);
    expect(group.items.map((item) => item.key)).toEqual(["live-thinking", "t1", "t2", "a1"]);
    // the synthetic marker makes the run pending + live (the breathing rail)
    expect(group.pending).toBe(true);
    expect(group.live).toBe(true);
    // the marker's own model resolves the turn (never a guess)
    expect(group.model).toBe("glm-5.2");
  });

  it("a user item splits the run — every exchange gets its own block", () => {
    const rows = groupDisplayRows([
      userItem("u1"),
      assistantItem("a1", { content: "first answer" }),
      toolItem("t1", { ok: true }),
      userItem("u2", { content: "again" }),
      assistantItem("a2", { content: "second answer" }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["item", "turn", "item", "turn"]);
    expect(rows.map((row) => row.key)).toEqual(["u1", "a1", "u2", "a2"]);
    const first = rows[1];
    if (first?.kind !== "turn") throw new Error("expected a turn");
    expect(first.items.map((item) => item.key)).toEqual(["a1", "t1"]);
    const second = rows[3];
    if (second?.kind !== "turn") throw new Error("expected a turn");
    expect(second.items.map((item) => item.key)).toEqual(["a2"]);
  });

  it("every interactive/terminal kind splits the run and rides its own row in place (standalone, never narration)", () => {
    const splitters: TranscriptItem[] = [
      userItem("sp-user"),
      { kind: "error", key: "sp-error", code: "E_TOOL", message: "the call failed" },
      {
        kind: "approval",
        key: "sp-approval",
        approvalId: "ap1",
        toolName: "run_command",
        argsSummary: "command: pnpm test",
        category: "command",
        decision: null,
      },
      {
        kind: "question",
        key: "sp-question",
        questionId: "q1",
        questions: [{ question: "which?", options: ["a", "b"], allowCustom: false, placeholder: null }],
        resolution: "pending",
        answers: null,
        sources: null,
      },
      {
        kind: "todo",
        key: "sp-todo",
        todos: [{ content: "ship it", status: "in_progress" }],
        source: "agent",
      },
      {
        kind: "subagent",
        key: "sp-subagent",
        childSessionId: "child_1",
        role: "builder",
        task: "build the thing",
        status: "running",
        code: null,
        model: null,
        taskId: null,
        detail: null,
      },
      { kind: "image", key: "sp-image", frameId: "f1", tool: "screenshot", note: "the screen" },
      { kind: "meta", key: "sp-meta", text: "round 2" },
      { kind: "debug", key: "sp-debug", content: "raw", live: false },
    ];
    for (const splitter of splitters) {
      const rows = groupDisplayRows([toolItem("t-before"), splitter, toolItem("t-after")]);
      expect(rows.map((row) => row.kind)).toEqual(["turn", "item", "turn"]);
      const middle = rows[1];
      if (middle?.kind !== "item") throw new Error(`expected a standalone row for ${splitter.kind}`);
      expect(middle.key).toBe(splitter.key);
      expect(middle.item).toBe(splitter); // untouched, same reference — the card owns it
      const before = rows[0];
      const after = rows[2];
      if (before?.kind !== "turn" || after?.kind !== "turn") throw new Error("expected turn rows");
      expect(before.items.map((item) => item.key)).toEqual(["t-before"]);
      expect(after.items.map((item) => item.key)).toEqual(["t-after"]);
    }
  });

  it("a settled assistant-only turn is neither live nor pending, and the model rides only when a member carried one", () => {
    const settled = singleTurn([assistantItem("a1", { content: "plain answer" })]);
    expect(settled.live).toBe(false);
    expect(settled.pending).toBe(false);
    expect(settled.model).toBeNull();
    const modeled = singleTurn([assistantItem("a1", { content: "hi", model: "glm-5.2" })]);
    expect(modeled.model).toBe("glm-5.2");
  });

  it("the group's key stays its FIRST item's key as the turn streams (the recycling law)", () => {
    const early = groupDisplayRows([assistantItem("a1", { live: true, chunks: ["par"] })]);
    const grown = groupDisplayRows([
      assistantItem("a1", { live: true, chunks: ["partial"] }),
      toolItem("t1", { ok: null, live: true }),
    ]);
    expect(early[0]?.key).toBe("a1");
    expect(grown[0]?.key).toBe("a1"); // same first item → same key, new member
  });

  it("a live member (not just the marker) makes the turn live; the thinking marker's model wins over a later assistant's", () => {
    const live = singleTurn([toolItem("t1", { ok: null, live: true })]);
    expect(live.live).toBe(true);
    expect(live.pending).toBe(false); // a tool run, not the pre-first-delta state
    const markerFirst = singleTurn([
      { kind: "thinking" as const, key: "live-thinking", model: "marker-model" },
      assistantItem("a1", { content: "done", model: "assistant-model" }),
    ]);
    expect(markerFirst.model).toBe("marker-model");
    const noMarkerModel = singleTurn([
      { kind: "thinking" as const, key: "live-thinking", model: null },
      assistantItem("a1", { content: "done", model: "assistant-model" }),
    ]);
    expect(noMarkerModel.model).toBe("assistant-model"); // the first honest carrier wins
  });
});

// ── the queued-after-turn law ───────────────────────────────────────────────

describe("turn-block — orderDisplayItems (the queued-after-turn law)", () => {
  it("an empty stream stays empty (the cheap path returns the same reference)", () => {
    const items: TranscriptItem[] = [];
    expect(orderDisplayItems(items)).toBe(items);
  });

  it("a stream with nothing queued returns the SAME reference (the memo's cheap path)", () => {
    const items: TranscriptItem[] = [
      userItem("u1"),
      assistantItem("a1", { content: "answer" }),
      toolItem("t1", { ok: true }),
    ];
    expect(orderDisplayItems(items)).toBe(items);
  });

  it("still-queued rows move AFTER everything — in particular after the in-progress turn's items — order among them preserved", () => {
    // the folded shape the owner reported: the queued row rides its LOG
    // position, right after the last persisted event (early), while the
    // in-progress turn streams at the tail.
    const items: TranscriptItem[] = [
      userItem("q1", { queued: true, content: "the waiting one" }),
      { kind: "thinking" as const, key: "live-thinking", model: null },
      toolItem("t1", { ok: null, live: true }),
      userItem("q2", { queued: true, content: "the second waiting one" }),
    ];
    const ordered = orderDisplayItems(items);
    expect(ordered.map((item) => item.key)).toEqual(["live-thinking", "t1", "q1", "q2"]);
  });

  it("delivered rows NEVER move — only what is still WAITING rides the tail", () => {
    const items: TranscriptItem[] = [
      userItem("q1", { queued: true }),
      userItem("d1", { queued: false }),
      userItem("q2", { queued: true }),
      assistantItem("a1", { content: "answer" }),
    ];
    const ordered = orderDisplayItems(items);
    expect(ordered.map((item) => item.key)).toEqual(["d1", "a1", "q1", "q2"]);
  });

  it("the live q-rows already at the tail stay put (idempotent in place)", () => {
    const items: TranscriptItem[] = [
      userItem("live-u1", { content: "the ask" }),
      assistantItem("a1", { live: true, chunks: ["partial"] }),
      userItem("q7", { queued: true, content: "queued while streaming" }),
    ];
    const ordered = orderDisplayItems(items);
    expect(ordered.map((item) => item.key)).toEqual(["live-u1", "a1", "q7"]);
    expect(orderDisplayItems(ordered)).toEqual(ordered); // stable — the law holds its own output
  });

  it("the law is idempotent — applying it twice never re-shuffles a thing", () => {
    const items: TranscriptItem[] = [
      userItem("q1", { queued: true }),
      userItem("d1", { queued: false }),
      toolItem("t1", { ok: true }),
      userItem("q2", { queued: true }),
    ];
    const once = orderDisplayItems(items);
    const twice = orderDisplayItems(once);
    expect(twice).toEqual(once);
    expect(twice.map((item) => item.key)).toEqual(["d1", "t1", "q1", "q2"]);
  });
});

// ── the rail's facts + string table ─────────────────────────────────────────

describe("turn-block — turnActivityFacts + activitySummary (the rail's string table)", () => {
  it("the settled string table — thinking-only, tools-only, both, and the failure count appended when > 0", () => {
    // thinking-only (the measured span reads the PC's own floor formula)
    expect(activitySummary(railFacts({ hasThinking: true, thoughtMs: 8_000 }))).toBe("Thought for 8s");
    // tools-only
    expect(activitySummary(railFacts({ toolCount: 3 }))).toBe("3 actions");
    expect(activitySummary(railFacts({ toolCount: 1 }))).toBe("1 action"); // the singular
    // both — the spec's own example
    expect(activitySummary(railFacts({ hasThinking: true, thoughtMs: 8_000, toolCount: 3 }))).toBe(
      "Thought for 8s · 3 actions",
    );
    // failures visible at a glance while collapsed
    expect(
      activitySummary(railFacts({ hasThinking: true, thoughtMs: 8_000, toolCount: 3, failedCount: 1 })),
    ).toBe("Thought for 8s · 3 actions · 1 failed");
    expect(activitySummary(railFacts({ toolCount: 3, failedCount: 2 }))).toBe("3 actions · 2 failed");
    // a failed count of 0 never appends (only when > 0)
    expect(activitySummary(railFacts({ toolCount: 3, failedCount: 0 }))).toBe("3 actions");
  });

  it("the measured span floors at one second and rounds honestly; a missing span reads the plain Thought word", () => {
    expect(activitySummary(railFacts({ hasThinking: true, thoughtMs: 7_500 }))).toBe("Thought for 8s");
    expect(activitySummary(railFacts({ hasThinking: true, thoughtMs: 12_400 }))).toBe("Thought for 12s");
    expect(activitySummary(railFacts({ hasThinking: true, thoughtMs: 400 }))).toBe("Thought for 1s");
    expect(activitySummary(railFacts({ hasThinking: true, thoughtMs: null }))).toBe("Thought");
  });

  it("a turn with NO activity at all renders no rail (null — the clean document)", () => {
    expect(activitySummary(railFacts())).toBeNull();
  });

  it("the live variants — the running tool's verb, else Writing… once text streams, else the breathing Thinking…", () => {
    expect(activitySummary(railFacts({ live: true }))).toBe("Thinking…");
    expect(activitySummary(railFacts({ live: true, writing: true }))).toBe("Writing…");
    expect(
      activitySummary(railFacts({ live: true, runningToolWord: "Reading src/a.ts…" })),
    ).toBe("Reading src/a.ts…");
    // the verb outranks the writing word (the running call is the story)
    expect(
      activitySummary(railFacts({ live: true, runningToolWord: "Writing src/a.ts…", writing: true })),
    ).toBe("Writing src/a.ts…");
    // the settled arm never reads a live word
    expect(activitySummary(railFacts({ live: false, runningToolWord: "Reading…" }))).toBeNull();
  });

  it("turnActivityFacts derives the counts off the group — and the hidden pref never teases a count the well will not show", () => {
    const group = singleTurn([
      assistantItem("a1", { thinking: "hmm", thinkingMs: 5_000, model: "glm-5.2" }),
      toolItem("t1", { ok: true }),
      toolItem("t2", { ok: false }),
    ]);
    const detailed = turnActivityFacts(group, "detailed");
    expect(detailed).toEqual({
      thoughtMs: 5_000,
      hasThinking: true,
      toolCount: 2,
      failedCount: 1,
      live: false,
      runningToolWord: null,
      writing: false,
      // R120-CM — the default fixtures carry no command/path to hint
      toolHints: [],
    });
    expect(activitySummary(detailed)).toBe("Thought for 5s · 2 actions · 1 failed");
    // compact keeps every count (the rows render, just pinned to one line)
    expect(turnActivityFacts(group, "compact").toolCount).toBe(2);
    // hidden: no tool rows render, so the counts read 0 — the summary never
    // teases content the block will not show (the clean document verdict)
    const hidden = turnActivityFacts(group, "hidden");
    expect(hidden.toolCount).toBe(0);
    expect(hidden.failedCount).toBe(0);
    expect(activitySummary(hidden)).toBe("Thought for 5s");
    // hidden + a tools-only turn → NO rail at all
    const toolsOnly = singleTurn([toolItem("t1", { ok: true }), toolItem("t2", { ok: false })]);
    expect(activitySummary(turnActivityFacts(toolsOnly, "hidden"))).toBeNull();
  });

  it("the live facts: the LAST running call's verb, writing once the reply's text has started", () => {
    const group = singleTurn([
      toolItem("t1", { toolName: "read_file", ok: null, live: true, argsSummary: "path: src/a.ts" }),
      toolItem("t2", { toolName: "run_command", ok: null, live: true, argsSummary: "command: pnpm test" }),
    ]);
    const facts = turnActivityFacts(group, "detailed");
    expect(facts.runningToolWord).toBe("Running pnpm test…"); // the LAST running call
    expect(facts.writing).toBe(false);
    expect(activitySummary(facts)).toBe("Running pnpm test…");
    // a settled stream never answers a running verb (ok:null malformed aside)
    const settled = singleTurn([toolItem("t1", { ok: null })]);
    expect(turnActivityFacts(settled, "detailed").runningToolWord).toBeNull();
    // writing: the live chunks carry text
    const writing = singleTurn([assistantItem("a1", { live: true, chunks: ["par"] })]);
    expect(turnActivityFacts(writing, "detailed").writing).toBe(true);
    const empty = singleTurn([assistantItem("a1", { live: true, chunks: [] })]);
    expect(turnActivityFacts(empty, "detailed").writing).toBe(false);
  });

  it("the thinking span is ADDITIVE across the turn's segments (each carries its own measured span)", () => {
    const group = singleTurn([
      assistantItem("a1", { thinking: "part one", thinkingMs: 5_000 }),
      toolItem("t1", { ok: true }),
      assistantItem("a2", { thinking: "part two", thinkingMs: 3_000, content: "done" }),
    ]);
    expect(turnActivityFacts(group, "detailed").thoughtMs).toBe(8_000);
    expect(activitySummary(turnActivityFacts(group, "detailed"))).toBe("Thought for 8s · 1 action");
  });
});

// ── the block's member text helpers ─────────────────────────────────────────

describe("turn-block — the group's member text helpers", () => {
  it("turnThinkingText joins the assistant members' thinking segments with a blank line; null when none", () => {
    expect(
      turnThinkingText([
        assistantItem("a1", { thinking: "part one" }),
        toolItem("t1", { ok: true }),
        assistantItem("a2", { thinking: "part two" }),
      ]),
    ).toBe("part one\n\npart two");
    expect(turnThinkingText([assistantItem("a1", { thinking: null })])).toBeNull();
    expect(turnThinkingText([assistantItem("a1", { thinking: "  " })])).toBeNull(); // blank is none
  });

  it("turnThoughtMs sums the members' spans; null when the wire carried none", () => {
    expect(
      turnThoughtMs([assistantItem("a1", { thinkingMs: 5_000 }), assistantItem("a2", { thinkingMs: 300 })]),
    ).toBe(5_300);
    expect(turnThoughtMs([assistantItem("a1", {})])).toBeNull();
  });

  it("turnReplyText reads the live chunks while streaming, the settled content otherwise, joined across segments", () => {
    expect(turnReplyText([assistantItem("a1", { live: true, chunks: ["par", "tial"] })])).toBe("partial");
    expect(turnReplyText([assistantItem("a1", { content: "settled" })])).toBe("settled");
    expect(
      turnReplyText([assistantItem("a1", { content: "first" }), assistantItem("a2", { content: "second" })]),
    ).toBe("first second");
    expect(turnReplyText([assistantItem("a1", {})])).toBe("");
  });
});

// ── R129-M — the separated thinking row's label ─────────────────────────────

describe("turn-block — thinkingRowLabel (R129-M — the separated thinking row's label)", () => {
  it("live reads Thinking…; settled reads the span-measure duration word; a missing span reads the plain fallback", () => {
    expect(thinkingRowLabel(true, 8_000)).toBe("Thinking…");
    expect(thinkingRowLabel(true, null)).toBe("Thinking…");
    expect(thinkingRowLabel(false, 8_000)).toBe("Thought for 8s");
    // the same floor-and-round grammar the rail's summary speaks
    expect(thinkingRowLabel(false, 500)).toBe("Thought for 1s");
    expect(thinkingRowLabel(false, 12_400)).toBe("Thought for 12s");
    expect(thinkingRowLabel(false, null)).toBe("Thought process");
  });
});

// ── the block's container label ─────────────────────────────────────────────

describe("turn-block — turnBlockA11yLabel (the one accessible container label)", () => {
  it("the settled label: thought seconds + actions + failures, the reply riding as the final clause", () => {
    expect(
      turnBlockA11yLabel({
        ...railFacts({ hasThinking: true, thoughtMs: 8_000, toolCount: 3, failedCount: 0 }),
        replyText: "",
      }),
    ).toBe("Assistant turn — thought 8 seconds, 3 actions");
    expect(
      turnBlockA11yLabel({
        ...railFacts({ hasThinking: true, thoughtMs: 8_000, toolCount: 3, failedCount: 1 }),
        replyText: "here is the answer",
      }),
    ).toBe("Assistant turn — thought 8 seconds, 3 actions, 1 failed. Reply: here is the answer");
    // no measured span → the plain word (never a guess)
    expect(
      turnBlockA11yLabel({ ...railFacts({ hasThinking: true, thoughtMs: null, toolCount: 1 }), replyText: "" }),
    ).toBe("Assistant turn — thought, 1 action");
  });

  it("a turn with no activity at all reads as the plain reply", () => {
    expect(turnBlockA11yLabel({ ...railFacts(), replyText: "" })).toBe("Assistant reply");
    expect(turnBlockA11yLabel({ ...railFacts(), replyText: "just text" })).toBe(
      "Assistant reply. Reply: just text",
    );
  });

  it("the live label — thinking / writing / the running verb", () => {
    expect(turnBlockA11yLabel({ ...railFacts({ live: true }), replyText: "" })).toBe(
      "Assistant turn — thinking",
    );
    expect(
      turnBlockA11yLabel({ ...railFacts({ live: true, writing: true }), replyText: "" }),
    ).toBe("Assistant turn — writing");
    expect(
      turnBlockA11yLabel({
        ...railFacts({ live: true, runningToolWord: "Reading src/a.ts…" }),
        replyText: "",
      }),
    ).toBe("Assistant turn — Reading src/a.ts…");
  });

  it("the reply preview collapses whitespace and tail-ellipsizes past 60 chars (one honest clause, never the wall)", () => {
    const long = `${"x".repeat(30)}\n\n  ${"y".repeat(40)}`;
    const label = turnBlockA11yLabel({ ...railFacts({ toolCount: 1 }), replyText: long });
    expect(label).toBe(`Assistant turn — 1 action. Reply: ${"x".repeat(30)} ${"y".repeat(29)}…`);
    // exactly 60 chars rides whole (no dead ellipsis)
    const exactly = "a".repeat(60);
    expect(turnBlockA11yLabel({ ...railFacts(), replyText: exactly })).toBe(
      `Assistant reply. Reply: ${exactly}`,
    );
  });
});

// ── R120-CM: the well row's title + the collapsed rail's tool hints ─────────

describe("turn-block — toolRowTitle (R120-CM — the well row's ONE-line grammar, per family)", () => {
  it("the write family: the streaming verb with its char count, the settled Wrote/Edited verdict", () => {
    // running + streaming raw: the growing file preview
    expect(
      toolRowTitle(
        toolItem("t1", {
          toolName: "write_file",
          ok: null,
          inputRaw: '{"path":"src/new.ts","content":"' + "x".repeat(96),
        }),
      ),
    ).toBe("Writing src/new.ts… · 96 chars");
    // running + a path but no raw yet (joined mid-call)
    expect(
      toolRowTitle(toolItem("t2", { toolName: "edit_file", ok: null, argsSummary: "path: src/a.ts" })),
    ).toBe("Editing src/a.ts…");
    // running + no path anywhere: the bare verb
    expect(toolRowTitle(toolItem("t3", { toolName: "write_file", ok: null, inputRaw: null }))).toBe(
      "Writing…",
    );
    // settled: the Wrote verdict
    expect(
      toolRowTitle(toolItem("t4", { toolName: "write_file", argsSummary: "path: src/new.ts" })),
    ).toBe("Wrote src/new.ts");
    expect(
      toolRowTitle(toolItem("t5", { toolName: "edit_file", argsSummary: "path: src/a.ts" })),
    ).toBe("Edited src/a.ts");
    // settled with no readable path: the humanized verb, never a guess
    expect(toolRowTitle(toolItem("t6", { toolName: "edit_file", argsSummary: "" }))).toBe("edit file");
  });

  it("the read/terminal/generic families: the verb · target one-line law; R123-W-m — the web pair and the browser family read their own targets", () => {
    expect(toolRowTitle(toolItem("t7", { toolName: "read_file", argsSummary: "path: src/a.ts" }))).toBe(
      "read file · src/a.ts",
    );
    expect(
      toolRowTitle(toolItem("t8", { toolName: "run_command", argsSummary: "command: npm test" })),
    ).toBe("run command · npm test");
    expect(
      toolRowTitle(toolItem("t9", { toolName: "search", argsSummary: "query: radius law" })),
    ).toBe("search · query: radius law");
    // an empty summary never rides a dangling separator
    expect(toolRowTitle(toolItem("t10", { toolName: "bash", argsSummary: "" }))).toBe("bash");
    // R123-W-m — web_search's query (live, still streaming)
    expect(
      toolRowTitle(
        toolItem("tw1", { toolName: "web_search", ok: null, inputRaw: '{"query":"clay palette' }),
      ),
    ).toBe("web search · clay palette");
    // R123-W-m — web_fetch's url (settled)
    expect(
      toolRowTitle(toolItem("tw2", { toolName: "web_fetch", argsSummary: "url: https://docs.foo.dev" })),
    ).toBe("web fetch · https://docs.foo.dev");
    // R123-W-m — browser_control's action + url (settled), the action alone when no url rides
    expect(
      toolRowTitle(
        toolItem("tb1", {
          toolName: "browser_control",
          argsSummary: "action: navigate, url: https://example.com",
        }),
      ),
    ).toBe("browser control · navigate https://example.com");
    expect(
      toolRowTitle(toolItem("tb2", { toolName: "browser_control", argsSummary: "action: read_dom" })),
    ).toBe("browser control · read_dom");
    // nothing readable anywhere → the family noun alone, never a guess
    expect(toolRowTitle(toolItem("tb3", { toolName: "browser_control", argsSummary: "" }))).toBe(
      "browser control",
    );
  });
});

describe("turn-block — toolHint / toolHintList (R120-CM — the collapsed rail's glance)", () => {
  it("the hint families: the write PATH, the terminal COMMAND, the read TARGET — and R123-W-m the web QUERY/URL + the browser ACTION — everything else null", () => {
    expect(toolHint(toolItem("h1", { toolName: "edit_file", argsSummary: "path: src/a.ts" }))).toBe(
      "src/a.ts",
    );
    // the write family's live raw carries the path too (the hint works mid-stream)
    expect(
      toolHint(toolItem("h2", { toolName: "write_file", ok: null, inputRaw: '{"path":"src/new.ts"' })),
    ).toBe("src/new.ts");
    expect(toolHint(toolItem("h3", { toolName: "run_command", argsSummary: "command: npm test" }))).toBe(
      "npm test",
    );
    expect(toolHint(toolItem("h4", { toolName: "read_file", argsSummary: "path: src/a.ts" }))).toBe(
      "src/a.ts",
    );
    // R123-W-m — the web pair hints its query/url (the row's own target)
    expect(toolHint(toolItem("hw1", { toolName: "web_search", argsSummary: "query: clay palette" }))).toBe(
      "clay palette",
    );
    expect(
      toolHint(toolItem("hw2", { toolName: "web_fetch", argsSummary: "url: https://docs.foo.dev" })),
    ).toBe("https://docs.foo.dev");
    // R123-W-m — the browser family hints its action (+url when one rides)
    expect(
      toolHint(
        toolItem("hb1", {
          toolName: "browser_control",
          argsSummary: "action: navigate, url: https://example.com",
        }),
      ),
    ).toBe("navigate https://example.com");
    expect(toolHint(toolItem("hb2", { toolName: "browser_control", argsSummary: "action: screenshot" }))).toBe(
      "screenshot",
    );
    // a genuinely unknown tool still teases nothing — the count already carries it
    expect(toolHint(toolItem("h5", { toolName: "search", argsSummary: "query: x" }))).toBeNull();
    // a write with no readable path teases nothing (never a guess)
    expect(toolHint(toolItem("h6", { toolName: "edit_file", argsSummary: "" }))).toBeNull();
    // a web call with nothing readable yet teases nothing either
    expect(toolHint(toolItem("hw3", { toolName: "web_search", argsSummary: "" }))).toBeNull();
  });

  it("toolHintList dedupes ORDER-PRESERVING (two edits of one file hint once) and keeps call order", () => {
    const items = [
      toolItem("d1", { toolName: "edit_file", argsSummary: "path: src/a.ts" }),
      toolItem("d2", { toolName: "edit_file", argsSummary: "path: src/a.ts" }),
      toolItem("d3", { toolName: "run_command", argsSummary: "command: npm test" }),
    ];
    expect(toolHintList(items)).toEqual(["src/a.ts", "npm test"]);
  });

  it("the cap: at most TOOL_HINT_MAX (3) hints, then the honest +N more tail", () => {
    expect(TOOL_HINT_MAX).toBe(3);
    const mk = (path: string): ToolItem =>
      toolItem(`c-${path}`, { toolName: "edit_file", argsSummary: `path: ${path}` });
    expect(toolHintList([mk("a.ts"), mk("b.ts"), mk("c.ts")])).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(toolHintList([mk("a.ts"), mk("b.ts"), mk("c.ts"), mk("d.ts")])).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
      "+1 more",
    ]);
    expect(
      toolHintList([mk("a.ts"), mk("b.ts"), mk("c.ts"), mk("d.ts"), mk("e.ts"), mk("f.ts")]),
    ).toEqual(["a.ts", "b.ts", "c.ts", "+3 more"]);
    // generic calls add nothing — the count already carries them
    expect(
      toolHintList([
        mk("a.ts"),
        toolItem("c-g", { toolName: "search", argsSummary: "query: x" }),
      ]),
    ).toEqual(["a.ts"]);
  });
});

describe("turn-block — activitySummary + a11y with the tool hints (R120-CM, item 40: the glance)", () => {
  it("the settled rail carries the hints BETWEEN the actions count and the failed tail", () => {
    expect(
      activitySummary(
        railFacts({ hasThinking: true, thoughtMs: 8_000, toolCount: 3, toolHints: ["src/a.ts", "npm test"] }),
      ),
    ).toBe("Thought for 8s · 3 actions · src/a.ts, npm test");
    // tools-only + hints
    expect(activitySummary(railFacts({ toolCount: 2, toolHints: ["src/a.ts"] }))).toBe(
      "2 actions · src/a.ts",
    );
    // hints + failures: the failed tail stays LAST (the glance-level tell)
    expect(
      activitySummary(railFacts({ toolCount: 3, failedCount: 1, toolHints: ["src/a.ts"] })),
    ).toBe("3 actions · src/a.ts · 1 failed");
    // no hints: the string table is byte-identical to R119-A
    expect(activitySummary(railFacts({ toolCount: 3 }))).toBe("3 actions");
  });

  it("the LIVE rail never carries hints — the running verb owns the line", () => {
    expect(
      activitySummary(railFacts({ live: true, toolHints: ["src/a.ts"], toolCount: 2 })),
    ).toBe("Thinking…");
    expect(
      activitySummary(
        railFacts({ live: true, runningToolWord: "Reading src/a.ts…", toolHints: ["src/a.ts"] }),
      ),
    ).toBe("Reading src/a.ts…");
  });

  it("turnActivityFacts derives the hints off the group — and the hidden pref never teases them", () => {
    const items = [
      assistantItem("a1", { thinking: "planning" }),
      toolItem("t1", { toolName: "edit_file", argsSummary: "path: src/a.ts" }),
      toolItem("t2", { toolName: "run_command", argsSummary: "command: npm test" }),
    ];
    const group = singleTurn(items);
    expect(turnActivityFacts(group, "detailed").toolHints).toEqual(["src/a.ts", "npm test"]);
    // compact keeps the hints (the rows render, one line each)
    expect(turnActivityFacts(group, "compact").toolHints).toEqual(["src/a.ts", "npm test"]);
    // hidden: no rows AND no hints — the summary never teases content the well will not show
    expect(turnActivityFacts(group, "hidden").toolHints).toEqual([]);
    expect(turnActivityFacts(group, "hidden").toolCount).toBe(0);
  });

  it("turnBlockA11yLabel rides the hints as the parenthetical — the screen reader hears what the glance sees", () => {
    expect(
      turnBlockA11yLabel({
        ...railFacts({ hasThinking: true, thoughtMs: 8_000, toolCount: 3, toolHints: ["src/a.ts", "npm test"] }),
        replyText: "",
      }),
    ).toBe("Assistant turn — thought 8 seconds, 3 actions (src/a.ts, npm test)");
    // no hints: the label keeps the R119-A spelling
    expect(
      turnBlockA11yLabel({ ...railFacts({ toolCount: 3 }), replyText: "" }),
    ).toBe("Assistant turn — 3 actions");
  });
});
