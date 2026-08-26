/**
 * ROUND-40 (task 3-b frontend): boots the notifications SSE stream once on
 * app mount. Lives for the app's lifetime — aborts only on unmount.
 * Auto-reconnects on close with exponential backoff (1s → 2s → 4s →
 * capped 15s).
 *
 * No-op in demo/fixture mode (useConfigStore.demoData===true, OR baseUrl/
 * token empty) — the stream starter never tries to hit a non-existent
 * sidecar, so the demo runs cleanly without crashing.
 *
 * Mounted ONCE in AppShell.tsx so the connection is shared with the Bell +
 * Toaster via useNotificationStreamStore. Multiple instances are safe —
 * the startedRef guard collapses duplicate subscriptions if React strict
 * mode double-mounts the component.
 *
 * Returns null — this component renders nothing; it exists purely to own
 * the SSE lifecycle side-effects.
 */
import { useEffect, useRef } from "react";
import { useConfigStore } from "../../lib/config-store";
import { getQueryClient } from "../../lib/query-client";
import {
  streamNotifications,
  type NotificationRecord,
} from "../../lib/notifications-api";
import {
  NOTIFICATIONS_QUERY_KEY,
  useNotificationStreamStore,
} from "../../hooks/use-notifications";

/** Backoff schedule for the reconnect loop (in milliseconds). */
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 15_000;

export function NotificationStreamStarter() {
  const demoData = useConfigStore((s) => s.demoData);
  const baseUrl = useConfigStore((s) => s.baseUrl);
  const token = useConfigStore((s) => s.token);
  // Ref-guard: collapse duplicate subscriptions across React strict-mode
  // double-mounts.
  const startedRef = useRef(false);
  // Track the active AbortController for force-abort on unmount.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (startedRef.current) return;

    // Demo/fixture mode (no sidecar) — skip the stream entirely. The Bell +
    // Toaster render nothing (the store stays at the default zero state).
    if (demoData || !baseUrl || !token) {
      useNotificationStreamStore.getState().setStatus("demo");
      return;
    }
    startedRef.current = true;

    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let backoffMs = BACKOFF_INITIAL_MS;

    const start = async () => {
      if (stopped) return;
      // First attempt is "connecting"; a retry after a drop is "reconnecting".
      const isFirst = backoffMs === BACKOFF_INITIAL_MS;
      useNotificationStreamStore.getState().setStatus(
        isFirst ? "connecting" : "reconnecting",
      );
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        await streamNotifications((event) => {
          const store = useNotificationStreamStore.getState();
          const qc = getQueryClient();

          // The hello frame: the server's authoritative unread count. Sets
          // the badge immediately and refreshes the list query (the bell's
          // dropdown reads from there).
          if ("type" in event && event.type === "hello") {
            store.setUnread(event.unread);
            if (qc) {
              void qc.invalidateQueries({ queryKey: [...NOTIFICATIONS_QUERY_KEY] });
            }
            store.setStatus("connected");
            // Reset backoff — the stream is live, so a future drop starts
            // from the initial 1s delay.
            backoffMs = BACKOFF_INITIAL_MS;
            return;
          }

          // A new notification record. Prepend to the react-query cache
          // (the Bell + dropdown read from there) AND bump the store's
          // unread + ticker (the Bell's badge + the Toaster read from
          // there).
          const record = event as NotificationRecord;
          if (qc) {
            qc.setQueryData<{
              notifications: NotificationRecord[];
              unread: number;
            } | undefined>([...NOTIFICATIONS_QUERY_KEY, "live"], (cur) => ({
              notifications: cur ? [record, ...cur.notifications] : [record],
              unread: (cur?.unread ?? 0) + 1,
            }));
          }
          store.pushNotification(record);
        }, ctrl.signal);

        // If we reach here, the stream ended normally (server closed). The
        // reconnect loop kicks in — the sidecar probably restarted.
        if (!stopped) {
          backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
          reconnectTimer = setTimeout(start, backoffMs);
        }
      } catch {
        // Network drop OR the sidecar returned non-2xx. On abort (signal
        // triggered by unmount), `stopped` is true → no reconnect.
        if (stopped) return;
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
        reconnectTimer = setTimeout(start, backoffMs);
      }
    };

    void start();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [demoData, baseUrl, token]);

  return null;
}
