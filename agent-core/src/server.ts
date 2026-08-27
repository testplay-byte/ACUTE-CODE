/**
 * Sidecar HTTP server (API.md; ADR-0006). Wave 1: health + bearer-token auth +
 * agent registry CRUD. Wave 2 adds the provider registry (keyring-backed) and
 * single-agent sessions/chat. WebSocket and the remaining resources come in
 * later waves.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { MemoryPolicy, RunMode } from "shared";
import { aiSdkChat, streamAiSdkChat, type ChatFn } from "./agents/chat.js";
import { runSingleAgentTurn, runStreamedAgentTurn } from "./agents/runtime.js";
import { pickFolder } from "./dialogs.js";
import { projectTree, readFile, searchCode, searchFiles } from "./tools/index.js";
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
  updateSessionTitle,
} from "./storage/sessions.js";
import { getOrchestrationSettings, setOrchestrationSettings } from "./storage/settings.js";
import { Orchestrator } from "./agents/orchestrator.js";
import {
  getApproval,
  listApprovals,
  resolvePendingApproval,
  setApprovalStatus,
  sweepStaleApprovals,
} from "./approvals.js";
import { getUsageSummary } from "./storage/usage.js";
import { log } from "./lib/log.js";
import {
  deleteModel,
  listModels,
  updateModel,
  upsertModel,
} from "./storage/models.js";
import { listSnapshots, restoreSnapshot, getSnapshotBySeq } from "./storage/snapshots.js";
// ROUND-44 (R44-a): the agent memory system — per-project persistent
// knowledge (facts/decisions/preferences) with REST read/delete for the
// right-sidebar Memory tab. Saves happen via the memory_save tool.
import { deleteMemory, listMemories } from "./storage/memory.js";
import { getIndexSummary, searchIndexSymbols } from "./storage/index.js";
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

export const VERSION = "0.3.0";

/**
 * ROUND-42: registry of live streamed turns, keyed by session id — powers
 * POST /sessions/:id/stop (the UI Stop button). Entries are added when a
 * stream starts and removed when the turn settles (finally block).
 */
const activeTurns = new Map<string, AbortController>();

/** API.md §1.3: every non-2xx response carries this single shape. */
function errorBody(code: string, message: string, details?: Record<string, unknown>): unknown {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
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
        "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
      };
    }
    return {};
  };
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin === "string" && CORS_ORIGINS.has(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-headers", "authorization, content-type");
      reply.header("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
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
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
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

  app.register(
    async (scope) => {
      registerBrowserRoutes(scope, token); // ROUND-43 (R43-10): embedded-browser proxy (iframe ticket auth, HTML/CSS rewriting, history + viewport state)

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
      scope.post("/providers/:id/test", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        const provider = resolveProvider(db, id);
        if (provider === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
        }
        if (!keyring.has(id)) {
          return reply.code(409).send(
            errorBody(
              "CONFLICT",
              `no API key stored for provider '${id}' — save one in Windows Credential Manager before testing`,
              { providerId: id },
            ),
          );
        }
        let model: string | undefined;
        const body: unknown = request.body;
        if (body !== undefined && body !== null) {
          if (typeof body !== "object" || Array.isArray(body)) {
            return reply
              .code(400)
              .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
          }
          const rawModel = (body as Record<string, unknown>).model;
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
        }
        try {
          return await testProviderConnection(keyring, provider, model);
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
        const model = upsertModel(db, id, {
          modelId: raw.modelId.trim(),
          displayName: typeof raw.displayName === "string" ? raw.displayName : undefined,
          contextWindow: typeof raw.contextWindow === "number" ? raw.contextWindow : undefined,
          maxOutputTokens: typeof raw.maxOutputTokens === "number" ? raw.maxOutputTokens : undefined,
          inputPricePerMtok: typeof raw.inputPricePerMtok === "number" ? raw.inputPricePerMtok : undefined,
          inputPriceCachedPerMtok: typeof raw.inputPriceCachedPerMtok === "number" ? raw.inputPriceCachedPerMtok : undefined,
          outputPricePerMtok: typeof raw.outputPricePerMtok === "number" ? raw.outputPricePerMtok : undefined,
          supportsThinking: raw.supportsThinking === true,
          hidden: raw.hidden === true,
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
        const patch: Record<string, unknown> = {};
        if (typeof raw.displayName === "string") patch.displayName = raw.displayName;
        if (typeof raw.contextWindow === "number" || raw.contextWindow === null) patch.contextWindow = raw.contextWindow;
        if (typeof raw.maxOutputTokens === "number" || raw.maxOutputTokens === null) patch.maxOutputTokens = raw.maxOutputTokens;
        if (typeof raw.inputPricePerMtok === "number" || raw.inputPricePerMtok === null) patch.inputPricePerMtok = raw.inputPricePerMtok;
        if (typeof raw.inputPriceCachedPerMtok === "number" || raw.inputPriceCachedPerMtok === null) patch.inputPriceCachedPerMtok = raw.inputPriceCachedPerMtok;
        if (typeof raw.outputPricePerMtok === "number" || raw.outputPricePerMtok === null) patch.outputPricePerMtok = raw.outputPricePerMtok;
        if (typeof raw.supportsThinking === "boolean") patch.supportsThinking = raw.supportsThinking;
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

      // Read the provider's API key (settings UI: view/copy — round-19 owner request).
      scope.get("/providers/:id/key", async (request, reply) => {
        const { id } = request.params as Record<string, string>;
        if (resolveProvider(db, id) === undefined) {
          return reply.code(404).send(errorBody("NOT_FOUND", `no provider with id ${id}`));
        }
        const key = keyring.get(id);
        return { hasKey: key !== undefined, key: key ?? null };
      });

      // Update the provider's API key (settings UI: edit — round-19 owner request).
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
              env: { ...process.env, FORCE_COLOR: "0", CI: "1" },
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
            env: { ...process.env, FORCE_COLOR: "0", CI: "1" },
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

        const outcome = await runSingleAgentTurn({ db, keyring, chat }, id, content, modelOverride);
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
        // ROUND-42: registry for POST /sessions/:id/stop. One live turn per
        // session — a second turn on the same session replaces the entry
        // (the runtime refuses concurrent turns anyway).
        activeTurns.set(id, abort);

        try {
          const outcome = await runStreamedAgentTurn(
            { db, keyring, chat, chatStream: streamAiSdkChat },
            id,
            content,
            send,
            modelOverride,
            abort.signal,
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
          if (activeTurns.get(id) === abort) activeTurns.delete(id);
          if (!clientGone) {
            try {
              res.end();
            } catch {
              /* socket already dead */
            }
          }
        }
      });

      // ROUND-42: explicit stop. The UI's Stop button aborts its local fetch
      // AND calls this — the server-side turn aborts, pending approvals deny
      // on abort, and the stream route resolves with {type:'stopped'}.
      scope.post("/sessions/:id/stop", async (request) => {
        const { id } = request.params as Record<string, string>;
        const controller = activeTurns.get(id);
        if (controller === undefined) {
          return { ok: true, stopped: false };
        }
        controller.abort();
        return { ok: true, stopped: true };
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
