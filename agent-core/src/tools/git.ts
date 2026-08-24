/**
 * Git tools (round-24): status, diff, log — the read-only trio that lets
 * the agent understand the repository state. Commit arrives with the
 * approval round-trip. All tools run inside the project root.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "./index.js";

const MAX_OUTPUT = 32 * 1024;
const GIT_TIMEOUT = 15_000;

function git(root: string, args: string[]): Promise<ToolResult> {
  return new Promise((resolve) => {
    if (!existsSync(join(root, ".git"))) {
      resolve({ ok: false, output: "not a git repository (no .git directory)" });
      return;
    }
    execFile("git", args, {
      cwd: root,
      timeout: GIT_TIMEOUT,
      maxBuffer: MAX_OUTPUT,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (error && !stdout) {
        resolve({ ok: false, output: `git ${args[0]} failed: ${stderr || error.message}`.slice(0, MAX_OUTPUT) });
        return;
      }
      const output = stdout || stderr || "(empty)";
      resolve({ ok: true, output: output.length > MAX_OUTPUT ? output.slice(0, MAX_OUTPUT) + "\n…[truncated]" : output });
    });
  });
}

export function gitStatus(root: string): Promise<ToolResult> {
  return git(root, ["status", "--porcelain=v1", "--branch"]);
}

export function gitDiff(root: string, file?: string): Promise<ToolResult> {
  const args = ["diff", "--no-color", "--no-ext-diff"];
  if (file) args.push("--", file);
  return git(root, args);
}

export function gitLog(root: string): Promise<ToolResult> {
  return git(root, ["log", "--oneline", "--decorate", "-n", "20"]);
}
