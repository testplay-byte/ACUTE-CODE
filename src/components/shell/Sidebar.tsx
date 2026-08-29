import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  ArrowLeft,
  BarChart3,
  Bot,
  ChevronsLeft,
  ChevronsRight,
  CircleAlert,
  FolderOpen,
  LayoutDashboard,
  LoaderCircle,
  MessageSquare,
  Palette,
  Pencil,
  Plus,
  Server,
  Settings,
  SlidersHorizontal,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { ApiError, pickFolderViaBackend, type Project, type Session } from "../../lib/api";
import { cn } from "../../lib/utils";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { isTauri } from "../../lib/sidecar";
import { useConfigStore } from "../../lib/config-store";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useProjects, useCreateProject, useDeleteProject } from "../../hooks/use-projects";
import { useCreateSession, useDeleteSession, useRenameSession, useSessions } from "../../hooks/use-sessions";
import { useAgents } from "../../hooks/use-agents";
import { useProjectChatStore } from "../../lib/project-chat-store";
import { useActiveStreams } from "../../lib/active-streams";
import { withAlpha } from "../dashboard/helpers";
import { NotificationBell } from "../notifications/NotificationBell";

type TauriGlobal = {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
};

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri) throw new Error("Tauri shell unavailable");
  return tauri.core.invoke(command, args) as Promise<T>;
}

const COLLAPSE_KEY = "acute-code.sidebar.collapsed";
const EXPANDED_KEY = "acute-code.sidebar.expandedProjects";

function readCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; }
}
function readExpanded(): string[] {
  try { return JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]") as string[]; } catch { return []; }
}

/** ROUND-42: shade a hex color ±percent — feeds the project tile gradient
 * (owner: "the project's actual images need to be a bit better"). */
function shadeHex(hex: string, percent: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (m === null) return hex;
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(parseInt(m[1], 16) + 255 * percent);
  const g = clamp(parseInt(m[2], 16) + 255 * percent);
  const b = clamp(parseInt(m[3], 16) + 255 * percent);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** ROUND-42: the project's tile — a soft vertical gradient derived from the
 * project's own color, with an inner top highlight + soft shadow. Replaces
 * the flat colored square (owner: modern, beautiful, cleaner, smoother).
 * ROUND-48 (R48-a): `selected` paints a 2px INSET ring on the tile itself so
 * the collapsed rail's active tile stays the exact same size as its
 * siblings (the old outside outline made it look bigger + clipped it). The
 * ring is WHITE — the tile is already a gradient of project.color, so a
 * project.color ring would vanish against it — and the soft outer glow
 * carries the project's hue. */
function ProjectTile({
  color,
  name,
  size = 32,
  radius = 10,
  fontSize = 13,
  selected = false,
}: {
  color: string;
  name: string;
  size?: number;
  radius?: number;
  fontSize?: number;
  selected?: boolean;
}) {
  return (
    <span
      className="shrink-0 grid place-items-center font-black select-none"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        fontSize,
        color: "#fff",
        background: `linear-gradient(150deg, ${shadeHex(color, 0.22)} 0%, ${color} 45%, ${shadeHex(color, -0.24)} 100%)`,
        boxShadow: selected
          ? `inset 0 0 0 2px rgba(255,255,255,0.95), inset 0 1px 0 rgba(255,255,255,0.28), inset 0 -1px 2px rgba(0,0,0,0.18), 0 2px 8px ${withAlpha(color, 0.55)}`
          : "inset 0 1px 0 rgba(255,255,255,0.28), inset 0 -1px 2px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.14)",
        textShadow: "0 1px 1px rgba(0,0,0,0.22)",
      }}
      aria-hidden
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * AcuteLogo (round-33; ROUND-48 redesign): the custom app mark — a rounded
 * orange tile with a SOLID angular white "A" plus a terminal-cursor
 * underscore ("A_" — the prompt heritage of a coding agent; owner round-48:
 * "the logo could be improved... currently it is just an A"). The old
 * 2-stroke A became a filled chevron silhouette with a punched counter, so
 * the mark stays crisp from 16px (favicon) to 52px (chat empty state).
 * Doubles as the sidebar toggle: hover morphs the mark into a panel-left
 * icon (cross-fade), click toggles. Used in the sidebar header, the mobile
 * drawer trigger, the floating show-sidebar button, and the chat empty
 * state — all through the same `size` prop. The mark mirrors
 * public/favicon.svg 1:1.
 */
export function AcuteLogo({
  size = 32,
  hoverToggle = false,
  onClick,
  ariaLabel,
  title,
}: {
  size?: number;
  hoverToggle?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
  title?: string;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={ariaLabel ?? "Acute"}
      title={title}
      className="relative grid place-items-center transition-transform hover:scale-[1.05] active:scale-95"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.28),
        background: "linear-gradient(155deg, #FF8147 0%, #FF6B2C 52%, #ED5A17 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.32), 0 2px 10px rgba(255,107,44,0.35)",
      }}
    >
      {/* The "A_" mark — a solid angular A (flat apex, punched counter) +
          the terminal underscore. Fades out on hover when hoverToggle. */}
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          opacity: hoverToggle && hovered ? 0 : 1,
          transition: "opacity 0.15s",
        }}
      >
        <path
          d="M11.8 7.5 H13.4 L20 25 H16.4 L15 21.3 H10.2 L8.8 25 H5.2 Z M12.6 13.3 L14.5 18.4 H10.7 Z"
          fill="#FFFFFF"
          fillRule="evenodd"
        />
        <rect x="22.1" y="22.3" width="4.9" height="2.7" rx="0.6" fill="#FFFFFF" />
      </svg>
      {/* The panel-left toggle icon — fades in on hover when hoverToggle */}
      {hoverToggle && (
        <svg
          width={size * 0.55}
          height={size * 0.55}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          style={{
            position: "absolute",
            opacity: hovered ? 1 : 0,
            transition: "opacity 0.15s",
          }}
        >
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <path d="M9 3v18" />
        </svg>
      )}
    </button>
  );
}

/**
 * Sidebar (round-33 owner redesign):
 * - HEADER: the Acute logo tile at the TOP-LEFT (click toggles the sidebar;
 *   hover morphs the mark into a panel-toggle icon) + the collapse button at
 *   the TOP-RIGHT, beside the logo (moved from the footer per owner).
 * - GENEROUS spacing between NAVIGATION and PROJECTS (owner: "way too close
 *   together").
 * - PROJECTS: no chevron, no session-count chip; the "+ new session" button
 *   lives ON the project row itself (owner directive); sessions are
 *   renameable (round-33).
 * - FOOTER: a PROMINENT Settings button (card-style, not a plain nav row).
 * - Collapsed rail: logo + icon tiles.
 */
/** ROUND-34 (owner design frame 1a): the settings sections that REPLACE the
 * normal navigation when the sidebar is in settings mode. ids stay the
 * SettingsPage tab ids so ?tab= deep links keep working. */
const SETTINGS_SECTIONS = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "api", label: "Models & Providers", icon: Server },
  // ROUND-44 (VLM pass): this entry was MISSING — the R43 Sub-agents tab
  // existed in SettingsPage TABS but the sidebar (the actual settings nav,
  // R34 design) never listed it, making the whole tab unreachable except by
  // hand-typing ?tab=subagents. Owners could not find the key pool at all.
  { id: "subagents", label: "Sub-agents", icon: Users },
  { id: "advanced", label: "Advanced", icon: SlidersHorizontal },
] as const;

export function Sidebar() {
  const styles = useThemeStyles();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  // ROUND-45 (VLM-pass find): MOBILE DRAWER. Below md the sidebar is a
  // fixed overlay (the old static 270px column left only 69px of content at
  // 375px) — closed by default, opened by the floating logo trigger,
  // closed by the backdrop, and auto-closed on navigation.
  const [mobileOpen, setMobileOpen] = useState(false);
  const setAppSidebarVisible = useProjectChatStore((s) => s.setAppSidebarVisible);
  const appSidebarVisible = useProjectChatStore((s) => s.appSidebarVisible);
  const { pathname, search } = useLocation();
  const isChatRoute = /^\/project\/[^/]+\/chat\/?$/.test(pathname);
  // ROUND-34: settings mode — the sidebar TRANSFORMS into the settings nav
  // (owner design: "the whole sidebar should change into the settings sidebar").
  const isSettingsRoute = pathname.startsWith("/settings");
  const activeTab = new URLSearchParams(search).get("tab") ?? "appearance";
  const showSidebar = !isChatRoute || appSidebarVisible;
  // Hooks BEFORE any early return (rules-of-hooks — review finding #1).
  const navigate = useNavigate();

  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch { /* */ }
  }, [collapsed]);

  // ROUND-45: any navigation closes the mobile drawer (standard drawer UX).
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname, search]);

  if (!showSidebar) return null;

  // Logo click (owner round-33): on chat routes it hides the sidebar (the
  // floating logo appears at the chat window's top-left to bring it back);
  // in settings mode it's the BACK affordance; elsewhere it toggles the rail.
  const onLogoClick = () => {
    if (isChatRoute) {
      setAppSidebarVisible(false);
    } else if (isSettingsRoute) {
      navigate("/");
    } else {
      setCollapsed((v) => !v);
    }
  };

  return (
    <>
      {/* ROUND-45: mobile backdrop — click to close; md+ unaffected. */}
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-40 cursor-default bg-black/40 md:hidden"
        />
      )}
      {/* ROUND-45: mobile trigger — the app logo, matching the chat-route
          floating toggle; visible below md whenever the drawer is closed. */}
      {!mobileOpen && (
        <div className="fixed top-[10px] left-[10px] z-50 md:hidden">
          <AcuteLogo
            size={34}
            hoverToggle
            onClick={() => setMobileOpen(true)}
            ariaLabel="Acute — open menu"
            title="Open menu"
          />
        </div>
      )}
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 64 : 270 }}
      transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
      className={cn(
        "shrink-0 flex flex-col overflow-hidden rounded-[20px] border-[1.5px]",
        // ROUND-45: below md this is an overlay drawer, not a flex column.
        "max-md:fixed max-md:inset-y-3 max-md:left-3 max-md:z-50 max-md:shadow-2xl",
        mobileOpen ? "max-md:translate-x-0" : "max-md:-translate-x-[120%] max-md:pointer-events-none",
        "max-md:transition-transform max-md:duration-200",
      )}
      aria-label="Main sidebar"
      style={{
        backgroundColor: styles.sidebarBg,
        borderColor: styles.sidebarBorder,
      }}
    >
      {/* HEADER — logo (top-left) + collapse button (top-right, beside it).
          ROUND-34: in settings mode the header gains a back affordance and a
          "Settings" title beside the logo (owner design frame 1a). */}
      <div className={cn("shrink-0 flex items-center gap-2 px-3 pt-3", collapsed && "flex-col gap-2.5 px-0")}>
        <AcuteLogo
          size={collapsed ? 36 : 32}
          hoverToggle
          onClick={onLogoClick}
          ariaLabel={isSettingsRoute ? "Acute — back to dashboard" : isChatRoute ? "Acute — hide sidebar" : collapsed ? "Acute — expand sidebar" : "Acute — collapse sidebar"}
          title={isSettingsRoute ? "Back to dashboard" : isChatRoute ? "Hide sidebar" : collapsed ? "Expand sidebar" : "Collapse sidebar"}
        />
        {!collapsed && isSettingsRoute && (
          <>
            <button
              onClick={() => navigate("/")}
              aria-label="Back to dashboard"
              title="Back to dashboard"
              className="w-7 h-7 shrink-0 rounded-[9px] grid place-items-center transition-colors"
              style={{ color: styles.textTertiary }}
              onMouseEnter={(e) => (e.currentTarget.style.background = styles.sidebarHover)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <ArrowLeft size={14} />
            </button>
            <span className="text-[13px] font-black tracking-tight truncate" style={{ color: styles.text }}>
              Settings
            </span>
          </>
        )}
        {!collapsed && !isSettingsRoute && (
          <span className="flex-1" />
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="w-8 h-8 shrink-0 rounded-[10px] grid place-items-center transition-colors"
          style={{ color: styles.textTertiary }}
          onMouseEnter={(e) => (e.currentTarget.style.background = styles.sidebarHover)}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          {collapsed ? <ChevronsRight size={14} /> : <ChevronsLeft size={14} />}
        </button>
      </div>

      {isSettingsRoute ? (
        /* ── SETTINGS MODE (owner design frame 1a): the sidebar's whole body
           becomes the settings section list. ─────────────────────────────── */
        <nav className={cn("flex-1 flex flex-col gap-1 px-2.5 pt-5 overflow-y-auto", collapsed && "px-1.5")} aria-label="Settings sections">
          {SETTINGS_SECTIONS.map(({ id, label, icon: Icon }) => {
            const active = activeTab === id;
            return (
              <button
                key={id}
                onClick={() => navigate(`/settings?tab=${id}`)}
                aria-current={active ? "true" : undefined}
                title={collapsed ? label : undefined}
                className={cn(
                  "relative h-11 flex items-center rounded-[12px] transition-all duration-200 text-[13px] font-bold",
                  collapsed ? "justify-center w-full" : "gap-2.5 px-2.5",
                )}
                style={{
                  background: active ? withAlpha(styles.accent, 0.12) : "transparent",
                  color: active ? styles.text : styles.textSecondary,
                }}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.background = styles.sidebarHover;
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.background = "transparent";
                }}
              >
                {/* Active indicator bar — same language as session rows. */}
                {active && (
                  <span
                    className="absolute left-0 top-1.5 bottom-1.5 w-[2.5px] rounded-full"
                    style={{ background: styles.accent }}
                    aria-hidden
                  />
                )}
                <span
                  className="w-7 h-7 shrink-0 rounded-[9px] grid place-items-center"
                  style={{
                    background: active ? withAlpha(styles.accent, 0.14) : styles.inputBg,
                    color: active ? styles.accent : styles.textSecondary,
                  }}
                >
                  <Icon size={14} />
                </span>
                {!collapsed && <span className="truncate">{label}</span>}
              </button>
            );
          })}
          {/* The dashed "more coming" slot (owner design: future sections). */}
          {!collapsed && (
            <div
              className="mt-1 h-10 flex items-center justify-center rounded-[12px] border-[1.5px] border-dashed text-[11px] font-bold"
              style={{ borderColor: styles.sidebarBorder, color: styles.textTertiary }}
            >
              More settings coming soon
            </div>
          )}
        </nav>
      ) : (
        <>
          {/* NAVIGATION SECTION — dedicated section for Dashboard + Usage.
              ROUND-42: same heading language as the refreshed Projects
              header (heavier weight, wider tracking). */}
          {!collapsed && (
            <div className="shrink-0 flex items-center px-4 pt-5 pb-1.5">
              <span
                className="text-[10.5px] font-black uppercase tracking-[0.14em]"
                style={{ color: styles.textTertiary }}
              >
                Navigation
              </span>
            </div>
          )}
          <nav
            className={cn("flex flex-col gap-1 px-2.5 pb-3", collapsed ? "px-1.5 pt-4" : "pt-1")}
            aria-label="Main navigation"
            // ROUND-45: any nav interaction closes the mobile drawer — even a
            // same-route click (the useLocation effect only fires on change).
            onClickCapture={() => setMobileOpen(false)}
          >
            <DashboardButton collapsed={collapsed} />
            <UsageButton collapsed={collapsed} />
          </nav>

          {/* Divider — generous spacing around it (owner round-33). */}
          <div className="shrink-0 mx-3 my-4 border-t-[1.5px]" style={{ borderColor: styles.sidebarBorder }} />

          {/* PROJECTS SECTION — expandable tree */}
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <ProjectSection collapsed={collapsed} />
          </div>

          {/* FOOTER — a PROMINENT Settings button (owner round-33) + the
              ROUND-40 NotificationBell (bell icon + unread badge + dropdown).
              The bell mounts beside Settings as the closest analog to
              "header actions" in this app's chrome. */}
          <div
            className={cn("shrink-0 border-t px-2.5 pb-3 pt-2.5", collapsed && "px-1.5")}
            style={{ borderColor: styles.sidebarBorder }}
          >
            {/* ROUND-40: small icon row above the prominent Settings
                button — collapsed = centered bell icon tile; expanded =
                bell icon aligned to the right (matches the existing
                footer's right-aligned language). */}
            <div className={cn("flex items-center mb-1.5", collapsed ? "justify-center" : "justify-end")}>
              <NotificationBell collapsed={collapsed} />
            </div>
            <SettingsButton collapsed={collapsed} />
          </div>
        </>
      )}
    </motion.aside>
    </>
  );
}

function NavButton({
  icon: Icon, label, active, collapsed, onClick,
}: {
  icon: typeof LayoutDashboard; label: string; active: boolean; collapsed: boolean; onClick: () => void;
}) {
  const styles = useThemeStyles();
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      title={collapsed ? label : undefined}
      className={cn(
        "h-10 flex items-center rounded-[12px] transition-all duration-200 text-[13px] font-bold",
        collapsed ? "justify-center w-full" : "px-3 gap-2.5",
      )}
      style={{
        background: active ? styles.accent : "transparent",
        color: active ? styles.accentText : styles.textSecondary,
        boxShadow: active ? `0 2px 8px ${withAlpha(styles.accent, 0.3)}` : "none",
      }}
      onMouseEnter={(e) => {
        if (!active) { e.currentTarget.style.background = styles.sidebarHover; e.currentTarget.style.color = styles.text; }
      }}
      onMouseLeave={(e) => {
        if (!active) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = styles.textSecondary; }
      }}
    >
      <Icon size={16} strokeWidth={2} className="shrink-0" />
      {!collapsed && <span>{label}</span>}
    </button>
  );
}

function DashboardButton({ collapsed }: { collapsed: boolean }) {
  const navigate = useNavigate();
  const active = useLocation().pathname === "/";
  return <NavButton icon={LayoutDashboard} label="Dashboard" active={active} collapsed={collapsed} onClick={() => navigate("/")} />;
}

function UsageButton({ collapsed }: { collapsed: boolean }) {
  const navigate = useNavigate();
  const active = useLocation().pathname.startsWith("/usage");
  return <NavButton icon={BarChart3} label="Usage" active={active} collapsed={collapsed} onClick={() => navigate("/usage")} />;
}

/** ROUND-45: the session manager (search/fork two-pane screen) nav entry was
 * REMOVED in ROUND-48 (owner: "remove the sessions section completely as it
 * is not needed") — the /sessions route + SessionsScreen stay for deep
 * links, but the sidebar no longer lists them. */

/** Prominent Settings button (owner round-33): a card-style row — icon tile
 * in an accent-tinted square + bold label — visually distinct from the plain
 * nav rows above the divider. Collapsed = a large gear icon tile. */
function SettingsButton({ collapsed }: { collapsed: boolean }) {
  const styles = useThemeStyles();
  const navigate = useNavigate();
  const active = useLocation().pathname.startsWith("/settings");
  const [hovered, setHovered] = useState(false);
  if (collapsed) {
    return (
      <button
        onClick={() => navigate("/settings")}
        aria-label="Settings"
        title="Settings"
        className="w-9 h-9 mx-auto rounded-[12px] grid place-items-center transition-all hover:scale-105"
        style={{
          background: active ? styles.accent : withAlpha(styles.accent, hovered ? 0.16 : 0.1),
          color: active ? styles.accentText : styles.accent,
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <Settings size={16} />
      </button>
    );
  }
  return (
    <button
      onClick={() => navigate("/settings")}
      aria-current={active ? "page" : undefined}
      className="w-full h-11 flex items-center gap-2.5 px-2.5 rounded-[12px] border-[1.5px] transition-all hover:-translate-y-px"
      style={{
        background: active ? withAlpha(styles.accent, 0.12) : styles.card,
        borderColor: active ? withAlpha(styles.accent, 0.4) : styles.border,
        boxShadow: hovered ? styles.softShadow : "none",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span
        className="w-7 h-7 rounded-[9px] grid place-items-center shrink-0"
        style={{ background: withAlpha(styles.accent, 0.13), color: styles.accent }}
      >
        <Settings size={14} />
      </span>
      <span className="text-[13px] font-bold" style={{ color: styles.text }}>
        Settings
      </span>
    </button>
  );
}

/** Projects section — expandable tree with sessions under each project.
 * ROUND-42 (owner): refreshed visuals — section header with a count chip +
 * ghost Add button, gradient project tiles, a smoother expand animation, and
 * the pixel-stream activity animation on a project row whenever ANY of its
 * sessions is running (even when the project is collapsed — the owner: "the
 * animation should move on to the project itself so I can clearly know which
 * project is active"). */
function ProjectSection({ collapsed }: { collapsed: boolean }) {
  const styles = useThemeStyles();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const projectsQuery = useProjects();
  const sessionsQuery = useSessions();
  const projects = projectsQuery.data ?? [];
  const sessions = sessionsQuery.data ?? [];
  const [expandedProjects, setExpandedProjects] = useState<string[]>(readExpanded);
  const [showAddDialog, setShowAddDialog] = useState(false);

  // ROUND-42: the set of running session ids (SSE/stream-driven store) →
  // which PROJECTS currently have live work. Drives the animation on the
  // project row (collapsed or expanded) + the collapsed-rail tiles.
  const runningSessions = useActiveStreams((s) => s.active);
  const runningProjects = new Set(
    sessions.filter((s) => runningSessions.has(s.id)).map((s) => s.projectId),
  );

  const activeProjectMatch = pathname.match(/^\/project\/([^/]+)/);
  const activeProjectId = activeProjectMatch?.[1] ?? null;
  // ROUND-30: the ?session= param is the authoritative selection (the chat
  // panel binds to it too) — highlight the matching session row.
  const activeSessionId = new URLSearchParams(search).get("session");

  // Auto-expand the active project
  useEffect(() => {
    if (activeProjectId && !expandedProjects.includes(activeProjectId)) {
      setExpandedProjects((prev) => [...prev, activeProjectId]);
    }
  }, [activeProjectId]);

  useEffect(() => {
    try { localStorage.setItem(EXPANDED_KEY, JSON.stringify(expandedProjects)); } catch { /* */ }
  }, [expandedProjects]);

  const toggleProject = (projectId: string) => {
    setExpandedProjects((prev) =>
      prev.includes(projectId) ? prev.filter((id) => id !== projectId) : [...prev, projectId],
    );
  };

  const projectSessions = (projectId: string) =>
    sessions.filter((s) => s.projectId === projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  // ROUND-33: session creation happens from the project row's + button (and
  // still from the bottom row). Uses the query hook so the list UPDATES
  // INSTANTLY (owner: "I have to refresh the whole page" — the old raw-fetch
  // button never invalidated the sessions query).
  const createSession = useCreateSession();
  const createSessionFor = async (projectId: string, projectName: string) => {
    const agentId = agentsForNewSessions();
    if (!agentId) return;
    try {
      const created = await createSession.mutateAsync({
        mode: "single" as const,
        agentId,
        projectId,
        title: `New chat · ${projectName}`,
      });
      navigate(`/project/${projectId}/chat?session=${created.id}`);
    } catch {
      /* surfaced by the mutation state; keep the sidebar stable */
    }
  };
  const agentsQueryForSessions = useAgents(false);
  const agentsForNewSessions = () => (agentsQueryForSessions.data ?? [])[0]?.id ?? null;

  if (collapsed) {
    return (
      // ROUND-48 (R48-a): the collapsed rail now SCROLLS (overflow-y-auto +
      // min-h-0 inside the min-h-0 wrapper) and has top padding — the old
      // container clipped the first tile and cut long project lists off at
      // the bottom. Selection is an INSET ring on the tile itself (see
      // ProjectTile) so the active tile stays exactly 36px like its siblings
      // (the old outside outline + 2px offset made it look bigger and got
      // clipped by the overflow-hidden wrapper).
      <div
        className="flex flex-col items-center gap-1.5 px-1.5 pt-2 pb-2 min-h-0 overflow-y-auto"
        style={{ scrollbarWidth: "thin" }}
        data-testid="collapsed-project-rail"
      >
        {projects.map((project) => {
          const isActive = activeProjectId === project.id;
          const isRunning = runningProjects.has(project.id);
          return (
            <button
              key={project.id}
              onClick={() => navigate(`/project/${project.id}/chat`)}
              title={isRunning ? `${project.name} — working…` : project.name}
              aria-label={isRunning ? `Open ${project.name} (working)` : `Open ${project.name}`}
              aria-current={isActive ? "true" : undefined}
              data-active={isActive ? "true" : "false"}
              className="relative w-9 h-9 grid place-items-center transition-transform hover:scale-105 active:scale-95"
              style={{ borderRadius: 12 }}
            >
              <ProjectTile
                color={project.color}
                name={project.name}
                size={36}
                radius={12}
                fontSize={14}
                selected={isActive}
              />
              {/* ROUND-42: live-work badge on the collapsed tile (owner:
                  "if the session of a project is going on and I collapse the
                  project, the animation should move on to the project
                  itself") — a pulsing accent dot pinned to the tile's
                  bottom-right. R48-a: the rail's px-1.5/pt-2/pb-2 padding
                  keeps the half-outset dot inside the scroll box, so it never
                  clips. */}
              {isRunning ? (
                <span
                  className="absolute -bottom-0.5 -right-0.5 w-[11px] h-[11px] rounded-full animate-pulse"
                  style={{
                    background: styles.accent,
                    boxShadow: `0 0 0 2px ${styles.sidebarBg}, 0 0 6px ${withAlpha(styles.accent, 0.8)}`,
                  }}
                  role="status"
                  aria-label="Project has a session working"
                />
              ) : null}
            </button>
          );
        })}
        <button
          onClick={() => setShowAddDialog(true)}
          aria-label="Add project"
          className="w-9 h-9 rounded-[12px] grid place-items-center border-[1.5px] border-dashed transition-transform hover:scale-105"
          style={{ borderColor: styles.border, color: styles.textTertiary }}
        >
          <Plus size={14} strokeWidth={2.5} />
        </button>
        {showAddDialog && (
          <AddProjectDialog onCreated={(id) => navigate(`/project/${id}/chat`)} onClose={() => setShowAddDialog(false)} />
        )}
      </div>
    );
  }

  return (
    <>
      {/* ROUND-42: refreshed section header — bold uppercase label + a mono
          count chip + a ghost icon Add button (owner: "the project headings
          do not look proper… make them modern, cleaner, smoother"). */}
      <div className="flex items-center justify-between px-4 pb-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="text-[10.5px] font-black uppercase tracking-[0.14em]"
            style={{ color: styles.textTertiary }}
          >
            Projects
          </span>
          {projects.length > 0 ? (
            <span
              className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-full tabular-nums"
              style={{ color: styles.textTertiary, background: styles.subtle }}
            >
              {projects.length}
            </span>
          ) : null}
        </div>
        <button
          onClick={() => setShowAddDialog(true)}
          title="Add project"
          aria-label="Add project"
          className="w-6 h-6 grid place-items-center rounded-[8px] transition-all hover:scale-110 active:scale-95"
          style={{ color: styles.accent, background: withAlpha(styles.accent, 0.1) }}
        >
          <Plus size={13} strokeWidth={2.5} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 pb-2 space-y-0.5" style={{ scrollbarWidth: "thin" }}>
        {projects.map((project) => {
          const isExpanded = expandedProjects.includes(project.id);
          const isActive = activeProjectId === project.id;
          const projSessions = projectSessions(project.id);

          return (
            <div key={project.id}>
              {/* Project row — click toggles sessions; the + button starts a
                  new session directly (owner round-33). ROUND-42: gradient
                  tile + the running animation lives HERE when collapsed. */}
              <ProjectRow
                project={project}
                active={isActive}
                expanded={isExpanded}
                running={runningProjects.has(project.id)}
                onToggle={() => toggleProject(project.id)}
                onNewSession={() => void createSessionFor(project.id, project.name)}
              />
              {/* Sessions underneath */}
              <AnimatePresence initial={false}>
                {isExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
                    className="overflow-hidden"
                  >
                    {/* ROUND-43: the tree rail is softened to a hairline so the
                        bordered session rows (below) carry the depth. */}
                    <div className="ml-[19px] pl-2.5 border-l space-y-1 py-1" style={{ borderColor: withAlpha(styles.textTertiary, 0.14) }}>
                      {projSessions.slice(0, 8).map((session) => (
                        <SessionRow
                          key={session.id}
                          session={session}
                          projectId={project.id}
                          active={session.id === activeSessionId}
                        />
                      ))}
                      {projSessions.length > 8 && (
                        <span className="block px-2 py-1 text-[10px]" style={{ color: styles.textTertiary }}>
                          +{projSessions.length - 8} more
                        </span>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}

        {projects.length === 0 && (
          <button
            onClick={() => setShowAddDialog(true)}
            className="h-10 w-full flex items-center justify-center gap-2 rounded-[14px] border-[1.5px] border-dashed text-[12px] font-bold transition-all hover:-translate-y-px"
            style={{ borderColor: styles.border, background: "transparent", color: styles.textTertiary }}
          >
            <Plus size={13} strokeWidth={2.5} />
            <span>Add your first project</span>
          </button>
        )}
      </div>

      {showAddDialog && (
        <AddProjectDialog onCreated={(id) => navigate(`/project/${id}/chat`)} onClose={() => setShowAddDialog(false)} />
      )}
    </>
  );
}

function ProjectRow({
  project, active, expanded, running, onToggle, onNewSession,
}: {
  project: Project;
  active: boolean;
  expanded: boolean;
  /** ROUND-42: any session of this project has a turn in flight — the
   * activity animation moves onto the project row itself (owner: "if the
   * session is going on and I collapse the project, the animation should
   * move on to the project itself"). */
  running: boolean;
  onToggle: () => void;
  onNewSession: () => void;
}) {
  const styles = useThemeStyles();
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="group relative h-11 flex items-center gap-2.5 rounded-[12px] px-2 cursor-pointer transition-all duration-200"
      style={{
        // ROUND-48 (R48-a): the active highlight follows the PROJECT'S OWN
        // color (withAlpha tint), not the theme accent — with per-project
        // palette colors the whole row now reads as belonging to that
        // project (owner: "projects should be given different colors").
        border: active ? `1.5px solid ${withAlpha(project.color, 0.4)}` : "1.5px solid transparent",
        background: active
          ? withAlpha(project.color, 0.1)
          : hovered
            ? styles.sidebarHover
            : "transparent",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onToggle}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onToggle(); }}
      aria-expanded={expanded}
      aria-label={`Project ${project.name} — click to ${expanded ? "collapse" : "expand"} sessions${running ? " (working)" : ""}`}
    >
      {/* ROUND-42: gradient tile (owner: "the project's actual images need
          to be a bit better"). */}
      <ProjectTile color={project.color} name={project.name} size={32} radius={10} fontSize={13} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className="text-[12px] font-bold truncate"
          style={{ color: active ? styles.text : styles.textSecondary }}
        >
          {project.name}
        </span>
      </div>
      {/* ROUND-42: live-work animation on the project row — the clear "this
          project is making changes right now" signal when the sessions are
          collapsed (or while scanning the list). */}
      {running ? (
        <span
          className="shrink-0 mr-0.5 ac-pixel-stream"
          style={{ color: styles.accent }}
          role="status"
          title="A session in this project is working…"
          aria-label="A session in this project is working"
        >
          <span /><span /><span /><span />
        </span>
      ) : null}
      {/* ROUND-33 (owner): the "+ new session" button lives ON the project row
          itself; no chevron, no session count. */}
      <button
        onClick={(e) => { e.stopPropagation(); onNewSession(); }}
        aria-label={`Start new session in ${project.name}`}
        title="New session"
        className="relative z-20 w-6 h-6 grid place-items-center rounded-md transition-all hover:scale-110"
        style={{
          color: styles.accent,
          opacity: hovered ? 1 : 0,
          background: hovered ? withAlpha(styles.accent, 0.1) : "transparent",
        }}
      >
        <Plus size={13} strokeWidth={2.5} />
      </button>
      <DeleteProjectButton projectId={project.id} projectName={project.name} visible={hovered} />
    </div>
  );
}

/** The visual state of a session row — drives the border tint, the leading
 * icon and the test attributes (ROUND-43). */
export type SessionRowState = "running" | "failed" | "idle";

export function deriveSessionRowState(session: Session, running: boolean): SessionRowState {
  if (running || session.status === "running") return "running";
  if (session.status === "failed" || session.status === "cancelled") return "failed";
  return "idle";
}

/**
 * ROUND-33 SessionRow · ROUND-43 depth pass (owner: “each individual session
 * could be given a dedicated border around it… the icons could be improved
 * and handled better”). Every row is now its own bordered card — hairline
 * neutral border at rest, stronger on hover, accent-tinted when ACTIVE —
 * with a 1-level shadow + inset highlight matching the R42 ProjectTile
 * gradient language. The leading icon is STATE-AWARE: spinner while a turn
 * is in flight, chat bubble at rest, alert glyph on failed/cancelled
 * sessions. The R38 pixel-stream on the right is preserved and composes
 * with the running icon (rail-side flourish + at-a-glance state).
 * ACTIVE session (matching the ?session= URL param) keeps the accent fill,
 * bold text + 2.5px indicator bar. Hover reveals RENAME (round-33) and
 * DELETE (round-30). Rename switches to an inline input (Enter · Escape).
 */
function SessionRow({
  session,
  projectId,
  active,
}: {
  session: Session;
  projectId: string;
  active: boolean;
}) {
  const styles = useThemeStyles();
  const navigate = useNavigate();
  const location = useLocation();
  const deleteSession = useDeleteSession();
  const renameSession = useRenameSession();
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title ?? "");
  // ROUND-38: pixelated activity indicator on the right when this session
  // has a turn in flight (owner directive).
  const streaming = useActiveStreams((s) => s.active.has(session.id));
  // ROUND-43: coherent row state (icon + tint + test attributes).
  const state = deriveSessionRowState(session, streaming);
  const running = state === "running";

  const remove = () => {
    deleteSession.mutate(session.id, {
      onSuccess: () => {
        if (location.search.includes(session.id)) {
          navigate(`/project/${projectId}/chat`, { replace: true });
        }
      },
    });
  };

  const commitRename = () => {
    const next = draft.trim();
    setEditing(false);
    if (next !== (session.title ?? "")) {
      renameSession.mutate({ id: session.id, title: next });
    }
  };

  // Inline rename input state.
  if (editing) {
    return (
      <div className="flex items-center gap-1.5 px-1 py-0.5">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setEditing(false);
          }}
          onBlur={commitRename}
          aria-label="Rename session"
          className="flex-1 min-w-0 h-6 px-2 rounded-[6px] border-[1.5px] text-[11px] outline-none"
          style={{
            background: styles.card,
            borderColor: withAlpha(styles.accent, 0.5),
            color: styles.text,
          }}
        />
        <button
          onClick={() => setEditing(false)}
          aria-label="Cancel rename"
          className="w-5 h-5 grid place-items-center rounded-md shrink-0"
          style={{ color: styles.textTertiary }}
        >
          <X size={10} />
        </button>
      </div>
    );
  }

  // ROUND-43: the dedicated border — neutral hairline at rest, stronger on
  // hover, accent-tinted on the active row; a failed session leans red so
  // the problem row is findable at a glance.
  const borderColor = active
    ? withAlpha(styles.accent, 0.45)
    : state === "failed"
      ? withAlpha(SEMANTIC_COLORS.danger, hovered ? 0.5 : 0.35)
      : hovered
        ? styles.border
        : styles.borderSubtle;
  // Depth consistent with the R42 ProjectTile treatment: a 1-level shadow +
  // a soft inset top highlight (instead of heavier borders).
  const rowShadow = active
    ? styles.isDark
      ? `inset 0 1px 0 rgba(255,255,255,0.06), 0 1px 4px ${withAlpha(styles.accent, 0.25)}`
      : `inset 0 1px 0 rgba(255,255,255,0.8), 0 1px 4px ${withAlpha(styles.accent, 0.18)}`
    : styles.isDark
      ? "inset 0 1px 0 rgba(255,255,255,0.04), 0 1px 2px rgba(0,0,0,0.22)"
      : "inset 0 1px 0 rgba(255,255,255,0.65), 0 1px 2px rgba(0,0,0,0.05)";

  return (
    <div
      data-session-row
      data-state={state}
      data-active={active ? "true" : "false"}
      className="group relative flex items-center gap-0.5 rounded-[9px] pl-0.5 pr-1 py-[3px] transition-all duration-150"
      style={{
        border: `1px solid ${borderColor}`,
        background: active
          ? withAlpha(styles.accent, 0.1)
          : state === "failed"
            ? hovered
              ? withAlpha(SEMANTIC_COLORS.danger, 0.08)
              : withAlpha(SEMANTIC_COLORS.danger, 0.05)
            : hovered
              ? styles.sidebarHover
              : styles.subtle,
        boxShadow: rowShadow,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Active indicator bar — the clear "currently selected" signal,
          sitting just inside the row's border. */}
      <span
        className="absolute left-[3px] top-1 bottom-1 w-[2.5px] rounded-full transition-opacity"
        style={{ background: styles.accent, opacity: active ? 1 : 0 }}
        aria-hidden
      />
      <button
        onClick={() => navigate(`/project/${projectId}/chat?session=${session.id}`)}
        aria-current={active ? "true" : undefined}
        className="flex-1 min-w-0 h-[26px] flex items-center gap-2 px-2 text-[11px] truncate"
        style={{
          color: active ? styles.text : hovered ? styles.textSecondary : styles.textTertiary,
          fontWeight: active ? 700 : 500,
        }}
        title={session.title ?? "Untitled"}
      >
        {/* ROUND-43 state-aware icon: running → spinner, failed → alert,
            idle → chat bubble. */}
        {state === "running" ? (
          <LoaderCircle
            size={11}
            className="shrink-0 animate-spin"
            style={{ color: styles.accent }}
            aria-label="Session is working"
          />
        ) : state === "failed" ? (
          <CircleAlert
            size={11}
            className="shrink-0"
            style={{ color: SEMANTIC_COLORS.danger }}
            aria-label="Session failed"
          />
        ) : (
          <MessageSquare
            size={10}
            className="shrink-0"
            style={{ color: active ? styles.accent : styles.textTertiary }}
          />
        )}
        <span className="truncate">{session.title ?? "Untitled"}</span>
      </button>
      {/* Rename (round-33) — ROUND-42: smooth opacity transition. */}
      <button
        onClick={(e) => { e.stopPropagation(); setDraft(session.title ?? ""); setEditing(true); }}
        aria-label={`Rename session ${session.title ?? "Untitled"}`}
        title="Rename session"
        className="relative z-10 w-5 h-5 grid place-items-center rounded-md transition-opacity duration-150 hover:bg-black/10"
        style={{ color: styles.textTertiary, opacity: hovered ? 1 : 0 }}
      >
        <Pencil size={10} />
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); remove(); }}
        disabled={deleteSession.isPending}
        aria-label={`Delete session ${session.title ?? "Untitled"}`}
        title="Delete session"
        className="relative z-10 w-5 h-5 grid place-items-center rounded-md transition-opacity duration-150 hover:bg-black/10"
        style={{ color: styles.textTertiary, opacity: hovered ? 1 : 0 }}
      >
        <Trash2 size={10} />
      </button>
      {/* ROUND-38 (owner: "the currently running session will have some
          animation to it, like a pixelated kind of animation playing along
          on the right side"). Shown only while a turn is in flight —
          composes with the ROUND-43 running icon on the left. */}
      {running ? (
        <span
          className="shrink-0 ac-pixel-stream"
          style={{ color: styles.accent }}
          aria-label="Session is working"
          role="status"
          title="Working…"
        >
          <span /><span /><span /><span />
        </span>
      ) : null}
    </div>
  );
}

function DeleteProjectButton({
  projectId, projectName, visible,
}: {
  projectId: string; projectName: string; visible: boolean;
}) {
  const styles = useThemeStyles();
  const { remove } = useDeleteProjectSimple();
  return (
    <button
      onClick={(e) => { e.stopPropagation(); remove(projectId); }}
      aria-label={`Delete ${projectName}`}
      title={`Delete ${projectName}`}
      className="relative z-20 w-6 h-6 grid place-items-center rounded-md transition-opacity"
      style={{ color: styles.textTertiary, opacity: visible ? 1 : 0 }}
    >
      <Trash2 size={11} />
    </button>
  );
}

function useDeleteProjectSimple() {
  const deleteProject = useDeleteProject();
  const remove = useCallback(
    (id: string) => deleteProject.mutate(id),
    [deleteProject],
  );
  return { remove };
}



// ─── Add Project Dialog ──────────────────────────────────────────────────────

function AddProjectDialog({
  onCreated, onClose,
}: {
  onCreated: (projectId: string) => void; onClose: () => void;
}) {
  const styles = useThemeStyles();
  const [rootPath, setRootPath] = useState("");
  const [picking, setPicking] = useState(false);
  const [pickHint, setPickHint] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  
  const pathRef = useRef<HTMLInputElement>(null);
  const demoData = useConfigStore((s) => s.demoData);

  useEffect(() => {
    const timer = setTimeout(() => pathRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, []);

  const handleBrowse = useCallback(async () => {
    setPicking(true); setPickHint(null);
    try {
      if (isTauri()) {
        const folder = await tauriInvoke<string | null>("pick_folder");
        if (typeof folder === "string" && folder) setRootPath(folder);
        return;
      }
      const picked = await pickFolderViaBackend();
      if (picked.path) setRootPath(picked.path);
      else if (picked.unavailable) setPickHint("No folder dialog — paste the path.");
      else if (picked.error) setPickHint(`Dialog failed: ${picked.error}`);
    } catch (cause) {
      setPickHint(`Dialog failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally { setPicking(false); }
  }, []);

  const createProject = useCreateProject();

  const submit = useCallback(() => {
    if (rootPath.trim().length === 0 || createProject.isPending) return;
    setFormError(null);
    // ROUND-33 (owner): the project name IS the folder's name — no manual
    // name picking. Derive from the path's basename (Windows + POSIX safe).
    const sep = /[/\\]/;
    const folderName = rootPath.trim().split(sep).filter(Boolean).pop() ?? "project";
    createProject.mutate(
      { name: folderName, rootPath: rootPath.trim() },
      {
        onSuccess: (project) => {
          onClose();
          onCreated(project.id);
        },
        onError: (error) => {
          setFormError(
            error instanceof ApiError
              ? error.message
              : error instanceof Error
                ? error.message
                : "Failed to create the project.",
          );
        },
      },
    );
  }, [rootPath, createProject, onClose, onCreated]);

  const is = { background: styles.inputBg, borderColor: styles.inputBorder, color: styles.text } as const;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center" style={{ background: "rgba(0,0,0,0.55)" }} onClick={onClose}>
      <div
        className="w-[min(440px,90vw)] rounded-[24px] border-[1.5px] p-5"
        style={{ background: styles.card, borderColor: styles.borderStrong, boxShadow: styles.bentoShadow }}
        onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label="Add a new project"
      >
        <h3 className="text-[15px] font-black tracking-tight mb-4" style={{ color: styles.text }}>Add New Project</h3>
        <div className="flex flex-col gap-3.5">
          <div>
            <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-widest" style={{ color: styles.textTertiary }}>Project Folder</label>
            <div className="flex gap-2">
              <input ref={pathRef} value={rootPath} onChange={(e) => setRootPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void submit()}
                placeholder="C:\projects\my-app  —  the project takes the folder's name"
                className="h-12 min-w-0 flex-1 rounded-[14px] border-[1.5px] px-4 font-mono text-[12px] outline-none"
                style={is} />
              {isTauri() || !demoData ? (
                <button onClick={() => void handleBrowse()} disabled={picking}
                  className="h-12 shrink-0 flex items-center gap-1.5 rounded-[14px] border-[1.5px] px-3.5 text-[12px] font-bold disabled:opacity-60"
                  style={{ background: styles.subtle, borderColor: styles.border, color: styles.textSecondary }}>
                  <FolderOpen size={13} /> Browse
                </button>
              ) : null}
            </div>
            {pickHint && <p className="mt-1.5 text-[11px]" style={{ color: styles.textTertiary }}>{pickHint}</p>}
          </div>
          {formError && (
            <p role="alert" className="rounded-[12px] border px-3 py-2 text-[12px]"
              style={{ borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.3), background: withAlpha(SEMANTIC_COLORS.danger, 0.08), color: SEMANTIC_COLORS.danger }}>
              {formError}
            </p>
          )}
          <button onClick={() => void submit()}
            disabled={rootPath.trim().length === 0 || createProject.isPending}
            className="h-12 w-full rounded-full font-black text-[14px] tracking-[-0.01em] transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100"
            style={{ background: styles.accent, color: styles.accentText, border: `1.5px solid ${styles.accent}`, boxShadow: `0 4px 16px ${withAlpha(styles.accent, 0.25)}` }}>
            {createProject.isPending ? "Creating…" : "Create Project"}
          </button>
        </div>
      </div>
    </div>
  );
}
