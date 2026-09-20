/**
 * Dashboard v2 (R109-c; R113-e — the compact header) — the owner's "see
 * the dashboard, the stats, the usage" screen. Everything renders from the desktop's EXISTING /usage
 * routes (features/config.ts, typed 1:1):
 *
 *   window 14d/30d → fetchUsageSummary(14|30)  — the daily chart + totals,
 *                     PLUS fetchUsageStats(1) alongside (always) for the
 *                     model leaderboard + the health block
 *   window 3mo     → fetchUsageStats(3)         — its series is daily, so it
 *                     carries the chart AND the leaderboard AND the health
 *
 * Layout (top → bottom): the window chips, the totals hero (4 ClayCards in
 * a 2×2 grid), THE CHART — a hand-built react-native-svg bar chart (the
 * ONLY chart surface; no external chart libraries): clay bars in the accent
 * color with the molded 2px lighter top-edge cap, the tallest bar
 * highlighted, first/last date axis labels, tap a bar for that day's inline
 * detail — the model leaderboard (top 6), and the health block (turn
 * errors + tool failures). Pull-to-refresh + honest loading/offline/error
 * states, gated on connected (the pill carries the link truth).
 *
 * formatTokens + formatUsd are the pure number helpers, EXPORTED from this
 * file for tests later.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshControl, StyleSheet, View, useWindowDimensions } from "react-native";
import Svg, { G, Line, Rect } from "react-native-svg";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { ErrorState, LoadingState, SkeletonList } from "@/components/list-state";
import {
  Badge,
  Chip,
  ClayCard,
  SectionHeader,
  Skeleton,
  TypeBodyStrong,
  TypeCaption,
  TypeMicro,
  TypeMono,
  TypeTitle,
} from "@/design/primitives";
import { selectionHaptic } from "@/design/haptics";
import { useTheme } from "@/design/theme";
import { mixHex, RADIUS_CARD, spacing } from "@/design/tokens";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";
import {
  fetchUsageStats,
  fetchUsageSummary,
  type UsageStats,
  type UsageStatsModel,
  type UsageSummary,
} from "@/features/config";
import { mobLog, mobWarn } from "@/lib/log";

// ── the pure number helpers (exported for tests later) ──────────────────────

/** 999 → "999" · 1234 → "1.2k" · 3_400_000 → "3.4M" · 2_100_000_000 → "2.1B". */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  const units: ReadonlyArray<readonly [number, string]> = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "k"],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const scaled = value / size;
      const text =
        Math.abs(scaled) >= 100 ? String(Math.round(scaled)) : String(Math.round(scaled * 10) / 10);
      return `${text}${suffix}`;
    }
  }
  return String(value);
}

/** "$0.0000" for dust → "$0.500" → "$1.23" — 2 decimals once it matters, 4 when it doesn't. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs === 0) return "$0.00";
  if (abs >= 1) return `$${value.toFixed(2)}`;
  if (abs >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

/** 1234 → "1,234" (deterministic en-US grouping). */
function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("en-US");
}

/** "2026-09-01" → "Sep 1" — parsed calendar-LOCAL, never timezone-shifted. */
function shortDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (m !== null) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  }
  const t = new Date(date).getTime();
  return Number.isNaN(t) ? date : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** ISO → "3:42 PM" (the generated-at footer's clock). */
function formatClock(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

// ── the window selector ─────────────────────────────────────────────────────

type WindowKey = "14d" | "30d" | "3mo";

const WINDOWS: ReadonlyArray<{ key: WindowKey; label: string }> = [
  { key: "14d", label: "14 days" },
  { key: "30d", label: "30 days" },
  { key: "3mo", label: "3 months" },
];

// ── the day bucket (the chart's unified row) ────────────────────────────────

/**
 * One chart bar. Summary windows fill every field; the 3-month stats series
 * carries totals only — the nulls keep the tap-through detail honest.
 */
interface DayBucket {
  date: string;
  tokens: number;
  inputTokens: number | null;
  outputTokens: number | null;
  requests: number | null;
  costUsd: number | null;
}

// ── the chart (react-native-svg, the only chart surface) ────────────────────

const CHART_HEIGHT = 160;
const CHART_CAP = 2;

function UsageChart({
  days,
  width,
  selected,
  onSelect,
}: {
  days: DayBucket[];
  width: number;
  selected: number | null;
  onSelect: (index: number | null) => void;
}) {
  const { tokens } = useTheme();
  const n = days.length;
  const peakTokens = days.reduce((max, day) => Math.max(max, day.tokens), 0);
  const baselineY = CHART_HEIGHT - 1;
  const plotHeight = baselineY - CHART_CAP - 3;
  // The molded clay cap — the accent lightened toward the card surface.
  const capFill = mixHex(tokens.accent, tokens.card, 0.45);
  const columnWidth = n > 0 ? width / n : width;
  const gap = columnWidth > 12 ? 3 : columnWidth > 6 ? 2 : columnWidth > 3.5 ? 1 : 0;

  return (
    <View accessibilityLabel="daily token totals bar chart" accessibilityRole="image">
      <Svg width={width} height={CHART_HEIGHT}>
        {days.map((day, index) => {
          const barWidth = Math.max(columnWidth - gap, 0.5);
          const x = index * columnWidth + gap / 2;
          const barHeight = Math.max(
            day.tokens > 0 ? 2 : 1.5,
            (day.tokens / Math.max(peakTokens, 1)) * plotHeight,
          );
          const y = baselineY - barHeight;
          const isPeak = day.tokens === peakTokens && day.tokens > 0;
          const isSelected = selected === index;
          return (
            <G key={`${day.date}-${index}`}>
              <Rect
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
                rx={Math.min(2.5, barWidth / 2)}
                fill={tokens.accent}
                fillOpacity={day.tokens === 0 ? 0.18 : isPeak || isSelected ? 1 : 0.5}
              />
              {barHeight > 5 ? (
                <Rect x={x} y={y - CHART_CAP} width={barWidth} height={CHART_CAP} rx={1} fill={capFill} />
              ) : null}
              {isSelected ? (
                <Rect x={x} y={baselineY} width={barWidth} height={CHART_HEIGHT - baselineY} fill={tokens.accent} />
              ) : null}
              {/* The tap target — the full column, so thin bars stay tappable. */}
              <Rect
                x={index * columnWidth}
                y={0}
                width={columnWidth}
                height={CHART_HEIGHT}
                fill="transparent"
                onPress={() => onSelect(isSelected ? null : index)}
              />
            </G>
          );
        })}
        <Line x1={0} y1={baselineY} x2={width} y2={baselineY} stroke={tokens.borderSubtle} strokeWidth={1} />
      </Svg>
      <View style={styles.axisRow}>
        <TypeMicro style={{ color: tokens.textTertiary }}>{n > 0 ? shortDate(days[0].date) : ""}</TypeMicro>
        <TypeMicro style={{ color: tokens.textTertiary }}>{n > 1 ? shortDate(days[n - 1].date) : ""}</TypeMicro>
      </View>
    </View>
  );
}

/** The tapped day's inline detail — "Sep 12 · 1.2M in / 340k out · 18 requests · $0.42". */
function DayDetailLine({ day }: { day: DayBucket }) {
  const datePart = shortDate(day.date);
  if (day.inputTokens !== null && day.outputTokens !== null) {
    const parts = [`${formatTokens(day.inputTokens)} in / ${formatTokens(day.outputTokens)} out`];
    if (day.requests !== null) parts.push(`${formatCount(day.requests)} requests`);
    if (day.costUsd !== null) parts.push(formatUsd(day.costUsd));
    return <TypeCaption>{`${datePart} · ${parts.join(" · ")}`}</TypeCaption>;
  }
  // The 3-month series is totals-only — the caption says exactly that much.
  return <TypeCaption>{`${datePart} · ${formatTokens(day.tokens)} tokens`}</TypeCaption>;
}

// ── the totals hero tiles ───────────────────────────────────────────────────

function StatTile({ label, value, caption }: { label: string; value: string; caption?: string }) {
  const { tokens } = useTheme();
  return (
    <ClayCard style={styles.statTile}>
      <View style={styles.statPad}>
        <TypeMicro style={[styles.statLabel, { color: tokens.textTertiary }]}>{label}</TypeMicro>
        <TypeTitle numberOfLines={1}>{value}</TypeTitle>
        {caption !== undefined ? <TypeMicro style={{ color: tokens.textTertiary }}>{caption}</TypeMicro> : null}
      </View>
    </ClayCard>
  );
}

// ── the model leaderboard ───────────────────────────────────────────────────

function ModelRow({ model, share }: { model: UsageStatsModel; share: number }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.modelRow}>
      <View style={styles.modelHead}>
        <TypeMono numberOfLines={1} style={styles.modelName}>
          {model.model}
        </TypeMono>
        <TypeBodyStrong numberOfLines={1}>{formatTokens(model.tokens)}</TypeBodyStrong>
      </View>
      <View style={[styles.modelTrack, { backgroundColor: tokens.borderSubtle }]}>
        <View
          style={[
            styles.modelTrackFill,
            { width: `${Math.round(Math.max(share, 0.05) * 100)}%`, backgroundColor: tokens.accent, opacity: 0.55 },
          ]}
        />
      </View>
      <TypeMicro style={{ color: tokens.textTertiary }}>
        {`${formatUsd(model.costUsd)} · ${formatCount(model.calls)} calls`}
      </TypeMicro>
    </View>
  );
}

// ── the health block ────────────────────────────────────────────────────────

function HealthCard({
  title,
  tone,
  items,
}: {
  title: string;
  tone: "danger" | "warning";
  items: { name: string; count: number }[];
}) {
  const { tokens } = useTheme();
  const top = items.slice(0, 5);
  return (
    <ClayCard>
      <View style={styles.healthPad}>
        <TypeMicro style={[styles.statLabel, { color: tokens.textTertiary }]}>{title}</TypeMicro>
        {top.length === 0 ? (
          <TypeCaption style={{ color: tokens.textTertiary }}>
            {`no ${title.toLowerCase()} in the window`}
          </TypeCaption>
        ) : (
          top.map((item) => (
            <View key={item.name} style={styles.healthRow}>
              <TypeMono numberOfLines={1} style={styles.healthName}>
                {item.name}
              </TypeMono>
              <Badge tone={tone}>{formatCount(item.count)}</Badge>
            </View>
          ))
        )}
      </View>
    </ClayCard>
  );
}

// ── the loading skeleton ────────────────────────────────────────────────────

function DashboardSkeleton() {
  return (
    <View style={styles.skeletonWrap}>
      <View style={styles.gridRow}>
        <Skeleton style={styles.statSkeleton} />
        <Skeleton style={styles.statSkeleton} />
      </View>
      <View style={styles.gridRow}>
        <Skeleton style={styles.statSkeleton} />
        <Skeleton style={styles.statSkeleton} />
      </View>
      <Skeleton style={styles.chartSkeleton} />
      <SkeletonList rows={3} rowHeight={64} />
    </View>
  );
}

// ── the screen ──────────────────────────────────────────────────────────────

export default function DashboardScreen() {
  const { tokens } = useTheme();
  const { status } = useLink();
  const { width: windowWidth } = useWindowDimensions();
  const connected = status === "connected";

  const [windowKey, setWindowKey] = useState<WindowKey>("14d");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [stats, setStats] = useState<UsageStats | null>(null);
  /** True when the auxiliary stats(1) fetch failed — the quiet degradation flag. */
  const [statsMissing, setStatsMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  /** Guards against a stale window's load landing after a newer one started. */
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const link = getLinkManager();
    try {
      if (windowKey === "3mo") {
        const outcome = await fetchUsageStats(link, 3);
        if (seq !== loadSeq.current) return;
        if (outcome.ok) {
          setStats(outcome.data);
          setSummary(null);
          setStatsMissing(false);
          setError(null);
          mobLog("dashboard", "stats loaded", {
            months: 3,
            days: outcome.data.series.length,
            models: outcome.data.models.length,
          });
        } else {
          setError(outcome.error.message);
          mobWarn("dashboard", "stats failed", { status: outcome.error.status, code: outcome.error.code });
        }
      } else {
        const dayCount = windowKey === "14d" ? 14 : 30;
        // Summary carries the window; stats(1) ALWAYS rides alongside for the
        // model leaderboard + health (the R109-c contract).
        const [summaryOut, statsOut] = await Promise.all([
          fetchUsageSummary(link, dayCount),
          fetchUsageStats(link, 1),
        ]);
        if (seq !== loadSeq.current) return;
        if (summaryOut.ok) {
          setSummary(summaryOut.data);
          setError(null);
          mobLog("dashboard", "summary loaded", { days: dayCount, rows: summaryOut.data.days.length });
        } else {
          setError(summaryOut.error.message);
          mobWarn("dashboard", "summary failed", { status: summaryOut.error.status, code: summaryOut.error.code });
        }
        if (statsOut.ok) {
          setStats(statsOut.data);
          setStatsMissing(false);
          mobLog("dashboard", "model stats loaded", { models: statsOut.data.models.length });
        } else {
          // The window itself is fine — leaderboard + health degrade quietly.
          setStats(null);
          setStatsMissing(true);
          mobWarn("dashboard", "model stats unavailable", { status: statsOut.error.status, code: statsOut.error.code });
        }
      }
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setError("the host is offline — the numbers will load when it returns");
      mobWarn("dashboard", "load threw", err instanceof Error ? err.message : err);
    } finally {
      if (seq === loadSeq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [windowKey]);

  // Load on mount, on link (re)connect, and on every window switch.
  useEffect(() => {
    if (status === "connected") {
      void load();
    } else if (status === "unpaired") {
      setLoading(false);
    }
  }, [status, load]);

  const selectWindow = useCallback(
    (key: WindowKey) => {
      if (key === windowKey) return;
      void selectionHaptic();
      setWindowKey(key);
      setSummary(null);
      setStats(null);
      setStatsMissing(false);
      setError(null);
      setSelectedDay(null);
      setLoading(true);
    },
    [windowKey],
  );

  // ── derived ──

  const days = useMemo<DayBucket[]>(() => {
    if (windowKey === "3mo") {
      if (stats === null) return [];
      return stats.series.map((point) => ({
        date: point.date,
        tokens: Object.values(point.byModel).reduce((sum, value) => sum + value, 0),
        inputTokens: null,
        outputTokens: null,
        requests: null,
        costUsd: null,
      }));
    }
    if (summary === null) return [];
    return summary.days.map((day) => ({
      date: day.date,
      tokens: day.inputTokens + day.outputTokens,
      inputTokens: day.inputTokens,
      outputTokens: day.outputTokens,
      requests: day.requests,
      costUsd: day.costUsd,
    }));
  }, [windowKey, summary, stats]);

  const totals = useMemo(() => {
    const empty = { totalTokens: 0, requests: 0, costUsd: 0, peak: { date: null as string | null, tokens: 0 } };
    if (windowKey === "3mo") {
      if (stats === null) return empty;
      return {
        totalTokens: stats.totals.totalTokens,
        requests: stats.totals.requests,
        costUsd: stats.totals.costUsd,
        peak: stats.peak,
      };
    }
    if (summary === null) return empty;
    let peakDate: string | null = null;
    let peakTokens = 0;
    for (const day of summary.days) {
      const dayTokens = day.inputTokens + day.outputTokens;
      if (dayTokens > peakTokens) {
        peakTokens = dayTokens;
        peakDate = day.date;
      }
    }
    return {
      totalTokens: summary.totals.inputTokens + summary.totals.outputTokens,
      requests: summary.totals.requests,
      costUsd: summary.totals.costUsd,
      peak: { date: peakDate, tokens: peakTokens },
    };
  }, [windowKey, summary, stats]);

  const models = useMemo(() => {
    if (stats === null) return [];
    return [...stats.models].sort((a, b) => b.tokens - a.tokens).slice(0, 6);
  }, [stats]);

  const health = stats?.health ?? { turnErrors: [], toolFailures: [] };
  const primaryLoaded = windowKey === "3mo" ? stats !== null : summary !== null;
  const generatedAt =
    windowKey === "3mo" ? stats?.generatedAt : (summary?.generatedAt ?? stats?.generatedAt);

  // Default the inline detail to the peak day (the tallest bar) — the caption
  // lands with content instead of a hint.
  useEffect(() => {
    if (days.length === 0) {
      setSelectedDay(null);
      return;
    }
    let peakIndex = 0;
    days.forEach((day, index) => {
      if (day.tokens > days[peakIndex].tokens) peakIndex = index;
    });
    setSelectedDay(peakIndex);
  }, [days]);

  // The chart's responsive width: the window minus the screen gutters (the
  // scaffold's own body padding) minus the chart card's own padding.
  const gutter = spacing.lg;
  const chartWidth = Math.max(120, Math.floor(windowWidth - gutter * 2 - spacing.md * 2));

  const refreshControl = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true);
        void load();
      }}
      tintColor={tokens.accent}
      colors={[tokens.accent]}
      progressBackgroundColor={tokens.card}
    />
  );

  return (
    <ScreenScaffold title="Dashboard" refreshControl={refreshControl}>
      {status === "unpaired" ? (
        <ErrorState title="No host linked" caption="Pair this phone to see usage, tokens, costs, and health." />
      ) : !connected && !primaryLoaded ? (
        status === "probing" ? (
          <LoadingState caption="connecting to the host…" />
        ) : (
          <ErrorState
            title="host offline"
            caption="the dashboard loads the moment the link returns."
            retryLabel="retry now"
            onRetry={() => getLinkManager().retryNow()}
          />
        )
      ) : (
        <>
          {/* ── the window selector ── */}
          <View style={styles.windowRow}>
            {WINDOWS.map((w) => (
              <Chip
                key={w.key}
                testID={`dashboard-window-${w.key}`}
                selected={windowKey === w.key}
                onPress={() => selectWindow(w.key)}
              >
                {w.label}
              </Chip>
            ))}
          </View>

          {loading && !primaryLoaded ? (
            <DashboardSkeleton />
          ) : !primaryLoaded && error !== null ? (
            <ErrorState
              title="Couldn't load usage"
              caption={error}
              retryLabel="try again"
              onRetry={() => void load()}
            />
          ) : (
            <>
              {!connected ? (
                <TypeCaption style={styles.softNotice}>
                  host offline — showing the last loaded numbers
                </TypeCaption>
              ) : error !== null ? (
                <TypeCaption style={[styles.softNotice, { color: tokens.danger }]}>
                  {`last refresh failed — ${error}`}
                </TypeCaption>
              ) : null}

              {/* ── the totals hero ── */}
              <View style={styles.gridRow}>
                <StatTile label="Total tokens" value={formatTokens(totals.totalTokens)} />
                <StatTile label="Requests" value={formatCount(totals.requests)} />
              </View>
              <View style={styles.gridRow}>
                <StatTile label="Cost" value={formatUsd(totals.costUsd)} />
                <StatTile
                  label="Peak day"
                  value={totals.peak.date !== null ? shortDate(totals.peak.date) : "—"}
                  caption={totals.peak.tokens > 0 ? `${formatTokens(totals.peak.tokens)} tokens` : "no usage yet"}
                />
              </View>

              {/* ── the chart ── */}
              <SectionHeader>Daily tokens</SectionHeader>
              {days.length === 0 ? (
                <ClayCard>
                  <View style={styles.quietPad}>
                    <TypeCaption style={{ color: tokens.textTertiary }}>
                      no usage recorded in this window yet
                    </TypeCaption>
                  </View>
                </ClayCard>
              ) : (
                <ClayCard>
                  <View style={styles.chartPad}>
                    <UsageChart days={days} width={chartWidth} selected={selectedDay} onSelect={setSelectedDay} />
                    <View style={styles.dayDetailWrap}>
                      {selectedDay !== null && selectedDay < days.length ? (
                        <DayDetailLine day={days[selectedDay]} />
                      ) : (
                        <TypeCaption style={{ color: tokens.textTertiary }}>tap a day for its detail</TypeCaption>
                      )}
                    </View>
                  </View>
                </ClayCard>
              )}

              {/* ── the model leaderboard ── */}
              <SectionHeader>Top models</SectionHeader>
              {stats === null ? (
                <ClayCard>
                  <View style={styles.quietPad}>
                    <TypeCaption style={{ color: tokens.textTertiary }}>
                      {statsMissing
                        ? "model stats are unavailable right now — pull to retry"
                        : "no model usage in this window yet"}
                    </TypeCaption>
                  </View>
                </ClayCard>
              ) : models.length === 0 ? (
                <ClayCard>
                  <View style={styles.quietPad}>
                    <TypeCaption style={{ color: tokens.textTertiary }}>no model usage in this window yet</TypeCaption>
                  </View>
                </ClayCard>
              ) : (
                <ClayCard>
                  <View style={styles.modelsPad}>
                    {models.map((model) => (
                      <ModelRow
                        key={model.model}
                        model={model}
                        share={model.tokens / Math.max(models[0].tokens, 1)}
                      />
                    ))}
                  </View>
                </ClayCard>
              )}

              {/* ── health ── */}
              <SectionHeader>Health</SectionHeader>
              {stats === null ? (
                <ClayCard>
                  <View style={styles.quietPad}>
                    <TypeCaption style={{ color: tokens.textTertiary }}>
                      {statsMissing
                        ? "health stats are unavailable right now — pull to retry"
                        : "no usage in this window yet"}
                    </TypeCaption>
                  </View>
                </ClayCard>
              ) : (
                <>
                  <HealthCard title="Turn errors" tone="danger" items={health.turnErrors} />
                  <HealthCard title="Tool failures" tone="warning" items={health.toolFailures} />
                </>
              )}

              {generatedAt !== undefined ? (
                <TypeMicro style={[styles.footer, { color: tokens.textTertiary }]}>
                  {`numbers generated ${formatClock(generatedAt)}`}
                </TypeMicro>
              ) : null}
            </>
          )}
        </>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  windowRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  softNotice: { paddingHorizontal: spacing.xs },
  gridRow: { flexDirection: "row", gap: spacing.md },
  statTile: { flex: 1, minHeight: 92 },
  statPad: { padding: spacing.md, gap: spacing.xs },
  statLabel: { textTransform: "uppercase", letterSpacing: 0.8 },
  chartPad: { padding: spacing.md, gap: spacing.sm },
  axisRow: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: spacing.xs },
  dayDetailWrap: { paddingHorizontal: spacing.xs },
  quietPad: { padding: spacing.lg },
  modelsPad: { padding: spacing.md, gap: spacing.lg },
  modelRow: { gap: spacing.xs },
  modelHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  modelName: { flex: 1 },
  modelTrack: { height: 3, borderRadius: 2, overflow: "hidden" },
  modelTrackFill: { height: 3, borderRadius: 2 },
  healthPad: { padding: spacing.md, gap: spacing.sm },
  healthRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 28 },
  healthName: { flex: 1 },
  footer: { textAlign: "center" },
  skeletonWrap: { gap: spacing.lg },
  statSkeleton: { flex: 1, height: 92, borderRadius: RADIUS_CARD },
  chartSkeleton: { height: CHART_HEIGHT + 72, borderRadius: RADIUS_CARD },
});
