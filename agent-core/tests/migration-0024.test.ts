// @vitest-environment node
//
// ROUND-64 (R64-e): migration 0024 — usage_events.key_slot (per-API-key
// usage stats) + idx_usage_events_provider_slot. The owner: "I want the
// ability to track each individual API key's stats, like the total usage of
// that API key, total tokens used on that API key."
//
// Scope under test:
//   · Fresh database: the column lands NOT NULL DEFAULT 0 (the honest
//     "primary key" reading of pre-R64 history — no backfill guesses), the
//     provider/slot index exists, bookkeeping + audit rows are written.
//   · Pre-0024 simulation: DROP COLUMN + DROP INDEX + clear the bookkeeping
//     (SQLite ≥ 3.35 supports DROP COLUMN; better-sqlite3 bundles 3.53) →
//     reopen re-applies 0024 verbatim — existing rows keep running.
//   · Idempotent on reopen (the db.ts one-transaction-per-file contract).
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/db";

let tempDir = "";

afterAll(() => {
  try {
    if (tempDir !== "") rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("migration 0024 (usage_events key_slot)", () => {
  it("adds the column (default 0), the provider/slot index, and audit bookkeeping on a fresh database", () => {
    tempDir = mkdtempSync(join(tmpdir(), "acute-m0024-"));
    const path = join(tempDir, `m0024-${randomUUID()}.db`);
    const db = openDatabase(path);

    const columns = (
      db.prepare("PRAGMA table_info(usage_events)").all() as Array<{ name: string; dflt_value: string; notnull: number }>
    ).find((c) => c.name === "key_slot");
    expect(columns).toMatchObject({ dflt_value: "0", notnull: 1 });

    const indexes = (
      db.prepare("PRAGMA index_list(usage_events)").all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexes).toContain("idx_usage_events_provider_slot");

    // A raw INSERT without the column lands on the default (pre-R64 parity).
    db.prepare(
      `INSERT INTO usage_events (agent_id, session_id, provider, model, input_tokens, output_tokens, cost_usd, ts)
       VALUES ('a', 's', 'openrouter', 'm', 1, 1, 0, '2025-01-01T00:00:00.000Z')`,
    ).run();
    const row = db
      .prepare("SELECT key_slot FROM usage_events WHERE session_id = 's'")
      .get() as { key_slot: number };
    expect(row.key_slot).toBe(0);

    // Bookkeeping + audit trail (the 0021/0022/0023 convention).
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 24").get()).toBeDefined();
    const audit = db
      .prepare("SELECT actor, action, decision FROM audit_log WHERE actor = 'migration-0024' LIMIT 1")
      .get() as { actor: string; action: string; decision: string };
    expect(audit).toEqual({ actor: "migration-0024", action: "usage.key.slot.add", decision: "applied" });

    // Idempotent on reopen: no second audit row, no duplicate bookkeeping.
    db.close();
    const again = openDatabase(path);
    expect(
      again.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE actor = 'migration-0024'").get(),
    ).toEqual({ n: 1 });
    again.close();
  });

  // R67 CI-stability: this test runs 26 real migrations TWICE (a fresh
  // fully-migrated open, then the downgrade + a second open) — on the loaded
  // Windows CI runner the whole file measured 8.3s with THIS test at 6.3s,
  // over vitest's 5s default (run 33965926186; the Linux sandbox finishes in
  // ~0.4s). Explicit 30s timeout — the same deterministic fix the R66
  // close-out applied to the real-OS-probe tests.
  it("re-applies verbatim on a pre-0024 database (dropped column + index) and is idempotent on reopen", { timeout: 30_000 }, () => {
    const path = join(tempDir, `m0024-rt-${randomUUID()}.db`);
    // Start from a fully-migrated database, then simulate the pre-0024 world:
    // strip the column, the index, the bookkeeping row, and the audit row.
    const old = openDatabase(path);
    old.prepare("DROP INDEX idx_usage_events_provider_slot").run();
    old.prepare("ALTER TABLE usage_events DROP COLUMN key_slot").run();
    old.prepare("DELETE FROM schema_migrations WHERE version = 24").run();
    old.prepare("DELETE FROM audit_log WHERE actor = 'migration-0024'").run();
    // One pre-R64 row survives the downgrade untouched.
    old.prepare(
      `INSERT INTO usage_events (agent_id, session_id, provider, model, input_tokens, output_tokens, cost_usd, ts)
       VALUES ('a', 'legacy', 'openrouter', 'm', 7, 3, 0.1, '2025-01-01T00:00:00.000Z')`,
    ).run();
    old.close();

    // Reopen: 0024 applies in its one transaction (column + index together).
    const db = openDatabase(path);
    const legacy = db
      .prepare("SELECT key_slot FROM usage_events WHERE session_id = 'legacy'")
      .get() as { key_slot: number };
    expect(legacy.key_slot).toBe(0); // DEFAULT 0 — the primary key, honestly

    const indexes = (
      db.prepare("PRAGMA index_list(usage_events)").all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexes).toContain("idx_usage_events_provider_slot");
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 24").get()).toBeDefined();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE actor = 'migration-0024'").get(),
    ).toEqual({ n: 1 }); // exactly one audit row, not one per reopen

    // Reopen again: nothing re-runs (idempotent — the bookkeeping gate).
    db.close();
    const again = openDatabase(path);
    expect(
      again.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE actor = 'migration-0024'").get(),
    ).toEqual({ n: 1 });
    again.close();
  });
});
