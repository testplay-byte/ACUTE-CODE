/**
 * ROUND-61 (R61): computer-use settings — persisted in the `settings` table
 * (migration 0001) with typed accessors + defaults, the same shape as
 * storage/settings.ts (ADR-0022). Keys:
 *
 *   computerUse.enabled    — the master switch (default FALSE: the whole
 *                            computer-use tool surface is dark until the
 *                            owner turns it on. The owner's directive: "give
 *                            the user the option to turn on and off the
 *                            computer use").
 *   computerUse.permission — the host policy posture:
 *                            "observe" = only read-only tools are
 *                            registered (list/get/screenshot/…);
 *                            "act"     = mutating tools registered, riding
 *                                        the approval channel in ask
 *                                        permission-mode;
 *                            "auto"    = mutating tools with no per-action
 *                                        approval prompts (full mode
 *                                        equivalent).
 *                            Default "act".
 *
 * ROUND-66 (R66-2-b): the VISION block (computerUse.vision.mode/provider/
 * modelId) was EXTRACTED into its own global settings module —
 * storage/vision.ts (vision.mode/provider/modelId, the dedicated Settings →
 * Image Analysis section, the analyze_image tool) per the owner's B3+B5
 * directive. The legacy computerUse.vision.* rows stay in the table
 * (migration 0025 seeds vision.* from them; getVisionSettings keeps a
 * read-only lazy fallback) — nothing here reads or writes them anymore.
 *
 * Everything is clamped/validated on WRITE (storage is the boundary) and
 * defaults safely on READ (a missing/corrupt row never breaks a turn — the
 * readBool/readEnum helpers below mirror settings.ts).
 */
import type { SqliteDatabase } from "./db.js";
// R66-2-b: the vision-keyring slot helper moved to storage/vision.ts with
// the settings it belongs to; re-exported here so every historical import
// site (server.ts, the plugins) keeps compiling unchanged.
export { visionKeyringId } from "./vision.js";

export type ComputerUsePermissionPosture = "observe" | "act" | "auto";

export interface ComputerUseSettings {
  enabled: boolean;
  permission: ComputerUsePermissionPosture;
}

export const COMPUTER_USE_DEFAULTS: ComputerUseSettings = {
  enabled: false,
  permission: "act",
};

const ENABLED_KEY = "computerUse.enabled";
const PERMISSION_KEY = "computerUse.permission";

const PERMISSION_VALUES: readonly ComputerUsePermissionPosture[] = ["observe", "act", "auto"];

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

export function getComputerUseSettings(db: SqliteDatabase): ComputerUseSettings {
  return {
    enabled: readBool(db, ENABLED_KEY, COMPUTER_USE_DEFAULTS.enabled),
    permission: readEnum(db, PERMISSION_KEY, PERMISSION_VALUES, COMPUTER_USE_DEFAULTS.permission),
  };
}

/** Upsert helper (ON CONFLICT — the settings.ts pattern). */
function upsert(db: SqliteDatabase, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export interface ComputerUseSettingsPatch {
  enabled?: boolean;
  permission?: ComputerUsePermissionPosture;
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
  return getComputerUseSettings(db);
}
