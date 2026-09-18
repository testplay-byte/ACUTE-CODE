/**
 * ROUND-106 (R106-S1, the sidecar mobile-link round): the MOBILE DEVICES
 * storage — the paired-phone registry the multi-token bearer wall
 * authenticates against (migration 0040; docs/planning/
 * LINKING-PROTOCOL.md §2 + §5).
 *
 * Design contract (ANDROID-R3-OWNER-RULINGS.md):
 *   · The token itself is NEVER stored — only its SHA-256 hash. The phone
 *     holds the secret in its Android Keystore; the desktop can verify it
 *     without ever being able to leak it (a stolen db cannot authenticate
 *     AS a device, only read that one existed).
 *   · Revocation is DELETE (the LINKING-PROTOCOL wording) — a revoked
 *     phone's next request finds no row and falls back to pairing.
 *   · Devices carry NO expiry (the long-lived-link ruling); last_seen_at
 *     is display-only staleness, written throttled by the wall.
 *
 * The module follows the storage/ idioms: SqliteDatabase in, prepared
 * statements, the narrow row shapes the routes render.
 */
import { createHash } from "node:crypto";
import type { SqliteDatabase } from "./db.js";

/** The v1 capability grant — the phone is a VIEW + INPUT medium, nothing
 * else (the owner's §1.5 ruling; the scopes field is the additive
 * capability registry, v1 grants exactly one implicit scope). */
export const MOBILE_DEVICE_DEFAULT_SCOPES = ["view-input"] as const;

export interface MobileDeviceRow {
  id: string;
  label: string;
  /** SHA-256 hex of the device token — never the token itself. */
  tokenHash: string;
  /** JSON array of capability scopes (v1: ["view-input"]). */
  scopes: string;
  createdAt: number;
  lastSeenAt: number;
}

/** The wall + routes render these fields; the token hash never leaves. */
export interface MobileDeviceInfo {
  id: string;
  label: string;
  scopes: string[];
  createdAt: number;
  lastSeenAt: number;
}

interface MobileDeviceSqlRow {
  id: string;
  label: string;
  token_hash: string;
  scopes: string;
  created_at: number;
  last_seen_at: number;
}

/** SHA-256 hex of a presented device token — the lookup key. */
export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function rowToInfo(row: MobileDeviceSqlRow): MobileDeviceInfo {
  let scopes: string[] = [...MOBILE_DEVICE_DEFAULT_SCOPES];
  try {
    const parsed: unknown = JSON.parse(row.scopes);
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
      scopes = parsed;
    }
  } catch {
    /* corrupt scopes fall back to the default grant — display-only field */
  }
  return {
    id: row.id,
    label: row.label,
    scopes,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * Register a freshly paired device (the pair/claim route). Returns the
 * stored row's public shape. The token_hash UNIQUE constraint is the
 * honest backstop: two devices can never share a token.
 */
export function createMobileDevice(
  db: SqliteDatabase,
  device: { id: string; label: string; tokenHash: string },
): MobileDeviceInfo {
  const now = Date.now();
  db.prepare(
    `INSERT INTO mobile_devices (id, label, token_hash, scopes, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    device.id,
    device.label,
    device.tokenHash,
    JSON.stringify([...MOBILE_DEVICE_DEFAULT_SCOPES]),
    now,
    now,
  );
  const row = db
    .prepare("SELECT * FROM mobile_devices WHERE id = ?")
    .get(device.id) as MobileDeviceSqlRow;
  return rowToInfo(row);
}

/** Find a device by the hash of its PRESENTED token — the wall's lookup.
 * Undefined = unknown/revoked token (reject). */
export function findMobileDeviceByTokenHash(
  db: SqliteDatabase,
  tokenHash: string,
): MobileDeviceRow | undefined {
  const row = db
    .prepare("SELECT * FROM mobile_devices WHERE token_hash = ?")
    .get(tokenHash) as MobileDeviceSqlRow | undefined;
  if (row === undefined) return undefined;
  return {
    id: row.id,
    label: row.label,
    tokenHash: row.token_hash,
    scopes: row.scopes,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

/** Every paired device, oldest-first (the Linked-devices list order). */
export function listMobileDevices(db: SqliteDatabase): MobileDeviceInfo[] {
  const rows = db
    .prepare("SELECT * FROM mobile_devices ORDER BY created_at ASC, id ASC")
    .all() as MobileDeviceSqlRow[];
  return rows.map(rowToInfo);
}

/** Revoke = DELETE the row (the LINKING-PROTOCOL wording). True when a row
 * actually went away; false when the id was already unknown. */
export function deleteMobileDevice(db: SqliteDatabase, id: string): boolean {
  const result = db.prepare("DELETE FROM mobile_devices WHERE id = ?").run(id);
  return result.changes > 0;
}

/**
 * Throttled last_seen_at write — the wall calls this on device-token
 * requests, but only when >60s passed since the row's last write (a chatty
 * phone streams dozens of requests a minute; each one must not become a
 * db write). Returns true when a write happened.
 */
export function touchMobileDeviceLastSeen(db: SqliteDatabase, id: string, minGapMs = 60_000): boolean {
  const row = db
    .prepare("SELECT last_seen_at FROM mobile_devices WHERE id = ?")
    .get(id) as { last_seen_at: number } | undefined;
  if (row === undefined) return false;
  const now = Date.now();
  if (now - row.last_seen_at < minGapMs) return false;
  db.prepare("UPDATE mobile_devices SET last_seen_at = ? WHERE id = ?").run(now, id);
  return true;
}
