/**
 * Terminal command execution — ROUND-37 rewrite: the static safe-prefix gate
 * is RETIRED. Every command passes through the approvals engine
 * (agent-core/src/approvals.ts), the single source of truth:
 *   blocked → never runs · auto (read-only/build/test) → runs ·
 *   project "always allow" rule → runs · everything else → ASKS the owner
 *   (highlighted ApprovalCard; Allow once / Always allow / Deny) and WAITS.
 * Sync turns + sub-agent children are non-interactive: a non-safe command
 *   fails fast with a clear note instead of burning the 120s timeout.
 *
 * ROUND-52 (R52-a) — the HANG FIX + background jobs. The owner's report:
 * `start /B node server.js > server.log 2>&1` showed "running…" for 10+
 * minutes. Node's `close` event (which the old code alone awaited) fires only
 * when the stdio PIPES close; a `start /B` grandchild INHERITS those pipe
 * handles and holds them for its whole lifetime, so `close` never fires and
 * the tool promise never resolved. The new contract:
 *
 *   1. `exit` and `close` are tracked SEPARATELY. When the shell EXITS but
 *      the pipes stay open past a grace period (2.5s; 1s for commands that
 *      visibly launch background processes — `start`, `nohup`, trailing `&`),
 *      the command is treated as a BACKGROUND LAUNCH: a job is registered in
 *      lib/background-jobs.ts (which keeps tailing the orphaned pipe + the
 *      parsed `> logFile`), and the tool call RESOLVES immediately with the
 *      exit code, the captured output, and exact polling instructions
 *      (job_status / job_stop) — the agent never blocks on a detached
 *      process again.
 *   2. HARD WATCHDOG: if the shell doesn't even EXIT within `timeoutMs`
 *      (default 60s), the process TREE is killed (taskkill /T /F on Windows)
 *      and the call resolves as a timeout with the partial output — the
 *      `close`-never-fires trap can no longer stall a turn, ever.
 *   3. LIVE OUTPUT (owner: "After running the commands, it should actually
 *      show the terminal interface of those commands too"): `options.onOutput`
 *      receives batched stdout+stderr chunks while the command runs, so the
 *      UI's working section / sub-agent panel can stream a terminal tail.
 *      Background jobs keep emitting (from the registry watcher's point of
 *      view the caller is gone — the tail lives in job_status instead).
 *
 * ROUND-70 (R70-a, SWE-agent ACI — "tool feedback quality ≈ model quality"):
 *   - the 64KB output cap now keeps BOTH ends (head 32KB + tail 32KB with an
 *     honest omitted-from-the-middle marker) — build/test errors live at the
 *     END of long logs, and the old HEAD-only clip threw them away before the
 *     model ever saw them;
 *   - a successful command that prints NOTHING resolves with an explicit
 *     "ran successfully and printed nothing" note (no silent empty output).
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { ToolResult } from "./index.js";
import { decideCommand, requestCommandApproval, type ApprovalRequestDeps } from "../approvals.js";
// ROUND-45 (audit P0-3): children never inherit the sidecar's secrets.
import { buildChildEnv } from "../lib/child-env.js";
// ROUND-52 (R52-a): the background-job registry.
import { registerJob, type BackgroundJobSnapshot } from "../lib/background-jobs.js";

export const COMMAND_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 64 * 1024;
/** ROUND-70 (R70-a): when output exceeds MAX_OUTPUT, keep the first
 * OUTPUT_HEAD chars + the last OUTPUT_TAIL chars and mark the omitted middle
 * honestly (total ≈ MAX_OUTPUT + one marker line). The tail matters most —
 * build/test errors live at the END of long logs. */
const OUTPUT_HEAD = 32 * 1024;
const OUTPUT_TAIL = 32 * 1024;
/** Grace after the shell exits before an open pipe is declared a background job. */
const PIPE_GRACE_MS = 2_500;
/** Shorter grace when the command text itself launches a background process. */
const BACKGROUND_LAUNCH_GRACE_MS = 1_000;
/** Live-output batching window (one frame per chunk window, not per byte). */
const OUTPUT_BATCH_MS = 400;

export function isSafeCommand(command: string): boolean {
  // Kept for back-compat with older tests: mirrors the engine's AUTO tier
  // (rule hits aren't knowable without a db).
  return decideCommand(undefined, undefined, command).action === "run";
}

/** Does the command text visibly launch a detached/background process?
 * (Windows `start` incl. `start /B`, unix `nohup`/`disown`, trailing `&`.) */
export function looksLikeBackgroundLaunch(command: string): boolean {
  const trimmed = command.trim();
  // Trailing `&` — but never `&&` (the lookbehind rejects the second & of a
  // `a && b` chain). Note: no `\b` before the `&` — "cmd &" has a SPACE
  // before the ampersand and a word boundary would never match there.
  if (/(?<!&)&\s*$/.test(trimmed)) return true;
  if (/(^|&&|\|\||;|\|)\s*start(\s+\/[a-zA-Z]+\s+|\s+)\S/i.test(trimmed)) return true;
  if (/(^|\s)nohup\s+\S/.test(trimmed) || /(^|\s)disown\b/.test(trimmed)) return true;
  return false;
}

/** Parse the first stdout/append redirection target (`> file` / `>> file`)
 * so job_status can tail what a redirected background process prints.
 * `2>&1`-style duplicates are ignored (they don't name a file). */
export function parseLogRedirect(command: string): string | null {
  const match = command.match(/(?:^|\s)(?:>>|>)\s*("[^"]+"|'[^']+'|[^\s>&|]+)/);
  if (match === null) return null;
  const raw = match[1].replace(/^["']|["']$/g, "");
  return raw === "" || raw === "&" ? null : raw;
}

export interface RunCommandOptions {
  /** Hard watchdog for the SHELL's exit (default 60s; the caller's approval
   * tier can shrink it — tests use small values). */
  timeoutMs?: number;
  /** Live terminal-output frames (batched ~400ms) while the command runs. */
  onOutput?: (chunk: string) => void;
  /** Project binding recorded on registered background jobs. */
  projectId?: string | null;
}

/** Windows: kill a whole process tree (the only reliable child-tree kill). */
function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        shell: true,
      });
    } else {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* best-effort */
  }
}

export async function runCommand(
  root: string,
  command: string,
  approvalDeps?: ApprovalRequestDeps,
  options?: RunCommandOptions,
): Promise<ToolResult> {
  const trimmed = command.trim();
  if (trimmed === "") {
    return { ok: false, output: "run_command needs a non-empty 'command'" };
  }

  if (approvalDeps !== undefined) {
    const gate = await requestCommandApproval(approvalDeps, trimmed, { root });
    if (!gate.allowed) {
      return { ok: false, output: `command not approved: ${gate.note}` };
    }
  }

  const timeoutMs = options?.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const isBackgroundLaunch = looksLikeBackgroundLaunch(trimmed);
  const graceMs = isBackgroundLaunch ? BACKGROUND_LAUNCH_GRACE_MS : PIPE_GRACE_MS;
  const logFile = parseLogRedirect(trimmed);

  return new Promise((resolve) => {
    const child: ChildProcess = spawn(trimmed, {
      cwd: root,
      shell: true,
      windowsHide: true,
      env: buildChildEnv(),
      // ROUND-52 follow-up (live battery): a background launch is spawned
      // DETACHED so on POSIX the shell becomes a PROCESS-GROUP LEADER and the
      // backgrounded grandchild stays in that group after the shell exits —
      // the registry can then probe the whole group's liveness synchronously
      // (kill(-pid, 0)) for the pipes-closed-fast Unix `&` case. On Windows
      // this is harmless (no group semantics — the pipe-held path governs).
      ...(isBackgroundLaunch ? { detached: true } : {}),
    });

    let combined = "";
    let settled = false;
    let exitCode: number | null = null;
    let shellExited = false;
    // ROUND-52 CI fix (windows): set when the watchdog initiates its tree-kill
    // — the kill often SUCCEEDS on Windows (taskkill /T /F takes down the
    // whole tree, the pipes close, and the normal-completion path wins the
    // race), and a watchdog-killed command must NEVER be reported as a plain
    // failed command: the close handler checks this flag and defers to the
    // watchdog's [timeout] resolution instead.
    let watchdogFired = false;
    // Live-output batching: buffer bytes, flush one frame per window.
    let outputBuffer = "";
    let outputTimer: ReturnType<typeof setInterval> | null = null;
    const flushOutput = (): void => {
      if (outputBuffer !== "" && options?.onOutput !== undefined) {
        options.onOutput(outputBuffer);
      }
      outputBuffer = "";
    };
    if (options?.onOutput !== undefined) {
      outputTimer = setInterval(flushOutput, OUTPUT_BATCH_MS);
    }

    const clip = (text: string): string => {
      const output = text.trim();
      if (output.length <= MAX_OUTPUT) return output;
      // ROUND-70 (R70-a): HEAD + TAIL, never head-only. The old
      // `slice(0, MAX_OUTPUT)` threw away the tail — where the actual error
      // summary of a long build/test log lives.
      const head = output.slice(0, OUTPUT_HEAD);
      const tail = output.slice(output.length - OUTPUT_TAIL);
      const omitted = output.length - head.length - tail.length;
      return (
        `${head}\n…[output truncated: ${omitted} bytes omitted from the middle — ` +
        `the first 32KB and the last 32KB are kept]…\n${tail}`
      );
    };

    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      if (outputTimer !== null) clearInterval(outputTimer);
      flushOutput();
      resolve(result);
    };

    const onData = (d: Buffer): void => {
      const text = d.toString("utf8");
      combined += text;
      outputBuffer += text;
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("error", (err) => {
      finish({ ok: false, output: `failed to start: ${err.message}` });
    });

    // The shell process itself exited (its stdio pipes may STILL be open —
    // held by an inherited grandchild).
    child.on("exit", (code) => {
      shellExited = true;
      exitCode = code;

      // Fast path: pipes already closed too (or closed within the grace) —
      // the normal synchronous-command outcome.
      const graceTimer = setTimeout(() => {
        if (settled) return;
        // Pipes still open past the grace = a detached grandchild holds them:
        // register a background job (the registry keeps tailing the pipe and
        // flips the job to exited when the grandchild dies) and resolve NOW.
        finishAsBackground("pipe-held");
      }, graceMs);

      child.once("close", () => {
        if (settled) {
          clearTimeout(graceTimer);
          return;
        }
        clearTimeout(graceTimer);
        // The watchdog's tree-kill closed the pipes — this is a TIMEOUT, not
        // a normal completion (the exit code of a force-killed shell is a
        // lie; the agent must see that WE killed it and why).
        if (watchdogFired) {
          finishTimeout();
          return;
        }
        // ROUND-52 follow-up (live battery): the Unix `cmd > log 2>&1 &`
        // shape — the grandchild redirected EVERYTHING to the log file, so
        // the pipes close the instant the shell exits and the grace timer
        // above never gets its turn. A clean-exiting background launch is
        // STILL a supervised job (the agent must be able to poll its log and
        // stop it) — register it in DETACHED mode (process-group liveness,
        // log-file tail) instead of the old silent "(no output)" result.
        // A NON-zero exit means the launch itself failed (e.g. cmd.exe does
        // not understand `&`) — report that as a normal failure instead.
        if (isBackgroundLaunch && exitCode === 0) {
          finishAsBackground("detached");
          return;
        }
        // Normal completion: pipes closed right after the shell exited.
        // ROUND-70 (R70-a): zero-output commands say so EXPLICITLY (SWE-agent
        // ACI — an empty/blank result is ambiguous: did it run? fail?).
        const output =
          clip(combined) ||
          (exitCode === 0
            ? "(no output — the command ran successfully and printed nothing)"
            : "(no output)");
        const exitLine = exitCode === 0 ? "" : `\n[exit code: ${exitCode}]`;
        finish({ ok: exitCode === 0, output: output + exitLine });
      });

      /** Register a background job + resolve with the supervision note.
       * "pipe-held": the grandchild holds the output pipes (Windows `start
       * /B` shape) — the registry tails the live pipe.
       * "detached": pipes already closed (Unix `&` + full redirect) —
       * liveness via the process group, output via the log-file tail. */
      const finishAsBackground = (kind: "pipe-held" | "detached"): void => {
        if (settled) return;
        const job: BackgroundJobSnapshot = registerJob(
          { command: trimmed, cwd: root, pid: child.pid ?? null, logFile, exitCode, projectId: options?.projectId ?? null },
          kind === "pipe-held" ? child : undefined,
          { detached: kind === "detached" },
        );
        const output = clip(combined) || "(no output captured before the shell exited)";
        const ok = exitCode === 0;
        const exitLine = exitCode === 0 ? "exited cleanly" : `[exit code: ${exitCode}]`;
        const logLine = job.logFile !== null ? `\n- Its output goes to '${job.logFile}' — read that file (read_file) or call job_status to tail it.` : "";
        const heldLine =
          kind === "pipe-held"
            ? "is STILL RUNNING in the background (it holds this command's output pipe)"
            : "was started DETACHED in the background (its own process group; output goes to its log file)";
        finish({
          ok,
          output:
            `${output}\n[background job ${job.id}] The launching shell ${exitLine}, but the started process ` +
            `${heldLine}.${logLine}\n` +
            `- Check what it's doing / its latest output: job_status {"job": "${job.id}"}\n` +
            `- Stop it: job_stop {"job": "${job.id}"}\n` +
            `Do NOT run this command again — it already started. Poll its status instead of waiting.`,
        });
      };
    });

    // HARD WATCHDOG: the shell itself never exited within timeoutMs (a hung
    // interactive/long command). Kill the tree and resolve with what we have
    // — never stall the agent turn on a silent command.
    /** The shared [timeout] resolution (the watchdog's own follow-up timer
     * AND the close-after-kill race both land here). */
    const finishTimeout = (): void => {
      if (settled) return;
      const output = clip(combined) || "(no output before the timeout)";
      finish({
        ok: false,
        output:
          `${output}\n[timeout] the command did not exit within ${timeoutMs}ms and was killed ` +
          `(process tree, pid ${child.pid ?? "?"}). If it launches something that must keep ` +
          `running, re-run it as a background launch (Windows: \`start /B <cmd> > <log> 2>&1\`) ` +
          `and poll it with job_status.`,
      });
    };
    const watchdog = setTimeout(() => {
      if (settled || shellExited) return;
      watchdogFired = true;
      if (child.pid !== undefined) killTree(child.pid);
      // Give the kill a moment to land, then resolve regardless of pipes.
      setTimeout(() => {
        if (settled) return;
        // After the tree-kill the shell may have exited but pipes remain
        // (grandchild) — the background-job path above handles liveness; here
        // we resolve as a TIMEOUT with the partial output so the turn moves.
        finishTimeout();
      }, 800);
    }, timeoutMs);
    // The watchdog is only meaningful pre-settle; clear it when the turn
    // finishes (close) or once the shell's exit path (the grace timer) owns
    // resolution. finish() is idempotent, so a late watchdog fire is a no-op —
    // the clears just stop the timer from ticking uselessly.
    child.once("close", () => clearTimeout(watchdog));
    child.once("exit", () => {
      setTimeout(() => clearTimeout(watchdog), graceMs + 100);
    });
  });
}
