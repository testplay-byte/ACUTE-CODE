import { useCallback, useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { ease } from "../../lib/motion";
import { AgentChatPanel } from "./AgentChatPanel";
import { RightSidebar } from "../right-sidebar/RightSidebar";
import { useRightSidebarStore } from "../../lib/right-sidebar-store";
import { useActiveSessionId } from "../../hooks/use-active-session";
import type { Project } from "../../lib/api";

/**
 * ChatFocusLayout (Round 32 redesign per the owner-approved design
 * Acute-Ui-Screens.html Frame 5 — "THE MONEY SCREEN"):
 *
 * - NO TOP NAVIGATION BAR (owner R32 directive). The chat panel's own slim
 *   header carries the essential controls.
 * - The chat window is its own FLOATING PANEL (radius 24, border, soft shadow)
 *   visually separate from the sidebar.
 * - ROUND-38 (owner: "a right side bar a menu… fills the previously-empty
 *   right side"): the layout is now [chat (flex-1)] [resize handle] [right
 *   sidebar]. The right sidebar hosts the Files / Terminal / Browser /
 *   Sub-agents tabs. Per-project state lives in right-sidebar-store.
 */
export function ChatFocusLayout({ project }: { project: Project }) {
  const styles = useThemeStyles();
  const setActiveProject = useRightSidebarStore((s) => s.setActiveProject);
  const sessionId = useActiveSessionId(project.id);

  // Declare this project active in the right-sidebar store (so its per-project
  // slice is the one the sidebar renders). Idempotent.
  useEffect(() => {
    setActiveProject(project.id);
  }, [project.id, setActiveProject]);

  // Resize handle for the right sidebar (drag left/right to grow/shrink).
  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const onResize = useCallback((delta: number) => {
    const s = useRightSidebarStore.getState();
    const cur = s.byProject[project.id]?.width ?? 440;
    // Dragging LEFT (negative delta) GROWS the sidebar (it's on the right edge
    // of the chat — moving the handle left eats into the chat).
    s.setWidth(project.id, cur - delta);
  }, [project.id]);
  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const delta = e.clientX - startX.current;
      onResize(delta);
      startX.current = e.clientX;
    };
    const handleUp = () => {
      isResizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [onResize]);

  return (
    <motion.div
      className="h-full min-h-0 flex gap-[3px]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3, ease }}
    >
      {/* The floating chat window — its own surface. */}
      <div
        className="flex-1 min-h-0 flex rounded-[24px] border-[1.5px] overflow-hidden"
        style={{
          backgroundColor: styles.card,
          borderColor: styles.border,
          boxShadow: styles.softShadow,
        }}
      >
        {/* ROUND-40 (owner: "chat window is capped and does not expand to
            the full available width"). max-w-[1500px] → max-w-none so the
            chat fills its column edge-to-edge. justify-center is kept — it
            is a no-op once the child is full-width, but removing it would
            change nothing and the parent contract (center an inner block)
            is preserved. */}
        <div className="flex-1 min-h-0 flex justify-center">
          <div className="w-full max-w-none min-h-0 flex">
            {/* ROUND-38: key by project id so a project switch FULLY remounts
                the panel — no live-stream/pending/echo state can bleed from
                project A into project B (owner: sessions were mixing). */}
            <AgentChatPanel key={project.id} projectId={project.id} project={project} />
          </div>
        </div>
      </div>

      {/* Resize handle between chat and the right sidebar. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize right sidebar"
        tabIndex={0}
        className="w-[5px] shrink-0 cursor-ew-resize relative group flex items-center justify-center outline-none rounded-full hover:opacity-100 opacity-0 transition-opacity"
        style={{ background: "transparent" }}
        onMouseDown={(e) => {
          e.preventDefault();
          isResizing.current = true;
          startX.current = e.clientX;
          startWidth.current = useRightSidebarStore.getState().byProject[project.id]?.width ?? 440;
          document.body.style.cursor = "ew-resize";
          document.body.style.userSelect = "none";
        }}
        onFocus={(e) => {
          e.currentTarget.style.background = styles.border;
        }}
        onBlur={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = styles.border;
        }}
        onMouseLeave={(e) => {
          if (!isResizing.current) e.currentTarget.style.background = "transparent";
        }}
      >
        <div
          className="absolute inset-y-2 w-[2px] rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-200"
          style={{ background: styles.border }}
        />
      </div>

      {/* The right sidebar (Files / Terminal / Browser / Sub-agents). */}
      <RightSidebar projectId={project.id} sessionId={sessionId} />
    </motion.div>
  );
}
