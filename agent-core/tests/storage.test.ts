import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

const dir = mkdtempSync(join(tmpdir(), "acute-storage-"));

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: Windows sometimes holds file handles briefly after close.
  }
});

interface AgentRow {
  id: string;
  name: string;
  provider_id: string | null;
  model: string | null;
  allowed_tools: string;
  memory_policy: string;
  max_turns: number;
  temperature: number;
  version: number;
  is_template: number;
}

function templateRows(db: SqliteDatabase): AgentRow[] {
  return db
    .prepare("SELECT * FROM agents WHERE is_template = 1 ORDER BY name ASC")
    .all() as AgentRow[];
}

describe("openDatabase", () => {
  it("runs in WAL mode", () => {
    const db = openDatabase(join(dir, "wal.db"));
    try {
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    } finally {
      db.close();
    }
  });

  it("creates the full schema v1 table set", () => {
    const db = openDatabase(join(dir, "schema.db"));
    try {
      const tables = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as { name: string }[]
      ).map((row) => row.name);
      expect(tables).toEqual(
        expect.arrayContaining([
          "agents",
          "providers",
          "sessions",
          "session_events",
          "usage_events",
          "approvals",
          "audit_log",
          "settings",
          "schema_migrations",
        ]),
      );
      const sessionColumns = (
        db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]
      ).map((column) => column.name);
      expect(sessionColumns).toContain("agent_id");
    } finally {
      db.close();
    }
  });

  it("keeps a per-session monotonic seq on the append-only event log", () => {
    const db = openDatabase(join(dir, "events.db"));
    try {
      const insert = db.prepare(
        "INSERT INTO session_events (session_id, seq, type, payload, ts) VALUES (?, ?, ?, ?, ?)",
      );
      const now = new Date().toISOString();
      insert.run("sess_a", 1, "message.user", "{}", now);
      insert.run("sess_a", 2, "message.assistant", "{}", now);
      insert.run("sess_b", 1, "message.user", "{}", now);
      // The UNIQUE (session_id, seq) constraint rejects seq reuse within a session…
      expect(() => insert.run("sess_a", 2, "message.user", "{}", now)).toThrow();
      // …while other sessions carry their own counters.
      expect(() => insert.run("sess_b", 2, "message.user", "{}", now)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("applies migrations idempotently (reopen does not re-apply or fail)", () => {
    const path = join(dir, "idempotent.db");
    const first = openDatabase(path);
    const appliedFirst = first
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all() as { version: number; name: string }[];
    first.close();

    const second = openDatabase(path);
    const appliedSecond = second
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all() as { version: number; name: string }[];
    second.close();

    expect(appliedFirst).toEqual([
      { version: 1, name: "0001_init.sql" },
      { version: 2, name: "0002_sessions_usage.sql" },
      { version: 3, name: "0003_projects.sql" },
    ]);
    expect(appliedSecond).toEqual(appliedFirst);
  });
});

describe("template seeding", () => {
  it("seeds the five templates with the agreed defaults on first run", () => {
    const db = openDatabase(join(dir, "seed.db"));
    try {
      const rows = templateRows(db);
      expect(rows).toHaveLength(5);
      expect(rows.map((row) => row.name)).toEqual([
        "Coder",
        "Planner",
        "Researcher",
        "Reviewer",
        "Tester",
      ]);
      for (const row of rows) {
        expect(row.id).toMatch(/^agt_tpl_/);
        expect(row.provider_id).toBeNull();
        expect(row.model).toBeNull();
        expect(JSON.parse(row.allowed_tools)).toEqual([
          "file_read",
          "file_write",
          "file_edit",
          "shell_exec",
          "web_search",
        ]);
        expect(row.memory_policy).toBe("on-start");
        expect(row.max_turns).toBe(40);
        expect(row.temperature).toBe(0.2);
        expect(row.version).toBe(1);
      }
    } finally {
      db.close();
    }
  });

  it("seeds exactly once across reopens (no duplicates)", () => {
    const path = join(dir, "seed-once.db");
    openDatabase(path).close();
    const db = openDatabase(path);
    try {
      expect(templateRows(db)).toHaveLength(5);
      const { total } = db.prepare("SELECT COUNT(*) AS total FROM agents").get() as {
        total: number;
      };
      // 5 templates + the round-15 plug-and-play default agent (Nova).
      expect(total).toBe(6);
    } finally {
      db.close();
    }
  });
});
