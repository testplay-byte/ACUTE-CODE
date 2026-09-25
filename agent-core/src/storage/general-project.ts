/**
 * ROUND-128 (R128-W3, SCREENS.md §2 law #9 — the General conversation): the
 * app's INTERNAL workspace project. Conversations that need no folder live
 * in <dataDir>/general — the sidecar's state dir beside the SQLite file —
 * seeded at boot by startServer (idempotently) and delete-PROTECTED at the
 * route layer (DELETE /projects/general → 409 general_protected; the storage
 * guard below is the belt-and-braces leg). The owner's rule: "the user will
 * not be required to select a folder for that — it will select an internal
 * folder and it will use that."
 *
 * The ONLY SQL for the "general" row lives here (the anti-drift rule the
 * other storage modules follow); routes/projects.ts imports the id constant
 * for its 409 guard so the spelling exists once.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SqliteDatabase } from "./db.js";
// The storage layer's logging idiom (skills-files.ts is the precedent):
// structured JSON-lines via lib/log.ts — never a bare console call.
import { log } from "../lib/log.js";

/** The stable row id — the frontend pins its list entry + hides its delete
 * affordance on this exact spelling. */
export const GENERAL_PROJECT_ID = "general";

export const GENERAL_PROJECT_NAME = "General";

/** A neutral slate — deliberately OFF the 8-hue PROJECT_PALETTE so the
 * internal workspace never reads as "just another project color" and never
 * disturbs the least-used-palette rotation user projects draw from. */
export const GENERAL_PROJECT_COLOR = "#64748B";

/**
 * Idempotent boot seed: mkdir the internal folder (recursive; EEXIST from a
 * racing boot on the same dir is fine) and upsert the project row.
 *
 *   - row absent  → INSERT OR IGNORE (a racing writer is tolerated);
 *   - row present → ensure its root_path matches THIS boot's data dir (the
 *     dir moved / the DB was copied to a new machine), otherwise leave the
 *     row exactly as it is (name/color are the owner's to change).
 *
 * Errors are the CALLER's contract: startServer wraps the call in a
 * fire-and-log-errors leg — a seeding failure must never kill boot.
 */
export function ensureGeneralProject(db: SqliteDatabase, dataDir: string): void {
  const rootPath = join(dataDir, "general");
  // The General conversations' sandbox root. `recursive: true` already
  // tolerates an existing dir; the catch keeps a read-only/unwritable state
  // dir from crashing a boot that should still serve everything else.
  try {
    mkdirSync(rootPath, { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== "EEXIST") {
      log("error", "general_project.mkdir_failed", {
        rootPath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const existing = db
    .prepare("SELECT root_path FROM projects WHERE id = ?")
    .get(GENERAL_PROJECT_ID) as { root_path: string } | undefined;
  if (existing === undefined) {
    db.prepare(
      `INSERT OR IGNORE INTO projects (id, name, root_path, color, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      GENERAL_PROJECT_ID,
      GENERAL_PROJECT_NAME,
      rootPath,
      GENERAL_PROJECT_COLOR,
      new Date().toISOString(),
    );
    return;
  }
  if (existing.root_path !== rootPath) {
    db.prepare("UPDATE projects SET root_path = ? WHERE id = ?").run(
      rootPath,
      GENERAL_PROJECT_ID,
    );
  }
}
