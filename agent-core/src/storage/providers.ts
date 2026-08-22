/**
 * Provider registry repository (API.md §8). Rows only — API keys never live in
 * this table (ARCHITECTURE §7: env-injected keyring held in memory). The
 * built-in openrouter row is created lazily by the registry layer on first
 * use, not seeded here.
 */
import type Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;

/** Provider ids reserved for the built-in adapters (API.md §8.1); custom rows may not claim them. */
export const RESERVED_PROVIDER_IDS: readonly string[] = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
];

/** The only provider kind registerable through the API in v1. */
export const CUSTOM_PROVIDER_KIND = "openai-compatible";

export interface ProviderRecord {
  id: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  enabled: boolean;
  createdAt: string;
}

export interface ProviderRecordInput {
  id: string;
  name: string;
  baseUrl: string;
}

interface ProviderRow {
  id: string;
  name: string;
  kind: string;
  base_url: string | null;
  enabled: number;
  created_at: string;
}

function toRecord(row: ProviderRow): ProviderRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

/**
 * Agent-validation view of existence: the reserved built-in ids count as known
 * providers even before their rows are lazily materialized.
 */
export function providerExists(db: SqliteDatabase, id: string): boolean {
  return (
    RESERVED_PROVIDER_IDS.includes(id) ||
    providerRecordIdExists(db, id)
  );
}

export function providerRecordIdExists(db: SqliteDatabase, id: string): boolean {
  return db.prepare("SELECT 1 FROM providers WHERE id = ?").get(id) !== undefined;
}

export function getProviderRecord(db: SqliteDatabase, id: string): ProviderRecord | undefined {
  const row = db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as
    | ProviderRow
    | undefined;
  return row === undefined ? undefined : toRecord(row);
}

export function listProviderRecords(db: SqliteDatabase): ProviderRecord[] {
  const rows = db
    .prepare("SELECT * FROM providers ORDER BY created_at ASC, id ASC")
    .all() as ProviderRow[];
  return rows.map(toRecord);
}

/** Caller has already validated id uniqueness and reserved-ness. */
export function createProviderRecord(
  db: SqliteDatabase,
  input: ProviderRecordInput,
  kind: string = CUSTOM_PROVIDER_KIND,
): ProviderRecord {
  db.prepare(
    `INSERT INTO providers (id, name, kind, base_url, enabled, created_at)
     VALUES (@id, @name, @kind, @baseUrl, 1, @createdAt)`,
  ).run({ ...input, kind, createdAt: new Date().toISOString() });
  return getProviderRecord(db, input.id) as ProviderRecord;
}

/** Deterministic id for a custom provider when the request omits one. */
export function slugifyProviderId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug === "" ? "" : `prv_${slug}`;
}
