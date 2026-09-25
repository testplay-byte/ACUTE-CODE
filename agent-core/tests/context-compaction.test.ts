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
 *
 * ROUND-125 (R125-C) — the ZCode D1/D2 adoption
 * (agent-ctx/research/zcode-context-compression.md §D1/§D2):
 *   - providerUsageAnchor pins (the pure D1 helper): no usage rows → null;
 *   the provider number alone when nothing follows it; provider number +
 *   estimated tail when messages came after; the LAST usage-bearing event
 *   wins; garbage rows are skipped, not trusted.
 *   - planCompaction's typed decision (D2): the old null returns became
 *   { decision: "skip", reason: "below_threshold" | "empty_to_summarize" }
 *   objects (the two pins that asserted null were updated with comments);
 *   every result carries { tokenCount, tokenSource, estimatedTokens,
 *   threshold, reason }.
 *   - The tokenOverride law (D1): the provider's number can FORCE a
 *   compaction the estimate says is unnecessary, and — the key honest case
 *   — VETO one the estimate demands (the estimator over-counted; the
 *   provider number wins).
 *   - assembleWithCompaction threads opts.tokenOverride into the gate and
 *   the persisted event payload carries the typed-decision fields; a
 *   runStreamedAgentTurn integration test pins the runtime's own anchor
 *   construction (the last usage-bearing assistant event → the event
 *   payload + the live meta.compaction frame).
 *
 * ROUND-128 (R128-W8) — the ZCode D3/D5 adoption
 * (agent-ctx/research/zcode-context-compression.md §D3/§D5): the selection
 * is ROUND-ALIGNED now (the keep window extends back to the oldest kept
 * assistant round's start — one pin above RE-PINNED honestly for the new
 * boundary arithmetic; the D3a/D3b/D5 unit + integration pins live in
 * tests/r128-compaction-d3d5.test.ts).
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { appendSessionEvent, createSession, listSessionEvents, type SessionEvent } from "../src/storage/sessions";
// ROUND-117 (R117-b): the episodic bridge's collaborators — the project the
// session binds to, the memory tier the summary lands in, the master switch.
import { createProject } from "../src/storage/projects";
import { listMemories, listWorkspaceMemories } from "../src/storage/memory";
import { setMemorySettings } from "../src/storage/settings";
import {
  applyCompaction,
  assembleWithCompaction,
  findLatestCompaction,
  planCompaction,
  providerUsageAnchor,
  SUMMARIZER_SYSTEM_PROMPT,
  type CompactionPayload,
  type SeqMessage,
} from "../src/agents/compaction";
// R125-C (D1): the runtime's own anchor expression + the estimator both
// live here — the integration test pins providerUsageAnchor against the
// same estimateMessageTokens the production gate reports.
import { assembleHistory, runStreamedAgentTurn } from "../src/agents/runtime";
import type { ChatFn, ChatTurnInput, StreamChatFn, StreamChatEvent } from "../src/agents/chat";
import { estimateMessageTokens } from "../src/context";
// R125-C: the runtime integration test's collaborators.
import { createAgent } from "../src/storage/agents";
import { upsertModel } from "../src/storage/models";
import { ProviderKeyring } from "../src/providers/registry";

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

  it("R125-C D2: the typed-decision fields round-trip the fold (new events carry them; pre-R125 events lack them)", () => {
    const sid = newSession();
    addMessage(sid, "message.user", "x");
    appendSessionEvent(db, sid, {
      type: "context.compact",
      agentId: null,
      // A PRE-R125 event (no decision fields) — every new field reads absent.
      payload: { summary: "old summary", throughSeq: 1, droppedMessages: 1, tokensSaved: 10 },
    });
    const old = findLatestCompaction(listSessionEvents(db, sid));
    expect(old?.tokenCount).toBeUndefined();
    expect(old?.tokenSource).toBeUndefined();
    expect(old?.estimatedTokens).toBeUndefined();
    expect(old?.threshold).toBeUndefined();
    expect(old?.reason).toBeUndefined();

    appendSessionEvent(db, sid, {
      type: "context.compact",
      agentId: null,
      // An R125-C event — the fields ride verbatim (garbage values are
      // dropped to absent, the same guard discipline as tokensSaved).
      payload: {
        summary: "new summary",
        throughSeq: 2,
        droppedMessages: 2,
        tokensSaved: 20,
        tokenCount: 123_456,
        tokenSource: "provider-anchored",
        estimatedTokens: 100,
        threshold: 959_232,
        reason: "above_threshold",
        junkField: "ignored",
      },
    });
    const found = findLatestCompaction(listSessionEvents(db, sid));
    expect(found).toMatchObject({
      summary: "new summary",
      tokenCount: 123_456,
      tokenSource: "provider-anchored",
      estimatedTokens: 100,
      threshold: 959_232,
      reason: "above_threshold",
    });
    // A garbage tokenSource / reason normalizes to absent, never invents.
    appendSessionEvent(db, sid, {
      type: "context.compact",
      agentId: null,
      payload: { summary: "junk summary", throughSeq: 3, tokenSource: "telepathy", reason: "because" },
    });
    const junk = findLatestCompaction(listSessionEvents(db, sid));
    expect(junk?.tokenSource).toBeUndefined();
    expect(junk?.reason).toBeUndefined();
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

/* ── ROUND-125 (R125-C, D1): providerUsageAnchor — the pure anchor helper ── */

describe("ROUND-125 (R125-C, D1): providerUsageAnchor", () => {
  /** Pure event literals — the helper takes (events, messages) and no DB. */
  const ev = (
    seq: number,
    type: "message.user" | "message.assistant",
    content: string,
    usage?: { inputTokens: number; outputTokens: number },
  ): SessionEvent => ({
    seq,
    type,
    agentId: null,
    payload: { role: type === "message.user" ? "user" : "assistant", content, ...(usage !== undefined ? { usage } : {}) },
    ts: `2026-01-01T00:00:${String(seq % 60).padStart(2, "0")}Z`,
  });

  it("no usage-bearing assistant event → null (the pure-estimate fallback)", () => {
    const events = [ev(1, "message.user", "task"), ev(2, "message.assistant", "reply with NO usage row")];
    const messages: SeqMessage[] = [
      { role: "user", content: "task", throughSeq: 1 },
      { role: "assistant", content: "reply with NO usage row", throughSeq: 2 },
    ];
    expect(providerUsageAnchor(events, messages)).toBeNull();
    expect(providerUsageAnchor([], [])).toBeNull();
  });

  it("usage event + ZERO later messages → exactly the provider number", () => {
    const events = [
      ev(1, "message.user", "task"),
      ev(2, "message.assistant", "reply", { inputTokens: 4321, outputTokens: 9 }),
    ];
    const messages: SeqMessage[] = [
      { role: "user", content: "task", throughSeq: 1 },
      { role: "assistant", content: "reply", throughSeq: 2 },
    ];
    expect(providerUsageAnchor(events, messages)).toBe(4321);
  });

  it("usage event + later messages → provider number + the estimated tail (throughSeq > the event's seq)", () => {
    const events = [
      ev(1, "message.user", "the original task"),
      ev(2, "message.assistant", "part one done", { inputTokens: 800, outputTokens: 5 }),
      ev(3, "message.user", "a follow-up message"),
    ];
    // A <tool_results> block anchored at a tool.use seq AFTER the anchor
    // event counts too — it is exactly what the provider had not seen.
    const messages: SeqMessage[] = [
      { role: "user", content: "the original task", throughSeq: 1 },
      { role: "assistant", content: "part one done", throughSeq: 2 },
      { role: "user", content: "a follow-up message", throughSeq: 3 },
      { role: "user", content: "<tool_results>\nread_file(x) → ok\n</tool_results>", throughSeq: 5 },
    ];
    const expectedTail = estimateMessageTokens([
      { role: "user", content: "a follow-up message" },
      { role: "user", content: "<tool_results>\nread_file(x) → ok\n</tool_results>" },
    ]);
    expect(expectedTail).toBeGreaterThan(0);
    expect(providerUsageAnchor(events, messages)).toBe(800 + expectedTail);
    // The PRE-anchor message (throughSeq 1 ≤ 2) contributes NOTHING — the
    // provider already counted it in its own number.
  });

  it("the LAST usage-bearing event wins (a newer assistant reply re-anchors)", () => {
    const events = [
      ev(1, "message.user", "task"),
      ev(2, "message.assistant", "old reply", { inputTokens: 9999, outputTokens: 1 }),
      ev(3, "message.user", "continue"),
      ev(4, "message.assistant", "new reply", { inputTokens: 150, outputTokens: 2 }),
    ];
    const messages: SeqMessage[] = [
      { role: "user", content: "task", throughSeq: 1 },
      { role: "assistant", content: "old reply", throughSeq: 2 },
      { role: "user", content: "continue", throughSeq: 3 },
      { role: "assistant", content: "new reply", throughSeq: 4 },
    ];
    // Anchored at seq 4: nothing after it → exactly the NEWEST number, not 9999.
    expect(providerUsageAnchor(events, messages)).toBe(150);
  });

  it("garbage usage rows are skipped, not trusted — the walk continues to the older usage-bearing event", () => {
    const events: SessionEvent[] = [
      ev(1, "message.user", "task"),
      ev(2, "message.assistant", "honest reply", { inputTokens: 700, outputTokens: 3 }),
      // Newer events with garbage usage — none of them may become the anchor.
      { ...ev(3, "message.assistant", "nan reply", { inputTokens: Number.NaN, outputTokens: 1 }) },
      { ...ev(4, "message.assistant", "zero reply", { inputTokens: 0, outputTokens: 1 }) },
      { ...ev(5, "message.assistant", "negative reply", { inputTokens: -50, outputTokens: 1 }) },
      // An assistant event with NO usage object at all.
      ev(6, "message.assistant", "usage-less reply"),
      // A non-numeric inputTokens under a usage object.
      {
        ...ev(7, "message.assistant", "string reply"),
        payload: { role: "assistant", content: "string reply", usage: { inputTokens: "lots" as unknown as number, outputTokens: 1 } },
      },
    ];
    const messages: SeqMessage[] = [
      { role: "user", content: "task", throughSeq: 1 },
      { role: "assistant", content: "honest reply", throughSeq: 2 },
      { role: "assistant", content: "nan reply", throughSeq: 3 },
    ];
    // The anchor is the seq-2 event + the seq-3 message tail (the seq-3
    // message IS post-anchor even though its own usage row was garbage).
    const expectedTail = estimateMessageTokens([{ role: "assistant", content: "nan reply" }]);
    expect(providerUsageAnchor(events, messages)).toBe(700 + expectedTail);
    // And when ONLY garbage exists → null (the estimate fallback).
    expect(providerUsageAnchor(events.slice(2), [])).toBeNull();
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

  it("returns the SKIP decision when the history fits (R125-C: null pre-R125 → the typed decision)", () => {
    // R125-C (D2, updated pin): the under-budget path returns the typed skip
    // object — { decision: "skip", reason: "below_threshold" } — where it
    // returned null before R125-C (planCompaction never returns null now).
    const skip = planCompaction(manyPairs(2), ROOMY_BUDGET);
    expect(skip.decision).toBe("skip");
    if (skip.decision !== "skip") throw new Error("unreachable");
    expect(skip.reason).toBe("below_threshold");
    // The decision's numbers: the local estimate (no anchor passed), the
    // derived threshold, and the dual-number pair agreeing with itself.
    expect(skip.tokenSource).toBe("estimated");
    expect(skip.threshold).toBe(ROOMY_BUDGET.contextWindow - ROOMY_BUDGET.maxOutputTokens - ROOMY_BUDGET.margin);
    expect(skip.tokenCount).toBe(skip.estimatedTokens);
  });

  it("over budget → summarizes the head, keeps the newest ~60% window ROUND-ALIGNED, keeps at least the final message", () => {
    const messages = manyPairs(10); // 20 messages ≈ 108 tokens each ≈ 2160 tokens > 800
    const plan = planCompaction(messages, TIGHT_BUDGET);
    expect(plan.decision).toBe("compact");
    if (plan.decision !== "compact") throw new Error("unreachable");
    // R125-C (D2): the compact side carries the typed decision too.
    expect(plan.reason).toBe("above_threshold");
    expect(plan.tokenSource).toBe("estimated");
    expect(plan.threshold).toBe(400);
    expect(plan.estimatedTokens).toBeGreaterThan(400);
    expect(plan.toSummarize.length).toBeGreaterThan(0);
    expect(plan.keep.length).toBeGreaterThan(0);
    expect(plan.keep[plan.keep.length - 1]).toBe(messages[messages.length - 1]); // final message kept
    // targetThroughSeq is the seq of the LAST summarized message.
    expect(plan.targetThroughSeq).toBe(plan.toSummarize[plan.toSummarize.length - 1].throughSeq);
    // R128-W8 (D3a, RE-PINNED — the selection is round-aligned now): the
    // byte cut alone fit the ~60% target (240 tokens), but it split the
    // assistant round [a17, u18] mid-exchange — the boundary walked BACK to
    // the round start (index 17), so the keep set is [a17, u18, a19]: it
    // STARTS at an assistant message (no orphaned tool_result tail) and may
    // exceed the 60% target within the materiality guard (target × 1.25 =
    // 300) but never the honest budget math the guard bounds it by.
    expect(plan.keep[0].role).toBe("assistant");
    expect(plan.keep[0]).toBe(messages[17]); // the round START, not the byte cut at 18
    const keepTokens = plan.keep.reduce((acc, m) => acc + Math.ceil(m.content.length / 4) + 8, 0);
    expect(keepTokens).toBeLessThanOrEqual(300);
    // The additive D3a decision fields: round-aligned, two whole assistant
    // rounds preserved verbatim ([a17,u18] + [a19]).
    expect(plan.roundAligned).toBe(true);
    expect(plan.preservedRounds).toBe(2);
    // Summarize + keep covers everything.
    expect(plan.toSummarize.length + plan.keep.length).toBe(messages.length);
  });

  it("a single gigantic message still keeps it (never keep nothing)", () => {
    const messages: SeqMessage[] = [
      { role: "user", content: "x".repeat(20_000), throughSeq: 1 },
      { role: "assistant", content: "y".repeat(20_000), throughSeq: 2 },
    ];
    const plan = planCompaction(messages, TIGHT_BUDGET);
    expect(plan.decision).toBe("compact");
    if (plan.decision !== "compact") throw new Error("unreachable");
    expect(plan.keep.length).toBeGreaterThan(0);
    expect(plan.keep[plan.keep.length - 1].throughSeq).toBe(2);
  });

  // ── R125-C (D1): the tokenOverride law ──────────────────────────────────

  it("R125-C D1: the anchor FORCES a compaction the estimate says is unnecessary (over threshold by the provider's number)", () => {
    // Estimate ≈ 430 tokens < 959,232 available — but the provider reported
    // a number far over the line (the estimator UNDER-counted; the provider
    // is the truth). ZCode compact/policy.ts shouldAutoCompact's
    // `tokenOverride?.tokenCount ?? estimatedTokenCount`, the same law.
    const messages = manyPairs(2);
    const plan = planCompaction(messages, ROOMY_BUDGET, false, { tokenOverride: 1_000_000 });
    expect(plan.decision).toBe("compact");
    if (plan.decision !== "compact") throw new Error("unreachable");
    expect(plan.reason).toBe("above_threshold");
    expect(plan.tokenSource).toBe("provider-anchored");
    // The dual numbers: the anchor won the gate, the estimate is reported
    // alongside (the disagreement is VISIBLE, not silent).
    expect(plan.tokenCount).toBe(1_000_000);
    expect(plan.estimatedTokens).toBeLessThan(1_000);
  });

  it("R125-C D1: the anchor VETOES a compaction the estimate demands — THE key honest case (the estimator over-counted)", () => {
    // Estimate ≈ 2160 tokens > 400 available — the pre-R125 gate would
    // compact. But the provider reported 100 input tokens: the estimator
    // over-counted, and the provider's number wins (a needless compaction
    // burns a summarizer call and destroys fidelity for nothing).
    const messages = manyPairs(10);
    const skip = planCompaction(messages, TIGHT_BUDGET, false, { tokenOverride: 100 });
    expect(skip.decision).toBe("skip");
    if (skip.decision !== "skip") throw new Error("unreachable");
    expect(skip.reason).toBe("below_threshold");
    expect(skip.tokenSource).toBe("provider-anchored");
    expect(skip.tokenCount).toBe(100);
    expect(skip.estimatedTokens).toBeGreaterThan(400); // the over-counted estimate, still reported
    expect(skip.threshold).toBe(400);
  });

  it("R125-C D1: garbage overrides (0 / NaN / negative / Infinity) fall back to the estimate", () => {
    const messages = manyPairs(10); // estimate over TIGHT_BUDGET's 400
    for (const garbage of [0, Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      const plan = planCompaction(messages, TIGHT_BUDGET, false, { tokenOverride: garbage });
      expect(plan.decision).toBe("compact");
      if (plan.decision !== "compact") throw new Error("unreachable");
      expect(plan.tokenSource).toBe("estimated");
      expect(plan.tokenCount).toBe(plan.estimatedTokens);
    }
    // And a finite-positive 401 (just over the 400 line) anchors and compacts:
    expect(planCompaction(manyPairs(10), TIGHT_BUDGET, false, { tokenOverride: 401 }).decision).toBe("compact");
  });

  it("R125-C D2: the legacy paths carry their typed reasons (forced / empty_to_summarize)", () => {
    const messages: SeqMessage[] = [
      { role: "user", content: "the original task", throughSeq: 1 },
      { role: "assistant", content: "did part one", throughSeq: 2 },
      { role: "user", content: "continue", throughSeq: 3 },
    ];
    // force=true under budget → compact with reason "forced" (the R71-e2
    // overflow-recovery semantics: the provider's rejection is ground
    // truth regardless of the estimate).
    const forced = planCompaction(messages, ROOMY_BUDGET, true);
    expect(forced.decision).toBe("compact");
    if (forced.decision !== "compact") throw new Error("unreachable");
    expect(forced.reason).toBe("forced");
    expect(forced.tokenSource).toBe("estimated");
    // A single message + force → the honest empty-head skip (the old null
    // return — the recovery must fail honestly, not invent a compaction).
    const empty = planCompaction([messages[2]], ROOMY_BUDGET, true);
    expect(empty.decision).toBe("skip");
    if (empty.decision !== "skip") throw new Error("unreachable");
    expect(empty.reason).toBe("empty_to_summarize");
  });
});

/* ── assembleWithCompaction (end-to-end with a fake ChatFn) ───────────────── */

/** 6 pairs ≈ 740 tokens > 400 available (user ≈ 71, assistant ≈ 53 each) —
 * hoisted to file scope since R117-b (the compaction→memory bridge tests
 * below seed their own overflowing project-bound sessions with it). */
function seedOverflowingSession(sessionId: string): void {
  for (let i = 0; i < 6; i++) {
    addMessage(sessionId, "message.user", `user message number ${i} — ${"context ".repeat(25)}`);
    addMessage(sessionId, "message.assistant", `assistant message number ${i} — ${"work ".repeat(30)}`);
  }
}

describe("assembleWithCompaction", () => {
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
    // R125-C (D2, added asserts): the persisted event carries the typed
    // decision — the estimate-driven shape here (no tokenOverride passed):
    // tokenSource "estimated", tokenCount === estimatedTokens, the derived
    // threshold, reason "above_threshold".
    expect(payload.tokenSource).toBe("estimated");
    expect(payload.reason).toBe("above_threshold");
    expect(payload.threshold).toBe(400);
    expect(payload.tokenCount).toBe(payload.estimatedTokens);
    expect(typeof payload.tokenCount).toBe("number");
  });

  // ── R125-C (D1): the tokenOverride threading (opts → planCompaction → event) ──

  it("R125-C D1: opts.tokenOverride drives the gate AND rides the persisted event payload (the runtime's threading contract)", async () => {
    // Estimate ≈ 740 tokens < 959,232 available — the estimate says SKIP;
    // the anchor (the provider's reported number) says COMPACT. This pins
    // the exact pass-through the runtime performs at its two call sites.
    const sid = newSession();
    seedOverflowingSession(sid);
    const { chat, calls } = fakeChat();
    const outcome = await assembleWithCompaction(assembleHistory(db, sid), ROOMY_BUDGET, { ...deps(chat), sessionId: sid }, {
      tokenOverride: 1_000_000,
    });
    expect(outcome.compacted).toBe(true);
    expect(calls).toHaveLength(1);
    const payload = listSessionEvents(db, sid).find((e) => e.type === "context.compact")?.payload as Record<
      string,
      unknown
    >;
    expect(payload.tokenSource).toBe("provider-anchored");
    expect(payload.tokenCount).toBe(1_000_000);
    expect(payload.reason).toBe("above_threshold");
    expect(payload.threshold).toBe(ROOMY_BUDGET.contextWindow - ROOMY_BUDGET.maxOutputTokens - ROOMY_BUDGET.margin);
    // The dual-number pair: the local estimate is reported ALONGSIDE the
    // winning provider number (the disagreement is visible).
    expect(typeof payload.estimatedTokens).toBe("number");
    expect(payload.estimatedTokens as number).toBeLessThan(1_000);
  });

  it("R125-C D1: an under-threshold anchor VETOES the compaction the estimate demands — no summarizer call, no event", async () => {
    // Estimate ≈ 740 tokens > 400 available — the pre-R125 gate compacts;
    // the provider reported 100 → the honest veto (nothing persisted, the
    // verbatim list rides on).
    const sid = newSession();
    seedOverflowingSession(sid);
    const { chat, calls } = fakeChat();
    const outcome = await assembleWithCompaction(assembleHistory(db, sid), TIGHT_BUDGET, { ...deps(chat), sessionId: sid }, {
      tokenOverride: 100,
    });
    expect(outcome.compacted).toBe(false);
    expect(calls).toHaveLength(0); // the summarizer never fired
    expect(outcome.messages[0].content).toContain("user message number 0"); // verbatim
    expect(listSessionEvents(db, sid).some((e) => e.type === "context.compact")).toBe(false);
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

/* ── ROUND-117 (R117-b): compaction → memory — the episodic bridge ───────── */

describe("ROUND-117 (R117-b): compaction persists the summary into project memory", () => {
  // The same deps shape the assembleWithCompaction block above uses.
  const deps = (chat: ChatFn) => ({
    db: db as Database.Database,
    sessionId: "",
    chat,
    provider: { id: "prov_openrouter", baseUrl: null, apiFormat: "chat-completions" },
    apiKey: "test-key",
    model: "test/model",
  });

  // A project-bound session helper (the bridge only writes for sessions with
  // a bound project — the projectless newSession() above stays the default
  // for every pre-R117 test in this file).
  function newProjectSession(projectId: string, title: string): string {
    return createSession(db, { agentId: "agt_default_nova", mode: "single", projectId, title }).id;
  }

  it("an over-budget compaction writes a 'Session summary (title): …' note (kind note, source system, ≤400-char slice) into the project's memory", async () => {
    const project = createProject(db, { name: "Bridge", rootPath: join(dir, "bridge-root") });
    const sid = newProjectSession(project.id, "Bridge session");
    seedOverflowingSession(sid);
    const { chat } = fakeChat();
    const outcome = await assembleWithCompaction(assembleHistory(db, sid), TIGHT_BUDGET, { ...deps(chat), sessionId: sid });
    expect(outcome.compacted).toBe(true);

    const memories = listMemories(db, project.id);
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      projectId: project.id,
      scope: "project",
      kind: "note",
      source: "system", // the deterministic writer, distinguishable from agent/owner saves
    });
    const prefix = "Session summary (Bridge session): ";
    expect(memories[0].content.startsWith(prefix)).toBe(true);
    expect(memories[0].content.slice(prefix.length)).toContain("the agent built feature X");
    // The slice is a POINTER + a taste (the full summary stays in the event log).
    expect(memories[0].content.length).toBeLessThanOrEqual(prefix.length + 400);

    // A LONG summary is sliced to the 400-char cap.
    const longProject = createProject(db, { name: "Bridge Long", rootPath: join(dir, "bridge-long-root") });
    const sid2 = newProjectSession(longProject.id, "Long session");
    seedOverflowingSession(sid2);
    const longSummary = "L".repeat(600);
    const { chat: longChat } = fakeChat(longSummary);
    await assembleWithCompaction(assembleHistory(db, sid2), TIGHT_BUDGET, { ...deps(longChat), sessionId: sid2 });
    const longMemories = listMemories(db, longProject.id);
    expect(longMemories).toHaveLength(1);
    expect(longMemories[0].content.length).toBe("Session summary (Long session): ".length + 400);
  });

  it("skips honestly: a projectless session or a disabled memory master switch writes NO memory row (the compaction itself still succeeds)", async () => {
    // Projectless (the pre-R117 CLI world): compaction works, no memory write.
    const projectless = newSession();
    seedOverflowingSession(projectless);
    const { chat } = fakeChat();
    const outcome = await assembleWithCompaction(assembleHistory(db, projectless), TIGHT_BUDGET, { ...deps(chat), sessionId: projectless });
    expect(outcome.compacted).toBe(true);

    // Memory OFF: same — best-effort, never a compaction failure mode.
    const project = createProject(db, { name: "Bridge Off", rootPath: join(dir, "bridge-off-root") });
    setMemorySettings(db, { enabled: false });
    const offSession = newProjectSession(project.id, "Off session");
    seedOverflowingSession(offSession);
    const offOutcome = await assembleWithCompaction(assembleHistory(db, offSession), TIGHT_BUDGET, { ...deps(chat), sessionId: offSession });
    expect(offOutcome.compacted).toBe(true);

    // Nothing landed anywhere (both scopes empty).
    expect(listMemories(db, project.id)).toHaveLength(0);
    expect(listWorkspaceMemories(db)).toHaveLength(0);
  });

  it("dedup: identical summary text (same session title) REFRESHES the row — re-compact does not duplicate; different text adds a second row", async () => {
    const project = createProject(db, { name: "Bridge Dedup", rootPath: join(dir, "bridge-dedup-root") });
    // Two sessions with the SAME title + the same canned summary → ONE row.
    const sidA = newProjectSession(project.id, "Twin session");
    seedOverflowingSession(sidA);
    const { chat } = fakeChat();
    await assembleWithCompaction(assembleHistory(db, sidA), TIGHT_BUDGET, { ...deps(chat), sessionId: sidA });
    const sidB = newProjectSession(project.id, "Twin session");
    seedOverflowingSession(sidB);
    await assembleWithCompaction(assembleHistory(db, sidB), TIGHT_BUDGET, { ...deps(chat), sessionId: sidB });
    expect(listMemories(db, project.id)).toHaveLength(1); // refreshed, not duplicated

    // A re-compact of the SAME session producing DIFFERENT text (round-2
    // folds the old summary) adds a second, distinct row.
    const sidC = newProjectSession(project.id, "Round two session");
    seedOverflowingSession(sidC);
    const { chat: roundChat } = fakeChat("DIFFERENT: the round-two summary covers new ground.");
    await assembleWithCompaction(assembleHistory(db, sidC), TIGHT_BUDGET, { ...deps(roundChat), sessionId: sidC });
    // Overflow again → a NEW compaction over the (already compacted) log.
    for (let i = 10; i < 16; i++) {
      addMessage(sidC, "message.user", `later user message ${i} — ${"more context ".repeat(25)}`);
      addMessage(sidC, "message.assistant", `later assistant message ${i} — ${"more work ".repeat(30)}`);
    }
    await assembleWithCompaction(assembleHistory(db, sidC), TIGHT_BUDGET, { ...deps(roundChat), sessionId: sidC });
    const memories = listMemories(db, project.id);
    expect(memories.length).toBe(2);
    expect(memories.some((m) => m.content.includes("DIFFERENT: the round-two summary"))).toBe(true);
    expect(memories.every((m) => m.source === "system")).toBe(true);
  });
});

/* ── ROUND-125 (R125-C, D1): the runtime integration — the anchor threading ── */

describe("ROUND-125 (R125-C): runStreamedAgentTurn builds + threads the provider-usage anchor", () => {
  // The full turn-level pin of the runtime's own expression —
  // providerUsageAnchor(listSessionEvents(db, session.id), rawMessages) —
  // computed at the streamed call site and threaded through
  // assembleWithCompaction's opts.tokenOverride into planCompaction's gate.
  // (The r120-harness pattern: a fake chatStream, a summarizer chat, a
  // tiny-window models row so the budget is test-small.)
  const USER1 = "the original task for this session";
  const ASSISTANT1 = "part one is complete";
  const FOLLOW_UP = "a follow-up message that came later";
  const TURN_CONTENT = "please finish the remaining work";

  it("the provider's stale-large number + estimated tail drives the compaction the estimate alone would skip — the event payload AND the live meta.compaction frame carry the typed decision", async () => {
    // A models row with a small window: available = 10_000 − 100 − 8_000 = 1_900.
    // The visible content is ~100 tokens (the estimate says SKIP); the
    // provider reported 5_000 input tokens for its last reply (the honest
    // under-count case — the anchor says COMPACT).
    upsertModel(db, "openrouter", { modelId: "test/r125c-1", contextWindow: 10_000, maxOutputTokens: 100 });
    const agent = createAgent(db, { name: "R125C Agent", providerId: "openrouter", model: "test/r125c-1" });
    const sid = createSession(db, { agentId: agent.id, mode: "single", projectId: null }).id;
    addMessage(sid, "message.user", USER1);
    appendSessionEvent(db, sid, {
      type: "message.assistant",
      agentId: agent.id,
      payload: { role: "assistant", content: ASSISTANT1, usage: { inputTokens: 5_000, outputTokens: 12 } },
    });
    addMessage(sid, "message.user", FOLLOW_UP);

    const summarizer: ChatFn = async () => ({
      text: "SUMMARY: the original task and part one.",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [],
    });
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      yield { type: "text-delta", delta: "all remaining work is done" };
      yield { type: "finish", usage: { inputTokens: 30, outputTokens: 4, totalTokens: 34 } };
    };
    const emitted: Array<Record<string, unknown>> = [];
    const outcome = await runStreamedAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: "sk-test-r125c" }), chat: summarizer, chatStream },
      sid,
      TURN_CONTENT,
      (event) => emitted.push(event as Record<string, unknown>),
    );
    expect(outcome.ok).toBe(true);

    // The exact numbers the runtime computed, derived from the same pure
    // estimator the production gate reports with:
    const expectedTail = estimateMessageTokens([
      { role: "user", content: FOLLOW_UP },
      { role: "user", content: TURN_CONTENT },
    ]);
    const expectedEstimate = estimateMessageTokens([
      { role: "user", content: USER1 },
      { role: "assistant", content: ASSISTANT1 },
      { role: "user", content: FOLLOW_UP },
      { role: "user", content: TURN_CONTENT },
    ]);
    // The whole visible list is FAR under the 1_900 line — only the anchor
    // could have tripped the gate (the D1 law under test).
    expect(expectedEstimate).toBeLessThan(1_900);

    // The persisted event: the typed decision with the provider-anchored
    // numbers (tokenCount = 5_000 + the estimated post-anchor tail).
    const payload = listSessionEvents(db, sid)
      .find((e) => e.type === "context.compact")
      ?.payload as Record<string, unknown>;
    expect(payload).toBeDefined();
    expect(payload.tokenSource).toBe("provider-anchored");
    expect(payload.reason).toBe("above_threshold");
    expect(payload.threshold).toBe(1_900);
    expect(payload.tokenCount).toBe(5_000 + expectedTail);
    expect(payload.estimatedTokens).toBe(expectedEstimate);

    // The live frame mirrors the same dual numbers + reason (additive keys).
    const frame = emitted.find((e) => e.type === "meta.compaction");
    expect(frame).toBeDefined();
    expect(frame?.tokenSource).toBe("provider-anchored");
    expect(frame?.reason).toBe("above_threshold");
    expect(frame?.tokenCount).toBe(5_000 + expectedTail);
    expect(frame?.threshold).toBe(1_900);
    expect(frame?.estimatedTokens).toBe(expectedEstimate);
    // The turn itself completed on the compacted list (the real reply landed).
    const reply = listSessionEvents(db, sid).find((e) => e.type === "message.assistant" && e.seq > 4);
    expect((reply?.payload as { content?: string }).content).toContain("all remaining work is done");
  });
});
