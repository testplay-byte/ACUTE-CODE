/**
 * ROUND-112 (R112-a, the desktop half of v0.106.0's remote access): the
 * CLOUD CONNECTOR — ONE outbound WebSocket tunnel to the acute-relay
 * Cloudflare Worker (https://acute-relay.anikuta.workers.dev), bridging the
 * phone's proxied HTTPS requests into the local TLS device listener.
 *
 * THE SHAPE (the relay README is the authoritative protocol spec — every
 * frame below is its exact contract):
 *
 *   connect:   GET <relayBase>/h/<machineId>/host  (WS upgrade, headers
 *              X-ACUTE-Key = HOST_KEY, X-ACUTE-Machine = machineId)
 *   welcome →  {"t":"hello","v":1,"machineId":…,"label":…,"appVersion":…}
 *   every 25s: the exact text {"t":"ping"}  (edge-answered with
 *              {"t":"pong"}; no pong within 10 s → dead → reconnect)
 *   req  →     {"t":"res"|"res-open"+chunks+"end"|"err"} per request
 *   disable:   {"t":"bye"} then close(1000)
 *
 * WHY THE `ws` PACKAGE (not Node's native WebSocket): the relay's host auth
 * rides custom request headers (X-ACUTE-Key), and the WHATWG WebSocket the
 * browser/Node global exposes has NO header support by design. `ws` is a
 * plain-JS dependency (no native build, no postinstall), so it stages into
 * the sidecar exactly like `web-push` — scripts/release/stage-sidecar.mjs
 * pins every dependency's installed version from the workspace lockfile.
 *
 * NEVER-FATAL BOOT (the fcm-push.ts rule): this module must NEVER crash the
 * sidecar. Every frame is parsed defensively (malformed → ignored), every
 * socket callback is wrapped, every public function catches its own
 * failures — the connector is an accessory; the loopback sidecar is the
 * product.
 *
 * CONSTRUCTOR-INJECTABLE SEAMS (the repo's DI/testing style): the tunnel
 * socket factory and the bridge client are injectable so the unit suites
 * can drive the full protocol with fakes, and `setCloudConnectorFactoriesForTest`
 * lets route-level tests intercept the module singleton the same way
 * resetVapidKeysForTest/resetFcmConfigForTest steer their modules.
 */
import { hostname } from "node:os";
import { request as httpsRequest } from "node:https";
import WebSocket from "ws";
import { log } from "./log.js";
import { VERSION } from "./version.js";

/* ── The tunnel protocol's exact texts (the relay matches PING byte-for-byte
 *    at the edge — setWebSocketAutoResponse — so these are CONSTANTS, never
 *    re-serialized JSON). ─────────────────────────────────────────────────── */

/** The heartbeat frame — answered AT THE EDGE without waking the relay. */
export const TUNNEL_PING_TEXT = '{"t":"ping"}';
/** The edge's answer (received, never sent by us). */
export const TUNNEL_PONG_TEXT = '{"t":"pong"}';
/** The graceful-shutdown notice, sent right before close(1000). */
export const TUNNEL_BYE_TEXT = '{"t":"bye"}';

/* ── Timing + size knobs (the relay's README contract). ──────────────────── */

/** Heartbeat cadence — the relay's welcome frame names it (25 s there). */
export const DEFAULT_HEARTBEAT_MS = 25_000;
/** No pong within this window → the tunnel is dead → terminate + reconnect. */
export const DEFAULT_PONG_TIMEOUT_MS = 10_000;
/** Reconnect backoff: 1 s → 2 s → 4 s → … capped here. */
export const DEFAULT_RECONNECT_BASE_MS = 1_000;
/** The backoff cap (also the direct delay after close 4000/4001). */
export const DEFAULT_RECONNECT_MAX_MS = 60_000;
/** Local bridge deadline — time from request start to response HEADERS.
 * Streaming (SSE) responses are NOT bounded once opened: the relay documents
 * "streaming responses are not deadline-bounded", and the relay's own 30 s
 * time-to-first-frame guest deadline already bounds the visible stall. */
export const BRIDGE_TIMEOUT_MS = 60_000;
/** Buffered response cap (the relay's per-request body cap is the same
 * 10 MB — a bridged response larger than this answers an err frame). */
export const BRIDGE_BODY_CAP_BYTES = 10 * 1024 * 1024;

/** Relay close codes with "stay away a while" semantics (README: another
 * instance took over / the admin evicted) — retry straight at the 60 s cap. */
const CLOSE_REPLACED = 4000;
const CLOSE_EVICTED = 4001;

/** Request headers forwarded guest→desktop (the relay's own whitelist —
 * keep the two lists in lockstep; the relay sends exactly these). */
const BRIDGE_FORWARD_REQUEST_HEADERS = [
  "authorization",
  "content-type",
  "accept",
  "accept-language",
  "user-agent",
  "x-requested-with",
] as const;

/** Response headers forwarded desktop→guest (hop-by-hop headers are never
 * forwarded; the relay sanitizes again on its side, so a small explicit
 * whitelist is defense-in-depth on BOTH ends). */
const BRIDGE_FORWARD_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "content-disposition",
] as const;

/* ── The injectable seams ─────────────────────────────────────────────────── */

/** The narrow WebSocket surface the connector drives — the `ws` class
 * satisfies it structurally; tests supply fakes with the same shape. */
export interface TunnelSocket {
  on(event: "open", listener: () => void): unknown;
  on(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  /** Text frame (ws throws if the socket is not open — callers catch). */
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Hard kill — no close handshake, close event follows. */
  terminate(): void;
}

/** Builds the tunnel socket for one connect attempt. */
export type TunnelSocketFactory = (url: string, headers: Record<string, string>) => TunnelSocket;

/** The default factory: the real `ws` WebSocket with the relay's host-auth
 * headers (the reason this dependency exists — the native WHATWG WebSocket
 * cannot send custom headers). */
const defaultTunnelSocketFactory: TunnelSocketFactory = (url, headers) =>
  new WebSocket(url, { headers }) as unknown as TunnelSocket;

/** One bridged request, exactly as the connector issues it. */
export interface BridgeRequestSpec {
  /** Always the loopback literal — the bridge never leaves this machine. */
  host: "127.0.0.1";
  /** The TLS device listener's live port. */
  port: number;
  method: string;
  /** Path + query, verbatim from the relay's req frame (validated "/…"). */
  path: string;
  /** The whitelisted forwarded headers (already lowercase). */
  headers: Record<string, string>;
  /** Base64-decoded request body (null when the frame carried none). */
  body: Buffer | null;
  /** Aborts the underlying request — fired by the connector's response
   * deadline, by the 10 MB body cap, by tunnel death, and by stop(). */
  signal: AbortSignal;
}

/** One bridged response: status + headers + the body as an async iterable
 * of raw Buffers (an http.IncomingMessage IS this — the default client
 * passes it through untouched; iteration ends at stream end and rejects on
 * stream error/abort). */
export interface BridgeResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  stream: AsyncIterable<Buffer>;
}

/** The bridge client seam. */
export type BridgeClient = (spec: BridgeRequestSpec) => Promise<BridgeResponse>;

/**
 * The default bridge client: one HTTPS request into the TLS device listener.
 *
 * rejectUnauthorized:false is deliberate and loopback-ONLY: the device
 * listener presents the machine's SELF-SIGNED certificate, whose pinning
 * story belongs to the phone's TOFU leg (LAN) and the relay's TLS leg
 * (cloud) — never to this hop. The connector dials the literal 127.0.0.1,
 * so an in-path attacker would already need code execution on this machine
 * (at which point the connector's trust boundary is the least of it).
 */
function defaultBridgeClient(spec: BridgeRequestSpec): Promise<BridgeResponse> {
  return new Promise<BridgeResponse>((resolve, reject) => {
    let settled = false;
    const req = httpsRequest(
      {
        host: spec.host,
        port: spec.port,
        method: spec.method,
        path: spec.path,
        headers: spec.headers,
        rejectUnauthorized: false,
      },
      (res) => {
        settled = true;
        resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res });
      },
    );
    req.on("error", (err: Error) => {
      if (!settled) reject(err);
      // After headers, errors surface through the stream's iteration —
      // the connector's per-request catch owns them there.
    });
    spec.signal.addEventListener(
      "abort",
      () => {
        // destroy(reason) surfaces the abort as a request/stream error —
        // the caller's catch turns it into the honest err frame.
        req.destroy(spec.signal.reason instanceof Error ? spec.signal.reason : new Error("aborted"));
      },
      { once: true },
    );
    try {
      if (spec.body !== null) req.write(spec.body);
      req.end();
    } catch (err) {
      if (!settled) reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/* ── Public shapes ────────────────────────────────────────────────────────── */

/** The configuration the boot block + settings route hand the connector. */
export interface CloudConnectorConfig {
  /** The relay's base URL (normalized — no trailing slash). */
  relayUrl: string;
  /** The relay's HOST_KEY (gates who may host a Room). */
  hostKey: string;
  /** This machine's stable 64-hex identity (the device cert's SHA-256). */
  machineId: string;
  /** The machine name the relay registry shows (link-info/claim's hostname()). */
  label?: string;
  /** The app version the hello frame carries (agent-core's VERSION). */
  appVersion?: string;
  /** The TLS device listener's live port — null while the link is off. */
  tlsPort: () => number | null;
}

/** The status snapshot (the settings GET + the Devices tab poll this). */
export interface CloudConnectorStatus {
  state: "disabled" | "connecting" | "connected" | "error";
  relayUrl: string;
  lastConnectedAt: number | null;
  lastError: string | null;
}

/** The controller (device-link.ts's controller style — one per tunnel). */
export interface CloudConnector {
  /** Begin the connect loop. Never throws; safe to call once per connector. */
  start(): void;
  /** Graceful stop: send {"t":"bye"}, close(1000), clear every timer,
   * abort in-flight bridges. Never throws; idempotent. */
  stop(): Promise<void>;
  status(): CloudConnectorStatus;
}

/** Config + the test knobs (all optional, all defaulted). */
export interface CloudConnectorOptions extends CloudConnectorConfig {
  createTunnelSocket?: TunnelSocketFactory;
  bridgeRequest?: BridgeClient;
  heartbeatMs?: number;
  pongTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** The jitter source (default Math.random) — inject for bounds tests. */
  random?: () => number;
}

/** Trim + strip trailing slashes ("https://relay.example.com/" → the base). */
export function normalizeRelayUrl(raw: string): string {
  let value = raw.trim();
  while (value.endsWith("/")) value = value.slice(0, -1);
  return value;
}

/** Turn any thrown value into a bounded, printable message. */
function messageOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** Race a promise against an AbortSignal — the connector's response
 * deadline must hold even if an injected bridge ignores the signal (the
 * DEFAULT client honors it via req.destroy, but the connector never
 * depends on that). A late settle after the abort is swallowed (the
 * listener stays attached — no unhandled rejections). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error(message));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** The relay's frame data → text (ws hands text frames as Buffer; inject()'s
 * fakes may hand strings — both are the same frame on the wire). */
function frameTextOf(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof Uint8Array) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (Array.isArray(data) && data.every((entry) => Buffer.isBuffer(entry))) {
    return Buffer.concat(data as Buffer[]).toString("utf8");
  }
  return null;
}

/** Lower-cased single-string view of a response header. */
function headerOf(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toUpperCase()];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") return value[0];
  return undefined;
}

/* ── The controller ───────────────────────────────────────────────────────── */

export function createCloudConnector(options: CloudConnectorOptions): CloudConnector {
  const relayUrl = normalizeRelayUrl(options.relayUrl);
  const hostKey = options.hostKey;
  const machineId = options.machineId;
  const label = options.label ?? hostname();
  const appVersion = options.appVersion ?? VERSION;
  const tlsPort = options.tlsPort;
  const createSocket = options.createTunnelSocket ?? defaultTunnelSocketFactory;
  const bridge = options.bridgeRequest ?? defaultBridgeClient;
  const fallbackHeartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
  const reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
  const reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
  const random = options.random ?? Math.random;

  let running = false;
  let state: CloudConnectorStatus["state"] = "disabled";
  let lastConnectedAt: number | null = null;
  let lastError: string | null = null;
  let socket: TunnelSocket | null = null;
  /** Identity guard: handlers from a superseded socket (replaced, terminated,
   * stopped) are ignored by generation mismatch. */
  let generation = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pongWatchdog: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive failed attempts since the last welcome (the backoff ladder). */
  let reconnectAttempts = 0;
  /** The in-flight bridge requests' abort handles (stop()/tunnel death). */
  const inflight = new Set<AbortController>();

  const status = (): CloudConnectorStatus => ({ state, relayUrl, lastConnectedAt, lastError });

  const sendText = (text: string): void => {
    const s = socket;
    if (s === null) return;
    try {
      s.send(text);
    } catch {
      // Dead socket — the close handler owns recovery; never throw upward.
    }
  };

  const sendFrame = (frame: Record<string, unknown>): void => {
    sendText(JSON.stringify(frame));
  };

  const clearHeartbeat = (): void => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (pongWatchdog !== null) {
      clearTimeout(pongWatchdog);
      pongWatchdog = null;
    }
  };

  const armPongWatchdog = (): void => {
    if (pongWatchdog !== null) clearTimeout(pongWatchdog);
    pongWatchdog = setTimeout(() => {
      pongWatchdog = null;
      const s = socket;
      if (s === null) return;
      lastError = `no pong within ${pongTimeoutMs} ms — treating the tunnel as dead`;
      state = "error";
      log("warn", "cloud.heartbeat_timeout", { relayUrl, pongTimeoutMs });
      try {
        s.terminate();
      } catch {
        // Already dead — the close handler schedules the reconnect.
      }
    }, pongTimeoutMs);
  };

  /** The next reconnect delay: exponential 1 s → cap, jittered ±30 % (the
   * anti-herd rule — two desktops that lost the relay together must not
   * retry in lockstep; eviction/replacement uses the cap directly but keeps
   * the jitter for the same reason). */
  const nextReconnectDelayMs = (evicted: boolean): number => {
    const exponential = Math.min(reconnectBaseMs * 2 ** reconnectAttempts, reconnectMaxMs);
    const base = evicted ? reconnectMaxMs : exponential;
    return Math.max(0, Math.round(base * (0.7 + 0.6 * random())));
  };

  const connect = (): void => {
    if (!running) return;
    reconnectTimer = null;
    generation += 1;
    const myGeneration = generation;
    state = "connecting";
    let s: TunnelSocket;
    try {
      s = createSocket(`${relayUrl}/h/${machineId}/host`, {
        "x-acute-key": hostKey,
        "x-acute-machine": machineId,
      });
      s.on("open", () => {
        // Nothing to do — the welcome frame is the real gate (and edge
        // proxies may open the socket long before the Room answers).
      });
      s.on("message", (data: unknown) => {
        if (generation !== myGeneration) return;
        try {
          handleFrameText(frameTextOf(data));
        } catch {
          // NEVER let a frame crash the sidecar (malformed input included).
        }
      });
      s.on("error", (err: Error) => {
        if (generation !== myGeneration) return;
        lastError = messageOf(err);
        // ws emits close after error — the close handler schedules recovery.
      });
      s.on("close", (code: number) => {
        if (generation !== myGeneration) return;
        handleClose(code);
      });
    } catch (err) {
      lastError = messageOf(err);
      state = "error";
      scheduleReconnect(nextReconnectDelayMs(false));
      return;
    }
    socket = s;
  };

  const scheduleReconnect = (delayMs: number): void => {
    if (!running) return;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delayMs);
  };

  const handleClose = (code: number): void => {
    socket = null;
    clearHeartbeat();
    // In-flight bridges can never be answered through a dead tunnel (the
    // relay's pending map died with the room's awake window) — abort them
    // NOW, the signal contract's "tunnel death" leg (BridgeRequestSpec's
    // doc: deadline / body cap / tunnel death / stop()).
    abortInflight("tunnel closed");
    if (lastError === null) lastError = `tunnel closed (code ${code})`;
    if (!running) {
      state = "disabled";
      return;
    }
    state = "error";
    const evicted = code === CLOSE_REPLACED || code === CLOSE_EVICTED;
    const delay = nextReconnectDelayMs(evicted);
    reconnectAttempts += 1;
    log("warn", "cloud.tunnel_closed", { relayUrl, code, evicted, retryInMs: delay });
    scheduleReconnect(delay);
  };

  const handleWelcome = (frame: Record<string, unknown>): void => {
    // Welcome = the tunnel is REAL: reset the backoff ladder, record the
    // moment, and introduce ourselves per the protocol.
    reconnectAttempts = 0;
    lastError = null;
    lastConnectedAt = Date.now();
    state = "connected";
    clearHeartbeat();
    sendFrame({ t: "hello", v: 1, machineId, label, appVersion });
    // The relay names its heartbeat cadence in the welcome frame; honor it
    // when sane, else the documented 25 s default.
    const announced = frame.heartbeatMs;
    const cadence =
      typeof announced === "number" && Number.isFinite(announced) && announced >= 1_000 && announced <= 300_000
        ? announced
        : fallbackHeartbeatMs;
    heartbeatTimer = setInterval(() => {
      if (!running || socket === null) return;
      sendText(TUNNEL_PING_TEXT);
      armPongWatchdog();
    }, cadence);
    log("info", "cloud.connected", { relayUrl, machineId, heartbeatMs: cadence });
  };

  /** Bridge one relayed request into the TLS device listener. */
  const handleReq = async (frame: Record<string, unknown>): Promise<void> => {
    const id = frame.id;
    if (typeof id !== "string" || id === "") return; // unanswerable → ignored
    const method = typeof frame.method === "string" ? frame.method.toUpperCase() : "";
    const path = typeof frame.path === "string" ? frame.path : "";
    if (method === "" || !path.startsWith("/")) return; // malformed → ignored

    const port = tlsPort();
    if (port === null) {
      // No TLS listener → nothing to bridge into. The phone sees an honest
      // 503-shaped error through the relay.
      sendFrame({
        t: "err",
        id,
        status: 503,
        code: "device_link_disabled",
        message: "the device link listener is not running on the desktop",
      });
      return;
    }

    const headers: Record<string, string> = {};
    if (typeof frame.headers === "object" && frame.headers !== null && !Array.isArray(frame.headers)) {
      const source = frame.headers as Record<string, unknown>;
      for (const name of BRIDGE_FORWARD_REQUEST_HEADERS) {
        const value = source[name];
        if (typeof value === "string" && value !== "") headers[name] = value;
      }
    }
    let body: Buffer | null = null;
    if (typeof frame.b64 === "string" && frame.b64 !== "") {
      try {
        body = Buffer.from(frame.b64, "base64");
      } catch {
        body = null; // a corrupt b64 degrades to a bodyless request
      }
    }

    const abort = new AbortController();
    inflight.add(abort);
    const deadline = setTimeout(
      () => abort.abort(new Error(`local bridge timeout (${BRIDGE_TIMEOUT_MS} ms)`)),
      BRIDGE_TIMEOUT_MS,
    );
    let response: BridgeResponse;
    try {
      response = await raceAbort(
        bridge({
          host: "127.0.0.1",
          port,
          method,
          path,
          headers,
          body,
          signal: abort.signal,
        }),
        abort.signal,
        `local bridge timeout (${BRIDGE_TIMEOUT_MS} ms)`,
      );
    } catch (err) {
      clearTimeout(deadline);
      inflight.delete(abort);
      sendFrame({ t: "err", id, status: 502, code: "bridge_error", message: messageOf(err) });
      return;
    }
    // Headers arrived — the response deadline is satisfied; streaming from
    // here is unbounded by design (see BRIDGE_TIMEOUT_MS's doc).
    clearTimeout(deadline);
    try {
      await respondWithFrames(id, response, abort);
    } catch (err) {
      sendFrame({ t: "err", id, status: 502, code: "bridge_error", message: messageOf(err) });
    } finally {
      inflight.delete(abort);
    }
  };

  const respondWithFrames = async (
    id: string,
    response: BridgeResponse,
    abort: AbortController,
  ): Promise<void> => {
    const contentType = headerOf(response.headers, "content-type") ?? "";
    const status = response.status;

    if (contentType.toLowerCase().includes("text/event-stream")) {
      // SSE: open → live chunks → end (the relay re-injects its own 10 s
      // ": ping" comments on the cloud leg — our chunks stay raw bytes).
      const openHeaders: Record<string, string> = { "content-type": contentType };
      const cacheControl = headerOf(response.headers, "cache-control");
      if (cacheControl !== undefined) openHeaders["cache-control"] = cacheControl;
      sendFrame({ t: "res-open", id, status, headers: openHeaders });
      for await (const chunk of response.stream) {
        sendFrame({ t: "chunk", id, b64: chunk.toString("base64") });
      }
      sendFrame({ t: "end", id });
      return;
    }

    // Buffered: accumulate (capped at 10 MB) → one res frame.
    const parts: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.stream) {
      size += chunk.length;
      if (size > BRIDGE_BODY_CAP_BYTES) {
        // Kill the source (the abort destroys the underlying request) and
        // answer the honest err frame — the phone sees a clean 413.
        abort.abort(new Error("bridged response body exceeded the cap"));
        sendFrame({
          t: "err",
          id,
          status: 413,
          code: "body_too_large",
          message: `bridged response body exceeds ${BRIDGE_BODY_CAP_BYTES} bytes`,
        });
        return;
      }
      parts.push(chunk);
    }
    const body = Buffer.concat(parts);
    const headers: Record<string, string> = {};
    for (const name of BRIDGE_FORWARD_RESPONSE_HEADERS) {
      const value = headerOf(response.headers, name);
      if (value !== undefined) headers[name] = value;
    }
    sendFrame({
      t: "res",
      id,
      status,
      headers,
      // Empty body → no b64 field at all (the relay treats missing as null).
      ...(body.length > 0 ? { b64: body.toString("base64") } : {}),
    });
  };

  const handleFrameText = (text: string | null): void => {
    if (text === null) return;
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      return; // malformed frames are ignored — never fatal
    }
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return;
    const f = frame as Record<string, unknown>;
    switch (f.t) {
      case "welcome":
        handleWelcome(f);
        return;
      case "pong":
        // The edge's heartbeat answer — clears the watchdog. Nothing else
        // about pings is handled (the relay answers ours at the edge; an
        // inbound "ping" frame never reaches a host).
        if (pongWatchdog !== null) {
          clearTimeout(pongWatchdog);
          pongWatchdog = null;
        }
        return;
      case "req":
        // Fire-and-forget with its own catch — a bridging failure must never
        // break the tunnel or the message loop.
        void handleReq(f).catch(() => {
          /* handleReq already answers err frames on every path */
        });
        return;
      case "bye":
      case "hello":
      case "res":
      case "res-open":
      case "chunk":
      case "end":
      case "err":
        // Host-bound frames echoed back — ignored (forward compat).
        return;
      case "kick":
        // Reserved in the relay protocol (eviction rides close 4001 today);
        // log-and-ignore rather than act on an unpinned directive.
        log("info", "cloud.kick_ignored", { relayUrl });
        return;
      default:
        return; // unknown frame types are ignored (forward compat)
    }
  };

  const abortInflight = (reason: string): void => {
    for (const abort of inflight) {
      try {
        abort.abort(new Error(reason));
      } catch {
        // Never fatal.
      }
    }
    inflight.clear();
  };

  const controller: CloudConnector = {
    start(): void {
      if (running) return;
      running = true;
      log("info", "cloud.start", { relayUrl, machineId });
      connect();
    },

    async stop(): Promise<void> {
      running = false;
      generation += 1; // supersede every handler of the live socket
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      clearHeartbeat();
      abortInflight("cloud connector stopped");
      const s = socket;
      socket = null;
      state = "disabled";
      if (s === null) return;
      log("info", "cloud.stop", { relayUrl });
      try {
        s.send(TUNNEL_BYE_TEXT);
      } catch {
        // Already dead — close below is still best-effort.
      }
      // Register the close listener BEFORE close() — a fast (or even
      // synchronous) close handshake must not outrun the wait.
      const closed = new Promise<void>((resolve) => {
        const done = setTimeout(resolve, 500);
        try {
          s.on("close", () => {
            clearTimeout(done);
            resolve();
          });
        } catch {
          clearTimeout(done);
          resolve();
        }
      });
      try {
        s.close(1000, "connector stopped");
      } catch {
        // Never fatal.
      }
      // Give the close frame a moment to flush (the relay answers bye with
      // close 1001); capped so a silent socket can never hang stop().
      await closed;
    },

    status(): CloudConnectorStatus {
      return status();
    },
  };
  return controller;
}

/* ── The module-level singleton (the boot block + settings route drive it;
 *    the mobile routes read its status for the QR's relay field) ──────────── */

let activeConnector: CloudConnector | null = null;
/** Test seam (setCloudConnectorFactoriesForTest) — production leaves null. */
let testFactories: { createTunnelSocket?: TunnelSocketFactory; bridgeRequest?: BridgeClient } | null =
  null;

/** The idle status (nothing started — the settings GET's honest default). */
const DISABLED_STATUS: CloudConnectorStatus = {
  state: "disabled",
  relayUrl: "",
  lastConnectedAt: null,
  lastError: null,
};

/** Start (or REPLACE — a new config wins) the singleton connector. Never
 * throws: any failure is logged and reflected in the returned status.
 * Takes the full options set (the timing knobs + injectable seams) because
 * the spread below has always carried them through — the type now says so. */
export function startCloudConnector(options: CloudConnectorOptions): CloudConnectorStatus {
  const previous = activeConnector;
  if (previous !== null) {
    // Graceful replace: bye + close(1000) ride out in the background while
    // the new tunnel connects (the relay also replaces stale hosts itself).
    void previous.stop();
  }
  try {
    const connector = createCloudConnector({
      ...options,
      ...(testFactories?.createTunnelSocket !== undefined
        ? { createTunnelSocket: testFactories.createTunnelSocket }
        : {}),
      ...(testFactories?.bridgeRequest !== undefined
        ? { bridgeRequest: testFactories.bridgeRequest }
        : {}),
    });
    activeConnector = connector;
    connector.start();
    return connector.status();
  } catch (err) {
    activeConnector = null;
    log("warn", "cloud.start_failed", { message: messageOf(err) });
    return { state: "error", relayUrl: normalizeRelayUrl(options.relayUrl), lastConnectedAt: null, lastError: messageOf(err) };
  }
}

/** Gracefully stop the singleton (no-op when none). Never throws. */
export async function stopCloudConnector(): Promise<CloudConnectorStatus> {
  const connector = activeConnector;
  activeConnector = null;
  if (connector !== null) {
    try {
      await connector.stop();
    } catch (err) {
      log("warn", "cloud.stop_failed", { message: messageOf(err) });
    }
  }
  return getCloudConnectorStatus();
}

/** The settings route's apply path: a clean stop → a fresh start with the
 * new config (no two tunnels racing into one Room). Never throws. */
export async function reconfigureCloudConnector(
  options: CloudConnectorOptions,
): Promise<CloudConnectorStatus> {
  await stopCloudConnector();
  return startCloudConnector(options);
}

/** The singleton's live status (the idle shape when nothing runs). */
export function getCloudConnectorStatus(): CloudConnectorStatus {
  return activeConnector?.status() ?? DISABLED_STATUS;
}

/** Test hook — drop the singleton (graceful background stop) + any injected
 * factories (the resetVapidKeysForTest / resetFcmConfigForTest pattern). */
export function resetCloudConnectorForTest(): void {
  const connector = activeConnector;
  activeConnector = null;
  testFactories = null;
  if (connector !== null) void connector.stop();
}

/** Test hook — install mock tunnel/bridge factories for the SINGLETON paths
 * (route tests intercept the real startCloudConnector/reconfigure calls). */
export function setCloudConnectorFactoriesForTest(factories: {
  createTunnelSocket?: TunnelSocketFactory;
  bridgeRequest?: BridgeClient;
}): void {
  testFactories = { ...factories };
}
