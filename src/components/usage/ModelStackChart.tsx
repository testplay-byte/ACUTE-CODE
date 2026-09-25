import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Layers } from "lucide-react";
import type { ThemeStyles } from "../../lib/themes";
import type { UsageStatsDayBucket, UsageStatsModel } from "../../lib/api";
import { ease } from "../../lib/motion";
import { Kicker } from "../ui/Kicker";
import { utcDateLabel, withAlpha } from "../dashboard/helpers";
import {
  formatCompactTokens,
  modelColor,
  CHART_BAR_GROW_MS,
  CHART_BAR_STAGGER_MS,
  CLAY_CARD,
  CLAY_TOOLTIP,
  placeTooltipBeside,
  sparseTickIndices,
  STAGGER_CAP_S,
} from "./usage-helpers";
import { RangeSelector } from "./RangeSelector";
import { cn } from "../../lib/utils";

/**
 * ROUND-98 (R98-I2, owner: "time-range graphs color-coded by model name —
 * the same name across providers IS one model"): the daily stacked bar
 * chart BY MODEL NAME. One bar per UTC day; one segment per model, painted
 * modelColor(name) in the models array's tokens-desc order (server-sorted,
 * so the stacking order is STABLE across refetches); the range picker
 * (7/30/90/365) slices the series tail. Hand-rolled SVG like
 * UsageActivityChart (no chart package — the no-new-deps rule).
 *
 * This is the MODEL view of the same days the UsageActivityChart draws as
 * the INPUT/OUTPUT view — both stay on the usage screen by design (the
 * owner asked for the model-color graph; the input/output split answers a
 * different question).
 *
 * R99-E (anti-jitter kit): the card reserves its final height
 * (min-h-[264px]/md:272px — header row + the fixed 150px bars + the 22px
 * x-axis band, so a 7/30/90/365 switch only relabels, never reflows); the
 * header never wraps (the label truncates, the picker is shrink-0) so the
 * height is width-independent; every number — axis labels, tooltip rows,
 * the range buttons — renders tabular-nums.
 *
 * R126-3b (the Clay Companion redesign): the card rides the CLAY material
 * (rim + `.ac-clay`), the hover tooltip is the clay popover
 * (`CLAY_TOOLTIP`), and the range picker is the SEGMENTED-CONTROL grammar
 * (the shared RangeSelector — bg-well track + the gliding bg-accent-deep
 * knob on TAB_SPRING). The STABLE per-model palette is untouched. The
 * stacked bars grow from the BASELINE on entry (MOTION §2's chart-entry
 * law — 350ms, 12ms per-bar stagger, once per data load: new days mount
 * fresh and grow in, existing keys hold their settled pose).
 *
 * ROUND-127 (R127-W2 — COMPONENTS §6's chart-interaction laws, binding):
 * · THE FULL-COLUMN HIT-TESTING LAW: the transparent `data-bar-idx` column
 *   (full plot height) is the ONE hit surface per bar; the PAINTED stacked
 *   motion.rect segments render `pointer-events: none` (display-only) so the
 *   pointer over a colored segment's BODY resolves through the column
 *   underneath (the owner's "hover only works at the top area of the bar"
 *   complaint, named on this chart).
 * · THE TOOLTIP EDGE LAW (superseded R128 by the side-placement law below —
 *   the edge INSET survives inside placeTooltipBeside; the center-on-bar
 *   behavior and the x:"-50%" slot are retired).
 * · The x-axis ticks read the shared `sparseTickIndices` (ONE spelling of
 *   the 4-tick idiom this chart invented — the ⅓ tick now rounds instead
 *   of flooring, a ±1-bucket shift at some window sizes).
 *
 * ROUND-128 (R128-W2 — COMPONENTS §6's amended laws, binding):
 * · THE SIDE-PLACEMENT LAW: the tooltip renders BESIDE the hovered column
 *   via the shared placeTooltipBeside, in the svg's Y_AXIS-offset
 *   coordinate space; `left` IS the tooltip's left edge, NO x:"-50%" slot.
 * · THE FILL LAW (the width-based leg): when the natural count-based
 *   geometry fits the MEASURED scroller, the geometry bumps to the widest
 *   tier that still fits (barGeometry's ladder, largest-first) — a 30-day
 *   window in a wide card renders 24px bars, not 14px bars parked left of
 *   dead margins. Overflowing windows keep the natural tier + scroll.
 * · THE NEWEST-END LAW, REINFORCED: useLayoutEffect (pre-paint), re-keyed
 *   by DATA IDENTITY — range, the visible window's first/last dates, AND
 *   the full series' length/first/last dates so a months-window swap
 *   (the panel's 6/12/24 picker re-fetches a longer series while `range`
 *   and the visible tail stay identical) re-lands too — plus the measured
 *   scroller width (resize re-asserts while overflowing).
 * · THE STAGGER CAP: the entrance delay is min(i × 12ms, 0.4s) like every
 *   other chart — 365 bars × 12ms = 4.38s reads as "starts from the oldest
 *   month" (the owner's complaint). data-entry-delay on the painted
 *   segments is the cap's observable test hook (framer carries the delay
 *   internally; happy-dom cannot spy the transition prop).
 */

const RANGE_OPTIONS = [7, 30, 90, 365] as const;
const CHART_HEIGHT = 150;
const LABEL_AREA = 22;
const Y_AXIS = 36;
const BAR_RADIUS = 3;
/** The tooltip's rendered width — the `w-52` class (208px) on the tooltip
 * card below. */
const TOOLTIP_W = 208;

/** R128-W2 (the fill law): the bar-geometry LADDER, widest tier first —
 * barGeometry(count) picks the count-based tier below; the fill leg bumps
 * to the widest tier whose natural width still fits the measured scroller. */
const BAR_GEOMETRY_TIERS = [
  { width: 24, gap: 8 },
  { width: 14, gap: 5 },
  { width: 7, gap: 2 },
  { width: 3, gap: 1 },
] as const;

function dayTotal(day: UsageStatsDayBucket): number {
  let sum = 0;
  for (const value of Object.values(day.byModel)) sum += value;
  return sum;
}

/** Bar width + gap step down as the window widens (the natural-width grid
 * scrolls horizontally inside the card on narrow screens). R128-W2: the
 * values read from the shared tier ladder (ONE spelling of the geometry). */
function barGeometry(count: number): { width: number; gap: number } {
  if (count <= 7) return BAR_GEOMETRY_TIERS[0];
  if (count <= 30) return BAR_GEOMETRY_TIERS[1];
  if (count <= 90) return BAR_GEOMETRY_TIERS[2];
  return BAR_GEOMETRY_TIERS[3];
}

export function ModelStackChart({
  days,
  models,
  styles,
}: {
  days: UsageStatsDayBucket[];
  models: UsageStatsModel[];
  styles: ThemeStyles;
}) {
  const { text, textSecondary, textTertiary, accentDeep, isDark } = styles;
  const [range, setRange] = useState<(typeof RANGE_OPTIONS)[number]>(30);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // The visible window is the series TAIL (most recent days first-class).
  const visible = useMemo(() => {
    if (days.length <= range) return days;
    return days.slice(days.length - range);
  }, [days, range]);

  const modelOrder = useMemo(
    () => models.map((m) => ({ name: m.model, color: modelColor(m.model, isDark) })),
    [models, isDark],
  );

  const maxTokens = useMemo(() => Math.max(0, ...visible.map(dayTotal)), [visible]);
  const totalTokens = useMemo(() => visible.reduce((sum, d) => sum + dayTotal(d), 0), [visible]);

  // R128-W2 (the fill law): the scroller's MEASURED content width — 0 until
  // the useLayoutEffect below reads it (happy-dom reports 0/0 geometry, so
  // the unmeasured frame keeps the natural tier; the ResizeObserver keeps
  // it fresh on real cards). The scroller sits inside the card's padding,
  // so its own clientWidth IS the fill law's available width.
  const [scrollerWidth, setScrollerWidth] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // The scroller mounts only in the ready branch — the observer effect is
  // keyed on the ready flag so the empty→ready swap attaches it.
  const chartMounted = visible.length > 0;
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

  // R128-W2 (the fill law, the width-based leg): start from the count-based
  // tier; when the natural chart fits the measured scroller with dead space,
  // bump to the widest tier whose natural width still fits (the ladder,
  // largest-first — "next-larger if it still fits", iterated). An
  // overflowing window keeps its natural tier (scroll + newest-end law); an
  // unmeasured one (0) keeps it too.
  const natural = barGeometry(visible.length);
  const naturalWidth = visible.length * (natural.width + natural.gap) - natural.gap;
  let barWidth = natural.width;
  let barGap = natural.gap;
  if (scrollerWidth > 0 && Y_AXIS + naturalWidth < scrollerWidth) {
    for (const tier of BAR_GEOMETRY_TIERS) {
      const tierWidth = visible.length * (tier.width + tier.gap) - tier.gap;
      if (Y_AXIS + tierWidth <= scrollerWidth) {
        barWidth = tier.width;
        barGap = tier.gap;
        break;
      }
    }
  }
  const chartWidth = visible.length * (barWidth + barGap) - barGap;
  const hovered = hoveredIdx !== null ? visible[hoveredIdx] : undefined;

  // R128-W2 (the side-placement law): the hovered bar's tooltip position —
  // BESIDE the hovered column (right of a left-half column, left of a
  // right-half one), in the svg's Y_AXIS-offset coordinate space (the plot
  // spans Y_AXIS..Y_AXIS+chartWidth; the tooltip's coordinate space is the
  // svg's, exactly as the R127 edge law's was). `left` IS the tooltip's own
  // left edge — NO x:"-50%" slot, ever.
  const tooltipX =
    hoveredIdx !== null && hovered !== undefined
      ? placeTooltipBeside(
          Y_AXIS + hoveredIdx * (barWidth + barGap),
          barWidth,
          Y_AXIS + chartWidth,
          TOOLTIP_W,
        )
      : null;

  // R128-W2 (the newest-end law, REINFORCED): the overflow-x scroller lands
  // at the newest end PRE-PAINT (useLayoutEffect — never the post-paint
  // useEffect that flashes the oldest end for a frame), re-keyed by DATA
  // IDENTITY: range + the visible window's first/last dates AND the FULL
  // series' length/first/last dates — the DataStatsPanel months picker
  // (6/12/24) re-fetches a longer series while `range` and the visible tail
  // can stay byte-identical, and that swap must re-land too. The measured
  // scrollerWidth is a dep so a resize re-asserts while overflowing
  // (`scrollLeft = scrollWidth` clamps to 0 when the content fits — the
  // 7/30-day centered fits are untouched). data-scrolled-to-latest is the
  // effect's observable contract (happy-dom's scroll geometry is 0/0, so
  // the pin reads the hook).
  const visibleFirst = visible[0]?.date ?? "";
  const visibleLast = visible[visible.length - 1]?.date ?? "";
  const daysFirst = days[0]?.date ?? "";
  const daysLast = days[days.length - 1]?.date ?? "";
  const dataKey = `${range}:${visible.length}:${visibleFirst}:${visibleLast}:${days.length}:${daysFirst}:${daysLast}`;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollLeft = el.scrollWidth;
    el.dataset.scrolledToLatest = "true";
  }, [dataKey, scrollerWidth]);

  return (
    <div
      data-testid="model-stack-chart"
      className={cn(CLAY_CARD, "flex min-h-[264px] flex-col p-4 md:min-h-[272px] md:p-5")}
    >
      <div className="mb-4 flex shrink-0 items-center justify-between gap-2">
        <Kicker icon={Layers} className="truncate tabular-nums">
          Model Mix · {visible.length} {visible.length === 1 ? "day" : "days"}
        </Kicker>
        {/* R126-3b: the range picker is the shared SEGMENTED-CONTROL grammar. */}
        <RangeSelector
          options={RANGE_OPTIONS}
          selected={range}
          onChange={(value) => {
            setRange(value as (typeof RANGE_OPTIONS)[number]);
            setHoveredIdx(null);
          }}
          groupLabel="Model mix day range"
          optionAriaLabel={(option) => `Last ${option} days`}
        />
      </div>

      {visible.length === 0 ? (
        <div className="flex h-[172px] flex-col items-center justify-center gap-1 text-center">
          <p className="text-[12px] font-semibold" style={{ color: text }}>
            No usage recorded yet
          </p>
        </div>
      ) : (
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
              width={Y_AXIS + chartWidth}
              height={CHART_HEIGHT + LABEL_AREA}
              viewBox={`0 0 ${Y_AXIS + chartWidth} ${CHART_HEIGHT + LABEL_AREA}`}
              role="img"
              aria-label={`Tokens per day stacked by model, ${totalTokens.toLocaleString()} tokens over ${visible.length} days`}
            >
              {[1, 0.5].map((pct) => (
                <g key={pct}>
                  <line
                    x1={Y_AXIS}
                    y1={CHART_HEIGHT - CHART_HEIGHT * pct}
                    x2={Y_AXIS + chartWidth}
                    y2={CHART_HEIGHT - CHART_HEIGHT * pct}
                    stroke={withAlpha(text, isDark ? 0.05 : 0.04)}
                    strokeWidth={1}
                    strokeDasharray="3 5"
                  />
                  <text
                    x={Y_AXIS - 6}
                    y={CHART_HEIGHT - CHART_HEIGHT * pct + 3}
                    textAnchor="end"
                    fill={textTertiary}
                    fontSize={10}
                    fontWeight={500}
                    className="tabular-nums"
                  >
                    {formatCompactTokens(Math.round(maxTokens * pct))}
                  </text>
                </g>
              ))}
              <line
                x1={Y_AXIS}
                y1={CHART_HEIGHT}
                x2={Y_AXIS + chartWidth}
                y2={CHART_HEIGHT}
                stroke={withAlpha(text, isDark ? 0.09 : 0.07)}
                strokeWidth={1}
              />

              <g>
                {visible.map((day, i) => {
                  const x = Y_AXIS + i * (barWidth + barGap);
                  const isHovered = hoveredIdx === i;
                  let yCursor = CHART_HEIGHT;
                  const segments = modelOrder.map(({ name, color }) => {
                    const tokens = day.byModel[name] ?? 0;
                    const height =
                      maxTokens > 0 && tokens > 0
                        ? Math.max((tokens / maxTokens) * CHART_HEIGHT, tokens > 0 ? 1 : 0)
                        : 0;
                    yCursor -= height;
                    return { name, color, tokens, y: yCursor, height };
                  });
                  // R128-W2 (the stagger cap): the entrance delay is CAPPED —
                  // 365 bars × 12ms = 4.38s of old→new sweep reads as "starts
                  // from the oldest month" (the owner's complaint). The shared
                  // STAGGER_CAP_S (0.4s) mirrors UsageActivityChart's R127 cap.
                  // data-entry-delay is the cap's observable test hook (framer
                  // carries the delay internally; happy-dom cannot spy the
                  // transition prop — the R127-W2 caveat's sanctioned seam).
                  const entryDelay = Math.min(i * CHART_BAR_STAGGER_MS, STAGGER_CAP_S);
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
                      {segments.map(
                        (seg) =>
                          seg.height > 0 && (
                            <motion.rect
                              key={seg.name}
                              x={x}
                              width={barWidth}
                              rx={BAR_RADIUS}
                              fill={seg.color}
                              opacity={hoveredIdx === null || isHovered ? 1 : 0.35}
                              data-stack-model={seg.name}
                              data-entry-delay={entryDelay.toFixed(3)}
                              // R127-W2 (the full-column law): the painted
                              // segment is DISPLAY-ONLY — pointer-events:none
                              // lets the pointer resolve through the
                              // transparent data-bar-idx column underneath
                              // (hovering a colored segment's BODY works, not
                              // just the air above the stack).
                              style={{ pointerEvents: "none" }}
                              // R126-3b (MOTION §2): grow from the baseline —
                              // 350ms, 12ms stagger (capped above), once per
                              // data load.
                              initial={{ y: CHART_HEIGHT, height: 0 }}
                              animate={{ y: seg.y, height: seg.height }}
                              transition={{
                                duration: CHART_BAR_GROW_MS,
                                ease,
                                delay: entryDelay,
                              }}
                            />
                          ),
                      )}
                    </g>
                  );
                })}
              </g>

              {/* R127-W2: the sparse 4-tick idiom reads the shared
                  sparseTickIndices (ONE spelling — the ⅓ tick now ROUNDS
                  instead of flooring; a ±1-bucket shift at some window
                  sizes, the same first/⅓/⅔/last spread). */}
              {visible.length > 1 &&
                sparseTickIndices(visible.length, 4).map((tick, i) => {
                    const day = visible[tick];
                    if (day === undefined) return null;
                    const cx = Y_AXIS + tick * (barWidth + barGap) + barWidth / 2;
                    return (
                      <text
                        key={`${day.date}-${i}`}
                        x={cx}
                        y={CHART_HEIGHT + 15}
                        textAnchor="middle"
                        fill={textTertiary}
                        fontSize={10}
                        fontWeight={500}
                        className="tabular-nums"
                      >
                        {utcDateLabel(day.date)}
                      </text>
                    );
                  })}
            </svg>

            <AnimatePresence>
              {hovered && tooltipX !== null ? (
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
                  {/* R126-3b: the tooltip surface is the clay popover. */}
                  <div className={cn(CLAY_TOOLTIP, "w-52 space-y-1.5 p-3")}>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold" style={{ color: text }}>
                        {utcDateLabel(hovered.date)}
                      </span>
                      <span className="text-[11px] font-semibold tabular-nums" style={{ color: accentDeep }}>
                        {dayTotal(hovered).toLocaleString()}
                      </span>
                    </div>
                    {modelOrder.map(({ name, color }) => {
                      const tokens = hovered.byModel[name] ?? 0;
                      if (tokens === 0) return null;
                      return (
                        <div key={name} className="flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span
                              aria-hidden
                              className="h-[7px] w-[7px] shrink-0 rounded-full"
                              style={{ backgroundColor: color }}
                            />
                            <span className="truncate font-mono text-[10px]" style={{ color: textSecondary }}>
                              {name}
                            </span>
                          </span>
                          <span className="shrink-0 font-mono text-[10px] font-semibold tabular-nums" style={{ color }}>
                            {tokens.toLocaleString()}
                          </span>
                        </div>
                      );
                    })}
                    <div
                      className="flex items-center justify-between pt-1"
                      style={{ borderTop: `1px solid ${styles.clayRim}` }}
                    >
                      <span className="text-[10px] tabular-nums" style={{ color: textSecondary }}>
                        {Object.keys(hovered.byModel).length} model
                        {Object.keys(hovered.byModel).length === 1 ? "" : "s"}
                      </span>
                      <span className="text-[10px] font-semibold tabular-nums" style={{ color: textSecondary }}>
                        {formatCompactTokens(dayTotal(hovered))} total
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
