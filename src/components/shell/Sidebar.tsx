import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  ArrowLeft,
  BarChart3,
  Bot,
  ChevronsLeft,
  ChevronsRight,
  FolderOpen,
  LayoutDashboard,
  MessageSquare,
  Palette,
  Pencil,
  Plus,
  Server,
  Settings,
  SlidersHorizontal,
  Trash2,
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
import { withAlpha } from "../dashboard/helpers";

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

/**
 * AcuteLogo (round-33): the custom app mark — a rounded-square accent tile
 * with a geometric white "A" (two strokes: the peak + the crossbar). Doubles
 * as the sidebar toggle: hover morphs the "A" into a panel-left icon
 * (cross-fade), click toggles. Used in the sidebar header AND as the
 * floating show-sidebar button when the rail is hidden.
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
  const stroke = Math.max(2, Math.round(size / 13));
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
        background: "#FF6B2C",
        boxShadow: "0 2px 10px rgba(255,107,44,0.35)",
      }}
    >
      {/* The geometric "A" — fades out on hover when hoverToggle */}
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
          d="M10 22.5 L16 9.5 L22 22.5"
          stroke="#FFFFFF"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M12.7 18 H19.3"
          stroke="#FFFFFF"
          strokeWidth={stroke}
          strokeLinecap="round"
        />
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
  { id: "advanced", label: "Advanced", icon: SlidersHorizontal },
] as const;

export function Sidebar() {
  const styles = useThemeStyles();
  const [collapsed, setCollapsed] = useState(readCollapsed);
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
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 64 : 270 }}
      transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
      className="shrink-0 flex flex-col overflow-hidden rounded-[20px] border-[1.5px]"
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
          {/* NAVIGATION SECTION — dedicated section for Dashboard + Usage. */}
          {!collapsed && (
            <div className="shrink-0 flex items-center px-4 pt-5 pb-1.5">
              <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: styles.textTertiary }}>
                Navigation
              </span>
            </div>
          )}
          <nav className={cn("flex flex-col gap-1 px-2.5 pb-3", collapsed ? "px-1.5 pt-4" : "pt-1")} aria-label="Main navigation">
            <DashboardButton collapsed={collapsed} />
            <UsageButton collapsed={collapsed} />
          </nav>

          {/* Divider — generous spacing around it (owner round-33). */}
          <div className="shrink-0 mx-3 my-4 border-t-[1.5px]" style={{ borderColor: styles.sidebarBorder }} />

          {/* PROJECTS SECTION — expandable tree */}
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <ProjectSection collapsed={collapsed} />
          </div>

          {/* FOOTER — a PROMINENT Settings button (owner round-33). */}
          <div
            className={cn("shrink-0 border-t px-2.5 pb-3 pt-2.5", collapsed && "px-1.5")}
            style={{ borderColor: styles.sidebarBorder }}
          >
            <SettingsButton collapsed={collapsed} />
          </div>
        </>
      )}
    </motion.aside>
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

/** Projects section — expandable tree with sessions under each project. */
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
      <div className="flex flex-col items-center gap-1.5 px-1.5 pb-2">
        {projects.map((project) => (
          <button
            key={project.id}
            onClick={() => navigate(`/project/${project.id}/chat`)}
            title={project.name}
            aria-label={`Open ${project.name}`}
            className="w-9 h-9 rounded-[10px] grid place-items-center font-black text-[12px] transition-transform hover:scale-105"
            style={{
              background: project.color,
              color: "#fff",
              outline: activeProjectId === project.id ? `2px solid ${styles.accent}` : "none",
              outlineOffset: 2,
            }}
          >
            {project.name.charAt(0).toUpperCase()}
          </button>
        ))}
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
      <div className="flex items-center justify-between px-4 pb-2">
        <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: styles.textTertiary }}>
          Projects
        </span>
        <button
          onClick={() => setShowAddDialog(true)}
          title="Add project"
          className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold transition-transform hover:scale-[1.03] active:scale-95"
          style={{ background: styles.accent, color: styles.accentText }}
        >
          <Plus size={10} strokeWidth={3} /> Add
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
                  new session directly (owner round-33). */}
              <ProjectRow
                project={project}
                active={isActive}
                expanded={isExpanded}
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
                    transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
                    className="overflow-hidden"
                  >
                    <div className="ml-5 pl-3 border-l-[1.5px] space-y-0.5 py-1" style={{ borderColor: styles.sidebarBorder }}>
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
  project, active, expanded, onToggle, onNewSession,
}: {
  project: Project; active: boolean; expanded: boolean; onToggle: () => void; onNewSession: () => void;
}) {
  const styles = useThemeStyles();
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="group relative h-11 flex items-center gap-2.5 rounded-[12px] px-2 cursor-pointer transition-all duration-200"
      style={{
        border: active ? `1.5px solid ${withAlpha(styles.accent, 0.4)}` : "1.5px solid transparent",
        background: active ? withAlpha(styles.accent, 0.1) : hovered ? styles.sidebarHover : "transparent",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onToggle}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onToggle(); }}
      aria-expanded={expanded}
      aria-label={`Project ${project.name} — click to ${expanded ? "collapse" : "expand"} sessions`}
    >
      <span
        className="w-8 h-8 shrink-0 rounded-[10px] grid place-items-center font-black text-[13px]"
        style={{ background: project.color, color: "#fff" }}
      >
        {project.name.charAt(0).toUpperCase()}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className="text-[12px] font-bold truncate"
          style={{ color: active ? styles.text : styles.textSecondary }}
        >
          {project.name}
        </span>
      </div>
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

/**
 * ROUND-33 SessionRow: one session under a project. ACTIVE session (matching
 * the ?session= URL param — same source of truth as the chat panel) gets the
 * accent-tinted fill + bold text + 2.5px indicator bar. Hover reveals the
 * RENAME (pencil, round-33) and DELETE (round-30) buttons. Rename switches
 * the row to an inline input (Enter saves · Escape cancels).
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

  return (
    <div
      className="group relative flex items-center rounded-[8px] transition-colors"
      style={{
        background: active ? withAlpha(styles.accent, 0.12) : hovered ? styles.sidebarHover : "transparent",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Active indicator bar — the clear "currently selected" signal. */}
      <span
        className="absolute left-0 top-1 bottom-1 w-[2.5px] rounded-full transition-opacity"
        style={{ background: styles.accent, opacity: active ? 1 : 0 }}
        aria-hidden
      />
      <button
        onClick={() => navigate(`/project/${projectId}/chat?session=${session.id}`)}
        aria-current={active ? "true" : undefined}
        className="flex-1 min-w-0 h-7 flex items-center gap-2 px-2.5 text-[11px] truncate"
        style={{
          color: active ? styles.text : hovered ? styles.textSecondary : styles.textTertiary,
          fontWeight: active ? 700 : 500,
        }}
        title={session.title ?? "Untitled"}
      >
        <MessageSquare
          size={10}
          className="shrink-0"
          style={{ color: active ? styles.accent : undefined }}
        />
        <span className="truncate">{session.title ?? "Untitled"}</span>
      </button>
      {/* Rename (round-33) */}
      <button
        onClick={(e) => { e.stopPropagation(); setDraft(session.title ?? ""); setEditing(true); }}
        aria-label={`Rename session ${session.title ?? "Untitled"}`}
        title="Rename session"
        className="relative z-10 w-5 h-5 grid place-items-center rounded-md transition-opacity"
        style={{ color: styles.textTertiary, opacity: hovered ? 1 : 0 }}
      >
        <Pencil size={10} />
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); remove(); }}
        disabled={deleteSession.isPending}
        aria-label={`Delete session ${session.title ?? "Untitled"}`}
        title="Delete session"
        className="relative z-10 w-5 h-5 mr-1 grid place-items-center rounded-md transition-opacity"
        style={{ color: styles.textTertiary, opacity: hovered ? 1 : 0 }}
      >
        <Trash2 size={10} />
      </button>
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
