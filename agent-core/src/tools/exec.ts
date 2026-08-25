/**
 * Terminal command execution — ROUND-37 rewrite: the static safe-prefix gate
 * is RETIRED. Every command passes through the approvals engine
 * (agent-core/src/approvals.ts), the single source of truth:
 *   blocked → never runs · auto (read-only/build/test) → runs ·
 *   project "always allow" rule → runs · everything else → ASKS the owner
 *   (highlighted ApprovalCard; Allow once / Always allow / Deny) and WAITS.
 * Sync turns + sub-agent children are non-interactive: a non-safe command
 * fails fast with a clear note instead of burning the 120s timeout.
 */
import { spawn } from "node:child_process";
import type { ToolResult } from "./index.js";
import { decideCommand, requestCommandApproval, type ApprovalRequestDeps } from "../approvals.js";

const COMMAND_TIMEOUT = 60_000;
const MAX_OUTPUT = 64 * 1024;

export function isSafeCommand(command: string): boolean {
  // Kept for back-compat with older tests: mirrors the engine's AUTO tier
  // (rule hits aren't knowable without a db).
  return decideCommand(undefined, undefined, command).action === "run";
}

export async function runCommand(
  root: string,
  command: string,
  approvalDeps?: ApprovalRequestDeps,
): Promise<ToolResult> {
  const trimmed = command.trim();
  if (trimmed === "") {
    return { ok: false, output: "run_command needs a non-empty 'command'" };
  }

  if (approvalDeps !== undefined) {
    const gate = await requestCommandApproval(approvalDeps, trimmed);
    if (!gate.allowed) {
      return { ok: false, output: `command not approved: ${gate.note}` };
    }
  }

  return new Promise((resolve) => {
    const child = spawn(trimmed, {
      cwd: root,
      shell: true,
      timeout: COMMAND_TIMEOUT,
      env: { ...process.env, FORCE_COLOR: "0", CI: "1" },
    });

    let combined = "";

    child.stdout?.on("data", (d: Buffer) => { combined += d.toString("utf8"); });
    child.stderr?.on("data", (d: Buffer) => { combined += d.toString("utf8"); });

    child.on("error", (err) => {
      resolve({ ok: false, output: `failed to start: ${err.message}` });
    });

    child.on("close", (code) => {
      const output = combined.trim();
      const truncated = output.length > MAX_OUTPUT
        ? output.slice(0, MAX_OUTPUT) + "\n…[truncated]"
        : output || "(no output)";
      const exitLine = code === 0 ? "" : `\n[exit code: ${code}]`;
      resolve({ ok: code === 0, output: truncated + exitLine });
    });
  });
}
