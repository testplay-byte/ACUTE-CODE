import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  Bot,
  Brain,
  Files,
  FolderTree,
  Globe,
  Plus,
  Terminal as TerminalIcon,
  X,
  PanelRightClose,
} from "lucide-react";
import {
  useRightSidebarStore,
  stateKey,
  defaultProjectRightState,
  type RightSidebarTabType,
} from "../../lib/right-sidebar-store";
import { useRightSidebarEvents } from "../../lib/right-sidebar-events";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";
import { ease } from "../../lib/motion";
import { FileViewerPanel } from "./FileViewerPanel";
// ROUND-48 (R48-c): the project file-explorer tab (tree left / content right).
import { FilesExplorerPanel } from "./FilesExplorerPanel";
import { TerminalPanel } from "./TerminalPanel";
import { BrowserPanel } from "./BrowserPanel";
import { SubAgentPanel } from "./SubAgentPanel";
// ROUND-44 (R44-a): the project-memory tab panel.
import { MemoryPanel } from "./MemoryPanel";
// ROUND-59 (R59-E): the diagnostics console tab panel (error monitoring).
import { ConsolePanel } from "./ConsolePanel";
// ROUND-64 (R64-b): the ROUND-61 computer-use monitor tab panel is DELETED —
// the always-on-top floating monitor window (src-tauri/src/mini.rs +
// src/mini/**, auto-opened by ComputerMiniWindow on live activity) is the
// only computer-use surface now (owner: "There is actually no need to show
// the computer use in the right sidebar menu at all").
import { fetchSubAgents, type SubAgentStatus } from "../../lib/api";
// R60-D: hide the active browser tab's native webview while the quick-menu
// / sub-agent-picker popover is open — native child webviews are OS layers
// ABOVE all app HTML, so a popover that overlaps the page area renders
// BEHIND it otherwise (the owner: "the options get hidden behind the actual
// browser window itself").
import { nativeTabSetVisible } from "../../lib/native-browser";
// R60-D: the shared suppression flag the BrowserPanel consults before
// showing a webview (closes the created-while-popover-open ordering race).
import { setPopoverWebviewSuppression } from "./popover-webview-guard";
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
  // ROUND-48 (R48-c): the file-explorer tab.
  files: FolderTree,
  browser: Globe,
  terminal: TerminalIcon,
  subagent: Bot,
  memory: Brain,
  // ROUND-59 (R59-E): the diagnostics console (error monitoring) tab.
  console: Activity,
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
  maxWidth,
}: {
  projectId: string;
  /** The current PARENT session id (for the sub-agents quick-menu list). */
  sessionId: string | null;
  /** ROUND-42: render-time cap on the sidebar's width — computed by
   * ChatFocusLayout from the container's measured width so the CHAT never
   * drops below its minimum. On narrow windows the sidebar smoothly
   * auto-shrinks instead of squeezing the chat. */
  maxWidth?: number;
}) {
  const styles = useThemeStyles();
  // ROUND-41: the slice is keyed by `${projectId}::${sessionId}` so each
  // session has its own independent sidebar state. When sessionId is null
  // (no sessions yet) the key falls back to `::default` so the sidebar still
  // renders an empty state.
  const activeSessionId = useRightSidebarStore(
    (s) => s.activeSessionByProject[projectId] ?? null,
  );
  const slice = useRightSidebarStore(
    (s) => s.byProject[stateKey(projectId, activeSessionId)],
  );
  const ensure = useRightSidebarStore((s) => s.ensure);
  const setActiveTab = useRightSidebarStore((s) => s.setActiveTab);
  const closeTab = useRightSidebarStore((s) => s.closeTab);
  const toggleOpen = useRightSidebarStore((s) => s.toggleOpen);
  const openBrowser = useRightSidebarStore((s) => s.openBrowser);
  const openTerminal = useRightSidebarStore((s) => s.openTerminal);
  const openMemory = useRightSidebarStore((s) => s.openMemory);
  // ROUND-59 (R59-E): the diagnostics console quick-menu action.
  const openConsole = useRightSidebarStore((s) => s.openConsole);
  // ROUND-48 (R48-c): the file-explorer quick-menu action.
  const openFiles = useRightSidebarStore((s) => s.openFiles);
  const openSubAgent = useRightSidebarStore((s) => s.openSubAgent);
  const requestFilePicker = useRightSidebarEvents((s) => s.requestFilePicker);
  // ROUND-42: ensure the project has a slice (idempotent — uses the active
  // session's key). Moved OUT of the render body — calling the zustand setter
  // during render triggered React's "Cannot update a component while
  // rendering" warning. The effect runs post-render; until then a default
  // slice renders (visually identical — no tabs, default width).
  useEffect(() => {
    if (slice === undefined) ensure(projectId);
  }, [slice, projectId, ensure]);
  const state = slice ?? defaultProjectRightState();
  const open = state.open;
  // ROUND-42: the EFFECTIVE width — the stored (dragged) width clamped by
  // the layout's computed cap. ROUND-43: the floor is the 36px collapse-
  // button column (was 240 — with the R42 cap's own 280px floor that made
  // chat-floor(480)+sidebar(280)+chrome ≈ 771px the layout's minimum, so any
  // narrower container overflowed: clipped sidebar, unreachable collapse
  // button). Now the sidebar yields ALL the way down when the window can't
  // fit it next to the chat's floor — the collapse affordance stays on-screen
  // and the row never forces horizontal overflow. The framer-motion `animate`
  // width below transitions SMOOTHLY whenever the cap changes (window resize)
  // — the owner asked for the shrink to happen "automatically, smoothly".
  const width = Math.max(36, Math.min(state.width, maxWidth ?? state.width));

  // Quick-menu open state.
  const [quickMenuOpen, setQuickMenuOpen] = useState(false);
  const [subAgentPickerFor, setSubAgentPickerFor] = useState<RightSidebarTabType | null>(null);

  // The active tab, hoisted ABOVE the collapsed-rail early return so the
  // R60-D popover-hide effect below (a hook — it must run on every render,
  // rail included) can see it.
  const activeTab = state.tabs.find((t) => t.id === state.activeTabId) ?? null;

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
  //
  // ROUND-41 (owner: "if I tap the new tab button on the very right side…
  // it does not respect the size of the screen. It shows the menu which
  // opens up for the new tab outside of it"). The popover's `left` is now
  // CLAMPED so the menu never spills past the viewport's right edge: if the
  // anchor + the menu's width would overflow, shift the menu left by the
  // overflow amount (with an 8px viewport margin). Same flip for the
  // SubAgentPicker (260px wide).
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
  const updatePopoverPos = useCallback(() => {
    if (!plusBtnRef.current) return;
    const r = plusBtnRef.current.getBoundingClientRect();
    const POPOVER_WIDTH = 240; // QuickMenu 220 + padding; SubAgentPicker 260 — use the wider.
    const VIEWPORT_MARGIN = 8;
    const maxLeft = window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN;
    const left = Math.min(r.left, Math.max(VIEWPORT_MARGIN, maxLeft));
    setPopoverPos({ top: r.bottom + 4, left });
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
      const POPOVER_WIDTH = 240;
      const VIEWPORT_MARGIN = 8;
      const maxLeft = window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN;
      const left = Math.min(r.left, Math.max(VIEWPORT_MARGIN, maxLeft));
      setPopoverPos({ top: r.bottom + 4, left });
    }
    setQuickMenuOpen(true);
  }, []);

  // ── R60-D: popover-over-webview z-index fix ─────────────────────────────
  // The QuickMenu / SubAgentPicker popovers are portaled to document.body
  // with position:fixed — in WEB mode that is enough to sit above the panel.
  // In TAURI mode the browser panel's page renderer is a NATIVE CHILD
  // WEBVIEW: an OS-level layer that floats above ALL app HTML, so wherever
  // the popover overlaps the page area it renders BEHIND the webview (the
  // owner: "when I click the new tab option then the options get hidden
  // behind the actual browser window itself"). Fix: while either popover is
  // open AND the active right-sidebar tab is a browser tab, HIDE that tab's
  // webview (browser_tab_set_visible false — the same background-tab
  // mechanism the panel itself uses; the session STAYS ALIVE); restore it
  // when the popover closes. The restore is GUARDED: it fires only when the
  // popover closes with that SAME browser tab still active and the sidebar
  // still open — every other path (tab switched away, sidebar collapsed,
  // tab closed) leaves the webview hidden, which is exactly what the
  // panel's own mount/unmount lifecycle wants. In web mode
  // nativeTabSetVisible degrades to a resolved no-op, so this is
  // Tauri-only by construction.
  const popoverHiddenTabRef = useRef<string | null>(null);
  useEffect(() => {
    const popoverOpen = quickMenuOpen || subAgentPickerFor !== null;
    const activeBrowserTabId =
      open && activeTab !== null && activeTab.type === "browser" ? activeTab.id : null;
    const warn = (err: unknown) => console.warn("[native-browser]", err);
    if (popoverOpen) {
      if (activeBrowserTabId !== null && popoverHiddenTabRef.current !== activeBrowserTabId) {
        popoverHiddenTabRef.current = activeBrowserTabId;
        // The module flag is what the BrowserPanel's nativeCreate consults —
        // a webview created while this popover is open must not show itself.
        setPopoverWebviewSuppression(activeBrowserTabId);
        void nativeTabSetVisible(activeBrowserTabId, false).catch(warn);
      }
      return;
    }
    const hidden = popoverHiddenTabRef.current;
    if (hidden === null) return;
    popoverHiddenTabRef.current = null;
    setPopoverWebviewSuppression(null);
    // Restore ONLY when the hidden tab is still the ACTIVE browser tab with
    // the sidebar open (its BrowserPanel is mounted and owns the webview).
    if (activeBrowserTabId === hidden) {
      void nativeTabSetVisible(hidden, true).catch(warn);
    }
  }, [quickMenuOpen, subAgentPickerFor, open, activeTab]);

  // R60-D: unmount-only cleanup — if the whole sidebar goes away while a
  // popover is open (project/session switch), clear the module suppression
  // so no webview stays hidden forever; every panel's own mount/unmount
  // lifecycle re-owns visibility from there. (Separate empty-deps effect:
  // the hide/restore effect above must NOT re-run its cleanup per change.)
  useEffect(() => {
    return () => {
      popoverHiddenTabRef.current = null;
      setPopoverWebviewSuppression(null);
    };
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

  return (
    <motion.div
      initial={false}
      animate={{ width, opacity: 1 }}
      transition={{ duration: 0.2, ease }}
      className="shrink-0 flex flex-col overflow-hidden rounded-2xl"
      style={{ background: styles.card, border: `1.5px solid ${styles.border}` }}
    >
      {/* ── Browser-style tab strip header ──
          ROUND-41 (owner: "the collapse button was properly there and it
          would never disappear, which is good, but there were issues with
          it. The issue was that it was not like a dedicated section kind of
          vibe. The content was going under it. The content should not go
          under it. It should be a separate kind of section. No content
          should go under it or over it"). The header is now a FLEX ROW of
          two dedicated columns: (a) the scrollable tab strip (tabs + "+"
          only) on the left, and (b) a dedicated collapse-button column on
          the right with its own left border. The collapse button is NO
          LONGER absolutely positioned over the tabs — it has its own
          non-overlapping slot, so no tab close-X or content can ever go
          under or over it. The QuickMenu / SubAgentPicker popovers are
          still portaled to document.body (they anchor below the "+"
          button). */}
      <div className="flex shrink-0 items-stretch">
        {/* Column 1: scrollable tab strip — tabs + "+" only. */}
        <div
          className="flex-1 min-w-0 flex items-stretch gap-0.5 h-10 border-b overflow-x-auto"
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
                  const POPOVER_WIDTH = 240;
                  const VIEWPORT_MARGIN = 8;
                  const maxLeft = window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN;
                  const left = Math.min(r.left, Math.max(VIEWPORT_MARGIN, maxLeft));
                  setPopoverPos({ top: r.bottom + 4, left });
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

        {/* Column 2: DEDICATED collapse-button column. Has its own left
            border so it reads as a separate section, not an overlay. Nothing
            can go under or over it — the tab strip is column 1, this is
            column 2, they never overlap. */}
        <button
          onClick={() => toggleOpen(projectId)}
          aria-label="Collapse right sidebar"
          title="Collapse"
          className="shrink-0 w-9 h-10 grid place-items-center border-l transition-colors"
          style={{
            color: styles.textTertiary,
            borderColor: styles.border,
            background: styles.isDark ? "rgba(0,0,0,0.18)" : styles.subtle,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = styles.subtleHover;
            e.currentTarget.style.color = styles.text;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = styles.isDark ? "rgba(0,0,0,0.18)" : styles.subtle;
            e.currentTarget.style.color = styles.textTertiary;
          }}
        >
          <PanelRightClose size={13} />
        </button>

        {/* Popovers portaled to document.body — escape ALL overflow clipping
            (overflow-x-auto on the tab strip + overflow-hidden on the sidebar
            shell). Anchored below the "+" button via its bounding rect;
            LEFT is clamped so the menu never spills past the viewport's
            right edge (ROUND-41). */}
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
                        // ROUND-48 (R48-c): "Files" opens the real file
                        // explorer tab (tree left / content right). The OLD
                        // behavior (open the CommandPalette search) stays
                        // reachable via the explorer's header Search button.
                        if (type === "files") {
                          openFiles(projectId);
                        } else if (type === "browser") {
                          openBrowser(projectId, null);
                        } else if (type === "terminal") {
                          openTerminal(projectId);
                        } else if (type === "memory") {
                          openMemory(projectId);
                        } else if (type === "console") {
                          // R59-E: the diagnostics console — error monitoring.
                          openConsole(projectId);
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
                          // ROUND-48 (R48-e2): the tab title carries the
                          // child's code — the same `${code} · ${title}`
                          // convention the Delegated card's live rows use, so
                          // every sub-agent tab is identifiable at a glance.
                          openSubAgent(
                            projectId,
                            sessionId,
                            sub.id,
                            `${sub.code} · ${sub.title ?? "Sub-agent"}`,
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
          <EmptyState
            styles={styles}
            onNewTab={openQuickMenu}
            onOpenFile={() => requestFilePicker()}
            onOpenBrowser={() => openBrowser(projectId, null)}
            onOpenTerminal={() => openTerminal(projectId)}
          />
        ) : activeTab.type === "file" ? (
          <FileViewerPanel projectId={projectId} tab={activeTab} />
        ) : activeTab.type === "files" ? (
          // ROUND-48 (R48-c): the file explorer (tree left / content right).
          <FilesExplorerPanel projectId={projectId} tab={activeTab} />
        ) : activeTab.type === "terminal" ? (
          <TerminalPanel projectId={projectId} tab={activeTab} />
        ) : activeTab.type === "browser" ? (
          <BrowserPanel projectId={projectId} tab={activeTab} />
        ) : activeTab.type === "memory" ? (
          <MemoryPanel projectId={projectId} tab={activeTab} />
        ) : activeTab.type === "console" ? (
          // ROUND-59 (R59-E): the diagnostics console (error monitoring).
          <ConsolePanel projectId={projectId} tab={activeTab} />
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
    // ROUND-48 (R48-c): "Files" = the real file explorer tab (the palette
    // search this item used to open lives on the explorer's Search button).
    { type: "files", label: "Files", icon: FolderTree, desc: "Browse the project's files" },
    { type: "browser", label: "Browser", icon: Globe, desc: "Browse the web in-app" },
    { type: "terminal", label: "Terminal", icon: TerminalIcon, desc: "Run a shell command" },
    // ROUND-44 (R44-a): the agent's persistent project knowledge.
    { type: "memory", label: "Memory", icon: Brain, desc: "Saved project knowledge" },
    // ROUND-59 (R59-E): the diagnostics console — the owner's "console-like
    // error monitoring and error handling" directive.
    { type: "console", label: "Console", icon: Activity, desc: "Error monitoring — frontend + engine" },
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
              {/* ROUND-48 (R48-e2, owner: "so I can easily identify which
                  sub-agent is which"): the leading monospace code badge —
                  R48-e1's deterministic 4-char [A-Z0-9] short id, the same
                  mark the Delegated rows / panel header / approval
                  attribution use. */}
              <span
                className="shrink-0 font-mono text-[10px] font-bold px-1.5 py-0.5 rounded-md tracking-[0.08em]"
                style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}
                data-testid="subagent-picker-code"
              >
                {sub.code}
              </span>
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
  onOpenFile,
  onOpenBrowser,
  onOpenTerminal,
}: {
  styles: ReturnType<typeof useThemeStyles>;
  onNewTab: () => void;
  onOpenFile: () => void;
  onOpenBrowser: () => void;
  onOpenTerminal: () => void;
}) {
  // ROUND-42: the empty sidebar is no longer a bare dashed + — direct
  // quick-actions open the common tabs in ONE click (the + quick-menu stays
  // for the sub-agent picker). Looks intentional instead of empty (owner:
  // "the right side empty area… both of them were not good").
  const actions = [
    { label: "Open a file", icon: Files, onClick: onOpenFile },
    { label: "Browse the web", icon: Globe, onClick: onOpenBrowser },
    { label: "Open a terminal", icon: TerminalIcon, onClick: onOpenTerminal },
  ];
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
        <div className="text-[11px] mt-1.5 mb-3" style={{ color: styles.textTertiary }}>
          Pick one to get started:
        </div>
        <div className="flex flex-col gap-1.5 max-w-[220px] mx-auto">
          {actions.map(({ label, icon: Icon, onClick }) => (
            <button
              key={label}
              onClick={onClick}
              className="w-full flex items-center gap-2 h-9 px-3 rounded-xl border text-[12px] font-medium transition-all hover:-translate-y-px"
              style={{
                borderColor: styles.border,
                background: styles.isDark ? "rgba(0,0,0,0.12)" : styles.subtle,
                color: styles.textSecondary,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = withAlpha(styles.accent, 0.5);
                e.currentTarget.style.color = styles.text;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = styles.border;
                e.currentTarget.style.color = styles.textSecondary;
              }}
            >
              <Icon size={14} style={{ color: styles.accent }} className="shrink-0" />
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
