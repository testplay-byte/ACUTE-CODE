import { useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import { MessagesSquare } from "lucide-react";
import { useProjectsStore } from "../../lib/projects-store";
import { useSessions } from "../../hooks/use-sessions";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { bdr, withAlpha } from "../dashboard/helpers";

/**
 * Project view (owner round-8): selecting a sidebar project opens THIS — the
 * project's home inside the main card. Sessions are not project-linked in the
 * backend yet (that lands with the orchestration phase, which also brings the
 * dedicated chat-window flow from the project-chat demo); until then this
 * shows an honest state plus the workspace's recent sessions for context.
 */
export function ProjectView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const styles = useThemeStyles();
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === id));
  const selectProject = useProjectsStore((s) => s.selectProject);

  useEffect(() => {
    if (id) selectProject(id);
  }, [id, selectProject]);

  const sessionsQuery = useSessions();
  const sessions = (sessionsQuery.data ?? []).slice(0, 5);

  if (!project) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="text-center">
          <p className="text-[14px] font-semibold" style={{ color: styles.text }}>
            Project not found
          </p>
          <button
            onClick={() => navigate("/")}
            className="mt-2 cursor-pointer text-[12px] underline underline-offset-4"
            style={{ color: styles.accent }}
          >
            Back to dashboard
          </button>
        </div>
      </div>
    );
  }

  const letter = project.name.charAt(0).toUpperCase();

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6">
      <div className="mx-auto max-w-3xl">
        {/* Project header */}
        <div className="flex items-center gap-3">
          <div
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-lg font-bold text-white"
            style={{ backgroundColor: `${project.color}CC` }}
          >
            {letter}
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-[22px] font-bold tracking-tight" style={{ color: styles.text }}>
              {project.name}
            </h1>
            <div className="truncate font-mono text-[11px]" style={{ color: styles.textTertiary }}>
              {project.path}
            </div>
          </div>
        </div>

        {/* Chat-window integration note (honest until orchestration lands) */}
        <div
          className="mt-5 rounded-[14px] border-[1.5px] p-4"
          style={{
            background: withAlpha(project.color, 0.06),
            borderColor: withAlpha(project.color, 0.25),
          }}
        >
          <div className="flex items-center gap-2">
            <MessagesSquare size={14} style={{ color: styles.text }} />
            <span className="text-[13px] font-bold" style={{ color: styles.text }}>
              Project chat
            </span>
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: styles.textSecondary }}>
            Agents will work on this project in a dedicated chat window — clicking a session from
            recent activity will open it here. This flow arrives with the orchestration phase
            (SPEC F3); the project registry itself is live and local-first.
          </p>
        </div>

        {/* Recent workspace sessions (context until project-linked sessions exist) */}
        <h2
          className="mb-2 mt-6 text-[11px] font-bold uppercase tracking-widest"
          style={{ color: styles.textTertiary }}
        >
          Recent workspace sessions
        </h2>
        {sessionsQuery.isPending ? (
          <div className="h-[52px] w-full animate-pulse rounded-lg" style={{ background: styles.subtle }} />
        ) : sessions.length === 0 ? (
          <div
            className="rounded-lg px-3 py-4 text-[12px]"
            style={{ border: bdr("1.5px", styles.border), color: styles.textTertiary }}
          >
            No sessions yet — create one from the dashboard&apos;s quick actions.
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => void navigate("/sessions")}
                className="flex w-full cursor-pointer items-center justify-between rounded-lg px-3 py-2.5 text-left transition-colors"
                style={{ border: bdr("1.5px", styles.border) }}
                onMouseEnter={(e) => (e.currentTarget.style.background = styles.subtleHover)}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <span className="min-w-0">
                  <span className="block truncate text-[12px] font-semibold" style={{ color: styles.text }}>
                    {s.title ?? s.id}
                  </span>
                  <span className="block text-[10px]" style={{ color: styles.textTertiary }}>
                    {s.status} · {s.mode}
                  </span>
                </span>
                <span className="shrink-0 text-[10px]" style={{ color: styles.textTertiary }}>
                  open →
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
