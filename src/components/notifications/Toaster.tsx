/**
 * ROUND-40 (task 3-b frontend): the Toaster — a stack of toast cards for
 * notifications that arrived over SSE during THIS mount. Mounted ONCE in
 * AppShell so toasts surface regardless of which route is active.
 *
 * Behaviour:
 *   - Subscribes to useNotificationStreamStore.lastSeq (the SSE ticker) +
 *     lastNotification. On each new tick, if the record's id isn't in the
 *     toasted-set, push it onto the toasting list (so reconnect-resilience
 *     holds — the same id never toasts twice, even across reconnects).
 *   - ROUND-64 (R64-c, owner: "The internal app ones should automatically
 *     disappear after 1.5 seconds"): non-persistent toasts auto-dismiss
 *     after 1.5s. permission_request + task_failed stay PERSISTENT — they
 *     need a decision/attention, so those NEVER auto-dismiss.
 *   - Click the body → mark the notification read + navigate to its session
 *     (via react-router's useNavigate). For permission_request, this drops
 *     the user into the chat where the ApprovalCard lives — the approval
 *     modal itself is in AgentChatPanel; navigation is enough.
 *   - Esc dismisses the most recent (top) toast.
 *   - z-[100] so it sits above the right sidebar + any popover.
 *
 * Icon mapping (lucide-react 1.33.0; CheckCircle2/XCircle/Loader2 from the
 * spec are NOT exported in this version — modern equivalents are used):
 *   - task_complete / subagent_complete → CircleCheck
 *   - task_failed / subagent_failed     → CircleX
 *   - permission_request                → ShieldAlert
 *   - subagent_queued                   → Clock
 *   - subagent_running                  → LoaderCircle (spinning)
 */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useNavigate } from "react-router";
import {
  Bell as BellIcon,
  CircleCheck,
  CircleX,
  Clock,
  LoaderCircle,
  ShieldAlert,
  X,
} from "lucide-react";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";
import type { NotificationKind, NotificationRecord } from "../../lib/notifications-api";
import { useNotificationStreamStore } from "../../hooks/use-notifications";

/** Toast kinds that NEVER auto-dismiss — they need user attention
 * (permission_request needs a decision; task_failed needs eyes). ROUND-64
 * (R64-c): exported for tests + the kind policy below. */
export const PERSISTENT_KINDS: ReadonlySet<NotificationKind> = new Set<NotificationKind>([
  "permission_request",
  "task_failed",
]);

/** ROUND-64 (R64-c, owner: "On the right side it shows me the notifications.
 * The internal app ones should automatically disappear after 1.5
 * seconds."): auto-dismiss delay for every non-persistent (internal/
 * ephemeral) kind — task_complete, subagent_* events. Exported for tests. */
export const AUTO_DISMISS_MS = 1_500;

/** ROUND-64 (R64-c): the per-kind dismiss policy — `null` means PERSISTENT
 * (never auto-dismiss; needs attention), otherwise the auto-dismiss delay.
 * Exported for tests. */
export function autoDismissDelayFor(kind: NotificationKind): number | null {
  return PERSISTENT_KINDS.has(kind) ? null : AUTO_DISMISS_MS;
}

/** Per-kind accent color (status tones — independent of the theme palette). */
function toneForKind(kind: NotificationKind): string {
  switch (kind) {
    case "task_complete":
    case "subagent_complete":
      return "#10B981"; // emerald-500
    case "task_failed":
    case "subagent_failed":
      return "#EF4444"; // red-500
    case "permission_request":
      return "#F59E0B"; // amber-500
    default:
      return "#6366F1"; // indigo-500 (queued/running)
  }
}

/** The icon for a notification kind. The `spin` flag animates LoaderCircle. */
function IconForKind({ kind }: { kind: NotificationKind }) {
  switch (kind) {
    case "task_complete":
    case "subagent_complete":
      return <CircleCheck size={18} />;
    case "task_failed":
    case "subagent_failed":
      return <CircleX size={18} />;
    case "permission_request":
      return <ShieldAlert size={18} />;
    case "subagent_queued":
      return <Clock size={18} />;
    case "subagent_running":
      return <LoaderCircle size={18} className="animate-spin" />;
    default:
      return <BellIcon size={18} />;
  }
}

/** "just now"/"3m ago"/"2h ago"/"Aug 4" — for the toast's small time-ago. */
function timeAgo(iso: string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

interface ToastEntry {
  id: string;
  notification: NotificationRecord;
}

export function Toaster() {
  const styles = useThemeStyles();
  const navigate = useNavigate();
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  // IDs we've already toasted — survives across SSE reconnects so a
  // reconnect-driven re-publish doesn't re-toast the same record.
  const toastedRef = useRef<Set<string>>(new Set());
  // Per-toast auto-dismiss timers (cleared on dismiss/unmount).
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // The SSE ticker — bumps on each new live notification.
  const lastSeq = useNotificationStreamStore((s) => s.lastSeq);
  const lastNotification = useNotificationStreamStore((s) => s.lastNotification);

  // ROUND-41 (owner: "whenever it finishes the response or anything like
  // that, it will send me a notification on my PC. I was hoping for it to
  // be like that but apparently I did not receive any notifications or
  // anything like that at all"). Wire the desktop Notification API: when a
  // new SSE notification arrives, fire a native OS notification (so the
  // user sees it even if the app window is minimised/behind another window).
  // Permission flow: if "default", request on the FIRST arrival (one-time
  // browser prompt). If "denied", skip silently (the in-app toast still
  // shows). If "granted", fire. The notification's `tag` is the record id
  // so duplicate publishes (across SSE reconnects) don't stack duplicates.
  // Clicking the desktop notification focuses the app window + navigates to
  // the notification's session (same as clicking the in-app toast).
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission === "default") {
      // Fire-and-forget; the browser surfaces the permission prompt. If the
      // user denies, subsequent notifications just skip — the in-app toast
      // still renders.
      void Notification.requestPermission();
    }
  }, []);

  useEffect(() => {
    if (!lastNotification) return;
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    // ROUND-42: only fire the in-page desktop notification when the page is
    // NOT visible. Three delivery paths, exactly one surface at a time:
    //   - page VISIBLE      → in-app toast only (the owner is watching).
    //   - page hidden/alive → this Notification + the sw.js push (same tag
    //                         → the browser replaces, never stacks).
    //   - page CLOSED       → sw.js push only (page JS is dead — that's why
    //                         R41 alone could never satisfy "closed window
    //                         ⇒ desktop notification").
    if (document.visibilityState === "visible") return;
    const n = lastNotification;
    try {
      const desktop = new Notification(n.title, {
        body: n.body ?? "",
        tag: n.id,
        // The icon: a small inline SVG data URL (the Acute mark). Keeps it
        // dependency-free + recognisable in the OS notification center.
        icon: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2214%22%20fill%3D%22%23FF6B2C%22%2F%3E%3Ctext%20x%3D%2232%22%20y%3D%2245%22%20font-family%3D%22Menlo%2C%20monospace%22%20font-size%3D%2234%22%20font-weight%3D%22700%22%20text-anchor%3D%22middle%22%20fill%3D%22%231f130a%22%3E%E2%97%90%3C%2Ftext%3E%3C%2Fsvg%3E",
      });
      desktop.onclick = () => {
        // Focus the app window + navigate to the session (same path as the
        // in-app toast's openSession).
        window.focus();
        openSession(n);
        desktop.close();
      };
    } catch {
      // Some browsers throw if the notification was created in a
      // background tab without a user gesture. The in-app toast still
      // shows — silently skip the desktop one.
    }
  }, [lastSeq, lastNotification]);

  useEffect(() => {
    if (!lastNotification) return;
    const n = lastNotification;
    if (toastedRef.current.has(n.id)) return;
    toastedRef.current.add(n.id);
    setToasts((cur) => [...cur, { id: n.id, notification: n }]);

    if (!PERSISTENT_KINDS.has(n.kind)) {
      const timer = setTimeout(() => {
        setToasts((cur) => cur.filter((t) => t.id !== n.id));
        timersRef.current.delete(n.id);
      }, autoDismissDelayFor(n.kind) ?? AUTO_DISMISS_MS);
      timersRef.current.set(n.id, timer);
    }
  }, [lastSeq, lastNotification]);

  // Clean up timers on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  const dismiss = (id: string) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  };

  // Esc dismisses the most recent (last in the array — the topmost visually
  // since the stack is laid out column-reverse via flex-col with newest at
  // the bottom; "most recent" by arrival time is the last array entry).
  useEffect(() => {
    if (toasts.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const last = toasts[toasts.length - 1];
        if (last) dismiss(last.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toasts]);

  // Click the toast body: mark the notification read + navigate to its
  // session. For permission_request, navigation alone surfaces the chat's
  // ApprovalCard (the approval modal lives in AgentChatPanel).
  const openSession = (n: NotificationRecord) => {
    if (n.sessionId && n.projectId) {
      navigate(
        `/project/${encodeURIComponent(n.projectId)}/chat?session=${encodeURIComponent(n.sessionId)}`,
      );
    }
    dismiss(n.id);
  };

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-[min(380px,calc(100vw-2rem))]"
    >
      <AnimatePresence initial={false}>
        {toasts.map(({ id, notification: n }) => {
          const tone = toneForKind(n.kind);
          const clickable = !!n.sessionId && !!n.projectId;
          return (
            <motion.div
              key={id}
              layout
              initial={{ opacity: 0, x: 60, scale: 0.96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 60, scale: 0.96 }}
              transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
              className="pointer-events-auto overflow-hidden rounded-[14px] border-[1.5px]"
              style={{
                backgroundColor: styles.card,
                borderColor: withAlpha(tone, 0.4),
                boxShadow: styles.softShadow,
              }}
              role="status"
            >
              <div className="flex items-start gap-2.5 p-3.5">
                <div
                  className="mt-0.5 shrink-0 grid place-items-center w-7 h-7 rounded-full"
                  style={{
                    background: withAlpha(tone, 0.14),
                    color: tone,
                  }}
                >
                  <IconForKind kind={n.kind} />
                </div>
                <button
                  type="button"
                  onClick={() => openSession(n)}
                  className="flex-1 min-w-0 text-left"
                  style={{ cursor: clickable ? "pointer" : "default" }}
                  aria-label={
                    clickable
                      ? `Open notification: ${n.title}`
                      : `Notification: ${n.title}`
                  }
                >
                  <div
                    className="text-[13px] font-bold leading-tight truncate"
                    style={{ color: styles.text }}
                  >
                    {n.title}
                  </div>
                  {n.body && (
                    <div
                      className="mt-0.5 text-[12px] leading-snug overflow-hidden"
                      style={{
                        color: styles.textSecondary,
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                      }}
                    >
                      {n.body}
                    </div>
                  )}
                  <div
                    className="mt-1 text-[10.5px] uppercase tracking-wider font-bold"
                    style={{ color: styles.textTertiary }}
                  >
                    {timeAgo(n.ts)}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => dismiss(id)}
                  aria-label="Dismiss notification"
                  className="shrink-0 w-6 h-6 rounded-md grid place-items-center transition-colors"
                  style={{ color: styles.textTertiary }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = styles.subtle;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  <X size={13} />
                </button>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
