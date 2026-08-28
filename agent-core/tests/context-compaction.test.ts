/**
 * ROUND-46 (R46-b) — CONTEXT COMPACTION.
 *
 * The overflow path used to be a silent hard trim (assembleWithinBudget
 * drops oldest pairs + a generic marker — information destroyed). These
 * tests pin the compaction replacement:
 *
 *   - assembleHistory seq annotations (message events carry their own seq;
 *     a tool_results block carries the LAST tool.use seq folded into it),
 *   - findLatestCompaction / applyCompaction (pure filter + summary prepend),
 *   - planCompaction (keep newest ~60% of the budget, never keep nothing,
 *     null when under budget),
 *   - assembleWithCompaction end-to-end with a fake ChatFn: over-budget
 *     history → ONE summarizer call → context.compact event appended →
 *     messages = [summary, ...keep]; a second assembly REUSES the event
 *     (no re-summarization); round-2 compaction when it overflows again;
 *     summarizer failure/empty-text degrades to the legacy hard trim.
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { appendSessionEvent, createSession, listSessionEvents } from "../src/storage/sessions";
import {
  applyCompaction,
  assembleWithCompaction,
  findLatestCompaction,
  planCompaction,
  SUMMARIZER_SYSTEM_PROMPT,
  type CompactionPayload,
  type SeqMessage,
} from "../src/agents/compaction";
import { assembleHistory } from "../src/agents/runtime";
import type { ChatFn, ChatTurnInput } from "../src/agents/chat";

const dir = mkdtempSync(join(tmpdir(), "acute-compaction-"));

let db: SqliteDatabase;

beforeEach(() => {
  db = openDatabase(join(dir, `${randomUUID()}.db`));
});

afterEach(() => {
  db.close();
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: Windows sometimes holds file handles briefly after close.
  }
});

function newSession(): string {
  return createSession(db, { agentId: "agt_default_nova", mode: "single", projectId: null }).id;
}

function addMessage(sessionId: string, type: "message.user" | "message.assistant", content: string): number {
  return appendSessionEvent(db, sessionId, {
    type,
    agentId: "agt_default_nova",
    payload: { role: type === "message.user" ? "user" : "assistant", content },
  }).seq;
}

function addToolUse(sessionId: string, toolName: string, output: string): number {
  return appendSessionEvent(db, sessionId, {
    type: "tool.use",
    agentId: "agt_default_nova",
    payload: { role: "tool", toolName, argsSummary: `${toolName} args`, ok: true, outputSummary: output },
  }).seq;
}

/** A budget with a tiny window so tests can overflow it with few messages. */
const TIGHT_BUDGET = { contextWindow: 600, maxOutputTokens: 100, margin: 100 }; // available 400
const ROOMY_BUDGET = { contextWindow: 1_000_000, maxOutputTokens: 32_768, margin: 8_000 };

/** Fake ChatFn that records every call; returns a canned summary. */
function fakeChat(summary = "SUMMARY: the agent built feature X across a.ts and b.ts; error E was fixed; next step is tests."): {
  chat: ChatFn;
  calls: ChatTurnInput[];
  failNext: () => void;
  emptyNext: () => void;
} {
  const calls: ChatTurnInput[] = [];
  let mode: "ok" | "fail" | "empty" = "ok";
  const chat: ChatFn = async (input) => {
    calls.push(input);
    if (mode === "fail") throw new Error("simulated provider outage");
    if (mode === "empty") return { text: "   ", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: [] };
    return { text: summary, usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, toolCalls: [] };
  };
  return { chat, calls, failNext: () => (mode = "fail"), emptyNext: () => (mode = "empty") };
}

/* ── assembleHistory: seq annotations ─────────────────────────────────────── */

describe("assembleHistory seq annotations", () => {
  it("message events carry their own seq; tool blocks carry the last tool.use seq", () => {
    const sid = newSession();
    const uSeq = addMessage(sid, "message.user", "build the thing");
    const t1 = addToolUse(sid, "read_file", "file contents here");
    const t2 = addToolUse(sid, "edit_file", "edited 3 lines");
    const aSeq = addMessage(sid, "message.assistant", "done, edited both files");

    const history = assembleHistory(db, sid);
    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({ role: "user", content: "build the thing", throughSeq: uSeq });
    // The tool_results block is ONE user message anchored at the LAST tool.use.
    expect(history[1]).toMatchObject({ role: "user", throughSeq: t2 });
    expect(history[1].content).toContain("<tool_results>");
    expect(history[1].content).toContain("read_file(");
    expect(history[1].content).toContain("edit_file(");
    expect(history[2]).toMatchObject({ role: "assistant", content: "done, edited both files", throughSeq: aSeq });
    expect(t2).toBeGreaterThan(t1);
  });

  it("thinking-only assistant segments (empty content) stay skipped", () => {
    const sid = newSession();
    addMessage(sid, "message.user", "hello");
    appendSessionEvent(db, sid, {
      type: "message.assistant",
      agentId: "agt_default_nova",
      payload: { role: "assistant", content: "" },
    });
    addMessage(sid, "message.assistant", "the real reply");
    const history = assembleHistory(db, sid);
    expect(history).toHaveLength(2);
  });
});

/* ── findLatestCompaction / applyCompaction ───────────────────────────────── */

describe("findLatestCompaction + applyCompaction", () => {
  const compact: CompactionPayload = {
    summary: "summary of early work",
    throughSeq: 7,
    droppedMessages: 5,
    tokensSaved: 1200,
  };

  it("returns null with no compaction events", () => {
    expect(findLatestCompaction([])).toBeNull();
  });

  it("finds the NEWEST compaction and ignores malformed payloads", () => {
    const sid = newSession();
    addMessage(sid, "message.user", "x");
    appendSessionEvent(db, sid, {
      type: "context.compact",
      agentId: null,
      payload: { summary: "first summary", throughSeq: 1, droppedMessages: 1, tokensSaved: 10 },
    });
    appendSessionEvent(db, sid, {
      type: "context.compact",
      agentId: null,
      payload: { summary: "second summary", throughSeq: 2, droppedMessages: 2, tokensSaved: 20 },
    });
    const found = findLatestCompaction(listSessionEvents(db, sid));
    expect(found?.summary).toBe("second summary");
    expect(found?.throughSeq).toBe(2);
    // Malformed newest (empty summary) → treated as absent.
    appendSessionEvent(db, sid, {
      type: "context.compact",
      agentId: null,
      payload: { summary: "  ", throughSeq: 9, droppedMessages: 0, tokensSaved: 0 },
    });
    expect(findLatestCompaction(listSessionEvents(db, sid))).toBeNull();
  });

  it("applyCompaction drops covered messages and prepends the summary", () => {
    const messages: SeqMessage[] = [
      { role: "user", content: "old task", throughSeq: 1 },
      { role: "assistant", content: "old work", throughSeq: 4 },
      { role: "user", content: "follow-up", throughSeq: 8 },
      { role: "assistant", content: "newer work", throughSeq: 9 },
    ];
    const applied = applyCompaction(messages, compact);
    expect(applied).toHaveLength(3); // summary + the two messages after seq 7
    expect(applied[0].role).toBe("user");
    expect(applied[0].content).toContain("summary of early work");
    expect(applied[0].content).toContain("authoritative record");
    expect(applied[1]).toMatchObject({ content: "follow-up" });
    expect(applied[2]).toMatchObject({ content: "newer work" });
  });
});

/* ── planCompaction ───────────────────────────────────────────────────────── */

describe("planCompaction", () => {
  /** N pairs of ~100-token messages (400 chars ≈ 100 tokens + 8 overhead). */
  function manyPairs(n: number): SeqMessage[] {
    const out: SeqMessage[] = [];
    for (let i = 0; i < n; i++) {
      out.push({ role: "user", content: `task message ${i} `.repeat(20), throughSeq: i * 2 + 1 });
      out.push({ role: "assistant", content: `assistant reply ${i} `.repeat(20), throughSeq: i * 2 + 2 });
    }
    return out;
  }

  it("returns null when the history fits", () => {
    expect(planCompaction(manyPairs(2), ROOMY_BUDGET)).toBeNull();
  });

  it("over budget → summarizes the head, keeps the newest ~60% window, keeps at least the final message", () => {
    const messages = manyPairs(10); // 20 messages ≈ 108 tokens each ≈ 2160 tokens > 800
    const plan = planCompaction(messages, TIGHT_BUDGET);
    expect(plan).not.toBeNull();
    expect(plan!.toSummarize.length).toBeGreaterThan(0);
    expect(plan!.keep.length).toBeGreaterThan(0);
    expect(plan!.keep[plan!.keep.length - 1]).toBe(messages[messages.length - 1]); // final message kept
    // targetThroughSeq is the seq of the LAST summarized message.
    expect(plan!.targetThroughSeq).toBe(plan!.toSummarize[plan!.toSummarize.length - 1].throughSeq);
    // The keep window fits the ~60% target (240 tokens) — the loop stops
    // BEFORE adding an over-target message.
    const keepTokens = plan!.keep.reduce((acc, m) => acc + Math.ceil(m.content.length / 4) + 8, 0);
    expect(keepTokens).toBeLessThanOrEqual(240);
    // Summarize + keep covers everything.
    expect(plan!.toSummarize.length + plan!.keep.length).toBe(messages.length);
  });

  it("a single gigantic message still keeps it (never keep nothing)", () => {
    const messages: SeqMessage[] = [
      { role: "user", content: "x".repeat(20_000), throughSeq: 1 },
      { role: "assistant", content: "y".repeat(20_000), throughSeq: 2 },
    ];
    const plan = planCompaction(messages, TIGHT_BUDGET);
    expect(plan).not.toBeNull();
    expect(plan!.keep.length).toBeGreaterThan(0);
    expect(plan!.keep[plan!.keep.length - 1].throughSeq).toBe(2);
  });
});

/* ── assembleWithCompaction (end-to-end with a fake ChatFn) ───────────────── */

describe("assembleWithCompaction", () => {
  function seedOverflowingSession(sessionId: string): void {
    // 6 pairs ≈ 740 tokens > 400 available (user ≈ 71, assistant ≈ 53 each).
    for (let i = 0; i < 6; i++) {
      addMessage(sessionId, "message.user", `user message number ${i} — ${"context ".repeat(25)}`);
      addMessage(sessionId, "message.assistant", `assistant message number ${i} — ${"work ".repeat(30)}`);
    }
  }

  const deps = (chat: ChatFn) => ({
    db: db as Database.Database,
    sessionId: "",
    chat,
    provider: { id: "prov_openrouter", baseUrl: null, apiFormat: "chat-completions" },
    apiKey: "test-key",
    model: "test/model",
  });

  it("under budget → verbatim messages, NO summarizer call, NO event", async () => {
    const sid = newSession();
    addMessage(sid, "message.user", "hi");
    addMessage(sid, "message.assistant", "hello");
    const { chat, calls } = fakeChat();
    const outcome = await assembleWithCompaction(assembleHistory(db, sid), ROOMY_BUDGET, { ...deps(chat), sessionId: sid });
    expect(outcome.compacted).toBe(false);
    expect(calls).toHaveLength(0);
    expect(outcome.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("over budget → ONE summarizer call (no tools), event appended, messages = [summary, ...keep]", async () => {
    const sid = newSession();
    seedOverflowingSession(sid);
    const { chat, calls } = fakeChat();
    const outcome = await assembleWithCompaction(assembleHistory(db, sid), TIGHT_BUDGET, { ...deps(chat), sessionId: sid });

    expect(outcome.compacted).toBe(true);
    expect(calls).toHaveLength(1);
    // The summarizer call: the compaction system prompt, no tools, maxTurns 1.
    expect(calls[0].system).toBe(SUMMARIZER_SYSTEM_PROMPT);
    expect(calls[0].tools).toBeUndefined();
    expect(calls[0].maxTurns).toBe(1);
    expect(calls[0].messages).toHaveLength(1); // the transcript as one user message
    expect(calls[0].messages[0].content).toContain("USER: user message number 0");
    expect(outcome.detail?.droppedMessages).toBeGreaterThan(0);
    expect(outcome.detail?.tokensSaved).toBeGreaterThan(0);

    // The final message list leads with the summary and stays within budget.
    expect(outcome.messages[0].content).toContain("SUMMARY: the agent built feature X");
    const total = outcome.messages.reduce((acc, m) => acc + Math.ceil(m.content.length / 4) + 8, 0);
    expect(total).toBeLessThanOrEqual(400);

    // The event landed in the log.
    const events = listSessionEvents(db, sid);
    const compactEvents = events.filter((e) => e.type === "context.compact");
    expect(compactEvents).toHaveLength(1);
    const payload = compactEvents[0].payload as Record<string, unknown>;
    expect(payload.summary).toContain("feature X");
    expect(typeof payload.throughSeq).toBe("number");
  });

  it("SECOND assembly reuses the compaction event — no re-summarization while it holds", async () => {
    const sid = newSession();
    seedOverflowingSession(sid);
    const { chat, calls } = fakeChat();
    const first = await assembleWithCompaction(assembleHistory(db, sid), TIGHT_BUDGET, { ...deps(chat), sessionId: sid });
    expect(first.compacted).toBe(true);
    expect(calls).toHaveLength(1);

    // Re-assemble from the SAME event log (the next outer-loop iteration):
    // the existing compaction applies, budget fits → no new summarizer call.
    const second = await assembleWithCompaction(assembleHistory(db, sid), TIGHT_BUDGET, { ...deps(chat), sessionId: sid });
    expect(second.compacted).toBe(false);
    expect(calls).toHaveLength(1); // unchanged
    // And the message list is the compacted one (summary first).
    expect(second.messages[0].content).toContain("SUMMARY: the agent built feature X");
  });

  it("round-2: overflow again → a NEW compaction supersedes (folds the old summary)", async () => {
    const sid = newSession();
    seedOverflowingSession(sid);
    const { chat, calls } = fakeChat();
    const first = await assembleWithCompaction(assembleHistory(db, sid), TIGHT_BUDGET, { ...deps(chat), sessionId: sid });
    expect(first.compacted).toBe(true);

    // Add enough NEW work to overflow the window again.
    for (let i = 10; i < 16; i++) {
      addMessage(sid, "message.user", `later user message ${i} — ${"more context ".repeat(25)}`);
      addMessage(sid, "message.assistant", `later assistant message ${i} — ${"more work ".repeat(30)}`);
    }
    const second = await assembleWithCompaction(assembleHistory(db, sid), TIGHT_BUDGET, { ...deps(chat), sessionId: sid });
    expect(second.compacted).toBe(true);
    expect(calls).toHaveLength(2);
    // The round-2 transcript includes the round-1 summary (it was the head
    // of the applied history).
    expect(calls[1].messages[0].content).toContain("SUMMARY: the agent built feature X");

    // Only the newest compaction matters: exactly 2 events exist, and a
    // third assembly reuses the second one.
    const third = await assembleWithCompaction(assembleHistory(db, sid), TIGHT_BUDGET, { ...deps(chat), sessionId: sid });
    expect(third.compacted).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("summarizer failure → legacy hard-trim fallback (marker + newest that fit), no event", async () => {
    const sid = newSession();
    seedOverflowingSession(sid);
    const { chat, calls, failNext } = fakeChat();
    failNext();
    const outcome = await assembleWithCompaction(assembleHistory(db, sid), TIGHT_BUDGET, { ...deps(chat), sessionId: sid });
    expect(outcome.compacted).toBe(false);
    expect(calls).toHaveLength(1); // tried once
    expect(outcome.messages[0].content).toContain("[Earlier conversation was trimmed");
    const total = outcome.messages.reduce((acc, m) => acc + Math.ceil(m.content.length / 4) + 8, 0);
    expect(total).toBeLessThanOrEqual(400 + 60); // marker + survivors
    expect(listSessionEvents(db, sid).some((e) => e.type === "context.compact")).toBe(false);
  });

  it("empty summarizer text → same hard-trim fallback", async () => {
    const sid = newSession();
    seedOverflowingSession(sid);
    const { chat, emptyNext } = fakeChat();
    emptyNext();
    const outcome = await assembleWithCompaction(assembleHistory(db, sid), TIGHT_BUDGET, { ...deps(chat), sessionId: sid });
    expect(outcome.compacted).toBe(false);
    expect(outcome.messages[0].content).toContain("[Earlier conversation was trimmed");
  });
});
