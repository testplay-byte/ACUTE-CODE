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
import { runSingleAgentTurn, runStreamedAgentTurn } from "../src/agents/runtime";
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

/* ── R131-T (Wave T): the successful multi-step turn's TWO truths ───────────
 *
 * The REAL streamAiSdkChat rides as the turn's chatStream (only the AI SDK's
 * streamText is mocked — this file's idiom), so the whole chain runs as
 * shipped: 3 SDK-internal steps → the finish frame's dual numbers → the
 * runtime's stats carrier + billing accumulation → the usage_events row.
 * The owner's 900K complaint dies HERE: the carrier (what the context meter
 * + the compaction gate anchor on) carries the LAST step's input, while the
 * usage row (billing) keeps the call's cumulative spend.
 */
describe("R131-T (Wave T): a 3-step streamed turn — the carrier carries the LAST step, the usage row keeps the SUM", () => {
  it("usage_events keeps the 600_600 cumulative spend while the persisted carrier carries the 200_400 newest request", async () => {
    const sessionId = await createAgentAndSession();
    // The owner's shape, compressed: a ~200K-context session where the SDK's
    // internal tool loop ran 3 provider requests (each RE-SENDS the whole
    // history — the inputs climb 200_000 → 200_200 → 200_400). The mocked
    // totalUsage is the SDK's own aggregation of the same 3 steps.
    streamTextMock.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "Reading the project files." };
        yield {
          type: "finish-step",
          usage: { inputTokens: 200_000, outputTokens: 900, inputTokenDetails: { cacheReadTokens: 120_000 } },
        };
        yield { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "a.txt" } };
        yield { type: "tool-result", toolCallId: "c1", toolName: "read_file", input: { path: "a.txt" }, output: { ok: true } };
        yield {
          type: "finish-step",
          usage: { inputTokens: 200_200, outputTokens: 1_100, inputTokenDetails: { cacheReadTokens: 130_000 } },
        };
        yield { type: "text-delta", text: " All done — the summary." };
        yield {
          type: "finish-step",
          usage: { inputTokens: 200_400, outputTokens: 1_500, inputTokenDetails: { cacheReadTokens: 150_000 } },
        };
      })(),
      totalUsage: Promise.resolve({
        inputTokens: 600_600,
        outputTokens: 3_500,
        totalTokens: 604_100,
        inputTokenDetails: { cacheReadTokens: 400_000 },
      }),
      usage: Promise.resolve({
        inputTokens: 600_600,
        outputTokens: 3_500,
        totalTokens: 604_100,
        inputTokenDetails: { cacheReadTokens: 400_000 },
      }),
    }));

    const outcome = await runStreamedAgentTurn(
      {
        db,
        keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
        chat: streamAiSdkChat as unknown as Parameters<typeof runStreamedAgentTurn>[0]["chat"],
        chatStream: streamAiSdkChat,
      },
      sessionId,
      "read a.txt and summarize",
      () => undefined,
    );

    expect(outcome.ok).toBe(true);
    // THE BILLING TRUTH: the returned turn usage + the usage_events row keep
    // the call's cumulative spend — the spend was REAL, only its old
    // double-duty as "context at last request" was the defect.
    if (outcome.ok) {
      expect(outcome.usage.inputTokens).toBe(600_600);
      expect(outcome.usage.outputTokens).toBe(3_500);
      expect(outcome.usage.cachedInputTokens).toBe(400_000);
    }
    const usageRows = db
      .prepare("SELECT input_tokens, output_tokens, cached_input_tokens FROM usage_events WHERE session_id = ?")
      .all(sessionId) as Array<{ input_tokens: number; output_tokens: number; cached_input_tokens: number }>;
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]?.input_tokens).toBe(600_600);
    expect(usageRows[0]?.output_tokens).toBe(3_500);
    expect(usageRows[0]?.cached_input_tokens).toBe(400_000);

    // THE CONTEXT TRUTH: the persisted stats carrier (the newest
    // message.assistant with usage — what the context meter's `actual` block
    // + providerUsageAnchor read) carries the LAST step's own numbers, the
    // 200K story — never the 600_600 sum. The cached tier is the LAST
    // step's own too (the newest request's cache line, not the 400_000 sum).
    const carriers = listSessionEvents(db, sessionId)
      .filter((e) => e.type === "message.assistant")
      .map(
        (e) =>
          (e.payload as { usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } })
            .usage,
      )
      .filter((u): u is { inputTokens: number; outputTokens: number; cachedInputTokens?: number } => u !== undefined);
    expect(carriers).toHaveLength(1);
    expect(carriers[0]).toEqual({ inputTokens: 200_400, outputTokens: 1_500, cachedInputTokens: 150_000 });
  });
});

/* ── R131-T (Wave T): the SYNC twin's runtime seam ───────────────────────────
 *
 * The streamed pin above proves the whole shipped chain for the live chat.
 * This block pins the sync twin's read of the SAME law (runtime.ts
 * runSingleAgentTurn): a multi-step generateText call reports BOTH numbers
 * (usage = the aggregated SUM — billing; contextUsage = the LAST step's own
 * numbers — the context truth), and the runtime's stats carrier persists
 * the CONTEXT truth while totalInputTokens → the usage_events row keeps the
 * SUM. The chat stub stands in for aiSdkChat's pinned contextUsage output
 * (chat-format.test.ts's R131-T sync block) — the seam under test is the
 * RUNTIME's read, not the adapter's computation.
 */
describe("R131-T (Wave T): runSingleAgentTurn — the sync carrier carries the LAST step, the usage row keeps the SUM", () => {
  it("a multi-step-shaped result: the persisted carrier reads contextUsage; the usage row + outcome keep usage (billing)", async () => {
    const sessionId = await createAgentAndSession();
    // The shape aiSdkChat returns for a 2-step tool call (chat-format's
    // R131-T sync pin): usage = the aggregated 40_200 (billing),
    // contextUsage = the LAST step's own 20_200 (context).
    const chat: Parameters<typeof runSingleAgentTurn>[0]["chat"] = async () => ({
      text: "did the work",
      usage: { inputTokens: 40_200, outputTokens: 2_000, totalTokens: 42_200 },
      contextUsage: { inputTokens: 20_200, outputTokens: 1_000 },
      toolCalls: [],
    });
    const outcome = await runSingleAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat },
      sessionId,
      "read a.txt and summarize",
    );
    expect(outcome.ok).toBe(true);
    // BILLING: the returned usage + the usage_events row keep the SUM.
    if (outcome.ok) {
      expect(outcome.usage.inputTokens).toBe(40_200);
      expect(outcome.usage.outputTokens).toBe(2_000);
    }
    const usageRows = db
      .prepare("SELECT input_tokens, output_tokens FROM usage_events WHERE session_id = ?")
      .all(sessionId) as Array<{ input_tokens: number; output_tokens: number }>;
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]?.input_tokens).toBe(40_200);
    expect(usageRows[0]?.output_tokens).toBe(2_000);
    // CONTEXT: the persisted carrier (the number providerUsageAnchor + the
    // meter's `actual` read) carries the LAST step's own numbers.
    const carrier = listSessionEvents(db, sessionId)
      .filter((e) => e.type === "message.assistant")
      .map((e) => (e.payload as { usage?: { inputTokens?: number; outputTokens?: number } }).usage)
      .find((u) => u !== undefined);
    expect(carrier).toEqual({ inputTokens: 20_200, outputTokens: 1_000 });
  });

  it("SINGLE-step sync turns (contextUsage absent — the settled path): the carrier reads usage byte-identically", async () => {
    const sessionId = await createAgentAndSession();
    const chat: Parameters<typeof runSingleAgentTurn>[0]["chat"] = async () => ({
      text: "ok",
      usage: { inputTokens: 12_000, outputTokens: 300, totalTokens: 12_300 },
      toolCalls: [],
    });
    const outcome = await runSingleAgentTurn(
      { db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }), chat },
      sessionId,
      "hello",
    );
    expect(outcome.ok).toBe(true);
    const carrier = listSessionEvents(db, sessionId)
      .filter((e) => e.type === "message.assistant")
      .map((e) => (e.payload as { usage?: { inputTokens?: number; outputTokens?: number } }).usage)
      .find((u) => u !== undefined);
    expect(carrier).toEqual({ inputTokens: 12_000, outputTokens: 300 });
    const usageRows = db
      .prepare("SELECT input_tokens FROM usage_events WHERE session_id = ?")
      .all(sessionId) as Array<{ input_tokens: number }>;
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]?.input_tokens).toBe(12_000);
  });
});
