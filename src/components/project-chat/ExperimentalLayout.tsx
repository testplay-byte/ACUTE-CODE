import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { GripHorizontal, Maximize2, Minus } from "lucide-react";
import { withAlpha } from "../dashboard/helpers";
import {
  useProjectChatStore,
  type FreeformPanel,
} from "../../lib/project-chat-store";
import { useThemeStyles } from "../../lib/use-theme-styles";
import type { Project } from "../../lib/api";
import { AgentChatPanel } from "./AgentChatPanel";
import { CodeView } from "./CodeView";
import { ExplorerPanel } from "./panels/ExplorerPanel";
import { TodoPanel } from "./panels/TodoPanel";

/**
 * Demo ExperimentalLayout ported 1:1 (freeform draggable/resizable/minimizable
 * windows, z-order on mousedown, container clamping) — but every window hosts
 * the REAL live panel instead of the demo's mock views:
 * sidebar → ExplorerPanel · code → CodeView · chat → AgentChatPanel ·
 * todo → TodoPanel.
 */

const MIN_SIZE = 120;
const TITLE_BAR_H = 40;

type ResizeEdge = "left" | "right" | "bottom" | "bottom-left" | "bottom-right";

function FreeformWindow({
  panel,
  containerRef,
  project,
}: {
  panel: FreeformPanel;
  containerRef: React.RefObject<HTMLDivElement | null>;
  project: Project;
}) {
  const styles = useThemeStyles();
  const updateFreeformPanel = useProjectChatStore((s) => s.updateFreeformPanel);
  const bringToFront = useProjectChatStore((s) => s.bringToFront);
  const [isDragging, setIsDragging] = useState(false);
  const [activeResize, setActiveResize] = useState<ResizeEdge | null>(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0, px: 0, py: 0 });

  const raise = useCallback(() => bringToFront(panel.id), [bringToFront, panel.id]);

  const handleDragStart = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, input, a, [contenteditable], pre, [data-resize]")) return;
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    setIsDragging(true);
    dragOffset.current = { x: e.clientX - rect.left - panel.x, y: e.clientY - rect.top - panel.y };
    raise();
  };

  const handleResizeStart = (e: React.MouseEvent, edge: ResizeEdge) => {
    e.preventDefault();
    e.stopPropagation();
    setActiveResize(edge);
    resizeStart.current = {
      x: e.clientX,
      y: e.clientY,
      w: panel.width,
      h: panel.minimized ? TITLE_BAR_H : panel.height,
      px: panel.x,
      py: panel.y,
    };
    raise();
  };

  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const maxX = Math.max(0, rect.width - panel.width);
      const maxY = Math.max(0, rect.height - (panel.minimized ? TITLE_BAR_H : panel.height));
      updateFreeformPanel(panel.id, {
        x: Math.max(0, Math.min(maxX, e.clientX - rect.left - dragOffset.current.x)),
        y: Math.max(0, Math.min(maxY, e.clientY - rect.top - dragOffset.current.y)),
      });
    };
    const handleUp = () => setIsDragging(false);
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [isDragging, panel.id, panel.width, panel.height, panel.minimized, updateFreeformPanel, containerRef]);

  useEffect(() => {
    if (!activeResize) return;
    const container = containerRef.current;
    if (!container) return;
    const handleMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const dx = e.clientX - resizeStart.current.x;
      const dy = e.clientY - resizeStart.current.y;
      const s = resizeStart.current;
      let newX = s.px;
      let newY = s.py;
      let newW = s.w;
      let newH = s.h;

      if (activeResize === "left" || activeResize === "bottom-left") {
        const proposedW = s.w - dx;
        if (proposedW >= MIN_SIZE) {
          newW = proposedW;
          newX = s.px + dx;
        } else {
          newW = MIN_SIZE;
          newX = s.px + (s.w - MIN_SIZE);
        }
      }
      if (activeResize === "right" || activeResize === "bottom-right") {
        newW = Math.max(MIN_SIZE, s.w + dx);
      }
      if (activeResize === "bottom" || activeResize === "bottom-left" || activeResize === "bottom-right") {
        newH = Math.max(MIN_SIZE, s.h + dy);
      }

      const maxX = Math.max(0, rect.width - newW);
      const maxY = Math.max(0, rect.height - newH);
      newX = Math.max(0, Math.min(maxX, newX));
      newY = Math.max(0, Math.min(maxY, newY));

      updateFreeformPanel(panel.id, { x: newX, y: newY, width: newW, height: newH });
    };
    const handleUp = () => setActiveResize(null);
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [activeResize, panel.id, updateFreeformPanel, containerRef]);

  let content: ReactNode = null;
  if (panel.id === "sidebar") content = <ExplorerPanel project={project} />;
  if (panel.id === "code") content = <CodeView projectId={project.id} />;
  if (panel.id === "chat")
    content = <AgentChatPanel projectId={project.id} project={project} compact />;
  if (panel.id === "todo") content = <TodoPanel projectId={project.id} mission={project.name} />;

  const displayHeight = panel.minimized ? TITLE_BAR_H : panel.height;

  return (
    <div
      className="absolute rounded-2xl border overflow-hidden flex flex-col"
      style={{
        left: panel.x,
        top: panel.y,
        width: panel.width,
        height: displayHeight,
        zIndex: panel.zIndex,
        background: styles.card,
        borderColor: isDragging ? styles.accent : styles.border,
        boxShadow: isDragging ? styles.bentoShadow : styles.softShadow,
        transition: panel.minimized ? `height 0.25s cubic-bezier(0.25,0.1,0.25,1)` : "none",
      }}
      onMouseDown={raise}
    >
      {/* Title bar */}
      <div
        className="shrink-0 h-10 flex items-center justify-between px-3 border-b cursor-grab active:cursor-grabbing"
        style={{ borderColor: styles.border, background: styles.inputBg }}
        onMouseDown={handleDragStart}
      >
        <div className="flex items-center gap-2">
          <GripHorizontal size={12} style={{ color: styles.textSecondary, opacity: 0.4 }} />
          <span className="text-[12px] font-semibold" style={{ color: styles.text }}>
            {panel.title}
          </span>
        </div>
        <button
          className="w-6 h-6 rounded-lg grid place-items-center transition-colors"
          style={{ color: styles.textSecondary }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = withAlpha(styles.accent, 0.08);
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
          onClick={(e) => {
            e.stopPropagation();
            updateFreeformPanel(panel.id, { minimized: !panel.minimized });
          }}
          aria-label={panel.minimized ? "Restore panel" : "Minimize panel"}
        >
          {panel.minimized ? <Maximize2 size={11} /> : <Minus size={11} />}
        </button>
      </div>

      {!panel.minimized && <div className="flex-1 overflow-auto min-h-0 auto-scroll">{content}</div>}

      {/* Resize handles (demo-exact five) */}
      {!panel.minimized && (
        <>
          <div
            data-resize="left"
            className="absolute top-10 bottom-0 w-[6px] left-0 cursor-ew-resize z-10"
            onMouseDown={(e) => handleResizeStart(e, "left")}
          />
          <div
            data-resize="right"
            className="absolute top-10 bottom-0 w-[6px] right-0 cursor-ew-resize z-10"
            onMouseDown={(e) => handleResizeStart(e, "right")}
          />
          <div
            data-resize="bottom"
            className="absolute left-0 right-0 h-[6px] bottom-0 cursor-ns-resize z-10"
            onMouseDown={(e) => handleResizeStart(e, "bottom")}
          />
          <div
            data-resize="bl"
            className="absolute bottom-0 left-0 w-4 h-4 cursor-nesw-resize z-20"
            onMouseDown={(e) => handleResizeStart(e, "bottom-left")}
          />
          <div
            data-resize="br"
            className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize z-20"
            onMouseDown={(e) => handleResizeStart(e, "bottom-right")}
          />
        </>
      )}
    </div>
  );
}

export function ExperimentalLayout({ project }: { project: Project }) {
  const styles = useThemeStyles();
  const freeformPanels = useProjectChatStore((s) => s.freeformPanels);
  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={containerRef} className="relative flex-1 min-h-0 w-full overflow-hidden" style={{ background: styles.bg }}>
      <div
        className="absolute top-4 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-2.5 h-9 px-5 rounded-full border font-mono text-[11px]"
        style={{
          background: styles.card,
          borderColor: styles.border,
          color: styles.accent,
          boxShadow: styles.softShadow,
        }}
      >
        <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: styles.accent }} />
        {"Experimental Mode — Drag & resize any panel"}
      </div>

      {freeformPanels.map((panel) => (
        <FreeformWindow key={panel.id} panel={panel} containerRef={containerRef} project={project} />
      ))}
    </div>
  );
}
