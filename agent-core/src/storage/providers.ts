/**
 * Provider registry lookups (agent-validation support; full provider CRUD is
 * a later wave, API.md §8).
 */
import type Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;

/** The four built-in provider ids (API.md §8.1); user-added rows live in `providers`. */
const BUILTIN_PROVIDER_IDS: readonly string[] = ["anthropic", "openai", "google", "openrouter"];

export function providerExists(db: SqliteDatabase, id: string): boolean {
  return (
    BUILTIN_PROVIDER_IDS.includes(id) ||
    db.prepare("SELECT 1 FROM providers WHERE id = ?").get(id) !== undefined
  );
}
