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
        description:
          "Write the FULL todo list for the current task (snapshot, not a delta). Use for multi-step tasks to track progress. Each item: {content, status: 'pending'|'in_progress'|'completed'}. Provide ALL items every time.",
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
