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
import { rmSync, readdirSync, statSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.js";
import { reseedFactoryData, type SqliteDatabase } from "../storage/db.js";
import { abortTurn, liveTurnIds } from "../lib/turn-registry.js";
import { terminalSessionsDisposeAll } from "../terminal-sessions.js";

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
