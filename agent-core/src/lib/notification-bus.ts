/**
 * ROUND-40: in-process notification pub/sub. The runtime/orchestrator/
 * approvals modules call publish() at the right transition points; the SSE
 * route (GET /api/v1/notifications/stream) subscribes to push live toasts to
 * the UI. One module-level singleton per sidecar process — subscribers die
 * with the SSE response (the route returns the unsubscribe on close).
 *
 * publish() writes the notification to SQLite (durable history) THEN notifies
 * live subscribers. A subscriber that throws is logged + skipped — never
 * crashes the publisher (a turn must not fail because a toast rendering
 * threw).
 */
import type { SqliteDatabase } from "../storage/db.js";
import {
  createNotification,
  type NotificationInput,
  type NotificationRecord,
} from "../storage/notifications.js";

type Subscriber = (n: NotificationRecord) => void;

class NotificationBus {
  private readonly subscribers = new Set<Subscriber>();

  /** Register a live subscriber. Returns an unsubscribe function. */
  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /** Persist the notification + push it to every live subscriber. */
  publish(db: SqliteDatabase, input: NotificationInput): NotificationRecord {
    const record = createNotification(db, input);
    for (const fn of this.subscribers) {
      try {
        fn(record);
      } catch (err) {
        // A subscriber error must never propagate into the turn runtime.
        // Log to stderr (the structured logger isn't available here without a
        // circular import) and continue.
        console.error("[notification-bus] subscriber threw:", err);
      }
    }
    return record;
  }
}

let bus: NotificationBus | null = null;

/** Process-wide singleton (one sidecar = one bus). */
export function getNotificationBus(): NotificationBus {
  if (bus === null) bus = new NotificationBus();
  return bus;
}
