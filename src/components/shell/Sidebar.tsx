import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  BarChart3,
  ChevronsLeft,
  ChevronsRight,
  FolderOpen,
  LayoutDashboard,
  Menu,
  MessageSquare,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { ApiError, pickFolderViaBackend, type Project, type Session } from "../../lib/api";
import { cn } from "../../lib/utils";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { isTauri } from "../../lib/sidecar";
import { useConfigStore } from "../../lib/config-store";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useProjects, useCreateProject, useDeleteProject } from "../../hooks/use-projects";
import { useDeleteSession, useSessions } from "../../hooks/use-sessions";
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
 * Sidebar (round-30 owner redesign):
 * - DISTINCT accent-tinted surface (styles.sidebarBg — derived per-theme from
 *   bg + accent, round-30) so the rail reads as its own element, separate
 *   from the main content area (owner: "give the sidebar a different kind of
 *   color and try to make it separate from the other elements")
 * - Hamburger toggle on the TOP-LEFT of the sidebar itself (shows/hides sidebar)
 * - NAV section (Dashboard/Usage) cleanly separated from PROJECTS section
 *   (round-30: Demos nav REMOVED — owner: "not needed at all")
 * - Projects are expandable: click → sessions list underneath
 * - Each session navigates to /project/:id/chat?session=<id> and the ACTIVE
 *   session is clearly highlighted (accent fill + left indicator bar)
 * - Session rows have hover delete (round-30: owner "not able to delete any
 *   of the sessions")
 * - Collapsed rail: icon tiles only
 */
export function Sidebar() {
  const styles = useThemeStyles();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const setAppSidebarVisible = useProjectChatStore((s) => s.setAppSidebarVisible);
  const appSidebarVisible = useProjectChatStore((s) => s.appSidebarVisible);
  const isChatRoute = /^\/project\/[^/]+\/chat\/?$/.test(useLocation().pathname);
  const showSidebar = !isChatRoute || appSidebarVisible;

  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch { /* */ }
  }, [collapsed]);

  if (!showSidebar) return null;

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
      {/* Top row: hamburger ONLY on chat routes (toggles sidebar visibility).
          No app name, no logo, no version pill at the top of the sidebar
          (owner R28 directive: "at the very top it should not show the app's
          name like that and the logo like that"). The product name lives in
          the document <title> and the Settings/About surfaces. */}
      {isChatRoute && (
        <div className={cn("shrink-0 flex items-center px-3 pt-4", collapsed && "justify-center px-2")}>
          <button
            onClick={() => setAppSidebarVisible(!appSidebarVisible)}
            aria-label={appSidebarVisible ? "Hide sidebar" : "Show sidebar"}
            title={appSidebarVisible ? "Hide sidebar" : "Show sidebar"}
            className="w-8 h-8 shrink-0 rounded-[10px] grid place-items-center transition-colors"
            style={{ background: styles.card, color: styles.textSecondary, border: `1.5px solid ${styles.border}` }}
          >
            <Menu size={14} />
          </button>
        </div>
      )}

      {/* NAVIGATION SECTION — dedicated section for Dashboard + Usage.
          Section header matches the PROJECTS header style for visual parity;
          hidden when collapsed (icons are self-explanatory). */}
      {!collapsed && (
        <div className="shrink-0 flex items-center px-4 pt-4 pb-1.5">
          <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: styles.textTertiary }}>
            Navigation
          </span>
        </div>
      )}
      <nav className={cn("flex flex-col gap-1 px-2.5 pb-3", collapsed ? "px-1.5 pt-4" : "pt-1")} aria-label="Main navigation">
        <DashboardButton collapsed={collapsed} />
        <UsageButton collapsed={collapsed} />
      </nav>

      {/* Divider */}
      <div className="shrink-0 mx-3 border-t-[1.5px]" style={{ borderColor: styles.sidebarBorder }} />

      {/* PROJECTS SECTION — expandable tree */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden pt-3">
        <ProjectSection collapsed={collapsed} />
      </div>

      {/* Bottom: Settings + collapse toggle */}
      <div
        className={cn("shrink-0 border-t px-2.5 pb-3 pt-2", collapsed && "px-1.5")}
        style={{ borderColor: styles.sidebarBorder }}
      >
        <SettingsButton collapsed={collapsed} />
        <button
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="w-full h-8 mt-1 flex items-center justify-center rounded-[10px] transition-colors"
          style={{ color: styles.textTertiary }}
          onMouseEnter={(e) => (e.currentTarget.style.background = styles.sidebarHover)}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          {collapsed ? <ChevronsRight size={14} /> : <ChevronsLeft size={14} />}
        </button>
      </div>
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

function SettingsButton({ collapsed }: { collapsed: boolean }) {
  const navigate = useNavigate();
  const active = useLocation().pathname.startsWith("/settings");
  return <NavButton icon={Settings} label="Settings" active={active} collapsed={collapsed} onClick={() => navigate("/settings")} />;
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
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold transition-colors"
          style={{ color: styles.accent }}
          onMouseEnter={(e) => (e.currentTarget.style.background = withAlpha(styles.accent, 0.1))}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <Plus size={10} /> Add
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 pb-2 space-y-0.5" style={{ scrollbarWidth: "thin" }}>
        {projects.map((project) => {
          const isExpanded = expandedProjects.includes(project.id);
          const isActive = activeProjectId === project.id;
          const projSessions = projectSessions(project.id);

          return (
            <div key={project.id}>
              {/* Project row */}
              <ProjectRow
                project={project}
                active={isActive}
                expanded={isExpanded}
                sessionCount={projSessions.length}
                onToggle={() => toggleProject(project.id)}
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
                      {/* New Session button — always at the bottom of each project's sessions */}
                      <NewSessionButton projectId={project.id} projectName={project.name} />
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
  project, active, expanded, sessionCount, onToggle,
}: {
  project: Project; active: boolean; expanded: boolean; sessionCount: number; onToggle: () => void;
}) {
  const styles = useThemeStyles();
  const [hovered, setHovered] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  return (
    <div
      className="group relative h-11 flex items-center gap-2.5 rounded-[12px] px-2 cursor-pointer transition-all duration-200"
      style={{
        border: active ? `1.5px solid ${withAlpha(styles.accent, 0.4)}` : "1.5px solid transparent",
        background: active ? withAlpha(styles.accent, 0.1) : hovered ? styles.sidebarHover : "transparent",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setShowDelete(false); }}
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
      {sessionCount > 0 && (
        <span
          className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-bold font-mono"
          style={{ background: styles.subtle, color: styles.textTertiary }}
        >
          {sessionCount}
        </span>
      )}
      <motion.span animate={{ rotate: expanded ? 90 : 0 }} transition={{ duration: 0.15 }} className="shrink-0">
        <ChevronsRight size={12} style={{ color: styles.textTertiary }} />
      </motion.span>
      <DeleteProjectButton projectId={project.id} projectName={project.name} visible={hovered || showDelete} />
    </div>
  );
}

/**
 * ROUND-30 SessionRow: one session under a project. The ACTIVE session
 * (matching the ?session= URL param — same source of truth as the chat
 * panel) gets an accent-tinted fill + bold text + a 2px left indicator bar
 * (owner: "When I click on any one of those sessions … those should be
 * clearly highlighted as the currently selected one"). Hover reveals the
 * delete button (owner: "I am not able to delete any of the sessions").
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
  const [hovered, setHovered] = useState(false);

  const remove = () => {
    deleteSession.mutate(session.id, {
      onSuccess: () => {
        // If the deleted session was open, drop the ?session param so the
        // chat panel falls back to the project's latest remaining session.
        if (location.search.includes(session.id)) {
          navigate(`/project/${projectId}/chat`, { replace: true });
        }
      },
    });
  };

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
      <button
        onClick={(e) => { e.stopPropagation(); remove(); }}
        disabled={deleteSession.isPending}
        aria-label={`Delete session ${session.title ?? "Untitled"}`}
        title="Delete session"
        className="relative z-10 w-5 h-5 mr-1 grid place-items-center rounded-md transition-opacity"
        style={{
          color: styles.textTertiary,
          opacity: hovered ? 1 : 0,
        }}
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
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [picking, setPicking] = useState(false);
  const [pickHint, setPickHint] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  
  const nameRef = useRef<HTMLInputElement>(null);
  const demoData = useConfigStore((s) => s.demoData);

  useEffect(() => {
    const timer = setTimeout(() => nameRef.current?.focus(), 60);
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
    if (name.trim().length === 0 || rootPath.trim().length === 0 || createProject.isPending) return;
    setFormError(null);
    createProject.mutate(
      { name: name.trim(), rootPath: rootPath.trim() },
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
  }, [name, rootPath, createProject, onClose, onCreated]);

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
            <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-widest" style={{ color: styles.textTertiary }}>Project Name</label>
            <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
              placeholder="my-awesome-project"
              className="h-12 w-full rounded-[14px] border-[1.5px] px-4 text-[13px] outline-none"
              style={is} />
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-widest" style={{ color: styles.textTertiary }}>Folder</label>
            <div className="flex gap-2">
              <input value={rootPath} onChange={(e) => setRootPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void submit()}
                placeholder="/path/to/project"
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
            disabled={name.trim().length === 0 || rootPath.trim().length === 0 || createProject.isPending}
            className="h-12 w-full rounded-full font-black text-[14px] tracking-[-0.01em] transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100"
            style={{ background: styles.accent, color: styles.accentText, border: `1.5px solid ${styles.accent}`, boxShadow: `0 4px 16px ${withAlpha(styles.accent, 0.25)}` }}>
            {createProject.isPending ? "Creating…" : "Create Project"}
          </button>
        </div>
      </div>
    </div>
  );
}

function NewSessionButton({ projectId, projectName }: { projectId: string; projectName: string }) {
  const styles = useThemeStyles();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [hovered, setHovered] = useState(false);

  const createSession = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const { baseUrl, token } = useConfigStore.getState();
      // Get the default agent (first non-template)
      const agentsRes = await fetch(`${baseUrl}/api/v1/agents?includeTemplates=false`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const agentsBody = await agentsRes.json();
      const agentId = agentsBody.agents?.[0]?.id;
      if (!agentId) return;

      const res = await fetch(`${baseUrl}/api/v1/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ mode: "single", agentId, projectId, title: `New chat · ${projectName}` }),
      });
      const body = await res.json();
      if (res.ok && body.id) {
        navigate(`/project/${projectId}/chat?session=${body.id}`);
      }
    } catch {
      /* silently fail — user can try again */
    } finally {
      setCreating(false);
    }
  };

  return (
    <button
      onClick={() => void createSession()}
      disabled={creating}
      className="w-full h-7 flex items-center gap-2 px-2 rounded-[8px] text-[11px] font-bold transition-colors"
      style={{ color: hovered ? styles.accent : styles.textTertiary }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseOver={(e) => { e.currentTarget.style.background = withAlpha(styles.accent, 0.08); }}
      onMouseOut={(e) => { e.currentTarget.style.background = "transparent"; }}
      aria-label={`Start new session in ${projectName}`}
    >
      <Plus size={10} strokeWidth={2.5} className="shrink-0" />
      <span>{creating ? "Creating…" : "New Session"}</span>
    </button>
  );
}
