// @vitest-environment node
//
// ROUND-112 (R112-a) — the R110 DISCONNECT-LOOP fix #1's regression suite:
// the SSE keep-alives on the two streams the phone actually holds open, plus
// the transport tuning (fix #2) both listeners boot with.
//
//   1. THE TURN STREAM (POST /sessions/:id/messages/stream) — a leading
//      `: ping` comment flushes the headers the INSTANT the route runs
//      (writeHead alone assigns headers; nothing reaches the socket until
//      the first write — pre-fix, a slow-to-first-token model left the
//      stream byte-silent for seconds), then one `: ping` every 10 s
//      between events, and the interval dies with the stream (close or
//      the route's finally).
//   2. THE NOTIFICATIONS STREAM (GET /api/v1/notifications/stream) — the
//      same 10 s comment heartbeat between toasts; real data frames keep
//      flowing alongside; the close handler clears the interval AND the
//      bus subscription.
//   3. TRANSPORT TUNING — both servers boot with keepAliveTimeout 65 s /
//      headersTimeout 66 s (Node's default 5 s keepAliveTimeout reaps idle
//      sockets right from under the phone's 5-minute OkHttp pool — the
//      reconnect loop's root cause #2).
//
// Driving trick: app.inject({ payloadAsStream: true }) resolves the moment
// a hijacked reply calls writeHead and hands back the LIVE body as a
// Readable — the SSE chunks are assertable mid-stream (the terminal-stream
// suite's captured-body pattern, live instead of after-the-fact), and
// response.raw.res.destroy() emits the 'close' the route's cleanup rides.
// The 10 s heartbeat cadence is driven on the fake clock with ONLY the
// timer functions faked (setImmediate/Date stay real so the request
// dispatch itself needs no ticking).
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

import { getNotificationBus } from "../src/lib/notification-bus";
import { liveTurnIds } from "../src/lib/turn-registry";
import {
  DEVICE_LISTENER_HEADERS_TIMEOUT_MS,
  DEVICE_LISTENER_KEEP_ALIVE_TIMEOUT_MS,
  deviceLinkControllerFor,
} from "../src/lib/device-link";
import { ProviderKeyring } from "../src/providers/registry";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer, startServer } from "../src/server";

const TOKEN = "test-token-r112ka";
const KEY = "sk-or-vtest-r112ka";
const HEARTBEAT_MS = 10_000;

/** Only the timer functions are faked — the dispatch + microtask plumbing
 * (process.nextTick, setImmediate, Date) stays real so app.inject() needs
 * no clock ticking to reach the handler. */
function useHeartbeatFakeTimers(): void {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
}

let tempDir = "";
let dataDir = "";
let db: SqliteDatabase;
let app: FastifyInstance;

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r112ka-"));
  dataDir = mkdtempSync(join(tempDir, "data-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({ token: TOKEN, db, dataDir, keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }) });
  streamTextMock.mockReset();
  generateTextMock.mockReset();
  createOpenAICompatibleMock.mockClear();
});

afterEach(async () => {
  // Restore real timers FIRST — a fake-clock interval left behind must never
  // wedge app.close()'s teardown.
  vi.useRealTimers();
  const link = deviceLinkControllerFor(app);
  if (link !== null) await link.stop();
  await app.close();
  db.close();
  // No live turn may leak across tests (the finally-unregister contract).
  expect(liveTurnIds()).toEqual([]);
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort (Windows file-handle lag) */
  }
});

async function authInject(options: {
  method: "GET" | "POST" | "PUT";
  url: string;
  payload?: Record<string, unknown>;
  payloadAsStream?: boolean;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}` },
  })) as LightMyRequestResponse;
}

/** A session + agent through the real routes (the r107 pattern). */
async function makeSessionViaApi(): Promise<string> {
  const agentRes = await authInject({
    method: "POST",
    url: "/api/v1/agents",
    payload: {
      name: "R112 Keepalive Agent",
      systemPrompt: "You are terse.",
      providerId: "openrouter",
      model: "test/r112-1",
    },
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

const USAGE = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };

/** A streamText result whose fullStream BLOCKS on a gate (the slow model),
 * then completes with a healthy text-delta + finish-step. */
function gatedStream(gate: Promise<void>) {
  return {
    fullStream: (async function* () {
      await gate;
      yield { type: "text-delta", text: "The turn completed." };
      yield { type: "finish-step", usage: { inputTokens: 5, outputTokens: 5 } };
    })(),
    totalUsage: Promise.resolve(USAGE),
    usage: Promise.resolve(USAGE),
  };
}

/** Collect a live payloadAsStream body into a growing string + a 'data'
 * frame parser (comment frames like `: ping` are skipped — mirrors the
 * client parsers in src/lib/api.ts + the mobile stream reader). */
class LiveBody {
  private text = "";
  private streamEnded = false;
  private endWaiters: Array<() => void> = [];

  constructor(stream: NodeJS.ReadableStream) {
    stream.on("data", (chunk: Buffer) => {
      this.text += chunk.toString("utf8");
    });
    stream.on("end", () => {
      this.streamEnded = true;
      for (const waiter of this.endWaiters.splice(0)) waiter();
    });
  }

  body(): string {
    return this.text;
  }

  pingCount(): number {
    return this.text.split(": ping").length - 1;
  }

  dataFrames(): Array<Record<string, unknown>> {
    const frames: Array<Record<string, unknown>> = [];
    for (const block of this.text.split("\n\n")) {
      for (const line of block.split("\n")) {
        if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
      }
    }
    return frames;
  }

  get isEnded(): boolean {
    return this.streamEnded;
  }

  /** Resolves when the underlying stream ends (the route's res.end()). */
  ended(): Promise<void> {
    if (this.streamEnded) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.endWaiters.push(resolve);
    });
  }
}

/** Flush microtasks + zero-tick the fake clock until the predicate holds. */
async function settle(predicate: () => boolean, turns = 200): Promise<void> {
  for (let i = 0; i < turns && !predicate(); i += 1) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(predicate()).toBe(true);
}

// ── 1. the turn stream heartbeat ────────────────────────────────────────────

describe("R112-a: the turn stream's SSE heartbeat", () => {
  it("flushes a leading `: ping` immediately, ticks one every 10 s, and dies with the stream", async () => {
    const sessionId = await makeSessionViaApi();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    streamTextMock.mockImplementation(() => gatedStream(gate));

    useHeartbeatFakeTimers();
    let body: LiveBody;
    try {
      // The model is silently thinking — pre-fix the stream wrote NOTHING.
      const response = await authInject({
        method: "POST",
        url: `/api/v1/sessions/${sessionId}/messages/stream`,
        payload: { content: "the slow turn" },
        payloadAsStream: true,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      body = new LiveBody(response.stream());

      // THE LIVE-BATTERY FLUSH: the leading `: ping` is on the wire the
      // instant the route runs — before the model's first token. R114-b
      // adds the turn's OPENING data frame right behind it: turn.started
      // (the early live-turn announcement — user text + the resolved
      // model), so the OTHER device learns the turn exists before the
      // first token. The ping is still FIRST on the wire, and while the
      // gated model keeps thinking NOTHING further flows.
      await settle(
        () => body.pingCount() === 1 && body.dataFrames().some((f) => f.type === "turn.started"),
      );
      expect(body.body().startsWith(": ping\n\n")).toBe(true);
      expect(body.dataFrames()).toEqual([
        { type: "turn.started", text: "the slow turn", model: "test/r112-1", providerId: "openrouter" },
      ]);

      // 9.999 s later: still exactly the leading ping (the cadence is 10 s,
      // not "as fast as possible" — a chatty heartbeat would itself look
      // like a busy stream to NAT accounting).
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS - 1);
      expect(body.pingCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(body.pingCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      expect(body.pingCount()).toBe(3);

      // The model answers: real frames flow BETWEEN the heartbeats.
      release();
      await settle(() => body.isEnded);
      const frames = body.dataFrames();
      expect(frames.some((f) => f.type === "done")).toBe(true);
      // The heartbeat NEVER interleaves into a data frame: every comment
      // block is its own frame boundary.
      expect(body.body().startsWith(": ping\n\n")).toBe(true);

      // The interval died with the stream — no fourth ping past the end.
      const pingsAtEnd = body.pingCount();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
      expect(body.pingCount()).toBe(pingsAtEnd);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── 2. the notifications stream heartbeat ───────────────────────────────────

describe("R112-a: the notifications stream's SSE heartbeat", () => {
  it("writes `: ping` every 10 s between toasts, and the close handler tears it all down", async () => {
    useHeartbeatFakeTimers();
    let body: LiveBody;
    let response: LightMyRequestResponse;
    try {
      response = await authInject({
        method: "GET",
        url: "/api/v1/notifications/stream",
        payloadAsStream: true,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      body = new LiveBody(response.stream());

      // The hello frame arrives immediately (the bell's first unread count);
      // NO ping before the first 10 s tick (this stream is live-batteried by
      // its own hello, unlike the turn stream's leading flush).
      await settle(() => body.dataFrames().length === 1);
      expect(body.dataFrames()[0]).toMatchObject({ type: "hello" });
      expect(body.pingCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS - 1);
      expect(body.pingCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(body.pingCount()).toBe(1);

      // A real toast flows BETWEEN the heartbeats — data frames and comment
      // frames coexist on the wire, and the client parser skips comments.
      getNotificationBus().publish(db, { kind: "task_complete", title: "Task finished" });
      await settle(() => body.dataFrames().length === 2);
      expect(body.dataFrames()[1]).toMatchObject({ kind: "task_complete", title: "Task finished" });

      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      expect(body.pingCount()).toBe(2);

      // The client disconnects (app closed / phone offline): 'close' clears
      // the heartbeat AND the bus subscription — no zombie writes follow.
      response.raw.res.destroy();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
      const pingsAtClose = body.pingCount();
      const framesAtClose = body.dataFrames().length;
      getNotificationBus().publish(db, { kind: "task_complete", title: "never delivered" });
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
      expect(body.pingCount()).toBe(pingsAtClose);
      expect(body.dataFrames().length).toBe(framesAtClose);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── 3. the transport tuning (fix #2) ────────────────────────────────────────

describe("R112-a: the keep-alive transport tuning on BOTH listeners", () => {
  it("exports the 65 s / 66 s pair and applies it to the TLS device listener", async () => {
    expect(DEVICE_LISTENER_KEEP_ALIVE_TIMEOUT_MS).toBe(65_000);
    expect(DEVICE_LISTENER_HEADERS_TIMEOUT_MS).toBe(66_000);
    // headersTimeout must EXCEED keepAliveTimeout (Node's own invariant —
    // the request-header deadline outlives the idle window).
    expect(DEVICE_LISTENER_HEADERS_TIMEOUT_MS).toBeGreaterThan(DEVICE_LISTENER_KEEP_ALIVE_TIMEOUT_MS);

    const enable = await authInject({ method: "PUT", url: "/api/v1/settings/device-link", payload: { enabled: true } });
    expect(enable.statusCode).toBe(200);
    const link = deviceLinkControllerFor(app);
    expect(link).not.toBeNull();
    // While stopped the tuning is honestly null; while live it is the fix.
    expect(link?.transportTuning()).toEqual({
      keepAliveTimeout: 65_000,
      headersTimeout: 66_000,
    });
    await link?.stop();
    expect(link?.transportTuning()).toBeNull();
  });

  it("the LOOPBACK listener boots with the same tuning (startServer's post-bind block)", async () => {
    const dbDir = mkdtempSync(join(tempDir, "loopback-"));
    const running = await startServer({ token: TOKEN, dbPath: join(dbDir, "acute.db") });
    try {
      expect(running.server.server.keepAliveTimeout).toBe(65_000);
      expect(running.server.server.headersTimeout).toBe(66_000);
    } finally {
      await running.server.close();
    }
  });
});
