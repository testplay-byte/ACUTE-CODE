/**
 * ROUND-92 (R92-B, the owner's v0.89.0 dead-end report: "Generation failed:
 * agent acute has no provider ID/model configured" — even after picking the
 * new provider's model in the composer) — the OVERRIDE-FIRST resolution gate.
 *
 * R91-A's force-delete (resetAgentsProvider) put referencing agents at
 * provider_id = NULL / model = NULL — a state no mainstream flow produced
 * before. prepareTurn's null gate ran BEFORE the per-send {model, providerId}
 * override was normalized, so the complete pair every chat send carries since
 * R82 could never satisfy it: the dead end. ROUND-92 reorders every gate to
 * decide on the EFFECTIVE pair (the override's when present, the agent's
 * otherwise):
 *
 *   · (a) a NULL agent + a complete override → the turn RUNS on the override's
 *     provider+model (sync + streamed routes; usage attributes to it).
 *   · (b) a NULL agent + NO override → the pinned 409 (sessions.test.ts's
 *     contract, message unchanged — still true: no complete pair exists).
 *   · (c) a NULL agent + a HALF-pair override (model without providerId) →
 *     the same honest 409.
 *   · (d) a CONFIGURED agent + no override → byte-for-byte the R82 behavior.
 *   · (e) the context meter: ?providerId=/?model= satisfy the gate.
 *   · (f) POST /sessions/:id/compact?providerId=&model= — the same effective
 *     pair for the compaction call (the R83 route gained the params).
 *   · (g) R92-C: PATCH /agents/:id with explicit nulls CLEARS providerId/model
 *     (the AgentFormDialog round-trip); absent fields still keep the row.
 *
 * Harness: the r82-provider-routing pattern (module-boundary "ai" mocks for
 * the streamed route; buildServer's injected ChatFn spy for the sync route +
 * compaction).
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
// provider-routing observable on the STREAMED path (r82's pattern).
const createOpenAICompatibleMock = vi.hoisted(() =>
  vi.fn(() => ({
    chatModel: (model: string) => ({ kind: "openai-compatible", model }),
  })),
);
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}));

import type { ChatFn } from "../src/agents/chat";
import { ProviderKeyring } from "../src/providers/registry";
import { createProviderRecord } from "../src/storage/providers";
import {
  createAgent,
  getAgent,
  resetAgentsProvider,
  updateAgent,
} from "../src/storage/agents";
import { appendSessionEvent, createSession, listSessionEvents } from "../src/storage/sessions";
import { upsertModel } from "../src/storage/models";
import { findLatestCompaction } from "../src/agents/compaction";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r92r";
const KEY = "sk-or-vtest-r92r";
const GW_KEY = "sk-gw-vtest-r92r";
const GW_ID = "prv_gw";
const GW_BASE = "https://gw.example.test/v1";
const GW_MODEL = "test/gw-model";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

/** A ChatFn spy recording the (providerId, model) pair of every call (the
 * r82 spyChat pattern — serves the sync turn route AND the compaction
 * summarizer, both buildServer-injected). */
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
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r92r-"));
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
  method: "GET" | "POST" | "PATCH";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

/**
 * The R91-A end-state: an agent that referenced openrouter, reset to
 * NULL/NULL by the force-delete (resetAgentsProvider — the exact production
 * path, not a synthetic insert).
 */
function makeResetAgentSession(): { sessionId: string; agentId: string } {
  const agent = createAgent(db, {
    name: "Reset Agent",
    providerId: "openrouter",
    model: "test/model-1",
  });
  const reset = resetAgentsProvider(db, "openrouter");
  expect(reset).toBeGreaterThanOrEqual(1);
  expect(getAgent(db, agent.id)?.providerId).toBeNull();
  expect(getAgent(db, agent.id)?.model).toBeNull();
  const session = createSession(db, { agentId: agent.id, mode: "single" });
  return { sessionId: session.id, agentId: agent.id };
}

/* ── The sync send route ──────────────────────────────────────────────────── */

describe("R92-B: POST /sessions/:id/messages on a NULL agent (the reset state)", () => {
  it("(a) a send carrying the complete {model, providerId} override RUNS the turn on the override's pair", async () => {
    const { sessionId, agentId } = makeResetAgentSession();
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      payload: { content: "hello gateway", model: GW_MODEL, providerId: GW_ID },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().assistantMessage.content).toBe("gateway reply");
    // THE dead-end pin: the chat input carried the OVERRIDE's pair — the old
    // gate 409'd on the agent row before this could ever happen.
    expect(spy.seen).toEqual([{ providerId: GW_ID, model: GW_MODEL }]);
    // The billing line attributes the turn to the provider that served it.
    const usageRow = db
      .prepare("SELECT * FROM usage_events WHERE session_id = ?")
      .get(sessionId) as { provider: string; model: string };
    expect(usageRow.provider).toBe(GW_ID);
    expect(usageRow.model).toBe(GW_MODEL);
    // The send does NOT write the agent row — the arm-from-pick PATCH is the
    // chat picker's job (R92-B's frontend half); a headless API caller keeps
    // the NULL state (the override rides every send).
    expect(getAgent(db, agentId)?.providerId).toBeNull();
    expect(getAgent(db, agentId)?.model).toBeNull();
  });

  it("(b) NO override → the pinned 409 (the message unchanged — still true: no complete pair exists)", async () => {
    const { sessionId } = makeResetAgentSession();
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      payload: { content: "hello" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
    expect(response.json().error.message).toContain("has no providerId/model configured");
    // Clean-state contract: nothing ran, nothing was appended.
    expect(spy.seen).toHaveLength(0);
    expect(listSessionEvents(db, sessionId)).toHaveLength(0);
  });

  it("(c) a model-ONLY override (half a pair) → the same honest 409", async () => {
    const { sessionId } = makeResetAgentSession();
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      payload: { content: "hello", model: GW_MODEL },
    });
    // The send didn't carry a complete pair either (no providerId → the
    // agent's NULL row decides) — the message stays the agent's own truth.
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain("has no providerId/model configured");
    expect(spy.seen).toHaveLength(0);
  });

  it("(d) regression pin: a CONFIGURED agent + no override keeps the R82 behavior (the agent's pair)", async () => {
    const agent = createAgent(db, {
      name: "Configured Agent",
      providerId: "openrouter",
      model: "test/model-1",
    });
    const session = createSession(db, { agentId: agent.id, mode: "single" });
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/messages`,
      payload: { content: "hello" },
    });
    expect(response.statusCode).toBe(200);
    expect(spy.seen).toEqual([{ providerId: "openrouter", model: "test/model-1" }]);
  });
});

/* ── The streamed send route ──────────────────────────────────────────────── */

describe("R92-B: POST /sessions/:id/messages/stream on a NULL agent", () => {
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

  it("(a) a complete override streams the turn against the OVERRIDE's provider + model", async () => {
    const { sessionId } = makeResetAgentSession();
    streamTextMock.mockImplementation(() => sdkStream());

    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "hello gateway", model: GW_MODEL, providerId: GW_ID },
    });
    expect(response.statusCode).toBe(200);
    // The client was constructed from the OVERRIDE's provider row — the
    // custom id + its baseUrl (the agent's NULL row never got a vote).
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

  it("(b) NO override → the honest error frame before any event is appended", async () => {
    const { sessionId } = makeResetAgentSession();
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "hello" },
    });
    // The streamed route is SSE 200 — the guard rides the wire as the
    // terminal error frame (the R43/R80 contract).
    expect(response.statusCode).toBe(200);
    const frames = parseSse(response.body as string);
    const errorFrame = frames.find((f) => f.type === "error") as
      | { status?: number; code?: string; message?: string }
      | undefined;
    expect(errorFrame).toBeDefined();
    expect(errorFrame?.status).toBe(409);
    expect(errorFrame?.code).toBe("CONFLICT");
    expect(String(errorFrame?.message)).toContain("has no providerId/model configured");
    expect(streamTextMock).not.toHaveBeenCalled();
    // Clean-state contract: the guard fired before any event was appended.
    expect(listSessionEvents(db, sessionId)).toHaveLength(0);
  });
});

/* ── The context meter route ──────────────────────────────────────────────── */

describe("R92-B: GET /sessions/:id/context on a NULL agent", () => {
  it("(e) ?providerId=&model= satisfy the gate — the report meters the override's pair", async () => {
    upsertModel(db, GW_ID, { modelId: GW_MODEL, contextWindow: 222_222 });
    const { sessionId } = makeResetAgentSession();

    // Without the params: the pinned 409 (context-report.test.ts's contract).
    const bare = await authInject({ method: "GET", url: `/api/v1/sessions/${sessionId}/context` });
    expect(bare.statusCode).toBe(409);
    expect(bare.json().error.message).toContain("has no providerId/model configured");

    // With the composer's live pair: 200, metered on the override's rows.
    const response = await authInject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/context?model=${encodeURIComponent(GW_MODEL)}&providerId=${GW_ID}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().providerId).toBe(GW_ID);
    expect(response.json().model).toBe(GW_MODEL);
    expect(response.json().contextWindow).toBe(222_222);
  });
});

/* ── The compact route ────────────────────────────────────────────────────── */

describe("R92-B: POST /sessions/:id/compact on a NULL agent (the ?providerId/?model params)", () => {
  /** An over-budget history: 12 messages ≈ 6K tokens against a 12K window
   * (1K output reserve + the 8K margin → 3K available — the r83 fixture's
   * arithmetic). */
  function overBudgetSession(): { sessionId: string; agentId: string } {
    const { sessionId, agentId } = makeResetAgentSession();
    for (let i = 0; i < 12; i += 1) {
      appendSessionEvent(db, sessionId, {
        type: i % 2 === 0 ? "message.user" : "message.assistant",
        agentId,
        payload: {
          role: i % 2 === 0 ? "user" : "assistant",
          content: `message ${i} — ${"context ".repeat(200)}`,
        },
      });
    }
    return { sessionId, agentId };
  }

  it("(f) the query pair satisfies the gate — the compaction call runs on the EFFECTIVE provider + model", async () => {
    upsertModel(db, GW_ID, { modelId: GW_MODEL, contextWindow: 12_000, maxOutputTokens: 1_000 });
    const { sessionId } = overBudgetSession();

    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/compact?providerId=${GW_ID}&model=${encodeURIComponent(GW_MODEL)}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().compacted).toBe(true);
    // THE pin: the summarizer ran with the override's pair (the spy serves
    // the buildServer-injected chat the compaction path rides).
    expect(spy.seen).toEqual([{ providerId: GW_ID, model: GW_MODEL }]);
    // The compaction is durable (the context.compact event on the log).
    expect(findLatestCompaction(listSessionEvents(db, sessionId))).not.toBeNull();
  });

  it("no params → the pinned 409 (the r83 suite's contract, message unchanged)", async () => {
    const { sessionId } = makeResetAgentSession();
    const response = await authInject({ method: "POST", url: `/api/v1/sessions/${sessionId}/compact` });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain("no providerId/model");
  });

  it("an UNKNOWN providerId on the query is refused honestly (never a 500)", async () => {
    const { sessionId } = makeResetAgentSession();
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/compact?providerId=prv_never-heard-of&model=${encodeURIComponent(GW_MODEL)}`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain("prv_never-heard-of");
  });
});

/* ── R92-C: the PATCH /agents/:id explicit-null semantics ─────────────────── */

describe("R92-C: PATCH /agents/:id — null clears, absent keeps", () => {
  it("an explicit {providerId: null, model: null} PATCH clears the columns (the dialog's round-trip)", async () => {
    const agent = createAgent(db, {
      name: "Clearable",
      providerId: "openrouter",
      model: "test/model-1",
    });
    const response = await authInject({
      method: "PATCH",
      url: `/api/v1/agents/${agent.id}`,
      payload: { providerId: null, model: null },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().providerId).toBeNull();
    expect(response.json().model).toBeNull();
    // Durable (the row, not just the reply).
    const row = getAgent(db, agent.id);
    expect(row?.providerId).toBeNull();
    expect(row?.model).toBeNull();
  });

  it("absent fields keep the row — an empty PATCH is still a no-op beyond the version bump", async () => {
    const agent = createAgent(db, {
      name: "Stable",
      providerId: "openrouter",
      model: "test/model-1",
    });
    const response = await authInject({
      method: "PATCH",
      url: `/api/v1/agents/${agent.id}`,
      payload: { name: "Stable 2" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: "Stable 2",
      providerId: "openrouter",
      model: "test/model-1",
    });
    // The storage-layer merge agrees (the route is a thin shell over it).
    const merged = updateAgent(db, agent.id, {});
    expect(merged?.providerId).toBe("openrouter");
  });
});
