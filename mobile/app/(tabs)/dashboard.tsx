/**
 * Dashboard v3 (R109-c; R113-e — the compact header; R114-c — the
 * color-coded, complete-info redesign + the header-free root) — the
 * owner's "see the dashboard, the stats, the usage" screen. Everything
 * renders from the desktop's EXISTING /usage routes (features/config.ts,
 * typed 1:1):
 *
 *   window 14d/30d → fetchUsageSummary(14|30)  — the daily chart + totals,
 *                     PLUS fetchUsageStats(1) alongside (always) for the
 *                     model leaderboard + the health block
 *   window 3mo     → fetchUsageStats(3)         — its series is daily, so it
 *                     carries the chart AND the leaderboard AND the health
 *
 * Layout (top → bottom): the window chips, the totals hero (4 ClayCards in
 * a 2×2 grid, each with its TONED ICON CHIP — accent tokens, green
 * requests, amber cost, violet peak — color rides on the chip, never the
 * card), THE CHART — a hand-built react-native-svg STACKED bar chart (the
 * ONLY chart surface; no external chart libraries): input tokens in the
 * terracotta accent, output tokens stacked above in the sage second hue,
 * 3 quiet dashed gridlines + the max-value scale label, the peak day
 * highlighted, first/last date axis labels, tap a bar for that day's
 * inline detail — the model leaderboard (top 6, each model in its OWN
 * rank hue: dot + name + mono count + share track + cost·calls caption,
 * with a tiny legend when two+ render), and the health block (turn errors
 * + tool failures, each with the total-count chip). Pull-to-refresh +
 * honest loading skeletons/offline/error/empty states, gated on connected.
 *
 * formatTokens + formatUsd are the pure number helpers, EXPORTED from this
 * file for tests later.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshControl, StyleSheet, View, useWindowDimensions } from "react-native";
import Svg, { G, Line, Rect } from "react-native-svg";
import { Coins, DollarSign, TrendingUp, Zap } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import { ErrorState, LoadingState, SkeletonList } from "@/components/list-state";
import {
  Badge,
  Chip,
  ClayCard,
  SectionHeader,
  Skeleton,
  TypeCaption,
  TypeMicro,
  TypeMono,
  TypeTitle,
} from "@/design/primitives";
import { selectionHaptic } from "@/design/haptics";
import { useTheme } from "@/design/theme";
import {
  CHART_HUES,
  chartHue,
  mixHex,
  modelHue,
  RADIUS_CARD,
  spacing,
} from "@/design/tokens";
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

const CHART_HEIGHT = 168;
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
  // R114-c — the two token hues: input = the terracotta accent (the dominant
  // mass), output = the cool sage second hue (tokens.ts's chart palette,
  // dark-mode variants included). The totals-only 3-month series blends the
  // two (an honest "combined" read, never a wrong single-side claim).
  const inHue = chartHue(CHART_HUES.input, tokens.isDark);
  const outHue = chartHue(CHART_HUES.output, tokens.isDark);
  const blendHue = mixHex(inHue, outHue, 0.5);
  // The molded clay cap — the TOP segment's hue lightened toward the card.
  const capFillOut = mixHex(outHue, tokens.card, 0.45);
  const columnWidth = n > 0 ? width / n : width;
  const gap = columnWidth > 12 ? 3 : columnWidth > 6 ? 2 : columnWidth > 3.5 ? 1 : 0;
  const hasSplit = days.some((day) => day.inputTokens !== null && day.outputTokens !== null);
  // 3 quiet dashed gridlines (quarter marks) — the y-axis's honest scale.
  const gridFractions = [0.25, 0.5, 0.75];

  return (
    <View accessibilityLabel="daily token totals stacked bar chart" accessibilityRole="image">
      {/* The scale row — the max-value label + the in/out legend (the
          split windows only; the totals-only 3-month series claims no side). */}
      <View style={styles.scaleRow}>
        <TypeMicro style={[styles.scaleLabel, { color: tokens.textTertiary }]}>
          {peakTokens > 0 ? `peak ${formatTokens(peakTokens)}` : ""}
        </TypeMicro>
        {hasSplit ? (
          <View style={styles.legendRow}>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: inHue }]} />
              <TypeMicro style={{ color: tokens.textTertiary }}>in</TypeMicro>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: outHue }]} />
              <TypeMicro style={{ color: tokens.textTertiary }}>out</TypeMicro>
            </View>
          </View>
        ) : null}
      </View>
      <Svg width={width} height={CHART_HEIGHT}>
        {/* The quiet dashed gridlines (DESIGN.md's calm — borderSubtle). */}
        {gridFractions.map((fraction) => {
          const y = baselineY - fraction * plotHeight;
          return (
            <Line
              key={`grid-${fraction}`}
              x1={0}
              y1={y}
              x2={width}
              y2={y}
              stroke={tokens.borderSubtle}
              strokeWidth={1}
              strokeDasharray="4 4"
            />
          );
        })}
        {days.map((day, index) => {
          const barWidth = Math.max(columnWidth - gap, 0.5);
          const x = index * columnWidth + gap / 2;
          const isPeak = day.tokens === peakTokens && day.tokens > 0;
          const isSelected = selected === index;
          const emphasis = isPeak || isSelected ? 1 : 0.72;
          // The tap target — the full column, so thin bars stay tappable.
          const tapTarget = (
            <Rect
              x={index * columnWidth}
              y={0}
              width={columnWidth}
              height={CHART_HEIGHT}
              fill="transparent"
              onPress={() => onSelect(isSelected ? null : index)}
            />
          );
          if (day.tokens === 0) {
            // An empty day — the faint ghost bar (never zero-height noise).
            return (
              <G key={`${day.date}-${index}`}>
                <Rect
                  x={x}
                  y={baselineY - 1.5}
                  width={barWidth}
                  height={1.5}
                  fill={inHue}
                  fillOpacity={0.16}
                />
                {tapTarget}
              </G>
            );
          }
          const totalHeight = Math.max(
            2,
            (day.tokens / Math.max(peakTokens, 1)) * plotHeight,
          );
          const inputTokens = day.inputTokens ?? day.tokens;
          const outputTokens = day.outputTokens ?? 0;
          const split =
            day.inputTokens !== null &&
            day.outputTokens !== null &&
            inputTokens > 0 &&
            outputTokens > 0;
          if (!split) {
            // Totals-only (the 3-month series) or a one-sided day: one bar in
            // the blend (totals) or the side that exists — never a fake split.
            const fill =
              day.inputTokens !== null && inputTokens > 0
                ? inHue
                : day.outputTokens !== null && outputTokens > 0
                  ? outHue
                  : blendHue;
            const capFill = mixHex(fill, tokens.card, 0.45);
            const y = baselineY - totalHeight;
            return (
              <G key={`${day.date}-${index}`}>
                <Rect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={totalHeight}
                  rx={Math.min(2.5, barWidth / 2)}
                  fill={fill}
                  fillOpacity={emphasis}
                />
                {totalHeight > 5 ? (
                  <Rect x={x} y={y - CHART_CAP} width={barWidth} height={CHART_CAP} rx={1} fill={capFill} />
                ) : null}
                {isSelected ? (
                  <Rect x={x} y={baselineY} width={barWidth} height={CHART_HEIGHT - baselineY} fill={fill} />
                ) : null}
                {tapTarget}
              </G>
            );
          }
          // The stacked day — input below (terracotta), output above (sage),
          // both scaled by the SAME peak denominator so the stack is the day.
          const inputHeight = Math.max(
            1,
            (inputTokens / Math.max(peakTokens, 1)) * plotHeight,
          );
          const outputHeight = Math.max(totalHeight - inputHeight, 0);
          const yOut = baselineY - totalHeight;
          const yIn = baselineY - inputHeight;
          return (
            <G key={`${day.date}-${index}`}>
              <Rect
                x={x}
                y={yIn}
                width={barWidth}
                height={inputHeight}
                rx={Math.min(2.5, barWidth / 2)}
                fill={inHue}
                fillOpacity={emphasis}
              />
              {outputHeight > 0 ? (
                <Rect
                  x={x}
                  y={yOut}
                  width={barWidth}
                  height={outputHeight}
                  rx={Math.min(2.5, barWidth / 2)}
                  fill={outHue}
                  fillOpacity={emphasis}
                />
              ) : null}
              {totalHeight > 5 ? (
                <Rect
                  x={x}
                  y={yOut - CHART_CAP}
                  width={barWidth}
                  height={CHART_CAP}
                  rx={1}
                  fill={capFillOut}
                />
              ) : null}
              {isSelected ? (
                <Rect x={x} y={baselineY} width={barWidth} height={CHART_HEIGHT - baselineY} fill={inHue} />
              ) : null}
              {tapTarget}
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

/** The tile's colored icon chip — DESIGN.md's law: color rides on the
 * ICON (and its quiet tinted chip), NEVER on the resting card itself. */
function StatTile({
  label,
  value,
  caption,
  icon: Icon,
  hue,
}: {
  label: string;
  value: string;
  caption?: string;
  icon: typeof Coins;
  hue: string;
}) {
  const { tokens } = useTheme();
  return (
    <ClayCard style={styles.statTile}>
      <View style={styles.statPad}>
        <View style={styles.statHead}>
          <View
            style={[styles.statChip, { backgroundColor: mixHex(tokens.card, hue, 0.14) }]}
            accessibilityLabel={`${label} indicator`}
          >
            <Icon size={15} color={hue} strokeWidth={2.2} />
          </View>
          <TypeMicro style={[styles.statLabel, { color: tokens.textTertiary }]}>{label}</TypeMicro>
        </View>
        <TypeTitle numberOfLines={1}>{value}</TypeTitle>
        {caption !== undefined ? <TypeMicro style={{ color: tokens.textTertiary }}>{caption}</TypeMicro> : null}
      </View>
    </ClayCard>
  );
}

// ── the model leaderboard ───────────────────────────────────────────────────

/** One model row — the RANK hue carries the whole row (dot, count, track);
 * the caption keeps the cost·calls truth. */
function ModelRow({
  model,
  share,
  rank,
}: {
  model: UsageStatsModel;
  share: number;
  rank: number;
}) {
  const { tokens } = useTheme();
  const hue = modelHue(rank, tokens.isDark);
  return (
    <View style={styles.modelRow}>
      <View style={styles.modelHead}>
        <View style={[styles.modelDot, { backgroundColor: hue }]} />
        <TypeMono numberOfLines={1} style={styles.modelName}>
          {model.model}
        </TypeMono>
        <TypeMono numberOfLines={1} style={styles.modelCount}>
          {formatTokens(model.tokens)}
        </TypeMono>
      </View>
      <View style={[styles.modelTrack, { backgroundColor: tokens.borderSubtle }]}>
        <View
          style={[
            styles.modelTrackFill,
            { width: `${Math.round(Math.max(share, 0.05) * 100)}%`, backgroundColor: hue },
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
  // R114-c — the total-count mini stat chip: the block's headline number
  // (trivially the sum of the per-name counts), next to the title.
  const total = items.reduce((sum, item) => sum + item.count, 0);
  return (
    <ClayCard>
      <View style={styles.healthPad}>
        <View style={styles.healthHead}>
          <TypeMicro style={[styles.statLabel, { color: tokens.textTertiary, flex: 1 }]}>{title}</TypeMicro>
          {total > 0 ? <Badge tone={tone}>{formatCount(total)}</Badge> : null}
        </View>
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
    <ScreenScaffold title="Dashboard" refreshControl={refreshControl} chrome={false}>
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

              {/* ── the totals hero — toned icon chips: accent tokens, green
                  requests, amber cost, violet peak (color on the chip only) ── */}
              <View style={styles.gridRow}>
                <StatTile
                  label="Total tokens"
                  value={formatTokens(totals.totalTokens)}
                  icon={Coins}
                  hue={chartHue(CHART_HUES.input, tokens.isDark)}
                />
                <StatTile
                  label="Requests"
                  value={formatCount(totals.requests)}
                  icon={Zap}
                  hue={tokens.success}
                />
              </View>
              <View style={styles.gridRow}>
                <StatTile
                  label="Cost"
                  value={formatUsd(totals.costUsd)}
                  icon={DollarSign}
                  hue={tokens.warning}
                />
                <StatTile
                  label="Peak day"
                  value={totals.peak.date !== null ? shortDate(totals.peak.date) : "—"}
                  caption={totals.peak.tokens > 0 ? `${formatTokens(totals.peak.tokens)} tokens` : "no usage yet"}
                  icon={TrendingUp}
                  hue={chartHue(CHART_HUES.peak, tokens.isDark)}
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

              {/* ── the model leaderboard — per-model rank hues ── */}
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
                    {models.map((model, index) => (
                      <ModelRow
                        key={model.model}
                        model={model}
                        rank={index}
                        share={model.tokens / Math.max(models[0].tokens, 1)}
                      />
                    ))}
                    {models.length >= 2 ? (
                      // The tiny legend — what the hues and the track mean.
                      <TypeMicro style={[styles.modelLegend, { color: tokens.textTertiary }]}>
                        each model keeps its hue · the track scales to the top model
                      </TypeMicro>
                    ) : null}
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
  statTile: { flex: 1, minHeight: 104 },
  statPad: { padding: spacing.md, gap: spacing.xs },
  statHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  statChip: {
    width: 26,
    height: 26,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  statLabel: { textTransform: "uppercase", letterSpacing: 0.8 },
  scaleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.xs,
  },
  scaleLabel: { letterSpacing: 0.3 },
  legendRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  chartPad: { padding: spacing.md, gap: spacing.sm },
  axisRow: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: spacing.xs },
  dayDetailWrap: { paddingHorizontal: spacing.xs },
  quietPad: { padding: spacing.lg },
  modelsPad: { padding: spacing.md, gap: spacing.lg },
  modelRow: { gap: spacing.xs },
  modelHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  modelDot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
  modelName: { flex: 1 },
  modelCount: { flexShrink: 0 },
  modelLegend: { textAlign: "center", paddingTop: spacing.xs },
  modelTrack: { height: 3, borderRadius: 2, overflow: "hidden" },
  modelTrackFill: { height: 3, borderRadius: 2 },
  healthPad: { padding: spacing.md, gap: spacing.sm },
  healthHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  healthRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 28 },
  healthName: { flex: 1 },
  footer: { textAlign: "center" },
  skeletonWrap: { gap: spacing.lg },
  statSkeleton: { flex: 1, height: 104, borderRadius: RADIUS_CARD },
  chartSkeleton: { height: CHART_HEIGHT + 96, borderRadius: RADIUS_CARD },
});
