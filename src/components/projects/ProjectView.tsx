import { Fragment } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { CircleAlert, FolderSearch, LoaderCircle, MessageSquare, Plus } from "lucide-react";
import { useAgents } from "../../hooks/use-agents";
import { useProjects } from "../../hooks/use-projects";
import { useCreateSession, useSessions } from "../../hooks/use-sessions";
import { useActiveStreams } from "../../lib/active-streams";
import { formatWhen } from "../../lib/format";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { cn } from "../../lib/utils";
// R126 (the Clay Companion redesign): the session-row STATE law is the
// sidebar's own derivation (deriveSessionRowState — the R58-cf stop-flow
// semantics: a live stream wins over a lagging status field, a settled
// "queued" is idle). ONE spelling, imported from the module that owns it
// (AgentChatPanel already imports AcuteLogo across the same boundary).
import { deriveSessionRowState } from "../shell/Sidebar";
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
 *
 * R126 (the Clay Companion redesign, SCREENS.md §3 — the Instrument
 * archetype as a THIN landing): the page sits on the app canvas with NO
 * extra card wrapper — the sessions WELL is the surface (the sidebar's
 * session-tree grammar: ONE bg-well recess with the rim hairline, flat rows
 * separated by 1px inset hairline dividers, the ACTIVE row popping with the
 * accentTint fill + the 2px accentDeep leading bar). The identity row rhymes
 * with the sidebar's project row: the 24px clay letter-avatar + the 13px/600
 * name + the mono rootPath + the quiet-solid clay primary (the accent-soft
 * pill retired). The honest states ride the clay materials: bg-well
 * skeletons, the danger badge-tone containers (TOKENS §11), and the
 * minimal-center empty shapes.
 */
export function ProjectView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // R126 (the selection grammar): the ?session= URL param decides the ACTIVE
  // row — the same param the sidebar's session well, the row clicks, and
  // RecentActivity all write. Read directly here: the fallback resolution
  // (latest session when the param is absent) belongs to the CHAT screen; a
  // landing highlights nothing until the param says so.
  const [searchParams] = useSearchParams();
  const activeSessionId = searchParams.get("session");
  const styles = useThemeStyles();
  const projectsQuery = useProjects();
  const project = id ? projectsQuery.data?.find((p) => p.id === id) : undefined;

  const sessionsQuery = useSessions();
  // Sessions list has no server-side projectId filter — filter client-side,
  // newest first (spec F3 project-chat integration).
  const sessions = (sessionsQuery.data ?? [])
    .filter((s) => s.projectId === id)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

  // R126: the live-streams store feeds the row STATE law (the spinner shows
  // while a turn is in flight even when the persisted status lags behind).
  const activeStreams = useActiveStreams((s) => s.active);

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
    // R126 (the anti-jitter law, COMPONENTS §6): the loading page mirrors the
    // READY layout section-for-section — the identity-row ghosts (tile +
    // name + path + CTA), the kicker ghost, and the well's skeleton hold the
    // landing's shape while the project is unknown (the pre-R126 lone pulse
    // tile retired). ONE role=status announcement owns the region.
    return (
      <div className="h-full overflow-y-auto p-4 md:p-6" role="status" aria-label="Loading project">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-center gap-3" aria-hidden>
            <span className="h-6 w-6 shrink-0 animate-pulse rounded-lg bg-well" />
            <span className="h-3.5 w-44 shrink-0 animate-pulse rounded bg-well" />
            <span className="h-3 w-56 min-w-0 flex-1 animate-pulse rounded bg-well" />
            <span className="h-8 w-28 shrink-0 animate-pulse rounded-lg bg-well" />
          </div>
          <div className="mb-2 mt-5 h-3 w-20 animate-pulse rounded bg-well" aria-hidden />
          <SessionWellSkeleton />
        </div>
      </div>
    );
  }

  // R97-I part 2 (owner: a UI "aware of its states"): a fetch ERROR is not
  // "not found" — pre-R97 a failed projects query fell through to the
  // misleading "Project not found" card, so a down sidecar read as a deleted
  // project. This branch renders the honest, retryable error card instead.
  // R97-J (m1) fix: the populated-wins rule — only when there is NO data at
  // all (a failed background refetch with the list still cached renders the
  // view normally, exactly like the chat transcript + the settings cards).
  // R126 (TOKENS §11): the error surface is the DANGER BADGE-TONE container —
  // bg-badge-danger + the deep-on-tint ink pair (the pre-R126 withAlpha
  // washes + the 1.5px bento border retired with the successor run). ONE
  // Retry — the OUTLINED-DANGER species (COMPONENTS §4: the class-leg
  // border-danger-deep + text-danger-deep, duration-100, press 0.98 — the
  // exact spelling the 3a/3b instrument waves ship, never a withAlpha
  // border style); the weight law 600/600, the deep tier as the ink.
  if (projectsQuery.isError && projectsQuery.data === undefined) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div
          role="alert"
          data-project-load-error
          className="max-w-md rounded-xl bg-badge-danger px-4 py-3.5 text-center text-badge-danger-fg"
        >
          <p className="text-[13px] font-semibold text-badge-danger-fg">Could not load projects</p>
          <p className="mt-1.5 text-[12px] leading-relaxed">
            The project list failed to load — the sidecar may be down or the connection dropped.
          </p>
          <button
            type="button"
            onClick={() => void projectsQuery.refetch()}
            aria-label="Retry loading projects"
            className="mt-3 h-8 cursor-pointer rounded-lg border border-danger-deep px-3.5 text-[12px] font-semibold text-danger-deep transition-opacity duration-100 hover:opacity-85 active:scale-[0.98]"
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
        {/* R126 (SCREENS §3, the mobile empty-state law): the minimal-center
            shape — ONE icon tile + one line + ONE action. The tile rides the
            accentTint icon-chip grammar (TOKENS §10) with the deep-accent
            glyph; the escape is a quiet accent-deep text action (the
            accent-as-text tier, TOKENS §1d). */}
        <div className="flex flex-col items-center text-center">
          <span
            data-project-empty-tile
            aria-hidden
            className="grid h-10 w-10 place-items-center rounded-xl bg-accent-tint text-accent-deep"
          >
            <FolderSearch size={16} />
          </span>
          <p className="mt-3 text-[13px] font-semibold" style={{ color: styles.text }}>
            Project not found
          </p>
          <button
            type="button"
            onClick={() => navigate("/")}
            className="mt-2 cursor-pointer text-[12px] font-medium text-accent-deep underline underline-offset-4 transition-[opacity,transform] duration-100 hover:opacity-80 active:scale-95"
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
            destination), and a fresh chat is the button.
            R126: the row rhymes with the sidebar's project row — the 24px
            clay letter-avatar (ProjectTile below) leads, and the button is
            the QUIET-SOLID clay primary (COMPONENTS §4: the accentDeep fill
            on the `bg-accent-deep` class + the accentText ink on the JS leg
            — `text-accent-text` is the phantom utility with no @theme
            mapping — h-8/rounded-lg/12px-600, press 0.98, and §4's disabled
            law bg-subtle + tertiary ink with opacity intact; the accent-soft
            pill retired with the nova dialect, and the successor run snapped
            the fill off the inline leg to the one instrument-family
            spelling). */}
        <div className="flex items-center gap-3">
          <ProjectTile color={project.color} name={project.name} />
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
          <button
            type="button"
            onClick={() => void startNewSession()}
            disabled={createSession.isPending}
            aria-label={`Start a new session in ${project.name}`}
            title="New session"
            className="shrink-0 h-8 cursor-pointer rounded-lg bg-accent-deep px-3 flex items-center justify-center gap-1.5 text-[12px] font-semibold transition-transform active:scale-[0.98] disabled:bg-subtle"
            style={{ color: createSession.isPending ? styles.textTertiary : styles.accentText }}
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
          /* R126 (TOKENS §10 law 4 + MOTION §4): the loading skeleton rides
             the WELL — the rim footprint with bg-well rows breathing inside
             (the skeleton forecasts the well, the mobile Skeleton recipe);
             never a false "No sessions yet". */
          <SessionWellSkeleton announce="Loading sessions" />
        ) : sessionsQuery.isError ? (
          /* R97-I part 2: a failed sessions fetch is an ERROR, not the false
             "No sessions yet". R126 (TOKENS §11): the danger badge-tone
             container + the deep-on-tint ink — and the section now carries
             its OWN one Retry (the sessions refetch; pre-R126 it was a bare
             one-line note with no recovery when only this join failed).
             R126-3c (successor): the container + Retry snapped to the ONE
             app-wide badge-tone error spelling (rounded-xl, no border, the
             class-leg outlined-danger Retry at duration-100 + press 0.98 —
             the withAlpha border styles retired). */
          <div
            role="alert"
            data-project-sessions-error
            className="rounded-xl bg-badge-danger px-4 py-3.5 text-badge-danger-fg"
          >
            <p className="text-[12px] font-semibold text-badge-danger-fg">
              Could not load sessions — check that the sidecar is running.
            </p>
            <button
              type="button"
              onClick={() => void sessionsQuery.refetch()}
              aria-label="Retry loading sessions"
              className="mt-3 h-8 cursor-pointer rounded-lg border border-danger-deep px-3.5 text-[12px] font-semibold text-danger-deep transition-opacity duration-100 hover:opacity-85 active:scale-[0.98]"
            >
              Retry
            </button>
          </div>
        ) : sessions.length === 0 ? (
          /* R126 (SCREENS §3): the settled-empty section = the minimal-center
             shape inside the well — ONE icon tile + one line + one action.
             The action is the SECONDARY species (outlined, COMPONENTS §4):
             border-line-strong + the muted ink on the class leg, the
             bg-subtle hover wash + the press floor at duration-100 (the
             row-grammar hover:bg-hover retired from buttons with the
             successor run) — the identity row's quiet-solid CTA stays the
             screen's ONE primary (the mobile one-primary law). */
          <div className="flex flex-col items-center rounded-lg border border-clay-rim bg-well px-3 py-8 text-center">
            <span
              data-project-empty-tile
              aria-hidden
              className="grid h-10 w-10 place-items-center rounded-xl bg-accent-tint text-accent-deep"
            >
              <MessageSquare size={16} />
            </span>
            <p className="mt-3 text-[12px]" style={{ color: styles.textTertiary }}>
              No sessions yet
            </p>
            <button
              type="button"
              onClick={() => void startNewSession()}
              disabled={createSession.isPending}
              className="mt-3 h-8 cursor-pointer rounded-lg border border-line-strong bg-transparent px-3.5 text-[12px] font-semibold text-muted transition-colors duration-100 hover:bg-subtle active:scale-[0.98] disabled:opacity-60"
            >
              Start a session
            </button>
          </div>
        ) : (
          /* R126 (the well grammar, rhyming with the sidebar's session tree):
              ONE bg-well recessed container with the rim hairline
              (`border-clay-rim` — the class leg, the one instrument-family
              spelling the 3a/3b waves ride); FLAT rows separated by 1px inset
              hairline dividers (the R113 per-row bordered cards retire — the
              differentiation contract moves to the well's dividers, exactly
              like the sidebar's). Each row: the state-aware icon (running
              spinner accent / failed alert / idle chat-bubble tertiary) + the
              title 12px (500 + ink when active) + the relative time
              right-aligned (11px mono tertiary, tabular). The ACTIVE row
              (matching ?session=) pops with the accentTint fill + the 2px
              accentDeep leading bar — the selection grammar; a plain hover
              wash (duration-100, TOKENS §6's instant tier) on the rest. */
          <div
            data-project-sessions-well
            className="rounded-lg border border-clay-rim bg-well py-1"
          >
            {sessions.map((s, i) => {
              const state = deriveSessionRowState(s, activeStreams.has(s.id));
              const isActive = s.id === activeSessionId;
              return (
                <Fragment key={s.id}>
                  {i > 0 && (
                    <div
                      aria-hidden
                      className="mx-2 border-t"
                      style={{ borderColor: styles.borderSubtle }}
                    />
                  )}
                  <button
                    type="button"
                    /* R113-d (the owner's project/sessions flow fix): each row
                       opens THAT session — ?session=<s.id> — the same URL
                       shape the sidebar's rows + RecentActivity use
                       (?session= is read by use-active-session). Pre-R113
                       every row navigated WITHOUT the param, so clicking an
                       older session silently reopened the project's LATEST
                       conversation. */
                    onClick={() => id && navigate(`/project/${id}/chat?session=${s.id}`)}
                    aria-current={isActive ? "true" : undefined}
                    data-project-session-row
                    data-state={state}
                    data-active={isActive ? "true" : "false"}
                    title={s.title ?? "Untitled"}
                    /* R100-F: hover = the CSS wash (the JS onMouseEnter/Leave
                       pair is retired — TOKENS §6); duration-100 — the
                       80–120ms instant tier (successor-run snap). */
                    className={cn(
                      "relative flex h-10 w-full cursor-pointer items-center gap-2 rounded-lg px-3 text-left transition-colors duration-100",
                      isActive ? "bg-accent-tint" : "hover:bg-hover",
                    )}
                  >
                    {/* The 2px accentDeep marker — the selection grammar's
                        leading bar ("2px when selected, ALWAYS"). */}
                    <span
                      aria-hidden
                      className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent-deep"
                      style={{ opacity: isActive ? 1 : 0 }}
                    />
                    {/* ROUND-43's state-aware icon law (the sidebar's
                        spelling): spinner while a turn is in flight, the
                        alert glyph on failed/cancelled, the chat bubble at
                        rest — the active idle glyph rides the DEEP accent
                        (accent-as-text, TOKENS §1d). */}
                    {state === "running" ? (
                      <LoaderCircle
                        size={12}
                        className="shrink-0 animate-spin text-accent"
                        aria-label="Session is working"
                      />
                    ) : state === "failed" ? (
                      <CircleAlert
                        size={12}
                        className="shrink-0 text-[color:var(--ac-danger)]"
                        aria-label="Session failed"
                      />
                    ) : (
                      <MessageSquare
                        size={12}
                        className="shrink-0"
                        style={{ color: isActive ? styles.accentDeep : styles.textTertiary }}
                      />
                    )}
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-[12px] font-normal text-muted",
                        isActive && "font-medium text-ink",
                      )}
                    >
                      {s.title ?? "Untitled"}
                    </span>
                    <span
                      className="shrink-0 font-mono text-[11px] tabular-nums"
                      style={{ color: styles.textTertiary }}
                    >
                      {formatWhen(s.updatedAt)}
                    </span>
                  </button>
                </Fragment>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** R126 (SCREENS §3 Instrument — the thin landing): the project's clay
 * letter-avatar — the SAME grammar as the sidebar's ProjectTile (the flat
 * project color + the clay small shadow, radius ≈33% of the 24px mark — the
 * mobile letter-avatar law; the pre-R126 black rim is retired there and
 * never lands here). A deliberate local copy: the sidebar's tile is
 * file-private, and the identity row only needs the 20-line mark, not the
 * whole shell module's worth of props (size/radius/fontSize knobs it never
 * varies). */
function ProjectTile({ color, name }: { color: string; name: string }) {
  return (
    <span
      data-project-tile
      className="shrink-0 grid h-6 w-6 place-items-center font-semibold text-white select-none"
      style={{
        borderRadius: 8,
        fontSize: 12,
        background: color,
        boxShadow: "var(--ac-clay-shadow-sm)",
      }}
      aria-hidden
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/** R126 (TOKENS §10 law 4 + MOTION §4's skeleton law): the sessions well's
 * loading ghost — the well's rim FOOTPRINT with bg-well rows breathing
 * inside (the skeleton forecasts the well: one step toward the surface the
 * ready state will paint, the mobile Skeleton recipe — never plain
 * bg-subtle). `announce` names the region for AT when the skeleton stands
 * alone (the sessions join loading under a settled identity row); embedded
 * inside an already-announced loading PAGE it stays decorative so the
 * screen announces its loading exactly once. */
function SessionWellSkeleton({ announce }: { announce?: string }) {
  return (
    <div
      data-project-sessions-skeleton
      className="rounded-lg border border-clay-rim py-1"
      role={announce ? "status" : undefined}
      aria-label={announce}
    >
      {[0, 1, 2].map((i) => (
        <div key={i} aria-hidden className="mx-2 my-1 h-10 animate-pulse rounded-md bg-well" />
      ))}
    </div>
  );
}
