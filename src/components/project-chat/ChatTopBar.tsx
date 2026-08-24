import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Moon, PanelsTopLeft, Sun, X } from "lucide-react";
import { Link } from "react-router";
import { useAgents } from "../../hooks/use-agents";
import { useProjectChatStore } from "../../lib/project-chat-store";
import { useThemeStore } from "../../lib/theme-store";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";
import type { Project } from "../../lib/api";

/**
 * ChatTopBar (Round 28 WS-D1): slim 56px top bar that appears in chat-focus
 * mode (chatFocusMode === true). Carries:
 *   - back-to-dashboard
 *   - project name (truncated)
 *   - agent chip (popover picker — reuses the existing agent list)
 *   - theme toggle (Sun/Moon quick flip)
 *   - "Show panels" toggle (flips chatFocusMode → false → 3-panel layout)
 *
 * Owner R28 directive: "the chat window should be made to show on the left
 * side or in the center on the left side. These infos will not show, like the
 * folder structures and the actual code window." The "Show panels" toggle is
 * the escape hatch back to the 3-panel layout when the user wants code.
 */
export function ChatTopBar({ project }: { project: Project }) {
  const styles = useThemeStyles();
  const navigate = useNavigateBack();
  const mode = useThemeStore((s) => s.mode);
  const toggleMode = useThemeStore((s) => s.toggleMode);
  const setChatFocusMode = useProjectChatStore((s) => s.setChatFocusMode);
  const selectedAgentId = useProjectChatStore((s) => s.selectedAgentId);
  const setSelectedAgentId = useProjectChatStore((s) => s.setSelectedAgentId);
  const agentsQuery = useAgents(false);
  const agents = agentsQuery.data ?? [];
  const currentAgent = agents.find((a) => a.id === selectedAgentId) ?? agents[0] ?? null;
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <header
      className="shrink-0 h-14 flex items-center gap-2 px-3 border-b-[1.5px]"
      style={{ background: styles.card, borderColor: styles.border }}
    >
      {/* Back to dashboard */}
      <Link
        to="/"
        aria-label="Back to dashboard"
        title="Back to dashboard"
        className="shrink-0 w-9 h-9 rounded-[10px] grid place-items-center transition-colors"
        style={{ color: styles.textSecondary, background: "transparent" }}
        onMouseEnter={(e) => (e.currentTarget.style.background = styles.subtleHover)}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        <ArrowLeft size={16} />
      </Link>

      <div className="shrink-0 w-px h-5" style={{ background: styles.border }} />

      {/* Project name */}
      <div className="min-w-0 flex-1 flex items-center gap-2">
        <span
          className="shrink-0 w-6 h-6 rounded-[7px] grid place-items-center font-black text-[11px]"
          style={{ background: project.color, color: "#fff" }}
        >
          {project.name.charAt(0).toUpperCase()}
        </span>
        <span className="truncate text-[14px] font-bold" style={{ color: styles.text }}>
          {project.name}
        </span>
      </div>

      {/* Agent chip (popover picker) */}
      <div className="relative shrink-0">
        <button
          onClick={() => setPickerOpen((v) => !v)}
          aria-label={`Agent: ${currentAgent?.name ?? "none"}. Pick agent.`}
          aria-expanded={pickerOpen}
          className="h-9 flex items-center gap-2 rounded-[10px] px-3 text-[12px] font-bold transition-colors"
          style={{ background: styles.subtle, color: styles.textSecondary, border: `1.5px solid ${styles.border}` }}
          onMouseEnter={(e) => (e.currentTarget.style.background = styles.subtleHover)}
          onMouseLeave={(e) => (e.currentTarget.style.background = styles.subtle)}
        >
          <span
            className="w-5 h-5 rounded-full grid place-items-center text-[10px] font-black"
            style={{ background: styles.accent, color: styles.accentText }}
          >
            {(currentAgent?.name ?? "A").charAt(0).toUpperCase()}
          </span>
          <span className="max-w-[120px] truncate">{currentAgent?.name ?? "No agent"}</span>
        </button>
        <AnimatePresence>
          {pickerOpen && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15 }}
              className="absolute right-0 top-11 z-50 w-56 rounded-[14px] border-[1.5px] p-1.5 shadow-lg overflow-hidden"
              style={{ background: styles.card, borderColor: styles.border, boxShadow: styles.bentoShadowSm }}
              role="listbox"
              aria-label="Pick an agent"
            >
              <div className="flex items-center justify-between px-2 py-1.5">
                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: styles.textTertiary }}>
                  Agents
                </span>
                <button
                  onClick={() => setPickerOpen(false)}
                  aria-label="Close agent picker"
                  className="w-6 h-6 rounded-md grid place-items-center"
                  style={{ color: styles.textTertiary }}
                >
                  <X size={12} />
                </button>
              </div>
              <div className="max-h-64 overflow-y-auto">
                {agents.length === 0 && (
                  <div className="px-2 py-3 text-[12px]" style={{ color: styles.textTertiary }}>
                    No agents configured.
                  </div>
                )}
                {agents.map((a) => {
                  const sel = a.id === currentAgent?.id;
                  return (
                    <button
                      key={a.id}
                      onClick={() => { setSelectedAgentId(a.id); setPickerOpen(false); }}
                      className="w-full flex items-center gap-2 rounded-[10px] px-2 py-2 text-left transition-colors"
                      style={{ background: sel ? withAlpha(styles.accent, 0.1) : "transparent" }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = sel ? withAlpha(styles.accent, 0.1) : styles.subtleHover)}
                      onMouseLeave={(e) => (e.currentTarget.style.background = sel ? withAlpha(styles.accent, 0.1) : "transparent")}
                      role="option"
                      aria-selected={sel}
                    >
                      <span
                        className="w-6 h-6 rounded-full grid place-items-center text-[11px] font-black"
                        style={{ background: styles.accent, color: styles.accentText }}
                      >
                        {a.name.charAt(0).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12px] font-bold" style={{ color: styles.text }}>
                        {a.name}
                      </span>
                      {sel && <span className="text-[10px] font-bold" style={{ color: styles.accent }}>✓</span>}
                    </button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Theme toggle */}
      <button
        onClick={toggleMode}
        aria-label={`Switch to ${mode === "dark" ? "light" : "dark"} mode`}
        title={`Switch to ${mode === "dark" ? "light" : "dark"} mode`}
        className="shrink-0 w-9 h-9 rounded-[10px] grid place-items-center transition-colors"
        style={{ color: styles.textSecondary, background: "transparent" }}
        onMouseEnter={(e) => (e.currentTarget.style.background = styles.subtleHover)}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        {mode === "dark" ? <Sun size={16} /> : <Moon size={16} />}
      </button>

      {/* Show panels (exit focus mode → 3-panel layout) */}
      <button
        onClick={() => { setChatFocusMode(false); navigate(); }}
        aria-label="Show panels — exit chat focus mode"
        title="Show panels (Explorer + Code)"
        className="shrink-0 h-9 flex items-center gap-1.5 rounded-[10px] px-3 text-[12px] font-bold transition-colors"
        style={{ background: withAlpha(styles.accent, 0.1), color: styles.accent, border: `1.5px solid ${withAlpha(styles.accent, 0.3)}` }}
      >
        <PanelsTopLeft size={14} />
        <span className="hidden sm:inline">Panels</span>
      </button>
    </header>
  );
}

/**
 * Tiny no-op navigate hook: the "Show panels" button just flips the store
 * flag (ProjectChatScreen re-renders on store change). This hook exists so
 * the button can also trigger any future analytics; for now it returns a
 * stable empty callback.
 */
function useNavigateBack() {
  return () => {};
}
