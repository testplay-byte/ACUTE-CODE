import { useEffect, useRef } from "react";
import { useConfigStore } from "../../lib/config-store";
import { getQueryClient } from "../../lib/query-client";
// R113-b: the events stream client — the pure dispatcher + the fetch-SSE
// transport this starter owns the lifetime of.
import { handleEventsFrame, openEventsStream } from "../../lib/events-stream";

/**
 * ROUND-113 (R113-b): boots the EVENTS stream once on app mount — the
 * desktop's half of the live-sync backbone (the sidecar's GET
 * /api/v1/events/stream landed in R113-a). Lives for the app's lifetime;
 * aborts only on unmount. Auto-reconnects on close/error with the same
 * exponential backoff as NotificationStreamStarter (1s → 2s → 4s → capped
 * 15s), and the hello frame on every (re)connect resets the ladder.
 *
 * The frame dispatch routes through handleEventsFrame (see
 * src/lib/events-stream.ts): hello = the resync sweep, session frames = the
 * debounced list/detail refetch, turn frames = the remote live-turn mirror
 * (the phone's turn streams on the desktop), project/settings frames = the
 * sidebar + open-tab refetches, and the appearance domain shifts the theme
 * live.
 *
 * No-op in demo/fixture mode (demoData === true, or baseUrl/token empty) —
 * exactly the NotificationStreamStarter contract: the starter never tries
 * to hit a non-existent sidecar, so the demo runs clean.
 *
 * Mounted ONCE in AppShell.tsx next to <NotificationStreamStarter />.
 * Returns null — this component renders nothing; it exists purely to own
 * the SSE lifecycle side-effects.
 */
export function EventStreamStarter() {
  const demoData = useConfigStore((s) => s.demoData);
  const baseUrl = useConfigStore((s) => s.baseUrl);
  const token = useConfigStore((s) => s.token);
  // Ref-guard: collapse duplicate subscriptions across React strict-mode
  // double-mounts (the NotificationStreamStarter pattern).
  const startedRef = useRef(false);
  // Track the active AbortController for force-abort on unmount.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (startedRef.current) return;

    // Demo/fixture mode (no sidecar) — skip the stream entirely.
    if (demoData || !baseUrl || !token) {
      return;
    }
    startedRef.current = true;

    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let backoffMs = 1_000;
    const BACKOFF_MAX_MS = 15_000;

    const start = async () => {
      if (stopped) return;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        await openEventsStream((frame) => {
          const qc = getQueryClient();
          if (qc === null) return;
          // The hello frame doubles as the connected signal: reset the
          // backoff ladder so a future drop starts from the initial 1s
          // delay (the stream is proven live).
          if (frame.type === "hello") {
            backoffMs = 1_000;
          }
          handleEventsFrame(qc, frame);
        }, ctrl.signal);

        // Reached here → the server closed the stream normally. Reconnect:
        // the sidecar probably restarted, and the hello-on-reconnect resync
        // covers whatever landed in the gap.
        if (!stopped) {
          backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
          reconnectTimer = setTimeout(start, backoffMs);
        }
      } catch {
        // Network drop OR non-2xx. On abort (unmount), `stopped` is true →
        // no reconnect; anything else retries after backoff.
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
