import { motion } from "framer-motion";
import { Activity, FolderOpen, MessageSquare, Zap } from "lucide-react";
import { useNavigate } from "react-router";
import { useAgents } from "../../hooks/use-agents";
import { useSessions, useUsageSummary } from "../../hooks/use-sessions";
import { formatTokenCount } from "../../lib/format";
import { ease, fadeInUp, staggerContainer } from "../../lib/motion";
import { useProjectsStore } from "../../lib/projects-store";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useGreeting, withAlpha } from "./helpers";
import { StatCard } from "./StatCard";
import { TokenBarChart } from "./TokenBarChart";
import { QuickActions } from "./QuickActions";
import { RecentActivity } from "./RecentActivity";

/**
 * Dashboard screen (SPEC F7) — port of the dashboard demo's WelcomeView fed by
 * LIVE data: greeting header, stat cards (sessions / tokens / requests /
 * agents), the 14-day token bar chart from GET /usage/summary, quick actions
 * and recent activity. Rendered inside AppShell's main card.
 */
export function DashboardScreen() {
  const navigate = useNavigate();
  const styles = useThemeStyles();
  const greeting = useGreeting();

  const sessionsQuery = useSessions();
  const agentsQuery = useAgents(false);
  const usage = useUsageSummary(14);
  const projectCount = useProjectsStore((s) => s.projects.length);

  const sessions = sessionsQuery.data ?? [];
  const agentById = new Map((agentsQuery.data ?? []).map((a) => [a.id, a]));
  const totals = usage.data?.totals;
  const totalTokens = (totals?.inputTokens ?? 0) + (totals?.outputTokens ?? 0);
  const loadError = sessionsQuery.isError || agentsQuery.isError;

  return (
    <motion.div
      variants={fadeInUp}
      initial="initial"
      animate="animate"
      className="h-full overflow-y-auto p-4 md:p-6"
    >
      <div className="relative mx-auto max-w-3xl pb-10">
        {/* Decorative faded accent shapes (demo WelcomeView pattern). */}
        <div
          aria-hidden
          className="pointer-events-none absolute -left-16 -top-8 h-32 w-32 rounded-full blur-3xl"
          style={{ backgroundColor: styles.accent, opacity: 0.04 }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -top-4 right-0 h-24 w-24 rotate-12 rounded-2xl blur-2xl"
          style={{ backgroundColor: styles.theme.accent2, opacity: 0.03 }}
        />

        {/* Big two-line greeting (demo fidelity). */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease }}
          className="mb-8 pt-2"
        >
          <h1
            className="font-bold leading-[1.1] tracking-tight"
            style={{
              color: styles.text,
              fontSize: "clamp(2.5rem, 5vw, 4.5rem)",
            }}
          >
            {greeting}
          </h1>
          <h2
            className="font-medium leading-[1.15] tracking-tight"
            style={{
              color: styles.accent,
              fontSize: "clamp(2rem, 4vw, 3.5rem)",
              opacity: 0.8,
            }}
          >
            Welcome back to <span className="font-bold">Acute Code</span>
          </h2>
          <p className="mt-3 text-sm md:text-base" style={{ color: styles.textSecondary }}>
            Here&apos;s what&apos;s happening across your workspace.
          </p>
        </motion.div>

        {/* Stats grid */}
        <motion.div
          variants={staggerContainer}
          initial="initial"
          animate="animate"
          className="mb-5 grid grid-cols-2 gap-2.5 md:grid-cols-4"
        >
          <StatCard value={String(projectCount)} label="Projects" icon={FolderOpen} styles={styles} />
          <StatCard value={String(sessions.length)} label="Sessions" icon={MessageSquare} styles={styles} />
          <StatCard
            value={formatTokenCount(totalTokens)}
            label="Tokens Used"
            icon={Zap}
            title={`${totals?.inputTokens ?? 0} in / ${totals?.outputTokens ?? 0} out · last 14 days`}
            styles={styles}
          />
          <StatCard
            value={String(totals?.requests ?? 0)}
            label="API Requests"
            icon={Activity}
            title="Model calls over the last 14 days"
            styles={styles}
          />
        </motion.div>

        {/* Weekly chart + quick actions */}
        <div className="mb-6 grid grid-cols-1 gap-2.5 md:grid-cols-2">
          <TokenBarChart
            days={usage.data?.days ?? []}
            // A disabled query (demo mode) stays isPending forever — only show
            // the skeleton while a fetch is actually in flight.
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
            className="mb-6 rounded-lg border-[1.5px] border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-500"
          >
            Could not load live workspace data — check that the sidecar is running.
          </div>
        ) : null}

        {/* Recent activity */}
        {sessionsQuery.isPending ? (
          <div aria-label="Loading recent activity" className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-[58px] w-full animate-pulse rounded-lg"
                style={{ backgroundColor: withAlpha(styles.accent, 0.06) }}
              />
            ))}
          </div>
        ) : (
          <RecentActivity
            sessions={sessions}
            agentById={agentById}
            onOpenSession={() => void navigate("/sessions")}
            styles={styles}
          />
        )}
      </div>
    </motion.div>
  );
}
