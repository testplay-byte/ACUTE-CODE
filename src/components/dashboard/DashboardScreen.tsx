import { motion } from "framer-motion";
import { Activity, FolderOpen, MessageSquare, Zap } from "lucide-react";
import { useNavigate } from "react-router";
import { useAgents } from "../../hooks/use-agents";
import { useProjects } from "../../hooks/use-projects";
import { useSessions, useUsageSummary } from "../../hooks/use-sessions";
import { formatTokenCount } from "../../lib/format";
import { ease, fadeInUp, staggerContainer } from "../../lib/motion";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
// R100-G (research §C2 P3 + §C3): the de-costumed hero rides the round-100
// Kicker primitive (label tier) + the 24px/600 title.
import { Kicker } from "../ui/Kicker";
import { useGreeting, withAlpha } from "./helpers";
import { SkeletonBlock } from "../shared/Skeletons";
import { StatCard } from "./StatCard";
import { TokenBarChart } from "./TokenBarChart";
import { QuickActions } from "./QuickActions";
import { RecentActivity } from "./RecentActivity";

/**
 * Dashboard screen (round-21 UI overhaul): the working-UI card ladder
 * (1280→1640px container), StatCard row, section labels and softShadow
 * cards (de-costumed R100-G per research §C2 P3 + §C3 — the wizard-DNA
 * hero violations below are deleted, not restyled). AppShell's main is
 * transparent; cards float.
 */
export function DashboardScreen() {
  const navigate = useNavigate();
  const styles = useThemeStyles();
  const greeting = useGreeting();

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

  // R100-G: the greeting is ONE plain title now — the accent-box split
  // (last word in the rotated highlight) was the wizard display hero this
  // wave deleted; the time-of-day greeting reads fine as a 24px/600 title.

  return (
    <motion.div
      variants={fadeInUp}
      initial="initial"
      animate="animate"
      className="h-full overflow-y-auto"
    >
      <div className="mx-auto w-full max-w-[1280px] xl:max-w-[1480px] 2xl:max-w-[1640px] px-5 md:px-8 2xl:px-14 py-6 md:py-10 pb-16">
        {/* Hero — R100-G (research §C2 P3): the de-costumed working-screen
            header — label-tier Kicker + 24px/600 title + one-line 13px
            secondary description (the rotated accent-box font-black display
            hero is deleted: wizard DNA stays in the wizard). */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease }}
          className="mb-8 md:mb-10"
        >
          <Kicker className="mb-1">Workspace Overview</Kicker>
          <h1 className="text-[24px] font-semibold tracking-tight leading-[1.2]" style={{ color: styles.text }}>
            {greeting}
          </h1>
          <p
            className="mt-2 text-[13px] max-w-[520px]"
            style={{ color: styles.textSecondary }}
          >
            Here&apos;s what&apos;s happening across your workspace.
          </p>
        </motion.div>

        {/* Stat cards — the bento recipe: card bg, softShadow, solid accent
            icon tiles. R97-I part 2: while any source is still loading the
            row is 4 StatCard-shaped skeleton blocks in the same grid (92px
            tall, 16px radius — the UsageScreen loading recipe), announced
            once by the role=status wrapper. NEVER false zeros. */}
        {statsLoading ? (
          <div
            role="status"
            aria-label="Loading workspace stats"
            data-stats-skeleton
            className="mb-4 md:mb-6 grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4"
          >
            {[0, 1, 2, 3].map((i) => (
              <SkeletonBlock
                key={i}
                className="h-[92px] w-full border-[1.5px] rounded-2xl"
                style={{ borderColor: styles.borderSubtle }}
              />
            ))}
          </div>
        ) : (
          <motion.div
            variants={staggerContainer}
            initial="initial"
            animate="animate"
            className="mb-4 md:mb-6 grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4"
          >
            <StatCard value={String(projectCount)} label="Projects" icon={FolderOpen} styles={styles} />
            <StatCard value={String(sessions.length)} label="Sessions" icon={MessageSquare} styles={styles} />
            <StatCard
              value={formatTokenCount(totalTokens)}
              label="Tokens"
              icon={Zap}
              title={`${totals?.inputTokens ?? 0} in / ${totals?.outputTokens ?? 0} out · last 14 days`}
              styles={styles}
              highlight
            />
            <StatCard
              value={String(totals?.requests ?? 0)}
              label="Turns"
              icon={Activity}
              title="Turns over the last 14 days (one usage row per turn — the ROUND-83 honest relabel; provider calls live on the /usage screen)"
              styles={styles}
            />
          </motion.div>
        )}

        {/* Chart + Quick Actions — the bento card scale (rounded-2xl, p-4/5) */}
        <div className="mb-4 md:mb-6 grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
          <TokenBarChart
            days={usage.data?.days ?? []}
            isPending={usage.isPending && usage.isFetching}
            isError={usage.isError}
            delay={0.2}
            styles={styles}
          />
          <QuickActions onNavigate={(to) => void navigate(to)} styles={styles} />
        </div>

        {loadError ? (
          <div
            role="alert"
            className="mb-4 md:mb-6 rounded-2xl border-[1.5px] px-4 py-3 text-[12px] font-medium flex flex-wrap items-center gap-x-3 gap-y-1"
            style={{
              borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.3),
              background: withAlpha(SEMANTIC_COLORS.danger, 0.08),
              color: SEMANTIC_COLORS.danger,
            }}
          >
            <span>
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
              className="shrink-0 h-7 px-3 rounded-lg text-[12px] font-semibold border transition-opacity hover:opacity-85"
              style={{ borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.45), color: SEMANTIC_COLORS.danger }}
            >
              Retry
            </button>
          </div>
        ) : null}

        {/* Recent activity */}
        {sessionsQuery.isPending ? (
          <div aria-label="Loading recent activity" className="flex flex-col gap-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-[64px] w-full animate-pulse rounded-2xl border-[1.5px]"
                style={{ backgroundColor: styles.subtle, borderColor: styles.borderSubtle }}
              />
            ))}
          </div>
        ) : (
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
            styles={styles}
          />
        )}
      </div>
    </motion.div>
  );
}
