import { useNavigate, useParams } from "react-router";
import { Plus } from "lucide-react";
import { useAgents } from "../../hooks/use-agents";
import { useProjects } from "../../hooks/use-projects";
import { useCreateSession, useSessions } from "../../hooks/use-sessions";
import { formatWhen } from "../../lib/format";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { bdr, withAlpha } from "../dashboard/helpers";
// R100-F (research §C2 P5): the Sessions section label rides THE one kicker.
import { Kicker } from "../ui/Kicker";

/**
 * Project view (owner round-8): selecting a sidebar project opens THIS — the
 * project's home inside the main card. The dedicated chat window is live at
 * /project/:id/chat (M3 project-chat port); this screen remains the project's
 * landing page with its bound sessions for context.
 *
 * R113-d (owner: page headers are "unnecessary, unneeded, and not required";
 * + the project/sessions flow fix): the 44px identity tile + 24px title +
 * the "Open project chat" CTA card collapse into ONE slim row — name at the
 * row tier + the mono rootPath inline + the New session affordance at the
 * right end. The session rows below are the chat entry points now, and EACH
 * row opens ITS OWN session (?session=<id>) instead of silently landing on
 * the project's latest conversation.
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

  // R113-d: the "New session" affordance — the sidebar's project-row + is
  // one entry point, but this screen needs its own (the flow must not depend
  // on the sidebar being expanded). Same recipe the sidebar uses: the first
  // non-template agent + useCreateSession, then land the chat AT the fresh
  // session (?session= is read by use-active-session).
  const agentsQuery = useAgents(false);
  const createSession = useCreateSession();
  const startNewSession = async () => {
    if (!id || !project || createSession.isPending) return;
    const agentId = (agentsQuery.data ?? [])[0]?.id ?? null;
    if (!agentId) {
      // No non-template agent in the registry yet — the chat screen's empty
      // state owns that teaching moment (it links to Settings); land there.
      void navigate(`/project/${id}/chat`);
      return;
    }
    try {
      const created = await createSession.mutateAsync({
        mode: "single" as const,
        agentId,
        projectId: id,
        title: `New chat · ${project.name}`,
      });
      void navigate(`/project/${id}/chat?session=${created.id}`);
    } catch {
      /* surfaced by the mutation state; keep the view stable */
    }
  };

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

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6">
      <div className="mx-auto max-w-3xl">
        {/* R113-d: the slim identity row (see the file header) — the name at
            the row tier (13px/600), the mono rootPath inline, and the row's
            right end carries the New session affordance. The pre-R113
            header (44px tile + 24px title) and the "Open project chat" CTA
            card are retired: the SESSION ROWS below are the chat entry
            points (the first row is the latest session — the old CTA's
            destination), and a fresh chat is the button. */}
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex flex-1 items-baseline gap-2.5">
            <h1
              className="min-w-0 truncate text-[13px] font-semibold"
              style={{ color: styles.text }}
              title={project.name}
            >
              {project.name}
            </h1>
            <span
              className="min-w-0 flex-1 truncate font-mono text-[11px] tabular-nums"
              style={{ color: styles.textTertiary }}
              title={project.rootPath}
            >
              {project.rootPath}
            </span>
          </div>
          {/* The Add-provider button's grammar (h-8 pill on the
              bg-accent-soft leg — TOKENS §6's CSS hover, never a handler). */}
          <button
            type="button"
            onClick={() => void startNewSession()}
            disabled={createSession.isPending}
            aria-label={`Start a new session in ${project.name}`}
            title="New session"
            className="shrink-0 h-8 px-3 flex items-center justify-center gap-1.5 rounded-lg text-[12px] font-semibold transition-colors bg-accent-soft hover:bg-accent-faded disabled:opacity-60"
            style={{ color: styles.accent }}
          >
            <Plus size={13} strokeWidth={2.5} /> New session
          </button>
        </div>

        {/* Sessions bound to this project (client-side projectId filter) */}
        {/* R100-F: THE one kicker (ui/Kicker) — the 11px font-bold
            tracking-widest hand-rolled header is retired. */}
        <Kicker as="h2" className="mb-2 mt-5">
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
                /* R113-d (the owner's project/sessions flow fix): each row
                   opens THAT session — ?session=<s.id> — the same URL shape
                   the sidebar's rows + RecentActivity use (?session= is read
                   by use-active-session). Pre-R113 every row navigated
                   WITHOUT the param, so clicking an older session silently
                   reopened the project's LATEST conversation. */
                onClick={() => id && navigate(`/project/${id}/chat?session=${s.id}`)}
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
