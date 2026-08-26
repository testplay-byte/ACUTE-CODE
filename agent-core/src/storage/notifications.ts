/**
 * ROUND-40 (owner: "add notification functionality"). Persistent app-level
 * notifications: task complete/failed, permission requests, sub-agent
 * transitions. Pure SQLite — no in-memory cache. The in-process pub/sub bus
 * (../lib/notification-bus.ts) calls createNotification() AND notifies live
 * SSE subscribers; the REST routes below are the read/mark-read surface.
 */
import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./db.js";

export type NotificationKind =
  | "task_complete"
  | "task_failed"
  | "permission_request"
  | "subagent_queued"
  | "subagent_running"
  | "subagent_complete"
  | "subagent_failed";

/** Input shape for creating a notification (the bus publishes these). */
export interface NotificationInput {
  kind: NotificationKind;
  title: string;
  body?: string;
  sessionId?: string;
  projectId?: string;
}

/** Stored record (what the REST API returns). */
export interface NotificationRecord {
  id: string;
  ts: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  sessionId: string | null;
  projectId: string | null;
  read: 0 | 1;
}

interface NotificationRow {
  id: string;
  ts: string;
  kind: string;
  title: string;
  body: string | null;
  session_id: string | null;
  project_id: string | null;
  read: number;
}

function toRecord(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    ts: row.ts,
    kind: row.kind as NotificationKind,
    title: row.title,
    body: row.body,
    sessionId: row.session_id,
    projectId: row.project_id,
    read: row.read === 1 ? 1 : 0,
  };
}

/** Insert + return the new record. Caller (the bus) notifies subscribers. */
export function createNotification(
  db: SqliteDatabase,
  input: NotificationInput,
): NotificationRecord {
  const id = `ntf_${randomUUID()}`;
  const ts = new Date().toISOString();
  db.prepare(
    `INSERT INTO notifications (id, ts, kind, title, body, session_id, project_id, read)
     VALUES (@id, @ts, @kind, @title, @body, @sessionId, @projectId, 0)`,
  ).run({
    id,
    ts,
    kind: input.kind,
    title: input.title,
    body: input.body ?? null,
    sessionId: input.sessionId ?? null,
    projectId: input.projectId ?? null,
  });
  return {
    id,
    ts,
    kind: input.kind,
    title: input.title,
    body: input.body ?? null,
    sessionId: input.sessionId ?? null,
    projectId: input.projectId ?? null,
    read: 0,
  };
}

/** List notifications, newest first. unreadOnly=true filters to unread. */
export function listNotifications(
  db: SqliteDatabase,
  opts?: { unreadOnly?: boolean; limit?: number },
): NotificationRecord[] {
  const limit = Math.min(opts?.limit ?? 50, 200);
  const where = opts?.unreadOnly ? "WHERE read = 0 " : "";
  const rows = db
    .prepare(`${where.length > 0 ? `SELECT * FROM notifications ${where}` : "SELECT * FROM notifications"} ORDER BY ts DESC LIMIT ?`)
    .all(limit) as NotificationRow[];
  return rows.map(toRecord);
}

/** Mark a single notification read. No-op if not found / already read. */
export function markNotificationRead(db: SqliteDatabase, id: string): boolean {
  const result = db.prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(id);
  return result.changes > 0;
}

/** Mark every unread notification read. Returns the count updated. */
export function markAllNotificationsRead(db: SqliteDatabase): number {
  const result = db.prepare("UPDATE notifications SET read = 1 WHERE read = 0").run();
  return result.changes;
}

/** Unread count (for the bell badge). */
export function countUnreadNotifications(db: SqliteDatabase): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM notifications WHERE read = 0")
    .get() as { c: number };
  return row.c;
}
