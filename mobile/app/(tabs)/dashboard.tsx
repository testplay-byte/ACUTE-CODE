/**
 * Dashboard v6 (R118-C — the mobile-first vertical instrument) — the owner's
 * "see the dashboard, the stats, the usage" screen. ONE vertical scroll, ZERO
 * horizontal FlatLists (the R116 carousel mandate is superseded — every
 * horizontal scroller on this screen was a defect: mixed-scope cards behind
 * a swipe, a second surface for the models section, a duplicate of the
 * chart's own day buckets).
 *
 * THE LOAD (features/config.ts, typed 1:1 — the orchestration is untouched):
 *   window 14d/30d → fetchUsageSummary(14|30) + fetchUsageStats(1) alongside
 *                    (always — the models ring's own calendar window)
 *   window 3mo     → fetchUsageStats(3) — its series is daily, so it carries
 *                    the chart AND the ring
 *   every window   → fetchDetailedUsage(14|30|90) — the whole-history
 *                    drill-down (tools/keys/projects)
 *
 * THE STACK (top → bottom, §2.0): the PERIOD SELECTOR — one self-sized
 * 14d/30d/3mo segmented control (the tab-pill recipe, TAB_SPRING glide) →
 * THE STAT GRID — one ClayCard, 2×2 composed cells (4-across ≥768dp) split
 * by 1px inset borderStrong dividers, all four numbers from the SELECTED
 * window (Tokens in/out · Cost avg/day · Turns · Peak day) → THE DAILY
 * CHART — the hand-built react-native-svg stacked bar chart (input
 * terracotta / output sage, dashed gridlines, thin capped bars centered in
 * their columns, weekday ticks + the "today" anchor in the 14-day window,
 * tap a bar for its day) → MODELS — the R117 donut + the ranked list in ONE
 * card (cap 8 + the honest "+N more models"; R120-S — the ring STRETCHES to
 * the card's full content width, the fixed 120px centered ring's dead side
 * bands are gone) → TOOLS → KEYS — the
 * whole-history leaderboards with 1px row dividers → PROJECTS — the
 * drill-down rows with the inline sessions well (the honest status law:
 * queued shows NO badge) → the footer clock.
 *
 * TABLET (≥768dp, §2.8): the body stack centers at maxWidth 840; the stats
 * go 4-across; the chart + models pair side-by-side; tools + keys pair when
 * keys exist; projects stay full width; the selector stays self-sized
 * leading.
 *
 * MOTION: the bars GROW from the baseline on every data load (withTiming
 * 350ms, staggered 12ms, capped at 30 beats) and the donut SWEEPS its arcs
 * in (500ms) — unchanged; the accordions ride the R118-C disclosure split
 * (expand DISCLOSURE_SPRING {180,24}; collapse withTiming 200ms ease-out +
 * 150ms fade — closing never bounces). Reduced motion snaps everywhere.
 *
 * The pure number/date/status helpers live in components/usage-format.ts
 * (jest-pinned, zero RN imports), re-exported through usage-cards.tsx.
 */

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { RefreshControl, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Svg, { G, Line, Rect } from "react-native-svg";
import Animated, {
  Easing,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { ScreenScaffold } from "@/components/screen-scaffold";
import {
  formatClock,
  formatCount,
  formatTokens,
  formatUsd,
  KeyStatRow,
  localDateString,
  ModelLegendRow,
  PeriodSegmentedControl,
  ProjectUsageRow,
  shortDate,
  StatGrid,
  ToolLeaderboardRow,
  type PeriodKey,
  type StatGridCell,
  type UsageDayRow,
} from "@/components/usage-cards";
import {
  DonutChart,
  donutShares,
  shortModelName,
  type DonutSegment,
} from "@/components/chart-donut";
import { ErrorState, LoadingState, SkeletonList } from "@/components/list-state";
import {
  ClayCard,
  Hairline,
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
  fontFamily,
  mixHex,
  RADIUS_CARD,
  SEGMENT_TRACK_H,
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
  type UsageSummary,
} from "@/features/config";
import { mobLog, mobWarn } from "@/lib/log";

// ── the window selector's wiring ────────────────────────────────────────────

/**
 * The detailed drill-down's `days` per window — the route validates 1–90, so
 * the 3-month window maps to 90 (the param scopes only that response's own
 * activity series; the whole-history sections are windowless by contract).
 */
const DETAILED_DAYS: Record<PeriodKey, number> = { "14d": 14, "30d": 30, "3mo": 90 };

/** The tool leaderboard's visible rows before the honest "+N more" line. */
const TOOL_ROWS_CAP = 8;
/** The model ranked list's visible rows before the honest "+N more" line (§2.4). */
const MODEL_ROWS_CAP = 8;

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

/** §2.3 — the weekday tick row's label vocabulary ("Mon"-style, calendar-LOCAL). */
const WEEKDAY_LABELS: ReadonlyArray<string> = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "2026-09-01" → "Mon" — parsed calendar-LOCAL, matching shortDate. */
function localWeekday(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (m === null) return "";
  return WEEKDAY_LABELS[new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay()] ?? "";
}

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
        rx={Math.min(2, barWidth / 2)}
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
        rx={Math.min(2, barWidth / 2)}
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
          rx={Math.min(2, barWidth / 2)}
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
  showWeekdayTicks,
}: {
  days: UsageDayRow[];
  width: number;
  selected: number | null;
  onSelect: (index: number | null) => void;
  /** The dataset's identity — the bars' grow re-triggers whenever it changes. */
  dataKey: string;
  /** §2.3 — the weekday tick row renders ONLY in the 14-day window. */
  showWeekdayTicks: boolean;
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
  // R118-C §2.3 — the thin capped bar: 62% of the column, never wider than
  // 10px, never thinner than 1px, CENTERED in its column (the old
  // fill-the-column bars were 18-19px chunks at 14 days).
  const barWidth = Math.max(1, Math.min(columnWidth * 0.62, 10));
  const hasSplit = days.some((day) => day.inputTokens !== null && day.outputTokens !== null);
  // §2.3 — the TODAY anchor: the bucket whose date is the device's own
  // calendar day (the wire's series ends today; a stale dataset anchors
  // nothing — honesty over assumption). Its tick reads "today" and its bar
  // carries full emphasis.
  const todayIso = localDateString();
  const todayIndex = days.findIndex((day) => day.date === todayIso);
  // 3 quiet dashed gridlines (quarter marks) — the y-axis's honest scale.
  const gridFractions = [0.25, 0.5, 0.75];
  // R117-g2 §2.3 — the gridlines one step stronger than borderSubtle: the
  // warm-ink family at 14% (light rgba(38,34,28,·) / dark white), so the
  // dashed scale actually draws on the card.
  const gridStroke = tokens.isDark ? "rgba(255,255,255,0.14)" : "rgba(38,34,28,0.14)";

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
        {/* The quiet dashed gridlines — R117-g2 §2.3's one-step-stronger
            warm-ink stroke (was borderSubtle's 6% — invisible at a squint). */}
        {gridFractions.map((fraction) => {
          const y = baselineY - fraction * plotHeight;
          return (
            <Line
              key={`grid-${fraction}`}
              x1={0}
              y1={y}
              x2={width}
              y2={y}
              stroke={gridStroke}
              strokeWidth={1}
              strokeDasharray="4 4"
            />
          );
        })}
        {days.map((day, index) => {
          const x = index * columnWidth + (columnWidth - barWidth) / 2;
          const isPeak = day.tokens === peakTokens && day.tokens > 0;
          const isSelected = selected === index;
          const isToday = index === todayIndex;
          const emphasis = isPeak || isSelected || isToday ? 1 : 0.72;
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
      {showWeekdayTicks ? (
        // §2.3 — the weekday tick row (the 14-day window only): a label on
        // every 2nd column in the micro tier at 10, with the TODAY bucket
        // anchored — "today" in accentDeep 10/700 (the last bucket by the
        // wire's ends-today contract; a single unbreakable word may kiss its
        // column's edge, which the chart card's padding absorbs).
        <View style={styles.axisRow}>
          {days.map((day, index) => {
            const isToday = index === todayIndex;
            if (index % 2 !== 0 && !isToday) {
              return <View key={`${day.date}-${index}`} style={{ width: columnWidth }} />;
            }
            return (
              <View key={`${day.date}-${index}`} style={{ width: columnWidth, alignItems: "center" }}>
                <Text
                  style={
                    isToday
                      ? [styles.tickToday, { color: tokens.accentDeep }]
                      : [styles.tickWeekday, { color: tokens.textTertiary }]
                  }
                >
                  {isToday ? "today" : localWeekday(day.date)}
                </Text>
              </View>
            );
          })}
        </View>
      ) : (
        // The 30d/3mo windows keep the endpoint axis (their columns are too
        // narrow for a tick every 2nd day to read).
        <View style={styles.axisRow}>
          <TypeMicro style={{ color: tokens.textTertiary }}>{n > 0 ? shortDate(days[0].date) : ""}</TypeMicro>
          <TypeMicro style={{ color: tokens.textTertiary }}>{n > 1 ? shortDate(days[n - 1].date) : ""}</TypeMicro>
        </View>
      )}
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

// ── the loading skeleton ────────────────────────────────────────────────────

function DashboardSkeleton() {
  return (
    <View style={styles.skeletonWrap}>
      {/* Shaped like the stack: the period selector, the 2×2 stat grid, the
          chart card, then rows. */}
      <Skeleton style={styles.selectorSkeleton} />
      <Skeleton style={styles.statsSkeleton} />
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

  const [windowKey, setWindowKey] = useState<PeriodKey>("14d");
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
          // The window itself is fine — leaderboard + ring degrade quietly.
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
    (key: PeriodKey) => {
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
  // window's tokens; the legend below caps at MODEL_ROWS_CAP (§2.4).
  const models = useMemo(() => {
    if (stats === null) return [];
    return [...stats.models].sort((a, b) => b.tokens - a.tokens);
  }, [stats]);
  const topModels = useMemo(() => models.slice(0, MODEL_ROWS_CAP), [models]);
  const hiddenModels = Math.max(0, models.length - topModels.length);
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

  // The models ride the stats response's own calendar window (stats(1) for
  // the 14d/30d chips — the R109-c contract), so the section says THAT.
  const modelsWindowLabel = windowKey === "3mo" ? "last 3 months" : "last month";

  // §2.2 — the stat grid's four cells, ALL from the selected window (the
  // all-time counters leave the headline; the sections own them).
  const statCells = useMemo<StatGridCell[]>(() => {
    const dayCount = days.length > 0 ? days.length : 1;
    return [
      {
        key: "tokens",
        kicker: "Tokens",
        value: formatTokens(totals.totalTokens),
        caption: `${formatTokens(totals.inputTokens)} in / ${formatTokens(totals.outputTokens)} out`,
      },
      {
        key: "cost",
        kicker: "Cost",
        value: formatUsd(totals.costUsd),
        caption: `${formatUsd(totals.costUsd / dayCount)} avg/day`,
      },
      { key: "turns", kicker: "Turns", value: formatCount(totals.requests) },
      {
        key: "peak",
        kicker: "Peak day",
        value: formatTokens(totals.peak.tokens),
        caption: totals.peak.date !== null ? `${shortDate(totals.peak.date)} · busiest` : undefined,
      },
    ];
  }, [totals, days]);

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

  // ── the responsive geometry (§2.8: the tablet reflow) ──
  const wide = windowWidth >= 768;
  // The stack's own width — the scaffold's 16px gutters, capped at 840 on
  // tablets (the centered instrument column).
  const bodyWidth = Math.min(wide ? 840 : Number.POSITIVE_INFINITY, windowWidth - spacing.lg * 2);
  // The chart's responsive width: the window minus the screen gutters (the
  // scaffold's own body padding) minus the chart card's own padding —
  // HALVED when the chart pairs beside the models card on tablets.
  const pairWidth = Math.floor((bodyWidth - spacing.lg) / 2);
  const chartWidth = Math.max(120, Math.floor((wide ? pairWidth : bodyWidth) - spacing.md * 2));
  // ── ROUND-120 (why): ── the donut's ring STRETCHES to its card's full
  // content width (the owner: the chart had "a lot of empty area on the
  // right sides and the left sides" — the fixed 120px ring sat centered in
  // a ~304dp content box with ~92dp dead bands on each side). The models
  // card's inner width is the SAME responsive figure the daily chart rides
  // (both cards pad md inside; on tablets both live in an equal pairCol),
  // so the one constant stretches BOTH charts to the identical full content
  // width — the daily chart already filled it, the ring now does too.
  const donutSize = chartWidth;

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

  // ── the sections (composed once, then stacked or paired per §2.8) ──

  const chartSection = (
    <>
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
              showWeekdayTicks={windowKey === "14d"}
            />
            <View style={styles.dayDetailWrap}>
              {selectedDay !== null && selectedDay < days.length ? (
                <DayDetailLine day={days[selectedDay]} />
              ) : (
                // R116-n — the single-line law (donts #31): the
                // chart's own hint line gains the clamp too.
                <TypeCaption numberOfLines={1} style={{ color: tokens.textTertiary }}>
                  tap a day for its detail
                </TypeCaption>
              )}
            </View>
          </View>
        </ClayCard>
      )}
    </>
  );

  const modelsSection = (
    <>
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
        <ClayCard>
          <View style={styles.donutPad}>
            <View style={styles.donutRow}>
              {/* R117-g2 §2.3: the track rides the mono-well class —
                  mixHex(card,"#2A2018",0.06) light (monoBg's exact
                  recipe), the honest recessed dark branch. */}
              <DonutChart
                testID="dashboard-donut"
                segments={donutSegmentsInput}
                dataKey={donutKey}
                size={donutSize}
                highlighted={highlightedModel}
                trackColor={tokens.monoBg}
                accessibilityLabel={`model usage donut — top model ${shortModelName(models[0].model)} at ${Math.round((modelShares[0] ?? 0) * 100)}% of tokens`}
                center={
                  <View style={[styles.donutCenterWrap, { maxWidth: Math.round(donutSize / 2) }]}>
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
            {/* The ranked list — §2.4's ONE-card fold: 1px borderStrong
                dividers between rows, cap 8, the honest "+N more". */}
            <View>
              {topModels.map((model, index) => (
                <Fragment key={model.model}>
                  <ModelLegendRow
                    model={model}
                    share={modelShares[index] ?? 0}
                    rank={index}
                    highlighted={highlightedModel === index}
                    dimmed={highlightedModel !== null && highlightedModel !== index}
                    onToggle={() => toggleHighlight(index)}
                  />
                  {index < topModels.length - 1 ? <Hairline strong /> : null}
                </Fragment>
              ))}
              {hiddenModels > 0 ? (
                <TypeMicro numberOfLines={1} style={[styles.moreLine, { color: tokens.textTertiary }]}>
                  +{hiddenModels} more models
                </TypeMicro>
              ) : null}
            </View>
          </View>
        </ClayCard>
      )}
    </>
  );

  const toolsSection = (
    <>
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
            {toolBoard.rows.map((row, index) => (
              <Fragment key={row.tool}>
                <ToolLeaderboardRow {...row} />
                {index < toolBoard.rows.length - 1 ? <Hairline strong /> : null}
              </Fragment>
            ))}
            {toolBoard.hidden > 0 ? (
              // R116-n — the clamp the "+N more sessions" idiom carries
              // everywhere else (one spelling).
              <TypeMicro numberOfLines={1} style={[styles.moreLine, { color: tokens.textTertiary }]}>
                +{toolBoard.hidden} more tools
              </TypeMicro>
            ) : null}
          </View>
        </ClayCard>
      )}
    </>
  );

  const keysSection =
    detailed !== null && detailed.keys.length > 0 ? (
      <>
        <SectionHeader>Keys · all time</SectionHeader>
        <ClayCard testID="dashboard-keys">
          <View style={styles.rowsPad}>
            {detailed.keys.map((key, index) => (
              <Fragment key={`${key.providerId}-${key.keySlot}`}>
                <KeyStatRow
                  providerId={key.providerId}
                  keySlot={key.keySlot}
                  requests={key.requests}
                  tokensTotal={key.inputTokens + key.outputTokens}
                  costUsd={key.costUsd}
                  lastUsedAt={key.lastUsedAt}
                />
                {index < detailed.keys.length - 1 ? <Hairline strong /> : null}
              </Fragment>
            ))}
          </View>
        </ClayCard>
      </>
    ) : null;

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
        // The body stack (§2.8): the scaffold's 12px intra-group beat carries
        // inside this wrapper; tablets center the whole instrument at 840.
        <View style={wide ? [styles.bodyStack, styles.tabletBody] : styles.bodyStack}>
          {/* ── the period selector (§2.1) — ONE self-sized control, leading,
              first element of the scroll body, NOT sticky ── */}
          <PeriodSegmentedControl selected={windowKey} onSelect={selectWindow} />

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

              {/* ── the headline stat block (§2.2) — one card, four windowed
                  numbers, the biggest figure first ── */}
              <StatGrid cells={statCells} wide={wide} testID="dashboard-stat" />

              {/* ── the daily chart + the models (§2.3/§2.4) — stacked on
                  phones, side-by-side columns ≥768dp ── */}
              {wide ? (
                <View style={styles.pairRow}>
                  <View style={styles.pairCol}>{chartSection}</View>
                  <View style={styles.pairCol}>{modelsSection}</View>
                </View>
              ) : (
                <>
                  {chartSection}
                  {modelsSection}
                </>
              )}

              {/* ── tools + keys (§2.5) — paired columns on tablets when the
                  keys exist; tools stand alone otherwise ── */}
              {wide && keysSection !== null ? (
                <View style={styles.pairRow}>
                  <View style={styles.pairCol}>{toolsSection}</View>
                  <View style={styles.pairCol}>{keysSection}</View>
                </View>
              ) : (
                <>
                  {toolsSection}
                  {keysSection}
                </>
              )}

              {/* ── the projects drill-down (§2.6) — whole-history rows; tap
                  expands the inline sessions well; full width everywhere ── */}
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
        </View>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  // The body stack (§2.8): the 12px intra-group beat moves inside this
  // wrapper; the tablet column centers at 840.
  bodyStack: { gap: spacing.md },
  tabletBody: { width: "100%", maxWidth: 840, alignSelf: "center" },
  pairRow: { flexDirection: "row", gap: spacing.lg },
  pairCol: { flex: 1, gap: spacing.md },
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
  // §2.3 — the weekday tick row's label tier: the micro recipe at 10px.
  tickWeekday: { fontSize: 10, fontFamily: fontFamily.semibold, lineHeight: 13, letterSpacing: 0.6 },
  tickToday: { fontSize: 10, fontFamily: fontFamily.bold, lineHeight: 13, letterSpacing: 0.6 },
  dayDetailWrap: { paddingHorizontal: spacing.xs },
  emptyPad: { padding: spacing.lg, alignItems: "center" },
  rowsPad: { padding: spacing.md },
  moreLine: { paddingTop: spacing.sm },
  projectsList: { gap: spacing.md },
  // The donut + legend card (R115-N — the leaderboard folded in; R118-C:
  // the dividers own the rows' rhythm).
  donutPad: { padding: spacing.md, gap: spacing.md },
  donutRow: { alignItems: "center" },
  /** ── ROUND-120 (why): ── the center slot's maxWidth is now responsive
   *  (half the stretched ring — was the fixed 84 the 120px ring needed),
   *  passed inline off donutSize; the hole itself grew with the ring. */
  donutCenterWrap: { alignItems: "center" },
  donutCenterName: { textAlign: "center" },
  donutCenterPct: { textAlign: "center" },
  footer: { textAlign: "center" },
  // R117-g2 (AMENDMENT 5): the loading twin knits at the same 12px beat the
  // body stack carries (the skeleton forecasts the rhythm).
  skeletonWrap: { gap: spacing.md },
  // The selector skeleton — the 52px track, self-width, r26.
  selectorSkeleton: { height: SEGMENT_TRACK_H, width: 176, borderRadius: SEGMENT_TRACK_H / 2 },
  // The stat-grid skeleton — the 2×2 composed cells (two ~94px rows + the
  // card's padding).
  statsSkeleton: { height: 200, borderRadius: RADIUS_CARD },
  chartSkeleton: { height: CHART_HEIGHT + 96, borderRadius: RADIUS_CARD },
});
