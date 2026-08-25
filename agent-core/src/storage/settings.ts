/**
 * ROUND-36 (ADR-0022): orchestration settings — persisted in the `settings`
 * table (migration 0001) with typed accessors + defaults.
 *
 *   orchestration.maxParallel   — total concurrent sub-agent runs (default 5,
 *                                 clamp 1–50; the owner's stated range).
 *   orchestration.perKeyLimit   — concurrent sub-agents per API key (default
 *                                 3, clamp 1–20) — "not burden the API keys".
 */
import type { SqliteDatabase } from "./db.js";

export interface OrchestrationSettings {
  maxParallel: number;
  perKeyLimit: number;
}

export const ORCHESTRATION_DEFAULTS: OrchestrationSettings = {
  maxParallel: 5,
  perKeyLimit: 3,
};

const MAX_PARALLEL_KEY = "orchestration.maxParallel";
const PER_KEY_LIMIT_KEY = "orchestration.perKeyLimit";

function readNumber(db: SqliteDatabase, key: string, fallback: number, min: number, max: number): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (row === undefined) return fallback;
  const parsed = Number(row.value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function getOrchestrationSettings(db: SqliteDatabase): OrchestrationSettings {
  return {
    maxParallel: readNumber(db, MAX_PARALLEL_KEY, ORCHESTRATION_DEFAULTS.maxParallel, 1, 50),
    perKeyLimit: readNumber(db, PER_KEY_LIMIT_KEY, ORCHESTRATION_DEFAULTS.perKeyLimit, 1, 20),
  };
}

export function setOrchestrationSettings(
  db: SqliteDatabase,
  patch: Partial<OrchestrationSettings>,
): OrchestrationSettings {
  const upsert = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  if (patch.maxParallel !== undefined) {
    if (!Number.isInteger(patch.maxParallel) || patch.maxParallel < 1 || patch.maxParallel > 50) {
      throw new Error("maxParallel must be an integer between 1 and 50");
    }
    upsert.run(MAX_PARALLEL_KEY, String(patch.maxParallel));
  }
  if (patch.perKeyLimit !== undefined) {
    if (!Number.isInteger(patch.perKeyLimit) || patch.perKeyLimit < 1 || patch.perKeyLimit > 20) {
      throw new Error("perKeyLimit must be an integer between 1 and 20");
    }
    upsert.run(PER_KEY_LIMIT_KEY, String(patch.perKeyLimit));
  }
  return getOrchestrationSettings(db);
}
