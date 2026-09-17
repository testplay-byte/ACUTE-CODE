import { useState } from "react";
import { motion } from "framer-motion";
import { Activity, MessageSquare, Wrench, Zap } from "lucide-react";
import { useNavigate } from "react-router";
import { useDetailedUsage, useUsageKeyPools } from "../../hooks/use-usage";
import { formatTokenCount } from "../../lib/format";
import { ease, fadeInUp, staggerContainer } from "../../lib/motion";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
// R100-G (research §C2 P3 + §C3): the de-costumed hero rides the round-100
// primitives — the Kicker (label tier) + 24px/600 title; the empty state's
// framing card rides SectionCard.
import { Kicker } from "../ui/Kicker";
import { SectionCard } from "../ui/SectionCard";
import { StatCard } from "../dashboard/StatCard";
import { withAlpha } from "../dashboard/helpers";
import { KeyCards } from "./KeyCards";
import { ModelCards } from "./ModelCards";
import { ProjectsDrilldown } from "./ProjectsDrilldown";
import { ToolsLeaderboard } from "./ToolsLeaderboard";
import { UsageActivityChart } from "./UsageActivityChart";
// R98-I2: the Data & Statistics panel joins the overview — the same shared
// panel the settings ?tab=data surface hosts.
import { DataStatsPanel } from "./DataStatsPanel";

/**
 * ROUND-52 (R52-b): the in-app Usage screen (/usage) — the owner-approved
 * DASHBOARD usage page layout rebuilt in the app's working-UI design
 * language (DashboardScreen's container ladder, StatCard/TokenBarChart
 * patterns, useThemeStyles colors, framer-motion entrance). Sections: hero +
 * range selector, overview stat cards, activity chart + tool leaderboard,
 * model cards, and the projects → sessions drill-down with nested
 * sub-agent runs. Overview/drill-down rollups are whole-history; `days`
 * scopes the chart.
 *
 * R100-G (research §C2 P3): the hero is DE-COSTUMED — the rotated
 * accent-box font-black display (clamp 2.75–4.5rem + -rotate-1 +
 * bentoShadow, WIZARD-DNA §8's working-screen violations) is replaced by
 * the label-tier Kicker + 24px/600 title + one-line 13px secondary
 * description (the SettingsPage header grammar). The chart's range picker
 * snapped to the DataStatsPanel picker grammar (rounded-xl segments,
 * rounded-lg buttons, 600 weights).
 */

const RANGE_OPTIONS = [7, 14, 30, 90] as const;

function RangeSelector({
  days,
  onChange,
  styles,
}: {
  days: number;
  onChange: (days: number) => void;
  styles: ReturnType<typeof useThemeStyles>;
}) {
  const { card, border, accent, accentText, textSecondary, softShadow } = styles;
  return (
    <div
      role="group"
      aria-label="Activity chart day range"
      className="flex shrink-0 items-center gap-1 rounded-xl border-[1.5px] p-1"
      style={{ backgroundColor: card, borderColor: border, boxShadow: softShadow }}
    >
      {RANGE_OPTIONS.map((option) => {
        const active = option === days;
        return (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            aria-pressed={active}
            aria-label={`Last ${option} days`}
            className="cursor-pointer rounded-lg px-2.5 py-1.5 text-[12px] font-semibold tabular-nums transition-colors duration-200"
            style={{ backgroundColor: active ? accent : "transparent", color: active ? accentText : textSecondary }}
          >
            {option}d
          </button>
        );
      })}
    </div>
  );
}

export function UsageScreen() {
  const navigate = useNavigate();
  const styles = useThemeStyles();
  const [days, setDays] = useState(30);
  const usage = useDetailedUsage(days);
  // ROUND-64 (R64-e): the "API keys" section's join data — providers +
  // masked key pools (live sidecar only, same dashboard semantics).
  const keyPools = useUsageKeyPools();

  const totals = usage.data?.totals;
  const totalTokens = (totals?.tokens.input ?? 0) + (totals?.tokens.output ?? 0);
  // Demo mode leaves the query idle at isPending — isFetching separates
  // "loading" from "disabled" so the screen settles on its empty state.
  const loading = usage.isPending && usage.isFetching;
  const hasData = (totals?.sessions ?? 0) + (totals?.subagentSessions ?? 0) > 0;

  // The keys section renders in BOTH branches — a configured key shows
  // ("not used yet") even when the ledger has no sessions yet, so the owner
  // sees every key he configured the moment he opens /usage.
  const keyCardsSection = (
    <KeyCards
      usageKeys={usage.data?.keys ?? []}
      providers={keyPools.providers}
      poolsById={keyPools.poolsById}
      settledPoolIds={keyPools.settledPoolIds}
      providersSettled={keyPools.providersSettled}
      isPending={keyPools.isPending}
      styles={styles}
    />
  );

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
            secondary description (the rotated accent-box display hero is
            deleted: wizard DNA stays in the wizard) — with the chart's
            day-range picker beside it */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease }}
          className="mb-8 md:mb-10 flex flex-col gap-4 md:flex-row md:items-end md:justify-between"
        >
          <div className="min-w-0">
            <Kicker className="mb-1">Data &amp; Statistics</Kicker>
            <h1
              className="text-[24px] font-semibold tracking-tight leading-[1.2]"
              style={{ color: styles.text }}
            >
              Usage
            </h1>
            <p
              className="mt-2 text-[13px] max-w-[560px]"
              style={{ color: styles.textSecondary }}
            >
              Every project, every session, every tool call — tokens, cost and
              model mix from the local ledger. Overview and drill-down cover
              all time; the chart shows the last {days} days.
            </p>
          </div>
          <RangeSelector days={days} onChange={setDays} styles={styles} />
        </motion.div>

        {loading ? (
          /* Loading skeletons — the dashboard's pulse-card recipe */
          <>
            <div aria-label="Loading usage overview" className="mb-4 md:mb-6 grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-[92px] w-full animate-pulse rounded-2xl border-[1.5px]"
                  style={{ backgroundColor: styles.subtle, borderColor: styles.borderSubtle }}
                />
              ))}
            </div>
            <div
              aria-label="Loading usage activity"
              className="mb-4 md:mb-6 h-[248px] w-full animate-pulse rounded-2xl border-[1.5px]"
              style={{ backgroundColor: styles.subtle, borderColor: styles.borderSubtle }}
            />
            <div className="flex flex-col gap-3">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-[64px] w-full animate-pulse rounded-2xl border-[1.5px]"
                  style={{ backgroundColor: styles.subtle, borderColor: styles.borderSubtle }}
                />
              ))}
            </div>
          </>
        ) : usage.isError ? (
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
              Could not load usage analytics — check that the sidecar is running,
              then reload.
            </span>
            {/* R97-I part 2 (owner: a UI "aware of its states"): the banner
                is RETRYABLE — pre-R97 it pointed at a full app reload for
                what one refetch fixes. */}
            <button
              type="button"
              onClick={() => void usage.refetch()}
              aria-label="Retry loading usage analytics"
              className="shrink-0 h-7 px-3 rounded-lg text-[12px] font-semibold border transition-opacity hover:opacity-85"
              style={{ borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.45), color: SEMANTIC_COLORS.danger }}
            >
              Retry
            </button>
          </div>
        ) : !hasData ? (
          <>
            {/* Empty state — the whole ledger is blank (R100-G: SectionCard
                framing + the ladder's section tier for the title). */}
            <SectionCard ariaLabel="Usage empty state" size="lg" className="py-10 text-center">
              <p className="text-[13px] font-semibold" style={{ color: styles.text }}>
                No usage yet — start a conversation
              </p>
              <p className="mt-1.5 text-[12px]" style={{ color: styles.textSecondary }}>
                Tokens, tool calls and sub-agent runs land here the moment your
                first session makes a model call.
              </p>
            </SectionCard>
            {/* ROUND-64 (R64-e): configured keys still show with "not used yet". */}
            {keyCardsSection}
          </>
        ) : (
          <>
            {/* Overview stat cards — wizard recipe (StatCard, dashboard's row) */}
            <motion.div
              variants={staggerContainer}
              initial="initial"
              animate="animate"
              className="mb-4 md:mb-6 grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4"
            >
              <StatCard
                value={formatTokenCount(totalTokens)}
                label="Tokens"
                icon={Zap}
                title={`All-time input + output tokens — ${(totals?.tokens.input ?? 0).toLocaleString()} in / ${(totals?.tokens.output ?? 0).toLocaleString()} out${(totals?.tokens.cached ?? 0) > 0 ? ` · ${(totals?.tokens.cached ?? 0).toLocaleString()} cached` : ""}`}
                styles={styles}
                highlight
              />
              <StatCard
                value={(totals?.requests ?? 0).toLocaleString()}
                label="Turns"
                icon={Activity}
                title={`All-time turns in the usage ledger${totals?.providerCalls !== undefined ? ` · ${(totals.providerCalls).toLocaleString()} provider calls (ROUND-83: the real SDK-call count — a multi-iteration turn is 1 turn · N calls)` : " (one row per turn since R24)"}`}
                styles={styles}
              />
              <StatCard
                value={String((totals?.sessions ?? 0) + (totals?.subagentSessions ?? 0))}
                label="Sessions"
                icon={MessageSquare}
                title={`${totals?.sessions ?? 0} main sessions + ${totals?.subagentSessions ?? 0} sub-agent runs (delegated via delegate_task)`}
                styles={styles}
              />
              <StatCard
                value={(totals?.toolCalls ?? 0).toLocaleString()}
                label="Tool calls"
                icon={Wrench}
                title={`All-time tool invocations across ${usage.data?.tools.length ?? 0} distinct tools`}
                styles={styles}
              />
            </motion.div>

            {/* Activity chart + tool leaderboard */}
            <div className="mb-4 md:mb-6 grid grid-cols-1 lg:grid-cols-3 gap-3 md:gap-4">
              <div className="lg:col-span-2 min-w-0">
                {/* UsageActivityChart STAYS (the R52-b input/output view) —
                    the DataStatsPanel's ModelStackChart below is the MODEL
                    view of the same ledger; the two answer different
                    questions (in/out split vs. which model burned it), so
                    both render by design (R98-I2). */}
                <UsageActivityChart
                  days={usage.data?.days ?? []}
                  dayCount={days}
                  isPending={false}
                  isError={false}
                  delay={0.2}
                  styles={styles}
                />
              </div>
              <ToolsLeaderboard tools={usage.data?.tools ?? []} styles={styles} />
            </div>

            {/* R98-I2 (owner: "Data & statistics … shown in BOTH the
                settings tab AND the usage screen"): the shared panel slots
                below the activity/leaderboard grid — the 12-month heatmap,
                the model-mix stack chart + donut, agent health, and the
                clear-all-data card. The panel owns its own query + months
                picker, so it works identically here and in settings. */}
            <div className="mb-4 md:mb-6">
              <DataStatsPanel />
            </div>

            {/* Model mix */}
            <ModelCards models={usage.data?.models ?? []} styles={styles} />

            {/* ROUND-64 (R64-e): per-API-key stats — one card per key. */}
            {keyCardsSection}

            {/* Projects → sessions drill-down (sub-agents nest under parents) */}
            <ProjectsDrilldown
              projects={usage.data?.projects ?? []}
              onOpenSession={(sessionId, projectId) => {
                // Same deep-link shape RecentActivity uses (?session= is read
                // by use-active-session). Orphaned/legacy sessions with no
                // project binding have no chat screen — stay put.
                if (projectId) {
                  void navigate(`/project/${projectId}/chat?session=${sessionId}`);
                } else {
                  void navigate("/");
                }
              }}
              styles={styles}
            />
          </>
        )}
      </div>
    </motion.div>
  );
}
