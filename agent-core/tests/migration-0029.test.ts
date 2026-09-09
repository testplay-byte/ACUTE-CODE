// @vitest-environment node
//
// ROUND-81 (R81, the unified mode picker): migration 0029 — the data-only
// mapping that keeps the R75 read-only guarantee after enforcement moves
// entirely to the permission tier (ADR-0029):
//   · permission_mode 'editor' → 'ask' (fail-closed: editor had no terminal;
//     ask is the only mode that still gates commands — nothing widens).
//   · active_mode IN ('plan','review','explore') → permission_mode 'plan'
//     (under R75 those postures were HARD read-only regardless of the
//     permission mode; the owner wanted read-only, so we err read-only).
//   · active_mode itself is KEPT (the non-enforcing posture pointer).
//   · Working postures (debug/build/refactor/custom/NULL) keep their
//     permission_mode verbatim.
// Idempotent on reopen; audit row written.
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
    if (tempDir !== "") rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort (Windows file-handle lag) */
  }
});

/** Applies migrations 0001..0028 by hand — simulates a pre-R81 install. */
function openPreR81Database(path: string): SqliteDatabase {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const migrationsDir = fileURLToPath(new URL("../src/storage/migrations", import.meta.url));
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) <= 28)
    .sort((a, b) => Number(a.slice(0, 4)) - Number(b.slice(0, 4)));
  expect(files).toHaveLength(28);
  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const file of files) {
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
    insert.run(Number(file.slice(0, 4)), file, new Date().toISOString());
  }
  return db;
}

interface ModeRow {
  id: string;
  permission_mode: string;
  active_mode: string | null;
}

describe("migration 0029 (unified operating modes)", () => {
  it("maps editor→ask, read-only postures→plan, keeps active_mode; idempotent", () => {
    tempDir = mkdtempSync(join(tmpdir(), "acute-m0029-"));
    const path = join(tempDir, `m0029-${randomUUID()}.db`);
    const old = openPreR81Database(path);

    // Pre-R81 sessions across the full (permission × active_mode) grid.
    const now = new Date().toISOString();
    const insert = old.prepare(
      `INSERT INTO sessions (id, project_id, agent_id, mode, status, title,
         permission_mode, active_mode, created_at, updated_at)
       VALUES (?, NULL, 'agt_default_nova', 'single', 'queued', NULL, ?, ?, ?, ?)`,
    );
    insert.run("sess_editor_null", "editor", null, now, now);
    insert.run("sess_editor_plan", "editor", "plan", now, now);
    insert.run("sess_full_null", "full", null, now, now);
    insert.run("sess_full_build", "full", "build", now, now);
    insert.run("sess_full_review", "full", "review", now, now);
    insert.run("sess_full_explore", "full", "explore", now, now);
    insert.run("sess_full_debug", "full", "debug", now, now);
    insert.run("sess_ask_plan", "ask", "plan", now, now);
    insert.run("sess_ask_refactor", "ask", "refactor", now, now);
    insert.run("sess_ask_custom", "ask", "audit-hardening", now, now);
    insert.run("sess_plan_plan", "plan", "plan", now, now);
    insert.run("sess_plan_build", "plan", "build", now, now);
    old.close();

    // Reopen with the current code: 0029 applies inside openDatabase.
    const db = openDatabase(path);
    try {
      const rows = (db.prepare("SELECT id, permission_mode, active_mode FROM sessions").all() as ModeRow[])
        .sort((a, b) => a.id.localeCompare(b.id));
      const byId = new Map(rows.map((r) => [r.id, r]));

      // editor → ask (fail-closed) — the retired value never survives.
      expect(byId.get("sess_editor_null")).toMatchObject({ permission_mode: "ask", active_mode: null });
      expect(byId.get("sess_editor_plan")).toMatchObject({ permission_mode: "plan", active_mode: "plan" });

      // Read-only R75 postures → plan, whatever the permission mode was.
      expect(byId.get("sess_full_review")).toMatchObject({ permission_mode: "plan", active_mode: "review" });
      expect(byId.get("sess_full_explore")).toMatchObject({ permission_mode: "plan", active_mode: "explore" });
      expect(byId.get("sess_ask_plan")).toMatchObject({ permission_mode: "plan", active_mode: "plan" });

      // Working postures keep their permission_mode verbatim.
      expect(byId.get("sess_full_null")).toMatchObject({ permission_mode: "full", active_mode: null });
      expect(byId.get("sess_full_build")).toMatchObject({ permission_mode: "full", active_mode: "build" });
      expect(byId.get("sess_full_debug")).toMatchObject({ permission_mode: "full", active_mode: "debug" });
      expect(byId.get("sess_ask_refactor")).toMatchObject({ permission_mode: "ask", active_mode: "refactor" });
      expect(byId.get("sess_ask_custom")).toMatchObject({ permission_mode: "ask", active_mode: "audit-hardening" });
      expect(byId.get("sess_plan_plan")).toMatchObject({ permission_mode: "plan", active_mode: "plan" });
      expect(byId.get("sess_plan_build")).toMatchObject({ permission_mode: "plan", active_mode: "build" });

      // active_mode is KEPT everywhere (the posture pointer rides the row).
      for (const row of rows) {
        if (row.id === "sess_editor_null" || row.id === "sess_full_null") {
          expect(row.active_mode).toBeNull();
        } else {
          expect(typeof row.active_mode).toBe("string");
        }
      }

      // The bookkeeping + audit row landed.
      const version = db
        .prepare("SELECT version, name FROM schema_migrations WHERE version = 29")
        .get() as { version: number; name: string };
      expect(version.version).toBe(29);
      expect(version.name).toContain("0029_unified_modes");
      const audit = db
        .prepare("SELECT actor, action FROM audit_log WHERE actor = 'migration-0029'")
        .get() as { actor: string; action: string };
      expect(audit.actor).toBe("migration-0029");
      expect(audit.action).toBe("session.mode.unify");

      // Idempotent: a second reopen matches zero rows, nothing changes.
      const rowsSnapshot = rows.map(({ id, permission_mode }) => ({ id, permission_mode }));
      db.close();
      const again = openDatabase(path);
      try {
        const after = (again.prepare("SELECT id, permission_mode FROM sessions").all() as ModeRow[])
          .sort((a, b) => a.id.localeCompare(b.id));
        expect(after).toEqual(rowsSnapshot);
      } finally {
        again.close();
      }
    } finally {
      try {
        db.close();
      } catch {
        /* already closed by the idempotency block */
      }
    }
  });
});
