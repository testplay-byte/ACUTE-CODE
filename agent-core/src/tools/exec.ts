/**
 * Terminal command execution (round-24, v1: safe commands only — the
 * interactive approval round-trip arrives with the full engine).
 * Runs commands inside the project root with a timeout and output cap.
 */
import { spawn } from "node:child_process";
import type { ToolResult } from "./index.js";

const COMMAND_TIMEOUT = 60_000;
const MAX_OUTPUT = 64 * 1024;

/** Commands that are safe to auto-execute (read-only / build / test). */
const SAFE_PREFIXES = [
  "ls", "cat", "head", "tail", "wc", "find", "grep", "rg ", "which", "where",
  "node --version", "npm --version", "pnpm --version", "python --version", "python3 --version",
  "git status", "git diff", "git log", "git branch", "git show", "git tag", "git commit", "git add",
  "npm test", "npm install", "npm run", "pnpm add", "pnpm install", "yarn ", "pnpm test", "pnpm run", "pnpm lint", "pnpm typecheck", "pnpm verify",
  "npx tsc", "jest", "vitest ", "cargo check", "cargo test", "cargo build",
  "echo", "help", "pip ", "pip3 ", "go ", "go test", "go build", "pwd", "date", "env",
];

/** Commands that are always blocked (destructive, system-level, or network). */
const BLOCKED = [
  "rm -rf /", "sed -i", "mv ", "cp ", "chmod ", "pnpm dev", "npm start", "vite", "next dev", "sudo ", "su ", "shutdown", "reboot", "mkfs", "dd if=",
  "curl ", "wget ", "ssh ", "scp ", "nc ", "telnet ",
];

export function isSafeCommand(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  if (BLOCKED.some((b) => trimmed.startsWith(b))) return false;
  return SAFE_PREFIXES.some((p) => trimmed.startsWith(p));
}

export function runCommand(root: string, command: string): Promise<ToolResult> {
  const trimmed = command.trim();
  if (trimmed === "") {
    return Promise.resolve({ ok: false, output: "run_command needs a non-empty 'command'" });
  }
  if (!isSafeCommand(trimmed)) {
    return Promise.resolve({
      ok: false,
      output: `command not in the auto-approved list (interactive approvals arrive in a future update). Safe prefixes: ${SAFE_PREFIXES.slice(0, 8).join(", ")}…`,
    });
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
