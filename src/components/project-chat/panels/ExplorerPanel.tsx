import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Braces, ChevronRight, FileCode2, FileText, Files, FolderOpen } from "lucide-react";
import { useProjectTree } from "../../../hooks/use-projects";
import { type Project, type TreeNode } from "../../../lib/api";
import { ease } from "../../../lib/motion";
import { useProjectChatStore } from "../../../lib/project-chat-store";
import { SEMANTIC_COLORS } from "../../../lib/semantics";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import { withAlpha } from "../../dashboard/helpers";
import { getFileColor } from "../highlight";

/**
 * File tree from GET /projects/:id/tree (demo ExplorerPanel port). Folder
 * expansion state persists in the project-chat store keyed by root-relative
 * TreeNode.path; on the first ever load all top-level folders start expanded.
 */

function FileIcon({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const color = getFileColor(name);
  if (ext === "json") return <Braces size={14} style={{ color }} className="shrink-0" />;
  if (ext === "md" || ext === "css") return <FileText size={14} style={{ color }} className="shrink-0" />;
  return <FileCode2 size={14} style={{ color }} className="shrink-0" />;
}

function FileTreeItem({ node, depth = 0 }: { node: TreeNode; depth?: number }) {
  const styles = useThemeStyles();
  const selectedFileId = useProjectChatStore((s) => s.selectedFileId);
  const selectFile = useProjectChatStore((s) => s.selectFile);
  const expandedFolders = useProjectChatStore((s) => s.expandedFolders);
  const toggleFolder = useProjectChatStore((s) => s.toggleFolder);
  const isFolder = node.type === "folder";
  const isExpanded = expandedFolders.includes(node.path);
  const isSelected = selectedFileId === node.path;

  return (
    <div>
      <button
        className="w-full flex items-center gap-2 h-[34px] px-2 text-left transition-colors rounded-lg"
        style={{
          paddingLeft: `${depth * 14 + 8}px`,
          background: isSelected
            ? withAlpha(styles.accent, styles.isDark ? 0.09 : 0.08)
            : "transparent",
        }}
        onClick={() => {
          if (isFolder) toggleFolder(node.path);
          else selectFile(node.path);
        }}
        onMouseEnter={(e) => {
          if (!isSelected)
            e.currentTarget.style.background = styles.isDark ? styles.inputBg : styles.subtleHover;
        }}
        onMouseLeave={(e) => {
          if (!isSelected) e.currentTarget.style.background = "transparent";
        }}
      >
        {isFolder ? (
          <motion.span
            animate={{ rotate: isExpanded ? 90 : 0 }}
            transition={{ duration: 0.15 }}
            className="shrink-0"
          >
            <ChevronRight size={12} style={{ color: styles.textSecondary }} />
          </motion.span>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        {isFolder ? (
          <FolderOpen
            size={14}
            style={{ color: isExpanded ? styles.accent : styles.textSecondary }}
            className="shrink-0"
          />
        ) : (
          <FileIcon name={node.name} />
        )}
        <span
          className="text-[12.5px] font-mono truncate"
          style={{
            color: isSelected ? styles.text : styles.textSecondary,
            fontWeight: isSelected ? 500 : 400,
          }}
        >
          {node.name}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {isFolder && isExpanded && node.children && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease }}
            style={{ overflow: "hidden" }}
          >
            {node.children.map((child) => (
              <FileTreeItem key={child.path} node={child} depth={depth + 1} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function ExplorerPanel({ project }: { project: Project }) {
  const styles = useThemeStyles();
  const treeQuery = useProjectTree(project.id);

  // One-time seed: with no persisted expansions, expand all top-level folders.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !treeQuery.data) return;
    seeded.current = true;
    const { expandedFolders } = useProjectChatStore.getState();
    if (expandedFolders.length > 0) return;
    const topLevel = treeQuery.data.tree
      .filter((n) => n.type === "folder")
      .map((n) => n.path);
    if (topLevel.length > 0) useProjectChatStore.setState({ expandedFolders: topLevel });
  }, [treeQuery.data]);

  return (
    <div>
      {/* Project name */}
      <div className="px-3 pb-2 flex items-center gap-2">
        <div
          className="w-5 h-5 rounded-md grid place-items-center shrink-0"
          style={{ backgroundColor: project.color }}
        >
          {/* white icon reads on the project's own color chip, not a theme surface */}
          <Files size={11} color="#fff" />
        </div>
        <span className="text-[11px] font-medium truncate" style={{ color: styles.text }}>
          {project.name}
        </span>
      </div>

      <div className="px-1.5 pb-2">
        {treeQuery.isLoading ? (
          <div>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-[34px] rounded-lg animate-pulse mb-1"
                style={{ backgroundColor: styles.subtle }}
              />
            ))}
          </div>
        ) : treeQuery.isError ? (
          <div className="px-2 py-3 text-[12px]" style={{ color: SEMANTIC_COLORS.danger }}>
            {treeQuery.error instanceof Error ? treeQuery.error.message : "Failed to load tree"}{" "}
            <button
              onClick={() => void treeQuery.refetch()}
              className="underline"
              style={{ color: styles.accent }}
            >
              Retry
            </button>
          </div>
        ) : (
          treeQuery.data?.tree.map((node) => <FileTreeItem key={node.path} node={node} depth={0} />)
        )}
      </div>
    </div>
  );
}
