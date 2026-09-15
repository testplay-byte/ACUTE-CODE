/**
 * ROUND-98 (R98-K, owner: "I want our application to be usable using the
 * terminal tool"): the CLI's PORTAL-DISCOVERY resolver — a PURE, tiny helper
 * module extracted from scripts/acute.mjs so it is unit-testable WITHOUT
 * executing the 930-line CLI (the script's top-level switch would run on
 * import). acute.mjs imports resolvePortalDiscovery; the tests import this
 * module directly.
 *
 * The contract on the other side (agent-core/src/server.ts startServer): a
 * running sidecar writes <dbDir>/acute-portal.json — {port, token, pid,
 * startedAt} — next to its SQLite DB, and removes it on graceful shutdown.
 * This module finds that file across the db dirs a sidecar actually uses
 * and derives the CLI's {baseUrl, token} from it. Explicit env vars
 * (ACUTE_BASE_URL / ACUTE_TOKEN) always win — the caller applies that rule;
 * this module never reads them.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PORTAL_FILENAME = "acute-portal.json";

/**
 * The per-user state dir the PACKAGED app's Rust shell uses for its DB
 * (src-tauri/src/sidecar.rs state_dir()): %APPDATA%\acute-code on Windows,
 * $XDG_DATA_HOME/acute-code (default ~/.local/share/acute-code) elsewhere.
 * Mirrored here in JS so the CLI looks exactly where the shell writes —
 * keyring files (~/.acute/*.key) are a DIFFERENT directory and deliberately
 * not searched (nothing ever writes a portal file there).
 */
export function portalStateDir() {
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA;
    return appdata !== undefined && appdata !== "" ? join(appdata, "acute-code") : null;
  }
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg !== undefined && xdg !== "" ? xdg : join(homedir(), ".local", "share");
  return join(base, "acute-code");
}

/**
 * The candidate discovery files, in priority order:
 *   1. <repoRoot>/.dev/acute-portal.json — the DEV stack (scripts/dev.mjs
 *      puts acute.db in <repo>/.dev, so that is where its sidecar's file
 *      lands; the repo root is passed by the caller, never assumed = cwd)
 *   2. the packaged app's state dir (portalStateDir()) — the installed app.
 * `stateDir` is injectable for tests; the default resolves per platform.
 */
export function portalDiscoveryCandidates(repoRoot, stateDir = portalStateDir()) {
  const candidates = [join(repoRoot, ".dev", PORTAL_FILENAME)];
  if (stateDir !== null) candidates.push(join(stateDir, PORTAL_FILENAME));
  return candidates;
}

/**
 * Parse ONE discovery file → {baseUrl, token, port, pid, startedAt} | null.
 * Strict about the load-bearing fields (a usable integer port + a non-empty
 * token string); tolerant about the metadata (pid/startedAt may be absent
 * from an older file). Unreadable/corrupt JSON → null — a bad file must
 * never break the CLI, it just doesn't count as discovered.
 */
export function readPortalDiscoveryFile(file) {
  if (!existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { port, token } = raw;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (typeof token !== "string" || token === "") return null;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    port,
    pid: typeof raw.pid === "number" ? raw.pid : null,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
  };
}

/**
 * Resolve the discovery across the candidates: the FIRST readable file
 * wins (priority order above — dev stack over installed app, matching how
 * the owner actually runs both). Returns the parsed record + the file it
 * came from, or null when nothing usable exists (the caller then keeps the
 * env-var/default behavior).
 */
export function resolvePortalDiscovery(repoRoot, stateDir = portalStateDir()) {
  for (const file of portalDiscoveryCandidates(repoRoot, stateDir)) {
    const found = readPortalDiscoveryFile(file);
    if (found !== null) return { ...found, file };
  }
  return null;
}
