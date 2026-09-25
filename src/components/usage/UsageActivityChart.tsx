import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Zap } from "lucide-react";
import type { ThemeStyles } from "../../lib/themes";
import { ease } from "../../lib/motion";
import type { UsageDayBucket } from "../../lib/api";
import { Kicker } from "../ui/Kicker";
import { shortUtcDay, utcDateLabel, withAlpha } from "../dashboard/helpers";
import {
  CHART_BAR_GROW_MS,
  CHART_BAR_STAGGER_MS,
  CLAY_CARD,
  CLAY_TOOLTIP,
  hourBucketDay,
  hourBucketLabel,
  hourTickLabel,
  placeTooltipBeside,
  sparseTickIndices,
  STAGGER_CAP_S,
  stretchDayBarGeometry,
} from "./usage-helpers";
import { cn } from "../../lib/utils";

/**
 * ROUND-52 (R52-b): activity chart for the /usage screen — TokenBarChart's
 * rendering contract (ported, not imported, because the dashboard component
 * hardcodes its "· 14 days" header while this screen's range selector drives
 * the label). Bars are total tokens per UTC day; the hover tooltip breaks the
 * day into input/output/requests/cost.
 *
 * ROUND-126 (R126-3b, the Clay Companion redesign): the card rides the CLAY
 * material (rim + `.ac-clay`), the bars paint the two-tier accent's DEEP leg
 * (`--ac-accent-deep`) as the primary series (SCREENS §3), the hover tooltip
 * is the clay popover (`CLAY_TOOLTIP`), the loading bars pulse in the WELL
 * (`bg-well` — TOKENS §10 law 4), and the bar ENTRANCE is MOTION §2's chart
 * grammar: grow from the baseline, 350ms, 12ms per-bar stagger, once per
 * data load.
 *
 * ROUND-127 (R127-W2 — COMPONENTS §6's chart-interaction laws, binding):
 * · THE FULL-COLUMN HIT-TESTING LAW: the transparent `data-bar-idx` column
 *   (full plot height) is the ONE hit surface per bar; the PAINTED
 *   motion.rect bars render `pointer-events: none` (display-only) so the
 *   pointer over a bar's BODY resolves through the column underneath (the
 *   owner's "hover only works at the top area of the bar" complaint).
 * · THE TOOLTIP EDGE LAW (superseded R128 by the side-placement law below —
 *   the edge INSET survives inside placeTooltipBeside; the center-on-bar
 *   behavior and the x:"-50%" slot are retired).
 * · THE HOURLY VIEW (`granularity="hour"`, the 7-day window): hour buckets
 *   ("YYYY-MM-DDThh" from GET /usage/detailed?granularity=hour) step the bar
 *   geometry down (6px bars / 2px gaps — 168 buckets ≈ 1.34Kpx of natural
 *   width, readable inside the overflow-x scroller), the label band thins to
 *   SPARSE "HH:00" ticks (`sparseTickIndices`) with a DAY-BOUNDARY
 *   treatment — each bucket whose day differs from the previous bucket's
 *   carries the day label (day keys only) — and the tooltip header reads
 *   `hourBucketLabel`. Hour keys NEVER reach shortUtcDay/utcDateLabel (they
 *   template-append `T00:00:00Z` and yield Invalid Date — the R127-Rb
 *   research's trap list).
 *
 * ROUND-128 (R128-W2 — COMPONENTS §6's amended laws, binding):
 * · THE SIDE-PLACEMENT LAW (the R127 center-on-bar law is RETIRED — the
 *   owner's "it was showing the details exactly on the top, centered on
 *   it" complaint): the tooltip renders BESIDE the hovered column — right
 *   of a left-half column, left of a right-half column — via the shared
 *   `placeTooltipBeside` (ONE spelling for every chart). `left` IS the
 *   tooltip's left edge; the x:"-50%" centering slot is GONE (no transform
 *   translation on these tooltips anywhere).
 * · THE FILL LAW: a day view whose natural width (20px bars) fits the
 *   MEASURED scroller stretches its pitch to fill the card (the shared
 *   `stretchDayBarGeometry`, capped at 42px bars / 16px gaps) — a 7-day
 *   view never parks a 176px chart in a ~900px card. HOUR geometry stays
 *   FIXED (hour views always scroll); overflowing day windows keep the
 *   natural pitch + the newest-end law.
 * · THE NEWEST-END LAW, REINFORCED: the scroller lands at the newest end
 *   PRE-PAINT (`useLayoutEffect`, never the post-paint useEffect that
 *   flashes the oldest end for a frame), re-keyed by DATA IDENTITY — a
 *   same-length window swap (keepPreviousData refetch, the day rolling
 *   over) re-lands too — and re-asserted on resize.
 */

const DAY_BAR_WIDTH = 20;
const DAY_BAR_GAP = 6;
/** R127-W2 (the hour law): hour buckets step down to 6px bars + 2px gaps —
 * 168 buckets (the 7-day hourly window) ≈ 1.34Kpx of natural chart width,
 * readable bars inside the overflow-x scroller (vs. ~4.3Kpx at day geometry). */
const HOUR_BAR_WIDTH = 6;
const HOUR_BAR_GAP = 2;
const CHART_HEIGHT = 140;
const DAY_LABEL_AREA = 28;
/** The hour band's treatment stays ONE line ≤22px (the alternating spelling:
 * DAY-BOUNDARY buckets carry the day label, sparse hour ticks carry "HH:00" —
 * never two stacked lines in the band). */
const HOUR_LABEL_AREA = 22;
const DAY_BAR_RADIUS = 6;
const HOUR_BAR_RADIUS = 2;
/** The tooltip's rendered width — the `w-44` class (176px) on the tooltip
 * card below. */
const TOOLTIP_W = 176;
/** The sparse-tick law: the hour view's "HH:00" tick budget — ≤7 hour ticks
 * beside the day-boundary labels that ride their own indices. */
const HOUR_TICK_MAX = 7;

function dayTotal(d: UsageDayBucket): number {
  return d.inputTokens + d.outputTokens;
}

/** One rendered label of the hourly view's alternating band. */
interface HourTick {
  index: number;
  label: string;
  /** True at each bucket whose DAY differs from the previous bucket's — the
   * day label rides the boundary (and wins a collision with an hour tick). */
  dayBoundary: boolean;
}

/** One row of the hover tooltip. */
function TooltipRow({
  label,
  value,
  share,
  color,
  styles,
}: {
  label: string;
  value: string;
  share?: number;
  color?: string;
  styles: ThemeStyles;
}) {
  const { text, textSecondary } = styles;
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium" style={{ color: text }}>
          {label}
        </span>
        <span className="ml-2 text-[10px] font-semibold tabular-nums" style={{ color: color ?? textSecondary }}>
          {value}
        </span>
      </div>
      {share !== undefined ? (
        <div className="mt-0.5 h-[3px] overflow-hidden rounded-full bg-well">
          <div
            className="h-full rounded-full"
            style={{ width: `${Math.round(share * 100)}%`, backgroundColor: color }}
          />
        </div>
      ) : null}
    </div>
  );
}

export function UsageActivityChart({
  days,
  dayCount,
  granularity = "day",
  isPending,
  isError,
  delay = 0,
  styles,
}: {
  days: UsageDayBucket[];
  /** Label only — the range selector's window (bars render whatever `days` holds). */
  dayCount: number;
  /** R127-W2: the series granularity — "hour" renders the hourly view
   * (6px bars, sparse "HH:00" ticks + day-boundary labels, hour tooltip
   * headers). Default "day" keeps the historical daily geometry. */
  granularity?: "day" | "hour";
  isPending: boolean;
  isError: boolean;
  delay?: number;
  styles: ThemeStyles;
}) {
  const { text, textSecondary, textTertiary, accentDeep, isDark } = styles;
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const maxTokens = useMemo(() => Math.max(0, ...days.map(dayTotal)), [days]);
  const totalTokens = useMemo(() => days.reduce((s, d) => s + dayTotal(d), 0), [days]);

  // R128-W2 (the fill law): the scroller's MEASURED content width — 0 until
  // the useLayoutEffect below reads it (happy-dom reports 0/0 geometry, so
  // the unmeasured frame keeps the natural pitch; the ResizeObserver keeps
  // it fresh on real cards). The scroller sits inside the card's p-4/md:p-5
  // padding, so its own clientWidth IS the fill law's available width — no
  // extra padding math.
  const [scrollerWidth, setScrollerWidth] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // The scroller mounts only in the ready branch — the observer effect is
  // keyed on the ready flag so the pending→ready swap attaches it.
  const chartMounted = !isPending && !isError && days.length > 0;
  useLayoutEffect(() => {
    if (!chartMounted) return;
    const el = scrollRef.current;
    if (el === null) return;
    setScrollerWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setScrollerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [chartMounted]);

  // R128-W2 (the fill law): a fitting DAY view stretches its pitch to fill
  // the measured scroller (capped 42px bars / 16px gaps); HOUR geometry
  // stays FIXED — 168 buckets always overflow and ride the newest-end law.
  const { barWidth, barGap, barRadius, labelArea } =
    granularity === "hour"
      ? {
          barWidth: HOUR_BAR_WIDTH,
          barGap: HOUR_BAR_GAP,
          barRadius: HOUR_BAR_RADIUS,
          labelArea: HOUR_LABEL_AREA,
        }
      : {
          ...stretchDayBarGeometry(days.length, DAY_BAR_WIDTH, DAY_BAR_GAP, scrollerWidth),
          barRadius: DAY_BAR_RADIUS,
          labelArea: DAY_LABEL_AREA,
        };

  const chartWidth = days.length * (barWidth + barGap) - barGap;

  // R127-W2 (the sparse-tick + hour laws): the hourly view's label band —
  // ≤7 sparse "HH:00" ticks OVERLAID by the day-boundary labels (each bucket
  // whose day differs from the previous bucket's carries the DAY label; a
  // boundary wins a collision with an hour tick). The day label reads
  // utcDateLabel on the 10-char DAY key only — an hour key would
  // template-append `T00:00:00Z` and yield Invalid Date.
  const hourTicks = useMemo<HourTick[]>(() => {
    if (granularity !== "hour") return [];
    const out = new Map<number, HourTick>();
    for (const i of sparseTickIndices(days.length, HOUR_TICK_MAX)) {
      const bucket = days[i];
      if (bucket === undefined) continue;
      out.set(i, { index: i, label: hourTickLabel(bucket.date), dayBoundary: false });
    }
    for (let i = 0; i < days.length; i++) {
      const bucket = days[i];
      const prev = i > 0 ? days[i - 1] : undefined;
      if (bucket === undefined) continue;
      const boundary =
        prev === undefined || hourBucketDay(bucket.date) !== hourBucketDay(prev.date);
      if (boundary) {
        out.set(i, {
          index: i,
          label: utcDateLabel(hourBucketDay(bucket.date)),
          dayBoundary: true,
        });
      }
    }
    return [...out.values()].sort((a, b) => a.index - b.index);
  }, [days, granularity]);

  // R128-W2 (the side-placement law): the hovered bar's tooltip position —
  // BESIDE the hovered column (right of a left-half column, left of a
  // right-half one), clamped inside the chart's content box by the shared
  // placeTooltipBeside (ONE spelling for every chart). Null while no bar is
  // hovered. The retired R127 center-on-bar spelling (the x:"-50%" slot) is
  // GONE — `left` is always the tooltip's own left edge.
  const tooltipX =
    hoveredIdx !== null && days[hoveredIdx] !== undefined
      ? placeTooltipBeside(
          hoveredIdx * (barWidth + barGap),
          barWidth,
          chartWidth,
          TOOLTIP_W,
        )
      : null;

  // R128-W2 (the newest-end law, REINFORCED): the overflow-x scroller lands
  // at the newest end PRE-PAINT (useLayoutEffect — never the post-paint
  // useEffect that flashes the oldest end for a frame), re-keyed by DATA
  // IDENTITY: a same-length window swap (the keepPreviousData refetch when
  // the day rolls over) changes the first/last bucket keys and re-lands too.
  // The measured scrollerWidth is a dep so a resize re-asserts the newest
  // end while the chart overflows (`scrollLeft = scrollWidth` clamps to 0
  // when the content fits — the day view's centered/stretched fit is
  // untouched). data-scrolled-to-latest is the effect's observable contract
  // (happy-dom's scroll geometry is 0/0, so the pin reads the hook).
  const firstKey = days[0]?.date ?? "";
  const lastKey = days[days.length - 1]?.date ?? "";
  const dataKey = `${granularity}:${days.length}:${firstKey}:${lastKey}`;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollLeft = el.scrollWidth;
    el.dataset.scrolledToLatest = "true";
  }, [dataKey, scrollerWidth]);

  return (
    <div className={cn(CLAY_CARD, "p-4 md:p-5")}>
      <div className="mb-4 flex items-center justify-between">
        <Kicker icon={Zap} className="tabular-nums">
          Token Activity · {dayCount} {dayCount === 1 ? "day" : "days"}
          {granularity === "hour" ? " · hourly" : ""}
        </Kicker>
        <span className="text-[11px] font-medium leading-none tabular-nums" style={{ color: textSecondary }}>
          {isPending ? "…" : `${totalTokens.toLocaleString()} total`}
        </span>
      </div>

      {isPending ? (
        // R126-3b (TOKENS §10 law 4): the loading bars pulse in the WELL.
        <div
          aria-label="Loading usage chart"
          className="flex h-[168px] items-end justify-center gap-2"
        >
          {[0.45, 0.75, 0.55, 0.9, 0.65].map((h, i) => (
            <div
              key={i}
              className="w-5 animate-pulse rounded-t-md bg-well"
              style={{ height: `${h * 100}%` }}
            />
          ))}
        </div>
      ) : isError || days.length === 0 ? (
        <div className="flex h-[168px] flex-col items-center justify-center gap-1 text-center">
          <p className="text-[12px] font-semibold" style={{ color: text }}>
            {isError ? "Usage data unavailable" : "No usage recorded yet"}
          </p>
        </div>
      ) : (
        // The bar grid keeps its natural pitch when it overflows (hour views,
        // 30/90-day windows, narrow phones — they scroll INSIDE the card and
        // mount at the newest end); a FITTING day view stretches to the
        // measured scroller width (the R128 fill law above). w-fit + mx-auto
        // centers whatever still doesn't fill.
        <div ref={scrollRef} className="custom-scrollbar overflow-x-auto">
          <div
            className="relative mx-auto w-fit"
            onPointerMove={(e) => {
              // R121-d: the ONE pointer read (the R5 law — hover is a pointer
              // read, never a per-bar hover pair).
              const hit = (e.target as Element).closest("[data-bar-idx]");
              setHoveredIdx(hit !== null ? Number(hit.getAttribute("data-bar-idx")) : null);
            }}
            onPointerLeave={() => setHoveredIdx(null)}
          >
            <svg
              width={chartWidth}
              height={CHART_HEIGHT + labelArea}
              viewBox={`0 0 ${chartWidth} ${CHART_HEIGHT + labelArea}`}
              role="img"
              aria-label={
                granularity === "hour"
                  ? `Token usage per hour, ${totalTokens.toLocaleString()} tokens over ${days.length} hours`
                  : `Token usage per day, ${totalTokens.toLocaleString()} tokens over ${days.length} days`
              }
            >
              <defs>
                {/* Hides the bottom rounded corners of bars, like the demo. */}
                <clipPath id="usage-screen-bar-clip">
                  <rect x={0} y={-barRadius} width={chartWidth} height={CHART_HEIGHT + barRadius} />
                </clipPath>
              </defs>

              {[0.25, 0.5, 0.75, 1].map((pct) => (
                <line
                  key={pct}
                  x1={0}
                  y1={CHART_HEIGHT - CHART_HEIGHT * pct}
                  x2={chartWidth}
                  y2={CHART_HEIGHT - CHART_HEIGHT * pct}
                  stroke={withAlpha(text, isDark ? 0.05 : 0.04)}
                  strokeWidth={1}
                  strokeDasharray="3 5"
                />
              ))}
              <line
                x1={0}
                y1={CHART_HEIGHT}
                x2={chartWidth}
                y2={CHART_HEIGHT}
                stroke={withAlpha(text, isDark ? 0.09 : 0.07)}
                strokeWidth={1}
              />

              <g clipPath="url(#usage-screen-bar-clip)">
                {days.map((day, i) => {
                  const barH =
                    maxTokens > 0 ? Math.max((dayTotal(day) / maxTokens) * CHART_HEIGHT, 4) : 4;
                  const x = i * (barWidth + barGap);
                  const y = CHART_HEIGHT - barH;
                  const isLast = i === days.length - 1;
                  const isHovered = hoveredIdx === i;
                  // R126-3b: the primary series is the deep accent tier
                  // (SCREENS §3); hover + the live tail hold it at full
                  // strength, the rest rides the tinted leg.
                  const fill =
                    isHovered || isLast ? accentDeep : withAlpha(accentDeep, isDark ? 0.36 : 0.27);
                  return (
                    <g key={day.date}>
                      <rect
                        x={x}
                        y={0}
                        width={barWidth}
                        height={CHART_HEIGHT}
                        fill="transparent"
                        style={{ cursor: "pointer" }}
                        data-bar-idx={i}
                      />
                      <motion.rect
                        x={x}
                        width={barWidth}
                        rx={barRadius}
                        ry={barRadius}
                        // R127-W2 (the full-column law): the painted bar is
                        // DISPLAY-ONLY — pointer-events:none lets the pointer
                        // resolve through the transparent data-bar-idx column
                        // underneath (hovering the bar BODY works, not just
                        // the air above it). It carries NO data-bar-idx itself.
                        style={{ fill, pointerEvents: "none" }}
                        // R126-3b (MOTION §2): grow from the baseline —
                        // 350ms, 12ms stagger, once per data load.
                        initial={{ y: CHART_HEIGHT, height: 0 }}
                        animate={{ y, height: barH }}
                        transition={{
                          duration: CHART_BAR_GROW_MS,
                          ease,
                          // R127-W2/R128-W2: the stagger is CAPPED — 168 hour
                          // buckets × 12ms would stack ~2s onto the tail; the
                          // last bars wait at most STAGGER_CAP_S (the shared
                          // R128 constant — every chart caps, not just this one).
                          delay: delay + Math.min(i * CHART_BAR_STAGGER_MS, STAGGER_CAP_S),
                        }}
                      />
                    </g>
                  );
                })}
              </g>

              {granularity === "hour"
                ? // R127-W2 (the hour law): the alternating band — day labels
                  // at the day boundaries, sparse "HH:00" ticks between them
                  // (day keys only through utcDateLabel; hour keys only
                  // through hourTickLabel — never the crossed pair).
                  hourTicks.map(({ index, label, dayBoundary }) => {
                    const cx = index * (barWidth + barGap) + barWidth / 2;
                    const isLast = index === days.length - 1;
                    const isHovered = hoveredIdx === index;
                    return (
                      <text
                        key={`${days[index]?.date ?? index}-label`}
                        x={cx}
                        y={CHART_HEIGHT + 15}
                        textAnchor="middle"
                        fill={isHovered || isLast ? accentDeep : dayBoundary ? textSecondary : textTertiary}
                        fontSize={10}
                        fontWeight={isHovered || isLast || dayBoundary ? 600 : 500}
                        className="tabular-nums"
                      >
                        {label}
                      </text>
                    );
                  })
                : days.map((day, i) => {
                    const cx = i * (barWidth + barGap) + barWidth / 2;
                    const isLast = i === days.length - 1;
                    const isHovered = hoveredIdx === i;
                    return (
                      <text
                        key={`${day.date}-label`}
                        x={cx}
                        y={CHART_HEIGHT + 18}
                        textAnchor="middle"
                        fill={isHovered || isLast ? accentDeep : textSecondary}
                        fontSize={10}
                        fontWeight={isHovered || isLast ? 600 : 500}
                        className="tabular-nums"
                      >
                        {shortUtcDay(day.date)}
                      </text>
                    );
                  })}
            </svg>

            <AnimatePresence>
              {hoveredIdx !== null && days[hoveredIdx] && tooltipX !== null ? (
                <motion.div
                  key="tooltip"
                  initial={{ opacity: 0, y: 4, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 4, scale: 0.96 }}
                  transition={{ duration: 0.15 }}
                  className="pointer-events-none absolute top-0 z-50"
                  // R128-W2 (the side-placement law): `left` IS the tooltip's
                  // left edge, BESIDE the hovered column (placeTooltipBeside —
                  // right of a left-half column, left of a right-half one).
                  // NO x:"-50%" slot, ever — the retired R127 center-on-bar
                  // transform is gone; the animated y/scale are the only
                  // transform writes (framer owns those slots).
                  style={{ left: tooltipX.left }}
                >
                  {/* R126-3b: the tooltip surface is the clay popover —
                      card fill + rim + the small-surface clay shadow. */}
                  <div className={cn(CLAY_TOOLTIP, "w-44 space-y-2 p-3")}>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold" style={{ color: text }}>
                        {/* R127-W2 (the hour law): the tooltip header reads
                            hourBucketLabel on hour keys — NEVER utcDateLabel
                            (the Invalid-Date trap). */}
                        {granularity === "hour"
                          ? hourBucketLabel(days[hoveredIdx].date)
                          : utcDateLabel(days[hoveredIdx].date)}
                      </span>
                      <span className="text-[11px] font-semibold tabular-nums" style={{ color: accentDeep }}>
                        {dayTotal(days[hoveredIdx]).toLocaleString()}
                      </span>
                    </div>
                    <TooltipRow
                      label="Input"
                      value={days[hoveredIdx].inputTokens.toLocaleString()}
                      share={
                        dayTotal(days[hoveredIdx]) > 0
                          ? days[hoveredIdx].inputTokens / dayTotal(days[hoveredIdx])
                          : 0
                      }
                      color={accentDeep}
                      styles={styles}
                    />
                    <TooltipRow
                      label="Output"
                      value={days[hoveredIdx].outputTokens.toLocaleString()}
                      share={
                        dayTotal(days[hoveredIdx]) > 0
                          ? days[hoveredIdx].outputTokens / dayTotal(days[hoveredIdx])
                          : 0
                      }
                      color={withAlpha(text, 0.45)}
                      styles={styles}
                    />
                    <div
                      className="flex items-center justify-between pt-1"
                      style={{ borderTop: `1px solid ${styles.clayRim}` }}
                    >
                      <span className="text-[10px] tabular-nums" style={{ color: textSecondary }}>
                        {days[hoveredIdx].requests} requests
                      </span>
                      <span className="text-[10px] font-semibold tabular-nums" style={{ color: textSecondary }}>
                        ${days[hoveredIdx].costUsd.toFixed(2)}
                      </span>
                    </div>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </div>
      )}
    </div>
  );
}
