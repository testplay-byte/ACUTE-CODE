// ─────────────────────────────────────────────────────────────────────────────
// R87: the agent-question domain — the interactive ask_user tool's resolve
// route.
//
// The flow (agent-question.ts is the mechanics): the ask_user tool emits an
// "agent-question" SSE frame (the chat card mounts), pends on the module's
// registry, and the frontend answers through here —
//
//   POST /agent-questions/:id/resolve  { answers: string[], sources?: ("option"|"custom")[] }
//
// The answers array aligns 1:1 with the ask's questions (one per question,
// in order). 200 {ok:true} settles the wait (the tool's promise resolves and
// the "agent-question.resolved" frame collapses the card); 404 {ok:false} for
// an unknown/expired id (the card's own timeout is the fallback); 400 for a
// malformed payload — the exact browser-checkpoints contract shape.
// ─────────────────────────────────────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.js";
import { errorBody } from "./helpers.js";
import { resolveAgentQuestion } from "../agent-question.js";

export function registerQuestionRoutes(scope: FastifyInstance, _ctx: RouteContext): void {
  scope.post("/agent-questions/:id/resolve", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    const raw = body as Record<string, unknown>;
    if (!Array.isArray(raw.answers)) {
      return reply.code(400).send(
        errorBody("VALIDATION", "answers must be an array of strings (one per question)", {
          field: "body.answers",
        }),
      );
    }
    if (raw.sources !== undefined && !Array.isArray(raw.sources)) {
      return reply.code(400).send(
        errorBody("VALIDATION", "sources must be an array of 'option' | 'custom'", {
          field: "body.sources",
        }),
      );
    }
    const settled = resolveAgentQuestion(id, raw.answers, raw.sources);
    if (!settled) {
      // Unknown id OR a mismatched answers length — both mean the card is
      // stale (timeout already settled it, or a duplicate submit raced).
      return reply.code(404).send(errorBody("NOT_FOUND", `no open question with id ${id}`));
    }
    return { ok: true };
  });
}
