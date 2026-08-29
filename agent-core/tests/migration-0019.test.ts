/**
 * ROUND-49: migration 0019 — the migration-damage repair.
 *
 * Migrations 0014 + 0015 appended delegate_task / browser_control /
 * memory_* to `(is_template = 1 OR id = 'agt_default_nova')` rows "when
 * missing" — but the DEFAULT agent is seeded with allowed_tools = '[]'
 * (= "ALL tools" per ADR-0019), so the appends turned that semantic into an
 * EXPLICIT allowlist of exactly the five appended tools. Every install's
 * default "Acute" agent lost its entire project tool set; both the main
 * agent and its sub-agent children (children run the parent's agent row)
 * honestly reported "I have no file tools" — the owner's round-48 Windows
 * test hit exactly this.
 *
 * 0019 resets the fingerprint-damaged row back to '[]'. The fingerprint:
 * non-empty AND every entry ∈ the five tools the damaging migrations could
 * append. Any list that also contains a real project tool is a deliberate
 * owner restriction and must survive; template rows are never touched.
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

/** Applies migrations 0001..0018 by hand — simulates a pre-R49 install. */
function openPreR49Database(path: string): SqliteDatabase {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const migrationsDir = fileURLToPath(new URL("../src/storage/migrations", import.meta.url));
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) <= 18)
    .sort((a, b) => Number(a.slice(0, 4)) - Number(b.slice(0, 4)));
  expect(files).toHaveLength(18);
  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const file of files) {
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
    insert.run(Number(file.slice(0, 4)), file, new Date().toISOString());
  }
  return db;
}

interface AgentToolsRow {
  id: string;
  allowed_tools: string;
}

describe("migration 0019 (default-agent allowlist repair)", () => {
  it("resets a migration-damaged default agent to [] (= ALL tools); deliberate restrictions and templates untouched; idempotent", () => {
    tempDir = mkdtempSync(join(tmpdir(), "acute-m0019-"));
    const path = join(tempDir, `m0019-${randomUUID()}.db`);
    const old = openPreR49Database(path);

    // The DAMAGE exactly as 0014+0015 produced it from '[]':
    const damaged = JSON.stringify([
      "delegate_task",
      "browser_control",
      "memory_save",
      "memory_recall",
      "memory_list",
    ]);
    // A PARTIAL variant (the 0014-only intermediate state) — same fingerprint.
    const partial = JSON.stringify(["delegate_task", "browser_control"]);
    // A deliberate owner restriction (real project tools) — must survive.
    const deliberate = JSON.stringify(["read_file", "write_file", "list_dir"]);
    // The repaired state already — stays untouched.
    const alreadyEmpty = "[]";
    // Real old installs HAVE the default agent row (seeded by an earlier
    // openDatabase with [] and narrowed by 0014+0015); hand-insert it in the
    // damaged state (ensureDefaultAgent would skip seeding while other
    // non-template agents exist).
    const ins = old.prepare(
      `INSERT INTO agents (id, name, role, system_prompt, provider_id, model, vision_model,
        allowed_tools, memory_policy, skills, max_turns, max_outer_loops, temperature,
        version, is_template, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'none', '[]', 80, 5, 0.2, 1, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    ins.run(
      "agt_default_nova", "Acute", "coder", "prompt", "openrouter", "test/model",
      damaged, 0, now, now,
    );
    // Other non-template agents with the damaged-looking fingerprint: 0019
    // scopes the repair to the DEFAULT agent only — a user-created agent
    // with this list is (however unluckily) their authored choice.
    ins.run("agt_user_damaged", "User Damaged", "", "", null, null, damaged, 0, now, now);
    ins.run("agt_user_deliberate", "User Deliberate", "", "", null, null, deliberate, 0, now, now);
    old.close();

    // Reopen with the current code: 0019 applies inside openDatabase.
    const db2 = openDatabase(path);
    try {
      const toolsOf = (id: string): string =>
        (db2.prepare("SELECT allowed_tools FROM agents WHERE id = ?").get(id) as AgentToolsRow)
          .allowed_tools;
      // The damaged default agent is REPAIRED to [] (= ALL tools).
      expect(toolsOf("agt_default_nova")).toBe(alreadyEmpty);
      // A user-created agent with the same fingerprint is NOT touched
      // (deliberately authored, even if it looks like the damage).
      expect(toolsOf("agt_user_damaged")).toBe(damaged);
      // A deliberate restriction survives.
      expect(toolsOf("agt_user_deliberate")).toBe(deliberate);
      // Templates keep whatever 0014/0015 left them (full seed list).
      const tpl = db2
        .prepare("SELECT allowed_tools FROM agents WHERE id = 'agt_tpl_coder'")
        .get() as AgentToolsRow;
      const tplTools = JSON.parse(tpl.allowed_tools) as string[];
      expect(tplTools).toContain("write_file");
      expect(tplTools).toContain("delegate_task");

      // Audit row (shared pattern with 0013/0014/0015/0018).
      const audit = db2
        .prepare("SELECT actor, action FROM audit_log WHERE actor = 'migration-0019' LIMIT 1")
        .get() as { actor: string; action: string };
      expect(audit).toEqual({ actor: "migration-0019", action: "agent.tools.repair" });

      // Idempotent: reopen again — no re-application, state unchanged.
      db2.close();
      const db3 = openDatabase(path);
      try {
        expect(
          (db3.prepare("SELECT allowed_tools FROM agents WHERE id = 'agt_default_nova'").get() as AgentToolsRow)
            .allowed_tools,
        ).toBe(alreadyEmpty);
        const auditCount = (
          db3.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE actor = 'migration-0019'").get() as {
            n: number;
          }
        ).n;
        expect(auditCount).toBe(1);
      } finally {
        db3.close();
      }
    } finally {
      // db2 was closed above before reopening; ensure closed on failure paths.
      try {
        db2.close();
      } catch {
        /* already closed */
      }
    }

    // The partial variant (0014-only intermediate state) ALSO repairs.
    const path2 = join(tempDir, `m0019b-${randomUUID()}.db`);
    const old2 = openPreR49Database(path2);
    old2
      .prepare(
        `INSERT INTO agents (id, name, role, system_prompt, provider_id, model, vision_model,
          allowed_tools, memory_policy, skills, max_turns, max_outer_loops, temperature,
          version, is_template, created_at, updated_at)
         VALUES ('agt_default_nova', 'Acute', 'coder', 'prompt', 'openrouter', 'test/model',
          NULL, ?, 'none', '[]', 80, 5, 0.2, 1, 0, ?, ?)`,
      )
      .run(partial, now, now);
    old2.close();
    const db4 = openDatabase(path2);
    try {
      expect(
        (db4.prepare("SELECT allowed_tools FROM agents WHERE id = 'agt_default_nova'").get() as AgentToolsRow)
          .allowed_tools,
      ).toBe(alreadyEmpty);
    } finally {
      db4.close();
    }
  });
});
