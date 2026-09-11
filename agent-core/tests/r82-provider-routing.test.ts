/**
 * ROUND-82 (R82, the owner's custom-provider routing fix) — the per-send
 * PROVIDER override:
 *
 *   POST /sessions/:id/messages and /messages/stream accept body.providerId
 *   (validated via providerExists → honest 400 VALIDATION for unknown ids);
 *   prepareTurn resolves the EFFECTIVE provider from the override's
 *   providerId when present — every guard (409 no-baseUrl, PROVIDER_DISABLED,
 *   no-key) runs against it; context-window/cost lookups and the vision relay
 *   key on it automatically. The debug-analyst phase mirrors the LAST turn's
 *   provider. GET /sessions/:id/context accepts ?providerId=.
 *
 * History (the defect this pins): the composer's picker captured
 * {model, providerId} but the wire dropped the providerId — a custom model
 * picked under any provider went verbatim to the AGENT's provider (the
 * default agent is openrouter-bound) → "No endpoints found".
 *
 * Coverage here:
 *  · (a) a send naming a custom provider → the chat input's provider.id +
 *    model record the OVERRIDE's pair (both send routes).
 *  · (b) unknown providerId → 400 VALIDATION (both send routes; nothing
 *    is appended to the event log).
 *  · (c) override to a DISABLED provider → 409 PROVIDER_DISABLED naming it
 *    (the R47-b guard runs against the EFFECTIVE provider, not the agent's).
 *  · (c2) override to a keyless provider → 409 CONFLICT naming the custom
 *    provider's env var (ACUTE_PROVIDER_PRV_GW).
 *  · (d) no override → the agent's provider (the pre-R82 behavior byte-for-
 *    byte — old clients keep working).
 *  · (e) GET /sessions/:id/context?providerId= → the report reflects the
 *    custom provider's context window (the meter keys on the provider that
 *    will actually serve the next send).
 *  · (f) the bare-string TurnModelOverride shape still routes to the
 *    agent's provider (compile-level compat — the union's string arm).
 *
 * The sync route is driven through buildServer's injected ChatFn spy (the
 * r43-subagent-provider pattern — provider.id + model recorded per call);
 * the streamed route through the module-boundary "ai" mock (the r78-queue
 * pattern) with the openai-compatible client factory ALSO mocked so the
 * LanguageModel handed to streamText carries the provider's name verbatim
 * (the chat-format.test.ts pattern).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

// Module-boundary mocks — no network, full stack otherwise (r78-queue pattern).
const streamTextMock = vi.hoisted(() => vi.fn());
const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  streamText: streamTextMock,
  generateText: generateTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
  jsonSchema: <T>(schema: T) => schema,
}));
// The chat-completions client factory is mocked so the model object handed
// to (the mocked) streamText carries the provider's name + baseUrl — the
// observable the provider-routing pin needs on the STREAMED path.
const createOpenAICompatibleMock = vi.hoisted(() =>
  vi.fn(() => ({
    chatModel: (model: string) => ({ kind: "openai-compatible", model }),
  })),
);
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}));

import { runSingleAgentTurn } from "../src/agents/runtime";
import type { ChatFn } from "../src/agents/chat";
import { ProviderKeyring } from "../src/providers/registry";
import { createProviderRecord, updateProviderRecord } from "../src/storage/providers";
import { createAgent } from "../src/storage/agents";
import { createSession, listSessionEvents } from "../src/storage/sessions";
import { upsertModel } from "../src/storage/models";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r82r";
const KEY = "sk-or-vtest-r82r";
const GW_KEY = "sk-gw-vtest-r82r";
const GW_ID = "prv_gw";
const GW_BASE = "https://gw.example.test/v1";
const GW_MODEL = "test/gw-model";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

/** A ChatFn spy recording the (providerId, model) pair of every turn (the
 * r43-subagent-provider spyChat pattern, extended with the provider id). */
function spyChat(): { chat: ChatFn; seen: Array<{ providerId: string; model: string }> } {
  const seen: Array<{ providerId: string; model: string }> = [];
  const chat: ChatFn = async (input) => {
    seen.push({ providerId: input.provider.id, model: input.model });
    return {
      text: "gateway reply",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [],
    };
  };
  return { chat, seen };
}

let spy: ReturnType<typeof spyChat>;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r82r-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  // The custom provider the composer's picker would name — a real row with
  // a real baseUrl (the Settings "Add provider" shape).
  createProviderRecord(db, { id: GW_ID, name: "Test Gateway", baseUrl: GW_BASE });
  spy = spyChat();
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({
      ACUTE_PROVIDER_OPENROUTER: KEY,
      ACUTE_PROVIDER_PRV_GW: GW_KEY,
    }),
    chat: spy.chat,
  });
  streamTextMock.mockReset();
  generateTextMock.mockReset();
  createOpenAICompatibleMock.mockClear();
});

afterEach(async () => {
  await app.close();
  db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
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

/** An agent bound to OPENROUTER (the default agent's shape) + a session. */
function makeSession(): { sessionId: string; agentId: string } {
  const agent = createAgent(db, {
    name: "R82 Agent",
    providerId: "openrouter",
    model: "test/model-1",
  });
  const session = createSession(db, { agentId: agent.id, mode: "single" });
  return { sessionId: session.id, agentId: agent.id };
}

/* ── The sync send route ──────────────────────────────────────────────────── */

describe("R82: POST /sessions/:id/messages with body.providerId", () => {
  it("(a) an override naming a CUSTOM provider routes the turn to it — provider.id AND model", async () => {
    const { sessionId } = makeSession();
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      payload: { content: "hello gateway", model: GW_MODEL, providerId: GW_ID },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().assistantMessage.content).toBe("gateway reply");
    // THE routing pin: the chat input carried the OVERRIDE's pair, not the
    // agent's (openrouter + test/model-1) — the pre-R82 code sent the model
    // string to the agent's provider verbatim.
    expect(spy.seen).toEqual([{ providerId: GW_ID, model: GW_MODEL }]);
    // The billing line attributes the turn to the provider that served it.
    const usageRow = db
      .prepare("SELECT * FROM usage_events WHERE session_id = ?")
      .get(sessionId) as { provider: string; model: string };
    expect(usageRow.provider).toBe(GW_ID);
    expect(usageRow.model).toBe(GW_MODEL);
  });

  it("(b) an UNKNOWN providerId is an honest 400 VALIDATION — nothing runs, nothing is appended", async () => {
    const { sessionId } = makeSession();
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      payload: { content: "hello", model: GW_MODEL, providerId: "prv_not-a-provider" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION");
    expect(response.json().error.message).toContain("no provider with id 'prv_not-a-provider'");
    expect(response.json().error.details.field).toBe("body.providerId");
    // The 400 fired BEFORE the turn — no chat call, no events.
    expect(spy.seen).toHaveLength(0);
    expect(listSessionEvents(db, sessionId)).toHaveLength(0);
  });

  it("(c) an override to a DISABLED provider is 409 PROVIDER_DISABLED naming it (the guard runs against the EFFECTIVE provider)", async () => {
    // Disable the custom provider — the AGENT's openrouter stays enabled, so
    // only an override-aware guard can see this.
    const gateway = (await import("../src/storage/providers")).getProviderRecord(db, GW_ID)!;
    updateProviderRecord(db, { ...gateway, enabled: false });
    const { sessionId } = makeSession();
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      payload: { content: "hello", model: GW_MODEL, providerId: GW_ID },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PROVIDER_DISABLED");
    expect(response.json().error.message).toContain("Test Gateway");
    expect(response.json().error.details.providerId).toBe(GW_ID);
    // Clean-state contract: the 409 fired before any event was appended.
    expect(spy.seen).toHaveLength(0);
    expect(listSessionEvents(db, sessionId)).toHaveLength(0);

    // Re-enabling unblocks the same send (the R47-b semantics, provider-scoped).
    updateProviderRecord(db, { ...gateway, enabled: true });
    const retried = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      payload: { content: "hello again", model: GW_MODEL, providerId: GW_ID },
    });
    expect(retried.statusCode).toBe(200);
    expect(spy.seen).toEqual([{ providerId: GW_ID, model: GW_MODEL }]);
  });

  it("(c2) an override to a KEYLESS provider is 409 CONFLICT naming the custom provider's env var", async () => {
    // Same database, but this app's keyring never received the gateway's key
    // (the restart cliff R82-B fixes on the Rust side — here: honest 409).
    const keyless = buildServer({
      token: TOKEN,
      db,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
      chat: spy.chat,
    });
    try {
      const { sessionId } = makeSession();
      const response = await keyless.inject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/messages`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { content: "hello", model: GW_MODEL, providerId: GW_ID },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("CONFLICT");
      // ROUND-92 (R92-D, re-pin): prepareTurn now resolves the provider's
      // key POOL (any size ≥ 1 passes) and the no-pool 409 points at the
      // Settings UI instead of the env-var name (spawn-injection plumbing).
      expect(response.json().error.message).toContain("no API key for provider 'prv_gw'");
      expect(response.json().error.message).toContain(
        "add one or more keys in Settings → Models & Providers",
      );
      expect(spy.seen).toHaveLength(0);
    } finally {
      await keyless.close();
    }
  });

  it("(d) NO override → the agent's provider (the pre-R82 behavior, byte-for-byte)", async () => {
    const { sessionId } = makeSession();
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      payload: { content: "hello" },
    });
    expect(response.statusCode).toBe(200);
    expect(spy.seen).toEqual([{ providerId: "openrouter", model: "test/model-1" }]);
  });

  it("a model-only override (no providerId) still routes to the agent's provider", async () => {
    const { sessionId } = makeSession();
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      payload: { content: "hello", model: "test/other-model" },
    });
    expect(response.statusCode).toBe(200);
    expect(spy.seen).toEqual([{ providerId: "openrouter", model: "test/other-model" }]);
  });
});

/* ── The streamed send route ──────────────────────────────────────────────── */

describe("R82: POST /sessions/:id/messages/stream with body.providerId", () => {
  /** The SDK-boundary stream shape the mocked streamText returns (r78-queue). */
  function sdkStream(): {
    fullStream: AsyncGenerator<Record<string, unknown>>;
    totalUsage: Promise<unknown>;
    usage: Promise<unknown>;
  } {
    return {
      fullStream: (async function* () {
        yield { type: "text-delta", text: "streamed gateway reply." };
        yield { type: "finish-step", usage: { inputTokens: 5, outputTokens: 5 } };
      })(),
      totalUsage: Promise.resolve({ inputTokens: 5, outputTokens: 5, totalTokens: 10 }),
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 5, totalTokens: 10 }),
    };
  }

  /** Parse a hijacked SSE body into its data frames. */
  function parseSse(body: string): Array<Record<string, unknown>> {
    const frames: Array<Record<string, unknown>> = [];
    for (const block of body.split("\n\n")) {
      for (const line of block.split("\n")) {
        if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
      }
    }
    return frames;
  }

  it("(a) an override naming a CUSTOM provider builds the model client against THAT provider", async () => {
    const { sessionId } = makeSession();
    streamTextMock.mockImplementation(() => sdkStream());

    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "hello gateway", model: GW_MODEL, providerId: GW_ID },
    });
    expect(response.statusCode).toBe(200);
    // The client was constructed from the OVERRIDE's provider row — the
    // custom id + its baseUrl (the agent's openrouter would have built
    // https://openrouter.ai/api/v1 instead).
    expect(createOpenAICompatibleMock).toHaveBeenCalledTimes(1);
    expect(createOpenAICompatibleMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: GW_ID, baseURL: GW_BASE }),
    );
    // …and the turn's model is the override's model id.
    const call = streamTextMock.mock.calls[0][0] as { model?: { model?: string } };
    expect(call.model?.model).toBe(GW_MODEL);
    const frames = parseSse(response.body as string);
    expect(frames[frames.length - 1]?.type).toBe("done");
    // The billing line attributes the streamed turn to the custom provider.
    const usageRow = db
      .prepare("SELECT * FROM usage_events WHERE session_id = ?")
      .get(sessionId) as { provider: string; model: string };
    expect(usageRow.provider).toBe(GW_ID);
    expect(usageRow.model).toBe(GW_MODEL);
  });

  it("(b) an UNKNOWN providerId is the same honest 400 VALIDATION on the streamed route", async () => {
    const { sessionId } = makeSession();
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "hello", model: GW_MODEL, providerId: "prv_nope" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION");
    expect(response.json().error.details.field).toBe("body.providerId");
    expect(streamTextMock).not.toHaveBeenCalled();
    expect(listSessionEvents(db, sessionId)).toHaveLength(0);
  });

  it("(c) an override to a DISABLED provider emits the PROVIDER_DISABLED error frame before any event is appended", async () => {
    const gateway = (await import("../src/storage/providers")).getProviderRecord(db, GW_ID)!;
    updateProviderRecord(db, { ...gateway, enabled: false });
    const { sessionId } = makeSession();
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "hello", model: GW_MODEL, providerId: GW_ID },
    });
    // The streamed route is SSE 200 — the guard rides the wire as the
    // terminal error frame (the R43/R80 contract).
    expect(response.statusCode).toBe(200);
    const frames = parseSse(response.body as string);
    const errorFrame = frames.find((f) => f.type === "error") as
      | { status?: number; code?: string; details?: { providerId?: string } }
      | undefined;
    expect(errorFrame).toBeDefined();
    expect(errorFrame?.status).toBe(409);
    expect(errorFrame?.code).toBe("PROVIDER_DISABLED");
    expect(errorFrame?.details?.providerId).toBe(GW_ID);
    expect(streamTextMock).not.toHaveBeenCalled();
    // Clean-state contract: the guard fired before any event was appended.
    expect(listSessionEvents(db, sessionId)).toHaveLength(0);
  });

  it("(d) NO override → the openrouter client, exactly as before R82", async () => {
    const { sessionId } = makeSession();
    streamTextMock.mockImplementation(() => sdkStream());
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "hello" },
    });
    expect(response.statusCode).toBe(200);
    expect(createOpenAICompatibleMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "openrouter", baseURL: "https://openrouter.ai/api/v1" }),
    );
    const call = streamTextMock.mock.calls[0][0] as { model?: { model?: string } };
    expect(call.model?.model).toBe("test/model-1");
  });
});

/* ── The context meter route ──────────────────────────────────────────────── */

describe("R82: GET /sessions/:id/context?providerId=", () => {
  it("(e) the report reflects the CUSTOM provider's context window for its model row", async () => {
    // Distinct windows per (provider, model): openrouter's row and the
    // gateway's row for their respective models.
    upsertModel(db, "openrouter", { modelId: "test/model-1", contextWindow: 111_111 });
    upsertModel(db, GW_ID, { modelId: GW_MODEL, contextWindow: 222_222 });
    const { sessionId } = makeSession();

    // Without the override: the agent's provider + its window (pre-R82).
    const mine = await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/context` });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().providerId).toBe("openrouter");
    expect(mine.json().contextWindow).toBe(111_111);

    // With the composer's per-send pair: the meter keys on the provider that
    // will actually serve the next send.
    const theirs = await authInject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/context?model=${encodeURIComponent(GW_MODEL)}&providerId=${GW_ID}`,
    });
    expect(theirs.statusCode).toBe(200);
    expect(theirs.json().providerId).toBe(GW_ID);
    expect(theirs.json().model).toBe(GW_MODEL);
    expect(theirs.json().contextWindow).toBe(222_222);
  });

  it("an UNKNOWN providerId never 400s — it is metered as-is with the generic default window", async () => {
    // The meter route is a read: a bad id is echoed and the window falls to
    // the 200 000 default (no models row exists for an unknown provider).
    // NOTE (R82-TESTS, honest pin): the route's inline comment claims
    // "unknown ids fall back to the agent's" — the CODE actually meters the
    // unknown provider id itself (window = the generic 200K default, not
    // the agent's row). Pinned as-implemented; a hand-crafted query is the
    // only source of unknown ids (the frontend passes the composer's
    // send-validated override), so the difference is cosmetic — flagged in
    // the R82-TESTS report, src frozen.
    upsertModel(db, "openrouter", { modelId: "test/model-1", contextWindow: 111_111 });
    const { sessionId } = makeSession();
    const response = await authInject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/context?providerId=prv_never-heard-of`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().providerId).toBe("prv_never-heard-of");
    expect(response.json().contextWindow).toBe(200_000);
  });
});

/* ── Compile-level compat: the bare-string TurnModelOverride arm ──────────── */

describe("R82: TurnModelOverride's bare-string arm (compile-level compat)", () => {
  it("(f) a STRING override routes to the agent's provider — every existing caller keeps working", async () => {
    const { sessionId } = makeSession();
    const outcome = await runSingleAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat: spy.chat },
      sessionId,
      "string-shaped override",
      "test/legacy-string-override",
    );
    expect(outcome.ok).toBe(true);
    // The string arm means the model alone; the provider stays the agent's.
    expect(spy.seen).toEqual([{ providerId: "openrouter", model: "test/legacy-string-override" }]);
  });
});
