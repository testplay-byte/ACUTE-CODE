/**
 * ROUND-129 (R129-S, SCREENS.md §2 law #9 — REWRITTEN from R128's General
 * conversation): the app's INTERNAL workspace project — the SCRATCHPAD.
 * Conversations that need no folder live under <dataDir>/scratchpad, and
 * EVERY Scratchpad session gets its OWN dedicated workspace folder
 * (<dataDir>/scratchpad/<sessionId>/ — the owner: "each of its sessions
 * will get a separate folder in of itself, a separate workspace") so
 * general conversations never share or pollute one folder. Deleting a
 * Scratchpad session removes its folder with its records (the delete
 * helpers below); deleting a NORMAL project or session never touches
 * files (SCREENS §2 law #8's delete-materiality law — routes/sessions.ts
 * + routes/projects.ts). The project row stays delete-PROTECTED at the
 * route layer (DELETE /projects/general → 409 general_protected; the
 * storage guard below is the belt-and-braces leg). The owner's rule
 * stands: "the user will not be required to select a folder for that —
 * it will select an internal folder and it will use that."
 *
 * ROUND-128 heritage (R128-W3): the stable row id "general" is KEPT — the
 * frontend pins its list entry + hides its delete affordance on this exact
 * spelling, and the 409 guard keys on it; a rename would be a migration
 * for zero benefit. Only the NAME changed ("General" → "Scratchpad") and
 * the root moved (<dataDir>/general → <dataDir>/scratchpad).
 *
 * The ONLY SQL for the "general" row lives here (the anti-drift rule the
 * other storage modules follow); routes/projects.ts imports the id constant
 * for its 409 guard so the spelling exists once.
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SqliteDatabase } from "./db.js";
// The storage layer's logging idiom (skills-files.ts is the precedent):
// structured JSON-lines via lib/log.ts — never a bare console call.
import { log } from "../lib/log.js";

/** The stable row id — the frontend pins its list entry + hides its delete
 * affordance on this exact spelling (unchanged by the R129 rename). */
export const GENERAL_PROJECT_ID = "general";

/** R129-S: the row NAME — "Scratchpad" (the owner: "it will also not be
 * called general, but it will be something else so that it looks proper").
 * The boot seed migrates a row still carrying the pre-R129 default name
 * (see LEGACY_GENERAL_NAME); an owner-rename to anything else is respected. */
export const GENERAL_PROJECT_NAME = "Scratchpad";

/** R129-S: the pre-R129 default name — the ONLY name the boot-time rename
 * migrates (an owner-renamed row is the owner's and stays untouched). */
const LEGACY_GENERAL_NAME = "General";

/** R129-S: the Scratchpad root's directory name under the data dir. The
 * legacy "general" directory is NEVER deleted (never delete user data) —
 * it is simply no longer the workspace root after this round. */
export const SCRATCHPAD_DIR_NAME = "scratchpad";

/** R129-S: the Scratchpad conversations' shared parent root —
 * <dataDir>/scratchpad. Every session's OWN workspace folder is a DIRECT
 * child of this root (the shape the delete guard below pins). */
export function scratchpadRoot(dataDir: string): string {
  return join(dataDir, SCRATCHPAD_DIR_NAME);
}

/** A neutral slate — deliberately OFF the 8-hue PROJECT_PALETTE so the
 * internal workspace never reads as "just another project color" and never
 * disturbs the least-used-palette rotation user projects draw from. */
export const GENERAL_PROJECT_COLOR = "#64748B";

/**
 * Idempotent boot seed: mkdir the Scratchpad root (recursive; EEXIST from a
 * racing boot on the same dir is fine) and upsert the project row.
 *
 *   - row absent  → INSERT OR IGNORE (a racing writer is tolerated);
 *   - row present with the pre-R129 default name "General" → the R129-S
 *     rename migration: UPDATE name to "Scratchpad" AND root_path to the
 *     new scratchpad dir (only the UNTOUCHED default migrates — an
 *     owner-rename to something else is respected);
 *   - any present row → ensure its root_path matches THIS boot's data dir
 *     (the dir moved / the DB was copied to a new machine), otherwise
 *     leave the row exactly as it is (name/color are the owner's to
 *     change).
 *
 * The legacy <dataDir>/general/ dir from pre-R129 installs stays on disk
 * — never delete user data; new sessions' workspaces live under the
 * scratchpad root.
 *
 * Errors are the CALLER's contract: startServer wraps the call in a
 * fire-and-log-errors leg — a seeding failure must never kill boot.
 */
export function ensureGeneralProject(db: SqliteDatabase, dataDir: string): void {
  const rootPath = scratchpadRoot(dataDir);
  // The Scratchpad conversations' sandbox parent. `recursive: true`
  // already tolerates an existing dir; the catch keeps a read-only/
  // unwritable state dir from crashing a boot that should still serve
  // everything else.
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
    .prepare("SELECT name, root_path FROM projects WHERE id = ?")
    .get(GENERAL_PROJECT_ID) as { name: string; root_path: string } | undefined;
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
  // R129-S (the rename migration): a row still carrying the pre-R129
  // default name migrates — name AND root move to the Scratchpad spelling
  // in one write (idempotent: a row already migrated fails the name check
  // and falls through; an owner-renamed row is respected verbatim).
  if (existing.name === LEGACY_GENERAL_NAME) {
    db.prepare("UPDATE projects SET name = ?, root_path = ? WHERE id = ?").run(
      GENERAL_PROJECT_NAME,
      rootPath,
      GENERAL_PROJECT_ID,
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

/**
 * R129-S (SCREENS §2 law #9): the CREATE path's side-effect helper — a
 * Scratchpad session's OWN workspace folder. Returns null (and touches
 * nothing) unless the session belongs to the Scratchpad project; else
 * mkdirs <dataDir>/scratchpad/<sessionId>/ (recursive) and UPDATEs the
 * session row's root_path (migration 0043; the write is idempotent — the
 * same value is a no-op), returning the folder. A mkdir failure is logged
 * via the storage idiom and returns null WITHOUT the row update — the
 * session then falls back to the project root (the Scratchpad parent) and
 * still works; never throws (a workspace failure must never fail the
 * session's creation).
 */
export function ensureScratchpadSessionWorkspace(
  db: SqliteDatabase,
  dataDir: string,
  sessionId: string,
  projectId: string | null | undefined,
): string | null {
  if (projectId !== GENERAL_PROJECT_ID) return null;
  const dir = join(scratchpadRoot(dataDir), sessionId);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    log("error", "scratchpad.session_workspace_mkdir_failed", {
      dir,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  db.prepare("UPDATE sessions SET root_path = ? WHERE id = ?").run(dir, sessionId);
  return dir;
}

/**
 * R129-S: the ORCHESTRATOR's create-site variant. The sub-agent
 * orchestrator is a process-level singleton with no dataDir to thread
 * (see agents/orchestrator.ts's call site), but the Scratchpad project's
 * OWN row carries the boot-seeded root — the same <dataDir>/scratchpad
 * directory ensureScratchpadSessionWorkspace computes — so a delegated
 * child of a Scratchpad parent gets its own folder under the SAME root
 * without the plumbing. Returns null (no folder, the child falls back to
 * the project root) unless the parent's project is the Scratchpad or the
 * row is missing/unusable; never throws.
 */
export function ensureScratchpadChildWorkspace(
  db: SqliteDatabase,
  sessionId: string,
  projectId: string | null | undefined,
): string | null {
  if (projectId !== GENERAL_PROJECT_ID) return null;
  const row = db
    .prepare("SELECT root_path FROM projects WHERE id = ?")
    .get(GENERAL_PROJECT_ID) as { root_path: string | null } | undefined;
  if (row === undefined || typeof row.root_path !== "string" || row.root_path === "") {
    return null;
  }
  const dir = join(row.root_path, sessionId);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    log("error", "scratchpad.child_workspace_mkdir_failed", {
      dir,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  db.prepare("UPDATE sessions SET root_path = ? WHERE id = ?").run(dir, sessionId);
  return dir;
}

/**
 * R129-S (SCREENS §2 laws #8 + #9): the DELETE path's guarded folder
 * removal. TRUE only when the folder was removed; false — and nothing on
 * disk touched — in every other case:
 *
 *   · sessionRootPath null/empty (a NORMAL session — law #8: its files
 *     are NEVER touched; only the Scratchpad deletes workspaces);
 *   · containment: path.resolve(sessionRootPath) must be a DIRECT child
 *     of path.resolve(scratchpadRoot(dataDir)) — the resolved parent must
 *     BE the scratchpad root. resolve() collapses `..` segments and any
 *     symlinked hops, so an escaped path (a tampered row, a re-pointed
 *     data dir) never qualifies — the rm simply refuses;
 *   · the row check: no LIVE session row may still reference the path
 *     (the delete path calls this AFTER deleteSession; the belt-and-braces
 *     leg keeps a mis-ordered or double-assigned future caller from
 *     removing a folder another session still calls its workspace);
 *   · the rm itself failed (logged, honest false).
 *
 * rm -rf via rmSync(dir, { recursive: true, force: true }); never throws.
 */
export function removeScratchpadSessionWorkspace(
  db: SqliteDatabase,
  dataDir: string,
  sessionRootPath: string | null,
): boolean {
  if (sessionRootPath === null || sessionRootPath === "") return false;
  const root = resolve(scratchpadRoot(dataDir));
  const target = resolve(sessionRootPath);
  // DIRECT-CHILD containment: the resolved parent must equal the
  // scratchpad root itself (blocks `..` escapes, deeper paths, and paths
  // outside the root that resolve() normalizes into view).
  if (dirname(target) !== root) return false;
  const stillReferenced = db
    .prepare("SELECT 1 FROM sessions WHERE root_path = ? LIMIT 1")
    .get(sessionRootPath);
  if (stillReferenced !== undefined) {
    log("warn", "scratchpad.session_workspace_still_referenced", { target });
    return false;
  }
  try {
    rmSync(target, { recursive: true, force: true });
    return true;
  } catch (err) {
    log("error", "scratchpad.session_workspace_remove_failed", {
      target,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
