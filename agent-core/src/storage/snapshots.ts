/**
 * File snapshots (round-25): checkpoint system for agent mutations.
 * Every write/edit/delete stores the before+after content so any agent
 * action can be reverted. Simpler than git-backed snapshots (no git
 * dependency, BLOB storage in SQLite).
 */
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SqliteDatabase } from "../storage/db.js";

export interface FileSnapshot {
  id: string;
  sessionId: string;
  seq: number;
  path: string;
  beforeContent: string | null;
  afterContent: string | null;
  toolName: string;
  ts: string;
}

interface SnapshotRow {
  id: string;
  session_id: string;
  seq: number;
  path: string;
  before_content: Buffer | null;
  after_content: Buffer | null;
  tool_name: string;
  ts: string;
}

function toSnapshot(row: SnapshotRow): FileSnapshot {
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    path: row.path,
    beforeContent: row.before_content ? row.before_content.toString("utf8") : null,
    afterContent: row.after_content ? row.after_content.toString("utf8") : null,
    toolName: row.tool_name,
    ts: row.ts,
  };
}

export function recordSnapshot(
  db: SqliteDatabase,
  input: {
    sessionId: string;
    seq: number;
    path: string;
    beforeContent: string | null;
    afterContent: string | null;
    toolName: string;
  },
): FileSnapshot {
  const id = `snap_${randomUUID()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO file_snapshots (id, session_id, seq, path, before_content, after_content, tool_name, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.sessionId,
    input.seq,
    input.path,
    input.beforeContent,
    input.afterContent,
    input.toolName,
    now,
  );
  return { id, ...input, ts: now };
}

export function listSnapshots(db: SqliteDatabase, sessionId: string): FileSnapshot[] {
  const rows = db
    .prepare("SELECT * FROM file_snapshots WHERE session_id = ? ORDER BY seq DESC")
    .all(sessionId) as SnapshotRow[];
  return rows.map(toSnapshot);
}

/** Restore a snapshot: write the 'before' content back (or delete if before=NULL). */
export function restoreSnapshot(
  db: SqliteDatabase,
  snapshotId: string,
  rootPath: string,
): { ok: boolean; message: string } {
  const row = db
    .prepare("SELECT * FROM file_snapshots WHERE id = ?")
    .get(snapshotId) as SnapshotRow | undefined;
  if (!row) return { ok: false, message: "snapshot not found" };

  const absPath = join(rootPath, row.path);

  try {
    if (row.before_content === null) {
      // File was created by the agent → delete it
      if (existsSync(absPath)) {
        unlinkSync(absPath);
        return { ok: true, message: `deleted ${row.path} (file was created by the agent)` };
      }
      return { ok: true, message: `${row.path} already removed` };
    } else {
      // Restore the before content
      writeFileSync(absPath, row.before_content);
      return { ok: true, message: `restored ${row.path} to previous content` };
    }
  } catch (error) {
    return { ok: false, message: `restore failed: ${error instanceof Error ? error.message : "unknown"}` };
  }
}
