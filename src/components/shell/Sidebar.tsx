import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  BarChart3,
  ChevronsLeft,
  ChevronsRight,
  LayoutDashboard,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";
import { motion } from "framer-motion";
import { APP_NAME } from "../../lib/version";
import { cn } from "../../lib/utils";
import { slideInLeft } from "../../lib/motion";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useProjectsStore, type Project } from "../../lib/projects-store";
import { bdr, withAlpha } from "../dashboard/helpers";

const COLLAPSE_KEY = "acute-code.sidebar.collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Sidebar (owner round-8 structure):
 * - TOP highlighted area: brand + Dashboard — the primary surface.
 * - PROJECTS section below, deliberately separated: project list + Add
 *   Project (local-first store until the workspace engine lands).
 * - Usage.
 * - Bottom: Settings (agents management + API config + appearance live in
 *   there now, NOT in the sidebar) + collapse toggle.
 * Sessions are intentionally absent: they open from a project's activity,
 * not from the sidebar (chat-window flow arrives with orchestration).
 */
export function Sidebar() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const styles = useThemeStyles();
  const navigate = useNavigate();
  const projects = useProjectsStore((s) => s.projects);
  const selectedProjectId = useProjectsStore((s) => s.selectedProjectId);
  const selectProject = useProjectsStore((s) => s.selectProject);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        /* private-mode localStorage failures just skip persistence */
      }
      return !c;
    });
  };

  const openProject = useCallback(
    (id: string) => {
      selectProject(id);
      navigate(`/project/${id}`);
    },
    [navigate, selectProject],
  );

  return (
    <motion.aside
      variants={slideInLeft}
      initial="initial"
      animate="animate"
      className={cn(
        "hidden shrink-0 flex-col overflow-hidden rounded-lg border-[1.5px] transition-all duration-200 md:flex",
        collapsed ? "w-[60px]" : "w-[250px] xl:w-[270px]",
      )}
      style={{ backgroundColor: styles.card, borderColor: styles.border }}
    >
      {/* ── TOP highlighted area: brand + Dashboard ── */}
      <div
        className={cn("shrink-0 pb-2 pt-3", collapsed ? "px-2" : "px-3")}
        style={{
          background: withAlpha(styles.accent, 0.05),
          borderBottom: bdr("1.5px", withAlpha(styles.accent, 0.15)),
        }}
      >
        <div className={cn("mb-2 flex items-center gap-2.5", collapsed && "justify-center")}>
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold"
            style={{ backgroundColor: styles.accent, color: styles.accentText }}
            title={APP_NAME}
          >
            A
          </div>
          {!collapsed ? (
            <div className="min-w-0">
              <div className="truncate text-[13px] font-bold tracking-tight" style={{ color: styles.text }}>
                {APP_NAME}
              </div>
              <div className="truncate text-[10px]" style={{ color: styles.textSecondary }}>
                multi-agent workbench
              </div>
            </div>
          ) : null}
        </div>
        <DashboardButton collapsed={collapsed} />
      </div>

      {/* ── PROJECTS section (separate concern, visually separated) ── */}
      <div className="flex min-h-0 flex-1 flex-col">
        {!collapsed ? (
          <>
            <div className="flex items-center gap-2 px-3 pb-1.5 pt-3">
              <h2 className="flex-1 text-[12px] font-bold" style={{ color: styles.text }}>
                Projects
              </h2>
              <span
                className="rounded-full px-1.5 py-0.5 text-[10px] font-bold"
                style={{ background: styles.subtle, color: styles.textTertiary }}
              >
                {projects.length}
              </span>
            </div>
            <div className="mx-3" style={{ borderTop: bdr("1.5px", styles.border) }} />
          </>
        ) : null}
        <div className="custom-scrollbar flex flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
          {projects.map((p) => (
            <ProjectItem
              key={p.id}
              project={p}
              collapsed={collapsed}
              isActive={p.id === selectedProjectId}
              onSelect={() => openProject(p.id)}
            />
          ))}
          {!collapsed && projects.length === 0 ? (
            <p className="px-2.5 py-2 text-[11px] leading-relaxed" style={{ color: styles.textTertiary }}>
              No projects yet — add one to give your agents a home.
            </p>
          ) : null}
        </div>
        <div className={cn("shrink-0 pb-1.5", collapsed ? "px-1.5" : "px-2")}>
          <AddProjectButton collapsed={collapsed} onCreated={openProject} />
        </div>
      </div>

      {/* ── Usage + Settings + collapse ── */}
      <div className="shrink-0 p-2" style={{ borderTop: bdr("1.5px", styles.border) }}>
        <UsageButton collapsed={collapsed} />
        <SettingsButton collapsed={collapsed} />
        <button
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "mt-1 flex h-7 w-full cursor-pointer items-center gap-2 rounded-lg px-2 transition-colors duration-200",
            collapsed && "justify-center px-0",
          )}
          style={{ color: styles.textTertiary }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = styles.subtleHover;
            e.currentTarget.style.color = styles.text;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = styles.textTertiary;
          }}
        >
          {collapsed ? <ChevronsRight size={13} /> : <ChevronsLeft size={13} />}
          {!collapsed ? (
            <span className="truncate font-mono text-[10px]">local-first · no telemetry</span>
          ) : null}
        </button>
      </div>
    </motion.aside>
  );
}

function navButtonClass(collapsed: boolean): string {
  return cn(
    "flex w-full shrink-0 cursor-pointer items-center gap-2.5 rounded-lg border-[1.5px] px-2.5 py-2 text-[12px] font-semibold transition-colors duration-200",
    collapsed && "justify-center px-0",
  );
}

function DashboardButton({ collapsed }: { collapsed: boolean }) {
  const styles = useThemeStyles();
  const navigate = useNavigate();
  return (
    <button
      onClick={() => {
        useProjectsStore.getState().selectProject(null);
        navigate("/");
      }}
      title={collapsed ? "Dashboard" : undefined}
      className={navButtonClass(collapsed)}
      style={{
        backgroundColor: withAlpha(styles.accent, 0.1),
        borderColor: withAlpha(styles.accent, 0.3),
        color: styles.accent,
      }}
    >
      <LayoutDashboard size={15} strokeWidth={2.25} className="shrink-0" />
      {!collapsed ? <span className="truncate">Dashboard</span> : null}
    </button>
  );
}

function UsageButton({ collapsed }: { collapsed: boolean }) {
  const styles = useThemeStyles();
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate("/usage")}
      title={collapsed ? "Usage" : undefined}
      className={navButtonClass(collapsed)}
      style={{ borderColor: "transparent", color: styles.textSecondary }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = styles.subtleHover;
        e.currentTarget.style.color = styles.text;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = styles.textSecondary;
      }}
    >
      <BarChart3 size={15} strokeWidth={2.25} className="shrink-0" />
      {!collapsed ? <span className="truncate">Usage</span> : null}
    </button>
  );
}

function SettingsButton({ collapsed }: { collapsed: boolean }) {
  const styles = useThemeStyles();
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate("/settings")}
      title={collapsed ? "Settings" : undefined}
      className={cn(navButtonClass(collapsed), "mt-0.5")}
      style={{ borderColor: "transparent", color: styles.textSecondary }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = styles.subtleHover;
        e.currentTarget.style.color = styles.text;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = styles.textSecondary;
      }}
    >
      <Settings size={15} strokeWidth={2.25} className="shrink-0" />
      {!collapsed ? <span className="truncate">Settings</span> : null}
    </button>
  );
}

function ProjectItem({
  project,
  isActive,
  collapsed,
  onSelect,
}: {
  project: Project;
  isActive: boolean;
  collapsed: boolean;
  onSelect: () => void;
}) {
  const styles = useThemeStyles();
  const deleteProject = useProjectsStore((s) => s.deleteProject);
  const letter = project.name.charAt(0).toUpperCase();

  if (collapsed) {
    return (
      <button
        onClick={onSelect}
        title={project.name}
        aria-label={project.name}
        className="mx-auto flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-sm font-bold text-white transition-transform duration-200 hover:scale-105"
        style={{
          backgroundColor: `${project.color}CC`,
          outline: isActive ? `2px solid ${styles.accent}` : "none",
        }}
      >
        {letter}
      </button>
    );
  }

  return (
    <div
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect();
      }}
      className="group relative cursor-pointer rounded-lg px-2.5 py-2 transition-colors duration-200"
      style={{
        backgroundColor: isActive ? withAlpha(project.color, 0.1) : "transparent",
        border: bdr("1.5px", isActive ? withAlpha(project.color, 0.3) : "transparent"),
      }}
      onMouseEnter={(e) => {
        if (!isActive) e.currentTarget.style.backgroundColor = styles.subtleHover;
      }}
      onMouseLeave={(e) => {
        if (!isActive) e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      <div className="flex items-center gap-2.5">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white transition-transform duration-200 group-hover:scale-105"
          style={{ backgroundColor: `${project.color}CC` }}
        >
          {letter}
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[12px] font-semibold"
            style={{ color: isActive ? styles.text : styles.text }}
          >
            {project.name}
          </div>
          <div
            className="mt-0.5 truncate font-mono text-[10px]"
            style={{ color: styles.textTertiary }}
          >
            {project.path}
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            deleteProject(project.id);
          }}
          aria-label={`Delete ${project.name}`}
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-0 transition-all duration-150 group-hover:opacity-100"
          style={{ color: styles.textTertiary }}
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  );
}

function AddProjectButton({
  collapsed,
  onCreated,
}: {
  collapsed: boolean;
  onCreated: (id: string) => void;
}) {
  const styles = useThemeStyles();
  const addProject = useProjectsStore((s) => s.addProject);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => nameRef.current?.focus(), 60);
  }, [open]);

  const handleAdd = useCallback(() => {
    if (!name.trim() || !path.trim()) return;
    const project = addProject(name.trim(), path.trim());
    setName("");
    setPath("");
    setOpen(false);
    onCreated(project.id);
  }, [name, path, addProject, onCreated]);

  if (collapsed) {
    return (
      <button
        onClick={() => {
          setCollapsedExpandHint();
        }}
        title="Expand the sidebar to add a project"
        className="mx-auto flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg"
        style={{ color: styles.textTertiary }}
      >
        <Plus size={14} strokeWidth={2.5} />
      </button>
    );
  }

  const inputStyle = {
    background: styles.inputBg,
    borderColor: styles.inputBorder,
    color: styles.text,
  } as const;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2.5 py-2 text-[11px] font-semibold transition-all duration-200 hover:scale-[1.01] active:scale-[0.99]"
        style={{
          backgroundColor: styles.subtle,
          border: bdr("1.5px", styles.border),
          borderStyle: "dashed",
          color: styles.textTertiary,
        }}
      >
        <Plus size={12} strokeWidth={2.5} />
        <span>Add Project</span>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center"
          style={{ background: "rgba(0,0,0,0.45)" }}
          onClick={() => setOpen(false)}
        >
          <div
            className="w-[min(420px,90vw)] rounded-[14px] border-2 p-5"
            style={{ background: styles.card, borderColor: styles.borderStrong }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[15px] font-bold" style={{ color: styles.text }}>
              Add New Project
            </h3>
            <div className="mt-3 flex flex-col gap-3">
              <div>
                <label className="mb-1.5 block text-[11px] font-semibold" style={{ color: styles.textTertiary }}>
                  Project Name
                </label>
                <input
                  ref={nameRef}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                  placeholder="my-awesome-project"
                  className="h-10 w-full rounded-[8px] border-[1.5px] px-3 text-sm outline-none"
                  style={inputStyle}
                />
              </div>
              <div>
                <label className="mb-1.5 block text-[11px] font-semibold" style={{ color: styles.textTertiary }}>
                  Folder Path
                </label>
                <input
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                  placeholder="~/projects/my-awesome-project"
                  className="h-10 w-full rounded-[8px] border-[1.5px] px-3 font-mono text-[12px] outline-none"
                  style={inputStyle}
                />
              </div>
              <button
                onClick={handleAdd}
                disabled={!name.trim() || !path.trim()}
                className="mt-1 h-10 cursor-pointer rounded-[8px] text-sm font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
                style={{ backgroundColor: styles.accent, color: styles.accentText }}
              >
                Create Project
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** Collapsed mode keeps the + inert (expanding is one click away). */
function setCollapsedExpandHint() {
  /* intentionally a no-op hint target; the collapse toggle is right below */
}
