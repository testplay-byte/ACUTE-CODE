/**
 * ROUND-78 (R78) regression tests — the MESSAGE QUEUE (the owner's
 * "工作中发送消息（排队）" ask: while the agent is responding/running tools
 * the user can still send; the message QUEUES and is auto-delivered right
 * after the current tool call completes; the agent reads it with full
 * context and continues — never interrupting the in-flight flow).
 *
 * Coverage:
 *  · Storage lifecycle: appendQueuedMessage / listUndeliveredQueuedMessages /
 *    deliverQueuedMessage (the type FLIP — seq/ts/payload/agentId
 *    untouched) / deleteQueuedMessage (queued rows only) /
 *    deliverAllQueuedMessages (the pre-flip loop).
 *  · assembleHistory ignores `message.queued` by construction (the model
 *    never sees an undelivered message); a flipped row is an ordinary
 *    message.user.
 *  · LOOP-TOP delivery inside runStreamedAgentTurn: a message queued
 *    mid-turn (from inside the fake chatStream's first call) is delivered
 *    at the next iteration's top and the SECOND call's model-facing
 *    messages include it — plus the live queued.delivered frame.
 *  · PRE-FLIP: a lingering queued event (crash/stop leftover) delivers
 *    BEFORE the new turn's own message; no frames emitted (the folded log
 *    owns the render).
 *  · The turn-registry notify extension: registerTurn(notify) +
 *    notifyTurn — the queue route's user.queued frame bridge.
 *  · The ROUTES: POST /sessions/:id/queue (validation, 404 unknown session,
 *    409 NO_LIVE_TURN without a live turn, 200 {ok, seq} + notifyTurn with
 *    one), DELETE /sessions/:id/queue/:seq (200/404), and the streamed
 *    route's TURN-END CONTINUATION (meta.queue_continue → the same SSE
 *    stream runs the queued message as a full second turn; the first queued
 *    event is consumed, the rest ride iteration 0).
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

// The full stack runs against the real adapter with ONLY the AI SDK mocked
// at the module boundary (the r58-stop-and-replay pattern) — no network.
const streamTextMock = vi.hoisted(() => vi.fn());
const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({
  streamText: streamTextMock,
  generateText: generateTextMock,
  stepCountIs: (count: number) => ({ type: "stepCount", count }),
  jsonSchema: <T>(schema: T) => schema,
}));
// ROUND-82 (R82): the chat-completions client factory is ALSO mocked (the
// chat-format.test.ts pattern) so the LanguageModel handed to the mocked
// streamText is a plain object — the queue-continuation provider-routing
// pins below assert WHICH provider row each turn's client was built from
// (name + baseURL) instead of SDK internals.
const createOpenAICompatibleMock = vi.hoisted(() =>
  // Typed with the provider-row argument so mock.calls[0][0] is indexable
  // (the routing pins below assert WHICH row built each turn's client).
  vi.fn((_row: { name: string; baseURL: string }) => ({
    chatModel: (model: string) => ({ kind: "openai-compatible", model }),
  })),
);
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}));

import {
  assembleHistory,
  runStreamedAgentTurn,
} from "../src/agents/runtime";
import type { ChatFn, StreamChatFn, StreamChatEvent } from "../src/agents/chat";
import {
  appendQueuedMessage,
  appendSessionEvent,
  createSession,
  deliverAllQueuedMessages,
  deliverQueuedMessage,
  deleteQueuedMessage,
  listSessionEvents,
  listUndeliveredQueuedMessages,
} from "../src/storage/sessions";
import { createAgent } from "../src/storage/agents";
import { createProviderRecord } from "../src/storage/providers";
import { createProject } from "../src/storage/projects";
import { setDebugSettings, setRetrySettings } from "../src/storage/settings";
import {
  getTurnController,
  notifyTurn,
  registerTurn,
  unregisterTurn,
} from "../src/lib/turn-registry";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r78q";
const KEY = "sk-or-vtest-r78q";
// ROUND-82 (R82): a second provider + key so the queued-override tests can
// route a continuation turn somewhere OTHER than the agent's openrouter.
const GW_KEY = "sk-gw-vtest-r78q";
const GW_ID = "prv_gw";
const GW_BASE = "https://gw.example.test/v1";
const GW_MODEL = "test/gw-model";

let tempDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r78q-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  // ROUND-82: the custom provider the queued override names (the Settings
  // "Add provider" shape — a real row with a real baseUrl).
  createProviderRecord(db, { id: GW_ID, name: "Queue Gateway", baseUrl: GW_BASE });
  app = buildServer({
    token: TOKEN,
    db,
    keyring: new ProviderKeyring({
      ACUTE_PROVIDER_OPENROUTER: KEY,
      ACUTE_PROVIDER_PRV_GW: GW_KEY,
    }),
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
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  payload?: Record<string, unknown>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

/** A session with project + agent, created through the storage layer. */
function makeSession(name: string): { sessionId: string; agentId: string } {
  const project = createProject(db, { name, rootPath: join(tempDir, name) });
  const agent = createAgent(db, { name: `${name} Agent`, providerId: "openrouter", model: "test/r78-1" });
  const session = createSession(db, { agentId: agent.id, mode: "single", projectId: project.id });
  return { sessionId: session.id, agentId: agent.id };
}

async function makeSessionViaApi(): Promise<string> {
  const agentRes = await authInject({
    method: "POST",
    url: "/api/v1/agents",
    payload: { name: "Queue Agent", systemPrompt: "You are terse.", providerId: "openrouter", model: "test/r78-1" },
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

const makeKeyring = (): ProviderKeyring => new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY });

const summarizerChat: ChatFn = async () => ({
  text: "SUMMARY: prior work.",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  toolCalls: [],
});

/* ── Storage lifecycle ─────────────────────────────────────────────────────── */

describe("R78: queue storage invariants", () => {
  it("appendQueuedMessage mirrors the message.user shape (role/content/attachments + agentId/ts stamping)", () => {
    const { sessionId, agentId } = makeSession("R78-Store-Shape");
    const queued = appendQueuedMessage(db, sessionId, {
      content: "queue me please",
      attachments: [{ name: "notes.txt", text: "hello" }],
    });
    expect(queued.type).toBe("message.queued");
    expect(queued.agentId).toBe(agentId);
    const payload = queued.payload as Record<string, unknown>;
    expect(payload.role).toBe("user");
    expect(payload.content).toBe("queue me please");
    expect(Array.isArray(payload.attachments)).toBe(true);
    expect(typeof payload.ts).toBe("string");
  });

  it("list → deliver (the type FLIP) → list again: seq/ts/agentId/payload untouched, ordering by seq", () => {
    const { sessionId, agentId } = makeSession("R78-Store-Flip");
    appendSessionEvent(db, sessionId, {
      type: "message.user",
      agentId,
      payload: { role: "user", content: "the original message" },
    });
    const first = appendQueuedMessage(db, sessionId, { content: "first queued" });
    const second = appendQueuedMessage(db, sessionId, { content: "second queued" });

    // Undelivered list: queued rows only, seq order (the user message is not listed).
    const before = listUndeliveredQueuedMessages(db, sessionId);
    expect(before.map((e) => e.seq)).toEqual([first.seq, second.seq]);

    // Deliver the first: a strict type flip on the SAME row.
    expect(deliverQueuedMessage(db, sessionId, first.seq)).toBe(true);
    const events = listSessionEvents(db, sessionId);
    const flipped = events.find((e) => e.seq === first.seq)!;
    expect(flipped.type).toBe("message.user");
    expect(flipped.ts).toBe(first.ts);
    expect(flipped.agentId).toBe(first.agentId);
    expect(flipped.payload).toEqual(first.payload);

    // Idempotence guards: re-delivering, delivering a non-queued row, a
    // foreign seq — all false, nothing changes.
    expect(deliverQueuedMessage(db, sessionId, first.seq)).toBe(false);
    expect(deliverQueuedMessage(db, sessionId, first.seq - 1)).toBe(false); // the original message.user
    expect(deliverQueuedMessage(db, sessionId, 999)).toBe(false);
    expect(listUndeliveredQueuedMessages(db, sessionId).map((e) => e.seq)).toEqual([second.seq]);

    // deliverAllQueuedMessages flips the rest and reports the count.
    expect(deliverAllQueuedMessages(db, sessionId)).toBe(1);
    expect(listUndeliveredQueuedMessages(db, sessionId)).toHaveLength(0);
    expect(deliverAllQueuedMessages(db, sessionId)).toBe(0);
  });

  it("deleteQueuedMessage removes ONLY queued rows", () => {
    const { sessionId, agentId } = makeSession("R78-Store-Delete");
    const userEvent = appendSessionEvent(db, sessionId, {
      type: "message.user",
      agentId,
      payload: { role: "user", content: "stay" },
    });
    const queued = appendQueuedMessage(db, sessionId, { content: "remove me" });
    const delivered = appendQueuedMessage(db, sessionId, { content: "already delivered" });
    deliverQueuedMessage(db, sessionId, delivered.seq);

    expect(deleteQueuedMessage(db, sessionId, queued.seq)).toBe(true);
    expect(listSessionEvents(db, sessionId).some((e) => e.seq === queued.seq)).toBe(false);
    // A delivered row is transcript history — refused.
    expect(deleteQueuedMessage(db, sessionId, delivered.seq)).toBe(false);
    // Ordinary user messages — refused.
    expect(deleteQueuedMessage(db, sessionId, userEvent.seq)).toBe(false);
    expect(deleteQueuedMessage(db, sessionId, 12345)).toBe(false);
  });
});

/* ── assembleHistory ignores message.queued by construction ───────────────── */

describe("R78: assembleHistory skips undelivered queued events", () => {
  it("a queued message is invisible to the model until the flip", () => {
    const { sessionId, agentId } = makeSession("R78-History-Skip");
    appendSessionEvent(db, sessionId, {
      type: "message.user",
      agentId,
      payload: { role: "user", content: "first user message" },
    });
    const queued = appendQueuedMessage(db, sessionId, { content: "queued secret instructions" });

    const before = assembleHistory(db, sessionId);
    expect(before.map((m) => m.content)).toEqual(["first user message"]);

    deliverQueuedMessage(db, sessionId, queued.seq);
    const after = assembleHistory(db, sessionId);
    expect(after.map((m) => m.content)).toEqual(["first user message", "queued secret instructions"]);
    expect(after[1]?.role).toBe("user");
  });
});

/* ── Loop-top delivery inside runStreamedAgentTurn ────────────────────────── */

describe("R78: loop-top delivery (mid-turn queue → next iteration sees it)", () => {
  it("a message queued DURING the first chatStream call is delivered at the next iteration's top + a queued.delivered frame", async () => {
    const { sessionId } = makeSession("R78-LoopTop");
    const emitted: Array<Record<string, unknown>> = [];
    const receivedMessages: Array<Array<{ role: string; content: string }>> = [];
    let calls = 0;
    const chatStream: StreamChatFn = async function* (input): AsyncGenerator<StreamChatEvent> {
      calls += 1;
      receivedMessages.push(
        input.messages.map((m) => ({ role: m.role, content: m.content })),
      );
      if (calls === 1) {
        // The user typed while the tool was running — the queue append lands
        // mid-turn (the route's queue POST would do exactly this).
        appendQueuedMessage(db, sessionId, { content: "also check the tests" });
        yield { type: "tool-call", toolName: "write_file", argsSummary: "path: a.txt" };
        yield { type: "tool-result", toolName: "write_file", argsSummary: "path: a.txt", ok: true, outputSummary: "wrote 2 bytes" };
        yield { type: "finish", usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
      } else {
        // Iteration 2: the delivered queue message must already be in the
        // model-facing history, AFTER the tool results it follows.
        yield { type: "text-delta", delta: "Task completed. Both done." };
        yield { type: "finish", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };
      }
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring: makeKeyring(), chat: summarizerChat, chatStream },
      sessionId,
      "create a.txt",
      (event) => emitted.push(event as Record<string, unknown>),
    );

    expect(outcome.ok).toBe(true);
    expect(calls).toBe(2);
    // The SECOND call's messages include the delivered user message.
    const second = receivedMessages[1]!;
    expect(second.some((m) => m.role === "user" && m.content === "also check the tests")).toBe(true);
    // The FIRST call's messages did NOT (it was queued mid-call).
    expect(receivedMessages[0]!.some((m) => m.content === "also check the tests")).toBe(false);
    // The live frame: queued.delivered with the seq + content + ts.
    const deliveredFrames = emitted.filter((e) => e.type === "queued.delivered");
    expect(deliveredFrames).toHaveLength(1);
    expect(deliveredFrames[0]?.content).toBe("also check the tests");
    expect(typeof deliveredFrames[0]?.seq).toBe("number");
    expect(typeof deliveredFrames[0]?.ts).toBe("string");
    // Nothing stays queued; the transcript carries it as an ordinary user event.
    expect(listUndeliveredQueuedMessages(db, sessionId)).toHaveLength(0);
    expect(
      listSessionEvents(db, sessionId).some(
        (e) => e.type === "message.user" && (e.payload as Record<string, unknown>).content === "also check the tests",
      ),
    ).toBe(true);
  });

  it("delivery never spends outer-loop budget — a 2-iteration turn with a mid-turn queue still completes in 2 calls", async () => {
    // Same shape as above but asserting the iteration accounting: the queue
    // delivery is not an iteration, so the tool-iteration + the
    // conversational-iteration still fit well under maxOuterLoops (5).
    const { sessionId } = makeSession("R78-LoopTop-Budget");
    let calls = 0;
    const chatStream: StreamChatFn = async function* (): AsyncGenerator<StreamChatEvent> {
      calls += 1;
      if (calls === 1) {
        appendQueuedMessage(db, sessionId, { content: "queued while working" });
        yield { type: "tool-call", toolName: "write_file", argsSummary: "path: b.txt" };
        yield { type: "tool-result", toolName: "write_file", argsSummary: "path: b.txt", ok: true, outputSummary: "ok" };
        yield { type: "finish", usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 } };
      } else {
        yield { type: "text-delta", delta: "Task completed." };
        yield { type: "finish", usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 } };
      }
    };
    const outcome = await runStreamedAgentTurn(
      { db, keyring: makeKeyring(), chat: summarizerChat, chatStream },
      sessionId,
      "create b.txt",
      () => undefined,
    );
    expect(outcome.ok).toBe(true);
    expect(calls).toBe(2);
  });
});

/* ── Pre-flip (crash/stop recovery) ───────────────────────────────────────── */

describe("R78: pre-flip at turn start (crash/stop recovery)", () => {
  it("a lingering queued event delivers BEFORE the new turn's own message — no frames emitted", async () => {
    const { sessionId } = makeSession("R78-PreFlip");
    // Simulate the leftover: a queued message from an aborted stream.
    appendQueuedMessage(db, sessionId, { content: "leftover from the crash" });

    const emitted: Array<Record<string, unknown>> = [];
    const receivedMessages: Array<Array<{ role: string; content: string }>> = [];
    const chatStream: StreamChatFn = async function* (input): AsyncGenerator<StreamChatEvent> {
      receivedMessages.push(input.messages.map((m) => ({ role: m.role, content: m.content })));
      yield { type: "text-delta", delta: "Task completed." };
      yield { type: "finish", usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 } };
    };

    const outcome = await runStreamedAgentTurn(
      { db, keyring: makeKeyring(), chat: summarizerChat, chatStream },
      sessionId,
      "new message after restart",
      (event) => emitted.push(event as Record<string, unknown>),
    );

    expect(outcome.ok).toBe(true);
    const first = receivedMessages[0]!;
    // The leftover is IN the model-facing history, BEFORE the new message.
    const leftoverIndex = first.findIndex((m) => m.content === "leftover from the crash");
    const newMessageIndex = first.findIndex((m) => m.content === "new message after restart");
    expect(leftoverIndex).toBeGreaterThan(-1);
    expect(newMessageIndex).toBeGreaterThan(leftoverIndex);
    // The folded log owns the render — no queued.delivered frames for the pre-flip.
    expect(emitted.filter((e) => e.type === "queued.delivered")).toHaveLength(0);
    // Nothing stays queued.
    expect(listUndeliveredQueuedMessages(db, sessionId)).toHaveLength(0);
  });
});

/* ── The turn-registry notify extension ───────────────────────────────────── */

describe("R78: notifyTurn (the registry's notify bridge)", () => {
  it("registerTurn with notify → notifyTurn delivers the event and reports true", () => {
    const received: unknown[] = [];
    const controller = new AbortController();
    registerTurn("sess-r78-notify", controller, (event) => received.push(event));
    try {
      expect(getTurnController("sess-r78-notify")).toBe(controller);
      const frame = { type: "user.queued", seq: 4, content: "hi", ts: "now" };
      expect(notifyTurn("sess-r78-notify", frame)).toBe(true);
      expect(received).toEqual([frame]);
      // No live entry for an unknown session → false.
      expect(notifyTurn("sess-r78-unknown", { type: "user.queued" })).toBe(false);
    } finally {
      unregisterTurn("sess-r78-notify", controller);
    }
    expect(notifyTurn("sess-r78-notify", { type: "user.queued" })).toBe(false);
  });

  it("a notifier that THROWS never bubbles into the caller (a dead socket ≠ a failed queue POST)", () => {
    const controller = new AbortController();
    registerTurn("sess-r78-throw", controller, () => {
      throw new Error("socket gone");
    });
    try {
      expect(notifyTurn("sess-r78-throw", { type: "user.queued" })).toBe(false);
    } finally {
      unregisterTurn("sess-r78-throw", controller);
    }
  });

  it("registerTurn without notify (children / legacy callers) stays backward-compatible", () => {
    const controller = new AbortController();
    registerTurn("sess-r78-legacy", controller);
    try {
      expect(notifyTurn("sess-r78-legacy", { type: "user.queued" })).toBe(false);
    } finally {
      unregisterTurn("sess-r78-legacy", controller);
    }
  });
});

/* ── The queue routes ─────────────────────────────────────────────────────── */

describe("R78: POST /sessions/:id/queue + DELETE /sessions/:id/queue/:seq", () => {
  it("NO live turn → 409 NO_LIVE_TURN (the panel falls back to a normal send)", async () => {
    const sessionId = await makeSessionViaApi();
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/queue`,
      payload: { content: "queue me" },
    });
    expect(response.statusCode).toBe(409);
    const error = response.json().error as { code: string; message: string };
    expect(error.code).toBe("NO_LIVE_TURN");
    expect(error.message).toContain("send the message normally");
    // Nothing was appended.
    expect(listSessionEvents(db, sessionId).some((e) => e.type === "message.queued")).toBe(false);
  });

  it("validation mirrors the send routes: empty content → 400; unknown session → 404; bad attachments → 400", async () => {
    const sessionId = await makeSessionViaApi();
    const empty = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/queue`,
      payload: { content: "   " },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.details.field).toBe("body.content");

    const unknown = await authInject({
      method: "POST",
      url: "/api/v1/sessions/sess_does_not_exist/queue",
      payload: { content: "hi" },
    });
    expect(unknown.statusCode).toBe(404);

    const badAttachments = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/queue`,
      payload: { content: "hi", attachments: "nope" },
    });
    expect(badAttachments.statusCode).toBe(400);
    expect(String(badAttachments.json().error.details.field)).toContain("body.attachments");
  });

  it("with a live registered turn → 200 {ok, seq}, the event lands, notifyTurn fires the user.queued frame", async () => {
    const sessionId = await makeSessionViaApi();
    const frames: unknown[] = [];
    const controller = new AbortController();
    registerTurn(sessionId, controller, (event) => frames.push(event));
    try {
      const response = await authInject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/queue`,
        payload: {
          content: "queued while you work",
          attachments: [{ name: "extra.txt", text: "data" }],
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { ok: boolean; seq: number };
      expect(body.ok).toBe(true);
      // The event: message.queued with the validated attachments persisted.
      const events = listSessionEvents(db, sessionId);
      const queued = events.find((e) => e.seq === body.seq)!;
      expect(queued.type).toBe("message.queued");
      const payload = queued.payload as Record<string, unknown>;
      expect(payload.content).toBe("queued while you work");
      expect(Array.isArray(payload.attachments)).toBe(true);
      // The notify bridge delivered the live chip frame.
      expect(frames).toEqual([
        { type: "user.queued", seq: body.seq, content: "queued while you work", ts: queued.ts },
      ]);
    } finally {
      unregisterTurn(sessionId, controller);
    }
  });

  it("DELETE removes a queued row (200) and 404s for delivered/unknown rows", async () => {
    const sessionId = await makeSessionViaApi();
    const queued = appendQueuedMessage(db, sessionId, { content: "chip to remove" });
    const delivered = appendQueuedMessage(db, sessionId, { content: "already gone" });
    deliverQueuedMessage(db, sessionId, delivered.seq);

    const gone = await authInject({ method: "DELETE", url: `/api/v1/sessions/${sessionId}/queue/${queued.seq}` });
    expect(gone.statusCode).toBe(200);
    expect(gone.json()).toEqual({ ok: true });
    expect(listSessionEvents(db, sessionId).some((e) => e.seq === queued.seq)).toBe(false);

    const again = await authInject({ method: "DELETE", url: `/api/v1/sessions/${sessionId}/queue/${queued.seq}` });
    expect(again.statusCode).toBe(404);
    const deliveredRow = await authInject({
      method: "DELETE",
      url: `/api/v1/sessions/${sessionId}/queue/${delivered.seq}`,
    });
    expect(deliveredRow.statusCode).toBe(404);
    const badSeq = await authInject({ method: "DELETE", url: `/api/v1/sessions/${sessionId}/queue/abc` });
    expect(badSeq.statusCode).toBe(400);
    const unknownSession = await authInject({
      method: "DELETE",
      url: "/api/v1/sessions/sess_none/queue/1",
    });
    expect(unknownSession.statusCode).toBe(404);
  });
});

/* ── The streamed route's turn-end continuation ───────────────────────────── */

/** Parse a hijacked SSE body into its data frames (the r58 helper). */
function parseSse(body: string): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  for (const block of body.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
    }
  }
  return frames;
}

/** The SDK-boundary stream shape the mocked streamText returns. */
function sdkStream(
  parts: Array<Record<string, unknown>>,
  usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
): { fullStream: AsyncGenerator<Record<string, unknown>>; totalUsage: Promise<unknown>; usage: Promise<unknown> } {
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part;
      // R80: a healthy provider stream ALWAYS ends each step with a
      // finish-step part (the chat-completions finish_reason, mapped by the
      // SDK). Without it the R80 truncation guard rightly reads the mock as
      // a clean-close drop and throws — these tests model HEALTHY streams.
      yield { type: "finish-step", usage: { inputTokens: 5, outputTokens: 5 } };
    })(),
    totalUsage: Promise.resolve(usage),
    usage: Promise.resolve(usage),
  };
}

describe("R78: turn-end continuation on the streamed route", () => {
  it("a message queued mid-turn CONTINUES the same SSE stream as a full second turn", async () => {
    const sessionId = await makeSessionViaApi();
    const calls: Array<Record<string, unknown>> = [];
    streamTextMock.mockImplementation((input: Record<string, unknown>) => {
      calls.push(input);
      if (calls.length === 1) {
        // The queue append lands while turn 1 is streaming (the user typed
        // during the answer — exactly what the queue POST does).
        appendQueuedMessage(db, sessionId, { content: "and then summarize it" });
        return sdkStream([{ type: "text-delta", text: "Task completed. The file is written." }]);
      }
      // The continuation turn: the queued content is its OWN user message.
      return sdkStream([{ type: "text-delta", text: "Summarized. All done." }]);
    });

    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "create a.txt" },
    });
    expect(response.statusCode).toBe(200);
    const frames = parseSse(response.body as string);

    // TWO full turns ran on one stream.
    expect(calls).toHaveLength(2);
    // The continuation frame announced the queue.
    const continueFrames = frames.filter((f) => f.type === "meta.queue_continue");
    expect(continueFrames).toEqual([{ type: "meta.queue_continue", count: 1 }]);
    // The second turn's model-facing input carries the queued content as a
    // user message (full context — the first turn's reply included).
    const secondInput = calls[1] as { messages?: Array<{ role: string; content: string }> };
    expect(secondInput.messages!.some((m) => m.role === "user" && m.content === "and then summarize it")).toBe(true);
    expect(secondInput.messages!.some((m) => m.role === "assistant")).toBe(true);
    // ONE terminal frame, at the very end (the stream closes once).
    expect(frames.filter((f) => f.type === "done")).toHaveLength(1);
    expect(frames[frames.length - 1]?.type).toBe("done");
    // The queued event was CONSUMED (deleted — nothing stays queued) and the
    // transcript shows two ordinary turns.
    expect(listUndeliveredQueuedMessages(db, sessionId)).toHaveLength(0);
    const types = listSessionEvents(db, sessionId).map((e) => e.type);
    expect(types).toEqual([
      "message.user", // create a.txt
      "message.assistant", // Task completed. …
      "message.user", // and then summarize it (the continuation turn's own append)
      "message.assistant", // Summarized. All done.
    ]);
  });

  it("TWO queued messages: the FIRST is consumed as the turn's content, the REST ride iteration 0 (delivered in order)", async () => {
    const sessionId = await makeSessionViaApi();
    const calls: Array<Record<string, unknown>> = [];
    streamTextMock.mockImplementation((input: Record<string, unknown>) => {
      calls.push(input);
      if (calls.length === 1) {
        appendQueuedMessage(db, sessionId, { content: "first queued" });
        appendQueuedMessage(db, sessionId, { content: "second queued" });
        return sdkStream([{ type: "text-delta", text: "Task completed." }]);
      }
      return sdkStream([{ type: "text-delta", text: "Handled both." }]);
    });

    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "start" },
    });
    expect(response.statusCode).toBe(200);
    const frames = parseSse(response.body as string);

    expect(calls).toHaveLength(2);
    expect(frames.filter((f) => f.type === "meta.queue_continue")).toEqual([
      { type: "meta.queue_continue", count: 2 },
    ]);
    expect(frames[frames.length - 1]?.type).toBe("done");
    // The continuation turn's input: the FIRST's content is the turn's own
    // user message; the SECOND was flipped and rides the history BEFORE it.
    const secondInput = calls[1] as { messages?: Array<{ role: string; content: string }> };
    const secondMessages = secondInput.messages!;
    const firstIdx = secondMessages.findIndex((m) => m.content === "first queued");
    const secondIdx = secondMessages.findIndex((m) => m.content === "second queued");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(-1);
    // The flipped second (seq 4) precedes the consumed first's re-append
    // (seq 5) in the folded history — delivery order preserved.
    expect(secondIdx).toBeLessThan(firstIdx);
    // Both are ordinary user events in the log; nothing queued remains.
    expect(listUndeliveredQueuedMessages(db, sessionId)).toHaveLength(0);
    const userContents = listSessionEvents(db, sessionId)
      .filter((e) => e.type === "message.user")
      .map((e) => (e.payload as Record<string, unknown>).content);
    expect(userContents).toEqual(["start", "second queued", "first queued"]);
  });

  it("a mid-queued message that arrives via the queue POST while the stream is live (the real wire path)", async () => {
    // The full path: POST /queue DURING the first turn (the registry entry
    // exists because the streamed route registered `send` as its notify) —
    // the frame lands on the stream and the continuation consumes it.
    const sessionId = await makeSessionViaApi();
    const calls: Array<Record<string, unknown>> = [];
    const usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };
    streamTextMock.mockImplementation((input: Record<string, unknown>) => {
      calls.push(input);
      if (calls.length === 1) {
        return {
          // The queue POST is awaited from INSIDE the stream — it lands
          // while the turn is live (registerTurn already happened).
          fullStream: (async function* () {
            await authInject({
              method: "POST",
              url: `/api/v1/sessions/${sessionId}/queue`,
              payload: { content: "while you were working" },
            });
            yield { type: "text-delta", text: "Task completed." };
            // R80: the healthy wire carries its finish-step (see sdkStream).
            yield { type: "finish-step", usage: { inputTokens: 5, outputTokens: 5 } };
          })(),
          totalUsage: Promise.resolve(usage),
          usage: Promise.resolve(usage),
        };
      }
      return sdkStream([{ type: "text-delta", text: "Got your queued note." }]);
    });

    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "begin" },
    });
    expect(response.statusCode).toBe(200);
    const frames = parseSse(response.body as string);
    const types = frames.map((f) => f.type);

    // The live chip frame landed on the SAME stream (notifyTurn → send).
    expect(types).toContain("user.queued");
    const queuedFrame = frames.find((f) => f.type === "user.queued") as { content: string };
    expect(queuedFrame.content).toBe("while you were working");
    // And the turn-end continuation consumed it.
    expect(calls).toHaveLength(2);
    expect(types).toContain("meta.queue_continue");
    expect(types[types.length - 1]).toBe("done");
    expect(listUndeliveredQueuedMessages(db, sessionId)).toHaveLength(0);
  });

  it("no queue → the stream closes exactly as before (one turn, done last, no queue frames)", async () => {
    const sessionId = await makeSessionViaApi();
    streamTextMock.mockImplementation(() =>
      sdkStream([{ type: "text-delta", text: "Task completed." }]),
    );
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "plain turn" },
    });
    expect(response.statusCode).toBe(200);
    const frames = parseSse(response.body as string);
    expect(frames.filter((f) => f.type === "meta.queue_continue")).toHaveLength(0);
    expect(frames.filter((f) => f.type === "queued.delivered")).toHaveLength(0);
    expect(frames[frames.length - 1]?.type).toBe("done");
    expect(listSessionEvents(db, sessionId).map((e) => e.type)).toEqual([
      "message.user",
      "message.assistant",
    ]);
  });
});

/* ── ROUND-82 (R82): queued messages carry their OWN model/providerId ────── */

describe("R78 + R82: queued messages carry their own per-send override", () => {
  it("appendQueuedMessage stores the override pair in the payload — blank values are omitted", () => {
    const { sessionId } = makeSession("R82-Queue-Shape");
    const queued = appendQueuedMessage(db, sessionId, {
      content: "queue me on the gateway",
      model: GW_MODEL,
      providerId: GW_ID,
    });
    expect(queued.type).toBe("message.queued");
    const payload = queued.payload as Record<string, unknown>;
    expect(payload.content).toBe("queue me on the gateway");
    // ROUND-82: the picker state at queue time rides the payload (the
    // queue-continuation loop reads it when the entry is consumed).
    expect(payload.model).toBe(GW_MODEL);
    expect(payload.providerId).toBe(GW_ID);

    // A plain queue entry (no override) carries NEITHER field — the
    // continuation then falls back to the running override.
    const plain = appendQueuedMessage(db, sessionId, {
      content: "queue me plainly",
      model: "   ",
      providerId: "",
    });
    const plainPayload = plain.payload as Record<string, unknown>;
    expect(plainPayload.model).toBeUndefined();
    expect(plainPayload.providerId).toBeUndefined();
  });

  it("the queue POST accepts {model, providerId} — the payload event carries them; an unknown provider 400s", async () => {
    const sessionId = await makeSessionViaApi();
    const controller = new AbortController();
    registerTurn(sessionId, controller, () => undefined);
    try {
      const response = await authInject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/queue`,
        payload: { content: "while you work, use the gateway", model: GW_MODEL, providerId: GW_ID },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { ok: boolean; seq: number };
      expect(body.ok).toBe(true);
      const queued = listSessionEvents(db, sessionId).find((e) => e.seq === body.seq)!;
      expect(queued.type).toBe("message.queued");
      const payload = queued.payload as Record<string, unknown>;
      expect(payload.model).toBe(GW_MODEL);
      expect(payload.providerId).toBe(GW_ID);

      // Same validation as the send routes: an unknown provider is an
      // honest 400 — a queued follow-up must not silently route to the
      // agent default the way it did pre-R82.
      const bad = await authInject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/queue`,
        payload: { content: "bad provider", model: GW_MODEL, providerId: "prv_not-here" },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.code).toBe("VALIDATION");
      expect(bad.json().error.details.field).toBe("body.providerId");
    } finally {
      unregisterTurn(sessionId, controller);
    }
  });

  it("the continuation turn routes to the QUEUED override's provider (the picker state when it was queued)", async () => {
    const sessionId = await makeSessionViaApi();
    const calls: Array<Record<string, unknown>> = [];
    streamTextMock.mockImplementation((input: Record<string, unknown>) => {
      calls.push(input);
      if (calls.length === 1) {
        // The user typed during turn 1 — the queue POST carries the gateway
        // pair (exactly what the composer sends when the picker names a
        // custom provider's model).
        return {
          fullStream: (async function* () {
            await authInject({
              method: "POST",
              url: `/api/v1/sessions/${sessionId}/queue`,
              payload: { content: "and route the follow-up via the gateway", model: GW_MODEL, providerId: GW_ID },
            });
            yield { type: "text-delta", text: "Task completed." };
            yield { type: "finish-step", usage: { inputTokens: 5, outputTokens: 5 } };
          })(),
          totalUsage: Promise.resolve({ inputTokens: 5, outputTokens: 5, totalTokens: 10 }),
          usage: Promise.resolve({ inputTokens: 5, outputTokens: 5, totalTokens: 10 }),
        };
      }
      return sdkStream([{ type: "text-delta", text: "Follow-up on the gateway." }]);
    });

    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "start on openrouter" },
    });
    expect(response.statusCode).toBe(200);
    const frames = parseSse(response.body as string);

    // TWO full turns ran on one stream.
    expect(calls).toHaveLength(2);
    expect(frames.filter((f) => f.type === "meta.queue_continue")).toEqual([
      { type: "meta.queue_continue", count: 1 },
    ]);
    expect(frames[frames.length - 1]?.type).toBe("done");

    // THE routing pin: turn 1's client was the AGENT's openrouter; the
    // CONTINUATION turn's client was built from the QUEUED entry's override —
    // the gateway row (name + baseUrl), not the agent's.
    expect(createOpenAICompatibleMock).toHaveBeenCalledTimes(2);
    expect(createOpenAICompatibleMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({ name: "openrouter", baseURL: "https://openrouter.ai/api/v1" }),
    );
    expect(createOpenAICompatibleMock.mock.calls[1][0]).toEqual(
      expect.objectContaining({ name: GW_ID, baseURL: GW_BASE }),
    );
    // …and the continuation's model is the queued override's model.
    const secondCall = calls[1] as { model?: { model?: string } };
    expect(secondCall.model?.model).toBe(GW_MODEL);
    // The usage row attributes the continuation to the gateway.
    const continuationUsage = db
      .prepare("SELECT * FROM usage_events WHERE session_id = ? AND provider = ?")
      .get(sessionId, GW_ID) as { model: string } | undefined;
    expect(continuationUsage).toMatchObject({ model: GW_MODEL });
  });

  it("a queued message WITHOUT its own override keeps the RUNNING override for the continuation (the fallback)", async () => {
    const sessionId = await makeSessionViaApi();
    const calls: Array<Record<string, unknown>> = [];
    streamTextMock.mockImplementation((input: Record<string, unknown>) => {
      calls.push(input);
      if (calls.length === 1) {
        return {
          fullStream: (async function* () {
            // Queued mid-turn with NO override — the continuation must keep
            // the original send's pair (pre-R82 dropped it entirely).
            await authInject({
              method: "POST",
              url: `/api/v1/sessions/${sessionId}/queue`,
              payload: { content: "and keep the gateway" },
            });
            yield { type: "text-delta", text: "Task completed." };
            yield { type: "finish-step", usage: { inputTokens: 5, outputTokens: 5 } };
          })(),
          totalUsage: Promise.resolve({ inputTokens: 5, outputTokens: 5, totalTokens: 10 }),
          usage: Promise.resolve({ inputTokens: 5, outputTokens: 5, totalTokens: 10 }),
        };
      }
      return sdkStream([{ type: "text-delta", text: "Still on the gateway." }]);
    });

    // The original send names the gateway.
    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "start on the gateway", model: GW_MODEL, providerId: GW_ID },
    });
    expect(response.statusCode).toBe(200);
    expect(calls).toHaveLength(2);
    // BOTH turns ran on the gateway: the original override (turn 1) and the
    // running override the override-less queue entry inherited (turn 2).
    expect(createOpenAICompatibleMock).toHaveBeenCalledTimes(2);
    expect(createOpenAICompatibleMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({ name: GW_ID, baseURL: GW_BASE }),
    );
    expect(createOpenAICompatibleMock.mock.calls[1][0]).toEqual(
      expect.objectContaining({ name: GW_ID, baseURL: GW_BASE }),
    );
  });
});

// ── R93-B1/B2: the recovery continuation + the honest stranded-queue report ──

describe("R93-B2: the automatic recovery continuation after a transient failure", () => {
  beforeEach(() => {
    // A FAST ladder (2 attempts, no wait) so the terminal failure arrives
    // quickly — the recovery logic is under test, not the ladder itself.
    setRetrySettings(db, { maxAttempts: 2, waitMinutes: [0] });
  });

  it("a NETWORK failure with a queued message CONTINUES the stream with it (exactly once)", async () => {
    const sessionId = await makeSessionViaApi();
    let calls = 0;
    let recovered = false;
    streamTextMock.mockImplementation(() => {
      calls += 1;
      // The message queues during the FINAL ladder attempt (call 2) — the
      // earlier attempts' retries are fresh outer iterations whose loop-top
      // delivery would flip a mid-turn message into the history, emptying
      // the queue before the terminal failure. Queueing on the LAST attempt
      // is the race window the recovery serves.
      if (calls === 2) {
        appendQueuedMessage(db, sessionId, { content: "please retry the search" });
      }
      // Both LADDER attempts of turn 1 fail (maxAttempts: 2)…
      if (calls <= 2) throw new Error("500 Internal Server Error from provider");
      // …call 3 is the RECOVERY turn (the queued message as its content).
      recovered = true;
      return sdkStream([{ type: "text-delta", text: "Recovered — done." }]);
    });

    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "start the search" },
    });
    expect(response.statusCode).toBe(200);
    const frames = parseSse(response.body as string);
    expect(recovered).toBe(true);
    // The recovery continuation frame carries the recovery marker.
    const continueFrames = frames.filter((f) => f.type === "meta.queue_continue");
    expect(continueFrames).toEqual([
      { type: "meta.queue_continue", count: 1, recovery: true },
    ]);
    // The stream ended on the recovery's OWN success (done, not error).
    expect(frames.filter((f) => f.type === "done")).toHaveLength(1);
    expect(frames[frames.length - 1]?.type).toBe("done");
    // The queued message was consumed.
    expect(listUndeliveredQueuedMessages(db, sessionId)).toHaveLength(0);
  });

  it("a SECOND transient failure does not recover again — the error frame reports queuedKept", async () => {
    const sessionId = await makeSessionViaApi();
    let calls = 0;
    streamTextMock.mockImplementation(() => {
      calls += 1;
      // The message queues during the FINAL ladder attempt (see test 1).
      if (calls === 2) appendQueuedMessage(db, sessionId, { content: "queued follow-up" });
      throw new Error("500 Internal Server Error from provider");
    });

    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "start" },
    });
    expect(response.statusCode).toBe(200);
    const frames = parseSse(response.body as string);
    // FOUR attempts ran (turn 1's ladder + the recovery turn's ladder).
    expect(calls).toBe(4);
    // The recovery turn ran (one meta.queue_continue with recovery)…
    const continueFrames = frames.filter((f) => f.type === "meta.queue_continue");
    expect(continueFrames).toEqual([
      { type: "meta.queue_continue", count: 1, recovery: true },
    ]);
    // …failed too: exactly one terminal error frame. No queuedKept here —
    // the message was CONSUMED by the recovery turn (the auth test below
    // covers the strand-report).
    const errorFrames = frames.filter((f) => f.type === "error");
    expect(errorFrames).toHaveLength(1);
    const details = (errorFrames[0] as { details?: { queuedKept?: number } }).details;
    expect(details?.queuedKept).toBeUndefined();
    expect(frames[frames.length - 1]?.type).toBe("error");
  });

  it("an AUTH failure never auto-continues — the queue strands with the report", async () => {
    const sessionId = await makeSessionViaApi();
    let calls = 0;
    streamTextMock.mockImplementation(() => {
      calls += 1;
      if (calls === 1) appendQueuedMessage(db, sessionId, { content: "queued follow-up" });
      const err = new Error("401 Unauthorized: invalid API key");
      (err as Error & { statusCode?: number }).statusCode = 401;
      throw err;
    });

    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "start" },
    });
    expect(response.statusCode).toBe(200);
    const frames = parseSse(response.body as string);
    // NO recovery continuation was attempted.
    expect(frames.filter((f) => f.type === "meta.queue_continue")).toHaveLength(0);
    const errorFrames = frames.filter((f) => f.type === "error");
    expect(errorFrames).toHaveLength(1);
    const details = (errorFrames[0] as { details?: { queuedKept?: number; errorClass?: string } }).details;
    expect(details?.queuedKept).toBe(1);
    expect(details?.errorClass).toBe("auth");
    expect(listUndeliveredQueuedMessages(db, sessionId)).toHaveLength(1);
  });
});

describe("R93-B1: the post-analyst queue re-check (the late-queue race)", () => {
  it("a message queued during the debug-analyst phase still continues the stream", async () => {
    // Debug mode ON: the analyst runs between the primary queue check and
    // the done frame — the exact window the race lived in.
    setDebugSettings(db, { enabled: true });
    const sessionId = await makeSessionViaApi();
    const calls: Array<Record<string, unknown>> = [];
    streamTextMock.mockImplementation((input: Record<string, unknown>) => {
      calls.push(input);
      if (calls.length === 1) {
        // Turn 1 — a clean success (the analyst follows).
        return sdkStream([{ type: "text-delta", text: "First done." }]);
      }
      if (calls.length === 2) {
        // The ANALYST's model call — the user queues a message WHILE it
        // runs (the turn is still registered; POST /queue succeeds).
        appendQueuedMessage(db, sessionId, { content: "late message" });
        return sdkStream([{ type: "text-delta", text: "## Report\nAll good." }]);
      }
      // Turn 2 — the LATE-queued message's continuation turn.
      return sdkStream([{ type: "text-delta", text: "Late message handled." }]);
    });

    const response = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "start" },
    });
    expect(response.statusCode).toBe(200);
    const frames = parseSse(response.body as string);
    // FOUR model calls: the turn, the analyst, the LATE continuation, and
    // the analyst again on the late turn's exit (the documented cost of the
    // post-analyst re-check — debug mode only).
    expect(calls).toHaveLength(4);
    const lateInput = calls[2] as { messages?: Array<{ role: string; content: string }> };
    expect(
      lateInput.messages?.some((m) => m.role === "user" && m.content === "late message"),
    ).toBe(true);
    // The late message was consumed; the stream closed exactly once on done.
    expect(listUndeliveredQueuedMessages(db, sessionId)).toHaveLength(0);
    expect(frames.filter((f) => f.type === "done")).toHaveLength(1);
    expect(frames[frames.length - 1]?.type).toBe("done");
  });
});
