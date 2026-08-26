import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { ease } from "../../lib/motion";
import { AgentChatPanel } from "./AgentChatPanel";
import { RightSidebar } from "../right-sidebar/RightSidebar";
import { useRightSidebarStore, stateKey } from "../../lib/right-sidebar-store";
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
 * - ROUND-41 (owner: "the sidebar will be different in each one of the
 *   sessions"): the right sidebar's per-session state is keyed by
 *   `${projectId}::${sessionId}`. setActiveSession is called whenever the
 *   active session id changes (resolved by useActiveSessionId from the URL
 *   ?session= param or the project's most-recent session).
 * - ROUND-42 (owner: "There should be a minimum width for the chat window.
 *   The chat window cannot be minimized or shrunk more than that. If it
 *   requires the screen display size then the other elements will be made
 *   smaller more than that. The right sidebar window will be made smaller
 *   automatically, smoothly"). The chat column now carries a hard MIN-WIDTH;
 *   the right sidebar's EFFECTIVE width is clamped against the measured
 *   container width (ResizeObserver) so on narrow screens the sidebar — never
 *   the chat — shrinks, smoothly (the width is a motion-animated value).
 *
 * - ROUND-43 (owner: "a lot of empty space on the right side of the chat
 *   window… it added a scroll bar at the bottom" + "the maximum width
 *   apparently does not get handled properly… It gets restricted"). Two
 *   measured root causes this round:
 *     (a) the R42 width-cap kept a 280px FLOOR, so once the container fell
 *         below chat-floor(480)+handle+gaps+280 ≈ 771px the three children
 *         could no longer fit — the sidebar was silently clipped off-screen
 *         (its collapse button unreachable) and the row overflowed. The cap
 *         now has NO floor: the sidebar keeps shrinking (down to its
 *         collapse-button sliver) exactly as the R42 directive describes.
 *     (b) the dead right side lived in AgentChatPanel (the panel root
 *         shrink-to-fit its content instead of filling — 455px panel inside a
 *         1781px card at a 2560px window) — fixed there.
 */

/** The chat window's floor. Below this the RIGHT SIDEBAR gives way instead. */
const CHAT_MIN_WIDTH = 480;
/** The resize handle's footprint. */
const HANDLE_WIDTH = 5;
/** The gap between the chat card and the sidebar card. */
const SEAM_GAP = 3;
/** Fixed chrome around the chat column: the handle + the two seam gaps. */
const CHROME_WIDTH = HANDLE_WIDTH + SEAM_GAP * 2; // 11px
/** The narrowest the right sidebar may render: its header's collapse-button
 * column (36px, same as the collapsed rail). Below this nothing useful is
 * visible anyway — better to keep the collapse affordance on-screen than to
 * clip it. */
const SIDEBAR_SLIVER_WIDTH = 36;

/** ROUND-43: the render-time cap on the right sidebar's width for a measured
 * container. Deliberately NO floor (the R42 `Math.max(280, …)` here is what
 * overflowed containers narrower than 771px): whatever is left after the
 * chat's floor + chrome is ALL the sidebar gets — 0 when nothing is left.
 * Invariant: sidebarWidthCap(w) + CHAT_MIN_WIDTH + CHROME_WIDTH ≤ w. */
export function sidebarWidthCap(containerWidth: number): number {
  return Math.max(0, containerWidth - CHAT_MIN_WIDTH - CHROME_WIDTH);
}

/** ROUND-43: the chat column's min-width. Hard 480px whenever that fits at
 * all (the sidebar yields first — R42). It softens ONLY when the container
 * is so narrow that even 480 + chrome + the sidebar's collapse sliver cannot
 * fit (≲527px container ≈ ≲830px window with the app sidebar open): physics
 * wins rather than forcing a horizontal overflow. Never drops below 160px.
 * Invariant: chatMinWidthFor(w) + CHROME_WIDTH + SIDEBAR_SLIVER_WIDTH ≤ w. */
export function chatMinWidthFor(containerWidth: number | null): number {
  if (containerWidth === null) return CHAT_MIN_WIDTH;
  return Math.min(
    CHAT_MIN_WIDTH,
    Math.max(160, Math.round(containerWidth - SIDEBAR_SLIVER_WIDTH - CHROME_WIDTH)),
  );
}

export function ChatFocusLayout({ project }: { project: Project }) {
  const styles = useThemeStyles();
  const setActiveProject = useRightSidebarStore((s) => s.setActiveProject);
  const setActiveSession = useRightSidebarStore((s) => s.setActiveSession);
  const sessionId = useActiveSessionId(project.id);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);

  // ROUND-42: measure the layout's own width so the right sidebar can be
  // clamped against the CHAT's minimum — on narrow windows the sidebar
  // smoothly yields space instead of squeezing the chat below its floor.
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    setContainerWidth(el.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  // Declare this project active in the right-sidebar store (so its
  // per-project slice is the one the sidebar renders). Idempotent.
  useEffect(() => {
    setActiveProject(project.id);
  }, [project.id, setActiveProject]);

  // ROUND-41: record the active session for this project. The store uses
  // it as the state-key suffix so switching sessions swaps the sidebar's
  // tabs/open/width/activeTab/terminal-scrollback atomically.
  useEffect(() => {
    setActiveSession(project.id, sessionId);
  }, [project.id, sessionId, setActiveSession]);

  // Resize handle for the right sidebar (drag left/right to grow/shrink).
  const isResizing = useRef(false);
  const startX = useRef(0);
  const onResize = useCallback((delta: number) => {
    const s = useRightSidebarStore.getState();
    const key = stateKey(project.id, s.activeSessionByProject[project.id] ?? null);
    const cur = s.byProject[key]?.width ?? 440;
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
      ref={containerRef}
      className="h-full min-h-0 flex"
      style={{ gap: SEAM_GAP }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3, ease }}
    >
      {/* The floating chat window — its own surface. ROUND-42: hard minimum
          width; when space runs out the RIGHT SIDEBAR shrinks (its effective
          width is clamped below), never the chat. ROUND-43: the floor itself
          softens only when the container cannot even fit floor+chrome+sliver
          (see chatMinWidthFor) — the row can never force horizontal overflow. */}
      <div
        className="flex-1 min-h-0 flex rounded-[24px] border-[1.5px] overflow-hidden"
        style={{
          minWidth: chatMinWidthFor(containerWidth),
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

      {/* Resize handle between chat and the right sidebar. ROUND-42: also
          keyboard-resizable (Arrow keys ±16px) for accessibility. */}
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
          document.body.style.cursor = "ew-resize";
          document.body.style.userSelect = "none";
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            onResize(16);
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            onResize(-16);
          }
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

      {/* The right sidebar (Files / Terminal / Browser / Sub-agents).
          ROUND-42: `maxWidth` caps the sidebar's stored width against the
          measured container so the chat never drops below CHAT_MIN_WIDTH —
          on narrow windows the sidebar smoothly auto-shrinks instead.
          ROUND-43: NO 280px floor on the cap — at large windows the sidebar
          keeps its natural (stored) width and the CHAT absorbs the extra
          space; when the window genuinely can't fit chat-floor + sidebar the
          cap keeps dropping so the row always fits (the sidebar's own render
          floor is its 36px collapse sliver, inside RightSidebar). */}
      <RightSidebar
        projectId={project.id}
        sessionId={sessionId}
        maxWidth={
          containerWidth === null ? undefined : sidebarWidthCap(containerWidth)
        }
      />
    </motion.div>
  );
}
