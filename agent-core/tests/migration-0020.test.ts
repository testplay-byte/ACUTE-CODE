/**
 * ROUND-50 (R50-c1): migration 0020 — the composer backend's two additive
 * columns. Simulates a pre-R50 install (migrations 0001..0019 applied by
 * hand, rows already living in sessions + usage_events) and reopens with the
 * current code: 0020 must add
 *   sessions.permission_mode       TEXT NOT NULL DEFAULT 'ask'
 *   usage_events.cached_input_tokens INTEGER (nullable)
 * and existing rows must read back with the fail-closed defaults ('ask' / no
 * cached value) — EXACTLY the pre-R50 behavior.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

let tempDir = "";

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort (Windows file-handle lag)
  }
});

/** Applies migrations 0001..0019 by hand — simulates a pre-R50 install. */
function openPreR50Database(path: string): SqliteDatabase {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const migrationsDir = fileURLToPath(new URL("../src/storage/migrations", import.meta.url));
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) <= 19)
    .sort((a, b) => Number(a.slice(0, 4)) - Number(b.slice(0, 4)));
  expect(files).toHaveLength(19);
  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const file of files) {
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
    insert.run(Number(file.slice(0, 4)), file, new Date().toISOString());
  }
  return db;
}

describe("migration 0020 (permission modes + cached input tokens)", () => {
  it("adds permission_mode ('ask' default) + cached_input_tokens (nullable) to a pre-R50 database, idempotently", () => {
    tempDir = mkdtempSync(join(tmpdir(), "acute-m0020-"));
    const path = join(tempDir, `m0020-${randomUUID()}.db`);
    const old = openPreR50Database(path);

    // A living pre-R50 session + usage row (the exact shapes round-49 wrote).
    const now = new Date().toISOString();
    old.prepare(
      `INSERT INTO sessions (id, project_id, agent_id, mode, status, title, created_at, updated_at)
       VALUES ('sess_pre_r50', NULL, 'agt_default_nova', 'single', 'queued', NULL, ?, ?)`,
    ).run(now, now);
    old.prepare(
      `INSERT INTO usage_events (agent_id, session_id, provider, model, input_tokens, output_tokens, cost_usd, ts)
       VALUES ('agt_default_nova', 'sess_pre_r50', 'openrouter', 'test/model', 100, 20, 0.01, ?)`,
    ).run(now);
    old.close();

    // Reopen with the current code: 0020 applies inside openDatabase.
    const db = openDatabase(path);
    try {
      // Column added, existing row reads the fail-closed default 'ask'.
      const sessionRow = db
        .prepare("SELECT permission_mode FROM sessions WHERE id = 'sess_pre_r50'")
        .get() as { permission_mode: string };
      expect(sessionRow.permission_mode).toBe("ask");

      // NOT NULL + DEFAULT 'ask' enforced at the SQL level for new rows.
      const info = db
        .prepare(
          `INSERT INTO sessions (id, project_id, agent_id, mode, status, title, created_at, updated_at)
           VALUES ('sess_migrated_new', NULL, NULL, 'single', 'queued', NULL, ?, ?)`,
        )
        .run(now, now);
      expect(info.changes).toBe(1);
      const fresh = db
        .prepare("SELECT permission_mode FROM sessions WHERE id = 'sess_migrated_new'")
        .get() as { permission_mode: string };
      expect(fresh.permission_mode).toBe("ask");

      // usage_events.cached_input_tokens exists and is NULL-safe: the
      // pre-0020 row reads NULL, a new row can store a number.
      const usageRow = db
        .prepare("SELECT cached_input_tokens FROM usage_events WHERE session_id = 'sess_pre_r50'")
        .get() as { cached_input_tokens: number | null };
      expect(usageRow.cached_input_tokens).toBeNull();
      db.prepare(
        `INSERT INTO usage_events (agent_id, session_id, provider, model, input_tokens, output_tokens, cached_input_tokens, cost_usd, ts)
         VALUES ('a', 'sess_pre_r50', 'openrouter', 'test/model', 50000, 0, 41000, 0, ?)`,
      ).run(now);
      const summed = db
        .prepare(
          "SELECT COALESCE(SUM(cached_input_tokens), 0) AS s FROM usage_events WHERE session_id = 'sess_pre_r50'",
        )
        .get() as { s: number };
      expect(summed.s).toBe(41000); // NULL rows contribute 0

      // The migration is registered…
      const applied = db
        .prepare("SELECT version, name FROM schema_migrations WHERE version = 20")
        .get() as { version: number; name: string };
      expect(applied).toEqual({ version: 20, name: "0020_permission_modes_attachments.sql" });

      // …and has the shared audit-trail row.
      const audit = db
        .prepare("SELECT actor FROM audit_log WHERE actor = 'migration-0020'")
        .get() as { actor: string } | undefined;
      expect(audit?.actor).toBe("migration-0020");
    } finally {
      db.close();
    }

    // Idempotent: reopening does not re-apply or fail.
    const again = openDatabase(path);
    const count = again
      .prepare("SELECT COUNT(*) AS c FROM schema_migrations WHERE version = 20")
      .get() as { c: number };
    expect(count.c).toBe(1);
    again.close();
  });
});
