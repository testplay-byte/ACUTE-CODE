/**
 * ROUND-132 (R132, Wave MA-core): the MINI AGENT plugin — the `mini_agent`
 * tool. The owner's directive: the main agent dispatches quick specialized
 * tasks to mini agent PARTNERS (browser use / computer use / file search /
 * custom specializations the main agent writes itself), up to 3 concurrent,
 * disposable one-task runs, the result + the current state returned as this
 * tool's result, the actions shown in a dedicated in-chat section (the
 * `mini-agent.*` frames the loop emits).
 *
 * The LOOP lives in agents/mini-agent.ts and arrives via a LAZY dynamic
 * import inside execute — the R84 DAG law (the delegation plugin's own
 * pattern): tools → leaf only in the static graph; agents/mini-agent →
 * tools/index → registry → THIS module is a legal one-direction chain as
 * long as the edge back to the loop is deferred to execution time.
 *
 * The registration gate: keyring + EITHER chat seam (the streamed adapter
 * OR the sync chat fn — the loop runs on both channels; the streamed one
 * frames live, the sync one lands the whole run in one call). A
 * bare/declaration build sees nothing (the delegation plugin's own gate
 * shape). NEVER THROWS: every validation failure returns {ok:false,
 * output} honestly.
 */
import { jsonSchema } from "ai";
import type { PluginDefinition, ToolDefinition } from "../registry.js";

export const miniAgentPlugin: PluginDefinition = {
  id: "core-mini-agent",
  name: "Mini Agents",
  version: "1.0.0",
  description:
    "mini_agent — quick specialized partner dispatches (R132): browser/computer/search/custom skills, ≤3 concurrent, disposable one-task runs returning outcome + current state.",
  category: "delegation",
  createTools: (ctx): ToolDefinition[] => {
    const toolDeps = ctx.toolDeps;
    if (
      toolDeps === undefined ||
      toolDeps.keyring === undefined ||
      (toolDeps.chatStream === undefined && toolDeps.chat === undefined)
    ) {
      return [];
    }
    return [
      {
        name: "mini_agent",
        description:
          "Dispatch ONE quick, specialized task to a mini agent — a small partner that lives inside this conversation (NOT a sub-agent session), runs its own short loop with the skill's full playbook pre-loaded, acts, and reports back the outcome + the current state. Skills: browser (drives the embedded browser panel — navigate, read pages, click, type, download), computer (drives the desktop via computer-use), search (finds files/code/projects on this machine — give it WHAT you are looking for and roughly WHY, it derives the keywords and strategy), custom (you define the specialty via instructions — the mini runs with your instructions plus the safe read-only tools). Give the GOAL in natural language with the why included — the mini decides the steps; include everything it needs (it cannot see this conversation and cannot ask follow-ups). Up to 3 minis run CONCURRENTLY: batch multiple mini_agent calls in one message. Each mini is disposable (one task, no resume) and bounded (~8 steps): do NOT use it for long-horizon work (delegate_task owns that) or for what one of your own tools does directly. The tool result IS the mini's report (OUTCOME / STATE / DETAILS).",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            skill: {
              type: "string",
              description:
                "The mini agent's specialization: browser | computer | search | custom.",
              enum: ["browser", "computer", "search", "custom"],
            },
            task: {
              type: "string",
              description:
                "The task in natural language — the GOAL plus the why and any constraints. The mini cannot see this conversation and cannot ask questions: include everything it needs (URLs, names, paths, criteria).",
            },
            instructions: {
              type: "string",
              description:
                "custom skill only: the specialty's instructions — what this mini is FOR and how it should work (its playbook). Required when skill is custom; ignored otherwise.",
            },
          },
        }),
        execute: async (input) => {
          try {
            const skill =
              typeof input.skill === "string" &&
              (["browser", "computer", "search", "custom"] as const).includes(
                input.skill as "browser" | "computer" | "search" | "custom",
              )
                ? (input.skill as "browser" | "computer" | "search" | "custom")
                : null;
            if (skill === null) {
              return {
                ok: false,
                output: `mini_agent skill must be browser, computer, search, or custom (got '${String(input.skill)}')`,
              };
            }
            const task = typeof input.task === "string" ? input.task.trim() : "";
            const instructions =
              typeof input.instructions === "string" ? input.instructions.trim() : undefined;
            // The loop arrives LAZILY (the DAG law — see the header).
            const { runMiniAgent } = await import("../../agents/mini-agent.js");
            const result = await runMiniAgent(toolDeps, {
              skill,
              ...(task !== "" ? { task } : { task: "" }),
              ...(instructions !== undefined && instructions !== ""
                ? { instructions }
                : {}),
            });
            return { ok: result.ok, output: result.output };
          } catch (error) {
            return {
              ok: false,
              output: `mini_agent failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        },
      },
    ];
  },
};
