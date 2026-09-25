import { Link, useParams } from "react-router";
import { useProjects } from "../../hooks/use-projects";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { ChatFocusLayout } from "./ChatFocusLayout";

/**
 * Project-chat screen — the Workspace archetype's route host (SCREENS.md §3):
 * resolves the :id route param against the live projects query and hands the
 * project to ChatFocusLayout, the ONE chat layout.
 *
 * R126-3d-1 (the dead-layouts retirement): this screen used to gate three
 * layouts on the persisted `chatFocusMode` / `experimentalMode` store flags,
 * but both setters had ZERO UI call sites — with `chatFocusMode` defaulting
 * true, ChatFocusLayout was the only reachable branch, and the 3-panel
 * layout (LeftSidebar + GapHandle + CodeView) plus the ExperimentalLayout
 * freeform branch rendered exclusively for pre-R126 persisted state. Both
 * branches and their files are RETIRED (LeftSidebar.tsx / CodeView.tsx /
 * ExperimentalLayout.tsx / panels/CodebasePanel.tsx deleted); this route
 * renders ChatFocusLayout unconditionally, and the two mode flags left the
 * store with them (project-chat-store.ts documents the stale persisted
 * keys). Session picking (?session= via useActiveSessionId) and the chat
 * internals live in ChatFocusLayout + AgentChatPanel — untouched.
 */
export default function ProjectChatScreen() {
  const styles = useThemeStyles();
  const { id } = useParams<"id">();
  const projectsQuery = useProjects();
  const project = projectsQuery.data?.find((p) => p.id === id) ?? null;

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

  return <ChatFocusLayout project={project} />;
}
