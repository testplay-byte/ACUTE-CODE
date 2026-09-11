// ─────────────────────────────────────────────────────────────────────────────
// R87: the system domain — the application-wide reset.
//
// The owner's directive: "In the About section there will be options to reset
// the whole application. All the things of the application will be reset: the
// projects, the data, the storage, and all of those will be removed from the
// application. The providers and models will be removed completely too."
//
// POST /system/reset does, in order:
//   1. ABORTS every live turn (main + sub-agent children — the shared
//      turn-registry), so no in-flight agent keeps writing to rows that are
//      about to vanish.
//   2. Clears the in-memory keyring (ACUTE_PROVIDER_* — the spawn-time env
//      snapshot outlives the webview reload and would otherwise keep
//      answering tests with erased keys) and disposes every terminal
//      session (sidecar-held PTYs).
//   3. WIPES every table except schema_migrations (foreign_keys OFF for the
//      sweep — parent/child order is unknowable when everything goes) and
//      re-runs the factory seeds (the same reseedFactoryData openDatabase
//      calls — templates, built-in provider rows, built-in skills, the
//      default agent; one definition shared by both paths by construction).
//   4. VACUUMs the file back to its fresh-install size.
//   5. PURGES the app's machine-scoped files best-effort (never fails the
//      reset): the ~/.acute note files + key files + external plugins, and
//      the dataDir's vapid.json (regenerated on next boot).
//
// What it deliberately does NOT touch: the owner's REAL project directories
// (rows vanish; files on disk are the owner's), and the OS credential store —
// the webview layer owns that boundary (the Tauri purge command runs BEFORE
// this route so a reset mid-flight cannot resurrect a Credential-Manager key
// into the already-cleared keyring).
//
// The frontend then clears its localStorage stores + react-query cache and
// reloads — the full journey back to first-run.
// ─────────────────────────────────────────────────────────────────────────────
import { rmSync, readdirSync, statSync, existsSync, unlinkSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.js";
import { reseedFactoryData, type SqliteDatabase } from "../storage/db.js";
import { abortTurn, liveTurnIds } from "../lib/turn-registry.js";
import { terminalSessionsDisposeAll } from "../terminal-sessions.js";

const GITHUB_REPO = "testplay-byte/ACUTE-CODE";
const GITHUB_LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const GITHUB_RELEASES_PAGE = `https://github.com/${GITHUB_REPO}/releases`;

/** R89-A2: the app's own version, from the package.json that ships with the
 * staged engine (dist/routes/… → ../../package.json = agent-core's manifest;
 * scripts/release/version.mjs keeps it identical to the root's). */
function appVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8"),
    ) as { version?: string };
    return typeof manifest.version === "string" && manifest.version !== "" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** "0.86.0" vs "0.87.0" → [0,86,0] (tolerant of leading v and short forms). */
function versionTuple(v: string): number[] {
  return v
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isNaN(part) ? 0 : part));
}

/** R89-A2: the launcher's saved GitHub token (~/.acute/github.pat — written
 * by acute_launcher.py's first-run prompt). The repo is PRIVATE, so the
 * releases API answers 404 to anonymous callers. Never logged, never
 * returned — read once per /system/updates call and used in the Authorization
 * header only. Returns null when absent/unreadable. */
function readLauncherGithubPat(): string | null {
  try {
    const pat = readFileSync(join(homedir(), ".acute", "github.pat"), "utf8").trim();
    if (!pat.startsWith("github_pat_")) return null;
    return pat;
  } catch {
    return null;
  }
}

/** Every user-data table in the database — derived from sqlite_master at
 * reset time (never a hand-maintained list to drift), minus the migration
 * ledger (keeping it keeps the schema version honest — re-running
 * migrations on a wiped app would re-apply nothing and stay a no-op). */
function userDataTables(db: SqliteDatabase): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'",
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/** The ~/.acute machine-scoped app files the reset purges. Best-effort:
 * every miss is fine (dev machines never have most of them). */
function purgeAcuteDir(): string[] {
  const purged: string[] = [];
  const acuteDir = join(homedir(), ".acute");
  const targets = ["custom-providers.txt", "vision-providers.txt"];
  for (const name of targets) {
    const path = join(acuteDir, name);
    try {
      if (existsSync(path)) {
        unlinkSync(path);
        purged.push(path);
      }
    } catch {
      // best-effort — a locked file never fails the reset
    }
  }
  // The launcher-era key files (openrouter.key, openrouter-slot2..4.key,
  // nvidia.key — written by distribute_key) + any other *.key drops.
  try {
    for (const entry of readdirSync(acuteDir)) {
      if (entry.endsWith(".key")) {
        const path = join(acuteDir, entry);
        try {
          unlinkSync(path);
          purged.push(path);
        } catch {
          // best-effort
        }
      }
    }
  } catch {
    // no ~/.acute dir at all — nothing to purge
  }
  // The external user plugins (ADR-0025: ~/.acute/plugins/*.mjs).
  const pluginsDir = join(acuteDir, "plugins");
  try {
    if (existsSync(pluginsDir) && statSync(pluginsDir).isDirectory()) {
      rmSync(pluginsDir, { recursive: true, force: true });
      purged.push(pluginsDir);
    }
  } catch {
    // best-effort
  }
  return purged;
}

export function registerSystemRoutes(scope: FastifyInstance, ctx: RouteContext): void {
  const { db, keyring } = ctx;

  // ── R89-A2: the update check ──────────────────────────────────────────────
  // The About tab's "Check for updates" used to call api.github.com from the
  // webview — the repo is PRIVATE, so GitHub answered 404 to the anonymous
  // browser fetch (the owner's verdict). The check now runs HERE, server-side,
  // with the launcher's saved token — the PAT never crosses the REST boundary.
  // The fetch is short-lived (8s) so the button can answer honestly fast.
  scope.get("/system/updates", async () => {
    const current = appVersion();
    const base = { current, releasesUrl: GITHUB_RELEASES_PAGE };
    const pat = readLauncherGithubPat();
    if (pat === null) {
      return {
        ...base,
        ok: false,
        reason: "no-token",
        error:
          "the launcher's GitHub token is not saved on this machine (start the app once via ACUTE.bat and let it save it)",
      };
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        const response = await fetch(GITHUB_LATEST_RELEASE_URL, {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${pat}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "ACUTE-CODE-update-check",
          },
          signal: controller.signal,
        });
        if (response.status === 404) {
          return {
            ...base,
            ok: false,
            reason: "no-release",
            error: "no published release is visible to this token yet",
          };
        }
        if (!response.ok) {
          return {
            ...base,
            ok: false,
            reason: "github",
            error: `GitHub answered HTTP ${response.status}`,
          };
        }
        const release = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
        const latest = typeof release.tag_name === "string" ? release.tag_name.replace(/^v/, "") : "";
        if (latest === "") {
          return { ...base, ok: false, reason: "bad-payload", error: "the release payload had no tag_name" };
        }
        const now = versionTuple(current);
        const newest = versionTuple(latest);
        const updateAvailable =
          newest.length > 0 && now.some((part, i) => part < (newest[i] ?? 0));
        return {
          ...base,
          ok: true,
          latest,
          updateAvailable,
          releaseUrl:
            typeof release.html_url === "string" ? release.html_url : GITHUB_RELEASES_PAGE,
        };
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      return {
        ...base,
        ok: false,
        reason: "network",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  scope.post("/system/reset", async () => {
    // 1. Abort every live turn (main sessions + sub-agent children) so no
    // in-flight agent writes to rows mid-wipe. The SSE streams unwind on
    // their own abort paths — the webview is reloading anyway.
    const aborted = liveTurnIds();
    for (const sessionId of aborted) {
      abortTurn(sessionId, "owner");
    }

    // 2. In-memory state: the keyring env snapshot + the sidecar-held
    // terminal PTYs.
    keyring.clear();
    terminalSessionsDisposeAll();

    // 3. The wipe + reseed, one transaction with FKs off (the sweep's
    // parent/child order is unknowable when everything goes).
    const tables = userDataTables(db);
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        for (const table of tables) {
          db.prepare(`DELETE FROM "${table}"`).run();
        }
        reseedFactoryData(db);
      })();
    } finally {
      db.pragma("foreign_keys = ON");
    }

    // 4. Shrink the file back to fresh-install size (must run OUTSIDE a
    // transaction — better-sqlite3 throws inside one).
    db.exec("VACUUM");

    // 5. Machine-scoped files, best-effort.
    const purged = purgeAcuteDir();
    if (ctx.dataDir !== undefined) {
      const vapidPath = join(ctx.dataDir, "vapid.json");
      try {
        if (existsSync(vapidPath)) {
          unlinkSync(vapidPath);
          purged.push(vapidPath);
        }
      } catch {
        // best-effort — regenerated on next boot
      }
    }

    return {
      ok: true,
      abortedTurns: aborted.length,
      wipedTables: tables.length,
      purgedFiles: purged.length,
    };
  });
}
