/**
 * ROUND-61 (R61): computer-use settings — persisted in the `settings` table
 * (migration 0001) with typed accessors + defaults, the same shape as
 * storage/settings.ts (ADR-0022). Keys:
 *
 *   computerUse.enabled          — the master switch (default FALSE: the
 *                                   whole computer-use tool surface is dark
 *                                   until the owner turns it on. The owner's
 *                                   directive: "give the user the option to
 *                                   turn on and off the computer use").
 *   computerUse.permission       — the host policy posture:
 *                                   "observe" = only read-only tools are
 *                                   registered (list/get/screenshot/…);
 *                                   "act"     = mutating tools registered,
 *                                               riding the approval channel
 *                                               in ask permission-mode;
 *                                   "auto"    = mutating tools with no
 *                                               per-action approval prompts
 *                                               (full mode equivalent).
 *                                   Default "act".
 *   computerUse.vision.mode      — "off" | "separate" | "main" (default
 *                                   "off"). "separate" = the dedicated
 *                                   vision model (provider+modelId+key,
 *                                   configured completely independently per
 *                                   the owner's directive); "main" = use
 *                                   the turn's main model when its row has
 *                                   supports_vision = 1.
 *   computerUse.vision.provider  — provider id for the separate vision
 *                                   model (any provider row; the vision KEY
 *                                   rides the keyring slot
 *                                   ACUTE_PROVIDER_<ID>_VISION via the
 *                                   pseudo-provider "<id>-vision" — the
 *                                   SAME store_provider_key handoff route
 *                                   and credential-target pattern as every
 *                                   other key; nothing new to trust).
 *   computerUse.vision.modelId   — the model id on that provider.
 *
 * Everything is clamped/validated on WRITE (storage is the boundary) and
 * defaults safely on READ (a missing/corrupt row never breaks a turn — the
 * readNumber/readBool/readString helpers below mirror settings.ts).
 */
import type { SqliteDatabase } from "./db.js";

export type ComputerUsePermissionPosture = "observe" | "act" | "auto";
export type VisionMode = "off" | "separate" | "main";

export interface ComputerUseSettings {
  enabled: boolean;
  permission: ComputerUsePermissionPosture;
  vision: {
    mode: VisionMode;
    provider: string | null;
    modelId: string | null;
  };
}

export const COMPUTER_USE_DEFAULTS: ComputerUseSettings = {
  enabled: false,
  permission: "act",
  vision: { mode: "off", provider: null, modelId: null },
};

const ENABLED_KEY = "computerUse.enabled";
const PERMISSION_KEY = "computerUse.permission";
const VISION_MODE_KEY = "computerUse.vision.mode";
const VISION_PROVIDER_KEY = "computerUse.vision.provider";
const VISION_MODEL_KEY = "computerUse.vision.modelId";

const PERMISSION_VALUES: readonly ComputerUsePermissionPosture[] = ["observe", "act", "auto"];
const VISION_MODE_VALUES: readonly VisionMode[] = ["off", "separate", "main"];
const PROVIDER_ID_RE = /^[a-z0-9_-]+$/;

function readRow(db: SqliteDatabase, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function readBool(db: SqliteDatabase, key: string, fallback: boolean): boolean {
  const raw = readRow(db, key);
  if (raw === undefined) return fallback;
  return raw === "1" || raw === "true";
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

export function getComputerUseSettings(db: SqliteDatabase): ComputerUseSettings {
  return {
    enabled: readBool(db, ENABLED_KEY, COMPUTER_USE_DEFAULTS.enabled),
    permission: readEnum(db, PERMISSION_KEY, PERMISSION_VALUES, COMPUTER_USE_DEFAULTS.permission),
    vision: {
      mode: readEnum(db, VISION_MODE_KEY, VISION_MODE_VALUES, COMPUTER_USE_DEFAULTS.vision.mode),
      provider: readNullable(db, VISION_PROVIDER_KEY),
      modelId: readNullable(db, VISION_MODEL_KEY),
    },
  };
}

/** Upsert helper (ON CONFLICT — the settings.ts pattern). */
function upsert(db: SqliteDatabase, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/** Removes a key (used when a nullable vision field is cleared). */
function remove(db: SqliteDatabase, key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

export interface ComputerUseSettingsPatch {
  enabled?: boolean;
  permission?: ComputerUsePermissionPosture;
  vision?: {
    mode?: VisionMode;
    /** null clears; undefined = untouched. */
    provider?: string | null;
    modelId?: string | null;
  };
}

export function setComputerUseSettings(
  db: SqliteDatabase,
  patch: ComputerUseSettingsPatch,
): ComputerUseSettings {
  if (patch.enabled !== undefined) {
    upsert(db, ENABLED_KEY, patch.enabled ? "1" : "0");
  }
  if (patch.permission !== undefined) {
    if (!PERMISSION_VALUES.includes(patch.permission)) {
      throw new Error(`permission must be one of ${PERMISSION_VALUES.join(" | ")}`);
    }
    upsert(db, PERMISSION_KEY, patch.permission);
  }
  if (patch.vision !== undefined) {
    if (patch.vision.mode !== undefined) {
      if (!VISION_MODE_VALUES.includes(patch.vision.mode)) {
        throw new Error(`vision.mode must be one of ${VISION_MODE_VALUES.join(" | ")}`);
      }
      upsert(db, VISION_MODE_KEY, patch.vision.mode);
    }
    if (patch.vision.provider !== undefined) {
      if (patch.vision.provider === null || patch.vision.provider === "") {
        remove(db, VISION_PROVIDER_KEY);
      } else {
        if (!PROVIDER_ID_RE.test(patch.vision.provider)) {
          throw new Error("vision.provider must be a lowercase slug (a-z, 0-9, '-', '_')");
        }
        upsert(db, VISION_PROVIDER_KEY, patch.vision.provider);
      }
    }
    if (patch.vision.modelId !== undefined) {
      if (patch.vision.modelId === null || patch.vision.modelId === "") {
        remove(db, VISION_MODEL_KEY);
      } else {
        if (patch.vision.modelId.length > 256) {
          throw new Error("vision.modelId must be at most 256 chars");
        }
        upsert(db, VISION_MODEL_KEY, patch.vision.modelId);
      }
    }
  }
  return getComputerUseSettings(db);
}

/**
 * The keyring provider id that holds the SEPARATE vision model's key:
 * "<providerId>-vision" — read by computer/vision.ts through the keyring's
 * env-var derivation (ACUTE_PROVIDER_<ID>_VISION). This is the exact
 * pattern R51 used for openrouter-slot{2,3,4}: a slug-suffixed pseudo
 * provider whose key rides the SAME store_provider_key handoff + credential
 * target (ACUTE-CODE/provider/<id>) as every other key. Nothing new to
 * audit — the key never appears in REST bodies, logs, or the DB.
 */
export function visionKeyringId(providerId: string): string {
  return `${providerId}-vision`;
}
