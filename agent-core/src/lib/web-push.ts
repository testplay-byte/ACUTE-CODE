/**
 * ROUND-42: Web Push delivery (owner: "I closed the window so it should send
 * me a notification after it has completed the task. Apparently it did not
 * send me any notification on my PC").
 *
 * WHY WEB PUSH: a closed browser window can't run page JS, so the ROUND-41
 * `new Notification(...)` approach can never fire once the tab is gone. The
 * only standards-based way to notify from a browser app with the window
 * closed is a Service Worker + the Push API: the sidecar sends the message
 * through the browser's push service (Mozilla/Google, TLS + authenticated
 * with our VAPID keypair), the browser wakes OUR service worker (sw.js) even
 * with no tabs open, and it shows the OS notification. Clicking it opens the
 * app at the notification's session.
 *
 * This module owns:
 *   - The VAPID keypair: generated ONCE, persisted at `<dbDir>/vapid.json`
 *     (gitignored .dev dir — a machine identity, not app data). If the file
 *     is lost the subscriptions become undeliverable and clients simply
 *     re-subscribe on next app boot with the new key.
 *   - sendPushToAll(): fan a NotificationRecord out to every stored
 *     subscription. Fire-and-forget from the notification bus — a push
 *     failure must NEVER break a turn. 404/410 endpoints are pruned (the
 *     browser told us the subscription is dead).
 *   - list/save/delete subscriptions (SQLite, migration 0012).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import webpush from "web-push";
import type { SqliteDatabase } from "../storage/db.js";
import type { NotificationRecord } from "../storage/notifications.js";

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

let vapidKeys: VapidKeys | null = null;

/** Load (or generate + persist) the VAPID keypair for THIS machine. */
export function ensureVapidKeys(dataDir: string): VapidKeys {
  if (vapidKeys !== null) return vapidKeys;
  const keyPath = join(dataDir, "vapid.json");
  try {
    const parsed = JSON.parse(readFileSync(keyPath, "utf8")) as Partial<VapidKeys>;
    if (typeof parsed.publicKey === "string" && typeof parsed.privateKey === "string") {
      vapidKeys = { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
      return vapidKeys;
    }
  } catch {
    /* missing or corrupt — regenerate below */
  }
  const generated = webpush.generateVAPIDKeys();
  vapidKeys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
  try {
    writeFileSync(keyPath, `${JSON.stringify(vapidKeys, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    // Non-fatal: push delivery still works this process; it just re-generates
    // next boot (clients re-subscribe automatically on key change).
    console.error("[web-push] could not persist vapid keys:", err);
  }
  return vapidKeys;
}

/** Test hook — clear the cached keys. */
export function resetVapidKeysForTest(): void {
  vapidKeys = null;
}

/** The stored VAPID public key (clients need it to subscribe). */
export function vapidPublicKey(): string | null {
  return vapidKeys?.publicKey ?? null;
}

export function listPushSubscriptions(db: SqliteDatabase): PushSubscriptionRow[] {
  return db
    .prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions")
    .all() as PushSubscriptionRow[];
}

/** Upsert by endpoint (a browser re-subscribing replaces its keys). */
export function savePushSubscription(
  db: SqliteDatabase,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
): void {
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
     VALUES (@endpoint, @p256dh, @auth, @createdAt)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = @p256dh, auth = @auth`,
  ).run({
    endpoint: sub.endpoint,
    p256dh: sub.keys.p256dh,
    auth: sub.keys.auth,
    createdAt: new Date().toISOString(),
  });
}

export function deletePushSubscription(db: SqliteDatabase, endpoint: string): void {
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

/** The payload the service worker understands (sw.js mirrors this shape). */
interface PushPayload {
  id: string;
  title: string;
  body: string | null;
  kind: string;
  sessionId: string | null;
  projectId: string | null;
  ts: string;
}

/**
 * Fan a notification out to every subscribed browser. NEVER throws — push
 * failures are logged and swallowed (a turn must not fail because a push
 * service was unreachable). Dead endpoints (404/410) are pruned.
 *
 * Calls fire concurrently with a hard 15s timeout per subscription.
 */
export function sendPushToAll(db: SqliteDatabase, record: NotificationRecord): void {
  if (vapidKeys === null) return; // ensureVapidKeys never ran — no keys, no push.
  const subs = listPushSubscriptions(db);
  if (subs.length === 0) return;

  const payload: PushPayload = {
    id: record.id,
    title: record.title,
    body: record.body,
    kind: record.kind,
    sessionId: record.sessionId,
    projectId: record.projectId,
    ts: record.ts,
  };
  // The SAME tag as the Toaster's in-page Notification — when the tab IS
  // alive both may fire; the browser replaces (never stacks) same-tag
  // notifications, so the user sees exactly one.
  const options: webpush.RequestOptions = {
    vapidDetails: {
      subject: "mailto:app@acute.local",
      publicKey: vapidKeys.publicKey,
      privateKey: vapidKeys.privateKey,
    },
    timeout: 15_000,
  };

  for (const sub of subs) {
    void webpush
      .sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        options,
      )
      .catch((err: unknown) => {
        const statusCode =
          typeof err === "object" && err !== null && "statusCode" in err
            ? Number((err as { statusCode?: unknown }).statusCode)
            : 0;
        if (statusCode === 404 || statusCode === 410) {
          // The subscription expired/was revoked — prune it.
          try {
            deletePushSubscription(db, sub.endpoint);
          } catch {
            /* db closed mid-shutdown — fine */
          }
          return;
        }
        // Transient network/service errors are expected sometimes; log + move on.
        console.error(
          `[web-push] delivery to ${sub.endpoint.slice(0, 48)}… failed:`,
          statusCode > 0 ? `HTTP ${statusCode}` : err,
        );
      });
  }
}
