/**
 * ROUND-52 (R52-f): the MEMORY plugin — memory_save / memory_recall /
 * memory_list, moved VERBATIM from tools/index.ts buildProjectTools. The
 * master switch (toolDeps.memoryEnabled === false → no tools) is applied by
 * the plugin itself — same semantics as the old inline deletes.
 */
import { jsonSchema } from "ai";
import { memoryListTool, memoryRecallTool, memorySaveTool } from "../memory.js";
import type { PluginDefinition, ToolDefinition } from "../registry.js";

export const memoryPlugin: PluginDefinition = {
  id: "core-memory",
  name: "Project Memory",
  version: "1.0.0",
  description: "Per-project persistent knowledge (facts/decisions/preferences).",
  category: "memory",
  createTools: (ctx): ToolDefinition[] => {
    const toolDeps = ctx.toolDeps;
    // ROUND-49 (owner directive: "a setting to turn off this memory
    // functionality"): the memory master switch — when explicitly disabled
    // the memory tools are simply not registered (the model never sees them,
    // so it can neither save new memories nor be fed stale ones through
    // recall; the digest injection lives in runtime.ts prepareTurn under the
    // same switch).
    if (toolDeps?.memoryEnabled === false) return [];
    return [
      {
        name: "memory_save",
        description:
          "Persist a durable fact/decision/preference about this project to recall in future sessions. Use for architecture decisions, owner preferences, gotchas — NOT transient state.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "The knowledge to remember (one item per call, max 4000 chars)",
            },
            kind: {
              type: "string",
              description: "fact | decision | preference | note (default note)",
              enum: ["fact", "decision", "preference", "note"],
            },
          },
          required: ["content"],
        }),
        execute: async (input) => memorySaveTool(toolDeps, input.content, input.kind),
      },
      {
        name: "memory_recall",
        description:
          "Search this project's saved memories (durable facts, decisions, preferences) by keyword, or list the newest 12 when no query is given. Content matches rank first.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Substring to look for in saved memories (omit = newest 12)",
            },
          },
          required: [],
        }),
        execute: async (input) => memoryRecallTool(toolDeps, input.query),
      },
      {
        name: "memory_list",
        description:
          "List this project's saved memories newest-first (default 20, max 50). Use to browse everything the project remembers.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Max memories to return (default 20, cap 50)",
            },
          },
          required: [],
        }),
        execute: async (input) => memoryListTool(toolDeps, input.limit),
      },
    ];
  },
};
