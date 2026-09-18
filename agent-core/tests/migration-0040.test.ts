// @vitest-environment node
//
// ROUND-106 (R106-S1): migration 0040 — the MOBILE DEVICES table (the
// paired-phone registry the multi-token bearer wall authenticates against;
// LINKING-PROTOCOL §2/§5). The migration-0029 pattern: build a pre-0040
// database by hand (apply 0001..0039), reopen with the current code, and
// prove the table lands with the contract shape, the bookkeeping row is
// written, and a reopen is idempotent. The UNIQUE token_hash constraint
// (two devices can never share a token) and the revocation-is-DELETE
// semantics are pinned here at the storage layer.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import {
  createMobileDevice,
  deleteMobileDevice,
  findMobileDeviceByTokenHash,
  hashDeviceToken,
  listMobileDevices,
} from "../src/storage/mobile-devices";

let tempDir = "";

afterAll(() => {
  try {
    if (tempDir !== "") rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort (Windows file-handle lag) */
  }
});

/** Applies migrations 0001..0039 by hand — simulates a pre-R106 install. */
function openPreR106Database(path: string): SqliteDatabase {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const migrationsDir = fileURLToPath(new URL("../src/storage/migrations", import.meta.url));
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) <= 39)
    .sort((a, b) => Number(a.slice(0, 4)) - Number(b.slice(0, 4)));
  expect(files).toHaveLength(39);
  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const file of files) {
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
    insert.run(Number(file.slice(0, 4)), file, new Date().toISOString());
  }
  return db;
}

describe("migration 0040 (mobile devices)", () => {
  it("creates the mobile_devices table on reopen; bookkeeping row; idempotent", () => {
    tempDir = mkdtempSync(join(tmpdir(), "acute-m0040-"));
    const path = join(tempDir, `m0040-${randomUUID()}.db`);
    const old = openPreR106Database(path);
    // Pre-R106: no mobile_devices table exists.
    const tablesBefore = (old
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mobile_devices'")
      .all() as Array<{ name: string }>);
    expect(tablesBefore).toHaveLength(0);
    old.close();

    // Reopen with the current code: 0040 applies inside openDatabase.
    const db = openDatabase(path);
    try {
      const version = db
        .prepare("SELECT version, name FROM schema_migrations WHERE version = 40")
        .get() as { version: number; name: string };
      expect(version.version).toBe(40);
      expect(version.name).toContain("0040_mobile_devices");

      // The contract shape: id PK, label, UNIQUE token_hash, scopes
      // (JSON), epoch-ms created_at + last_seen_at.
      const columns = (db
        .prepare("PRAGMA table_info(mobile_devices)")
        .all() as Array<{ name: string; type: string; notnull: number }>);
      const byName = new Map(columns.map((c) => [c.name, c]));
      expect(byName.get("id")).toMatchObject({ type: "TEXT" });
      expect(byName.get("label")).toMatchObject({ type: "TEXT", notnull: 1 });
      expect(byName.get("token_hash")).toMatchObject({ type: "TEXT", notnull: 1 });
      expect(byName.get("scopes")).toMatchObject({ type: "TEXT", notnull: 1 });
      expect(byName.get("created_at")).toMatchObject({ type: "INTEGER", notnull: 1 });
      expect(byName.get("last_seen_at")).toMatchObject({ type: "INTEGER", notnull: 1 });
      const uniqueIndexes = (db
        .prepare("PRAGMA index_list(mobile_devices)")
        .all() as Array<{ name: string; unique: number; origin: string }>);
      expect(uniqueIndexes.some((idx) => idx.unique === 1 && idx.origin === "u")).toBe(true);

      // The storage layer round-trips: create → list → hash lookup →
      // revoke (DELETE) — the wall's exact sequence.
      const token = `device-token-${randomUUID()}`;
      const created = createMobileDevice(db, {
        id: "mob_test_1",
        label: "Migration phone",
        tokenHash: hashDeviceToken(token),
      });
      expect(created).toMatchObject({
        id: "mob_test_1",
        label: "Migration phone",
        scopes: ["view-input"],
      });
      expect(typeof created.createdAt).toBe("number");
      expect(created.lastSeenAt).toBe(created.createdAt);

      const found = findMobileDeviceByTokenHash(db, hashDeviceToken(token));
      expect(found?.id).toBe("mob_test_1");
      // A WRONG token hash finds nothing (revoked/unknown → reject).
      expect(findMobileDeviceByTokenHash(db, hashDeviceToken("no-such-token"))).toBeUndefined();

      // The token itself is never stored — only its hash.
      const raw = db
        .prepare("SELECT token_hash FROM mobile_devices WHERE id = ?")
        .get("mob_test_1") as { token_hash: string };
      expect(raw.token_hash).toBe(hashDeviceToken(token));
      expect(raw.token_hash).not.toBe(token);

      // UNIQUE token_hash: two devices cannot share a token.
      expect(() =>
        createMobileDevice(db, { id: "mob_test_2", label: "Impostor", tokenHash: hashDeviceToken(token) }),
      ).toThrow();

      // Revocation is DELETE — the row goes away, the list empties.
      expect(deleteMobileDevice(db, "mob_test_1")).toBe(true);
      expect(listMobileDevices(db)).toHaveLength(0);
      expect(findMobileDeviceByTokenHash(db, hashDeviceToken(token))).toBeUndefined();

      // Idempotent: a second reopen applies nothing new, keeps the schema.
      db.close();
      const again = openDatabase(path);
      try {
        const applied = (again
          .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 40")
          .get() as { count: number }).count;
        expect(applied).toBe(1);
        const row = again
          .prepare("SELECT COUNT(*) AS count FROM mobile_devices")
          .get() as { count: number };
        expect(row.count).toBe(0);
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

  it("corrupt scopes JSON falls back to the default grant on read (display-only field)", () => {
    tempDir = mkdtempSync(join(tmpdir(), "acute-m0040b-"));
    const db = openDatabase(join(tempDir, `m0040b-${randomUUID()}.db`));
    try {
      const now = Date.now();
      db.prepare(
        `INSERT INTO mobile_devices (id, label, token_hash, scopes, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("mob_corrupt", "Corrupt scopes", hashDeviceToken("tok"), "{not-json", now, now);
      const devices = listMobileDevices(db);
      expect(devices).toHaveLength(1);
      expect(devices[0].scopes).toEqual(["view-input"]);
    } finally {
      db.close();
    }
  });
});
