// ─────────────────────────────────────────────────────────────────────────────
// R84 (Wave 2-a): the project-memory domain (ROUND-44, R44-a).
//
// Registers, in the original server.ts registration order: GET
// /projects/:id/memory and DELETE /projects/:id/memory/:memoryId.
//
// Provenance: extracted verbatim from server.ts in R84 (Wave 2-a) —
// behavior-identical, test-guarded. Saves go through the agent's memory_save
// tool, not a REST POST — memory is the AGENT's channel by design; these
// routes are the right-sidebar Memory tab's read/prune surface.
// ─────────────────────────────────────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.js";
import { getProject } from "../storage/projects.js";
// ROUND-44 (R44-a): the agent memory system — per-project persistent
// knowledge (facts/decisions/preferences) with REST read/delete for the
// right-sidebar Memory tab. Saves happen via the memory_save tool.
import { deleteMemory, listMemories } from "../storage/memory.js";
import { errorBody } from "./helpers.js";

export function registerMemoryRoutes(scope: FastifyInstance, ctx: RouteContext): void {
  const { db } = ctx;
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
}
