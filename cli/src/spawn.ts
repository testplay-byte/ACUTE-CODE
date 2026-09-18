/**
 * ROUND-106 (R106-S3, CLI-DESIGN §1): the Node port of
 * `src-tauri/src/sidecar.rs::spawn_and_handshake` — the CLI's SPAWN mode.
 *
 * Protocol (ARCHITECTURE §2, byte-identical to the Rust shell's):
 *   1. mint a 256-bit hex token (randomBytes(32));
 *   2. default ACUTE_DB_PATH to the app's state-dir DB (--db isolates);
 *   3. spawn `node agent-core/dist/main.js` with ACUTE_TOKEN + ACUTE_DB_PATH
 *      (+ ACUTE_PROVIDER_* keys, §5);
 *   4. await the `ACUTE_READY {"port":N}` stdout line — 25s per attempt,
 *      3 attempts, 2s pause between, KILL THE ORPHAN on every failed
 *      attempt (the R54 lesson: a dropped child keeps the SQLite file and
 *      races every later restart);
 *   5. health-poll GET /health every 100ms until 200 (15s deadline);
 *   6. verify the portal file appeared next to the DB (the sidecar writes
 *      it — R98-K; last-boot-wins — the CLI only relies on it, and only
 *      for a sidecar it spawned itself).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { healthFetch } from "./api.js";

// The Rust handshake constants, ported verbatim (sidecar.rs §"limits").
export const READY_TIMEOUT_MS = 25_000;
export const START_ATTEMPTS = 3;
export const RETRY_PAUSE_MS = 2_000;
export const HEALTH_TIMEOUT_MS = 15_000;
export const POLL_INTERVAL_MS = 100;

/** The built-in provider ids whose keys the spawn ladder resolves (the
 * seeded rows — storage/providers.ts BUILTIN_PROVIDER_SEEDS; every one of
 * them is a legitimate `~/.acute/<id>.key` candidate per CLI-DESIGN §5). */
export const BUILTIN_PROVIDER_IDS = ["openrouter", "anthropic", "openai", "google", "nvidia"] as const;

export interface SpawnedSidecar {
  child: ChildProcess;
  port: number;
  token: string;
  pid: number;
  /** The portal file the sidecar wrote (verified post-handshake). */
  portalFile: string | null;
}

/** ACUTE_PROVIDER_<ID> env var name (ProviderKeyring.envVarName's rule). */
export function providerEnvName(providerId: string): string {
  return `ACUTE_PROVIDER_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** Where a provider's key FILE lives (~/.acute/<id>.key — the dev.mjs ladder). */
export function providerKeyFile(providerId: string, home: string = homedir()): string {
  return join(home, ".acute", `${providerId}.key`);
}

export type KeySource = "env" | "file" | "keyring" | "none";

export interface ResolvedKey {
  source: KeySource;
  value: string;
}

/** §5 ladder for ONE provider: env → ~/.acute/<id>.key → OS keyring probe →
 * honest none. The VALUE never appears in any log — callers print length only. */
export function resolveProviderKey(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): ResolvedKey {
  const fromEnv = env[providerEnvName(providerId)];
  if (fromEnv !== undefined && fromEnv !== "") return { source: "env", value: fromEnv };
  const file = providerKeyFile(providerId, home);
  if (process.platform !== "win32" && existsSync(file)) {
    const fromFile = readFileSync(file, "utf8").trim();
    if (fromFile !== "") return { source: "file", value: fromFile };
  }
  const probed = probeOsKeyring(providerId);
  if (probed !== null) return { source: "keyring", value: probed };
  return { source: "none", value: "" };
}

/** The OS keyring probe (§5): credential.ps1 on Windows, secret-tool on
 * Linux, unsupported elsewhere / headless → null. Never throws, never logs. */
function probeOsKeyring(providerId: string): string | null {
  try {
    if (process.platform === "win32") {
      const script = join(repoRootFromModule(), "scripts", "credential.ps1");
      if (!existsSync(script)) return null;
      const res = spawnSync(
        "powershell",
        ["-NoProfile", "-File", script, "Read", `ACUTE-CODE/provider/${providerId}`],
        { encoding: "utf8", timeout: 5_000 },
      );
      const key = res.stdout ? res.stdout.trim() : "";
      return key === "" ? null : key;
    }
    if (process.platform === "linux") {
      const res = spawnSync(
        "secret-tool",
        ["lookup", "service", "ACUTE-CODE", "account", providerId],
        { encoding: "utf8", timeout: 5_000 },
      );
      if (res.status !== 0) return null;
      const key = res.stdout ? res.stdout.trim() : "";
      return key === "" ? null : key;
    }
  } catch {
    return null;
  }
  return null;
}

/** The repo root as seen from THIS module (cli/dist|src/spawn.js → 3 dirs up). */
export function repoRootFromModule(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

/** Kill a failed handshake's child (R54): SIGTERM, brief grace, SIGKILL. */
async function killOrphan(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000).unref?.()),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export interface SpawnOptions {
  /** Repo root holding agent-core/dist/main.js. */
  repoRoot: string;
  /** Explicit DB path (--db); default = the app state dir's acute.db. */
  dbPath?: string;
  /** Extra env passthrough (ACUTE_PROVIDER_* from the desktop runner). */
  env?: NodeJS.ProcessEnv;
  /** Home dir override for the key ladder (tests). */
  home?: string;
  /** Dim stderr notices (spawn progress lines). */
  notice?: (line: string) => void;
}

/**
 * Spawn + handshake (the Rust port). Throws Error with the enriched last
 * failure when all attempts die — the CLI surfaces it verbatim.
 */
export async function spawnSidecar(options: SpawnOptions): Promise<SpawnedSidecar> {
  const main = join(options.repoRoot, "agent-core", "dist", "main.js");
  if (!existsSync(main)) {
    throw new Error(
      `agent-core is not built (${main} missing) — run: pnpm --filter agent-core run build`,
    );
  }
  const dbPath = options.dbPath ?? defaultAppDbPath(process.env, options.home ?? homedir());
  let lastError = "spawn failed";
  for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
    const outcome = await spawnAndHandshakeOnce(main, dbPath, options);
    if (outcome.ok) {
      options.notice?.(`(sidecar ready on 127.0.0.1:${outcome.port} — attempt ${attempt}/${START_ATTEMPTS})`);
      return {
        child: outcome.child,
        port: outcome.port,
        token: outcome.token,
        pid: outcome.child.pid ?? -1,
        portalFile: outcome.portalFile,
      };
    }
    await killOrphan(outcome.child);
    lastError = outcome.error;
    options.notice?.(`(spawn attempt ${attempt}/${START_ATTEMPTS} failed: ${outcome.error})`);
    if (attempt < START_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
    }
  }
  throw new Error(`sidecar startup failed (all ${START_ATTEMPTS} attempts): ${lastError}`);
}

/** The app's shared DB — the packaged shell's state dir (sidecar.rs
 * state_dir()/acute.db; WAL makes a CLI sidecar + the desktop app safe). */
export function defaultAppDbPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const dir = appStateDir(env, home);
  return join(dir, "acute.db");
}

/** The installed app's per-user state dir (acute-discovery.mjs's mirror). */
export function appStateDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (process.platform === "win32") {
    const appdata = env.APPDATA;
    return appdata !== undefined && appdata !== "" ? join(appdata, "acute-code") : join(home, ".acute");
  }
  const xdg = env.XDG_DATA_HOME;
  const base = xdg !== undefined && xdg !== "" ? xdg : join(home, ".local", "share");
  return join(base, "acute-code");
}

interface HandshakeOutcome {
  ok: boolean;
  child: ChildProcess;
  port: number;
  token: string;
  portalFile: string | null;
  error: string;
}

async function spawnAndHandshakeOnce(
  main: string,
  dbPath: string,
  options: SpawnOptions,
): Promise<HandshakeOutcome> {
  const { randomBytes } = await import("node:crypto");
  const token = randomBytes(32).toString("hex");
  const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}) };
  env.ACUTE_TOKEN = token;
  env.ACUTE_DB_PATH = dbPath;
  // §5: the built-in provider keys ride the spawn env (the keyring
  // snapshots them); everything else must come via ACUTE_PROVIDER_* env.
  for (const providerId of BUILTIN_PROVIDER_IDS) {
    if (env[providerEnvName(providerId)] !== undefined) continue; // passthrough wins
    const key = resolveProviderKey(providerId, options.env ?? process.env, options.home ?? homedir());
    if (key.source !== "none") env[providerEnvName(providerId)] = key.value;
  }

  const child = spawn(process.execPath, [main], {
    cwd: options.repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const ready = await readReadyLine(child);
  if (!ready.ok) {
    return { ok: false, child, port: 0, token, portalFile: null, error: ready.error };
  }
  const health = await healthPoll(child, ready.port);
  if (!health.ok) {
    return { ok: false, child, port: ready.port, token, portalFile: null, error: health.error };
  }
  // R98-K: verify the portal file the sidecar wrote next to its DB.
  const portalFile = join(dirname(dbPath), "acute-portal.json");
  const verified = existsSync(portalFile);
  return {
    ok: true,
    child,
    port: ready.port,
    token,
    portalFile: verified ? portalFile : null,
    error: "",
  };
}

/** Await the `ACUTE_READY {"port":N}` stdout line (the Rust read_ready_line:
 * prefix-scan — structured log lines may precede it). */
function readReadyLine(child: ChildProcess): Promise<{ ok: boolean; port: number; error: string }> {
  return new Promise((resolve) => {
    const stdout = child.stdout;
    if (stdout === null) {
      resolve({ ok: false, port: 0, error: "child stdout was not piped" });
      return;
    }
    let buffer = "";
    let settled = false;
    const finish = (ok: boolean, port: number, error: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Keep draining post-handshake stdout so the pipe never fills (the
      // Rust reader thread's job) — silent by design (M1/M2).
      stdout.on("data", () => {});
      resolve({ ok, port, error });
    };
    const tryParse = (line: string): void => {
      if (!line.startsWith("ACUTE_READY")) return;
      try {
        const parsed = JSON.parse(line.slice("ACUTE_READY".length).trim()) as { port?: unknown };
        if (typeof parsed.port === "number" && Number.isInteger(parsed.port) && parsed.port > 0) {
          finish(true, parsed.port, "");
        } else {
          finish(false, 0, `malformed ready line: ${line.slice(0, 120)}`);
        }
      } catch {
        finish(false, 0, `malformed ready line: ${line.slice(0, 120)}`);
      }
    };
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (!settled) tryParse(line);
      }
      if (!settled && buffer.startsWith("ACUTE_READY")) {
        // A ready line without its newline yet — wait for the rest.
        return;
      }
    };
    stdout.on("data", onData);
    stdout.once("close", () => {
      if (!settled) finish(false, 0, "stdout closed before the ready line");
    });
    child.once("exit", (code) => {
      if (!settled) finish(false, 0, `sidecar exited during startup (code ${code ?? "?"})`);
    });
    const timer = setTimeout(() => {
      if (!settled) finish(false, 0, "timed out waiting for ACUTE_READY");
    }, READY_TIMEOUT_MS);
    timer.unref?.();
  });
}

/** Poll GET /health every 100ms until 200, at most 15s (Rust health_poll). */
async function healthPoll(child: ChildProcess, port: number): Promise<{ ok: boolean; error: string }> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return { ok: false, error: `sidecar exited during startup (code ${child.exitCode ?? child.signalCode})` };
    }
    const health = await healthFetch(`http://127.0.0.1:${port}`, 1_000);
    if (health !== null) return { ok: true, error: "" };
    if (Date.now() + POLL_INTERVAL_MS >= deadline) {
      return { ok: false, error: "health check deadline exceeded" };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
