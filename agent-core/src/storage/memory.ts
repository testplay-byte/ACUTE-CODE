/**
 * Project memory repository (ROUND-44, R44-a — owner directive "complete
 * the agentic coding environment"). Agents forgot everything between
 * turns/sessions; this table is the persistent, per-project knowledge base
 * the agent writes via the memory_save tool and reads back via
 * memory_recall / memory_list / the system-prompt digest.
 *
 * The ONLY SQL for memory lives here (anti-drift rule, same as every other
 * storage module). Validation is code-side (not SQL) so the tool layer can
 * return readable errors instead of raw SQLite exceptions.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;

/** The four memory kinds (mirrors the 0015 CHECK constraint). */
export type MemoryKind = "fact" | "decision" | "preference" | "note";

export const MEMORY_KINDS: readonly MemoryKind[] = ["fact", "decision", "preference", "note"];

/** Hard cap on a single memory's content (kept well under prompt budgets). */
export const MAX_MEMORY_CONTENT_CHARS = 4_000;

/** Memory row as served by the API. */
export interface MemoryItem {
  id: string;
  projectId: string;
  kind: MemoryKind;
  content: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryInput {
  projectId: string;
  kind?: string;
  content: string;
  /** Who saved it ('agent' for tool calls; the API layer can pass others). */
  source?: string;
}

interface MemoryRow {
  id: string;
  project_id: string;
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
    kind: row.kind,
    content: row.content,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
 * Insert one memory row. Throws on validation failure (unknown kind, empty
 * content after trimming, content over MAX_MEMORY_CONTENT_CHARS) — callers
 * translate into their own error surface (tools: ok:false; routes: 4xx).
 * `updated_at` is bumped to now (the table carries both stamps so a future
 * edit-in-place feature needs no schema change).
 */
export function saveMemory(db: SqliteDatabase, input: MemoryInput): MemoryItem {
  const projectId = input.projectId.trim();
  if (projectId === "") throw new Error("memory requires a non-empty projectId");
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
  const memory: MemoryItem = {
    id: `mem_${randomUUID()}`,
    projectId,
    kind,
    content,
    source,
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO memory (id, project_id, kind, content, source, created_at, updated_at)
     VALUES (@id, @projectId, @kind, @content, @source, @createdAt, @updatedAt)`,
  ).run(memory);
  return memory;
}

/** Newest-first listing of a project's memories. `rowid DESC` breaks
 * same-millisecond ties in INSERTION order (agents can save several memories
 * in one burst) — id DESC would tie-break randomly on uuids. */
export function listMemories(db: SqliteDatabase, projectId: string, limit = 100): MemoryItem[] {
  const rows = db
    .prepare(
      `SELECT * FROM memory WHERE project_id = ?
       ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
    )
    .all(projectId, Math.max(1, Math.min(500, Math.floor(limit)))) as MemoryRow[];
  return rows.map(toMemory);
}

/** Escape SQL LIKE wildcards so user queries match literally. */
function likePattern(needle: string): string {
  return `%${needle.replaceAll(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Substring search over content + kind (case-insensitive — SQLite's LIKE is
 * ASCII-case-insensitive). Ranking: rows whose CONTENT contains the query
 * first, then rows where only the KIND matched; newest first within each
 * tier. Returns at most `limit` rows.
 */
export function searchMemories(
  db: SqliteDatabase,
  projectId: string,
  query: string,
  limit = 12,
): MemoryItem[] {
  const needle = query.trim();
  if (needle === "") return listMemories(db, projectId, limit);
  const pattern = likePattern(needle);
  const rows = db
    .prepare(
      `SELECT * FROM memory
       WHERE project_id = ? AND (content LIKE ? ESCAPE '\\' OR kind LIKE ? ESCAPE '\\')
       ORDER BY (content LIKE ? ESCAPE '\\') DESC, updated_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(projectId, pattern, pattern, pattern, Math.max(1, Math.min(50, Math.floor(limit)))) as MemoryRow[];
  return rows.map(toMemory);
}

/** Delete one memory by id. `{ ok: false, error }` when the id is unknown. */
export function deleteMemory(
  db: SqliteDatabase,
  id: string,
): { ok: true } | { ok: false; error: string } {
  const info = db.prepare("DELETE FROM memory WHERE id = ?").run(id);
  if (info.changes === 0) return { ok: false, error: `no memory with id ${id}` };
  return { ok: true };
}

/**
 * Compact newest-first digest for system-prompt injection: "• [kind]
 * content" lines concatenated until `maxChars` is reached. Whole-line
 * granularity — a line that would overflow the cap is dropped cleanly (the
 * model can memory_recall the rest), and a SINGLE line longer than the cap
 * is hard-sliced with an ellipsis. Returns "" when the project has no
 * memories (callers skip the prompt section entirely).
 */
export function memoryDigest(db: SqliteDatabase, projectId: string, maxChars = 1_500): string {
  const rows = listMemories(db, projectId, 500);
  const lines: string[] = [];
  let total = 0;
  for (const row of rows) {
    const line = `• [${row.kind}] ${row.content}`;
    // +1 for the "\n" separator that join() will insert before this line.
    const cost = line.length + (lines.length > 0 ? 1 : 0);
    if (total + cost <= maxChars) {
      lines.push(line);
      total += cost;
      continue;
    }
    // Cap reached: drop this and every later line — unless nothing fit yet
    // (a single memory longer than the whole digest budget gets one slice).
    if (lines.length === 0) {
      lines.push(`${line.slice(0, Math.max(1, maxChars - 1))}…`);
      total = maxChars;
    }
    break;
  }
  return lines.join("\n");
}
