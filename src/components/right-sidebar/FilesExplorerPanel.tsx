import { useEffect, useRef } from "react";
import { create } from "zustand";
import { AnimatePresence, motion } from "framer-motion";
import {
  Braces,
  ChevronRight,
  FileCode2,
  FileText,
  FolderOpen,
  FolderTree,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
} from "lucide-react";
import { useProjectFile, useProjectTree, useProjects } from "../../hooks/use-projects";
import type { TreeNode } from "../../lib/api";
import { useRightSidebarEvents } from "../../lib/right-sidebar-events";
import type { RightSidebarTab } from "../../lib/right-sidebar-store";
import { ease } from "../../lib/motion";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useScrollFade } from "../../lib/useScrollFade";
import { getFileColor, highlightLine } from "../project-chat/highlight";
import { isMarkdown, Markdown } from "./FileViewerPanel";

/**
 * ROUND-48 (R48-c) — the right-sidebar file EXPLORER tab. Owner spec: "The
 * right sidebar will be divided into two sections: on the left half, the
 * actual file system with navigation/open folders/click files; on the right
 * side, the actual content of the files."
 *
 * Data comes from the same surface the project-chat ExplorerPanel uses
 * (GET /projects/:id/tree via useProjectTree — depth ≤ 8, node_modules/.git
 * filtered — and GET /projects/:id/file via useProjectFile), so the explorer
 * and the chat's explorer panel always agree. The tree UX mirrors
 * ExplorerPanel's (animated chevron + folder icons + per-extension file
 * colors, click-to-expand folders) but is implemented lean IN THIS FILE:
 * ExplorerPanel's tree rows are coupled to the project-chat store
 * (selectedFileId/expandedFolders there), and that file is outside R48-c's
 * edit scope — duplicating ~40 lines of row rendering beats a cross-panel
 * refactor mid-round. Content rendering REUSES FileViewerPanel's exported
 * Markdown renderer (+ its isMarkdown rule) so .md previews look identical in
 * both surfaces; code renders with the same line-number + token-highlight
 * treatment.
 *
 * Layout notes for the narrow right sidebar (360-760px, typically ~460):
 * the tree pane is a fixed 40% column with its own scroll + custom scrollbar
 * (.auto-scroll + useScrollFade, the pattern every other long list in the
 * right sidebar uses), the content pane takes the remaining 60%. The header's
 * PanelLeftClose/PanelLeftOpen toggle collapses the tree pane entirely for
 * narrow widths — the explorer then reads as a single full-width preview.
 */

/** Per-project explorer UI state. Module-level (NOT component state) because
 * the right sidebar renders ONLY the active tab's panel — switching to
 * another tab unmounts this panel, and the owner's tree navigation should
 * not reset when they come back. Keyed by projectId (the tree itself is
 * project-scoped, not session-scoped). Deliberately NOT persisted: this is
 * ephemeral browsing state, unlike the tab list (right-sidebar-store). */
interface FilesExplorerUiState {
  expandedFolders: string[];
  selectedPath: string | null;
  treeCollapsed: boolean;
}

const DEFAULT_UI: FilesExplorerUiState = {
  expandedFolders: [],
  selectedPath: null,
  treeCollapsed: false,
};

interface FilesExplorerState {
  byProject: Record<string, FilesExplorerUiState>;
  toggleFolder: (projectId: string, path: string) => void;
  selectFile: (projectId: string, path: string) => void;
  toggleTreeCollapsed: (projectId: string) => void;
  seedExpanded: (projectId: string, paths: string[]) => void;
}

const useFilesExplorerStore = create<FilesExplorerState>()((set) => ({
  byProject: {},
  toggleFolder: (projectId, path) =>
    set((s) => {
      const cur = s.byProject[projectId] ?? DEFAULT_UI;
      const expandedFolders = cur.expandedFolders.includes(path)
        ? cur.expandedFolders.filter((p) => p !== path)
        : [...cur.expandedFolders, path];
      return { byProject: { ...s.byProject, [projectId]: { ...cur, expandedFolders } } };
    }),
  selectFile: (projectId, path) =>
    set((s) => {
      const cur = s.byProject[projectId] ?? DEFAULT_UI;
      if (cur.selectedPath === path) return s;
      return { byProject: { ...s.byProject, [projectId]: { ...cur, selectedPath: path } } };
    }),
  toggleTreeCollapsed: (projectId) =>
    set((s) => {
      const cur = s.byProject[projectId] ?? DEFAULT_UI;
      return { byProject: { ...s.byProject, [projectId]: { ...cur, treeCollapsed: !cur.treeCollapsed } } };
    }),
  /** One-time first-load seed: expand all top-level folders (same rule as
   * ExplorerPanel). Only fires while the project has NO stored slice yet so
   * a user who collapsed everything never gets re-expanded behind their back. */
  seedExpanded: (projectId, paths) =>
    set((s) => {
      if (s.byProject[projectId] !== undefined) return s;
      return { byProject: { ...s.byProject, [projectId]: { ...DEFAULT_UI, expandedFolders: paths } } };
    }),
}));

/** Same file-type icon treatment as ExplorerPanel (json → braces, md/css →
 * text, else code glyph), colored by the shared extension palette. */
function FileIcon({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const color = getFileColor(name);
  if (ext === "json") return <Braces size={13} style={{ color }} className="shrink-0" />;
  if (ext === "md" || ext === "css") return <FileText size={13} style={{ color }} className="shrink-0" />;
  return <FileCode2 size={13} style={{ color }} className="shrink-0" />;
}

function TreeRow({
  node,
  depth,
  expandedFolders,
  selectedPath,
  onToggleFolder,
  onSelectFile,
}: {
  node: TreeNode;
  depth: number;
  expandedFolders: string[];
  selectedPath: string | null;
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const styles = useThemeStyles();
  const isFolder = node.type === "folder";
  const expanded = expandedFolders.includes(node.path);
  const selected = selectedPath === node.path;
  return (
    <div>
      <button
        data-tree-path={node.path}
        aria-expanded={isFolder ? expanded : undefined}
        aria-current={selected ? "true" : undefined}
        // R126-3e: the tree row = the hover wash (kept) + the selected file =
        // bg-accent-tint + text-accent-deep 500 (TOKENS §10/§1d's selection
        // grammar); the withAlpha(accent) fill died.
        className={`w-full flex items-center gap-1.5 h-[30px] px-1.5 text-left transition-colors rounded-md hover:bg-hover ${
          selected ? "bg-accent-tint" : ""
        }`}
        style={{
          paddingLeft: `${depth * 12 + 6}px`,
        }}
        onClick={() => {
          if (isFolder) onToggleFolder(node.path);
          else onSelectFile(node.path);
        }}
        title={node.path}
      >
        {isFolder ? (
          <motion.span
            animate={{ rotate: expanded ? 90 : 0 }}
            transition={{ duration: 0.15 }}
            className="shrink-0"
          >
            <ChevronRight size={11} style={{ color: styles.textSecondary }} />
          </motion.span>
        ) : (
          <span className="w-[11px] shrink-0" />
        )}
        {isFolder ? (
          <FolderOpen
            size={13}
            style={{ color: expanded ? styles.accent : styles.textSecondary }}
            className="shrink-0"
          />
        ) : (
          <FileIcon name={node.name} />
        )}
        <span
          // R126-3e: the selected label = text-accent-deep + 500; inactive
          // = text-muted (the JS color/weight legs died).
          className={`text-[12px] font-mono truncate ${
            selected ? "text-accent-deep font-medium" : "text-muted"
          }`}
        >
          {node.name}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {isFolder && expanded && node.children && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease }}
            style={{ overflow: "hidden" }}
          >
            {node.children.map((child) => (
              <TreeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                expandedFolders={expandedFolders}
                selectedPath={selectedPath}
                onToggleFolder={onToggleFolder}
                onSelectFile={onSelectFile}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Small header icon-button (Search / tree toggle): tertiary color, the
 * CSS hover wash (R100-G) — the same affordance language as the tab-strip
 * buttons. */
function HeaderIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const styles = useThemeStyles();
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="w-7 h-7 grid place-items-center rounded-lg transition-colors shrink-0 hover:bg-hover"
      style={{ color: styles.textTertiary }}
    >
      {children}
    </button>
  );
}

/** Loading skeleton rows for the tree pane (ExplorerPanel's pattern).
 * R126-3e (TOKENS §10 law 4): skeletons ride the well (bg-well). */
function TreeSkeleton() {
  return (
    <div aria-label="Loading file tree">
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="h-[30px] rounded-md animate-pulse mb-1 bg-well"
        />
      ))}
    </div>
  );
}

/** Honest failure card with a retry affordance (tree OR file loads).
 * R126-3e (§11): the danger badge-tone container + the outlined-danger
 * Retry — the withAlpha(danger) washes died. */
function ErrorRetry({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="m-2 p-2.5 rounded-xl flex flex-col gap-2 bg-badge-danger text-badge-danger-fg"
    >
      <div className="text-[11px] leading-snug">
        {message}
      </div>
      <button
        onClick={onRetry}
        className="self-start flex items-center gap-1.5 h-7 px-2.5 rounded-lg border border-danger-deep text-danger-deep text-[11px] font-medium transition-colors duration-100 active:scale-[0.98]"
      >
        <RefreshCw size={11} />
        Try again
      </button>
    </div>
  );
}

export function FilesExplorerPanel({
  projectId,
}: {
  projectId: string;
  /** Shape parity with the other right-sidebar panels. The explorer keeps
   * its own per-project selection state (see useFilesExplorerStore) — the
   * singleton tab carries no per-file key. */
  tab: RightSidebarTab;
}) {
  const styles = useThemeStyles();
  const requestFilePicker = useRightSidebarEvents((s) => s.requestFilePicker);

  const ui = useFilesExplorerStore((s) => s.byProject[projectId]) ?? DEFAULT_UI;
  const toggleFolder = useFilesExplorerStore((s) => s.toggleFolder);
  const selectFile = useFilesExplorerStore((s) => s.selectFile);
  const toggleTreeCollapsed = useFilesExplorerStore((s) => s.toggleTreeCollapsed);
  const seedExpanded = useFilesExplorerStore((s) => s.seedExpanded);

  const projectsQuery = useProjects();
  const project = projectsQuery.data?.find((p) => p.id === projectId) ?? null;
  const treeQuery = useProjectTree(projectId);
  const selectedPath = ui.selectedPath;
  const fileQuery = useProjectFile(projectId, selectedPath);

  const treeScrollRef = useRef<HTMLDivElement>(null);
  const contentScrollRef = useRef<HTMLDivElement>(null);
  useScrollFade(treeScrollRef);
  useScrollFade(contentScrollRef);

  // One-time seed: with no stored slice for the project yet, expand all
  // top-level folders once the tree loads (ExplorerPanel's first-load rule).
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !treeQuery.data) return;
    seededRef.current = true;
    const topLevel = treeQuery.data.tree
      .filter((n) => n.type === "folder")
      .map((n) => n.path);
    if (topLevel.length > 0) seedExpanded(projectId, topLevel);
  }, [treeQuery.data, projectId, seedExpanded]);

  const content = fileQuery.data?.content ?? "";
  const fileName = selectedPath !== null ? selectedPath.split("/").pop() ?? selectedPath : "";
  const fileColor = getFileColor(fileName);

  return (
    <div className="h-full flex flex-col min-h-0" data-testid="files-explorer-panel">
      {/* ── Header: project name + Search (palette) + tree-pane toggle ── */}
      {/* R126-3e: the header strip = the in-flow chrome shade
          (bg-header-surface + the clay-rim hairline). */}
      <div
        className="shrink-0 flex items-center gap-2 px-2.5 h-9 border-b border-clay-rim bg-header-surface"
      >
        <div
          className="w-5 h-5 rounded-md grid place-items-center shrink-0"
          style={{ backgroundColor: project?.color ?? styles.accent }}
          title={project?.rootPath ?? projectId}
        >
          {/* white icon reads on the project's own color chip, not a theme surface */}
          <FolderTree size={11} color="#fff" />
        </div>
        <span
          // R126-3e tightening (the panel-header spelling): the title snaps
          // to 12px/600 — one header tier with SubAgent/Console (was 11/500).
          className="flex-1 min-w-0 truncate text-[12px] font-semibold"
          style={{ color: styles.text }}
        >
          {project?.name ?? "Files"}
        </span>
        <HeaderIconButton
          label="Search files (command palette)"
          onClick={() => requestFilePicker()}
        >
          <Search size={13} />
        </HeaderIconButton>
        <HeaderIconButton
          label={ui.treeCollapsed ? "Show file tree" : "Hide file tree"}
          onClick={() => toggleTreeCollapsed(projectId)}
        >
          {ui.treeCollapsed ? <PanelLeftOpen size={13} /> : <PanelLeftClose size={13} />}
        </HeaderIconButton>
      </div>

      {/* ── Two-pane body: tree (≈40%) | content (≈60%) ── */}
      <div className="flex-1 min-h-0 flex">
        {!ui.treeCollapsed && (
          <div
            ref={treeScrollRef}
            aria-label="Project file tree"
            // R126-3e: the pane divider = the clay-rim hairline.
            className="w-[40%] shrink-0 min-w-0 overflow-y-auto auto-scroll border-r border-clay-rim py-1.5 px-1"
            style={{ scrollbarWidth: "thin" }}
          >
            {treeQuery.isLoading ? (
              <TreeSkeleton />
            ) : treeQuery.isError ? (
              <ErrorRetry
                message={
                  treeQuery.error instanceof Error
                    ? treeQuery.error.message
                    : "Failed to load the file tree."
                }
                onRetry={() => void treeQuery.refetch()}
              />
            ) : treeQuery.data && treeQuery.data.tree.length === 0 ? (
              <div className="px-2 py-3 text-[11px]" style={{ color: styles.textTertiary }}>
                No files in this project yet.
              </div>
            ) : (
              treeQuery.data?.tree.map((node) => (
                <TreeRow
                  key={node.path}
                  node={node}
                  depth={0}
                  expandedFolders={ui.expandedFolders}
                  selectedPath={selectedPath}
                  onToggleFolder={(path) => toggleFolder(projectId, path)}
                  onSelectFile={(path) => selectFile(projectId, path)}
                />
              ))
            )}
          </div>
        )}

        {/* Content pane */}
        <div className="flex-1 min-w-0 flex flex-col">
          {selectedPath !== null && (
            <div
              // R126-3e: the content path strip = the in-flow chrome shade.
              className="shrink-0 flex items-center gap-1.5 px-2.5 h-7 border-b border-clay-rim bg-header-surface font-mono text-[10px] truncate"
              style={{
                color: styles.textSecondary,
              }}
              title={selectedPath}
            >
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: fileColor }} aria-hidden />
              <span className="truncate">{selectedPath}</span>
            </div>
          )}
          <div ref={contentScrollRef} className="flex-1 min-h-0 overflow-y-auto auto-scroll">
            {selectedPath === null ? (
              <div className="h-full grid place-items-center px-4 text-center">
                <div className="text-[11px] leading-relaxed" style={{ color: styles.textTertiary }}>
                  Select a file in the tree
                  <br />
                  to preview its content here.
                </div>
              </div>
            ) : fileQuery.isLoading ? (
              <div className="px-2.5 py-2 text-[11px] font-mono" style={{ color: styles.textTertiary }}>
                loading…
              </div>
            ) : fileQuery.isError ? (
              <ErrorRetry
                message={
                  fileQuery.error instanceof Error
                    ? fileQuery.error.message
                    : "Failed to load the file."
                }
                onRetry={() => void fileQuery.refetch()}
              />
            ) : isMarkdown(selectedPath) ? (
              <div className="px-2.5 py-2.5">
                {/* R99-A: pass the project through so markdown links in the
                    preview route through the central link router (in-app
                    browser by default), same as the file-viewer tab. */}
                <Markdown content={content} projectId={projectId} />
              </div>
            ) : (
              <pre className="p-2 font-mono text-[11px] leading-[1.6]">
                {content.split("\n").map((line, idx) => (
                  <div key={idx} className="flex">
                    <span
                      className="w-7 shrink-0 text-right pr-2 select-none font-mono text-[10px] leading-[1.6]"
                      style={{ color: styles.textTertiary }}
                    >
                      {idx + 1}
                    </span>
                    <code className="flex-1 whitespace-pre-wrap break-words" style={{ color: styles.text }}>
                      {highlightLine(line).map((tok, ti) => (
                        <span key={ti} style={tok.color ? { color: tok.color } : undefined}>
                          {tok.text}
                        </span>
                      ))}
                      {line === "" ? " " : null}
                    </code>
                  </div>
                ))}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
