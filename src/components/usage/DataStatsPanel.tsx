import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  CircleDollarSign,
  HeartPulse,
  Trash2,
  TrendingUp,
  Wrench,
  Zap,
} from "lucide-react";
import { clearUsageData, type UsageStatsHealthIssue } from "../../lib/api";
import { useUsageStats } from "../../hooks/use-usage";
import { formatTokenCount } from "../../lib/format";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { StatCard } from "../dashboard/StatCard";
import { bdr, utcDateLabel, withAlpha } from "../dashboard/helpers";
import { SkeletonBlock, SkeletonRows } from "../shared/Skeletons";
import { ConfirmDialog } from "../settings/ConfirmDialog";
import { ModelDonut } from "./ModelDonut";
import { ModelStackChart } from "./ModelStackChart";
import { UsageHeatmap } from "./UsageHeatmap";
import { formatCompactTokens, formatCost } from "./usage-helpers";

/**
 * ROUND-98 (R98-I2, owner: "Data & statistics"): the ONE panel rendered in
 * BOTH the settings "Data & Statistics" tab AND the /usage screen — total
 * tokens, peak day, total cost and turns; the 12-month token-activity
 * heatmap; the per-day model-mix stacked chart + the model donut (color-
 * coded BY MODEL NAME — same name across providers is one model, same
 * color everywhere); agent health; and the clear-all-data danger card.
 *
 * The panel OWNS its query (useUsageStats) + the months picker (6/12/24)
 * so both mount sites stay one-liners. State gates per R97-I: loading =
 * the shared Skeleton primitives with ONE role="status" announcement;
 * error = role="alert" with the exact cause and ONE Retry that re-drives
 * the query.
 */

const MONTHS_OPTIONS = [6, 12, 24] as const;

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
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
          {[0, 1, 2, 3].map((i) => (
            <SkeletonBlock key={i} className="h-[92px] rounded-[20px]" style={{ border: bdr("1.5px", border) }} />
          ))}
        </div>
        <SkeletonBlock className="h-[150px] rounded-[24px]" style={{ border: bdr("1.5px", border) }} />
        <SkeletonBlock className="h-[230px] rounded-[24px]" style={{ border: bdr("1.5px", border) }} />
        <SkeletonRows rows={2} rowClassName="h-[64px] rounded-[16px]" />
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
      {/* The months window picker — drives the whole panel's query. */}
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
                className="cursor-pointer rounded-[10px] px-2.5 py-1.5 text-[12px] font-bold transition-colors duration-200"
                style={{ backgroundColor: active ? accent : "transparent", color: active ? accentText : textSecondary }}
              >
                {option}mo
              </button>
            );
          })}
        </div>
      </div>

      {/* The headline stat cards (the dashboard StatCard primitive). */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
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
      </div>

      {/* The 12-month-style heatmap (accent ladder; model colors live in
          the charts below). */}
      <UsageHeatmap days={data.series} styles={styles} />

      {/* The model view: daily stacked mix + the share donut. */}
      <ModelStackChart days={data.series} models={data.models} styles={styles} />
      <ModelDonut models={data.models} styles={styles} />

      {/* Agent health — amber turn errors, danger tool failures; both are
          honest one-liners when the window is clean (never fabricated). */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
        <HealthCard
          testId="stats-turn-errors"
          icon={<HeartPulse size={13} />}
          title="Turn errors"
          emptyLine="No turn errors in this window."
          issues={data.health.turnErrors}
          tone={SEMANTIC_COLORS.warning}
          styles={styles}
        />
        <HealthCard
          testId="stats-tool-failures"
          icon={<Wrench size={13} />}
          title="Tool failures"
          emptyLine="No failed tool calls in this window."
          issues={data.health.toolFailures}
          tone={SEMANTIC_COLORS.danger}
          styles={styles}
        />
      </div>

      {/* Clear all data — the danger card + the exact-enumeration confirm. */}
      <section
        data-testid="clear-usage-card"
        className="rounded-[24px] border-[1.5px] p-4 md:p-5"
        style={{
          backgroundColor: card,
          borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.35),
          boxShadow: softShadow,
        }}
        aria-label="Clear usage data"
      >
        <div className="mb-3 flex items-center gap-2">
          <Trash2 size={13} style={{ color: SEMANTIC_COLORS.danger, opacity: 0.8 }} />
          <span className="text-[12px] font-semibold" style={{ color: text }}>
            Clear usage data
          </span>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-[520px] text-[11.5px] leading-relaxed" style={{ color: textSecondary }}>
            Wipes the usage ledger — every token count, cost, and model-history row. The
            conversations themselves, your agents, providers, and settings are not touched.
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
            className="mt-2 text-[11px] font-semibold"
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

/** One agent-health card — semantic-tinted rows (amber turn errors, danger
 * tool failures); the empty state is the honest one-liner, never a
 * fabricated "healthy" row. */
function HealthCard({
  testId,
  icon,
  title,
  emptyLine,
  issues,
  tone,
  styles,
}: {
  testId: string;
  icon: React.ReactNode;
  title: string;
  emptyLine: string;
  issues: UsageStatsHealthIssue[];
  tone: string;
  styles: ReturnType<typeof useThemeStyles>;
}) {
  const { text, textSecondary, border, card, softShadow } = styles;
  return (
    <section
      data-testid={testId}
      className="rounded-[24px] border-[1.5px] p-4"
      style={{ backgroundColor: card, borderColor: border, boxShadow: softShadow }}
      aria-label={title}
    >
      <div className="mb-3 flex items-center gap-2">
        <span style={{ color: tone, opacity: 0.8 }}>{icon}</span>
        <span className="text-[12px] font-semibold" style={{ color: text }}>
          {title}
        </span>
        <span
          className="ml-auto rounded-full px-2 py-0.5 font-mono text-[10px] font-bold"
          style={{ background: withAlpha(tone, 0.1), color: tone }}
        >
          {issues.reduce((sum, issue) => sum + issue.count, 0).toLocaleString()}
        </span>
      </div>
      {issues.length === 0 ? (
        <p className="text-[11.5px]" style={{ color: textSecondary }}>
          {emptyLine}
        </p>
      ) : (
        <div className="space-y-1">
          {issues.map((issue) => (
            <div key={issue.name} className="flex items-center justify-between gap-2 rounded-md px-1">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]" style={{ color: text }}>
                {issue.name}
              </span>
              <span
                className="shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-bold"
                style={{ background: withAlpha(tone, 0.1), color: tone }}
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
