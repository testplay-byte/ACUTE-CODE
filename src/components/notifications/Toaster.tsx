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
 *   - Auto-dismiss after 6s EXCEPT for permission_request + task_failed
 *     (those need attention; they persist until the user dismisses them).
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

/** Toast kinds that NEVER auto-dismiss — they need user attention. */
const PERSISTENT_KINDS = new Set<NotificationKind>([
  "permission_request",
  "task_failed",
]);

/** Auto-dismiss delay for non-persistent toasts. */
const AUTO_DISMISS_MS = 6_000;

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
      }, AUTO_DISMISS_MS);
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
