/**
 * ROUND-106 (R106-S3, CLI-DESIGN §1): attach-or-spawn — the CLI's connection
 * resolver. Resolution order (the R98-K contract):
 *
 *   1. explicit ACUTE_BASE_URL + ACUTE_TOKEN (BOTH or NEITHER — a
 *      half-explicit pair is an honest error, never a silent mismatch);
 *   2. the portal discovery file — <repo>/.dev/acute-portal.json, then the
 *      installed app's state dir (%APPDATA%\\acute-code or
 *      $XDG_DATA_HOME/acute-code) — verified LIVE via GET /health (a stale
 *      file after a hard kill falls through to spawn, exactly like a wrong
 *      ACUTE_BASE_URL);
 *   3. spawn (spawn.ts — the Node port of the shell's handshake).
 *
 * Attach never tears anything down; a CLI-SPAWNED sidecar is torn down on
 * exit by `releaseConnection` — SIGTERM only when the CLI owns the pid
 * (the R54 orphan discipline; last-boot-wins on the portal file).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { healthFetch } from "./api.js";
import { appStateDir, repoRootFromModule, spawnSidecar, type SpawnedSidecar } from "./spawn.js";

export const PORTAL_FILENAME = "acute-portal.json";

export type ConnectionSource = "env" | "portal" | "spawn";

export interface Connection {
  baseUrl: string;
  token: string;
  source: ConnectionSource;
  /** True only when THIS CLI process spawned the sidecar (owns the pid). */
  ownsSidecar: boolean;
  /** The discovery file the attach came from (portal mode). */
  portalFile: string | null;
  port: number;
  /** The spawned child handle (spawn mode; null when attaching). */
  spawned: SpawnedSidecar | null;
}

export interface ResolveOptions {
  /** Repo root for portal candidate #1 + agent-core spawn (tests inject). */
  repoRoot?: string;
  /** ACUTE_BASE_URL/ACUTE_TOKEN overrides (tests inject; env by default). */
  env?: NodeJS.ProcessEnv;
  /** Home override for the state-dir portal candidate (tests). */
  home?: string;
  /** --db isolation (spawn mode only). */
  dbPath?: string;
  /** Dim stderr notices (the spawn progress lines). */
  notice?: (line: string) => void;
}

export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

/** The repo root as seen from cli/dist|src/connection.js (3 dirs up). */
export function defaultRepoRoot(): string {
  return repoRootFromModule();
}

/** The candidate discovery files, in R98-K priority order (dev stack first). */
export function portalCandidates(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const candidates = [join(repoRoot, ".dev", PORTAL_FILENAME)];
  candidates.push(join(appStateDir(env, home), PORTAL_FILENAME));
  return candidates;
}

/** Parse ONE discovery file (acute-discovery.mjs's strict-tolerant rule):
 * load-bearing fields (integer port, non-empty token) required; pid/
 * startedAt optional; unreadable/corrupt → null — a bad file never breaks
 * the CLI. */
export function readPortalFile(file: string): { port: number; token: string; pid: number | null; startedAt: string | null } | null {
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as { port?: unknown; token?: unknown; pid?: unknown; startedAt?: unknown };
  if (
    typeof record.port !== "number" ||
    !Number.isInteger(record.port) ||
    record.port <= 0 ||
    record.port > 65535
  ) {
    return null;
  }
  if (typeof record.token !== "string" || record.token === "") return null;
  return {
    port: record.port,
    token: record.token,
    pid: typeof record.pid === "number" ? record.pid : null,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : null,
  };
}

/**
 * Resolve the connection (env > portal > spawn). NEVER throws for a dead
 * portal file — that is the spawn fallback's job. Throws ConnectionError
 * only for the half-explicit env pair and a failed spawn (surfaced
 * verbatim).
 */
export async function resolveConnection(options: ResolveOptions = {}): Promise<Connection> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const repoRoot = options.repoRoot ?? defaultRepoRoot();

  // 1. Explicit env pair — both or neither (the CLI-DESIGN §1 rule).
  const hasBase = env.ACUTE_BASE_URL !== undefined && env.ACUTE_BASE_URL !== "";
  const hasToken = env.ACUTE_TOKEN !== undefined && env.ACUTE_TOKEN !== "";
  if (hasBase || hasToken) {
    if (!hasBase || !hasToken) {
      throw new ConnectionError(
        "ACUTE_BASE_URL and ACUTE_TOKEN must be set together (a half-explicit pair would silently mismatch)",
      );
    }
    return {
      baseUrl: env.ACUTE_BASE_URL!.replace(/\/$/, ""),
      token: env.ACUTE_TOKEN!,
      source: "env",
      ownsSidecar: false,
      portalFile: null,
      port: portOf(env.ACUTE_BASE_URL!),
      spawned: null,
    };
  }

  // 2. Portal discovery — first LIVE candidate wins (stale files fall through).
  for (const file of portalCandidates(repoRoot, env, home)) {
    const found = readPortalFile(file);
    if (found === null) continue;
    const baseUrl = `http://127.0.0.1:${found.port}`;
    const health = await healthFetch(baseUrl, 1_500);
    if (health === null) continue; // stale portal file (hard-killed sidecar)
    options.notice?.(`(attached to the running sidecar on port ${found.port} — discovered at ${file})`);
    return {
      baseUrl,
      token: found.token,
      source: "portal",
      ownsSidecar: false,
      portalFile: file,
      port: found.port,
      spawned: null,
    };
  }

  // 3. Spawn — the CLI owns the pid; teardown is releaseConnection's job.
  const spawned = await spawnSidecar({
    repoRoot,
    ...(options.dbPath !== undefined ? { dbPath: options.dbPath } : {}),
    ...(home !== homedir() ? { home } : {}),
    ...(options.notice !== undefined ? { notice: options.notice } : {}),
  });
  return {
    baseUrl: `http://127.0.0.1:${spawned.port}`,
    token: spawned.token,
    source: "spawn",
    ownsSidecar: true,
    portalFile: spawned.portalFile,
    port: spawned.port,
    spawned,
  };
}

function portOf(baseUrl: string): number {
  try {
    const parsed = new URL(baseUrl);
    return Number(parsed.port) || 0;
  } catch {
    return 0;
  }
}

/**
 * Tear down the connection on CLI exit: SIGTERM ONLY when this CLI spawned
 * the sidecar (it owns the pid); attaching never tears anything down.
 * Best-effort SIGKILL after a 3s grace (the R54 orphan discipline).
 */
export async function releaseConnection(connection: Connection): Promise<void> {
  if (!connection.ownsSidecar || connection.spawned === null) return;
  const child = connection.spawned.child;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 3_000);
      timer.unref?.();
    }),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** The module's own directory (for tests that need the sibling layout). */
export function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}
