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
import { getCatalogModel, isKnownCatalogModelId, listModels } from "./models.js";
import { providerExists } from "./providers.js";

/**
 * ROUND-82 (R82, §2.4.5 — the NVIDIA sub-agent gap): the sub-agent model as
 * a PROVIDER-SCOPED reference. Historically a bare OpenRouter-catalog id —
 * NIM/custom rows could never be sub-agent models (the validation was
 * catalog-only). Stored values keep BOTH shapes: a legacy plain string
 * reads as {providerId: "openrouter", modelId: <string>} (every historical
 * value was a catalog id); the object form is the R82 wire shape.
 */
export interface SubagentModelRef {
  providerId: string;
  modelId: string;
}

export interface OrchestrationSettings {
  maxParallel: number;
  perKeyLimit: number;
  /** ROUND-82: normalized to the provider-scoped ref (legacy plain-string
   * values read as openrouter-scoped); null = inherit the parent agent's
   * model (the pre-R43 behavior). */
  subagentModel: SubagentModelRef | null;
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

/**
 * ROUND-82 (R82): parse the stored subagentModel value into the normalized
 * ref. A plain string is a legacy OpenRouter-catalog id → openrouter-scoped
 * (the honest backfill — every pre-R82 value passed catalog validation). A
 * JSON object {providerId, modelId} is the R82 shape. Anything else
 * (corrupt JSON, wrong shape, empty fields) degrades to null — never a
 * crash, never a silent wrong provider.
 */
function readSubagentModel(db: SqliteDatabase): SubagentModelRef | null {
  const stored = readNullableString(db, SUBAGENT_MODEL_KEY);
  if (stored === null) return null;
  // R82 JSON object form.
  if (stored.startsWith("{")) {
    try {
      const parsed = JSON.parse(stored) as { providerId?: unknown; modelId?: unknown };
      if (
        typeof parsed.providerId === "string" &&
        parsed.providerId.trim() !== "" &&
        typeof parsed.modelId === "string" &&
        parsed.modelId.trim() !== ""
      ) {
        return { providerId: parsed.providerId.trim(), modelId: parsed.modelId.trim() };
      }
    } catch {
      // Corrupt JSON — degrade to null below.
    }
    return null;
  }
  // Legacy plain-string form — OpenRouter catalog ids by construction.
  return { providerId: "openrouter", modelId: stored };
}

export function getOrchestrationSettings(db: SqliteDatabase): OrchestrationSettings {
  return {
    maxParallel: readNumber(db, MAX_PARALLEL_KEY, ORCHESTRATION_DEFAULTS.maxParallel, 1, 50),
    perKeyLimit: readNumber(db, PER_KEY_LIMIT_KEY, ORCHESTRATION_DEFAULTS.perKeyLimit, 1, 20),
    subagentModel: readSubagentModel(db),
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

/** ROUND-82 (R82): the PATCH input — subagentModel accepts the provider-
 * scoped ref, the legacy plain catalog id, or null (clear). Reads always
 * return the normalized ref shape. */
export interface OrchestrationSettingsPatch
  extends Partial<Omit<OrchestrationSettings, "subagentModel">> {
  subagentModel?: SubagentModelRef | string | null;
}

export function setOrchestrationSettings(
  db: SqliteDatabase,
  patch: OrchestrationSettingsPatch,
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
    } else if (typeof patch.subagentModel === "string") {
      // Legacy wire form (a catalog id) — kept working for old callers and
      // the openrouter-scoped fast path. Stored verbatim; reads normalize
      // to {providerId: "openrouter", modelId}.
      const id = patch.subagentModel;
      if (!isKnownCatalogModelId(id)) {
        throw new Error(
          `subagentModel must be a known catalog model id (got '${id}') — for a custom provider use the {providerId, modelId} form`,
        );
      }
      if (getCatalogModel(id)?.supportsTools === false) {
        throw new Error(
          `subagentModel '${id}' does not support tool calling — sub-agents are mandated tool users`,
        );
      }
      upsert.run(SUBAGENT_MODEL_KEY, id);
    } else {
      // ROUND-82 (R82, §2.4.5): the provider-scoped ref — a NIM/custom row
      // can be the sub-agent model. Validation: the provider must EXIST;
      // the model id must be non-empty; tool-capability is enforced where
      // KNOWABLE (an explicit false on the configured row rejects; null
      // (unknown) and absent rows pass — the honest tri-state, never the
      // 0004-era "unknown means off" lie).
      const ref = patch.subagentModel;
      if (!providerExists(db, ref.providerId)) {
        throw new Error(
          `subagentModel provider '${ref.providerId}' does not exist`,
        );
      }
      if (ref.modelId.trim() === "") {
        throw new Error("subagentModel modelId must be a non-empty string");
      }
      const configuredRow = listModels(db, ref.providerId).find(
        (m) => m.modelId === ref.modelId,
      );
      if (configuredRow?.supportsTools === false) {
        throw new Error(
          `subagentModel '${ref.modelId}' is marked as NOT tool-capable on '${ref.providerId}' — sub-agents are mandated tool users`,
        );
      }
      upsert.run(SUBAGENT_MODEL_KEY, JSON.stringify(ref));
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

// ── ROUND-78 (R78, owner: "General Settings 重试配置" — a retry-config
//    section) — the per-class AUTO-RETRY switches ─────────────────────────────
//
// The R75 transient-API retry ladder auto-retries rate_limit / network /
// timeout failures (up to six attempts across 30 minutes). These three
// switches let the owner turn each class OFF — a disabled class FAILS FAST
// through the honest terminal path (attempts:1, the provider's real error
// text) instead of waiting out the ladder. Defaults: all ON (the R75
// behavior — the owner's original "retry timeouts and rate limits" spec;
// turning them off is the new opt-out).
//
//   retry.autoRetryRateLimit — 429 / quota storms wait out the ladder (default true)
//   retry.autoRetryTimeout   — provider timeouts wait out the ladder (default true)
//   retry.autoRetryNetwork   — 5xx / transport blips wait out the ladder (default true)

//   retry.maxAttempts   — ROUND-80 (R80, owner: "in the settings retry
//   customization is needed"): total provider attempts per turn (initial
//   call + rungs), integer 2–10, default 6 (the R75 spec).
//   retry.waitMinutes   — the rung waits in MINUTES (JSON array; index =
//   retry number - 1), default [0, 1.5, 5, 10, 30] (the R75 schedule).
//   Each entry validates 0–1440; the runtime's resolveRetrySchedule()
//   resolves per-rung fallbacks, so a shorter/longer array than
//   maxAttempts-1 never breaks the ladder.
//   retry.providerTimeoutSeconds — the per-call provider ceiling (seconds,
//   integer 60–3600, default 600 = chat.ts PROVIDER_CALL_TIMEOUT_MS);
//   a call exceeding it aborts → class timeout → the ladder (if enabled).

export interface RetrySettings {
  autoRetryRateLimit: boolean;
  autoRetryTimeout: boolean;
  autoRetryNetwork: boolean;
  /** R80: total attempts per turn (initial + rungs), 2–10, default 6. */
  maxAttempts: number;
  /** R80: rung waits in minutes (rung i = wait before attempt i+2),
   * default [0, 1.5, 5, 10, 30]. Length may differ from maxAttempts-1;
   * resolution pads/truncates per-rung. */
  waitMinutes: number[];
  /** R80: provider call ceiling in seconds, 60–3600, default 600. */
  providerTimeoutSeconds: number;
}

export const RETRY_DEFAULTS: RetrySettings = {
  autoRetryRateLimit: true,
  autoRetryTimeout: true,
  autoRetryNetwork: true,
  maxAttempts: 6,
  waitMinutes: [0, 1.5, 5, 10, 30],
  providerTimeoutSeconds: 600,
};

const AUTO_RETRY_RATE_LIMIT_KEY = "retry.autoRetryRateLimit";
const AUTO_RETRY_TIMEOUT_KEY = "retry.autoRetryTimeout";
const AUTO_RETRY_NETWORK_KEY = "retry.autoRetryNetwork";
const RETRY_MAX_ATTEMPTS_KEY = "retry.maxAttempts";
const RETRY_WAIT_MINUTES_KEY = "retry.waitMinutes";
const PROVIDER_TIMEOUT_SECONDS_KEY = "retry.providerTimeoutSeconds";

/** Reads the waitMinutes JSON row defensively: absent/corrupt/out-of-bounds
 * entries fall back to the R75 default rung-by-rung (resolveRetrySchedule's
 * exact rule, applied at the read boundary so every consumer sees a sane
 * array without re-validating). */
function readWaitMinutes(db: SqliteDatabase): number[] {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(RETRY_WAIT_MINUTES_KEY) as
    | { value: string }
    | undefined;
  if (row === undefined) return [...RETRY_DEFAULTS.waitMinutes];
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return [...RETRY_DEFAULTS.waitMinutes];
  }
  if (!Array.isArray(parsed)) return [...RETRY_DEFAULTS.waitMinutes];
  const out: number[] = [];
  for (let i = 0; i < parsed.length && i < 9; i += 1) {
    const entry = parsed[i];
    out.push(
      typeof entry === "number" && Number.isFinite(entry) && entry >= 0 && entry <= 1440
        ? entry
        : (RETRY_DEFAULTS.waitMinutes[i] ?? RETRY_DEFAULTS.waitMinutes[4]),
    );
  }
  return out.length > 0 ? out : [...RETRY_DEFAULTS.waitMinutes];
}

export function getRetrySettings(db: SqliteDatabase): RetrySettings {
  return {
    autoRetryRateLimit: readBoolean(db, AUTO_RETRY_RATE_LIMIT_KEY, RETRY_DEFAULTS.autoRetryRateLimit),
    autoRetryTimeout: readBoolean(db, AUTO_RETRY_TIMEOUT_KEY, RETRY_DEFAULTS.autoRetryTimeout),
    autoRetryNetwork: readBoolean(db, AUTO_RETRY_NETWORK_KEY, RETRY_DEFAULTS.autoRetryNetwork),
    // readNumber clamps into bounds (a hand-edited row can never produce an
    // impossible schedule); waitMinutes reads with its own per-rung fallbacks.
    maxAttempts: readNumber(db, RETRY_MAX_ATTEMPTS_KEY, RETRY_DEFAULTS.maxAttempts, 2, 10),
    waitMinutes: readWaitMinutes(db),
    providerTimeoutSeconds: readNumber(
      db,
      PROVIDER_TIMEOUT_SECONDS_KEY,
      RETRY_DEFAULTS.providerTimeoutSeconds,
      60,
      3600,
    ),
  };
}

/** Partial patch (the setDebugSettings pattern): only provided keys write;
 * non-boolean values throw — the route maps that to a 400 VALIDATION.
 * R80: the numeric fields validate against the same bounds the runtime
 * resolves with (maxAttempts 2–10, waitMinutes entries 0–1440, array length
 * ≤ 9, providerTimeoutSeconds 60–3600). */
export function setRetrySettings(db: SqliteDatabase, patch: Partial<RetrySettings>): RetrySettings {
  const upsert = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const fields: Array<[keyof RetrySettings, string]> = [
    ["autoRetryRateLimit", AUTO_RETRY_RATE_LIMIT_KEY],
    ["autoRetryTimeout", AUTO_RETRY_TIMEOUT_KEY],
    ["autoRetryNetwork", AUTO_RETRY_NETWORK_KEY],
  ];
  for (const [field, key] of fields) {
    const value = patch[field];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      throw new Error(`${field} must be a boolean`);
    }
    upsert.run(key, String(value));
  }
  if (patch.maxAttempts !== undefined) {
    if (typeof patch.maxAttempts !== "number" || !Number.isInteger(patch.maxAttempts) || patch.maxAttempts < 2 || patch.maxAttempts > 10) {
      throw new Error("maxAttempts must be an integer between 2 and 10");
    }
    upsert.run(RETRY_MAX_ATTEMPTS_KEY, String(patch.maxAttempts));
  }
  if (patch.waitMinutes !== undefined) {
    if (!Array.isArray(patch.waitMinutes) || patch.waitMinutes.length === 0 || patch.waitMinutes.length > 9) {
      throw new Error("waitMinutes must be an array of 1 to 9 numbers");
    }
    for (const entry of patch.waitMinutes) {
      if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0 || entry > 1440) {
        throw new Error("waitMinutes entries must be numbers between 0 and 1440 (minutes)");
      }
    }
    upsert.run(RETRY_WAIT_MINUTES_KEY, JSON.stringify(patch.waitMinutes));
  }
  if (patch.providerTimeoutSeconds !== undefined) {
    if (
      typeof patch.providerTimeoutSeconds !== "number" ||
      !Number.isInteger(patch.providerTimeoutSeconds) ||
      patch.providerTimeoutSeconds < 60 ||
      patch.providerTimeoutSeconds > 3600
    ) {
      throw new Error("providerTimeoutSeconds must be an integer between 60 and 3600");
    }
    upsert.run(PROVIDER_TIMEOUT_SECONDS_KEY, String(patch.providerTimeoutSeconds));
  }
  return getRetrySettings(db);
}
