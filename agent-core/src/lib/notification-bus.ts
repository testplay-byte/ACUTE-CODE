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
 *
 * ROUND-117 (R117-e): a subscriber failure is now also an ENGINE diagnostic —
 * it routes into the sidecar's diagnostics ring through the injectable
 * `failureRecorder` (default: lib/diagnostics-sink.ts's recordDiagnostic, a
 * no-op until a server registers its ring). console.error stays as the belt
 * (sidecar.log); the ring is what the owner actually READS (the Console tab).
 * The recorder is a settable INJECTABLE so tests pin the failure path without
 * a server.
 */
import type { SqliteDatabase } from "../storage/db.js";
import {
  createNotification,
  type NotificationInput,
  type NotificationRecord,
} from "../storage/notifications.js";
import { recordDiagnostic } from "./diagnostics-sink.js";

type Subscriber = (n: NotificationRecord) => void;

/** The failure-path recorder — `(message) => void`. Injectable for tests. */
export type NotificationFailureRecorder = (message: string) => void;

class NotificationBus {
  private readonly subscribers = new Set<Subscriber>();

  /**
   * R117-e: the diagnostics-ring recorder for delivery failures. Default
   * routes through lib/diagnostics-sink.ts (no-op without a server); tests
   * (and any future embedding) inject their own via setFailureRecorder.
   */
  private failureRecorder: NotificationFailureRecorder = (message) => {
    recordDiagnostic("notification", message);
  };

  /** Register a live subscriber. Returns an unsubscribe function. */
  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /** R117-e: inject (or reset) the delivery-failure recorder. */
  setFailureRecorder(fn: NotificationFailureRecorder): void {
    this.failureRecorder = fn;
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
        // circular import) and continue — plus, since R117-e, record it into
        // the diagnostics ring so the Console tab shows the delivery failure.
        console.error("[notification-bus] subscriber threw:", err);
        this.failureRecorder(
          `notification delivery failed (${record.kind}, notification ${record.id}): ${describeFailure(err)}`,
        );
      }
    }
    return record;
  }
}

/** One-line description of the failure (Error → name + message; else JSON). */
function describeFailure(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

let bus: NotificationBus | null = null;

/** Process-wide singleton (one sidecar = one bus). */
export function getNotificationBus(): NotificationBus {
  if (bus === null) bus = new NotificationBus();
  return bus;
}
