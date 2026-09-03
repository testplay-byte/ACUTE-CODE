/**
 * Sidecar HTTP server (API.md; ADR-0006). Wave 1: health + bearer-token auth +
 * agent registry CRUD. Wave 2 adds the provider registry (keyring-backed) and
 * single-agent sessions/chat. WebSocket and the remaining resources come in
 * later waves.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type {
  MemoryPolicy,
  MessageAttachment,
  PermissionMode,
  RunMode,
  ThinkingLevel,
} from "shared";
import { PERMISSION_MODES, THINKING_LEVELS } from "shared";
import { aiSdkChat, streamAiSdkChat, type ChatFn } from "./agents/chat.js";
import {
  assembleHistory,
  effectiveToolNames,
  getModelContextWindow,
  runSingleAgentTurn,
  runStreamedAgentTurn,
} from "./agents/runtime.js";
import { pickFiles, pickFolder } from "./dialogs.js";
import { projectTree, readFile, resolveInsideRoot, searchCode, searchFiles } from "./tools/index.js";
import {
  ProviderKeyring,
  ProviderTestError,
  fetchProviderModels,
  listProviderViews,
  resolveProvider,
  testProviderConnection,
} from "./providers/registry.js";
import {
  RESERVED_PROVIDER_IDS,
  clearProviderTombstone,
  createProviderRecord,
  deleteProviderRecord,
  providerExists,
  providerRecordIdExists,
  slugifyProviderId,
  updateProviderRecord,
} from "./storage/providers.js";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  projectRootPathExists,
} from "./storage/projects.js";
import {
  createSession,
  deleteSession,
  forkSession,
  getSession,
  lastSessionSeq,
  listSessionEvents,
  listSessions,
  listSubAgents,
  revertSession,
  searchSessions,
  updateSessionPermissionMode,
  updateSessionTitle,
} from "./storage/sessions.js";
import {
  getDebugSettings,
  getMemorySettings,
  getOrchestrationSettings,
  setDebugSettings,
  setMemorySettings,
  setOrchestrationSettings,
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
import {
  DEFAULT_MODEL_ID,
  MODEL_CATALOG,
  RECOMMENDED_MODEL_IDS,
  SUBAGENT_DEFAULT_MODEL_ID,
  deleteModel,
  listModels,
  updateModel,
  upsertModel,
} from "./storage/models.js";
import { listSnapshots, restoreSnapshot, getSnapshotBySeq } from "./storage/snapshots.js";
// ROUND-59 (R59-D): the RESPONSE RATING system — every assistant reply can
// be rated good/bad and is persisted WITH a full context snapshot (the
// owner's "full context will be properly shared"), exportable for failure
// analysis. Storage + typed errors live in storage/ratings.ts.
import {
  MAX_RATING_NOTE_CHARS,
  RatingError,
  deleteRating,
  listRatings,
  listSessionRatings,
  rateReply,
} from "./storage/ratings.js";
// ROUND-44 (R44-a): the agent memory system — per-project persistent
// knowledge (facts/decisions/preferences) with REST read/delete for the
// right-sidebar Memory tab. Saves happen via the memory_save tool.
import { deleteMemory, listMemories, memoryDigest } from "./storage/memory.js";
// ROUND-61 (R61): computer use, skills, MCP — the extension surface.
import {
  getComputerUseSettings,
  setComputerUseSettings,
  visionKeyringId,
} from "./storage/computer-use.js";
import { getComputerSession } from "./computer/session.js";
import { backendForPlatform, realRunner } from "./computer/backends/index.js";
import { listSkills, createSkill, updateSkill, deleteSkill } from "./storage/skills.js";
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
import { getIndexSummary, searchIndexSymbols } from "./storage/index.js";
import { estimateMessageTokens, estimateTokens } from "./context.js";
import { buildSystemPromptSections, readCustomRules } from "./agents/prompts.js";
import { openDatabase, type SqliteDatabase } from "./storage/db.js";
import {
  TOOL_NAMES,
  createAgent,
  deleteAgent,
  duplicateAgent,
  getAgent,
  listAgents,
  updateAgent,
  type Agent,
  type AgentInput,
} from "./storage/agents.js";
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
import { dirname } from "node:path";
// ROUND-43 (R43-10): embedded-browser proxy backend — all logic + routes live
// in browser-proxy.ts; server.ts only mounts it on the scoped API surface.
import { registerBrowserRoutes } from "./browser-proxy.js";
// ROUND-52 (R52-a): the background-job registry (GET /projects/:id/jobs,
// POST /jobs/:id/stop).
import { getJobStatus, listJobs, stopJob } from "./lib/background-jobs.js";
// ROUND-52 (R52-b): the SHARED live-turn registry — replaces the local
// activeTurns Map so sub-agent children (registered by the orchestrator)
// are stoppable through the SAME POST /sessions/:id/stop route as main
// turns. Reasons ("owner" | "stall") let the orchestrator report why a
// child ended.
import { registerTurn, unregisterTurn, abortTurn } from "./lib/turn-registry.js";

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

/** API.md §1.3: every non-2xx response carries this single shape. */
function errorBody(code: string, message: string, details?: Record<string, unknown>): unknown {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

// ── ROUND-59 (R59-E): the sidecar's DIAGNOSTICS ERROR RING ────────────────
// The owner: "proper console-like error monitoring and error handling… If
// there are any errors along the way then you can easily detect them by
// yourself." The frontend half lives in src/lib/error-bus.ts; this is the
// ENGINE half — every THROWN request error (status ≥ 500) lands in an
// in-memory ring that GET /diagnostics/errors serves to the right-sidebar
// Console tab, so engine failures and frontend failures read in ONE place.

/** One ring row — deliberately the fields the console renders, nothing else. */
export interface SidecarDiagnosticError {
  id: string;
  /** ISO timestamp of the failure. */
  ts: string;
  source: "sidecar";
  /** Capture point — "http" (fastify error handler) today. */
  kind: string;
  /** Always ≥ 500 — see the 4xx-exclusion decision in recordDiagnosticError. */
  statusCode: number;
  /** The error code (fastify FST_* code or the envelope code). */
  code: string;
  /** Scrubbed, length-bounded error message. */
  message: string;
  /** HTTP method of the failing request. */
  method: string;
  /** Request path with the query string STRIPPED (query params can carry data). */
  url: string;
  /** Frontend-parity field (the bus's AppError carries count) — always 1 here. */
  count: number;
}

/** Ring cap — matches the frontend bus ring (src/lib/error-bus.ts). */
const DIAGNOSTICS_RING_CAP = 200;

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

interface FieldIssue {
  field: string;
  message: string;
}

const MEMORY_POLICIES: readonly MemoryPolicy[] = ["none", "on-start", "every-turn"];
const KNOWN_TOOLS: readonly string[] = TOOL_NAMES;

/**
 * Hand-rolled validation (no schema dependency in Wave 1): validates an agent
 * body for create (`partial: false`, name required) or patch (`partial: true`).
 * Unknown keys are ignored; absent keys stay undefined in the returned input.
 */
function validateAgentInput(
  body: unknown,
  options: { partial: boolean; db: SqliteDatabase },
): { issues: FieldIssue[]; input: AgentInput } {
  const issues: FieldIssue[] = [];
  const input: AgentInput = {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { issues: [{ field: "body", message: "body must be a JSON object" }], input };
  }
  const raw = body as Record<string, unknown>;
  const present = (key: string): boolean => raw[key] !== undefined;

  if (present("name")) {
    if (typeof raw.name !== "string" || raw.name.trim() === "") {
      issues.push({ field: "body.name", message: "name must be a non-empty string" });
    } else {
      input.name = raw.name;
    }
  } else if (!options.partial) {
    issues.push({ field: "body.name", message: "name is required" });
  }

  for (const key of ["role", "systemPrompt"] as const) {
    if (!present(key)) continue;
    if (typeof raw[key] !== "string") {
      issues.push({ field: `body.${key}`, message: `${key} must be a string` });
    } else {
      input[key] = raw[key];
    }
  }

  for (const key of ["providerId", "model", "visionModel"] as const) {
    if (!present(key)) continue;
    const value = raw[key];
    if (value === null) {
      input[key] = null;
    } else if (typeof value !== "string") {
      issues.push({ field: `body.${key}`, message: `${key} must be a string or null` });
    } else if (key === "providerId" && !providerExists(options.db, value)) {
      issues.push({ field: "body.providerId", message: `unknown providerId: ${value}` });
    } else {
      input[key] = value;
    }
  }

  if (present("allowedTools")) {
    const value = raw.allowedTools;
    if (!Array.isArray(value) || value.some((tool) => typeof tool !== "string")) {
      issues.push({
        field: "body.allowedTools",
        message: `allowedTools must be an array of tool names (${KNOWN_TOOLS.join(", ")})`,
      });
    } else {
      const unknown = (value as string[]).filter((tool) => !KNOWN_TOOLS.includes(tool));
      if (unknown.length > 0) {
        issues.push({
          field: "body.allowedTools",
          message: `unknown tool names: ${unknown.join(", ")}`,
        });
      } else {
        input.allowedTools = value as string[];
      }
    }
  }

  if (present("skills")) {
    const value = raw.skills;
    if (!Array.isArray(value) || value.some((skill) => typeof skill !== "string")) {
      issues.push({ field: "body.skills", message: "skills must be an array of strings" });
    } else {
      input.skills = value as string[];
    }
  }

  if (present("memoryPolicy")) {
    const value = raw.memoryPolicy;
    if (typeof value !== "string" || !MEMORY_POLICIES.includes(value as MemoryPolicy)) {
      issues.push({
        field: "body.memoryPolicy",
        message: `body.memoryPolicy must be one of: ${MEMORY_POLICIES.join(", ")}`,
      });
    } else {
      input.memoryPolicy = value as MemoryPolicy;
    }
  }

  if (present("maxTurns")) {
    const value = raw.maxTurns;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      issues.push({
        field: "body.maxTurns",
        message: "maxTurns must be a non-negative integer",
      });
    } else {
      input.maxTurns = value;
    }
  }

  if (present("temperature")) {
    const value = raw.temperature;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2) {
      issues.push({
        field: "body.temperature",
        message: "temperature must be a number between 0 and 2",
      });
    } else {
      input.temperature = value;
    }
  }

  return { issues, input };
}

/* ── ROUND-50 (R50-d): model-config field gate ────────────────────────────────
 *
 * The owner now edits per-model pricing/context/limits through the Settings
 * → Models & Providers config dialog (POST /providers/:id/models upsert +
 * PATCH /models/:id). Both routes previously WHITELISTED the fields but
 * silently DROPPED any value of the wrong type — a patch that "saved" while
 * discarding the pricing the user typed. Every whitelisted field is now
 * validated strictly: a malformed value is a 400 VALIDATION naming the field.
 *
 * Nullability contract (mirrored by storage/models.ts upsertModel):
 *   number        → set the field
 *   null          → clear it back to "unknown" (NULL in the DB)
 *   absent        → leave the stored value untouched (upsert semantics)
 */
const MODEL_NUMERIC_FIELDS = [
  "contextWindow",
  "maxOutputTokens",
  "inputPricePerMtok",
  "inputPriceCachedPerMtok",
  "outputPricePerMtok",
] as const;

type ModelNumericValues = Partial<
  Record<(typeof MODEL_NUMERIC_FIELDS)[number], number | null>
>;

/** Reads the whitelisted numeric model fields off a raw JSON body.
 * Returns the values that are present, or the first offending field name
 * (mapped by the routes to 400 VALIDATION). */
function readModelNumericFields(
  raw: Record<string, unknown>,
): { ok: true; values: ModelNumericValues } | { ok: false; field: string } {
  const values: ModelNumericValues = {};
  for (const field of MODEL_NUMERIC_FIELDS) {
    const value = raw[field];
    if (value === undefined) continue;
    if (value === null || typeof value === "number") {
      values[field] = value;
      continue;
    }
    return { ok: false, field };
  }
  return { ok: true, values };
}

/** Strict gate for the non-numeric model-config fields: displayName must be a
 * string, the toggles booleans. Returns the offending field name for 400s. */
function readModelScalarFields(
  raw: Record<string, unknown>,
): { ok: true } | { ok: false; field: string } {
  if (raw.displayName !== undefined && typeof raw.displayName !== "string") {
    return { ok: false, field: "displayName" };
  }
  if (raw.supportsThinking !== undefined && typeof raw.supportsThinking !== "boolean") {
    return { ok: false, field: "supportsThinking" };
  }
  if (raw.hidden !== undefined && typeof raw.hidden !== "boolean") {
    return { ok: false, field: "hidden" };
  }
  // ROUND-61 (R61): the vision flag — same boolean gate as thinking.
  if (raw.supportsVision !== undefined && typeof raw.supportsVision !== "boolean") {
    return { ok: false, field: "supportsVision" };
  }
  return { ok: true };
}

// ── ROUND-50 (R50-c1): composer send-route field validation ───────────────────

/** Max attachments per send (mirrors /attachments/read's path cap). */
const MAX_ATTACHMENTS_PER_SEND = 20;
/** Server-side cap on a single attachment's text (128KB head — the same
 * slice POST /attachments/read would have produced). */
const MAX_ATTACHMENT_TEXT_CHARS = 128 * 1024;

export interface ComposerSendFields {
  thinkingLevel?: ThinkingLevel;
  attachments?: MessageAttachment[];
}

/**
 * ROUND-50 (R50-c1): validate the composer's extra send fields shared by
 * BOTH send routes (POST /sessions/:id/messages and /messages/stream):
 * - `thinkingLevel` — optional; when present it must be one of the 4
 *   ThinkingLevel values (400 VALIDATION otherwise).
 * - `attachments` — optional array (≤20 items) of
 *   { name: non-empty string ≤200 chars, path?, size?, text?: string|null }.
 *   The text is capped server-side to 128KB; unknown/extra fields are
 *   dropped (never echoed into the persisted payload).
 * Returns the error reply on failure (mirrors the routes' 400 shape).
 */
function readComposerSendFields(
  raw: Record<string, unknown>,
  reply: FastifyReply,
): { ok: true; value: ComposerSendFields } | { ok: false } {
  let thinkingLevel: ThinkingLevel | undefined;
  if (raw.thinkingLevel !== undefined) {
    if (typeof raw.thinkingLevel !== "string" || !THINKING_LEVELS.includes(raw.thinkingLevel as ThinkingLevel)) {
      reply.code(400).send(
        errorBody("VALIDATION", "thinkingLevel must be one of default|low|high|max", {
          field: "body.thinkingLevel",
        }),
      );
      return { ok: false };
    }
    if (raw.thinkingLevel !== "default") thinkingLevel = raw.thinkingLevel as ThinkingLevel;
  }

  let attachments: MessageAttachment[] | undefined;
  if (raw.attachments !== undefined) {
    if (!Array.isArray(raw.attachments)) {
      reply.code(400).send(
        errorBody("VALIDATION", "attachments must be an array", { field: "body.attachments" }),
      );
      return { ok: false };
    }
    if (raw.attachments.length > MAX_ATTACHMENTS_PER_SEND) {
      reply.code(400).send(
        errorBody("VALIDATION", `at most ${MAX_ATTACHMENTS_PER_SEND} attachments per message`, {
          field: "body.attachments",
        }),
      );
      return { ok: false };
    }
    const parsed: MessageAttachment[] = [];
    for (const [i, entry] of raw.attachments.entries()) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        reply.code(400).send(
          errorBody("VALIDATION", `attachments[${i}] must be an object`, {
            field: `body.attachments[${i}]`,
          }),
        );
        return { ok: false };
      }
      const item = entry as Record<string, unknown>;
      if (typeof item.name !== "string" || item.name.trim() === "" || item.name.length > 200) {
        reply.code(400).send(
          errorBody("VALIDATION", `attachments[${i}].name must be a non-empty string (≤200 chars)`, {
            field: `body.attachments[${i}].name`,
          }),
        );
        return { ok: false };
      }
      if (item.path !== undefined && typeof item.path !== "string") {
        reply.code(400).send(
          errorBody("VALIDATION", `attachments[${i}].path must be a string`, {
            field: `body.attachments[${i}].path`,
          }),
        );
        return { ok: false };
      }
      if (item.size !== undefined && (typeof item.size !== "number" || !Number.isFinite(item.size) || item.size < 0)) {
        reply.code(400).send(
          errorBody("VALIDATION", `attachments[${i}].size must be a non-negative number`, {
            field: `body.attachments[${i}].size`,
          }),
        );
        return { ok: false };
      }
      if (item.text !== undefined && item.text !== null && typeof item.text !== "string") {
        reply.code(400).send(
          errorBody("VALIDATION", `attachments[${i}].text must be a string or null`, {
            field: `body.attachments[${i}].text`,
          }),
        );
        return { ok: false };
      }
      parsed.push({
        name: item.name,
        ...(typeof item.path === "string" ? { path: item.path } : {}),
        ...(typeof item.size === "number" ? { size: item.size } : {}),
        ...(typeof item.text === "string"
          ? { text: item.text.slice(0, MAX_ATTACHMENT_TEXT_CHARS) }
          : item.text === null
            ? { text: null }
            : {}),
      });
    }
    if (parsed.length > 0) attachments = parsed;
  }

  return {
    ok: true,
    value: {
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      ...(attachments !== undefined ? { attachments } : {}),
    },
  };
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

      scope.get("/agents", async (request) => {
        const query = request.query as Record<string, string | undefined>;
        const includeTemplates = (query.includeTemplates ?? "true").toLowerCase() !== "false";
        return { agents: listAgents(db, includeTemplates) };
      });

      scope.post("/agents", async (request, reply) => {
        const { issues, input } = validateAgentInput(request.body, {
          partial: false,
          db,
        });
        const firstIssue = issues[0];
        if (firstIssue !== undefined || input.name === undefined) {
          const issue =
            firstIssue ?? { field: "body.name", message: "name is required" };
          return reply
            .code(400)
            .send(errorBody("VALIDATION", issue.message, { field: issue.field }));
        }
        const agent = createAgent(db, { ...input, name: input.name });
        return reply.code(201).send(agent);
      });

      scope.get("/agents/:id", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const agent: Agent | undefined = getAgent(db, id);
        if (agent === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no agent with id ${id}`));
        }
        return agent;
      });

      scope.patch("/agents/:id", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        if (getAgent(db, id) === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no agent with id ${id}`));
        }
        const { issues, input } = validateAgentInput(request.body, { partial: true, db });
        if (issues.length > 0) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", issues[0].message, { field: issues[0].field }));
        }
        return updateAgent(db, id, input) as Agent;
      });

      scope.delete("/agents/:id", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const result = deleteAgent(db, id);
        if (result === "missing") {
          return reply.code(404).send(errorBody("NOT_FOUND", `no agent with id ${id}`));
        }
        if (result === "template") {
          return reply
            .code(409)
            .send(
              errorBody("CONFLICT", "template agents cannot be deleted", { reason: "template" }),
            );
        }
        return reply.code(204).send();
      });

      scope.post("/agents/:id/duplicate", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        if (getAgent(db, id) === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no agent with id ${id}`));
        }
        let name: string | undefined;
        const body: unknown = request.body;
        if (body !== undefined && body !== null) {
          if (typeof body !== "object" || Array.isArray(body)) {
            return reply
              .code(400)
              .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
          }
          const rawName = (body as Record<string, unknown>).name;
          if (rawName !== undefined) {
            if (typeof rawName !== "string" || rawName.trim() === "") {
              return reply.code(400).send(
                errorBody("VALIDATION", "name must be a non-empty string", {
                  field: "body.name",
                }),
              );
            }
            name = rawName;
          }
        }
        return reply.code(201).send(duplicateAgent(db, id, name));
      });

      // ---- Providers (API.md §8) ---- keys never appear in any response.

      scope.get("/providers", async () => {
        return { providers: listProviderViews(db, keyring) };
      });

      scope.post("/providers", async (request, reply) => {
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        const raw = body as Record<string, unknown>;

        if (typeof raw.name !== "string" || raw.name.trim() === "") {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "name must be a non-empty string", { field: "body.name" }));
        }
        let baseUrl: URL;
        if (typeof raw.baseUrl !== "string") {
          return reply.code(400).send(
            errorBody("VALIDATION", "baseUrl must be a http(s) URL string", {
              field: "body.baseUrl",
            }),
          );
        }
        try {
          baseUrl = new URL(raw.baseUrl);
        } catch {
          return reply.code(400).send(
            errorBody("VALIDATION", "baseUrl must be a valid URL", { field: "body.baseUrl" }),
          );
        }
        if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
          return reply.code(400).send(
            errorBody("VALIDATION", "baseUrl must use http or https", { field: "body.baseUrl" }),
          );
        }

        let id = slugifyProviderId(raw.name);
        if (raw.id !== undefined) {
          if (typeof raw.id !== "string" || raw.id.trim() === "") {
            return reply.code(400).send(
              errorBody("VALIDATION", "id must be a non-empty string", { field: "body.id" }),
            );
          }
          id = raw.id.trim();
        }
        if (id === "") {
          return reply.code(400).send(
            errorBody("VALIDATION", `id is reserved or unusable: ${id}`, { field: "body.id" }),
          );
        }
        // ROUND-37 (owner: "Add Provider" offers the built-in presets): a
        // RESERVED id is now claimable when its row is ABSENT — that's a
        // deleted built-in being re-added (re-adding clears the tombstone
        // below so the boot seed leaves it alone). An existing row —
        // reserved or not — is still a 409.
        if (providerRecordIdExists(db, id)) {
          return reply
            .code(409)
            .send(errorBody("CONFLICT", `provider '${id}' already exists`, { field: "body.id" }));
        }

        const apiFormat =
          raw.apiFormat === "anthropic-messages" || raw.apiFormat === "responses"
            ? (raw.apiFormat as string)
            : "chat-completions";
        if (RESERVED_PROVIDER_IDS.includes(id)) {
          clearProviderTombstone(db, id);
        }
        const record = createProviderRecord(db, {
          id,
          name: raw.name.trim(),
          baseUrl: baseUrl.toString(),
          apiFormat,
        });
        return reply.code(201).send({ ...record, hasKey: keyring.has(record.id) });
      });

      // ROUND-37 (owner: "he will be given these options to delete it, to
      // change the base URL, to change the name… and the API key"): EVERY
      // provider is editable — built-ins included. The old 409 for built-ins
      // is gone; only the reserved-id IMMUTABILITY of seeding is protected
      // (via tombstones on delete).
      scope.patch("/providers/:id", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const record = resolveProvider(db, id);
        if (record === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
        }
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        const raw = body as Record<string, unknown>;
        let baseUrl = record.baseUrl;
        if (raw.baseUrl !== undefined) {
          if (typeof raw.baseUrl !== "string") {
            return reply.code(400).send(
              errorBody("VALIDATION", "baseUrl must be a http(s) URL string", { field: "body.baseUrl" }),
            );
          }
          try {
            const parsed = new URL(raw.baseUrl);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("bad protocol");
            baseUrl = parsed.toString();
          } catch {
            return reply.code(400).send(
              errorBody("VALIDATION", "baseUrl must be a valid URL", { field: "body.baseUrl" }),
            );
          }
        }
        const name =
          typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : record.name;
        const apiFormat =
          raw.apiFormat === "anthropic-messages" || raw.apiFormat === "responses" || raw.apiFormat === "chat-completions"
            ? raw.apiFormat
            : record.apiFormat;
        const enabled = typeof raw.enabled === "boolean" ? raw.enabled : record.enabled;
        const updated = updateProviderRecord(db, { ...record, name, baseUrl, apiFormat, enabled });
        return reply.code(200).send({ ...updated, hasKey: keyring.has(updated.id) });
      });

      // ROUND-37: delete ANY provider (built-ins write a tombstone so the
      // boot seed doesn't resurrect them; re-adding via Add Provider clears
      // it). Agents referencing the provider still block deletion — their
      // next turn would 409 on a dead provider otherwise.
      scope.delete("/providers/:id", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const record = resolveProvider(db, id);
        if (record === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
        }
        const referencing = listAgents(db, true).filter((a) => a.providerId === id);
        if (referencing.length > 0) {
          return reply.code(409).send(
            errorBody(
              "CONFLICT",
              `${referencing.length} agent${referencing.length === 1 ? "" : "s"} still use '${record.name}' (${referencing.map((a) => a.name).join(", ")}) — reassign or delete them first`,
              { field: "params.id", agents: referencing.map((a) => a.id) },
            ),
          );
        }
        deleteProviderRecord(db, id);
        keyring.set(id, "");
        return reply.code(204).send();
      });

      scope.get("/providers/:id/models", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        if (resolveProvider(db, id) === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
        }
        try {
          const result = await fetchProviderModels(db, keyring, id);
          if (result === undefined) {
            return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
          }
          return result;
        } catch (error) {
          // ProviderFetchError carries sanitized upstream context; anything
          // else still maps to the same envelope without internals.
          const message =
            error instanceof Error ? error.message : `provider '${id}' models fetch failed`;
          return reply
            .code(502)
            .send(errorBody("PROVIDER_ERROR", message, { providerId: id }));
        }
      });

      // Wizard connection-test pill (API.md §8.6, cheap variant): proves the
      // provider exists, the keyring holds a key, and the key is accepted
      // upstream — without spending tokens on a completion.
      // ROUND-47 (R47-b): {model?, slot?} — slot scopes the probe to one
      // key-pool entry (slot 0 = primary; omitted = primary, exactly the
      // pre-R47 behavior) so each pool key is testable in place.
      scope.post("/providers/:id/test", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const provider = resolveProvider(db, id);
        if (provider === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
        }
        let model: string | undefined;
        let slot: number | undefined;
        const body: unknown = request.body;
        if (body !== undefined && body !== null) {
          if (typeof body !== "object" || Array.isArray(body)) {
            return reply
              .code(400)
              .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
          }
          const raw = body as Record<string, unknown>;
          const rawModel = raw.model;
          if (rawModel !== undefined) {
            if (typeof rawModel !== "string" || rawModel.trim() === "") {
              return reply.code(400).send(
                errorBody("VALIDATION", "model must be a non-empty string", {
                  field: "body.model",
                }),
              );
            }
            model = rawModel;
          }
          // ROUND-47 (R47-b): {slot} scopes the probe to ONE key-pool entry
          // (slot 0 = the primary) so the Key Pool UI can test each key in
          // place. The plan contract: integer 0..31, 409 when that slot
          // holds no key.
          const rawSlot = raw.slot;
          if (rawSlot !== undefined) {
            if (
              typeof rawSlot !== "number" ||
              !Number.isInteger(rawSlot) ||
              rawSlot < 0 ||
              rawSlot > 31
            ) {
              return reply.code(400).send(
                errorBody("VALIDATION", "slot must be an integer between 0 and 31", {
                  field: "body.slot",
                }),
              );
            }
            slot = rawSlot;
          }
        }
        // Key resolution: slot omitted → the primary (exactly the pre-R47
        // behavior, same 409 wording). Slot given → that POOL slot's key
        // (slot 0 IS the primary slot), 409 naming provider + slot when empty.
        let keyOverride: string | undefined;
        if (slot === undefined) {
          if (!keyring.has(id)) {
            return reply.code(409).send(
              errorBody(
                "CONFLICT",
                `no API key stored for provider '${id}' — save one in Windows Credential Manager before testing`,
                { providerId: id },
              ),
            );
          }
        } else {
          keyOverride = keyring.getSlot(id, slot);
          if (keyOverride === undefined) {
            return reply.code(409).send(
              errorBody(
                "CONFLICT",
                `no API key stored for provider '${id}' slot ${slot} — save one in Settings → Models & Providers`,
                { providerId: id, slot },
              ),
            );
          }
        }
        try {
          return await testProviderConnection(keyring, provider, model, keyOverride);
        } catch (error) {
          // The probe executed and the provider answered NO (bad key, unknown
          // model): HTTP 200 with ok:false — the test call itself succeeded.
          if (error instanceof ProviderTestError) {
            return { ok: false, message: error.message };
          }
          const message =
            error instanceof Error ? error.message : `provider '${id}' connection test failed`;
          return reply
            .code(502)
            .send(errorBody("PROVIDER_ERROR", message, { providerId: id }));
        }
      });

      // ---- Models (round-19: per-provider model metadata + pricing) ----

      scope.get("/providers/:id/models-config", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        if (resolveProvider(db, id) === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
        }
        return { models: listModels(db, id) };
      });

      scope.post("/providers/:id/models", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        if (resolveProvider(db, id) === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
        }
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        const raw = body as Record<string, unknown>;
        if (typeof raw.modelId !== "string" || raw.modelId.trim() === "") {
          return reply.code(400).send(
            errorBody("VALIDATION", "modelId must be a non-empty string", { field: "body.modelId" }),
          );
        }
        // ROUND-50 (R50-d): strict field validation — a malformed value is a
        // 400 naming the field, never a silently dropped "successful" save.
        const numerics = readModelNumericFields(raw);
        if (!numerics.ok) {
          return reply.code(400).send(
            errorBody("VALIDATION", `${numerics.field} must be a number or null`, {
              field: `body.${numerics.field}`,
            }),
          );
        }
        const scalars = readModelScalarFields(raw);
        if (!scalars.ok) {
          return reply.code(400).send(
            errorBody(
              "VALIDATION",
              `${scalars.field} must be ${scalars.field === "displayName" ? "a string" : "a boolean"}`,
              { field: `body.${scalars.field}` },
            ),
          );
        }
        const model = upsertModel(db, id, {
          modelId: raw.modelId.trim(),
          displayName: typeof raw.displayName === "string" ? raw.displayName : undefined,
          ...numerics.values,
          // Absent toggles stay undefined so upsertModel KEEPS the stored
          // value (the old `=== true` coercion reset them to false on every
          // re-upsert of an existing model — the "add model" flow no longer
          // wipes supportsThinking/hidden).
          supportsThinking: typeof raw.supportsThinking === "boolean" ? raw.supportsThinking : undefined,
          supportsVision: typeof raw.supportsVision === "boolean" ? raw.supportsVision : undefined,
          hidden: typeof raw.hidden === "boolean" ? raw.hidden : undefined,
        });
        return reply.code(201).send(model);
      });

      scope.patch("/models/:id", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        const raw = body as Record<string, unknown>;
        // ROUND-50 (R50-d): same strict gate as the POST route — number sets,
        // null clears to "unknown", absent leaves the stored value; a wrong
        // type is a 400 VALIDATION naming the field (never a silent drop).
        const numerics = readModelNumericFields(raw);
        if (!numerics.ok) {
          return reply.code(400).send(
            errorBody("VALIDATION", `${numerics.field} must be a number or null`, {
              field: `body.${numerics.field}`,
            }),
          );
        }
        const scalars = readModelScalarFields(raw);
        if (!scalars.ok) {
          return reply.code(400).send(
            errorBody(
              "VALIDATION",
              `${scalars.field} must be ${scalars.field === "displayName" ? "a string" : "a boolean"}`,
              { field: `body.${scalars.field}` },
            ),
          );
        }
        const patch: Record<string, unknown> = {};
        if (typeof raw.displayName === "string") patch.displayName = raw.displayName;
        Object.assign(patch, numerics.values);
        if (typeof raw.supportsThinking === "boolean") patch.supportsThinking = raw.supportsThinking;
        if (typeof raw.supportsVision === "boolean") patch.supportsVision = raw.supportsVision;
        if (typeof raw.hidden === "boolean") patch.hidden = raw.hidden;
        const model = updateModel(db, id, patch);
        if (model === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no model with id ${id}`));
        }
        return model;
      });

      scope.delete("/models/:id", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        if (!deleteModel(db, id)) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no model with id ${id}`));
        }
        return reply.code(204).send();
      });

      // ROUND-47 (R47-b): the STATIC model catalog for every picker. The
      // frontend hand-copied this 47-entry list into two components — a
      // guaranteed drift trap (SubAgentsTab already diverged). One route,
      // sourced from the constants themselves: no cache, no DB rows, nothing
      // stale. Same authenticated scope as the provider routes above.
      scope.get("/models/catalog", async () => {
        return {
          models: MODEL_CATALOG,
          defaultModelId: DEFAULT_MODEL_ID,
          subagentDefaultModelId: SUBAGENT_DEFAULT_MODEL_ID,
          recommendedModelIds: RECOMMENDED_MODEL_IDS,
        };
      });

      // ROUND-47 (R47-b): the old GET /providers/:id/key (round-19 "view/copy")
      // was REMOVED — it returned the RAW key value, contradicting the
      // "keys never appear in any response" invariant at the top of this
      // route group, and nothing ever called it (src/, src-tauri/, onboarding/
      // only PUT). Only the update route below survives.
      scope.put("/providers/:id/key", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        if (resolveProvider(db, id) === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
        }
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        const value = (body as Record<string, unknown>).value;
        if (typeof value !== "string" || value.trim() === "") {
          return reply.code(400).send(
            errorBody("VALIDATION", "value must be a non-empty string", { field: "body.value" }),
          );
        }
        keyring.set(id, value.trim());
        return reply.code(204).send();
      });

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

      // ---- Projects (Agentic Coding MVP, API.md §4a) ----

      scope.get("/projects", async () => ({ projects: listProjects(db) }));

      scope.post("/projects", async (request, reply) => {
        const body = request.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        const raw = body as Record<string, unknown>;
        const issues: { field: string; message: string }[] = [];
        const name = typeof raw.name === "string" ? raw.name.trim() : "";
        if (name === "") {
          issues.push({ field: "body.name", message: "name is required" });
        }
        let rootPath = typeof raw.rootPath === "string" ? raw.rootPath.trim() : "";
        if (rootPath === "") {
          issues.push({ field: "body.rootPath", message: "rootPath must be an absolute folder path" });
        }
        // Normalize Windows separators; require an EXISTING directory on disk.
        rootPath = rootPath.replace(/[\\/]+$/, "");
        if (rootPath !== "") {
          try {
            if (!statSync(rootPath).isDirectory()) {
              issues.push({ field: "body.rootPath", message: "rootPath is not a directory" });
            }
          } catch {
            issues.push({ field: "body.rootPath", message: `folder does not exist: ${rootPath}` });
          }
        }
        if (rootPath !== "" && projectRootPathExists(db, rootPath)) {
          return reply.code(409).send(
            errorBody("CONFLICT", `a project already uses the folder ${rootPath}`, {
              field: "body.rootPath",
            }),
          );
        }
        if (issues.length > 0) {
          return reply.code(400).send(
            errorBody("VALIDATION", issues[0].message, { field: issues[0].field }),
          );
        }
        const color = typeof raw.color === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.color) ? raw.color : undefined;
        return reply.code(201).send(createProject(db, { name, rootPath, ...(color !== undefined ? { color } : {}) }));
      });

      scope.get("/projects/:id", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const project = getProject(db, id);
        if (project === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
        }
        return project;
      });

      scope.delete("/projects/:id", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        if (!deleteProject(db, id)) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
        }
        return reply.code(204).send();
      });

      scope.get("/projects/:id/tree", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const project = getProject(db, id);
        if (project === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
        }
        return { tree: projectTree(project.rootPath), rootPath: project.rootPath };
      });

      scope.get("/projects/:id/file", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const query = request.query as Record<string, string | undefined>;
        const project = getProject(db, id);
        if (project === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
        }
        if (query.path === undefined || query.path === "") {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "path query parameter is required", { field: "query.path" }));
        }
        const result = readFile(project.rootPath, query.path);
        if (!result.ok) {
          return reply.code(404).send(errorBody("NOT_FOUND", result.output));
        }
        return { path: query.path, content: result.output };
      });

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

      // ROUND-44 (R44-a): project memory — the right-sidebar Memory tab reads
      // everything the agent saved via memory_save (newest first); DELETE
      // removes one item (the owner pruning stale knowledge). Saves go
      // through the agent's memory_save tool, not a REST POST — memory is
      // the AGENT's channel by design.
      scope.get("/projects/:id/memory", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const project = getProject(db, id);
        if (project === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
        }
        return { memories: listMemories(db, id, 100) };
      });

      scope.delete("/projects/:id/memory/:memoryId", async (request, reply) => {
        const { id, memoryId } = request.params as Record<string, string>;
        const project = getProject(db, id);
        if (project === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
        }
        const result = deleteMemory(db, memoryId);
        if (!result.ok) {
          return reply.code(404).send(errorBody("NOT_FOUND", result.error));
        }
        return { ok: true };
      });

      // Round-28 WS-H: unified search (files + symbols + content) for the
      // CommandPalette. Reuses search_files + search_code + the codebase index.
      scope.post("/projects/:id/search", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const body = request.body as Record<string, unknown> | null;
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          return reply.code(400).send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        const project = getProject(db, id);
        if (project === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
        }
        const query = typeof body.query === "string" ? body.query : "";
        const kind = body.kind === "symbols" || body.kind === "content" ? body.kind : "files";
        if (query.trim() === "") {
          return reply.code(400).send(errorBody("VALIDATION", "query is required", { field: "body.query" }));
        }
        if (kind === "symbols") {
          const symbols = searchIndexSymbols(db, id, query, 50);
          return { kind: "symbols", results: symbols };
        }
        if (kind === "content") {
          const res = searchCode(project.rootPath, query, undefined, {
            caseSensitive: body.case_sensitive === true,
            wholeWord: body.whole_word === true,
            fileGlob: typeof body.file_glob === "string" ? body.file_glob : undefined,
            maxResults: typeof body.max_results === "number" ? body.max_results : 50,
          });
          return { kind: "content", results: res.ok ? res.output : "" };
        }
        // kind === "files"
        const res = searchFiles(project.rootPath, query, undefined);
        return { kind: "files", results: res.ok ? res.output : "" };
      });

      // Round-28 WS-I: in-app demo viewer. Walks <project>/demos/ for HTML
      // files; each demo is viewable in a sandboxed iframe. The agent's
      // write_file tool can create demos as part of a task.
      scope.get("/projects/:id/demos", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const project = getProject(db, id);
        if (project === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
        }
        const demosDir = join(project.rootPath, "demos");
        if (!existsSync(demosDir)) {
          return { demos: [] };
        }
        const demos: Array<{ name: string; path: string; size: number; modifiedAt: string }> = [];
        try {
          for (const entry of readdirSync(demosDir)) {
            const abs = join(demosDir, entry);
            try {
              const stats = statSync(abs);
              if (stats.isDirectory()) {
                // demo is a folder with index.html (or other .html)
                const indexHtml = join(abs, "index.html");
                if (existsSync(indexHtml)) {
                  demos.push({
                    name: entry,
                    path: `demos/${entry}/index.html`,
                    size: statSync(indexHtml).size,
                    modifiedAt: stats.mtime.toISOString(),
                  });
                }
              } else if (entry.endsWith(".html")) {
                demos.push({
                  name: entry.replace(/\.html$/, ""),
                  path: `demos/${entry}`,
                  size: stats.size,
                  modifiedAt: stats.mtime.toISOString(),
                });
              }
            } catch {
              /* unreadable entry — skip */
            }
          }
        } catch {
          /* demos dir unreadable — return empty */
        }
        return { demos };
      });

      // ---- Sessions + single-agent chat (API.md §5) ----

      scope.post("/sessions", async (request, reply) => {
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        const raw = body as Record<string, unknown>;

        if (raw.mode === undefined || raw.mode !== "single") {
          return reply.code(400).send(
            errorBody("VALIDATION", "body.mode must be 'single' (team modes arrive in a later wave)", {
              field: "body.mode",
            }),
          );
        }
        if (typeof raw.agentId !== "string" || raw.agentId.trim() === "") {
          return reply.code(400).send(
            errorBody("VALIDATION", "agentId is required (no default agent is configured yet)", {
              field: "body.agentId",
            }),
          );
        }
        if (getAgent(db, raw.agentId) === undefined) {
          return reply
            .code(404)
            .send(errorBody("NOT_FOUND", `no agent with id ${raw.agentId}`));
        }
        let title: string | null = null;
        if (raw.title !== undefined) {
          if (typeof raw.title !== "string") {
            return reply
              .code(400)
              .send(errorBody("VALIDATION", "title must be a string", { field: "body.title" }));
          }
          title = raw.title.trim() === "" ? null : raw.title;
        }
        let projectId: string | null = null;
        if (raw.projectId !== undefined) {
          if (typeof raw.projectId !== "string" || raw.projectId.trim() === "") {
            return reply.code(400).send(
              errorBody("VALIDATION", "projectId must be a non-empty string", {
                field: "body.projectId",
              }),
            );
          }
          if (getProject(db, raw.projectId) === undefined) {
            return reply.code(404).send(
              errorBody("NOT_FOUND", `no project with id ${raw.projectId}`, {
                field: "body.projectId",
              }),
            );
          }
          projectId = raw.projectId;
        }

        const session = createSession(db, {
          agentId: raw.agentId,
          mode: "single" as RunMode,
          projectId,
          title,
        });
        return reply.code(202).send(session);
      });

      scope.get("/sessions", async (request) => {
        const query = request.query as Record<string, string | undefined>;
        const limitRaw = Number(query.limit ?? 50);
        const offsetRaw = Number(query.offset ?? 0);
        const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
        const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
        // ROUND-44 (R44-c): `?q=` searches titles + event text (storage/
        // sessions.ts searchSessions — LIKE over sessions.title and the event
        // payload JSON). Same response shape as the plain list; `total` is the
        // result count (search is not paginated).
        const q = (query.q ?? "").trim();
        if (q !== "") {
          const sessions = searchSessions(db, q, limit);
          return { sessions, total: sessions.length };
        }
        // ROUND-36: children are excluded unless includeChildren=1 (the
        // sidebar stays clean; the sub-agents view lists them explicitly).
        const includeChildren = query.includeChildren === "1" || query.includeChildren === "true";
        return listSessions(db, { limit, offset, includeChildren });
      });

      scope.get("/sessions/:id", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const session = getSession(db, id);
        if (session === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no session with id ${id}`));
        }
        return {
          ...session,
          events: listSessionEvents(db, id),
          lastSeq: lastSessionSeq(db, id),
        };
      });

      // PATCH /sessions/:id (round-33, owner request: renameable sessions).
      // Currently only the title is mutable; body: { title: string }.
      scope.patch("/sessions/:id", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        const raw = body as Record<string, unknown>;
        if (typeof raw.title !== "string") {
          return reply.code(400).send(
            errorBody("VALIDATION", "title must be a string", { field: "body.title" }),
          );
        }
        if (raw.title.length > 200) {
          return reply.code(400).send(
            errorBody("VALIDATION", "title must be at most 200 characters", {
              field: "body.title",
            }),
          );
        }
        const updated = updateSessionTitle(db, id, raw.title);
        if (updated === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no session with id ${id}`));
        }
        return reply.code(200).send(updated);
      });

      // ── ROUND-50 (R50-c1): the composer's permission-mode switcher ─────────
      // PATCH /sessions/:id/permissions — body { mode } with mode ∈
      // full|ask|plan|editor (400 VALIDATION otherwise). Persists on the
      // session row (migration 0020) and returns the updated session in the
      // SAME shape as GET /sessions/:id ({...session, events, lastSeq}).
      // Enforcement happens at TURN time (runtime.ts prepareTurn tool-set
      // restriction + approvals.ts ask-tier widening) — switching mid-session
      // applies to the NEXT turn.
      scope.patch("/sessions/:id/permissions", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        const raw = body as Record<string, unknown>;
        if (
          typeof raw.mode !== "string" ||
          !PERMISSION_MODES.includes(raw.mode as PermissionMode)
        ) {
          return reply.code(400).send(
            errorBody("VALIDATION", "mode must be one of full|ask|plan|editor", {
              field: "body.mode",
            }),
          );
        }
        const updated = updateSessionPermissionMode(db, id, raw.mode as PermissionMode);
        if (updated === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no session with id ${id}`));
        }
        return reply.code(200).send({
          ...updated,
          events: listSessionEvents(db, id),
          lastSeq: lastSessionSeq(db, id),
        });
      });

      // ── ROUND-50 (R50-c1): the composer's context donut ────────────────────
      // GET /sessions/:id/context?model=<modelId> — the context meter's data
      // source: context window, per-slice token ESTIMATES (the donut), the
      // cache hit-rate line, and the session's lifetime token/cost totals.
      // `model` is optional (defaults to the session agent's model — the
      // composer's per-send model picker passes its selection).
      //
      // All breakdown numbers are ESTIMATES (approximations documented
      // inline below): the goal is an honest donut, not exact provider
      // accounting. usedTokens = the sum of all breakdown slices.
      //
      // ROUND-51 (R51-c): the response ALSO carries `usage` — the Main agent
      // / Sub-agents / Combined split of the session-totals (the donut
      // popover's Session section). The flat sessionTotals/cache fields are
      // unchanged (additive shape).
      scope.get("/sessions/:id/context", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const query = request.query as Record<string, string | undefined>;
        const session = getSession(db, id);
        if (session === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no session with id ${id}`));
        }
        if (session.agentId === null) {
          return reply
            .code(409)
            .send(errorBody("CONFLICT", `session ${id} has no bound agent`));
        }
        const agent = getAgent(db, session.agentId);
        if (agent === undefined) {
          return reply.code(409).send(
            errorBody("CONFLICT", `session agent ${session.agentId} no longer exists`),
          );
        }
        if (agent.providerId === null || agent.model === null) {
          return reply.code(409).send(
            errorBody("CONFLICT", `agent '${agent.name}' has no providerId/model configured`, {
              agentId: agent.id,
              field: "providerId",
            }),
          );
        }
        const providerId = agent.providerId;
        const model =
          typeof query.model === "string" && query.model.trim() !== ""
            ? query.model.trim()
            : agent.model;
        const project =
          session.projectId !== null ? getProject(db, session.projectId) : undefined;

        // Tool names: the post-mode, post-allowlist set a REAL turn would
        // receive (runtime.ts effectiveToolNames — shared with prepareTurn's
        // computation, so the donut reflects the live toolset).
        const toolNames = project !== undefined ? effectiveToolNames(db, session, agent) : [];

        // System-prompt slices via the R50-c1 section split (prompts.ts).
        // Projectless sessions run on agent.systemPrompt with NO tools.
        const sections =
          project !== undefined
            ? buildSystemPromptSections({
                projectName: project.name,
                rootPath: project.rootPath,
                toolNames,
                customRules: readCustomRules(project.rootPath),
                maxTurns: agent.maxTurns,
                indexSummary:
                  session.projectId !== null
                    ? getIndexSummary(db, session.projectId) ?? undefined
                    : undefined,
                memoryDigest:
                  getMemorySettings(db).enabled &&
                  session.parentSessionId === null &&
                  session.projectId !== null
                    ? memoryDigest(db, session.projectId) || undefined
                    : undefined,
                permissionMode: session.permissionMode,
              })
            : null;

        // ── Breakdown approximations (context.ts estimateTokens — ROUND-64's
        // GPT-style BPE approximation, calibrated ±15% of cl100k behavior):
        // systemPrompt: the identity section — the core prompt text minus the
        //   tool list, memory digest, and meta sections.
        // systemTools: the prompt's tool-names section (measured) PLUS ~350
        //   tokens per tool for the JSON schemas the API carries alongside the
        //   prompt (the schema objects aren't cheaply stringifiable — the
        //   fixed per-tool figure is the documented approximation).
        // memory: the memory digest section. meta: codebase index + custom
        //   rules. messages: assembleHistory with attachments rendered,
        //   exactly what a real turn would send. mcpTools: honest 0 (no MCP
        //   system yet — the UI shows "none").
        const TOOL_SCHEMA_TOKENS = 350;
        const systemPrompt = sections !== null ? estimateTokens(sections.identity) : estimateTokens(agent.systemPrompt);
        const systemTools =
          sections !== null ? estimateTokens(sections.tools) + TOOL_SCHEMA_TOKENS * toolNames.length : 0;
        const memory = sections !== null ? estimateTokens(sections.memory) : 0;
        const meta = sections !== null ? estimateTokens(sections.meta) : 0;
        const messages = estimateMessageTokens(assembleHistory(db, id));
        const mcpTools = 0;
        const usedTokens = systemPrompt + systemTools + memory + messages + meta + mcpTools;

        // ── Cache + lifetime totals: SQL SUMs over the session's usage rows
        // (COUNT(*) = requests; SUM(cost_usd) rounded like the usage summary;
        // cached_input_tokens is NULL pre-0020 / on providers without a
        // cached tier — COALESCE handles it).
        const totalsRow = db
          .prepare(
            `SELECT
               COALESCE(SUM(input_tokens), 0) AS inputTokens,
               COALESCE(SUM(output_tokens), 0) AS outputTokens,
               COALESCE(SUM(cached_input_tokens), 0) AS cachedInputTokens,
               COUNT(*) AS requests,
               COALESCE(SUM(cost_usd), 0) AS costUsd
             FROM usage_events WHERE session_id = ?`,
          )
          .get(id) as {
          inputTokens: number;
          outputTokens: number;
          cachedInputTokens: number;
          requests: number;
          costUsd: number;
        };
        const roundUsd = (value: number): number => Math.round(value * 1e6) / 1e6;

        // ── ROUND-51 (R51-c): the Main agent / Sub-agents / Combined usage
        // split (owner: "The actual main sessions stats and the sub-agent
        // sessions stats will be kept separate. They will not be kept
        // separate completely. They will be shown as combined all together
        // too."). `subagents` sums the usage_events of the session's DIRECT
        // children — the exact set listSubAgents lists
        // (parent_session_id = this session; grandchildren roll into their
        // own parent's report, mirroring the sub-agents panel's rows). The
        // flat sessionTotals fields above stay byte-identical (additive
        // shape — old consumers keep working).
        const subRow = db
          .prepare(
            `SELECT
               COALESCE(SUM(input_tokens), 0) AS inputTokens,
               COALESCE(SUM(output_tokens), 0) AS outputTokens,
               COUNT(*) AS requests,
               COALESCE(SUM(cost_usd), 0) AS costUsd
             FROM usage_events
             WHERE session_id IN (SELECT id FROM sessions WHERE parent_session_id = ?)`,
          )
          .get(id) as {
          inputTokens: number;
          outputTokens: number;
          requests: number;
          costUsd: number;
        };
        const sumTotals = (
          a: { inputTokens: number; outputTokens: number; requests: number; costUsd: number },
          b: { inputTokens: number; outputTokens: number; requests: number; costUsd: number },
        ): { inputTokens: number; outputTokens: number; requests: number; costUsd: number } => ({
          inputTokens: a.inputTokens + b.inputTokens,
          outputTokens: a.outputTokens + b.outputTokens,
          requests: a.requests + b.requests,
          costUsd: a.costUsd + b.costUsd,
        });

        return reply.code(200).send({
          model,
          providerId,
          contextWindow: getModelContextWindow(db, providerId, model),
          usedTokens,
          breakdown: {
            systemPrompt,
            systemTools,
            memory,
            messages,
            meta,
            mcpTools,
          },
          cache: {
            inputTokens: totalsRow.inputTokens,
            cachedInputTokens: totalsRow.cachedInputTokens,
            hitRate:
              totalsRow.inputTokens > 0
                ? totalsRow.cachedInputTokens / totalsRow.inputTokens
                : null,
          },
          sessionTotals: {
            inputTokens: totalsRow.inputTokens,
            outputTokens: totalsRow.outputTokens,
            requests: totalsRow.requests,
            costUsd: roundUsd(totalsRow.costUsd),
          },
          // ROUND-51 (R51-c): main = THIS session only; subagents = its
          // direct children; combined = the sum. Rounded exactly like the
          // flat fields.
          usage: {
            main: {
              inputTokens: totalsRow.inputTokens,
              outputTokens: totalsRow.outputTokens,
              requests: totalsRow.requests,
              costUsd: roundUsd(totalsRow.costUsd),
            },
            subagents: {
              inputTokens: subRow.inputTokens,
              outputTokens: subRow.outputTokens,
              requests: subRow.requests,
              costUsd: roundUsd(subRow.costUsd),
            },
            combined: (() => {
              const c = sumTotals(totalsRow, subRow);
              return {
                inputTokens: c.inputTokens,
                outputTokens: c.outputTokens,
                requests: c.requests,
                costUsd: roundUsd(c.costUsd),
              };
            })(),
          },
        });
      });

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

      // DELETE /sessions/:id (round-30, owner request: "I am not able to
      // delete any of the sessions"). Transactionally removes the session row
      // AND its dependent rows (event log, usage lines, approvals, file
      // snapshots). The append-only contract (ADR-0010) governs in-flight
      // operation — a wholesale session delete at the owner's request is the
      // documented exception, executed as one transaction.
      scope.delete("/sessions/:id", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const session = getSession(db, id);
        if (session === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no session with id ${id}`));
        }
        deleteSession(db, id);
        return reply.code(204).send();
      });

      // ── ROUND-44 (R44-c, owner directive: "complete the whole agentic coding
      //    environment"): fork + revert. Both are owner-facing session
      //    management operations on the append-only log (ADR-0010's documented
      //    exceptions, executed transactionally — same standing as round-30's
      //    DELETE /sessions/:id). ─────────────────────────────────────────────

      // POST /sessions/:id/fork — copy the session + its full event log under a
      // NEW top-level session row ("Fork · <title>"). Usage is NOT carried
      // over. Response: 201 { session } (creation convention: /agents/:id/
      // duplicate). 404 when the source id is unknown.
      scope.post("/sessions/:id/fork", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const fork = forkSession(db, id);
        if (fork === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no session with id ${id}`));
        }
        return reply.code(201).send({ session: fork });
      });

      // POST /sessions/:id/revert — rewind the event log to an earlier message.
      // Body: { keepThroughSeq: integer >= 0 } — everything AFTER that seq is
      // deleted (the user message at keepThroughSeq SURVIVES; its reply + later
      // turns are removed) and one `session.reverted` marker event is appended.
      // Response: 200 { ok: true, removedCount }. 404 unknown session, 409 when
      // a turn is running (deleting under a live stream would race it), 400 on
      // a bad body.
      scope.post("/sessions/:id/revert", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        const raw = body as Record<string, unknown>;
        if (
          typeof raw.keepThroughSeq !== "number" ||
          !Number.isInteger(raw.keepThroughSeq) ||
          raw.keepThroughSeq < 0
        ) {
          return reply.code(400).send(
            errorBody("VALIDATION", "keepThroughSeq must be an integer >= 0", {
              field: "body.keepThroughSeq",
            }),
          );
        }
        const result = revertSession(db, id, raw.keepThroughSeq);
        if (!result.ok) {
          const status = result.code === "NOT_FOUND" ? 404 : result.code === "CONFLICT" ? 409 : 400;
          return reply.code(status).send(errorBody(result.code, result.message));
        }
        return reply.code(200).send({ ok: true, removedCount: result.removedCount });
      });

      // ── ROUND-36 (ADR-0022): sub-agent monitoring + recovery ──────────

      // Children with computed status/progress/tokens/report — the chat UI's
      // tap-to-inspect surface (owner: "when the user taps on the running
      // sessions, he can look at their status").
      scope.get("/sessions/:id/subagents", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        if (getSession(db, id) === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no session with id ${id}`));
        }
        return { subagents: listSubAgents(db, id) };
      });

      // Retry a failed/interrupted child — resumes from the event log (the
      // R34 history assembly feeds its prior work back) or re-runs the task.
      scope.post("/sessions/:id/subagents/:childId/retry", async (request, reply) => {
        const { id, childId } = request.params as Record<string, string>;
        if (getSession(db, id) === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no session with id ${id}`));
        }
        const child = getSession(db, childId);
        if (child === undefined || child.parentSessionId !== id) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no child session ${childId} under ${id}`));
        }
        if (child.status === "running") {
          return reply.code(409).send(
            errorBody("CONFLICT", `sub-agent ${childId} is already running`, { field: "params.childId" }),
          );
        }
        const { getOrchestrator } = await import("./agents/orchestrator.js");
        const orchestrator = getOrchestrator();
        const result = await orchestrator.retryChild(
          { db, keyring, chat },
          id,
          childId,
        );
        if (!result.ok) {
          return reply.code(502).send(errorBody("PROVIDER_ERROR", result.message));
        }
        return reply.code(200).send({ ok: true, message: result.message });
      });

      // ── ROUND-59 (R59-D): response ratings (the owner's flagship request
      // this round: "add the options to mark the responses as good or bad,
      // and all of these will be tracked and saved… The full context will be
      // properly shared"). POST upserts on (session_id, assistant_seq) —
      // re-rating overwrites, one verdict per reply. The 200 body carries the
      // row WITHOUT context (the chat UI only needs the verdict); the frozen
      // snapshot is read back via GET /ratings (the analysis path).
      scope.post("/sessions/:id/ratings", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return reply
            .code(400)
            .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        const raw = body as Record<string, unknown>;
        if (
          typeof raw.assistantSeq !== "number" ||
          !Number.isInteger(raw.assistantSeq) ||
          raw.assistantSeq <= 0
        ) {
          return reply.code(400).send(
            errorBody(
              "VALIDATION",
              "assistantSeq must be a positive integer (the event seq of the assistant reply being rated)",
              { field: "body.assistantSeq" },
            ),
          );
        }
        if (raw.rating !== "good" && raw.rating !== "bad") {
          return reply.code(400).send(
            errorBody("VALIDATION", "rating must be 'good' or 'bad'", { field: "body.rating" }),
          );
        }
        let note: string | undefined;
        if (raw.note !== undefined && raw.note !== null) {
          if (typeof raw.note !== "string") {
            return reply
              .code(400)
              .send(errorBody("VALIDATION", "note must be a string", { field: "body.note" }));
          }
          if (raw.note.length > MAX_RATING_NOTE_CHARS) {
            return reply.code(400).send(
              errorBody(
                "VALIDATION",
                `note must be at most ${MAX_RATING_NOTE_CHARS} characters`,
                { field: "body.note" },
              ),
            );
          }
          note = raw.note;
        }
        try {
          const rating = rateReply(db, {
            sessionId: id,
            assistantSeq: raw.assistantSeq,
            rating: raw.rating,
            note,
          });
          return reply.code(200).send({ rating });
        } catch (err) {
          if (err instanceof RatingError) {
            return reply.code(err.status).send(
              errorBody(err.code, err.message, err.field !== undefined ? { field: err.field } : undefined),
            );
          }
          throw err;
        }
      });

      // The session's verdicts for the chat UI's rating map — light views
      // (no context; the panel only needs {assistantSeq, rating, note}).
      scope.get("/sessions/:id/ratings", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        if (getSession(db, id) === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no session with id ${id}`));
        }
        return { ratings: listSessionRatings(db, id) };
      });

      // The ANALYSIS/EXPORT path: newest-first with the FULL frozen context
      // per rating (the data the dev agent dumps to determine "did it
      // perform the request which it was given properly or not"). Ratings
      // deliberately outlive session deletes, so an unknown sessionId filter
      // just yields an empty list. limit follows the /sessions tolerance
      // (clamped, default 200); a bad rating filter is an honest 400.
      scope.get("/ratings", async (request, reply) => {
        const query = request.query as Record<string, string | undefined>;
        let rating: "good" | "bad" | undefined;
        if (query.rating !== undefined) {
          if (query.rating !== "good" && query.rating !== "bad") {
            return reply.code(400).send(
              errorBody("VALIDATION", "rating filter must be 'good' or 'bad'", {
                field: "query.rating",
              }),
            );
          }
          rating = query.rating;
        }
        const limitRaw = Number(query.limit ?? 200);
        const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 200;
        return {
          ratings: listRatings(db, {
            ...(query.sessionId !== undefined && query.sessionId.trim() !== ""
              ? { sessionId: query.sessionId }
              : {}),
            ...(rating !== undefined ? { rating } : {}),
            limit,
          }),
        };
      });

      // Remove one verdict (the chat UI's same-thumb click clears it).
      scope.delete("/ratings/:id", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const rowId = Number(id);
        if (!Number.isInteger(rowId) || rowId <= 0) {
          return reply.code(400).send(
            errorBody("VALIDATION", "rating id must be a positive integer", {
              field: "params.id",
            }),
          );
        }
        if (!deleteRating(db, rowId)) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no rating with id ${rowId}`));
        }
        return { ok: true };
      });

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
            ...(typeof raw.subagentModel === "string" ? { subagentModel: raw.subagentModel } : {}),
            ...(raw.subagentModel === null ? { subagentModel: null } : {}),
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

      // ── ROUND-36: API key pool (per provider) ──────────────────────────

      scope.get("/providers/:id/keys", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        if (resolveProvider(db, id) === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
        }
        return { keys: keyring.poolInfo(id) };
      });

      // ROUND-58 (R58-d): POST /providers/:id/keys/reveal — the ONE route
      // that returns key VALUES. The owner explicitly asked for visible keys
      // ("Make sure that the API key shows properly there too in our
      // application. It should not be hidden. I should be able to click the
      // options there and I should be able to see the API key there, every
      // single one of the API keys, without any issues.") — this consciously
      // reverses the R47 "keys never appear in any response" invariant FOR
      // THIS SINGLE ROUTE ONLY: every other /keys response stays masked
      // (poolInfo), and the key values are still NEVER logged anywhere.
      // Same bearer wall + 404 semantics as the sibling pool routes.
      scope.post("/providers/:id/keys/reveal", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        if (resolveProvider(db, id) === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
        }
        // Every HELD slot with its full value (slot 0 = the primary, plus the
        // pool slots the keyring holds). getPool never logs, only reads.
        return { keys: keyring.getPool(id).map(({ slot, key }) => ({ slot, value: key })) };
      });

      scope.put("/providers/:id/keys/:slot", async (request, reply) => {
        const { id, slot } = request.params as Record<string, string>;
        if (resolveProvider(db, id) === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
        }
        const slotNum = Number(slot);
        if (!Number.isInteger(slotNum) || slotNum < 0 || slotNum > 31) {
          return reply.code(400).send(errorBody("VALIDATION", `invalid slot ${slot}`, { field: "params.slot" }));
        }
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null) {
          return reply.code(400).send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
        }
        const value = (body as Record<string, unknown>).value;
        if (typeof value !== "string" || value.trim() === "") {
          return reply.code(400).send(
            errorBody("VALIDATION", "value must be a non-empty string", { field: "body.value" }),
          );
        }
        keyring.setSlot(id, slotNum, value.trim());
        return reply.code(200).send({ keys: keyring.poolInfo(id) });
      });

      scope.delete("/providers/:id/keys/:slot", async (request, reply) => {
        const { id, slot } = request.params as Record<string, string>;
        if (resolveProvider(db, id) === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
        }
        const slotNum = Number(slot);
        if (!Number.isInteger(slotNum) || slotNum < 0 || slotNum > 31) {
          return reply.code(400).send(errorBody("VALIDATION", `invalid slot ${slot}`, { field: "params.slot" }));
        }
        if (slotNum === 0) {
          return reply.code(409).send(
            errorBody("CONFLICT", "the primary key is removed via the main key endpoint", {
              field: "params.slot",
            }),
          );
        }
        keyring.setSlot(id, slotNum, "");
        // The removed slot itself may drop out of poolInfo (env state has no
        // high-water mark) — re-include it as empty so the UI keeps the row.
        const keys = keyring.poolInfo(id).filter((k) => k.slot !== slotNum);
        keys.push({ slot: slotNum, hasKey: false, masked: null });
        keys.sort((a, b) => a.slot - b.slot);
        return reply.code(200).send({ keys });
      });

      scope.post("/sessions/:id/messages", async (request, reply) => {
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
        // ROUND-50 (R50-c1): the composer's per-send fields — thinking level
        // (reasoning.effort, not persisted) and attachments (persisted on the
        // message.user payload). Validation is shared with the streamed route.
        const composer = readComposerSendFields(raw, reply);
        if (!composer.ok) return reply;

        const outcome = await runSingleAgentTurn(
          { db, keyring, chat },
          id,
          content,
          modelOverride,
          undefined,
          undefined,
          composer.value.thinkingLevel,
          composer.value.attachments,
        );
        if (outcome.ok) {
          return reply.code(200).send({
            assistantMessage: outcome.assistantMessage,
            usage: outcome.usage,
          });
        }
        return reply
          .code(outcome.status)
          .send(errorBody(outcome.code, outcome.message, outcome.details));
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
        registerTurn(id, abort);

        try {
          const outcome = await runStreamedAgentTurn(
            { db, keyring, chat, chatStream: streamAiSdkChat },
            id,
            content,
            send,
            modelOverride,
            abort.signal,
            composer.value.thinkingLevel,
            composer.value.attachments,
          );
          if (outcome.ok) {
            // ROUND-42: ALWAYS publish task_complete. The R40 didWork gate
            // (only tool-using turns) left the owner's conversational test
            // ("say hello, close the window") silent — a completed reply IS
            // a completed task from the owner's perspective. The in-page
            // Toaster only fires desktop notifications when the page is
            // hidden; the service worker push only fires when no visible
            // window exists — so an on-screen user still isn't spammed.
            const session = getSession(db, id);
            getNotificationBus().publish(db, {
              kind: "task_complete",
              title: session?.title ?? "Task complete",
              body: outcome.assistantMessage.content.slice(0, 160),
              sessionId: id,
              projectId: session?.projectId ?? undefined,
            });
            send({ type: "done", assistantMessage: outcome.assistantMessage, usage: outcome.usage });
          } else if (outcome.code === "ABORTED") {
            // ROUND-42: the user explicitly stopped the turn — a deliberate
            // stop is not a failure; no task_failed notification.
            send({ type: "stopped" });
          } else {
            // ROUND-40/42: real failures (provider errors, crashes) always
            // notify. Validation conflicts (404 unknown session / 409 wrong
            // state) are request errors, not task failures — no notification.
            const session = getSession(db, id);
            if (outcome.status >= 500) {
              getNotificationBus().publish(db, {
                kind: "task_failed",
                title: session?.title ?? "Task failed",
                body: outcome.message,
                sessionId: id,
                projectId: session?.projectId ?? undefined,
              });
            }
            send({
              type: "error",
              status: outcome.status,
              code: outcome.code,
              message: outcome.message,
              ...(outcome.details ? { details: outcome.details } : {}),
            });
          }
        } catch (routeError) {
          // ROUND-43: an unexpected crash in the route itself (not a provider
          // failure) must still terminate the SSE stream with an error frame —
          // otherwise the client sees the socket end with no terminal event
          // and the turn dies silently (the owner's bug).
          const message =
            routeError instanceof Error ? routeError.message : String(routeError);
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

      // ROUND-42 → R52-b: explicit stop. The UI's Stop button aborts its local
      // fetch AND calls this — the server-side turn aborts, pending approvals
      // deny on abort, and the stream route resolves with {type:'stopped'}.
      // ROUND-52 (R52-b): this now ALSO stops SUB-AGENT children — the
      // orchestrator registers each running child in the same registry, so a
      // stop aimed at a child session id aborts ONLY that child (the parent
      // turn keeps running and receives an honest "stopped by the owner"
      // report from the delegate_task tool result).
      scope.post("/sessions/:id/stop", async (request) => {
        const { id } = request.params as Record<string, string>;
        const stopped = abortTurn(id, "owner");
        return { ok: true, stopped };
      });

      // ── ROUND-61 (R61): COMPUTER USE — the desktop-control surface ────────
      // The monitor ring (GET session), the UI kill switch (POST stop), the
      // settings (GET/PUT config incl. the vision-model separation), the
      // readiness probe, and the dedicated VISION KEY slot (the
      // "<providerId>-vision" keyring pseudo-provider — the Tauri shell
      // writes the durable credential + handoff; this route is the web-dev
      // + in-session path). Same bearer wall as everything else.
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

      // ── ROUND-61 (R61): SKILLS — the owner's multiple-skills surface ─────
      scope.get("/skills", async () => {
        return { skills: listSkills(db) };
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
