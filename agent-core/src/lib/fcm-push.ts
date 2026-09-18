/**
 * ROUND-106 (R106-S1, the FCM publisher SKELETON — the graceful no-op).
 *
 * The mobile round's contract (ANDROID-R3-OWNER-RULINGS.md §1.10): the owner
 * APPROVED Firebase Cloud Messaging as the push transport and will supply
 * the Firebase credentials with the anywhere-access round. Until then this
 * module ships as the desktop-side fan-out destination that is DORMANT by
 * design: it reads an optional `<dataDir>/fcm.json` (the exact vapid.json
 * directory-resolution pattern — the machine-scoped data dir next to the
 * SQLite db), and when the file is missing or `{enabled:false}` every
 * publish resolves immediately with a no-op result. NEVER throws — it sits
 * in the notification bus's fan-out path, where a failure must never break
 * a turn (the same rule web-push's sendPushToAll follows).
 *
 * THE INTENDED PAYLOAD (documented now, wired when the credentials arrive —
 * LINKING-PROTOCOL §3): a push carries NO content, just a ping ("something
 * needs you; ask your desktop"); the app then fetches the real
 * approval/notification over the link. The FCM HTTP v1 call will be:
 *
 *   POST https://fcm.googleapis.com/v1/projects/{projectId}/messages:send
 *   Authorization: Bearer <OAuth2 token minted from the service-account key
 *                  with scope https://www.googleapis.com/auth/firebase.messaging>
 *   {
 *     "message": {
 *       "token": "<device FCM registration token (a mobile_devices column
 *                  will carry them when the phone registers)>",
 *       "data": { "ping": "1", "kind": "<notification kind>", "id": "<id>" },
 *       "android": { "priority": "high" }
 *     }
 *   }
 *
 * `data` (not `notification`) is deliberate: the app owns presentation and
 * the payload carries nothing sensitive — the phone is told to ASK, never
 * told the message.
 *
 * The fcm.json shape (documented for the future credentials round):
 *
 *   {
 *     "enabled": false,          // flip when the owner supplies credentials
 *     "projectId": "<firebase project id>",
 *     "clientEmail": "<service-account email>",
 *     "privateKey": "<PEM service-account key>",
 *     "tokens": ["<device registration token>", ...]
 *   }
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NotificationRecord } from "../storage/notifications.js";

/** The config file's name — sits NEXT TO vapid.json in the data dir. */
export const FCM_CONFIG_FILENAME = "fcm.json";

export interface FcmConfig {
  enabled: boolean;
}

/** One fan-out outcome — the no-op is an honest, inspectable result. */
export interface FcmPublishResult {
  delivered: number;
  /** True when nothing was attempted (missing/disabled config). */
  skipped: boolean;
  reason?: string;
}

let cachedConfig: FcmConfig | null = null;
let cachedForDir: string | null = null;

/**
 * Load the optional fcm.json (cached per data dir, the ensureVapidKeys
 * pattern — a publish never re-stats the disk). Returns null when the file
 * is missing; "absent" and "present but disabled" are distinct honest
 * states, but both make publishFcm a no-op.
 */
export function loadFcmConfig(dataDir: string): FcmConfig | null {
  if (cachedForDir === dataDir) return cachedConfig;
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, FCM_CONFIG_FILENAME), "utf8")) as Partial<FcmConfig>;
    cachedConfig = { enabled: parsed.enabled === true };
  } catch {
    // Missing or corrupt — the dormant default (cached: a publish must
    // not re-stat the disk per notification). A corrupt file is NOT an
    // error worth surfacing: FCM is opt-in and the credentials round
    // will write it properly.
    cachedConfig = null;
  }
  cachedForDir = dataDir;
  return cachedConfig;
}

/** Test hook — drop the cached config. */
export function resetFcmConfigForTest(): void {
  cachedConfig = null;
  cachedForDir = null;
}

/**
 * Fan one notification out over FCM. THE NO-OP CONTRACT: resolves
 * immediately (never rejects, never throws) when the config is missing or
 * disabled — the skeleton's whole job this round. When enabled in a future
 * round, this is where the documented HTTP v1 calls land (ping-only data
 * payloads, fire-and-forget with per-device error tolerance, exactly like
 * sendPushToAll's 404/410 pruning).
 */
export async function publishFcm(dataDir: string, _record: NotificationRecord): Promise<FcmPublishResult> {
  const config = loadFcmConfig(dataDir);
  if (config === null) {
    return { delivered: 0, skipped: true, reason: "fcm config absent (dormant skeleton)" };
  }
  if (!config.enabled) {
    return { delivered: 0, skipped: true, reason: "fcm disabled in fcm.json" };
  }
  // NOT REACHED this round: no credentials exist yet. The future
  // implementation belongs here — one POST per device token from the
  // documented shape above, all failures swallowed into the result.
  return { delivered: 0, skipped: true, reason: "fcm enabled but the sender is not wired yet (credentials arrive with the remote-access round)" };
}
