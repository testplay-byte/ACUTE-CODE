/**
 * Provider registry repository (API.md §8). Rows only — API keys never live in
 * this table (ARCHITECTURE §7: env-injected keyring held in memory). Built-in
 * rows are seeded once per database open (see seedBuiltinProviders), so the
 * primary dev provider is visible before any request.
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

/** Row spec for a built-in provider seeded at openDatabase (SPEC §F4). */
interface BuiltinProviderSeed {
  id: string;
  name: string;
  baseUrl: string;
}

/**
 * Built-ins that must exist as rows on every database. OpenRouter is the
 * primary dev provider (SPEC §F4): seeding it here — not lazily on first use —
 * guarantees `GET /providers` lists it immediately after a fresh boot. Ids are
 * reserved, so custom rows can never collide with these.
 */
const BUILTIN_PROVIDER_SEEDS: readonly BuiltinProviderSeed[] = [
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
];

/**
 * Inserts any built-in provider whose row is missing; a no-op for ids already
 * present, so repeated opens never duplicate rows (providers.id is the PK).
 */
export function seedBuiltinProviders(db: SqliteDatabase): void {
  const insert = db.prepare(
    `INSERT INTO providers (id, name, kind, base_url, enabled, created_at)
     VALUES (@id, @name, @kind, @baseUrl, 1, @createdAt)`,
  );
  db.transaction(() => {
    for (const seed of BUILTIN_PROVIDER_SEEDS) {
      if (providerRecordIdExists(db, seed.id)) continue;
      insert.run({
        id: seed.id,
        name: seed.name,
        kind: CUSTOM_PROVIDER_KIND,
        baseUrl: seed.baseUrl,
        createdAt: new Date().toISOString(),
      });
    }
  })();
}

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
