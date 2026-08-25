import { motion } from "framer-motion";
import { Bot, Files, Globe, PanelRightClose, Terminal } from "lucide-react";
import { useRightSidebarStore, type RightSidebarTab } from "../../lib/right-sidebar-store";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";
import { ease } from "../../lib/motion";
import { FileViewerPanel } from "./FileViewerPanel";
import { TerminalPanel } from "./TerminalPanel";
import { BrowserPanel } from "./BrowserPanel";
import { SubAgentsPanel } from "./SubAgentsPanel";

/**
 * ROUND-38 (owner: "a right side bar a menu… at the very top it will show the
 * tabs kind of view… for the sub agents, for the browser, for the codes"). A
 * tabbed right sidebar that FILLS the previously-empty right side of the chat
 * route: Files (code + markdown viewer), Terminal (command runner), Browser
 * (embedded webview + per-project history), Sub-agents (the child sessions'
 * prompt + actions). Per-project state lives in right-sidebar-store.
 *
 * Width animates; the GapHandle in ChatFocusLayout resizes it. Collapsing
 * leaves a thin rail with a reopen button.
 */
const TABS: Array<{ id: RightSidebarTab; label: string; icon: typeof Files }> = [
  { id: "files", label: "Files", icon: Files },
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "browser", label: "Browser", icon: Globe },
  { id: "subagents", label: "Sub-agents", icon: Bot },
];

export function RightSidebar({
  projectId,
  sessionId,
}: {
  projectId: string;
  /** The current PARENT session id (for the sub-agents list). null when none. */
  sessionId: string | null;
}) {
  const styles = useThemeStyles();
  const slice = useRightSidebarStore((s) => s.byProject[projectId]);
  const ensure = useRightSidebarStore((s) => s.ensure);
  const setTab = useRightSidebarStore((s) => s.setTab);
  const toggleOpen = useRightSidebarStore((s) => s.toggleOpen);
  // Make sure the project has a slice (idempotent).
  if (slice === undefined) ensure(projectId);
  const state = slice ?? useRightSidebarStore.getState().byProject[projectId];
  if (state === undefined) return null;
  const open = state.open;
  const activeTab = state.activeTab;
  const width = state.width;

  if (!open) {
    // Collapsed rail — a reopen button.
    return (
      <motion.button
        onClick={() => toggleOpen(projectId)}
        aria-label="Open right sidebar"
        title="Open right sidebar"
        initial={{ opacity: 0, width: 0 }}
        animate={{ opacity: 1, width: 36 }}
        transition={{ duration: 0.2, ease }}
        className="shrink-0 self-stretch rounded-2xl grid place-items-center transition-colors"
        style={{ background: styles.card, border: `1.5px solid ${styles.border}`, color: styles.textTertiary }}
        onMouseEnter={(e) => (e.currentTarget.style.background = styles.subtleHover)}
        onMouseLeave={(e) => (e.currentTarget.style.background = styles.card)}
      >
        <PanelRightClose size={14} className="rotate-180" />
      </motion.button>
    );
  }

  return (
    <motion.div
      initial={false}
      animate={{ width, opacity: 1 }}
      transition={{ duration: 0.2, ease }}
      className="shrink-0 flex flex-col overflow-hidden rounded-2xl"
      style={{ background: styles.card, border: `1.5px solid ${styles.border}` }}
    >
      {/* Tab header */}
      <div
        className="shrink-0 flex items-center gap-0.5 px-1.5 h-10 border-b"
        style={{ borderColor: styles.border }}
      >
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              onClick={() => setTab(projectId, id)}
              aria-current={active ? "page" : undefined}
              title={label}
              className="relative h-8 px-2.5 flex items-center gap-1.5 rounded-lg text-[11.5px] font-bold transition-colors"
              style={{
                color: active ? styles.text : styles.textTertiary,
                background: active ? withAlpha(styles.accent, 0.12) : "transparent",
              }}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.background = styles.subtleHover;
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.background = "transparent";
              }}
            >
              <Icon size={13} style={{ color: active ? styles.accent : undefined }} />
              <span className="hidden xl:inline">{label}</span>
              {active ? (
                <span
                  className="absolute left-1.5 right-1.5 bottom-0 h-[2px] rounded-full"
                  style={{ background: styles.accent }}
                  aria-hidden
                />
              ) : null}
            </button>
          );
        })}
        <span className="flex-1" />
        <button
          onClick={() => toggleOpen(projectId)}
          aria-label="Collapse right sidebar"
          title="Collapse"
          className="w-7 h-7 grid place-items-center rounded-lg transition-colors"
          style={{ color: styles.textTertiary }}
          onMouseEnter={(e) => (e.currentTarget.style.background = styles.subtleHover)}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <PanelRightClose size={13} />
        </button>
      </div>
      {/* Active panel */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === "files" ? (
          <FileViewerPanel projectId={projectId} />
        ) : activeTab === "terminal" ? (
          <TerminalPanel projectId={projectId} />
        ) : activeTab === "browser" ? (
          <BrowserPanel projectId={projectId} />
        ) : (
          <SubAgentsPanel sessionId={sessionId} />
        )}
      </div>
    </motion.div>
  );
}
