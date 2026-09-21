/**
 * ROUND-52 (R52-f): the MEMORY plugin — memory_save / memory_recall /
 * memory_list, moved VERBATIM from tools/index.ts buildProjectTools. The
 * master switch (toolDeps.memoryEnabled === false → no tools) is applied by
 * the plugin itself — same semantics as the old inline deletes.
 *
 * ROUND-117 (R117-b): + session_recall (the episodic search over this
 * project's PAST SESSIONS), and the per-agent MEMORY POLICY becomes real:
 * an agent whose memory_policy is 'none' gets NO memory tools at all — the
 * honest tool-drop, exactly like the master switch (a 'none' agent cannot
 * save, recall, list, or dig through past sessions; the digest injection is
 * gated in runtime.ts prepareTurn under the same policy).
 */
import { jsonSchema } from "ai";
import { memoryListTool, memoryRecallTool, memorySaveTool, sessionRecallTool } from "../memory.js";
import type { PluginDefinition, ToolDefinition } from "../registry.js";

export const memoryPlugin: PluginDefinition = {
  id: "core-memory",
  name: "Project Memory",
  version: "1.1.0",
  description: "Per-project persistent knowledge (facts/decisions/preferences) + episodic past-session search.",
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
    // ROUND-117 (R117-b): the agent's memory_policy — 'none' drops the whole
    // memory family (tools AND digest; the digest gate is runtime.ts's twin
    // check on agent.memoryPolicy). Undefined (older call sites, tests) =
    // keep the tools — the policy only ever NARROWS.
    if (toolDeps?.memoryPolicy === "none") return [];
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
      // ROUND-117 (R117-b): the EPISODIC leg — the model-facing search over
      // this project's PAST SESSIONS (titles + transcript text). Past work
      // was UI-only before; now "what did we do about X" is answerable.
      {
        name: "session_recall",
        description:
          "Search this project's PAST sessions (titles + transcript text) for prior work on a topic — episodic memory beyond saved memories. Returns session id, title, last activity, and a short snippet. Use it before re-researching anything this project may have already done.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Topic, file name, or error text to find in past sessions",
            },
            limit: {
              type: "number",
              description: "Max sessions to return (default 5, cap 10)",
            },
          },
          required: ["query"],
        }),
        execute: async (input) => sessionRecallTool(toolDeps, input.query, input.limit),
      },
    ];
  },
};
