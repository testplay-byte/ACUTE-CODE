/**
 * ROUND-98 (R98-F3): AUTO-INDEX — the background freshness keeper for the
 * codebase symbol index. The owner's ask, verbatim: "Look into indexing…
 * essential for larger projects with a lot of files, folders, subfolders."
 *
 * THE HOOK (runtime.ts prepareTurn, the cheapest honest spot): every turn,
 * BEFORE the model call, the runtime calls maybeAutoIndexProject once. The
 * check is ONE SQL query (MAX(ts) for the project — getIndexedAt); the
 * expensive part (reindexProject's tree walk) runs FIRE-AND-FORGET via
 * setImmediate, so the turn is never blocked — the walk lands in the event
 * loop's next idle stretch (the model call's network wait), not in
 * prepareTurn's synchronous path.
 *
 * THE GUARDS (both module state, per projectId — the edit-streak/dir-
 * conventions in-process posture):
 *   · STALENESS: fires only when the project's index rows are MISSING
 *     (never indexed / emptied) or their MAX(ts) is older than
 *     AUTO_INDEX_STALE_MS (10 minutes). A successful walk refreshes MAX(ts),
 *     so a live project self-limits to roughly one background walk per 10
 *     minutes of real work.
 *   · CONCURRENCY: an in-flight Set guarantees at most ONE background
 *     reindex per project AT A TIME (sub-agent children and the main
 *     session share the guard — same project, one walk).
 *   · ATTEMPT COOLDOWN: a per-project lastAttempt timestamp, honored
 *     regardless of outcome — a project whose walk found nothing indexable
 *     (MAX(ts) stays NULL) or whose walk threw is retried at most once per
 *     10 minutes, never once per turn (the honest bound: no busy re-trigger
 *     loop on a permanently empty/broken root).
 *
 * Failures are swallowed DELIBERATELY (fire-and-forget): a failed background
 * refresh must never surface as a turn error — search_symbols reports the
 * index's honest state, index_project is the manual refresher, and the next
 * cooldown window gets another attempt.
 *
 * THE INCREMENTAL SIBLING: after every successful write_file/edit_file/
 * delete_file, tools/plugins/filesystem.ts calls reindexFile for the ONE
 * touched path inline (cheap: one file) — the index catches up as the agent
 * works, so the background pass is only for external changes (the user's
 * editor, git checkouts, other tools).
 */
import { getIndexedAt, parseSqliteTs, reindexProject } from "./index.js";
import type { SqliteDatabase } from "./db.js";

/** The staleness horizon — an index older than this (or missing) triggers the
 * background walk; the same number bounds the attempt cooldown. ~10 minutes
 * matches the search_symbols staleness note, so the tool's advice and the
 * keeper's trigger never disagree. */
export const AUTO_INDEX_STALE_MS = 10 * 60 * 1000;

/** In-flight background walks (at most one per project at a time). */
const inFlight = new Set<string>();

/** Per-project last ATTEMPT (epoch ms) — the retry bound (module header). */
const lastAttempt = new Map<string, number>();

/** The staleness fact alone (no side effects): true when the project's index
 * rows are missing, carry an unparseable ts (fail-safe: treat as stale —
 * never guess "fresh"), or are older than AUTO_INDEX_STALE_MS. */
export function isIndexStale(db: SqliteDatabase, projectId: string): boolean {
  const ts = getIndexedAt(db, projectId);
  if (ts === null) return true;
  const ms = parseSqliteTs(ts);
  if (ms === null) return true;
  return Date.now() - ms > AUTO_INDEX_STALE_MS;
}

/**
 * The prepareTurn hook: schedule ONE guarded background reindex when the
 * project's index is missing/stale. Returns whether a walk was SCHEDULED
 * (the honest observable — tests + future diagnostics; false = fresh,
 * in-flight, or cooling down). Never throws, never blocks: the walk runs in
 * setImmediate and its failures are swallowed (module header).
 */
export function maybeAutoIndexProject(db: SqliteDatabase, projectId: string, rootPath: string): boolean {
  const now = Date.now();
  if (inFlight.has(projectId)) return false;
  const last = lastAttempt.get(projectId);
  if (last !== undefined && now - last < AUTO_INDEX_STALE_MS) return false;
  if (!isIndexStale(db, projectId)) return false;
  inFlight.add(projectId);
  lastAttempt.set(projectId, now);
  setImmediate(() => {
    try {
      reindexProject(db, projectId, rootPath);
    } catch {
      /* fire-and-forget: a failed background refresh is never a turn error */
    } finally {
      inFlight.delete(projectId);
    }
  });
  return true;
}

/** Test seam: the in-flight project ids (the concurrency-guard observable). */
export function autoIndexInFlightForTest(): readonly string[] {
  return [...inFlight];
}

/** Test seam: wipe the guard state (suite independence). */
export function resetAutoIndexForTest(): void {
  inFlight.clear();
  lastAttempt.clear();
}
