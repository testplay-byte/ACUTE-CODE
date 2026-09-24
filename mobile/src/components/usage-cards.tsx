/**
 * usage-cards.tsx — R118-C: the dashboard's section components (the
 * mobile-first vertical-instrument redo). Everything here is PRESENTATIONAL:
 * the dashboard screen (app/(tabs)/dashboard.tsx) owns the fetch orchestration
 * and passes typed rows down; this module owns the shapes.
 *
 * R124 (the owner's round-124 verdict — "the complete UI redesign of the
 * dashboard page … at the very top it shows me the three options: 14 days,
 * 30 days, three months. That is definitely not the place for it to be …
 * the model's last month donut chart is not proper. It is looking ugly and
 * bad"):
 *
 *   · RangeChips        — the COMPACT window selector that now lives INSIDE
 *                         the daily chart's card (its first row — the control
 *                         reads as belonging to the chart it scopes, never
 *                         as the page's hero). 40-tall surfaceWell track,
 *                         self-sized segments, the tab-pill indicator recipe
 *                         at the compact tier gliding on TAB_SPRING.
 *   · PeriodSegmentedControl — R124 TOMBSTONE: zero call sites since the
 *                         selector moved into the chart card; kept for
 *                         export stability (the ActivityGrid precedent).
 *   · ModelLegendRow    — redesigned for the R124 models card: the ring sits
 *                         BESIDE the ranked legend (one row, no dead bands,
 *                         no full-width wire hoop), so the row is the
 *                         COMPACT side-legend shape — hue dot + the
 *                         HUMANIZED name (cleanModelName — never the raw id)
 *                         + the share pct, with the tokens · cost · calls
 *                         caption under it. Full facts stay in the a11y label.
 *   · StatGrid          — the card's padding moves md → lg (the round's
 *                         consistent-breathing pass).
 *
 * Everything else (ToolLeaderboardRow / KeyStatRow / ProjectUsageRow / the
 * accordion) is untouched R118-C surface.
 *
 * THE COLOR CONTRACT (round-116 §1.6): every MODEL surface here resolves its
 * color through modelColor(model.name, isDark) — the PC's 12-hue name-hash
 * palette port (src/design/model-colors.ts). CHART_HUES stays the chart bars'
 * semantic family; model hue IDENTITY is the data encoding.
 *
 * THE MOTION SPLIT (§2.7, R118-C): expansion rides DISCLOSURE_SPRING {180,24}
 * — ζ 0.894, one soft settle; COLLAPSE rides withTiming 200ms ease-out + a
 * 150ms opacity fade — a timing curve cannot overshoot, so closing never
 * bounces. Reduced motion snaps. The chevron follows the same split.
 *
 * The pure number/date/status formatters (formatTokens/formatUsd/formatCount/
 * shortDate/formatClock/timeAgoFromIso/sessionStatusBadge/
 * sessionLastActivityIso/PERIOD_OPTIONS/localDateString/chartAxisTicks)
 * moved to usage-format.ts (pure, zero RN imports, jest-pinned) — RE-EXPORTED
 * below so every existing `@/components/usage-cards` import path keeps working.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { ChevronDown } from "lucide-react-native";
import { LetterAvatar } from "@/components/letter-avatar";
import {
  Badge,
  ClayCard,
  Hairline,
  PressableCard,
  TypeBodyStrong,
  TypeCaption,
  TypeMicro,
  TypeMono,
  TypeStat,
} from "@/design/primitives";
import { DONUT_DIM_OPACITY } from "@/components/chart-donut";
import { modelColor } from "@/design/model-colors";
import {
  DISCLOSURE_COLLAPSE_MS,
  DISCLOSURE_FADE_MS,
  DISCLOSURE_SPRING,
  TAB_SPRING,
} from "@/design/motion";
import { useTheme } from "@/design/theme";
import {
  fontFamily,
  mixHex,
  RADIUS_INPUT,
  SEGMENT_INSET,
  SEGMENT_TRACK_H,
  spacing,
  TYPE_CAPTION,
} from "@/design/tokens";
import { cleanModelName, type DetailedUsageProject, type DetailedUsageSession, type UsageStatsModel } from "@/features/config";
import {
  formatCount,
  formatTokens,
  formatUsd,
  PERIOD_OPTIONS,
  sessionLastActivityIso,
  sessionStatusBadge,
  shortDate,
  timeAgoFromIso,
  type PeriodKey,
} from "@/components/usage-format";

// ── the pure helpers (one spelling, shared with the dashboard screen) ───────

export {
  chartAxisTicks,
  formatClock,
  formatCount,
  formatTokens,
  formatUsd,
  localDateString,
  PERIOD_OPTIONS,
  sessionLastActivityIso,
  sessionStatusBadge,
  shortDate,
  timeAgoFromIso,
} from "./usage-format";
export type {
  PeriodKey,
  PeriodOption,
  SessionBadgeTone,
  SessionStatusBadge,
} from "./usage-format";

// ── the shared day row (the chart's, the grid's, the detail line's) ─────────

/**
 * One chart/grid bar. Summary windows fill every field; the 3-month stats
 * series carries totals only — the nulls keep the tap-through detail honest.
 */
export interface UsageDayRow {
  date: string;
  tokens: number;
  inputTokens: number | null;
  outputTokens: number | null;
  requests: number | null;
  costUsd: number | null;
}

// ── the window selector (R124 — the compact in-chart control) ───────────────

/**
 * R124 — THE RANGE CHIPS: the compact 14d/30d/3mo window selector that lives
 * INSIDE the daily chart's card (its first row, self-sized and leading), so
 * the control reads as the chart's own toolbar — the owner's verdict killed
 * its old life as the page's opening hero ("at the very top it shows me the
 * three options … that is definitely not the place for it to be").
 *
 * Geometry — the shared segmented grammar at the COMPACT tier: a 40-tall
 * surfaceWell track (radius 20, hairline clayRim — the R117 chip resting
 * surface) wrapping SELF-SIZED segments (no flex:1 — "14d" never stretches),
 * with the tab-pill indicator recipe scaled down: accentTint fill + a 1.5px
 * accentDeep border (r17), gliding on TAB_SPRING. Labels pin the chrome tier
 * — 12.5/700 accentDeep selected, 12.5/600 textSecondary unselected. The
 * 32px visual segments carry hitSlop ±6 vertical → the 44px touch law holds
 * without a 52px chrome band riding inside the card. testIDs stay
 * `dashboard-window-14d/30d/3mo` (the walkthrough contract).
 */
const RANGE_TRACK_H = 40;
const RANGE_TRACK_INSET = 3;
/** The compact tier's effective-touch hitSlop — 32px visual + 12 = 44. */
const RANGE_HIT_SLOP = 6;

export function RangeChips({
  selected,
  onSelect,
}: {
  selected: PeriodKey;
  onSelect: (key: PeriodKey) => void;
}) {
  const { tokens } = useTheme();
  const reduced = useReducedMotion();
  /** Each segment's measured x/width inside the track (the indicator's pose). */
  const [segmentLayout, setSegmentLayout] = useState<Partial<Record<PeriodKey, { x: number; width: number }>>>({});
  const indicatorX = useSharedValue(-1);
  const indicatorWidth = useSharedValue(0);
  /** False until the first pose lands — the mount pose snaps, never springs. */
  const primed = useRef(false);

  const activeLayout = segmentLayout[selected];

  useEffect(() => {
    if (activeLayout === undefined) return;
    if (!primed.current) {
      // The mount pose: appear exactly on the selected segment, no slide-in.
      primed.current = true;
      indicatorX.value = activeLayout.x;
      indicatorWidth.value = activeLayout.width;
      return;
    }
    if (reduced) {
      indicatorX.value = activeLayout.x;
      indicatorWidth.value = activeLayout.width;
      return;
    }
    indicatorX.value = withSpring(activeLayout.x, TAB_SPRING);
    // The labels are all ≤4 chars — the width deltas are sub-pixel; snap it.
    indicatorWidth.value = activeLayout.width;
  }, [activeLayout, reduced, indicatorX, indicatorWidth]);

  const indicatorStyle = useAnimatedStyle(() => ({
    width: indicatorWidth.value,
    transform: [{ translateX: indicatorX.value }],
  }));

  return (
    <View
      style={[
        styles.rangeTrack,
        {
          alignSelf: "flex-start",
          backgroundColor: tokens.surfaceWell,
          borderColor: tokens.clayRim,
        },
      ]}
    >
      {activeLayout !== undefined ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.rangeIndicator,
            { backgroundColor: tokens.accentTint, borderColor: tokens.accentDeep },
            indicatorStyle,
          ]}
        />
      ) : null}
      {PERIOD_OPTIONS.map((option) => {
        const isSelected = option.key === selected;
        return (
          <Pressable
            key={option.key}
            testID={`dashboard-window-${option.key}`}
            accessibilityRole="button"
            accessibilityLabel={option.accessibilityLabel}
            accessibilityState={{ selected: isSelected }}
            hitSlop={{ top: RANGE_HIT_SLOP, bottom: RANGE_HIT_SLOP }}
            onPress={() => onSelect(option.key)}
            onLayout={(event: LayoutChangeEvent) => {
              const { x, width } = event.nativeEvent.layout;
              setSegmentLayout((current) => {
                const known = current[option.key];
                if (known !== undefined && known.x === x && known.width === width) return current;
                return { ...current, [option.key]: { x, width } };
              });
            }}
            style={styles.rangeSegment}
          >
            <Text
              numberOfLines={1}
              style={{
                color: isSelected ? tokens.accentDeep : tokens.textSecondary,
                fontSize: TYPE_CAPTION,
                fontFamily: isSelected ? fontFamily.bold : fontFamily.semibold,
                lineHeight: 16,
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── the period selector (R124 TOMBSTONE) ────────────────────────────────────

/**
 * R124 TOMBSTONE — zero call sites since the window selector moved INTO the
 * daily chart's card as the compact RangeChips (the owner's round-124
 * verdict: the control is not the page's hero — "that is definitely not the
 * place for it to be"); kept for export stability (the ActivityGrid
 * precedent). The R118-C spelling it froze:
 *
 * THE PERIOD SELECTOR — ONE self-sized 3-segment control (leading, never a
 * wrapping row of three buttons). Geometry = the shared SegmentedControl
 * grammar (track 52 / r26 / inset 4) with the tab-pill indicator (accentTint
 * fill + a 2px accentDeep border, r22) gliding on TAB_SPRING; labels at the
 * chrome tier (12.5/700 accentDeep selected, 12.5/600 textSecondary
 * unselected); testIDs `dashboard-window-14d/30d/3mo`.
 */
export function PeriodSegmentedControl({
  selected,
  onSelect,
}: {
  selected: PeriodKey;
  onSelect: (key: PeriodKey) => void;
}) {
  const { tokens } = useTheme();
  const reduced = useReducedMotion();
  /** Each segment's measured x/width inside the track (the indicator's pose). */
  const [segmentLayout, setSegmentLayout] = useState<Partial<Record<PeriodKey, { x: number; width: number }>>>({});
  const indicatorX = useSharedValue(-1);
  const indicatorWidth = useSharedValue(0);
  /** False until the first pose lands — the mount pose snaps, never springs. */
  const primed = useRef(false);

  const activeLayout = segmentLayout[selected];

  useEffect(() => {
    if (activeLayout === undefined) return;
    if (!primed.current) {
      // The mount pose: appear exactly on the selected segment, no slide-in.
      primed.current = true;
      indicatorX.value = activeLayout.x;
      indicatorWidth.value = activeLayout.width;
      return;
    }
    if (reduced) {
      indicatorX.value = activeLayout.x;
      indicatorWidth.value = activeLayout.width;
      return;
    }
    indicatorX.value = withSpring(activeLayout.x, TAB_SPRING);
    // The labels are all ≤4 chars — the width deltas are sub-pixel; snap it.
    indicatorWidth.value = activeLayout.width;
  }, [activeLayout, reduced, indicatorX, indicatorWidth]);

  const indicatorStyle = useAnimatedStyle(() => ({
    width: indicatorWidth.value,
    transform: [{ translateX: indicatorX.value }],
  }));

  return (
    <View
      style={[
        styles.periodTrack,
        {
          alignSelf: "flex-start",
          backgroundColor: tokens.surfaceWell,
          borderColor: tokens.clayRim,
        },
      ]}
    >
      {activeLayout !== undefined ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.periodIndicator,
            { backgroundColor: tokens.accentTint, borderColor: tokens.accentDeep },
            indicatorStyle,
          ]}
        />
      ) : null}
      {PERIOD_OPTIONS.map((option) => {
        const isSelected = option.key === selected;
        return (
          <Pressable
            key={option.key}
            testID={`dashboard-window-${option.key}`}
            accessibilityRole="button"
            accessibilityLabel={option.accessibilityLabel}
            accessibilityState={{ selected: isSelected }}
            onPress={() => onSelect(option.key)}
            onLayout={(event: LayoutChangeEvent) => {
              const { x, width } = event.nativeEvent.layout;
              setSegmentLayout((current) => {
                const known = current[option.key];
                if (known !== undefined && known.x === x && known.width === width) return current;
                return { ...current, [option.key]: { x, width } };
              });
            }}
            style={styles.periodSegment}
          >
            <Text
              numberOfLines={1}
              style={{
                color: isSelected ? tokens.accentDeep : tokens.textSecondary,
                fontSize: TYPE_CAPTION,
                fontFamily: isSelected ? fontFamily.bold : fontFamily.semibold,
                lineHeight: 16,
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── the headline stat block (§2.2) ──────────────────────────────────────────

/** One StatGrid cell — kicker → value → optional one-line caption. */
export interface StatGridCell {
  key: string;
  /** The uppercase TypeMicro kicker ("Tokens", "Cost", …). */
  kicker: string;
  /** The headline figure — formatTokens/formatUsd/formatCount's spelling. */
  value: string;
  /** The optional one-line TypeMicro caption (the cell's honesty scope). */
  caption?: string;
}

/**
 * THE STAT GRID — the screen's biggest numbers first: ONE ClayCard (the
 * resting clay material: r20, clayShadow1, clayRim) carrying a composed
 * grid — 2×2 on phones, 4-across ≥768dp — with the cells split by 1px inset
 * dividers at borderStrong (the shared strong-divider spelling). Cell =
 * TypeMicro kicker (uppercase 0.8 tertiary) → TypeStat value (28
 * mono-medium, ink) → optional one-line TypeMicro caption; minHeight 88.
 * No icon chips, no carousels — one window, one card, four numbers.
 * R124: the card's padding moves md → lg (the round's consistent-breathing
 * pass — every redesigned dashboard card now pads lg).
 */
export function StatGrid({
  cells,
  wide = false,
  testID,
}: {
  cells: ReadonlyArray<StatGridCell>;
  /** ≥768dp: 4-across instead of the phone's 2×2. */
  wide?: boolean;
  /** The cell testIDs' prefix — `${testID}-${cell.key}`. */
  testID?: string;
}) {
  const { tokens } = useTheme();
  if (cells.length === 0) return null;
  const columns = wide ? Math.min(4, cells.length) : 2;
  const rows = Math.ceil(cells.length / columns);

  return (
    <ClayCard>
      <View style={styles.statGridPad}>
        <View style={styles.statGrid}>
          {cells.map((cell, index) => {
            const isLastRow = Math.floor(index / columns) === rows - 1;
            const isLastColumn = (index + 1) % columns === 0 || index === cells.length - 1;
            return (
              <View
                key={cell.key}
                testID={testID !== undefined ? `${testID}-${cell.key}` : undefined}
                accessibilityLabel={`${cell.kicker}: ${cell.value}${cell.caption !== undefined ? `, ${cell.caption}` : ""}`}
                style={[
                  styles.statCell,
                  { width: `${100 / columns}%` },
                  !isLastColumn ? { borderRightWidth: 1, borderRightColor: tokens.borderStrong } : null,
                  !isLastRow ? { borderBottomWidth: 1, borderBottomColor: tokens.borderStrong } : null,
                ]}
              >
                <TypeMicro
                  numberOfLines={1}
                  style={[styles.statKicker, { color: tokens.textTertiary }]}
                >
                  {cell.kicker}
                </TypeMicro>
                <TypeStat numberOfLines={1}>{cell.value}</TypeStat>
                {cell.caption !== undefined ? (
                  <TypeMicro numberOfLines={1} style={{ color: tokens.textSecondary }}>
                    {cell.caption}
                  </TypeMicro>
                ) : null}
              </View>
            );
          })}
        </View>
      </View>
    </ClayCard>
  );
}

// ── the GitHub-style activity grid (R118-C TOMBSTONE) ───────────────────────

const GRID_GAP = 3;
/** The intensity ladder's blend stops toward the accent (level 4 = accent). */
const GRID_TINTS: ReadonlyArray<number> = [0.26, 0.48, 0.7];

/** "2026-09-01" → 0..6 (Sunday-first, calendar-LOCAL — matches shortDate). */
function dayOfWeek(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (m === null) return 0;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay();
}

/**
 * R118-C TOMBSTONE — zero call sites since the vertical-instrument redo
 * (the daily chart owns the day buckets; a second surface over the same
 * data was the §1 #5 duplication); kept for export stability.
 *
 * The 7-row × N-week intensity grid over the window's own day buckets —
 * GitHub's grammar, the house's reading: the accent (the clay-est hue in
 * the palette) blended toward the card in four steps, empty days the subtle
 * background fill. Levels are quartiles of THIS window's nonzero days (the
 * busiest day always reads as the top level). Tapping a cell drives the
 * shared day spotlight (the chart's selected bar + the detail lines).
 */
export function ActivityGrid({
  days,
  width,
  selected,
  onSelect,
}: {
  days: UsageDayRow[];
  width: number;
  selected: number | null;
  onSelect: (index: number | null) => void;
}) {
  const { tokens } = useTheme();
  const n = days.length;

  const { firstDow, cols, cell } = useMemo(() => {
    if (n === 0) return { firstDow: 0, cols: 0, cell: 0 };
    const dow = dayOfWeek(days[0].date);
    const columns = Math.ceil((dow + n) / 7);
    const size = Math.min(18, Math.max(11, Math.floor((width - (columns - 1) * GRID_GAP) / columns)));
    return { firstDow: dow, cols: columns, cell: size };
  }, [days, n, width]);

  // The intensity ladder: [empty, q25, q50, q75, max] over the nonzero days,
  // the accent blended toward the card (level 4 is the accent itself).
  const { thresholds, colors } = useMemo(() => {
    const sorted = days.map((day) => day.tokens).filter((value) => value > 0).sort((a, b) => a - b);
    const pick = (p: number): number =>
      sorted.length === 0 ? Number.POSITIVE_INFINITY : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    const q75 = pick(0.75);
    const max = sorted.length === 0 ? 0 : sorted[sorted.length - 1];
    // The window's max must always read as the TOP level (a single active
    // day is the BUSIEST day, never the quietest) — nudge the top threshold
    // under it when the quartile collides with the max.
    const t3 = q75 >= max && max > 0 ? max - 0.5 : q75;
    return {
      thresholds: [pick(0.25), pick(0.5), t3],
      colors: [
        tokens.subtle,
        ...GRID_TINTS.map((tint) => mixHex(tokens.card, tokens.accent, tint)),
        tokens.accent,
      ],
    };
  }, [days, tokens]);

  const levelFor = (value: number): number => {
    if (value <= 0) return 0;
    if (value <= thresholds[0]) return 1;
    if (value <= thresholds[1]) return 2;
    if (value <= thresholds[2]) return 3;
    return 4;
  };

  if (n === 0 || cols === 0) return null;
  const cellRadius = Math.max(2, Math.round(cell * 0.24));

  return (
    <View
      testID="dashboard-activity-grid"
      accessibilityLabel="daily activity intensity grid, tap a day for its detail"
      accessibilityRole="image"
      style={styles.grid}
    >
      {Array.from({ length: cols }, (_, week) => (
        <View key={week} style={styles.gridColumn}>
          {Array.from({ length: 7 }, (_, dow) => {
            const index = week * 7 + dow - firstDow;
            if (index < 0 || index >= n) {
              // The leading/trailing stub days outside the window.
              return <View key={dow} style={{ width: cell, height: cell }} />;
            }
            const day = days[index];
            const isSelected = selected === index;
            return (
              <Pressable
                key={dow}
                accessibilityRole="button"
                accessibilityLabel={`${shortDate(day.date)} · ${formatTokens(day.tokens)} tokens${
                  day.requests !== null ? ` · ${formatCount(day.requests)} requests` : ""
                }`}
                onPress={() => onSelect(isSelected ? null : index)}
                style={[
                  {
                    width: cell,
                    height: cell,
                    borderRadius: cellRadius,
                    backgroundColor: colors[levelFor(day.tokens)],
                  },
                  isSelected ? { borderWidth: 1.5, borderColor: tokens.text } : null,
                ]}
              />
            );
          })}
        </View>
      ))}
    </View>
  );
}

// ── the tool leaderboard row ────────────────────────────────────────────────

/**
 * One Tools row — rank + mono tool name + count + the failures chip (danger
 * tone, ONLY when failures > 0) over a proportional sparkbar (count scaled
 * to the leaderboard's own max). This REPLACES the old Activity table's
 * tool-failure rows and the Health block (round-116 #33).
 */
export function ToolLeaderboardRow({
  rank,
  tool,
  count,
  failures,
  fraction,
}: {
  rank: number;
  tool: string;
  count: number;
  failures: number;
  /** 0..100 — count / the section's max count. */
  fraction: number;
}) {
  const { tokens } = useTheme();
  return (
    <View
      style={styles.toolRow}
      accessibilityLabel={`Tool ${tool}, rank ${rank}: ${formatCount(count)} calls${
        failures > 0 ? `, ${formatCount(failures)} failed` : ""
      }`}
    >
      <TypeMono style={[styles.toolRank, { color: tokens.textTertiary }]}>{rank}</TypeMono>
      <View style={styles.toolMain}>
        <View style={styles.toolHead}>
          <TypeMono numberOfLines={1} style={styles.toolName}>
            {tool}
          </TypeMono>
          {failures > 0 ? <Badge tone="danger">{`${formatCount(failures)} failed`}</Badge> : null}
          <TypeMono numberOfLines={1} style={styles.toolCount}>
            {formatCount(count)}
          </TypeMono>
        </View>
        {/* The sparkbar is decorative — the name + mono count carry the reading.
            R117-g2 §2.3: the track rides surfaceWell (the recessed step), the
            fill stays accent (3.9:1 vs card — bars are non-text, pass). */}
        <View
          style={[styles.toolTrack, { backgroundColor: tokens.surfaceWell }]}
          accessibilityElementsHidden
        >
          <View style={[styles.toolFill, { width: `${fraction}%`, backgroundColor: tokens.accent }]} />
        </View>
      </View>
    </View>
  );
}

// ── the model legend row (the R124 models card's side-legend half) ───────────

/**
 * R124 — ONE LEGEND ROW, the compact side-legend shape: the models card now
 * composes the ring BESIDE the ranked legend (one row — the R120-S
 * full-card-width wire hoop is gone), so the row carries the hue dot + the
 * HUMANIZED name (cleanModelName — "z-ai/glm-5.2:free" reads "Glm 5.2",
 * NEVER the raw id; the provider-screen's displayName ?? cleanModelName
 * pattern applied where the wire row has no displayName to prefer) + the
 * share pct right-aligned in mono, with the tokens · cost · calls caption
 * under it. The full facts (name, share, tokens, cost, calls) stay in the
 * a11y label; the visible caption clamps to one line and ellipsizes — the
 * tight column never wraps into clutter.
 *
 * The MUTUAL HIGHLIGHT survives the redesign: tapping spotlights that
 * model's arc on the ring (this row + its segment at 1, everything else
 * dimmed to DONUT_DIM_OPACITY) and the ring's center swaps to the model's
 * own numbers (the dashboard's center slot); tapping it again clears.
 */
export function ModelLegendRow({
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
  const name = cleanModelName(model.model);
  return (
    <Pressable
      testID={`dashboard-legend-${rank}`}
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ selected: highlighted }}
      accessibilityLabel={`${name}: ${pct}% of tokens, ${formatTokens(model.tokens)} tokens, ${formatUsd(model.costUsd)}, ${formatCount(model.calls)} calls`}
      style={({ pressed }) => [
        styles.modelLegendRow,
        {
          backgroundColor: pressed ? tokens.subtleHover : "transparent",
          opacity: dimmed ? DONUT_DIM_OPACITY : 1,
        },
      ]}
    >
      <View style={styles.modelHead}>
        <View style={[styles.modelDot, { backgroundColor: hue }]} accessibilityElementsHidden />
        <TypeMono numberOfLines={1} style={styles.modelName}>
          {name}
        </TypeMono>
        <TypeMono numberOfLines={1} style={styles.legendPct}>{`${pct}%`}</TypeMono>
      </View>
      <TypeMicro numberOfLines={1} style={[styles.legendCaption, { color: tokens.textTertiary }]}>
        {`${formatTokens(model.tokens)} · ${formatUsd(model.costUsd)} · ${formatCount(model.calls)} calls`}
      </TypeMicro>
    </Pressable>
  );
}

// ── the API key stat row ────────────────────────────────────────────────────

/**
 * One key rollup row — the providerId in mono (the honest machine truth when
 * no local provider-name map is loaded; resolving names would cost an extra
 * roundtrip this screen refuses), the slot word (primary / pool slot N), the
 * requests · tokens · cost meta line, and the last-used timeAgo trailing.
 */
export function KeyStatRow({
  providerId,
  keySlot,
  requests,
  tokensTotal,
  costUsd,
  lastUsedAt,
}: {
  providerId: string;
  keySlot: number;
  requests: number;
  tokensTotal: number;
  costUsd: number;
  lastUsedAt: string;
}) {
  const { tokens } = useTheme();
  const slotLabel = keySlot === 0 ? "primary key" : `slot ${keySlot}`;
  const lastUsed = timeAgoFromIso(lastUsedAt);
  return (
    <View
      style={styles.keyRow}
      accessibilityLabel={`${providerId} ${slotLabel}: ${formatCount(requests)} requests, ${formatTokens(tokensTotal)} tokens, ${formatUsd(costUsd)}, last used ${lastUsed}`}
    >
      <View style={styles.keyHead}>
        <TypeMono numberOfLines={1} style={styles.keyProvider}>
          {providerId}
        </TypeMono>
        <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary, flexShrink: 0 }}>
          {lastUsed}
        </TypeMicro>
      </View>
      <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
        {`${slotLabel} · ${formatCount(requests)} requests · ${formatTokens(tokensTotal)} tokens · ${formatUsd(costUsd)}`}
      </TypeMicro>
    </View>
  );
}

// ── the projects section (row + inline sessions accordion) ──────────────────

/** How many sessions the expansion previews before the "+N more" line. */
const PROJECT_SESSIONS_PREVIEW = 5;

/** The honest drill-down title: the session's own title, else a short id caption. */
function sessionRowTitle(session: DetailedUsageSession): string {
  const trimmed = session.title.trim();
  return trimmed !== "" ? trimmed : `Session ${session.id.slice(0, 12)}`;
}

/** The collapse's timing curve — ease-out, zero overshoot by construction. */
const COLLAPSE_EASING = Easing.out(Easing.quad);

/**
 * THE ACCORDION (R115-h's Yoga fix + R118-C §2.7's motion split): height +
 * opacity under DISCLOSURE_SPRING on EXPAND (ζ 0.894 — one soft settle, the
 * bounce the owner likes as a whisper), and on COLLAPSE the height rides
 * withTiming 200ms ease-out while the content fades over 150ms — a timing
 * curve cannot overshoot, so closing never bounces. The clip View carries
 * overflow:hidden ONLY (a static height would race the animated value AND
 * make Yoga clamp the relative auto-height child to 0 — onLayout reported 0
 * forever); the measurement child is ABSOLUTE so it lays out at its NATURAL
 * height at any clip height. Reduced motion snaps instead of animating.
 */
function UsageAccordion({ open, children }: { open: boolean; children: ReactNode }) {
  const reduced = useReducedMotion();
  const height = useSharedValue(0);
  const opacity = useSharedValue(0);
  // The measured natural height — a SHARED VALUE so the toggle effect reads
  // the FRESH number whenever it fires.
  const contentHeight = useSharedValue(0);

  useEffect(() => {
    if (reduced) {
      height.value = open ? contentHeight.value : 0;
      opacity.value = open ? 1 : 0;
      return;
    }
    if (open) {
      height.value = withSpring(contentHeight.value, DISCLOSURE_SPRING);
      opacity.value = withSpring(1, DISCLOSURE_SPRING);
    } else {
      height.value = withTiming(0, { duration: DISCLOSURE_COLLAPSE_MS, easing: COLLAPSE_EASING });
      opacity.value = withTiming(0, { duration: DISCLOSURE_FADE_MS });
    }
  }, [open, reduced, height, opacity, contentHeight]);

  const style = useAnimatedStyle(() => ({
    height: Math.max(0, height.value),
    opacity: Math.max(0, opacity.value),
  }));

  const onLayout = (event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.height;
    if (measured <= 0) return;
    contentHeight.value = measured;
    // An OPEN panel whose content re-measured springs to the new height on
    // the disclosure spring; a CLOSED one just records it for the next toggle.
    if (open) {
      height.value = reduced ? measured : withSpring(measured, DISCLOSURE_SPRING);
    }
  };

  return (
    <Animated.View style={[styles.accordionClip, style]}>
      {/* The ABSOLUTE measurement child — natural height at any clip height
          (collapsable={false} keeps RN from folding it out of the tree). */}
      <View collapsable={false} onLayout={onLayout} style={styles.accordionMeasure}>
        {children}
      </View>
    </Animated.View>
  );
}

/**
 * One session row inside the expansion (§2.6's anatomy): the 2-line tail
 * title + the honest status badge (ONLY when the status says something —
 * queued shows NOTHING), the model chip (name-hash dot + mono name, the
 * owner's keep) with the last-activity timeAgo trailing, and the
 * right-aligned mono tokens · cost pair. minHeight 56; the 1px
 * borderStrong divider between rows is the well's (the caller's Hairline).
 */
function UsageSessionRow({ session }: { session: DetailedUsageSession }) {
  const { tokens } = useTheme();
  const sessionTokens = session.tokens.input + session.tokens.output;
  const title = sessionRowTitle(session);
  const badge = sessionStatusBadge(session.status);
  const activityIso = sessionLastActivityIso(session);
  const activity = activityIso !== null ? timeAgoFromIso(activityIso) : null;
  return (
    <View
      style={styles.sessionRow}
      accessibilityLabel={`Session ${title}${badge !== null ? `, ${badge.label}` : ""}, ${formatTokens(sessionTokens)} tokens, ${formatUsd(session.costUsd)}${activity !== null ? `, ${activity}` : ""}`}
    >
      <View style={styles.sessionHead}>
        <TypeBodyStrong numberOfLines={2} style={styles.sessionTitle}>
          {title}
        </TypeBodyStrong>
        {badge !== null ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
      </View>
      <View style={styles.sessionMetaRow}>
        {session.model !== null ? (
          <>
            <View
              style={[styles.sessionModelDot, { backgroundColor: modelColor(session.model, tokens.isDark) }]}
              accessibilityElementsHidden
            />
            <TypeMono numberOfLines={1} style={styles.sessionModel}>
              {session.model}
            </TypeMono>
          </>
        ) : null}
        {activity !== null ? (
          <TypeMicro numberOfLines={1} style={[styles.sessionActivity, { color: tokens.textTertiary }]}>
            {activity}
          </TypeMicro>
        ) : null}
      </View>
      <View style={styles.sessionNumbers}>
        <TypeMono numberOfLines={1} style={[styles.sessionTokens, { color: tokens.textSecondary }]}>
          {formatTokens(sessionTokens)}
        </TypeMono>
        <TypeMono numberOfLines={1} style={[styles.sessionCost, { color: tokens.text }]}>
          {` · ${formatUsd(session.costUsd)}`}
        </TypeMono>
      </View>
    </View>
  );
}

/**
 * One project row — the LetterAvatar identity (never a bare colored dot,
 * donts #15), the name + sessions/tokens meta line, the all-time cost
 * trailing, and the chevron affordance. Tapping expands the inline sessions
 * WELL (§2.6: the recessed surfaceWell container, RADIUS_INPUT, hairline
 * clayRim, inset by marginHorizontal sm — top sessions newest-first, the
 * server's own drill-down order) under a 1px borderStrong divider that
 * separates the header from the well. The chevron rides §2.7's motion
 * split: DISCLOSURE_SPRING out, the 200ms timing curve back.
 */
export function ProjectUsageRow({
  project,
  expanded,
  onToggle,
  testID,
}: {
  project: DetailedUsageProject;
  expanded: boolean;
  onToggle: () => void;
  testID?: string;
}) {
  const { tokens } = useTheme();
  const reduced = useReducedMotion();
  const chevron = useSharedValue(expanded ? 1 : 0);

  useEffect(() => {
    if (reduced) {
      chevron.value = expanded ? 1 : 0;
      return;
    }
    if (expanded) {
      chevron.value = withSpring(1, DISCLOSURE_SPRING);
    } else {
      chevron.value = withTiming(0, { duration: DISCLOSURE_COLLAPSE_MS, easing: COLLAPSE_EASING });
    }
  }, [expanded, reduced, chevron]);

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${chevron.value * 180}deg` }],
  }));

  const mains = useMemo(
    () => project.sessions.filter((session) => !session.isSubagent),
    [project.sessions],
  );
  const visible = mains.slice(0, PROJECT_SESSIONS_PREVIEW);
  const hidden = mains.length - visible.length;
  const totalTokens = project.totals.tokens.input + project.totals.tokens.output;

  return (
    <PressableCard
      onPress={onToggle}
      testID={testID}
      accessibilityLabel={`Project ${project.name}: ${project.sessionCount} sessions, ${formatTokens(totalTokens)} tokens, ${formatUsd(project.totals.costUsd)}${expanded ? ", expanded" : ""}`}
      accessibilityState={{ expanded }}
    >
      <View style={styles.projectInner}>
        <LetterAvatar label={project.name} color={project.color} size={36} />
        <View style={styles.projectMain}>
          <TypeBodyStrong numberOfLines={1}>{project.name}</TypeBodyStrong>
          <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
            {`${project.sessionCount} session${project.sessionCount === 1 ? "" : "s"} · ${formatTokens(totalTokens)} tokens`}
          </TypeMicro>
        </View>
        <TypeMono numberOfLines={1} style={styles.projectCost}>
          {formatUsd(project.totals.costUsd)}
        </TypeMono>
        <Animated.View style={chevronStyle}>
          <ChevronDown size={18} color={tokens.textTertiary} strokeWidth={2.2} />
        </Animated.View>
      </View>

      {/* ── the inline sessions expansion (§2.6's recessed well) ── */}
      <UsageAccordion open={expanded}>
        {/* The tier break between the project header and the well. */}
        <Hairline strong />
        <View
          style={[
            styles.projectWell,
            { backgroundColor: tokens.surfaceWell, borderColor: tokens.clayRim },
          ]}
        >
          {visible.length === 0 ? (
            // R116-n — the single-line law (donts #31), the dashboard's
            // QuietLine spelling: the well's honest empty clamps.
            <TypeCaption numberOfLines={1} style={[styles.wellFootnote, { color: tokens.textTertiary }]}>
              no sessions recorded yet
            </TypeCaption>
          ) : (
            visible.map((session, index) => (
              <Fragment key={session.id}>
                <UsageSessionRow session={session} />
                {/* The 1px row divider — never after the last row. */}
                {index < visible.length - 1 ? <Hairline strong /> : null}
              </Fragment>
            ))
          )}
          {hidden > 0 ? (
            // R116-n — the clamp the projects screen's own "+N more sessions"
            // row carries (one spelling of the idiom across the two wells).
            <TypeMicro numberOfLines={1} style={[styles.wellFootnote, { color: tokens.textTertiary }]}>
              +{hidden} more sessions
            </TypeMicro>
          ) : null}
          {project.subagents.count > 0 ? (
            <TypeMicro numberOfLines={1} style={[styles.wellFootnote, { color: tokens.textTertiary }]}>
              {`${project.subagents.count} sub-agent session${project.subagents.count === 1 ? "" : "s"}`}
            </TypeMicro>
          ) : null}
        </View>
      </UsageAccordion>
    </PressableCard>
  );
}

// ── styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // The compact range chips (R124): the 40-tall track (r20 / inset 3) with
  // self-sized segments; the ±6 vertical hitSlop rides the Pressables so the
  // 44px touch law holds without a 52px chrome band inside the chart card.
  rangeTrack: {
    height: RANGE_TRACK_H,
    borderRadius: RANGE_TRACK_H / 2,
    padding: RANGE_TRACK_INSET,
    flexDirection: "row",
    borderWidth: StyleSheet.hairlineWidth,
  },
  rangeSegment: {
    minHeight: RANGE_TRACK_H - RANGE_TRACK_INSET * 2,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.md,
  },
  // The compact tab-pill indicator: accentTint fill + the 1.5px accentDeep
  // border, radius 17 = the track's inner height halved.
  rangeIndicator: {
    position: "absolute",
    top: RANGE_TRACK_INSET,
    bottom: RANGE_TRACK_INSET,
    left: 0,
    borderRadius: (RANGE_TRACK_H - RANGE_TRACK_INSET * 2) / 2,
    borderWidth: 1.5,
  },
  // The period selector (§2.1): the shared track geometry (52/r26/inset 4)
  // with self-sized segments carrying the 44px touch law.
  periodTrack: {
    height: SEGMENT_TRACK_H,
    borderRadius: SEGMENT_TRACK_H / 2,
    padding: SEGMENT_INSET,
    flexDirection: "row",
    borderWidth: StyleSheet.hairlineWidth,
  },
  periodSegment: {
    minHeight: SEGMENT_TRACK_H - SEGMENT_INSET * 2,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
  },
  // The tab-pill indicator: accentTint fill + the 2px accentDeep border,
  // radius 22 = the track's inner height halved.
  periodIndicator: {
    position: "absolute",
    top: SEGMENT_INSET,
    bottom: SEGMENT_INSET,
    left: 0,
    borderRadius: (SEGMENT_TRACK_H - SEGMENT_INSET * 2) / 2,
    borderWidth: 2,
  },
  // The stat grid (§2.2): the card's lg padding insets the dividers off the
  // rim; cells pad md so the numbers breathe off the lines (R124: md → lg).
  statGridPad: { padding: spacing.lg },
  statGrid: { flexDirection: "row", flexWrap: "wrap" },
  statCell: { padding: spacing.md, minHeight: 88, gap: 3 },
  statKicker: { textTransform: "uppercase", letterSpacing: 0.8 },
  // The activity grid.
  grid: { flexDirection: "row", gap: GRID_GAP },
  gridColumn: { flexDirection: "column", gap: GRID_GAP },
  // The tool leaderboard row.
  toolRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 44 },
  toolRank: { width: 20, flexShrink: 0, textAlign: "right" },
  toolMain: { flex: 1, gap: 5 },
  toolHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  toolName: { flex: 1 },
  toolCount: { flexShrink: 0, minWidth: 44, textAlign: "right" },
  toolTrack: { height: 4, borderRadius: 2, overflow: "hidden" },
  toolFill: { height: 4, borderRadius: 2 },
  // The model legend row (R124 — the compact side-legend shape): minHeight 44
  // (the touch law holds at the compact tier), the dot at 12, the pct's mono
  // column right-aligned at minWidth 38.
  modelLegendRow: {
    minHeight: 44,
    borderRadius: RADIUS_INPUT,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    gap: 2,
    justifyContent: "center",
  },
  modelHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  modelName: { flex: 1 },
  legendPct: { flexShrink: 0, minWidth: 38, textAlign: "right" },
  // The caption aligns under the model NAME: dot width (12) + head gap (sm).
  legendCaption: { paddingLeft: 12 + spacing.sm },
  // The key stat row.
  keyRow: { gap: 3, minHeight: 44, justifyContent: "center" },
  keyHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  keyProvider: { flex: 1 },
  // The project row + the sessions well (§2.6).
  projectInner: { flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.md },
  projectMain: { flex: 1, gap: 2 },
  projectCost: { flexShrink: 0, minWidth: 52, textAlign: "right" },
  // The recessed well: surfaceWell fill + hairline clayRim + RADIUS_INPUT,
  // inset by marginHorizontal sm; dividers own the rows' rhythm (gap 0).
  projectWell: {
    marginHorizontal: spacing.sm,
    borderRadius: RADIUS_INPUT,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.sm,
    overflow: "hidden",
  },
  wellFootnote: { paddingTop: spacing.sm },
  // The session row anatomy (§2.6): minHeight 56, the 2-line title, the
  // model chip + trailing timeAgo, the right-aligned mono pair.
  sessionRow: { minHeight: 56, paddingVertical: spacing.sm, gap: 3 },
  sessionHead: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  sessionTitle: { flex: 1, lineHeight: 20 },
  sessionMetaRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  sessionModelDot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
  sessionModel: { flexShrink: 1, fontSize: 11 },
  sessionActivity: { flexShrink: 0, marginLeft: "auto" },
  sessionNumbers: { flexDirection: "row", alignItems: "baseline", justifyContent: "flex-end" },
  sessionTokens: { flexShrink: 0 },
  sessionCost: { flexShrink: 0 },
  // The accordion (R115-h — overflow ONLY, no static height).
  accordionClip: { overflow: "hidden" },
  /** The ABSOLUTE measurement child — natural height at any clip height. */
  accordionMeasure: { position: "absolute", top: 0, left: 0, right: 0 },
  // The shared model dot (the name-hash color contract; R117-g2 §2.3:
  // 10 → 12 — identity readability at a squint).
  modelDot: { width: 12, height: 12, borderRadius: 6, flexShrink: 0 },
});
