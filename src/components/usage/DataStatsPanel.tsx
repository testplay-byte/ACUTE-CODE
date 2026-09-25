import { useState } from "react";
import { motion } from "framer-motion";
import {
  HeartPulse,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { type UsageStatsHealthIssue } from "../../lib/api";
import { useUsageStats } from "../../hooks/use-usage";
import { formatTokenCount } from "../../lib/format";
import { ease } from "../../lib/motion";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { utcDateLabel } from "../dashboard/helpers";
import { Kicker } from "../ui/Kicker";
import { ModelDonut } from "./ModelDonut";
import { ModelStackChart } from "./ModelStackChart";
import { UsageHeatmap } from "./UsageHeatmap";
import { RangeSelector } from "./RangeSelector";
import { UsageStatRow, type StatCell } from "./UsageStatRow";
import { CLAY_CARD, CLAY_CARD_SM, formatCompactTokens, formatCost } from "./usage-helpers";
import { cn } from "../../lib/utils";

/**
 * ROUND-98 (R98-I2, owner: "Data & statistics"): the ONE panel rendered in
 * BOTH the settings "Data & Statistics" tab AND the /usage screen — total
 * tokens, peak day, total cost and turns; the token-activity heatmap; the
 * per-day model-mix stacked chart + the model donut (color-coded BY MODEL
 * NAME — same name across providers is one model, same color everywhere);
 * and agent health.
 *
 * ROUND-127 (R127-W1 amendment, SCREENS §3 "THE USAGE PAGE ORDER"): the
 * clear-all-data DANGER ZONE no longer lives here — it moved BYTE-WHOLESALE
 * into the standalone ClearUsageDataCard so it can close the PAGE (and the
 * settings tab) as its final section (the danger-zone law applies at PAGE
 * scope, not panel scope — the owner's "very bottom" directive). The panel
 * now ends at agent health; both mount sites render ClearUsageDataCard
 * after it.
 *
 * ROUND-99 (R99-E, owner: "the data and statistics… not that well handled…
 * some things seem out of place"): the section ORDER is the GitHub-settings
 * read — stats → heatmap → model charts → ONE unified "Agent health"
 * section (two QUIET sub-blocks; severity rides the icon + number color,
 * never a tinted card) → the DANGER ZONE always LAST (red-outlined quiet
 * box, description-left / action-button-right; the exact enumeration lives
 * in the ConfirmDialog as before). The anti-jitter kit (research §3.2):
 * every chart wrapper reserves its final height so loading→ready→window
 * switches never shift layout, the skeleton below mirrors the ready
 * geometry section-for-section, and EVERY number renders tabular-nums.
 *
 * The panel OWNS its query (useUsageStats) + the months picker (6/12/24)
 * so both mount sites stay one-liners. State gates per R97-I: loading =
 * well-pulsing skeleton blocks with ONE role="status" announcement;
 * error = role="alert" with the exact cause and ONE Retry that re-drives
 * the query.
 *
 * ROUND-126 (R126-3b, the Clay Companion redesign): the material pass —
 * the stat row is the ONE-clay-card 4-cell grammar (UsageStatRow, SCREENS
 * §3), the months picker is the SEGMENTED-CONTROL grammar (RangeSelector —
 * bg-well track + the gliding bg-accent-deep knob on TAB_SPRING), the
 * health sub-blocks are compact clay tiles, and the skeleton blocks ride
 * the WELL (`bg-well` — TOKENS §10 law 4). The DANGER ZONE keeps its
 * dedicated grammar UNCHANGED (COMPONENTS §6: the quiet red-OUTLINED box,
 * 1.5px withAlpha(danger, 0.4) border, no fill, no shadow, LAST — the
 * documented exception).
 */

const MONTHS_OPTIONS = [6, 12, 24] as const;

/** One well-pulsing skeleton block — R126-3b's `bg-well` spelling (TOKENS
 *  §10 law 4: skeletons ride the well, never bg-subtle). */
function WellSkeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-2xl bg-well", className)} />;
}

/** The months-switch settle — opacity ONLY, 150ms (MOTION §2 quick tier).
 * Keyed by the window so the swapped stats/heatmap/donut dip-and-settle
 * like a native filter change; NEVER a layout animation (the charts keep
 * fixed geometry, so there is nothing to animate but the ink). */
function QuickFade({
  windowKey,
  children,
  className,
}: {
  windowKey: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      key={windowKey}
      initial={{ opacity: 0.45 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, ease }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function DataStatsPanel() {
  const styles = useThemeStyles();
  const [months, setMonths] = useState<(typeof MONTHS_OPTIONS)[number]>(12);
  const stats = useUsageStats(months);

  const { text, textSecondary } = styles;

  /* R97-I gates — the error branch FIRST (a failed GET must never hang on
   * "loading…"), then the loading branch (demo mode leaves the query idle
   * at isPending — isFetching separates "loading" from "disabled"). */
  if (stats.isError && stats.data === undefined) {
    const cause = stats.error instanceof Error ? stats.error.message : String(stats.error);
    return (
      <div data-testid="data-stats-panel" className="flex w-full flex-col gap-4">
        {/* R126 (TOKENS §11): the retryable error card is the danger
            BADGE-TONE container — tinted container + deep-on-tint ink, never
            a flat-hue danger text on an alpha wash (the pre-R126 withAlpha
            grammar died with §11); the Retry button is the outlined danger
            species (COMPONENTS §4). */}
        <div
          role="alert"
          className="rounded-xl bg-badge-danger px-4 py-3.5 text-badge-danger-fg"
        >
          {/* R100-E2: 13px/600 (the error heading is a section header, the
              weight law's 600 tier — the old 12.5px-bold was off-ladder). */}
          <div className="text-[13px] font-semibold">
            Could not load data &amp; statistics
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed">
            The agent sidecar may be down or the request was rejected — {cause}.
          </p>
          <button
            type="button"
            onClick={() => void stats.refetch()}
            aria-label="Retry loading data and statistics"
            className="mt-3 h-8 cursor-pointer rounded-lg border border-danger-deep px-3.5 text-[12px] font-semibold text-danger-deep transition-opacity duration-100 hover:opacity-85 active:scale-[0.98]"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (stats.isPending && stats.isFetching) {
    return (
      <div
        data-testid="data-stats-panel"
        role="status"
        aria-label="Loading data and statistics"
        className="flex w-full flex-col gap-4"
      >
        {/* R99-E anti-jitter: the skeleton mirrors the READY geometry
            section-for-section (header → the ONE-card stat row → heatmap →
            stack → donut → agent health — same heights, same order) so the
            loading→ready swap never shifts the layout. R126-3b: the blocks
            pulse in the WELL (bg-well). R127-W1: the trailing h-[96px]
            danger-zone block DIED with the zone's extraction into
            ClearUsageDataCard (the panel no longer renders it). */}
        <WellSkeleton className="h-[56px] rounded-xl" />
        <div className={cn(CLAY_CARD, "grid grid-cols-2 md:grid-cols-4")}>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={cn(
                "h-[92px] animate-pulse bg-well",
                i === 1 || i === 3 ? "border-l border-clay-rim" : "",
                i >= 2 ? "border-t border-clay-rim md:border-t-0" : "",
              )}
            />
          ))}
        </div>
        <WellSkeleton className="h-[184px] md:h-[192px]" />
        <WellSkeleton className="h-[264px] md:h-[272px]" />
        {/* R127-W2 (the donut GAUGE law — COMPONENTS §6): the donut block's
            mirror grew to the gauge ring's reserved height (160px ring +
            14px stroke + the display-tier center stat — the ready card's
            min-h-[224px]/md:232px). The ONE sanctioned W2 edit in this
            file; the heatmap's own h-[184px]/md:192px mirror above is
            W1's and stays. */}
        <WellSkeleton className="h-[224px] md:h-[232px]" />
        <div>
          <div className="mb-2.5">
            <WellSkeleton className="h-[13px] w-[120px] rounded-sm" />
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
            {[0, 1].map((i) => (
              <WellSkeleton key={i} className="h-[72px]" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const data = stats.data;
  if (data === undefined) {
    // Demo mode (the query stays idle): the honest empty panel.
    return (
      <div data-testid="data-stats-panel" className="flex w-full flex-col gap-4">
        <div className={cn(CLAY_CARD, "p-8 text-center")}>
          <p className="text-[13px] font-semibold" style={{ color: text }}>
            No usage statistics available
          </p>
          <p className="mt-1.5 text-[12px]" style={{ color: textSecondary }}>
            Statistics come from the live agent sidecar's usage ledger — they land here
            once your first session makes a model call.
          </p>
        </div>
      </div>
    );
  }

  const totals = data.totals;
  const peak = data.peak;

  return (
    <div data-testid="data-stats-panel" className="flex w-full flex-col gap-4">
      {/* 1 — the months window picker (drives the whole panel's query).
          R126-3b: the SEGMENTED-CONTROL grammar (the shared RangeSelector). */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
        <div>
          {/* R100-E2: the panel title snapped 16px/font-black → 13px/600 (the
              ladder's section tier — the settings page header and the /usage
              hero each carry the page-level title above it, TOKENS.md §2). */}
          <h2 className="text-[13px] font-semibold" style={{ color: text }}>
            Data &amp; Statistics
          </h2>
          <p className="mt-1 text-[12px]" style={{ color: textSecondary }}>
            Tokens, cost, model mix and agent health over the selected window.
          </p>
        </div>
        <RangeSelector
          options={MONTHS_OPTIONS}
          selected={months}
          onChange={(value) => {
            setMonths(value as (typeof MONTHS_OPTIONS)[number]);
          }}
          groupLabel="Statistics months window"
          optionAriaLabel={(option) => `Last ${option} months`}
          suffix="mo"
          testId="stats-months-selector"
        />
      </div>

      {/* 2 — the headline stat row (R126-3b: the ONE-clay-card 4-cell
          grammar, UsageStatRow; h-[92px] cells + tabular-nums — the
          anti-jitter contract). */}
      <QuickFade windowKey={months}>
        <UsageStatRow
          testId="data-stats-stat-row"
          ariaLabel="Data and statistics overview"
          cells={[
            {
              value: formatTokenCount(totals.totalTokens),
              label: "Tokens",
              sub: `${formatCompactTokens(totals.inputTokens)} in · ${formatCompactTokens(totals.outputTokens)} out`,
              title: `Input + output tokens in the window — ${totals.inputTokens.toLocaleString()} in / ${totals.outputTokens.toLocaleString()} out`,
            },
            {
              value: formatCompactTokens(peak.tokens),
              label: peak.date ? `Peak day · ${utcDateLabel(peak.date)}` : "Peak day",
              sub: peak.date ? peak.date : "no traffic yet",
              title: peak.date
                ? `Highest input+output day (${peak.date}) — ${peak.tokens.toLocaleString()} tokens`
                : "No traffic in this window yet",
            },
            {
              value: formatCost(totals.costUsd),
              label: "Cost",
              sub: `${totals.requests.toLocaleString()} turns`,
              title: `Total recorded cost over the window · ${totals.requests.toLocaleString()} turns · ${totals.providerCalls.toLocaleString()} provider calls (the real SDK-call count)`,
            },
            {
              value: totals.requests.toLocaleString(),
              label: "Turns",
              sub: `${totals.providerCalls.toLocaleString()} provider calls`,
              title: `Turns recorded in the window (one usage row per turn since R24) · ${totals.providerCalls.toLocaleString()} provider calls`,
            },
          ] satisfies StatCell[]}
        />
      </QuickFade>

      {/* 3 — the token-activity heatmap (accent ladder; model colors live in
          the charts below). */}
      <QuickFade windowKey={months}>
        <UsageHeatmap days={data.series} styles={styles} />
      </QuickFade>

      {/* 4 — the model view: the daily stacked mix. NOT window-keyed — its
          7/30/90/365 range + hover state are the user's own; the tail slice
          is identical across window switches. */}
      <ModelStackChart days={data.series} models={data.models} styles={styles} />

      {/* 5 — the token-share donut. */}
      <QuickFade windowKey={months}>
        <ModelDonut models={data.models} styles={styles} />
      </QuickFade>

      {/* 6 — Agent health: ONE section, two QUIET sub-blocks side-by-side
          (1-col below md). Severity rides the icon + the number color ONLY —
          never a tinted card (the R99-E verdict); both sub-blocks ALWAYS
          render their honest empty one-liner so the layout is stable
          window-over-window (no content jumping). R127-W1: this is now the
          panel's LAST section — the danger zone that followed moved into the
          standalone ClearUsageDataCard (page-scope law). */}
      <section data-testid="agent-health-section" aria-label="Agent health">
        <div className="mb-2.5">
          <Kicker icon={ShieldCheck}>Agent health</Kicker>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
          <HealthBlock
            testId="stats-turn-errors"
            icon={<HeartPulse size={12} />}
            label="Turn errors"
            noun="turn errors"
            emptyLine="No turn errors in the window — clean run."
            issues={data.health.turnErrors}
            tone={styles.warningDeep}
            months={months}
            styles={styles}
          />
          <HealthBlock
            testId="stats-tool-failures"
            icon={<Wrench size={12} />}
            label="Tool failures"
            noun="tool failures"
            emptyLine="No tool failures in the window — clean run."
            issues={data.health.toolFailures}
            tone={styles.dangerDeep}
            months={months}
            styles={styles}
          />
        </div>
      </section>
    </div>
  );
}

/** One quiet agent-health sub-block — compact clay tile (rim + `.ac-clay-sm`,
 *  NO semantic tint, NO glow); the severity lives in the icon and the count
 * color alone. The empty state is the honest one-liner, never a fabricated
 * "healthy" row; the count line rides an aria-label that reads the window. */
function HealthBlock({
  testId,
  icon,
  label,
  noun,
  emptyLine,
  issues,
  tone,
  months,
  styles,
}: {
  testId: string;
  icon: React.ReactNode;
  label: string;
  /** The aria-label noun — "turn errors" / "tool failures". */
  noun: string;
  emptyLine: string;
  issues: UsageStatsHealthIssue[];
  tone: string;
  months: number;
  styles: ReturnType<typeof useThemeStyles>;
}) {
  const { text, textSecondary, textTertiary } = styles;
  const count = issues.reduce((sum, issue) => sum + issue.count, 0);
  return (
    /* R126-3b: the compact clay tile (CLAY_CARD_SM) — the testid +
       aria-label passthrough keeps the sub-block's accessible name; the
       QUIET card contract (no tint, no glow) is unchanged. */
    <section data-testid={testId} aria-label={label} className={cn(CLAY_CARD_SM, "min-h-[72px] p-3.5")}>
      <div className="flex items-center gap-2">
        <span className="shrink-0 leading-none" style={{ color: tone, opacity: 0.85 }} aria-hidden>
          {icon}
        </span>
        <span className="text-[12px] font-semibold leading-none" style={{ color: text }}>
          {label}
        </span>
        <span
          className="ml-auto font-mono text-[12px] font-semibold leading-none tabular-nums"
          style={{ color: count > 0 ? tone : textTertiary }}
          aria-label={`${count === 0 ? "No" : count.toLocaleString()} ${noun} in the last ${months} months`}
        >
          {count.toLocaleString()}
        </span>
      </div>
      {issues.length === 0 ? (
        <p className="mt-2 text-[11px]" style={{ color: textSecondary }}>
          {emptyLine}
        </p>
      ) : (
        <div className="mt-2 space-y-1">
          {issues.map((issue) => (
            <div key={issue.name} className="flex items-center justify-between gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]" style={{ color: text }}>
                {issue.name}
              </span>
              <span
                className="shrink-0 font-mono text-[11px] font-semibold tabular-nums"
                style={{ color: tone }}
              >
                {issue.count.toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
