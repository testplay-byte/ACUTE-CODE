/**
 * ROUND-106 (R106-S1, the sidecar mobile-link round): the DEVICE-LINK
 * CONTROLLER — the second, TLS listener that carries the whole mobile
 * surface (docs/planning/LINKING-PROTOCOL.md, ANDROID-R3-OWNER-RULINGS.md
 * §1.2 + §3.1).
 *
 * DUAL-LISTENER ARCHITECTURE — the mechanism decision, stated once here:
 * the device listener is a plain `node:https` server whose request handler
 * is Fastify's PUBLIC `app.routing(req, res)` API (fastify 5.12: instance.d.ts
 * declares `routing(req: RawRequest, res: RawReply): void`; fastify.js
 * binds `routing: httpHandler` — the EXACT function fastify itself hands to
 * `https.createServer(httpsOptions, httpHandler)` in lib/server.js). Routing
 * into the ONE real Fastify instance means every route, every in-memory
 * singleton (turn registry, notification bus, dialogs, approval waiters) is
 * shared with the loopback listener — no second app, no state duplication,
 * no drift between what the desktop window and the phone can see. The
 * alternative (a second Fastify instance from the same factory) was rejected
 * because those singletons are per-instance state and would fork the truth.
 *
 * The loopback plaintext listener (127.0.0.1, ephemeral port, portal file,
 * webview + CLI attach) is UNTOUCHED and stays the default: this controller
 * only exists when device links are enabled (settings key `deviceLink.enabled`
 * or the ACUTE_HOST boot override), and its listener is dynamically
 * startable/stoppable at runtime — a settings flip never needs a process
 * restart.
 *
 * PAIRING SESSIONS also live here (per-server in-memory state, 120-second
 * TTL, single-use, 5-wrong-PIN ceiling — LINKING-PROTOCOL §2/§5).
 */
import { randomBytes } from "node:crypto";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ensureDeviceCertificate, lanIPv4Addresses } from "./device-cert.js";

/**
 * ROUND-106 (R106-S1): did this request ride the TLS device listener?
 * `socket.encrypted` is Node's own TLSSocket flag — the same property
 * fastify's internal protocol getter reads (`this.socket.encrypted ? 'https'
 * : 'http'`). The cast is needed because the static type of a request socket
 * is the base `net.Socket` (the flag only exists on TLSSocket); and
 * inject()'s mock socket leaves it undefined, which is exactly right —
 * injected/plain requests did NOT arrive on the device listener, and the
 * unauthenticated claim route must reject them.
 */
export function requestArrivedOverTls(request: FastifyRequest): boolean {
  const socket: unknown = request.socket;
  return (
    typeof socket === "object" &&
    socket !== null &&
    (socket as { encrypted?: unknown }).encrypted === true
  );
}

/** The pairing window (LINKING-PROTOCOL: the 120-second PIN TTL). */
export const PAIRING_TTL_MS = 120_000;

/** The documented brute-force ceiling — the 5th wrong PIN kills the session. */
export const PAIRING_MAX_ATTEMPTS = 5;

/* ── ROUND-112 (R112-a, the R110 disconnect-loop fix #2): the keep-alive
 * tuning BOTH listeners boot with. Node's DEFAULT keepAliveTimeout is 5 s,
 * which collides head-on with the phone's 5-minute OkHttp connection pool:
 * the pool hands OkHttp a socket the server has just reclaimed, every
 * retryOnConnectionFailure is disabled, and the phone reads a dead socket
 * as "disconnected" — the reconnect loop's root cause #2. 65 s keeps the
 * server's idle sockets open LONGER than any pooled client would ever
 * reuse them; headersTimeout must EXCEED keepAliveTimeout (Node's own
 * invariant — the request-header deadline has to outlive the idle window)
 * and 66 s does. */
export const DEVICE_LISTENER_KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const DEVICE_LISTENER_HEADERS_TIMEOUT_MS = 66_000;

/** PIN length — 8 numeric digits (LINKING-PROTOCOL §2). */
const PIN_DIGITS = 8;

export interface PairingSession {
  /** 8-digit numeric PIN, crypto-random without modulo bias. */
  pin: string;
  /** Epoch ms — the session's hard expiry. */
  expiresAt: number;
  /** Wrong-PIN attempts consumed so far (ceiling PAIRING_MAX_ATTEMPTS). */
  attempts: number;
}

/** The routes' view of a live pairing session (never the attempts count). */
export interface PairingSnapshot {
  pin: string;
  expiresAt: number;
}

export interface DeviceLinkStatus {
  /** True when the TLS listener is listening. */
  enabled: boolean;
  /** The bound ephemeral port (null when stopped). */
  port: number | null;
  /** The machine's LAN IPv4 addresses (fresh per call). */
  addrs: string[];
  /** The pinned SHA-256 fingerprint (null before the first start). */
  certFP: string | null;
  /** The stable per-machine id (null before the first start). */
  machineId: string | null;
}

export interface DeviceLinkController {
  /** Boot (or re-report) the TLS listener. Resolves with the live status;
   * throws when the cert can't be produced or the port can't bind — the
   * caller (the settings PUT / startServer boot) keeps `enabled` OFF then. */
  start(): Promise<DeviceLinkStatus>;
  /** Stop the listener (idempotent). Never throws. */
  stop(): Promise<DeviceLinkStatus>;
  /** Current status snapshot (addrs recomputed fresh). */
  status(): DeviceLinkStatus;
  /** R110/R112-a: the HTTP keep-alive tuning this listener booted with
   * (null while stopped) — published so tests and the diagnostics surface
   * can assert the disconnect-loop fix is actually applied to the socket. */
  transportTuning(): { keepAliveTimeout: number; headersTimeout: number } | null;
  /** The active cert/machineId when the cert was ever loaded (boot-loaded so
   * link-info can report identity even while the listener is OFF). */
  identity(): { certFP: string; machineId: string } | null;
  /** Create the ONE active pairing session (invalidates any prior). Returns
   * null while the link is off — pairing needs the live TLS listener. */
  beginPairing(): PairingSnapshot | null;
  /** The still-valid session snapshot, or null (expired/consumed/none). */
  activePairing(): PairingSnapshot | null;
  /**
   * A claim attempt against the active session.
   *   · "claimed"    — the PIN matched; the session is CONSUMED (single-use)
   *                    and the caller mints the device token.
   *   · "wrong-pin"  — the attempt counted; `attemptsLeft` names the
   *                    remaining tries (0 = the session just died).
   *   · "gone"       — no live session (expired, consumed, never started, or
   *                    the 6th attempt after the ceiling) → the route's 410.
   */
  attemptClaim(pin: string): { result: "claimed" } | { result: "wrong-pin"; attemptsLeft: number } | { result: "gone" };
  /** Drop any active pairing session (stop() housekeeping). */
  clearPairing(): void;
}

/** 8-digit numeric PIN without modulo bias: rejection sampling over the
 * uint32 space (values ≥ the largest multiple of 10^8 are discarded, so
 * every digit string is exactly equiprobable — a modulo-only approach
 * would bias the low digits). */
export function generatePairingPin(): string {
  const space = 10 ** PIN_DIGITS;
  // Largest multiple of `space` that fits a uint32 — anything at or above
  // it would wrap the distribution; reject and redraw.
  const limit = Math.floor(0x1_0000_0000 / space) * space;
  let value = randomUint32();
  while (value >= limit) {
    value = randomUint32();
  }
  return String(value % space).padStart(PIN_DIGITS, "0");
}

function randomUint32(): number {
  // crypto.randomBytes(4) → big-endian uint32 (crypto.randomInt would work
  // too; bytes keep the bias math explicit and testable).
  const buf = randomBytes(4);
  return buf.readUInt32BE(0);
}

export interface DeviceLinkOptions {
  /** The machine-scoped data dir (cert file lives next to vapid.json). */
  dataDir: string;
  /** The ONE Fastify instance every listener routes into (see header). */
  app: FastifyInstance;
}

/* The controller registry, keyed by the Fastify instance it routes into.
 * buildServer creates the controller (routes need it via RouteContext);
 * startServer looks it back up for the boot-time enable check (persisted
 * setting + ACUTE_HOST) without widening buildServer's return type. */
const controllerByApp = new WeakMap<FastifyInstance, DeviceLinkController>();

/** The controller buildServer created for THIS app, when one exists
 * (dataDir undefined = no controller = loopback-only sidecar). */
export function deviceLinkControllerFor(app: FastifyInstance): DeviceLinkController | null {
  return controllerByApp.get(app) ?? null;
}

/** Build the controller. The cert is loaded lazily on first start() — the
 * loopback-only default never pays the generation cost. */
export function createDeviceLinkController(options: DeviceLinkOptions): DeviceLinkController {
  const { dataDir, app } = options;
  let server: HttpsServer | null = null;
  let port: number | null = null;
  let identity: { certFP: string; machineId: string } | null = null;
  let session: PairingSession | null = null;

  const liveSession = (): PairingSession | null => {
    if (session === null) return null;
    if (Date.now() >= session.expiresAt) {
      session = null; // lazy expiry — the TTL is enforced on read
      return null;
    }
    return session;
  };

  const currentStatus = (): DeviceLinkStatus => ({
    enabled: server !== null,
    port,
    addrs: lanIPv4Addresses(),
    certFP: identity?.certFP ?? null,
    machineId: identity?.machineId ?? null,
  });

  const controller: DeviceLinkController = {
    async start(): Promise<DeviceLinkStatus> {
      if (server !== null && port !== null) return currentStatus();
      // Routes must be registered before the first request can be routed
      // (buildServer's register()s land on avvio's boot); ready() is the
      // documented gate and is idempotent once booted.
      await app.ready();
      const certMaterial = await ensureDeviceCertificate(dataDir);
      identity = { certFP: certMaterial.certFP, machineId: certMaterial.machineId };
      const tls = createHttpsServer(
        { key: certMaterial.key, cert: certMaterial.cert },
        (req, res) => {
          // THE mechanism (see module header): the same httpHandler fastify
          // itself installs on its own listener.
          app.routing(req, res);
        },
      );
      // R112-a (the R110 disconnect-loop fix): keep idle keep-alive sockets
      // open for 65 s — see the DEVICE_LISTENER_* constants above.
      tls.keepAliveTimeout = DEVICE_LISTENER_KEEP_ALIVE_TIMEOUT_MS;
      tls.headersTimeout = DEVICE_LISTENER_HEADERS_TIMEOUT_MS;
      // A plaintext probe against the TLS port (or a broken handshake) must
      // never crash the sidecar — log at debug level and drop the socket.
      tls.on("tlsClientError", (err) => {
        console.error("[device-link] tls client error (ignored):", err.message);
      });
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException): void => {
          reject(err);
        };
        tls.once("error", onError);
        tls.listen(0, "0.0.0.0", () => {
          tls.off("error", onError);
          resolve();
        });
      });
      server = tls;
      const address = tls.address();
      port = address !== null && typeof address === "object" ? address.port : null;
      if (port === null) {
        // Address went away between listen and read — treat as bind failure.
        tls.close();
        server = null;
        throw new Error("device listener failed to bind a TCP port");
      }
      return currentStatus();
    },

    async stop(): Promise<DeviceLinkStatus> {
      const tls = server;
      server = null;
      port = null;
      session = null;
      if (tls !== null) {
        await new Promise<void>((resolve) => {
          // Drain in-flight requests; force lingering keep-alives shut so
          // tests and runtime toggles never hang on idle sockets.
          tls.close(() => resolve());
          if (typeof tls.closeAllConnections === "function") tls.closeAllConnections();
          if (typeof tls.closeIdleConnections === "function") tls.closeIdleConnections();
        });
      }
      return currentStatus();
    },

    status(): DeviceLinkStatus {
      return currentStatus();
    },

    transportTuning(): { keepAliveTimeout: number; headersTimeout: number } | null {
      return server === null
        ? null
        : { keepAliveTimeout: server.keepAliveTimeout, headersTimeout: server.headersTimeout };
    },

    identity(): { certFP: string; machineId: string } | null {
      return identity;
    },

    beginPairing(): PairingSnapshot | null {
      // Pairing without the live TLS listener is meaningless — the claim
      // would have nowhere to land (the 403 TLS gate below the routes).
      if (server === null) return null;
      const expiresAt = Date.now() + PAIRING_TTL_MS;
      session = { pin: generatePairingPin(), expiresAt, attempts: 0 };
      return { pin: session.pin, expiresAt };
    },

    activePairing(): PairingSnapshot | null {
      const live = liveSession();
      return live === null ? null : { pin: live.pin, expiresAt: live.expiresAt };
    },

    attemptClaim(pin: string): { result: "claimed" } | { result: "wrong-pin"; attemptsLeft: number } | { result: "gone" } {
      const live = liveSession();
      if (live === null) return { result: "gone" };
      if (pin !== live.pin) {
        live.attempts += 1;
        const attemptsLeft = PAIRING_MAX_ATTEMPTS - live.attempts;
        if (attemptsLeft <= 0) {
          // The documented ceiling: the 5th wrong PIN invalidates the
          // session entirely — subsequent claims see "gone" (410).
          session = null;
        }
        return { result: "wrong-pin", attemptsLeft: Math.max(attemptsLeft, 0) };
      }
      // Correct PIN — single-use: consume before the caller mints anything.
      session = null;
      return { result: "claimed" };
    },

    clearPairing(): void {
      session = null;
    },
  };
  controllerByApp.set(app, controller);
  return controller;
}
