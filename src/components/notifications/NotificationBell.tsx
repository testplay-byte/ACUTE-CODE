/**
 * ROUND-40 (task 3-b frontend): the NotificationBell — a bell icon with an
 * unread-count badge + a portaled dropdown listing the 10 most recent
 * notifications. Mounted in the Sidebar footer (next to the Settings
 * button — the closest analog to "header actions" in this app's chrome).
 *
 * Behaviour:
 *   - The badge count comes from useNotificationStreamStore.unread — the
 *     live-SSE-driven value. Updates instantly without a refetch.
 *   - Click the bell → opens a portaled popover (anchored below the bell)
 *     with the top-10 most recent notifications. Each row: icon + title +
 *     1-line body clamp + time-ago. Clicking a row marks it read + (if it
 *     has a session) navigates to that session's chat.
 *   - "Mark all read" button at the top of the dropdown (visible when
 *     unread > 0).
 *   - Empty state ("No notifications yet") when the list is empty.
 *   - Esc closes the dropdown; click-outside also closes it.
 *
 * The popover is portaled to document.body so it escapes any overflow
 * clipping — same pattern as src/components/right-sidebar/RightSidebar.tsx
 * (the "+" quick-menu, line 306-340).
 *
 * Accepts a `collapsed` prop: when true (sidebar in rail mode), the bell
 * shrinks to an icon tile with the badge; when false (expanded sidebar),
 * the bell is a wider row. Same pattern as the existing SettingsButton.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useNavigate } from "react-router";
import {
  Bell as BellIcon,
  CircleCheck,
  CircleX,
  Clock,
  LoaderCircle,
  ShieldAlert,
} from "lucide-react";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";
import { cn } from "../../lib/utils";
import {
  useNotifications,
  useNotificationStreamStore,
} from "../../hooks/use-notifications";
import type { NotificationKind, NotificationRecord } from "../../lib/notifications-api";

/** Per-kind accent color (status tones — independent of the theme palette). */
function toneForKind(kind: NotificationKind): string {
  switch (kind) {
    case "task_complete":
    case "subagent_complete":
      return "#10B981";
    case "task_failed":
    case "subagent_failed":
      return "#EF4444";
    case "permission_request":
      return "#F59E0B";
    default:
      return "#6366F1";
  }
}

/** The icon for a notification kind (small size for the bell dropdown rows). */
function IconForKind({ kind, size = 14 }: { kind: NotificationKind; size?: number }) {
  switch (kind) {
    case "task_complete":
    case "subagent_complete":
      return <CircleCheck size={size} />;
    case "task_failed":
    case "subagent_failed":
      return <CircleX size={size} />;
    case "permission_request":
      return <ShieldAlert size={size} />;
    case "subagent_queued":
      return <Clock size={size} />;
    case "subagent_running":
      return <LoaderCircle size={size} className="animate-spin" />;
    default:
      return <BellIcon size={size} />;
  }
}

/** Compact time-ago for the dropdown rows. */
function timeAgo(iso: string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

interface PopoverPos {
  top: number;
  left: number;
}

/** ROUND-42: the popover's measured width — used for viewport clamping on
 * BOTH axes. The owner reported the bell's popover opening with its "left
 * half completely cut out": the R41 fix only clamped the VERTICAL axis (top),
 * but the popover was RIGHT-anchored at the bell — and the bell lives in the
 * LEFT sidebar, so a 340px popover anchored at a bell ~60px from the screen's
 * left edge extended ~280px off-screen. Positioning is now left-anchored
 * with both axes clamped to the viewport. */
const POPOVER_WIDTH = 340;
const POPOVER_ESTIMATED_HEIGHT = 460;
const POPOVER_VIEWPORT_MARGIN = 8;

/** Compute a fully viewport-clamped position for the popover, given the
 * bell button's rect + the popover's (estimated or measured) height.
 *
 * Horizontal: prefer aligning the popover's RIGHT edge with the bell's right
 * edge (natural anchoring in the right sidebar); if that pushes the popover
 * past the LEFT edge (bell near the screen's left — the left-sidebar case),
 * align the popover's LEFT edge with the bell's left edge instead; if even
 * that overflows (tiny viewport), clamp to the margin.
 * Vertical: drop below the bell; flip up when there's more room above; then
 * clamp so neither edge can spill off-screen. */
function computePopoverPos(
  bell: DOMRect,
  popoverH: number,
): { top: number; left: number } {
  const maxLeft = window.innerWidth - POPOVER_WIDTH - POPOVER_VIEWPORT_MARGIN;
  let left: number;
  const rightAligned = bell.right - POPOVER_WIDTH;
  if (rightAligned >= POPOVER_VIEWPORT_MARGIN) {
    left = rightAligned;
  } else if (bell.left + POPOVER_WIDTH <= window.innerWidth - POPOVER_VIEWPORT_MARGIN) {
    left = bell.left;
  } else {
    left = Math.max(POPOVER_VIEWPORT_MARGIN, Math.min(bell.left, maxLeft));
  }
  const spaceBelow = window.innerHeight - bell.bottom - POPOVER_VIEWPORT_MARGIN;
  const spaceAbove = bell.top - POPOVER_VIEWPORT_MARGIN;
  let top: number;
  if (spaceBelow >= popoverH || spaceBelow >= spaceAbove) {
    top = bell.bottom + 6;
    const maxTop = window.innerHeight - popoverH - POPOVER_VIEWPORT_MARGIN;
    if (top > maxTop) top = Math.max(POPOVER_VIEWPORT_MARGIN, maxTop);
  } else {
    top = bell.top - 6 - popoverH;
    if (top < POPOVER_VIEWPORT_MARGIN) top = POPOVER_VIEWPORT_MARGIN;
  }
  return { top, left };
}

export function NotificationBell({ collapsed }: { collapsed: boolean }) {
  const styles = useThemeStyles();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState<PopoverPos | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const { notifications, markRead, markAllRead } = useNotifications();
  // The unread count comes from the SSE-driven store (live updates, no
  // refetch needed). Falls back to 0 in demo mode (no stream).
  const unread = useNotificationStreamStore((s) => s.unread);

  const recent = notifications.slice(0, 10);
  // ">9" shows "9+" instead of the raw count (prevents the badge from
  // spilling out of the 16px circle).
  const badge = unread > 9 ? "9+" : unread > 0 ? String(unread) : null;

  // ROUND-41: compute the popover's position from the bell button's bounding
  // rect. If the popover would extend below the viewport (bell is near the
  // bottom of the screen), FLIP IT UP so it opens ABOVE the bell. Also
  // re-measure the actual popover height after mount and clamp `top` so the
  // popover never spills off either edge. Recompute on resize/scroll while
  // open (capture-phase scroll so any inner-scroller movement updates the
  // anchor).
  const reposition = useCallback(() => {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    // Measure the actual popover height if mounted; fall back to an estimate.
    const popoverH = popoverRef.current?.offsetHeight ?? POPOVER_ESTIMATED_HEIGHT;
    setPopoverPos(computePopoverPos(r, popoverH));
  }, []);
  useEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, reposition]);
  // Re-measure after the popover mounts (the offsetHeight is only known
  // once the children render — list height varies with notification count).
  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, reposition, notifications.length]);

  // Esc closes the dropdown.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Click-outside closes the dropdown.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // Don't close if the click landed inside the popover OR the bell button
      // itself — the popover is portaled to body so we rely on data-attr.
      const target = e.target as HTMLElement | null;
      if (target && target.closest("[data-notification-popover]")) return;
      if (target && target.closest("[data-notification-bell-button]")) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // Open a notification: mark it read + navigate to its session (if any).
  const openRow = (n: NotificationRecord) => {
    void markRead(n.id);
    setOpen(false);
    if (n.sessionId && n.projectId) {
      navigate(
        `/project/${encodeURIComponent(n.projectId)}/chat?session=${encodeURIComponent(n.sessionId)}`,
      );
    }
  };

  const handleBellClick = () => {
    if (!open) {
      // Compute position synchronously before the popover mounts so the
      // first paint is correctly placed (the layout effect re-measures
      // + clamps once the actual height is known).
      if (btnRef.current) {
        const r = btnRef.current.getBoundingClientRect();
        setPopoverPos(computePopoverPos(r, POPOVER_ESTIMATED_HEIGHT));
      }
    }
    setOpen((v) => !v);
  };

  // Common button styling (collapsed vs expanded variants handled below).
  const button = (
    <button
      ref={btnRef}
      data-notification-bell-button
      onClick={handleBellClick}
      aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
      aria-expanded={open}
      aria-haspopup="menu"
      title={collapsed ? "Notifications" : undefined}
      className={cn(
        "relative grid place-items-center transition-all",
        collapsed ? "w-9 h-9 mx-auto rounded-[12px]" : "w-9 h-9 rounded-[10px]",
      )}
      style={{
        background: open ? withAlpha(styles.accent, 0.12) : "transparent",
        color: open ? styles.accent : styles.textSecondary,
      }}
      onMouseEnter={(e) => {
        if (!open) {
          e.currentTarget.style.background = styles.sidebarHover;
          e.currentTarget.style.color = styles.text;
        }
      }}
      onMouseLeave={(e) => {
        if (!open) {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = styles.textSecondary;
        }
      }}
    >
      <BellIcon size={16} strokeWidth={2} />
      {badge && (
        <span
          className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 grid place-items-center rounded-full text-[10px] font-bold leading-none"
          style={{
            background: "#EF4444",
            color: "#FFFFFF",
            boxShadow: `0 0 0 2px ${styles.sidebarBg}`,
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );

  return (
    <>
      {button}
      {popoverPos !== null && typeof document !== "undefined"
        ? createPortal(
            <AnimatePresence>
              {open ? (
                <motion.div
                  ref={popoverRef}
                  data-notification-popover
                  role="menu"
                  aria-label="Recent notifications"
                  initial={{ opacity: 0, y: -6, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -6, scale: 0.96 }}
                  transition={{ duration: 0.16, ease: [0.25, 0.1, 0.25, 1] }}
                  className="fixed z-[80] w-[340px] max-w-[calc(100vw-1rem)] rounded-[14px] border-[1.5px] overflow-hidden"
                  style={{
                    top: popoverPos.top,
                    left: popoverPos.left,
                    backgroundColor: styles.card,
                    borderColor: styles.border,
                    boxShadow: styles.softShadow,
                  }}
                >
                  {/* Header row: title + "Mark all read" action. */}
                  <div
                    className="flex items-center justify-between px-3 py-2 border-b-[1.5px]"
                    style={{ borderColor: styles.border }}
                  >
                    <span
                      className="text-[11px] font-bold uppercase tracking-widest"
                      style={{ color: styles.textTertiary }}
                    >
                      Notifications
                    </span>
                    {unread > 0 && (
                      <button
                        type="button"
                        onClick={() => void markAllRead()}
                        className="text-[11px] font-bold rounded-md px-2 py-1 transition-colors"
                        style={{
                          color: styles.accent,
                          background: withAlpha(styles.accent, 0.08),
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = withAlpha(
                            styles.accent,
                            0.16,
                          );
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = withAlpha(
                            styles.accent,
                            0.08,
                          );
                        }}
                      >
                        Mark all read
                      </button>
                    )}
                  </div>

                  {/* List — newest first, top 10. Max-height with scroll
                      for very long lists. */}
                  <div className="max-h-[min(60vh,420px)] overflow-y-auto">
                    {recent.length === 0 ? (
                      <div
                        className="px-3 py-8 text-center text-[12px] font-medium"
                        style={{ color: styles.textTertiary }}
                      >
                        No notifications yet
                      </div>
                    ) : (
                      recent.map((n) => {
                        const tone = toneForKind(n.kind);
                        const clickable = !!n.sessionId && !!n.projectId;
                        return (
                          <button
                            key={n.id}
                            type="button"
                            role="menuitem"
                            onClick={() => openRow(n)}
                            className="w-full text-left flex items-start gap-2.5 px-3 py-2.5 transition-colors border-b-[1px] last:border-b-0"
                            style={{
                              borderColor: styles.borderSubtle,
                              background:
                                n.read === 1
                                  ? "transparent"
                                  : withAlpha(styles.accent, 0.04),
                              cursor: clickable ? "pointer" : "default",
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.background = styles.subtle;
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background =
                                n.read === 1
                                  ? "transparent"
                                  : withAlpha(styles.accent, 0.04);
                            }}
                          >
                            <div
                              className="mt-0.5 shrink-0 grid place-items-center w-6 h-6 rounded-full"
                              style={{
                                background:
                                  tone === "transparent"
                                    ? styles.subtle
                                    : withAlpha(tone, 0.16),
                                color:
                                  tone === "transparent"
                                    ? styles.textSecondary
                                    : tone,
                              }}
                            >
                              <IconForKind kind={n.kind} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-start gap-2">
                                <span
                                  className="flex-1 text-[12.5px] font-bold leading-tight truncate"
                                  style={{ color: styles.text }}
                                >
                                  {n.title}
                                </span>
                                {n.read === 0 && (
                                  <span
                                    className="mt-1 shrink-0 w-2 h-2 rounded-full"
                                    style={{ background: styles.accent }}
                                    aria-label="unread"
                                  />
                                )}
                              </div>
                              {n.body && (
                                <div
                                  className="mt-0.5 text-[11.5px] leading-snug truncate"
                                  style={{ color: styles.textSecondary }}
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
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </>
  );
}
