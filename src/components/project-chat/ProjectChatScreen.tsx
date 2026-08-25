import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { motion } from "framer-motion";
import { ChevronRight, Files } from "lucide-react";
import { Link, useParams } from "react-router";
import { useProjects } from "../../hooks/use-projects";
import { ease } from "../../lib/motion";
import { useProjectChatStore } from "../../lib/project-chat-store";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { AgentChatPanel } from "./AgentChatPanel";
import { ChatFocusLayout } from "./ChatFocusLayout";
import { CodeView } from "./CodeView";
import { ExperimentalLayout } from "./ExperimentalLayout";
import { LeftSidebar } from "./LeftSidebar";

/**
 * Project-chat screen (M3 + round-14 demo parity): the demo's FULL TopBar
 * (hamburger: agent picker + file search + theme grid; Code/Experimental/
 * dark toggles) over NormalLayout — resizable Explorer / Code / Chat columns
 * driven by the persisted project-chat store — or the freeform
 * ExperimentalLayout when experimental mode is on.
 * Ported from design/demos/project-chat/src/components/project-chat/.
 */

/**
 * Gap resize strip between panels (demo GapHandle, verbatim) plus keyboard
 * access: Arrow keys step ±16px, Home/End clamp to the min/max via the store's
 * clamping setters.
 */
function GapHandle({ onResize }: { onResize: (delta: number) => void }) {
  const styles = useThemeStyles();
  const isResizing = useRef(false);
  const startX = useRef(0);

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

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onResize(-16);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onResize(16);
    } else if (e.key === "Home") {
      e.preventDefault();
      // Overshoot delta: the store setter clamps to the panel minimum.
      onResize(-100_000);
    } else if (e.key === "End") {
      e.preventDefault();
      onResize(100_000);
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      tabIndex={0}
      className="w-[5px] shrink-0 cursor-ew-resize relative group flex items-center justify-center outline-none"
      onMouseDown={(e) => {
        e.preventDefault();
        isResizing.current = true;
        startX.current = e.clientX;
        document.body.style.cursor = "ew-resize";
        document.body.style.userSelect = "none";
      }}
      onKeyDown={onKeyDown}
      // Focus ring: 2px accent (mouse + keyboard focus both show it — the
      // strip is a drag affordance, so this is the a11y signal, not decoration).
      onFocus={(e) => {
        e.currentTarget.style.outline = `2px solid ${styles.accent}`;
      }}
      onBlur={(e) => {
        e.currentTarget.style.outline = "none";
      }}
    >
      <div
        className="absolute inset-y-2 w-[2px] rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-200"
        style={{ background: styles.border }}
      />
    </div>
  );
}

/** Demo CollapsedSidebar rail (w-12 card strip with expand + explorer buttons). */
function CollapsedSidebar({ onExpand }: { onExpand: () => void }) {
  const styles = useThemeStyles();
  const hoverBg = (e: ReactMouseEvent<HTMLButtonElement>, on: boolean) => {
    e.currentTarget.style.background = on ? styles.subtleHover : styles.inputBg;
  };
  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 48, opacity: 1 }}
      transition={{ duration: 0.25, ease }}
      className="shrink-0 flex flex-col items-center py-3 gap-1.5 overflow-hidden rounded-2xl border"
      style={{ backgroundColor: styles.card, borderColor: styles.border }}
    >
      <button
        onClick={onExpand}
        aria-label="Expand explorer"
        title="Expand sidebar"
        className="w-9 h-9 rounded-xl grid place-items-center transition-colors"
        style={{ color: styles.textSecondary, background: styles.inputBg }}
        onMouseEnter={(e) => hoverBg(e, true)}
        onMouseLeave={(e) => hoverBg(e, false)}
      >
        <ChevronRight size={16} />
      </button>
      <button
        onClick={onExpand}
        aria-label="Open explorer"
        title="Explorer"
        className="w-9 h-9 rounded-xl grid place-items-center transition-colors"
        style={{ color: styles.textSecondary, background: styles.inputBg }}
        onMouseEnter={(e) => hoverBg(e, true)}
        onMouseLeave={(e) => hoverBg(e, false)}
      >
        <Files size={16} />
      </button>
    </motion.div>
  );
}

export default function ProjectChatScreen() {
  const styles = useThemeStyles();
  const { id } = useParams<"id">();
  const projectsQuery = useProjects();
  const project = projectsQuery.data?.find((p) => p.id === id) ?? null;



  const sidebarOpen = useProjectChatStore((s) => s.sidebarOpen);
  const codeVisible = useProjectChatStore((s) => s.codeVisible);
  const chatWidth = useProjectChatStore((s) => s.chatWidth);
  const experimentalMode = useProjectChatStore((s) => s.experimentalMode);
  const chatFocusMode = useProjectChatStore((s) => s.chatFocusMode);
  const setSidebarOpen = useProjectChatStore((s) => s.setSidebarOpen);



  // getState() keeps every mousemove delta fresh without re-baselining closures.
  const handleSidebarResize = useCallback((delta: number) => {
    const s = useProjectChatStore.getState();
    s.setSidebarWidth(s.sidebarWidth + delta);
  }, []);
  const handleChatResize = useCallback((delta: number) => {
    // The chat's drag handle sits on the chat's LEFT edge: dragging right
    // SHRINKS the chat (and grows the code pane) — the owner-reported bug was
    // this sign being inverted (right moved it left).
    const s = useProjectChatStore.getState();
    s.setChatWidth(s.chatWidth - delta);
  }, []);

  if (projectsQuery.isLoading) {
    return (
      <div className="h-full grid place-items-center" style={{ backgroundColor: styles.bg }}>
        <span className="text-[13px]" style={{ color: styles.textSecondary }}>
          Loading project…
        </span>
      </div>
    );
  }

  if (!id || !project) {
    return (
      <div className="h-full grid place-items-center" style={{ backgroundColor: styles.bg }}>
        <div className="text-[13px]" style={{ color: styles.textSecondary }}>
          Project not found ·{" "}
          <Link to="/" style={{ color: styles.accent }}>
            back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  const onlyChat = !sidebarOpen && !codeVisible;

  // Round-28 WS-D1: chatFocusMode (default true on chat routes) shows ONLY the
  // chat — left/center-left aligned, no Explorer/Code panels. The ChatTopBar's
  // "Show panels" toggle flips this false → 3-panel layout below. Experimental
  // mode still takes precedence (it's the freeform windows view).
  if (!experimentalMode && chatFocusMode) {
    return <ChatFocusLayout project={project} />;
  }

  return (
    <motion.div
      className="h-full min-h-0 flex flex-col gap-[3px]"
      style={{ backgroundColor: styles.bg }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3, ease }}
    >
      {/* Demo TopBar (round-14 parity): hamburger menu + toggles */}

      {experimentalMode ? (
        <ExperimentalLayout project={project} />
      ) : (
        <div
          className="flex-1 flex min-h-0 overflow-hidden"
        >
          {!onlyChat &&
            (sidebarOpen ? (
              <>
                <LeftSidebar project={project} />
                <GapHandle onResize={handleSidebarResize} />
              </>
            ) : (
              <CollapsedSidebar onExpand={() => setSidebarOpen(true)} />
            ))}

          {codeVisible && (
            <>
              <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
                <CodeView projectId={project.id} />
              </div>
              <GapHandle onResize={handleChatResize} />
            </>
          )}

          {/* ROUND-37 (owner: "a lot of the right side area was completely
              empty"): when the Code panel is hidden the chat FILLS the freed
              space instead of staying a fixed-width column with dead space
              to its right. */}
          <div
            className={codeVisible ? "shrink-0 overflow-hidden rounded-2xl" : "flex-1 min-w-0 overflow-hidden rounded-2xl"}
            style={codeVisible ? { width: chatWidth } : undefined}
          >
            <AgentChatPanel projectId={project.id} project={project} />
          </div>
        </div>
      )}
    </motion.div>
  );
}
