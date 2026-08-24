/**
 * Todo tool (round-25: Kilo Code parity — task tracking during multi-step work).
 * The model writes a full-snapshot todo list; it's stored as a `todo.update`
 * session event (append-only, ADR-0010). The TodoPanel reads the latest
 * snapshot from the event log.
 */
import { appendSessionEvent } from "../storage/sessions.js";
import type Database from "better-sqlite3";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface TodoDeps {
  db: Database.Database;
  sessionId: string;
  agentId: string;
}

/**
 * Write the full todo list snapshot. The model provides the ENTIRE list
 * (not a delta) — this is how Cline/Kilo/Roo handle todos (idempotent,
 * no merge conflicts).
 */
export function writeTodo(
  deps: TodoDeps,
  items: TodoItem[],
): { ok: boolean; output: string } {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, output: "todo_write needs a non-empty 'todos' array" };
  }
  if (items.length > 30) {
    return { ok: false, output: "too many todos (max 30) — break the task into smaller phases" };
  }

  // Validate + normalize each item
  const valid: TodoItem[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const content = typeof item.content === "string" ? item.content.trim() : "";
    const status =
      item.status === "completed" || item.status === "in_progress" ? item.status : "pending";
    if (content) valid.push({ content: content.slice(0, 200), status });
  }
  if (valid.length === 0) {
    return { ok: false, output: "no valid todo items (each needs non-empty 'content')" };
  }

  // Append as a session event (the UI reads the latest snapshot)
  appendSessionEvent(deps.db, deps.sessionId, {
    type: "todo.update",
    agentId: deps.agentId,
    payload: { todos: valid },
  });

  const done = valid.filter((t) => t.status === "completed").length;
  return {
    ok: true,
    output: `todo list updated: ${done}/${valid.length} completed (${valid.filter((t) => t.status === "in_progress").length} in progress)`,
  };
}
