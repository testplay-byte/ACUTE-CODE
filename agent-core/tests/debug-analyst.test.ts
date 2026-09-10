/**
 * ROUND-66 (R66-2-c) unit tests — the CONTEXT-FREE DEBUG ANALYST (the
 * owner's C1 directive): buildDebugTranscript (the readable render of the
 * session's WHOLE event log — user/assistant/tool/ERROR/APPROVAL lines with
 * FULL tool outputs, hard-capped at 60k head+tail) and runDebugAnalyst (the
 * fresh no-tools model call that streams its report as debug-delta frames).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildDebugTranscript, runDebugAnalyst } from "../src/agents/debug-analyst";
import type { ChatFn, StreamChatFn, StreamChatInput } from "../src/agents/chat";
import { appendSessionEvent, createSession } from "../src/storage/sessions";
import { createAgent } from "../src/storage/agents";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

const KEY = "sk-or-vtest-r66c";

let tempDir = "";
let db: SqliteDatabase;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r66c-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
});

afterEach(() => {
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/** A session with an agent bound (openrouter + a test model). */
function makeSession(): string {
  const agent = createAgent(db, {
    name: "R66c Agent",
    providerId: "openrouter",
    model: "test/model-1",
  });
  const session = createSession(db, { agentId: agent.id, mode: "single" });
  return session.id;
}

function addUser(sessionId: string, content: string, attachments?: unknown[]): void {
  appendSessionEvent(db, sessionId, {
    type: "message.user",
    agentId: "agt_r66c",
    payload: {
      role: "user",
      content,
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
    },
  });
}

function addAssistant(sessionId: string, content: string): void {
  appendSessionEvent(db, sessionId, {
    type: "message.assistant",
    agentId: "agt_r66c",
    payload: { role: "assistant", content },
  });
}

function addTool(
  sessionId: string,
  toolName: string,
  argsSummary: string,
  ok: boolean,
  outputSummary?: string,
): void {
  appendSessionEvent(db, sessionId, {
    type: "tool.use",
    agentId: "agt_r66c",
    payload: {
      role: "tool",
      toolName,
      argsSummary,
      ok,
      ...(outputSummary !== undefined ? { outputSummary } : {}),
    },
  });
}

// ── buildDebugTranscript ─────────────────────────────────────────────────────

describe("buildDebugTranscript (ROUND-66 R66-2-c)", () => {
  it("renders USER / ASSISTANT / TOOL (ok + FAILED, FULL output) / ERROR / APPROVAL lines in order", () => {
    const sessionId = makeSession();
    addUser(sessionId, "write a.txt", [
      { name: "spec.md", path: "spec.md", size: 6, text: "# spec" },
      { name: "logo.png", size: 4096, text: null },
    ]);
    appendSessionEvent(db, sessionId, {
      type: "approval.requested",
      agentId: "agt_r66c",
      payload: { approvalId: "appr_1", toolName: "run_command", argsSummary: "npm install", category: "confirm" },
    });
    appendSessionEvent(db, sessionId, {
      type: "approval.resolved",
      agentId: "agt_r66c",
      payload: { approvalId: "appr_1", toolName: "run_command", decision: "denied", remember: "once" },
    });
    addTool(sessionId, "read_file", "path: a.txt", true, "hello world");
    addTool(sessionId, "write_file", "path: a.txt, content: 12 chars", false, "EACCES: permission denied");
    appendSessionEvent(db, sessionId, {
      type: "turn.error",
      agentId: "agt_r66c",
      payload: {
        code: "PROVIDER_ERROR",
        message: "provider 'openrouter' call failed for session s",
        providerError: "429 Too Many Requests",
        userSeq: 1,
      },
    });
    addAssistant(sessionId, "I could not finish.");

    const { transcript, truncated, eventCount } = buildDebugTranscript(db, sessionId);
    expect(truncated).toBe(false);
    expect(eventCount).toBe(7);
    expect(transcript).toBe(
      [
        "USER: write a.txt",
        "[attachment: spec.md]",
        "[attachment: logo.png]",
        "APPROVAL run_command: pending",
        "APPROVAL run_command: denied",
        "TOOL read_file(path: a.txt) → ok: hello world",
        "TOOL write_file(path: a.txt, content: 12 chars) → FAILED: EACCES: permission denied",
        "ERROR PROVIDER_ERROR: provider 'openrouter' call failed for session s — 429 Too Many Requests",
        "ASSISTANT: I could not finish.",
      ].join("\n"),
    );
  });

  it("hard-caps at 60k: HEAD and TAIL kept, the middle becomes an honest omission marker", () => {
    const sessionId = makeSession();
    addUser(sessionId, "do many things");
    // 40 tool events, each ~4000 chars of output → ~160KB total.
    for (let i = 0; i < 40; i++) {
      addTool(sessionId, "run_command", `cmd: step ${i}`, true, `${"x".repeat(2000)} step ${i} ${"y".repeat(2000)}`);
    }
    addAssistant(sessionId, "The very final answer.");

    const { transcript, truncated, eventCount } = buildDebugTranscript(db, sessionId);
    expect(truncated).toBe(true);
    expect(eventCount).toBe(42);
    // The HARD cap holds.
    expect(transcript.length).toBeLessThanOrEqual(60_000);
    // HEAD: the original request + the early steps survived…
    expect(transcript.startsWith("USER: do many things\nTOOL run_command(cmd: step 0) → ok:")).toBe(true);
    expect(transcript).toContain("step 1 ");
    // …TAIL: the LAST tool result + the final answer survived…
    expect(transcript).toContain("step 39 ");
    expect(transcript.endsWith("ASSISTANT: The very final answer.")).toBe(true);
    // …and the middle is marked honestly with the omitted event count.
    const marker = /…\[(\d+) events omitted\]…/.exec(transcript);
    expect(marker).not.toBeNull();
    expect(Number(marker![1])).toBeGreaterThan(0);
    // A middle step is gone (not head, not tail).
    expect(transcript).not.toContain("step 15 ");
  });

  it("an empty session renders an honest empty transcript", () => {
    const sessionId = makeSession();
    const { transcript, truncated, eventCount } = buildDebugTranscript(db, sessionId);
    expect(transcript).toBe("");
    expect(truncated).toBe(false);
    expect(eventCount).toBe(0);
  });

  it("a SINGLE block larger than the whole budget is sliced head+tail (never just the marker)", () => {
    const sessionId = makeSession();
    // One 100k user paste — bigger than the entire 60k budget.
    addUser(sessionId, `${"P".repeat(100_000)}`);
    const { transcript, truncated, eventCount } = buildDebugTranscript(db, sessionId);
    expect(truncated).toBe(true);
    expect(eventCount).toBe(1);
    expect(transcript.length).toBeLessThanOrEqual(60_000);
    expect(transcript).toContain("…[transcript truncated]…");
    // The paste's START survived in the head…
    expect(transcript.startsWith("USER: PPPP")).toBe(true);
    // …and its END survived in the tail.
    expect(transcript.endsWith("PPPP")).toBe(true);
  });

  it("skips debug.report events (an earlier turn's analysis never leaks into a later one) + unknown types + empty assistant markers", () => {
    const sessionId = makeSession();
    addUser(sessionId, "turn one");
    addAssistant(sessionId, "first reply");
    appendSessionEvent(db, sessionId, {
      type: "debug.report",
      agentId: "agt_r66c",
      payload: { content: "## earlier analysis\n- the agent did fine", model: "test/analyst-1" },
    });
    addUser(sessionId, "turn two");
    // A stats-carrier assistant event (empty content) renders nothing.
    appendSessionEvent(db, sessionId, {
      type: "message.assistant",
      agentId: "agt_r66c",
      payload: { role: "assistant", content: "", usage: { inputTokens: 5, outputTokens: 1 } },
    });
    appendSessionEvent(db, sessionId, {
      type: "todo.update",
      agentId: "agt_r66c",
      payload: { items: [] },
    });
    addAssistant(sessionId, "second reply");

    const { transcript, eventCount } = buildDebugTranscript(db, sessionId);
    expect(eventCount).toBe(7); // every event WAS walked — the count is honest.
    expect(transcript).toBe("USER: turn one\nASSISTANT: first reply\nUSER: turn two\nASSISTANT: second reply");
  });
});

// ── runDebugAnalyst ──────────────────────────────────────────────────────────

describe("runDebugAnalyst (ROUND-66 R66-2-c)", () => {
  const PARAMS = {
    sessionId: "",
    provider: { id: "openrouter", baseUrl: "https://example.test/v1", apiFormat: "chat-completions" },
    apiKey: KEY,
    model: "test/analyst-1",
  };

  function seedSession(): string {
    const sessionId = makeSession();
    addUser(sessionId, "write the file");
    addTool(sessionId, "write_file", "path: a.txt, content: 12 chars", true, "wrote 12 bytes");
    addAssistant(sessionId, "Done.");
    return sessionId;
  }

  it("STREAMING: emits one debug-delta per text chunk and returns the accumulated full content", async () => {
    const sessionId = seedSession();
    let captured: StreamChatInput | undefined;
    const chatStream: StreamChatFn = async function* (input) {
      captured = input;
      yield { type: "text-delta", delta: "## What the task was\n" };
      yield { type: "thinking-delta", delta: "(internal reasoning the analyst UI never shows)" };
      yield { type: "text-delta", delta: "- write the file\n" };
      yield { type: "text-delta", delta: "## Did the outcome satisfy the request\nYES." };
      yield { type: "finish", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } };
    };
    const emitted: Array<{ type: string; delta?: string; sessionId?: string }> = [];
    const result = await runDebugAnalyst(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat: async () => { throw new Error("unused"); }, chatStream },
      { ...PARAMS, sessionId, emit: (event) => emitted.push(event as typeof emitted[number]) },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.content).toBe("## What the task was\n- write the file\n## Did the outcome satisfy the request\nYES.");
    // One debug-delta per TEXT chunk (thinking + finish never leak), each
    // carrying the session id, in arrival order.
    expect(emitted).toEqual([
      { type: "debug-delta", sessionId, delta: "## What the task was\n" },
      { type: "debug-delta", sessionId, delta: "- write the file\n" },
      { type: "debug-delta", sessionId, delta: "## Did the outcome satisfy the request\nYES." },
    ]);

    // The call itself: NO tools, ONE user message (the WHOLE transcript),
    // the analyst system prompt, temperature default, single turn.
    expect(captured).toBeDefined();
    expect(captured!.tools).toBeUndefined();
    expect(captured!.messages).toHaveLength(1);
    expect(captured!.messages[0].role).toBe("user");
    expect(captured!.messages[0].content).toContain("USER: write the file");
    expect(captured!.messages[0].content).toContain("TOOL write_file(path: a.txt, content: 12 chars) → ok: wrote 12 bytes");
    expect(captured!.messages[0].content).toContain("ASSISTANT: Done.");
    expect(captured!.system).toContain("You are a DEBUG ANALYST");
    expect(captured!.system).toContain("never invent events that are not in the transcript");
    expect(captured!.temperature).toBe(0.2);
    expect(captured!.maxTurns).toBe(1);
  });

  it("SYNC FALLBACK: without a chatStream the one-shot chat call's text is the report (no deltas)", async () => {
    const sessionId = seedSession();
    const inputs: unknown[] = [];
    const chat: ChatFn = async (input) => {
      inputs.push(input);
      return { text: "## Recommended fixes\n1. none", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: [] };
    };
    const emitted: unknown[] = [];
    const result = await runDebugAnalyst(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat },
      { ...PARAMS, sessionId, emit: (event) => emitted.push(event) },
    );
    // ROUND-83 (R83): the sync result now surfaces the analyst's own usage
    // (the route records the origin-'debug' usage row from it — the hidden
    // call is no longer invisible spend). cachedInputTokens null = the mock
    // reported no cached tier (the honest NULL contract).
    expect(result).toEqual({
      ok: true,
      content: "## Recommended fixes\n1. none",
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: null },
    });
    expect(emitted).toHaveLength(0); // no streaming adapter → no delta frames
    expect(inputs).toHaveLength(1); // exactly ONE provider call
  });

  it("provider failure → { ok: false } with the API key scrubbed out of the message", async () => {
    const sessionId = seedSession();
    const chatStream: StreamChatFn = async function* () {
      yield { type: "text-delta", delta: "partial…" };
      throw new Error(`provider exploded with key ${KEY} in the message`);
    };
    const result = await runDebugAnalyst(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat: async () => { throw new Error("unused"); }, chatStream },
      { ...PARAMS, sessionId, emit: () => undefined },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("provider exploded");
    expect(result.error).not.toContain(KEY);
    expect(result.error).toContain("***");
  });

  it("an empty model reply → the honest { ok: false } (never a blank report card)", async () => {
    const sessionId = seedSession();
    const chatStream: StreamChatFn = async function* () {
      yield { type: "finish", usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } };
    };
    const result = await runDebugAnalyst(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat: async () => { throw new Error("unused"); }, chatStream },
      { ...PARAMS, sessionId, emit: () => undefined },
    );
    expect(result).toEqual({ ok: false, error: "debug analyst: the model returned an empty report" });
  });

  it("keyring-held secrets are scrubbed from the transcript before it leaves for the provider", async () => {
    const sessionId = makeSession();
    addUser(sessionId, "run the deploy");
    addTool(sessionId, "run_command", "cmd: env", true, `ACUTE_PROVIDER_SECRET=${KEY}`);
    const chatStream: StreamChatFn = async function* (input) {
      expect(input.messages[0].content).not.toContain(KEY);
      yield { type: "text-delta", delta: "report" };
    };
    const result = await runDebugAnalyst(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_SECRET: KEY }), chat: async () => { throw new Error("unused"); }, chatStream },
      { ...PARAMS, sessionId, emit: () => undefined },
    );
    expect(result.ok).toBe(true);
  });
});
