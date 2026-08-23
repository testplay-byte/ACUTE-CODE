import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  BarChart3,
  ChevronsLeft,
  ChevronsRight,
  FolderOpen,
  LayoutDashboard,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";
import { motion } from "framer-motion";
import { ApiError, pickFolderViaBackend, type Project } from "../../lib/api";
import { cn } from "../../lib/utils";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { isTauri } from "../../lib/sidecar";
import { useConfigStore } from "../../lib/config-store";
import { useThemeStyles, } from "../../lib/use-theme-styles";
import { useCreateProject, useDeleteProject, useProjects } from "../../hooks/use-projects";
import { withAlpha } from "../dashboard/helpers";

type TauriGlobal = {
  core: {
    invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
};

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri) throw new Error("Tauri shell unavailable");
  return tauri.core.invoke(command, args) as Promise<T>;
}

const COLLAPSE_KEY = "acute-code.sidebar.collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Sidebar (round-21 UI overhaul): wizard design DNA applied —
 * solid accent fills for active states, 1.5px borderStrong borders,
 * softShadow on the card, generous radii (12-20px), 11px bold uppercase
 * tracked labels, and the wizard's selected-card recipe (accent border +
 * ring + shadow + lift) for active projects.
 */
export function Sidebar() {
  const styles = useThemeStyles();
  const [collapsed, setCollapsed] = useState(readCollapsed);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      /* private mode */
    }
  }, [collapsed]);

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 64 : 264 }}
      transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
      className="shrink-0 flex flex-col overflow-hidden rounded-[20px] border-[1.5px]"
      style={{
        backgroundColor: styles.card,
        borderColor: styles.borderStrong,
        boxShadow: styles.softShadow,
      }}
    >
      {/* Brand row — wizard pill style */}
      <div className={cn("shrink-0 flex items-center gap-2.5 px-3 pt-4", collapsed && "justify-center px-2")}>
        <div
          className="w-8 h-8 shrink-0 rounded-[10px] grid place-items-center font-black text-[14px]"
          style={{ background: styles.accent, color: styles.accentText }}
        >
          {"\u25D0"}
        </div>
        {!collapsed && (
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[13px] font-bold tracking-[-0.02em] truncate" style={{ color: styles.text }}>
              Acute
            </span>
            <span
              className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-bold font-mono"
              style={{ background: styles.accent, color: styles.accentText }}
            >
              "v0.1.0"
            </span>
          </div>
        )}
      </div>

      {/* Nav items */}
      <nav className={cn("flex flex-col gap-1 px-2.5 pt-4", collapsed && "px-1.5")} aria-label="Main navigation">
        <DashboardButton collapsed={collapsed} />
        <UsageButton collapsed={collapsed} />
      </nav>

      {/* Projects section */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden pt-4">
        <ProjectSection collapsed={collapsed} />
      </div>

      {/* Bottom */}
      <div className={cn("shrink-0 border-t px-2.5 pb-3 pt-2", collapsed && "px-1.5")} style={{ borderColor: styles.borderSubtle }}>
        <SettingsButton collapsed={collapsed} />
        <button
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="w-full h-8 mt-1 flex items-center justify-center rounded-[10px] transition-colors"
          style={{ color: styles.textTertiary }}
          onMouseEnter={(e) => (e.currentTarget.style.background = styles.subtleHover)}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          {collapsed ? <ChevronsRight size={14} /> : <ChevronsLeft size={14} />}
        </button>
      </div>
    </motion.aside>
  );
}

/** Nav button — active = solid accent fill + bentoShadowSm (wizard recipe). */
function NavButton({
  icon: Icon,
  label,
  active,
  collapsed,
  onClick,
}: {
  icon: typeof LayoutDashboard;
  label: string;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
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
        boxShadow: active ? styles.bentoShadowSm : "none",
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = styles.subtleHover;
          e.currentTarget.style.color = styles.text;
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = styles.textSecondary;
        }
      }}
    >
      <Icon size={16} strokeWidth={2} className="shrink-0" />
      {!collapsed && <span>{label}</span>}
    </button>
  );
}

function DashboardButton({ collapsed }: { collapsed: boolean }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const active = pathname === "/";
  return (
    <NavButton
      icon={LayoutDashboard}
      label="Dashboard"
      active={active}
      collapsed={collapsed}
      onClick={() => navigate("/")}
    />
  );
}

function UsageButton({ collapsed }: { collapsed: boolean }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const active = pathname.startsWith("/usage");
  return (
    <NavButton
      icon={BarChart3}
      label="Usage"
      active={active}
      collapsed={collapsed}
      onClick={() => navigate("/usage")}
    />
  );
}

function SettingsButton({ collapsed }: { collapsed: boolean }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const active = pathname.startsWith("/settings");
  return (
    <NavButton
      icon={Settings}
      label="Settings"
      active={active}
      collapsed={collapsed}
      onClick={() => navigate("/settings")}
    />
  );
}

/** Projects section — header label + project list + Add Project button. */
function ProjectSection({ collapsed }: { collapsed: boolean }) {
  const styles = useThemeStyles();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const projectsQuery = useProjects();
  const projects = projectsQuery.data ?? [];
  const [showAddDialog, setShowAddDialog] = useState(false);

  const activeProjectMatch = pathname.match(/^\/project\/([^/]+)/);
  const activeProjectId = activeProjectMatch?.[1] ?? null;

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1.5 px-1.5 pb-2">
        {projects.slice(0, 5).map((project) => (
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
          title="Add project"
          className="w-9 h-9 rounded-[12px] grid place-items-center border-[1.5px] border-dashed transition-transform hover:scale-105"
          style={{ borderColor: styles.border, color: styles.textTertiary }}
        >
          <Plus size={14} strokeWidth={2.5} />
        </button>
        {showAddDialog && (
          <AddProjectDialog
            onCreated={(id) => navigate(`/project/${id}/chat`)}
            onClose={() => setShowAddDialog(false)}
          />
        )}
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between px-4 pb-2">
        <span
          className="text-[11px] font-bold uppercase tracking-widest"
          style={{ color: styles.textTertiary }}
        >
          Projects
        </span>
        {projects.length > 0 && (
          <span
            className="px-1.5 py-0.5 rounded-full text-[10px] font-bold"
            style={{ background: styles.subtle, color: styles.textTertiary }}
          >
            {projects.length}
          </span>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-2.5 pb-2 space-y-1" style={{ scrollbarWidth: "thin" }}>
        {projects.map((project) => (
          <ProjectItem
            key={project.id}
            project={project}
            active={activeProjectId === project.id}
          />
        ))}
        <AddProjectButton onOpen={() => setShowAddDialog(true)} />
      </div>
      {showAddDialog && (
        <AddProjectDialog
          onCreated={(id) => navigate(`/project/${id}/chat`)}
          onClose={() => setShowAddDialog(false)}
        />
      )}
    </>
  );
}

function ProjectItem({ project, active }: { project: Project; active: boolean }) {
  const styles = useThemeStyles();
  const navigate = useNavigate();
  const deleteProject = useDeleteProject();
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="group relative h-11 flex items-center gap-2.5 rounded-[12px] px-2 cursor-pointer transition-all duration-200"
      style={{
        border: active ? `1.5px solid ${styles.accent}` : "1.5px solid transparent",
        background: active ? "transparent" : hovered ? styles.subtleHover : "transparent",
        boxShadow: active ? `0 0 0 3px ${withAlpha(styles.accent, 0.15)}` : "none",
        transform: active ? "translateY(-1px)" : "none",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => navigate(`/project/${project.id}/chat`)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") navigate(`/project/${project.id}/chat`);
      }}
      aria-label={`Open project ${project.name}`}
    >
      <span
        className="w-8 h-8 shrink-0 rounded-[10px] grid place-items-center font-black text-[13px]"
        style={{ background: project.color, color: "#fff" }}
      >
        {project.name.charAt(0).toUpperCase()}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className="text-[12px] font-bold truncate transition-colors"
          style={{ color: active ? styles.text : styles.textSecondary }}
        >
          {project.name}
        </span>
        <span
          className="font-mono text-[9.5px] truncate"
          style={{ color: styles.textTertiary }}
          title={project.rootPath}
        >
          {project.rootPath}
        </span>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          deleteProject.mutate(project.id);
        }}
        aria-label={`Delete ${project.name}`}
        title={`Delete ${project.name}`}
        className="absolute right-1.5 w-6 h-6 grid place-items-center rounded-md opacity-0 transition-opacity group-hover:opacity-100"
        style={{ color: styles.textTertiary }}
      >
        <Trash2 size={11} />
      </button>
    </div>
  );
}

function AddProjectButton({ onOpen }: { onOpen: () => void }) {
  const styles = useThemeStyles();
  return (
    <button
      onClick={onOpen}
      className="h-10 flex items-center justify-center gap-2 rounded-[14px] border-[1.5px] border-dashed text-[12px] font-bold transition-all duration-200 hover:-translate-y-px"
      style={{
        borderColor: styles.border,
        background: styles.subtle,
        color: styles.textTertiary,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = styles.borderStrong;
        e.currentTarget.style.color = styles.textSecondary;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = styles.border;
        e.currentTarget.style.color = styles.textTertiary;
      }}
    >
      <Plus size={13} strokeWidth={2.5} />
      <span>Add Project</span>
    </button>
  );
}

// ─── Add Project Dialog (wizard-style: h-12 inputs, 24px radius) ─────────────

function AddProjectDialog({
  onCreated,
  onClose,
}: {
  onCreated: (projectId: string) => void;
  onClose: () => void;
}) {
  const styles = useThemeStyles();
  const createProject = useCreateProject();
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
    setPicking(true);
    setPickHint(null);
    try {
      if (isTauri()) {
        const folder = await tauriInvoke<string | null>("pick_folder");
        if (typeof folder === "string" && folder) setRootPath(folder);
        return;
      }
      const picked = await pickFolderViaBackend();
      if (picked.path) {
        setRootPath(picked.path);
      } else if (picked.unavailable) {
        setPickHint("No folder dialog on this machine — paste the path.");
      } else if (picked.error) {
        setPickHint(`Folder dialog failed: ${picked.error}`);
      }
    } catch (cause) {
      setPickHint(`Folder dialog failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setPicking(false);
    }
  }, []);

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

  const is = {
    background: styles.inputBg,
    borderColor: styles.inputBorder,
    color: styles.text,
  } as const;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={onClose}
    >
      <div
        className="w-[min(440px,90vw)] rounded-[24px] border-[1.5px] p-5"
        style={{
          background: styles.card,
          borderColor: styles.borderStrong,
          boxShadow: styles.bentoShadow,
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Add a new project"
      >
        <h3 className="text-[15px] font-black tracking-tight mb-4" style={{ color: styles.text }}>
          Add New Project
        </h3>
        <div className="flex flex-col gap-3.5">
          <div>
            <label
              className="mb-1.5 block text-[11px] font-bold uppercase tracking-widest"
              style={{ color: styles.textTertiary }}
            >
              Project Name
            </label>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="my-awesome-project"
              className="h-12 w-full rounded-[14px] border-[1.5px] px-4 text-[13px] outline-none transition-colors"
              style={is}
              onFocus={(e) => (e.currentTarget.style.borderColor = styles.inputFocusBorder)}
              onBlur={(e) => (e.currentTarget.style.borderColor = styles.inputBorder)}
            />
          </div>
          <div>
            <label
              className="mb-1.5 block text-[11px] font-bold uppercase tracking-widest"
              style={{ color: styles.textTertiary }}
            >
              Folder
            </label>
            <div className="flex gap-2">
              <input
                value={rootPath}
                onChange={(e) => setRootPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder="/path/to/project"
                className="h-12 min-w-0 flex-1 rounded-[14px] border-[1.5px] px-4 font-mono text-[12px] outline-none transition-colors"
                style={is}
                onFocus={(e) => (e.currentTarget.style.borderColor = styles.inputFocusBorder)}
                onBlur={(e) => (e.currentTarget.style.borderColor = styles.inputBorder)}
              />
              {isTauri() || !demoData ? (
                <button
                  onClick={() => void handleBrowse()}
                  disabled={picking}
                  title="Browse for a folder"
                  className="h-12 shrink-0 flex items-center justify-center gap-1.5 rounded-[14px] border-[1.5px] px-3.5 text-[12px] font-bold transition-all disabled:opacity-60"
                  style={{ background: styles.subtle, borderColor: styles.border, color: styles.textSecondary }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = styles.subtleHover)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = styles.subtle)}
                >
                  <FolderOpen size={13} />
                  Browse
                </button>
              ) : null}
            </div>
            {pickHint && (
              <p className="mt-1.5 text-[11px]" style={{ color: styles.textTertiary }}>
                {pickHint}
              </p>
            )}
          </div>
          {formError && (
            <p
              role="alert"
              className="rounded-[12px] border px-3 py-2 text-[12px]"
              style={{
                borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.3),
                background: withAlpha(SEMANTIC_COLORS.danger, 0.08),
                color: SEMANTIC_COLORS.danger,
              }}
            >
              {formError}
            </p>
          )}
          <button
            onClick={submit}
            disabled={name.trim().length === 0 || rootPath.trim().length === 0 || createProject.isPending}
            className="h-12 w-full rounded-full font-black text-[14px] tracking-[-0.01em] transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100"
            style={{
              background: `linear-gradient(135deg, ${styles.accent}, ${styles.accent})`,
              color: styles.accentText,
              border: `1.5px solid ${styles.accent}`,
              boxShadow: styles.bentoShadowSm,
            }}
          >
            {createProject.isPending ? "Creating…" : "Create Project"}
          </button>
        </div>
      </div>
    </div>
  );
}
