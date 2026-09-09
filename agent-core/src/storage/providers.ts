/**
 * Provider registry repository (API.md §8). Rows only — API keys never live in
 * this table (ARCHITECTURE §7: env-injected keyring held in memory). Built-in
 * rows are seeded once per database open (see seedBuiltinProviders), so the
 * primary dev provider is visible before any request.
 */
import type Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;

/** Provider ids reserved for the built-in adapters (API.md §8.1); custom rows may not claim them.
 * ROUND-80 (R80, owner: "make sure it works with the nvidia api key too"):
 * "nvidia" joins the reserved set — the built-in NIM row is seeded below. */
export const RESERVED_PROVIDER_IDS: readonly string[] = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "nvidia",
];

/** The only provider kind registerable through the API in v1. */
export const CUSTOM_PROVIDER_KIND = "openai-compatible";

/** Row spec for a built-in provider seeded at openDatabase (SPEC §F4). */
interface BuiltinProviderSeed {
  id: string;
  name: string;
  baseUrl: string;
  /** R37 review #9: the wire format the endpoint actually speaks. */
  apiFormat?: string;
}

/**
 * Built-ins that must exist as rows on every database. OpenRouter is the
 * primary dev provider (SPEC §F4): seeding it here — not lazily on first use —
 * guarantees `GET /providers` lists it immediately after a fresh boot. Ids are
 * reserved, so custom rows can never collide with these.
 */
const BUILTIN_PROVIDER_SEEDS: readonly BuiltinProviderSeed[] = [
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  // ROUND-34: the remaining built-in adapter rows — they render in the
  // provider list as "add a key" entries; the chat adapter only speaks
  // OpenAI-compatible endpoints today (apiFormat stays chat-completions).
  { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", apiFormat: "anthropic-messages" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "google", name: "Google", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  // ROUND-80 (R80, owner: "make sure it works with the nvidia api key too"):
  // NVIDIA NIM (build.nvidia.com) — an OpenAI-compatible /v1 surface at
  // integrate.api.nvidia.com with `nvapi-…` keys. The chat adapter's
  // createOpenAICompatible path speaks it as-is; the key rides
  // ACUTE_PROVIDER_NVIDIA (env spawn injection, keys.rs provider_key_env_targets
  // + dev.mjs). Models load through the existing provider /models fetch +
  // POST /providers/:id/models upsert — no catalog seeds needed.
  { id: "nvidia", name: "NVIDIA", baseUrl: "https://integrate.api.nvidia.com/v1" },
];

/**
 * Inserts any built-in provider whose row is missing; a no-op for ids already
 * present, so repeated opens never duplicate rows (providers.id is the PK).
 * ROUND-37: ids with a TOMBSTONE (the owner deleted the built-in) stay
 * deleted — the seed must not resurrect them on every boot.
 */
export function seedBuiltinProviders(db: SqliteDatabase): void {
  const insert = db.prepare(
    `INSERT INTO providers (id, name, kind, base_url, api_format, enabled, created_at)
     VALUES (@id, @name, @kind, @baseUrl, @apiFormat, 1, @createdAt)`,
  );
  // ROUND-34: ONE shared timestamp for the whole seed batch — a per-insert
  // clock read raced the millisecond tick and made list order (created_at,
  // id) non-deterministic across tests.
  const createdAt = new Date().toISOString();
  db.transaction(() => {
    for (const seed of BUILTIN_PROVIDER_SEEDS) {
      if (providerRecordIdExists(db, seed.id)) continue;
      if (isProviderTombstoned(db, seed.id)) continue;
      insert.run({
        id: seed.id,
        name: seed.name,
        apiFormat: seed.apiFormat ?? "chat-completions",
        kind: CUSTOM_PROVIDER_KIND,
        baseUrl: seed.baseUrl,
        createdAt,
      });
    }
  })();
}

/** ROUND-37: the owner deliberately deleted this built-in — don't re-seed. */
export function isProviderTombstoned(db: SqliteDatabase, id: string): boolean {
  return db.prepare("SELECT 1 FROM provider_tombstones WHERE id = ?").get(id) !== undefined;
}

/** ROUND-37: record a built-in deletion (idempotent). */
export function addProviderTombstone(db: SqliteDatabase, id: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO provider_tombstones (id, deleted_at) VALUES (?, ?)",
  ).run(id, new Date().toISOString());
}

/** ROUND-37: re-adding a deleted built-in clears its tombstone. */
export function clearProviderTombstone(db: SqliteDatabase, id: string): void {
  db.prepare("DELETE FROM provider_tombstones WHERE id = ?").run(id);
}

export interface ProviderRecord {
  id: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  apiFormat?: string;
  enabled: boolean;
  createdAt: string;
}

export interface ProviderRecordInput {
  id: string;
  name: string;
  baseUrl: string;
  apiFormat?: string;
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
    apiFormat: (row as { api_format?: string }).api_format ?? "chat-completions",
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
    `INSERT INTO providers (id, name, kind, base_url, api_format, enabled, created_at)
     VALUES (@id, @name, @kind, @baseUrl, @apiFormat, 1, @createdAt)`,
  ).run({ ...input, kind, apiFormat: input.apiFormat ?? "chat-completions", createdAt: new Date().toISOString() });
  return getProviderRecord(db, input.id) as ProviderRecord;
}

/** ROUND-34: update a custom provider row (name/baseUrl/apiFormat/enabled). */
export function updateProviderRecord(
  db: SqliteDatabase,
  record: ProviderRecord,
): ProviderRecord {
  db.prepare(
    `UPDATE providers SET name = @name, base_url = @baseUrl, api_format = @apiFormat, enabled = @enabled WHERE id = @id`,
  ).run({
    id: record.id,
    name: record.name,
    baseUrl: record.baseUrl,
    apiFormat: record.apiFormat,
    enabled: record.enabled ? 1 : 0,
  });
  return getProviderRecord(db, record.id) as ProviderRecord;
}

/** ROUND-34 → ROUND-37: delete a provider row (idempotent). Built-in ids
 * additionally write a tombstone so the boot seed doesn't resurrect them. */
export function deleteProviderRecord(db: SqliteDatabase, id: string): void {
  db.prepare("DELETE FROM providers WHERE id = ?").run(id);
  db.prepare("DELETE FROM models WHERE provider_id = ?").run(id);
  if (RESERVED_PROVIDER_IDS.includes(id)) {
    addProviderTombstone(db, id);
  }
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
