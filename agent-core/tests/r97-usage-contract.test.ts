/**
 * ROUND-97 (R97-J, M2) — the failure-usage contract's RUNTIME half.
 *
 * The R97-E adapter pins (r97-error-usage.test.ts) prove the partial usage
 * rides the THROWN error out of streamAiSdkChat. These pins prove the RUNTIME
 * composes it onto the surfaces the owner actually reads:
 *   · the persisted turn.error payload — the FOLDED card after a reload;
 *   · the returned outcome.details — the SSE error frame spreads it verbatim
 *     (routes/sse.ts builds the frame's details from `outcome.details ?? {}`,
 *     so pinning the outcome pins the frame).
 *
 * End-to-end shape: the REAL streamAiSdkChat rides as the turn's chatStream;
 * only the AI SDK's streamText is mocked (the r97-error-usage idiom), so the
 * whole path — SDK parts → adapter symbol → runtime composition → the
 * persisted payload + the returned details — runs as shipped.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const streamTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: vi.fn(),
  streamText: streamTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
}));
// The r97-error-usage idiom: the provider constructors are mocked so no
// network path can exist (buildModel resolves through them).
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(() => ({
    chatModel: (model: string) => ({ kind: "openai-compatible", model }),
  })),
}));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: vi.fn() }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: vi.fn() }));

import { streamAiSdkChat } from "../src/agents/chat";
import { runStreamedAgentTurn } from "../src/agents/runtime";
import { listSessionEvents } from "../src/storage/sessions";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r97u";
const KEY = "sk-or-vtest-r97u";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r97u-"));
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
    // Best-effort: Windows sometimes holds file handles briefly after close.
  }
});

async function authInject(options: {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<{ statusCode: number; json: () => unknown }> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as { statusCode: number; json: () => unknown };
}

async function createAgentAndSession(): Promise<string> {
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

function mockStream(parts: Array<Record<string, unknown>>): void {
  streamTextMock.mockImplementation(() => ({
    fullStream: (async function* () {
      for (const part of parts) yield part;
    })(),
    totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
  }));
}

describe("R97-E + R97-J (M2): a failed streamed turn reports its real spend end-to-end", () => {
  it("the persisted turn.error payload AND the returned outcome.details carry the usage the stream actually spent", async () => {
    const sessionId = await createAgentAndSession();
    // A mid-stream death AFTER a usage-bearing finish-step, with a NON-
    // transient class — the error object carries statusCode 401 (the
    // classifier's status-only auth rule: a plain text-only "401" reads
    // unknown and would arm the R94-D1 progress retry; auth fails FAST —
    // single key in the pool, no juggling, no ladder, ONE call).
    mockStream([
      { type: "text-delta", text: "working on it" },
      {
        type: "finish-step",
        usage: { inputTokens: 1_500, outputTokens: 120, inputTokenDetails: { cacheReadTokens: 0 } },
      },
      { type: "text-delta", text: "still going" },
      { type: "error", error: Object.assign(new Error("Unauthorized"), { statusCode: 401 }) },
    ]);

    const outcome = await runStreamedAgentTurn(
      {
        db,
        keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
        chat: streamAiSdkChat as unknown as Parameters<typeof runStreamedAgentTurn>[0]["chat"],
        chatStream: streamAiSdkChat,
      },
      sessionId,
      "please summarize the README",
      () => undefined,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;

    // The outcome's details are EXACTLY what the SSE error frame spreads
    // (routes/sse.ts: `details: { ...(outcome.details ?? {}) }`) — the LIVE
    // card's "Tokens sent ↑ / received ↓" line reads it.
    expect(outcome.details?.usage).toEqual({ inputTokens: 1_500, outputTokens: 120 });

    // The persisted turn.error payload — the FOLDED card after a reload —
    // carries the same numbers. (The partial text flushes as a
    // message.assistant BETWEEN the user message and the error — the R58-c
    // precedent — so the error event is FOUND, never positionally indexed.)
    const events = listSessionEvents(db, sessionId);
    expect(events.map((e) => e.type)).toEqual(["message.user", "message.assistant", "turn.error"]);
    const error = events.find((e) => e.type === "turn.error")!.payload as Record<string, unknown>;
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.usage).toEqual({ inputTokens: 1_500, outputTokens: 120 });
  });

  it("a failure that spent NOTHING carries no usage on either surface (never fabricated zeros)", async () => {
    const sessionId = await createAgentAndSession();
    mockStream([
      { type: "text-delta", text: "starting" },
      { type: "error", error: Object.assign(new Error("Unauthorized"), { statusCode: 401 }) },
    ]);

    const outcome = await runStreamedAgentTurn(
      {
        db,
        keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
        chat: streamAiSdkChat as unknown as Parameters<typeof runStreamedAgentTurn>[0]["chat"],
        chatStream: streamAiSdkChat,
      },
      sessionId,
      "please summarize the README",
      () => undefined,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // No fabricated 0/0 — the card renders no token line at all.
    expect(outcome.details?.usage).toBeUndefined();
    const events = listSessionEvents(db, sessionId);
    const error = events.find((e) => e.type === "turn.error")!.payload as Record<string, unknown>;
    expect(error.usage).toBeUndefined();
  });

  it("R97-J (m7): the LADDER's earlier attempts keep their burn — later attempts report the FULL spend", async () => {
    const sessionId = await createAgentAndSession();
    // Attempt 1: rate_limit AFTER streaming 1,200/80 (a real burn) → the
    // ladder retries. Attempts 2..6: the same class dies instantly → the
    // sixth failure is the honest terminal persist (the R75 schedule).
    let attempt = 0;
    streamTextMock.mockImplementation(() => {
      attempt += 1;
      const parts: Array<Record<string, unknown>> =
        attempt === 1
          ? [
              { type: "text-delta", text: "burning tokens" },
              {
                type: "finish-step",
                usage: { inputTokens: 1_200, outputTokens: 80, inputTokenDetails: { cacheReadTokens: 0 } },
              },
              { type: "error", error: Object.assign(new Error("Too Many Requests"), { statusCode: 429 }) },
            ]
          : [{ type: "error", error: Object.assign(new Error("Too Many Requests"), { statusCode: 429 }) }];
      return {
        fullStream: (async function* () {
          for (const part of parts) yield part;
        })(),
        totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
        usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      };
    });

    // The R75 schedule — [immediate, 1.5m, 5m, 10m, 30m] — six attempts in
    // total; advance the fake clock through every rung (the r43 idiom).
    vi.useFakeTimers();
    let outcome: Awaited<ReturnType<typeof runStreamedAgentTurn>>;
    try {
      const turnPromise = runStreamedAgentTurn(
        {
          db,
          keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
          chat: streamAiSdkChat as unknown as Parameters<typeof runStreamedAgentTurn>[0]["chat"],
          chatStream: streamAiSdkChat,
        },
        sessionId,
        "please summarize the README",
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(90_000 + 300_000 + 600_000 + 1_800_000 + 5_000);
      outcome = await turnPromise;
    } finally {
      vi.useRealTimers();
    }

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.details?.attempts).toBe(6);
    // Attempt 1's 1,200/80 SURVIVES the five instant deaths — the pre-m7
    // path read only the last error's symbol and reported nothing.
    expect(outcome.details?.usage).toEqual({ inputTokens: 1_200, outputTokens: 80 });
    const events = listSessionEvents(db, sessionId);
    const error = events.find((e) => e.type === "turn.error")!.payload as Record<string, unknown>;
    expect(error.usage).toEqual({ inputTokens: 1_200, outputTokens: 80 });
  });
});
