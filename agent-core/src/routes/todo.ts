// ─────────────────────────────────────────────────────────────────────────────
// ROUND-88 (R88, owner: the floating to-do widget): the manual-edit route —
// the OWNER's write path for a session's todo list.
//
//   POST /sessions/:id/todo  { todos: [{ content, status }] }
//
// The owner's spec: "I am also thinking about adding the functionality to
// manually edit the to-do list and make some changes so that the agent can
// properly and easily work with them. If I feel something is off in the
// to-do list, then I can modify it and handle it properly."
//
// The write reuses writeTodo's exact validation + normalization ladder (the
// tool's own gate — max 30 items, 200-char content, status normalize), but
// with ONE deliberate widening: an EMPTY array is accepted here (the
// widget's "clear the list" affordance — the tool keeps its ≥1 rule because
// the model has no business deleting its plan; the owner does). The persisted
// event carries source:"user" so (1) the fold/UI can badge owner edits and
// (2) prepareTurn's CURRENT TODO LIST section emphasizes them — the agent
// sees the owner's changes on its next turn and works with them.
//
// Frames: when a live streamed turn is registered for the session, the
// todo-updated frame rides its SSE via the turn registry (the R78
// user.queued pattern) so a SECOND view of the session (or the same one
// before its refetch) updates instantly. No live turn → the persisted event
// + the caller's own refetch is the whole story (200 either way).
// ─────────────────────────────────────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.js";
import { errorBody } from "./helpers.js";
import { appendSessionEvent, getSession } from "../storage/sessions.js";
import { writeTodo, type TodoItem } from "../tools/todo.js";
import { notifyTurn } from "../lib/turn-registry.js";

/** The route's own validation — mirrors writeTodo's ladder but allows the
 * empty list (the owner's clear affordance) and reports per-field 400s the
 * UI can surface in the widget. */
function parseTodoItems(raw: unknown): { ok: true; items: TodoItem[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, message: "todos must be an array of { content, status }" };
  }
  if (raw.length > 30) {
    return { ok: false, message: "too many todos (max 30) — break the task into smaller phases" };
  }
  const items: TodoItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, message: "each todo must be an object with content + status" };
    }
    const content = (entry as Record<string, unknown>).content;
    if (typeof content !== "string" || content.trim().length === 0) {
      return { ok: false, message: "each todo needs a non-empty 'content' string" };
    }
    const status = (entry as Record<string, unknown>).status;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") {
      return { ok: false, message: "status must be 'pending' | 'in_progress' | 'completed'" };
    }
    items.push({ content: content.trim().slice(0, 200), status });
  }
  return { ok: true, items };
}

export function registerTodoRoutes(scope: FastifyInstance, ctx: RouteContext): void {
  scope.post("/sessions/:id/todo", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const session = getSession(ctx.db, id);
    if (session === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no session with id ${id}`));
    }
    if (session.agentId === null) {
      return reply.code(409).send(errorBody("CONFLICT", `session ${id} has no bound agent`));
    }

    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply.code(400).send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    const parsed = parseTodoItems((body as Record<string, unknown>).todos);
    if (!parsed.ok) {
      return reply.code(400).send(errorBody("VALIDATION", parsed.message, { field: "body.todos" }));
    }

    // The write itself — the tool's own ladder, marked source:"user".
    const result = writeTodo(
      { db: ctx.db, sessionId: id, agentId: session.agentId, source: "user" },
      parsed.items,
    );

    // The empty list ("clear") writes an EMPTY todo.update — the fold and
    // latestTodoSnapshot both treat an empty latest snapshot as "no list",
    // so the widget hides and the prompt section drops out. (The tool keeps
    // its ≥1 rule: the MODEL has no business deleting its plan; the owner
    // does.)
    if (parsed.items.length === 0) {
      appendSessionEvent(ctx.db, id, {
        type: "todo.update",
        agentId: session.agentId,
        payload: { todos: [], source: "user" },
      });
      notifyTurn(id, { type: "todo-updated", sessionId: id, todos: [], source: "user" });
      return { ok: true, todos: [] };
    }

    if (!result.ok) {
      // The ladder above already validated everything the tool re-checks;
      // this arm is unreachable-by-construction belt-and-braces.
      return reply.code(400).send(errorBody("VALIDATION", result.output, { field: "body.todos" }));
    }

    // Fan out to any live turn's stream (second views update instantly; the
    // caller's own refetch folds the persisted event).
    notifyTurn(id, { type: "todo-updated", sessionId: id, todos: parsed.items, source: "user" });

    return { ok: true, todos: parsed.items };
  });
}
