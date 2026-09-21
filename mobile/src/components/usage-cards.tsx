/**
 * usage-cards.tsx — R116-g: the dashboard's dynamic section components (the
 * round-116 verdict #27-#34 redo). Everything here is PRESENTATIONAL: the
 * dashboard screen (app/(tabs)/dashboard.tsx) owns the fetch orchestration
 * and passes typed rows down; this module owns the shapes.
 *
 *   StatCarouselCard   — one overview-carousel stat card (big mono number +
 *                        icon-chip accent + one-line caption)
 *   ActivityGrid       — the GitHub-style 7-row × N-week intensity grid over
 *                        the window's day buckets (tap a cell = the shared
 *                        day spotlight)
 *   ToolLeaderboardRow — rank + tool + count + failures chip + sparkbar
 *   ModelCarouselCard  — one per-model card (name-hash color dot, in/out
 *                        split, calls, cost, provider micro line)
 *   KeyStatRow         — one API-key rollup row (providerId mono, slot,
 *                        requests/tokens/cost, last-used timeAgo)
 *   ProjectUsageRow    — one project row + the inline sessions accordion
 *                        (the R115-h Yoga-safe pattern, copied)
 *
 * THE COLOR CONTRACT (round-116 §1.6): every MODEL surface here resolves its
 * color through modelColor(model.name, isDark) — the PC's 12-hue name-hash
 * palette port (src/design/model-colors.ts). CHART_HUES stays the chart
 * bars' semantic family; model hue IDENTITY is the data encoding.
 *
 * The pure number/date formatters (formatTokens/formatUsd/formatCount/
 * shortDate/formatClock) moved HERE from dashboard.tsx so both modules share
 * one spelling — exported for the future pure-logic suites.
 */

import { useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from "react-native-reanimated";
import { ChevronDown } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { timeAgo } from "@/components/host-card";
import { LetterAvatar } from "@/components/letter-avatar";
import {
  Badge,
  ClayCard,
  PressableCard,
  TypeBodyStrong,
  TypeCaption,
  TypeMicro,
  TypeMono,
  TypeTitle,
} from "@/design/primitives";
import { modelColor } from "@/design/model-colors";
import { SPRING } from "@/design/motion";
import { useTheme } from "@/design/theme";
import { fontFamily, mixHex, RADIUS_INPUT, spacing } from "@/design/tokens";
import type { DetailedUsageProject, DetailedUsageSession, UsageStatsModel } from "@/features/config";
import { sessionStatusLabel, sessionStatusTone, type SessionStatus } from "@/features/sessions";

// ── the pure helpers (one spelling, shared with the dashboard screen) ───────

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
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("en-US");
}

/** "2026-09-01" → "Sep 1" — parsed calendar-LOCAL, never timezone-shifted. */
export function shortDate(date: string): string {
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
export function formatClock(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

/** ISO → "5m ago" / "3d ago" (host-card's shared timeAgo vocabulary). */
export function timeAgoFromIso(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : timeAgo(t);
}

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

/** The carousels' shared snap grammar: card width + this gutter = the snap interval. */
export const CAROUSEL_GUTTER = spacing.md;

// ── the stat carousel card ──────────────────────────────────────────────────

/**
 * One overview-carousel card — the old 2×2 hero tile's carousel grammar: the
 * toned icon chip (color rides on the chip, never the card), the BIG MONO
 * number, and ONE caption line that carries the honesty scope ("last 14
 * days" / "all time").
 */
export function StatCarouselCard({
  label,
  value,
  caption,
  icon: Icon,
  hue,
  width,
  testID,
}: {
  label: string;
  value: string;
  caption: string;
  icon: LucideIcon;
  hue: string;
  width: number;
  testID?: string;
}) {
  const { tokens } = useTheme();
  return (
    <ClayCard testID={testID} style={{ width, minHeight: 116 }}>
      <View style={styles.statPad}>
        <View style={styles.statHead}>
          <View
            style={[styles.statChip, { backgroundColor: mixHex(tokens.card, hue, 0.14) }]}
            accessibilityLabel={`${label} indicator`}
            accessibilityElementsHidden
          >
            <Icon size={15} color={hue} strokeWidth={2.2} />
          </View>
          <TypeMicro style={[styles.statLabel, { color: tokens.textTertiary }]} numberOfLines={1}>
            {label}
          </TypeMicro>
        </View>
        {/* The big mono number — TypeTitle's ladder step in the mono face. */}
        <TypeTitle numberOfLines={1} style={styles.statValue}>
          {value}
        </TypeTitle>
        <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
          {caption}
        </TypeMicro>
      </View>
    </ClayCard>
  );
}

// ── the GitHub-style activity grid ──────────────────────────────────────────

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
        {/* The sparkbar is decorative — the name + mono count carry the reading. */}
        <View
          style={[styles.toolTrack, { backgroundColor: tokens.borderSubtle }]}
          accessibilityElementsHidden
        >
          <View style={[styles.toolFill, { width: `${fraction}%`, backgroundColor: tokens.accent }]} />
        </View>
      </View>
    </View>
  );
}

// ── the models carousel card ────────────────────────────────────────────────

/**
 * One per-model card — the name-hash color dot (the PC contract) + the full
 * model name + the in/out token split on two lines + calls · cost + the
 * provider micro line. Windowed (the stats response's own window — the
 * screen labels that honestly).
 */
export function ModelCarouselCard({
  model,
  width,
  testID,
}: {
  model: UsageStatsModel;
  width: number;
  testID?: string;
}) {
  const { tokens } = useTheme();
  const hue = modelColor(model.model, tokens.isDark);
  const provider =
    model.providers.length > 1
      ? `${model.providers[0]} +${model.providers.length - 1}`
      : (model.providers[0] ?? "unknown provider");
  return (
    <ClayCard testID={testID} style={{ width, minHeight: 132 }}>
      <View style={styles.modelCardPad}>
        <View style={styles.modelCardHead}>
          <View style={[styles.modelDot, { backgroundColor: hue }]} accessibilityElementsHidden />
          <TypeMono numberOfLines={1} style={styles.modelCardName}>
            {model.model}
          </TypeMono>
        </View>
        <View style={styles.modelSplitRow}>
          <TypeMicro style={styles.modelSplitLabel}>in</TypeMicro>
          <TypeMono numberOfLines={1} style={styles.modelSplitValue}>
            {formatTokens(model.inputTokens)}
          </TypeMono>
        </View>
        <View style={styles.modelSplitRow}>
          <TypeMicro style={styles.modelSplitLabel}>out</TypeMicro>
          <TypeMono numberOfLines={1} style={styles.modelSplitValue}>
            {formatTokens(model.outputTokens)}
          </TypeMono>
        </View>
        <TypeMicro numberOfLines={1} style={[styles.modelCardMeta, { color: tokens.textTertiary }]}>
          {`${formatCount(model.calls)} calls · ${formatUsd(model.costUsd)}`}
        </TypeMicro>
        <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
          {provider}
        </TypeMicro>
      </View>
    </ClayCard>
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

const KNOWN_SESSION_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

/** The wire's status string → the honest owner label (unknowns pass raw). */
function sessionStatusWord(status: string): string {
  return KNOWN_SESSION_STATUSES.has(status) ? sessionStatusLabel(status as SessionStatus) : status;
}

function sessionBadgeTone(status: string): "success" | "warning" | "danger" | "neutral" {
  return KNOWN_SESSION_STATUSES.has(status) ? sessionStatusTone(status as SessionStatus) : "neutral";
}

/** The honest drill-down title: the session's own title, else a short id caption. */
function sessionRowTitle(session: DetailedUsageSession): string {
  const trimmed = session.title.trim();
  return trimmed !== "" ? trimmed : `Session ${session.id.slice(0, 12)}`;
}

/**
 * THE ACCORDION (R115-h's Yoga fix, copied from the projects screen):
 * height + opacity under the ONE house spring; the clip View carries
 * overflow:hidden ONLY (a static height would race the animated value AND
 * make Yoga clamp the relative auto-height child to 0 — onLayout reported 0
 * forever); the measurement child is ABSOLUTE so it lays out at its NATURAL
 * height at any clip height. Reduced motion snaps instead of springing.
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
    height.value = withSpring(open ? contentHeight.value : 0, SPRING);
    opacity.value = withSpring(open ? 1 : 0, SPRING);
  }, [open, reduced, height, opacity, contentHeight]);

  const style = useAnimatedStyle(() => ({
    height: Math.max(0, height.value),
    opacity: Math.max(0, opacity.value),
  }));

  const onLayout = (event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.height;
    if (measured <= 0) return;
    contentHeight.value = measured;
    // An OPEN panel whose content re-measured springs to the new height;
    // a CLOSED one just records it for the next toggle.
    if (open) {
      height.value = reduced ? measured : withSpring(measured, SPRING);
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

/** One session row inside the expansion: title + status badge, then the
 * model-dot · tokens · cost meta line (all one-line). */
function UsageSessionRow({ session }: { session: DetailedUsageSession }) {
  const { tokens } = useTheme();
  const sessionTokens = session.tokens.input + session.tokens.output;
  const title = sessionRowTitle(session);
  return (
    <View
      style={styles.sessionRow}
      accessibilityLabel={`Session ${title}, ${sessionStatusWord(session.status)}, ${formatTokens(sessionTokens)} tokens, ${formatUsd(session.costUsd)}`}
    >
      <View style={styles.sessionHead}>
        <TypeBodyStrong numberOfLines={1} style={styles.sessionTitle}>
          {title}
        </TypeBodyStrong>
        <Badge tone={sessionBadgeTone(session.status)}>{sessionStatusWord(session.status)}</Badge>
      </View>
      <View style={styles.sessionMeta}>
        {session.model !== null ? (
          <>
            <View
              style={[styles.sessionModelDot, { backgroundColor: modelColor(session.model, tokens.isDark) }]}
              accessibilityElementsHidden
            />
            <TypeMono numberOfLines={1} style={styles.sessionModel}>
              {session.model}
            </TypeMono>
            <TypeMicro numberOfLines={1} style={[styles.sessionMetaTail, { color: tokens.textTertiary }]}>
              {` · ${formatTokens(sessionTokens)} tokens · ${formatUsd(session.costUsd)}`}
            </TypeMicro>
          </>
        ) : (
          <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
            {`${formatTokens(sessionTokens)} tokens · ${formatUsd(session.costUsd)}`}
          </TypeMicro>
        )}
      </View>
    </View>
  );
}

/**
 * One project row — the LetterAvatar identity (never a bare colored dot,
 * donts #15), the name + sessions/tokens meta line, the all-time cost
 * trailing, and the chevron affordance. Tapping expands the inline sessions
 * well (top sessions newest-first, the server's own drill-down order).
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
    chevron.value = withSpring(expanded ? 1 : 0, SPRING);
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

      {/* ── the inline sessions expansion (the projects-screen grammar) ── */}
      <UsageAccordion open={expanded}>
        <View style={[styles.projectWell, { borderTopColor: tokens.borderSubtle }]}>
          {visible.length === 0 ? (
            // R116-n — the single-line law (donts #31), the dashboard's
            // QuietLine spelling: the well's honest empty clamps.
            <TypeCaption numberOfLines={1} style={{ color: tokens.textTertiary }}>
              no sessions recorded yet
            </TypeCaption>
          ) : (
            visible.map((session) => <UsageSessionRow key={session.id} session={session} />)
          )}
          {hidden > 0 ? (
            // R116-n — the clamp the projects screen's own "+N more sessions"
            // row carries (one spelling of the idiom across the two wells).
            <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
              +{hidden} more sessions
            </TypeMicro>
          ) : null}
          {project.subagents.count > 0 ? (
            <TypeMicro numberOfLines={1} style={{ color: tokens.textTertiary }}>
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
  // The stat carousel card.
  statPad: { padding: spacing.md, gap: spacing.xs },
  statHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  statChip: {
    width: 26,
    height: 26,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  statLabel: { textTransform: "uppercase", letterSpacing: 0.8, flexShrink: 1 },
  statValue: { fontFamily: fontFamily.monoMedium },
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
  // The models carousel card.
  modelCardPad: { padding: spacing.md, gap: 5 },
  modelCardHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 26 },
  modelCardName: { flex: 1 },
  modelSplitRow: { flexDirection: "row", alignItems: "baseline", gap: spacing.sm },
  modelSplitLabel: { width: 24, flexShrink: 0 },
  modelSplitValue: { flexShrink: 1 },
  modelCardMeta: { marginTop: spacing.xs },
  // The key stat row.
  keyRow: { gap: 3, minHeight: 44, justifyContent: "center" },
  keyHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  keyProvider: { flex: 1 },
  // The project row + the sessions well.
  projectInner: { flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.md },
  projectMain: { flex: 1, gap: 2 },
  projectCost: { flexShrink: 0, minWidth: 52, textAlign: "right" },
  projectWell: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  sessionRow: { gap: 3, minHeight: 40, justifyContent: "center", borderRadius: RADIUS_INPUT, paddingHorizontal: spacing.xs },
  sessionHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  sessionTitle: { flex: 1 },
  sessionMeta: { flexDirection: "row", alignItems: "center", gap: 5, paddingLeft: spacing.xs },
  sessionModelDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  sessionModel: { flexShrink: 1, fontSize: 11 },
  sessionMetaTail: { flexShrink: 1 },
  // The accordion (R115-h — overflow ONLY, no static height).
  accordionClip: { overflow: "hidden" },
  /** The ABSOLUTE measurement child — natural height at any clip height. */
  accordionMeasure: { position: "absolute", top: 0, left: 0, right: 0 },
  // The shared model dot (the name-hash color contract).
  modelDot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
});
