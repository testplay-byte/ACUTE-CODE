/**
 * ROUND-112 (R112-a) — the CLOUD CONNECTOR unit suite: the outbound tunnel
 * to the acute-relay Cloudflare Worker, driven end-to-end through injected
 * fakes (the repo's constructor-DI testing style). What is pinned:
 *
 *   1. the HANDSHAKE — connect URL + host-auth headers, welcome → the exact
 *      hello frame, status transitions + lastConnectedAt.
 *   2. the HEARTBEAT — the exact `{"t":"ping"}` text every 25 s (the
 *      welcome frame's heartbeatMs wins when sane), the pong watchdog
 *      (10 s → terminate → reconnect), pong resets.
 *   3. the RECONNECT LADDER — 1 s → 2 s → 4 s … cap 60 s with ±30 % jitter
 *      bounds, close 4000/4001 → the cap directly, backoff reset on welcome.
 *   4. the BRIDGE — req → res / res-open + chunk + end / err mapping, the
 *      forwarded header whitelist, base64 round-trips, the 10 MB cap, the
 *      60 s response deadline, device-link-disabled err frames.
 *   5. the NEVER-THROW guarantee — malformed frames, a throwing factory, a
 *      dead socket: nothing escapes, the loop keeps going.
 *   6. the module singleton — start/stop/reconfigure/status semantics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_BODY_CAP_BYTES,
  BRIDGE_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_PONG_TIMEOUT_MS,
  DEFAULT_RECONNECT_BASE_MS,
  DEFAULT_RECONNECT_MAX_MS,
  TUNNEL_BYE_TEXT,
  TUNNEL_PING_TEXT,
  TUNNEL_PONG_TEXT,
  createCloudConnector,
  getCloudConnectorStatus,
  normalizeRelayUrl,
  reconfigureCloudConnector,
  resetCloudConnectorForTest,
  startCloudConnector,
  stopCloudConnector,
  type BridgeClient,
  type BridgeRequestSpec,
  type BridgeResponse,
  type CloudConnector,
  type TunnelSocket,
} from "../src/lib/cloud-connector";

const RELAY = "https://acute-relay.example.workers.dev";
const HOST_KEY = "host-key-0123456789abcdef";
const MACHINE_ID = "a".repeat(64);
const APP_VERSION = "0.106.0-test";

/* ── The fake tunnel socket (ws-shaped: on/send/close/terminate) ──────────── */

class MockSocket implements TunnelSocket {
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  terminated = 0;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  // The interface's exact overload set (the loose implementation below
  // satisfies them bivariantly — callers see only the four typed shapes).
  on(event: "open", listener: () => void): unknown;
  on(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: string, listener: (...args: never[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    // never[] accepts every overload's listener; the map stores the loose
    // call shape emit() uses (the assertion is direction-legal).
    list.push(listener as (...args: unknown[]) => void);
    this.listeners.set(event, list);
    return this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    // ws delivers close asynchronously — mimic it so ordering assumptions
    // can't silently invert.
    queueMicrotask(() => this.emit("close", code ?? 1006, Buffer.from(reason ?? "")));
  }

  terminate(): void {
    this.terminated += 1;
    queueMicrotask(() => this.emit("close", 1006, Buffer.alloc(0)));
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  /** The relay's frames inbound (Buffer, like ws text frames). */
  receive(text: string): void {
    this.emit("message", Buffer.from(text, "utf8"));
  }

  /** String frames inbound (the inject()-style variant — same wire frame). */
  receiveText(text: string): void {
    this.emit("message", text);
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
  }

  texts(): string[] {
    return [...this.sent];
  }
}

/** A factory harness: records constructions, hands each socket to the test. */
class MockRelay {
  readonly sockets: MockSocket[] = [];
  readonly calls: Array<{ url: string; headers: Record<string, string> }> = [];
  autoWelcome = true;

  factory = (url: string, headers: Record<string, string>): TunnelSocket => {
    this.calls.push({ url, headers });
    const socket = new MockSocket();
    this.sockets.push(socket);
    if (this.autoWelcome) {
      queueMicrotask(() =>
        socket.receive(JSON.stringify({ t: "welcome", v: 1, heartbeatMs: DEFAULT_HEARTBEAT_MS, machineId: MACHINE_ID })),
      );
    }
    return socket;
  };

  get latest(): MockSocket {
    return this.sockets[this.sockets.length - 1];
  }
}

/* ── The fake bridge body stream (async iterable of Buffers) ──────────────── */

class MockBody {
  private queue: Buffer[] = [];
  private ended = false;
  private failure: Error | null = null;
  private waiters: Array<() => void> = [];

  push(chunk: Buffer): void {
    this.queue.push(chunk);
    this.wake();
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  fail(error: Error): void {
    this.failure = error;
    this.wake();
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    return {
      next: () =>
        new Promise<IteratorResult<Buffer>>((resolve, reject) => {
          const attempt = (): void => {
            if (this.queue.length > 0) {
              resolve({ value: this.queue.shift() as Buffer, done: false });
              return;
            }
            if (this.failure !== null) {
              reject(this.failure);
              return;
            }
            if (this.ended) {
              resolve({ value: undefined, done: true });
              return;
            }
            this.waiters.push(attempt);
          };
          attempt();
        }),
    };
  }
}

/** A bridge client the test scripts: records specs, answers on demand. */
class MockBridge {
  readonly specs: BridgeRequestSpec[] = [];
  private pending: Array<{ spec: BridgeRequestSpec; resolve: (r: BridgeResponse) => void; reject: (e: Error) => void }> =
    [];

  client: BridgeClient = (spec) =>
    new Promise<BridgeResponse>((resolve, reject) => {
      this.specs.push(spec);
      this.pending.push({ spec, resolve, reject });
    });

  /** Answer one pending request with a buffered-style response. */
  respond(spec: Partial<BridgeResponse> & { status?: number }, body: Buffer | string): void {
    const entry = this.pending.shift();
    if (entry === undefined) throw new Error("no pending bridge request");
    const chunks = typeof body === "string" ? [Buffer.from(body, "utf8")] : [body];
    const stream = new MockBody();
    for (const chunk of chunks) stream.push(chunk);
    stream.end();
    entry.resolve({
      status: spec.status ?? 200,
      headers: spec.headers ?? { "content-type": "application/json" },
      stream,
    });
  }

  /** Answer one pending request with a LIVE (SSE-style) stream. */
  respondStream(spec: Partial<BridgeResponse> & { status?: number }): MockBody {
    const entry = this.pending.shift();
    if (entry === undefined) throw new Error("no pending bridge request");
    const stream = new MockBody();
    entry.resolve({
      status: spec.status ?? 200,
      headers: spec.headers ?? { "content-type": "text/event-stream; charset=utf-8" },
      stream,
    });
    return stream;
  }

  fail(message: string): void {
    const entry = this.pending.shift();
    if (entry === undefined) throw new Error("no pending bridge request");
    entry.reject(new Error(message));
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}

/* ── Shared harness ───────────────────────────────────────────────────────── */

let relay: MockRelay;
let bridge: MockBridge;
let tlsPort: { value: number | null } = { value: 45321 };
const connectors: CloudConnector[] = [];

/** Flush the microtask generations (async handlers in the connector). */
async function flush(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

function buildConnector(overrides: Record<string, unknown> = {}): CloudConnector {
  const created = createCloudConnector({
    relayUrl: RELAY,
    hostKey: HOST_KEY,
    machineId: MACHINE_ID,
    appVersion: APP_VERSION,
    label: "Test Machine",
    tlsPort: () => tlsPort.value,
    createTunnelSocket: relay.factory,
    bridgeRequest: bridge.client,
    ...overrides,
  });
  connectors.push(created);
  return created;
}

/** Connect + handshake (builds the connector); returns the live socket
 * AND the connector that owns it (the one to assert status on / stop). */
async function connectAndWelcome(): Promise<{ socket: MockSocket; connector: CloudConnector }> {
  const c = buildConnector();
  c.start();
  await flush();
  const socket = relay.latest;
  await flush();
  expect(socket.frames()[0]).toEqual({
    t: "hello",
    v: 1,
    machineId: MACHINE_ID,
    label: "Test Machine",
    appVersion: APP_VERSION,
  });
  return { socket, connector: c };
}

/** Send one relay→host req frame (sync). */
function sendReq(socket: MockSocket, frame: Record<string, unknown>): number {
  const before = socket.sent.length;
  socket.receive(JSON.stringify(frame));
  return before;
}

/** Flush until the socket carries `total` sent frames; returns the frames
 * sent AFTER `before`. */
async function waitForFrames(
  socket: MockSocket,
  before: number,
  total: number,
  turns = 200,
): Promise<Array<Record<string, unknown>>> {
  for (let i = 0; i < turns && socket.sent.length < total; i += 1) {
    await flush(1);
  }
  return socket.frames().slice(before);
}

/** Flush until a frame sent AFTER `before` matches the predicate (heartbeat
 * pings may interleave — counts alone can race); returns the frames sent
 * after `before`. */
async function waitForFrame(
  socket: MockSocket,
  before: number,
  match: (frame: Record<string, unknown>) => boolean,
  turns = 200,
): Promise<Array<Record<string, unknown>>> {
  const seen = (): boolean => socket.frames().slice(before).some(match);
  for (let i = 0; i < turns && !seen(); i += 1) {
    await flush(1);
  }
  return socket.frames().slice(before);
}

beforeEach(() => {
  vi.useFakeTimers();
  relay = new MockRelay();
  bridge = new MockBridge();
  tlsPort = { value: 45321 };
});

afterEach(() => {
  for (const created of connectors.splice(0)) {
    void created.stop();
  }
  resetCloudConnectorForTest();
  vi.useRealTimers();
});

/* ── 1. the handshake ─────────────────────────────────────────────────────── */

describe("R112-a: the tunnel handshake", () => {
  it("connects to <relayBase>/h/<machineId>/host with the host-auth headers", () => {
    const c = buildConnector();
    c.start();
    expect(relay.calls).toHaveLength(1);
    expect(relay.calls[0].url).toBe(`${RELAY}/h/${MACHINE_ID}/host`);
    expect(relay.calls[0].headers).toEqual({
      "x-acute-key": HOST_KEY,
      "x-acute-machine": MACHINE_ID,
    });
  });

  it("answers welcome with the exact hello frame; status → connected with lastConnectedAt", async () => {
    const startedAt = Date.now();
    const { socket, connector: c } = await connectAndWelcome();
    expect(socket.frames()[0]).toMatchObject({ t: "hello", v: 1 });
    const status = c.status();
    expect(status.state).toBe("connected");
    expect(status.relayUrl).toBe(RELAY);
    expect(status.lastConnectedAt).not.toBeNull();
    expect(status.lastConnectedAt as number).toBeGreaterThanOrEqual(startedAt);
    expect(status.lastError).toBeNull();
  });

  it("normalizes a trailing-slash relay URL before composing the host route", () => {
    const c = createCloudConnector({
      relayUrl: `${RELAY}/`,
      hostKey: HOST_KEY,
      machineId: MACHINE_ID,
      tlsPort: () => 1,
      createTunnelSocket: relay.factory,
      bridgeRequest: bridge.client,
    });
    c.start();
    expect(relay.calls[0].url).toBe(`${RELAY}/h/${MACHINE_ID}/host`);
    expect(c.status().relayUrl).toBe(RELAY);
  });
});

/* ── 2. the heartbeat ─────────────────────────────────────────────────────── */

describe("R112-a: the 25 s heartbeat + pong watchdog", () => {
  it("sends the exact ping text every 25 s and arms the 10 s watchdog", async () => {
    const { socket, connector: c } = await connectAndWelcome();
    expect(socket.texts()).toEqual([expect.any(String)]); // hello only
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_MS - 1);
    expect(socket.texts().slice(1)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.texts()[1]).toBe(TUNNEL_PING_TEXT);
    // No pong → the watchdog terminates the dead tunnel.
    await vi.advanceTimersByTimeAsync(DEFAULT_PONG_TIMEOUT_MS - 1);
    expect(socket.terminated).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.terminated).toBe(1);
    const status = c.status();
    expect(status.state).toBe("error");
    expect(status.lastError).toContain("no pong");
  });

  it("a pong clears the watchdog; the next ping re-arms it", async () => {
    const { socket } = await connectAndWelcome();
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_MS);
    socket.receive('{"t":"pong"}');
    await vi.advanceTimersByTimeAsync(DEFAULT_PONG_TIMEOUT_MS);
    expect(socket.terminated).toBe(0);
    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_MS); // second ping
    expect(socket.texts().filter((t) => t === TUNNEL_PING_TEXT)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(DEFAULT_PONG_TIMEOUT_MS);
    expect(socket.terminated).toBe(1);
  });

  it("honors the welcome frame's heartbeatMs when sane (5 s cadence)", async () => {
    relay.autoWelcome = false;
    const c = buildConnector();
    c.start();
    const socket = relay.latest;
    socket.receive(JSON.stringify({ t: "welcome", v: 1, heartbeatMs: 5_000, machineId: MACHINE_ID }));
    await flush();
    expect(socket.frames()[0].t).toBe("hello");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(socket.texts().includes(TUNNEL_PING_TEXT)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.texts().includes(TUNNEL_PING_TEXT)).toBe(true);
  });
});

/* ── 3. the reconnect ladder ──────────────────────────────────────────────── */

describe("R112-a: the reconnect ladder (1 s → 60 s, jittered)", () => {
  /** No jitter: the delay is exactly the ladder's base. */
  function ladderConnector(): CloudConnector {
    return buildConnector({ random: () => 0.5 });
  }

  it("progresses 1 s → 2 s → 4 s … and resets on welcome", async () => {
    // No auto-welcome: the ladder must climb across RAW reconnects.
    relay.autoWelcome = false;
    ladderConnector().start();
    expect(relay.sockets).toHaveLength(1);
    // First close → 1 s (jitter 0.5 ⇒ exactly the base).
    relay.latest.emit("close", 1006, Buffer.alloc(0));
    await vi.advanceTimersByTimeAsync(DEFAULT_RECONNECT_BASE_MS - 1);
    expect(relay.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(relay.sockets).toHaveLength(2);
    // Second close → 2 s (not 1 s — the ladder climbed).
    relay.latest.emit("close", 1006, Buffer.alloc(0));
    await vi.advanceTimersByTimeAsync(DEFAULT_RECONNECT_BASE_MS);
    expect(relay.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(DEFAULT_RECONNECT_BASE_MS);
    expect(relay.sockets).toHaveLength(3);
    // A welcome on the third socket RESETS the ladder → the next close is 1 s.
    relay.latest.receive(JSON.stringify({ t: "welcome", v: 1, machineId: MACHINE_ID }));
    await flush();
    relay.latest.emit("close", 1006, Buffer.alloc(0));
    await vi.advanceTimersByTimeAsync(DEFAULT_RECONNECT_BASE_MS - 1);
    expect(relay.sockets).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(relay.sockets).toHaveLength(4);
  });

  it("jitters ±30 %: random 0 → 0.7×base, random 1 → 1.3×base", async () => {
    relay.autoWelcome = false;
    let rand = 0;
    const c = buildConnector({ random: () => rand });
    c.start();
    // First close: random 0 → the 0.7 floor (700 ms — nothing reconnects at 699).
    relay.latest.emit("close", 1006, Buffer.alloc(0));
    await vi.advanceTimersByTimeAsync(Math.round(DEFAULT_RECONNECT_BASE_MS * 0.7) - 1);
    expect(relay.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(relay.sockets).toHaveLength(2);
    // Second close (ladder at 2 s): random 1 → the 1.3 ceiling (2600 ms).
    rand = 1;
    relay.latest.emit("close", 1006, Buffer.alloc(0));
    await vi.advanceTimersByTimeAsync(Math.round(DEFAULT_RECONNECT_BASE_MS * 2 * 1.3) - 1);
    expect(relay.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(relay.sockets).toHaveLength(3);
  });

  it("close 4000 (replaced) and 4001 (evicted) retry straight at the 60 s cap", async () => {
    relay.autoWelcome = false;
    ladderConnector().start();
    relay.latest.emit("close", 4001, Buffer.alloc(0));
    await vi.advanceTimersByTimeAsync(DEFAULT_RECONNECT_MAX_MS - 1);
    expect(relay.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(relay.sockets).toHaveLength(2);
    // …and stays at the cap on a subsequent close — the ladder would say
    // 2 s here; eviction keeps it at 60 s (nothing reconnects at 4 s).
    relay.latest.emit("close", 4000, Buffer.alloc(0));
    await vi.advanceTimersByTimeAsync(DEFAULT_RECONNECT_BASE_MS * 4);
    expect(relay.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(DEFAULT_RECONNECT_MAX_MS - DEFAULT_RECONNECT_BASE_MS * 4);
    expect(relay.sockets).toHaveLength(3);
  });

  it("caps the exponential ladder at 60 s", async () => {
    relay.autoWelcome = false;
    ladderConnector().start();
    // 1+2+4+8+16+32 = 63 s of climbing covers six closes (each advance is
    // generous — only the ladder's growth matters, not the exact sum).
    for (let i = 0; i < 6; i += 1) {
      relay.latest.emit("close", 1006, Buffer.alloc(0));
      await vi.advanceTimersByTimeAsync(DEFAULT_RECONNECT_MAX_MS + 1_000);
    }
    expect(relay.sockets).toHaveLength(7);
    // The 7th delay is the cap exactly (jitter 0.5): nothing at 59 999 ms.
    const before = relay.sockets.length;
    relay.latest.emit("close", 1006, Buffer.alloc(0));
    await vi.advanceTimersByTimeAsync(DEFAULT_RECONNECT_MAX_MS - 1);
    expect(relay.sockets).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(relay.sockets).toHaveLength(before + 1);
  });
});

/* ── 4. the bridge ────────────────────────────────────────────────────────── */

describe("R112-a: the request bridge", () => {
  it("maps a req frame to a buffered res frame — method/path/whitelisted headers/body carried, base64 round-trip", async () => {
    const { socket } = await connectAndWelcome();
    const bodyBytes = Buffer.from(JSON.stringify({ hello: "world", n: 42 }), "utf8");
    const before = sendReq(socket, {
      t: "req",
      id: "req-1",
      method: "POST",
      path: "/api/v1/sessions?x=1",
      headers: {
        authorization: "Bearer shell-token",
        "content-type": "application/json",
        accept: "application/json",
        "accept-language": "en-US",
        "user-agent": "okhttp/4.12",
        "x-requested-with": "com.acutecode.companion",
        // Non-whitelisted — must NOT ride the bridge:
        "x-evil": "nope",
        cookie: "session=1",
      },
      b64: bodyBytes.toString("base64"),
    });
    await flush();
    expect(bridge.specs).toHaveLength(1);
    const spec = bridge.specs[0];
    expect(spec.host).toBe("127.0.0.1");
    expect(spec.port).toBe(45321);
    expect(spec.method).toBe("POST");
    expect(spec.path).toBe("/api/v1/sessions?x=1");
    expect(spec.headers).toEqual({
      authorization: "Bearer shell-token",
      "content-type": "application/json",
      accept: "application/json",
      "accept-language": "en-US",
      "user-agent": "okhttp/4.12",
      "x-requested-with": "com.acutecode.companion",
    });
    expect(spec.body?.toString("utf8")).toBe(bodyBytes.toString("utf8"));

    const responseBody = Buffer.from(JSON.stringify({ ok: true, bin: [0, 1, 2, 255] }), "utf8");
    bridge.respond({ status: 200, headers: { "content-type": "application/json" } }, responseBody);
    const frames = await waitForFrames(socket, before, before + 1);
    expect(frames).toHaveLength(1);
    expect(frames[0].t).toBe("res");
    expect(frames[0].id).toBe("req-1");
    expect(frames[0].status).toBe(200);
    expect(frames[0].headers).toEqual({ "content-type": "application/json" });
    expect(Buffer.from(frames[0].b64 as string, "base64").toString("utf8")).toBe(
      responseBody.toString("utf8"),
    );
  });

  it("omits b64 for an empty body and forwards no body when the frame has none", async () => {
    const { socket } = await connectAndWelcome();
    const before = sendReq(socket, {
      t: "req",
      id: "req-2",
      method: "GET",
      path: "/api/v1/agents",
      headers: {},
    });
    await flush();
    expect(bridge.specs[0].body).toBeNull();
    bridge.respond({ status: 204, headers: {} }, Buffer.alloc(0));
    const frames = await waitForFrames(socket, before, before + 1);
    expect(frames[0].t).toBe("res");
    expect(frames[0].status).toBe(204);
    expect("b64" in frames[0]).toBe(false);
  });

  it("streams SSE: res-open → chunk frames as bytes arrive → end", async () => {
    const { socket } = await connectAndWelcome();
    const before = sendReq(socket, {
      t: "req",
      id: "req-3",
      method: "GET",
      path: "/api/v1/notifications/stream",
      headers: {},
    });
    await flush();
    const stream = bridge.respondStream({
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
      },
    });
    await flush();
    stream.push(Buffer.from("data: {\"type\":\"hello\"}\n\n", "utf8"));
    stream.push(Buffer.from(": ping\n\n", "utf8"));
    await flush();
    stream.push(Buffer.from("data: {\"type\":\"notification\"}\n\n", "utf8"));
    await flush();
    stream.end();
    const frames = await waitForFrames(socket, before, before + 5);
    expect(frames[0]).toEqual({
      t: "res-open",
      id: "req-3",
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
      },
    });
    expect(frames[1]).toEqual({
      t: "chunk",
      id: "req-3",
      b64: Buffer.from("data: {\"type\":\"hello\"}\n\n").toString("base64"),
    });
    expect(frames[2]).toEqual({
      t: "chunk",
      id: "req-3",
      b64: Buffer.from(": ping\n\n").toString("base64"),
    });
    // The THIRD chunk (the notification frame pushed after the comment):
    // chunks arrive as raw bytes in push order — the comment frame is just
    // another chunk on the wire (the relay re-injects its own SSE comments
    // on the cloud leg; ours pass through untouched).
    expect(frames[3]).toEqual({
      t: "chunk",
      id: "req-3",
      b64: Buffer.from("data: {\"type\":\"notification\"}\n\n").toString("base64"),
    });
    expect(frames[4]).toEqual({ t: "end", id: "req-3" });
  });

  it("answers the err frame when the TLS device listener is off", async () => {
    tlsPort.value = null;
    const { socket } = await connectAndWelcome();
    const before = sendReq(socket, { t: "req", id: "req-4", method: "GET", path: "/health", headers: {} });
    const frames = await waitForFrames(socket, before, before + 1);
    expect(frames).toEqual([
      {
        t: "err",
        id: "req-4",
        status: 503,
        code: "device_link_disabled",
        message: expect.any(String),
      },
    ]);
    expect(bridge.specs).toHaveLength(0);
  });

  it("answers the 502 bridge_error frame when the bridge rejects", async () => {
    const { socket } = await connectAndWelcome();
    const before = sendReq(socket, {
      t: "req",
      id: "req-5",
      method: "GET",
      path: "/api/v1/agents",
      headers: {},
    });
    await flush();
    bridge.fail("connect ECONNREFUSED 127.0.0.1:45321");
    const frames = await waitForFrames(socket, before, before + 1);
    expect(frames).toEqual([
      {
        t: "err",
        id: "req-5",
        status: 502,
        code: "bridge_error",
        message: expect.stringContaining("ECONNREFUSED"),
      },
    ]);
  });

  it("enforces the 60 s response deadline even when the bridge hangs (the signal fires)", async () => {
    const { socket } = await connectAndWelcome();
    const before = sendReq(socket, {
      t: "req",
      id: "req-6",
      method: "GET",
      path: "/api/v1/agents",
      headers: {},
    });
    await flush();
    expect(bridge.pendingCount).toBe(1);
    const signal = bridge.specs[0].signal;
    expect(signal.aborted).toBe(false);
    // Keep the tunnel ALIVE across the wait (the honest live-tunnel shape:
    // the 25 s pings are answered before their 10 s watchdogs expire) — the
    // deadline under test is the BRIDGE's, not the heartbeat's.
    const stepped = Math.floor((BRIDGE_TIMEOUT_MS - 1) / 5_000) * 5_000;
    for (let elapsed = 0; elapsed < stepped; elapsed += 5_000) {
      await vi.advanceTimersByTimeAsync(5_000);
      socket.receive(TUNNEL_PONG_TEXT);
    }
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(BRIDGE_TIMEOUT_MS - 1 - stepped);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    const frames = await waitForFrame(socket, before, (f) => f.t === "err");
    const err = frames.find((f) => f.t === "err");
    expect(err).toEqual({
      t: "err",
      id: "req-6",
      status: 502,
      code: "bridge_error",
      message: expect.stringContaining("timeout"),
    });
  });

  it("aborts in-flight bridges the moment the tunnel dies (the signal's tunnel-death leg)", async () => {
    const { socket } = await connectAndWelcome();
    const before = sendReq(socket, {
      t: "req",
      id: "req-death",
      method: "GET",
      path: "/api/v1/agents",
      headers: {},
    });
    await flush();
    expect(bridge.pendingCount).toBe(1);
    const signal = bridge.specs[0].signal;
    expect(signal.aborted).toBe(false);
    // The tunnel drops mid-request (network blip, eviction, watchdog): the
    // bridge's request is aborted immediately — its response could never
    // be delivered through the dead socket.
    socket.emit("close", 1006, Buffer.alloc(0));
    expect(signal.aborted).toBe(true);
    expect(bridge.pendingCount).toBe(1); // the hung fake stays pending — the ABORT is the observable
    // And nothing is written to the dead socket (an err frame would be
    // undeliverable — the relay's pending map died with the tunnel).
    await flush();
    expect(socket.sent.length).toBe(before);
  });

  it("caps buffered bodies at 10 MB → the body_too_large err frame + the source aborted", async () => {
    const { socket } = await connectAndWelcome();
    const before = sendReq(socket, {
      t: "req",
      id: "req-7",
      method: "GET",
      path: "/api/v1/attachments/x",
      headers: {},
    });
    await flush();
    // Buffered path (non-SSE content-type) fed over the live-stream shape.
    const stream = bridge.respondStream({
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
    await flush();
    stream.push(Buffer.alloc(BRIDGE_BODY_CAP_BYTES + 1));
    const frames = await waitForFrames(socket, before, before + 1);
    expect(frames).toEqual([
      {
        t: "err",
        id: "req-7",
        status: 413,
        code: "body_too_large",
        message: expect.stringContaining("10485760"),
      },
    ]);
    expect(bridge.specs[0].signal.aborted).toBe(true);
  });
});

/* ── 5. the never-throw guarantee ─────────────────────────────────────────── */

describe("R112-a: the never-throw guarantee", () => {
  it("ignores malformed frames entirely (garbage JSON, non-objects, unanswerable reqs)", async () => {
    const { socket, connector: c } = await connectAndWelcome();
    const sentBefore = socket.sent.length;
    socket.receive("this is not json");
    socket.receiveText('{"t":"req"}');
    socket.receiveText("null");
    socket.receiveText('["array"]');
    socket.receiveText('{"t":"req","id":123}');
    socket.receiveText('{"t":"welcome","heartbeatMs":"nope"}'); // welcome again, ignored heartbeatMs
    socket.receiveText('{"t":"kick","reason":"evicted"}'); // reserved → logged, ignored
    socket.receiveText('{"t":"unknown-frame"}');
    await flush();
    // Only the second welcome's hello may appear; nothing else sent.
    expect(socket.sent.length).toBe(sentBefore + 1);
    expect(socket.frames()[sentBefore].t).toBe("hello");
    expect(c.status().state).toBe("connected");
  });

  it("survives a THROWING socket factory — the retry loop keeps going", async () => {
    let throwsLeft = 1;
    const c = buildConnector({
      createTunnelSocket: (url: string, headers: Record<string, string>) => {
        if (throwsLeft > 0) {
          throwsLeft -= 1;
          throw new Error("factory exploded");
        }
        return relay.factory(url, headers);
      },
      random: () => 0.5,
    });
    c.start();
    expect(c.status().state).toBe("error");
    expect(c.status().lastError).toContain("factory exploded");
    await vi.advanceTimersByTimeAsync(DEFAULT_RECONNECT_BASE_MS);
    expect(relay.sockets).toHaveLength(1);
    await flush();
    expect(c.status().state).toBe("connected");
  });

  it("stop() is graceful (bye + close 1000) and idempotent; status → disabled", async () => {
    const { socket, connector: c } = await connectAndWelcome();
    await c.stop();
    expect(socket.texts().includes(TUNNEL_BYE_TEXT)).toBe(true);
    expect(socket.closes).toEqual([{ code: 1000, reason: "connector stopped" }]);
    expect(c.status()).toEqual({
      state: "disabled",
      relayUrl: RELAY,
      lastConnectedAt: expect.any(Number),
      lastError: null,
    });
    // A second stop is a no-op.
    await expect(c.stop()).resolves.toBeUndefined();
    expect(socket.closes).toHaveLength(1);
    // No reconnect follows a deliberate stop.
    await vi.advanceTimersByTimeAsync(DEFAULT_RECONNECT_MAX_MS * 3);
    expect(relay.sockets).toHaveLength(1);
  });
});

/* ── 6. the module singleton ──────────────────────────────────────────────── */

describe("R112-a: the module-level singleton", () => {
  afterEach(() => {
    resetCloudConnectorForTest();
  });

  it("getCloudConnectorStatus reports the idle shape before any start", () => {
    expect(getCloudConnectorStatus()).toEqual({
      state: "disabled",
      relayUrl: "",
      lastConnectedAt: null,
      lastError: null,
    });
  });

  it("startCloudConnector drives the singleton; stopCloudConnector disables it", async () => {
    const relayMock = new MockRelay();
    const bridgeMock = new MockBridge();
    const status0 = startCloudConnector({
      relayUrl: RELAY,
      hostKey: HOST_KEY,
      machineId: MACHINE_ID,
      tlsPort: () => 45321,
      createTunnelSocket: relayMock.factory,
      bridgeRequest: bridgeMock.client,
    });
    expect(status0.state).toBe("connecting");
    await flush();
    expect(getCloudConnectorStatus().state).toBe("connected");
    expect(getCloudConnectorStatus().relayUrl).toBe(RELAY);

    const status1 = await stopCloudConnector();
    expect(status1.state).toBe("disabled");
    expect(relayMock.latest.texts().includes(TUNNEL_BYE_TEXT)).toBe(true);
  });

  it("reconfigureCloudConnector stops the old tunnel and starts the new one", async () => {
    const relayMock = new MockRelay();
    const bridgeMock = new MockBridge();
    startCloudConnector({
      relayUrl: RELAY,
      hostKey: HOST_KEY,
      machineId: MACHINE_ID,
      tlsPort: () => 45321,
      createTunnelSocket: relayMock.factory,
      bridgeRequest: bridgeMock.client,
    });
    await flush();
    expect(relayMock.sockets).toHaveLength(1);
    const first = relayMock.sockets[0];

    await reconfigureCloudConnector({
      relayUrl: "https://other-relay.example.workers.dev",
      hostKey: "second-key",
      machineId: MACHINE_ID,
      tlsPort: () => 45321,
      createTunnelSocket: relayMock.factory,
      bridgeRequest: bridgeMock.client,
    });
    await flush();
    // The old tunnel got its graceful bye; the new one connected.
    expect(first.texts().includes(TUNNEL_BYE_TEXT)).toBe(true);
    expect(relayMock.sockets).toHaveLength(2);
    expect(getCloudConnectorStatus().relayUrl).toBe("https://other-relay.example.workers.dev");
  });
});

/* ── 7. pure helpers ──────────────────────────────────────────────────────── */

describe("R112-a: normalizeRelayUrl", () => {
  it("trims whitespace and strips ALL trailing slashes", () => {
    expect(normalizeRelayUrl("  https://r.example.workers.dev  ")).toBe(
      "https://r.example.workers.dev",
    );
    expect(normalizeRelayUrl("https://r.example.workers.dev/")).toBe(
      "https://r.example.workers.dev",
    );
    expect(normalizeRelayUrl("https://r.example.workers.dev///")).toBe(
      "https://r.example.workers.dev",
    );
    expect(normalizeRelayUrl("")).toBe("");
  });
});
