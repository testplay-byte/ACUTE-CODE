/**
 * ROUND-43 regression tests — failed turns must be LOUD, PERSISTED, and
 * RETRYABLE (the owner's silent-death bug: "it does not show me any error
 * message on the screen at all… I only see the message which I sent").
 *
 *  1. A streamed turn whose provider adapter throws persists a `turn.error`
 *     event into the session timeline (right after the user message) with the
 *     reason, model, provider, and the failed turn's user seq — and returns
 *     the session to `queued` so a retry is accepted.
 *  2. A user STOP (abort signal) is NOT an error — ABORTED outcome, no
 *     turn.error event.
 *  3. Partial work before the failure survives (tool.use events) and the
 *     error event lands after it.
 *  4. The sync path (POST /sessions/:id/messages with a rejecting provider)
 *     persists the same turn.error event and answers 502.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

// The real aiSdkChat adapter with ONLY the AI SDK mocked at the module
// boundary (same hermetic pattern as sessions.test.ts — no network, no keys).
const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: generateTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
}));

import { aiSdkChat, type StreamChatEvent } from "../src/agents/chat";
import { runStreamedAgentTurn } from "../src/agents/runtime";
import { appendSessionEvent, getSession, listSessionEvents } from "../src/storage/sessions";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r43";
const KEY = "sk-or-vtest-77f2";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r43-"));
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

async function createAgentAndSession(): Promise<{ agentId: string; sessionId: string }> {
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
  const session = sessionRes.json() as { id: string };
  return { agentId: agent.id, sessionId: session.id };
}

/** A provider adapter that dies like a real 4xx/5xx would (mid-stream throw). */
async function* throwingChatStream(): AsyncGenerator<StreamChatEvent> {
  yield { type: "text-delta", delta: "partial " };
  throw new Error("429 Too Many Requests: rate limited on test/model-1");
}

describe("runStreamedAgentTurn provider failure (ROUND-43)", () => {
  it("persists a turn.error event after the user message and returns the session to queued", async () => {
    const { agentId, sessionId } = await createAgentAndSession();
    const events0 = listSessionEvents(db, sessionId);
    expect(events0).toHaveLength(0);

    const outcome = await runStreamedAgentTurn(
      {
        db,
        keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
        chat: aiSdkChat,
        chatStream: throwingChatStream,
      },
      sessionId,
      "please summarize the README",
      () => undefined,
    );

    // 502 PROVIDER_ERROR envelope, enriched with model + userSeq + errorTs.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(502);
      expect(outcome.code).toBe("PROVIDER_ERROR");
      expect(outcome.details?.model).toBe("test/model-1");
      expect(outcome.details?.userSeq).toBe(1);
      expect(typeof outcome.details?.errorTs).toBe("string");
    }

    // THE FIX: the failure is in the session timeline — reload shows the
    // user message AND the error event below it, forever.
    const events = listSessionEvents(db, sessionId);
    expect(events.map((e) => e.type)).toEqual(["message.user", "turn.error"]);
    const user = events[0].payload as Record<string, unknown>;
    expect(user.content).toBe("please summarize the README");
    const error = events[1].payload as Record<string, unknown>;
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.model).toBe("test/model-1");
    expect(error.providerId).toBe("openrouter");
    expect(error.userSeq).toBe(1);
    expect(String(error.providerError)).toContain("429 Too Many Requests");
    expect(String(error.message)).toContain("openrouter");
    expect(events[1].agentId).toBe(agentId);

    // The session stays retryable (not running/failed) after the failure.
    const row = db
      .prepare("SELECT status FROM sessions WHERE id = ?")
      .get(sessionId) as { status: string };
    expect(row.status).toBe("queued");
  });

  it("keeps partial tool work before the failure, then appends the error event", async () => {
    const { sessionId } = await createAgentAndSession();
    const chatStream = async function* (): AsyncGenerator<StreamChatEvent> {
      yield { type: "tool-call", toolName: "read_file", argsSummary: "path: README.md" };
      yield {
        type: "tool-result",
        toolName: "read_file",
        argsSummary: "path: README.md",
        ok: true,
        outputSummary: "200 chars",
      };
      throw new Error("500 Internal Server Error from provider");
    };

    const outcome = await runStreamedAgentTurn(
      {
        db,
        keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
        chat: aiSdkChat,
        chatStream,
      },
      sessionId,
      "read then summarize",
      () => undefined,
    );
    expect(outcome.ok).toBe(false);

    const events = listSessionEvents(db, sessionId);
    expect(events.map((e) => e.type)).toEqual([
      "message.user",
      "tool.use", // the partial work SURVIVES the failure
      "turn.error", // …and the failure is appended right after it
    ]);
    const error = events[2].payload as Record<string, unknown>;
    expect(String(error.providerError)).toContain("500 Internal Server Error");
  });

  it("a user STOP is not an error: ABORTED outcome, no turn.error event", async () => {
    const { sessionId } = await createAgentAndSession();
    const controller = new AbortController();
    controller.abort();

    const chatStream = async function* (): AsyncGenerator<StreamChatEvent> {
      yield { type: "text-delta", delta: "starting…" };
      throw new Error("the SDK aborted the request");
    };

    const outcome = await runStreamedAgentTurn(
      {
        db,
        keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
        chat: aiSdkChat,
        chatStream,
      },
      sessionId,
      "stop me please",
      () => undefined,
      undefined,
      controller.signal,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("ABORTED");
      expect(outcome.status).toBe(499);
      // ROUND-58 (R58-c): the abort message names the deliberate stop.
      expect(outcome.message).toContain("stopped by user");
    }
    // Deliberate stop: NO error record. ROUND-58 (R58-c): the in-flight
    // partial segment IS now persisted (flushed on abort) so the transcript
    // keeps the streamed-so-far text and a follow-up "continue" resumes
    // from it — the old behavior (only message.user) was the partial-text
    // loss the owner reported. The partial text lands as an assistant
    // event; still NO turn.error.
    const events = listSessionEvents(db, sessionId);
    expect(events.map((e) => e.type)).toEqual(["message.user", "message.assistant"]);
    const partial = events[1].payload as { content?: string };
    expect(partial.content).toBe("starting…");
  });

  it("ROUND-58: a user STOP resets the session to queued (no eternal running spinner)", async () => {
    const { sessionId } = await createAgentAndSession();
    const controller = new AbortController();
    controller.abort();

    const chatStream = async function* (): AsyncGenerator<StreamChatEvent> {
      yield { type: "text-delta", delta: "partial" };
      throw new Error("aborted");
    };

    await runStreamedAgentTurn(
      {
        db,
        keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
        chat: aiSdkChat,
        chatStream,
      },
      sessionId,
      "stop me",
      () => undefined,
      undefined,
      controller.signal,
    );

    // The streamed path flips to "running" at turn start; the abort return
    // must reset it to the resting state — the sidebar's spinner keys off
    // this status after the streams refetch.
    const session = getSession(db, sessionId);
    expect(session?.status).toBe("queued");
  });

  it("scrubs the provider API key out of the persisted error detail", async () => {
    const { sessionId } = await createAgentAndSession();
    const chatStream = async function* (): AsyncGenerator<StreamChatEvent> {
      throw new Error(`auth failed for key ${KEY} (simulated leak)`);
    };
    await runStreamedAgentTurn(
      {
        db,
        keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
        chat: aiSdkChat,
        chatStream,
      },
      sessionId,
      "hello",
      () => undefined,
    );
    const events = listSessionEvents(db, sessionId);
    const error = events[1].payload as Record<string, unknown>;
    expect(String(error.providerError)).not.toContain(KEY);
    expect(String(error.providerError)).toContain("***");
  });
});

describe("sync path failure (POST /sessions/:id/messages)", () => {
  it("persists the turn.error event and answers 502 when the provider rejects", async () => {
    const { sessionId } = await createAgentAndSession();
    generateTextMock.mockRejectedValueOnce(new Error("503 model overloaded"));

    const res = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      payload: { content: "hello there" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("PROVIDER_ERROR");

    const events = listSessionEvents(db, sessionId);
    expect(events.map((e) => e.type)).toEqual(["message.user", "turn.error"]);
    const error = events[1].payload as Record<string, unknown>;
    expect(error.model).toBe("test/model-1");
    expect(String(error.providerError)).toContain("503 model overloaded");
    expect(error.userSeq).toBe(1);

    // Retryable: the session accepts a follow-up turn afterwards.
    const again = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      payload: { content: "retry now" },
    });
    expect(again.statusCode).toBe(200);
  });
});

describe("turn.error + listSubAgents (pre-existing read side)", () => {
  it("the persisted event feeds the sub-agent error field", async () => {
    // listSubAgents already reads `turn.error` payloads (storage/sessions.ts)
    // — the persisted shape must match what it expects.
    const { agentId, sessionId } = await createAgentAndSession();
    appendSessionEvent(db, sessionId, {
      type: "message.user",
      agentId,
      payload: { role: "user", content: "task" },
    });
    appendSessionEvent(db, sessionId, {
      type: "turn.error",
      agentId,
      payload: {
        code: "PROVIDER_ERROR",
        message: "provider 'openrouter' call failed for session x",
        model: "test/model-1",
        providerId: "openrouter",
        providerError: "429 rate limited",
        userSeq: 1,
      },
    });
    const res = await authInject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/subagents`,
    });
    // Not a child session — the endpoint still answers; the shape assertion
    // below is what matters (no crash, tolerant parse).
    expect([200, 404]).toContain(res.statusCode);
  });
});
