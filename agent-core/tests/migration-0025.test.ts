// @vitest-environment node
//
// ROUND-66 (R66-2-b): migration 0025 — the vision settings split (the
// owner's B3+B5 directive: the vision model removed from computer use into
// its own dedicated section). vision.mode/provider/modelId are seeded from
// the R61 legacy computerUse.vision.* rows.
//
// Scope under test:
//   · Fresh database: NO legacy rows → the three INSERT…SELECT statements
//     insert nothing (guarded selects), bookkeeping + audit rows are
//     written, and getVisionSettings defaults to null/null with mode
//     "main" (R114-b: "off" is retired — the default became "main" and a
//     stored "off" reads as "main").
//   · Seed-from-old: a pre-0025 database carrying computerUse.vision.*
//     rows → reopen seeds the vision.* rows verbatim (legacy rows kept).
//   · Idempotent on reopen; INSERT OR IGNORE respects a vision.* row the
//     engine already wrote (no clobber).
//   · The LAZY half (storage/vision.ts): a database 0025 has NOT touched
//     (vision.mode absent, legacy present) reads the legacy rows
//     read-only; the first setVisionSettings write lands the new keys and
//     the legacy rows are ignored forever after.
//   · setVisionSettings validation (the computer-use.ts convention).
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/storage/db";
import { getVisionSettings, setVisionSettings } from "../src/storage/vision";

let tempDir = "";

afterAll(() => {
  try {
    if (tempDir !== "") rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function row(db: Database.Database, key: string): string | undefined {
  return (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined)?.value;
}

/** Strip the 0025 bookkeeping/audit + the vision.* rows → the pre-0025 world. */
function strip0025(db: Database.Database): void {
  db.prepare("DELETE FROM schema_migrations WHERE version = 25").run();
  db.prepare("DELETE FROM audit_log WHERE actor = 'migration-0025'").run();
  db.prepare("DELETE FROM settings WHERE key IN ('vision.mode', 'vision.provider', 'vision.modelId')").run();
}

function insertLegacy(
  db: Database.Database,
  values: { mode?: string; provider?: string; modelId?: string },
): void {
  const upsert = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  if (values.mode !== undefined) upsert.run("computerUse.vision.mode", values.mode);
  if (values.provider !== undefined) upsert.run("computerUse.vision.provider", values.provider);
  if (values.modelId !== undefined) upsert.run("computerUse.vision.modelId", values.modelId);
}

describe("migration 0025 (vision settings split)", () => {
  it("fresh database: no legacy rows → nothing is seeded, bookkeeping + audit land, defaults read back", () => {
    tempDir = mkdtempSync(join(tmpdir(), "acute-m0025-"));
    const path = join(tempDir, `m0025-${randomUUID()}.db`);
    const db = openDatabase(path);

    // Guarded INSERT…SELECT: absent source keys insert NOTHING.
    expect(row(db, "vision.mode")).toBeUndefined();
    expect(row(db, "vision.provider")).toBeUndefined();
    expect(row(db, "vision.modelId")).toBeUndefined();
    // The typed accessor defaults safely (R114-b: the default mode is
    // "main" — the retired "off"'s replacement; a stored "off" likewise
    // reads as "main", pinned in r114-sync-wave.test.ts).
    expect(getVisionSettings(db)).toEqual({ mode: "main", provider: null, modelId: null });

    // Bookkeeping + audit trail (the 0021/0022/0023/0024 convention).
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 25").get()).toBeDefined();
    const audit = db
      .prepare("SELECT actor, action, decision FROM audit_log WHERE actor = 'migration-0025' LIMIT 1")
      .get() as { actor: string; action: string; decision: string };
    expect(audit).toEqual({ actor: "migration-0025", action: "vision.settings.split", decision: "applied" });

    // Idempotent on reopen: no second audit row, no duplicate bookkeeping.
    db.close();
    const again = openDatabase(path);
    expect(
      again.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE actor = 'migration-0025'").get(),
    ).toEqual({ n: 1 });
    again.close();
  });

  it("seed-from-old: a pre-0025 database with computerUse.vision.* rows seeds vision.* verbatim; legacy rows STAY", () => {
    const path = join(tempDir, `m0025-seed-${randomUUID()}.db`);
    // Start fully migrated, then rewind to the pre-0025 world carrying the
    // R61 legacy rows (partial on purpose: no modelId — only two of three).
    const old = openDatabase(path);
    strip0025(old);
    insertLegacy(old, { mode: "separate", provider: "openrouter" });
    old.close();

    // Reopen: 0025 applies in its one transaction — all three statements
    // run; the absent source (modelId) inserts nothing.
    const db = openDatabase(path);
    expect(row(db, "vision.mode")).toBe("separate");
    expect(row(db, "vision.provider")).toBe("openrouter");
    expect(row(db, "vision.modelId")).toBeUndefined();
    // The legacy rows are kept (read-only compatibility — never deleted).
    expect(row(db, "computerUse.vision.mode")).toBe("separate");
    expect(row(db, "computerUse.vision.provider")).toBe("openrouter");
    // The typed accessor reads the seeded state.
    expect(getVisionSettings(db)).toEqual({ mode: "separate", provider: "openrouter", modelId: null });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE actor = 'migration-0025'").get(),
    ).toEqual({ n: 1 });

    // Idempotent on reopen: nothing re-runs, nothing duplicates.
    db.close();
    const again = openDatabase(path);
    expect(row(again, "vision.mode")).toBe("separate");
    expect(
      again.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE actor = 'migration-0025'").get(),
    ).toEqual({ n: 1 });
    again.close();
  });

  it("INSERT OR IGNORE: a vision.* row the engine already wrote is never clobbered by a re-run", () => {
    const path = join(tempDir, `m0025-ignore-${randomUUID()}.db`);
    const old = openDatabase(path);
    strip0025(old);
    // The engine wrote vision.mode=main AFTER 0025 had once applied (its
    // bookkeeping was lost, say); the legacy row still says separate.
    old.prepare("INSERT INTO settings (key, value) VALUES ('vision.mode', 'main')").run();
    insertLegacy(old, { mode: "separate" });
    old.close();

    const db = openDatabase(path);
    expect(row(db, "vision.mode")).toBe("main"); // OR IGNORE kept the engine's row
    expect(row(db, "computerUse.vision.mode")).toBe("separate"); // legacy untouched
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE actor = 'migration-0025'").get(),
    ).toEqual({ n: 1 });
    db.close();
  });

  it("the LAZY half: without 0025, getVisionSettings reads the legacy rows read-only (nothing written)", () => {
    const path = join(tempDir, `m0025-lazy-${randomUUID()}.db`);
    const db = openDatabase(path);
    // Simulate an engine whose db 0025 never touched: no vision.* rows, no
    // bookkeeping — and the migration will NOT re-run while this handle is
    // open (db.ts applies at open only).
    strip0025(db);
    insertLegacy(db, { mode: "main", provider: "anthropic", modelId: "claude-sonnet-4" });

    // The lazy read: legacy values, zero writes.
    expect(getVisionSettings(db)).toEqual({
      mode: "main",
      provider: "anthropic",
      modelId: "claude-sonnet-4",
    });
    expect(row(db, "vision.mode")).toBeUndefined();
    expect(row(db, "vision.provider")).toBeUndefined();
    expect(row(db, "vision.modelId")).toBeUndefined();

    // The first WRITE lands the new keys and switches over: the legacy
    // rows are ignored forever after.
    setVisionSettings(db, { mode: "separate", provider: "openrouter", modelId: "google/gemini-2.5-flash" });
    expect(row(db, "vision.mode")).toBe("separate");
    expect(row(db, "computerUse.vision.mode")).toBe("main"); // legacy kept, unread
    expect(getVisionSettings(db)).toEqual({
      mode: "separate",
      provider: "openrouter",
      modelId: "google/gemini-2.5-flash",
    });
    db.close();
  });

  it("setVisionSettings validation mirrors computer-use.ts (enum, slug regex, length, null clears)", () => {
    const path = join(tempDir, `m0025-set-${randomUUID()}.db`);
    const db = openDatabase(path);

    setVisionSettings(db, { mode: "separate", provider: "openrouter", modelId: "m/vision" });
    expect(getVisionSettings(db)).toEqual({ mode: "separate", provider: "openrouter", modelId: "m/vision" });

    expect(() => setVisionSettings(db, { mode: "nope" as never })).toThrow(/mode must be one of/);
    expect(() => setVisionSettings(db, { provider: "Not A Slug" })).toThrow(/provider must be a lowercase slug/);
    expect(() => setVisionSettings(db, { modelId: "x".repeat(257) })).toThrow(/modelId must be at most 256 chars/);

    // null clears (the row is REMOVED — readNullable treats "" as null too).
    setVisionSettings(db, { provider: null, modelId: null });
    expect(getVisionSettings(db)).toEqual({ mode: "separate", provider: null, modelId: null });
    expect(row(db, "vision.provider")).toBeUndefined();
    expect(row(db, "vision.modelId")).toBeUndefined();
    db.close();
  });
});
