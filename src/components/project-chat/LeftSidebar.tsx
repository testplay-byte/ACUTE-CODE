import { useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckSquare, ChevronLeft, ChevronRight, Code2, Files } from "lucide-react";
import type { Project } from "../../lib/api";
import { ease } from "../../lib/motion";
import { useProjectChatStore } from "../../lib/project-chat-store";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useScrollFade } from "../../lib/useScrollFade";
import { withAlpha } from "../dashboard/helpers";
import { ExplorerPanel } from "./panels/ExplorerPanel";
import { TodoPanel } from "./panels/TodoPanel";

/**
 * Expanded left sidebar (demo LeftSidebar port): EXPLORER section (live tree)
 * + the demo's TO-DO section (round-14 parity — per-project local tasks in
 * the persisted store until Phase-3 task events). Width animates from the
 * persisted store; the collapsed rail lives in ProjectChatScreen.
 */
export function LeftSidebar({ project }: { project: Project }) {
  const styles = useThemeStyles();
  const sidebarWidth = useProjectChatStore((s) => s.sidebarWidth);
  const setSidebarOpen = useProjectChatStore((s) => s.setSidebarOpen);
  const codeVisible = useProjectChatStore((s) => s.codeVisible);
  const setCodeVisible = useProjectChatStore((s) => s.setCodeVisible);
  const collapsedPanels = useProjectChatStore((s) => s.collapsedPanels);
  const togglePanel = useProjectChatStore((s) => s.togglePanel);
  const explorerCollapsed = collapsedPanels.includes("explorer");
  const todoCollapsed = collapsedPanels.includes("todo");
  const scrollRef = useRef<HTMLDivElement>(null);
  const todoScrollRef = useRef<HTMLDivElement>(null);

  useScrollFade(scrollRef);
  useScrollFade(todoScrollRef);

  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: sidebarWidth, opacity: 1 }}
      transition={{ duration: 0.25, ease }}
      className="shrink-0 flex flex-col overflow-hidden rounded-2xl"
      style={{ backgroundColor: styles.card }}
    >
      {/* Sidebar header: project name + code toggle + minimize */}
      <div className="shrink-0 flex items-center justify-between px-2 h-9 gap-1">
        <span
          className="text-[11px] font-semibold uppercase tracking-[0.1em] px-1 truncate"
          style={{ color: styles.textSecondary }}
        >
          {project.name}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setCodeVisible(!codeVisible)}
            aria-pressed={codeVisible}
            aria-label="Toggle code panel"
            title={codeVisible ? "Hide code panel" : "Show code panel"}
            // R100-D (TOKENS §6): the hover wash is the CSS class
            // (hover:bg-hover), gated to the UNpressed state exactly as the
            // old JS handler was; the hardcoded demo-era accent rgba rides
            // withAlpha(styles.accent, 0.08) — the token spelling.
            className="w-7 h-7 rounded-lg grid place-items-center transition-colors hover:bg-hover"
            style={{
              color: codeVisible ? styles.accent : styles.textSecondary,
              background: codeVisible ? withAlpha(styles.accent, 0.08) : undefined,
            }}
          >
            <Code2 size={13} />
          </button>
          <button
            onClick={() => setSidebarOpen(false)}
            aria-label="Collapse explorer"
            title="Hide explorer"
            className="w-7 h-7 rounded-lg grid place-items-center transition-colors hover:bg-hover"
            style={{ color: styles.textSecondary }}
          >
            <ChevronLeft size={13} />
          </button>
        </div>
      </div>

      {/* Explorer section */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <button
          className="shrink-0 w-full flex items-center gap-2 px-3 h-9 transition-colors"
          style={{ borderBottom: explorerCollapsed ? "none" : `1px solid ${styles.border}` }}
          onClick={() => togglePanel("explorer")}
          aria-expanded={!explorerCollapsed}
        >
          <Files size={14} style={{ color: styles.accent }} />
          <span
            className="text-[10px] font-semibold uppercase tracking-[0.1em]"
            style={{ color: styles.textSecondary }}
          >
            Explorer
          </span>
          <span className="flex-1" />
          <motion.span
            animate={{ rotate: explorerCollapsed ? 0 : 90 }}
            transition={{ duration: 0.15 }}
            className="shrink-0"
          >
            <ChevronRight size={12} style={{ color: styles.textSecondary }} />
          </motion.span>
        </button>

        <AnimatePresence initial={false}>
          {!explorerCollapsed && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease }}
              className="flex-1 min-h-0 overflow-hidden"
            >
              <div ref={scrollRef} className="h-full overflow-y-auto auto-scroll">
                <ExplorerPanel project={project} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* To-Do section (demo parity, round-14): collapsible, own scroll */}
      <div className="shrink-0 flex flex-col overflow-hidden max-h-[45%] border-t" style={{ borderColor: styles.border }}>
        <button
          className="shrink-0 w-full flex items-center gap-2 px-3 h-9 transition-colors"
          style={{ borderBottom: todoCollapsed ? "none" : `1px solid ${styles.border}` }}
          onClick={() => togglePanel("todo")}
          aria-expanded={!todoCollapsed}
        >
          <CheckSquare size={14} style={{ color: styles.accent }} />
          <span
            className="text-[10px] font-semibold uppercase tracking-[0.1em]"
            style={{ color: styles.textSecondary }}
          >
            To-Do
          </span>
          <span className="flex-1" />
          <motion.span animate={{ rotate: todoCollapsed ? 0 : 90 }} transition={{ duration: 0.15 }} className="shrink-0">
            <ChevronRight size={12} style={{ color: styles.textSecondary }} />
          </motion.span>
        </button>
        <AnimatePresence initial={false}>
          {!todoCollapsed && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease }}
              className="min-h-0 overflow-hidden"
            >
              <div ref={todoScrollRef} className="max-h-[240px] overflow-y-auto auto-scroll">
                <TodoPanel projectId={project.id} mission={project.name} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
