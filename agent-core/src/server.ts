/**
 * Sidecar HTTP server (API.md; ADR-0006). Wave 1: health + bearer-token auth +
 * agent registry CRUD. Wave 2 adds the provider registry (keyring-backed) and
 * single-agent sessions/chat. WebSocket and the remaining resources come in
 * later waves.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { MemoryPolicy, RunMode } from "shared";
import { aiSdkChat, streamAiSdkChat, type ChatFn } from "./agents/chat.js";
import { runSingleAgentTurn, runStreamedAgentTurn } from "./agents/runtime.js";
import { pickFolder } from "./dialogs.js";
import { projectTree, readFile } from "./tools/index.js";
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
  createProviderRecord,
  providerExists,
  providerRecordIdExists,
  slugifyProviderId,
} from "./storage/providers.js";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  projectRootPathExists,
} from "./storage/projects.js";
import { createSession, getSession, lastSessionSeq, listSessionEvents, listSessions } from "./storage/sessions.js";
import { getUsageSummary } from "./storage/usage.js";
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

export const VERSION = "0.3.0";

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
        if (id === "" || RESERVED_PROVIDER_IDS.includes(id)) {
          return reply.code(400).send(
            errorBody("VALIDATION", `id is reserved or unusable: ${id}`, { field: "body.id" }),
          );
        }
        if (providerRecordIdExists(db, id)) {
          return reply
            .code(409)
            .send(errorBody("CONFLICT", `provider '${id}' already exists`, { field: "body.id" }));
        }

        const record = createProviderRecord(db, {
          id,
          name: raw.name.trim(),
          baseUrl: baseUrl.toString(),
        });
        return reply.code(201).send({ ...record, hasKey: keyring.has(record.id) });
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
        return listSessions(db, { limit, offset });
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
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        const send = (event: unknown) => {
          if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        const abort = new AbortController();
        res.on("close", () => abort.abort());

        const outcome = await runStreamedAgentTurn(
          { db, keyring, chat, chatStream: streamAiSdkChat },
          id,
          content,
          send,
          modelOverride,
          abort.signal,
        );
        if (outcome.ok) {
          send({ type: "done", assistantMessage: outcome.assistantMessage, usage: outcome.usage });
        } else {
          send({
            type: "error",
            status: outcome.status,
            code: outcome.code,
            message: outcome.message,
            ...(outcome.details ? { details: outcome.details } : {}),
          });
        }
        res.end();
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
  const app = buildServer({ token: options.token, db });
  app.addHook("onClose", async () => {
    db.close();
  });
  await app.listen({ port: options.port ?? 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    await app.close();
    throw new Error("sidecar failed to bind a TCP port");
  }
  // The shell parses this exact line (ARCHITECTURE §2); nothing else may print to stdout.
  console.log(`ACUTE_READY ${JSON.stringify({ port: address.port })}`);
  return { server: app, port: address.port };
}
