/**
 * Dashboard v4 (R109-c; R113-e — the compact header; R114-c — the
 * color-coded, complete-info redesign + the header-free root; R115-N — the
 * donut + activity round) — the owner's "see the dashboard, the stats, the
 * usage" screen. Everything renders from the desktop's EXISTING /usage
 * routes (features/config.ts, typed 1:1):
 *
 *   window 14d/30d → fetchUsageSummary(14|30)  — the daily chart + totals,
 *                     PLUS fetchUsageStats(1) alongside (always) for the
 *                     model ring + the health block
 *   window 3mo     → fetchUsageStats(3)         — its series is daily, so it
 *                     carries the chart AND the ring AND the health
 *
 * Layout (top → bottom): the window chips, the totals hero (4 ClayCards in
 * a 2×2 grid, each with its TONED ICON CHIP — accent tokens, green
 * requests, amber cost, violet peak — color rides on the chip, never the
 * card), THE CHART — a hand-built react-native-svg STACKED bar chart (the
 * ONLY chart surface; no external chart libraries): input tokens in the
 * terracotta accent, output tokens stacked above in the sage second hue,
 * 3 quiet dashed gridlines + the max-value scale label, the peak day
 * highlighted, first/last date axis labels, tap a bar for that day's
 * inline detail — TOP MODELS as the DONUT + LEGEND (R115-N: the PC's
 * ModelDonut port, src/components/chart-donut.tsx — the ring carries every
 * model's token share, the leaderboard rows fold INTO the legend rows, the
 * center hole carries the top model + its share, tapping a legend row
 * spotlights its segment with the mutual 1-vs-0.55 highlight), the ACTIVITY
 * table (R115-N: requests, turn errors, tool failures, the peak day — one
 * compact row per metric with a proportional sparkbar in the metric's hue,
 * mono values right-aligned), and the health block (turn errors + tool
 * failures, each with the total-count chip). Pull-to-refresh + honest
 * loading skeletons/offline/error/empty states, gated on connected.
 *
 * MOTION (motion.md §4.6, R115-N): the bars GROW from the baseline on every
 * data load — each column withTiming 350ms, staggered 12ms, keyed on the
 * dataset's identity so window switches re-trigger it — and the donut SWEEPS
 * its arcs in (withTiming 500ms). Both run once per load and never loop.
 *
 * formatTokens + formatUsd are the pure number helpers, EXPORTED from this
 * file for tests later.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import Svg, { G, Line, Rect } from "react-native-svg";
import Animated, {
  Easing,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { Coins, DollarSign, TrendingUp, Zap } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import {
  DONUT_DIM_OPACITY,
  DonutChart,
  donutShares,
  shortModelName,
  type DonutSegment,
} from "@/components/chart-donut";
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
import { CHART_BAR_GROW_MS, CHART_BAR_STAGGER_MS } from "@/design/motion";
import { useTheme } from "@/design/theme";
import {
  CHART_HUES,
  chartHue,
  mixHex,
  modelHue,
  RADIUS_CARD,
  RADIUS_INPUT,
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
/**
 * motion.md §2's stagger cap, applied to the chart's own 12ms ladder: the
 * entry wave spans at most 30 column-beats (the 30-day window's full length
 * — a 360ms wave) so the ~90-column 3-month series rides the SAME wave
 * instead of a 1.1-second crawl.
 */
const CHART_STAGGER_CAP = 30;

const AnimatedRect = Animated.createAnimatedComponent(Rect);

/**
 * One column's §4.6 entry: 0 → 1 on its own beat (withTiming 350ms, 12ms
 * stagger), re-keyed on the dataset's identity so window switches and
 * reloads re-trigger it. Reduced motion snaps to full height.
 */
function useColumnEntry(dataKey: string, index: number) {
  const reduced = useReducedMotion();
  const progress = useSharedValue(0);
  // Layout effect: the reset-to-0 lands BEFORE the next paint, so a reloaded
  // dataset (pull-to-refresh with new numbers) can never flash its static
  // (full-height) hedge for a frame before the grow restarts.
  useLayoutEffect(() => {
    if (reduced) {
      progress.value = 1;
      return;
    }
    progress.value = 0;
    progress.value = withDelay(
      Math.min(index, CHART_STAGGER_CAP) * CHART_BAR_STAGGER_MS,
      withTiming(1, {
        duration: CHART_BAR_GROW_MS,
        easing: Easing.out(Easing.quad),
      }),
    );
  }, [dataKey, index, reduced, progress]);
  return progress;
}

/** An empty day — the faint ghost bar (never zero-height noise; nothing to grow). */
function GhostBar({
  x,
  barWidth,
  baselineY,
  hue,
  tapTarget,
}: {
  x: number;
  barWidth: number;
  baselineY: number;
  hue: string;
  tapTarget: ReactElement;
}) {
  return (
    <G>
      <Rect x={x} y={baselineY - 1.5} width={barWidth} height={1.5} fill={hue} fillOpacity={0.16} />
      {tapTarget}
    </G>
  );
}

/**
 * A totals-only (the 3-month series) or one-sided day: one bar in the blend
 * (totals) or the side that exists — never a fake split. Grows from the
 * baseline on entry; the static props are the FAIL-STATIC hedge (the resting
 * bar) — reanimated's animatedProps override them while the entry runs, and
 * if they ever fail to apply on a device the chart renders complete anyway.
 */
function SingleBar({
  x,
  barWidth,
  baselineY,
  totalHeight,
  fill,
  capFill,
  emphasis,
  isSelected,
  tapTarget,
  dataKey,
  index,
}: {
  x: number;
  barWidth: number;
  baselineY: number;
  totalHeight: number;
  fill: string;
  capFill: string;
  emphasis: number;
  isSelected: boolean;
  tapTarget: ReactElement;
  dataKey: string;
  index: number;
}) {
  const progress = useColumnEntry(dataKey, index);
  const barProps = useAnimatedProps(() => ({
    y: baselineY - totalHeight * progress.value,
    height: totalHeight * progress.value,
  }));
  const capProps = useAnimatedProps(() => ({
    y: baselineY - totalHeight * progress.value - CHART_CAP,
  }));
  return (
    <G>
      <AnimatedRect
        x={x}
        y={baselineY - totalHeight}
        width={barWidth}
        height={totalHeight}
        rx={Math.min(2.5, barWidth / 2)}
        fill={fill}
        fillOpacity={emphasis}
        animatedProps={barProps}
      />
      {totalHeight > 5 ? (
        <AnimatedRect
          x={x}
          y={baselineY - totalHeight - CHART_CAP}
          width={barWidth}
          height={CHART_CAP}
          rx={1}
          fill={capFill}
          animatedProps={capProps}
        />
      ) : null}
      {isSelected ? (
        <Rect x={x} y={baselineY} width={barWidth} height={CHART_HEIGHT - baselineY} fill={fill} />
      ) : null}
      {tapTarget}
    </G>
  );
}

/**
 * The stacked day — input below (terracotta), output above (sage), both
 * scaled by the SAME peak denominator so the stack is the day; the whole
 * stack grows out of the baseline on entry (the cap rides the rising top).
 */
function SplitBar({
  x,
  barWidth,
  baselineY,
  inputHeight,
  outputHeight,
  totalHeight,
  inHue,
  outHue,
  capFillOut,
  emphasis,
  isSelected,
  tapTarget,
  dataKey,
  index,
}: {
  x: number;
  barWidth: number;
  baselineY: number;
  inputHeight: number;
  outputHeight: number;
  totalHeight: number;
  inHue: string;
  outHue: string;
  capFillOut: string;
  emphasis: number;
  isSelected: boolean;
  tapTarget: ReactElement;
  dataKey: string;
  index: number;
}) {
  const progress = useColumnEntry(dataKey, index);
  const inputProps = useAnimatedProps(() => ({
    y: baselineY - inputHeight * progress.value,
    height: inputHeight * progress.value,
  }));
  const outputProps = useAnimatedProps(() => ({
    y: baselineY - (inputHeight + outputHeight) * progress.value,
    height: outputHeight * progress.value,
  }));
  const capProps = useAnimatedProps(() => ({
    y: baselineY - totalHeight * progress.value - CHART_CAP,
  }));
  return (
    <G>
      <AnimatedRect
        x={x}
        y={baselineY - inputHeight}
        width={barWidth}
        height={inputHeight}
        rx={Math.min(2.5, barWidth / 2)}
        fill={inHue}
        fillOpacity={emphasis}
        animatedProps={inputProps}
      />
      {outputHeight > 0 ? (
        <AnimatedRect
          x={x}
          y={baselineY - totalHeight}
          width={barWidth}
          height={outputHeight}
          rx={Math.min(2.5, barWidth / 2)}
          fill={outHue}
          fillOpacity={emphasis}
          animatedProps={outputProps}
        />
      ) : null}
      {totalHeight > 5 ? (
        <AnimatedRect
          x={x}
          y={baselineY - totalHeight - CHART_CAP}
          width={barWidth}
          height={CHART_CAP}
          rx={1}
          fill={capFillOut}
          animatedProps={capProps}
        />
      ) : null}
      {isSelected ? (
        <Rect x={x} y={baselineY} width={barWidth} height={CHART_HEIGHT - baselineY} fill={inHue} />
      ) : null}
      {tapTarget}
    </G>
  );
}

function UsageChart({
  days,
  width,
  selected,
  onSelect,
  dataKey,
}: {
  days: DayBucket[];
  width: number;
  selected: number | null;
  onSelect: (index: number | null) => void;
  /** The dataset's identity — the bars' grow re-triggers whenever it changes. */
  dataKey: string;
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
            return (
              <GhostBar
                key={`${day.date}-${index}`}
                x={x}
                barWidth={barWidth}
                baselineY={baselineY}
                hue={inHue}
                tapTarget={tapTarget}
              />
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
            // Totals-only (the 3-month series) or a one-sided day.
            const fill =
              day.inputTokens !== null && inputTokens > 0
                ? inHue
                : day.outputTokens !== null && outputTokens > 0
                  ? outHue
                  : blendHue;
            const capFill = mixHex(fill, tokens.card, 0.45);
            return (
              <SingleBar
                key={`${day.date}-${index}`}
                x={x}
                barWidth={barWidth}
                baselineY={baselineY}
                totalHeight={totalHeight}
                fill={fill}
                capFill={capFill}
                emphasis={emphasis}
                isSelected={isSelected}
                tapTarget={tapTarget}
                dataKey={dataKey}
                index={index}
              />
            );
          }
          const inputHeight = Math.max(
            1,
            (inputTokens / Math.max(peakTokens, 1)) * plotHeight,
          );
          const outputHeight = Math.max(totalHeight - inputHeight, 0);
          return (
            <SplitBar
              key={`${day.date}-${index}`}
              x={x}
              barWidth={barWidth}
              baselineY={baselineY}
              inputHeight={inputHeight}
              outputHeight={outputHeight}
              totalHeight={totalHeight}
              inHue={inHue}
              outHue={outHue}
              capFillOut={capFillOut}
              emphasis={emphasis}
              isSelected={isSelected}
              tapTarget={tapTarget}
              dataKey={dataKey}
              index={index}
            />
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

// ── the model legend (the leaderboard folded into the donut card) ───────────

/**
 * One legend row — the R115-N fold of the old ModelRow: the RANK hue carries
 * the row (dot + the donut's own segment), the head line reads model · share
 * · tokens (mono, right-aligned tabular columns), and the cost·calls caption
 * keeps the leaderboard's truth. Tapping spotlights that model's segment on
 * the ring (the PC's MUTUAL highlight: this row + its arc at 1, everything
 * else dimmed to DONUT_DIM_OPACITY); tapping it again clears.
 */
function ModelLegendRow({
  model,
  share,
  rank,
  highlighted,
  dimmed,
  onToggle,
}: {
  model: UsageStatsModel;
  share: number;
  rank: number;
  highlighted: boolean;
  dimmed: boolean;
  onToggle: () => void;
}) {
  const { tokens } = useTheme();
  const hue = modelHue(rank, tokens.isDark);
  const pct = Math.round(share * 100);
  return (
    <Pressable
      testID={`dashboard-legend-${rank}`}
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ selected: highlighted }}
      accessibilityLabel={`${model.model}: ${pct}% of tokens, ${formatTokens(model.tokens)} tokens, ${formatUsd(model.costUsd)}, ${formatCount(model.calls)} calls`}
      style={({ pressed }) => [
        styles.modelLegendRow,
        {
          backgroundColor: pressed ? tokens.subtleHover : "transparent",
          opacity: dimmed ? DONUT_DIM_OPACITY : 1,
        },
      ]}
    >
      <View style={styles.modelHead}>
        <View style={[styles.modelDot, { backgroundColor: hue }]} />
        <TypeMono numberOfLines={1} style={styles.modelName}>
          {model.model}
        </TypeMono>
        <TypeMono numberOfLines={1} style={styles.legendPct}>{`${pct}%`}</TypeMono>
        <TypeMono numberOfLines={1} style={styles.legendTokens}>
          {formatTokens(model.tokens)}
        </TypeMono>
      </View>
      <TypeMicro numberOfLines={1} style={[styles.legendCaption, { color: tokens.textTertiary }]}>
        {`${formatUsd(model.costUsd)} · ${formatCount(model.calls)} calls`}
      </TypeMicro>
    </Pressable>
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
  /** The donut/legend's spotlight — a legend row's rank, or null for none. */
  const [highlightedModel, setHighlightedModel] = useState<number | null>(null);
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
      setHighlightedModel(null);
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

  // The FULL model ranking — the donut's honest denominator is every model
  // the stats carry (the PC passes them all too), so a share is of the
  // window's tokens; the legend below folds the old top-6 leaderboard.
  const models = useMemo(() => {
    if (stats === null) return [];
    return [...stats.models].sort((a, b) => b.tokens - a.tokens);
  }, [stats]);
  const topModels = useMemo(() => models.slice(0, 6), [models]);
  const modelShares = useMemo(() => donutShares(models.map((m) => m.tokens)), [models]);
  const totalModelTokens = models.reduce((sum, model) => sum + model.tokens, 0);
  const donutSegmentsInput = useMemo<DonutSegment[]>(
    () =>
      models.map((model, index) => ({
        label: model.model,
        value: model.tokens,
        hue: modelHue(index, tokens.isDark),
      })),
    [models, tokens.isDark],
  );
  // The two §4.6 entry identities — the data's own fingerprint, so the bars'
  // grow and the donut's sweep re-trigger exactly once per data load (a
  // window switch always changes it; an identical refresh doesn't).
  const chartKey = useMemo(() => {
    if (days.length === 0) return "none";
    const generated =
      windowKey === "3mo" ? stats?.generatedAt : (summary?.generatedAt ?? "");
    return `${windowKey}:${generated ?? ""}:${days.length}:${days[0].date}:${days[days.length - 1].date}:${totals.totalTokens}`;
  }, [windowKey, days, summary, stats, totals]);
  const donutKey = useMemo(() => {
    if (stats === null) return "none";
    return `${windowKey}:${stats.generatedAt}:${models.map((m) => `${m.model}=${m.tokens}`).join("|")}`;
  }, [windowKey, stats, models]);
  // A fresh dataset clears the spotlight — a stale rank would light the
  // wrong model on the new ring.
  useEffect(() => {
    setHighlightedModel(null);
  }, [donutKey]);
  const toggleHighlight = useCallback((index: number) => {
    void selectionHaptic();
    setHighlightedModel((current) => (current === index ? null : index));
  }, []);

  // The Activity table — one row per metric the loaded data honestly
  // carries (nothing fabricated): requests + the peak day ride the SELECTED
  // window's totals (summary for 14d/30d, stats for 3mo); turn errors + tool
  // failures ride the stats response's health block (stats(1)'s month for
  // the 14d/30d windows — the same R109-c contract the ring + Health use —
  // and stats(3) for 3mo), so those two rows simply don't render when the
  // stats fetch degraded (the Health section below says why).
  const activityRows = useMemo(() => {
    const rows: { label: string; display: string; value: number; hue: string }[] = [
      { label: "Requests", display: formatCount(totals.requests), value: totals.requests, hue: tokens.success },
    ];
    if (stats !== null) {
      const turnErrors = stats.health.turnErrors.reduce((sum, item) => sum + item.count, 0);
      const toolFailures = stats.health.toolFailures.reduce((sum, item) => sum + item.count, 0);
      rows.push(
        { label: "Turn errors", display: formatCount(turnErrors), value: turnErrors, hue: tokens.danger },
        { label: "Tool failures", display: formatCount(toolFailures), value: toolFailures, hue: tokens.warning },
      );
    }
    if (totals.peak.date !== null) {
      rows.push({
        label: `Peak day ${shortDate(totals.peak.date)}`,
        display: formatTokens(totals.peak.tokens),
        value: totals.peak.tokens,
        hue: chartHue(CHART_HUES.peak, tokens.isDark),
      });
    }
    // The sparkbars scale to the table's own max — a proportional read of
    // the metrics against each other (the ring's track discipline).
    const max = rows.reduce((m, row) => Math.max(m, row.value), 0);
    return rows.map((row) => ({
      ...row,
      fraction: max > 0 ? Math.min(100, Math.round((row.value / max) * 100)) : 0,
    }));
  }, [totals, stats, tokens]);

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
                    <UsageChart
                      days={days}
                      width={chartWidth}
                      selected={selectedDay}
                      onSelect={setSelectedDay}
                      dataKey={chartKey}
                    />
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

              {/* ── top models — the DONUT + LEGEND (R115-N: the leaderboard
                  rows fold into the legend; the ring carries the shares, so
                  the old 3px per-row track is gone — it would duplicate the
                  ring) ── */}
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
              ) : totalModelTokens === 0 ? (
                <ClayCard>
                  <View style={styles.quietPad}>
                    <TypeCaption style={{ color: tokens.textTertiary }}>no model usage in this window yet</TypeCaption>
                  </View>
                </ClayCard>
              ) : (
                <ClayCard>
                  <View style={styles.donutPad}>
                    <View style={styles.donutRow}>
                      <DonutChart
                        testID="dashboard-donut"
                        segments={donutSegmentsInput}
                        dataKey={donutKey}
                        highlighted={highlightedModel}
                        trackColor={tokens.borderSubtle}
                        accessibilityLabel={`model usage donut — top model ${shortModelName(models[0].model)} at ${Math.round((modelShares[0] ?? 0) * 100)}% of tokens`}
                        center={
                          <View style={styles.donutCenterWrap}>
                            <TypeMono numberOfLines={1} style={styles.donutCenterName}>
                              {shortModelName(models[0].model)}
                            </TypeMono>
                            <TypeTitle numberOfLines={1} style={styles.donutCenterPct}>
                              {`${Math.round((modelShares[0] ?? 0) * 100)}%`}
                            </TypeTitle>
                          </View>
                        }
                      />
                    </View>
                    <View style={styles.legendList}>
                      {topModels.map((model, index) => (
                        <ModelLegendRow
                          key={model.model}
                          model={model}
                          share={modelShares[index] ?? 0}
                          rank={index}
                          highlighted={highlightedModel === index}
                          dimmed={highlightedModel !== null && highlightedModel !== index}
                          onToggle={() => toggleHighlight(index)}
                        />
                      ))}
                    </View>
                  </View>
                </ClayCard>
              )}

              {/* ── activity — the window's counts at a glance (R115-N) ── */}
              <SectionHeader>Activity</SectionHeader>
              {activityRows.length === 0 ? (
                <ClayCard>
                  <View style={styles.quietPad}>
                    <TypeCaption style={{ color: tokens.textTertiary }}>no usage in this window yet</TypeCaption>
                  </View>
                </ClayCard>
              ) : (
                <ClayCard testID="dashboard-activity">
                  <View style={styles.activityPad}>
                    {activityRows.map((row) => (
                      <View key={row.label} style={styles.activityRow}>
                        <TypeCaption numberOfLines={1} style={styles.activityLabel}>
                          {row.label}
                        </TypeCaption>
                        {/* The sparkbar is decorative — the row's label + mono
                            value already carry the reading. */}
                        <View
                          style={[styles.activityTrack, { backgroundColor: tokens.borderSubtle }]}
                          accessibilityElementsHidden
                        >
                          <View
                            style={[styles.activityFill, { width: `${row.fraction}%`, backgroundColor: row.hue }]}
                          />
                        </View>
                        <TypeMono numberOfLines={1} style={styles.activityValue}>
                          {row.display}
                        </TypeMono>
                      </View>
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
  // The donut + legend card (R115-N — the leaderboard folded in).
  modelHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  modelDot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
  modelName: { flex: 1 },
  donutPad: { padding: spacing.md, gap: spacing.md },
  donutRow: { alignItems: "center" },
  donutCenterWrap: { alignItems: "center", maxWidth: 84 },
  donutCenterName: { textAlign: "center" },
  donutCenterPct: { textAlign: "center" },
  legendList: { gap: spacing.xs },
  modelLegendRow: {
    minHeight: 44,
    borderRadius: RADIUS_INPUT,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    gap: 2,
    justifyContent: "center",
  },
  legendPct: { flexShrink: 0, minWidth: 44, textAlign: "right" },
  legendTokens: { flexShrink: 0, minWidth: 56, textAlign: "right" },
  // The caption aligns under the model NAME: dot width (10) + head gap (sm).
  legendCaption: { paddingLeft: 10 + spacing.sm },
  // The activity table (R115-N — metric + sparkbar + mono value).
  activityPad: { padding: spacing.md, gap: spacing.sm },
  activityRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 32 },
  activityLabel: { width: 116, flexShrink: 0 },
  activityTrack: { flex: 1, height: 4, borderRadius: 2, overflow: "hidden" },
  activityFill: { height: 4, borderRadius: 2 },
  activityValue: { flexShrink: 0, minWidth: 56, textAlign: "right" },
  healthPad: { padding: spacing.md, gap: spacing.sm },
  healthHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  healthRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 28 },
  healthName: { flex: 1 },
  footer: { textAlign: "center" },
  skeletonWrap: { gap: spacing.lg },
  statSkeleton: { flex: 1, height: 104, borderRadius: RADIUS_CARD },
  chartSkeleton: { height: CHART_HEIGHT + 96, borderRadius: RADIUS_CARD },
});
