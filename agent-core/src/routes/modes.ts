// ─────────────────────────────────────────────────────────────────────────────
// R84 (Wave 2-a): the task-modes domain — the project-scoped posture listing.
//
// Registers, in the original server.ts registration order: GET
// /projects/:id/modes (the R73-b mode picker's data source).
//
// Provenance: extracted verbatim from server.ts in R84 (Wave 2-a) —
// behavior-identical, test-guarded. The listing resolves through the SAME
// resolveEffectiveModes prepareTurn and switch_mode use (agents/modes.ts), so
// the picker, the prompt's TASK MODES index, and the tool can never disagree.
// ─────────────────────────────────────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.js";
import { getProject } from "../storage/projects.js";
// ROUND-73 (R73-b): the task-modes resolver — the project-scoped /modes
// listing and the PATCH /sessions/:id activeMode validation both sit on the
// SAME resolveEffectiveModes prepareTurn + switch_mode use.
import { resolveEffectiveModes } from "../agents/modes.js";
import { errorBody } from "./helpers.js";

export function registerModeRoutes(scope: FastifyInstance, ctx: RouteContext): void {
  const { db } = ctx;
  // ── ROUND-73 (R73-b): TASK MODES — the project-scoped mode listing ──
  // GET /projects/:id/modes — the mode picker's data source (the
  // composer's R73-c wave): the six builtins + the project's
  // .acute/agents/*.md customs (shadowing included), resolved through
  // the SAME resolveEffectiveModes prepareTurn and switch_mode use, so
  // the picker, the prompt's TASK MODES index, and the tool can never
  // disagree. METADATA ONLY (id/name/description/source) — bodies are
  // PROMPT-SIDE and never served here (GET /skills' metadata-only
  // honesty: the deep module rides the system prompt while active, and
  // switch_mode returns it once on activation).
  scope.get("/projects/:id/modes", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const project = getProject(db, id);
    if (project === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no project with id ${id}`));
    }
    const { modes } = resolveEffectiveModes(project.rootPath);
    return {
      modes: modes.map((mode) => ({
        id: mode.id,
        name: mode.name,
        description: mode.description,
        source: mode.source,
        // ROUND-81 (R81, ADR-0029): readOnly is RETIRED — postures are
        // non-enforcing guidance now (the unified mode picker carries
        // the read-only badge on PLAN). Kept as always-false for wire
        // compatibility with any cached client build reading this route.
        readOnly: false,
      })),
    };
  });
}
