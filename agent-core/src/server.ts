/**
 * Sidecar HTTP server (API.md; ADR-0006). Wave 1: health + bearer-token auth +
 * agent registry CRUD. Wave 2 adds the provider registry (keyring-backed) and
 * single-agent sessions/chat. WebSocket and the remaining resources come in
 * later waves.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
import type { MessageAttachment } from "shared";
import { aiSdkChat, streamAiSdkChat, type ChatFn } from "./agents/chat.js";
import {
  persistTurnError,
  runStreamedAgentTurn,
  type TurnModelOverride,
} from "./agents/runtime.js";
// ROUND-66 (R66-2-c, C1): the post-turn CONTEXT-FREE DEBUG ANALYST — a
// fresh model call (no tools, no history of its own) that receives the
// session's whole transcript and streams its report back over the SAME
// still-open SSE before the turn's terminal frame.
import { runDebugAnalyst } from "./agents/debug-analyst.js";
import { pickFiles, pickFolder } from "./dialogs.js";
import { resolveInsideRoot } from "./tools/index.js";
import {
  ProviderKeyring,
  resolveProvider,
} from "./providers/registry.js";
import { getProject } from "./storage/projects.js";
import {
  appendSessionEvent,
  deleteQueuedMessage,
  deliverQueuedMessage,
  getSession,
  listSessionEvents,
  listUndeliveredQueuedMessages,
  recordUsage,
} from "./storage/sessions.js";
import {
  getDebugSettings,
  getMemorySettings,
  getOrchestrationSettings,
  getRetrySettings,
  setDebugSettings,
  setMemorySettings,
  setOrchestrationSettings,
  setRetrySettings,
} from "./storage/settings.js";
import { Orchestrator } from "./agents/orchestrator.js";
import {
  getApproval,
  listApprovals,
  resolvePendingApproval,
  setApprovalStatus,
  sweepStaleApprovals,
} from "./approvals.js";
import { getDetailedUsage, getUsageSummary } from "./storage/usage.js";
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
import { lookupPricing } from "./storage/models.js";
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
import { createSkill, updateSkill, deleteSkill } from "./storage/skills.js";
// ROUND-70 (R70-b, D1): the file-based skills surface — the merged listing
// (DB + project files + user-global files) and the synthetic-id guard the
// CRUD routes refuse edits through.
import { isFileSkillId, listAllSkillsMerged } from "./storage/skills-files.js";
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
import { getAgent } from "./storage/agents.js";
// ROUND-40: notifications (task complete/failed, permission requests,
// sub-agent transitions). The bus is the in-process pub/sub; the storage
// module is the durable SQLite record + REST read/mark-read surface.
import { getNotificationBus } from "./lib/notification-bus.js";
// ROUND-80 (R80): the customizable retry schedule — resolved from the
// settings for the task_failed notification's schedule line.
import { describeRetrySchedule, resolveRetrySchedule } from "./lib/retry.js";
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
import { dirname } from "node:path";
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
// ROUND-52 (R52-b): the SHARED live-turn registry — replaces the local
// activeTurns Map so sub-agent children (registered by the orchestrator)
// are stoppable through the SAME POST /sessions/:id/stop route as main
// turns. Reasons ("owner" | "stall") let the orchestrator report why a
// child ended.
import {
  registerTurn,
  unregisterTurn,
} from "./lib/turn-registry.js";
import { errorBody } from "./routes/helpers.js";
import { DIAGNOSTICS_RING_CAP, type RouteContext, type SidecarDiagnosticError } from "./routes/context.js";
// ROUND-84 (R84, Wave 2-a): the domain route modules — server.ts is now
// the assembler; each module registers its routes verbatim (registration
// order preserved; the shared context lives in routes/context.ts).
import { registerSessionRoutes } from "./routes/sessions.js";
import { readComposerSendFields, readOverrideProviderId } from "./routes/sessions.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerProjectRoutes } from "./routes/projects.js";

import { registerProviderRoutes } from "./routes/providers.js";
import { registerModelRoutes } from "./routes/models.js";
// R84 (Wave 2-a, phase 4): the small CRUD domains continue the split.
import { registerModeRoutes } from "./routes/modes.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerRatingRoutes } from "./routes/ratings.js";

/**
 * ROUND-63: the app version GET /health reports — read at BOOT from the
 * package.json that sits NEXT TO the compiled code (agent-core/package.json
 * in the dev workspace; sidecar/app/package.json inside the installed
 * desktop app, where the staging step copies the exact version). This used
 * to be a hardcoded "0.3.0" that went stale for 60+ rounds, which made
 * /health useless for exactly the thing it exists for: letting the
 * launcher PROVE the freshly installed desktop app is really running the
 * new engine (registry version + exe FileVersion + /health version must
 * all agree — see launcher `desktop_flow`'s verification chain).
 */
function readAppVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    // A missing/corrupt manifest must never take the engine down — /health
    // then reports 0.0.0 and the launcher's check flags it honestly.
    return "0.0.0";
  }
}

export const VERSION = readAppVersion();

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

// ── ROUND-50 (R50-c1): composer send-route field validation ───────────────────

/**
 * ROUND-82 (R82, §2.4.5): shape check for the orchestration PATCH's
 * subagentModel object form — {providerId: string, modelId: string}, both
 * non-blank. Anything else (wrong types, missing fields) is NOT the object
 * form and falls through to the legacy string/null branches.
 */
function isSubagentModelRefBody(value: unknown): value is { providerId: unknown; modelId: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return "providerId" in record && "modelId" in record;
}

/** ROUND-82: normalize the validated object form (trim + type-check the
 * two fields; blank strings 400 via the settings validator downstream —
 * this returns the typed shape). */
function normalizeSubagentModelRef(
  value: { providerId: unknown; modelId: unknown },
): { providerId: string; modelId: string } {
  return {
    providerId: typeof value.providerId === "string" ? value.providerId.trim() : "",
    modelId: typeof value.modelId === "string" ? value.modelId.trim() : "",
  };
}


// ── ROUND-67 (R67-A): attachment INGESTION constants ──────────────────────────

/**
 * ROUND-67 (R67-A): decoded-byte ceiling for a single uploaded attachment —
 * deliberately the SAME 8MB analyze_image enforces (tools/plugins/vision.ts
 * MAX_IMAGE_BYTES): a file the vision tool would refuse is not worth landing
 * in the project.
 */
const MAX_ATTACHMENT_UPLOAD_BYTES = 8 * 1024 * 1024;
/**
 * ROUND-67 (R67-A): per-route body cap for POST /attachments/upload. 8MB of
 * file bytes rides as ~10.7MB of base64 JSON — far above fastify's 1MB
 * default, which would 413 the request before the handler ever ran.
 */
const ATTACHMENT_UPLOAD_BODY_LIMIT_BYTES = 12 * 1024 * 1024;
/** ROUND-67 (R67-A): how many -2/-3… dedupe variants one name may mint. */
const ATTACHMENT_SUFFIX_CAP = 100;

/**
 * ROUND-67 (R67-A): the dedupe-suffixed form of an attachment name —
 * "photo.png" → "photo-2.png" (the EXTENSION survives so analyze_image's
 * extension gate still passes); extension-less names just append. Conservative
 * and honest: the counter starts at 2 and counts from the ORIGINAL name.
 */
function attachmentSuffixName(name: string, counter: number): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-${counter}${name.slice(dot)}` : `${name}-${counter}`;
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
  // failure can never break a turn).
  if (options.dataDir !== undefined) {
    ensureVapidKeys(options.dataDir);
    getNotificationBus().subscribe((n) => {
      try {
        sendPushToAll(db, n);
      } catch (err) {
        console.error("[web-push] fanout threw:", err);
      }
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

  // ARCHITECTURE §2.3/§7: every route except GET /health requires the bearer token.
  app.addHook("preHandler", async (request, reply) => {
    if (isHealthRequest(request.method, request.url)) return;
    if (!isAuthorized(request.headers.authorization, token)) {
      return reply
        .code(401)
        .send(errorBody("UNAUTHORIZED", "missing or invalid bearer token"));
    }
  });

  // Unknown paths keep the token wall too; known+authed misses get the envelope.
  app.setNotFoundHandler((request, reply) => {
    if (!isHealthRequest(request.method, request.url) && !isAuthorized(request.headers.authorization, token)) {
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
  // destructures only what its domain uses.
  const ctx: RouteContext = { token, db, keyring, chat, corsHeadersFor, diagnosticsRing };


  app.get("/health", async () => ({
    status: "ok",
    app: "acute-code",
    version: VERSION,
  }));

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
    // 'delete' uses the same shape with a sentinel value; the shell only
    // sends 'set' today.
    keyring.set(providerId, action === "delete" ? "" : value);
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

      // ── ROUND-50 (R50-c1): reading attachment content ──────────────────────
      // POST /attachments/read — body { paths: string[], projectId? } → the
      // text heads the composer attaches. Per-file outcomes (NEVER a 500):
      //   - relative paths resolve ONLY inside the given project's root
      //     (escape / missing project → per-file error entry);
      //   - absolute paths read as-is (user-picked files; local-first app,
      //     user-initiated read);
      //   - files > 512KB are refused; text = the first 128KB head
      //     (truncated: true when longer);
      //   - a NUL byte in the first 8KB marks binary → text: null.
      scope.post("/attachments/read", async (request, reply) => {
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        const raw = body as Record<string, unknown>;
        if (!Array.isArray(raw.paths) || raw.paths.some((p) => typeof p !== "string")) {
          return reply.code(400).send(
            errorBody("VALIDATION", "paths must be an array of strings", {
              field: "body.paths",
            }),
          );
        }
        const paths = raw.paths as string[];
        if (paths.length > 20) {
          return reply.code(400).send(
            errorBody("VALIDATION", "at most 20 paths per request", { field: "body.paths" }),
          );
        }
        if (raw.projectId !== undefined && typeof raw.projectId !== "string") {
          return reply.code(400).send(
            errorBody("VALIDATION", "projectId must be a string", { field: "body.projectId" }),
          );
        }
        const projectId = typeof raw.projectId === "string" ? raw.projectId : undefined;
        const project = projectId !== undefined ? getProject(db, projectId) : undefined;

        const MAX_READABLE_BYTES = 512 * 1024;
        const TEXT_HEAD_BYTES = 128 * 1024;
        const BINARY_SNIFF_BYTES = 8 * 1024;

        const files = paths.map((path): Record<string, unknown> => {
          const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
          const errorEntry = (error: string): Record<string, unknown> => ({
            path,
            name,
            size: 0,
            text: null,
            truncated: false,
            error,
          });

          // Resolve: absolute (user-picked) vs project-relative.
          let abs: string;
          const isAbsoluteLike = path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path);
          if (isAbsoluteLike) {
            abs = path;
          } else {
            if (project === undefined) {
              return errorEntry(
                projectId !== undefined
                  ? `project ${projectId} not found — relative paths need a valid project`
                  : "relative paths need a projectId",
              );
            }
            const resolved = resolveInsideRoot(project.rootPath, path);
            if ("error" in resolved) return errorEntry(resolved.error);
            abs = resolved.abs;
          }

          try {
            const stats = statSync(abs);
            if (stats.isDirectory()) {
              return errorEntry(`'${path}' is a directory, not a file`);
            }
            if (stats.size > MAX_READABLE_BYTES) {
              return errorEntry(
                `file is ${stats.size} bytes — above the 512KB attachment read limit`,
              );
            }
            const head = readFileSync(abs);
            const sniff = head.subarray(0, BINARY_SNIFF_BYTES);
            if (sniff.includes(0)) {
              // Binary (a NUL byte in the first 8KB) — no text, honest size.
              return { path, name, size: stats.size, text: null, truncated: false };
            }
            const text = head.subarray(0, TEXT_HEAD_BYTES).toString("utf8");
            return {
              path,
              name,
              size: stats.size,
              text,
              truncated: stats.size > TEXT_HEAD_BYTES,
            };
          } catch {
            return errorEntry(`cannot read '${path}': no such file or unreadable`);
          }
        });

        return reply.code(200).send({ files });
      });

      // ── ROUND-67 (R67-A): attachment INGESTION ────────────────────────────
      // POST /attachments/upload — body { projectId, name, dataBase64? |
      // absolutePath? }, EXACTLY ONE source. The owner's #1 v0.66.0 field
      // report: "I uploaded an image directly in chat and the agent said the
      // image doesn't exist. It does not actually upload the image, it just
      // shows the path." — dropped/pasted bytes died in the BROWSER (the
      // composer's NUL-sniff read the ArrayBuffer only to discard it), the
      // wire attachment never carried bytes, and renderAttachments showed the
      // model a.name only, so analyze_image guessed at paths and ENOENT'd.
      // This route is the missing half of the pipeline:
      //   - dataBase64   → the composer's dropped/pasted bytes (≤8MB decoded,
      //                    base64-validated with a round-trip length check),
      //                    written to <root>/attachments/<sanitized-name>;
      //   - absolutePath → an OS-picker file the SIDECAR copies in (fs
      //                    copyFile — the picker returns trusted absolute
      //                    paths, the same trust POST /attachments/read reads
      //                    them with).
      // The target is DEDUPED: an identical file (same size AND content) is
      // reused; a DIFFERENT file under the same name gets a -2/-3… suffix
      // before the extension — NEVER an overwrite. Containment follows the
      // resolveInsideRoot convention (fs-ops.ts): the name is sanitized to a
      // single plain filename, then joined under <root>/attachments/. Reply:
      // 200 { path: "attachments/<final-name>" (PROJECT-RELATIVE, forward
      // slashes), name, size } — the composer threads `path` back onto the
      // chip, onto message.user, and renderAttachments renders it as the
      // exact analyze_image instruction. Per-route bodyLimit: 8MB of bytes
      // rides as ~10.7MB of base64 JSON, far above fastify's 1MB default.
      scope.post(
        "/attachments/upload",
        { bodyLimit: ATTACHMENT_UPLOAD_BODY_LIMIT_BYTES },
        async (request, reply) => {
          const body: unknown = request.body;
          if (typeof body !== "object" || body === null || Array.isArray(body)) {
            return reply
              .code(400)
              .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
          }
          const raw = body as Record<string, unknown>;

          // Project → whose attachments/ dir receives the file.
          if (typeof raw.projectId !== "string" || raw.projectId.trim() === "") {
            return reply.code(400).send(
              errorBody("VALIDATION", "projectId must be a non-empty string", {
                field: "body.projectId",
              }),
            );
          }
          const project = getProject(db, raw.projectId);
          if (project === undefined) {
            return reply
              .code(404)
              .send(errorBody("NOT_FOUND", `no project with id ${raw.projectId}`));
          }

          // Name → the on-disk filename. Sanitized to a PLAIN filename: no
          // path separators, no '..' (conservatively anywhere — also rejects
          // harmless 'x..y.png', never the traversal vector), no control
          // characters, ≤200 chars (the readComposerSendFields caps). The
          // EXTENSION survives (the dedupe suffix keeps it too).
          if (typeof raw.name !== "string" || raw.name.trim() === "" || raw.name.length > 200) {
            return reply.code(400).send(
              errorBody("VALIDATION", "name must be a non-empty string (≤200 chars)", {
                field: "body.name",
              }),
            );
          }
          const name = raw.name;
          if (/[\\/]/.test(name) || name.includes("..") || /[\u0000-\u001f\u007f]/.test(name)) {
            return reply.code(400).send(
              errorBody(
                "VALIDATION",
                "name must be a plain filename — no path separators, '..', or control characters",
                { field: "body.name" },
              ),
            );
          }

          // EXACTLY ONE source of bytes (typed checks keep the error honest
          // for junk values, not just absence).
          if (raw.dataBase64 !== undefined && typeof raw.dataBase64 !== "string") {
            return reply.code(400).send(
              errorBody("VALIDATION", "dataBase64 must be a base64 string", {
                field: "body.dataBase64",
              }),
            );
          }
          if (raw.absolutePath !== undefined && typeof raw.absolutePath !== "string") {
            return reply.code(400).send(
              errorBody("VALIDATION", "absolutePath must be a string", {
                field: "body.absolutePath",
              }),
            );
          }
          const hasData = typeof raw.dataBase64 === "string";
          const hasPath = typeof raw.absolutePath === "string";
          if (hasData && hasPath) {
            return reply.code(400).send(
              errorBody("VALIDATION", "pass dataBase64 OR absolutePath — one, not both", {
                field: "body",
              }),
            );
          }
          if (!hasData && !hasPath) {
            return reply.code(400).send(
              errorBody(
                "VALIDATION",
                "exactly one of dataBase64 (base64 file bytes) or absolutePath (a file to copy) is required",
                { field: "body" },
              ),
            );
          }

          // Obtain the bytes. dataBase64: strict base64 (regex + length %4 +
          // round-trip decoded length) and the 8MB cap. absolutePath: the
          // same absolute-path trust the read route applies, then stat + read
          // (the read is needed for the dedupe comparison; the write itself
          // uses copyFile).
          let bytes: Buffer;
          let copyFrom: string | null = null;
          if (hasData) {
            const dataBase64 = raw.dataBase64 as string;
            const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
            const expectedBytes = (dataBase64.length / 4) * 3 - padding;
            if (
              dataBase64 === "" ||
              !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64) ||
              dataBase64.length % 4 !== 0
            ) {
              return reply.code(400).send(
                errorBody("VALIDATION", "dataBase64 is not a valid base64 string", {
                  field: "body.dataBase64",
                }),
              );
            }
            bytes = Buffer.from(dataBase64, "base64");
            if (bytes.length !== expectedBytes) {
              return reply.code(400).send(
                errorBody("VALIDATION", "dataBase64 is not a valid base64 string", {
                  field: "body.dataBase64",
                }),
              );
            }
            if (bytes.length > MAX_ATTACHMENT_UPLOAD_BYTES) {
              return reply.code(400).send(
                errorBody(
                  "VALIDATION",
                  `attachment is ${bytes.length} bytes — above the ${MAX_ATTACHMENT_UPLOAD_BYTES / (1024 * 1024)}MB upload limit`,
                  { field: "body.dataBase64" },
                ),
              );
            }
          } else {
            const absolutePath = (raw.absolutePath as string).trim();
            const absoluteLike = absolutePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(absolutePath);
            if (absolutePath === "" || !absoluteLike) {
              return reply.code(400).send(
                errorBody("VALIDATION", `absolutePath must be an ABSOLUTE path (got '${raw.absolutePath}')`, {
                  field: "body.absolutePath",
                }),
              );
            }
            try {
              const stats = statSync(absolutePath);
              if (stats.isDirectory()) {
                return reply.code(400).send(
                  errorBody("VALIDATION", `'${absolutePath}' is a directory, not a file`, {
                    field: "body.absolutePath",
                  }),
                );
              }
              bytes = readFileSync(absolutePath);
              copyFrom = absolutePath;
            } catch {
              return reply.code(400).send(
                errorBody("VALIDATION", `cannot read '${absolutePath}': no such file or unreadable`, {
                  field: "body.absolutePath",
                }),
              );
            }
          }

          // Persist INSIDE the project (fs-ops writeFile style: sync fs,
          // mkdir with parents, try/catch, honest envelope).
          try {
            const attachmentsDir = join(project.rootPath, "attachments");
            mkdirSync(attachmentsDir, { recursive: true });
            let finalName = name;
            let reused = false;
            for (let counter = 2; ; counter++) {
              const candidate = join(attachmentsDir, finalName);
              if (!existsSync(candidate)) break;
              let identical = false;
              try {
                const existing = readFileSync(candidate);
                identical = existing.length === bytes.length && existing.equals(bytes);
              } catch {
                // Unreadable incumbent — treat as a different file (never a
                // silent reuse of something we could not verify).
              }
              if (identical) {
                reused = true;
                break;
              }
              if (counter > ATTACHMENT_SUFFIX_CAP) {
                return reply.code(409).send(
                  errorBody(
                    "CONFLICT",
                    `attachments/${name} already has ${ATTACHMENT_SUFFIX_CAP} different variants — refusing to mint more`,
                  ),
                );
              }
              finalName = attachmentSuffixName(name, counter);
            }
            const target = join(attachmentsDir, finalName);
            if (!reused) {
              if (copyFrom !== null) copyFileSync(copyFrom, target);
              else writeFileSync(target, bytes);
            }
            const size = statSync(target).size;
            return reply.code(200).send({
              path: `attachments/${finalName}`,
              name: finalName,
              size,
            });
          } catch (error) {
            return reply.code(500).send(
              errorBody(
                "INTERNAL",
                `could not persist attachment '${name}': ${error instanceof Error ? error.message : "unknown error"}`,
              ),
            );
          }
        },
      );

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

      // ── ROUND-36: orchestration settings ──────────────────────────────

      scope.get("/settings/orchestration", async () => {
        return getOrchestrationSettings(db);
      });

      scope.put("/settings/orchestration", async (request, reply) => {
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        const raw = body as Record<string, unknown>;
        try {
          return setOrchestrationSettings(db, {
            ...(typeof raw.maxParallel === "number" ? { maxParallel: raw.maxParallel } : {}),
            ...(typeof raw.perKeyLimit === "number" ? { perKeyLimit: raw.perKeyLimit } : {}),
            // ROUND-43 (R43-5): temporary sub-agent model override — string id
            // (catalog-validated in settings.ts) or null to re-inherit.
            // ROUND-82 (R82, §2.4.5): the provider-scoped {providerId,
            // modelId} object form — a NIM/custom configured row can be the
            // sub-agent model (validated in settings.ts: provider exists,
            // explicit tools=false rejects).
            ...(typeof raw.subagentModel === "string" ? { subagentModel: raw.subagentModel } : {}),
            ...(raw.subagentModel === null ? { subagentModel: null } : {}),
            ...(isSubagentModelRefBody(raw.subagentModel)
              ? { subagentModel: normalizeSubagentModelRef(raw.subagentModel) }
              : {}),
            // ROUND-52 (R52-b): the child-supervisor knobs (heartbeat cadence
            // + stall threshold) — validated + clamped in settings.ts.
            ...(typeof raw.childWatchdogMs === "number" ? { childWatchdogMs: raw.childWatchdogMs } : {}),
            ...(typeof raw.childStallTimeoutMs === "number"
              ? { childStallTimeoutMs: raw.childStallTimeoutMs }
              : {}),
          });
        } catch (error) {
          return reply.code(400).send(
            errorBody("VALIDATION", error instanceof Error ? error.message : "invalid settings", {
              field: "body",
            }),
          );
        }
      });

      // ── ROUND-49: memory settings (the master switch) ───────────────────

      scope.get("/settings/memory", async () => {
        return getMemorySettings(db);
      });

      scope.put("/settings/memory", async (request, reply) => {
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        const raw = body as Record<string, unknown>;
        if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body.enabled must be a boolean", { field: "body.enabled" }));
        }
        try {
          return setMemorySettings(db, {
            ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
          });
        } catch (error) {
          return reply.code(400).send(
            errorBody("VALIDATION", error instanceof Error ? error.message : "invalid settings", {
              field: "body",
            }),
          );
        }
      });

      // ── ROUND-65: debug settings (the agent self-report switch) ──────

      scope.get("/settings/debug", async () => {
        return getDebugSettings(db);
      });

      scope.put("/settings/debug", async (request, reply) => {
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        const raw = body as Record<string, unknown>;
        if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body.enabled must be a boolean", { field: "body.enabled" }));
        }
        try {
          return setDebugSettings(db, {
            ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
          });
        } catch (error) {
          return reply.code(400).send(
            errorBody("VALIDATION", error instanceof Error ? error.message : "invalid settings", {
              field: "body",
            }),
          );
        }
      });

      // ── ROUND-78 (R78, owner: "General Settings 重试配置"): the per-class
      // auto-retry switches. Same shape/behavior as /settings/debug — GET
      // returns the full RetrySettings, PUT accepts a partial patch and
      // returns the updated object. The runtime's retry ladder reads these
      // per turn (a disabled class fails fast with the provider's real error
      // text). ROUND-80 (R80): the object gained maxAttempts + waitMinutes +
      // providerTimeoutSeconds (the customizable schedule; validated against
      // the same bounds the runtime resolves with).

      scope.get("/settings/retry", async () => {
        return getRetrySettings(db);
      });

      scope.put("/settings/retry", async (request, reply) => {
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        const raw = body as Record<string, unknown>;
        for (const field of ["autoRetryRateLimit", "autoRetryTimeout", "autoRetryNetwork"] as const) {
          if (raw[field] !== undefined && typeof raw[field] !== "boolean") {
            return reply
              .code(400)
              .send(errorBody("VALIDATION", `body.${field} must be a boolean`, { field: `body.${field}` }));
          }
        }
        // ROUND-80 (R80): the numeric schedule fields — validated here with
        // the exact bounds setRetrySettings enforces (the route names the
        // offending field; the storage error is the backstop).
        if (raw.maxAttempts !== undefined) {
          if (
            typeof raw.maxAttempts !== "number" ||
            !Number.isInteger(raw.maxAttempts) ||
            raw.maxAttempts < 2 ||
            raw.maxAttempts > 10
          ) {
            return reply.code(400).send(
              errorBody("VALIDATION", "body.maxAttempts must be an integer between 2 and 10", {
                field: "body.maxAttempts",
              }),
            );
          }
        }
        if (raw.waitMinutes !== undefined) {
          if (!Array.isArray(raw.waitMinutes) || raw.waitMinutes.length === 0 || raw.waitMinutes.length > 9) {
            return reply
              .code(400)
              .send(errorBody("VALIDATION", "body.waitMinutes must be an array of 1 to 9 numbers", { field: "body.waitMinutes" }));
          }
          for (const entry of raw.waitMinutes) {
            if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0 || entry > 1440) {
              return reply.code(400).send(
                errorBody("VALIDATION", "body.waitMinutes entries must be numbers between 0 and 1440 (minutes)", {
                  field: "body.waitMinutes",
                }),
              );
            }
          }
        }
        if (raw.providerTimeoutSeconds !== undefined) {
          if (
            typeof raw.providerTimeoutSeconds !== "number" ||
            !Number.isInteger(raw.providerTimeoutSeconds) ||
            raw.providerTimeoutSeconds < 60 ||
            raw.providerTimeoutSeconds > 3600
          ) {
            return reply.code(400).send(
              errorBody("VALIDATION", "body.providerTimeoutSeconds must be an integer between 60 and 3600", {
                field: "body.providerTimeoutSeconds",
              }),
            );
          }
        }
        try {
          return setRetrySettings(db, {
            ...(typeof raw.autoRetryRateLimit === "boolean" ? { autoRetryRateLimit: raw.autoRetryRateLimit } : {}),
            ...(typeof raw.autoRetryTimeout === "boolean" ? { autoRetryTimeout: raw.autoRetryTimeout } : {}),
            ...(typeof raw.autoRetryNetwork === "boolean" ? { autoRetryNetwork: raw.autoRetryNetwork } : {}),
            ...(typeof raw.maxAttempts === "number" ? { maxAttempts: raw.maxAttempts } : {}),
            ...(Array.isArray(raw.waitMinutes) ? { waitMinutes: raw.waitMinutes as number[] } : {}),
            ...(typeof raw.providerTimeoutSeconds === "number"
              ? { providerTimeoutSeconds: raw.providerTimeoutSeconds }
              : {}),
          });
        } catch (error) {
          return reply.code(400).send(
            errorBody("VALIDATION", error instanceof Error ? error.message : "invalid settings", {
              field: "body",
            }),
          );
        }
      });

      // STREAMED turn (round-16): same validation + persistence as the sync
      // route, but Server-Sent Events stream out live: {type:'text-delta'},
      // {type:'tool-call'}, {type:'tool-result'}, {type:'finish'} and a
      // terminal {type:'done'|'error'} envelope. Client disconnects (closed
      // tab / stop) abort the provider call via AbortSignal.
      //
      // ROUND-42 (owner: "I sent another message and this time I closed the
      // window so it should send me a notification after it has completed the
      // task"): a client disconnect NO LONGER aborts the turn. The turn runs
      // to completion in the background (events keep persisting to SQLite,
      // the completion notification fires, and Web Push delivers it to the
      // closed window's service worker). Only an explicit POST
      // /sessions/:id/stop (the UI's Stop button) aborts. Live SSE frames
      // are skipped once the client is gone — writing to a destroyed socket
      // would throw.
      scope.post("/sessions/:id/messages/stream", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        const raw = body as Record<string, unknown>;
        const content = raw.content;
        if (typeof content !== "string" || content.trim() === "") {
          return reply.code(400).send(
            errorBody("VALIDATION", "content must be a non-empty string", {
              field: "body.content",
            }),
          );
        }
        const modelOverride =
          typeof raw.model === "string" && raw.model.trim() !== "" ? raw.model : undefined;
        // ROUND-82: the send's provider (see the sync route's comment — the
        // same validation, shared by both routes).
        const overrideProviderId = readOverrideProviderId(db, raw);
        if (overrideProviderId.error !== undefined) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", overrideProviderId.error, { field: "body.providerId" }));
        }
        const turnModelOverride =
          modelOverride === undefined
            ? undefined
            : { model: modelOverride, ...(overrideProviderId.value !== undefined ? { providerId: overrideProviderId.value } : {}) };
        // ROUND-82 (R82): the CURRENT turn's override for the queue-
        // continuation loop — starts as the original send's; each
        // continuation adopts the consumed queued message's OWN override
        // (the picker state when it was queued) when it carries one, else
        // keeps the running override (the pre-R82 behavior was to drop the
        // override entirely and fall back to the agent default). Declared
        // OUTSIDE the try so the debug-analyst phase below reads the LAST
        // turn's override (it mirrors the provider that actually served the
        // stream's final turn).
        let currentModelOverride: TurnModelOverride | undefined = turnModelOverride;
        // ROUND-50 (R50-c1): the composer's per-send fields (same validation
        // as the sync route — see the comment there).
        const composer = readComposerSendFields(raw, reply);
        if (!composer.ok) return reply;

        reply.hijack();
        const res = reply.raw;
        // ROUND-30 FIX (owner Windows bug "Failed to fetch" after every
        // message): headers set via reply.header() in the onRequest hook are
        // dropped once the reply is hijacked, so the SSE response previously
        // shipped WITHOUT Access-Control-Allow-Origin — the browser blocked
        // the cross-origin response and fetch() rejected. Write the CORS
        // headers directly into the raw writeHead here.
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          ...corsHeadersFor(request.headers.origin),
        });
        let clientGone = false;
        res.on("close", () => {
          // ROUND-42: do NOT abort the turn — it completes in the background
          // (the owner closes the window and still expects the task to finish
          // + a desktop notification). Only mark the socket dead so send()
          // stops writing to it.
          clientGone = true;
        });
        const send = (event: unknown) => {
          if (clientGone) return;
          try {
            if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
          } catch {
            // The socket died mid-write — treat the client as gone.
            clientGone = true;
          }
        };
        const abort = new AbortController();
        // ROUND-42 → R52-b: registry for POST /sessions/:id/stop (SHARED with
        // the orchestrator's child turns). One live turn per session — a
        // second turn on the same session replaces the entry (the runtime
        // refuses concurrent turns anyway).
        // ROUND-78 (R78): `send` registers as the turn's NOTIFIER — the queue
        // route (POST /sessions/:id/queue) rides notifyTurn so its
        // user.queued frames land on this still-open stream. The single
        // registration spans the WHOLE queue-continuation loop below (one
        // registration per SSE request; the runtime never re-registers).
        registerTurn(id, abort, send);

        // ── ROUND-66 (R66-2-c, owner's C1 directive): the post-turn DEBUG
        // ANALYST phase. When debug mode (Settings → Advanced) is ON and the
        // turn finished on its own (ok, or a real failure — NEVER a
        // deliberate ABORTED stop), a COMPLETELY NEW context-free agent is
        // launched here: it receives the session's WHOLE transcript (user
        // request, every tool call with its COMPLETE result, errors) and
        // streams its analysis live over this still-open SSE as
        // debug-start / debug-delta* / debug-done (or debug-error) frames,
        // BEFORE the turn's own done/error frame — so the frontend renders
        // the dedicated debug section at the bottom of the LIVE turn. On
        // success the report is ALSO persisted as a `debug.report` session
        // event (assembleHistory skips the type — a follow-up user message
        // NEVER includes it; toProjectChatItems folds it into the turn's
        // AssistantTurnItem.debugReport for reloads). A debug failure must
        // NEVER break the turn's own terminal frame — the phase catches
        // everything it can and the route's try/catch below is the
        // belt-and-suspenders guard.
        const runDebugAnalystPhase = async (): Promise<void> => {
          try {
            // (a) The debug setting — the same accessor the /settings/debug
            // routes use (default OFF → this whole phase is a no-op).
            if (getDebugSettings(db).enabled !== true) return;
            // (c) Minimal provider/model resolution for the session — the
            // exact helpers prepareTurn uses (session → agent → provider →
            // keyring key); the model mirrors the TURN's choice (the
            // per-send override when one was sent, else the agent default).
            const session = getSession(db, id);
            if (session === undefined || session.agentId === null) {
              send({ type: "debug-error", sessionId: id, message: "debug analyst: the session or its agent is gone" });
              return;
            }
            const agent = getAgent(db, session.agentId);
            if (agent === undefined || agent.providerId === null || agent.model === null) {
              send({
                type: "debug-error",
                sessionId: id,
                message: "debug analyst: the session's agent has no provider/model configured",
              });
              return;
            }
            // ROUND-82: the debug run mirrors the LAST turn's provider too —
            // an override that named a provider (the custom-model case)
            // debugs against THAT provider, not the agent's
            // (currentModelOverride tracks the queue-continuation loop).
            const debugProviderId =
              typeof currentModelOverride === "object" && currentModelOverride.providerId !== undefined
                ? currentModelOverride.providerId
                : agent.providerId;
            const provider = resolveProvider(db, debugProviderId);
            if (provider === undefined || provider.baseUrl === null) {
              send({
                type: "debug-error",
                sessionId: id,
                message: `debug analyst: provider '${debugProviderId}' is not resolvable`,
              });
              return;
            }
            const apiKey = keyring.get(provider.id);
            if (apiKey === undefined) {
              send({
                type: "debug-error",
                sessionId: id,
                message: `debug analyst: no API key for provider '${provider.id}'`,
              });
              return;
            }
            // ROUND-82: narrow the union (string | {model, providerId}) —
            // a bare-string override means the model alone (pre-R82 wire).
            const debugOverrideModel =
              typeof currentModelOverride === "object"
                ? currentModelOverride.model
                : typeof currentModelOverride === "string"
                  ? currentModelOverride
                  : undefined;
            const model = debugOverrideModel ?? agent.model;
            // (d) The live marker — the frontend opens the dedicated
            // streaming section (loading animation while the analyst works).
            send({ type: "debug-start", sessionId: id });
            // (e) The analyst itself — streams debug-delta frames through
            // send and never throws (provider failures come back as
            // { ok: false, error } with the API key scrubbed).
            const result = await runDebugAnalyst(
              { db, keyring, chat, chatStream: streamAiSdkChat },
              {
                sessionId: id,
                provider: { id: provider.id, baseUrl: provider.baseUrl, apiFormat: provider.apiFormat },
                apiKey,
                model,
                emit: send,
              },
            );
            if (result.ok) {
              // (f) Persist the report as a `debug.report` session event —
              // UNCONDITIONALLY (a closed window still gets the folded card
              // on reload; only the SSE frames skip when the client is
              // gone). Payload shape: { content, model, ts } + the storage
              // layer's own agentId/ts stamping.
              appendSessionEvent(db, id, {
                type: "debug.report",
                agentId: agent.id,
                payload: { content: result.content, model, ts: new Date().toISOString() },
              });
              send({ type: "debug-done", sessionId: id, content: result.content, model });
              // ROUND-83 (R83): meter the analyst's own spend (origin
              // "debug", agentId null — the audit's §2.12: real provider
              // spend that previously appeared in NO usage surface).
              // Best-effort: a recording failure never fails the phase.
              if (result.usage !== undefined && (result.usage.inputTokens > 0 || result.usage.outputTokens > 0)) {
                try {
                  const pricing = lookupPricing(db, provider.id, model);
                  const inputCost =
                    pricing.inputPricePerMtok === null
                      ? 0
                      : (result.usage.inputTokens / 1_000_000) * pricing.inputPricePerMtok;
                  const outputCost =
                    pricing.outputPricePerMtok === null
                      ? 0
                      : (result.usage.outputTokens / 1_000_000) * pricing.outputPricePerMtok;
                  recordUsage(
                    db,
                    {
                      agentId: null,
                      sessionId: id,
                      provider: provider.id,
                      model,
                      inputTokens: result.usage.inputTokens,
                      outputTokens: result.usage.outputTokens,
                      cachedInputTokens: result.usage.cachedInputTokens,
                      costUsd: inputCost + outputCost,
                      ts: new Date().toISOString(),
                    },
                    0,
                    { providerCalls: 1, origin: "debug" },
                  );
                } catch {
                  // Best-effort accounting — never a debug-phase failure.
                }
              }
            } else {
              send({ type: "debug-error", sessionId: id, message: result.error });
            }
          } catch (error) {
            // The phase's own guard — an unexpected crash in the closure
            // still produces the honest debug-error frame (and nothing else:
            // the turn's terminal frame below is untouched).
            send({
              type: "debug-error",
              sessionId: id,
              message: `debug analyst failed: ${
                error instanceof Error ? error.message : String(error)
              }`.slice(0, 2000),
            });
          }
        };

        try {
          // ── ROUND-78 (R78, owner: "工作中发送消息（排队）… the agent reads
          // it with full context and continues"): the QUEUE-CONTINUATION
          // loop. After a SUCCESSFUL turn, undelivered queued messages
          // CONTINUE THE SAME SSE STREAM: the FIRST queued event is CONSUMED
          // (deleted — its content/attachments become the next
          // runStreamedAgentTurn call's args), the REST are flipped directly
          // to message.user so the continuation turn's iteration 0 history
          // includes them (no queued.delivered frames for these — the folded
          // log the UI refetches owns their render), a
          // meta.queue_continue frame announces the count, and the loop
          // runs another full turn. One registration + one abort controller
          // span the WHOLE loop (a Stop aborts the in-flight continuation
          // — queued messages STAY queued, pre-flipped on the next send).
          // task_complete fires per successful turn; the debug analyst +
          // terminal frame run ONCE, after the loop exits. ABORTED/error
          // break the loop. Capped at MAX_QUEUE_CONTINUATIONS so a
          // queue→turn→queue cycle can never run forever — the honest break
          // closes the stream normally and leaves the rest queued.
          const MAX_QUEUE_CONTINUATIONS = 25;
          let continuations = 0;
          let currentContent = content;
          let currentAttachments = composer.value.attachments;
          // ROUND-82: currentModelOverride is declared above the try (the
          // debug-analyst phase reads the LAST turn's override through it).
          // (while(true) — the loop's exits are the outcome branches below;
          // the queue-continue `continue` is the only loop-around.)
          while (true) {
            const outcome = await runStreamedAgentTurn(
              { db, keyring, chat, chatStream: streamAiSdkChat },
              id,
              currentContent,
              send,
              currentModelOverride,
              abort.signal,
              composer.value.thinkingLevel,
              currentAttachments,
            );
            if (outcome.ok) {
              // ROUND-42: ALWAYS publish task_complete. The R40 didWork gate
              // (only tool-using turns) left the owner's conversational test
              // ("say hello, close the window") silent — a completed reply IS
              // a completed task from the owner's perspective. The in-page
              // Toaster only fires desktop notifications when the page is
              // hidden; the service worker push only fires when no visible
              // window exists — so an on-screen user still isn't spammed.
              // R78: fires per successful turn — continuations included.
              const session = getSession(db, id);
              getNotificationBus().publish(db, {
                kind: "task_complete",
                title: session?.title ?? "Task complete",
                body: outcome.assistantMessage.content.slice(0, 160),
                sessionId: id,
                projectId: session?.projectId ?? undefined,
              });
              // R78: the queue check — continue the same stream when
              // messages are waiting (and the cap is not reached).
              const queued = listUndeliveredQueuedMessages(db, id);
              if (queued.length > 0 && continuations < MAX_QUEUE_CONTINUATIONS) {
                continuations += 1;
                send({ type: "meta.queue_continue", count: queued.length });
                const first = queued[0];
                // CONSUME the first (delete the row — its content becomes
                // the next turn's user message, appended fresh by the
                // runtime; the stream itself is the notifier, so no
                // notifyTurn here).
                deleteQueuedMessage(db, id, first.seq);
                // DELIVER the rest (type-flip) — the continuation turn's
                // iteration 0 history includes them as ordinary user events
                // (the route flips them directly; loop-top delivery is a
                // no-op for these — no queued.delivered frames).
                for (const q of queued.slice(1)) deliverQueuedMessage(db, id, q.seq);
                const firstPayload =
                  first.payload !== null && typeof first.payload === "object"
                    ? (first.payload as Record<string, unknown>)
                    : null;
                currentContent =
                  firstPayload !== null && typeof firstPayload.content === "string"
                    ? firstPayload.content
                    : "";
                currentAttachments =
                  firstPayload !== null && Array.isArray(firstPayload.attachments)
                    ? (firstPayload.attachments as MessageAttachment[])
                    : undefined;
                // ROUND-82 (R82): the consumed entry's OWN override wins for
                // its continuation turn (the user's picker state when the
                // message was queued — fresher intent than the original
                // send's); absent → the running override stays (the original
                // send's).
                const queuedOverrideModel =
                  firstPayload !== null && typeof firstPayload.model === "string"
                    ? firstPayload.model.trim()
                    : "";
                if (queuedOverrideModel !== "") {
                  const queuedOverrideProviderId =
                    firstPayload !== null && typeof firstPayload.providerId === "string"
                      ? firstPayload.providerId.trim()
                      : "";
                  currentModelOverride =
                    queuedOverrideProviderId !== ""
                      ? { model: queuedOverrideModel, providerId: queuedOverrideProviderId }
                      : { model: queuedOverrideModel };
                }
                continue;
              }
              // R66-2-c: the debug analyst runs AFTER the outcome handling
              // (the completion notification fires the moment the turn is
              // done) and BEFORE the done frame — the live turn is still open,
              // so the report streams into the dedicated section under the
              // answer while the owner watches. The debug.report event +
              // debug-done frame land before the terminal done frame.
              // R78: once, after the loop's LAST successful turn (queue empty
              // or the cap's honest break — the remaining chips stay queued).
              await runDebugAnalystPhase();
              send({ type: "done", assistantMessage: outcome.assistantMessage, usage: outcome.usage });
            } else if (outcome.code === "ABORTED") {
              // ROUND-42: the user explicitly stopped the turn — a deliberate
              // stop is not a failure; no task_failed notification, and NO
              // debug analyst either (the owner deliberately stopped — there
              // is no completed turn to analyze; status 499 < 500 keeps the
              // gate below closed for the same reason). R78: the loop breaks
              // here — queued messages STAY queued (Stop does not purge the
              // queue; the chips persist, pre-flipped on the next send).
              send({ type: "stopped" });
            } else {
              // ROUND-40/42: real failures (provider errors, crashes) always
              // notify. Validation conflicts (404 unknown session / 409 wrong
              // state) are request errors, not task failures — no notification.
              // R78: the loop breaks — queued messages stay queued.
              const session = getSession(db, id);
              if (outcome.status >= 500) {
                // ROUND-75 (R75): when the transient-API retry ladder ran and
                // exhausted, the notification body says so — the owner asked
                // to be TOLD when the ladder gives up ("it will stop, notify
                // the user, and show the error message").
                // ROUND-80 (R80): the schedule line is built from the REAL
                // settings (describeRetrySchedule over the resolved
                // schedule) — the owner's customized ladder phrased
                // truthfully, never the hardcoded R75 rungs.
                const attempts = outcome.details?.attempts;
                const scheduleLine = describeRetrySchedule(resolveRetrySchedule(getRetrySettings(db)));
                getNotificationBus().publish(db, {
                  kind: "task_failed",
                  title: session?.title ?? "Task failed",
                  body:
                    typeof attempts === "number" && attempts > 1
                      ? `${outcome.message} — auto-retried ${attempts} times (${scheduleLine}) before giving up`
                      : outcome.message,
                  sessionId: id,
                  projectId: session?.projectId ?? undefined,
                });
                // R66-2-c: a REAL failure (status >= 500 — provider error,
                // loop guard) still ran real work the analyst can dissect
                // (the turn.error event is already persisted, so the
                // transcript carries the ERROR line). Validation conflicts
                // (404/409) and deliberate stops never reach here.
                await runDebugAnalystPhase();
              }
              send({
                type: "error",
                status: outcome.status,
                code: outcome.code,
                message: outcome.message,
                ...(outcome.details ? { details: outcome.details } : {}),
              });
            }
            break; // every terminal branch above ends the loop (queue-continue `continue`s are the only loop-around)
          }
        } catch (routeError) {
          // ROUND-43: an unexpected crash in the route itself (not a provider
          // failure) must still terminate the SSE stream with an error frame —
          // otherwise the client sees the socket end with no terminal event
          // and the turn dies silently (the owner's bug).
          // ROUND-80 (R80, the same silent-stop class): the R43 frame alone
          // was LIVE-ONLY — nothing was persisted, so a reload showed the
          // conversation ending at the user message with no error and the
          // session row stayed `running` until the next boot sweep (a
          // vanished failure). Best-effort persistTurnError (crash-guarded
          // — the handler must never itself throw) + the honest task_failed
          // notification + the session-status reset all ride along now.
          const message =
            routeError instanceof Error ? routeError.message : String(routeError);
          try {
            const session = getSession(db, id);
            const agent =
              session !== undefined && session.agentId !== null
                ? getAgent(db, session.agentId)
                : undefined;
            // The failed turn's user message: the LAST message.user event on
            // the log (best-effort — the crash may have landed anywhere).
            const events = listSessionEvents(db, id);
            let userSeq = 0;
            for (const ev of events) {
              if (ev.type === "message.user") userSeq = ev.seq;
            }
            if (session !== undefined) {
              persistTurnError(db, {
                sessionId: id,
                agentId: agent?.id ?? "unknown",
                userSeq,
                code: "INTERNAL_ERROR",
                message: `route crash: ${message}`,
                model: agent?.model ?? "unknown",
                providerId: agent?.providerId ?? "unknown",
                providerError: message,
                keySecrets: keyring.list().filter((v) => v.length >= 8),
              });
              getNotificationBus().publish(db, {
                kind: "task_failed",
                title: session.title ?? "Task failed",
                body: `route crash: ${message}`.slice(0, 300),
                sessionId: id,
                projectId: session.projectId ?? undefined,
              });
            }
          } catch {
            /* the crash handler never crashes — the error frame below is
               the guaranteed terminal event either way */
          }
          send({ type: "error", status: 500, code: "INTERNAL_ERROR", message });
        } finally {
          unregisterTurn(id, abort);
          if (!clientGone) {
            try {
              res.end();
            } catch {
              /* socket already dead */
            }
          }
        }
      });

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

      // ── ROUND-61 (R61) → ROUND-70 (R70-b, D1): SKILLS ──────────────────
      // The listing is now the MERGED surface: DB rows (builtin/user, the
      // editable source of truth) + file skills (project .acute/skills/ for
      // every registered project + user-global ~/.agents/skills/), provenance-
      // marked via `source` ("project-file" | "global-file") + the additive
      // `filePath`/`projectName` fields. DB rows shadow same-name files.
      // ROUND-72 (R72-c, additive): file-skill entries now also carry
      // `references` — the references/ metadata ({name, fileName, bytes},
      // possibly empty; DB rows omit the field). Metadata ONLY: reference
      // content is never served here — the agent loads it with
      // read_skill { name, reference }. Zero route/frontend changes required.
      scope.get("/skills", async () => {
        return { skills: listAllSkillsMerged(db) };
      });

      scope.post("/skills", async (request, reply) => {
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        try {
          const skill = createSkill(db, body as Parameters<typeof createSkill>[1]);
          return reply.code(201).send(skill);
        } catch (err) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", String((err as Error).message), { field: "body" }));
        }
      });

      scope.patch("/skills/:id", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        // R70-b (D1): file-defined skills are read-only — the SKILL.md on
        // disk is their editable source of truth.
        if (isFileSkillId(id)) {
          return reply
            .code(409)
            .send(
              errorBody(
                "CONFLICT",
                "file-defined skill: edit the SKILL.md file on disk instead (file skills are read-only in the app)",
              ),
            );
        }
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        try {
          const skill = updateSkill(db, id, body as Parameters<typeof updateSkill>[2]);
          if (skill === undefined) {
            return reply.code(404).send(errorBody("NOT_FOUND", `no skill with id ${id}`));
          }
          return skill;
        } catch (err) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", String((err as Error).message), { field: "body" }));
        }
      });

      scope.delete("/skills/:id", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        if (isFileSkillId(id)) {
          return reply
            .code(409)
            .send(
              errorBody(
                "CONFLICT",
                "file-defined skill: remove the SKILL.md file on disk instead (file skills are read-only in the app)",
              ),
            );
        }
        const result = deleteSkill(db, id);
        if (!result.ok) {
          return reply
            .code(result.note === "no such skill" ? 404 : 409)
            .send(errorBody(result.note === "no such skill" ? "NOT_FOUND" : "CONFLICT", result.note ?? "cannot delete"));
        }
        return reply.code(204).send();
      });

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

      // ---- Usage summary (SPEC §F7 dashboard chart) ----

      scope.get("/usage/summary", async (request, reply) => {
        const query = request.query as Record<string, string | undefined>;
        let days = 14;
        if (query.days !== undefined) {
          const parsed = Number(query.days);
          if (!Number.isInteger(parsed) || parsed < 1 || parsed > 90) {
            return reply.code(400).send(
              errorBody("VALIDATION", "days must be an integer between 1 and 90", {
                field: "query.days",
              }),
            );
          }
          days = parsed;
        }
        return getUsageSummary(db, { days });
      });

      // ---- ROUND-52 (R52-b): detailed usage analytics — the in-app /usage
      // screen (owner: "Usage screen section 2 … you apparently did not
      // implement the usage properly"). Same aggregation the PUBLIC
      // usage.json export runs (scripts/export-usage.mjs) minus its
      // redaction: this link is the private bearer-token loopback, so real
      // ids/titles/roles are the point. `days` scopes only the zero-filled
      // activity series; totals/tools/models/projects are whole-history. ----

      scope.get("/usage/detailed", async (request, reply) => {
        const query = request.query as Record<string, string | undefined>;
        let days = 30;
        if (query.days !== undefined) {
          const parsed = Number(query.days);
          if (!Number.isInteger(parsed) || parsed < 1 || parsed > 90) {
            return reply.code(400).send(
              errorBody("VALIDATION", "days must be an integer between 1 and 90", {
                field: "query.days",
              }),
            );
          }
          days = parsed;
        }
        return getDetailedUsage(db, { days });
      });

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
  await app.listen({ port: options.port ?? 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    await app.close();
    throw new Error("sidecar failed to bind a TCP port");
  }
  // The shell parses this exact line (ARCHITECTURE §2). R37 note: structured
  // log lines (JSON) may precede it on stdout — the shell prefix-scans for
  // ACUTE_READY, so they're harmless; only malformed non-JSON output would
  // risk confusing a stricter parser.
  console.log(`ACUTE_READY ${JSON.stringify({ port: address.port })}`);
  return { server: app, port: address.port };
}



