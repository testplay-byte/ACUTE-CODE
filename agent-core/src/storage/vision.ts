/**
 * ROUND-66 (R66-2-b, owner directive B3+B5): the DEDICATED image-analysis
 * (vision) settings — extracted OUT of computer use into their own section
 * (Settings → Image Analysis). The owner: "remove the vision model from
 * [computer use] and create a DEDICATED section… allow the user to select
 * it much more properly… provider and model… paste in the API key", plus
 * "without using the computer use skill, the agent can just generally use
 * [image analysis]" — so these settings are GLOBAL: the computer-use
 * screenshot relay, the embedded-browser screenshot relay AND the general
 * analyze_image tool all read THIS module (one vision configuration, one
 * honest failure story).
 *
 * Keys (the `settings` table, migration 0001 — same access pattern as
 * storage/computer-use.ts / settings.ts):
 *
 *   vision.mode      — "off" | "separate" | "main" (default "off").
 *                      "separate" = the dedicated vision model
 *                      (provider+modelId+key, configured completely
 *                      independently); "main" = use the turn's main model
 *                      when its row has supports_vision = 1.
 *   vision.provider  — provider id for the separate vision model (any
 *                      provider row; the vision KEY rides the keyring slot
 *                      ACUTE_PROVIDER_<ID>_VISION via the pseudo-provider
 *                      "<id>-vision" — the SAME store_provider_key handoff
 *                      route and credential-target pattern as every other
 *                      key; nothing new to trust).
 *   vision.modelId   — the model id on that provider.
 *
 * MIGRATION FROM R61 (the lazy half): the pre-R66 rows were
 * `computerUse.vision.mode/provider/modelId`. Migration 0025 seeds the new
 * rows from them (INSERT … SELECT, absent source keys insert nothing) —
 * this module ALSO carries a READ-ONLY fallback for engines that open a
 * database 0025 has not touched: when `vision.mode` is ABSENT but the
 * legacy `computerUse.vision.mode` exists, getVisionSettings reads the OLD
 * keys (nothing is written — the first setVisionSettings write lands
 * `vision.mode` and the legacy rows are ignored forever after). Both paths
 * are idempotent by construction; the legacy rows STAY in the table.
 *
 * Everything is clamped/validated on WRITE (storage is the boundary) and
 * defaults safely on READ (a missing/corrupt row never breaks a turn — the
 * readNumber/readEnum helpers below mirror computer-use.ts).
 */
import type { SqliteDatabase } from "./db.js";

export type VisionMode = "off" | "separate" | "main";

export interface VisionSettings {
  mode: VisionMode;
  provider: string | null;
  modelId: string | null;
}

export const VISION_SETTINGS_DEFAULTS: VisionSettings = {
  mode: "off",
  provider: null,
  modelId: null,
};

const MODE_KEY = "vision.mode";
const PROVIDER_KEY = "vision.provider";
const MODEL_KEY = "vision.modelId";

// The pre-R66 (R61) keys — read-only compatibility, never written here.
const LEGACY_MODE_KEY = "computerUse.vision.mode";
const LEGACY_PROVIDER_KEY = "computerUse.vision.provider";
const LEGACY_MODEL_KEY = "computerUse.vision.modelId";

const VISION_MODE_VALUES: readonly VisionMode[] = ["off", "separate", "main"];
const PROVIDER_ID_RE = /^[a-z0-9_-]+$/;

function readRow(db: SqliteDatabase, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function readEnum<T extends string>(
  db: SqliteDatabase,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = readRow(db, key);
  if (raw === undefined) return fallback;
  const hit = allowed.find((v) => v === raw);
  return hit ?? fallback;
}

function readNullable(db: SqliteDatabase, key: string): string | null {
  const raw = readRow(db, key);
  if (raw === undefined || raw === "") return null;
  return raw;
}

/**
 * Read the global vision settings. Defaults safely when rows are missing;
 * the LAZY MIGRATION above applies when only the legacy R61 keys exist.
 */
export function getVisionSettings(db: SqliteDatabase): VisionSettings {
  const lazySeed =
    readRow(db, MODE_KEY) === undefined && readRow(db, LEGACY_MODE_KEY) !== undefined;
  const modeKey = lazySeed ? LEGACY_MODE_KEY : MODE_KEY;
  const providerKey = lazySeed ? LEGACY_PROVIDER_KEY : PROVIDER_KEY;
  const modelKey = lazySeed ? LEGACY_MODEL_KEY : MODEL_KEY;
  return {
    mode: readEnum(db, modeKey, VISION_MODE_VALUES, VISION_SETTINGS_DEFAULTS.mode),
    provider: readNullable(db, providerKey),
    modelId: readNullable(db, modelKey),
  };
}

/** Upsert helper (ON CONFLICT — the settings.ts pattern). */
function upsert(db: SqliteDatabase, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/** Removes a key (used when a nullable field is cleared). */
function remove(db: SqliteDatabase, key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

export interface VisionSettingsPatch {
  mode?: VisionMode;
  /** null clears; undefined = untouched. */
  provider?: string | null;
  modelId?: string | null;
}

/**
 * Validated partial patch (the storage-is-the-boundary convention). The
 * writes ALWAYS land on the NEW vision.* keys — a legacy computerUse.vision.*
 * reader stops being consulted the moment `vision.mode` exists.
 */
export function setVisionSettings(
  db: SqliteDatabase,
  patch: VisionSettingsPatch,
): VisionSettings {
  if (patch.mode !== undefined) {
    if (!VISION_MODE_VALUES.includes(patch.mode)) {
      throw new Error(`mode must be one of ${VISION_MODE_VALUES.join(" | ")}`);
    }
    upsert(db, MODE_KEY, patch.mode);
  }
  if (patch.provider !== undefined) {
    if (patch.provider === null || patch.provider === "") {
      remove(db, PROVIDER_KEY);
    } else {
      if (!PROVIDER_ID_RE.test(patch.provider)) {
        throw new Error("provider must be a lowercase slug (a-z, 0-9, '-', '_')");
      }
      upsert(db, PROVIDER_KEY, patch.provider);
    }
  }
  if (patch.modelId !== undefined) {
    if (patch.modelId === null || patch.modelId === "") {
      remove(db, MODEL_KEY);
    } else {
      if (patch.modelId.length > 256) {
        throw new Error("modelId must be at most 256 chars");
      }
      upsert(db, MODEL_KEY, patch.modelId);
    }
  }
  return getVisionSettings(db);
}

/**
 * The keyring provider id that holds the SEPARATE vision model's key:
 * "<providerId>-vision" — read by computer/vision.ts through the keyring's
 * env-var derivation (ACUTE_PROVIDER_<ID>_VISION). This is the exact
 * pattern R51 used for openrouter-slot{2,3,4}: a slug-suffixed pseudo
 * provider whose key rides the SAME store_provider_key handoff + credential
 * target (ACUTE-CODE/provider/<id>) as every other key. Moved here from
 * storage/computer-use.ts in R66 (the slot is THE slot — the R61
 * /computer-use/vision-key routes and the Tauri store_vision_key command
 * keep using it unchanged); computer-use.ts re-exports it for back-compat.
 */
export function visionKeyringId(providerId: string): string {
  return `${providerId}-vision`;
}
