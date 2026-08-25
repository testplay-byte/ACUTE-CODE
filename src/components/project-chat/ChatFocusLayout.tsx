import { motion } from "framer-motion";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { ease } from "../../lib/motion";
import { AgentChatPanel } from "./AgentChatPanel";
import type { Project } from "../../lib/api";

/**
 * ChatFocusLayout (Round 32 redesign per the owner-approved design
 * Acute-Ui-Screens.html Frame 5 — "THE MONEY SCREEN"):
 *
 * - NO TOP NAVIGATION BAR (owner R32 directive: "at the very top there is no
 *   need to show the top navigation bar… unnecessary, unusual, unneeded, and a
 *   bad experience"). The old ChatTopBar (back/agent/theme/panels) is gone;
 *   the essential controls (agent picker, model chip, ⌘K, theme, panels) live
 *   in the chat panel's own slim header inside AgentChatPanel.
 * - The chat window is its own FLOATING PANEL: pure white in light mode /
 *   cardDark in dark, radius 24, 1.5px border, softShadow — visually separate
 *   from the sidebar (owner: "the right side chat window was separate from
 *   it"), with the app shell providing the 12px spacing on all sides.
 * - The conversation column stays left-leaning on desktop (mr-auto), full
 *   width on mobile.
 */
export function ChatFocusLayout({ project }: { project: Project }) {
  const styles = useThemeStyles();

  return (
    <motion.div
      className="h-full min-h-0 flex flex-col"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3, ease }}
    >
      {/* The floating chat window — its own surface, separate from the rail.
          ROUND-33: explicit 4-corner rounding (owner reported the bottom-left
          + top-right corners reading square) and a wider reading column with
          comfortable side padding (owner: "somewhat more padding" instead of
          big empty voids at the sides). */}
      <div
        className="flex-1 min-h-0 flex rounded-tl-[24px] rounded-tr-[24px] rounded-br-[24px] rounded-bl-[24px] border-[1.5px] overflow-hidden"
        style={{
          backgroundColor: styles.card,
          borderColor: styles.border,
          boxShadow: styles.softShadow,
        }}
      >
        {/* ROUND-37 (owner: "its width was not proper. A lot of the right
            side area was completely empty"): the 900px R35 cap is GONE — the
            conversation column now fills the panel with comfortable padding;
            a soft 1500px readability cap keeps 13px text sane on ultrawide
            displays (plan amendment #7). */}
        <div className="flex-1 min-h-0 flex justify-center">
          <div className="w-full max-w-[1500px] min-h-0 flex">
            <AgentChatPanel projectId={project.id} project={project} />
          </div>
        </div>
      </div>
    </motion.div>
  );
}
