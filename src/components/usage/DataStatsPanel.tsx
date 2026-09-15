import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Activity,
  CircleDollarSign,
  HeartPulse,
  ShieldCheck,
  TrendingUp,
  Wrench,
  Zap,
} from "lucide-react";
import { clearUsageData, type UsageStatsHealthIssue } from "../../lib/api";
import { useUsageStats } from "../../hooks/use-usage";
import { formatTokenCount } from "../../lib/format";
import { ease } from "../../lib/motion";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { StatCard } from "../dashboard/StatCard";
import { bdr, utcDateLabel, withAlpha } from "../dashboard/helpers";
import { SkeletonBlock } from "../shared/Skeletons";
import { ConfirmDialog } from "../settings/ConfirmDialog";
import { ModelDonut } from "./ModelDonut";
import { ModelStackChart } from "./ModelStackChart";
import { UsageHeatmap } from "./UsageHeatmap";
import { formatCompactTokens, formatCost } from "./usage-helpers";

/**
 * ROUND-98 (R98-I2, owner: "Data & statistics"): the ONE panel rendered in
 * BOTH the settings "Data & Statistics" tab AND the /usage screen — total
 * tokens, peak day, total cost and turns; the token-activity heatmap; the
 * per-day model-mix stacked chart + the model donut (color-coded BY MODEL
 * NAME — same name across providers is one model, same color everywhere);
 * agent health; and the clear-all-data danger zone.
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
 * the shared Skeleton primitives with ONE role="status" announcement;
 * error = role="alert" with the exact cause and ONE Retry that re-drives
 * the query.
 */

const MONTHS_OPTIONS = [6, 12, 24] as const;

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
  const queryClient = useQueryClient();
  const [months, setMonths] = useState<(typeof MONTHS_OPTIONS)[number]>(12);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearedCount, setClearedCount] = useState<number | null>(null);
  const stats = useUsageStats(months);

  const clear = useMutation({
    mutationFn: () => clearUsageData(),
    onSuccess: (result) => {
      setClearedCount(result.deleted);
      // Refetch EVERY usage surface that reads the now-empty ledger (the
      // stats panel itself + the usage screen's detailed rollups + the
      // dashboard summary) — the prefix matches all months/day windows.
      void queryClient.invalidateQueries({ queryKey: ["usage-stats"] });
      void queryClient.invalidateQueries({ queryKey: ["usage-detailed"] });
      void queryClient.invalidateQueries({ queryKey: ["usage-summary"] });
    },
  });

  const { card, border, text, textSecondary, accent, accentText, softShadow } = styles;

  /* R97-I gates — the error branch FIRST (a failed GET must never hang on
   * "loading…"), then the loading branch (demo mode leaves the query idle
   * at isPending — isFetching separates "loading" from "disabled"). */
  if (stats.isError && stats.data === undefined) {
    const cause = stats.error instanceof Error ? stats.error.message : String(stats.error);
    return (
      <div data-testid="data-stats-panel" className="flex w-full flex-col gap-4">
        <div
          role="alert"
          className="rounded-[16px] border-[1.5px] px-4 py-3.5"
          style={{
            borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.35),
            background: withAlpha(SEMANTIC_COLORS.danger, 0.08),
          }}
        >
          <div className="text-[12.5px] font-bold" style={{ color: SEMANTIC_COLORS.danger }}>
            Could not load data &amp; statistics
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: textSecondary }}>
            The agent sidecar may be down or the request was rejected — {cause}.
          </p>
          <button
            type="button"
            onClick={() => void stats.refetch()}
            aria-label="Retry loading data and statistics"
            className="mt-3 h-8 cursor-pointer rounded-lg border px-3.5 text-[12px] font-semibold transition-opacity hover:opacity-85"
            style={{
              borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.45),
              color: SEMANTIC_COLORS.danger,
            }}
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
            section-for-section (header → stat cards → heatmap → stack →
            donut → agent health → danger zone — same heights, same order)
            so the loading→ready swap never shifts the layout. */}
        <SkeletonBlock className="h-[56px] rounded-[14px]" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
          {[0, 1, 2, 3].map((i) => (
            <SkeletonBlock key={i} className="h-[92px] rounded-[20px]" style={{ border: bdr("1.5px", border) }} />
          ))}
        </div>
        <SkeletonBlock className="h-[184px] rounded-[24px] md:h-[192px]" style={{ border: bdr("1.5px", border) }} />
        <SkeletonBlock className="h-[264px] rounded-[24px] md:h-[272px]" style={{ border: bdr("1.5px", border) }} />
        <SkeletonBlock className="h-[184px] rounded-[24px] md:h-[192px]" style={{ border: bdr("1.5px", border) }} />
        <div>
          <SkeletonBlock className="mb-2.5 h-[13px] w-[120px] rounded-[5px]" />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
            {[0, 1].map((i) => (
              <SkeletonBlock key={i} className="h-[72px] rounded-[16px]" style={{ border: bdr("1.5px", border) }} />
            ))}
          </div>
        </div>
        <SkeletonBlock className="h-[96px] rounded-[16px]" style={{ border: bdr("1.5px", border) }} />
      </div>
    );
  }

  const data = stats.data;
  if (data === undefined) {
    // Demo mode (the query stays idle): the honest empty panel.
    return (
      <div data-testid="data-stats-panel" className="flex w-full flex-col gap-4">
        <div
          className="rounded-[24px] border-[1.5px] p-8 text-center"
          style={{ backgroundColor: card, borderColor: border, boxShadow: softShadow }}
        >
          <p className="text-[14px] font-bold" style={{ color: text }}>
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
      {/* 1 — the months window picker (drives the whole panel's query). */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
        <div>
          <h2 className="text-[16px] font-black" style={{ color: text }}>
            Data &amp; Statistics
          </h2>
          <p className="mt-1 text-[12px]" style={{ color: textSecondary }}>
            Tokens, cost, model mix and agent health over the selected window.
          </p>
        </div>
        <div
          role="group"
          aria-label="Statistics months window"
          className="flex shrink-0 items-center gap-1 rounded-[14px] border-[1.5px] p-1"
          style={{ backgroundColor: card, borderColor: border, boxShadow: softShadow }}
        >
          {MONTHS_OPTIONS.map((option) => {
            const active = option === months;
            return (
              <button
                key={option}
                type="button"
                onClick={() => {
                  setMonths(option);
                  setClearedCount(null);
                }}
                aria-pressed={active}
                aria-label={`Last ${option} months`}
                className="cursor-pointer rounded-[10px] px-2.5 py-1.5 text-[12px] font-bold tabular-nums transition-colors duration-200"
                style={{ backgroundColor: active ? accent : "transparent", color: active ? accentText : textSecondary }}
              >
                {option}mo
              </button>
            );
          })}
        </div>
      </div>

      {/* 2 — the headline stat cards (the dashboard StatCard primitive;
          h-[92px] + tabular-nums — the anti-jitter contract). */}
      <QuickFade windowKey={months} className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
        <StatCard
          value={formatTokenCount(totals.totalTokens)}
          label="Tokens"
          icon={Zap}
          title={`Input + output tokens in the window — ${totals.inputTokens.toLocaleString()} in / ${totals.outputTokens.toLocaleString()} out`}
          styles={styles}
          highlight
        />
        <StatCard
          value={formatCompactTokens(peak.tokens)}
          label={peak.date ? `Peak day · ${utcDateLabel(peak.date)}` : "Peak day"}
          icon={TrendingUp}
          title={
            peak.date
              ? `Highest input+output day (${peak.date}) — ${peak.tokens.toLocaleString()} tokens`
              : "No traffic in this window yet"
          }
          styles={styles}
        />
        <StatCard
          value={formatCost(totals.costUsd)}
          label="Cost"
          icon={CircleDollarSign}
          title={`Total recorded cost over the window · ${totals.requests.toLocaleString()} turns · ${totals.providerCalls.toLocaleString()} provider calls (the real SDK-call count)`}
          styles={styles}
        />
        <StatCard
          value={totals.requests.toLocaleString()}
          label="Turns"
          icon={Activity}
          title={`Turns recorded in the window (one usage row per turn since R24) · ${totals.providerCalls.toLocaleString()} provider calls`}
          styles={styles}
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
          window-over-window (no content jumping). */}
      <section data-testid="agent-health-section" aria-label="Agent health">
        <div className="mb-2.5 flex items-center gap-2">
          <ShieldCheck size={13} style={{ color: accent, opacity: 0.7 }} aria-hidden />
          <span
            className="text-[11px] font-bold uppercase leading-none tracking-widest"
            style={{ color: styles.textTertiary }}
          >
            Agent health
          </span>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
          <HealthBlock
            testId="stats-turn-errors"
            icon={<HeartPulse size={12} />}
            label="Turn errors"
            noun="turn errors"
            emptyLine="No turn errors in the window — clean run."
            issues={data.health.turnErrors}
            tone={SEMANTIC_COLORS.warning}
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
            tone={SEMANTIC_COLORS.danger}
            months={months}
            styles={styles}
          />
        </div>
      </section>

      {/* 7 — THE DANGER ZONE, always LAST (the GitHub settings pattern): a
          quiet red-OUTLINED box — no filled background, no shadow — with the
          description-left / red-action-button-right row. The exact
          enumeration of what stays untouched lives in the ConfirmDialog. */}
      <section
        data-testid="clear-usage-card"
        aria-label="Danger zone"
        className="min-h-[96px] rounded-[16px] border-[1.5px] p-4"
        style={{ borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.4) }}
      >
        <div className="mb-2.5 flex items-center gap-2">
          <span
            className="text-[11px] font-bold uppercase leading-none tracking-widest"
            style={{ color: SEMANTIC_COLORS.danger }}
          >
            Danger zone
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-[520px] text-[11.5px] leading-relaxed" style={{ color: textSecondary }}>
            Clear usage data — deletes every usage event in the ledger. Turns, sessions, and project
            data are untouched.
          </p>
          <button
            type="button"
            disabled={clear.isPending}
            data-testid="clear-usage-button"
            onClick={() => setConfirmOpen(true)}
            className="h-8 shrink-0 cursor-pointer rounded-lg border px-3.5 text-[12px] font-bold transition-opacity hover:opacity-85 disabled:cursor-wait disabled:opacity-60"
            style={{
              borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.45),
              color: SEMANTIC_COLORS.danger,
              background: withAlpha(SEMANTIC_COLORS.danger, 0.08),
            }}
          >
            {clear.isPending ? "Clearing…" : "Clear data…"}
          </button>
        </div>
        {clear.isError ? (
          <div className="mt-2 text-[11px]" style={{ color: SEMANTIC_COLORS.danger }} role="alert">
            Could not clear the usage ledger — {clear.error instanceof Error ? clear.error.message : String(clear.error)}.
            Nothing was deleted.
          </div>
        ) : null}
        {clearedCount !== null && !clear.isError ? (
          <div
            className="mt-2 text-[11px] font-semibold tabular-nums"
            style={{ color: SEMANTIC_COLORS.success }}
            role="status"
            data-testid="clear-usage-success"
          >
            Cleared {clearedCount.toLocaleString()} usage event{clearedCount === 1 ? "" : "s"}
          </div>
        ) : null}
      </section>

      {confirmOpen ? (
        <ConfirmDialog
          title="Clear all usage data?"
          message="This deletes every usage event — token counts, costs, and model history. Sessions, conversations, agents, providers, and settings are NOT touched."
          confirmLabel="Clear data"
          danger
          onConfirm={() => {
            setConfirmOpen(false);
            setClearedCount(null);
            clear.mutate();
          }}
          onClose={() => setConfirmOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** One quiet agent-health sub-block — card surface + hairline border (NO
 * semantic tint, NO shadow); the severity lives in the icon and the count
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
  const { text, textSecondary, textTertiary, border, card } = styles;
  const count = issues.reduce((sum, issue) => sum + issue.count, 0);
  return (
    <section
      data-testid={testId}
      aria-label={label}
      className="min-h-[72px] rounded-[16px] border-[1.5px] p-3.5"
      style={{ backgroundColor: card, borderColor: border }}
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 leading-none" style={{ color: tone, opacity: 0.85 }} aria-hidden>
          {icon}
        </span>
        <span className="text-[12px] font-semibold leading-none" style={{ color: text }}>
          {label}
        </span>
        <span
          className="ml-auto font-mono text-[12px] font-bold leading-none tabular-nums"
          style={{ color: count > 0 ? tone : textTertiary }}
          aria-label={`${count === 0 ? "No" : count.toLocaleString()} ${noun} in the last ${months} months`}
        >
          {count.toLocaleString()}
        </span>
      </div>
      {issues.length === 0 ? (
        <p className="mt-2 text-[11.5px]" style={{ color: textSecondary }}>
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
