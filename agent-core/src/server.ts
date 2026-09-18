/**
 * Sidecar HTTP server (API.md; ADR-0006). Wave 1: health + bearer-token auth +
 * agent registry CRUD. Wave 2 adds the provider registry (keyring-backed) and
 * single-agent sessions/chat. WebSocket and the remaining resources come in
 * later waves.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
import { aiSdkChat, type ChatFn } from "./agents/chat.js";
import { pickFiles, pickFolder } from "./dialogs.js";
import { ProviderKeyring } from "./providers/registry.js";
import { getProject } from "./storage/projects.js";
import { getSession } from "./storage/sessions.js";
import { Orchestrator } from "./agents/orchestrator.js";
import {
  getApproval,
  listApprovals,
  resolvePendingApproval,
  setApprovalStatus,
  sweepStaleApprovals,
} from "./approvals.js";
import { log } from "./lib/log.js";
// ROUND-45 (audit P0-3): every spawned child gets a scrubbed environment.
import { buildChildEnv } from "./lib/child-env.js";
// ROUND-45 (R45-b): persistent interactive terminal sessions (PTY primary,
// persistent-pipe fallback) — the registry the terminal-sessions routes below
// drive; terminalSessionsDisposeAll is wired into app shutdown.
import {
  getTerminalSessions,
  terminalSessionsDisposeAll,
  type TerminalSessionDescriptor,
} from "./terminal-sessions.js";
import { listSnapshots, restoreSnapshot, getSnapshotBySeq } from "./storage/snapshots.js";
// ROUND-61 (R61): computer use, skills, MCP — the extension surface.
import {
  getComputerUseSettings,
  setComputerUseSettings,
} from "./storage/computer-use.js";
// ROUND-66 (R66-2-b): the DEDICATED image-analysis (vision) settings — the
// owner's B3+B5 directive moved the vision model OUT of computer use into
// its own section. The KEY stays on the R61 keyring slot ("<id>-vision").
import { getVisionSettings, setVisionSettings, visionKeyringId } from "./storage/vision.js";
import { describeRaster } from "./computer/vision.js";
import { getComputerSession } from "./computer/session.js";
// ROUND-67 (R67-D): the ephemeral raster registry the live screenshot
// THUMBNAILS route below reads (in-memory only, LRU 12, 10-minute TTL —
// never persisted, never model-facing).
import { rasterFor } from "./computer/raster-cache.js";
import { backendForPlatform, realRunner } from "./computer/backends/index.js";
import {
  listMcpServers,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  getMcpServer,
} from "./storage/mcp.js";
import {
  listServerTools,
  probeServer,
  resetServerFailure,
  stopServer,
} from "./mcp/manager.js";
import { builtInToolCatalog, BUILT_IN_PLUGINS, externalPluginFileReport } from "./tools/registry.js";
import { getIndexSummary } from "./storage/index.js";
import { openDatabase, type SqliteDatabase } from "./storage/db.js";
// ROUND-40: notifications (task complete/failed, permission requests,
// sub-agent transitions). The bus is the in-process pub/sub; the storage
// module is the durable SQLite record + REST read/mark-read surface.
import { getNotificationBus } from "./lib/notification-bus.js";
import {
  countUnreadNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "./storage/notifications.js";
// ROUND-42: Web Push delivery (desktop notifications with the app window
// CLOSED — the service worker wakes on push and shows the OS notification).
import {
  deletePushSubscription,
  ensureVapidKeys,
  savePushSubscription,
  sendPushToAll,
  vapidPublicKey,
} from "./lib/web-push.js";
import { dirname, join } from "node:path";
// ROUND-43 (R43-10): embedded-browser proxy backend — all logic + routes live
// in browser-proxy.ts; server.ts only mounts it on the scoped API surface.
import { registerBrowserRoutes } from "./browser-proxy.js";
// ROUND-66 (R66, A4): the human-verification checkpoint registry (the
// wait_for_verification browser tool pends on it; the resolve route below is
// the chat card's answer channel).
import { resolveBrowserCheckpoint } from "./browser-checkpoint.js";
// ROUND-52 (R52-a): the background-job registry (GET /projects/:id/jobs,
// POST /jobs/:id/stop).
import { getJobStatus, listJobs, stopJob } from "./lib/background-jobs.js";
import { errorBody } from "./routes/helpers.js";
import { DIAGNOSTICS_RING_CAP, setDeviceAuth, type RouteContext, type SidecarDiagnosticError } from "./routes/context.js";
// ROUND-84 (R84, Wave 2-a): the domain route modules — server.ts is now
// the assembler; each module registers its routes verbatim (registration
// order preserved; the shared context lives in routes/context.ts).
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerProjectRoutes } from "./routes/projects.js";

import { registerProviderRoutes } from "./routes/providers.js";
import { registerModelRoutes } from "./routes/models.js";
// R84 (Wave 2-a, phase 4): the small CRUD domains continue the split.
import { registerModeRoutes } from "./routes/modes.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerRatingRoutes } from "./routes/ratings.js";
import { registerSkillRoutes } from "./routes/skills.js";
// R98-E1: the prompt-customization domain (GET/PUT/DELETE /prompts/sections
// + GET /prompts/preview — the Settings Prompts tab's backend over the
// R59-F override engine).
import { registerPromptRoutes } from "./routes/prompts.js";
import { registerUsageRoutes } from "./routes/usage.js";
// R87: the system domain (POST /system/reset — the application-wide reset).
import { registerSystemRoutes } from "./routes/system.js";
// R87: the agent-question domain (ask_user's REST resolve route).
import { registerQuestionRoutes } from "./routes/questions.js";
import { registerTodoRoutes } from "./routes/todo.js";
import { registerAttachmentRoutes } from "./routes/attachments.js";
import { registerSettingsRoutes } from "./routes/settings.js";
// R86: the SSE domain — the streamed turn route (final-phase extraction).
import { registerSseRoutes } from "./routes/sse.js";
// ROUND-106 (R106-S1, the mobile-link round): the Android companion's
// linking surface — pair/start + pair/claim + the device list/revoke +
// link-info (routes/mobile.ts), the TLS device-listener controller
// (lib/device-link.ts — the dual-listener architecture), the multi-token
// bearer wall's device-token lookup (storage/mobile-devices.ts), and the
// FCM fan-out leg (lib/fcm-push.ts — the dormant no-op). The whole mobile
// link is OFF by default: the loopback plaintext sidecar below stays
// byte-identical in behavior until the owner flips deviceLink.enabled.
import { registerMobileRoutes } from "./routes/mobile.js";
import {
  createDeviceLinkController,
  deviceLinkControllerFor,
  requestArrivedOverTls,
} from "./lib/device-link.js";
import {
  findMobileDeviceByTokenHash,
  hashDeviceToken,
  touchMobileDeviceLastSeen,
} from "./storage/mobile-devices.js";
import { getDeviceLinkSettings, setDeviceLinkSettings } from "./storage/settings.js";
import { publishFcm } from "./lib/fcm-push.js";
// R106-S1: the app version (ROUND-63's readAppVersion) moved to
// lib/version.ts so routes/mobile.ts can share it without an import cycle;
// re-exported here — every existing `import { VERSION } from "../server"`
// keeps working.
import { VERSION } from "./lib/version.js";
export { VERSION };

/**
 * ROUND-63: the app version GET /health reports — read at BOOT from the
 * package.json that sits NEXT TO the compiled code (agent-core/package.json
 * in the dev workspace; sidecar/app/package.json inside the installed
 * desktop app, where the staging step copies the exact version). ROUND-106
 * (R106-S1): the definition moved verbatim to lib/version.ts (shared with
 * routes/mobile.ts without an import cycle); see the re-export above.
 */

/**
 * ROUND-42 → ROUND-52 (R52-b): registry of live streamed turns, keyed by
 * session id — powers POST /sessions/:id/stop (the UI Stop button). Since
 * R52-b the map lives in lib/turn-registry.ts and is SHARED with the
 * orchestrator, so a sub-agent's child turn is registrable and stoppable
 * exactly like a main turn (the owner: "I should be given options to stop
 * the sub-agents in a similar way too").
 */

// ── ROUND-59 (R59-E): the sidecar's DIAGNOSTICS ERROR RING ────────────────
// The owner: "proper console-like error monitoring and error handling… If
// there are any errors along the way then you can easily detect them by
// yourself." The frontend half lives in src/lib/error-bus.ts; this is the
// ENGINE half — every THROWN request error (status ≥ 500) lands in an
// in-memory ring that GET /diagnostics/errors serves to the right-sidebar
// Console tab, so engine failures and frontend failures read in ONE place.

/** Message cap per row — stacks and blobs stay bounded. */
const DIAGNOSTIC_MESSAGE_CAP = 2_000;

/**
 * Scrub secret-shaped text OUT of ring messages before capture. The ring is
 * served to the UI verbatim and copied to the clipboard from the console — a
 * bearer token or provider key embedded in a thrown error's message must
 * never leave through it. (Request BODIES and auth HEADERS are never
 * captured at all — the recorder only sees status/code/message/method/path.)
 */
function scrubDiagnosticText(text: string): string {
  let out = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer ***");
  out = out.replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "sk-***");
  if (out.length > DIAGNOSTIC_MESSAGE_CAP) {
    out = `${out.slice(0, DIAGNOSTIC_MESSAGE_CAP)}… (truncated ${out.length - DIAGNOSTIC_MESSAGE_CAP} chars)`;
  }
  return out;
}

/** Constant-time bearer comparison; the token is per-spawn and loopback-only. */
function isAuthorized(header: unknown, token: string): boolean {
  if (typeof header !== "string") return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function isHealthRequest(method: string, url: string): boolean {
  return method === "GET" && url.split("?")[0] === "/health";
}

/**
 * ROUND-106 (R106-S1): the paths that skip the bearer wall entirely —
 * GET /health (the shell's probe) + POST /api/v1/mobile/pair/claim (the
 * phone's ONE unauthenticated pairing hop). The claim path is gated
 * SEPARATELY and more strictly inside routes/mobile.ts: a claim that did
 * not arrive over the TLS device listener dies with 403 BEFORE any session
 * state is touched — so a device token can never be minted over (or ride)
 * the plaintext loopback listener.
 */
function isUnauthenticatedRequest(method: string, url: string): boolean {
  if (isHealthRequest(method, url)) return true;
  return method === "POST" && url.split("?")[0] === "/api/v1/mobile/pair/claim";
}

/**
 * ROUND-106 (R106-S1): the DEVICE-TOKEN leg of the multi-token bearer wall.
 * A presented `Authorization: Bearer <token>` that is not the shell token
 * is hashed (SHA-256 hex) and looked up in mobile_devices — found + not
 * revoked (revocation is DELETE) = valid. On success the device row's id
 * is recorded on the request (routes/context.ts's deviceAuth WeakMap) so
 * shell-only routes can 403 device-token requests, and lastSeenAt is
 * refreshed THROTTLED (a write only when >60s since that device's last).
 *
 * WHY LOOKUP-BY-HASH IS NOT A TIMING ORACLE (the documented rationale):
 * the attacker-controlled input is the TOKEN STRING, but the lookup key is
 * its SHA-256 digest — avalanche makes the digest uniformly distributed
 * over the table REGARDLESS of attacker input, so unlike a prefix/timing
 * comparison there is no way to steer probes toward early-vs-late B-tree
 * positions or adaptively refine a guess (the hash destroys all structure
 * of the guess). The tokens themselves are 32 random bytes — nothing
 * enumerable. The SHELL-token leg above stays constant-time
 * (timingSafeEqual) because THAT comparison touches the secret directly;
 * this leg's discipline is "hash, then O(log n) on an unsteerable key".
 */
function authorizeDeviceToken(
  db: SqliteDatabase,
  header: unknown,
): { deviceId: string } | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/.exec(header);
  if (match === null) return null;
  const row = findMobileDeviceByTokenHash(db, hashDeviceToken(match[1]));
  if (row === undefined) return null;
  try {
    touchMobileDeviceLastSeen(db, row.id);
  } catch {
    // A lastSeen hiccup must never reject an otherwise-valid request.
  }
  return { deviceId: row.id };
}

/** The full multi-token wall check (shell token OR device token). */
function isRequestAuthorized(
  db: SqliteDatabase,
  request: FastifyRequest,
  token: string,
): boolean {
  if (isAuthorized(request.headers.authorization, token)) return true;
  const device = authorizeDeviceToken(db, request.headers.authorization);
  if (device !== null) {
    setDeviceAuth(request, device);
    return true;
  }
  return false;
}

export interface ServerOptions {
  token: string;
  db: SqliteDatabase;
  /** ROUND-42: directory for machine-scoped files (VAPID keypair). Defaults
   * to undefined — push endpoints then respond 503 (tests use this to stay
   * hermetic). The real sidecar passes the SQLite file's directory. */
  dataDir?: string;
  /** Snapshots `ACUTE_PROVIDER_*` env vars; defaults to the spawn environment. */
  keyring?: ProviderKeyring;
  /** Chat function used by session turns; defaults to the AI SDK adapter. */
  chat?: ChatFn;
}

/** Builds the Fastify app without binding a port (tests drive it with inject()). */
export function buildServer(options: ServerOptions): FastifyInstance {
  const { token, db } = options;
  const keyring = options.keyring ?? new ProviderKeyring();
  const chat = options.chat ?? aiSdkChat;
  const app = Fastify();

  // ROUND-42: Web Push init. The VAPID keypair is generated ONCE and
  // persisted at <dataDir>/vapid.json. Every published notification is
  // fanned out to every subscribed browser (fire-and-forget — a push
  // failure can never break a turn). ROUND-106 (R106-S1): the fan-out gains
  // ONE more destination — publishFcm, the FCM publisher skeleton (a
  // graceful no-op until the owner's Firebase credentials arrive with the
  // remote-access round; it resolves immediately and NEVER throws, so the
  // fan-out shape is unchanged).
  if (options.dataDir !== undefined) {
    const dataDir = options.dataDir;
    ensureVapidKeys(dataDir);
    getNotificationBus().subscribe((n) => {
      try {
        sendPushToAll(db, n);
      } catch (err) {
        console.error("[web-push] fanout threw:", err);
      }
      // R106-S1: the FCM leg — ping-only payloads someday, a no-op today.
      void publishFcm(dataDir, n);
    });
  }

  // ROUND-36 (ADR-0022 §3): a dead sidecar leaves `running` sessions — flip
  // them to failed so they're retryable. Idempotent at every boot.
  Orchestrator.sweepStaleRunning(db);

  // ROUND-37 (ADR-0024): crash-orphaned pending approvals fail closed.
  const swept = sweepStaleApprovals(db);
  if (swept > 0) log("info", "boot.approvals_swept", { swept });

  // CORS: loopback-only product, but the webview (tauri.localhost) and the
  // dev vite server (localhost:5173) are cross-origin callers — without
  // these headers the browser blocks every response ("Failed to fetch").
  // Strict origin allowlist; unknown origins get no CORS headers.
  const CORS_ORIGINS = new Set([
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    // ROUND-52 (live-battery): the IPv6 loopback literal — vite binds ::1 on
    // some hosts and opening the dev server by its literal origin then sends
    // Origin: http://[::1]:5173, which previously failed every preflight
    // (401 from the bearer wall) and silently fell the app back to demo data.
    "http://[::1]:5173",
  ]);
  /**
   * CORS headers for a request Origin when it is allow-listed; `{}` otherwise.
   * Shared by the onRequest hook AND the hijacked SSE streaming route —
   * reply.hijack() bypasses Fastify's reply serialization, so headers set via
   * reply.header() BEFORE hijack are silently DROPPED from the raw response.
   * Without this, the streaming POST returns no Access-Control-Allow-Origin,
   * the browser blocks the response, and fetch() rejects with "Failed to
   * fetch" on EVERY streamed message (owner-reported round-30 Windows bug).
   */
  const corsHeadersFor = (origin: unknown): Record<string, string> => {
    if (typeof origin === "string" && CORS_ORIGINS.has(origin)) {
      return {
        "access-control-allow-origin": origin,
        "access-control-allow-headers": "authorization, content-type",
        // ROUND-49: PUT was missing from the allow-methods list — every
        // cross-origin PUT (Settings → Advanced toggles, key-pool slots,
        // viewport PUTs) died at preflight with "Failed to fetch" while
        // GET/POST/PATCH worked. Found live while verifying the new memory
        // master switch in the browser.
        "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      };
    }
    return {};
  };
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin === "string" && CORS_ORIGINS.has(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-headers", "authorization, content-type");
      reply.header("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      if (request.method === "OPTIONS") {
        return reply.code(204).send();
      }
    }
  });

  // ARCHITECTURE §2.3/§7: every route except GET /health requires the bearer
  // token. ROUND-106 (R106-S1): the token may now be the SHELL token (the
  // constant-time compare, unchanged) OR a paired DEVICE token (the
  // hash-lookup leg — see authorizeDeviceToken). With device links OFF
  // (nobody paired) the device leg finds nothing and every response stays
  // byte-identical to the pre-R106 wall. The claim exemption
  // (isUnauthenticatedRequest) is the phone's ONE unauthenticated hop; the
  // TLS-socket gate inside routes/mobile.ts keeps it off plaintext forever.
  app.addHook("preHandler", async (request, reply) => {
    if (isUnauthenticatedRequest(request.method, request.url)) return;
    if (!isRequestAuthorized(db, request, token)) {
      return reply
        .code(401)
        .send(errorBody("UNAUTHORIZED", "missing or invalid bearer token"));
    }
  });

  // Unknown paths keep the token wall too; known+authed misses get the envelope.
  app.setNotFoundHandler((request, reply) => {
    if (!isUnauthenticatedRequest(request.method, request.url) && !isRequestAuthorized(db, request, token)) {
      return reply
        .code(401)
        .send(errorBody("UNAUTHORIZED", "missing or invalid bearer token"));
    }
    return reply
      .code(404)
      .send(errorBody("NOT_FOUND", `no route for ${request.method} ${request.url.split("?")[0]}`));
  });

  // Everything unexpected still comes back in the uniform envelope.
  const codeByStatus: Record<number, string> = {
    400: "VALIDATION",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "CONFLICT",
    422: "VALIDATION",
    429: "RATE_LIMITED",
    502: "PROVIDER_ERROR",
  };
  // R59-E: the engine's error ring (per-buildServer instance — every test
  // server gets a fresh one). Thrown route-handler errors funnel through
  // this error handler by fastify's design, so ONE recorder here covers
  // them all; the app-level 4xx replies (validation, auth, not-found) never
  // pass through and never pollute the ring.
  const diagnosticsRing: SidecarDiagnosticError[] = [];
  /**
   * R59-E + DECISION (from the live battery): record ONLY status ≥ 500 —
   * 4xx is client noise (bad input, unknown ids, wrong token), not an
   * engine error, and the console would drown in them on every owner typo.
   * A thrown error without a statusCode fastifies to 500, so "route handler
   * throws" land here by default. Only status/code/message/method/path are
   * captured — never request bodies, never auth headers.
   */
  const recordDiagnosticError = (
    request: FastifyRequest,
    statusCode: number,
    code: string,
    message: string,
  ): void => {
    if (statusCode < 500) return;
    diagnosticsRing.unshift({
      id: randomUUID(),
      ts: new Date().toISOString(),
      source: "sidecar",
      kind: "http",
      statusCode,
      code,
      message: scrubDiagnosticText(message),
      method: request.method,
      // Strip the query string — params (e.g. ?url= on the browser proxy)
      // are request data, not diagnostics.
      url: request.url.split("?")[0],
      count: 1,
    });
    if (diagnosticsRing.length > DIAGNOSTICS_RING_CAP) diagnosticsRing.pop();
  };
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    // R59-E: the diagnostics ring capture point (status ≥ 500 only).
    recordDiagnosticError(
      request,
      status,
      error.code ?? codeByStatus[status] ?? "INTERNAL",
      error.message,
    );
    if (status >= 500) {
      const correlationId = randomUUID();
      request.log.error({ err: error, correlationId });
      return reply
        .status(500)
        .send(errorBody("INTERNAL", `internal error (correlation id: ${correlationId})`));
    }
    return reply
      .status(status)
      .send(errorBody(codeByStatus[status] ?? "INTERNAL", error.message));
  });
  // R84 (Wave 2-a): the shared per-server context handed to every domain
  // route module below (routes/context.ts). Each register function
  // destructures only what its domain uses. R106-S1: + mobileLink — the
  // device-link controller, built ONLY when a machine data dir exists
  // (loopback-only/hermetic builds stay link-free by construction).
  const mobileLink =
    options.dataDir !== undefined
      ? createDeviceLinkController({ dataDir: options.dataDir, app })
      : undefined;
  // R106-S1: the TLS listener is OURS (not fastify's), so ITS teardown is
  // registered right where it is created — every app.close() (tests,
  // startServer's failure path, the shell's graceful teardown) stops the
  // device listener too; a leaked 0.0.0.0 socket must never outlive its app.
  if (mobileLink !== undefined) {
    app.addHook("onClose", async () => {
      await mobileLink.stop();
    });
  }
  const ctx: RouteContext = {
    token,
    db,
    keyring,
    chat,
    corsHeadersFor,
    diagnosticsRing,
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
    ...(mobileLink !== undefined ? { mobileLink } : {}),
  };


  // GET /health — TWO honest shapes, ONE route (R106-S1). The loopback
  // listener's shape is BYTE-IDENTICAL to the pre-R106 contract (the shell
  // and every existing test pin it). A request that rode the TLS device
  // listener (requestArrivedOverTls — Node's TLSSocket flag, the same one
  // fastify's own protocol getter reads) is the phone's unauthenticated
  // reachability probe and gets the richer linkMode shape:
  // {ok, version, machineId, linkMode} — NOTHING sensitive (no addresses,
  // no ports, no pairing state; the phone pairs by QR, never by discovery).
  app.get("/health", async (request) => {
    if (requestArrivedOverTls(request)) {
      return {
        ok: true,
        version: VERSION,
        machineId: mobileLink?.identity()?.machineId ?? null,
        linkMode: true,
      };
    }
    return {
      status: "ok",
      app: "acute-code",
      version: VERSION,
    };
  });

  // Internal key handoff (API.md §2.3): ONLY the Tauri shell calls this —
  // same bearer wall as everything else — to rotate a provider key inside
  // the in-memory keyring right after Credential Manager is updated, so a
  // connection test immediately reflects a freshly saved key. The key value
  // is never logged and never echoed back.
  app.post("/internal/providers/keys", async (request, reply) => {
    const body = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    const raw = body as Record<string, unknown>;
    const providerId = raw.providerId;
    const value = raw.value;
    const action = raw.action === undefined ? "set" : raw.action;
    if (typeof providerId !== "string" || !/^[a-z0-9_-]+$/.test(providerId)) {
      return reply.code(400).send(
        errorBody("VALIDATION", "body.providerId must be a lowercase slug", {
          field: "body.providerId",
        }),
      );
    }
    if (typeof value !== "string" || value === "") {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body.value must be a non-empty string", { field: "body.value" }));
    }
    if (action !== "set" && action !== "delete") {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body.action must be 'set' or 'delete'", { field: "body.action" }));
    }
    // ROUND-92 (R92-D, the 1-c Rust contract — store_provider_key_slot's hot
    // handoff): the optional `slot` field routes the value to a POOL slot
    // (ACUTE_PROVIDER_<ID>_SLOT<N>) instead of the primary. Absent / 0 keeps
    // the legacy primary path (store_provider_key's payload carries no slot;
    // setSlot(id, 0, …) IS set()). 'delete' clears the named slot
    // symmetrically (the sentinel-value route). The bounds mirror the
    // PUT /providers/:id/keys/:slot route (the keyring scans slots 0..31).
    // `keyName` ("pool") rides along unvalidated — informational only.
    let slot = 0;
    if (raw.slot !== undefined) {
      if (typeof raw.slot !== "number" || !Number.isInteger(raw.slot) || raw.slot < 0 || raw.slot > 31) {
        return reply.code(400).send(
          errorBody("VALIDATION", "slot must be an integer between 0 and 31", {
            field: "body.slot",
          }),
        );
      }
      slot = raw.slot;
    }
    keyring.setSlot(providerId, slot, action === "delete" ? "" : value);
    return reply.code(204).send();
  });

  // Native OS folder picker (round-14/15): the sidecar opens the REAL dialog
  // (PowerShell FolderBrowserDialog + Shell fallback / zenity / kdialog) so
  // folder selection works even in browser dev (no Tauri). Same bearer wall
  // as everything else. 200 {path, error?} — path null + no error = user
  // cancelled; error set = the dialog FAILED (UI shows the cause); 501
  // DIALOG_UNAVAILABLE only when this machine has no dialog backend.
  // Never hit by tests: the dialog blocks on a human.
  app.post("/internal/dialog/folder", async (_request, reply) => {
    const picked = await pickFolder();
    if (picked.error && picked.error.includes("not supported on")) {
      return reply.code(501).send(
        errorBody("DIALOG_UNAVAILABLE", picked.error),
      );
    }
    return { path: picked.path, ...(picked.error ? { error: picked.error } : {}) };
  });

  // ROUND-50 (R50-c1): the composer's multi-FILE picker — the mirror of the
  // folder route above for "Add Context" attachments (PowerShell
  // OpenFileDialog with Multiselect on Windows / zenity --multiple on Unix;
  // the Tauri shell invokes its own rfd pick_files command instead). Same
  // bearer wall; same 501 DIALOG_UNAVAILABLE contract; 200 { files: [] }
  // = user cancelled (never an error). Never hit by tests: the dialog
  // blocks on a human (dialogs-script.test.ts pins the script structure).
  app.post("/api/v1/internal/dialog/files", async (_request, reply) => {
    const picked = await pickFiles();
    if (picked.error && picked.error.includes("not supported on")) {
      return reply.code(501).send(
        errorBody("DIALOG_UNAVAILABLE", picked.error),
      );
    }
    return { files: picked.files, ...(picked.error ? { error: picked.error } : {}) };
  });

  app.register(
    async (scope) => {
      registerBrowserRoutes(scope, token, db); // ROUND-43 (R43-10): embedded-browser proxy (iframe ticket auth, HTML/CSS rewriting, history + viewport state). ROUND-46 (R46-d): db handle → the per-project cookie jars (migration 0017) restore/persist through it.

      // ── ROUND-66 (R66, A4): POST /browser-checkpoints/:checkpointId/resolve ──
      // The chat CHECKPOINT CARD's answer channel — the mirror of the
      // browser-command result route (browser-proxy.ts), but the answer
      // comes from the OWNER ("Mark as done" / "Stop waiting"), not the app
      // UI, and it resolves the browser_control wait_for_verification tool's
      // pending promise (browser-checkpoint.ts). Same bearer-auth scope as
      // every route here. Always 200 {ok, resolution} — ok:false +
      // resolution:"timeout" for unknown/expired ids (the card falls back to
      // its own countdown timeout) — exactly the src/lib/api.ts
      // resolveBrowserCheckpoint contract.
      scope.post("/browser-checkpoints/:checkpointId/resolve", async (request, reply) => {
        const { checkpointId } = request.params as { checkpointId?: string };
        if (typeof checkpointId !== "string" || checkpointId === "") {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "checkpointId path param is required", { field: "params.checkpointId" }));
        }
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        const action = (body as Record<string, unknown>).action;
        if (action !== "done" && action !== "stop") {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body.action must be 'done' or 'stop'", { field: "body.action" }));
        }
        const resolved = resolveBrowserCheckpoint(checkpointId, action);
        if (!resolved) {
          return { ok: false, resolution: "timeout", error: "unknown or expired checkpoint" };
        }
        return { ok: true, resolution: action };
      });

      // ── ROUND-59 (R59-E): diagnostics — the engine's error ring ────────
      // The in-app Console tab (right sidebar) polls GET every 5s and merges
      // these rows with the frontend error bus; DELETE clears the ring (the
      // console's Clear all clears BOTH). Same bearer wall as every route in
      // this scope (the app-level preHandler). The ring rows are already
      // scrubbed at capture time — this route adds nothing to them.
      scope.get("/diagnostics/errors", async (request, reply) => {
        const query = request.query as Record<string, string | undefined>;
        let limit = DIAGNOSTICS_RING_CAP;
        if (query.limit !== undefined) {
          const parsed = Number(query.limit);
          if (!Number.isInteger(parsed) || parsed < 1) {
            return reply.code(400).send(
              errorBody("VALIDATION", "limit must be a positive integer", {
                field: "query.limit",
              }),
            );
          }
          limit = Math.min(parsed, DIAGNOSTICS_RING_CAP);
        }
        // Newest first (the ring is stored newest-first; slice is the cap).
        return { errors: diagnosticsRing.slice(0, limit) };
      });

      scope.delete("/diagnostics/errors", async () => {
        diagnosticsRing.length = 0;
        return { ok: true };
      });

      // R84 (Wave 2-a): agent registry CRUD (API.md §3) — extracted verbatim
      // to routes/agents.ts; registration order preserved.
      registerAgentRoutes(scope, ctx);

      // R84 (Wave 2-a): providers + provider keys (API.md §8) — extracted
      // verbatim to routes/providers.ts (the key-pool routes ride the same
      // register call; registration order preserved).
      registerProviderRoutes(scope, ctx);

      // R84 (Wave 2-a): the models domain — extracted verbatim to
      // routes/models.ts; registration order preserved.
      registerModelRoutes(scope, ctx);

      // ---- Checkpoints (round-25: revert agent changes) ----

      scope.get("/sessions/:id/checkpoints", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const session = getSession(db, id);
        if (session === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no session with id ${id}`));
        }
        const snapshots = listSnapshots(db, id).map((s) => ({
          id: s.id,
          seq: s.seq,
          path: s.path,
          toolName: s.toolName,
          ts: s.ts,
          hadBefore: s.beforeContent !== null,
        }));
        return { checkpoints: snapshots };
      });

      // Round-28 WS-D3: fetch before/after content for a single snapshot (by
      // seq) — DiffCard renders a real unified diff from this. Content is
      // excluded from the list route (large BLOBs) but included here on
      // demand. 404 if no snapshot for that seq (older sessions pre-R25).
      scope.get("/sessions/:id/snapshots/:seq", async (request, reply) => {
        const { id, seq } = request.params as Record<string, string>;
        const seqNum = Number(seq);
        if (!Number.isInteger(seqNum) || seqNum < 0) {
          return reply.code(400).send(errorBody("BAD_REQUEST", `invalid seq ${seq}`));
        }
        const snapshot = getSnapshotBySeq(db, id, seqNum);
        if (!snapshot) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no snapshot for session ${id} seq ${seq}`));
        }
        return {
          id: snapshot.id,
          sessionId: snapshot.sessionId,
          seq: snapshot.seq,
          path: snapshot.path,
          toolName: snapshot.toolName,
          ts: snapshot.ts,
          beforeContent: snapshot.beforeContent,
          afterContent: snapshot.afterContent,
        };
      });

      scope.post("/checkpoints/:id/restore", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const session = db
          .prepare("SELECT session_id FROM file_snapshots WHERE id = ?")
          .get(id) as { session_id: string } | undefined;
        if (!session) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no checkpoint with id ${id}`));
        }
        const fullSession = getSession(db, session.session_id);
        if (!fullSession?.projectId) {
          return reply.code(409).send(errorBody("CONFLICT", "session has no project — cannot determine root"));
        }
        const project = db
          .prepare("SELECT root_path FROM projects WHERE id = ?")
          .get(fullSession.projectId) as { root_path: string } | undefined;
        if (!project) {
          return reply.code(409).send(errorBody("CONFLICT", "project not found"));
        }
        const result = restoreSnapshot(db, id, project.root_path);
        if (!result.ok) {
          return reply.code(500).send(errorBody("INTERNAL", result.message));
        }
        return { restored: true, message: result.message };
      });

      // R84 (Wave 2-a): the projects domain (API.md §4a) + the WS-H unified
      // search + the WS-I demo viewer — extracted verbatim to
      // routes/projects.ts; registration order preserved.
      registerProjectRoutes(scope, ctx);

      // Round-28 WS-G2: codebase index summary for the frontend CodebasePanel.
      scope.get("/projects/:id/index", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const project = getProject(db, id);
        if (project === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
        }
        const summary = getIndexSummary(db, id);
        return { index: summary };
      });

      // R84 (Wave 2-a): the task-modes posture listing (R73-b) — extracted
      // verbatim to routes/modes.ts; registration order preserved.
      registerModeRoutes(scope, ctx);

      // ROUND-38 (owner: "I can see the terminal on the right sidebar"): a
      // USER-driven command runner for the right-sidebar Terminal tab. The
      // user types the command themselves, so this bypasses the agent
      // approvals engine (the human IS the approver here). Same spawn +
      // timeout + max-output guards as the agent run_command tool; runs in
      // the project root; returns combined stdout/stderr + exit code.
      scope.post("/projects/:id/terminal", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const project = getProject(db, id);
        if (project === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
        }
        const body = request.body as { command?: unknown } | null;
        const command = typeof body?.command === "string" ? body.command.trim() : "";
        if (command === "") {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "command is required", { field: "body.command" }));
        }
        const { spawn } = await import("node:child_process");
        const TIMEOUT = 60_000;
        const MAX_OUT = 64 * 1024;
        const result = await new Promise<{ ok: boolean; output: string; exitCode: number | null }>(
          (resolve) => {
            const child = spawn(command, {
              cwd: project.rootPath,
              shell: true,
              timeout: TIMEOUT,
              env: buildChildEnv(),
            });
            let combined = "";
            child.stdout?.on("data", (d: Buffer) => { combined += d.toString("utf8"); });
            child.stderr?.on("data", (d: Buffer) => { combined += d.toString("utf8"); });
            child.on("error", (err) =>
              resolve({ ok: false, output: `failed to start: ${err.message}`, exitCode: null }),
            );
            child.on("close", (code) => {
              const output =
                combined.length > MAX_OUT ? combined.slice(0, MAX_OUT) + "\n…[truncated]" : combined;
              resolve({ ok: code === 0, output, exitCode: code });
            });
          },
        );
        return result;
      });

      // ROUND-44 (R44-e, owner directive "complete the agentic coding
      // environment"): STREAMING variant of the terminal runner above. Same
      // containment — project must exist, command required, spawn with
      // shell:true in the PROJECT ROOT, FORCE_COLOR=0/CI=1 env, 60s timeout,
      // 64 KB combined output cap — but stdout/stderr are pushed to the client
      // as SSE `data:` frames the MOMENT the child emits them, followed by an
      // exit frame carrying the real exit code. The fire-and-forget route made
      // long commands look frozen (nothing arrived until the process exited)
      // and exit codes were invisible; this mirrors the fetch+SSE pattern of
      // POST /sessions/:id/messages/stream (reply.hijack + raw writeHead so
      // the CORS headers survive hijacking — the ROUND-30 lesson).
      //
      // Frame protocol (one JSON object per `data:` line, frames separated by
      // a blank line; a `: ping` comment frame every 10s keeps proxies from
      // closing the idle stream — agent turns are chatty, a quiet `sleep 60`
      // is not):
      //   {"type":"stdout","text":"…"}   — a stdout chunk, as-is
      //   {"type":"stderr","text":"…"}   — a stderr chunk, as-is
      //   {"type":"exit","code":N,"ms":T}— child exited with code N (null when
      //                                   killed by a signal) after T ms
      //   {"type":"error","message":"…"} — spawn failure / timeout / output
      //                                   cap; the stream ends right after
      //
      // Optional body {timeoutMs, maxBytes} can only SHRINK the budgets — the
      // server-side maximums are the sync route's defaults (60s / 64 KB), so
      // tests can exercise the kill paths quickly and power users can tighten
      // a slow command, but nobody can enlarge the blast radius.
      scope.post("/projects/:id/terminal/stream", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const project = getProject(db, id);
        if (project === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
        }
        const body = request.body as
          | { command?: unknown; timeoutMs?: unknown; maxBytes?: unknown }
          | null;
        const command = typeof body?.command === "string" ? body.command.trim() : "";
        if (command === "") {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "command is required", { field: "body.command" }));
        }
        // Budget overrides: integers within [min, server default]; anything
        // else is a 400, and the defaults apply when omitted.
        const DEFAULT_TIMEOUT_MS = 60_000;
        const DEFAULT_MAX_BYTES = 64 * 1024;
        const overrideOr400 = (value: unknown, min: number, max: number): number | null | undefined => {
          if (value === undefined || value === null) return null;
          if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
            return undefined; // invalid → caller 400s
          }
          return value;
        };
        const timeoutOverride = overrideOr400(body?.timeoutMs, 250, DEFAULT_TIMEOUT_MS);
        if (timeoutOverride === undefined) {
          return reply.code(400).send(
            errorBody("VALIDATION", `timeoutMs must be an integer between 250 and ${DEFAULT_TIMEOUT_MS}`, {
              field: "body.timeoutMs",
            }),
          );
        }
        const maxBytesOverride = overrideOr400(body?.maxBytes, 256, DEFAULT_MAX_BYTES);
        if (maxBytesOverride === undefined) {
          return reply.code(400).send(
            errorBody("VALIDATION", `maxBytes must be an integer between 256 and ${DEFAULT_MAX_BYTES}`, {
              field: "body.maxBytes",
            }),
          );
        }
        const timeoutMs = timeoutOverride ?? DEFAULT_TIMEOUT_MS;
        const maxBytes = maxBytesOverride ?? DEFAULT_MAX_BYTES;

        const { spawn } = await import("node:child_process");

        let clientGone = false;
        let ended = false; // terminal frame sent + response ended
        let errorFrameSent = false; // an error frame already terminated the story
        let capFired = false;
        let emittedBytes = 0;
        const startedAt = Date.now();

        reply.hijack();
        const res = reply.raw;
        // Same header block as the chat stream (ROUND-30: headers set via
        // reply.header() are dropped after hijack — CORS must ride writeHead).
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          ...corsHeadersFor(request.headers.origin),
        });
        // LIVE-BATTERY FIX: writeHead() only ASSIGNS headers on the raw
        // ServerResponse — nothing reaches the socket until the first write.
        // A quiet command (`sleep 60`) would leave the client without even
        // response HEADERS until the 10s heartbeat. Flush a leading comment
        // frame so the stream is live the instant the route runs (same trick
        // as the notifications stream's initial hello frame).
        try {
          res.write(": ping\n\n");
        } catch {
          clientGone = true;
        }

        // Comment-only heartbeat frame every 10s (idle proxies stay open).
        const heartbeat = setInterval(() => {
          if (clientGone || ended || res.writableEnded) return;
          try {
            res.write(": ping\n\n");
          } catch {
            clientGone = true;
          }
        }, 10_000);

        const send = (event: unknown) => {
          if (clientGone || res.writableEnded) return;
          try {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          } catch {
            // The socket died mid-write — treat the client as gone.
            clientGone = true;
          }
        };
        const finish = (resolve: () => void) => {
          clearInterval(heartbeat);
          if (ended) {
            resolve();
            return;
          }
          ended = true;
          if (!clientGone) {
            try {
              res.end();
            } catch {
              /* socket already dead */
            }
          }
          resolve();
        };

        await new Promise<void>((resolve) => {
          const child = spawn(command, {
            cwd: project.rootPath,
            shell: true,
            env: buildChildEnv(),
          });
          const killChild = () => {
            try {
              child.kill();
            } catch {
              /* already dead */
            }
          };
          // A client disconnect (Stop button / closed tab) kills the child —
          // unlike agent turns (ROUND-42: they complete in the background),
          // an interactive terminal command has no value once its reader is
          // gone, and letting it run would burn the CPU for the full timeout.
          request.raw.on("close", () => {
            clientGone = true;
            killChild();
          });
          res.on("close", () => {
            // Real sockets: 'close' on a premature termination. (In tests
            // light-my-request also emits 'close' right after end() — the
            // `ended` guard makes that a no-op.)
            if (!ended) {
              clientGone = true;
              killChild();
            }
          });

          // Kill-on-timeout: we manage the timer ourselves (not spawn's
          // `timeout` option) so we can emit the honest error frame the
          // moment the budget is spent. The timer ALWAYS finishes the stream
          // (clearing the heartbeat) — a client that left mid-command must
          // not leak the interval if the dying child lingers.
          const timer = setTimeout(() => {
            if (!ended && !clientGone) {
              const label = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
              errorFrameSent = true;
              send({ type: "error", message: `timed out after ${label}` });
            }
            killChild();
            finish(resolve);
          }, timeoutMs);

          const emitChunk = (chunk: Buffer, type: "stdout" | "stderr") => {
            if (ended || clientGone || chunk.length === 0) return;
            emittedBytes += chunk.length;
            const remaining = maxBytes - (emittedBytes - chunk.length);
            const text = remaining >= chunk.length ? chunk.toString("utf8") : chunk.subarray(0, Math.max(0, remaining)).toString("utf8");
            if (text !== "") send({ type, text });
            if (emittedBytes > maxBytes && !capFired) {
              capFired = true;
              errorFrameSent = true;
              send({
                type: "error",
                message: `output exceeded ${maxBytes} bytes — command killed (output truncated)`,
              });
              killChild();
              // No finish() here: the child's close event follows and ends the
              // stream — but with errorFrameSent set, the exit frame is
              // suppressed (we killed it; there is no honest exit code).
            }
          };
          child.stdout?.on("data", (d: Buffer) => emitChunk(d, "stdout"));
          child.stderr?.on("data", (d: Buffer) => emitChunk(d, "stderr"));

          child.on("error", (err) => {
            clearTimeout(timer);
            if (ended || clientGone) {
              finish(resolve);
              return;
            }
            errorFrameSent = true;
            send({ type: "error", message: `failed to start: ${err.message}` });
            finish(resolve);
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            if (!ended && !clientGone && !errorFrameSent) {
              send({ type: "exit", code, ms: Date.now() - startedAt });
            }
            finish(resolve);
          });
        });
      });

      // ── ROUND-45 (R45-b): persistent terminal sessions ─────────────────────
      //
      // The ROUND-38/44 terminal routes run ONE command per request; these
      // routes manage LONG-LIVED interactive shells (agent-core/src/
      // terminal-sessions.ts) — the round-44 "no PTY" deferral. A session is
      // one shell process in the project root: node-pty when the optional
      // native module loads (a REAL pty: echo, line editing, TUIs, colors),
      // otherwise ONE persistent bash/cmd.exe pipe pair (cwd/env/venv state
      // still persists across commands; no TUI echo — the UI compensates).
      // Sessions SURVIVE stream disconnects; DELETE (or idle reaping —
      // 10 min without input or output) kills them. Env is the P0-3
      // allowlist (buildChildEnv) — never sidecar secrets.
      //
      // Cap policy (documented choice): max 3 sessions per project, 8
      // globally — creating over a cap kills the OLDEST session of that
      // project (the globally-oldest for the global cap) instead of
      // rejecting: new tabs always work and zombies from closed tabs die.

      /** cols/rows validation shared by create + resize (integers, optional
       * at create / required at resize — callers pass min/max and the field
       * name for the 400 details). */
      const terminalDimension = (
        value: unknown,
        min: number,
        max: number,
      ): number | null | undefined => {
        if (value === undefined || value === null) return null;
        if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
          return undefined; // invalid → caller 400s
        }
        return value;
      };

      // Create a session: {cols?, rows?} (defaults 120x30) → 201 {id, engine,
      // createdAt}. The engine is chosen server-side and reported back — the
      // UI needs it to know whether to echo commands locally (pipe has no
      // echo of its own).
      scope.post("/projects/:id/terminal-sessions", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const project = getProject(db, id);
        if (project === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
        }
        const body = request.body as { cols?: unknown; rows?: unknown } | null;
        const cols = terminalDimension(body?.cols, 20, 500);
        if (cols === undefined) {
          return reply.code(400).send(
            errorBody("VALIDATION", "cols must be an integer between 20 and 500", {
              field: "body.cols",
            }),
          );
        }
        const rows = terminalDimension(body?.rows, 10, 200);
        if (rows === undefined) {
          return reply.code(400).send(
            errorBody("VALIDATION", "rows must be an integer between 10 and 200", {
              field: "body.rows",
            }),
          );
        }
        try {
          const session = await getTerminalSessions().create({
            projectId: id,
            rootPath: project.rootPath,
            cols: cols ?? 120,
            rows: rows ?? 30,
          });
          return reply
            .code(201)
            .send({ id: session.id, engine: session.engine, createdAt: session.createdAt });
        } catch (err) {
          return reply.code(503).send(
            errorBody(
              "UNAVAILABLE",
              `failed to start shell: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }
      });

      // List a project's LIVE sessions (oldest first).
      scope.get("/projects/:id/terminal-sessions", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const project = getProject(db, id);
        if (project === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
        }
        const sessions: TerminalSessionDescriptor[] = getTerminalSessions().list(id);
        return { sessions };
      });

      /** The session named by :tsid, verified to belong to :id's project —
       * 404 envelope otherwise (never leak cross-project session ids). */
      const ownedTerminalSession = (
        projectId: string,
        tsid: string,
      ): TerminalSessionDescriptor | null => {
        const descriptor = getTerminalSessions().get(tsid);
        if (descriptor === null || descriptor.projectId !== projectId) return null;
        return descriptor;
      };

      // Write to the shell's stdin. {data} max 8 KB per request.
      scope.post("/projects/:id/terminal-sessions/:tsid/input", async (request, reply) => {
        const { id, tsid } = request.params as Record<string, string>;
        const project = getProject(db, id);
        if (project === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
        }
        const body = request.body as { data?: unknown } | null;
        if (typeof body?.data !== "string") {
          return reply.code(400).send(
            errorBody("VALIDATION", "data must be a string", { field: "body.data" }),
          );
        }
        if (Buffer.byteLength(body.data, "utf8") > 8192) {
          return reply.code(400).send(
            errorBody("VALIDATION", "data exceeds the 8 KB limit", { field: "body.data" }),
          );
        }
        if (ownedTerminalSession(id, tsid) === null) {
          return reply
            .code(404)
            .send(errorBody("NOT_FOUND", `no terminal session with id ${tsid}`));
        }
        getTerminalSessions().input(tsid, body.data);
        return reply.code(204).send();
      });

      // Resize the pty (no-op on the pipe engine). Both dims required.
      scope.post("/projects/:id/terminal-sessions/:tsid/resize", async (request, reply) => {
        const { id, tsid } = request.params as Record<string, string>;
        const project = getProject(db, id);
        if (project === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
        }
        const body = request.body as { cols?: unknown; rows?: unknown } | null;
        const cols = terminalDimension(body?.cols, 20, 500);
        if (cols === null || cols === undefined) {
          return reply.code(400).send(
            errorBody("VALIDATION", "cols must be an integer between 20 and 500", {
              field: "body.cols",
            }),
          );
        }
        const rows = terminalDimension(body?.rows, 10, 200);
        if (rows === null || rows === undefined) {
          return reply.code(400).send(
            errorBody("VALIDATION", "rows must be an integer between 10 and 200", {
              field: "body.rows",
            }),
          );
        }
        if (ownedTerminalSession(id, tsid) === null) {
          return reply
            .code(404)
            .send(errorBody("NOT_FOUND", `no terminal session with id ${tsid}`));
        }
        getTerminalSessions().resize(tsid, cols, rows);
        return reply.code(204).send();
      });

      // SSE viewer for a session. Same mechanics as the R44-e terminal
      // stream route (hijack + writeHead CORS + leading `: ping` + 10s
      // heartbeats), ONE crucial divergence: on client disconnect the
      // SESSION SURVIVES — only the viewer left. Frames:
      //   {"type":"output","text":"…"}  — a chunk (the FIRST one carries the
      //                                   ring-buffer backlog for late
      //                                   subscribers)
      //   {"type":"exit","code":N|null} — the shell died (N null = killed)
      //   {"type":"error","message":"…"}
      // The response ends after the exit frame.
      scope.get("/projects/:id/terminal-sessions/:tsid/stream", async (request, reply) => {
        const { id, tsid } = request.params as Record<string, string>;
        const project = getProject(db, id);
        if (project === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
        }
        if (ownedTerminalSession(id, tsid) === null) {
          return reply
            .code(404)
            .send(errorBody("NOT_FOUND", `no terminal session with id ${tsid}`));
        }
        const sessions = getTerminalSessions();

        reply.hijack();
        const res = reply.raw;
        // ROUND-30: headers must ride writeHead — hijack drops reply.header().
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          ...corsHeadersFor(request.headers.origin),
        });
        // Flush the headers immediately (writeHead only assigns them).
        try {
          res.write(": ping\n\n");
        } catch {
          /* client already gone — the close handlers below finish us */
        }

        let clientGone = false;
        let ended = false;
        const heartbeat = setInterval(() => {
          if (clientGone || ended || res.writableEnded) return;
          try {
            res.write(": ping\n\n");
          } catch {
            clientGone = true;
          }
        }, 10_000);

        const send = (event: unknown) => {
          if (clientGone || res.writableEnded || ended) return;
          try {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          } catch {
            clientGone = true;
          }
        };
        const finish = (resolve: () => void) => {
          clearInterval(heartbeat);
          unsubscribe?.();
          if (ended) {
            resolve();
            return;
          }
          ended = true;
          if (!clientGone) {
            try {
              res.end();
            } catch {
              /* socket already dead */
            }
          }
          resolve();
        };

        // Subscribe BEFORE reading the backlog: both steps are synchronous,
        // so nothing can be emitted between them — the backlog carries
        // everything up to NOW, the listener everything after (no gap, no
        // duplication).
        let unsubscribe: (() => void) | null = null;
        await new Promise<void>((resolve) => {
          try {
            unsubscribe =
              sessions.subscribe(tsid, (event) => {
                if (event.type === "output") {
                  send({ type: "output", text: event.text });
                } else {
                  send({ type: "exit", code: event.code });
                  finish(resolve); // the shell died — end the viewer
                }
              }) ?? null;
            const backlog = sessions.backlog(tsid);
            if (backlog !== "") send({ type: "output", text: backlog });
          } catch (err) {
            // Defensive: nothing above should throw, but a viewer must never
            // hang silently on an unexpected failure (ROUND-43 lesson).
            send({
              type: "error",
              message: `terminal stream failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            });
            finish(resolve);
            return;
          }

          // Viewer disconnect: unsubscribe ONLY — the session is persistent
          // and outlives its readers (unlike the one-shot R44-e stream).
          request.raw.on("close", () => {
            clientGone = true;
            finish(resolve);
          });
          res.on("close", () => {
            if (!ended) {
              clientGone = true;
              finish(resolve);
            }
          });
        });
      });

      // Kill a session (emits the exit frame to viewers).
      scope.delete("/projects/:id/terminal-sessions/:tsid", async (request, reply) => {
        const { id, tsid } = request.params as Record<string, string>;
        const project = getProject(db, id);
        if (project === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
        }
        if (ownedTerminalSession(id, tsid) === null) {
          return reply
            .code(404)
            .send(errorBody("NOT_FOUND", `no terminal session with id ${tsid}`));
        }
        getTerminalSessions().kill(tsid);
        return reply.code(204).send();
      });

      // R84 (Wave 2-a): the project-memory read/prune routes (R44-a) —
      // extracted verbatim to routes/memory.ts; registration order preserved.
      registerMemoryRoutes(scope, ctx);

      // R84 (Wave 2-a): sessions + single-agent chat (API.md §5) — extracted
      // verbatim to routes/sessions.ts; registration order preserved. The
      // SSE stream route still lives inline below (final-phase move).
      registerSessionRoutes(scope, ctx);

      // R84 (Wave 2-a): the attachments routes (R50-c1 read + R67-A
      // upload) — extracted verbatim to routes/attachments.ts;
      // registration order preserved.
      registerAttachmentRoutes(scope, ctx);

      // R84 (Wave 2-a): the response-ratings routes (R59-D) — extracted
      // verbatim to routes/ratings.ts; registration order preserved.
      registerRatingRoutes(scope, ctx);

      // ── ROUND-37: approvals (ADR-0024 — the human permission flow) ───────

      scope.get("/approvals", async (request) => {
        const query = request.query as Record<string, string | undefined>;
        const status = query.status;
        const projectId = query.projectId;
        return {
          approvals: listApprovals(db, {
            ...(status !== undefined ? { status } : {}),
            ...(projectId !== undefined ? { projectId } : {}),
          }),
        };
      });

      scope.post("/approvals/:id/decision", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const approval = getApproval(db, id);
        if (approval === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no approval with id ${id}`));
        }
        if (approval.status !== "pending") {
          return reply.code(409).send(
            errorBody("CONFLICT", `approval ${id} is already ${approval.status}`, {
              field: "params.id",
            }),
          );
        }
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        const raw = body as Record<string, unknown>;
        const decision = raw.decision;
        if (decision !== "approved" && decision !== "denied") {
          return reply.code(400).send(
            errorBody("VALIDATION", "decision must be 'approved' or 'denied'", {
              field: "body.decision",
            }),
          );
        }
        // HARD RULE: destructive operations are NEVER "always allow" — a
        // remember=always on a destructive approval silently downgrades to
        // once (the engine double-checks before writing any rule).
        const requestedRemember = raw.remember;
        const remember: "once" | "always" | undefined =
          requestedRemember === "always" && approval.category !== "destructive"
            ? "always"
            : requestedRemember === "once" || requestedRemember === "always"
              ? "once"
              : undefined;

        // 1) Persist the decision (BEFORE resolving the waiter — the engine
        //    reads remember back to decide whether to write the rule).
        setApprovalStatus(db, id, decision, remember, "owner");
        // 2) Wake the waiting tool call (no-op when the turn died).
        resolvePendingApproval(id, decision);
        return reply.code(200).send({ ok: true, decision, remember: remember ?? "once" });
      });

      // R84 (Wave 2-a): the settings domain (R36 orchestration + R49 memory
      // + R65 debug + R78/R80 retry) — extracted verbatim to
      // routes/settings.ts; registration order preserved. R106-S1: the
      // domain also carries GET/PUT /settings/device-link (the Devices tab's
      // allow-links switch, which drives the ctx.mobileLink listener).
      registerSettingsRoutes(scope, ctx);

      // R106-S1: the mobile-link domain — pair/start, pair/claim, the
      // device list + revoke, link-info (routes/mobile.ts).
      registerMobileRoutes(scope, ctx);

      // R86: the SSE domain — the streamed turn route (the final-phase
      // extraction of the R84 server.ts split) — extracted verbatim to
      // routes/sse.ts; registration order preserved.
      registerSseRoutes(scope, ctx);

      // ── ROUND-61 (R61): COMPUTER USE — the desktop-control surface ────────
      // The monitor ring (GET session), the UI kill switch (POST stop), the
      // settings (GET/PUT config — the VISION block moved OUT in R66 to
      // /vision/settings), the readiness probe, and the dedicated VISION
      // KEY slot (the "<providerId>-vision" keyring pseudo-provider — the
      // Tauri shell writes the durable credential + handoff; this route is
      // the web-dev + in-session path). Same bearer wall as everything else.
      scope.get("/computer-use/config", async () => {
        const settings = getComputerUseSettings(db);
        const backend = backendForPlatform();
        return {
          settings,
          platform: backend.kind,
          capabilities: backend.capabilities(),
        };
      });

      scope.put("/computer-use/config", async (request, reply) => {
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        // R66-2-b: the vision block moved — a legacy client PUTting `vision`
        // gets the honest pointer instead of a silent drop.
        if ("vision" in (body as Record<string, unknown>)) {
          return reply
            .code(400)
            .send(
              errorBody("VALIDATION", "vision settings moved to PUT /vision/settings", {
                field: "body.vision",
              }),
            );
        }
        try {
          const settings = setComputerUseSettings(db, body as Parameters<typeof setComputerUseSettings>[1]);
          return { settings };
        } catch (err) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", String((err as Error).message), { field: "body" }));
        }
      });

      // The monitor: session state + the newest-first event ring (the
      // floating mini window polls this while a control session is live).
      scope.get("/computer-use/session", async () => {
        return getComputerSession().state();
      });

      // ── ROUND-67 (R67-D): GET /computer-use/frames/:frameId/raster ───────
      // The PNG bytes of a frame captured THIS process lifetime — the live
      // chat THUMBNAIL fetch (the owner: "the images should be shown during
      // its thinking in the agent's chat window itself, in a small view").
      // The plugins copy successful captures into the in-memory raster
      // registry (computer/raster-cache.ts) and announce the frame id over
      // the turn SSE ({type:"screenshot"}); the frontend lazy-fetches here
      // per thumbnail. Same bearer wall as the sibling routes. Honest 404
      // after the 10-minute TTL or the LRU eviction (rasters are EPHEMERAL
      // — never persisted, never fed to the model; the quiet "expired" tile
      // in the chat is the deliberate design, not a bug).
      scope.get("/computer-use/frames/:frameId/raster", async (request, reply) => {
        const { frameId } = request.params as Record<string, string>;
        if (typeof frameId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(frameId)) {
          return reply
            .code(400)
            .send(
              errorBody("VALIDATION", "frameId must be alphanumeric/dash/underscore (max 64 chars)", {
                field: "params.frameId",
              }),
            );
        }
        const entry = rasterFor(frameId);
        if (entry === null) {
          return reply
            .code(404)
            .send(
              errorBody(
                "NOT_FOUND",
                `no raster for frame '${frameId}' — rasters are in-memory only, capped (12) and expire after 10 minutes`,
              ),
            );
        }
        // Binary reply: the decoded PNG, no-store (a stale thumbnail tile is
        // worse than a re-fetch; the bytes die with the TTL anyway).
        reply.header("content-type", "image/png");
        reply.header("cache-control", "no-store");
        return reply.send(Buffer.from(entry.pngBase64, "base64"));
      });

      // The UI's STOP button: the kill switch (releases a held button; all
      // further computer-use calls refuse with kill_switch_active).
      scope.post("/computer-use/stop", async (request) => {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const reason =
          typeof body.reason === "string" && body.reason.trim() !== ""
            ? body.reason.trim().slice(0, 200)
            : "stopped by the owner from the UI";
        const session = getComputerSession();
        const { releasedHeld } = session.stop(reason);
        if (releasedHeld) {
          // The only sanctioned auto-release (doc 08 §2): a real mouse-up
          // at the recorded point, so the user's desktop is never left
          // with a stuck button.
          void backendForPlatform().rawButton(realRunner(), releasedHeld.point, false);
        }
        return { ok: true, reason };
      });

      // Readiness probe (request_access equivalent, for the Settings page):
      // never pops dialogs; returns the permission report + capabilities.
      // R61 close-out (docs-round drift fix): the report is COMPOSED into a
      // UI-ready verdict — ok (both core capabilities granted) + issues (the
      // report's notes + explicit denied lines) — while the raw
      // accessibility/screenCapture/backendKind fields still ride the same
      // object for richer consumers. The ComputerUseTab's Test readiness
      // button reads exactly {ok, issues}.
      scope.post("/computer-use/test", async () => {
        const backend = backendForPlatform();
        const report = await backend.probePermissions(realRunner());
        const issues: string[] = [...(report.notes ?? [])];
        if (report.accessibility === "denied") {
          issues.push("Accessibility permission is denied — grant it in the OS privacy settings");
        }
        if (report.screenCapture === "denied") {
          issues.push("Screen capture permission is denied — grant it in the OS privacy settings");
        }
        const verdict = {
          ...report,
          ok: report.accessibility === "granted" && report.screenCapture === "granted",
          issues,
        };
        return { report: verdict, capabilities: backend.capabilities(), platform: backend.kind };
      });

      // The VISION KEY slot: in-memory keyring write for web-mode. The
      // packaged app writes the durable credential via the Tauri
      // store_provider_key command (providerId "<id>-vision") which ALSO
      // POSTs the internal handoff route. Values never appear in ANY
      // response — hasKey + masked only.
      scope.get("/computer-use/vision-key", async (request, reply) => {
        const query = request.query as Record<string, string | undefined>;
        const providerId = query.providerId;
        if (typeof providerId !== "string" || !/^[a-z0-9_-]+$/.test(providerId)) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "providerId must be a lowercase slug", { field: "query.providerId" }));
        }
        const slotId = visionKeyringId(providerId);
        const value = keyring.get(slotId);
        return {
          providerId,
          hasKey: value !== undefined,
          masked: value !== undefined ? `${value.slice(0, 10)}…${value.slice(-4)}` : null,
        };
      });

      scope.put("/computer-use/vision-key", async (request, reply) => {
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        const raw = body as Record<string, unknown>;
        const providerId = raw.providerId;
        const value = raw.value;
        if (typeof providerId !== "string" || !/^[a-z0-9_-]+$/.test(providerId)) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "providerId must be a lowercase slug", { field: "body.providerId" }));
        }
        if (typeof value !== "string" || value.trim() === "") {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "value must be a non-empty string", { field: "body.value" }));
        }
        keyring.set(visionKeyringId(providerId), value.trim());
        return reply.code(204).send();
      });

      scope.delete("/computer-use/vision-key", async (request, reply) => {
        const query = request.query as Record<string, string | undefined>;
        const providerId = query.providerId;
        if (typeof providerId !== "string" || !/^[a-z0-9_-]+$/.test(providerId)) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "providerId must be a lowercase slug", { field: "query.providerId" }));
        }
        keyring.set(visionKeyringId(providerId), "");
        return reply.code(204).send();
      });

      // ── ROUND-66 (R66-2-b, owner B3+B5): IMAGE ANALYSIS — the DEDICATED
      // vision-model settings section. The vision model moved OUT of
      // computer use; these routes are the new home (the frontend half is
      // src/components/settings/ImageAnalysisTab.tsx). The vision KEY keeps
      // the R61 /computer-use/vision-key routes above (the "<id>-vision"
      // keyring slot is THE slot — the Tauri store_vision_key command is
      // unchanged). Same bearer wall as everything else.
      // GET /vision/settings → the VisionSettings object itself (the
      // api.ts client types the response as VisionSettings, not a wrapper).
      scope.get("/vision/settings", async () => {
        return getVisionSettings(db);
      });

      scope.put("/vision/settings", async (request, reply) => {
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        try {
          // Returns the new settings BARE (the api.ts contract).
          return setVisionSettings(db, body as Parameters<typeof setVisionSettings>[1]);
        } catch (err) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", String((err as Error).message), { field: "body" }));
        }
      });

      // POST /vision/test — a tiny 1×1 transparent PNG through the CURRENT
      // settings (separate mode only, honestly): "main" mode has no model to
      // aim at without a live turn (the relay resolves the TURN's model), so
      // it answers the honest error instead of guessing; off answers the
      // honest off error. {ok, description?, model?, error?}.
      scope.post("/vision/test", async () => {
        // A 1×1 transparent PNG (the smallest honest probe image).
        const TEST_PNG_BASE64 =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        const settings = getVisionSettings(db);
        if (settings.mode === "off") {
          return { ok: false, error: "image analysis is OFF — pick a mode above first" };
        }
        if (settings.mode === "main") {
          return {
            ok: false,
            error: "main-mode test needs a live turn — flip a provider model's supports-vision flag instead",
          };
        }
        if (settings.provider === null || settings.modelId === null) {
          return {
            ok: false,
            error: "separate mode is not fully configured — pick a provider and model, then test again",
          };
        }
        const result = await describeRaster(
          { db, keyring, visionKeyringId: visionKeyringId(settings.provider) },
          { mode: "separate", providerId: settings.provider, modelId: settings.modelId },
          { imageBase64: TEST_PNG_BASE64, instruction: "Describe this image in one short sentence." },
        );
        if ("error" in result) {
          return { ok: false, error: result.error };
        }
        return { ok: true, description: result.text, model: result.model, ms: result.ms };
      });

      // R84 (Wave 2-a): the skills CRUD routes (R61 → R70-b → R72-c) —
      // extracted verbatim to routes/skills.ts; registration order preserved.
      registerSkillRoutes(scope, ctx);

      // ROUND-98 (R98-E1): the PROMPT-CUSTOMIZATION routes — the Settings
      // Prompts tab's backend (GET/PUT/DELETE /prompts/sections,
      // GET /prompts/preview). Same bearer wall as everything else.
      registerPromptRoutes(scope, ctx);

      // ── ROUND-61 (R61): MCP SERVERS — owner-configured stdio extensions ─
      // Commands are configuration, never model-writable; the manager
      // sanitizes the child env (no ACUTE_PROVIDER_* leaks).
      scope.get("/mcp", async () => {
        const servers = listMcpServers(db);
        return { servers };
      });

      scope.post("/mcp", async (request, reply) => {
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        try {
          const server = createMcpServer(db, body as Parameters<typeof createMcpServer>[1]);
          return reply.code(201).send(server);
        } catch (err) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", String((err as Error).message), { field: "body" }));
        }
      });

      scope.patch("/mcp/:id", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        try {
          const server = updateMcpServer(db, id, body as Parameters<typeof updateMcpServer>[2]);
          if (server === undefined) {
            return reply.code(404).send(errorBody("NOT_FOUND", `no MCP server with id ${id}`));
          }
          // Config changed: drop the cached child so the next call respawns
          // with the new command/env.
          resetServerFailure(id);
          return server;
        } catch (err) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", String((err as Error).message), { field: "body" }));
        }
      });

      scope.delete("/mcp/:id", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        stopServer(id);
        if (!deleteMcpServer(db, id)) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no MCP server with id ${id}`));
        }
        return reply.code(204).send();
      });

      // Live tools/list for ONE server (the Extensions tab's expand row).
      scope.get("/mcp/:id/tools", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const server = getMcpServer(db, id);
        if (server === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no MCP server with id ${id}`));
        }
        const listed = await listServerTools(server);
        return listed.ok
          ? { tools: listed.tools }
          : { tools: [], error: listed.error };
      });

      // Health probe: spawn + initialize + tools/list (honest ok/error/ms).
      scope.post("/mcp/:id/probe", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const server = getMcpServer(db, id);
        if (server === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no MCP server with id ${id}`));
        }
        resetServerFailure(id);
        const probe = await probeServer(server);
        return probe;
      });

      // ── ROUND-61 (R61): PLUGINS — the catalog + load status ─────────────
      // Built-ins (fixed ids + categories) + the external .mjs registry's
      // load report (the R52 loader) + the live tool counts from the
      // registry catalog. One place for the Extensions tab to render.
      scope.get("/plugins", async (request) => {
        const query = request.query as Record<string, string | undefined>;
        const projectId = query.projectId;
        const root =
          projectId !== undefined ? getProject(db, projectId)?.rootPath ?? undefined : undefined;
        // Plugin METADATA straight from the registry (id/name/version/
        // category/description — the computer-use plugin is listed even
        // while its master switch is off: the gate is SETTINGS, not
        // existence). The tool-level catalog (gated plugins contribute
        // nothing) + the external .mjs file report complete the picture.
        const plugins = BUILT_IN_PLUGINS.map((plugin) => ({
          id: plugin.id,
          name: plugin.name,
          version: plugin.version,
          category: plugin.category,
          description: plugin.description,
          builtIn: true,
        }));
        const catalog = await builtInToolCatalog();
        const external = externalPluginFileReport(root);
        return { plugins, tools: catalog, external };
      });

      // ---- ROUND-52 (R52-a): background jobs — the agent's run_command
      // background launches (start /B …, `… &`, nohup …) register here so
      // BOTH the agent (job_status/job_stop tools) and the UI (these routes:
      // the Terminal panel's jobs view) can watch and stop them. ----

      // All tracked jobs (optionally scoped to one project via ?projectId=).
      scope.get("/jobs", async (request) => {
        const query = request.query as Record<string, string | undefined>;
        const projectId = query.projectId;
        return { jobs: listJobs(projectId) };
      });

      // A project's jobs (the Terminal panel calls this shape).
      scope.get("/projects/:id/jobs", async (request) => {
        const { id } = request.params as Record<string, string>;
        return { jobs: listJobs(id) };
      });

      // Full status of one job (command, age, alive, output tail, log tail).
      scope.get("/jobs/:id", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const status = getJobStatus(id);
        if (status === null) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no background job '${id}'`));
        }
        return { job: status };
      });

      // Stop a tracked job (the UI's per-job Stop button — same best-effort
      // kill path as the job_stop tool).
      scope.post("/jobs/:id/stop", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const status = getJobStatus(id);
        if (status === null) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no background job '${id}'`));
        }
        const result = await stopJob(id);
        return result;
      });

      // R84 (Wave 2-a): the usage-analytics routes (§F7 + R52-b) —
      // extracted verbatim to routes/usage.ts; registration order preserved.
      registerUsageRoutes(scope, ctx);

      // R87: the system routes (POST /system/reset — the application-wide
      // reset). Registered last: no wildcard overlaps, and the wipe wants
      // every other route's in-flight work to have landed first.
      registerSystemRoutes(scope, ctx);

      // R87: the agent-question resolve route (the ask_user tool's REST
      // answer path — the browser-checkpoints contract shape).
      registerQuestionRoutes(scope, ctx);

      // R88: the floating todo widget's manual-edit route (the owner's write
      // path — POST /sessions/:id/todo persists a source:"user" snapshot the
      // next turn's prompt emphasizes).
      registerTodoRoutes(scope, ctx);

      // ---- ROUND-40: notifications (task complete/failed, permission
      // requests, sub-agent transitions). The owner: "add notification
      // functionality. Our project will send notifications to the user on
      // various occasions, like after completing the task, after it fails the
      // task, after requesting a permission, and various other things." ----

      // List notifications (newest first). ?unread=1 filters to unread;
      // ?limit=N (default 50, capped 200) bounds the page.
      scope.get("/notifications", async (request) => {
        const query = request.query as Record<string, string | undefined>;
        const unreadOnly = query.unread === "1" || query.unread === "true";
        let limit = 50;
        if (query.limit !== undefined) {
          const parsed = Number(query.limit);
          if (!Number.isInteger(parsed) || parsed < 1) {
            return { notifications: listNotifications(db, { unreadOnly, limit: 50 }), unread: countUnreadNotifications(db) };
          }
          limit = parsed;
        }
        return {
          notifications: listNotifications(db, { unreadOnly, limit }),
          unread: countUnreadNotifications(db),
        };
      });

      // Mark one notification read (POST per the uniform-verb convention; the
      // body is empty — the id is the path param).
      scope.post("/notifications/:id/read", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const updated = markNotificationRead(db, id);
        if (!updated) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no unread notification with id ${id}`));
        }
        return { ok: true, unread: countUnreadNotifications(db) };
      });

      // Mark every unread notification read (the bell's "clear all" action).
      scope.post("/notifications/read-all", async () => {
        const cleared = markAllNotificationsRead(db);
        return { ok: true, cleared, unread: 0 };
      });

      // Live SSE stream: one global channel. The browser opens it once on app
      // boot (fetch + ReadableStream — EventSource can't set the Authorization
      // header, so we use the same fetch-stream pattern as the message
      // stream). Each published notification is pushed as a `data:` frame.
      scope.get("/notifications/stream", async (request, reply) => {
        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          ...corsHeadersFor(request.headers.origin),
        });
        // Send an initial hello so the client knows the stream is live (and
        // can render the bell badge from the first unread count).
        const hello = { type: "hello", unread: countUnreadNotifications(db) };
        res.write(`data: ${JSON.stringify(hello)}\n\n`);
        const unsubscribe = getNotificationBus().subscribe((n) => {
          if (!res.writableEnded) res.write(`data: ${JSON.stringify(n)}\n\n`);
        });
        res.on("close", () => unsubscribe());
        // Hold the reply open until the client disconnects. Fastify's hijack
        // means we never call reply.send; the SSE stream lives until close.
      });

      // ---- ROUND-42: Web Push subscription surface (desktop notifications
      // with the app window closed). The browser registers /sw.js, asks the
      // Notification permission, subscribes with the VAPID public key, and
      // POSTs the subscription here. Every published notification is then
      // delivered by the push service to the service worker. ----

      // The VAPID public key (the client needs it to subscribe).
      scope.get("/notifications/push/key", async (_request, reply) => {
        const publicKey = vapidPublicKey();
        if (publicKey === null) {
          return reply
            .code(503)
            .send(errorBody("UNAVAILABLE", "web push is not configured on this sidecar"));
        }
        return { publicKey };
      });

      // Save/refresh a PushSubscription (upsert by endpoint).
      scope.post("/notifications/push/subscribe", async (request, reply) => {
        if (vapidPublicKey() === null) {
          return reply
            .code(503)
            .send(errorBody("UNAVAILABLE", "web push is not configured on this sidecar"));
        }
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null) {
          return reply.code(400).send(errorBody("VALIDATION", "body must be a JSON object"));
        }
        const raw = body as Record<string, unknown>;
        const endpoint = raw.endpoint;
        const keys = raw.keys;
        if (
          typeof endpoint !== "string" ||
          endpoint === "" ||
          typeof keys !== "object" ||
          keys === null
        ) {
          return reply.code(400).send(
            errorBody("VALIDATION", "expected { endpoint: string, keys: { p256dh, auth } }", {
              field: "body",
            }),
          );
        }
        const k = keys as Record<string, unknown>;
        if (typeof k.p256dh !== "string" || typeof k.auth !== "string") {
          return reply.code(400).send(
            errorBody("VALIDATION", "keys must carry string p256dh + auth", {
              field: "body.keys",
            }),
          );
        }
        savePushSubscription(db, {
          endpoint,
          keys: { p256dh: k.p256dh, auth: k.auth },
        });
        return { ok: true };
      });

      // Drop a subscription (browser revoked it / user turned notifications
      // off in-app).
      scope.post("/notifications/push/unsubscribe", async (request, reply) => {
        const body: unknown = request.body;
        const endpoint =
          typeof body === "object" && body !== null
            ? (body as Record<string, unknown>).endpoint
            : undefined;
        if (typeof endpoint !== "string" || endpoint === "") {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "expected { endpoint: string }", { field: "body" }));
        }
        deletePushSubscription(db, endpoint);
        return { ok: true };
      });
    },
    { prefix: "/api/v1" },
  );

  // ROUND-45 (R45-b): app shutdown kills every live terminal-session shell —
  // app.close() (tests, startServer's failure path, the shell's graceful
  // teardown) must never leave orphan bash/pty processes behind. main.ts
  // additionally covers SIGTERM/SIGINT, which bypass Fastify's close hooks.
  app.addHook("onClose", async () => {
    terminalSessionsDisposeAll();
  });

  return app;
}

export interface StartServerOptions {
  /** 0 (default) binds an ephemeral port; the shell never picks it (ARCHITECTURE §2.1). */
  port?: number;
  token: string;
  dbPath: string;
}

export interface RunningSidecar {
  server: FastifyInstance;
  port: number;
  /** ROUND-98 (R98-K): the discovery file startServer wrote (see
   * writePortalDiscoveryFile) — absent when the write failed best-effort.
   * Exposed for tests; the runtime never reads it back. */
  discoveryFile?: string;
}

/* ── ROUND-98 (R98-K, owner: "I want our application to be usable using the
 * terminal tool"): the PORTAL DISCOVERY FILE. startServer writes
 * <dbDir>/acute-portal.json — {port, token, pid, startedAt} — next to the
 * SQLite DB, so the CLI (scripts/acute.mjs → scripts/acute-discovery.mjs)
 * can find the RUNNING app without env plumbing: port + token are exactly
 * what ACUTE_BASE_URL/ACUTE_TOKEN would have carried. The file is
 * user-local (the db dir already is — .dev/ in the dev stack, the Rust
 * shell's state_dir()/acute-code packaged), removed on graceful shutdown
 * (app.close → the onClose hook below; SIGTERM/SIGINT bypass Fastify's
 * hooks, so a stale file can linger after a hard kill — the CLI's resolver
 * treats a dead target as "not found" via the connection error, exactly
 * like a wrong ACUTE_BASE_URL). The TOKEN is never LOGGED (the ready line
 * prints the port only — pinned by server.test.ts); it rides the
 * user-local file, which is the same trust boundary the shell's env
 * injection already is. */
export const PORTAL_DISCOVERY_FILENAME = "acute-portal.json";

/** Write the discovery file (best-effort — a failure NEVER kills boot:
 * the ready line still tells the shell the port). Returns the path (or the
 * would-be path when the write failed) so onClose can attempt removal. */
function writePortalDiscoveryFile(dbDir: string, port: number, token: string): string {
  const file = join(dbDir, PORTAL_DISCOVERY_FILENAME);
  try {
    writeFileSync(
      file,
      `${JSON.stringify({ port, token, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch {
    // best-effort by design (read-only dir, disk full, …)
  }
  return file;
}

/** Remove the discovery file (best-effort — a concurrent boot may already
 * have replaced it; rmSync's force tolerates absence). */
function removePortalDiscoveryFile(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // best-effort by design
  }
}

/**
 * ROUND-106 (R106-S1): the ACUTE_HOST boot override. ACUTE_HOST names the
 * address family the sidecar should serve (the CLI/planning references) —
 * a NON-LOOPBACK value at boot means "this machine wants LAN exposure" and
 * force-enables the device link (persisted, so it survives later boots and
 * the Devices tab shows the honest state). Loopback values (127.0.0.1,
 * ::1, localhost, blank, unset) mean nothing — the persisted setting alone
 * decides.
 */
function isNonLoopbackAcuteHost(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (value === "" || value === "localhost" || value === "127.0.0.1" || value === "::1") {
    return false;
  }
  return true;
}

/** Opens the database, binds 127.0.0.1 (loopback only), prints the ready line. */
export async function startServer(options: StartServerOptions): Promise<RunningSidecar> {
  const db = openDatabase(options.dbPath);
  const app = buildServer({
    token: options.token,
    db,
    // ROUND-42: Web Push VAPID keys live next to the SQLite file (.dev dir).
    dataDir: dirname(options.dbPath),
  });
  app.addHook("onClose", async () => {
    db.close();
  });
  // R98-K: the discovery-file lifecycle. The WRITE needs the real port
  // (after the bind) but the REMOVAL hook must be registered BEFORE listen
  // (Fastify refuses addHook on a listening instance), so a mutable holder
  // carries the path from the write to the removal. Until the write lands
  // the hook is a no-op, which also covers the failed-bind throw path below
  // (app.close() runs before any file exists — a STALE file from a previous
  // boot on this dbDir survives that close, deliberately: this boot never
  // owned it).
  const discovery: { file?: string } = {};
  app.addHook("onClose", async () => {
    if (discovery.file !== undefined) removePortalDiscoveryFile(discovery.file);
  });
  await app.listen({ port: options.port ?? 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    await app.close();
    throw new Error("sidecar failed to bind a TCP port");
  }
  // R98-K: the discovery file — written AFTER the successful bind (the port
  // is real, never a placeholder) and removed by the hook above on graceful
  // close; a hard SIGTERM/SIGINT kill can leave a stale file, which the
  // next boot overwrites (last boot wins — pinned in r98-cli-discovery).
  discovery.file = writePortalDiscoveryFile(dirname(options.dbPath), address.port, options.token);
  // The shell parses this exact line (ARCHITECTURE §2). R37 note: structured
  // log lines (JSON) may precede it on stdout — the shell prefix-scans for
  // ACUTE_READY, so they're harmless; only malformed non-JSON output would
  // risk confusing a stricter parser. R98-K: still exactly ONE line, still
  // port-only — the token reaches the shell through env injection and the
  // CLI through the discovery file, never through stdout.
  console.log(`ACUTE_READY ${JSON.stringify({ port: address.port })}`);
  // R106-S1: the DEVICE-LINK boot (post-ready — the shell's parse is done;
  // post-ready stdout lines are drained into sidecar.log by design, and
  // these are structured JSON either way). The PERSISTED setting is the
  // truth: a machine that had links enabled gets its TLS listener back on
  // every boot — the auto-reconnect ruling's substrate (stable cert file +
  // stable token rows → the phone reconnects with zero re-setup). ACUTE_HOST
  // non-loopback force-enables (and persists) for THIS boot. A failed start
  // is logged and NEVER fatal: the loopback sidecar is the product; the
  // link is the accessory.
  if (deviceLinkControllerFor(app) !== null) {
    const link = deviceLinkControllerFor(app);
    if (link !== null) {
      const forced = isNonLoopbackAcuteHost(process.env.ACUTE_HOST);
      try {
        if (forced && !getDeviceLinkSettings(db).enabled) {
          setDeviceLinkSettings(db, { enabled: true });
        }
        if (forced || getDeviceLinkSettings(db).enabled) {
          const status = await link.start();
          log("info", "boot.device_link", {
            port: status.port,
            addrs: status.addrs,
            certFP: status.certFP,
            forcedByEnv: forced,
          });
        }
      } catch (err) {
        log("warn", "boot.device_link_failed", {
          message: err instanceof Error ? err.message : String(err),
          forcedByEnv: forced,
        });
      }
    }
  }
  return { server: app, port: address.port, discoveryFile: discovery.file };
}



