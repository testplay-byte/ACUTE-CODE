// @vitest-environment node
//
// ROUND-66 (R66, B3): migration 0026 — analyze_image appended to
// template/default allowlists that include web_fetch (the general-capability
// companion rule).
//
// Scope rules under test (the lessons of 0014/0019/0021 baked in):
//   · '[]' rows mean ALL tools (ADR-0019) — NEVER appended.
//   · Only template rows + agt_default_nova are touched — user agents keep
//     deliberately-authored lists verbatim.
//   · Within that scope, a row whose allowlist lacks web_fetch gets nothing.
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

/** A pre-R66 database: full schema through 0025, agent rows hand-seeded. */
function openPreR66Database(path: string): Database.Database {
  const db = openDatabase(path); // applies everything INCLUDING 0026
  // Simulate the pre-0026 world: drop the 0026 bookkeeping + the audit row,
  // and reset the seeded rows to the shapes under test.
  db.prepare("DELETE FROM schema_migrations WHERE version = 26").run();
  db.prepare("DELETE FROM audit_log WHERE actor = 'migration-0026'").run();
  db.prepare("DELETE FROM agents").run();
  return db;
}

describe("migration 0026 (analyze_image tool append)", () => {
  it("appends analyze_image to template/default rows with web_fetch; [] rows, web-fetch-less rows, and user curation untouched; idempotent", () => {
    tempDir = mkdtempSync(join(tmpdir(), "acute-m0026-"));
    const path = join(tempDir, `m0026-${randomUUID()}.db`);
    const old = openPreR66Database(path);
    const now = new Date().toISOString();

    const ins = old.prepare(
      `INSERT INTO agents (id, name, role, system_prompt, provider_id, model, vision_model,
        allowed_tools, memory_policy, skills, max_turns, max_outer_loops, temperature,
        version, is_template, created_at, updated_at)
       VALUES (?, 'X', 'coder', '', 'openrouter', 'z-ai/glm-5.2:free', NULL, ?, 'none', '[]', 40, 5, 0.2, 1, ?, ?, ?)`,
    );
    const withFetch = JSON.stringify([
      "list_dir", "read_file", "write_file", "web_fetch", "memory_save",
    ]);
    const noFetch = JSON.stringify(["read_file", "write_file", "list_dir"]);
    // A USER agent whose list includes web_fetch — deliberately authored;
    // user rows are never widened.
    const userWithFetch = JSON.stringify(["web_fetch", "read_file"]);

    ins.run("agt_tpl_coder", withFetch, 1, now, now);   // template, has web_fetch → +1
    ins.run("agt_default_nova", "[]", 0, now, now);     // [] = ALL tools → untouched
    ins.run("agt_tpl_readonly", noFetch, 1, now, now);  // template, no web_fetch → untouched
    ins.run("agt_user_fetcher", userWithFetch, 0, now, now); // user curation → untouched
    old.close();

    const db = openDatabase(path); // 0026 applies
    const row = (id: string): string[] =>
      JSON.parse(
        (db.prepare("SELECT allowed_tools FROM agents WHERE id = ?").get(id) as { allowed_tools: string }).allowed_tools,
      ) as string[];

    // Template with web_fetch: analyze_image appended at the tail.
    expect(row("agt_tpl_coder")).toEqual([
      "list_dir", "read_file", "write_file", "web_fetch", "memory_save",
      "analyze_image",
    ]);
    // [] row means ALL tools — untouched (the 0019 lesson).
    expect(row("agt_default_nova")).toEqual([]);
    // Template without web_fetch: no general-capability baseline — untouched.
    expect(row("agt_tpl_readonly")).toEqual(["read_file", "write_file", "list_dir"]);
    // User curation: never widened.
    expect(row("agt_user_fetcher")).toEqual(["web_fetch", "read_file"]);

    // Audit trail + bookkeeping.
    const audit = db
      .prepare("SELECT actor, action, decision FROM audit_log WHERE actor = 'migration-0026' LIMIT 1")
      .get() as { actor: string; action: string; decision: string };
    expect(audit).toEqual({
      actor: "migration-0026",
      action: "agent.tools.append",
      decision: "applied",
    });
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 26").get()).toBeDefined();

    // Idempotent on reopen.
    db.close();
    const again = openDatabase(path);
    expect(
      JSON.parse(
        (again.prepare("SELECT allowed_tools FROM agents WHERE id = 'agt_tpl_coder'").get() as { allowed_tools: string }).allowed_tools,
      ) as string[],
    ).toHaveLength(6);
    again.close();
  });
});
