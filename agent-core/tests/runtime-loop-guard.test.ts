/**
 * ROUND-51 (R51-f): the LOOP-HYGIENE GUARD — the deepseek-harness
 * `guard/repeat-tool-reminder` pattern ported into our runtime (see
 * docs/research/deepseek-harness-notes.md; ideas only, no code copied).
 *
 * The guard exists for the owner's R51 complaint ("It takes up way too many
 * steps… It should work in an optimized way"): a model stuck re-calling the
 * SAME tool with the SAME arguments, or hammering failing calls, used to burn
 * every remaining SDK step and outer iteration before the loop's own caps
 * ended the turn. Now: nudge at 3 identical consecutive calls (rides the next
 * iteration's in-memory message list), honest stop at 5 identical or 6
 * consecutive failures (persisted turn.error + 502 LOOP_GUARD envelope —
 * never a throw).
 *
 * Suite layout mirrors runtime-nudge.test.ts (same seams: scripted ChatFn
 * stubs + scripted chatStream generators + a real temp SQLite session):
 *   1. PURE guard tests — thresholds, resets, canonicalization (no DB).
 *   2. SYNC path integration (runSingleAgentTurn).
 *   3. STREAMED path integration (runStreamedAgentTurn) — including the
 *      MID-STREAM stop (the stream is abandoned before its finish frame).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { createProject } from "../src/storage/projects";
import { createAgent } from "../src/storage/agents";
import { createSession, listSessionEvents } from "../src/storage/sessions";
import {
  MAX_CONSECUTIVE_FAILURES,
  REPEAT_NUDGE,
  REPEAT_STOP,
  canonicalToolArgs,
  createLoopGuard,
  runSingleAgentTurn,
  runStreamedAgentTurn,
} from "../src/agents/runtime";
import type { ChatFn, ChatToolCall, ChatTurnMessage, StreamChatFn } from "../src/agents/chat";
import { ProviderKeyring } from "../src/providers/registry";

const KEY = "sk-test-loopguard";
let tempDir = "";
let db: SqliteDatabase;

afterAll(() => {
  db?.close();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/** A chat stub with scripted per-call behavior + call recording (runtime-nudge seam). */
function scriptedChat(behaviors: Array<Awaited<ReturnType<ChatFn>>>): {
  chat: ChatFn;
  calls: ChatTurnMessage[][];
} {
  const calls: ChatTurnMessage[][] = [];
  let i = 0;
  const chat: ChatFn = async (input) => {
    calls.push(input.messages.map((m) => ({ ...m })));
    const behavior = behaviors[Math.min(i, behaviors.length - 1)];
    i += 1;
    return behavior;
  };
  return { chat, calls };
}

function call(name: string, argsSummary: string, ok: boolean): ChatToolCall {
  return { name, argsSummary, ok, ...(ok ? { outputSummary: "ok" } : { outputSummary: "failed" }) };
}

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

// ── 1. PURE guard: thresholds, resets, canonicalization ─────────────────────

describe("ROUND-51 (R51-f): createLoopGuard — pure state machine", () => {
  it("nudges once when the exact same call repeats REPEAT_NUDGE times, then escalates to a hard stop at REPEAT_STOP", () => {
    const guard = createLoopGuard();
    const actions: string[] = [];
    let nudge: string | undefined;
    let stopReason: string | undefined;
    for (let i = 0; i < REPEAT_STOP; i++) {
      const action = guard.onToolCall("read_file", "path: a.md", true);
      actions.push(action.action);
      if (action.action === "nudge") nudge = action.nudge;
      if (action.action === "stop") stopReason = action.reason;
    }
    expect(actions).toEqual(["continue", "continue", "nudge", "continue", "stop"]);
    // The nudge is the mission's exact correction: names the tool + the count.
    expect(nudge).toContain("read_file");
    expect(nudge).toContain(`${REPEAT_NUDGE} times in a row`);
    expect(nudge).toContain("Stop repeating");
    // The stop is honest: names the tool + the streak, no blame-shifting.
    expect(stopReason).toContain(`${REPEAT_STOP} identical consecutive calls to read_file`);
    expect(stopReason).toContain("no-progress loop");
  });

  it("stays stopped once stopped (a caller that keeps feeding never re-arms the guard)", () => {
    const guard = createLoopGuard();
    for (let i = 0; i < REPEAT_STOP; i++) guard.onToolCall("read_file", "path: a.md", true);
    const after = guard.onToolCall("read_file", "path: a.md", true);
    expect(after.action).toBe("stop");
  });

  it("a DIFFERENT call (name or args) resets the streak — no nudge, no stop", () => {
    const guard = createLoopGuard();
    const feed = [
      ["read_file", "path: a.md"],
      ["read_file", "path: a.md"],
      ["read_file", "path: b.md"], // different args → reset
      ["read_file", "path: a.md"],
      ["list_dir", "path: a.md"], // different tool → reset
    ] as const;
    for (const [name, args] of feed) {
      expect(guard.onToolCall(name, args, true).action).toBe("continue");
    }
  });

  it("a fresh streak after a reset can nudge again", () => {
    const guard = createLoopGuard();
    // First streak: 3 identical → nudge.
    guard.onToolCall("read_file", "path: a.md", true);
    guard.onToolCall("read_file", "path: a.md", true);
    expect(guard.onToolCall("read_file", "path: a.md", true).action).toBe("nudge");
    // A different call resets; three identical again → the correction repeats.
    guard.onToolCall("read_file", "path: b.md", true);
    guard.onToolCall("read_file", "path: a.md", true);
    guard.onToolCall("read_file", "path: a.md", true);
    expect(guard.onToolCall("read_file", "path: a.md", true).action).toBe("nudge");
  });

  it("consecutive FAILURES accumulate across DIFFERENT args and stop at MAX_CONSECUTIVE_FAILURES", () => {
    const guard = createLoopGuard();
    let stopReason: string | undefined;
    for (let i = 1; i <= MAX_CONSECUTIVE_FAILURES; i++) {
      // Every call fails with DIFFERENT arguments — the exact-match repeat
      // chain never fires; only the failure counter sees this loop.
      const action = guard.onToolCall("read_file", `path: f${i}.md`, false);
      if (action.action === "stop") stopReason = action.reason;
      else if (i === MAX_CONSECUTIVE_FAILURES) throw new Error(`expected stop at failure ${i}`);
    }
    expect(stopReason).toContain(`${MAX_CONSECUTIVE_FAILURES} consecutive failed tool calls`);
    expect(stopReason).toContain("read_file");
  });

  it("ANY successful call resets the failure counter — 5 failures + a success + 5 more failures never stops", () => {
    const guard = createLoopGuard();
    for (let round = 0; round < 2; round++) {
      for (let i = 1; i < MAX_CONSECUTIVE_FAILURES; i++) {
        expect(guard.onToolCall("read_file", `path: r${round}f${i}.md`, false).action).toBe("continue");
      }
      expect(guard.onToolCall("read_file", "path: ok.md", true).action).toBe("continue");
    }
  });

  it("identical SUCCEEDING calls still count — a read-only no-progress loop is caught too", () => {
    const guard = createLoopGuard();
    for (let i = 0; i < REPEAT_STOP - 1; i++) guard.onToolCall("read_file", "path: a.md", true);
    expect(guard.onToolCall("read_file", "path: a.md", true).action).toBe("stop");
  });

  it("canonicalToolArgs: strings pass through; objects canonicalize key-order-insensitively (deep); degenerates never throw", () => {
    expect(canonicalToolArgs("path: a.md")).toBe("path: a.md");
    expect(canonicalToolArgs({ path: "a", content: "x" })).toBe(
      canonicalToolArgs({ content: "x", path: "a" }),
    );
    expect(canonicalToolArgs({ a: { x: 1, y: [2, 3] } })).toBe(
      canonicalToolArgs({ a: { y: [2, 3], x: 1 } }),
    );
    // Deep-equal objects with different key ORDER feed the same chain key…
    const guard = createLoopGuard();
    guard.onToolCall("write_file", { path: "a", content: "x" }, true);
    guard.onToolCall("write_file", { content: "x", path: "a" }, true);
    expect(guard.onToolCall("write_file", { path: "a", content: "x" }, true).action).toBe("nudge");
    // …and unstringifiable input degrades instead of throwing.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalToolArgs(cyclic)).not.toThrow();
    expect(() => canonicalToolArgs(undefined)).not.toThrow();
  });
});

// ── 2. SYNC path integration (runSingleAgentTurn) ───────────────────────────

describe("ROUND-51 (R51-f): loop guard — the SYNC path (runSingleAgentTurn)", () => {
  function setup(name: string): { sessionId: string; keyring: ProviderKeyring } {
    tempDir = tempDir === "" ? mkdtempSync(join(tmpdir(), "acute-loopguard-")) : tempDir;
    db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    const project = createProject(db, { name, rootPath: join(tempDir, name) });
    const agent = createAgent(db, { name: `${name} Agent`, providerId: "openrouter", model: "test/lg-1" });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    return { sessionId: session.id, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }) };
  }

  it("an identical-call streak injects the nudge into the NEXT iteration's message list (in-memory only, never persisted)", async () => {
    const { sessionId, keyring } = setup("LG-Sync-Nudge");
    const { chat, calls } = scriptedChat([
      // Iteration 1: three IDENTICAL calls in one SDK batch → streak hits 3.
      { text: "working on it", usage, toolCalls: [call("read_file", "path: a.md", true), call("read_file", "path: a.md", true), call("read_file", "path: a.md", true)] },
      // Iteration 2 (nudged): a DIFFERENT call + completion signal → done.
      { text: "Done.", usage, toolCalls: [call("read_file", "path: b.md", true)] },
    ]);

    const outcome = await runSingleAgentTurn({ db, keyring, chat }, sessionId, "loop once please");
    expect(outcome.ok).toBe(true);

    // The nudge rode iteration 2's in-memory message list…
    expect(calls).toHaveLength(2);
    const lastMessage = calls[1][calls[1].length - 1];
    expect(lastMessage.role).toBe("user");
    expect(lastMessage.content).toContain("read_file with identical arguments 3 times in a row");
    expect(lastMessage.content).toContain("Stop repeating");
    // …and is NOT in the persisted log (machine correction, not a chat turn).
    const events = listSessionEvents(db, sessionId);
    expect(JSON.stringify(events)).not.toContain("identical arguments");
    expect(events.filter((e) => e.type === "tool.use")).toHaveLength(4);
  });

  it("a streak reaching REPEAT_STOP ends the turn honestly: 502 LOOP_GUARD, persisted turn.error, retryable session, usage accounted", async () => {
    const { sessionId, keyring } = setup("LG-Sync-Stop");
    const { chat, calls } = scriptedChat([
      // One SDK batch with FIVE identical calls — the streak hits the hard
      // threshold inside iteration 1; the loop must not spend iteration 2.
      {
        text: "spinning",
        usage,
        toolCalls: Array.from({ length: REPEAT_STOP }, () => call("read_file", "path: a.md", true)),
      },
    ]);

    const outcome = await runSingleAgentTurn({ db, keyring, chat }, sessionId, "do the thing");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(502);
      expect(outcome.code).toBe("LOOP_GUARD");
      expect(outcome.message).toContain(`${REPEAT_STOP} identical consecutive calls to read_file`);
      expect(outcome.message).toContain("no-progress loop");
    }
    // Honest, not a throw: exactly ONE provider call was spent…
    expect(calls).toHaveLength(1);
    // …all five executed calls are still in the audit trail…
    const events = listSessionEvents(db, sessionId);
    expect(events.filter((e) => e.type === "tool.use")).toHaveLength(REPEAT_STOP);
    // …the failure is persisted (R42/R43 rule — reload shows it)…
    const error = events.find((e) => e.type === "turn.error");
    expect((error?.payload as Record<string, unknown>)?.code).toBe("LOOP_GUARD");
    expect(String((error?.payload as Record<string, unknown>)?.message)).toContain(
      "identical consecutive calls",
    );
    // …the session stays retryable…
    const row = db.prepare("SELECT status FROM sessions WHERE id = ?").get(sessionId) as { status: string };
    expect(row.status).toBe("queued");
    // …and the tokens actually burned are accounted in the usage ledger.
    const usageRows = db
      .prepare("SELECT COUNT(*) AS n FROM usage_events WHERE session_id = ?")
      .get(sessionId) as { n: number };
    expect(usageRows.n).toBe(1);
  });

  it("different args / interleaved successes reset the counters — no nudge, no stop, normal completion", async () => {
    const { sessionId, keyring } = setup("LG-Sync-Reset");
    const { chat, calls } = scriptedChat([
      // Two identical (below the threshold), then a different call — reset.
      {
        text: "working",
        usage,
        toolCalls: [call("read_file", "path: a.md", true), call("read_file", "path: a.md", true), call("read_file", "path: b.md", true)],
      },
      { text: "Done.", usage, toolCalls: [] },
    ]);

    const outcome = await runSingleAgentTurn({ db, keyring, chat }, sessionId, "vary your calls");
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(2);
    // No guard nudge anywhere in iteration 2's message list.
    expect(JSON.stringify(calls[1])).not.toContain("identical arguments");
    const events = listSessionEvents(db, sessionId);
    expect(events.some((e) => e.type === "turn.error")).toBe(false);
  });

  it("MAX_CONSECUTIVE_FAILURES failing calls with DIFFERENT args still end the turn honestly", async () => {
    const { sessionId, keyring } = setup("LG-Sync-Failures");
    const { chat, calls } = scriptedChat([
      {
        text: "trying repeatedly",
        usage,
        toolCalls: Array.from({ length: MAX_CONSECUTIVE_FAILURES }, (_, i) =>
          call("read_file", `path: missing-${i}.md`, false),
        ),
      },
    ]);

    const outcome = await runSingleAgentTurn({ db, keyring, chat }, sessionId, "read these files");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("LOOP_GUARD");
      expect(outcome.message).toContain(`${MAX_CONSECUTIVE_FAILURES} consecutive failed tool calls`);
    }
    expect(calls).toHaveLength(1);
    const events = listSessionEvents(db, sessionId);
    expect(events.filter((e) => e.type === "tool.use")).toHaveLength(MAX_CONSECUTIVE_FAILURES);
    expect(events.some((e) => e.type === "turn.error")).toBe(true);
    const row = db.prepare("SELECT status FROM sessions WHERE id = ?").get(sessionId) as { status: string };
    expect(row.status).toBe("queued");
  });
});

// ── 3. STREAMED path integration (runStreamedAgentTurn) ─────────────────────

describe("ROUND-51 (R51-f): loop guard — the STREAMED path (runStreamedAgentTurn)", () => {
  function setup(name: string): { sessionId: string; keyring: ProviderKeyring } {
    tempDir = tempDir === "" ? mkdtempSync(join(tmpdir(), "acute-loopguard-")) : tempDir;
    db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    const project = createProject(db, { name, rootPath: join(tempDir, name) });
    const agent = createAgent(db, { name: `${name} Agent`, providerId: "openrouter", model: "test/lg-1" });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    return { sessionId: session.id, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }) };
  }

  const noOpChat: ChatFn = async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, toolCalls: [] });

  it("a streak reaching REPEAT_STOP stops the stream MID-STREAM — no finish frame, honest LOOP_GUARD outcome, work persisted", async () => {
    const { sessionId, keyring } = setup("LG-Stream-Stop");
    const emitted: Array<Record<string, unknown>> = [];
    let streamCalls = 0;

    const chatStream: StreamChatFn = async function* () {
      streamCalls += 1;
      yield { type: "text-delta", delta: "checking " };
      for (let i = 0; i < REPEAT_STOP; i++) {
        yield { type: "tool-call", toolName: "read_file", argsSummary: "path: a.md" };
        yield { type: "tool-result", toolName: "read_file", argsSummary: "path: a.md", ok: true, outputSummary: "same content" };
      }
      // Unreachable in a guard stop: the consumer breaks out of the for-await
      // at the FIFTH tool-result (the generator's return() runs instead).
      yield { type: "finish", usage: { inputTokens: 9, outputTokens: 9, totalTokens: 18 } };
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: noOpChat, chatStream },
      sessionId,
      "keep checking the file",
      (event) => emitted.push(event as Record<string, unknown>),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(502);
      expect(outcome.code).toBe("LOOP_GUARD");
      expect(outcome.message).toContain(`${REPEAT_STOP} identical consecutive calls to read_file`);
    }
    // MID-STREAM: exactly ONE streamed SDK call, and its finish frame never
    // reached the UI (the honest trade-off — the waste is stopped, the
    // aborted call's tokens are under-counted).
    expect(streamCalls).toBe(1);
    expect(emitted.filter((e) => e.type === "finish")).toHaveLength(0);
    expect(emitted.filter((e) => e.type === "tool-result")).toHaveLength(REPEAT_STOP);
    // The executed work is persisted, then the failure, in order. The final
    // empty message.assistant is the ROUND-35 stats carrier (the iteration's
    // text preceded the tools, so the final flush was a no-op).
    const events = listSessionEvents(db, sessionId);
    expect(events.map((e) => e.type)).toEqual([
      "message.user",
      "message.assistant", // "checking " flushed before the first tool ran
      ...Array.from({ length: REPEAT_STOP }, () => "tool.use"),
      "message.assistant", // stats carrier for the aborted iteration
      "turn.error",
    ]);
    const error = events[events.length - 1].payload as Record<string, unknown>;
    expect(error.code).toBe("LOOP_GUARD");
    expect(String(error.message)).toContain("identical consecutive calls");
    const row = db.prepare("SELECT status FROM sessions WHERE id = ?").get(sessionId) as { status: string };
    expect(row.status).toBe("queued");
  });

  it("a 3-call streak in a streamed iteration nudges the NEXT streamed call (in-memory only)", async () => {
    const { sessionId, keyring } = setup("LG-Stream-Nudge");
    const seenMessages: ChatTurnMessage[][] = [];
    let streamCalls = 0;

    const chatStream: StreamChatFn = async function* () {
      streamCalls += 1;
      if (streamCalls === 1) {
        // Three identical calls, then the iteration ends normally.
        for (let i = 0; i < REPEAT_NUDGE; i++) {
          yield { type: "tool-call", toolName: "read_file", argsSummary: "path: a.md" };
          yield { type: "tool-result", toolName: "read_file", argsSummary: "path: a.md", ok: true, outputSummary: "same" };
        }
        yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        return;
      }
      // Iteration 2 (nudged): a DIFFERENT call + the completion signal.
      yield { type: "text-delta", delta: "Done. Reading something else now." };
      yield { type: "tool-call", toolName: "read_file", argsSummary: "path: b.md" };
      yield { type: "tool-result", toolName: "read_file", argsSummary: "path: b.md", ok: true, outputSummary: "other" };
      yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    };

    // Wrapper records the message list each streamed call received.
    const recordingStream: StreamChatFn = async function* (input) {
      seenMessages.push(input.messages.map((m) => ({ ...m })));
      yield* chatStream(input);
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: noOpChat, chatStream: recordingStream },
      sessionId,
      "check the file",
      () => undefined,
    );

    expect(outcome.ok).toBe(true);
    expect(streamCalls).toBe(2);
    const lastMessage = seenMessages[1][seenMessages[1].length - 1];
    expect(lastMessage.role).toBe("user");
    expect(lastMessage.content).toContain("read_file with identical arguments 3 times in a row");
    // Never persisted.
    const events = listSessionEvents(db, sessionId);
    expect(JSON.stringify(events)).not.toContain("identical arguments");
    expect(events.some((e) => e.type === "turn.error")).toBe(false);
  });
});
