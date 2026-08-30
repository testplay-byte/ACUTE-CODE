/**
 * ROUND-52 (R52-f): the GIT plugin — git_status / git_diff / git_log, moved
 * VERBATIM from tools/index.ts buildProjectTools.
 */
import { jsonSchema } from "ai";
import { gitDiff, gitLog, gitStatus } from "../git.js";
import type { PluginDefinition, ToolDefinition } from "../registry.js";

export const gitPlugin: PluginDefinition = {
  id: "core-git",
  name: "Git",
  version: "1.0.0",
  description: "Read-only git inspection (status/diff/log) inside the project root.",
  category: "git",
  createTools: (ctx): ToolDefinition[] => {
    const root = ctx.root;
    return [
      {
        name: "git_status",
        description:
          "Show the current git repository status: branch, staged/unstaged files, ahead/behind. Use before making changes to understand the state.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {},
          required: [],
        }),
        execute: async () => gitStatus(root),
      },
      {
        name: "git_diff",
        description: "Show git diff of the working directory (optionally for a specific file). Use to review pending changes.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            file: { type: "string", description: "Optional file path to diff (empty = all changes)" },
          },
          required: [],
        }),
        execute: async (input) =>
          gitDiff(root, typeof input.file === "string" && input.file.trim() !== "" ? input.file : undefined),
      },
      {
        name: "git_log",
        description: "Show the last 20 git commits (oneline + branch decorations). Use to understand recent history.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {},
          required: [],
        }),
        execute: async () => gitLog(root),
      },
    ];
  },
};
