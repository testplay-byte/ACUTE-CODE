/**
 * ROUND-52 (R52-a): the BACKGROUND-JOB registry.
 *
 * The owner's round-52 report (the exact case, on Windows):
 *   run_command "taskkill /F /PID 16132"  → ✓ SUCCESS
 *   run_command "start /B node server.js > server.log 2>&1" → "running…" for
 *   10+ minutes, never finished, never checked status.
 *
 * Root cause: `spawn(cmd, { shell: true })` resolves Node's `close` event
 * only when the stdio PIPES close. A Windows `start /B` grandchild INHERITS
 * the shell's pipe handles — it can hold them open for the process's whole
 * lifetime, so `close` never fires and the tool promise never resolves (the
 * 60s spawn timeout kills the SHELL, not the pipe holders — `close` still
 * waits on pipes).
 *
 * This module is the companion registry for the exec.ts fix: when exec.ts
 * detects a detached/background child (shell exited, pipes still open), it
 * registers a JOB here and RESOLVES the tool call immediately with polling
 * instructions. The registry then:
 *   - keeps reading the orphaned pipe, appending to a small ring-buffer tail
 *     (the job's live "terminal output" — what the owner asked to SEE);
 *   - marks the job exited when the pipe finally closes (= the background
 *     process died) — pipe-open-ness IS the liveness signal;
 *   - tails a parsed `> file` redirection on demand (job_status) so the
 *     agent can read what a redirected server prints;
 *   - stops jobs best-effort (tree-kill the shell pid when alive; otherwise
 *     discover the grandchild pids by command-line match and kill those).
 *
 * Jobs are process-local (one sidecar = one registry, like terminal
 * sessions). Cap 100 jobs; ended jobs are pruned after 12h; the oldest ended
 * jobs are dropped when the cap is hit.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface BackgroundJobSnapshot {
  /** Short public id ("j" + 7 hex chars) — what the model/UI addresses. */
  id: string;
  command: string;
  cwd: string;
  projectId: string | null;
  startedAt: number;
  /** "running" = pipe still open (or shell pid alive); "exited" = confirmed done. */
  status: "running" | "exited";
  /** The launching shell's exit code, when exec.ts observed it. */
  exitCode: number | null;
  endedAt: number | null;
  pid: number | null;
  logFile: string | null;
  /** Ring-buffered pipe output captured AFTER the tool call resolved. */
  outputTail: string;
  /** ROUND-52 follow-up: a fully-detached launch (Unix `&` + full redirect —
   * pipes closed instantly, no live tail): liveness is probed via the
   * process group, output via the log-file tail. */
  detached: boolean;
}

interface BackgroundJob extends BackgroundJobSnapshot {
  pipesOpen: boolean;
}

const MAX_JOBS = 100;
const TAIL_CAP = 8 * 1024;
const PRUNE_AGE_MS = 12 * 60 * 60 * 1000;
/** Max log bytes served per job_status call (head-dropped tail). */
const LOG_TAIL_BYTES = 2048;
/** Safety cap for the pid-match stop path. */
const MAX_STOP_PIDS = 12;

const jobs = new Map<string, BackgroundJob>();

function newJobId(): string {
  return `j${randomBytes(4).toString("hex")}`;
}

function appendTail(job: BackgroundJob, text: string): void {
  job.outputTail = (job.outputTail + text).slice(-TAIL_CAP);
}

function prune(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status === "exited" && now - (job.endedAt ?? job.startedAt) > PRUNE_AGE_MS) {
      jobs.delete(id);
    }
  }
  if (jobs.size <= MAX_JOBS) return;
  // Drop the OLDEST ENDED jobs first — running jobs are never evicted.
  const ended = [...jobs.values()]
    .filter((j) => j.status === "exited")
    .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
  for (const job of ended) {
    if (jobs.size <= MAX_JOBS) break;
    jobs.delete(job.id);
  }
}

export interface RegisterJobInput {
  command: string;
  cwd: string;
  projectId?: string | null;
  pid?: number | null;
  logFile?: string | null;
  exitCode?: number | null;
}

export interface RegisterJobOptions {
  /** DETACHED mode (Unix `&` + full redirect): the grandchild closed the
   * pipes instantly and lives in its own process group — no pipe watcher;
   * liveness = kill(-pid, 0) group probe (see groupAlive). */
  detached?: boolean;
}

/**
 * Register a detected background job.
 *
 * PIPE-HELD mode (child given, detached falsy): `child` is the ALREADY-EXITED
 * shell's ChildProcess whose pipes are still held by the detached grandchild —
 * attaching the watcher keeps tailing the orphaned pipe (Node keeps the read
 * ends alive as long as we hold listeners) and flips the job to "exited"
 * when the grandchild dies and the pipes finally close.
 *
 * DETACHED mode (detached: true): the grandchild redirected its output to a
 * file and the pipes are gone — the job's "running" state is probed via the
 * PROCESS GROUP (exec.ts spawns background launches with detached: true so
 * the shell was the group leader; the group survives its leader while any
 * member lives). Output comes from the log-file tail on demand.
 */
export function registerJob(
  input: RegisterJobInput,
  child?: ChildProcess,
  options?: RegisterJobOptions,
): BackgroundJobSnapshot {
  prune();
  const detached = options?.detached === true;
  const job: BackgroundJob = {
    id: newJobId(),
    command: input.command,
    cwd: input.cwd,
    projectId: input.projectId ?? null,
    startedAt: Date.now(),
    status: "running",
    exitCode: input.exitCode ?? null,
    endedAt: null,
    pid: input.pid ?? null,
    logFile: input.logFile ?? null,
    outputTail: "",
    detached,
    pipesOpen: !detached,
  };
  jobs.set(job.id, job);

  if (child !== undefined && !detached) {
    const onData = (d: Buffer): void => {
      appendTail(job, d.toString("utf8"));
    };
    const onClose = (): void => {
      job.pipesOpen = false;
      if (job.status === "running") {
        job.status = "exited";
        job.endedAt = Date.now();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    // 'close' = all stdio streams ended. With the shell already exited, this
    // only fires when every pipe-holder (the grandchild) is gone.
    child.once("close", onClose);
    // Race guard: if the streams had ALREADY ended before we attached (a
    // fully-redirected grandchild closes them fast), 'close' may have fired
    // without us — detect the ended state directly.
    const stdoutEnded = child.stdout === null || child.stdout.readableEnded || child.stdout.destroyed;
    const stderrEnded = child.stderr === null || child.stderr.readableEnded || child.stderr.destroyed;
    if (stdoutEnded && stderrEnded) onClose();
  }

  return snapshot(job);
}

function snapshot(job: BackgroundJob): BackgroundJobSnapshot {
  return {
    id: job.id,
    command: job.command,
    cwd: job.cwd,
    projectId: job.projectId,
    startedAt: job.startedAt,
    status: job.status,
    exitCode: job.exitCode,
    endedAt: job.endedAt,
    pid: job.pid,
    logFile: job.logFile,
    outputTail: job.outputTail,
    detached: job.detached,
  };
}

/** Is the job's launching shell pid still alive? (Best-effort, sync.) */
function pidAlive(pid: number | null): boolean {
  if (pid === null || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = exists but owned by another user — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** ROUND-52 follow-up: is the job's whole PROCESS GROUP alive? exec.ts spawns
 * background launches with detached: true, so the (now-dead) shell was the
 * group leader and the grandchild remains a member — a negative-pid probe
 * succeeds while ANY member lives and ESRCHs once the group is empty.
 * POSIX only (Windows has no groups — returns false; the pipe-held path
 * governs there). Probe-verified: leader dead + member alive → true. */
function groupAlive(pid: number | null): boolean {
  if (process.platform === "win32") return false;
  if (pid === null || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tailFile(path: string, bytes: number): string | null {
  try {
    const buffer = readFileSync(path);
    if (buffer.length <= bytes) return buffer.toString("utf8");
    return buffer.subarray(buffer.length - bytes).toString("utf8");
  } catch {
    return null;
  }
}

export interface JobStatus extends BackgroundJobSnapshot {
  ageMs: number;
  /** Liveness: pipe open or shell pid alive. */
  alive: boolean;
  /** Last bytes of the parsed `> logFile`, when readable. */
  logTail: string | null;
}

/** Full status for one job (null when unknown). */
export function getJobStatus(id: string): JobStatus | null {
  const job = jobs.get(id);
  if (job === undefined) return null;
  const alive = job.pipesOpen || pidAlive(job.pid) || groupAlive(job.pid);
  return {
    ...snapshot(job),
    ageMs: Date.now() - job.startedAt,
    alive,
    logTail:
      job.logFile !== null
        ? tailFile(isAbsolute(job.logFile) ? job.logFile : join(job.cwd, job.logFile), LOG_TAIL_BYTES)
        : null,
  };
}

/** Every job (newest first) with status — the job_status tool's list mode. */
export function listJobs(projectId?: string): JobStatus[] {
  const all = [...jobs.values()]
    .map((job) => getJobStatus(job.id))
    .filter((j): j is JobStatus => j !== null);
  const scoped = projectId !== undefined ? all.filter((j) => j.projectId === projectId) : all;
  return scoped.sort((a, b) => b.startedAt - a.startedAt);
}

/** Test helper: clear the registry. */
export function clearJobsForTest(): void {
  jobs.clear();
}

// ── stopping ────────────────────────────────────────────────────────────────

function killTreeWindows(pid: number): Promise<string> {
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      shell: true,
    });
    let out = "";
    killer.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
    killer.stderr?.on("data", (d: Buffer) => (out += d.toString("utf8")));
    killer.on("error", () => resolve(`taskkill failed to start for pid ${pid}`));
    killer.on("close", (code) =>
      resolve(code === 0 ? `killed pid ${pid} (tree)` : `taskkill pid ${pid}: ${out.trim() || `exit ${code}`}`),
    );
  });
}

function killPidsUnix(pids: number[]): Promise<string> {
  return new Promise((resolve) => {
    let pending = pids.length;
    const lines: string[] = [];
    if (pending === 0) resolve("no pids to kill");
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
        lines.push(`killed pid ${pid}`);
      } catch (error) {
        lines.push(`pid ${pid}: ${(error as Error).message}`);
      }
      if (--pending === 0) resolve(lines.join("; "));
    }
  });
}

/**
 * Best-effort discovery of the detached grandchild's pids by COMMAND-LINE
 * match. The grandchild's command line contains the launched tail (e.g.
 * "node server.js") even though the shell that knew its exact pid is gone.
 *
 *   Windows: PowerShell Get-CimInstance Win32_Process CommandLine -like
 *   Unix:    pgrep -f
 *
 * The match pattern is derived by stripping shell syntax (start/nohup/&,
 * redirections) from the original command — never shorter than 4 chars so a
 * trivial pattern can't match half the process table. Our own pid and the
 * dead shell's pid are excluded.
 */
export async function findJobPids(job: BackgroundJobSnapshot): Promise<number[]> {
  const tail = job.command
    .replace(/^\s*(start|nohup|disown)(\s+\/[a-zA-Z]+)*\s+/i, "")
    .replace(/\s*(?:>>|>|2>&1|&)\s*\S*/g, " ")
    .trim();
  const pattern = tail.length >= 4 ? tail : job.command.trim();
  const self = process.pid;
  const found: number[] = [];

  if (process.platform === "win32") {
    const ps = spawn(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne ${self} -and $_.CommandLine -like '*${pattern.replaceAll("'", "''").replaceAll("*", "")}*' } | Select-Object -First ${MAX_STOP_PIDS} -ExpandProperty ProcessId) -join ' '`,
      ],
      { windowsHide: true },
    );
    const out = await new Promise<string>((resolve) => {
      let text = "";
      ps.stdout?.on("data", (d: Buffer) => (text += d.toString("utf8")));
      ps.on("error", () => resolve(""));
      ps.on("close", () => resolve(text));
    });
    for (const token of out.trim().split(/\s+/)) {
      const pid = Number(token);
      if (Number.isInteger(pid) && pid > 0 && pid !== self && pid !== job.pid) found.push(pid);
    }
    return found;
  }

  const pgrep = spawn("pgrep", ["-f", pattern], { windowsHide: true });
  const out = await new Promise<string>((resolve) => {
    let text = "";
    pgrep.stdout?.on("data", (d: Buffer) => (text += d.toString("utf8")));
    pgrep.on("error", () => resolve(""));
    pgrep.on("close", () => resolve(text));
  });
  for (const token of out.trim().split(/\s+/)) {
    const pid = Number(token);
    if (Number.isInteger(pid) && pid > 0 && pid !== self && pid !== job.pid) found.push(pid);
  }
  return found.slice(0, MAX_STOP_PIDS);
}

export interface StopJobResult {
  ok: boolean;
  output: string;
}

/** Stop a background job: tree-kill a live shell pid; kill the process
 * group of a detached launch; otherwise discover the grandchild pids by
 * command-line match and kill those. Marks the job exited once the pipes
 * close (the watcher flips it) — the stop itself is reported honestly
 * either way. */
export async function stopJob(id: string): Promise<StopJobResult> {
  const job = jobs.get(id);
  if (job === undefined) return { ok: false, output: `no background job '${id}'` };
  if (job.status === "exited" && !job.pipesOpen && !groupAlive(job.pid)) {
    return { ok: true, output: `job ${id} already exited (code ${job.exitCode ?? "?"})` };
  }

  const notes: string[] = [];
  // (1) The launching shell is still alive → kill its whole tree.
  if (pidAlive(job.pid)) {
    if (process.platform === "win32") {
      notes.push(await killTreeWindows(job.pid as number));
    } else {
      notes.push(await killPidsUnix([job.pid as number]));
    }
  }
  // (1b) ROUND-52 follow-up: a DETACHED launch (group leader long dead,
  // group members alive) → signal the whole process group.
  if (groupAlive(job.pid)) {
    try {
      process.kill(-(job.pid as number), "SIGKILL");
      notes.push(`killed process group ${job.pid}`);
    } catch (error) {
      notes.push(`process group ${job.pid}: ${(error as Error).message}`);
    }
  }
  // (2) Shell gone but the job still looks alive (pipe held) → find + kill
  // the detached grandchildren by command-line match.
  if (job.pipesOpen) {
    const pids = await findJobPids(job);
    if (pids.length > 0) {
      notes.push(
        process.platform === "win32"
          ? (await Promise.all(pids.map((p) => killTreeWindows(p)))).join("; ")
          : await killPidsUnix(pids),
      );
    } else {
      notes.push("no matching process found by command-line search");
    }
  }

  // Give the pipes/processes a moment to die after the kills, then report.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const stillAlive = (job.pipesOpen || groupAlive(job.pid)) && job.status === "running";
  if (!stillAlive) {
    job.status = "exited";
    job.endedAt ??= Date.now();
  }
  return {
    ok: !stillAlive,
    output: stillAlive
      ? `job ${id}: stop signal sent but the job still appears alive — ${notes.join("; ")}`
      : `job ${id} stopped (${notes.join("; ")})`,
  };
}
