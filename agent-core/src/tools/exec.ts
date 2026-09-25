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
 *     model ever saw them. ROUND-71 (R71-e2, D1): the marker gained a real
 *     recovery path for the omitted middle — redirect to a file + read_file
 *     in slices (kilocode's spill-to-file pattern);
 *   - a successful command that prints NOTHING resolves with an explicit
 *     "ran successfully and printed nothing" note (no silent empty output).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
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

/** Parse the stdout/append redirection targets (`> file` / `>> file`) so
 * job_status can tail what a redirected background process prints.
 * `2>&1`-style duplicates are ignored (they don't name a file).
 *
 * ROUND-128 (R128-W7b, FIX 6): the null device is NEVER a log — `>nul`,
 * `>NUL`, `>/dev/null` are discarded, and when MULTIPLE redirects exist the
 * LAST REAL one wins (the ledger complaint: a job advertised log 'nul'
 * while the command actually redirected to `TEST-1\job.log` — the shape
 * was `… > job.log 2>&1 >nul`, and the FIRST-match parse picked 'nul').
 * All-null (`>nul 2>&1`) → null: no log is advertised at all. */
export function parseLogRedirect(command: string): string | null {
  const redirectRe = /(?:^|\s)(?:>>|>)\s*("[^"]+"|'[^']+'|[^\s>&|]+)/g;
  const realTargets: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = redirectRe.exec(command)) !== null) {
    const raw = match[1].replace(/^["']|["']$/g, "");
    if (raw === "" || raw === "&") continue;
    // R128-W7b: the null device is a SINK, not a log (case-insensitive —
    // Windows' NUL is usually spelled lowercase in scripts).
    if (raw.toLowerCase() === "nul" || raw.toLowerCase() === "/dev/null") continue;
    realTargets.push(raw);
  }
  return realTargets.length > 0 ? realTargets[realTargets.length - 1] : null;
}

/** ROUND-128 (R128-W7b, FIX 2): search tools whose "no matches" exit code
 * is 1, not an error — findstr/find/grep/rg all use exit 1 for "nothing
 * matched", and the old finish path reported that as FAILED: "(no output)",
 * teaching the model its probe had ERRORED (the ledger's findstr case). */
const SEARCH_TOOLS_EXITING_ONE = new Set([
  "findstr", "findstr.exe", "grep", "egrep", "fgrep", "rg", "ripgrep",
  "find", "find.exe",
]);

/** R128-W7b (FIX 2): the command's first whitespace token (trimmed,
 * case-insensitive, quotes stripped) — the tool name a shell would exec. */
function firstCommandToken(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  return first.replace(/^["']|["']$/g, "").toLowerCase();
}

/** R128-W7b (FIX 10): does the command suppress stderr into the Windows
 * null device? (`2>nul`, `2 > nul` — cmd's spelling; the ledger's agent
 * appended it and lost the actual error text.) */
function suppressesStderrToNull(command: string): boolean {
  return /2\s*>\s*nul/i.test(command);
}

/* ── ROUND-128 (R128-W7b, FIX 4): win32 `node -e "<script>"` auto-tempfile ──
 * The ledger's complaint: "Multiple inline `node -e` commands via
 * run_command were visibly mangled by Windows/cmd quoting and escaping; the
 * assistant explicitly noted 'cmd mangled the quoting.'" With shell:true a
 * `node -e "script with ' \" ^ % < > & |"` payload round-trips through
 * cmd.exe's quote collapsing — the script node RECEIVES is not the script
 * the model wrote. The fix: when the command is exactly a quoted
 * `node -e "script"` (the script is the tail of the command) whose body
 * contains shell-hostile characters, write the body to a temp file and
 * spawn `node "<tempfile>"` instead. The rewrite is SILENT to the model
 * (same output, same exit code) and the temp file is ALWAYS deleted in the
 * finish path — success, failure, timeout, background — so nothing leaks.
 * POSIX is untouched (sh passes the payload through verbatim). */

/** The mangle-risk characters: quotes beyond the wrapping pair plus the
 * cmd metacharacters that re-interpret inside a quoted script. */
const EVAL_MANGLE_CHARS = /["'^%<>&|]/;

/** The detection shape: `node`/`node.exe` + `-e`/`--eval` + a quoted script. */
const NODE_EVAL_SHAPE = /(?:^|\s)(?:"?node(?:\.exe)?"?)\s+(?:--eval\s+|-e\s+)(["'])/i;

/** One planned rewrite: the spawned command + the temp file to create (the
 * caller writes `script` to `path`, spawns `command`, deletes `path` in its
 * finish path). */
export interface EvalTempPlan {
  command: string;
  path: string;
  script: string;
}

/** R128-W7b (FIX 4) + the R128 CI fix: plan the win32 auto-tempfile rewrite
 * for a complex inline `node -e "<script>"` payload. Returns null when the
 * shape does not apply (not win32, not a node -e form, the script has no
 * mangle-risk characters, the script is followed by ANYTHING — trailing
 * arguments or a compound continuation (`&& other-cmd` — the FIRST CI-red
 * taught that a `lastIndexOf`-script-end swallows the whole chain into the
 * temp file and breaks it) — or the command is a background launch: a
 * detached grandchild must not race the temp-file deletion). PURE: no
 * filesystem access, so tests can pin the rewrite directly. */
export function planWindowsEvalTempFile(command: string, opts?: { background?: boolean }): EvalTempPlan | null {
  if (process.platform !== "win32") return null;
  if (opts?.background === true) return null;
  const trimmed = command.trim();
  const shape = NODE_EVAL_SHAPE.exec(trimmed);
  if (shape === null) return null;
  const quote = shape[1];
  const scriptStart = shape.index + shape[0].length;
  // The script runs to the FIRST UNESCAPED occurrence of the wrapping quote
  // — backslash-escaped same-quotes (`\"`) are part of the script body
  // (exactly what cmd mangles), an unescaped one TERMINATES it. A
  // lastIndexOf here would swallow `... && node -e "second"` chains whole.
  let scriptEnd = -1;
  for (let i = scriptStart; i < trimmed.length; i += 1) {
    if (trimmed[i] !== quote) continue;
    let backslashes = 0;
    for (let j = i - 1; j >= scriptStart && trimmed[j] === "\\"; j -= 1) backslashes += 1;
    if (backslashes % 2 === 0) {
      scriptEnd = i;
      break;
    }
  }
  if (scriptEnd < scriptStart) return null;
  const rawScript = trimmed.slice(scriptStart, scriptEnd);
  if (rawScript.trim() === "") return null;
  if (!EVAL_MANGLE_CHARS.test(rawScript)) return null;
  // The script must BE the whole command's tail: trailing arguments cannot
  // be safely reconstructed, and a compound continuation (`&& …`) means the
  // chain must run verbatim (a partial rewrite would still mangle the other
  // segments — the conservative pre-R128 behavior for chains).
  const trailing = trimmed.slice(scriptEnd + 1).trim();
  if (trailing !== "") return null;
  // The temp file must carry the script as node would have RECEIVED it via
  // argv (CommandLineToArgvW), not as it sits inside the command string:
  // inside a double-quoted arg, `\"` is a literal quote and `\\` collapses
  // accordingly — writing the raw slice would be a syntax error for exactly
  // the escaped-quote payloads this rewrite exists to rescue.
  const script = quote === '"' ? unescapeCmdQuotedBody(rawScript) : rawScript;
  // `node -e` scripts are CommonJS by default — a `.js` temp file keeps
  // EXACTLY those semantics for the ledger's `require(...)`-shaped scripts.
  // ESM-shaped bodies (import/export statements) get `.mjs` — `node -e`
  // auto-detects those on modern Node, and a plain `.js` file would not.
  const looksEsm = /(^|\n)\s*(import|export)\s/.test(script);
  const path = `${tmpdir()}${tmpdir().endsWith("/") || tmpdir().endsWith("\\") ? "" : "/"}acute-eval-${randomUUID().slice(0, 8)}.${looksEsm ? "mjs" : "js"}`;
  return { command: `node "${path}"`, path, script };
}

/** Unescape the body of a cmd.exe double-quoted argument per
 * CommandLineToArgvW: an ODD run of backslashes before a `"` means the quote
 * is literal (the run collapses to half its length + the quote); backslashes
 * not followed by a quote stand verbatim. (Inside the extracted body every
 * `"` is escaped by construction — the scanner already stopped at the first
 * unescaped one.) */
function unescapeCmdQuotedBody(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; ) {
    if (body[i] !== "\\") {
      out += body[i];
      i += 1;
      continue;
    }
    let run = 0;
    while (body[i + run] === "\\") run += 1;
    const next = body[i + run];
    if (next === '"' && run % 2 === 1) {
      out += "\\".repeat((run - 1) / 2) + '"';
      i += run + 1;
    } else {
      out += "\\".repeat(run);
      i += run;
    }
  }
  return out;
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

  // R128-W7b (FIX 4): on win32 a complex inline `node -e "<script>"` is
  // rewritten to `node "<tempfile>"` — cmd.exe cannot round-trip the quoted
  // payload ("cmd mangled the quoting", the ledger's repeated failure). The
  // rewrite happens AFTER the approval gate (the model's command is what was
  // approved — the temp file is an execution detail, silent to the model) and
  // NEVER for background launches (a detached grandchild would race the
  // finish-path deletion of the temp file). A failed write falls back to the
  // original command verbatim.
  let evalTemp: EvalTempPlan | null = planWindowsEvalTempFile(trimmed, { background: isBackgroundLaunch });
  if (evalTemp !== null) {
    try {
      writeFileSync(evalTemp.path, evalTemp.script, "utf8");
    } catch {
      evalTemp = null;
    }
  }
  const spawnCommand = evalTemp !== null ? evalTemp.command : trimmed;

  return new Promise((resolve) => {
    const child: ChildProcess = spawn(spawnCommand, {
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
      // ROUND-71 (R71-e2, D1): byte semantics kept, plus the recovery path
      // for the omitted middle — the marker now teaches it (the tail is
      // already included; to see the middle, re-run with output redirected
      // to a file and read_file it in slices — a real, cheap recovery).
      return (
        `${head}\n…[output truncated: ${omitted} bytes omitted from the middle — the first 32KB and the last 32KB are kept ` +
        `— the tail is included; if the failure you need is in the omitted middle, re-run with output redirected to a file ` +
        `and read_file it in slices]…\n${tail}`
      );
    };

    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      if (outputTimer !== null) clearInterval(outputTimer);
      flushOutput();
      // R128-W7b (FIX 4): the eval temp file ALWAYS goes away — success,
      // failure, timeout, background — the rewrite is leak-free by
      // construction (finish is the single settle point).
      if (evalTemp !== null) {
        try {
          unlinkSync(evalTemp.path);
        } catch {
          /* already gone — nothing to leak */
        }
      }
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
        // R128-W7b (FIX 2): a SEARCH tool that exits 1 with NO output is
        // "no matches", not a failure — findstr/grep/rg exit 1 when nothing
        // matched, and the old FAILED: "(no output)" taught the model its
        // probe had errored (the ledger's findstr case).
        const isNoMatches =
          exitCode === 1 &&
          clip(combined) === "" &&
          SEARCH_TOOLS_EXITING_ONE.has(firstCommandToken(trimmed));
        if (isNoMatches) {
          finish({
            ok: true,
            output: `(no matches — ${firstCommandToken(trimmed)} exits 1 when nothing matches)`,
          });
          return;
        }
        const output =
          clip(combined) ||
          (exitCode === 0
            ? "(no output — the command ran successfully and printed nothing)"
            : "(no output)");
        const exitLine = exitCode === 0 ? "" : `\n[exit code: ${exitCode}]`;
        // R128-W7b (FIX 10): a FAILED command that suppressed its stderr into
        // the Windows null device gets the one-line nudge — the ledger's agent
        // appended 2>nul and lost the diagnostic it needed. Success stays
        // silent (the suppression was harmless then).
        const stderrNote =
          exitCode !== 0 && suppressesStderrToNull(trimmed)
            ? `\n[note: the command suppressed stderr with 2>nul — remove it to see the actual error]`
            : "";
        finish({ ok: exitCode === 0, output: output + exitLine + stderrNote });
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
