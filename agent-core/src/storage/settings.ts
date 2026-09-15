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

// ── ROUND-97 (R97-D): the thinking-loop guard settings ────────────────────────
//
// The owner's eighth report: "Currently the thinking loop is quite bad and it
// does not allow the model to think as it needs to. I do feel like the thinking
// loop functionality is a good thing to have but I think we should give the
// user the option in the settings to turn it on or off. By default it will be
// turned off so that the model can think as much as it needs to and can handle
// the things better. Make sure to handle it like that and also give the user
// the option and flexibility to edit the thinking loop management and handle
// it better."
//
//   thinkingLoop.enabled          — the master switch (DEFAULT FALSE per the
//                                   directive — the model thinks freely; the
//                                   R95-E watchdog only arms when ON).
//   thinkingLoop.stallSeconds     — the no-progress window that arms the
//                                   watchdog (default 120s, clamp 30–600).
//   thinkingLoop.reasoningBytesKB  — the reasoning volume that arms it (default
//                                   24KB, clamp 8–256 — BOTH conditions must
//                                   hold, the R95-E conjunction).

export interface ThinkingLoopSettings {
  enabled: boolean;
  stallSeconds: number;
  reasoningBytesKB: number;
}

export const THINKING_LOOP_DEFAULTS: ThinkingLoopSettings = {
  enabled: false,
  stallSeconds: 120,
  reasoningBytesKB: 24,
};

const THINKING_LOOP_ENABLED_KEY = "thinkingLoop.enabled";
const THINKING_LOOP_STALL_KEY = "thinkingLoop.stallSeconds";
const THINKING_LOOP_BYTES_KEY = "thinkingLoop.reasoningBytesKB";

export function getThinkingLoopSettings(db: SqliteDatabase): ThinkingLoopSettings {
  return {
    enabled: readBoolean(db, THINKING_LOOP_ENABLED_KEY, THINKING_LOOP_DEFAULTS.enabled),
    stallSeconds: readNumber(
      db,
      THINKING_LOOP_STALL_KEY,
      THINKING_LOOP_DEFAULTS.stallSeconds,
      30,
      600,
    ),
    reasoningBytesKB: readNumber(
      db,
      THINKING_LOOP_BYTES_KEY,
      THINKING_LOOP_DEFAULTS.reasoningBytesKB,
      8,
      256,
    ),
  };
}

/** Partial patch (the setRetrySettings pattern): only provided keys write; a
 * bad type or an out-of-bounds number throws (the route maps that to a 400
 * VALIDATION). The clamps match getThinkingLoopSettings's reads. */
export function setThinkingLoopSettings(
  db: SqliteDatabase,
  patch: Partial<ThinkingLoopSettings>,
): ThinkingLoopSettings {
  const upsert = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") {
      throw new Error("enabled must be a boolean");
    }
    upsert.run(THINKING_LOOP_ENABLED_KEY, String(patch.enabled));
  }
  if (patch.stallSeconds !== undefined) {
    if (
      typeof patch.stallSeconds !== "number" ||
      !Number.isInteger(patch.stallSeconds) ||
      patch.stallSeconds < 30 ||
      patch.stallSeconds > 600
    ) {
      throw new Error("stallSeconds must be an integer between 30 and 600");
    }
    upsert.run(THINKING_LOOP_STALL_KEY, String(patch.stallSeconds));
  }
  if (patch.reasoningBytesKB !== undefined) {
    if (
      typeof patch.reasoningBytesKB !== "number" ||
      !Number.isInteger(patch.reasoningBytesKB) ||
      patch.reasoningBytesKB < 8 ||
      patch.reasoningBytesKB > 256
    ) {
      throw new Error("reasoningBytesKB must be an integer between 8 and 256");
    }
    upsert.run(THINKING_LOOP_BYTES_KEY, String(patch.reasoningBytesKB));
  }
  return getThinkingLoopSettings(db);
}

// ── ROUND-97 (R97-G): the browser settings domain ────────────────────────────
//
// The owner: "I would also like you to add a dedicated section in the settings
// for the browser, like a dedicated browser section in the settings, which I
// can use to edit some settings of the browsers, manage the browser, and
// handle the browser in a bit more proper and better-managed way."
//
//   browser.searchEngine   — the address bar's QUERY fallback (default
//                            duckduckgo — the pre-R97 hardcoded behavior).
//   browser.homepage       — the Home button's target (default
//                            "acute://home" = the panel's quick-links page).
//   browser.defaultZoom    — new browser sessions start at this zoom
//                            (0.25–3, default 1).
//   browser.quickLinks     — the quick-links row on the home page (JSON
//                            array of {label, url}; default = the R87 trio).
//   browser.linkOpeningMode — where in-app links open (R99-A): "in-app"
//                            (the embedded browser panel) | "system"
//                            (the device's default browser). Default
//                            in-app — the app ships its own browser engine
//                            now, so links stay inside it.

export interface BrowserQuickLink {
  label: string;
  url: string;
}

export type LinkOpeningMode = "in-app" | "system";

export interface BrowserSettings {
  searchEngine: "duckduckgo" | "google" | "bing" | "brave";
  homepage: string;
  defaultZoom: number;
  quickLinks: BrowserQuickLink[];
  linkOpeningMode: LinkOpeningMode;
}

export const BROWSER_SETTINGS_DEFAULTS: BrowserSettings = {
  searchEngine: "duckduckgo",
  homepage: "acute://home",
  defaultZoom: 1,
  quickLinks: [
    { label: "GitHub", url: "https://github.com" },
    { label: "MDN", url: "https://developer.mozilla.org" },
    { label: "This app (dev)", url: "http://localhost:5173" },
  ],
  linkOpeningMode: "in-app",
};

const BROWSER_SEARCH_ENGINE_KEY = "browser.searchEngine";
const BROWSER_HOMEPAGE_KEY = "browser.homepage";
const BROWSER_DEFAULT_ZOOM_KEY = "browser.defaultZoom";
const BROWSER_QUICK_LINKS_KEY = "browser.quickLinks";
const BROWSER_LINK_OPENING_MODE_KEY = "browser.linkOpeningMode";

const SEARCH_ENGINES: ReadonlySet<string> = new Set(["duckduckgo", "google", "bing", "brave"]);
const LINK_OPENING_MODES: ReadonlySet<string> = new Set(["in-app", "system"]);

/** The engine → search-URL template (the frontend mirror lives in
 * api.ts — the panel's normalizeUrl builds from the same table). */
export const SEARCH_ENGINE_TEMPLATES: Record<BrowserSettings["searchEngine"], string> = {
  duckduckgo: "https://duckduckgo.com/?q=",
  google: "https://www.google.com/search?q=",
  bing: "https://www.bing.com/search?q=",
  brave: "https://search.brave.com/search?q=",
};

/** Reads the quickLinks JSON row defensively: absent/corrupt/out-of-shape
 * entries fall back to the defaults (the readWaitMinutes pattern). */
function readQuickLinks(db: SqliteDatabase): BrowserQuickLink[] {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(BROWSER_QUICK_LINKS_KEY) as
    | { value: string }
    | undefined;
  if (row === undefined) return [...BROWSER_SETTINGS_DEFAULTS.quickLinks];
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return [...BROWSER_SETTINGS_DEFAULTS.quickLinks];
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 12) {
    return [...BROWSER_SETTINGS_DEFAULTS.quickLinks];
  }
  const out: BrowserQuickLink[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { label?: unknown; url?: unknown };
    if (typeof e.label !== "string" || typeof e.url !== "string") continue;
    const label = e.label.trim().slice(0, 40);
    const url = e.url.trim().slice(0, 500);
    if (label === "" || url === "") continue;
    out.push({ label, url });
  }
  return out.length > 0 ? out : [...BROWSER_SETTINGS_DEFAULTS.quickLinks];
}

/** The zoom is FRACTIONAL (0.25 steps) — readNumber's integer gate would
 * round every 1.25/1.5 back to the default. This local read keeps two
 * decimals and clamps into the same bounds the write validates. */
function readDefaultZoom(db: SqliteDatabase): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(BROWSER_DEFAULT_ZOOM_KEY) as
    | { value: string }
    | undefined;
  if (row === undefined) return BROWSER_SETTINGS_DEFAULTS.defaultZoom;
  const parsed = Number(row.value);
  if (!Number.isFinite(parsed)) return BROWSER_SETTINGS_DEFAULTS.defaultZoom;
  return Math.min(3, Math.max(0.25, Math.round(parsed * 100) / 100));
}

export function getBrowserSettings(db: SqliteDatabase): BrowserSettings {
  const engineRow = db.prepare("SELECT value FROM settings WHERE key = ?").get(BROWSER_SEARCH_ENGINE_KEY) as
    | { value: string }
    | undefined;
  const searchEngine = SEARCH_ENGINES.has(engineRow?.value ?? "")
    ? (engineRow!.value as BrowserSettings["searchEngine"])
    : BROWSER_SETTINGS_DEFAULTS.searchEngine;
  const homepageRow = db.prepare("SELECT value FROM settings WHERE key = ?").get(BROWSER_HOMEPAGE_KEY) as
    | { value: string }
    | undefined;
  const homepage = typeof homepageRow?.value === "string" ? homepageRow.value.slice(0, 500) : BROWSER_SETTINGS_DEFAULTS.homepage;
  const linkModeRow = db.prepare("SELECT value FROM settings WHERE key = ?").get(BROWSER_LINK_OPENING_MODE_KEY) as
    | { value: string }
    | undefined;
  const linkOpeningMode = LINK_OPENING_MODES.has(linkModeRow?.value ?? "")
    ? (linkModeRow!.value as LinkOpeningMode)
    : BROWSER_SETTINGS_DEFAULTS.linkOpeningMode;
  return {
    searchEngine,
    homepage: homepage === "" ? BROWSER_SETTINGS_DEFAULTS.homepage : homepage,
    defaultZoom: readDefaultZoom(db),
    quickLinks: readQuickLinks(db),
    linkOpeningMode,
  };
}

/** Partial patch. Validation: the engine must be one of the four; the zoom an
 * integer-ish 0.25–3 (two decimals); the quickLinks a 1–12 array of non-blank
 * {label, url}; the linkOpeningMode one of the two R99-A values. Throws map
 * to the route's 400s. */
export function setBrowserSettings(
  db: SqliteDatabase,
  patch: Partial<BrowserSettings>,
): BrowserSettings {
  const upsert = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  if (patch.searchEngine !== undefined) {
    if (!SEARCH_ENGINES.has(patch.searchEngine)) {
      throw new Error("searchEngine must be one of duckduckgo, google, bing, brave");
    }
    upsert.run(BROWSER_SEARCH_ENGINE_KEY, patch.searchEngine);
  }
  if (patch.homepage !== undefined) {
    if (typeof patch.homepage !== "string" || patch.homepage.length > 500) {
      throw new Error("homepage must be a string of at most 500 characters");
    }
    upsert.run(BROWSER_HOMEPAGE_KEY, patch.homepage.trim());
  }
  if (patch.defaultZoom !== undefined) {
    if (typeof patch.defaultZoom !== "number" || !Number.isFinite(patch.defaultZoom) || patch.defaultZoom < 0.25 || patch.defaultZoom > 3) {
      throw new Error("defaultZoom must be a number between 0.25 and 3");
    }
    upsert.run(BROWSER_DEFAULT_ZOOM_KEY, String(Math.round(patch.defaultZoom * 100) / 100));
  }
  if (patch.quickLinks !== undefined) {
    if (!Array.isArray(patch.quickLinks) || patch.quickLinks.length === 0 || patch.quickLinks.length > 12) {
      throw new Error("quickLinks must be an array of 1 to 12 links");
    }
    for (const link of patch.quickLinks) {
      if (
        typeof link !== "object" ||
        link === null ||
        typeof (link as { label?: unknown }).label !== "string" ||
        (link as { label: string }).label.trim() === "" ||
        typeof (link as { url?: unknown }).url !== "string" ||
        (link as { url: string }).url.trim() === ""
      ) {
        throw new Error("quickLinks entries must be non-blank {label, url} objects");
      }
    }
    upsert.run(BROWSER_QUICK_LINKS_KEY, JSON.stringify(patch.quickLinks));
  }
  if (patch.linkOpeningMode !== undefined) {
    if (!LINK_OPENING_MODES.has(patch.linkOpeningMode)) {
      throw new Error("linkOpeningMode must be either \"in-app\" or \"system\"");
    }
    upsert.run(BROWSER_LINK_OPENING_MODE_KEY, patch.linkOpeningMode);
  }
  return getBrowserSettings(db);
}

// ── ROUND-98 (R98-J, owner: task complete / failed / permission needed →
//    "it will send me a notification on my PC"): the DESKTOP-NOTIFICATIONS
//    switch — gates the Tauri notification bridge's fan-out (the frontend
//    src/lib/desktop-notifications.ts caches THIS value in memory so a
//    flip takes effect on the very next record, no restart). The
//    setDebugSettings pattern exactly: one boolean row, default ON (the
//    pre-R98 behavior — the Toaster already fired web notifications, so
//    the desktop leg ships enabled). ─────────────────────────────────────

export interface DesktopNotificationsSettings {
  enabled: boolean;
}

export const DESKTOP_NOTIFICATIONS_DEFAULTS: DesktopNotificationsSettings = {
  enabled: true,
};

const DESKTOP_NOTIFICATIONS_ENABLED_KEY = "desktopNotifications.enabled";

export function getDesktopNotificationsSettings(db: SqliteDatabase): DesktopNotificationsSettings {
  return { enabled: readBoolean(db, DESKTOP_NOTIFICATIONS_ENABLED_KEY, DESKTOP_NOTIFICATIONS_DEFAULTS.enabled) };
}

export function setDesktopNotificationsSettings(
  db: SqliteDatabase,
  patch: Partial<DesktopNotificationsSettings>,
): DesktopNotificationsSettings {
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") {
      throw new Error("enabled must be a boolean");
    }
    db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(DESKTOP_NOTIFICATIONS_ENABLED_KEY, String(patch.enabled));
  }
  return getDesktopNotificationsSettings(db);
}
