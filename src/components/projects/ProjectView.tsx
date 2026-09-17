import { useNavigate, useParams } from "react-router";
import { MessagesSquare } from "lucide-react";
import { useProjects } from "../../hooks/use-projects";
import { useSessions } from "../../hooks/use-sessions";
import { formatWhen } from "../../lib/format";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { bdr, withAlpha } from "../dashboard/helpers";
// R100-F (research §C2 P5): the Sessions header rides THE one kicker.
import { Kicker } from "../ui/Kicker";

/**
 * Project view (owner round-8): selecting a sidebar project opens THIS — the
 * project's home inside the main card. The dedicated chat window is live at
 * /project/:id/chat (M3 project-chat port); this screen remains the project's
 * landing page with its bound sessions for context.
 */
export function ProjectView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const styles = useThemeStyles();
  const projectsQuery = useProjects();
  const project = id ? projectsQuery.data?.find((p) => p.id === id) : undefined;

  const sessionsQuery = useSessions();
  // Sessions list has no server-side projectId filter — filter client-side,
  // newest first (spec F3 project-chat integration).
  const sessions = (sessionsQuery.data ?? [])
    .filter((s) => s.projectId === id)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

  if (projectsQuery.isPending) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="h-11 w-11 animate-pulse rounded-xl" style={{ background: styles.subtle }} />
      </div>
    );
  }

  // R97-I part 2 (owner: a UI "aware of its states"): a fetch ERROR is not
  // "not found" — pre-R97 a failed projects query fell through to the
  // misleading "Project not found" card, so a down sidecar read as a deleted
  // project. This branch renders the honest, retryable error card instead
  // (the ChatLoadErrorCard shape: role=alert, the danger token, one action).
  // R97-J (m1) fix: the populated-wins rule — only when there is NO data at
  // all (a failed background refetch with the list still cached renders the
  // view normally, exactly like the chat transcript + the settings cards).
  if (projectsQuery.isError && projectsQuery.data === undefined) {
    return (
      <div className="grid h-full place-items-center p-6">
        {/* R100-F: rounded-2xl (the card tier); the weight law — 600 for
            the error title, 600 for the retry button. */}
        <div
          role="alert"
          data-project-load-error
          className="max-w-md rounded-2xl border-[1.5px] px-4 py-3.5 text-center"
          style={{
            borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.35),
            background: withAlpha(SEMANTIC_COLORS.danger, 0.06),
          }}
        >
          <p className="text-[13px] font-semibold" style={{ color: SEMANTIC_COLORS.danger }}>
            Could not load projects
          </p>
          <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: styles.textSecondary }}>
            The project list failed to load — the sidecar may be down or the connection dropped.
          </p>
          <button
            type="button"
            onClick={() => void projectsQuery.refetch()}
            aria-label="Retry loading projects"
            className="mt-3 h-8 px-3.5 rounded-lg text-[12px] font-semibold border transition-opacity hover:opacity-85"
            style={{ borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.45), color: SEMANTIC_COLORS.danger }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="text-center">
          <p className="text-[13px] font-semibold" style={{ color: styles.text }}>
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
          {/* R100-F: the header tile mirrors the sidebar's flattened
              ProjectTile grammar — flat project color + a 1px border, the
              13px/600 letter (the `${color}CC` string-suffix hack becomes
              withAlpha(color, 0.8) per TOKENS §1 rule 3). */}
          <div
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-[13px] font-semibold text-white"
            style={{
              backgroundColor: withAlpha(project.color, 0.8),
              border: "1px solid rgba(0, 0, 0, 0.14)",
            }}
          >
            {letter}
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-[24px] font-semibold" style={{ color: styles.text }}>
              {project.name}
            </h1>
            <div className="truncate font-mono text-[11px] tabular-nums" style={{ color: styles.textTertiary }}>
              {project.rootPath}
            </div>
          </div>
        </div>

        {/* Project chat entry point (M3 project-chat screen) */}
        <div
          className="mt-5 rounded-2xl border-[1.5px] p-4"
          style={{
            background: withAlpha(project.color, 0.06),
            borderColor: withAlpha(project.color, 0.25),
          }}
        >
          <div className="flex items-center gap-2">
            <MessagesSquare size={14} style={{ color: styles.text }} />
            <span className="text-[13px] font-semibold" style={{ color: styles.text }}>
              Project chat
            </span>
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: styles.textSecondary }}>
            Agents work on this project in a dedicated chat window — files, tools and turns side
            by side. Opening it starts (or resumes) a session bound to this workspace.
          </p>
          {/* R100-F (research §C2 P5): the CTA radius snaps rounded-[8px] →
              rounded-lg and the label to the 13px/600 button tier. */}
          <button
            onClick={() => id && navigate(`/project/${id}/chat`)}
            className="mt-3 h-10 cursor-pointer rounded-lg px-4 text-[13px] font-semibold transition-opacity hover:opacity-90"
            style={{ backgroundColor: styles.accent, color: styles.accentText }}
          >
            Open project chat
          </button>
        </div>

        {/* Sessions bound to this project (client-side projectId filter) */}
        {/* R100-F: THE one kicker (ui/Kicker) — the 11px font-bold
            tracking-widest hand-rolled header is retired. */}
        <Kicker as="h2" className="mb-2 mt-6">
          Sessions
        </Kicker>
        {sessionsQuery.isPending ? (
          <div className="h-[52px] w-full animate-pulse rounded-lg" style={{ background: styles.subtle }} />
        ) : sessionsQuery.isError ? (
          /* R97-I part 2: a failed sessions fetch is an ERROR, not the false
             "No sessions yet" — one honest line in the empty-state box's own
             shape, danger-tinted (role=alert). R100-F: the 1px hairline. */
          <div
            role="alert"
            data-project-sessions-error
            className="rounded-lg px-3 py-4 text-[12px] font-semibold"
            style={{
              border: bdr("1px", withAlpha(SEMANTIC_COLORS.danger, 0.35)),
              color: SEMANTIC_COLORS.danger,
              background: withAlpha(SEMANTIC_COLORS.danger, 0.05),
            }}
          >
            Could not load sessions — check that the sidecar is running.
          </div>
        ) : sessions.length === 0 ? (
          <div
            className="rounded-lg px-3 py-4 text-[12px] border border-line"
            style={{ color: styles.textTertiary }}
          >
            No sessions yet
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => id && navigate(`/project/${id}/chat`)}
                /* R100-F: hover = the CSS wash (the JS onMouseEnter/Leave
                   pair is retired — TOKENS §6); the border rides the
                   border-line utility; row title 500, status + timestamp
                   meta-mono (mono, tabular). */
                className="flex w-full cursor-pointer items-center justify-between rounded-lg border border-line px-3 py-2.5 text-left transition-colors hover:bg-hover"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[12px] font-medium" style={{ color: styles.text }}>
                    {s.title ?? "Untitled"}
                  </span>
                  <span className="block font-mono text-[10px] tabular-nums" style={{ color: styles.textTertiary }}>
                    {s.status}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[10px] tabular-nums" style={{ color: styles.textTertiary }}>
                  {formatWhen(s.updatedAt)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
