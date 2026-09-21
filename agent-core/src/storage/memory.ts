/**
 * Project memory repository (ROUND-44, R44-a — owner directive "complete
 * the agentic coding environment"; ROUND-46 memory v2 — relevance-ranked
 * recall). Agents forgot everything between turns/sessions; this table is
 * the persistent, per-project knowledge base the agent writes via the
 * memory_save tool and reads back via memory_recall / memory_list / the
 * system-prompt digest.
 *
 * The ONLY SQL for memory lives here (anti-drift rule, same as every other
 * storage module). Validation is code-side (not SQL) so the tool layer can
 * return readable errors instead of raw SQLite exceptions.
 *
 * ROUND-46 (memory v2) ranking model, all stdlib:
 *   - recall: token-overlap scoring (content matches dominate, full-substring
 *     bonus, kind-match boost, importance×recency tie-break) instead of SQL
 *     LIKE substring tiers — multi-token queries rank by RELEVANCE now.
 *   - digest: importance weight by kind (decision > fact > preference >
 *     note) × recency decay instead of pure newest-first.
 *   - save: exact-duplicate content (case-insensitive) bumps updated_at
 *     instead of inserting a twin row.
 *
 * ROUND-117 (R117-b): the SCOPE tier. The table gains `scope`
 * ('project' | 'workspace', migration 0042; workspace rows carry
 * project_id NULL) — the workspace tier holds CROSS-PROJECT facts (the
 * owner's identity/preferences/environment truths) written through the REST
 * surface (GET/POST/PUT/DELETE /memory/workspace) and injected into every
 * main-session prompt ABOVE the project digest (agents/prompts.ts composes
 * the two labeled blocks). Every save/list/search/digest entry point takes
 * a scope: the PROJECT spellings keep their pre-R117 signatures verbatim
 * (callers unchanged), the WORKSPACE spellings are new siblings, and the
 * shared core is keyed by MemoryScopeRef.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;

/** The four memory kinds (mirrors the 0015 CHECK constraint). */
export type MemoryKind = "fact" | "decision" | "preference" | "note";

export const MEMORY_KINDS: readonly MemoryKind[] = ["fact", "decision", "preference", "note"];

/** ROUND-117 (R117-b): which tier a memory belongs to (mirrors the 0042
 * CHECK constraint). 'project' = scoped to one project's root; 'workspace'
 * = the cross-project tier (project_id NULL). */
export type MemoryScope = "project" | "workspace";

/** The scope discriminator every storage entry point resolves to: a project
 * reference (id required) or the single global workspace tier. */
export type MemoryScopeRef =
  | { scope: "project"; projectId: string }
  | { scope: "workspace" };

/** Hard cap on a single memory's content (kept well under prompt budgets). */
export const MAX_MEMORY_CONTENT_CHARS = 4_000;

/** Memory row as served by the API. `projectId` is NULL on workspace rows
 * (migration 0042 made the column nullable for exactly that case). */
export interface MemoryItem {
  id: string;
  projectId: string | null;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryInput {
  /** Owning project id — REQUIRED for project scope, ignored (stored NULL)
   * for workspace scope. */
  projectId: string | null;
  /** ROUND-117 (R117-b): the tier this row belongs to (default 'project' —
   * the pre-R117 behavior). */
  scope?: MemoryScope;
  kind?: string;
  content: string;
  /** Who saved it ('agent' for tool calls; the API layer can pass others). */
  source?: string;
}

interface MemoryRow {
  id: string;
  project_id: string | null;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  source: string;
  created_at: string;
  updated_at: string;
}

function toMemory(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    projectId: row.project_id,
    scope: row.scope,
    kind: row.kind,
    content: row.content,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Normalize a MemoryInput into the scope ref + the stored project_id
 * (NULL for workspace rows — the scope owns the truth, a stray projectId
 * on a workspace save is ignored rather than honored). */
function resolveScope(input: MemoryInput): { ref: MemoryScopeRef; projectId: string | null } {
  if (input.scope === "workspace") return { ref: { scope: "workspace" }, projectId: null };
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  return { ref: { scope: "project", projectId }, projectId };
}

/** WHERE fragment + bind params for one scope ref (the shared core's only
 * scope-aware piece — every query below composes it). */
function scopeFilter(ref: MemoryScopeRef): { where: string; params: unknown[] } {
  return ref.scope === "workspace"
    ? { where: "scope = 'workspace'", params: [] }
    : { where: "scope = 'project' AND project_id = ?", params: [ref.projectId] };
}

/* ── ROUND-46 (memory v2): scoring primitives ───────────────────────────── */

/** Importance weight per kind — a durable DECISION outranks a casual note
 * when both compete for the digest's character budget. */
const KIND_WEIGHT: Record<MemoryKind, number> = {
  decision: 1.0,
  fact: 0.8,
  preference: 0.7,
  note: 0.5,
};

/** English stopwords dropped from QUERY tokens (content tokens keep them —
 * only the query side needs noise reduction for overlap scoring). */
const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "to", "of", "in",
  "on", "for", "with", "and", "or", "we", "our", "it", "its", "this", "that",
  "at", "by", "as", "from", "but", "not", "no", "do", "does", "did", "has",
  "have", "had", "will", "can", "should", "use", "used",
]);

/** Lowercase alphanumeric tokens ≥2 chars; stopword-dropped on demand. */
export function tokenizeText(text: string, dropStopwords = false): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  return dropStopwords ? tokens.filter((t) => !STOPWORDS.has(t)) : tokens;
}

/** Recency decay multiplier: fresh memories win ties. Buckets keep this
 * cheap (no clock math per token) and stable across test runs. */
export function recencyMultiplier(updatedAt: string, now = new Date()): number {
  const then = Date.parse(updatedAt);
  if (!Number.isFinite(then)) return 0.7; // unparseable stamp: mid bucket
  const ageDays = (now.getTime() - then) / 86_400_000;
  if (ageDays <= 7) return 1.0;
  if (ageDays <= 30) return 0.85;
  if (ageDays <= 90) return 0.7;
  return 0.55;
}

/** Scored row for searchMemories / ranking internals. */
interface ScoredMemory {
  item: MemoryItem;
  rowid: number;
  score: number;
}

/** Fetch up to `cap` rows of one scope (with rowid for stable tie-breaks). */
function fetchScopeMemories(
  db: SqliteDatabase,
  ref: MemoryScopeRef,
  cap: number,
): Array<MemoryRow & { rowid: number }> {
  const filter = scopeFilter(ref);
  return db
    .prepare(
      `SELECT rowid, * FROM memory WHERE ${filter.where}
       ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
    )
    .all(...filter.params, cap) as Array<MemoryRow & { rowid: number }>;
}

/**
 * Relevance score of one memory against a tokenized query. Content overlap
 * dominates (×2 weight, so ANY content match outranks a kind-only match);
 * the full query appearing as a substring adds a bonus; a kind-token match
 * adds a small boost (keeps the v1 behavior where kind-only rows are still
 * findable); importance×recency breaks ties so durable recent decisions
 * float above stale notes. Returns 0 when nothing matched (caller drops it).
 */
function scoreMemory(queryTokens: string[], fullQueryLower: string, item: MemoryItem, now: Date): number {
  if (queryTokens.length === 0) return 0;
  const contentTokens = new Set(tokenizeText(item.content));
  let matched = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) matched += 1;
  }
  const overlap = matched / queryTokens.length;
  const substringBonus = item.content.toLowerCase().includes(fullQueryLower) ? 0.5 : 0;
  const kindTokens = new Set(tokenizeText(item.kind));
  const kindBoost = queryTokens.some((t) => kindTokens.has(t)) ? 0.3 : 0;
  // Nothing matched at all → drop the row entirely (the importance term is a
  // TIE-BREAKER, never a reason to include a non-matching memory).
  if (matched === 0 && substringBonus === 0 && kindBoost === 0) return 0;
  const importance = KIND_WEIGHT[item.kind] * recencyMultiplier(item.updatedAt, now);
  return overlap * 2 + substringBonus + kindBoost + importance * 0.2;
}

/** Parse + validate a kind; returns undefined for anything not in the enum. */
function parseKind(kind: string | undefined): MemoryKind {
  if (kind === undefined || kind === "") return "note"; // the documented default
  const trimmed = kind.trim().toLowerCase();
  if ((MEMORY_KINDS as readonly string[]).includes(trimmed)) return trimmed as MemoryKind;
  throw new Error(
    `memory kind must be one of ${MEMORY_KINDS.join(" | ")} (got '${kind}')`,
  );
}

/**
 * Insert one memory row — ROUND-46 v2: exact-duplicate content (same scope,
 * case-insensitive trimmed match) BUMPS the existing row's updated_at (and
 * refreshes kind/source) instead of inserting a twin; agents re-saving the
 * same convention no longer pollute recall results. ROUND-117 (R117-b): the
 * dedup key is the SCOPE — a project row and a workspace row with identical
 * content are two different memories. Throws on validation failure (unknown
 * kind, empty content after trimming, content over MAX_MEMORY_CONTENT_CHARS,
 * project scope without a projectId) — callers translate into their own
 * error surface (tools: ok:false; routes: 4xx).
 */
export interface SaveMemoryResult {
  item: MemoryItem;
  /** True when an existing row was refreshed instead of inserted. */
  deduplicated: boolean;
}

export function saveMemoryWithDedup(db: SqliteDatabase, input: MemoryInput): SaveMemoryResult {
  const { ref, projectId } = resolveScope(input);
  if (ref.scope === "project" && (typeof projectId !== "string" || projectId === "")) {
    throw new Error("memory requires a non-empty projectId");
  }
  const kind = parseKind(input.kind);
  const content = input.content.trim();
  if (content === "") throw new Error("memory content must be a non-empty string");
  if (content.length > MAX_MEMORY_CONTENT_CHARS) {
    throw new Error(
      `memory content too long (${content.length} chars, max ${MAX_MEMORY_CONTENT_CHARS}) — split it into multiple memories`,
    );
  }
  const source = (input.source ?? "agent").trim() || "agent";
  const now = new Date().toISOString();

  const filter = scopeFilter(ref);
  const existing = db
    .prepare(
      `SELECT rowid, * FROM memory WHERE ${filter.where} AND LOWER(content) = LOWER(?) LIMIT 1`,
    )
    .get(...filter.params, content) as (MemoryRow & { rowid: number }) | undefined;
  if (existing) {
    db.prepare("UPDATE memory SET kind = ?, source = ?, updated_at = ? WHERE rowid = ?").run(
      kind,
      source,
      now,
      existing.rowid,
    );
    return {
      item: { ...toMemory(existing), kind, source, updatedAt: now },
      deduplicated: true,
    };
  }

  const memory: MemoryItem = {
    id: `mem_${randomUUID()}`,
    projectId,
    scope: ref.scope,
    kind,
    content,
    source,
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO memory (id, project_id, scope, kind, content, source, created_at, updated_at)
     VALUES (@id, @projectId, @scope, @kind, @content, @source, @createdAt, @updatedAt)`,
  ).run(memory);
  return { item: memory, deduplicated: false };
}

/** Compat wrapper: insert-or-refresh, returning just the item. */
export function saveMemory(db: SqliteDatabase, input: MemoryInput): MemoryItem {
  return saveMemoryWithDedup(db, input).item;
}

/** Newest-first listing of a project's memories. `rowid DESC` breaks
 * same-millisecond ties in INSERTION order (agents can save several memories
 * in one burst) — id DESC would tie-break randomly on uuids. */
export function listMemories(db: SqliteDatabase, projectId: string, limit = 100): MemoryItem[] {
  return listScopeMemories(db, { scope: "project", projectId }, limit);
}

/** ROUND-117 (R117-b): newest-first listing of the WORKSPACE tier (the
 * cross-project facts the owner curates via REST). */
export function listWorkspaceMemories(db: SqliteDatabase, limit = 100): MemoryItem[] {
  return listScopeMemories(db, { scope: "workspace" }, limit);
}

function listScopeMemories(db: SqliteDatabase, ref: MemoryScopeRef, limit: number): MemoryItem[] {
  const filter = scopeFilter(ref);
  const rows = db
    .prepare(
      `SELECT * FROM memory WHERE ${filter.where}
       ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
    )
    .all(...filter.params, Math.max(1, Math.min(500, Math.floor(limit)))) as MemoryRow[];
  return rows.map(toMemory);
}

/** Round-46 v2 note: the SQL LIKE pattern helper is gone — ranking is pure
 * in-memory token scoring now; the bounded scope fetch above is the only
 * query the search path needs. */

/**
 * ROUND-46 v2: relevance-ranked search. The scope's rows (bounded to 500,
 * same window the digest sees) are scored in memory: content token overlap
 * dominates, full-substring gets a bonus, kind-token matches stay findable,
 * importance×recency breaks ties. Zero-score rows are dropped. Newest-first
 * within equal scores (then rowid). Empty/whitespace query degrades to the
 * newest-first listing (unchanged contract).
 */
export function searchMemories(
  db: SqliteDatabase,
  projectId: string,
  query: string,
  limit = 12,
): MemoryItem[] {
  return searchScopeMemories(db, { scope: "project", projectId }, query, limit);
}

/** ROUND-117 (R117-b): the workspace twin of searchMemories (same scoring
 * core, the cross-project tier). */
export function searchWorkspaceMemories(
  db: SqliteDatabase,
  query: string,
  limit = 12,
): MemoryItem[] {
  return searchScopeMemories(db, { scope: "workspace" }, query, limit);
}

function searchScopeMemories(
  db: SqliteDatabase,
  ref: MemoryScopeRef,
  query: string,
  limit: number,
): MemoryItem[] {
  const needle = query.trim();
  const cap = Math.max(1, Math.min(50, Math.floor(limit)));
  if (needle === "") return listScopeMemories(db, ref, cap);
  const queryTokens = tokenizeText(needle, true);
  const fullQueryLower = needle.toLowerCase();
  if (queryTokens.length === 0) return listScopeMemories(db, ref, cap);
  const now = new Date();
  const scored: ScoredMemory[] = [];
  for (const row of fetchScopeMemories(db, ref, 500)) {
    const item = toMemory(row);
    const score = scoreMemory(queryTokens, fullQueryLower, item, now);
    if (score > 0) scored.push({ item, rowid: row.rowid, score });
  }
  scored.sort((a, b) => b.score - a.score || a.item.updatedAt.localeCompare(b.item.updatedAt) * -1 || a.rowid - b.rowid);
  return scored.slice(0, cap).map((s) => s.item);
}

/** Delete one memory by id (either scope — the id is global). `{ ok: false,
 * error }` when the id is unknown. */
export function deleteMemory(
  db: SqliteDatabase,
  id: string,
): { ok: true } | { ok: false; error: string } {
  const info = db.prepare("DELETE FROM memory WHERE id = ?").run(id);
  if (info.changes === 0) return { ok: false, error: `no memory with id ${id}` };
  return { ok: true };
}

/* ── ROUND-98 (R98-F1): the owner-facing edit surface ─────────────────────── */

/** Partial-edit patch for updateMemory: both fields optional, at least one
 * required (the ROUTE layer 400s the empty patch; this is the same partial
 * grammar as PUT /settings/*). `kind` follows the save contract (absent or
 * empty → keep the row's current kind; a present value validates through
 * parseKind); `content` follows the save validation exactly (non-empty after
 * trim, ≤ MAX_MEMORY_CONTENT_CHARS). */
export interface UpdateMemoryPatch {
  content?: string;
  kind?: string;
}

/**
 * ROUND-98 (R98-F1, the owner: "implement our proper memory functionality"):
 * partial-edit one memory row — the REST PUT behind the Memory panel's
 * per-row edit (content fixes + kind moves; works for EITHER scope — the
 * id addresses the row). Bumps updated_at so an edited row ranks like a
 * fresh save (recency decay + newest-first listing). Validation is the SAME
 * code path as save (throws the same readable errors); unknown id returns
 * `{ ok: false, error }` — the deleteMemory convention. Note: the memory
 * table has NO importance column (0015) — the kind weight IS the importance
 * model (decision > fact > preference > note, KIND_WEIGHT below), so there
 * is deliberately no importance field to patch.
 */
export function updateMemory(
  db: SqliteDatabase,
  id: string,
  patch: UpdateMemoryPatch,
): { ok: true; item: MemoryItem } | { ok: false; error: string } {
  const row = db.prepare("SELECT rowid, * FROM memory WHERE id = ?").get(id) as
    | (MemoryRow & { rowid: number })
    | undefined;
  if (row === undefined) return { ok: false, error: `no memory with id ${id}` };
  // The same validation the save path runs — an edited row obeys the cap.
  const content = patch.content !== undefined ? patch.content.trim() : row.content;
  if (content === "") throw new Error("memory content must be a non-empty string");
  if (content.length > MAX_MEMORY_CONTENT_CHARS) {
    throw new Error(
      `memory content too long (${content.length} chars, max ${MAX_MEMORY_CONTENT_CHARS}) — split it into multiple memories`,
    );
  }
  // parseKind's absent/empty → "note" default would silently MOVE a row to
  // note on a kind-less patch; only a PRESENT kind may change it.
  const kind = patch.kind !== undefined && patch.kind.trim() !== "" ? parseKind(patch.kind) : row.kind;
  const now = new Date().toISOString();
  db.prepare("UPDATE memory SET kind = ?, content = ?, updated_at = ? WHERE rowid = ?").run(
    kind,
    content,
    now,
    row.rowid,
  );
  return { ok: true, item: { ...toMemory(row), kind, content, updatedAt: now } };
}

/* ── ROUND-117 (R117-b): the digest + its richness-scaled budget ─────────── */

/**
 * The digest budget's step function (R117-b deliverable 5): 1,500 chars
 * when the tier holds few rows (the pre-R117 cap, unchanged), 3,000 when it
 * holds more than 30 — a rich memory base earns a richer slice instead of
 * silently darkening everything past the cap. Simple, deterministic, and
 * applied per scope (a workspace tier with few rows keeps the small
 * budget even when the project tier is rich, and vice versa).
 */
export function digestBudget(rowCount: number): number {
  return rowCount > 30 ? 3_000 : 1_500;
}

/**
 * Compact ranked digest for system-prompt injection (ROUND-46 v2): rows are
 * ordered by importance (kind weight) × recency decay — a durable recent
 * DECISION outranks a stale note — then formatted as "• [kind] content"
 * lines concatenated until the budget is reached. Whole-line granularity —
 * a line that would overflow the cap is dropped cleanly (the model can
 * memory_recall the rest), and a SINGLE line longer than the cap is
 * hard-sliced with an ellipsis. Returns "" when the scope has no memories.
 *
 * ROUND-117 (R117-b): an OMITTED `maxChars` now resolves through
 * digestBudget(row count) — few rows keep the 1,500 default (byte-identical
 * to pre-R117), >30 rows widen to 3,000. An EXPLICIT maxChars still wins
 * (the tests' tiny-budget pins and any future caller keep full control).
 */
export function memoryDigest(db: SqliteDatabase, projectId: string, maxChars?: number): string {
  return scopeDigest(db, { scope: "project", projectId }, maxChars);
}

/** ROUND-117 (R117-b): the WORKSPACE digest — the cross-project tier's
 * ranked slice, same core and same budget step as the project digest. */
export function workspaceMemoryDigest(db: SqliteDatabase, maxChars?: number): string {
  return scopeDigest(db, { scope: "workspace" }, maxChars);
}

function scopeDigest(db: SqliteDatabase, ref: MemoryScopeRef, maxChars?: number): string {
  const now = new Date();
  const rows = fetchScopeMemories(db, ref, 500);
  const budget = maxChars ?? digestBudget(rows.length);
  const ranked = rows
    .map((row) => ({ row, rank: KIND_WEIGHT[row.kind] * recencyMultiplier(row.updated_at, now) }))
    .sort(
      (a, b) =>
        b.rank - a.rank || b.row.updated_at.localeCompare(a.row.updated_at) || b.row.rowid - a.row.rowid,
    );
  const lines: string[] = [];
  let total = 0;
  for (const { row } of ranked) {
    const line = `• [${row.kind}] ${row.content}`;
    // +1 for the "\n" separator that join() will insert before this line.
    const cost = line.length + (lines.length > 0 ? 1 : 0);
    if (total + cost <= budget) {
      lines.push(line);
      total += cost;
      continue;
    }
    // Cap reached: drop this and every later line — unless nothing fit yet
    // (a single memory longer than the whole digest budget gets one slice).
    if (lines.length === 0) {
      lines.push(`${line.slice(0, Math.max(1, budget - 1))}…`);
      total = budget;
    }
    break;
  }
  return lines.join("\n");
}
