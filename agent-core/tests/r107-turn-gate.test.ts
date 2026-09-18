// @vitest-environment node
//
// R107-b (F1): the CONCURRENT-TURN GATE — the P0 fix.
//
// The R107-b review's finding: with THREE consumers on one session (the
// desktop GUI, the CLI, the Android companion — all riding POST
// /sessions/:id/messages/stream, plus the sync POST /sessions/:id/messages),
// a second send while one turn streamed STARTED A PARALLEL TURN:
//   · registerTurn REPLACED the live entry, so the FIRST turn's
//     AbortController was dropped — POST /stop could never reach it;
//   · both turns interleaved writes into ONE event log;
//   · prepareTurn only refused TERMINAL statuses, so a `running` session
//     happily accepted the second send (the old "the runtime refuses
//     concurrent turns anyway" comment was false in the code).
//
// The fix gates BOTH send routes on the shared turn registry BEFORE
// registerTurn: a live controller → 409 CONFLICT with the honest queue
// pointer (POST /sessions/:id/queue is the designed mid-turn path). The
// stream route's own queue-continuation loop is unaffected (one registration
// spans the whole loop — the gate only fires on NEW route entries). The sync
// route also REGISTERS its turn now, so its gate catches sync-vs-sync and a
// Stop aimed at a sync turn actually aborts it.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

const streamTextMock = vi.hoisted(() => vi.fn());
const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  generateText: generateTextMock,
  streamText: streamTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
  jsonSchema: <T>(schema: T) => schema,
}));
const createOpenAICompatibleMock = vi.hoisted(() =>
  vi.fn((_row: { name: string; baseURL: string }) => ({
    chatModel: (model: string) => ({ kind: "openai-compatible", model }),
  })),
);
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}));

import { getTurnController, liveTurnIds } from "../src/lib/turn-registry";
import { listSessionEvents, listUndeliveredQueuedMessages } from "../src/storage/sessions";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r107gate";
const KEY = "sk-or-vtest-r107g";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r107gate-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }) });
  streamTextMock.mockReset();
  generateTextMock.mockReset();
  createOpenAICompatibleMock.mockClear();
});

afterEach(async () => {
  await app.close();
  db.close();
  // No live turn may leak across tests (the finally-unregister contract).
  expect(liveTurnIds()).toEqual([]);
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

async function authInject(options: {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

/** A session + agent through the real routes (the r78 pattern). */
async function makeSessionViaApi(): Promise<string> {
  const agentRes = await authInject({
    method: "POST",
    url: "/api/v1/agents",
    payload: { name: "R107 Gate Agent", systemPrompt: "You are terse.", providerId: "openrouter", model: "test/r107-1" },
  });
  expect(agentRes.statusCode).toBe(201);
  const sessionRes = await authInject({
    method: "POST",
    url: "/api/v1/sessions",
    payload: { agentId: (agentRes.json() as { id: string }).id, mode: "single" },
  });
  expect(sessionRes.statusCode).toBe(202);
  return (sessionRes.json() as { id: string }).id;
}

/** Poll until a live turn registers for the session (the send routes
 * register before the first provider call resolves). */
async function waitForRegistration(sessionId: string, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (getTurnController(sessionId) !== undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(getTurnController(sessionId), what).toBeDefined();
}

/** Parse a hijacked SSE body into its data frames (the r58/r78 helper). */
function parseSse(body: string): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  for (const block of body.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
    }
  }
  return frames;
}

const USAGE = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };

/** A streamText result whose fullStream BLOCKS on a gate, then completes
 * with healthy parts (text-delta + finish-step). */
function gatedStream(gate: Promise<void>) {
  return {
    fullStream: (async function* () {
      await gate;
      yield { type: "text-delta", text: "First turn completed." };
      yield { type: "finish-step", usage: { inputTokens: 5, outputTokens: 5 } };
    })(),
    totalUsage: Promise.resolve(USAGE),
    usage: Promise.resolve(USAGE),
  };
}

describe("R107-b (F1): the streamed route's concurrent-turn gate", () => {
  it("a SECOND stream send while one turn is live → 409 CONFLICT with the queue pointer — one turn, one registration, no interleaved writes", async () => {
    const sessionId = await makeSessionViaApi();
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    streamTextMock.mockImplementation(() => gatedStream(firstGate));

    const firstPromise = authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "the first, slow turn" },
    });
    await waitForRegistration(sessionId, "the first send registers its turn");

    // The second send (the CLI / mobile racing the desktop GUI): 409, not a
    // parallel turn. Pre-gate this REPLACED the live registration and both
    // turns interleaved writes into the one event log.
    const second = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "the racing second turn" },
    });
    expect(second.statusCode).toBe(409);
    const body = second.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toContain("a turn is already in flight");
    expect(body.error.message).toContain(`/queue`);
    // A plain (non-SSE) 409 body — the second stream never started.
    expect(String(second.body)).not.toContain("data: ");

    // Exactly ONE turn ever called the provider (the gate refused the second
    // BEFORE any work), and the event log carries exactly ONE user message.
    expect(streamTextMock).toHaveBeenCalledTimes(1);
    expect(listSessionEvents(db, sessionId).filter((e) => e.type === "message.user")).toHaveLength(1);

    // The first turn is still registered + still stoppable (its controller
    // was NOT replaced by the refused send).
    expect(liveTurnIds()).toEqual([sessionId]);

    // The first stream completes cleanly on its own terms.
    releaseFirst();
    const first = await firstPromise;
    expect(first.statusCode).toBe(200);
    const frames = parseSse(first.body as string);
    expect(frames.filter((f) => f.type === "done")).toHaveLength(1);
    expect(frames[frames.length - 1]?.type).toBe("done");
  });

  it("the queue route still works MID-TURN (the designed path the 409 points at) — 200 + the user.queued frame on the live stream", async () => {
    const sessionId = await makeSessionViaApi();
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    streamTextMock.mockImplementation(() => gatedStream(firstGate));

    const firstPromise = authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "keep working" },
    });
    await waitForRegistration(sessionId, "the live turn registers");

    // The queue POST the 409 points at: 200 {ok, seq} (the R78 contract —
    // this is the mid-turn path, and the gate must not have broken it).
    const queued = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/queue`,
      payload: { content: "and then summarize it" },
    });
    expect(queued.statusCode).toBe(200);
    expect((queued.json() as { ok: boolean }).ok).toBe(true);
    expect(typeof (queued.json() as { seq: number }).seq).toBe("number");

    // The FIRST turn completes (its own content — the queued message stays
    // queued for the turn-end continuation, exactly the R78 shape).
    releaseFirst();
    const first = await firstPromise;
    expect(first.statusCode).toBe(200);
    const frames = parseSse(first.body as string);
    // The live chip frame rode the still-open stream via notifyTurn.
    expect(frames.some((f) => f.type === "user.queued")).toBe(true);
    // The continuation consumed the queued message as the second turn.
    expect(frames.some((f) => f.type === "meta.queue_continue")).toBe(true);
    expect(listUndeliveredQueuedMessages(db, sessionId)).toHaveLength(0);
  });

  it("the stream route's OWN queue-continuation is unaffected by the gate (one registration spans the whole loop — the gate only fires on NEW route entries)", async () => {
    const sessionId = await makeSessionViaApi();
    // The queue append lands while turn 1 streams (the R78 fixture shape);
    // the continuation then runs ANOTHER full turn on the SAME stream — the
    // gate must not fire for it (it is the route's internal loop, not a new
    // POST).
    let calls = 0;
    streamTextMock.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        // Queue the follow-up DURING the first turn — the same wire path
        // the queue POST takes, driven from inside the stream.
        return {
          fullStream: (async function* () {
            await authInject({
              method: "POST",
              url: `/api/v1/sessions/${sessionId}/queue`,
              payload: { content: "the follow-up" },
            });
            yield { type: "text-delta", text: "Task completed." };
            yield { type: "finish-step", usage: { inputTokens: 5, outputTokens: 5 } };
          })(),
          totalUsage: Promise.resolve(USAGE),
          usage: Promise.resolve(USAGE),
        };
      }
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", text: "Follow-up handled." };
          yield { type: "finish-step", usage: { inputTokens: 5, outputTokens: 5 } };
        })(),
        totalUsage: Promise.resolve(USAGE),
        usage: Promise.resolve(USAGE),
      };
    });

    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "start" },
    });
    expect(response.statusCode).toBe(200);
    const frames = parseSse(response.body as string);
    // TWO turns ran on one stream — the continuation survived the gate.
    expect(streamTextMock).toHaveBeenCalledTimes(2);
    expect(frames.filter((f) => f.type === "meta.queue_continue")).toHaveLength(1);
    expect(frames[frames.length - 1]?.type).toBe("done");
  });
});

describe("R107-b (F1): the sync route's gate + registration", () => {
  it("a SECOND sync send while a sync turn is live → 409; a STREAM send while a sync turn is live → 409 (both routes share one live-turn truth)", async () => {
    const sessionId = await makeSessionViaApi();
    let releaseSync: () => void = () => {};
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    generateTextMock.mockImplementation(() => syncGate.then(() => ({
      text: "sync reply",
      usage: USAGE,
      steps: [],
    })));

    const firstPromise = authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      payload: { content: "the slow sync turn" },
    });
    // The sync route REGISTERS its turn now (pre-R107 it was invisible to
    // the registry — ungate-able AND unstoppable).
    await waitForRegistration(sessionId, "the sync route registers its turn");

    // sync-vs-sync: 409.
    const secondSync = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      payload: { content: "racing sync send" },
    });
    expect(secondSync.statusCode).toBe(409);
    expect((secondSync.json() as { error: { code: string } }).error.code).toBe("CONFLICT");
    expect((secondSync.json() as { error: { message: string } }).error.message).toContain("/queue");

    // stream-vs-sync: 409 too (the cross-route gate).
    const streamSend = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "racing stream send" },
    });
    expect(streamSend.statusCode).toBe(409);
    expect((streamSend.json() as { error: { code: string } }).error.code).toBe("CONFLICT");

    // Exactly ONE provider call, ONE user event — no parallel turn started.
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(listSessionEvents(db, sessionId).filter((e) => e.type === "message.user")).toHaveLength(1);

    releaseSync();
    const first = await firstPromise;
    expect(first.statusCode).toBe(200);
    expect((first.json() as { assistantMessage: { content: string } }).assistantMessage.content).toBe("sync reply");
  });

  it("a STREAM turn in flight blocks the SYNC route too (the gate is symmetric)", async () => {
    const sessionId = await makeSessionViaApi();
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    streamTextMock.mockImplementation(() => gatedStream(firstGate));

    const streamPromise = authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "the streamed turn" },
    });
    await waitForRegistration(sessionId, "the streamed turn registers");

    const syncSend = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      payload: { content: "racing sync send" },
    });
    expect(syncSend.statusCode).toBe(409);
    expect((syncSend.json() as { error: { code: string } }).error.code).toBe("CONFLICT");
    expect(generateTextMock).not.toHaveBeenCalled();

    releaseFirst();
    const stream = await streamPromise;
    expect(stream.statusCode).toBe(200);
    expect(parseSse(stream.body as string).some((f) => f.type === "done")).toBe(true);
  });

  it("POST /stop now reaches a live SYNC turn (the registration the route never had): stopped:true + the honest 499 ABORTED + NO turn.error (a stop is not an error)", async () => {
    const sessionId = await makeSessionViaApi();
    // The SDK-shaped in-flight call: it rejects the moment its abortSignal
    // fires (what the real generateText does when the combined signal trips).
    generateTextMock.mockImplementation(
      (call: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          call.abortSignal?.addEventListener("abort", () => reject(new Error("aborted by test")), { once: true });
        }),
    );

    const firstPromise = authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages`,
      payload: { content: "stop me mid-call" },
    });
    await waitForRegistration(sessionId, "the sync turn registers");

    // The Stop button's server-side half. Pre-R107 this returned
    // {stopped:false} for a sync turn — no registration existed.
    const stop = await authInject({ method: "POST", url: `/api/v1/sessions/${sessionId}/stop` });
    expect(stop.statusCode).toBe(200);
    expect(stop.json()).toEqual({ ok: true, stopped: true });

    const first = await firstPromise;
    // The honest ABORTED outcome (the R48-e1 semantics the streamed route
    // always had): 499, code ABORTED — and no turn.error event (R42/R43
    // rule: a deliberate stop is not an error).
    expect(first.statusCode).toBe(499);
    const body = first.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ABORTED");
    expect(body.error.message).toContain("aborted");
    expect(listSessionEvents(db, sessionId).some((e) => e.type === "turn.error")).toBe(false);
    // The registry entry is gone (the route's finally).
    expect(liveTurnIds()).toEqual([]);
  });
});
