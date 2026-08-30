// @vitest-environment node
//
// ROUND-52 (R52-a): migration 0021 — job_status + job_stop appended to
// template/default allowlists that include run_command.
//
// Scope rules under test (the lessons of 0014/0019 baked in):
//   · '[]' rows mean ALL tools (ADR-0019) — NEVER appended (0019's damage).
//   · Only template rows + agt_default_nova are touched (0014's curation
//     respect) — user agents keep deliberately-authored lists verbatim.
//   · Within that scope, a row whose allowlist lacks run_command gets
//     nothing (job tools are companions to run_command).
//   · Idempotent on reopen.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/storage/db";

let tempDir = "";

afterAll(() => {
  try {
    if (tempDir !== "") rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** A pre-R52 database: full schema through 0020, agent rows hand-seeded. */
function openPreR52Database(path: string): Database.Database {
  const db = openDatabase(path); // applies everything INCLUDING 0021
  // Simulate the pre-0021 world: drop the 0021 bookkeeping + the audit row,
  // and reset the seeded rows to the shapes under test.
  db.prepare("DELETE FROM schema_migrations WHERE version = 21").run();
  db.prepare("DELETE FROM audit_log WHERE actor = 'migration-0021'").run();
  db.prepare("DELETE FROM agents").run();
  return db;
}

describe("migration 0021 (background-job tools append)", () => {
  it("appends job tools to template/default rows with run_command; [] rows, run-command-less rows, and user curation untouched; idempotent", () => {
    tempDir = mkdtempSync(join(tmpdir(), "acute-m0021-"));
    const path = join(tempDir, `m0021-${randomUUID()}.db`);
    const old = openPreR52Database(path);
    const now = new Date().toISOString();

    const ins = old.prepare(
      `INSERT INTO agents (id, name, role, system_prompt, provider_id, model, vision_model,
        allowed_tools, memory_policy, skills, max_turns, max_outer_loops, temperature,
        version, is_template, created_at, updated_at)
       VALUES (?, 'X', 'coder', '', 'openrouter', 'z-ai/glm-5.2:free', NULL, ?, 'none', '[]', 40, 5, 0.2, 1, ?, ?, ?)`,
    );
    const withRun = JSON.stringify([
      "list_dir", "read_file", "write_file", "run_command", "memory_save",
    ]);
    const noRun = JSON.stringify(["read_file", "write_file", "list_dir"]);
    // A USER agent whose list includes run_command — deliberately authored;
    // 0014's convention says user rows are never widened.
    const userWithRun = JSON.stringify(["run_command", "read_file"]);

    ins.run("agt_tpl_coder", withRun, 1, now, now);   // template, has run_command → +2
    ins.run("agt_default_nova", "[]", 0, now, now);   // [] = ALL tools → untouched
    ins.run("agt_tpl_readonly", noRun, 1, now, now);  // template, no run_command → untouched
    ins.run("agt_user_runner", userWithRun, 0, now, now); // user curation → untouched
    old.close();

    const db = openDatabase(path); // 0021 applies
    const row = (id: string): string[] =>
      JSON.parse(
        (db.prepare("SELECT allowed_tools FROM agents WHERE id = ?").get(id) as { allowed_tools: string }).allowed_tools,
      ) as string[];

    // Template with run_command: both job tools appended at the tail.
    expect(row("agt_tpl_coder")).toEqual([
      "list_dir", "read_file", "write_file", "run_command", "memory_save",
      "job_status",
      "job_stop",
    ]);
    // [] row means ALL tools — untouched (the 0019 lesson).
    expect(row("agt_default_nova")).toEqual([]);
    // Template without run_command: nothing to supervise — untouched.
    expect(row("agt_tpl_readonly")).toEqual(["read_file", "write_file", "list_dir"]);
    // User curation: never widened.
    expect(row("agt_user_runner")).toEqual(["run_command", "read_file"]);

    // Audit trail + bookkeeping.
    const audit = db
      .prepare("SELECT actor, action, decision FROM audit_log WHERE actor = 'migration-0021' LIMIT 1")
      .get() as { actor: string; action: string; decision: string };
    expect(audit).toEqual({
      actor: "migration-0021",
      action: "agent.tools.append",
      decision: "applied",
    });
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 21").get()).toBeDefined();

    // Idempotent on reopen.
    db.close();
    const again = openDatabase(path);
    expect(
      JSON.parse(
        (again.prepare("SELECT allowed_tools FROM agents WHERE id = 'agt_tpl_coder'").get() as { allowed_tools: string }).allowed_tools,
      ) as string[],
    ).toHaveLength(7);
    again.close();
  });
});
