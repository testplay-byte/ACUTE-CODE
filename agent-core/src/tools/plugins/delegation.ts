/**
 * ROUND-52 (R52-f): the DELEGATION plugin — delegate_task, moved VERBATIM
 * from tools/index.ts buildProjectTools. The registration gate (needs
 * toolDeps.keyring + toolDeps.chat; the allowlist filter is applied by the
 * assembler) is the plugin's own decision now — same semantics as the old
 * inline `delegateAllowed && toolDeps && keyring && chat` check.
 */
import { jsonSchema } from "ai";
import { SUB_ROLES, type SubRole, getOrchestrator } from "../../agents/orchestrator.js";
import type { PluginDefinition, ToolDefinition } from "../registry.js";

export const delegationPlugin: PluginDefinition = {
  id: "core-delegation",
  name: "Sub-agent Delegation",
  version: "1.0.0",
  description: "delegate_task — parallel self-contained sub-agent runs (ADR-0022).",
  category: "delegation",
  createTools: (ctx): ToolDefinition[] => {
    const toolDeps = ctx.toolDeps;
    // ROUND-36 (ADR-0022): the parent delegates self-contained subtasks;
    // children run their own sessions concurrently (per-key + total limits)
    // and report back. ROUND-49 (owner directive: sub-agents are "exactly
    // like how the main agent works — the only difference is the separate
    // context and API keys"): children MAY delegate too (nested sub-agents) —
    // the runtime strips delegate_task only at/beyond MAX_DELEGATION_DEPTH;
    // prepareTurn owns that decision through the allowlist it passes.
    if (toolDeps === undefined || toolDeps.keyring === undefined || toolDeps.chat === undefined) {
      return [];
    }
    const keyring = toolDeps.keyring;
    const chat = toolDeps.chat;
    return [
      {
        name: "delegate_task",
        description:
          "Delegate a self-contained subtask to an independent sub-agent that runs with the same project tools and reports back. Make MULTIPLE delegate_task calls in ONE message to run sub-agents in PARALLEL. Each call waits for its sub-agent to finish and returns its final report. Use for parallelizable work: researching several areas at once, reviewing multiple modules, independent implementation tasks. role: planner|researcher|coder|reviewer|tester (default researcher).",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            task: {
              type: "string",
              description: "The complete, self-contained task for the sub-agent (include ALL context it needs — it cannot see this conversation).",
            },
            role: {
              type: "string",
              description: "planner | researcher | coder | reviewer | tester (default researcher)",
              enum: ["planner", "researcher", "coder", "reviewer", "tester"],
            },
          },
          required: ["task"],
        }),
        execute: async (input) => {
          const task = typeof input.task === "string" ? input.task.trim() : "";
          if (task === "") return { ok: false, output: "task must be a non-empty string" };
          const role: SubRole =
            typeof input.role === "string" && (SUB_ROLES as readonly string[]).includes(input.role)
              ? (input.role as SubRole)
              : "researcher";
          const orchestrator = getOrchestrator();
          const result = await orchestrator.delegateTask(
            {
              db: toolDeps.db,
              keyring,
              chat,
              // ROUND-50 (R50-b): forward the streaming adapter — a streamed
              // parent turn spawns STREAMED children (live raw deltas to the
              // sub-agent panel); sync parents keep the sync fallback.
              ...(toolDeps.chatStream !== undefined ? { chatStream: toolDeps.chatStream } : {}),
            },
            toolDeps.sessionId,
            task,
            role,
            toolDeps.emit,
            // ROUND-48 (R48-e1): forward the live parent turn's abort signal so
            // the child stops between iterations + its approvals deny on abort.
            toolDeps.signal,
          );
          return { ok: result.ok, output: result.output };
        },
      },
    ];
  },
};
