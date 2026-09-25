// ─────────────────────────────────────────────────────────────────────────────
// R84 (Wave 2-a): the sessions + single-agent chat domain (API.md §5).
//
// Registers, in the original server.ts registration order: POST /sessions,
// GET /sessions, GET /sessions/:id, PATCH /sessions/:id,
// PATCH /sessions/:id/permissions, GET /sessions/:id/context,
// POST /sessions/:id/compact, DELETE /sessions/:id, POST /sessions/:id/fork,
// POST /sessions/:id/revert, GET /sessions/:id/subagents,
// POST /sessions/:id/subagents/:childId/retry, POST /sessions/:id/messages,
// POST /sessions/:id/stop, POST /sessions/:id/queue,
// DELETE /sessions/:id/queue/:seq.
//
// Provenance: extracted verbatim from server.ts in R84 (Wave 2-a) —
// behavior-identical, test-guarded. The SSE stream route
// (POST /sessions/:id/messages/stream — queue-continuation, debug-analyst,
// crash recovery) deliberately still lives in server.ts; it moves here in
// the final R84 phase.
// ─────────────────────────────────────────────────────────────────────────────
import type { FastifyInstance, FastifyReply } from "fastify";
import type { RouteContext } from "./context.js";
// R115-E2: the wall's per-request auth KIND — a POST /sessions that rode a
// DEVICE token (the phone minted the session) tags the created frame with
// source:"device" so the desktop auto-navigates to the new chat.
import { deviceAuthOf } from "./context.js";
import type {
  MessageAttachment,
  PermissionMode,
  RunMode,
  SessionStatus,
  ThinkingLevel,
} from "shared";
import { PERMISSION_MODES, THINKING_LEVELS } from "shared";
import {
  assembleHistory,
  buildPromptEnvironment,
  effectiveToolNames,
  resolveTurnBudget,
  runSingleAgentTurn,
} from "../agents/runtime.js";
import { measureToolSchemaTokens } from "../tools/index.js";
import { resolveProvider } from "../providers/registry.js";
import { getProviderRecord, providerExists } from "../storage/providers.js";
// ROUND-114 (R114-b): the selected-model pair's validation reads the
// provider row (exists + baseUrl configured) and the models table + catalog
// (the pair must name something real — the same surface the pickers list).
import { findModelByProviderAndModelId, getCatalogModel } from "../storage/models.js";
import { getProject } from "../storage/projects.js";
import {
  appendQueuedMessage,
  buildBackgroundTasksReminder,
  createSession,
  deleteQueuedMessage,
  deleteSession,
  forkSession,
  getSession,
  lastSessionSeq,
  listSessionEvents,
  listSessions,
  listSubAgents,
  revertSession,
  searchSessions,
  setSessionSelectedModel,
  type SessionSelectedModel,
  updateSessionActiveMode,
  updateSessionPermissionMode,
  updateSessionTitle,
} from "../storage/sessions.js";
import { getMemorySettings } from "../storage/settings.js";
// ROUND-44 (R44-a): the agent memory system — per-project persistent
// knowledge (facts/decisions/preferences) with REST read/delete for the
// right-sidebar Memory tab. Saves happen via the memory_save tool.
import { memoryDigest } from "../storage/memory.js";
// ROUND-61 (R61): computer use, skills, MCP — the extension surface.
import { getComputerUseSettings } from "../storage/computer-use.js";
import { getIndexSummary } from "../storage/index.js";
import { estimateMessageTokens, estimateTokens } from "../context.js";
// ROUND-83 (R83): the meter applies the newest compaction to the messages
// estimate (the model receives the summary + tail — the raw log is NOT what
// rides the next request; the audit's §2.4).
// ROUND-127 (R127-W4): providerUsageAnchor — the meter's headline number
// anchors on the provider's OWN reported input tokens (the honesty law).
import {
  applyCompaction,
  assembleWithCompaction,
  findLatestCompaction,
  providerUsageAnchor,
} from "../agents/compaction.js";
import { buildSystemPromptSections, readCustomRules } from "../agents/prompts.js";
// ROUND-83 (R83): the meter's skills resolution — the same shared resolver
// prepareTurn uses, so the SKILLS section the estimate counts is the one the
// real turn carries.
import { resolveEffectiveSkills } from "../storage/skills-files.js";
// ROUND-73 (R73-b): the task-modes resolver — the project-scoped /modes
// listing and the PATCH /sessions/:id activeMode validation both sit on the
// SAME resolveEffectiveModes prepareTurn + switch_mode use.
import { findMode, resolveEffectiveModes } from "../agents/modes.js";
import { type SqliteDatabase } from "../storage/db.js";
import { getAgent } from "../storage/agents.js";
// ROUND-52 (R52-b): the SHARED live-turn registry — replaces the local
// activeTurns Map so sub-agent children (registered by the orchestrator)
// are stoppable through the SAME POST /sessions/:id/stop route as main
// turns. Reasons ("owner" | "stall") let the orchestrator report why a
// child ended.
import {
  getTurnController,
  notifyTurn,
  abortTurn,
  registerTurn,
  unregisterTurn,
} from "../lib/turn-registry.js";
import { errorBody } from "./helpers.js";

/** Max attachments per send (mirrors /attachments/read's path cap). */
const MAX_ATTACHMENTS_PER_SEND = 20;
/** ROUND-78 (R78): terminal session statuses — the queue routes mirror
 * prepareTurn's guard (a terminal session accepts no new messages, queued
 * or otherwise). Same three statuses runtime.ts's TERMINAL_STATUSES holds. */
const TERMINAL_SESSION_STATUSES: readonly SessionStatus[] = ["completed", "failed", "cancelled"];
/** Server-side cap on a single attachment's text (128KB head — the same
 * slice POST /attachments/read would have produced). */
const MAX_ATTACHMENT_TEXT_CHARS = 128 * 1024;

/**
 * ROUND-114 (R114-b): read + validate the PATCH body's OPTIONAL `model`
 * field — the session's server-side selected model (the tier between the
 * per-send override and the agent row). Shared by BOTH PATCH routes
 * (/sessions/:id and /sessions/:id/permissions — the composer flips mode and
 * model in one breath, so both surfaces accept the pair). Absent → untouched;
 * null → CLEAR (back to the agent default); an object → must be a COMPLETE
 * {providerId, model} pair naming a KNOWN+CONFIGURED provider (a row with a
 * baseUrl — the send-time gates then police enabled/key honestly, exactly
 * like an agent row referencing them) and a model that matches a models row
 * for that provider OR a catalog entry (the same surface the pickers list —
 * never a string the picker could not have produced). A wrong shape gets the
 * honest early 400 naming body.model, BEFORE any write runs.
 */
export function readSessionModelPatch(
  db: SqliteDatabase,
  raw: Record<string, unknown>,
  reply: FastifyReply,
): { ok: true; value: SessionSelectedModel | null | undefined } | { ok: false } {
  if (!("model" in raw)) return { ok: true, value: undefined };
  const value = raw.model;
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    reply.code(400).send(
      errorBody(
        "VALIDATION",
        "model must be { providerId, model } or null (clear back to the agent default)",
        { field: "body.model" },
      ),
    );
    return { ok: false };
  }
  const item = value as Record<string, unknown>;
  const providerId = typeof item.providerId === "string" ? item.providerId.trim() : "";
  const model = typeof item.model === "string" ? item.model.trim() : "";
  if (providerId === "" || model === "") {
    reply.code(400).send(
      errorBody("VALIDATION", "model must carry BOTH providerId and model (a complete pair)", {
        field: "body.model",
      }),
    );
    return { ok: false };
  }
  if (!providerExists(db, providerId) || getProviderRecord(db, providerId)?.baseUrl == null) {
    reply.code(400).send(
      errorBody(
        "VALIDATION",
        `model.providerId '${providerId}' is not a configured provider (no row with a baseUrl)`,
        { field: "body.model.providerId" },
      ),
    );
    return { ok: false };
  }
  if (
    findModelByProviderAndModelId(db, providerId, model) === undefined &&
    getCatalogModel(model) === undefined
  ) {
    reply.code(400).send(
      errorBody(
        "VALIDATION",
        `model '${model}' is not a known model on provider '${providerId}' (no models row and no catalog entry)`,
        { field: "body.model.model" },
      ),
    );
    return { ok: false };
  }
  return { ok: true, value: { providerId, model } };
}

export interface ComposerSendFields {
  thinkingLevel?: ThinkingLevel;
  attachments?: MessageAttachment[];
}

/**
 * ROUND-82 (R82, the owner's custom-provider routing fix): read + validate
 * the send's OPTIONAL providerId (the composer's provider-grouped model
 * picker). Absent/null → no override (the agent's provider applies — the
 * pre-R82 behavior); a non-blank string must name a KNOWN provider row
 * (the same providerExists validation agent edits use — an unknown id gets
 * the honest early 400 instead of a confusing downstream 409). Shared by
 * BOTH send routes.
 */
export function readOverrideProviderId(
  db: SqliteDatabase,
  raw: Record<string, unknown>,
): { value: string | undefined; error?: string } {
  const value = raw.providerId;
  if (value === undefined || value === null) return { value: undefined };
  if (typeof value !== "string") {
    return { value: undefined, error: "providerId must be a string when present" };
  }
  const trimmed = value.trim();
  if (trimmed === "") return { value: undefined };
  if (!providerExists(db, trimmed)) {
    return { value: undefined, error: `no provider with id '${trimmed}'` };
  }
  return { value: trimmed };
}

/**
 * ROUND-117 (R117-e): the MESSAGE CONTENT CAP — the honest upper bound on
 * one send's `content` field, enforced at ALL THREE ingress legs (the sync
 * send + the queue POST here, the streamed send in routes/sse.ts). The
 * bound is 262,144 characters (2^18 — 256KiB of text): generous for real
 * long prompts (the biggest legitimate pastes — whole files pasted into the
 * composer — live comfortably under it; attachments carry their own 128KB
 * per-file text cap) while stopping the abuse/silent-bloat vector the
 * R117-plan silent-failure list flagged (no cap existed at all). The honest
 * 400 names the exact number so a client can pre-validate.
 */
export const MESSAGE_CONTENT_CAP = 262_144;

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
export function readComposerSendFields(
  raw: Record<string, unknown>,
  reply: FastifyReply,
): { ok: true; value: ComposerSendFields } | { ok: false } {
  let thinkingLevel: ThinkingLevel | undefined;
  if (raw.thinkingLevel !== undefined) {
    if (typeof raw.thinkingLevel !== "string" || !THINKING_LEVELS.includes(raw.thinkingLevel as ThinkingLevel)) {
      reply.code(400).send(
        errorBody("VALIDATION", "thinkingLevel must be one of default|low|medium|high|max", {
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

export function registerSessionRoutes(scope: FastifyInstance, ctx: RouteContext): void {
  const { db, keyring, chat } = ctx;
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
      // R115-E2: the phone's hand — the request authenticated with a
      // device token (routes/context.ts deviceAuthOf, the same read the
      // mobile routes' shell-only guard uses). RIDES THE EVENTS-BUS FRAME
      // ONLY (additive source:"device"); the session row itself is
      // identical no matter who created it.
      ...(deviceAuthOf(request) !== null ? { source: "device" as const } : {}),
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
  // Body: { title?: string, activeMode?: string | null, model?: {providerId,
  // model} | null } — each field is independently optional (absent =
  // untouched). ROUND-73 (R73-b): the activeMode field — the user-side mode
  // switch (the composer picker's R73-c wave and the /mode slash will PATCH
  // exactly like this):
  //   · absent → untouched;
  //   · null → CLEAR the active task mode (default posture);
  //   · string → must resolve against the session's project
  //     (resolveEffectiveModes; a projectless session resolves the
  //     builtins only) — an unknown id is a 400 VALIDATION carrying the
  //     available ids, the same honesty the switch_mode tool returns.
  // ROUND-114 (R114-b): the model field — the session's server-side selected
  // model (readSessionModelPatch validates; null clears back to the agent
  // default). Every setter publishes its events-bus meta frame at the
  // storage choke point, so the OTHER device's composer follows live.
  // Enforcement is at TURN time: prepareTurn resolves the id to the mode
  // record and threads its body into the ACTIVE TASK MODE prompt
  // section (a vanished custom mode is cleared with an honest note), and
  // resolves the model per-send override → session.selectedModel → agent.
  scope.patch("/sessions/:id", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    const raw = body as Record<string, unknown>;
    const hasTitle = "title" in raw;
    const hasActiveMode = "activeMode" in raw;
    // ROUND-114 (R114-b): the optional selected-model pair (absent = untouched).
    const modelPatch = readSessionModelPatch(db, raw, reply);
    if (!modelPatch.ok) return reply;
    const hasModel = modelPatch.value !== undefined;
    if (hasTitle) {
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
    }
    if (!hasTitle && !hasActiveMode && !hasModel) {
      return reply.code(400).send(
        errorBody("VALIDATION", "body must include title, activeMode, and/or model", { field: "body" }),
      );
    }
    const session = getSession(db, id);
    if (session === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no session with id ${id}`));
    }
    // ROUND-73 (R73-b): validate the mode BEFORE any write (a bad value
    // never renames the session as a side effect). Projectless sessions
    // resolve the builtins only (resolveEffectiveModes' no-root path).
    let resolvedModeId: string | null | undefined;
    if (hasActiveMode) {
      const value = raw.activeMode;
      if (value === null) {
        resolvedModeId = null;
      } else if (typeof value === "string") {
        const requested = value.trim();
        const root =
          session.projectId !== null ? getProject(db, session.projectId)?.rootPath : undefined;
        const { modes } = resolveEffectiveModes(root);
        const mode = findMode(modes, requested);
        if (mode === undefined) {
          return reply.code(400).send(
            errorBody("VALIDATION", `activeMode '${requested}' is not an available task mode`, {
              field: "body.activeMode",
              availableModes: modes.map((m) => m.id),
            }),
          );
        }
        resolvedModeId = mode.id;
      } else {
        return reply.code(400).send(
          errorBody("VALIDATION", "activeMode must be a mode id string or null", {
            field: "body.activeMode",
          }),
        );
      }
    }
    let updated: ReturnType<typeof getSession> = session;
    if (hasTitle) {
      // Validated above (hasTitle ⇒ a string ≤ 200 chars).
      updated = updateSessionTitle(db, id, raw.title as string);
    }
    if (hasActiveMode) {
      // resolvedModeId is null (clear) or a resolved mode id here — the
      // string type is narrowed by the validation above.
      const afterMode = updateSessionActiveMode(db, id, resolvedModeId as string | null);
      // Both setters return the fresh row; whichever ran LAST wins the
      // response (they hit the same row — the second re-reads the first).
      updated = afterMode ?? updated;
    }
    // ROUND-114 (R114-b): persist the selected-model pair (validated above —
    // complete, known+configured provider, models-row/catalog match). The
    // {kind:"meta", selectedModel} events-bus frame fires inside the storage
    // setter; the response is the fresh row whichever setter ran last.
    if (hasModel) {
      const afterModel = setSessionSelectedModel(db, id, modelPatch.value ?? null);
      updated = afterModel ?? updated;
    }
    if (updated === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no session with id ${id}`));
    }
    return reply.code(200).send(updated);
  });
  // ── ROUND-50 (R50-c1): the composer's permission-mode switcher ─────────
  // PATCH /sessions/:id/permissions — body { mode, model? } with mode ∈
  // full|ask|plan|editor (400 VALIDATION otherwise). Persists on the
  // session row (migration 0020) and returns the updated session in the
  // SAME shape as GET /sessions/:id ({...session, events, lastSeq}).
  // ROUND-114 (R114-b): the OPTIONAL model field — the composer flips mode
  // and model in one breath, so this surface accepts the selected-model pair
  // too (readSessionModelPatch validates; the same contract PATCH
  // /sessions/:id applies). Enforcement happens at TURN time (runtime.ts
  // prepareTurn tool-set restriction + approvals.ts ask-tier widening) —
  // switching mid-session applies to the NEXT turn. Both setters publish
  // their events-bus meta frames at the storage choke point (the phone's
  // composer follows the flip live).
  scope.patch("/sessions/:id/permissions", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    const raw = body as Record<string, unknown>;
    // ROUND-114 (R114-b): validate the pair BEFORE the mode check runs any
    // write (a bad model never switches the mode as a side effect).
    const modelPatch = readSessionModelPatch(db, raw, reply);
    if (!modelPatch.ok) return reply;
    if (
      typeof raw.mode !== "string" ||
      !PERMISSION_MODES.includes(raw.mode as PermissionMode)
    ) {
      // ROUND-81: the retired "editor" value gets the honest mapping
      // message (the old picker's clients learn where it went).
      const hint =
        raw.mode === "editor"
          ? "mode 'editor' was removed in R81 — use 'ask' (commands are gated by the owner instead of absent)"
          : undefined;
      return reply.code(400).send(
        errorBody("VALIDATION", "mode must be one of full|ask|plan", {
          field: "body.mode",
          ...(hint === undefined ? {} : { hint }),
        }),
      );
    }
    const updated = updateSessionPermissionMode(db, id, raw.mode as PermissionMode);
    if (updated === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no session with id ${id}`));
    }
    // ROUND-114 (R114-b): the selected-model pair rides the SAME route — the
    // fresh row from whichever setter ran last is the response either way.
    const afterModel =
      modelPatch.value !== undefined
        ? setSessionSelectedModel(db, id, modelPatch.value)
        : undefined;
    const final = afterModel ?? updated;
    if (final === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no session with id ${id}`));
    }
    return reply.code(200).send({
      ...final,
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
  // The breakdown numbers are ESTIMATES (approximations documented
  // inline below): the goal is an honest donut, not exact provider
  // accounting. usedTokens = the sum of all breakdown slices — EXCEPT
  // under the ROUND-127 anchor (see the R127-W4 block in the handler):
  // once the provider has reported its own input token count, that
  // number + the post-anchor tail IS the headline, labeled
  // usedTokensBasis "provider-anchored".
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
    // ROUND-82: the meter honors the composer's per-send provider too —
    // ?providerId= (the picker's provider) overrides the agent's, so the
    // window/pricing lookups key on the provider that will actually
    // serve the next send. Unknown ids fall back to the agent's (the
    // meter never 400s; a bad id simply meters the default).
    // ROUND-114 (R114-b): the SAME three-tier fallback prepareTurn resolves
    // — query pair (the live per-send pick) → session.selectedModel → agent
    // row — so the meter's effective-model line is the pair the next send
    // (without its own override) would actually run on.
    const queryProviderId =
      typeof query.providerId === "string" && query.providerId.trim() !== ""
        ? query.providerId.trim()
        : undefined;
    const providerId = queryProviderId ?? session.selectedModel?.providerId ?? agent.providerId;
    const model =
      typeof query.model === "string" && query.model.trim() !== ""
        ? query.model.trim()
        : (session.selectedModel?.model ?? agent.model);
    // ROUND-92 (R92-B): the EFFECTIVE-PAIR gate — the same reorder prepareTurn
    // got. The old gate checked the AGENT ROW before the ?providerId/?model
    // params were read, so a session whose agent was reset to NULL/NULL
    // (R91-A's force-delete) 409'd even while the composer's per-send pair
    // sat unused on the query string. The params now satisfy the gate: only
    // an INCOMPLETE effective pair (either side missing from BOTH the params
    // and the agent row) 409s — the same message, still true (no complete
    // pair exists to meter).
    if (providerId === null || model === null) {
      return reply.code(409).send(
        errorBody("CONFLICT", `agent '${agent.name}' has no providerId/model configured`, {
          agentId: agent.id,
          field: "providerId",
        }),
      );
    }
    const project =
      session.projectId !== null ? getProject(db, session.projectId) : undefined;

    // Tool names: the post-mode, post-allowlist set a REAL turn would
    // receive (runtime.ts effectiveToolNames — shared with prepareTurn's
    // computation, so the donut reflects the live toolset).
    const toolNames = project !== undefined ? effectiveToolNames(db, session, agent) : [];

    // ROUND-83 (R83): the meter now feeds buildSystemPromptSections the
    // SAME PromptContext a real turn receives (the audit's §2.2: the
    // meter previously omitted skills, the task-modes index, the ACTIVE
    // mode's deep module, the background-tasks reminder, and the
    // environment grounding — a mode/skills-heavy session under-counted
    // the system prompt by thousands of tokens, while the UI labeled a
    // slice "Memory & skills" without counting the skills at all).
    // Honest omission, documented: taskHints/modeHints are per-turn
    // ephemeral (they depend on the NEXT user message, unknowable here)
    // and stay out — the estimate errs small, labeled as estimated.
    const environment =
      project !== undefined ? await buildPromptEnvironment(project.rootPath) : undefined;
    const modeResolution =
      project !== undefined
        ? resolveEffectiveModes(project.rootPath)
        : { modes: [] as ReturnType<typeof resolveEffectiveModes>["modes"] };
    // Read-only mirror of prepareTurn's active-mode resolution (a STALE
    // mode id resolves to nothing here — the meter never WRITES; the
    // turn's own resolution does the honest clearing).
    const meterActiveTaskMode =
      session.activeMode !== null
        ? findMode(modeResolution.modes, session.activeMode)
        : undefined;
    const meterSkills =
      project !== undefined
        ? resolveEffectiveSkills(db, {
            ...(project !== undefined ? { projectRoot: project.rootPath, projectScope: project.id } : {}),
            ...(agent.skills.length > 0 ? { agentSkills: agent.skills } : {}),
          }).map((skill) => ({ name: skill.name, description: skill.description }))
        : [];

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
            // ROUND-83: the merged AGENTIC LOOP section's outer cap —
            // the same line prepareTurn passes.
            maxOuterLoops: agent.maxOuterLoops ?? 5,
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
            // ROUND-83: the sections a real turn carries (see above).
            environment,
            skills: meterSkills,
            taskModes: modeResolution.modes.map((mode) => ({
              id: mode.id,
              name: mode.name,
              description: mode.description,
            })),
            ...(meterActiveTaskMode !== undefined
              ? {
                  activeTaskMode: {
                    id: meterActiveTaskMode.id,
                    name: meterActiveTaskMode.name,
                    body: meterActiveTaskMode.body,
                  },
                }
              : {}),
            backgroundTasks: buildBackgroundTasksReminder(db, session.id),
            computerUse: (() => {
              const cu = getComputerUseSettings(db);
              return { enabled: cu.enabled, posture: cu.permission };
            })(),
          })
        : null;

    // ── Breakdown approximations (context.ts estimateTokens — ROUND-64's
    // GPT-style BPE approximation, calibrated ±15% of cl100k behavior):
    // systemPrompt: the identity section — the core prompt text minus the
    //   tool list, memory digest, and meta sections.
    // systemTools: the prompt's tool-names section (measured) PLUS the
    //   ROUND-83 SCHEMA MEASUREMENT — estimateTokens(JSON.stringify(
    //   schema)) per effective tool via tools/index.ts
    //   measureToolSchemaTokens (in-process cached), replacing the
    //   pre-R83 fixed 350/tool constant (the audit's §2.3: real schemas
    //   range tiny→large; ±1-3K tokens of error at 15-20 tools).
    // memory: the memory digest section. meta: codebase index + custom
    //   rules. messages: assembleHistory WITH the newest compaction
    //   applied (ROUND-83 §2.4 — the model receives the summary + tail,
    //   not the raw log; the pre-R83 meter counted the full log forever).
    // mcpTools: honest 0 (no MCP system yet — the UI shows "none").
    const systemPrompt = sections !== null ? estimateTokens(sections.identity) : estimateTokens(agent.systemPrompt);
    const schemaTokens =
      project !== undefined ? await measureToolSchemaTokens(project.rootPath, toolNames) : 0;
    const systemTools = sections !== null ? estimateTokens(sections.tools) + schemaTokens : 0;
    const memory = sections !== null ? estimateTokens(sections.memory) : 0;
    const meta = sections !== null ? estimateTokens(sections.meta) : 0;
    // ROUND-83: compaction-aware messages estimate + the report's
    // compaction badge data (the newest context.compact event).
    const meterEvents = listSessionEvents(db, id);
    const latestCompact = findLatestCompaction(meterEvents);
    const seqMessages = assembleHistory(db, id);
    const meterMessages =
      latestCompact !== null ? applyCompaction(seqMessages, latestCompact) : seqMessages;
    const messages = estimateMessageTokens(meterMessages);
    const mcpTools = 0;

    // ── ROUND-127 (R127-W4): THE HONESTY LAW — the provider-usage anchor
    // wins the meter's headline number. The owner's complaint: "in my
    // provider, it was showing me 50,000 or 60,000 tokens, or even 70,000
    // tokens occasionally, but our context window management was only
    // showing a fixed value there… fixed at 26K of 1 million" — the donut
    // showed the PURE local estimate while the provider's own reported
    // input was 2-3× higher. The estimate LIES LOW: the provider counts
    // what it ACTUALLY received — the real serialization of every tool
    // schema (not our ±15% BPE approximation of it), per-message wire
    // overhead, provider-side framing — everything the local sum
    // under-counts. The R125-C law (compaction.ts providerUsageAnchor —
    // the same anchor the RUNTIME already gates compaction on at its two
    // assembleWithCompaction call sites) is therefore applied HERE too:
    // when a provider-reported inputTokens exists, the headline
    // `usedTokens` = that number + the estimated tail of model-facing
    // messages the provider has NOT yet seen (the anchor's own
    // arithmetic). The BREAKDOWN slices stay as-is — per-slice estimates,
    // still rendered in the popover (under the anchor they no longer sum
    // to the headline; that divergence is the honest, visible gap between
    // the estimate and the provider's count). FAILURE MODE, documented:
    // the anchor is null before the first provider reply — the local
    // estimate stands, labeled usedTokensBasis "estimated" (never a
    // fabricated number, never a fake 0). The `actual` block below stays
    // byte-identical either way (the popover keeps the provider's
    // last-request ground truth).
    const anchor = providerUsageAnchor(meterEvents, meterMessages);
    let usedTokensBasis: "estimated" | "provider-anchored" = "estimated";
    let usedTokens = systemPrompt + systemTools + memory + messages + meta + mcpTools;
    if (anchor !== null) {
      usedTokens = anchor;
      usedTokensBasis = "provider-anchored";
    }

    // ROUND-83 (R83) §3.1: the `actual` block — the provider's OWN
    // number for the last request (the newest message.assistant
    // stats-carrier event; per-SDK-call usage persisted by the streamed
    // runner since R35). The definition of "context used" cannot be more
    // honest than this; the estimate above stays the live-filling
    // projection, labeled as such. null before the first provider reply.
    let actual: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number | null;
      at: string;
      model: string;
    } | null = null;
    for (let i = meterEvents.length - 1; i >= 0; i--) {
      const ev = meterEvents[i];
      if (ev.type !== "message.assistant") continue;
      const payload = (ev.payload ?? {}) as {
        usage?: { inputTokens?: unknown; outputTokens?: unknown; cachedInputTokens?: unknown };
        model?: unknown;
      };
      if (
        payload.usage === undefined ||
        typeof payload.usage.inputTokens !== "number" ||
        typeof payload.usage.outputTokens !== "number"
      ) {
        continue;
      }
      actual = {
        inputTokens: payload.usage.inputTokens,
        outputTokens: payload.usage.outputTokens,
        cachedInputTokens: typeof payload.usage.cachedInputTokens === "number" ? payload.usage.cachedInputTokens : null,
        at: ev.ts,
        model: typeof payload.model === "string" ? payload.model : model,
      };
      break;
    }

    // ROUND-83 (R83) §3.3: ONE budget — the same resolveTurnBudget the
    // turn runners use (window WITH source label, the owner's
    // max_output_tokens finally honored, available = window − output −
    // margin). The pre-R83 route called getModelContextWindow (a bare
    // number, silent 200K default) and never told the UI which.
    const budget = resolveTurnBudget(db, providerId, model);

    // ── Cache + lifetime totals: SQL SUMs over the session's usage rows
    // (COUNT(*) = turns — the ROUND-83 relabel; SUM(cost_usd) rounded
    // like the usage summary; cached_input_tokens is NULL pre-0020 AND
    // (R83) when no provider call reported a cached tier — the RATE
    // computation reads the raw SUM (no COALESCE) so "not reported"
    // renders as null, never a fabricated 0%; the DISPLAY total keeps
    // the COALESCE for old consumers).
    const totalsRow = db
      .prepare(
        `SELECT
           COALESCE(SUM(input_tokens), 0) AS inputTokens,
           COALESCE(SUM(output_tokens), 0) AS outputTokens,
           SUM(cached_input_tokens) AS cachedInputTokensRaw,
           COALESCE(SUM(cached_input_tokens), 0) AS cachedInputTokens,
           COALESCE(SUM(provider_calls), 0) AS providerCalls,
           COUNT(*) AS requests,
           COALESCE(SUM(cost_usd), 0) AS costUsd
         FROM usage_events WHERE session_id = ?`,
      )
      .get(id) as {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokensRaw: number | null;
      cachedInputTokens: number;
      providerCalls: number;
      requests: number;
      costUsd: number;
    };
    const roundUsd = (value: number): number => Math.round(value * 1e6) / 1e6;
    // The honest rate: null when NO row ever reported a cache tier
    // (SUM over all-NULLs is NULL in SQLite) or when nothing ran yet.
    const hitRate =
      totalsRow.cachedInputTokensRaw !== null && totalsRow.inputTokens > 0
        ? totalsRow.cachedInputTokensRaw / totalsRow.inputTokens
        : null;

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
      contextWindow: budget.contextWindow,
      // ROUND-83: the budget trio + provenance — the donut renders the
      // "compaction line" marker at available/window, shows the
      // window's source ("your override" / "catalog default" /
      // "assumed 200k — unknown model"), and reserves the honest
      // output headroom the pre-R83 donut ignored entirely.
      contextWindowSource: budget.contextWindowSource,
      maxOutputTokens: budget.maxOutputTokens,
      available: budget.available,
      usedTokens,
      // ROUND-83: every estimate field is LABELED — the wire says which
      // number is a projection and which is the provider's own.
      // ROUND-127 (R127-W4): "provider-anchored" — the headline is the
      // provider's OWN reported input + the post-anchor tail estimate
      // (the meter's honesty law; "estimated" only when the anchor is
      // null — before the first provider reply).
      usedTokensBasis,
      breakdown: {
        systemPrompt,
        systemTools,
        memory,
        messages,
        meta,
        mcpTools,
      },
      // ROUND-83: the newest compaction's effect + detail (the donut's
      // "Context compacted — N messages summarized" badge; tokensSaved
      // is an estimate delta, rendered with a "~").
      ...(latestCompact !== null
        ? {
            compaction: {
              throughSeq: latestCompact.throughSeq,
              droppedMessages: latestCompact.droppedMessages,
              tokensSaved: latestCompact.tokensSaved,
            },
          }
        : {}),
      // ROUND-83 §3.1: the provider-measured ground truth for the LAST
      // request (null before the first reply; the model + ts ride along
      // so a per-send model switch can never silently mix numbers).
      actual,
      cache: {
        inputTokens: totalsRow.inputTokens,
        cachedInputTokens: totalsRow.cachedInputTokens,
        hitRate,
      },
      sessionTotals: {
        inputTokens: totalsRow.inputTokens,
        outputTokens: totalsRow.outputTokens,
        requests: totalsRow.requests,
        costUsd: roundUsd(totalsRow.costUsd),
        // ROUND-83: the real SDK-call count (the "requests" field above
        // counts TURNS — one row per turn since R24).
        providerCalls: totalsRow.providerCalls,
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
          providerCalls: totalsRow.providerCalls,
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
            providerCalls: totalsRow.providerCalls,
          };
        })(),
      },
    });
  });
  // ── ROUND-83 (R83): the compaction affordance the 800K guard used to
  // promise — POST /sessions/:id/compact forces a context compaction
  // NOW (the same assembleWithCompaction machinery the turn loop runs:
  // summarize the over-budget head into a dense briefing, persist the
  // context.compact event, keep the newest messages). Body {} (no
  // options yet). Honest gates: 404 unknown session, 409 no agent /
  // vanished agent / unconfigured model / missing key / disabled
  // provider — never a 500. ROUND-92 (R92-B): optional ?providerId=/
  // ?model= query params satisfy the unconfigured-model gate (the
  // effective-pair contract — see the inline comment below). The response:
  //   200 { compacted: true,  throughSeq, droppedMessages, tokensSaved }
  //   200 { compacted: false, reason } — nothing to summarize (a short
  //        session has no over-budget head; force skips the under-budget
  //        gate but an empty to-summarize set still declines honestly).
  // The next turn's assembly (and the context meter, R83) reads the
  // persisted event — the compaction applies to the model-facing
  // context immediately and durably (fork/revert inherit it, ADR-0010).
  scope.post("/sessions/:id/compact", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const session = getSession(db, id);
    if (session === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no session with id ${id}`));
    }
    if (session.agentId === null) {
      return reply.code(409).send(errorBody("CONFLICT", `session ${id} has no bound agent`));
    }
    const agent = getAgent(db, session.agentId);
    if (agent === undefined) {
      return reply.code(409).send(
        errorBody("CONFLICT", `session agent ${session.agentId} no longer exists`),
      );
    }
    // ROUND-92 (R92-B): optional ?providerId=/?model= query params — the same
    // effective-pair contract the send routes (R82) and the context meter
    // (R92) got. A session whose agent was reset to NULL/NULL by R91-A's
    // force-delete can still compact: the pair on the query string (the
    // composer's live pick) resolves the provider/model the compaction call
    // runs with, exactly like a send. Params are read the meter's way (blank
    // → undefined → the agent's row decides); an unknown provider id is
    // refused by the resolveProvider gate below — never a 500.
    const query = request.query as Record<string, string | undefined>;
    const queryProviderId =
      typeof query.providerId === "string" && query.providerId.trim() !== ""
        ? query.providerId.trim()
        : undefined;
    const queryModel =
      typeof query.model === "string" && query.model.trim() !== ""
        ? query.model.trim()
        : undefined;
    const effectiveProviderId = queryProviderId ?? agent.providerId;
    const effectiveModel = queryModel ?? agent.model;
    // The EFFECTIVE-PAIR gate (prepareTurn's ROUND-92 reorder): only an
    // incomplete pair (both the params and the agent row missing a side)
    // 409s — the message stays the agent's own truth.
    if (effectiveProviderId === null || effectiveModel === null) {
      return reply.code(409).send(
        errorBody("CONFLICT", `agent '${agent.name}' has no providerId/model configured`, {
          agentId: agent.id,
          field: "providerId",
        }),
      );
    }
    const provider = resolveProvider(db, effectiveProviderId);
    if (provider === undefined) {
      return reply.code(409).send(
        errorBody(
          "CONFLICT",
          queryProviderId !== undefined
            ? `providerId '${queryProviderId}' does not exist`
            : `agent '${agent.name}' references missing provider '${agent.providerId}'`,
        ),
      );
    }
    if (provider.baseUrl === null) {
      return reply.code(409).send(
        errorBody("CONFLICT", `provider '${provider.id}' has no baseUrl configured`),
      );
    }
    if (provider.enabled === false) {
      return reply.code(409).send(
        errorBody("CONFLICT", `provider '${provider.name}' is disabled — enable it in Settings → Models & Providers`),
      );
    }
    const apiKey = keyring.get(provider.id);
    if (apiKey === undefined) {
      return reply.code(409).send(
        errorBody("CONFLICT", `no API key for provider '${provider.id}' — set it in Settings → Models & Providers`),
      );
    }
    const budget = resolveTurnBudget(db, provider.id, effectiveModel);
    const outcome = await assembleWithCompaction(assembleHistory(db, id), budget, {
      db,
      sessionId: id,
      // The buildServer-injected chat (tests drive this with fakes —
      // the same seam the send routes use).
      chat,
      provider: { id: provider.id, baseUrl: provider.baseUrl, apiFormat: provider.apiFormat },
      apiKey,
      // ROUND-92 (R92-B): the EFFECTIVE model (the query pair's when present,
      // the agent's otherwise) — the compaction call runs with the same
      // model a send would.
      model: effectiveModel,
    }, { force: true });
    if (!outcome.compacted || outcome.detail === undefined) {
      return reply.code(200).send({
        compacted: false,
        reason:
          "nothing to compact — the session's history is within the model's budget (or too short to summarize)",
      });
    }
    return reply.code(200).send({
      compacted: true,
      throughSeq: outcome.detail.throughSeq,
      droppedMessages: outcome.detail.droppedMessages,
      tokensSaved: outcome.detail.tokensSaved,
    });
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
  // Body: { keepThroughSeq: integer >= 0 } — ROUND-77 (R77) semantics: the
  // seq of the USER message being reverted; everything from that seq ONWARD
  // is deleted (the target message + its reply + later turns — the UI
  // refills the composer with the message's text so the owner can edit +
  // resend) and one `session.reverted` marker event is appended.
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
    const { getOrchestrator } = await import("../agents/orchestrator.js");
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
    // R117-e: the content cap — the sync-send leg of the shared policy
    // (MESSAGE_CONTENT_CAP above).
    if (content.length > MESSAGE_CONTENT_CAP) {
      return reply.code(400).send(
        errorBody("VALIDATION", `content exceeds ${MESSAGE_CONTENT_CAP} characters`, {
          field: "body.content",
        }),
      );
    }
    const modelOverride =
      typeof raw.model === "string" && raw.model.trim() !== "" ? raw.model : undefined;
    // ROUND-82 (R82, the owner's custom-provider routing fix): the send's
    // PROVIDER — the composer's picker is provider-grouped, so the
    // override carries the provider the model was picked under. Absent
    // (old clients, no override) → the agent's provider, exactly the
    // pre-R82 behavior. Unknown ids get the honest early 400 (the same
    // providerExists validation agent edits use).
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
    // ROUND-50 (R50-c1): the composer's per-send fields — thinking level
    // (reasoning.effort, not persisted) and attachments (persisted on the
    // message.user payload). Validation is shared with the streamed route.
    const composer = readComposerSendFields(raw, reply);
    if (!composer.ok) return reply;

    // ── R107-b (F1): the CONCURRENT-TURN GATE — the sync twin of the
    // streamed route's gate. A second send while a turn is LIVE on this
    // session (registered by the streamed route, this route, or an
    // orchestrated child turn) is a 409, never a parallel turn: the sync
    // turn below now REGISTERS itself too (pre-R107 it was invisible to
    // the registry — ungate-able AND unstoppable), so both send routes and
    // every child share ONE live-turn truth. The designed mid-turn path is
    // the QUEUE (loop-top delivery + the pre-flip on the next sync send).
    if (getTurnController(id) !== undefined) {
      return reply.code(409).send(
        errorBody(
          "CONFLICT",
          `a turn is already in flight for session ${id} — queue the message instead (POST /sessions/${id}/queue), or stop the running turn first (POST /sessions/${id}/stop)`,
          { field: "session" },
        ),
      );
    }

    // R107-b (F1): the sync turn's own REGISTRATION — the route-scoped
    // AbortController that POST /sessions/:id/stop aborts (the R52-b
    // shared registry, finally covering the sync path too: a stop aimed at
    // a sync turn used to be a no-op — abortTurn found no entry). The
    // signal threads into runSingleAgentTurn: pending approvals deny on
    // abort (fail-closed) and the outer loop stops BETWEEN iterations with
    // the honest ABORTED 499 (the R48-e1 semantics the streamed route
    // always had). No notify — a sync turn has no SSE listener; the queue
    // route's notifyTurn reports false and the event-log chip owns the
    // render on the next fold. unregisterTurn is identity-guarded (the
    // SAME controller), so a stale later registration can never be
    // silently deleted by an overlapping route finally-block.
    const abort = new AbortController();
    registerTurn(id, abort);
    try {
      const outcome = await runSingleAgentTurn(
        { db, keyring, chat },
        id,
        content,
        turnModelOverride,
        undefined,
        abort.signal,
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
    } finally {
      unregisterTurn(id, abort);
    }
  });
  // ROUND-120 (R120-C-PC, items 37+38 — the sync/state law): the LIVE-TURN
  // truth surface. The frontend's working/stop state used to derive from SSE
  // frame ARRIVAL ("no frames lately" → looks done), so a refresh mid-turn
  // rendered a finished transcript while the backend kept working and the
  // stop button vanished. The turn registry (lib/turn-registry.ts — the SAME
  // map registerTurn/unregisterTurn/abortTurn maintain for the stop route
  // and the queue route's notifyTurn) is the honest source: this route
  // answers, for any session, whether a turn is registered RIGHT NOW. The
  // PC panel polls it on load + on a sane interval while idle to REHYDRATE
  // a live turn (a refresh mid-turn reopens the working state instead of
  // pretending completion), and to retire a remote mirror whose terminal
  // frame was missed. One boolean, no session mutation, no event writes —
  // a read-only view of the registry, additive to the route set.
  scope.get("/sessions/:id/live", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const session = getSession(db, id);
    if (session === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no session with id ${id}`));
    }
    return { live: getTurnController(id) !== undefined };
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
  // ── ROUND-78 (R78, owner: "工作中发送消息（排队）" — while the agent is
  // responding/running tools the user can still send): the MESSAGE QUEUE
  // surface. POST appends a message.queued event (ONLY while a live turn
  // is registered — 409 NO_LIVE_TURN otherwise, so the panel falls back
  // to a normal send); DELETE removes a not-yet-delivered queued message
  // (the chip's remove). Delivery itself is NOT a route: the runtime's
  // loop-top flip + the streamed route's turn-end continuation own it. ──

  scope.post("/sessions/:id/queue", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    const raw = body as Record<string, unknown>;
    // Content validates EXACTLY like the send routes.
    const content = raw.content;
    if (typeof content !== "string" || content.trim() === "") {
      return reply.code(400).send(
        errorBody("VALIDATION", "content must be a non-empty string", {
          field: "body.content",
        }),
      );
    }
    // R117-e: the content cap — the queue leg of the shared policy
    // (MESSAGE_CONTENT_CAP above); a queued monster message must not
    // bypass the cap the send routes enforce.
    if (content.length > MESSAGE_CONTENT_CAP) {
      return reply.code(400).send(
        errorBody("VALIDATION", `content exceeds ${MESSAGE_CONTENT_CAP} characters`, {
          field: "body.content",
        }),
      );
    }
    // Attachments validate through the SAME shared reader as the send
    // routes (thinkingLevel is meaningless for a queued message — a
    // queued event carries NO reasoning-effort; any provided value is
    // validated for shape and then ignored).
    const composer = readComposerSendFields(raw, reply);
    if (!composer.ok) return reply;

    // Session guards, prepareTurn-style: 404 unknown session, 409
    // terminal status (a completed/failed/cancelled session accepts no
    // queue — same contract as a normal send).
    const session = getSession(db, id);
    if (session === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no session with id ${id}`));
    }
    if (TERMINAL_SESSION_STATUSES.includes(session.status)) {
      return reply.code(409).send(
        errorBody("CONFLICT", `session ${id} is ${session.status} and no longer accepts messages`),
      );
    }
    // A queue entry requires a LIVE registered turn — the message rides
    // the in-flight stream (loop-top delivery + the turn-end
    // continuation). No live turn (turn just ended, sub-agent child
    // without a stream, stale UI state) → the honest 409 so the panel
    // falls back to an ordinary send.
    if (getTurnController(id) === undefined) {
      return reply.code(409).send(
        errorBody(
          "NO_LIVE_TURN",
          "no live turn for this session — send the message normally",
        ),
      );
    }

    // ROUND-82 (R82): the queue entry's OWN override — the picker state
    // at queue time. Same validation as the send routes (unknown
    // provider → honest 400; the queued follow-up must not silently
    // route to the agent default the way it did pre-R82).
    const queuedModelOverride =
      typeof raw.model === "string" && raw.model.trim() !== ""
        ? raw.model.trim()
        : undefined;
    const queuedOverrideProviderId = readOverrideProviderId(db, raw);
    if (queuedOverrideProviderId.error !== undefined) {
      return reply.code(400).send(
        errorBody("VALIDATION", queuedOverrideProviderId.error, { field: "body.providerId" }),
      );
    }

    const queued = appendQueuedMessage(db, id, {
      content,
      ...(composer.value.attachments !== undefined ? { attachments: composer.value.attachments } : {}),
      ...(queuedModelOverride !== undefined ? { model: queuedModelOverride } : {}),
      ...(queuedOverrideProviderId.value !== undefined
        ? { providerId: queuedOverrideProviderId.value }
        : {}),
    });
    // The live stream's chip: the queued frame rides the registered
    // notify (the SSE send captured at registerTurn). False = no live
    // listener (background turn) — the event log still owns the chip on
    // the next fold.
    notifyTurn(id, { type: "user.queued", seq: queued.seq, content, ts: queued.ts });
    return reply.code(200).send({ ok: true, seq: queued.seq });
  });

  // ROUND-78 (R78): remove a not-yet-delivered queued message (the chip's
  // X button). Only message.queued rows are deletable — a delivered row
  // is ordinary transcript history and 404s (the UI never offers removal
  // on those).
  scope.delete("/sessions/:id/queue/:seq", async (request, reply) => {
    const { id, seq } = request.params as Record<string, string>;
    const parsedSeq = Number(seq);
    if (!Number.isInteger(parsedSeq) || parsedSeq <= 0) {
      return reply.code(400).send(
        errorBody("VALIDATION", "seq must be a positive integer", { field: "params.seq" }),
      );
    }
    const session = getSession(db, id);
    if (session === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no session with id ${id}`));
    }
    if (deleteQueuedMessage(db, id, parsedSeq)) {
      return reply.code(200).send({ ok: true });
    }
    return reply.code(404).send(
      errorBody("NOT_FOUND", `no queued message with seq ${parsedSeq} for session ${id}`),
    );
  });
}
