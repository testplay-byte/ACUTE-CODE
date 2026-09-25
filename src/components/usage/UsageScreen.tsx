import { useState } from "react";
import { motion } from "framer-motion";
import { MessageSquare } from "lucide-react";
import { useNavigate } from "react-router";
import { useDetailedUsage, useUsageKeyPools } from "../../hooks/use-usage";
import { formatTokenCount } from "../../lib/format";
import { fadeInUp } from "../../lib/motion";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { cn } from "../../lib/utils";
import { KeyCards } from "./KeyCards";
import { ModelCards } from "./ModelCards";
import { ProjectsDrilldown } from "./ProjectsDrilldown";
import { ToolsLeaderboard } from "./ToolsLeaderboard";
import { UsageActivityChart } from "./UsageActivityChart";
// R127-W1 (SCREENS §3 "THE USAGE PAGE ORDER"): the activity grid's INSIGHTS
// RAIL (the key-details companion of the token-activity card) + the
// page-scope danger-zone card (extracted from DataStatsPanel — LAST).
import { InsightsRail } from "./InsightsRail";
import { ClearUsageDataCard } from "./ClearUsageDataCard";
// R98-I2: the Data & Statistics panel joins the overview — the same shared
// panel the settings ?tab=data surface hosts.
import { DataStatsPanel } from "./DataStatsPanel";
// R126-3b: the segmented-control day-range picker + the ONE-card stat row.
import { RangeSelector } from "./RangeSelector";
import { UsageStatRow, type StatCell } from "./UsageStatRow";
import { CLAY_CARD, formatCompactTokens } from "./usage-helpers";

/**
 * ROUND-52 (R52-b): the in-app Usage screen (/usage) — the owner-approved
 * DASHBOARD usage page layout rebuilt in the app's working-UI design
 * language. Sections: the range toolbar, overview stat row, activity chart +
 * tool leaderboard, model cards, API-key cards, and the projects → sessions
 * drill-down with nested sub-agent runs. Overview/drill-down rollups are
 * whole-history; `days` scopes the chart.
 *
 * R113-d (owner: the page headers are "unnecessary, unneeded, and not
 * required"): the Kicker + 24px "Usage" title + description hero is DELETED
 * — the chart's day-range selector survives as the ONE functional toolbar
 * row at the top (decoration dies, controls stay).
 *
 * ROUND-126 (R126-3b, the Clay Companion redesign): the screen rides the
 * Instrument archetype's clay materials (SCREENS §3) — the segmented-control
 * range grammar, the ONE-clay-card stat row (no icon chips), clay chart
 * cards + tooltips, `bg-well` skeletons, and the mobile minimal-center empty
 * state (one icon tile + one line + one action, PC-densified).
 *
 * ROUND-127 (R127-W1 — SCREENS §3 "THE USAGE PAGE ORDER", binding): (1) the
 * range toolbar; (2) the overview stat row; (3) the activity grid — Token
 * Activity at 2-cols + the INSIGHTS RAIL at 1-col (the window's key details:
 * top model + share, peak day, busiest tool, active projects — NEVER the
 * tools leaderboard, the owner's placement complaint); (4) the tools
 * leaderboard as its own full-width section BELOW the grid; (5) the Data &
 * Statistics panel (heatmap → model mix → donut → agent health) with the
 * per-model list (ModelCards) DIRECTLY below it; (6) key cards; (7) the
 * projects drill-down; (8) THE DANGER ZONE LAST (the standalone
 * ClearUsageDataCard — the page's final section, never interleaved
 * mid-page).
 */

const RANGE_OPTIONS = [7, 14, 30, 90] as const;

export function UsageScreen() {
  const navigate = useNavigate();
  const styles = useThemeStyles();
  const [days, setDays] = useState(30);
  // R127-W2 (the owner's hourly ask — "if I select it to seven days… then it
  // only shows seven bars… instead of seven days, it would show me a much
  // better kind of view, like hourly based"): the 7-day window rides the
  // HOURLY series (granularity=hour on GET /usage/detailed — 168
  // "YYYY-MM-DDThh" buckets at 6px bars ≈ 1.34Kpx of scrolling chart, the
  // fat-bars-with-empty-sides defect dead); every other window keeps the
  // daily series (and the historical single-arg fetch shape — every
  // existing exact-args pin stays true).
  const granularity = days === 7 ? "hour" : "day";
  const usage = useDetailedUsage(days, granularity);
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
      <div className="mx-auto w-full max-w-[1280px] xl:max-w-[1480px] 2xl:max-w-[1640px] px-5 md:px-8 2xl:px-14 py-4 md:py-6 pb-16">
        {/* R113-d: the hero is GONE (owner directive — see the file header);
            the day-range picker stays as the one functional toolbar row at
            the top of the page, right-aligned where it always lived.
            R126-3b: the picker is the SEGMENTED-CONTROL grammar (bg-well
            track + the gliding bg-accent-deep knob on TAB_SPRING). */}
        <div className="mb-4 md:mb-6 flex justify-end">
          <RangeSelector
            options={RANGE_OPTIONS}
            selected={days}
            onChange={setDays}
            groupLabel="Activity chart day range"
            optionAriaLabel={(option) => `Last ${option} days`}
            testId="usage-range-selector"
          />
        </div>

        {loading ? (
          /* Loading skeletons — R126-3b (TOKENS §10 law 4): skeleton blocks
             ride the WELL (bg-well + the rim hairline), never bg-subtle; the
             stat skeleton mirrors the ONE-card 4-cell ready geometry. */
          <>
            <div
              aria-label="Loading usage overview"
              className={cn(CLAY_CARD, "mb-4 md:mb-6 grid grid-cols-2 md:grid-cols-4")}
            >
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className={cn(
                    "h-[92px] animate-pulse border-clay-rim bg-well",
                    i === 1 || i === 3 ? "border-l" : "",
                    i >= 2 ? "border-t md:border-t-0" : "",
                  )}
                />
              ))}
            </div>
            <div
              aria-label="Loading usage activity"
              className={cn(CLAY_CARD, "mb-4 md:mb-6 h-[248px] w-full animate-pulse bg-well")}
            />
            <div className="flex flex-col gap-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className={cn(CLAY_CARD, "h-[64px] w-full animate-pulse bg-well")} />
              ))}
            </div>
          </>
        ) : usage.isError ? (
          /* R126 (TOKENS §11): the retryable error banner is the danger
             BADGE-TONE container — tinted container + deep-on-tint ink,
             never a flat-hue danger text on an alpha wash (the pre-R126
             withAlpha grammar died with §11); the Retry button is the
             outlined danger species (COMPONENTS §4). */
          <div
            role="alert"
            className="mb-4 md:mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-badge-danger px-4 py-3 text-[12px] font-medium text-badge-danger-fg"
          >
            <span className="min-w-0">
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
              className="h-7 shrink-0 cursor-pointer rounded-lg border border-danger-deep px-3 text-[12px] font-semibold text-danger-deep transition-opacity duration-100 hover:opacity-85 active:scale-[0.98]"
            >
              Retry
            </button>
          </div>
        ) : !hasData ? (
          <>
            {/* Empty state — R126-3b: the mobile minimal-center shape
                PC-densified (one icon tile + one line + one action) on the
                clay card. */}
            <div className={cn(CLAY_CARD, "mb-4 md:mb-6 flex flex-col items-center gap-3 px-6 py-10 text-center")}>
              <span
                aria-hidden
                className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-tint text-accent-deep"
              >
                <MessageSquare size={18} strokeWidth={2} />
              </span>
              <p className="text-[13px] font-semibold" style={{ color: styles.text }}>
                No usage yet — start a conversation
              </p>
              {/* R126-3b: the ONE action is the quiet-solid clay primary
                  (COMPONENTS §4 — h-9, rounded-lg, 13px/600, the accentText
                  pair via the JS leg, press = 0.98). */}
              <button
                type="button"
                onClick={() => void navigate("/")}
                className="h-9 cursor-pointer rounded-lg bg-accent-deep px-4 text-[13px] font-semibold transition-transform active:scale-[0.98]"
                style={{ color: styles.accentText }}
              >
                Open a chat
              </button>
            </div>
            {/* ROUND-64 (R64-e): configured keys still show with "not used yet". */}
            {keyCardsSection}
          </>
        ) : (
          <>
            {/* Overview stat row — R126-3b (SCREENS §3): ONE clay card, four
                cells with 1px inset border-strong dividers, kicker labels,
                22px/600 tabular values, one supporting line, NO icon chips. */}
            <div className="mb-4 md:mb-6">
              <UsageStatRow
                testId="usage-stat-row"
                ariaLabel="Usage overview"
                cells={
                  [
                    {
                      value: formatTokenCount(totalTokens),
                      label: "Tokens",
                      sub: `${formatCompactTokens(totals?.tokens.input ?? 0)} in · ${formatCompactTokens(totals?.tokens.output ?? 0)} out`,
                      title: `All-time input + output tokens — ${(totals?.tokens.input ?? 0).toLocaleString()} in / ${(totals?.tokens.output ?? 0).toLocaleString()} out${(totals?.tokens.cached ?? 0) > 0 ? ` · ${(totals?.tokens.cached ?? 0).toLocaleString()} cached` : ""}`,
                    },
                    {
                      value: (totals?.requests ?? 0).toLocaleString(),
                      label: "Turns",
                      sub:
                        totals?.providerCalls !== undefined
                          ? `${totals.providerCalls.toLocaleString()} provider calls`
                          : "one row per turn",
                      title: `All-time turns in the usage ledger${totals?.providerCalls !== undefined ? ` · ${(totals.providerCalls).toLocaleString()} provider calls (ROUND-83: the real SDK-call count — a multi-iteration turn is 1 turn · N calls)` : " (one row per turn since R24)"}`,
                    },
                    {
                      value: String((totals?.sessions ?? 0) + (totals?.subagentSessions ?? 0)),
                      label: "Sessions",
                      sub: `${totals?.sessions ?? 0} main + ${totals?.subagentSessions ?? 0} sub-agents`,
                      title: `${totals?.sessions ?? 0} main sessions + ${totals?.subagentSessions ?? 0} sub-agent runs (delegated via delegate_task)`,
                    },
                    {
                      value: (totals?.toolCalls ?? 0).toLocaleString(),
                      label: "Tool calls",
                      sub: `across ${usage.data?.tools.length ?? 0} tools`,
                      title: `All-time tool invocations across ${usage.data?.tools.length ?? 0} distinct tools`,
                    },
                  ] satisfies StatCell[]
                }
              />
            </div>

            {/* Activity grid — R127-W1 (SCREENS §3 order step 3): Token
                Activity at 2-cols + the INSIGHTS RAIL at 1-col. The tools
                leaderboard that used to squat this rail is now its own
                full-width section below the grid (the owner's "should not be
                shown just right of the token activity" directive). */}
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
                  granularity={granularity}
                  isPending={false}
                  isError={false}
                  delay={0.2}
                  styles={styles}
                />
              </div>
              <InsightsRail
                models={usage.data?.models ?? []}
                days={usage.data?.days ?? []}
                tools={usage.data?.tools ?? []}
                projectCount={usage.data?.projects.length ?? 0}
                styles={styles}
              />
            </div>

            {/* Tools leaderboard — R127-W1 (SCREENS §3 order step 4): its own
                FULL-WIDTH hairline section BELOW the activity grid (same clay
                card + data contract; the rows stretch to the page width). */}
            <div className="mb-4 md:mb-6">
              <ToolsLeaderboard tools={usage.data?.tools ?? []} styles={styles} />
            </div>

            {/* R98-I2 (owner: "Data & statistics … shown in BOTH the
                settings tab AND the usage screen"): the shared panel slots
                below the activity/leaderboard grid — the 12-month heatmap,
                the model-mix stack chart + donut, and agent health (R127-W1:
                the danger zone moved out — it closes the page now, not the
                panel). The panel owns its own query + months picker, so it
                works identically here and in settings. */}
            <div className="mb-4 md:mb-6">
              <DataStatsPanel />
            </div>

            {/* Model mix — R127-W1 (SCREENS §3 order step 5): the individual
                per-model usage sits DIRECTLY below the Data & Statistics
                panel (the donut's card group) — the owner's "supposed to be
                shown below the Model Usage" directive. The list reads
                usage.data.models (whole-history); the donut inside the panel
                reads the months window — ModelCards' sub-caption states the
                scope difference. */}
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

            {/* THE DANGER ZONE, LAST — R127-W1 (SCREENS §3 order step 8 +
                COMPONENTS §6 at PAGE scope): the standalone clear-all-data
                card closes the page (the owner's "supposed to be shown at the
                very bottom" directive — it used to sit inside DataStatsPanel,
                mid-page between agent health and this list). */}
            <ClearUsageDataCard />
          </>
        )}
      </div>
    </motion.div>
  );
}
