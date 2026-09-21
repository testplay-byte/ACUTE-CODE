/**
 * ROUND-52 (R52-f): the DELEGATION plugin — delegate_task, moved VERBATIM
 * from tools/index.ts buildProjectTools. The registration gate (needs
 * toolDeps.keyring + toolDeps.chat; the allowlist filter is applied by the
 * assembler) is the plugin's own decision now — same semantics as the old
 * inline `delegateAllowed && toolDeps && keyring && chat` check.
 *
 * ROUND-79 (R79-a, the orchestrator round): the tool gained the ADDRESSABLE
 * surface — task_id (the parent model's own address for a delegation),
 * background (fire-and-forget, REQUIRES task_id), and resume (the COLLECT
 * path: wait + collect / retry). The default (task, no background) stays
 * the BLOCKING behavior verbatim. Dispatch lives in execute; EVERY
 * validation failure returns {ok:false, output} honestly — this tool never
 * throws.
 *
 * ROUND-117 (R117-d): the GUIDANCE mode — delegate_task {task_id, guidance}
 * injects a mid-task course correction into a RUNNING child's queue (the
 * orchestrator's sendGuidance; the same internal path the queue route
 * rides). Rejected unless the addressed task is running.
 */
import { jsonSchema } from "ai";
// ROUND-84 (R84, Wave 2-c — the 25-file SCC break): the delegation plugin
// NO LONGER statically imports agents/orchestrator.js. The old edge
// (delegation → orchestrator → runtime → tools/index → registry →
// delegation) was ESM-legal but left NO layer boundary between the tool
// layer and the orchestration layer (the R80.5 audit's root-cause find).
// The vocabulary arrives from the agents/sub-roles.ts LEAF; the
// ORCHESTRATOR arrives via the ToolDeps seam below (type-only — erased at
// runtime) with a lazy dynamic-import fallback, so the STATIC import
// graph is a clean DAG: tools → (leaf) sub-roles; orchestrator → runtime
// → tools — one direction, never back.
import { SUB_ROLES, type SubRole } from "../../agents/sub-roles.js";
import type { PluginDefinition, ToolDefinition } from "../registry.js";

export const delegationPlugin: PluginDefinition = {
  id: "core-delegation",
  name: "Sub-agent Delegation",
  version: "1.2.0",
  description: "delegate_task — parallel self-contained sub-agent runs (ADR-0022); R79: addressable, background, resumable; R117-d: mid-task guidance.",
  category: "delegation",
  createTools: (ctx): ToolDefinition[] => {
    const toolDeps = ctx.toolDeps;
    // ROUND-36 (ADR-0022): the parent delegates self-contained subtasks;
    // children run their own sessions concurrently (per-key + total limits)
    // and report back. ROUND-49 (owner directive: sub-agents are "exactly
    // like how the main agent works — the only difference is the separate
    // context and API keys"): children MAY delegate too (nested sub-agents)
    // — the runtime strips delegate_task only at/beyond MAX_DELEGATION_DEPTH;
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
          "Delegate a self-contained subtask to an independent sub-agent with the same project tools. DEFAULT (task only): BLOCKING — the call waits and returns the sub-agent's final report; multiple delegate_task calls in ONE message run in PARALLEL. task_id: your own address for the delegation (1-64 chars: starts alphanumeric, then A-Za-z0-9._-; unique per session) — needed to resume later. background:true (REQUIRES task_id): fire-and-forget — the call returns IMMEDIATELY with a receipt, the task runs detached, the owner watches its progress in the Sub-agents panel, and its status rides your NEXT turn's system prompt. resume: COLLECT a delegated task by its task_id (or session id or 4-char code) — completed returns the final report; failed retries it from where it stopped. NEVER sleep-poll a background task: delegate_task {\"resume\":\"<task_id>\"} IS the wait (resume blocks until the task is terminal). guidance: send a mid-task course correction to a RUNNING task (delegate_task {task_id, guidance}) — the text lands in its queue and reaches it at its next step boundary; refused unless the task is running. A misbehaving background task is stopped by the owner from the Sub-agents panel. role: planner|researcher|coder|reviewer|tester (default researcher).",
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
            task_id: {
              type: "string",
              description: "Your own address for this delegation: 1-64 chars, starts alphanumeric, then A-Za-z0-9._- . REQUIRED with background:true; must be unique among this session's delegations; resume accepts it.",
            },
            background: {
              type: "boolean",
              description: "true = fire-and-forget: the call returns immediately with a receipt and the task runs detached (requires task_id; the report is collected later with resume). Default false = blocking (the call waits and returns the report).",
            },
            resume: {
              type: "string",
              description: "COLLECT a delegated task: its task_id, child session id, or 4-char code. Waits while it runs, returns the final report on completion, retries it from where it stopped on failure. task/role are ignored on this path.",
            },
            guidance: {
              type: "string",
              description: "Send a mid-task course correction to a RUNNING task, addressed by task_id (also accepts the child session id or 4-char code): the text is queued as the child's next user message and reaches it at its next step boundary — no interruption, its current tool call finishes first. Write it as a direct instruction with the context it needs (it cannot see this conversation). Refused unless the task is running; pair with background:true for a steer-able long task.",
            },
          },
        }),
        execute: async (input) => {
          // ROUND-79 (R79-a): validation failures return {ok:false, output}
          // — this tool NEVER throws (a broken tool call must not fail the
          // parent's whole turn). The top-level catch is the belt.
          try {
            const task = typeof input.task === "string" ? input.task.trim() : "";
            const role: SubRole =
              typeof input.role === "string" && (SUB_ROLES as readonly string[]).includes(input.role)
                ? (input.role as SubRole)
                : "researcher";
            const taskId = typeof input.task_id === "string" ? input.task_id.trim() : "";
            const background = input.background === true;
            const resume = typeof input.resume === "string" ? input.resume.trim() : "";
            const guidance = typeof input.guidance === "string" ? input.guidance.trim() : "";
            const orchestrator =
              // ROUND-84 (R84, Wave 2-c): the ToolDeps seam first (the
              // audit's preferred injection — same pattern as chat/
              // chatStream), then the lazy singleton fallback. The dynamic
              // import is deferred to EXECUTION time: every module is
              // loaded by then, the module cache makes repeat calls free,
              // and no static tools→orchestrator edge exists.
              toolDeps.orchestrator ??
              (await import("../../agents/orchestrator.js")).getOrchestrator();
            const deps = {
              db: toolDeps.db,
              keyring,
              chat,
              // ROUND-50 (R50-b): forward the streaming adapter — a streamed
              // parent turn spawns STREAMED children (live raw deltas to the
              // sub-agent panel); sync parents keep the sync fallback.
              ...(toolDeps.chatStream !== undefined ? { chatStream: toolDeps.chatStream } : {}),
              // R93-B4: the parent turn's effective model pair — the
              // orchestrator falls NULL-agent-row children back onto it
              // (subagentModel ?? agent row ?? THIS).
              ...(toolDeps.mainModel !== undefined ? { mainModel: toolDeps.mainModel } : {}),
            };
            // ── The COLLECT path: resume present → task/role are ignored. ──
            if (resume !== "") {
              const result = await orchestrator.resumeTask(
                deps,
                toolDeps.sessionId,
                resume,
                // The wait honors the live parent turn's abort signal (the
                // honest "still running" line when the owner stops the turn).
                toolDeps.emit,
                toolDeps.signal,
              );
              return { ok: result.ok, output: result.output };
            }
            // ── The GUIDANCE path (R117-d): guidance present → a mid-task
            // course correction for a RUNNING child, addressed by task_id
            // (the orchestrator also resolves session ids + codes). ──
            if (guidance !== "") {
              if (taskId === "") {
                return {
                  ok: false,
                  output:
                    "guidance requires task_id (the child session id or 4-char code also resolve) — delegate_task {\"task_id\":\"…\",\"guidance\":\"…\"} steers a RUNNING task. " +
                    "For a task that is not running yet, wait for it (resume) or include the direction in the original task text.",
                };
              }
              const result = await orchestrator.sendGuidance(
                deps,
                toolDeps.sessionId,
                taskId,
                guidance,
              );
              return { ok: result.ok, output: result.output };
            }
            // ── The DELEGATE path: task present. ──────────────────────────
            if (task !== "") {
              if (background) {
                // background REQUIRES task_id (the receipt + later resume
                // both address the task by it — the honest refusal when it
                // is missing).
                if (taskId === "") {
                  return {
                    ok: false,
                    output:
                      "background:true requires task_id — the immediate receipt and the later resume (delegate_task {\"resume\":\"<task_id>\"}) both address the task by it. " +
                      "task_id is 1-64 chars (starts alphanumeric, then A-Za-z0-9._-), unique among this session's delegations. " +
                      "Either provide task_id + background:true, or drop background to run the delegation blocking (it waits and returns the report).",
                  };
                }
                const result = await orchestrator.delegateBackground(
                  deps,
                  toolDeps.sessionId,
                  task,
                  role,
                  taskId,
                  toolDeps.emit,
                  // ROUND-79 (R79-a): forwarded so the owner's Stop on the
                  // parent turn still cascades to the detached child (the
                  // documented choice — no zombie spend after a stop).
                  toolDeps.signal,
                );
                return { ok: result.ok, output: result.output };
              }
              // The BLOCKING default (verbatim pre-R79 behavior + the
              // optional taskId: validated, duplicate-checked, and
              // delegation.collected-marked at completion by the
              // orchestrator — the report was delivered inline).
              const result = await orchestrator.delegateTask(
                deps,
                toolDeps.sessionId,
                task,
                role,
                toolDeps.emit,
                // ROUND-48 (R48-e1): forward the live parent turn's abort signal so
                // the child stops between iterations + its approvals deny on abort.
                toolDeps.signal,
                taskId !== "" ? taskId : undefined,
              );
              return { ok: result.ok, output: result.output };
            }
            // ── NEITHER: the honest addressable list (the cheap
            // affordance — what there IS to resume, with real addresses). ──
            return {
              ok: false,
              output: orchestrator.addressableChildrenOutput(
                toolDeps.db,
                toolDeps.sessionId,
                "delegate_task needs a task (delegate), a resume (collect a delegated task), a task + background for a fire-and-forget run, or a task_id + guidance to steer a running task — this call provided none of them.",
              ),
            };
          } catch (error) {
            return {
              ok: false,
              output: `delegate_task failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        },
      },
    ];
  },
};
