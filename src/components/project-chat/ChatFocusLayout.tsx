import { motion } from "framer-motion";
import { useProjectChatStore } from "../../lib/project-chat-store";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { ease } from "../../lib/motion";
import { AgentChatPanel } from "./AgentChatPanel";
import { ChatTopBar } from "./ChatTopBar";
import type { Project } from "../../lib/api";

/**
 * ChatFocusLayout (Round 28 WS-D1): the chat-focus-mode layout. Renders the
 * ChatTopBar (slim, back/agent/theme/panels) + the AgentChatPanel alone.
 *
 * The chat is LEFT-aligned on desktop (mr-auto, not mx-auto — 6-e review fix:
 * owner said "left side or center on the LEFT side"; mx-auto centers, mr-auto
 * left-aligns with the right margin absorbing slack). On mobile (<1024px) the
 * chat fills the full width (no maxWidth constraint).
 *
 * Owner R28 directive: "the chat window should be made to show on the left
 * side or in the center on the left side. These infos will not show, like the
 * folder structures and the actual code window or other windows. Those will
 * not show there."
 */
export function ChatFocusLayout({ project }: { project: Project }) {
  const styles = useThemeStyles();
  const appSidebarVisible = useProjectChatStore((s) => s.appSidebarVisible);

  return (
    <motion.div
      className="h-full min-h-0 flex flex-col"
      style={{ backgroundColor: styles.bg }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3, ease }}
    >
      <ChatTopBar project={project} />
      {/* Chat takes flex-1, left-aligned on desktop (mr-auto), full-width on
          mobile. max-w-3xl (768px) keeps the chat readable on wide screens. */}
      <div
        className={
          appSidebarVisible
            ? "flex-1 min-h-0 flex justify-center px-2 py-2"
            : "flex-1 min-h-0 flex justify-center lg:justify-start px-2 py-2"
        }
      >
        <div className="w-full max-w-3xl lg:mr-auto min-h-0 flex">
          <AgentChatPanel projectId={project.id} project={project} />
        </div>
      </div>
    </motion.div>
  );
}
