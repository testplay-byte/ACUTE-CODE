/**
 * ROUND-52 (R52-f): the TODO plugin — todo_write, moved VERBATIM from
 * tools/index.ts buildProjectTools.
 */
import { jsonSchema } from "ai";
import { writeTodo, type TodoItem } from "../todo.js";
import type { PluginDefinition, ToolDefinition } from "../registry.js";

export const todoPlugin: PluginDefinition = {
  id: "core-todo",
  name: "Todo Tracking",
  version: "1.0.0",
  description: "The whole-list todo snapshot tool for multi-step task tracking.",
  category: "planning",
  createTools: (ctx): ToolDefinition[] => {
    const toolDeps = ctx.toolDeps;
    return [
      {
        name: "todo_write",
        // ROUND-70 (R70-a): Codex + Claude Code's high-leverage todo guidance
        // (skip trivial tasks, no single-step plans, in_progress BEFORE
        // starting, update after each sub-task) — the snapshot semantics are
        // UNCHANGED, only the description teaches the discipline.
        description:
          "Write the FULL todo list for the current task (whole-list snapshot, not a delta — provide ALL items every time; one call per update). Use it for genuinely multi-step work: SKIP the todo list for trivial tasks you can finish in one or two steps, and do NOT create single-item plans — a plan needs at least 2 steps or it is not a plan. Write the todos BEFORE starting the work. Mark exactly one item in_progress BEFORE beginning it, and update the list IMMEDIATELY after completing each sub-task (never batch completions). The todo list is your progress contract: when every item is completed and verified, you may finish the task. Each item: {content, status: 'pending'|'in_progress'|'completed'}.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            todos: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  content: { type: "string", description: "What needs to be done (one line)" },
                  status: { type: "string", description: "pending | in_progress | completed" },
                },
                required: ["content", "status"],
              },
              description: "The complete todo list snapshot",
            },
          },
          required: ["todos"],
        }),
        execute: async (input) => {
          if (!toolDeps) return { ok: false, output: "todo tracking unavailable in this context" };
          const todos = Array.isArray(input.todos) ? (input.todos as TodoItem[]) : [];
          return writeTodo(toolDeps, todos);
        },
      },
    ];
  },
};
