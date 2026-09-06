/**
 * ROUND-52 (R52-f): the TERMINAL plugin — run_command + job_status +
 * job_stop, moved VERBATIM from tools/index.ts buildProjectTools (including
 * the ROUND-52 R52-a background-job supervision tools and live tool-output
 * emission).
 */
import { jsonSchema } from "ai";
import { runCommand } from "../exec.js";
import { getJobStatus, listJobs, stopJob } from "../../lib/background-jobs.js";
import { buildApprovalDeps } from "../approval-deps.js";
import type { PluginDefinition, ToolDefinition } from "../registry.js";

export const execPlugin: PluginDefinition = {
  id: "core-terminal",
  name: "Terminal & Background Jobs",
  version: "1.0.0",
  description:
    "Shell command execution inside the project root (approvals-gated) + background-job supervision (status/stop).",
  category: "terminal",
  createTools: (ctx): ToolDefinition[] => {
    const root = ctx.root;
    const toolDeps = ctx.toolDeps;
    return [
      {
        name: "run_command",
        description:
          "Run a terminal command inside the project root. Read-only and build/test commands run automatically (ls, cat, grep, git status/diff/log, npm/pnpm test/build/lint, cargo check/build) — but ONLY while every path they touch stays INSIDE the project root (anything under /, ~, .. or another drive asks first). Any other command also asks the owner for permission and waits for their decision — blocked commands (sudo, rm -rf, curl, dev servers) are refused outright. LONG-RUNNING/SERVER commands: launch them detached (Windows: `start /B <cmd> > <log> 2>&1`; Unix: `<cmd> > <log> 2>&1 &`) — the call returns immediately with a background-job id; then VERIFY the process actually started by polling job_status (or reading the log file) instead of waiting or re-running.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            command: { type: "string", description: "The shell command to execute" },
          },
          required: ["command"],
        }),
        execute: async (input) =>
          runCommand(
            root,
            typeof input.command === "string" ? input.command : "",
            toolDeps !== undefined ? buildApprovalDeps(toolDeps) : undefined,
            {
              // ROUND-52 (R52-a): background jobs bind to the project so the
              // UI's jobs view can scope them.
              projectId: toolDeps?.projectId ?? null,
              // ROUND-52 (R52-a): LIVE terminal output — batched chunks stream
              // to the UI while the command runs (the "terminal interface" of
              // the command the owner asked to see).
              ...(toolDeps?.emit !== undefined
                ? {
                    onOutput: (chunk: string) => {
                      toolDeps?.emit?.({
                        type: "tool-output",
                        sessionId: toolDeps.sessionId,
                        toolName: "run_command",
                        argsSummary: typeof input.command === "string" ? input.command : "",
                        chunk,
                      });
                    },
                  }
                : {}),
            },
          ),
      },
      // ── ROUND-52 (R52-a): BACKGROUND-JOB SUPERVISION ─────────────────────
      // The owner's round-52 case: `start /B node server.js > server.log 2>&1`
      // ran and the agent then waited forever without checking anything. Now
      // run_command resolves immediately for background launches (registry in
      // lib/background-jobs.ts) and THESE tools let the agent — and the main
      // agent supervising sub-agents — poll and stop what it started.
      {
        name: "job_status",
        description:
          "Check what a background command (started via run_command with `start /B` / `&` / nohup) is doing RIGHT NOW: alive or exited, how long it has run, its recent terminal output (tail), and the tail of its log file when output was redirected. With no arguments, lists every tracked background job with one-line status. ALWAYS call this after starting a server/long process to verify it actually started, and poll it (every ~30-60s) while a task depends on it — never assume, never re-run the launch command.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            job: {
              type: "string",
              description: "Background job id (e.g. 'j1a2b3c4'). Omit to list all jobs.",
            },
          },
          required: [],
        }),
        execute: async (input) => {
          const id = typeof input.job === "string" ? input.job.trim() : "";
          if (id !== "") {
            const status = getJobStatus(id);
            if (status === null) return { ok: false, output: `no background job '${id}' — call job_status without arguments to list tracked jobs` };
            const lines = [
              `job ${status.id}: ${status.alive ? "RUNNING" : "not running"} (status: ${status.status}${status.detached ? ", detached process group" : ""})`,
              `command: ${status.command}`,
              `age: ${Math.round(status.ageMs / 1000)}s` +
                (status.endedAt !== null ? `, ended ${new Date(status.endedAt).toISOString()}` : "") +
                (status.exitCode !== null ? `, launcher exit code ${status.exitCode}` : ""),
            ];
            if (status.logFile !== null) lines.push(`log file: ${status.logFile}`);
            const hasLiveOutput = status.outputTail.trim() !== "";
            const hasLogOutput = (status.logTail ?? "").trim() !== "";
            if (hasLiveOutput) {
              lines.push("recent output:");
              lines.push(status.outputTail.trim().split("\n").slice(-12).join("\n"));
            }
            if (hasLogOutput) {
              lines.push(`log tail (${status.logFile}):`);
              lines.push((status.logTail ?? "").trim().split("\n").slice(-12).join("\n"));
            }
            // ROUND-70 (R70-a, D4): no output AT ALL must say so explicitly —
            // including the previously-missed case of an EXISTING but empty
            // log file (logTail === "" — the old `=== null` check skipped the
            // note and the result showed neither output nor explanation).
            if (!hasLiveOutput && !hasLogOutput) {
              lines.push(
                "(no output captured yet — the process may still be starting, may write only to its log file, or may genuinely produce nothing)",
              );
            }
            if (!status.alive && status.status === "exited") {
              lines.push("The background process appears to have EXITED — check the output/log above for why (a crash, a port conflict, a missing dependency) before doing anything else.");
            }
            return { ok: true, output: lines.join("\n") };
          }
          const jobs = listJobs();
          if (jobs.length === 0) return { ok: true, output: "no background jobs tracked" };
          return {
            ok: true,
            output: jobs
              .map(
                (j) =>
                  `${j.id} ${j.alive ? "RUNNING" : "exited"} ${Math.round(j.ageMs / 1000)}s — ${j.command.slice(0, 100)}`,
              )
              .join("\n"),
          };
        },
      },
      {
        name: "job_stop",
        description:
          "Stop a background command this agent started (a job id from run_command's background note / job_status). Use it for cleanup — e.g. the task is done and the dev server should be shut down, or a started process is misbehaving. Only OUR tracked jobs can be stopped through this tool.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            job: { type: "string", description: "Background job id to stop (e.g. 'j1a2b3c4')" },
          },
          required: ["job"],
        }),
        execute: async (input) => {
          const id = typeof input.job === "string" ? input.job.trim() : "";
          if (id === "") return { ok: false, output: "job_stop needs a 'job' id" };
          const result = await stopJob(id);
          return result;
        },
      },
    ];
  },
};
