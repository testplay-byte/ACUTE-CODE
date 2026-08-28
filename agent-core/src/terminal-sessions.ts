/**
 * ROUND-45 (R45-b): PERSISTENT interactive terminal sessions.
 *
 * The ROUND-38/44 terminal routes run ONE command per request (spawn →
 * stream → exit) — interactive stdin (cd persistence, exported env vars,
 * venvs, REPLs) needs a LONG-LIVED shell instead. This module is the
 * in-process session registry behind POST/GET/DELETE
 * /projects/:id/terminal-sessions (mounted in server.ts): each session is
 * one shell process running in the project root whose stdout/stderr stream
 * to every subscriber (SSE viewers) and accumulate in a per-session ring
 * buffer so a LATE subscriber gets the backlog first.
 *
 * TWO engines, chosen at create():
 *
 *  - "pty" (PRIMARY): node-pty, an optionalDependency — a real
 *    pseudoterminal. Echo, line editing, TUI apps and colors all work
 *    because the shell really is interactive. The native module is loaded
 *    DEFENSIVELY at runtime (non-literal dynamic import; any load failure —
 *    missing build tools on a user machine — resolves to null) and the
 *    manager falls back to the pipe engine. NEVER a hard dependency.
 *
 *  - "pipe" (FALLBACK): ONE long-lived `bash`/`cmd.exe` child with
 *    stdio pipes. input() writes the data + "\n" to stdin; stdout/stderr
 *    stream back. cwd, env exports and venvs persist across commands
 *    because it is the same process. No TUI/echo support (stdin is not a
 *    tty) — acceptable; the UI knows which engine is active and echoes the
 *    command itself.
 *
 * Security (audit P0-3, non-negotiable): every shell is spawned with
 * buildChildEnv() — an ALLOWLIST environment. The sidecar's secrets
 * (ACUTE_TOKEN, ACUTE_PROVIDER_*) are never inherited by terminal
 * sessions. See lib/child-env.ts.
 *
 * Lifecycle: sessions SURVIVE viewer disconnects (unlike the one-shot
 * R44-e stream route, which kills its child when the reader leaves — a
 * persistent session's value IS surviving). They die on DELETE, when the
 * shell process itself exits (an exit marker is emitted to subscribers),
 * or via idle reaping (see options.idleTimeoutMs — a session is "idle"
 * when it has seen NEITHER input NOR output for that long, so a running
 * 15-minute build is never reaped just because the user stopped typing).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { buildChildEnv } from "./lib/child-env.js";

// ── node-pty, loaded defensively ────────────────────────────────────────────
//
// The module specifier is a VARIABLE so neither tsc nor any bundler tries to
// resolve it statically: on a machine where the optional native dependency
// failed to install, `import("node-pty")` would be a compile error if it
// were a literal. The types below are LOCAL structural shapes of the tiny
// surface we use (the real package ships its own, richer typings).

interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  };
}

type PtySpawnFn = (
  file: string,
  args: string[],
  options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
  },
) => PtyProcess;

const PTY_MODULE_ID = "node-pty";

let ptySpawnPromise: Promise<PtySpawnFn | null> | null = null;

/** Try to load node-pty once per process; null when unavailable. */
function loadPtySpawn(): Promise<PtySpawnFn | null> {
  if (ptySpawnPromise === null) {
    ptySpawnPromise = import(PTY_MODULE_ID)
      .then((mod: unknown) => {
        const candidate = mod as { spawn?: unknown; default?: { spawn?: unknown } };
        const spawnFn = candidate.spawn ?? candidate.default?.spawn;
        return typeof spawnFn === "function" ? (spawnFn as PtySpawnFn) : null;
      })
      .catch(() => {
        // Missing native build / missing module / dlopen failure — the pipe
        // engine takes over. Deliberately silent: this is the designed
        // degraded mode, not an error.
        return null;
      });
  }
  return ptySpawnPromise;
}

/** Test/introspection helper: is the PTY engine usable in this process? */
export async function isPtyLoadable(): Promise<boolean> {
  return (await loadPtySpawn()) !== null;
}

// ── public session types ────────────────────────────────────────────────────

export type TerminalSessionEngine = "pty" | "pipe";

/** What the REST surface serves for one session (live sessions only). */
export interface TerminalSessionDescriptor {
  id: string;
  projectId: string;
  engine: TerminalSessionEngine;
  createdAt: number;
}

/** Everything a subscriber can observe on a live session. */
export type TerminalSessionEvent =
  | { type: "output"; text: string }
  | { type: "exit"; code: number | null };

export type TerminalSessionListener = (event: TerminalSessionEvent) => void;

export interface TerminalSessionCreateInput {
  projectId: string;
  /** Shell working directory (the project root). */
  rootPath: string;
  cols?: number;
  rows?: number;
  /** Engine override (tests force "pipe" on machines where pty loads). */
  engine?: TerminalSessionEngine;
}

export interface TerminalSessionManagerOptions {
  /** A session with neither input nor output for this long is reaped. */
  idleTimeoutMs?: number;
  /** Sweep-timer cadence (the timer starts lazily with the first session). */
  sweepIntervalMs?: number;
  /** Per-session output ring buffer cap (characters; backlog drops oldest). */
  ringBufferBytes?: number;
  maxSessionsPerProject?: number;
  maxSessionsGlobal?: number;
}

/** Shell-spawn failure surfaced to the REST layer (503 UNAVAILABLE). */
export class TerminalSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalSessionError";
  }
}

interface SessionRecord {
  id: string;
  projectId: string;
  engine: TerminalSessionEngine;
  createdAt: number;
  /** Idle-reaping clock: bumped on every input AND every output chunk. */
  lastActivityAt: number;
  listeners: Set<TerminalSessionListener>;
  /** Ring buffer of everything the shell has emitted (cap: drop oldest). */
  buffer: string;
  proc:
    | { kind: "pty"; pty: PtyProcess }
    | { kind: "pipe"; child: ChildProcess; decoder: TextDecoder };
}

const DEFAULTS: Required<TerminalSessionManagerOptions> = {
  idleTimeoutMs: 10 * 60_000,
  sweepIntervalMs: 60_000,
  ringBufferBytes: 256 * 1024,
  maxSessionsPerProject: 3,
  maxSessionsGlobal: 8,
};

/**
 * Registry of live terminal sessions. Production code uses the singleton
 * (getTerminalSessions()); tests that need custom timing/limits construct
 * their own instance and dispose() it.
 *
 * Cap policy (documented choice): at most 3 concurrent sessions per project
 * and 8 globally. Creating over a cap kills the OLDEST session of that
 * project (or, for the global cap, the globally-oldest) rather than
 * rejecting the create — opening a new terminal tab always succeeds, and
 * zombie sessions left behind by closed tabs die instead of piling up.
 */
export class TerminalSessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly opts: Required<TerminalSessionManagerOptions>;

  constructor(options: TerminalSessionManagerOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /** Spawn a new shell session in rootPath. Throws TerminalSessionError
   * when no shell can be started (missing cwd, no bash on PATH). */
  async create(input: TerminalSessionCreateInput): Promise<TerminalSessionDescriptor> {
    // Resolve the PTY engine ONCE (cached promise) — the decision needs the
    // import anyway, and spawnPty() below reuses the resolved fn
    // synchronously. Any load failure degrades to the pipe engine.
    if (this.cachedPtySpawn === undefined) {
      this.cachedPtySpawn = await loadPtySpawn();
    }
    const engine: TerminalSessionEngine =
      input.engine ?? (this.cachedPtySpawn !== null ? "pty" : "pipe");
    this.enforceCaps(input.projectId);
    const id = randomUUID();
    let proc: SessionRecord["proc"];
    try {
      proc =
        engine === "pty"
          ? { kind: "pty", pty: this.spawnPty(input) }
          : { kind: "pipe", child: this.spawnPipe(input), decoder: new TextDecoder() };
    } catch (err) {
      throw new TerminalSessionError(
        `failed to start ${engine} shell in ${input.rootPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const record: SessionRecord = {
      id,
      projectId: input.projectId,
      engine,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      listeners: new Set(),
      buffer: "",
      proc,
    };
    this.sessions.set(id, record);
    this.startSweep();
    this.wire(record);
    return { id, projectId: input.projectId, engine, createdAt: record.createdAt };
  }

  // ── engine spawn + wiring ────────────────────────────────────────────────

  private childEnv(): Record<string, string> {
    // P0-3: allowlisted env, never the sidecar's secrets. A PTY additionally
    // wants a real TERM so the shell behaves like a terminal (line editing,
    // colors); only set it when the allowlist did not pass one through.
    const env = buildChildEnv();
    if (env.TERM === undefined) env.TERM = "xterm-256color";
    return env;
  }

  private spawnPty(input: TerminalSessionCreateInput): PtyProcess {
    // create() has already awaited loadPtySpawn() (that is how the engine
    // was chosen), so the resolved spawn fn is available synchronously.
    const fn = this.cachedPtySpawn;
    if (fn === undefined || fn === null) {
      throw new TerminalSessionError("node-pty not loaded");
    }
    return fn(
      process.platform === "win32" ? "cmd.exe" : "bash",
      [],
      {
        name: "xterm-256color",
        cols: input.cols ?? 120,
        rows: input.rows ?? 30,
        cwd: input.rootPath,
        env: this.childEnv(),
      },
    );
  }

  /** Resolved node-pty spawn fn (null when the module cannot load); set by
   * the first create() call. */
  private cachedPtySpawn: PtySpawnFn | null | undefined;

  private spawnPipe(input: TerminalSessionCreateInput): ChildProcess {
    return spawn(process.platform === "win32" ? "cmd.exe" : "bash", [], {
      cwd: input.rootPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.childEnv(),
    });
  }

  private wire(record: SessionRecord): void {
    if (record.proc.kind === "pty") {
      const pty = record.proc.pty;
      pty.onData((data) => this.handleOutput(record, data));
      pty.onExit((event) => {
        this.handleExit(record, event.exitCode ?? null);
      });
    } else {
      const proc = record.proc;
      if (proc.kind !== "pipe") return;
      const child = proc.child;
      // TextDecoder(stream) keeps multi-byte UTF-8 code points intact across
      // chunk boundaries (a naive Buffer.toString per chunk can split them).
      child.stdout?.on("data", (chunk: Buffer) => {
        this.handleOutput(record, proc.decoder.decode(chunk));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        this.handleOutput(record, proc.decoder.decode(chunk));
      });
      child.on("error", () => {
        // Spawn failure after the fact (EPIPE etc.) — the close event follows.
      });
      child.on("close", (code) => {
        // Flush any decoder tail, then mark the exit.
        const tail = proc.decoder.decode();
        if (tail !== "") this.handleOutput(record, tail);
        this.handleExit(record, code);
      });
    }
  }

  // ── event plumbing ───────────────────────────────────────────────────────

  private handleOutput(record: SessionRecord, text: string): void {
    if (text === "" || this.sessions.get(record.id) !== record) return;
    record.lastActivityAt = Date.now();
    record.buffer += text;
    if (record.buffer.length > this.opts.ringBufferBytes) {
      // Drop the OLDEST characters — the backlog is always the most recent
      // ringBufferBytes of output.
      record.buffer = record.buffer.slice(-this.opts.ringBufferBytes);
    }
    for (const listener of record.listeners) {
      listener({ type: "output", text });
    }
  }

  private handleExit(record: SessionRecord, code: number | null): void {
    // kill() removes the record first and emits its own marker — this guard
    // makes the process-exit event a no-op for already-killed sessions.
    if (this.sessions.get(record.id) !== record) return;
    this.sessions.delete(record.id);
    this.emitExit(record, code);
    this.maybeStopSweep();
  }

  private emitExit(record: SessionRecord, code: number | null): void {
    for (const listener of record.listeners) {
      listener({ type: "exit", code });
    }
    record.listeners.clear();
  }

  // ── caps + reaping ───────────────────────────────────────────────────────

  private enforceCaps(projectId: string): void {
    const projectSessions = this.liveSessionsOf(projectId);
    while (projectSessions.length >= this.opts.maxSessionsPerProject) {
      const oldest = projectSessions.shift();
      if (oldest === undefined) break;
      this.kill(oldest.id);
    }
    while (this.sessions.size >= this.opts.maxSessionsGlobal) {
      let oldest: SessionRecord | null = null;
      for (const s of this.sessions.values()) {
        if (oldest === null || s.createdAt < oldest.createdAt) oldest = s;
      }
      if (oldest === null) break;
      this.kill(oldest.id);
    }
  }

  private liveSessionsOf(projectId: string): SessionRecord[] {
    const result: SessionRecord[] = [];
    for (const s of this.sessions.values()) {
      if (s.projectId === projectId) result.push(s);
    }
    return result.sort((a, b) => a.createdAt - b.createdAt);
  }

  private startSweep(): void {
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => this.sweep(), this.opts.sweepIntervalMs);
    // Never keep the sidecar (or a test worker) alive just for the sweeper.
    this.sweepTimer.unref?.();
  }

  private maybeStopSweep(): void {
    if (this.sweepTimer !== null && this.sessions.size === 0) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const s of [...this.sessions.values()]) {
      if (now - s.lastActivityAt >= this.opts.idleTimeoutMs) {
        this.kill(s.id); // emits the exit marker to any viewer
      }
    }
  }

  // ── session operations ───────────────────────────────────────────────────

  /** Descriptor of a LIVE session, or null. */
  get(id: string): TerminalSessionDescriptor | null {
    const s = this.sessions.get(id);
    if (s === undefined) return null;
    return { id: s.id, projectId: s.projectId, engine: s.engine, createdAt: s.createdAt };
  }

  /** Ring-buffer backlog (everything the shell emitted, oldest dropped). */
  backlog(id: string): string {
    return this.sessions.get(id)?.buffer ?? "";
  }

  /** Write raw input to the shell. Returns false for an unknown session. */
  input(id: string, data: string): boolean {
    const s = this.sessions.get(id);
    if (s === undefined) return false;
    s.lastActivityAt = Date.now();
    try {
      if (s.proc.kind === "pty") {
        // Raw write — the caller includes its own Enter (\n works in the
        // pty's canonical line discipline; control sequences pass through).
        s.proc.pty.write(data);
      } else {
        // The pipe engine has no line discipline: complete the line so the
        // shell executes it. (Callers sending "cmd\n" produce one harmless
        // empty command — bash no-ops it.)
        s.proc.child.stdin?.write(data + "\n");
      }
    } catch {
      // The shell died between the registry check and the write — its exit
      // marker is already in flight; nothing else to do.
    }
    return true;
  }

  /** Resize the pty. No-op (returns true) on the pipe engine. */
  resize(id: string, cols: number, rows: number): boolean {
    const s = this.sessions.get(id);
    if (s === undefined) return false;
    if (s.proc.kind === "pty") {
      try {
        s.proc.pty.resize(cols, rows);
      } catch {
        /* already-dead pty: the exit marker is on its way */
      }
    }
    return true;
  }

  /** Subscribe to output/exit events of a live session. Null when unknown. */
  subscribe(id: string, listener: TerminalSessionListener): (() => void) | null {
    const s = this.sessions.get(id);
    if (s === undefined) return null;
    s.listeners.add(listener);
    return () => {
      s.listeners.delete(listener);
    };
  }

  /** Live sessions of one project, oldest first. */
  list(projectId: string): TerminalSessionDescriptor[] {
    return this.liveSessionsOf(projectId).map((s) => ({
      id: s.id,
      projectId: s.projectId,
      engine: s.engine,
      createdAt: s.createdAt,
    }));
  }

  /** Kill a session (emits an exit marker, code null = killed by us). */
  kill(id: string): boolean {
    const s = this.sessions.get(id);
    if (s === undefined) return false;
    // Remove FIRST: the process-exit events that follow must be no-ops.
    this.sessions.delete(id);
    try {
      if (s.proc.kind === "pty") s.proc.pty.kill();
      else s.proc.child.kill();
    } catch {
      /* already dead */
    }
    this.emitExit(s, null);
    this.maybeStopSweep();
    return true;
  }

  /** Kill every session and stop the sweeper (shutdown hook). */
  dispose(): void {
    for (const id of [...this.sessions.keys()]) {
      this.kill(id);
    }
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}

// ── singleton ───────────────────────────────────────────────────────────────

let singleton: TerminalSessionManager | null = null;

/** Process-wide manager the REST routes use. */
export function getTerminalSessions(): TerminalSessionManager {
  if (singleton === null) singleton = new TerminalSessionManager();
  return singleton;
}

/**
 * Shutdown hook: kill every live shell so no orphan processes survive the
 * sidecar. Called from server.ts (app onClose) and main.ts (SIGTERM/SIGINT —
 * the dev workflow kills the sidecar with a signal, which does NOT run
 * Fastify's close hooks on its own).
 */
export function terminalSessionsDisposeAll(): void {
  getTerminalSessions().dispose();
}
