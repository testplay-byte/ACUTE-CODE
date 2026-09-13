/**
 * ROUND-51 (R51-f) → ROUND-96 (R96-B): the LOOP-HYGIENE GUARD — now
 * WARN-ONLY. The owner's v0.93.0 report rewrote the contract:
 * "Our loop guard is way too bad. The model was reading a file: it read
 * the first half of the file, then the second, then the fourth, then the
 * fifth, the sixth… our loop guard stopped it midway and said it was
 * stuck in a loop while it was clearly not stuck in a loop. By loop…
 * the model is responding with the exact same things again and again, or
 * maybe trying to do the exact same task with every single one of the
 * things exactly the same… The loop guard should not be one that will
 * stop but it will only warn the user and it will pass the generation,
 * pass the workflow, and everything like that."
 *
 * The R96 contract this suite pins:
 *   1. RAW-args identity: identical DISPLAY summaries with DIFFERENT
 *      numeric args (paged reads of one file — the owner's exact report)
 *      NEVER fire anything.
 *   2. WARN, never STOP: identical calls warn at REPEAT_NUDGE (3) and
 *      re-warn every 3 more; consecutive failures warn at
 *      MAX_CONSECUTIVE_FAILURES (6); identical assistant text warns at
 *      IDENTICAL_TEXT_WARN (3). NOTHING ends the turn — the generation
 *      always passes through (the caps stay the honest backstop).
 *   3. The warning is a persisted turn.warning event + a live
 *      {type:"turn.warning"} frame — NEVER a "generation failed" error
 *      card over a passing turn.
 *
 * Suite layout mirrors runtime-nudge.test.ts (same seams: scripted ChatFn
 * stubs + scripted chatStream generators + a real temp SQLite session):
 *   1. PURE guard tests — thresholds, resets, canonicalization (no DB).
 *   2. SYNC path integration (runSingleAgentTurn).
 *   3. STREAMED path integration (runStreamedAgentTurn).
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
  IDENTICAL_TEXT_WARN,
  MAX_CONSECUTIVE_FAILURES,
  REPEAT_NUDGE,
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

function call(name: string, argsSummary: string, ok: boolean, args?: unknown): ChatToolCall {
  return {
    name,
    argsSummary,
    ...(args !== undefined ? { args } : {}),
    ok,
    ...(ok ? { outputSummary: "ok" } : { outputSummary: "failed" }),
  };
}

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

// ── 1. PURE guard: thresholds, resets, canonicalization ─────────────────────

describe("R96-B: createLoopGuard — the WARN-ONLY state machine", () => {
  it("warns (never stops) at REPEAT_NUDGE identical calls, re-warns every REPEAT_NUDGE more, and NOTHING ever ends the turn", () => {
    const guard = createLoopGuard();
    const actions: string[] = [];
    let warnReason: string | undefined;
    for (let i = 0; i < REPEAT_NUDGE * 3; i++) {
      const action = guard.onToolCall("read_file", "path: a.md", true);
      actions.push(action.action);
      if (action.action === "warn") {
        warnReason = action.reason;
        expect(action.nudge).toContain("read_file");
        expect(action.nudge).toContain("Stop repeating");
      }
    }
    // The cadence: continue ×2, warn at 3, continue ×2, warn at 6, continue ×2, warn at 9.
    expect(actions.filter((a) => a === "warn")).toHaveLength(3);
    expect(actions[REPEAT_NUDGE - 1]).toBe("warn");
    expect(actions[REPEAT_NUDGE * 2 - 1]).toBe("warn");
    // NEVER a stop — the owner's directive: the generation always passes.
    expect(actions).not.toContain("stop");
    // The warning is honest and non-fatal by construction ("still running").
    expect(warnReason).toContain("still running");
    expect(warnReason).toContain("read_file");
  });

  it("R96-B — THE OWNER'S FALSE-POSITIVE PIN: identical DISPLAY summaries with DIFFERENT numeric args (paged reads of one file) NEVER fire anything", () => {
    const guard = createLoopGuard();
    // The owner's exact report: "it read the first half of the file, then
    // the second, then the fourth, then the fifth, then the sixth" — every
    // page carries the SAME argsSummary ("path: big.html") but a DIFFERENT
    // offset. The R51 guard compared the summary and stopped the healthy
    // read at call 5. The R96 guard compares the RAW args (the canonical
    // object — offsets included), so the pages are all DISTINCT calls.
    const pages = [1, 5000, 10000, 15000, 20000, 25000, 30000, 35000];
    for (const offset of pages) {
      const action = guard.onToolCall("read_file", { path: "big.html", offset, limit: 5000 }, true);
      expect(action.action).toBe("continue");
    }
    // The same shape through the assistant-text lens stays quiet too.
    expect(guard.onAssistantText("working through the file").action).toBe("continue");
  });

  it("a DIFFERENT call (name or raw args) resets the streak — no warn", () => {
    const guard = createLoopGuard();
    const feed: Array<[string, unknown]> = [
      ["read_file", { path: "a.md" }],
      ["read_file", { path: "a.md" }],
      ["read_file", { path: "b.md" }], // different args → reset
      ["read_file", { path: "a.md" }],
      ["list_dir", { path: "a.md" }], // different tool → reset
    ];
    for (const [name, args] of feed) {
      expect(guard.onToolCall(name, args, true).action).toBe("continue");
    }
  });

  it("a fresh streak after a reset can warn again", () => {
    const guard = createLoopGuard();
    // First streak: 3 identical → warn.
    guard.onToolCall("read_file", { path: "a.md" }, true);
    guard.onToolCall("read_file", { path: "a.md" }, true);
    expect(guard.onToolCall("read_file", { path: "a.md" }, true).action).toBe("warn");
    // A different call resets; three identical again → the correction repeats.
    guard.onToolCall("read_file", { path: "b.md" }, true);
    guard.onToolCall("read_file", { path: "a.md" }, true);
    guard.onToolCall("read_file", { path: "a.md" }, true);
    expect(guard.onToolCall("read_file", { path: "a.md" }, true).action).toBe("warn");
  });

  it("consecutive FAILURES accumulate across DIFFERENT args and WARN at MAX_CONSECUTIVE_FAILURES — the turn is never stopped", () => {
    const guard = createLoopGuard();
    let warned = false;
    for (let i = 1; i <= MAX_CONSECUTIVE_FAILURES; i++) {
      // Every call fails with DIFFERENT arguments — the exact-match repeat
      // chain never fires; only the failure counter sees this loop.
      const action = guard.onToolCall("read_file", { path: `f${i}.md` }, false);
      if (action.action === "warn") {
        warned = true;
        expect(action.kind).toBe("failure");
        expect(action.reason).toContain(`${MAX_CONSECUTIVE_FAILURES} consecutive tool calls failed`);
        expect(action.reason).toContain("still running");
        expect(action.nudge).toContain("Re-read the error output");
      } else if (i === MAX_CONSECUTIVE_FAILURES) {
        throw new Error(`expected warn at failure ${i}`);
      }
    }
    expect(warned).toBe(true);
    // Feeding MORE failures after the warn continues warning on cadence —
    // and never produces a stop.
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      const action = guard.onToolCall("read_file", { path: `more-${i}.md` }, false);
      expect(action.action).toBeOneOf(["continue", "warn"]);
    }
  });

  it("ANY successful call resets the failure counter — 5 failures + a success + 5 more failures never warns", () => {
    const guard = createLoopGuard();
    for (let round = 0; round < 2; round++) {
      for (let i = 1; i < MAX_CONSECUTIVE_FAILURES; i++) {
        expect(guard.onToolCall("read_file", { path: `r${round}f${i}.md` }, false).action).toBe("continue");
      }
      expect(guard.onToolCall("read_file", { path: "ok.md" }, true).action).toBe("continue");
    }
  });

  it("identical SUCCEEDING calls still count — a read-only no-progress loop warns too", () => {
    const guard = createLoopGuard();
    for (let i = 0; i < REPEAT_NUDGE - 1; i++) guard.onToolCall("read_file", { path: "a.md" }, true);
    const action = guard.onToolCall("read_file", { path: "a.md" }, true);
    expect(action.action).toBe("warn");
    expect(action.kind).toBe("repeat");
  });

  it("R96-B — the identical-TEXT detector: the same final response IDENTICAL_TEXT_WARN times warns; different text or any tool activity resets", () => {
    const guard = createLoopGuard();
    for (let i = 0; i < IDENTICAL_TEXT_WARN - 1; i++) {
      expect(guard.onAssistantText("The file is ready.").action).toBe("continue");
    }
    const warn = guard.onAssistantText("The file is ready.");
    expect(warn.action).toBe("warn");
    expect(warn.kind).toBe("identical_text");
    expect(warn.reason).toContain("still running");
    expect(warn.nudge).toContain("Do not repeat yourself");
    // A DIFFERENT response resets the chain…
    expect(guard.onAssistantText("Different content entirely.").action).toBe("continue");
    // …and any tool activity resets it too (the owner's loop shape is
    // text-only repetition).
    guard.onAssistantText("Repeating myself again.");
    guard.onAssistantText("Repeating myself again.");
    guard.onToolCall("read_file", { path: "x.md" }, true);
    expect(guard.onAssistantText("Repeating myself again.").action).toBe("continue");
    // Blank text is not a response (the R77 NO_OUTPUT guard owns that).
    expect(guard.onAssistantText("   ").action).toBe("continue");
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
    expect(guard.onToolCall("write_file", { path: "a", content: "x" }, true).action).toBe("warn");
    // …and unstringifiable input degrades instead of throwing.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalToolArgs(cyclic)).not.toThrow();
    expect(() => canonicalToolArgs(undefined)).not.toThrow();
  });
});

// ── 2. SYNC path integration (runSingleAgentTurn) ───────────────────────────

describe("R96-B: loop guard — the SYNC path (runSingleAgentTurn)", () => {
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
      // Iteration 1: three IDENTICAL calls (raw args), NO text — mid-work, the
      // loop continues → iteration 2 carries the guard nudge.
      {
        text: "",
        usage,
        toolCalls: [
          call("read_file", "path: a.md", true, { path: "a.md" }),
          call("read_file", "path: a.md", true, { path: "a.md" }),
          call("read_file", "path: a.md", true, { path: "a.md" }),
        ],
      },
      // Iteration 2 (nudged): a DIFFERENT call, then the final answer.
      { text: "Done. Task complete.", usage, toolCalls: [call("read_file", "path: b.md", true, { path: "b.md" })] },
    ]);

    const outcome = await runSingleAgentTurn({ db, keyring, chat }, sessionId, "loop once please");
    expect(outcome.ok).toBe(true);

    // The nudge rode iteration 2's in-memory message list…
    expect(calls).toHaveLength(2);
    const lastMessage = calls[1][calls[1].length - 1];
    expect(lastMessage.role).toBe("user");
    expect(lastMessage.content).toContain("read_file with identical arguments 3 times in a row");
    expect(lastMessage.content).toContain("Stop repeating");
    // …and the NUDGE is not in the persisted log (machine correction, not a
    // chat turn — the persisted turn.warning's message is the WARNING text,
    // never the nudge's "Stop repeating" correction).
    const events = listSessionEvents(db, sessionId);
    expect(JSON.stringify(events)).not.toContain("Stop repeating");
    expect(events.filter((e) => e.type === "tool.use")).toHaveLength(4);
    // The WARN is persisted as a turn.warning (never a turn.error) and the
    // generation PASSED — exactly the owner's directive.
    const warnings = events.filter((e) => e.type === "turn.warning");
    expect(warnings).toHaveLength(1);
    expect(String((warnings[0].payload as Record<string, unknown>)?.message)).toContain(
      "still running",
    );
    expect(events.some((e) => e.type === "turn.error")).toBe(false);
  });

  it("R96-B — THE OWNER'S PAGED-READ PIN (sync): eight pages of one file complete with ZERO warnings — the guard never fires on healthy paging", async () => {
    const { sessionId, keyring } = setup("LG-Sync-Paged");
    const { chat, calls } = scriptedChat([
      {
        text: "",
        usage,
        // The owner's exact shape: first half, second, fourth, fifth, sixth…
        // every page a DIFFERENT offset, the SAME display summary.
        toolCalls: [1, 5000, 10000, 15000, 20000, 25000, 30000, 35000].map((offset) =>
          call("read_file", "path: big.html", true, { path: "big.html", offset, limit: 5000 }),
        ),
      },
      { text: "Done. Task complete. Read the whole file across 8 pages.", usage, toolCalls: [] },
    ]);

    const outcome = await runSingleAgentTurn({ db, keyring, chat }, sessionId, "read the whole file");
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(2);
    const events = listSessionEvents(db, sessionId);
    expect(events.filter((e) => e.type === "tool.use")).toHaveLength(8);
    expect(events.some((e) => e.type === "turn.warning")).toBe(false);
    expect(events.some((e) => e.type === "turn.error")).toBe(false);
  });

  it("a long identical streak WARNS (persisted turn.warning) but the turn COMPLETES — no 502, no turn.error, the session ends normally", async () => {
    const { sessionId, keyring } = setup("LG-Sync-Warn-Passes");
    const { chat, calls } = scriptedChat([
      // One SDK batch with SIX identical calls — two warns fire (3, 6)…
      {
        text: "",
        usage,
        toolCalls: Array.from({ length: 6 }, () =>
          call("read_file", "path: a.md", true, { path: "a.md" }),
        ),
      },
      // …and the turn STILL continues to a normal completion.
      { text: "Done. Task complete.", usage, toolCalls: [] },
    ]);

    const outcome = await runSingleAgentTurn({ db, keyring, chat }, sessionId, "do the thing");
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(2);
    const events = listSessionEvents(db, sessionId);
    expect(events.filter((e) => e.type === "tool.use")).toHaveLength(6);
    const warnings = events.filter((e) => e.type === "turn.warning");
    expect(warnings).toHaveLength(2);
    expect(events.some((e) => e.type === "turn.error")).toBe(false);
  });

  it("MAX_CONSECUTIVE_FAILURES failing calls WARN but the turn passes through to completion", async () => {
    const { sessionId, keyring } = setup("LG-Sync-Failures");
    const { chat, calls } = scriptedChat([
      {
        text: "",
        usage,
        toolCalls: Array.from({ length: MAX_CONSECUTIVE_FAILURES }, (_, i) =>
          call("read_file", `path: missing-${i}.md`, false, { path: `missing-${i}.md` }),
        ),
      },
      { text: "Done. Task complete. Those files do not exist.", usage, toolCalls: [] },
    ]);

    const outcome = await runSingleAgentTurn({ db, keyring, chat }, sessionId, "read these files");
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(2);
    const events = listSessionEvents(db, sessionId);
    expect(events.filter((e) => e.type === "tool.use")).toHaveLength(MAX_CONSECUTIVE_FAILURES);
    const warnings = events.filter((e) => e.type === "turn.warning");
    expect(warnings).toHaveLength(1);
    expect(String((warnings[0].payload as Record<string, unknown>)?.message)).toContain(
      "consecutive tool calls failed",
    );
    expect(events.some((e) => e.type === "turn.error")).toBe(false);
  });
});

// ── 3. STREAMED path integration (runStreamedAgentTurn) ─────────────────────

describe("R96-B: loop guard — the STREAMED path (runStreamedAgentTurn)", () => {
  function setup(name: string): { sessionId: string; keyring: ProviderKeyring } {
    tempDir = tempDir === "" ? mkdtempSync(join(tmpdir(), "acute-loopguard-")) : tempDir;
    db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    const project = createProject(db, { name, rootPath: join(tempDir, name) });
    const agent = createAgent(db, { name: `${name} Agent`, providerId: "openrouter", model: "test/lg-1" });
    const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
    return { sessionId: session.id, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }) };
  }

  const noOpChat: ChatFn = async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, toolCalls: [] });

  it("a long identical streak in a streamed iteration WARNS live mid-stream — and the stream runs to its finish frame and the turn COMPLETES (no mid-stream stop)", async () => {
    const { sessionId, keyring } = setup("LG-Stream-Warn-Passes");
    const emitted: Array<Record<string, unknown>> = [];
    let streamCalls = 0;

    const chatStream: StreamChatFn = async function* () {
      streamCalls += 1;
      if (streamCalls === 1) {
        // Tools only, NO text (mid-work — the outer loop continues, so the
        // nudged iteration 2 actually runs).
        for (let i = 0; i < 5; i++) {
          yield { type: "tool-call", toolName: "read_file", argsSummary: "path: a.md", args: { path: "a.md" } };
          yield {
            type: "tool-result",
            toolName: "read_file",
            argsSummary: "path: a.md",
            args: { path: "a.md" },
            ok: true,
            outputSummary: "same content",
          };
        }
        // The R96 contract: the finish frame IS reached (the guard never
        // aborts the stream — the owner: "it will only warn… and it will
        // pass the generation").
        yield { type: "finish", usage: { inputTokens: 9, outputTokens: 9, totalTokens: 18 } };
        return;
      }
      // Iteration 2 (nudged): a different call + the final answer.
      yield { type: "text-delta", delta: "Done. Task complete." };
      yield { type: "tool-call", toolName: "read_file", argsSummary: "path: b.md", args: { path: "b.md" } };
      yield { type: "tool-result", toolName: "read_file", argsSummary: "path: b.md", args: { path: "b.md" }, ok: true, outputSummary: "other" };
      yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: noOpChat, chatStream },
      sessionId,
      "keep checking the file",
      (event) => emitted.push(event as Record<string, unknown>),
    );

    expect(outcome.ok).toBe(true);
    // The live UI saw the warning frame and BOTH iterations' finish markers
    // — never an error over a passing turn, and never an aborted stream.
    const warnFrames = emitted.filter((e) => e.type === "turn.warning");
    expect(warnFrames).toHaveLength(1);
    expect(String(warnFrames[0].message)).toContain("still running");
    expect(emitted.filter((e) => e.type === "finish")).toHaveLength(2);
    expect(streamCalls).toBe(2);
    // The persisted log: warnings, never errors; the turn completed.
    const events = listSessionEvents(db, sessionId);
    expect(events.filter((e) => e.type === "turn.warning")).toHaveLength(1);
    expect(events.some((e) => e.type === "turn.error")).toBe(false);
  });

  it("R96-B — THE OWNER'S PAGED-READ PIN (streamed): sequential pages of one file stream through with ZERO warning frames", async () => {
    const { sessionId, keyring } = setup("LG-Stream-Paged");
    const emitted: Array<Record<string, unknown>> = [];
    let streamCalls = 0;

    const chatStream: StreamChatFn = async function* () {
      streamCalls += 1;
      if (streamCalls === 1) {
        for (const offset of [1, 5000, 10000, 15000, 20000, 25000]) {
          yield { type: "tool-call", toolName: "read_file", argsSummary: "path: big.html", args: { path: "big.html", offset, limit: 5000 } };
          yield {
            type: "tool-result",
            toolName: "read_file",
            argsSummary: "path: big.html",
            args: { path: "big.html", offset, limit: 5000 },
            ok: true,
            outputSummary: `page at ${offset}`,
          };
        }
        yield { type: "finish", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
        return;
      }
      yield { type: "text-delta", delta: "Done. Task complete. All six pages read." };
      yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring, chat: noOpChat, chatStream },
      sessionId,
      "read the whole file",
      (event) => emitted.push(event as Record<string, unknown>),
    );

    expect(outcome.ok).toBe(true);
    expect(emitted.filter((e) => e.type === "turn.warning")).toHaveLength(0);
    expect(emitted.filter((e) => e.type === "error")).toHaveLength(0);
    const events = listSessionEvents(db, sessionId);
    expect(events.filter((e) => e.type === "tool.use")).toHaveLength(6);
    expect(events.some((e) => e.type === "turn.warning")).toBe(false);
    expect(events.some((e) => e.type === "turn.error")).toBe(false);
  });

  it("a 3-call streak in a streamed iteration nudges the NEXT streamed call (in-memory only)", async () => {
    const { sessionId, keyring } = setup("LG-Stream-Nudge");
    const seenMessages: ChatTurnMessage[][] = [];
    let streamCalls = 0;

    const chatStream: StreamChatFn = async function* () {
      streamCalls += 1;
      if (streamCalls === 1) {
        // Three identical calls, then the iteration ends normally (no text —
        // mid-work; the outer loop continues).
        for (let i = 0; i < REPEAT_NUDGE; i++) {
          yield { type: "tool-call", toolName: "read_file", argsSummary: "path: a.md", args: { path: "a.md" } };
          yield { type: "tool-result", toolName: "read_file", argsSummary: "path: a.md", args: { path: "a.md" }, ok: true, outputSummary: "same" };
        }
        yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        return;
      }
      // Iteration 2 (nudged): a DIFFERENT call + the final answer.
      yield { type: "text-delta", delta: "Done. Reading something else now." };
      yield { type: "tool-call", toolName: "read_file", argsSummary: "path: b.md", args: { path: "b.md" } };
      yield { type: "tool-result", toolName: "read_file", argsSummary: "path: b.md", args: { path: "b.md" }, ok: true, outputSummary: "other" };
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
    // The NUDGE is never persisted (its "Stop repeating" correction rides
    // the in-memory list only — the persisted turn.warning message never
    // carries the nudge text).
    const events = listSessionEvents(db, sessionId);
    expect(JSON.stringify(events)).not.toContain("Stop repeating");
    expect(events.some((e) => e.type === "turn.error")).toBe(false);
  });
});
