import { motion, useReducedMotion } from "framer-motion";
import { useNavigate } from "react-router";
import { useAgents } from "../../hooks/use-agents";
import { useProjects } from "../../hooks/use-projects";
import { useSessions, useUsageSummary } from "../../hooks/use-sessions";
import { formatTokenCount } from "../../lib/format";
import { ENTRANCE_DELTA, SPRING, STAGGER_STEP_MS } from "../../lib/motion";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { SkeletonBlock } from "../shared/Skeletons";
import { QuickActions } from "./QuickActions";
import { RecentActivity } from "./RecentActivity";
import { StatRow, type StatRowCell } from "./StatCard";
import { TokenBarChart } from "./TokenBarChart";

/**
 * Dashboard screen — R126-3a, the Instrument archetype (SCREENS §3): the
 * bold lead heading → stat row → chart + quick actions → recent activity,
 * ONE scroll, on the container ladder (1280→1640px). AppShell's main is
 * transparent; the clay cards float.
 *
 * · R113-d (owner: the page headers are "unnecessary, unneeded, and not
 *   required"): NO page-header CHROME. R127 (SCREENS §3 — THE DASHBOARD
 *   BOLDNESS LAW) later sanctioned the greeting tier's RETURN as a CONTENT
 *   heading: "Workspace" at the 32px/800 display tier with ONE honest
 *   12px secondary scope line ("N projects · M sessions · last 14 days",
 *   values already fetched; "—" while loading). No greeting copy, no
 *   header chrome — a content heading, typographic hierarchy only.
 * · R126: the stat row is ONE clay card with four inset-divided cells
 *   (StatRow — the mobile stat-grid law); QuickActions + RecentActivity
 *   ride `ui/SectionCard` on the clay material; the error banner is the
 *   danger badge-tone container (TOKENS §11) with the outlined-danger
 *   Retry; skeletons ride the WELL fill (TOKENS §10 law 4).
 * · R127: the stat row's values render at display weight (26px/700 —
 *   StatCard.tsx) and RecentActivity reads as a TIMELINE (the "bubbles +
 *   timelines" ask) — no new hues, no new materials.
 * · Motion (MOTION §2/§6): the lead heading enters first (index 0), the
 *   stat row follows at index 1, the sections stagger after on the 30ms
 *   beat — fade-in-up 8px on the house spring, imported from
 *   src/lib/motion.ts. NO hover lift/bloom anywhere (the clay card is
 *   already elevated; hover = the rim→border-strong swap at most).
 *   Reduced motion snaps the entrance (rule 5).
 */
export function DashboardScreen() {
  const navigate = useNavigate();
  const styles = useThemeStyles();
  const reduced = useReducedMotion() === true;

  const sessionsQuery = useSessions();
  const agentsQuery = useAgents(false);
  const usage = useUsageSummary(14);
  const projectsQuery = useProjects();
  const projectCount = projectsQuery.data?.length ?? 0;

  const sessions = sessionsQuery.data ?? [];
  const agentById = new Map((agentsQuery.data ?? []).map((a) => [a.id, a]));
  const totals = usage.data?.totals;
  const totalTokens = (totals?.inputTokens ?? 0) + (totals?.outputTokens ?? 0);
  // R97-I part 2 (owner: a UI "aware of its states"): the stat row stays a
  // SKELETON until EVERY source has settled — pre-R97 it painted false zeros
  // ("0" Projects / "0" Sessions) while the queries were still in flight.
  // (usage rides isFetching: in demo mode the query is idle-but-pending,
  // which is a settled state, not a loading one — same rule as the chart.)
  const statsLoading =
    projectsQuery.isPending ||
    sessionsQuery.isPending ||
    agentsQuery.isPending ||
    (usage.isPending && usage.isFetching);
  // R97-I part 2: a failed PROJECTS fetch now joins the banner — pre-R97 it
  // was silently swallowed into the "0 Projects" stat card. R97-J (m2):
  // a failed USAGE fetch joins too — its absence used to paint false
  // "0" Tokens / "0" Turns beside the chart's own error card (the exact
  // false-zero the round kills).
  const loadError =
    sessionsQuery.isError || agentsQuery.isError || projectsQuery.isError || usage.isError;

  // R126 (MOTION §2/§6) + R127 (the lead heading takes index 0): the
  // section entrance — fade-in-up ENTRANCE_DELTA(8) on the house SPRING,
  // staggered STAGGER_STEP_MS(30) after the heading (index 0; the stat row
  // is index 1, the hero CARD). Reduced motion snaps ({ duration: 0 } —
  // rule 5).
  const sectionEntrance = (index: number) => ({
    initial: { opacity: 0, y: ENTRANCE_DELTA },
    animate: { opacity: 1, y: 0 },
    transition: reduced ? { duration: 0 } : { ...SPRING, delay: index * STAGGER_STEP_MS },
  });

  // R126 → R127: the four cells of the ONE-card stat row — kicker →
  // 26px/700 tabular value (display weight, SCREENS §3) → ONE 11px
  // supporting line (the honesty scope). The Tokens cell is the highlight
  // (accentDeep ink — never a solid fill).
  const statCells: StatRowCell[] = [
    { key: "projects", label: "Projects", value: String(projectCount), caption: "all-time" },
    { key: "sessions", label: "Sessions", value: String(sessions.length), caption: "all-time" },
    {
      key: "tokens",
      label: "Tokens",
      value: formatTokenCount(totalTokens),
      caption: `${formatTokenCount(totals?.inputTokens ?? 0)} in · ${formatTokenCount(totals?.outputTokens ?? 0)} out`,
      title: `${totals?.inputTokens ?? 0} in / ${totals?.outputTokens ?? 0} out · last 14 days`,
      highlight: true,
    },
    {
      key: "turns",
      label: "Turns",
      value: String(totals?.requests ?? 0),
      caption: "last 14 days",
      title: "Turns over the last 14 days (one usage row per turn — the ROUND-83 honest relabel; provider calls live on the /usage screen)",
    },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1280px] xl:max-w-[1480px] 2xl:max-w-[1640px] px-5 md:px-8 2xl:px-14 py-4 md:py-6 pb-16">
        {/* THE LEAD HEADING (R127, SCREENS §3 — THE DASHBOARD BOLDNESS LAW):
            the greeting tier returned as a CONTENT heading — 32px/800
            display (font-extrabold — the law's 28–34px/800 band), Manrope's
            own weight axis (no new font imports), the theme's text ink, ONE
            honest 12px secondary scope line under it. It is
            chrome-independent CONTENT: always rendered — while the sources
            load the scope line holds the honest "—", never a false count
            (the R97-I rule riding the same data). */}
        <motion.div {...sectionEntrance(0)} className="mb-4 md:mb-5">
          <h1
            data-testid="dashboard-lead-heading"
            className="text-[32px] font-extrabold leading-[1.15]"
            style={{ color: styles.text }}
          >
            Workspace
          </h1>
          <p className="mt-1.5 text-xs text-muted tabular-nums">
            {statsLoading
              ? "—"
              : `${projectCount} ${projectCount === 1 ? "project" : "projects"} · ${sessions.length} ${sessions.length === 1 ? "session" : "sessions"} · last 14 days`}
          </p>
        </motion.div>

        {/* The stat row — ONE clay card, four cells (R126, SCREENS §3).
            R97-I part 2: while any source is still loading the row holds its
            shape as ONE h-[92px] card-shaped skeleton block (the anti-jitter
            mirror — same height, same order), announced once by the
            role=status wrapper. NEVER false zeros. */}
        {statsLoading ? (
          <div
            role="status"
            aria-label="Loading workspace stats"
            data-stats-skeleton
            className="mb-4 md:mb-6"
          >
            <SkeletonBlock className="h-[92px] w-full rounded-2xl" />
          </div>
        ) : (
          <motion.div {...sectionEntrance(1)} className="mb-4 md:mb-6">
            <StatRow cells={statCells} styles={styles} testId="dashboard-stat-row" />
          </motion.div>
        )}

        {/* Chart + Quick Actions — the clay section cards (rounded-2xl,
            rim + .ac-clay); both enter on the section stagger's next beat. */}
        <div className="mb-4 md:mb-6 grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
          <motion.div {...sectionEntrance(2)} className="min-w-0">
            <TokenBarChart
              days={usage.data?.days ?? []}
              isPending={usage.isPending && usage.isFetching}
              isError={usage.isError}
              delay={0.2}
              styles={styles}
            />
          </motion.div>
          <motion.div {...sectionEntrance(2)} className="min-w-0">
            <QuickActions onNavigate={(to) => void navigate(to)} />
          </motion.div>
        </div>

        {loadError ? (
          /* R126 (TOKENS §11): the retryable loadError banner is the danger
              BADGE-TONE container — tinted container + deep-on-tint ink,
              never a flat-hue text on an alpha wash; the Retry button is
              the outlined danger species (COMPONENTS §4). */
          <div
            role="alert"
            className="mb-4 md:mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-badge-danger px-4 py-3 text-[12px] font-medium text-badge-danger-fg"
          >
            <span className="min-w-0">
              Could not load live workspace data — check that the sidecar is running.
            </span>
            {/* R97-I part 2: the banner is RETRYABLE — pre-R97 it named the
                problem but offered no action. One click re-drives every
                FAILED source (the errored ones only — settled sources keep
                their data). */}
            <button
              type="button"
              onClick={() => {
                if (sessionsQuery.isError) void sessionsQuery.refetch();
                if (agentsQuery.isError) void agentsQuery.refetch();
                if (projectsQuery.isError) void projectsQuery.refetch();
                // R97-J (m2): the usage source retries too (its failure
                // joins loadError above).
                if (usage.isError) void usage.refetch();
              }}
              aria-label="Retry loading workspace data"
              className="h-7 shrink-0 cursor-pointer rounded-lg border border-danger-deep px-3 text-[12px] font-semibold text-danger-deep transition-opacity duration-100 hover:opacity-85 active:scale-[0.98]"
            >
              Retry
            </button>
          </div>
        ) : null}

        {/* Recent activity — the clay SectionCard carrying the R127 TIMELINE
            (SCREENS §3: the vertical spine with day-divider nodes and card
            rows hanging off it); while the sessions list is in flight one
            card-shaped well block holds the section's footprint (the loading
            mirror, announced by aria-label). */}
        {sessionsQuery.isPending ? (
          <div aria-label="Loading recent activity">
            <SkeletonBlock className="h-52 w-full rounded-2xl" />
          </div>
        ) : (
          <motion.div {...sectionEntrance(3)}>
            <RecentActivity
              sessions={sessions}
              agentById={agentById}
              onOpenSession={(sessionId) => {
                // ROUND-44 (VLM pass): this used to navigate("/sessions") — a
                // route that does not exist (every recent-activity card dumped
                // the owner on the "Not found" placeholder). Open the session's
                // project chat at the exact session instead — the same URL shape
                // the shell sidebar uses (?session= is read by use-active-session).
                const session = sessions.find((s) => s.id === sessionId);
                if (session?.projectId) {
                  void navigate(`/project/${session.projectId}/chat?session=${session.id}`);
                } else {
                  // Legacy sessions with no project binding have no chat screen
                  // to land on — stay put (the card already shows the title).
                  void navigate("/");
                }
              }}
            />
          </motion.div>
        )}
      </div>
    </div>
  );
}
