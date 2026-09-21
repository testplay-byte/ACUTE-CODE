/**
 * Dashboard v5 (R109-c; R113-e; R114-c; R115-N the donut round; R116-g —
 * the DYNAMIC redo) — the owner's "see the dashboard, the stats, the usage"
 * screen. Round-116 verdicts #27-#34: everything the owner asked for was
 * already on the wire — /usage/detailed serves totals, a tool leaderboard
 * with per-tool failures, per-model stats, API-key rollups, and
 * project→session drill-downs; this screen now calls it and renders it.
 *
 * THE LOAD (features/config.ts, typed 1:1):
 *   window 14d/30d → fetchUsageSummary(14|30) + fetchUsageStats(1) alongside
 *                    (always — the models ring's own calendar window)
 *   window 3mo     → fetchUsageStats(3) — its series is daily, so it carries
 *                    the chart AND the ring
 *   every window   → fetchDetailedUsage(14|30|90) — the whole-history
 *                    drill-down (tools/keys/projects + the all-time counts);
 *                    its `days` param scopes ONLY its activity series, and
 *                    the screen reuses the PRIMARY window's day buckets for
 *                    the grid instead (one window, one truth)
 *
 * LAYOUT (top → bottom): the window chips, THE OVERVIEW CAROUSEL — a
 * horizontal snap FlatList of stat cards (Total/Input/Output tokens,
 * Requests, Tool calls, Cost, Projects, Sessions; big mono numbers, toned
 * icon chips; windowed cards carry the window label, whole-history cards
 * say "all time" — the honesty law), THE CHART — the hand-built
 * react-native-svg stacked bar chart (input terracotta / output sage, dashed
 * gridlines, the peak highlighted, tap a bar for its day), THE ACTIVITY GRID
 * — a GitHub-style 7-row × N-week intensity grid over the same day buckets
 * (the accent blended toward the card in four quartile steps; tap a cell
 * drives the SHARED day spotlight), MODELS — the donut + top-6 legend (the
 * PC's 12-hue NAME-HASH color contract, src/design/model-colors.ts) plus a
 * per-model carousel (in/out split, calls, cost, provider), TOOLS — the
 * whole-history leaderboard (rank + count + a failures chip only when a
 * tool actually failed + a proportional sparkbar; replaces the old Activity
 * table + Health blocks, round-116 #33), KEYS — the per-key rollups
 * (providerId mono, slot, requests/tokens/cost, last-used), PROJECTS — the
 * drill-down rows with the inline sessions accordion (the projects-screen
 * grammar), and the footer clock.
 *
 * MOTION (motion.md §4.6, kept from R115-N): the bars GROW from the baseline
 * on every data load — each column withTiming 350ms, staggered 12ms, keyed
 * on the dataset's identity — and the donut SWEEPS its arcs in (500ms). The
 * page's dynamism is INTERACTION (snap carousels, the tappable grid/chart,
 * the spring accordions), never looping decoration; reduced motion is
 * honored everywhere (snaps instead of springs).
 *
 * The pure number helpers (formatTokens/formatUsd/formatCount/shortDate/
 * formatClock) live in components/usage-cards.tsx now — one spelling shared
 * with the section components.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  FlatList,
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
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Coins,
  DollarSign,
  Folder,
  MessageSquare,
  Wrench,
  Zap,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { ScreenScaffold } from "@/components/screen-scaffold";
import {
  ActivityGrid,
  CAROUSEL_GUTTER,
  formatClock,
  formatCount,
  formatTokens,
  formatUsd,
  KeyStatRow,
  ModelCarouselCard,
  ProjectUsageRow,
  shortDate,
  StatCarouselCard,
  ToolLeaderboardRow,
  type UsageDayRow,
} from "@/components/usage-cards";
import {
  DONUT_DIM_OPACITY,
  DonutChart,
  donutShares,
  shortModelName,
  type DonutSegment,
} from "@/components/chart-donut";
import { ErrorState, LoadingState, SkeletonList } from "@/components/list-state";
import {
  Chip,
  ClayCard,
  SectionHeader,
  Skeleton,
  TypeCaption,
  TypeMicro,
  TypeMono,
  TypeTitle,
} from "@/design/primitives";
import { modelColor } from "@/design/model-colors";
import { selectionHaptic } from "@/design/haptics";
import { CHART_BAR_GROW_MS, CHART_BAR_STAGGER_MS } from "@/design/motion";
import { useTheme } from "@/design/theme";
import {
  CHART_HUES,
  chartHue,
  mixHex,
  RADIUS_CARD,
  RADIUS_INPUT,
  spacing,
} from "@/design/tokens";
import { getLinkManager } from "@/link/runtime";
import { useLink } from "@/link/use-link";
import type { ApiOutcome } from "@/features/api";
import {
  fetchDetailedUsage,
  fetchUsageStats,
  fetchUsageSummary,
  type DetailedUsage,
  type UsageStats,
  type UsageStatsModel,
  type UsageSummary,
} from "@/features/config";
import { mobLog, mobWarn } from "@/lib/log";

// ── the window selector ─────────────────────────────────────────────────────

type WindowKey = "14d" | "30d" | "3mo";

const WINDOWS: ReadonlyArray<{ key: WindowKey; label: string }> = [
  { key: "14d", label: "14 days" },
  { key: "30d", label: "30 days" },
  { key: "3mo", label: "3 months" },
];

/**
 * The detailed drill-down's `days` per window — the route validates 1–90, so
 * the 3-month window maps to 90 (the param scopes only that response's own
 * activity series; the whole-history sections are windowless by contract).
 */
const DETAILED_DAYS: Record<WindowKey, number> = { "14d": 14, "30d": 30, "3mo": 90 };

/** The carousel card's share of the content column (the next card's edge peeks). */
const CAROUSEL_CARD_FRACTION = 0.78;
/** The carousel card's width ceiling — tablet-class screens don't balloon the cards. */
const CAROUSEL_CARD_MAX = 312;
/** The tool leaderboard's visible rows before the honest "+N more" line. */
const TOOL_ROWS_CAP = 8;

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
  days: UsageDayRow[];
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
function DayDetailLine({ day }: { day: UsageDayRow }) {
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

/** The section's honest empty — one line, centered in the card. */
function QuietLine({ children }: { children: string }) {
  const { tokens } = useTheme();
  return (
    <ClayCard>
      <View style={styles.emptyPad}>
        <TypeCaption numberOfLines={1} style={{ color: tokens.textTertiary, textAlign: "center" }}>
          {children}
        </TypeCaption>
      </View>
    </ClayCard>
  );
}

// ── the model legend (the leaderboard folded into the donut card) ───────────

/**
 * One legend row — the R115-N fold of the old ModelRow: the NAME-HASH hue
 * carries the row (dot + the donut's own segment — the PC's color contract,
 * R116-g), the head line reads model · share · tokens (mono, right-aligned
 * tabular columns), and the cost·calls caption keeps the leaderboard's
 * truth. Tapping spotlights that model's segment on the ring (the PC's
 * MUTUAL highlight: this row + its arc at 1, everything else dimmed to
 * DONUT_DIM_OPACITY); tapping it again clears.
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
  const hue = modelColor(model.model, tokens.isDark);
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

// ── the loading skeleton ────────────────────────────────────────────────────

function DashboardSkeleton() {
  return (
    <View style={styles.skeletonWrap}>
      {/* Shaped like the content: the carousel's first card, the chart, rows. */}
      <Skeleton style={styles.carouselSkeleton} />
      <Skeleton style={styles.chartSkeleton} />
      <SkeletonList rows={3} rowHeight={64} />
    </View>
  );
}

// ── the screen ──────────────────────────────────────────────────────────────

/** One overview-carousel card spec (the statCards memo's row). */
interface StatCardSpec {
  key: string;
  label: string;
  value: string;
  caption: string;
  icon: LucideIcon;
  hue: string;
}

export default function DashboardScreen() {
  const { tokens } = useTheme();
  const { status } = useLink();
  const { width: windowWidth } = useWindowDimensions();
  const connected = status === "connected";

  const [windowKey, setWindowKey] = useState<WindowKey>("14d");
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [stats, setStats] = useState<UsageStats | null>(null);
  /** True if the auxiliary stats(1) fetch failed — the quiet degradation flag. */
  const [statsMissing, setStatsMissing] = useState(false);
  /** The whole-history drill-down (R116-g) — tools/keys/projects + all-time counts. */
  const [detailed, setDetailed] = useState<DetailedUsage | null>(null);
  /** True when the detailed fetch failed — its sections degrade honestly. */
  const [detailedMissing, setDetailedMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  /** The donut/legend's spotlight — a legend row's rank, or null for none. */
  const [highlightedModel, setHighlightedModel] = useState<number | null>(null);
  /** The projects drill-down's inline expansion (one row open at a time). */
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  /** Guards against a stale window's load landing after a newer one started. */
  const loadSeq = useRef(0);

  // The detailed fetch's landing — whole-history sections ride it; a failure
  // degrades THOSE sections quietly (the window's own data still renders).
  const takeDetailed = useCallback((outcome: ApiOutcome<DetailedUsage>) => {
    if (outcome.ok) {
      setDetailed(outcome.data);
      setDetailedMissing(false);
      mobLog("dashboard", "detailed usage loaded", {
        tools: outcome.data.tools.length,
        keys: outcome.data.keys.length,
        projects: outcome.data.projects.length,
      });
    } else {
      setDetailed(null);
      setDetailedMissing(true);
      mobWarn("dashboard", "detailed usage unavailable", {
        status: outcome.error.status,
        code: outcome.error.code,
      });
    }
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const link = getLinkManager();
    try {
      if (windowKey === "3mo") {
        const [statsOut, detailedOut] = await Promise.all([
          fetchUsageStats(link, 3),
          fetchDetailedUsage(link, DETAILED_DAYS[windowKey]),
        ]);
        if (seq !== loadSeq.current) return;
        if (statsOut.ok) {
          setStats(statsOut.data);
          setSummary(null);
          setStatsMissing(false);
          setError(null);
          mobLog("dashboard", "stats loaded", {
            months: 3,
            days: statsOut.data.series.length,
            models: statsOut.data.models.length,
          });
        } else {
          setError(statsOut.error.message);
          mobWarn("dashboard", "stats failed", { status: statsOut.error.status, code: statsOut.error.code });
        }
        takeDetailed(detailedOut);
      } else {
        const dayCount = windowKey === "14d" ? 14 : 30;
        // Summary carries the window; stats(1) ALWAYS rides alongside for the
        // model leaderboard (the R109-c contract); detailed(14|30) brings the
        // whole-history drill-down (R116-g).
        const [summaryOut, statsOut, detailedOut] = await Promise.all([
          fetchUsageSummary(link, dayCount),
          fetchUsageStats(link, 1),
          fetchDetailedUsage(link, DETAILED_DAYS[windowKey]),
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
          // The window itself is fine — leaderboard + carousel degrade quietly.
          setStats(null);
          setStatsMissing(true);
          mobWarn("dashboard", "model stats unavailable", { status: statsOut.error.status, code: statsOut.error.code });
        }
        takeDetailed(detailedOut);
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
  }, [windowKey, takeDetailed]);

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
      setDetailed(null);
      setDetailedMissing(false);
      setError(null);
      setSelectedDay(null);
      setHighlightedModel(null);
      setExpandedProject(null);
      setLoading(true);
    },
    [windowKey],
  );

  // ── derived ──

  const days = useMemo<UsageDayRow[]>(() => {
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
    const empty = {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      requests: 0,
      costUsd: 0,
      peak: { date: null as string | null, tokens: 0 },
    };
    if (windowKey === "3mo") {
      if (stats === null) return empty;
      return {
        totalTokens: stats.totals.totalTokens,
        inputTokens: stats.totals.inputTokens,
        outputTokens: stats.totals.outputTokens,
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
      inputTokens: summary.totals.inputTokens,
      outputTokens: summary.totals.outputTokens,
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
      models.map((model) => ({
        label: model.model,
        value: model.tokens,
        hue: modelColor(model.model, tokens.isDark),
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

  // The overview carousel's cards (verdict #27): windowed totals from
  // summary/stats as today; tool calls / projects / sessions are
  // WHOLE-HISTORY counts from the detailed rollup — captioned "all time".
  const windowLabel = `last ${WINDOWS.find((w) => w.key === windowKey)?.label ?? ""}`;
  // The models ride the stats response's own calendar window (stats(1) for
  // the 14d/30d chips — the R109-c contract), so the section says THAT.
  const modelsWindowLabel = windowKey === "3mo" ? "last 3 months" : "last month";

  const statCards = useMemo<StatCardSpec[]>(() => {
    const inHue = chartHue(CHART_HUES.input, tokens.isDark);
    const outHue = chartHue(CHART_HUES.output, tokens.isDark);
    const peakHue = chartHue(CHART_HUES.peak, tokens.isDark);
    const detailedCount = (value: number): string => (detailed !== null ? formatCount(value) : "—");
    return [
      {
        key: "tokens",
        label: "Total tokens",
        value: formatTokens(totals.totalTokens),
        caption: windowLabel,
        icon: Coins,
        hue: inHue,
      },
      {
        key: "input",
        label: "Input tokens",
        value: formatTokens(totals.inputTokens),
        caption: windowLabel,
        icon: ArrowDownToLine,
        hue: inHue,
      },
      {
        key: "output",
        label: "Output tokens",
        value: formatTokens(totals.outputTokens),
        caption: windowLabel,
        icon: ArrowUpFromLine,
        hue: outHue,
      },
      {
        key: "requests",
        label: "Requests",
        value: formatCount(totals.requests),
        caption: windowLabel,
        icon: Zap,
        hue: tokens.success,
      },
      {
        key: "toolcalls",
        label: "Tool calls",
        value: detailedCount(detailed?.totals.toolCalls ?? 0),
        caption: "all time",
        icon: Wrench,
        hue: tokens.warning,
      },
      {
        key: "cost",
        label: "Cost",
        value: formatUsd(totals.costUsd),
        caption: windowLabel,
        icon: DollarSign,
        hue: tokens.warning,
      },
      {
        key: "projects",
        label: "Projects",
        value: detailedCount(detailed?.totals.projects ?? 0),
        caption: "all time",
        icon: Folder,
        hue: peakHue,
      },
      {
        key: "sessions",
        label: "Sessions",
        value: detailedCount(detailed?.totals.sessions ?? 0),
        caption: "all time",
        icon: MessageSquare,
        hue: tokens.accent2,
      },
    ];
  }, [totals, detailed, windowLabel, tokens]);

  // The tool leaderboard (verdict #29) — detailed.tools is already count-desc
  // server-side; sorted defensively, capped, sparkbars scaled to its own max.
  const toolBoard = useMemo(() => {
    if (detailed === null) return null;
    const sorted = [...detailed.tools].sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
    const max = sorted.length > 0 ? sorted[0].count : 0;
    return {
      rows: sorted.slice(0, TOOL_ROWS_CAP).map((tool, index) => ({
        rank: index + 1,
        tool: tool.tool,
        count: tool.count,
        failures: tool.failures,
        fraction: max > 0 ? Math.min(100, Math.round((tool.count / max) * 100)) : 0,
      })),
      hidden: Math.max(0, sorted.length - TOOL_ROWS_CAP),
    };
  }, [detailed]);

  const toggleProject = useCallback((id: string) => {
    void selectionHaptic();
    setExpandedProject((current) => (current === id ? null : id));
  }, []);

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

  // The carousels' shared snap grammar: fixed card width + gutter, the next
  // card's edge peeking in the column, getItemLayout trivial (fixed width).
  const carouselCardWidth = Math.min(
    CAROUSEL_CARD_MAX,
    Math.round((windowWidth - gutter * 2) * CAROUSEL_CARD_FRACTION),
  );
  const carouselSnap = carouselCardWidth + CAROUSEL_GUTTER;
  const statItemLayout = useCallback(
    (_data: ArrayLike<StatCardSpec> | null | undefined, index: number) => ({
      length: carouselSnap,
      offset: carouselSnap * index,
      index,
    }),
    [carouselSnap],
  );
  const modelItemLayout = useCallback(
    (_data: ArrayLike<UsageStatsModel> | null | undefined, index: number) => ({
      length: carouselSnap,
      offset: carouselSnap * index,
      index,
    }),
    [carouselSnap],
  );

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

  const detailedUnavailableLine = "usage details unavailable — pull to retry";
  const primaryLoaded = windowKey === "3mo" ? stats !== null : summary !== null;
  const generatedAt =
    windowKey === "3mo" ? stats?.generatedAt : (summary?.generatedAt ?? stats?.generatedAt);

  return (
    <ScreenScaffold title="Dashboard" refreshControl={refreshControl} chrome={false}>
      {status === "unpaired" ? (
        <ErrorState title="No host linked" caption="Pair this phone to see usage, tokens, costs, and tools." />
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

              {/* ── the overview carousel (verdicts #27 + #34) — horizontal
                  snap cards; windowed cards carry the window label, the
                  whole-history counts say "all time" (the honesty law) ── */}
              <FlatList
                testID="dashboard-carousel"
                horizontal
                data={statCards}
                keyExtractor={(item) => item.key}
                renderItem={({ item }) => (
                  <View style={{ marginRight: CAROUSEL_GUTTER }}>
                    <StatCarouselCard
                      testID={`dashboard-stat-${item.key}`}
                      label={item.label}
                      value={item.value}
                      caption={item.caption}
                      icon={item.icon}
                      hue={item.hue}
                      width={carouselCardWidth}
                    />
                  </View>
                )}
                getItemLayout={statItemLayout}
                snapToInterval={carouselSnap}
                decelerationRate="fast"
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingRight: spacing.lg }}
              />

              {/* ── the daily tokens chart (verdict #28 — kept) ── */}
              <SectionHeader>Daily tokens</SectionHeader>
              {days.length === 0 ? (
                <QuietLine>no usage recorded in this window yet</QuietLine>
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

              {/* ── the GitHub-style activity grid (verdict #30) — the same
                  day buckets, intensity by quartile; a tap drives the SHARED
                  day spotlight (the chart's bar + both detail lines) ── */}
              <SectionHeader>Activity</SectionHeader>
              {days.length === 0 ? (
                <QuietLine>no usage recorded in this window yet</QuietLine>
              ) : (
                <ClayCard>
                  <View style={styles.chartPad}>
                    <ActivityGrid
                      days={days}
                      width={chartWidth}
                      selected={selectedDay}
                      onSelect={setSelectedDay}
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

              {/* ── models (verdict #31) — the donut + legend (top 6) with the
                  PC's name-hash colors, then the per-model carousel. The
                  stats response's own calendar window is the honest label ── */}
              <SectionHeader>{`Models · ${modelsWindowLabel}`}</SectionHeader>
              {stats === null ? (
                <QuietLine>
                  {statsMissing
                    ? "model stats unavailable — pull to retry"
                    : "no model usage in this window yet"}
                </QuietLine>
              ) : totalModelTokens === 0 ? (
                <QuietLine>no model usage in this window yet</QuietLine>
              ) : (
                <>
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
                  <FlatList
                    testID="dashboard-models-carousel"
                    horizontal
                    data={models}
                    keyExtractor={(item) => item.model}
                    renderItem={({ item }) => (
                      <View style={{ marginRight: CAROUSEL_GUTTER }}>
                        <ModelCarouselCard model={item} width={carouselCardWidth} />
                      </View>
                    )}
                    getItemLayout={modelItemLayout}
                    snapToInterval={carouselSnap}
                    decelerationRate="fast"
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ paddingRight: spacing.lg }}
                  />
                </>
              )}

              {/* ── the tool leaderboard (verdict #29) — count + failures
                  COMBINED per tool; replaces the old Activity table + Health
                  (round-116 #33). Whole-history, labeled ── */}
              <SectionHeader>Tools · all time</SectionHeader>
              {toolBoard === null ? (
                <QuietLine>
                  {detailedMissing ? detailedUnavailableLine : "no tool calls recorded yet"}
                </QuietLine>
              ) : toolBoard.rows.length === 0 ? (
                <QuietLine>no tool calls recorded yet</QuietLine>
              ) : (
                <ClayCard testID="dashboard-tools">
                  <View style={styles.rowsPad}>
                    {toolBoard.rows.map((row) => (
                      <ToolLeaderboardRow key={row.tool} {...row} />
                    ))}
                    {toolBoard.hidden > 0 ? (
                      <TypeMicro style={{ color: tokens.textTertiary }}>+{toolBoard.hidden} more tools</TypeMicro>
                    ) : null}
                  </View>
                </ClayCard>
              )}

              {/* ── the API key stats (verdict #32) — whole-history rollups;
                  providerIds stay mono (no extra providers roundtrip — the
                  machine truth is the honest cheap read) ── */}
              {detailed !== null && detailed.keys.length > 0 ? (
                <>
                  <SectionHeader>Keys · all time</SectionHeader>
                  <ClayCard testID="dashboard-keys">
                    <View style={styles.rowsPad}>
                      {detailed.keys.map((key) => (
                        <KeyStatRow
                          key={`${key.providerId}-${key.keySlot}`}
                          providerId={key.providerId}
                          keySlot={key.keySlot}
                          requests={key.requests}
                          tokensTotal={key.inputTokens + key.outputTokens}
                          costUsd={key.costUsd}
                          lastUsedAt={key.lastUsedAt}
                        />
                      ))}
                    </View>
                  </ClayCard>
                </>
              ) : null}

              {/* ── the projects drill-down (verdict #32) — whole-history
                  rows; tap expands the inline sessions well (the
                  projects-screen accordion grammar) ── */}
              <SectionHeader>Projects · all time</SectionHeader>
              {detailed === null ? (
                <QuietLine>
                  {detailedMissing ? detailedUnavailableLine : "no projects with usage yet"}
                </QuietLine>
              ) : detailed.projects.length === 0 ? (
                <QuietLine>no projects with usage yet</QuietLine>
              ) : (
                <View style={styles.projectsList} testID="dashboard-projects">
                  {detailed.projects.map((project) => (
                    <ProjectUsageRow
                      key={project.id}
                      testID={`dashboard-project-${project.id}`}
                      project={project}
                      expanded={expandedProject === project.id}
                      onToggle={() => toggleProject(project.id)}
                    />
                  ))}
                </View>
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
  emptyPad: { padding: spacing.lg, alignItems: "center" },
  rowsPad: { padding: spacing.md, gap: spacing.sm },
  projectsList: { gap: spacing.md },
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
  footer: { textAlign: "center" },
  skeletonWrap: { gap: spacing.lg },
  carouselSkeleton: { height: 116, borderRadius: RADIUS_CARD },
  chartSkeleton: { height: CHART_HEIGHT + 96, borderRadius: RADIUS_CARD },
});
