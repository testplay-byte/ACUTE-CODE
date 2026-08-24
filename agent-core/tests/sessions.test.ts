import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

// The whole suite runs against the real aiSdkChat adapter with ONLY the AI SDK
// mocked at the module boundary — no network, no keys, full stack otherwise.
const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: generateTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
}));

import { aiSdkChat } from "../src/agents/chat";
import { runStreamedAgentTurn } from "../src/agents/runtime";
import { getUsageSummary } from "../src/storage/usage";
import { listSessionEvents } from "../src/storage/sessions";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-1a4e";
const KEY = "sk-or-vtest-77f2";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-sessions-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
  });
  generateTextMock.mockReset();
  generateTextMock.mockResolvedValue({
    text: "Fixed reply.",
    usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
  });
});

afterEach(async () => {
  await app.close();
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Best-effort: Windows sometimes holds file handles briefly after close.
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

async function createAgent(payload: Record<string, unknown> = {}): Promise<{ id: string; name: string }> {
  const response = await authInject({
    method: "POST",
    url: "/api/v1/agents",
    payload: {
      name: "Chat Agent",
      systemPrompt: "You are terse.",
      providerId: "openrouter",
      model: "test/model-1",
      temperature: 0.2,
      maxTurns: 8,
      ...payload,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function createSession(agentId: string): Promise<{ id: string }> {
  const response = await authInject({
    method: "POST",
    url: "/api/v1/sessions",
    payload: { agentId, mode: "single" },
  });
  expect(response.statusCode).toBe(202);
  return response.json();
}

describe("POST /api/v1/sessions", () => {
  it("creates a queued single-agent session bound to the agent", async () => {
    const agent = await createAgent();
    const session = await createSession(agent.id);
    expect(session).toMatchObject({
      id: expect.stringMatching(/^sess_/),
      agentId: agent.id,
      mode: "single",
      status: "queued",
      projectId: null,
      title: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it("accepts an optional title and stores it", async () => {
    const agent = await createAgent();
    const response = await authInject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: { agentId: agent.id, mode: "single", title: "Fix the flaky test" },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().title).toBe("Fix the flaky test");
  });

  const badBodies: Array<{ name: string; payload: Record<string, unknown>; field: string }> = [
    { name: "missing mode", payload: { agentId: "agt_x" }, field: "body.mode" },
    {
      name: "non-single mode",
      payload: { agentId: "agt_x", mode: "auto-team" },
      field: "body.mode",
    },
    { name: "missing agentId", payload: { mode: "single" }, field: "body.agentId" },
    {
      name: "empty agentId",
      payload: { agentId: "  ", mode: "single" },
      field: "body.agentId",
    },
    {
      name: "non-string title",
      payload: { agentId: "agt_x", mode: "single", title: 5 },
      field: "body.title",
    },
  ];
  for (const testCase of badBodies) {
    it(`rejects ${testCase.name} with 400 VALIDATION`, async () => {
      // A real agent so field validation (not agent existence) is what fails;
      // the agentId cases keep their deliberately-bad value.
      const agent = await createAgent();
      const payload = { ...testCase.payload };
      if (testCase.field !== "body.agentId") payload.agentId = agent.id;
      const response = await authInject({
        method: "POST",
        url: "/api/v1/sessions",
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION");
      expect(response.json().error.details.field).toBe(testCase.field);
    });
  }

  it("404s on an unknown agentId", async () => {
    const response = await authInject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: { agentId: "agt_missing", mode: "single" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("requires the bearer token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/sessions",
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /api/v1/sessions", () => {
  it("lists sessions newest-first with a total", async () => {
    const agent = await createAgent();
    const first = await createSession(agent.id);
    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct created_at ms
    const second = await createSession(agent.id);

    const response = await authInject({ method: "GET", url: "/api/v1/sessions" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBe(2);
    expect(body.sessions.map((session: { id: string }) => session.id)).toEqual([
      second.id,
      first.id,
    ]);
  });

  it("returns a session with its events and lastSeq", async () => {
    const agent = await createAgent();
    const session = await createSession(agent.id);
    const response = await authInject({ method: "GET", url: `/api/v1/sessions/${session.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: session.id,
      status: "queued",
      events: [],
      lastSeq: 0,
    });
  });

  it("404s on an unknown session", async () => {
    const response = await authInject({ method: "GET", url: "/api/v1/sessions/sess_missing" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });
});

describe("POST /api/v1/sessions/:id/messages", () => {
  it("runs the single-agent turn end to end (mocked generateText)", async () => {
    const agent = await createAgent();
    const session = await createSession(agent.id);

    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/messages`,
      payload: { content: "hello there" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.assistantMessage).toEqual({
      seq: 2,
      role: "assistant",
      agentId: agent.id,
      content: "Fixed reply.",
      ts: expect.any(String),
    });
    expect(body.usage).toEqual({
      agentId: agent.id,
      sessionId: session.id,
      provider: "openrouter",
      model: "test/model-1",
      inputTokens: 12,
      outputTokens: 34,
      costUsd: 0,
      ts: expect.any(String),
    });
    expect(response.body).not.toContain(KEY);

    // generateText got the agent's shape: system, temperature, maxTurns (as
    // stepCountIs), and the turn's messages.
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const call = generateTextMock.mock.calls[0][0] as Record<string, unknown>;
    expect(call.system).toBe("You are terse.");
    expect(call.temperature).toBe(0.2);
    expect(call.stopWhen).toEqual({ type: "stepCount", count: 8 });
    expect(call.messages).toEqual([{ role: "user", content: "hello there" }]);
    expect(call.model).toBeDefined();

    // Session flipped to running; both events landed with monotonic seqs.
    const fetched = await authInject({ method: "GET", url: `/api/v1/sessions/${session.id}` });
    const detailed = fetched.json();
    expect(detailed.status).toBe("running");
    expect(detailed.lastSeq).toBe(2);
    expect(detailed.events).toEqual([
      {
        seq: 1,
        type: "message.user",
        agentId: agent.id,
        payload: { role: "user", content: "hello there", agentId: agent.id, ts: expect.any(String) },
        ts: expect.any(String),
      },
      {
        seq: 2,
        type: "message.assistant",
        agentId: agent.id,
        payload: {
          role: "assistant",
          content: "Fixed reply.",
          agentId: agent.id,
          ts: expect.any(String),
          // Round-16 per-reply stats ride on the assistant payload.
          usage: { inputTokens: 12, outputTokens: 34 },
          ms: expect.any(Number),
          model: "test/model-1",
        },
        ts: expect.any(String),
      },
    ]);

    // The billing line landed in usage_events.
    const usageRows = db
      .prepare("SELECT * FROM usage_events WHERE session_id = ?")
      .all(session.id) as Array<Record<string, unknown>>;
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      agent_id: agent.id,
      provider: "openrouter",
      model: "test/model-1",
      input_tokens: 12,
      output_tokens: 34,
      cost_usd: 0,
    });
  });

  it("feeds the prior turns back as conversation history with strictly monotonic seqs", async () => {
    const agent = await createAgent();
    const session = await createSession(agent.id);

    const first = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/messages`,
      payload: { content: "first question" },
    });
    expect(first.statusCode).toBe(200);

    generateTextMock.mockResolvedValue({
      text: "Second reply.",
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    });
    const second = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/messages`,
      payload: { content: "second question" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().assistantMessage).toMatchObject({ seq: 4, content: "Second reply." });

    const call = generateTextMock.mock.calls[1][0] as Record<string, unknown>;
    expect(call.messages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "Fixed reply." },
      { role: "user", content: "second question" },
    ]);

    const detailed = (await authInject({ method: "GET", url: `/api/v1/sessions/${session.id}` })).json();
    const seqs = detailed.events.map((event: { seq: number }) => event.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(new Set(seqs).size).toBe(seqs.length); // append-only: never reused
    const usageCount = db
      .prepare("SELECT COUNT(*) AS n FROM usage_events WHERE session_id = ?")
      .get(session.id) as { n: number };
    expect(usageCount.n).toBe(2);
  });

  it("409 CONFLICT when the agent has no providerId/model", async () => {
    const agent = await createAgent({ providerId: null, model: null });
    const session = await createSession(agent.id);
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/messages`,
      payload: { content: "hello" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
    expect(response.json().error.message).toContain("providerId");
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("409 CONFLICT when the provider has no key, naming the env var", async () => {
    const agent = await createAgent();
    const session = await createSession(agent.id);
    // Same database, but this app's keyring has no ACUTE_PROVIDER_OPENROUTER.
    const keyless = buildServer({ token: TOKEN, db, keyring: new ProviderKeyring({}) });
    try {
      const response = await keyless.inject({
        method: "POST",
        url: `/api/v1/sessions/${session.id}/messages`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { content: "hello" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("CONFLICT");
      expect(response.json().error.message).toContain("ACUTE_PROVIDER_OPENROUTER");
      expect(generateTextMock).not.toHaveBeenCalled();
    } finally {
      await keyless.close();
    }
  });

  it("502 PROVIDER_ERROR on provider failure; the user event stays and seq is never reused", async () => {
    const agent = await createAgent();
    const session = await createSession(agent.id);

    generateTextMock.mockRejectedValueOnce(new Error(`upstream 500 (key ${KEY})`));
    const failed = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/messages`,
      payload: { content: "try me" },
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error.code).toBe("PROVIDER_ERROR");
    expect(failed.body).not.toContain(KEY);
    expect(failed.json().error.details.providerError).toContain("***");

    // The log stays append-only: the failed turn's user event consumed seq 1.
    const afterFailure = (await authInject({ method: "GET", url: `/api/v1/sessions/${session.id}` })).json();
    expect(afterFailure.lastSeq).toBe(1);
    expect(afterFailure.events).toHaveLength(1);

    // Retrying the same session works and continues the sequence at seq 2.
    const retried = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/messages`,
      payload: { content: "try again" },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().assistantMessage.seq).toBe(3);
    const seqs = (
      db
        .prepare("SELECT seq FROM session_events WHERE session_id = ? ORDER BY seq")
        .all(session.id) as { seq: number }[]
    ).map((row) => row.seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it("409 CONFLICT when the session is in a terminal status", async () => {
    const agent = await createAgent();
    const session = await createSession(agent.id);
    db.prepare("UPDATE sessions SET status = 'completed' WHERE id = ?").run(session.id);
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/messages`,
      payload: { content: "hello" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain("completed");
  });

  it("404s on an unknown session and 400s on a bad body", async () => {
    const missing = await authInject({
      method: "POST",
      url: "/api/v1/sessions/sess_missing/messages",
      payload: { content: "hello" },
    });
    expect(missing.statusCode).toBe(404);

    const agent = await createAgent();
    const session = await createSession(agent.id);
    for (const payload of [{}, { content: "" }, { content: "  " }, { content: 5 }]) {
      const response = await authInject({
        method: "POST",
        url: `/api/v1/sessions/${session.id}/messages`,
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.details.field).toBe("body.content");
    }
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});

describe("aiSdkChat usage mapping", () => {
  it("defaults missing usage fields to 0 and falls back for totalTokens", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "bare",
      usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
    });
    const result = await aiSdkChat({
      provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
      apiKey: "sk-irrelevant",
      model: "test/model-1",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
      maxTurns: 1,
    });
    expect(result.text).toBe("bare");
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });

    generateTextMock.mockResolvedValueOnce({
      text: "partial",
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: undefined },
    });
    const partial = await aiSdkChat({
      provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
      apiKey: "sk-irrelevant",
      model: "test/model-1",
      system: "keep",
      messages: [],
      temperature: 1,
      maxTurns: 2,
    });
    expect(partial.usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
    // An empty system prompt is omitted from the call entirely.
    const firstCall = generateTextMock.mock.calls[0][0] as Record<string, unknown>;
    expect(firstCall.system).toBeUndefined();
    const secondCall = generateTextMock.mock.calls[1][0] as Record<string, unknown>;
    expect(secondCall.system).toBe("keep");
  });
});

describe("streamed turn runtime (round-16)", () => {
  it("emits live events and persists user → tool.use → assistant(+stats) in order", async () => {
    const agent = await createAgent();
    const session = await createSession(agent.id);
    const streamKeyring = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY });

    const emitted: Array<{ type: string }> = [];
    const chatStream = async function* (): AsyncGenerator<import("../src/agents/chat").StreamChatEvent> {
      yield { type: "text-delta", delta: "Let me " };
      yield { type: "text-delta", delta: "look. Done." };
      yield { type: "tool-call", toolName: "list_dir", argsSummary: "path: ''" };
      yield { type: "tool-result", toolName: "list_dir", argsSummary: "path: ''", ok: true };
      yield { type: "tool-result", toolName: "write_file", argsSummary: "path: a.ts, content: 10 chars", ok: true };
      yield { type: "finish", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring: streamKeyring, chat: aiSdkChat, chatStream },
      session.id,
      "do it",
      (e) => emitted.push(e as { type: string }),
    );

    expect(outcome.ok).toBe(true);
    expect(emitted.map((e) => e.type)).toEqual([
      "text-delta",
      "text-delta",
      "tool-call",
      "tool-result",
      "tool-result",
      "finish",
    ]);

    const events = listSessionEvents(db, session.id);
    expect(events.map((e) => e.type)).toEqual([
      "message.user",
      "tool.use",
      "tool.use",
      "message.assistant",
    ]);
    const tools = events
      .filter((e) => e.type === "tool.use")
      .map((e) => e.payload as Record<string, unknown>);
    expect(tools.map((x) => x.toolName)).toEqual(["list_dir", "write_file"]);
    expect(tools.every((x) => x.ok === true)).toBe(true);

    const assistant = events.find((e) => e.type === "message.assistant")
      ?.payload as Record<string, unknown>;
    expect(assistant.content).toBe("Let me look. Done.");
    expect(assistant.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(typeof assistant.ms).toBe("number");
    expect(assistant.model).toBe("test/model-1");

    const usage = getUsageSummary(db, { days: 1 });
    expect(usage.totals.inputTokens).toBe(100);
    expect(usage.totals.outputTokens).toBe(20);
  });

  // Round-28 WS-F: multi-turn agentic continuation (outer loop).
  it("continues the outer loop when there's no completion signal, capped at maxOuterLoops", async () => {
    const agent = await createAgent();
    const session = await createSession(agent.id);
    const streamKeyring = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY });

    const emitted: Array<{ type: string }> = [];
    // Mock that produces text WITHOUT a completion signal — the outer loop
    // should continue up to maxOuterLoops (5), emitting meta.continuation
    // between iterations and meta.continuation_complete at the cap.
    const chatStream = async function* (): AsyncGenerator<import("../src/agents/chat").StreamChatEvent> {
      yield { type: "text-delta", delta: "still working" };
      yield { type: "finish", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    };

    await runStreamedAgentTurn(
      { db, keyring: streamKeyring, chat: aiSdkChat, chatStream },
      session.id,
      "do a multi-step task",
      (e) => emitted.push(e as { type: string }),
    );

    // Should have run 5 iterations (maxOuterLoops default) + 4 continuation
    // events between them + 1 continuation_complete at the end.
    const iterations = emitted.filter((e) => e.type === "finish").length;
    const continuations = emitted.filter((e) => e.type === "meta.continuation").length;
    const capEvent = emitted.find((e) => e.type === "meta.continuation_complete");
    expect(iterations).toBe(5);
    expect(continuations).toBe(4);
    expect(capEvent).toBeTruthy();
    expect((capEvent as { iterations?: number }).iterations).toBe(5);
  });

  it("refuses to stream when no streaming adapter is configured", async () => {
    const agent = await createAgent();
    const session = await createSession(agent.id);
    const streamKeyring = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY });
    const outcome = await runStreamedAgentTurn(
      { db, keyring: streamKeyring, chat: aiSdkChat },
      session.id,
      "hi",
      () => undefined,
    );
    expect(outcome.ok).toBe(false);
  });
});
