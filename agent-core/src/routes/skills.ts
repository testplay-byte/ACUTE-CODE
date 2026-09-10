// ─────────────────────────────────────────────────────────────────────────────
// R84 (Wave 2-a): the skills CRUD domain (ROUND-61 → ROUND-70 (R70-b, D1) →
// ROUND-72 (R72-c)).
//
// Registers, in the original server.ts registration order: GET /skills (the
// MERGED listing: DB rows + project/user-global file skills), POST /skills,
// PATCH /skills/:id, DELETE /skills/:id.
//
// Provenance: extracted verbatim from server.ts in R84 (Wave 2-a) —
// behavior-identical, test-guarded. The read_skill TOOL (the agent-side
// reference loader) already lives in tools/plugins/skills.ts — it shares the
// ONE resolver (storage/skills-files.ts) with this listing, so the prompt
// index and read_skill can never disagree.
// ─────────────────────────────────────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.js";
import { createSkill, updateSkill, deleteSkill } from "../storage/skills.js";
// ROUND-70 (R70-b, D1): the file-based skills surface — the merged listing
// (DB + project files + user-global files) and the synthetic-id guard the
// CRUD routes refuse edits through.
import { isFileSkillId, listAllSkillsMerged } from "../storage/skills-files.js";
import { errorBody } from "./helpers.js";

export function registerSkillRoutes(scope: FastifyInstance, ctx: RouteContext): void {
  const { db } = ctx;
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
}
