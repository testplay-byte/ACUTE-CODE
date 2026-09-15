/**
 * ROUND-98 (R98-F2): the per-SESSION FILE-FRESHNESS LEDGER — the owner's
 * edit-efficiency ask, verbatim: "It just created a file and then I tell it
 * to change something in that file. It should not be the one to read the
 * whole file again. It does know where things are and how it handled it.
 * It should be able to directly make those changes as needed… context-
 * optimized and token-optimized."
 *
 * WHAT THIS IS: an in-memory Map<sessionId, Map<normalizedAbsPath, entry>>
 * recording the mtime/size of every file the model READ (read_file) or
 * WROTE (edit_file / edit_file_multi / write_file) in a session. The
 * entries answer ONE question honestly — "is the file on disk still the
 * bytes the model last saw?" — so the tools can (a) warn when it is NOT
 * (the user or another process changed it) and (b) stay silent when it IS
 * (a successful edit IS the confirmation; no re-read needed).
 *
 * WHAT THIS IS NOT:
 *   - NOT a cache of content. The model's context holds the content; the
 *     ledger holds only the freshness FACT (mtime + size + timestamps).
 *   - NOT persistence. Module state, process lifetime, keyed by sessionId:
 *     a fresh session re-reads on its first edit of a file — the correct
 *     semantics (a new session genuinely has not seen the file). Same
 *     in-memory posture as tools/edit-streak.ts + tools/dir-conventions.ts.
 *   - NOT a gate. Bookkeeping only: every consumer wraps its ledger call in
 *     try/catch-shaped tolerance — a broken stat must never break the read
 *     or edit it rides on.
 *
 * THE CONTRACT (the three entry points the tools call):
 *   · ledgerRecordRead(sessionId, absPath, stat) — after a successful
 *     read_file: the model now knows the file as of `stat`.
 *   · ledgerRecordWrite(sessionId, absPath, stat) — after a successful
 *     edit/write: the model KNOWS the new content (it authored it), so the
 *     post-write stat is the truth the next freshness check compares
 *     against. This is the owner's exact case: "edit the file you just
 *     created/edited directly — do not read the whole file again."
 *   · ledgerCheckFresh(sessionId, absPath, currentStat) → "fresh" |
 *     "stale" | "unknown":
 *       "fresh"   — disk mtime AND size equal the recorded pair: the model's
 *                   last view is still the truth (edit again directly).
 *       "stale"   — an entry exists but disk differs: something changed the
 *                   file since the model last saw it (the user, a run_command,
 *                   another agent). The anchor may not match — warn.
 *       "unknown" — no entry for (session, path): the model has not read or
 *                   written the file THIS session; the classic read-first
 *                   rule applies. Sessionless callers (bare/test builds with
 *                   no toolDeps) always get "unknown" and never record —
 *                   deterministic for tests, no map growth from them (the
 *                   dir-conventions precedent).
 *
 * BOUNDED: LEDGER_MAX_ENTRIES_PER_SESSION (200) per session, LRU-ish —
 * JS Map preserves insertion order, every record DELETES+SETS to refresh
 * recency, and an over-cap insert evicts from the FRONT (the least
 * recently touched path). A session touching more than 200 distinct files
 * simply loses the OLDEST freshness facts — they decay to "unknown", which
 * degrades honestly (re-read before edit), never dangerously.
 *
 * PATH NORMALIZATION: node:path.normalize on the ABSOLUTE path — the same
 * path family fs-ops.resolveInsideRoot produces (posix.normalize + join),
 * so "…/a/./b.ts", "…/a//b.ts" and "…/a/b.ts" are one key. Callers pass
 * resolved.abs; the normalize() here is defense so direct/test callers
 * cannot split one file across two keys.
 */
import { normalize } from "node:path";

/** The freshness facts of one file at one moment (from statSync). */
export interface LedgerFileStat {
  mtimeMs: number;
  size: number;
}

/** One ledger entry: what the model last saw + when. */
export interface FileLedgerEntry {
  /** Disk mtime (ms) at the model's last read/write of the file. */
  mtimeMs: number;
  /** Disk size (bytes) at the model's last read/write of the file. */
  size: number;
  /** epoch ms of the last read_file that refreshed this entry (null when the session has only written). */
  readAt: number | null;
  /** epoch ms of the last successful edit/write (null when the session has only read). */
  editedAt: number | null;
}

/** The honest three-valued freshness answer. */
export type LedgerFreshness = "fresh" | "stale" | "unknown";

/** Per-session cap — see the module header (LRU-ish trim, ~200 files is far
 * beyond any sane single-session working set; the eviction degrades to
 * "unknown", which is the safe direction). */
export const LEDGER_MAX_ENTRIES_PER_SESSION = 200;

/** sessionId → (normalized abs path → entry). */
const ledger = new Map<string, Map<string, FileLedgerEntry>>();

/** The once-per-(session, file) redundant-read reminder dedup — the
 * R72-d shouldInject pattern, reused verbatim in spirit: the FIRST
 * expensive re-read carries the reminder, later ones stay clean. */
const remindedReads = new Set<string>();

/** The canonical key: normalized absolute path. */
function ledgerKey(absPath: string): string {
  return normalize(absPath);
}

function sessionMap(sessionId: string): Map<string, FileLedgerEntry> {
  let map = ledger.get(sessionId);
  if (map === undefined) {
    map = new Map();
    ledger.set(sessionId, map);
  }
  return map;
}

/** Set an entry with LRU recency + the over-cap evict (module header). */
function setEntry(sessionId: string, key: string, entry: FileLedgerEntry): void {
  const map = sessionMap(sessionId);
  map.delete(key); // delete+set = refresh recency (Map insertion order)
  map.set(key, entry);
  while (map.size > LEDGER_MAX_ENTRIES_PER_SESSION) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** Record a successful read_file: the model saw the file as of `stat`.
 * Sessionless callers no-op (module header). */
export function ledgerRecordRead(sessionId: string | undefined, absPath: string, stat: LedgerFileStat): void {
  if (sessionId === undefined) return;
  const key = ledgerKey(absPath);
  const prior = ledger.get(sessionId)?.get(key);
  setEntry(
    sessionId,
    key,
    prior === undefined
      ? { mtimeMs: stat.mtimeMs, size: stat.size, readAt: Date.now(), editedAt: null }
      : { mtimeMs: stat.mtimeMs, size: stat.size, readAt: Date.now(), editedAt: prior.editedAt },
  );
}

/** Record a successful edit_file/edit_file_multi/write_file: the model
 * AUTHORED the new content, so `stat` (the post-write stat) is the truth
 * the next freshness check compares against. Sessionless callers no-op. */
export function ledgerRecordWrite(sessionId: string | undefined, absPath: string, stat: LedgerFileStat): void {
  if (sessionId === undefined) return;
  const key = ledgerKey(absPath);
  const prior = ledger.get(sessionId)?.get(key);
  setEntry(
    sessionId,
    key,
    prior === undefined
      ? { mtimeMs: stat.mtimeMs, size: stat.size, readAt: null, editedAt: Date.now() }
      : { mtimeMs: stat.mtimeMs, size: stat.size, readAt: prior.readAt, editedAt: Date.now() },
  );
}

/** "fresh" | "stale" | "unknown" — see the module header for the semantics.
 * A read entry keeps matching until the disk mtime OR size moves. */
export function ledgerCheckFresh(
  sessionId: string | undefined,
  absPath: string,
  currentStat: LedgerFileStat,
): LedgerFreshness {
  if (sessionId === undefined) return "unknown";
  const entry = ledger.get(sessionId)?.get(ledgerKey(absPath));
  if (entry === undefined) return "unknown";
  return entry.mtimeMs === currentStat.mtimeMs && entry.size === currentStat.size ? "fresh" : "stale";
}

/** True when the session has ANY entry for the path (read or write) — the
 * redundant-read reminder's precondition ("you already read <file> this
 * session" is honest for a written file too: the model authored it). */
export function ledgerHasEntry(sessionId: string | undefined, absPath: string): boolean {
  if (sessionId === undefined) return false;
  return ledger.get(sessionId)?.has(ledgerKey(absPath)) === true;
}

/** Milliseconds since the model last SAW the file (read or write), or null
 * when there is no entry. The staleness warning's "(X ms ago)" — the only
 * honest number available (the ledger never learns WHEN the disk change
 * happened, only that it happened after the model's last look). */
export function ledgerLastSeenAgeMs(sessionId: string | undefined, absPath: string): number | null {
  if (sessionId === undefined) return null;
  const entry = ledger.get(sessionId)?.get(ledgerKey(absPath));
  if (entry === undefined) return null;
  const lastSeen = Math.max(entry.readAt ?? 0, entry.editedAt ?? 0);
  return lastSeen > 0 ? Date.now() - lastSeen : null;
}

/**
 * CHECK-AND-MARK for the redundant-read reminder: true exactly ONCE per
 * (session, file) — the first re-read of a file the session already saw.
 * Mirrors dir-conventions' shouldInject (the R72-d pattern): once the
 * reminder has ridden one read, repeating it would be pure noise.
 */
export function shouldRemindRedundantRead(sessionId: string | undefined, absPath: string): boolean {
  if (sessionId === undefined) return false;
  const key = `${sessionId}::${ledgerKey(absPath)}`;
  if (remindedReads.has(key)) return false;
  remindedReads.add(key);
  return true;
}

/** Test seam: wipe the ledger + the reminder dedup (suite independence). */
export function resetFileLedgerForTest(): void {
  ledger.clear();
  remindedReads.clear();
}
