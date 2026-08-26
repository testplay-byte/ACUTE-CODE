import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bot,
  Files,
  Globe,
  Plus,
  Terminal as TerminalIcon,
  X,
  PanelRightClose,
} from "lucide-react";
import {
  useRightSidebarStore,
  type RightSidebarTabType,
} from "../../lib/right-sidebar-store";
import { useRightSidebarEvents } from "../../lib/right-sidebar-events";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";
import { ease } from "../../lib/motion";
import { FileViewerPanel } from "./FileViewerPanel";
import { TerminalPanel } from "./TerminalPanel";
import { BrowserPanel } from "./BrowserPanel";
import { SubAgentPanel } from "./SubAgentPanel";
import { fetchSubAgents, type SubAgentStatus } from "../../lib/api";
import { useQuery } from "@tanstack/react-query";

/**
 * ROUND-39 (owner: "I was hoping for the UI to be much more like a browser…
 * at the very top we can add new tabs… a plus button… options on what I need
 * to open: file viewer / browser / terminal / sub-agents… sub-agent option
 * only shows if there were sub-agents… select which sub-agent I want to open
 * and that sub-agent will open up as a tab"). A browser-style tabbed right
 * sidebar: a dynamic list of tabs (file | browser | terminal | subagent)
 * with a "+" button that opens a quick-menu popover of SVG icons. Switching
 * tabs is one click. Closing is one x. Per-project state lives in
 * right-sidebar-store (v2 — dynamic tabs).
 */

const TAB_ICON: Record<RightSidebarTabType, typeof Files> = {
  file: Files,
  browser: Globe,
  terminal: TerminalIcon,
  subagent: Bot,
};

const ROLE_COLORS: Record<string, string> = {
  planner: "#c792ea",
  researcher: "#82aaff",
  coder: "#a5d6a7",
  reviewer: "#f9a825",
  tester: "#f59e0b",
};

export function RightSidebar({
  projectId,
  sessionId,
}: {
  projectId: string;
  /** The current PARENT session id (for the sub-agents quick-menu list). */
  sessionId: string | null;
}) {
  const styles = useThemeStyles();
  const slice = useRightSidebarStore((s) => s.byProject[projectId]);
  const ensure = useRightSidebarStore((s) => s.ensure);
  const setActiveTab = useRightSidebarStore((s) => s.setActiveTab);
  const closeTab = useRightSidebarStore((s) => s.closeTab);
  const toggleOpen = useRightSidebarStore((s) => s.toggleOpen);
  const openBrowser = useRightSidebarStore((s) => s.openBrowser);
  const openTerminal = useRightSidebarStore((s) => s.openTerminal);
  const openSubAgent = useRightSidebarStore((s) => s.openSubAgent);
  const requestFilePicker = useRightSidebarEvents((s) => s.requestFilePicker);
  // Make sure the project has a slice (idempotent).
  if (slice === undefined) ensure(projectId);
  const state = slice ?? useRightSidebarStore.getState().byProject[projectId];
  if (state === undefined) return null;
  const open = state.open;
  const width = state.width;

  // Quick-menu open state.
  const [quickMenuOpen, setQuickMenuOpen] = useState(false);
  const [subAgentPickerFor, setSubAgentPickerFor] = useState<RightSidebarTabType | null>(null);

  // Live sub-agents list (for the quick-menu's "Sub-agents" option visibility
  // + the picker popover).
  const subAgentsQuery = useQuery({
    queryKey: ["subagents", sessionId],
    queryFn: () => fetchSubAgents(sessionId as string),
    enabled: sessionId !== null,
    staleTime: 2_000,
    refetchInterval: 3_000,
  });
  const subs: SubAgentStatus[] = subAgentsQuery.data ?? [];
  const hasSubs = subs.length > 0;

  // ROUND-40 (owner: "+ dropdown must overlay below the tab bar, not render
  // inside it forcing scroll"). The QuickMenu / SubAgentPicker popovers are
  // now portaled to document.body and positioned fixed below the "+"
  // button. This escapes ALL overflow clipping (the tab strip's
  // overflow-x-auto AND the sidebar shell's overflow-hidden). Position is
  // computed from the "+" button's bounding rect on open and refreshed on
  // window resize / scroll (capture phase so any scroller anywhere updates
  // the anchor).
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
  const updatePopoverPos = useCallback(() => {
    if (!plusBtnRef.current) return;
    const r = plusBtnRef.current.getBoundingClientRect();
    setPopoverPos({ top: r.bottom + 4, left: r.left });
  }, []);
  useEffect(() => {
    if (!quickMenuOpen && subAgentPickerFor === null) return;
    updatePopoverPos();
    const onWin = () => updatePopoverPos();
    window.addEventListener("resize", onWin);
    window.addEventListener("scroll", onWin, true);
    return () => {
      window.removeEventListener("resize", onWin);
      window.removeEventListener("scroll", onWin, true);
    };
  }, [quickMenuOpen, subAgentPickerFor, updatePopoverPos]);
  // Shared opener used by both the tab-strip "+" button and the EmptyState's
  // big "+" button. Computes the anchor synchronously so the first paint
  // of the popover is already correctly positioned (no flash at 0,0).
  const openQuickMenu = useCallback(() => {
    if (plusBtnRef.current) {
      const r = plusBtnRef.current.getBoundingClientRect();
      setPopoverPos({ top: r.bottom + 4, left: r.left });
    }
    setQuickMenuOpen(true);
  }, []);

  if (!open) {
    // Collapsed rail — a reopen button.
    return (
      <motion.button
        onClick={() => toggleOpen(projectId)}
        aria-label="Open right sidebar"
        title="Open right sidebar"
        initial={{ opacity: 0, width: 0 }}
        animate={{ opacity: 1, width: 36 }}
        transition={{ duration: 0.2, ease }}
        className="shrink-0 self-stretch rounded-2xl grid place-items-center transition-colors"
        style={{ background: styles.card, border: `1.5px solid ${styles.border}`, color: styles.textTertiary }}
        onMouseEnter={(e) => (e.currentTarget.style.background = styles.subtleHover)}
        onMouseLeave={(e) => (e.currentTarget.style.background = styles.card)}
      >
        <PanelRightClose size={14} className="rotate-180" />
      </motion.button>
    );
  }

  const activeTab = state.tabs.find((t) => t.id === state.activeTabId) ?? null;

  return (
    <motion.div
      initial={false}
      animate={{ width, opacity: 1 }}
      transition={{ duration: 0.2, ease }}
      className="shrink-0 flex flex-col overflow-hidden rounded-2xl"
      style={{ background: styles.card, border: `1.5px solid ${styles.border}` }}
    >
      {/* ── Browser-style tab strip header ──
          ROUND-40 (owner: "+ dropdown must overlay below the tab bar, not
          render inside it forcing scroll; collapse button must ALWAYS be
          visible top-right, nothing overlaps it"). The header is now a
          relative wrapper around (a) the overflow-x-auto tab strip (tabs +
          "+" only) and (b) the absolutely-positioned collapse button
          (never scrolled). The QuickMenu / SubAgentPicker popovers are
          portaled to document.body so they escape the tab strip's
          overflow-x-auto clipping entirely; they anchor below the "+"
          button via its bounding rect. */}
      <div className="relative shrink-0">
        {/* Scrollable tab strip — tabs + "+" only. pr-9 reserves room on
            the right so the absolutely-positioned collapse button never
            covers a tab's close X. */}
        <div
          className="flex items-stretch gap-0.5 h-10 border-b overflow-x-auto pr-9"
          style={{
            borderColor: styles.border,
            background: styles.isDark ? "rgba(0,0,0,0.12)" : styles.subtle,
            scrollbarWidth: "thin",
          }}
        >
          {state.tabs.map((tab) => {
            const active = tab.id === state.activeTabId;
            const Icon = TAB_ICON[tab.type];
            const iconColor =
              tab.type === "subagent" && tab.subRole
                ? ROLE_COLORS[tab.subRole] ?? styles.accent
                : active
                  ? styles.accent
                  : styles.textTertiary;
            return (
              <div
                key={tab.id}
                role="tab"
                tabIndex={0}
                aria-selected={active}
                onClick={() => setActiveTab(projectId, tab.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setActiveTab(projectId, tab.id);
                  }
                }}
                className="group relative flex items-center gap-1.5 pl-2.5 pr-1.5 h-full min-w-[120px] max-w-[180px] cursor-pointer transition-colors shrink-0"
                style={{
                  background: active ? styles.card : "transparent",
                  color: active ? styles.text : styles.textSecondary,
                  borderBottom: active ? `2px solid ${styles.accent}` : `2px solid transparent`,
                }}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.background = styles.subtleHover;
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.background = "transparent";
                }}
                title={tab.title}
              >
                <Icon size={13} style={{ color: iconColor }} className="shrink-0" />
                <span className="flex-1 min-w-0 truncate text-[11px] font-medium">
                  {tab.title}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(projectId, tab.id);
                  }}
                  aria-label={`Close ${tab.title}`}
                  title="Close tab"
                  className="w-5 h-5 grid place-items-center rounded shrink-0 transition-colors"
                  style={{ color: styles.textTertiary }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = withAlpha(styles.accent, 0.12);
                    e.currentTarget.style.color = styles.text;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.color = styles.textTertiary;
                  }}
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}

          {/* + button (opens the quick menu). Stays inside the scroll strip
              so it scrolls with the tabs (browser-style). The popovers it
              opens are portaled out (below). */}
          <div className="relative shrink-0">
            <button
              ref={plusBtnRef}
              onClick={() => {
                if (!quickMenuOpen && plusBtnRef.current) {
                  const r = plusBtnRef.current.getBoundingClientRect();
                  setPopoverPos({ top: r.bottom + 4, left: r.left });
                }
                setQuickMenuOpen((v) => !v);
              }}
              aria-label="New tab"
              title="New tab"
              className="w-8 h-full grid place-items-center transition-colors"
              style={{
                color: quickMenuOpen ? styles.accent : styles.textTertiary,
                background: quickMenuOpen ? withAlpha(styles.accent, 0.12) : "transparent",
              }}
              onMouseEnter={(e) => {
                if (!quickMenuOpen) {
                  e.currentTarget.style.background = styles.subtleHover;
                  e.currentTarget.style.color = styles.text;
                }
              }}
              onMouseLeave={(e) => {
                if (!quickMenuOpen) {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = styles.textTertiary;
                }
              }}
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        {/* Collapse button — ALWAYS visible top-right, never inside the
            scrollable strip, z above the portaled popovers (z-50) so nothing
            overlaps it. */}
        <button
          onClick={() => toggleOpen(projectId)}
          aria-label="Collapse right sidebar"
          title="Collapse"
          className="absolute top-1 right-1.5 z-[60] w-7 grid place-items-center rounded-lg transition-colors"
          style={{ color: styles.textTertiary, height: "28px" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = styles.subtleHover)}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <PanelRightClose size={13} />
        </button>

        {/* Popovers portaled to document.body — escape ALL overflow clipping
            (overflow-x-auto on the tab strip + overflow-hidden on the sidebar
            shell). Anchored below the "+" button via its bounding rect;
            refreshed on window resize/scroll. */}
        {popoverPos !== null && typeof document !== "undefined"
          ? createPortal(
              <>
                <AnimatePresence>
                  {quickMenuOpen ? (
                    <QuickMenu
                      styles={styles}
                      hasSubs={hasSubs}
                      anchor={popoverPos}
                      onPick={(type) => {
                        setQuickMenuOpen(false);
                        if (type === "file") {
                          requestFilePicker();
                        } else if (type === "browser") {
                          openBrowser(projectId, null);
                        } else if (type === "terminal") {
                          openTerminal(projectId);
                        } else if (type === "subagent") {
                          setSubAgentPickerFor("subagent");
                        }
                      }}
                      onClose={() => setQuickMenuOpen(false)}
                    />
                  ) : null}
                </AnimatePresence>
                <AnimatePresence>
                  {subAgentPickerFor !== null ? (
                    <SubAgentPicker
                      styles={styles}
                      subs={subs}
                      anchor={popoverPos}
                      onPick={(sub) => {
                        setSubAgentPickerFor(null);
                        if (sessionId !== null) {
                          openSubAgent(
                            projectId,
                            sessionId,
                            sub.id,
                            sub.title ?? "Sub-agent",
                            sub.subRole ?? undefined,
                          );
                        }
                      }}
                      onClose={() => setSubAgentPickerFor(null)}
                    />
                  ) : null}
                </AnimatePresence>
              </>,
              document.body,
            )
          : null}
      </div>

      {/* ── Active panel ── */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === null ? (
          <EmptyState styles={styles} onNewTab={openQuickMenu} />
        ) : activeTab.type === "file" ? (
          <FileViewerPanel projectId={projectId} tab={activeTab} />
        ) : activeTab.type === "terminal" ? (
          <TerminalPanel projectId={projectId} tab={activeTab} />
        ) : activeTab.type === "browser" ? (
          <BrowserPanel projectId={projectId} tab={activeTab} />
        ) : (
          <SubAgentPanel tab={activeTab} />
        )}
      </div>
    </motion.div>
  );
}

/** The quick-menu popover (SVG icons for: file / browser / terminal /
 * sub-agents). Sub-agents only renders when the parent session has
 * children. */
function QuickMenu({
  styles,
  hasSubs,
  anchor,
  onPick,
  onClose,
}: {
  styles: ReturnType<typeof useThemeStyles>;
  hasSubs: boolean;
  /** Viewport-relative anchor (top-left of the popover), computed from
   * the "+" button's bounding rect by the parent and refreshed on
   * window resize/scroll. The popover is portaled to document.body so
   * this is a fixed position. */
  anchor: { top: number; left: number };
  onPick: (type: RightSidebarTabType) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const items: Array<{ type: RightSidebarTabType; label: string; icon: typeof Files; desc: string }> = [
    { type: "file", label: "File", icon: Files, desc: "Open a code/markdown file" },
    { type: "browser", label: "Browser", icon: Globe, desc: "Browse the web in-app" },
    { type: "terminal", label: "Terminal", icon: TerminalIcon, desc: "Run a shell command" },
  ];
  if (hasSubs) {
    items.push({
      type: "subagent",
      label: "Sub-agents",
      icon: Bot,
      desc: "Inspect a child sub-agent",
    });
  }
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: -4, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.97 }}
      transition={{ duration: 0.14, ease }}
      className="fixed z-50 w-[220px] rounded-xl border p-1.5"
      style={{
        top: anchor.top,
        left: anchor.left,
        background: styles.card,
        borderColor: styles.border,
        boxShadow: styles.softShadow,
      }}
    >
      <div
        className="px-1.5 pt-0.5 pb-1 text-[9.5px] font-bold uppercase tracking-wider"
        style={{ color: styles.textTertiary }}
      >
        New tab
      </div>
      {items.map(({ type, label, icon: Icon, desc }) => (
        <button
          key={type}
          onClick={() => onPick(type)}
          className="w-full flex items-start gap-2 px-1.5 py-1.5 rounded-lg transition-colors text-left"
          onMouseEnter={(e) => (e.currentTarget.style.background = styles.subtleHover)}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <Icon size={16} style={{ color: styles.accent }} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="text-[12px] font-semibold leading-tight" style={{ color: styles.text }}>
              {label}
            </div>
            <div className="text-[10.5px] leading-tight mt-0.5" style={{ color: styles.textTertiary }}>
              {desc}
            </div>
          </div>
        </button>
      ))}
    </motion.div>
  );
}

/** The sub-agent picker (shown when the user picks "Sub-agents" from the
 * quick menu). Lists the parent session's sub-agents with role + status;
 * picking one opens a sub-agent tab. */
function SubAgentPicker({
  styles,
  subs,
  anchor,
  onPick,
  onClose,
}: {
  styles: ReturnType<typeof useThemeStyles>;
  subs: SubAgentStatus[];
  /** Viewport-relative anchor (top-left of the popover), computed from
   * the "+" button's bounding rect by the parent. */
  anchor: { top: number; left: number };
  onPick: (sub: SubAgentStatus) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: -4, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.97 }}
      transition={{ duration: 0.14, ease }}
      className="fixed z-50 w-[260px] max-h-[300px] overflow-y-auto rounded-xl border p-1.5"
      style={{
        top: anchor.top,
        left: anchor.left,
        background: styles.card,
        borderColor: styles.border,
        boxShadow: styles.softShadow,
      }}
    >
      <div
        className="px-1.5 pt-0.5 pb-1 text-[9.5px] font-bold uppercase tracking-wider"
        style={{ color: styles.textTertiary }}
      >
        Sub-agents
      </div>
      {subs.length === 0 ? (
        <div className="px-1.5 py-2 text-[11px]" style={{ color: styles.textTertiary }}>
          No sub-agents in this session.
        </div>
      ) : (
        subs.map((sub) => {
          const role = sub.subRole ?? "agent";
          const color = ROLE_COLORS[role] ?? styles.textTertiary;
          return (
            <button
              key={sub.id}
              onClick={() => onPick(sub)}
              className="w-full flex items-center gap-2 px-1.5 py-1.5 rounded-lg transition-colors text-left"
              onMouseEnter={(e) => (e.currentTarget.style.background = styles.subtleHover)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <span
                className="text-[9px] font-mono font-bold uppercase shrink-0 px-1.5 py-0.5 rounded-md"
                style={{ color, background: withAlpha(color, 0.14) }}
              >
                {role}
              </span>
              <span className="flex-1 min-w-0 truncate text-[11px] font-medium" style={{ color: styles.text }} title={sub.title ?? "Untitled"}>
                {sub.title ?? "Untitled"}
              </span>
              <span className="text-[10px] shrink-0" style={{ color: styles.textTertiary }}>
                {sub.status}
              </span>
            </button>
          );
        })
      )}
    </motion.div>
  );
}

function EmptyState({
  styles,
  onNewTab,
}: {
  styles: ReturnType<typeof useThemeStyles>;
  onNewTab: () => void;
}) {
  return (
    <div className="h-full grid place-items-center px-6 text-center">
      <div>
        <button
          onClick={onNewTab}
          className="w-12 h-12 mx-auto mb-3 grid place-items-center rounded-2xl border-2 border-dashed transition-colors"
          style={{
            borderColor: styles.border,
            color: styles.textTertiary,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = withAlpha(styles.accent, 0.5);
            e.currentTarget.style.color = styles.accent;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = styles.border;
            e.currentTarget.style.color = styles.textTertiary;
          }}
          aria-label="Open a new tab"
          title="Open a new tab"
        >
          <Plus size={20} />
        </button>
        <div className="text-[12.5px] font-medium" style={{ color: styles.textSecondary }}>
          No tabs open
        </div>
        <div className="text-[11px] mt-1.5" style={{ color: styles.textTertiary }}>
          Click + to open a file, browser, terminal, or sub-agent tab.
        </div>
      </div>
    </div>
  );
}
