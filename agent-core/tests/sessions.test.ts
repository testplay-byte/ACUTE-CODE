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
import { appendSessionEvent, listSessionEvents } from "../src/storage/sessions";
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
  method: "GET" | "POST" | "PATCH" | "DELETE";
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

describe("DELETE /api/v1/sessions/:id (round-30)", () => {
  it("deletes a session with its events and usage rows, leaving others intact", async () => {
    const agent = await createAgent();
    const victim = await createSession(agent.id);
    const survivor = await createSession(agent.id);

    // Give the victim a user message + a completed turn (usage row + events).
    const turn = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${victim.id}/messages`,
      payload: { content: "hello" },
    });
    expect(turn.statusCode).toBe(200);
    expect(listSessionEvents(db, victim.id).length).toBeGreaterThan(0);

    const del = await authInject({ method: "DELETE", url: `/api/v1/sessions/${victim.id}` });
    expect(del.statusCode).toBe(204);

    // The victim is gone — row, events, usage.
    await expect(
      authInject({ method: "GET", url: `/api/v1/sessions/${victim.id}` }),
    ).resolves.toMatchObject({ statusCode: 404 });
    expect(listSessionEvents(db, victim.id)).toEqual([]);
    const usageLeft = db
      .prepare("SELECT COUNT(*) AS n FROM usage_events WHERE session_id = ?")
      .get(victim.id) as { n: number };
    expect(usageLeft.n).toBe(0);

    // The survivor is untouched.
    const survivorGet = await authInject({ method: "GET", url: `/api/v1/sessions/${survivor.id}` });
    expect(survivorGet.statusCode).toBe(200);
  });

  it("404s on an unknown session", async () => {
    const response = await authInject({ method: "DELETE", url: "/api/v1/sessions/sess_missing" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("requires the bearer token", async () => {
    const agent = await createAgent();
    const session = await createSession(agent.id);
    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/sessions/${session.id}`,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("PATCH /api/v1/sessions/:id (round-33 rename)", () => {
  it("renames a session and trims whitespace; empty title clears it", async () => {
    const agent = await createAgent();
    const session = await createSession(agent.id);

    const renamed = await authInject({
      method: "PATCH",
      url: `/api/v1/sessions/${session.id}`,
      payload: { title: "  Fix the login bug  " },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().title).toBe("Fix the login bug");

    const cleared = await authInject({
      method: "PATCH",
      url: `/api/v1/sessions/${session.id}`,
      payload: { title: "   " },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().title).toBeNull();
  });

  it("404s on an unknown session and 400s on a bad body", async () => {
    const missing = await authInject({
      method: "PATCH",
      url: "/api/v1/sessions/sess_missing",
      payload: { title: "x" },
    });
    expect(missing.statusCode).toBe(404);

    const bad = await authInject({
      method: "PATCH",
      url: "/api/v1/sessions/any",
      payload: { title: 42 },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("VALIDATION");
  });

  it("requires the bearer token", async () => {
    const agent = await createAgent();
    const session = await createSession(agent.id);
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/sessions/${session.id}`,
      payload: { title: "no auth" },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("ROUND-34: tool results feed back into the conversation (multi-step fix)", () => {
  it("assembles history with <tool_results> blocks so iteration 2+ sees what tools did", async () => {
    const agent = await createAgent();
    const session = await createSession(agent.id);

    // Simulate a tool-using turn: user → tool.use (with output) → assistant.
    await authInject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/messages`,
      payload: { content: "create notes.txt" },
    }).catch(() => undefined);
    // Direct event-log writes (the runtime normally does this):
    const db2 = db;
    appendSessionEvent(db2, session.id, {
      type: "tool.use",
      agentId: agent.id,
      payload: { role: "tool", toolName: "write_file", argsSummary: "path: notes.txt", ok: true, outputSummary: "wrote 24 chars" },
    });
    // Now run a SYNC turn with a mock that RECORDS the messages it receives.
    const seenMessages: Array<{ role: string; content: string }> = [];
    generateTextMock.mockReset();
    generateTextMock.mockImplementation((input: { messages: Array<{ role: string; content: string }> }) => {
      seenMessages.push(...input.messages);
      return {
        text: "Done.",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    });
    const turn = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/messages`,
      payload: { content: "what did you do?" },
    });
    expect(turn.statusCode).toBe(200);
    // The second turn's conversation MUST include the tool result block.
    const toolBlock = seenMessages.find((m) => m.content.includes("<tool_results>"));
    expect(toolBlock).toBeTruthy();
    expect(toolBlock!.content).toContain("write_file(path: notes.txt) → ok: wro");
  });
});

describe("ROUND-35: thinking + interleaved segments", () => {
  it("persists thinking with the assistant segment and flushes text AROUND tool calls", async () => {
    const agent = await createAgent();
    const session = await createSession(agent.id);
    const streamKeyring = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY });

    const chatStream = async function* (): AsyncGenerator<import("../src/agents/chat").StreamChatEvent> {
      yield { type: "thinking-delta", delta: "I should create the file first." };
      yield { type: "text-delta", delta: "Creating the file now." };
      yield { type: "tool-call", toolName: "write_file", argsSummary: "path: a.ts" };
      yield { type: "tool-result", toolName: "write_file", argsSummary: "path: a.ts", ok: true, outputSummary: "wrote 10 chars" };
      yield { type: "text-delta", delta: " Done." };
      yield { type: "finish", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring: streamKeyring, chat: aiSdkChat, chatStream },
      session.id,
      "create a.ts then say done",
      () => undefined,
    );
    expect(outcome.ok).toBe(true);

    const events = listSessionEvents(db, session.id);
    expect(events.map((e) => e.type)).toEqual([
      "message.user",
      "message.assistant", // interim segment: "Creating the file now." + thinking
      "tool.use",
      "message.assistant", // final segment: " Done." with stats
    ]);
    const interim = events[1].payload as Record<string, unknown>;
    expect(interim.content).toBe("Creating the file now.");
    expect(interim.thinking).toBe("I should create the file first.");
    expect(interim.usage).toBeUndefined();
    const final = events[3].payload as Record<string, unknown>;
    expect(final.content).toBe(" Done.");
    expect(final.usage).toEqual({ inputTokens: 5, outputTokens: 5 });
    expect(final.model).toBe("test/model-1");
  });
});

describe("ROUND-34: PATCH/DELETE /api/v1/providers/:id", () => {
  it("custom providers can be renamed, re-pointed, disabled, and deleted", async () => {
    const created = await authInject({
      method: "POST",
      url: "/api/v1/providers",
      payload: { name: "My Gateway", baseUrl: "https://gw.example.com/v1" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const patched = await authInject({
      method: "PATCH",
      url: `/api/v1/providers/${id}`,
      payload: { name: "Renamed GW", baseUrl: "https://gw2.example.com/v1", enabled: false },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ name: "Renamed GW", baseUrl: "https://gw2.example.com/v1", enabled: false });

    const gone = await authInject({ method: "DELETE", url: `/api/v1/providers/${id}` });
    expect(gone.statusCode).toBe(204);
    const missing = await authInject({ method: "GET", url: `/api/v1/providers/${id}/models` });
    expect(missing.statusCode).toBe(404);
  });

  it("ROUND-37: built-ins are now editable (owner: every provider gets delete/rename/baseUrl/format)", async () => {
    const patched = await authInject({
      method: "PATCH",
      url: "/api/v1/providers/anthropic",
      payload: { name: "Anthropic (proxy)", baseUrl: "https://proxy.example.com/v1", apiFormat: "anthropic-messages" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      id: "anthropic",
      name: "Anthropic (proxy)",
      baseUrl: "https://proxy.example.com/v1",
      apiFormat: "anthropic-messages",
    });

    // restore for other tests
    const restored = await authInject({
      method: "PATCH",
      url: "/api/v1/providers/anthropic",
      payload: { name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", apiFormat: "chat-completions" },
    });
    expect(restored.statusCode).toBe(200);
  });

  it("ROUND-37: deleting a built-in tombstones it — the boot seed does NOT resurrect it; re-adding clears the tombstone", async () => {
    const dbPath = join(tempDir, `${randomUUID()}.db`);
    const inject = (a: FastifyInstance, url: string, method: "GET" | "POST" | "DELETE" = "GET", payload?: Record<string, unknown>) =>
      a.inject({ url, method, ...(payload ? { payload } : {}), headers: { authorization: `Bearer ${TOKEN}` } });

    // Fresh database + server.
    let localDb = openDatabase(dbPath);
    let localApp = buildServer({ token: TOKEN, db: localDb, keyring: new ProviderKeyring({}) });

    // Delete the openai built-in.
    const del = await inject(localApp, "/api/v1/providers/openai", "DELETE");
    expect(del.statusCode).toBe(204);
    await localApp.close();
    localDb.close();

    // Re-open the database (the boot seed runs) — openai must STAY deleted.
    localDb = openDatabase(dbPath);
    localApp = buildServer({ token: TOKEN, db: localDb, keyring: new ProviderKeyring({}) });
    const list = await inject(localApp, "/api/v1/providers");
    expect(list.statusCode).toBe(200);
    expect(list.json().providers.find((p: { id: string }) => p.id === "openai")).toBeUndefined();

    // Re-adding via the Add Provider preset (POST with the reserved id) works
    // and clears the tombstone.
    const readd = await inject(localApp, "/api/v1/providers", "POST", {
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(readd.statusCode).toBe(201);
    await localApp.close();
    localDb.close();

    // …and the seed still leaves the re-added row alone on the next open.
    localDb = openDatabase(dbPath);
    localApp = buildServer({ token: TOKEN, db: localDb, keyring: new ProviderKeyring({}) });
    const list2 = await inject(localApp, "/api/v1/providers");
    expect(list2.json().providers.find((p: { id: string }) => p.id === "openai")).toMatchObject({ id: "openai" });
    await localApp.close();
    localDb.close();
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
      // ROUND-50 (R50-c1) → ROUND-83 (R83): the mocked generateText reports
      // NO cached tier — the usage row now writes NULL (the shared type's
      // documented contract, finally honored): the meter's hit-rate line
      // renders "— not reported" instead of a fabricated 0%. The pre-R83
      // code recorded a plain 0 here (the audit's §2.10).
      cachedInputTokens: null,
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

    // Session returned to the resting state after the successful turn
    // (ROUND-44 fix: success used to leave it stuck at "running" forever —
    // only the error path reset it); both events landed with monotonic seqs.
    const fetched = await authInject({ method: "GET", url: `/api/v1/sessions/${session.id}` });
    const detailed = fetched.json();
    expect(detailed.status).toBe("queued");
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

  it("409 CONFLICT when the provider has no key, pointing at the Settings UI", async () => {
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
      // ROUND-92 (R92-D): the message now points at the UI where keys are
      // added (Settings → Models & Providers) instead of the pre-R92 env-var
      // name — the shell persists keys via Credential Manager; the env var is
      // spawn-injection plumbing the owner should never hand-set. Pinned
      // here because the pool changed the wording (a pool of ANY size ≥ 1
      // passes this gate).
      expect(response.json().error.message).toContain("no API key for provider 'openrouter'");
      expect(response.json().error.message).toContain(
        "add one or more keys in Settings → Models & Providers",
      );
      expect(generateTextMock).not.toHaveBeenCalled();
    } finally {
      await keyless.close();
    }
  });

  // ROUND-47 (R47-b): provider.enabled === false blocks the turn at
  // prepareTurn — the same error path as the no-key 409 above (no user event
  // appended, session stays clean and retryable, the 409 envelope drives the
  // UI's honest error card).
  it("ROUND-47: 409 PROVIDER_DISABLED when the provider is disabled; re-enabling unblocks the turn", async () => {
    const agent = await createAgent();
    const session = await createSession(agent.id);
    // Same database, keyring WITHOUT the openrouter key — after re-enabling,
    // the turn must fall through to the NORMAL next failure (the no-key 409),
    // proving the block was the disablement and nothing else.
    const keyless = buildServer({ token: TOKEN, db, keyring: new ProviderKeyring({}) });
    try {
      const auth = { authorization: `Bearer ${TOKEN}` };
      const disabled = await keyless.inject({
        method: "PATCH",
        url: "/api/v1/providers/openrouter",
        headers: auth,
        payload: { enabled: false },
      });
      expect(disabled.statusCode).toBe(200);
      expect(disabled.json().enabled).toBe(false);

      // PROVIDER_DISABLED wins even though the key is ALSO missing — the
      // disablement is the owner's explicit choice, the more fundamental state.
      const blocked = await keyless.inject({
        method: "POST",
        url: `/api/v1/sessions/${session.id}/messages`,
        headers: auth,
        payload: { content: "hello" },
      });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error.code).toBe("PROVIDER_DISABLED");
      expect(blocked.json().error.message).toContain(
        "Provider 'OpenRouter' is disabled — enable it in Settings → Models & Providers",
      );
      expect(blocked.json().error.details.providerId).toBe("openrouter");
      expect(generateTextMock).not.toHaveBeenCalled();
      // Clean state: nothing was appended — the retry after re-enabling
      // starts from scratch (no orphaned user event).
      const eventCount = db
        .prepare("SELECT COUNT(*) AS n FROM session_events WHERE session_id = ?")
        .get(session.id) as { n: number };
      expect(eventCount.n).toBe(0);

      // Re-enable → the very same turn proceeds to the normal next failure.
      const enabled = await keyless.inject({
        method: "PATCH",
        url: "/api/v1/providers/openrouter",
        headers: auth,
        payload: { enabled: true },
      });
      expect(enabled.statusCode).toBe(200);
      const retried = await keyless.inject({
        method: "POST",
        url: `/api/v1/sessions/${session.id}/messages`,
        headers: auth,
        payload: { content: "hello" },
      });
      expect(retried.statusCode).toBe(409);
      expect(retried.json().error.code).toBe("CONFLICT");
      // ROUND-92 (R92-D): the re-pinned no-key wording (see the test above).
      expect(retried.json().error.message).toContain("no API key for provider 'openrouter'");
      expect(retried.json().error.message).toContain("Settings → Models & Providers");
      expect(generateTextMock).not.toHaveBeenCalled();
    } finally {
      // Leave the shared db in the seeded state for any later test.
      await keyless.inject({
        method: "PATCH",
        url: "/api/v1/providers/openrouter",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { enabled: true },
      });
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

    // ROUND-43: the failure is now PERSISTED as a turn.error event (the
    // owner's silent-death bug — the log previously ended at the user event,
    // so a reload showed nothing below the user's message). Append-only: the
    // user event consumed seq 1, the error event seq 2.
    const afterFailure = (await authInject({ method: "GET", url: `/api/v1/sessions/${session.id}` })).json();
    expect(afterFailure.lastSeq).toBe(2);
    expect(afterFailure.events).toHaveLength(2);
    expect(afterFailure.events[1].type).toBe("turn.error");
    expect(afterFailure.events[1].payload.model).toBe("test/model-1");
    expect(afterFailure.events[1].payload.userSeq).toBe(1);
    expect(JSON.stringify(afterFailure.events[1])).not.toContain(KEY);

    // Retrying the same session works and continues the sequence at seq 3.
    const retried = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/messages`,
      payload: { content: "try again" },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().assistantMessage.seq).toBe(4);
    const seqs = (
      db
        .prepare("SELECT seq FROM session_events WHERE session_id = ? ORDER BY seq")
        .all(session.id) as { seq: number }[]
    ).map((row) => row.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
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
    // ROUND-35: text segments flush AROUND tool calls — the mock emits
    // text → tool-call/tool-result → finish (no trailing text), so the order
    // is user → assistant(segment) → tool.use ×2 → assistant(STATS CARRIER:
    // empty content + usage/ms/model — review fix #1 keeps the badges alive).
    expect(events.map((e) => e.type)).toEqual([
      "message.user",
      "message.assistant",
      "tool.use",
      "tool.use",
      "message.assistant",
    ]);
    const tools = events
      .filter((e) => e.type === "tool.use")
      .map((e) => e.payload as Record<string, unknown>);
    expect(tools.map((x) => x.toolName)).toEqual(["list_dir", "write_file"]);
    expect(tools.every((x) => x.ok === true)).toBe(true);

    // The FIRST assistant event is the interim text segment (no stats);
    // the LAST is the stats carrier (empty content + usage/ms/model).
    const assistants = events.filter((e) => e.type === "message.assistant");
    const interim = assistants[0].payload as Record<string, unknown>;
    expect(interim.content).toBe("Let me look. Done.");
    expect(interim.usage).toBeUndefined();
    const carrier = assistants[assistants.length - 1].payload as Record<string, unknown>;
    expect(carrier.content).toBe("");
    expect(carrier.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(typeof carrier.ms).toBe("number");
    expect(carrier.model).toBe("test/model-1");

    const usage = getUsageSummary(db, { days: 1 });
    expect(usage.totals.inputTokens).toBe(100);
    expect(usage.totals.outputTokens).toBe(20);
  });

  // Round-28 WS-F: multi-turn agentic continuation (outer loop).
  it("ROUND-33: a text-only reply with NO tool calls STOPS the outer loop (the 'hello' bug)", async () => {
    const agent = await createAgent();
    const session = await createSession(agent.id);
    const streamKeyring = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY });

    const emitted: Array<{ type: string }> = [];
    // Mock that produces a conversational reply with ZERO tool calls — the
    // owner's "hello, how are you" case. The turn must end after ONE
    // iteration; the old behavior (continue up to maxOuterLoops) forced the
    // model to invent work in an infinite-feeling loop.
    const chatStream = async function* (): AsyncGenerator<import("../src/agents/chat").StreamChatEvent> {
      yield { type: "text-delta", delta: "Hey, doing great, thanks for asking!" };
      yield { type: "finish", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    };

    await runStreamedAgentTurn(
      { db, keyring: streamKeyring, chat: aiSdkChat, chatStream },
      session.id,
      "hello, how are you",
      (e) => emitted.push(e as { type: string }),
    );

    expect(emitted.filter((e) => e.type === "finish").length).toBe(1);
    expect(emitted.filter((e) => e.type === "meta.continuation").length).toBe(0);
    expect(emitted.find((e) => e.type === "meta.continuation_complete")).toBeUndefined();
  });

  it("continues the outer loop for TOOL-USING iterations without a completion signal, capped at maxOuterLoops", async () => {
    const agent = await createAgent();
    const session = await createSession(agent.id);
    const streamKeyring = new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY });

    const emitted: Array<{ type: string }> = [];
    // Mock that CALLS TOOLS and never produces final text — the outer loop
    // continues up to maxOuterLoops (5).
    // ROUND-51 (R51-f): the args VARY per iteration. The original fixture
    // repeated the IDENTICAL list_dir call every iteration — exactly the
    // no-progress loop the loop-hygiene guard exists to warn on (it would
    // nudge at 3 under R96-B's warn-only contract). The test's intent is
    // unchanged: tool-using iterations without a completion signal run to
    // the maxOuterLoops cap.
    // ROUND-96 (R96-B): the per-iteration "still working" TEXT is GONE —
    // under the new completion rule (research finding #1: a tool-using
    // iteration with non-empty text is the model's OWN stop) text+tools
    // ends the turn after ONE iteration. The loop-continuing shape is
    // TOOLS WITHOUT TEXT (the model is mid-work — see the runtime's
    // "Tools only, no text — the model is mid-work" path).
    let streamCalls = 0;
    const chatStream = async function* (): AsyncGenerator<import("../src/agents/chat").StreamChatEvent> {
      streamCalls += 1;
      yield { type: "tool-call", toolName: "list_dir", argsSummary: `path: ./iter-${streamCalls}`, args: { path: `./iter-${streamCalls}` } };
      yield { type: "tool-result", toolName: "list_dir", argsSummary: `path: ./iter-${streamCalls}`, args: { path: `./iter-${streamCalls}` }, ok: true };
      yield { type: "finish", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    };

    await runStreamedAgentTurn(
      { db, keyring: streamKeyring, chat: aiSdkChat, chatStream },
      session.id,
      "do a multi-step task",
      (e) => emitted.push(e as { type: string }),
    );

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
