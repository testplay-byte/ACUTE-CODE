// ─────────────────────────────────────────────────────────────────────────────
// R84 (Wave 2-a): the project-memory domain (ROUND-44, R44-a).
//
// Registers, in the original server.ts registration order: GET
// /projects/:id/memory and DELETE /projects/:id/memory/:memoryId.
//
// Provenance: extracted verbatim from server.ts in R84 (Wave 2-a) —
// behavior-identical, test-guarded. Saves originally went through the
// agent's memory_save tool only — memory was the AGENT's channel by design;
// these routes were the right-sidebar Memory tab's read/prune surface.
//
// ROUND-98 (R98-F1, the owner: "it definitely does not know or remember the
// things properly… implement our proper memory functionality"): the WRITE
// side joins the read side — POST /projects/:id/memory (the Memory tab's
// add-memory form) and PUT /projects/:id/memory/:memoryId (the per-row
// edit). Validation follows routes/ratings.ts's explicit-errorBody idiom;
// storage rides storage/memory.ts's saveMemoryWithDedup/updateMemory (the
// dedup path is the point: an exact duplicate REFRESHES the row instead of
// inserting a twin, exactly as memory_save does).
// ─────────────────────────────────────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.js";
import { getProject } from "../storage/projects.js";
// ROUND-44 (R44-a): the agent memory system — per-project persistent
// knowledge (facts/decisions/preferences) with REST read/delete for the
// right-sidebar Memory tab. Saves happen via the memory_save tool.
// ROUND-98 (R98-F1): + the REST write side (POST/PUT) for the panel's
// add/edit flows — same storage validation, same dedup semantics.
// ROUND-117 (R117-b): + the WORKSPACE tier — the cross-project scope
// (memory rows with scope 'workspace' + project_id NULL) exposed as a
// top-level route family mirroring the project pair, so the Memory panel's
// "Workspace" side and any future client can curate the owner's global
// facts. Same validation grammar, same dedup, same source "owner".
import {
  MAX_MEMORY_CONTENT_CHARS,
  MEMORY_KINDS,
  deleteMemory,
  listMemories,
  listWorkspaceMemories,
  saveMemoryWithDedup,
  updateMemory,
} from "../storage/memory.js";
import { errorBody } from "./helpers.js";

/** ROUND-98 (R98-F1): normalize a body's `kind` — undefined/null →
 * undefined (absent); otherwise the lowercased value, validated against the
 * four. `blankIsAbsent` (the POST's reading): a whitespace-only string reads
 * as absent so the storage default "note" applies — exactly the memory_save
 * tool's contract. The PUT passes false: in a PATCH context a blank kind has
 * no default to fall back to (absent = keep the row's kind), so it 400s with
 * the honest set instead of silently no-oping. */
function normalizeKind(raw: unknown, blankIsAbsent: boolean): { kind?: string; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string") {
    return { error: `kind must be one of ${MEMORY_KINDS.join(" | ")} (got '${String(raw)}')` };
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "" && blankIsAbsent) return {}; // blank = absent — the tool contract
  if (!(MEMORY_KINDS as readonly string[]).includes(trimmed)) {
    return { error: `kind must be one of ${MEMORY_KINDS.join(" | ")} (got '${raw}')` };
  }
  return { kind: trimmed };
}

/* ── ROUND-117 (R117-b): the shared body parsers (the project + workspace
 * route families validate IDENTICALLY — the helpers below are the R98-F1
 * inline checks extracted verbatim, in the same order, producing the same
 * status/message/field; the project routes' pinned 400s are unchanged). */

/** A 4xx the route layer renders (the errorBody shape + the status). */
interface Body4xx {
  status: 400;
  code: "VALIDATION";
  message: string;
  field: string;
}

/** The create-body parser ({kind?, content} — blank kind absent, trimmed
 * non-empty content ≤ the table cap). */
function parseMemoryCreateBody(body: unknown): { kind?: string; content?: string; error?: Body4xx } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: { status: 400, code: "VALIDATION", message: "body must be a JSON object", field: "body" } };
  }
  const raw = body as Record<string, unknown>;
  const kindCheck = normalizeKind(raw.kind, true);
  if (kindCheck.error !== undefined) {
    return { error: { status: 400, code: "VALIDATION", message: kindCheck.error, field: "body.kind" } };
  }
  // The table's cap is measured on the TRIMMED content (the storage path
  // trims first) — the route mirrors it so the two validations agree.
  const content = typeof raw.content === "string" ? raw.content.trim() : "";
  if (content === "") {
    return { error: { status: 400, code: "VALIDATION", message: "content must be a non-empty string", field: "body.content" } };
  }
  if (content.length > MAX_MEMORY_CONTENT_CHARS) {
    return { error: { status: 400, code: "VALIDATION", message: `content must be at most ${MAX_MEMORY_CONTENT_CHARS} characters`, field: "body.content" } };
  }
  return { kind: kindCheck.kind, content };
}

/** The partial-patch parser ({content?, kind?} — at least one; null reads as
 * "not provided", the ratings `note` grammar). */
function parseMemoryPatchBody(body: unknown): { content?: string; kind?: string; error?: Body4xx } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: { status: 400, code: "VALIDATION", message: "body must be a JSON object", field: "body" } };
  }
  const raw = body as Record<string, unknown>;
  // null reads as "not provided" — the empty patch check has to use the same
  // reading or {content: null} would slip through as a no-op bump.
  const hasContent = raw.content !== undefined && raw.content !== null;
  const hasKind = raw.kind !== undefined && raw.kind !== null;
  if (!hasContent && !hasKind) {
    return { error: { status: 400, code: "VALIDATION", message: "provide at least one of content or kind", field: "body" } };
  }
  let content: string | undefined;
  if (hasContent) {
    if (typeof raw.content !== "string") {
      return { error: { status: 400, code: "VALIDATION", message: "content must be a non-empty string", field: "body.content" } };
    }
    content = raw.content.trim();
    if (content === "") {
      return { error: { status: 400, code: "VALIDATION", message: "content must be a non-empty string", field: "body.content" } };
    }
    if (content.length > MAX_MEMORY_CONTENT_CHARS) {
      return { error: { status: 400, code: "VALIDATION", message: `content must be at most ${MAX_MEMORY_CONTENT_CHARS} characters`, field: "body.content" } };
    }
  }
  const kindCheck = normalizeKind(raw.kind, false);
  if (kindCheck.error !== undefined) {
    return { error: { status: 400, code: "VALIDATION", message: kindCheck.error, field: "body.kind" } };
  }
  return { content, kind: kindCheck.kind };
}

/** Render one parsed-body error (the shared 4xx renderer; the narrowed
 * reply shape from routes/prompts.ts's requireProject). */
type RejectableReply = { code: (status: number) => { send: (body: unknown) => unknown } };
function sendBodyError(reply: RejectableReply, error: Body4xx): unknown {
  return reply.code(error.status).send(errorBody(error.code, error.message, { field: error.field }));
}

export function registerMemoryRoutes(scope: FastifyInstance, ctx: RouteContext): void {
  const { db } = ctx;
  // ROUND-44 (R44-a): project memory — the right-sidebar Memory tab reads
  // everything the agent saved via memory_save (newest first); DELETE
  // removes one item (the owner pruning stale knowledge). Saves go
  // through the agent's memory_save tool, not a REST POST — memory is the
  // AGENT's channel by design.
  // (R98-F1: the POST below relaxes that only for the OWNER's own manual
  // saves — source "owner", distinguishable in every row.)
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

  // ── ROUND-98 (R98-F1): the add-memory form's write side. The body is
  // {kind?, content} — kind absent/blank defaults to "note" (exactly the
  // memory_save tool's contract), content validates non-empty after trim
  // and ≤ MAX_MEMORY_CONTENT_CHARS (the table's cap, the same readable
  // error the tool path throws). An EXACT duplicate (case-insensitive,
  // same project) rides saveMemoryWithDedup's refresh path: 200 +
  // {deduplicated: true} + the bumped row instead of a twin insert (201).
  // The row is sourced "owner" — the agent's own saves stay "agent".
  // (R117-b: the body checks moved into parseMemoryCreateBody — shared with
  // the workspace POST below, byte-identical outcomes.)
  scope.post("/projects/:id/memory", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const project = getProject(db, id);
    if (project === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
    }
    const parsed = parseMemoryCreateBody(request.body);
    if (parsed.error !== undefined) return sendBodyError(reply, parsed.error);
    const result = saveMemoryWithDedup(db, {
      projectId: id,
      kind: parsed.kind,
      content: parsed.content as string,
      source: "owner",
    });
    return reply.code(result.deduplicated ? 200 : 201).send({
      memory: result.item,
      deduplicated: result.deduplicated,
    });
  });

  // ── ROUND-98 (R98-F1): the per-row edit's write side — a PARTIAL patch
  // {content?, kind?} (at least one; the PUT /settings/* grammar). Content
  // re-validates exactly like the POST; kind moves the row between the
  // four; unknown memory id is the DELETE route's 404. updated_at bumps so
  // the edited row ranks like a fresh save. No importance field: the
  // memory table's importance model IS the kind weight (0015 + KIND_WEIGHT)
  // — see updateMemory's docblock.
  // (R117-b: the body checks moved into parseMemoryPatchBody — shared with
  // the workspace PUT below, byte-identical outcomes.)
  scope.put("/projects/:id/memory/:memoryId", async (request, reply) => {
    const { id, memoryId } = request.params as Record<string, string>;
    const project = getProject(db, id);
    if (project === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
    }
    const parsed = parseMemoryPatchBody(request.body);
    if (parsed.error !== undefined) return sendBodyError(reply, parsed.error);
    // The route has validated everything updateMemory checks, so its
    // thrown errors are defensive-only here (never reached through REST).
    const result = updateMemory(db, memoryId, { content: parsed.content, kind: parsed.kind });
    if (!result.ok) {
      return reply.code(404).send(errorBody("NOT_FOUND", result.error));
    }
    return { memory: result.item };
  });

  // ── ROUND-117 (R117-b): the WORKSPACE tier — the cross-project scope's
  // top-level route family, mirroring the project pair (GET/POST + the
  // DELETE/PUT the Memory panel's CRUD needs). No project to 404 on: the
  // tier IS the address. Rows carry scope 'workspace' + project_id NULL +
  // source "owner" (the owner's curated global facts; the agent's
  // memory_save channel stays project-scoped by design this wave).
  scope.get("/memory/workspace", async () => {
    return { memories: listWorkspaceMemories(db, 100) };
  });

  scope.delete("/memory/workspace/:memoryId", async (request, reply) => {
    const { memoryId } = request.params as Record<string, string>;
    const result = deleteMemory(db, memoryId);
    if (!result.ok) {
      return reply.code(404).send(errorBody("NOT_FOUND", result.error));
    }
    return { ok: true };
  });

  scope.post("/memory/workspace", async (request, reply) => {
    const parsed = parseMemoryCreateBody(request.body);
    if (parsed.error !== undefined) return sendBodyError(reply, parsed.error);
    const result = saveMemoryWithDedup(db, {
      projectId: null,
      scope: "workspace",
      kind: parsed.kind,
      content: parsed.content as string,
      source: "owner",
    });
    return reply.code(result.deduplicated ? 200 : 201).send({
      memory: result.item,
      deduplicated: result.deduplicated,
    });
  });

  scope.put("/memory/workspace/:memoryId", async (request, reply) => {
    const { memoryId } = request.params as Record<string, string>;
    const parsed = parseMemoryPatchBody(request.body);
    if (parsed.error !== undefined) return sendBodyError(reply, parsed.error);
    const result = updateMemory(db, memoryId, { content: parsed.content, kind: parsed.kind });
    if (!result.ok) {
      return reply.code(404).send(errorBody("NOT_FOUND", result.error));
    }
    return { memory: result.item };
  });
}
