// @vitest-environment node
//
// ROUND-113 (R113-a) — the EVENT STREAM suite (GET /api/v1/events/stream,
// routes/events.ts + the lib/events-bus.ts fan-out it serves):
//
//   1. AUTH — the bearer wall applies (401 without a token); the phone's
//      seat matters, so a DEVICE token is proven to reach the stream too
//      (the route is deliberately NOT on the device blocklist — the phone
//      watches turns the desktop starts through this channel).
//   2. THE HELLO FRAME — `data: {"type":"hello"}` arrives immediately on
//      connect (the reconnect contract: "resync everything, then follow").
//   3. LIVE DELIVERY — a frame published on the bus (the imported
//      singleton — the same instance the storage hooks and routes use)
//      lands on the wire verbatim, PRE-serialization shape intact.
//   4. END-TO-END PUBLISH POINTS — real routes drive real frames:
//      PUT /settings/appearance → {"type":"settings"}, and POST /sessions
//      → {"type":"session","kind":"created"} straight from the
//      storage-layer choke point (createSession's publish).
//   5. THE HEARTBEAT — `: ping` every 10 s between frames (the R112-a
//      pattern; idle SSE otherwise gets reaped by NAT/proxy power-save).
//   6. TEARDOWN — client close clears the heartbeat AND the bus
//      subscription (no zombie writes, no leaked subscribers).
//
// Driving trick: app.inject({ payloadAsStream: true }) resolves the moment
// the hijacked reply calls writeHead and hands back the LIVE body — the
// r112-keepalive suite's pattern (its LiveBody collector, replicated here);
// response.raw.res.destroy() emits the 'close' the route's cleanup rides.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

// The full stack runs with ONLY the AI SDK mocked at the module boundary
// (the sessions-suite pattern) — the streamed-turn test below drives a real
// POST /sessions/:id/messages/stream through the real runtime.
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

import { getEventsBus } from "../src/lib/events-bus";
import { deviceLinkControllerFor } from "../src/lib/device-link";
import { ProviderKeyring } from "../src/providers/registry";
import { appendSessionEvent } from "../src/storage/sessions";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { buildServer } from "../src/server";

const TOKEN = "test-token-r113events";
const KEY = "sk-or-vtest-r113events";
const HEARTBEAT_MS = 10_000;

/** Only the timer functions are faked — the dispatch + microtask plumbing
 * (process.nextTick, setImmediate, Date) stays real so app.inject() needs
 * no clock ticking to reach the handler (the r112-keepalive trick). */
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
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r113events-"));
  dataDir = mkdtempSync(join(tempDir, "data-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  app = buildServer({
    token: TOKEN,
    db,
    dataDir,
    keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: KEY }),
  });
  streamTextMock.mockReset();
  generateTextMock.mockReset();
  createOpenAICompatibleMock.mockClear();
});

afterEach(async () => {
  // Real timers FIRST — a fake-clock interval left behind must never wedge
  // app.close()'s teardown (the r112-keepalive lesson).
  vi.useRealTimers();
  const link = deviceLinkControllerFor(app);
  if (link !== null) await link.stop();
  await app.close();
  db.close();
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
  headers?: Record<string, string>;
}): Promise<LightMyRequestResponse> {
  return (await app.inject({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}`, ...(options.headers ?? {}) },
  })) as LightMyRequestResponse;
}

/** A REAL TLS request against the device listener — the phone's seat (the
 * r109-device-blocklist pattern). */
function tlsRequest(
  port: number,
  method: string,
  path: string,
  opts?: { body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = opts?.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        rejectUnauthorized: false,
        headers: {
          ...(payload !== undefined
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(payload)),
              }
            : {}),
          ...(opts?.headers ?? {}),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            /* non-JSON body — the status carries it */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Enable the link, mint a pairing, claim it over TLS → the device token
 * (the r109-device-blocklist pattern, verbatim). */
async function pairDevice(): Promise<string> {
  const put = await authInject({ method: "PUT", url: "/api/v1/settings/device-link", payload: { enabled: true } });
  expect(put.statusCode).toBe(200);
  const start = await authInject({ method: "POST", url: "/api/v1/mobile/pair/start" });
  expect(start.statusCode).toBe(200);
  const qr = start.json() as { pin: string; port: number };
  const claim = await tlsRequest(qr.port, "POST", "/api/v1/mobile/pair/claim", {
    body: { pin: qr.pin, label: "the owner's phone" },
  });
  expect(claim.status).toBe(200);
  return (claim.json as { deviceToken: string }).deviceToken;
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

  ended(): Promise<void> {
    if (this.streamEnded) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.endWaiters.push(resolve);
    });
  }
}

/** Flush microtasks + zero-tick the clock until the predicate holds —
 * under fake timers (the heartbeat assertions) it ticks the fake clock;
 * under real timers (the plain frame-delivery tests) it yields to the
 * macrotask queue instead. */
async function settle(predicate: () => boolean, turns = 200): Promise<void> {
  for (let i = 0; i < turns && !predicate(); i += 1) {
    await Promise.resolve();
    if (vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(0);
    } else {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  expect(predicate()).toBe(true);
}

/** An agent + session through the real routes (the r112 pattern) — the
 * session-create frame is itself one of the assertions below. */
async function makeSessionViaApi(): Promise<string> {
  const agentRes = await authInject({
    method: "POST",
    url: "/api/v1/agents",
    payload: {
      name: "R113 Events Agent",
      systemPrompt: "You are terse.",
      providerId: "openrouter",
      model: "test/r113-1",
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

// ── 1. auth ─────────────────────────────────────────────────────────────────

describe("R113-a: the events stream auth", () => {
  it("401s without a bearer token (the app-level wall)", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/events/stream" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("serves a device token (the phone's live channel — NOT on the blocklist)", async () => {
    // Pair a real device through the mobile routes, then hold its token
    // against the stream: the whole R113 point is the phone watching turns
    // the desktop starts.
    const deviceToken = await pairDevice();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/events/stream",
      headers: { authorization: `Bearer ${deviceToken}` },
      payloadAsStream: true,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const body = new LiveBody(response.stream());
    await settle(() => body.dataFrames().length === 1);
    expect(body.dataFrames()[0]).toEqual({ type: "hello" });
    response.raw.res.destroy();
  });
});

// ── 2-4. hello, live delivery, end-to-end publish points ───────────────────

describe("R113-a: the events stream frames", () => {
  it("sends the hello frame immediately, then mirrors bus frames live", async () => {
    useHeartbeatFakeTimers();
    let body: LiveBody;
    let response: LightMyRequestResponse;
    try {
      response = await authInject({
        method: "GET",
        url: "/api/v1/events/stream",
        payloadAsStream: true,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      // The SSE response headers the hijack must carry (the ROUND-30
      // lesson: CORS rides writeHead, and nothing may buffer the stream).
      expect(response.headers["cache-control"]).toBe("no-cache, no-transform");
      body = new LiveBody(response.stream());

      // HELLO — immediately, before anything else.
      await settle(() => body.dataFrames().length === 1);
      expect(body.dataFrames()[0]).toEqual({ type: "hello" });

      // LIVE DELIVERY — a direct bus publish (the same singleton the
      // storage hooks publish through) lands on the wire verbatim.
      getEventsBus().publishTurnFrame("sess_x", { type: "text-delta", text: "live" });
      await settle(() => body.dataFrames().length === 2);
      expect(body.dataFrames()[1]).toEqual({
        type: "turn",
        sessionId: "sess_x",
        frame: { type: "text-delta", text: "live" },
      });

      // END-TO-END (a): a real settings PUT broadcasts through the route.
      const put = await authInject({
        method: "PUT",
        url: "/api/v1/settings/appearance",
        payload: { themeId: "clay", mode: "dark" },
      });
      expect(put.statusCode).toBe(200);
      await settle(() => body.dataFrames().length === 3);
      expect(body.dataFrames()[2]).toEqual({
        type: "settings",
        domain: "appearance",
        value: { themeId: "clay", mode: "dark" },
      });

      // END-TO-END (b): POST /sessions → the storage choke point's
      // "created" frame (projectId null, status "queued").
      await makeSessionViaApi();
      await settle(() => body.dataFrames().some((f) => f.type === "session" && f.kind === "created"));
      const created = body.dataFrames().find((f) => f.type === "session" && f.kind === "created");
      expect(created).toMatchObject({
        type: "session",
        projectId: null,
        kind: "created",
        status: "queued",
      });
      expect(typeof (created as { sessionId?: unknown }).sessionId).toBe("string");

      // THE HEARTBEAT — nothing before the first 10 s tick, one `: ping`
      // at it (the cadence, not a busy stream), data frames unharmed.
      expect(body.pingCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS - 1);
      expect(body.pingCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(body.pingCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      expect(body.pingCount()).toBe(2);

      // TEARDOWN — the client goes away: 'close' clears the heartbeat AND
      // the bus subscription. Give the 'close' event a beat to fire (it is
      // asynchronous), then no zombie writes may follow — neither pings
      // nor the post-close bus publish below.
      response.raw.res.destroy();
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      const pingsAtClose = body.pingCount();
      const framesAtClose = body.dataFrames().length;
      getEventsBus().publishSettingsFrame("memory", { enabled: false });
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
      expect(body.pingCount()).toBe(pingsAtClose);
      expect(body.dataFrames().length).toBe(framesAtClose);
    } finally {
      vi.useRealTimers();
    }
  });

  it("mirrors the session log's append frames end-to-end (the storage hook)", async () => {
    const response = await authInject({
      method: "GET",
      url: "/api/v1/events/stream",
      payloadAsStream: true,
    });
    const body = new LiveBody(response.stream());
    await settle(() => body.dataFrames().length === 1);

    const sessionId = await makeSessionViaApi();
    // (The create itself published kind:"created" — asserted in the test
    // above; this test drives the OTHER storage choke point.)

    // The appendSessionEvent choke point: an event row lands → the frame
    // carries the fresh seq + the session's project scope + status.
    appendSessionEvent(db, sessionId, {
      type: "message.user",
      payload: { role: "user", content: "hello from the test" },
    });
    await settle(() =>
      body
        .dataFrames()
        .some((f) => f.type === "session" && f.kind === "event" && f.seq === 1),
    );
    const eventFrame = body
      .dataFrames()
      .find((f) => f.type === "session" && f.kind === "event" && f.seq === 1);
    expect(eventFrame).toEqual({
      type: "session",
      sessionId,
      projectId: null,
      kind: "event",
      seq: 1,
      status: "queued",
    });
    response.raw.res.destroy();
  });
});

// ── 7. THE CROWN JEWEL: a real streamed turn, mirrored to a watcher ─────────
//
// The owner's exact bug: a message sent from the phone reaches the backend
// and the turn runs — but the DESKTOP (here: the watcher holding
// /events/stream) sees nothing live. This test drives the REAL streamed
// turn route through the REAL runtime (only the AI SDK mocked at the module
// boundary, the sessions-suite pattern) and asserts the watcher receives
// the whole live story: the queued→running status flip, the session-log
// appends (message.user / message.assistant with their seqs), the turn
// frames (text-delta … done), and the running→queued reset — INCLUDING
// AFTER the initiating client's own socket dies mid-turn (the R42 rule: a
// closed window does NOT abort the turn; the mirror keeps flowing to every
// other watcher).

const USAGE = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };

/** A streamText result that BLOCKS on a gate (the slow model), then
 * completes with a healthy text-delta + finish-step (the r112-keepalive
 * gatedStream, verbatim). */
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

describe("R113-a: a real streamed turn, mirrored live to a watcher", () => {
  it("mirrors status flips, log appends, and every turn frame — surviving the initiator's death", async () => {
    const sessionId = await makeSessionViaApi();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    streamTextMock.mockImplementation(() => gatedStream(gate));

    // (a) The WATCHER connects first — the phone watching the desktop's turn.
    const watcherResponse = await authInject({
      method: "GET",
      url: "/api/v1/events/stream",
      payloadAsStream: true,
    });
    expect(watcherResponse.statusCode).toBe(200);
    const watcher = new LiveBody(watcherResponse.stream());
    await settle(() => watcher.dataFrames().length === 1); // hello
    expect(watcher.dataFrames()[0]).toEqual({ type: "hello" });

    // (b) The INITIATOR (desktop/CLI/phone — any one seat) starts the turn.
    const initiatorResponse = await authInject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/messages/stream`,
      payload: { content: "the watched turn" },
      payloadAsStream: true,
    });
    expect(initiatorResponse.statusCode).toBe(200);
    const initiator = new LiveBody(initiatorResponse.stream());

    // (c) The watcher sees the LIVE story while the model is still thinking:
    // the queued→running status flip, the message.user log append (seq 1),
    // and — once the model answers — the turn frames themselves.
    await settle(() =>
      watcher.dataFrames().some((f) => f.type === "session" && f.kind === "status" && f.status === "running"),
    );
    await settle(() =>
      watcher.dataFrames().some((f) => f.type === "session" && f.kind === "event" && f.seq === 1),
    );
    expect(
      watcher.dataFrames().find((f) => f.type === "session" && f.kind === "event" && f.seq === 1),
    ).toMatchObject({ sessionId, kind: "event", seq: 1, status: "running" });

    // (d) THE OWNER'S BUG, FIXED: the initiator's window dies MID-TURN
    // (the R42 rule — the turn keeps running in the background). Give the
    // socket's async 'close' event a beat to fire (clientGone rides it) —
    // then release the model: the watcher's mirror must keep flowing.
    initiatorResponse.raw.res.destroy();
    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    release();
    await settle(() => watcher.dataFrames().some((f) => f.type === "turn" && (f.frame as { type?: string }).type === "text-delta"));
    await settle(() =>
      watcher.dataFrames().some(
        (f) => f.type === "turn" && (f.frame as { type?: string }).type === "done",
      ),
    );

    // (e) The full mirrored turn story, in order: every text-delta frame the
    // initiator's socket WOULD have received, the terminal done, and the
    // turn-end resets — the assistant log append + the running→queued flip.
    const turnFrames = watcher
      .dataFrames()
      .filter((f) => f.type === "turn")
      .map((f) => (f.frame as { type?: string }).type);
    expect(turnFrames).toContain("text-delta");
    expect(turnFrames).toContain("done");
    await settle(() =>
      watcher.dataFrames().some((f) => f.type === "session" && f.kind === "event" && f.seq === 2),
    );
    await settle(() =>
      watcher.dataFrames().some((f) => f.type === "session" && f.kind === "status" && f.status === "queued"),
    );

    // (f) The initiator's own socket was dead before the model answered —
    // its body froze mid-turn (clientGone skips the writes), while the
    // watcher got everything. That asymmetry IS the fix: pre-R113 the
    // turn's frames simply ceased to exist for everyone else.
    expect(initiator.dataFrames().some((f) => f.type === "done")).toBe(false);
    watcherResponse.raw.res.destroy();
  });
});

