/**
 * ROUND-128 (R128-W8) — the ZCode D3+D5 compaction adoption
 * (agent-ctx/research/zcode-context-compression.md §D3/§D5):
 *
 *   - D3a ROUND-ALIGNED SELECTION: groupByAssistantStartedRounds (the pure
 *     grouping helper — head group, assistant rounds, trailing users) +
 *     planCompaction's boundary math (the byte cut walks BACK to the start
 *     of the oldest kept assistant round; the materiality guard's honest
 *     fallback; the additive roundAligned/preservedRounds fields).
 *   - D3b ANCHOR INVALIDATION: providerUsageAnchor skips every usage event
 *     at-or-before the newest compaction EVENT (the keep-set tail included —
 *     those inputTokens measured the pre-compaction serialization, the
 *     documented stale-anchor over-trigger) and returns null until a
 *     post-boundary provider reply re-anchors.
 *   - D5 RAPID-REFILL CIRCUIT BREAKER: evaluateRapidRefill's decision table
 *     (3×<3-tool-turn compactions → block; the reset after a compaction
 *     followed by ≥3 tool turns; the manual-force bypass) + the
 *     assembleWithCompaction integration (blocked → no summarizer call, no
 *     event, ONE teaching turn.warning; force compacts anyway).
 *   - The additive payload fields round-trip findLatestCompaction's typed
 *     guards exactly the R125-C way (old events lack them; garbage drops to
 *     absent).
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { appendSessionEvent, createSession, listSessionEvents, type SessionEvent } from "../src/storage/sessions";
import {
  assembleWithCompaction,
  evaluateRapidRefill,
  findLatestCompaction,
  groupByAssistantStartedRounds,
  MAX_CONSECUTIVE_RAPID_REFILLS,
  planCompaction,
  providerUsageAnchor,
  RAPID_REFILL_TOOL_TURN_THRESHOLD,
  RAPID_REFILL_WARNING_KIND,
  RAPID_REFILL_WARNING_MESSAGE,
  ROUND_EXTENSION_TOLERANCE,
  type SeqMessage,
} from "../src/agents/compaction";
import { assembleHistory } from "../src/agents/runtime";
import type { ChatFn, ChatTurnInput } from "../src/agents/chat";
import { estimateMessageTokens } from "../src/context";

const dir = mkdtempSync(join(tmpdir(), "acute-r128-d3d5-"));

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

/** A budget with a tiny window so tests can overflow it with few messages
 * (available 400 → keep-target 240 → extension guard at 300). */
const TIGHT_BUDGET = { contextWindow: 600, maxOutputTokens: 100, margin: 100 };
const ROOMY_BUDGET = { contextWindow: 1_000_000, maxOutputTokens: 32_768, margin: 8_000 };

/** A pure letter-run message ("x"×chars estimates to round(chars/4.5+0.1)+8
 * tokens — the estimator's single-segment arithmetic, stable for pins). */
function msg(role: "user" | "assistant", chars: number, throughSeq: number, label = `${role[0]}${throughSeq}`): SeqMessage {
  return { role, content: `${label}: ${"x".repeat(chars)}`, throughSeq };
}

/** Fake ChatFn that records every call; returns a canned summary. */
function fakeChat(summary = "SUMMARY: the agent built feature X across a.ts and b.ts; error E was fixed; next step is tests."): {
  chat: ChatFn;
  calls: ChatTurnInput[];
} {
  const calls: ChatTurnInput[] = [];
  const chat: ChatFn = async (input) => {
    calls.push(input);
    return { text: summary, usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, toolCalls: [] };
  };
  return { chat, calls };
}

const deps = (chat: ChatFn, sessionId: string) => ({
  db: db as Database.Database,
  sessionId,
  chat,
  provider: { id: "prov_openrouter", baseUrl: null, apiFormat: "chat-completions" },
  apiKey: "test-key",
  model: "test/model",
});

/* ── D3a: groupByAssistantStartedRounds (the pure grouping helper) ───────── */

describe("ROUND-128 (R128-W8, D3a): groupByAssistantStartedRounds", () => {
  const flat = (groups: ReturnType<typeof groupByAssistantStartedRounds>): Array<[string, boolean]> =>
    groups.map((g) => [g.messages.map((m) => (m.role === "user" ? "u" : "a")).join(""), g.assistantStarted]);

  it("leading user messages form their own HEAD group; each assistant starts a round that swallows its trailing users/tool blocks", () => {
    // The canonical assembled shape: user prose, then assistant exchanges
    // whose tool_results blocks are user-role messages.
    const messages = [
      msg("user", 10, 1, "u0"),
      msg("user", 10, 2, "u1"),
      msg("assistant", 10, 3, "a2"),
      msg("user", 10, 4, "tool"), // a2's tool_results block
      msg("assistant", 10, 5, "a4"),
      msg("user", 10, 6, "u5"),
      msg("user", 10, 7, "u6"),
    ];
    expect(flat(groupByAssistantStartedRounds(messages))).toEqual([
      ["uu", false], // the head group
      ["au", true], // a2 + its tool block
      ["auu", true], // a4 + trailing users
    ]);
  });

  it("an empty list groups to nothing; a user-only list is ONE head group", () => {
    expect(groupByAssistantStartedRounds([])).toEqual([]);
    expect(flat(groupByAssistantStartedRounds([msg("user", 10, 1), msg("user", 10, 2)]))).toEqual([["uu", false]]);
  });

  it("consecutive assistant messages each start their OWN round (no assistant-id seam to merge streaming segments)", () => {
    expect(flat(groupByAssistantStartedRounds([msg("assistant", 10, 1), msg("assistant", 10, 2)]))).toEqual([
      ["a", false], // the degenerate opening segment — functions as the head
      ["a", true],
    ]);
  });

  it("a list that STARTS with an assistant keeps its opening segment as the head group (ZCode rounds.ts's current.length>0 law)", () => {
    expect(flat(groupByAssistantStartedRounds([msg("assistant", 10, 1), msg("user", 10, 2), msg("assistant", 10, 3)]))).toEqual([
      ["au", false],
      ["a", true],
    ]);
  });

  it("every group is a contiguous partition of the input (order + membership preserved)", () => {
    const messages = [msg("user", 10, 1), msg("assistant", 10, 2), msg("user", 10, 3), msg("assistant", 10, 4)];
    const groups = groupByAssistantStartedRounds(messages);
    expect(groups.flatMap((g) => g.messages)).toEqual(messages);
  });
});

/* ── D3a: planCompaction's round-aligned boundary math ───────────────────── */

describe("ROUND-128 (R128-W8, D3a): planCompaction round-aligned boundary math", () => {
  it("a MID-ROUND byte cut EXTENDS back to the round start — the assistant's whole exchange rides in the keep set", () => {
    // Groups: head=[u0], round1=[a1,u2,u3], round2=[a4,u5,u6]. The byte cut
    // lands on u5 (a4's 186 tokens just overflow the 240 target) — inside
    // round2 — so the boundary walks back to a4 and the keep set is the
    // WHOLE round2.
    const messages = [
      msg("user", 400, 1),
      msg("assistant", 400, 2),
      msg("user", 400, 3),
      msg("user", 400, 4),
      msg("assistant", 800, 5),
      msg("user", 100, 6),
      msg("user", 100, 7),
    ];
    const plan = planCompaction(messages, TIGHT_BUDGET);
    expect(plan.decision).toBe("compact");
    if (plan.decision !== "compact") throw new Error("unreachable");
    // The exact selection: summarize [u0..u3], keep the whole round2.
    expect(plan.toSummarize).toEqual(messages.slice(0, 4));
    expect(plan.keep).toEqual(messages.slice(4));
    expect(plan.keep[0].role).toBe("assistant"); // never an orphaned tool tail
    expect(plan.targetThroughSeq).toBe(4); // u3 — the last summarized message
    // The additive decision fields.
    expect(plan.roundAligned).toBe(true);
    expect(plan.preservedRounds).toBe(1); // round2 only (round1 is summarized)
    // The extended keep fits the materiality guard (240 × 1.25 = 300), even
    // though it exceeds the 60% target itself.
    const keepTokens = plan.keep.reduce(
      (acc, m) => acc + Math.round((m.content.length - 4) / 4.5 + 0.1) + 8,
      0,
    );
    expect(keepTokens).toBeGreaterThan(240); // the extension is real
    expect(keepTokens).toBeLessThanOrEqual(240 * ROUND_EXTENSION_TOLERANCE);
  });

  it("a byte cut that already sits ON a round start extends nothing", () => {
    // Groups: head=[u0], round1=[a1,u2], round2=[a3,u4]. The byte cut lands
    // exactly on a3 — already round-aligned.
    const messages = [
      msg("user", 400, 1),
      msg("assistant", 400, 2),
      msg("user", 400, 3),
      msg("assistant", 400, 4),
      msg("user", 500, 5),
    ];
    const plan = planCompaction(messages, TIGHT_BUDGET);
    expect(plan.decision).toBe("compact");
    if (plan.decision !== "compact") throw new Error("unreachable");
    expect(plan.keep).toEqual(messages.slice(3)); // starts AT a3
    expect(plan.targetThroughSeq).toBe(3);
    expect(plan.roundAligned).toBe(true);
    expect(plan.preservedRounds).toBe(1);
  });

  it("a boundary inside the HEAD group does not extend (leading user prose is not a round; no round is split)", () => {
    // No assistant messages at all: one head group, nothing to align — the
    // byte cut stands and the plan honestly says roundAligned (vacuously:
    // no assistant round is split) with zero preserved rounds.
    const messages = Array.from({ length: 8 }, (_, i) => msg("user", 200, i + 1));
    const plan = planCompaction(messages, TIGHT_BUDGET);
    expect(plan.decision).toBe("compact");
    if (plan.decision !== "compact") throw new Error("unreachable");
    expect(plan.keep).toEqual(messages.slice(4));
    expect(plan.roundAligned).toBe(true);
    expect(plan.preservedRounds).toBe(0);
  });

  it("MATERIALITY GUARD: a gigantic partial round aborts the extension — the byte cut stands, roundAligned:false (the honest fallback)", () => {
    // Groups: head=[u0], round1=[a1(453 tokens!),u2,u3], round2=[a4,u5]. The
    // byte cut lands on u2 (inside round1); extending back to a1 would push
    // the keep set to ~640 tokens — far past the 300-token guard — so the
    // byte cut stands and the split round is honestly reported.
    const messages = [
      msg("user", 400, 1),
      msg("assistant", 2000, 2),
      msg("user", 100, 3),
      msg("user", 100, 4),
      msg("assistant", 400, 5),
      msg("user", 100, 6),
    ];
    const plan = planCompaction(messages, TIGHT_BUDGET);
    expect(plan.decision).toBe("compact");
    if (plan.decision !== "compact") throw new Error("unreachable");
    expect(plan.keep).toEqual(messages.slice(2)); // the byte cut, NOT the round start
    expect(plan.keep[0].role).toBe("user"); // the split is real (a1 summarized, u2 kept)
    expect(plan.targetThroughSeq).toBe(2); // a1 itself is the last summarized message
    expect(plan.roundAligned).toBe(false); // the logged fallback decision
    expect(plan.preservedRounds).toBe(1); // round2 only — round1 is split, not preserved
    expect(plan.toSummarize.length + plan.keep.length).toBe(messages.length);
  });

  it("the ALIGNMENT INVARIANT: when roundAligned is true, every assistant-started round is wholly inside keep OR wholly inside toSummarize", () => {
    // The manyPairs shape from context-compaction.test.ts: 10 alternating
    // pairs whose byte cut lands mid-round and extends.
    const messages: SeqMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "user", content: `task message ${i} `.repeat(20), throughSeq: i * 2 + 1 });
      messages.push({ role: "assistant", content: `assistant reply ${i} `.repeat(20), throughSeq: i * 2 + 2 });
    }
    for (const plan of [planCompaction(messages, TIGHT_BUDGET), planCompaction(messages, TIGHT_BUDGET, true)]) {
      expect(plan.decision).toBe("compact");
      if (plan.decision !== "compact") throw new Error("unreachable");
      expect(plan.roundAligned).toBe(true);
      const keepStart = messages.length - plan.keep.length;
      let index = 0;
      for (const group of groupByAssistantStartedRounds(messages)) {
        if (group.assistantStarted) {
          const whollyKept = index >= keepStart;
          const whollySummarized = index + group.messages.length <= keepStart;
          expect(whollyKept || whollySummarized).toBe(true); // never split
        }
        index += group.messages.length;
      }
      // The LAST round is always preserved verbatim (ZCode's
      // preserve-the-last-round law, wearing ACUTE's keep-window shape).
      const lastRoundStart = messages.map((m) => m.role === "assistant").lastIndexOf(true);
      expect(keepStart).toBeLessThanOrEqual(lastRoundStart);
    }
  });

  it("the SKIP paths carry no selection fields (round alignment only exists when a boundary was chosen)", () => {
    const underBudget = planCompaction([msg("user", 100, 1), msg("assistant", 100, 2)], ROOMY_BUDGET);
    expect(underBudget.decision).toBe("skip");
    expect("roundAligned" in underBudget).toBe(false);
    expect("preservedRounds" in underBudget).toBe(false);
    const empty = planCompaction([msg("user", 100, 1)], ROOMY_BUDGET, true);
    expect(empty.decision).toBe("skip");
    expect("roundAligned" in empty).toBe(false);
  });
});

/* ── D3b: providerUsageAnchor invalidation ───────────────────────────────── */

describe("ROUND-128 (R128-W8, D3b): providerUsageAnchor skips pre-boundary usage", () => {
  const ts = (seq: number) => `2026-01-01T00:00:${String(seq % 60).padStart(2, "0")}Z`;
  const userEv = (seq: number, content: string): SessionEvent => ({
    seq,
    type: "message.user",
    agentId: null,
    payload: { role: "user", content },
    ts: ts(seq),
  });
  const assistantEv = (seq: number, content: string, usage?: { inputTokens: number; outputTokens: number }): SessionEvent => ({
    seq,
    type: "message.assistant",
    agentId: null,
    payload: { role: "assistant", content, ...(usage !== undefined ? { usage } : {}) },
    ts: ts(seq),
  });
  const compactEv = (seq: number, throughSeq: number): SessionEvent => ({
    seq,
    type: "context.compact",
    agentId: null,
    payload: { summary: "the seeded summary", throughSeq, droppedMessages: 1, tokensSaved: 10 },
    ts: ts(seq),
  });
  const toolEv = (seq: number): SessionEvent => ({
    seq,
    type: "tool.use",
    agentId: null,
    payload: { role: "tool", toolName: "read_file", argsSummary: "read", ok: true, outputSummary: "out" },
    ts: ts(seq),
  });

  it("a POST-boundary assistant anchors (the provider's own number + the estimated tail after it)", () => {
    const events = [
      userEv(1, "task"),
      assistantEv(2, "old reply", { inputTokens: 9000, outputTokens: 5 }),
      userEv(3, "follow-up"),
      compactEv(4, 2),
      assistantEv(5, "the re-anchoring reply", { inputTokens: 200, outputTokens: 7 }),
      userEv(6, "one more message"),
    ];
    const messages: SeqMessage[] = [
      { role: "user", content: "task", throughSeq: 1 },
      { role: "assistant", content: "old reply", throughSeq: 2 },
      { role: "user", content: "follow-up", throughSeq: 3 },
      { role: "assistant", content: "the re-anchoring reply", throughSeq: 5 },
      { role: "user", content: "one more message", throughSeq: 6 },
    ];
    // The seq-2 usage (9000) is pre-boundary and MUST be ignored; the
    // seq-5 reply is the anchor, with only the seq-6 message after it.
    const expectedTail = estimateMessageTokens([{ role: "user", content: "one more message" }]);
    const anchor = providerUsageAnchor(events, messages);
    expect(anchor).not.toBeNull();
    expect(anchor).toBe(200 + expectedTail);
  });

  it("NO post-boundary assistant → null (right after a compaction, before any new provider reply — the honest no-anchor)", () => {
    const events = [userEv(1, "task"), assistantEv(2, "the only reply", { inputTokens: 9000, outputTokens: 5 }), compactEv(3, 2)];
    const messages: SeqMessage[] = [
      { role: "user", content: "task", throughSeq: 1 },
      { role: "assistant", content: "the only reply", throughSeq: 2 },
    ];
    expect(providerUsageAnchor(events, messages)).toBeNull();
  });

  it("THE STALE-ANCHOR KILL: a KEEP-SET assistant (seq > throughSeq but persisted BEFORE the compaction event) is INVALID too", () => {
    // The keep-set assistant survived compaction (its seq 4 > throughSeq 2)
    // but its usage was measured over the PRE-compaction serialization —
    // the documented over-trigger window. D3b skips it: null.
    const events = [
      userEv(1, "task"),
      assistantEv(2, "summarized reply", { inputTokens: 9000, outputTokens: 5 }),
      userEv(3, "follow-up"),
      assistantEv(4, "keep-set reply", { inputTokens: 5000, outputTokens: 5 }),
      compactEv(5, 2),
    ];
    const messages: SeqMessage[] = [
      { role: "user", content: "task", throughSeq: 1 },
      { role: "assistant", content: "summarized reply", throughSeq: 2 },
      { role: "user", content: "follow-up", throughSeq: 3 },
      { role: "assistant", content: "keep-set reply", throughSeq: 4 },
    ];
    expect(providerUsageAnchor(events, messages)).toBeNull();
  });

  it("NO compaction → the R125-C law byte-identical (the newest usage event + its estimated tail)", () => {
    const events = [
      userEv(1, "the original task"),
      assistantEv(2, "part one done", { inputTokens: 800, outputTokens: 5 }),
      userEv(3, "a follow-up message"),
      toolEv(4),
    ];
    const messages: SeqMessage[] = [
      { role: "user", content: "the original task", throughSeq: 1 },
      { role: "assistant", content: "part one done", throughSeq: 2 },
      { role: "user", content: "a follow-up message", throughSeq: 3 },
      { role: "user", content: "<tool_results>\nread_file(x) → ok\n</tool_results>", throughSeq: 4 },
    ];
    const expectedTail = estimateMessageTokens([
      { role: "user", content: "a follow-up message" },
      { role: "user", content: "<tool_results>\nread_file(x) → ok\n</tool_results>" },
    ]);
    expect(expectedTail).toBeGreaterThan(0);
    expect(providerUsageAnchor(events, messages)).toBe(800 + expectedTail);
  });

  it("a MALFORMED newest compaction poisons the boundary to absent (findLatestCompaction's twin law) — the newest usage anchors", () => {
    const events = [
      userEv(1, "task"),
      assistantEv(2, "honest reply", { inputTokens: 700, outputTokens: 3 }),
      { ...compactEv(3, 2), payload: { summary: "   ", throughSeq: 2, droppedMessages: 1, tokensSaved: 10 } },
    ];
    const messages: SeqMessage[] = [
      { role: "user", content: "task", throughSeq: 1 },
      { role: "assistant", content: "honest reply", throughSeq: 2 },
    ];
    expect(providerUsageAnchor(events, messages)).toBe(700);
  });

  it("garbage post-boundary usage rows are skipped — and if only PRE-boundary honest rows remain, null", () => {
    // A garbage post-boundary assistant (NaN), then the compaction, then an
    // honest PRE-boundary assistant: the walk skips the garbage, hits the
    // boundary, and honestly returns null (never trusts the stale number).
    const events = [
      userEv(1, "task"),
      assistantEv(2, "stale honest reply", { inputTokens: 700, outputTokens: 3 }),
      compactEv(3, 2),
      { ...assistantEv(4, "garbage reply"), payload: { role: "assistant", content: "garbage reply", usage: { inputTokens: Number.NaN, outputTokens: 1 } } },
    ];
    const messages: SeqMessage[] = [
      { role: "user", content: "task", throughSeq: 1 },
      { role: "assistant", content: "stale honest reply", throughSeq: 2 },
    ];
    expect(providerUsageAnchor(events, messages)).toBeNull();
  });
});

/* ── D5: evaluateRapidRefill — the pure decision table ───────────────────── */

describe("ROUND-128 (R128-W8, D5): evaluateRapidRefill decision table", () => {
  const ts = (seq: number) => `2026-01-01T00:00:${String(seq % 60).padStart(2, "0")}Z`;
  let seq = 0;
  const next = () => (seq += 1);
  const C = (): SessionEvent => ({
    seq: next(),
    type: "context.compact",
    agentId: null,
    payload: { summary: "s", throughSeq: 1, droppedMessages: 1, tokensSaved: 1 },
    ts: ts(seq),
  });
  const T = (n = 1): SessionEvent[] =>
    Array.from({ length: n }, () => ({
      seq: next(),
      type: "tool.use",
      agentId: null,
      payload: { role: "tool", toolName: "read_file", argsSummary: "r", ok: true, outputSummary: "o" },
      ts: ts(seq),
    }) as SessionEvent);
  const M = (): SessionEvent => ({
    seq: next(),
    type: "message.user",
    agentId: null,
    payload: { role: "user", content: "noise that never counts" },
    ts: ts(seq),
  });

  beforeEach(() => {
    seq = 0;
  });

  it("no compactions (or fewer than MAX_CONSECUTIVE_RAPID_REFILLS) → never blocked", () => {
    expect(evaluateRapidRefill([]).blocked).toBe(false);
    expect(evaluateRapidRefill([...T(10)]).blocked).toBe(false);
    // Two rapid compactions, nothing since: streak 2 < 3.
    const two = evaluateRapidRefill([C(), C()]);
    expect(two.blocked).toBe(false);
    expect(two.consecutiveRapidRefills).toBe(2);
    expect(two.gaps).toEqual([0, 0]);
    expect(two.toolUsesSinceLastCompact).toBe(0);
  });

  it("3×<3-tool-turn compactions → BLOCKED (the letter's marquee row)", () => {
    const decision = evaluateRapidRefill([C(), C(), C()]);
    expect(decision.blocked).toBe(true);
    expect(decision.compactions).toBe(3);
    expect(decision.consecutiveRapidRefills).toBe(MAX_CONSECUTIVE_RAPID_REFILLS);
    expect(decision.gaps).toEqual([0, 0, 0]);
  });

  it("2 rapid compactions then a FAT gap (≥3 tool turns before the next) → allowed — the streak broke", () => {
    // C1, C2 rapid; then 5 tool turns; a third compaction with that fat gap
    // is NOT rapid — the trailing streak is 0.
    const decision = evaluateRapidRefill([C(), C(), ...T(5), C()]);
    expect(decision.gaps).toEqual([0, 0, 5]);
    expect(decision.consecutiveRapidRefills).toBe(0);
    expect(decision.blocked).toBe(false);
  });

  it("3 rapid compactions THEN ≥3 tool turns (the RESET) → the next compaction is allowed — a session that recovered is not punished for its past", () => {
    const decision = evaluateRapidRefill([C(), C(), C(), ...T(RAPID_REFILL_TOOL_TURN_THRESHOLD)]);
    expect(decision.consecutiveRapidRefills).toBe(3);
    expect(decision.toolUsesSinceLastCompact).toBe(RAPID_REFILL_TOOL_TURN_THRESHOLD);
    expect(decision.blocked).toBe(false);
  });

  it("4+ rapid compactions with nothing since → still blocked (the streak only grows past the threshold)", () => {
    const decision = evaluateRapidRefill([C(), C(), C(), C()]);
    expect(decision.consecutiveRapidRefills).toBe(4);
    expect(decision.blocked).toBe(true);
  });

  it("only tool.use events count as tool turns — message events never inflate a gap", () => {
    const decision = evaluateRapidRefill([C(), M(), M(), M(), C(), M(), C()]);
    expect(decision.gaps).toEqual([0, 0, 0]);
    expect(decision.blocked).toBe(true);
  });

  it("mixed cadence: rapid, healthy, rapid → streak 1 (the healthy compaction broke the tail)", () => {
    const decision = evaluateRapidRefill([C(), ...T(2), C(), ...T(9), C()]);
    expect(decision.gaps).toEqual([0, 2, 9]);
    expect(decision.consecutiveRapidRefills).toBe(0); // the LAST gap (9) is healthy
    expect(decision.blocked).toBe(false);
  });
});

/* ── D5 + D3a: the assembleWithCompaction integration ────────────────────── */

describe("ROUND-128 (R128-W8, D5): assembleWithCompaction breaker integration", () => {
  /** An over-budget session (~88-token messages × 12 ≈ 1056 ≫ 400 — sized
   * so the round extension stays inside the materiality guard). */
  function seedOverflowing(sessionId: string): void {
    for (let i = 0; i < 6; i++) {
      appendSessionEvent(db, sessionId, {
        type: "message.user",
        agentId: "agt_default_nova",
        payload: { role: "user", content: `user message ${i} — ${"x".repeat(360)}` },
      });
      appendSessionEvent(db, sessionId, {
        type: "message.assistant",
        agentId: "agt_default_nova",
        payload: { role: "assistant", content: `assistant reply ${i} — ${"x".repeat(360)}` },
      });
    }
  }

  /** Three landed compactions with NO tool turns between (gaps [0,0,0]).
   * throughSeq=1 keeps them valid-but-nearly-inert for assembly. */
  function seedRapidRefillStreak(sessionId: string): void {
    for (let i = 0; i < 3; i++) {
      appendSessionEvent(db, sessionId, {
        type: "context.compact",
        agentId: null,
        payload: { summary: `streak summary ${i}`, throughSeq: 1, droppedMessages: 1, tokensSaved: 10 },
      });
    }
  }

  it("BLOCKED: the 3×rapid streak skips the compaction — no summarizer call, no event, ONE teaching turn.warning, raw messages ride on", async () => {
    const sid = newSession();
    seedOverflowing(sid);
    seedRapidRefillStreak(sid);
    const { chat, calls } = fakeChat();

    const outcome = await assembleWithCompaction(assembleHistory(db, sid), TIGHT_BUDGET, deps(chat, sid));
    expect(outcome.compacted).toBe(false);
    expect(calls).toHaveLength(0); // the summarizer never fired
    // No NEW compaction event (still exactly the 3 seeded ones).
    expect(listSessionEvents(db, sid).filter((e) => e.type === "context.compact")).toHaveLength(3);
    // The raw (prior-compaction-applied) list: the seeded streak's newest
    // summary leads; the legacy trim marker is absent.
    expect(outcome.messages[0].content).toContain("streak summary 2");
    expect(outcome.messages[0].content).toContain("[Earlier conversation compacted");
    expect(outcome.messages.some((m) => m.content.includes("[Earlier conversation was trimmed"))).toBe(false);

    // The ONE teaching warning — the loop-guard warnings' payload shape.
    const warnings = listSessionEvents(db, sid).filter((e) => e.type === "turn.warning");
    expect(warnings).toHaveLength(1);
    const payload = warnings[0].payload as Record<string, unknown>;
    expect(payload.kind).toBe(RAPID_REFILL_WARNING_KIND);
    expect(payload.message).toBe(RAPID_REFILL_WARNING_MESSAGE);
    expect(payload.message).toContain("compacting faster than the conversation fills");
    expect(payload.message).toContain("POST /sessions/:id/compact");
    expect(payload.consecutiveRapidRefills).toBe(3);
    expect(payload.compactions).toBe(3);
    expect(payload.toolTurnsSinceLastCompact).toBe(0);
  });

  it("dedup: a second blocked assembly does NOT append a second warning (one per episode)", async () => {
    const sid = newSession();
    seedOverflowing(sid);
    seedRapidRefillStreak(sid);
    const { chat } = fakeChat();
    await assembleWithCompaction(assembleHistory(db, sid), TIGHT_BUDGET, deps(chat, sid));
    await assembleWithCompaction(assembleHistory(db, sid), TIGHT_BUDGET, deps(chat, sid));
    await assembleWithCompaction(assembleHistory(db, sid), TIGHT_BUDGET, deps(chat, sid));
    expect(listSessionEvents(db, sid).filter((e) => e.type === "turn.warning")).toHaveLength(1);
  });

  it("MANUAL FORCE BYPASS: { force: true } compacts straight through the streak (the manual route / overflow-recovery law)", async () => {
    const sid = newSession();
    seedOverflowing(sid);
    seedRapidRefillStreak(sid);
    const { chat, calls } = fakeChat();

    const outcome = await assembleWithCompaction(assembleHistory(db, sid), TIGHT_BUDGET, deps(chat, sid), { force: true });
    expect(outcome.compacted).toBe(true);
    expect(calls).toHaveLength(1);
    const compactEvents = listSessionEvents(db, sid).filter((e) => e.type === "context.compact");
    expect(compactEvents).toHaveLength(4); // the forced compaction landed
    // And no warning fired (force is not an auto compaction to block).
    expect(listSessionEvents(db, sid).some((e) => e.type === "turn.warning")).toBe(false);
    // The fresh event carries the D3a fields (additive on the payload).
    const latest = findLatestCompaction(listSessionEvents(db, sid));
    expect(latest?.roundAligned).toBe(true);
    expect(typeof latest?.preservedRounds).toBe("number");
    expect((latest?.preservedRounds as number) >= 0).toBe(true);
  });

  it("RESET: a compaction followed by ≥3 tool turns un-blocks the next AUTO compaction", async () => {
    const sid = newSession();
    seedOverflowing(sid);
    seedRapidRefillStreak(sid);
    // The 3 tool turns after the last compaction — the reset.
    for (let i = 0; i < RAPID_REFILL_TOOL_TURN_THRESHOLD; i++) {
      appendSessionEvent(db, sid, {
        type: "tool.use",
        agentId: "agt_default_nova",
        payload: { role: "tool", toolName: "read_file", argsSummary: "read", ok: true, outputSummary: "x".repeat(400) },
      });
    }
    const { chat, calls } = fakeChat();

    const outcome = await assembleWithCompaction(assembleHistory(db, sid), TIGHT_BUDGET, deps(chat, sid));
    expect(outcome.compacted).toBe(true); // the AUTO compaction fired
    expect(calls).toHaveLength(1);
    expect(listSessionEvents(db, sid).some((e) => e.type === "turn.warning")).toBe(false);
  });

  it("the summarizer-failure hard trim is NOT blocked by a streak when reached under FORCE (the fallback is never a casualty)", async () => {
    const sid = newSession();
    seedOverflowing(sid);
    seedRapidRefillStreak(sid);
    const failing: ChatFn = async () => {
      throw new Error("simulated summarizer outage");
    };
    const outcome = await assembleWithCompaction(assembleHistory(db, sid), TIGHT_BUDGET, deps(failing, sid), { force: true });
    expect(outcome.compacted).toBe(false);
    expect(outcome.messages[0].content).toContain("[Earlier conversation was trimmed"); // the legacy fallback
    expect(listSessionEvents(db, sid).some((e) => e.type === "turn.error")).toBe(false); // never a new failure mode
  });
});

/* ── The additive payload fields' fold round-trip ─────────────────────────── */

describe("ROUND-128 (R128-W8, D3a): the payload fields round-trip findLatestCompaction's typed guards", () => {
  const ts = "2026-01-01T00:00:00Z";
  const compact = (payload: Record<string, unknown>): SessionEvent => ({
    seq: 1,
    type: "context.compact",
    agentId: null,
    payload,
    ts,
  });

  it("a pre-R128 event lacks the fields; garbage values drop to absent, never invent", () => {
    const old = findLatestCompaction([compact({ summary: "old", throughSeq: 1, droppedMessages: 1, tokensSaved: 1 })]);
    expect(old?.roundAligned).toBeUndefined();
    expect(old?.preservedRounds).toBeUndefined();

    const garbage = findLatestCompaction([
      compact({
        summary: "junk",
        throughSeq: 2,
        droppedMessages: 1,
        tokensSaved: 1,
        roundAligned: "yes" as unknown as boolean,
        preservedRounds: -1,
      }),
    ]);
    expect(garbage?.roundAligned).toBeUndefined();
    expect(garbage?.preservedRounds).toBeUndefined();
  });

  it("an R128-W8 event folds the fields verbatim (boolean / finite non-negative int)", () => {
    const found = findLatestCompaction([
      compact({ summary: "new", throughSeq: 3, droppedMessages: 4, tokensSaved: 500, roundAligned: true, preservedRounds: 2 }),
    ]);
    expect(found?.roundAligned).toBe(true);
    expect(found?.preservedRounds).toBe(2);
  });

  it("a live compaction persists roundAligned:false ONLY on the materiality fallback (the honest logged decision)", async () => {
    // The guard-abort shape from the boundary-math block, end-to-end: the
    // gigantic round trips the guard, the event says roundAligned:false.
    const sid = newSession();
    const shapes: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: `u0: ${"x".repeat(400)}` },
      { role: "assistant", content: `a1: ${"x".repeat(2000)}` },
      { role: "user", content: `u2: ${"x".repeat(100)}` },
      { role: "user", content: `u3: ${"x".repeat(100)}` },
      { role: "assistant", content: `a4: ${"x".repeat(400)}` },
      { role: "user", content: `u5: ${"x".repeat(100)}` },
    ];
    for (const m of shapes) {
      appendSessionEvent(db, sid, {
        type: m.role === "user" ? "message.user" : "message.assistant",
        agentId: "agt_default_nova",
        payload: { role: m.role, content: m.content },
      });
    }
    const { chat } = fakeChat();
    const outcome = await assembleWithCompaction(assembleHistory(db, sid), TIGHT_BUDGET, deps(chat, sid));
    expect(outcome.compacted).toBe(true);
    expect(outcome.detail?.roundAligned).toBe(false);
    expect(outcome.detail?.preservedRounds).toBe(1);
    const latest = findLatestCompaction(listSessionEvents(db, sid));
    expect(latest?.roundAligned).toBe(false);
    expect(latest?.preservedRounds).toBe(1);
  });
});
