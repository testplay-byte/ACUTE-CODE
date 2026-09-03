/**
 * ROUND-36 (ADR-0022): orchestration settings — persisted in the `settings`
 * table (migration 0001) with typed accessors + defaults.
 *
 *   orchestration.maxParallel   — total concurrent sub-agent runs (default 5,
 *                                 clamp 1–50; the owner's stated range).
 *   orchestration.perKeyLimit   — concurrent sub-agents per API key (default
 *                                 3, clamp 1–20) — "not burden the API keys".
 *   orchestration.subagentModel — ROUND-43 (R43-5, owner directive: a
 *                                 temporary sub-agent model override)
 *                                 model id ALL sub-agent children run on,
 *                                 regardless of the seeded agents' models;
 *                                 null = inherit the parent agent's model
 *                                 (the pre-R43 behavior). Validated against
 *                                 the models.ts catalog on write and must be
 *                                 tool-capable (children are mandated tool
 *                                 users — ROUND-39).
 *   orchestration.childWatchdogMs      — ROUND-52 (R52-b): how often the
 *                                 supervisor samples a running child and
 *                                 emits a heartbeat frame (default 15s,
 *                                 clamp 5s–60s).
 *   orchestration.childStallTimeoutMs  — ROUND-52 (R52-b): no child events
 *                                 for this long = STALLED (hung command,
 *                                 dead provider) → the watchdog aborts the
 *                                 child and reports honestly to the parent
 *                                 (default 5 min, clamp 1 min–60 min).
 *
 * ROUND-49 (owner directive: "maybe try giving me a setting in the settings
 * to turn off this memory functionality"):
 *   memory.enabled — the master switch for the agent MEMORY system (default
 *                    true). When false: no memory digest is injected into
 *                    any system prompt, the memory_save/recall/list tools
 *                    are not registered, and the Memory panel says so. The
 *                    memory TABLE is never dropped — data survives a
 *                    re-enable untouched.
 */
import type { SqliteDatabase } from "./db.js";
import { getCatalogModel, isKnownCatalogModelId } from "./models.js";

export interface OrchestrationSettings {
  maxParallel: number;
  perKeyLimit: number;
  subagentModel: string | null;
  childWatchdogMs: number;
  childStallTimeoutMs: number;
}

export const ORCHESTRATION_DEFAULTS: OrchestrationSettings = {
  maxParallel: 5,
  perKeyLimit: 3,
  subagentModel: null,
  childWatchdogMs: 15_000,
  childStallTimeoutMs: 300_000,
};

const MAX_PARALLEL_KEY = "orchestration.maxParallel";
const PER_KEY_LIMIT_KEY = "orchestration.perKeyLimit";
const SUBAGENT_MODEL_KEY = "orchestration.subagentModel";
const CHILD_WATCHDOG_MS_KEY = "orchestration.childWatchdogMs";
const CHILD_STALL_TIMEOUT_MS_KEY = "orchestration.childStallTimeoutMs";

function readNumber(db: SqliteDatabase, key: string, fallback: number, min: number, max: number): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (row === undefined) return fallback;
  const parsed = Number(row.value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Reads a nullable string setting (absent/empty row → null). */
function readNullableString(db: SqliteDatabase, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (row === undefined || row.value === "") return null;
  return row.value;
}

export function getOrchestrationSettings(db: SqliteDatabase): OrchestrationSettings {
  return {
    maxParallel: readNumber(db, MAX_PARALLEL_KEY, ORCHESTRATION_DEFAULTS.maxParallel, 1, 50),
    perKeyLimit: readNumber(db, PER_KEY_LIMIT_KEY, ORCHESTRATION_DEFAULTS.perKeyLimit, 1, 20),
    subagentModel: readNullableString(db, SUBAGENT_MODEL_KEY),
    childWatchdogMs: readNumber(
      db,
      CHILD_WATCHDOG_MS_KEY,
      ORCHESTRATION_DEFAULTS.childWatchdogMs,
      5_000,
      60_000,
    ),
    childStallTimeoutMs: readNumber(
      db,
      CHILD_STALL_TIMEOUT_MS_KEY,
      ORCHESTRATION_DEFAULTS.childStallTimeoutMs,
      60_000,
      3_600_000,
    ),
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
  if (patch.subagentModel !== undefined) {
    if (patch.subagentModel === null) {
      // Clear = remove the row entirely (absent key reads back as null).
      db.prepare("DELETE FROM settings WHERE key = ?").run(SUBAGENT_MODEL_KEY);
    } else {
      const id = patch.subagentModel;
      if (!isKnownCatalogModelId(id)) {
        throw new Error(
          `subagentModel must be a known catalog model id (got '${id}')`,
        );
      }
      if (getCatalogModel(id)?.supportsTools === false) {
        throw new Error(
          `subagentModel '${id}' does not support tool calling — sub-agents are mandated tool users`,
        );
      }
      upsert.run(SUBAGENT_MODEL_KEY, id);
    }
  }
  // ROUND-52 (R52-b): the supervisor cadence + stall threshold.
  if (patch.childWatchdogMs !== undefined) {
    if (!Number.isInteger(patch.childWatchdogMs) || patch.childWatchdogMs < 5_000 || patch.childWatchdogMs > 60_000) {
      throw new Error("childWatchdogMs must be an integer between 5000 and 60000");
    }
    upsert.run(CHILD_WATCHDOG_MS_KEY, String(patch.childWatchdogMs));
  }
  if (patch.childStallTimeoutMs !== undefined) {
    if (
      !Number.isInteger(patch.childStallTimeoutMs) ||
      patch.childStallTimeoutMs < 60_000 ||
      patch.childStallTimeoutMs > 3_600_000
    ) {
      throw new Error("childStallTimeoutMs must be an integer between 60000 and 3600000");
    }
    upsert.run(CHILD_STALL_TIMEOUT_MS_KEY, String(patch.childStallTimeoutMs));
  }
  return getOrchestrationSettings(db);
}

// ── ROUND-49: memory settings (the master switch) ──────────────────────────

export interface MemorySettings {
  enabled: boolean;
}

export const MEMORY_DEFAULTS: MemorySettings = {
  enabled: true,
};

const MEMORY_ENABLED_KEY = "memory.enabled";

/** Reads a boolean setting ('true'/'false'; anything else = fallback). */
function readBoolean(db: SqliteDatabase, key: string, fallback: boolean): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (row === undefined) return fallback;
  if (row.value === "true") return true;
  if (row.value === "false") return false;
  return fallback;
}

export function getMemorySettings(db: SqliteDatabase): MemorySettings {
  return { enabled: readBoolean(db, MEMORY_ENABLED_KEY, MEMORY_DEFAULTS.enabled) };
}

export function setMemorySettings(db: SqliteDatabase, patch: Partial<MemorySettings>): MemorySettings {
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") {
      throw new Error("enabled must be a boolean");
    }
    db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(MEMORY_ENABLED_KEY, String(patch.enabled));
  }
  return getMemorySettings(db);
}

// ── ROUND-65: debug settings (the agent self-report switch) ────────────────

export interface DebugSettings {
  enabled: boolean;
}

export const DEBUG_DEFAULTS: DebugSettings = {
  enabled: false,
};

const DEBUG_ENABLED_KEY = "debug.enabled";

export function getDebugSettings(db: SqliteDatabase): DebugSettings {
  return { enabled: readBoolean(db, DEBUG_ENABLED_KEY, DEBUG_DEFAULTS.enabled) };
}

export function setDebugSettings(db: SqliteDatabase, patch: Partial<DebugSettings>): DebugSettings {
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") {
      throw new Error("enabled must be a boolean");
    }
    db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(DEBUG_ENABLED_KEY, String(patch.enabled));
  }
  return getDebugSettings(db);
}
