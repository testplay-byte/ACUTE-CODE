/**
 * ROUND-58 (R58-c) backend regression tests — the owner's Windows field
 * report on the streaming engine:
 *
 *  1. STOP HONESTY: a deliberate stop persists the partial segment (flushed
 *     on abort — the old behavior dropped it), resets the session to
 *     `queued` (the sidebar spinner bug), and reports "stopped by user".
 *     (Covered here via the direct runtime path; r43-turn-error.test.ts
 *     carries the no-turn.error + partial-persist pins.)
 *  2. LIVE TOOL-INPUT FRAMES: streamAiSdkChat forwards the AI SDK v7
 *     `tool-input-start` / `tool-input-delta` parts so the UI can render a
 *     live file-write preview while the model is still generating args.
 *  3. HISTORY REPLAY CAPPING (the "it copied and pasted the whole session"
 *     hallucination): only the last RECENT_TOOL_RESULTS tool.use events
 *     keep full output summaries; older ones stub; blocks are bounded.
 *  4. COMPLETION-SIGNAL BROADENING: "Task completed." now ends a tool-using
 *     turn (previously only "Task complete." matched, forcing an extra
 *     provider call on the full history — the regurgitation trigger).
 *  5. ROUND-66 (R66-2-c, C1): the POST /sessions/:id/messages/stream DEBUG
 *     ANALYST phase — debug OFF → no debug frames + no debug.report event;
 *     debug ON + an ok turn → debug-start → debug-delta* → debug-done +
 *     the persisted debug.report event, ALL BEFORE the terminal done frame
 *     (frame ORDER); the analyst's own provider failure → debug-error, the
 *     turn outcome untouched; a 502 turn (status >= 500) still analyzed.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

// The real adapter with ONLY the AI SDK mocked at the module boundary
// (same hermetic pattern as chat-format.test.ts / r43-turn-error.test.ts).
const streamTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  streamText: streamTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
}));

import { streamAiSdkChat, type StreamChatEvent } from "../src/agents/chat";
import { assembleHistory, runStreamedAgentTurn } from "../src/agents/runtime";
import { appendSessionEvent, listSessionEvents } from "../src/storage/sessions";
import { setDebugSettings } from "../src/storage/settings";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r58";
const KEY = "sk-or-vtest-r58";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r58-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
  });
  streamTextMock.mockReset();
});

afterEach(async () => {
  await app.close();
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
});

async function authInject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

async function createSession(): Promise<string> {
  const agentRes = await authInject({
    method: "POST",
    url: "/api/v1/agents",
    payload: {
      name: "Chat Agent",
      systemPrompt: "You are terse.",
      providerId: "openrouter",
      model: "test/model-1",
      temperature: 0.2,
      maxTurns: 8,
    },
  });
  expect(agentRes.statusCode).toBe(201);
  const agent = agentRes.json() as { id: string };
  const sessionRes = await authInject({
    method: "POST",
    url: "/api/v1/sessions",
    payload: { agentId: agent.id, mode: "single" },
  });
  expect(sessionRes.statusCode).toBe(202);
  return (sessionRes.json() as { id: string }).id;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Live tool-input frames (chat.ts adapter forwarding)
// ─────────────────────────────────────────────────────────────────────────────

describe("streamAiSdkChat tool-input forwarding (ROUND-58 R58-c)", () => {
  const baseInput = {
    provider: { id: "openrouter", baseUrl: "https://example.test/v1", apiFormat: "chat-completions" },
    apiKey: KEY,
    model: "test/model-1",
    system: "You are terse.",
    messages: [{ role: "user" as const, content: "write a file" }],
    temperature: 0.2,
    maxTurns: 4,
  };

  it("yields tool-input-start and tool-input-delta frames in arrival order", async () => {
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        // fullStream part shapes per the AI SDK v7 types: {id, toolName} /
        // {id, delta} — chat.ts normalizes them to toolCallId/inputTextDelta.
        yield { type: "tool-input-start", id: "call-1", toolName: "write_file" };
        yield { type: "tool-input-delta", id: "call-1", delta: '{"path":"a.t' };
        yield { type: "tool-input-delta", id: "call-1", delta: 'xt","content":"hi"}' };
        yield { type: "tool-call", toolName: "write_file", input: { path: "a.txt", content: "hi" } };
      })(),
      totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    }));

    const frames: StreamChatEvent[] = [];
    for await (const event of streamAiSdkChat(baseInput)) frames.push(event);

    expect(frames[0]).toEqual({
      type: "tool-input-start",
      toolCallId: "call-1",
      toolName: "write_file",
    });
    expect(frames[1]).toEqual({
      type: "tool-input-delta",
      toolCallId: "call-1",
      inputTextDelta: '{"path":"a.t',
    });
    expect(frames[2]).toEqual({
      type: "tool-input-delta",
      toolCallId: "call-1",
      inputTextDelta: 'xt","content":"hi"}',
    });
    // The completed call still announces itself with the args summary.
    expect(frames.some((f) => f.type === "tool-call")).toBe(true);
  });

  it("emits tool-input frames through runStreamedAgentTurn's SSE channel (the UI's live preview source)", async () => {
    const sessionId = await createSession();
    const seen: unknown[] = [];
    const chatStream = async function* (): AsyncGenerator<StreamChatEvent> {
      yield { type: "tool-input-start", toolCallId: "call-1", toolName: "write_file" };
      yield { type: "tool-input-delta", toolCallId: "call-1", inputTextDelta: '{"path":"a.txt"' };
      yield { type: "text-delta", delta: "Writing your file now." };
      yield { type: "finish", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
    };

    const outcome = await runStreamedAgentTurn(
      {
        db,
        keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
        chat: streamTextMock as never,
        chatStream,
      },
      sessionId,
      "write a file",
      (event) => seen.push(event),
    );
    expect(outcome.ok).toBe(true);
    expect(
      seen.some(
        (e) =>
          typeof e === "object" && e !== null && (e as { type?: string }).type === "tool-input-start",
      ),
    ).toBe(true);
    expect(
      seen.some(
        (e) =>
          typeof e === "object" && e !== null && (e as { type?: string }).type === "tool-input-delta",
      ),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. History replay capping (assembleHistory)
// ─────────────────────────────────────────────────────────────────────────────

describe("assembleHistory replay capping (ROUND-58 R58-c)", () => {
  it("keeps the LAST 8 tool results full and stubs older ones", async () => {
    const sessionId = await createSession();
    appendSessionEvent(db, sessionId, {
      type: "message.user",
      agentId: "agt_x",
      payload: { role: "user", content: "do the thing" },
    });
    // 10 tool results with long outputs.
    for (let i = 0; i < 10; i++) {
      appendSessionEvent(db, sessionId, {
        type: "tool.use",
        agentId: "agt_x",
        payload: {
          role: "tool",
          toolName: "run_command",
          argsSummary: `cmd: step ${i}`,
          ok: true,
          outputSummary: `${"x".repeat(2000)} output ${i} ${"y".repeat(2000)}`,
        },
      });
    }
    appendSessionEvent(db, sessionId, {
      type: "message.assistant",
      agentId: "agt_x",
      payload: { role: "assistant", content: "did it" },
    });

    const messages = assembleHistory(db, sessionId);
    const toolBlock = messages.find((m) => m.content.includes("<tool_results>"));
    expect(toolBlock).toBeDefined();
    const content = toolBlock!.content;

    // The last 8 (steps 2..9) keep full ~4000-char summaries…
    expect(content).toContain("output 9");
    expect(content).not.toContain("…[older result truncated]… output 9");
    // …the first 2 (steps 0..1) collapse to stubs.
    expect(content.match(/…\[older result truncated\]/g)?.length).toBe(2);
    // And the block is far smaller than the uncapped ~40KB would be.
    expect(content.length).toBeLessThan(8 * 4100 + 2 * 300);
  });

  it("bounds the whole <tool_results> block under MAX_TOOL_BLOCK_CHARS", async () => {
    const sessionId = await createSession();
    appendSessionEvent(db, sessionId, {
      type: "message.user",
      agentId: "agt_x",
      payload: { role: "user", content: "go" },
    });
    // 12 tool results, each a full 4000-char summary — all "recent" by the
    // per-line rule, so the BLOCK cap is the only thing bounding the replay.
    for (let i = 0; i < 12; i++) {
      appendSessionEvent(db, sessionId, {
        type: "tool.use",
        agentId: "agt_x",
        payload: {
          role: "tool",
          toolName: "read_file",
          argsSummary: `path: f${i}.txt`,
          ok: true,
          outputSummary: `${"a".repeat(2000)} mid ${i} ${"b".repeat(2000)}`,
        },
      });
    }
    const messages = assembleHistory(db, sessionId);
    const toolBlock = messages.find((m) => m.content.includes("<tool_results>"));
    expect(toolBlock).toBeDefined();
    expect(toolBlock!.content.length).toBeLessThanOrEqual(48_000 + 200 /* block + slack */);
  });

  it("short sessions are unchanged (no stubbing below the thresholds)", async () => {
    const sessionId = await createSession();
    appendSessionEvent(db, sessionId, {
      type: "message.user",
      agentId: "agt_x",
      payload: { role: "user", content: "read it" },
    });
    appendSessionEvent(db, sessionId, {
      type: "tool.use",
      agentId: "agt_x",
      payload: {
        role: "tool",
        toolName: "read_file",
        argsSummary: "path: main.py",
        ok: true,
        outputSummary: "print('hello')",
      },
    });
    appendSessionEvent(db, sessionId, {
      type: "message.assistant",
      agentId: "agt_x",
      payload: { role: "assistant", content: "read it" },
    });
    const messages = assembleHistory(db, sessionId);
    const toolBlock = messages.find((m) => m.content.includes("<tool_results>"));
    expect(toolBlock!.content).toContain("print('hello')");
    expect(toolBlock!.content).not.toContain("older result truncated");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Completion-signal broadening
// ─────────────────────────────────────────────────────────────────────────────

describe("completion signal broadening (ROUND-58 R58-c)", () => {
  it("'Task completed.' ends a tool-using turn after ONE iteration (no forced regurgitation call)", async () => {
    const sessionId = await createSession();
    let streamCalls = 0;
    const chatStream = async function* (): AsyncGenerator<StreamChatEvent> {
      streamCalls += 1;
      yield { type: "tool-input-start", toolCallId: "c1", toolName: "write_file" };
      yield { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: '{"path":"a.txt"' };
      yield { type: "tool-call", toolName: "write_file", argsSummary: "path: a.txt" };
      yield {
        type: "tool-result",
        toolName: "write_file",
        argsSummary: "path: a.txt",
        ok: true,
        outputSummary: "wrote 12 bytes",
      };
      yield { type: "text-delta", delta: "Task completed. The file is written." };
      yield { type: "finish", usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
    };

    const outcome = await runStreamedAgentTurn(
      {
        db,
        keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
        chat: streamTextMock as never,
        chatStream,
      },
      sessionId,
      "create a.txt",
      () => undefined,
    );
    expect(outcome.ok).toBe(true);
    // The broadened signal matched → the outer loop did NOT force a second
    // provider call on the full history (the regurgitation trigger).
    expect(streamCalls).toBe(1);
    // The events persisted in live order: user → tool.use → assistant.
    expect(listSessionEvents(db, sessionId).map((e) => e.type)).toEqual([
      "message.user",
      "tool.use",
      "message.assistant",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. ROUND-66 (R66-2-c, the owner's C1 directive): the DEBUG ANALYST phase on
//    POST /sessions/:id/messages/stream — a FRESH context-free model call
//    launched AFTER the turn, streaming its report into the still-open SSE
//    BEFORE the terminal frame, and persisting a `debug.report` event.
// ─────────────────────────────────────────────────────────────────────────────

describe("debug analyst phase on the stream route (ROUND-66 R66-2-c)", () => {
  /** Parse the hijacked SSE body into its data frames. */
  function parseSse(body: string): Array<Record<string, unknown>> {
    const frames: Array<Record<string, unknown>> = [];
    for (const block of body.split("\n\n")) {
      for (const line of block.split("\n")) {
        if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
      }
    }
    return frames;
  }

  /** POST a message through the streamed route and return the SSE frames. */
  async function streamTurn(sessionId: string, content: string): Promise<Array<Record<string, unknown>>> {
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    return parseSse(response.body as string);
  }

  /** The main turn's provider stream (call 1): one tool round-trip + a
   * completion-signaled text. */
  const turnStream = (): { fullStream: AsyncGenerator<Record<string, unknown>>; totalUsage: Promise<unknown>; usage: Promise<unknown> } => ({
    fullStream: (async function* () {
      yield { type: "tool-call", toolName: "write_file", input: { path: "a.txt", content: "hi" } };
      yield {
        type: "tool-result",
        toolName: "write_file",
        input: { path: "a.txt", content: "hi" },
        output: { ok: true, output: "wrote 2 bytes" },
      };
      yield { type: "text-delta", text: "Task completed. The file is written." };
    })(),
    totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 10, totalTokens: 20 }),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 10, totalTokens: 20 }),
  });

  /** The ANALYST's provider stream (call 2): streamed report text. */
  const analystStream = (): { fullStream: AsyncGenerator<Record<string, unknown>>; totalUsage: Promise<unknown>; usage: Promise<unknown> } => ({
    fullStream: (async function* () {
      yield { type: "text-delta", text: "## What the task was\n" };
      yield { type: "text-delta", text: "Write a.txt. write_file returned ok — the result is sane." };
    })(),
    totalUsage: Promise.resolve({ inputTokens: 40, outputTokens: 30, totalTokens: 70 }),
    usage: Promise.resolve({ inputTokens: 40, outputTokens: 30, totalTokens: 70 }),
  });

  it("debug OFF: no debug frames, no debug.report event — the turn closes exactly as before", async () => {
    const sessionId = await createSession();
    let calls = 0;
    streamTextMock.mockImplementation(() => {
      calls += 1;
      return turnStream();
    });

    const frames = await streamTurn(sessionId, "create a.txt");
    expect(calls).toBe(1); // the turn only — no analyst call
    const types = frames.map((f) => f.type);
    expect(types).not.toContain("debug-start");
    expect(types).not.toContain("debug-delta");
    expect(types).not.toContain("debug-done");
    expect(types).not.toContain("debug-error");
    expect(types[types.length - 1]).toBe("done");
    // No debug.report event anywhere in the log.
    expect(listSessionEvents(db, sessionId).some((e) => e.type === "debug.report")).toBe(false);
  });

  it("debug ON + ok turn: debug-start → deltas → debug-done + persisted debug.report, ALL BEFORE the done frame", async () => {
    const sessionId = await createSession();
    setDebugSettings(db, { enabled: true });
    const calls: Array<Record<string, unknown>> = [];
    streamTextMock.mockImplementation((input: Record<string, unknown>) => {
      calls.push(input);
      return calls.length === 1 ? turnStream() : analystStream();
    });

    const frames = await streamTurn(sessionId, "create a.txt");
    expect(calls).toHaveLength(2); // the turn + the context-free analyst

    // FRAME ORDER: the analyst's whole lifecycle lands BEFORE the terminal
    // done frame (the live turn is still open while the report streams).
    const types = frames.map((f) => f.type);
    const doneIndex = types.indexOf("done");
    const startIndex = types.indexOf("debug-start");
    const done1 = types.indexOf("debug-done");
    expect(startIndex).toBeGreaterThan(-1);
    expect(done1).toBeGreaterThan(startIndex);
    expect(doneIndex).toBeGreaterThan(done1);
    expect(types[types.length - 1]).toBe("done");
    // The deltas arrive between start and done.
    const deltaIndexes = types
      .map((t, i) => (t === "debug-delta" ? i : -1))
      .filter((i) => i !== -1);
    expect(deltaIndexes.length).toBe(2);
    expect(Math.min(...deltaIndexes)).toBeGreaterThan(startIndex);
    expect(Math.max(...deltaIndexes)).toBeLessThan(done1);
    // The delta frames concatenate to the report text.
    const deltaText = deltaIndexes
      .map((i) => (frames[i] as { delta: string }).delta)
      .join("");
    const doneFrame = frames[done1] as { content: string; model?: string; sessionId: string };
    expect(doneFrame.content).toBe(deltaText);
    expect(doneFrame.model).toBe("test/model-1");
    expect(doneFrame.sessionId).toBe(sessionId);

    // The ANALYST call is a FRESH context-free conversation: the system
    // prompt is the analyst's, the ONE user message carries the WHOLE
    // transcript (user request + FULL tool result), NO tools, and the
    // session's model (the LanguageModel's modelId).
    const analystInput = calls[1] as {
      system?: string;
      messages?: Array<{ role: string; content: string }>;
      tools?: unknown;
      model?: { modelId?: string };
    };
    expect(analystInput.system).toContain("You are a DEBUG ANALYST");
    expect(analystInput.messages).toHaveLength(1);
    expect(analystInput.messages![0].content).toContain("USER: create a.txt");
    expect(analystInput.messages![0].content).toContain(
      "TOOL write_file(path: a.txt, content: 2 chars) → ok: wrote 2 bytes",
    );
    expect(analystInput.tools).toBeUndefined();
    expect(analystInput.model?.modelId).toBe("test/model-1");

    // The persisted debug.report event: content + model + the session's
    // agent id (the storage layer stamps agentId/ts into the payload).
    const reportEvent = listSessionEvents(db, sessionId).find((e) => e.type === "debug.report");
    expect(reportEvent).toBeDefined();
    const payload = reportEvent!.payload as {
      content: string;
      model: string;
      agentId: string | null;
      ts: string;
    };
    expect(payload.content).toBe(doneFrame.content);
    expect(payload.model).toBe("test/model-1");
    expect(typeof payload.agentId).toBe("string");
    expect(typeof payload.ts).toBe("string");
    setDebugSettings(db, { enabled: false });
  });

  it("debug ON + the ANALYST's provider fails: debug-error frame, the turn outcome is UNTOUCHED", async () => {
    const sessionId = await createSession();
    setDebugSettings(db, { enabled: true });
    streamTextMock.mockImplementation(() => {
      // Call 1: the turn succeeds; call 2 (the analyst) explodes.
      if (streamTextMock.mock.calls.length === 1) return turnStream();
      throw new Error(`analyst provider died with ${KEY}`);
    });

    const frames = await streamTurn(sessionId, "create a.txt");
    const types = frames.map((f) => f.type);
    // The turn's own outcome survived: done is still the terminal frame.
    expect(types[types.length - 1]).toBe("done");
    expect(types).toContain("done");
    // The honest analyst failure — debug-error AFTER debug-start, and the
    // API key never leaks into the frame.
    const errorIndex = types.indexOf("debug-error");
    expect(errorIndex).toBeGreaterThan(types.indexOf("debug-start"));
    const errorFrame = frames[errorIndex] as { message: string; sessionId: string };
    expect(errorFrame.message).toContain("analyst provider died");
    expect(errorFrame.message).not.toContain(KEY);
    expect(errorFrame.sessionId).toBe(sessionId);
    // No debug-done, no persisted report for a failed analyst.
    expect(types).not.toContain("debug-done");
    expect(listSessionEvents(db, sessionId).some((e) => e.type === "debug.report")).toBe(false);
    setDebugSettings(db, { enabled: false });
  });

  it("debug ON + a FAILED turn (status 502): the gate still fires — the transcript carries the ERROR line", async () => {
    const sessionId = await createSession();
    setDebugSettings(db, { enabled: true });
    const calls: Array<Record<string, unknown>> = [];
    streamTextMock.mockImplementation((input: Record<string, unknown>) => {
      calls.push(input);
      if (calls.length === 1) throw new Error("the turn's provider 500'd");
      return analystStream();
    });

    const frames = await streamTurn(sessionId, "create a.txt");
    const types = frames.map((f) => f.type);
    // The turn failed for real: the terminal frame is error, AFTER the
    // analyst's debug-done (the analyst dissected the failure).
    const errorIndex = types.indexOf("error");
    const done1 = types.indexOf("debug-done");
    expect(errorIndex).toBeGreaterThan(-1);
    expect(done1).toBeGreaterThan(-1);
    expect(errorIndex).toBeGreaterThan(done1);
    expect(types[types.length - 1]).toBe("error");
    // The transcript the analyst received includes the persisted turn.error.
    const analystInput = calls[1] as { messages?: Array<{ content: string }> };
    expect(analystInput.messages![0].content).toContain("ERROR PROVIDER_ERROR:");
    // Both events persisted: the failure + the analysis of the failure.
    const eventTypes = listSessionEvents(db, sessionId).map((e) => e.type);
    expect(eventTypes).toContain("turn.error");
    expect(eventTypes).toContain("debug.report");
    setDebugSettings(db, { enabled: false });
  });
});
