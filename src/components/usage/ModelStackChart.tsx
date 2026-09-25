import { useEffect, useMemo, useRef, useState } from "react";
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
  clampTooltipX,
  sparseTickIndices,
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
 * · THE TOOLTIP EDGE LAW: the tooltip centers on its bar only while it
 *   fits; near the first/last bars `clampTooltipX` (the shared helper — ONE
 *   spelling) clamps it inside the chart's content box (the owner's
 *   "hover the very right side entry… the details show where there is no
 *   place to view them" complaint, named on this chart). The -50%
 *   centering rides framer's own `x` slot (a raw style.transform would be
 *   clobbered by the animated y/scale — the pre-R126 lesson, kept).
 * · The x-axis ticks read the shared `sparseTickIndices` (ONE spelling of
 *   the 4-tick idiom this chart invented — the ⅓ tick now rounds instead
 *   of flooring, a ±1-bucket shift at some window sizes).
 * · THE NEWEST-END LAW: the overflow-x scroller MOUNTS at the newest end
 *   and re-lands there on every range swap (the owner's "same goes for the
 *   other areas" report — the 90/365-day windows open on the latest week).
 */

const RANGE_OPTIONS = [7, 30, 90, 365] as const;
const CHART_HEIGHT = 150;
const LABEL_AREA = 22;
const Y_AXIS = 36;
const BAR_RADIUS = 3;
/** R127-W2 (the edge law): the tooltip's rendered width — the `w-52` class
 * (208px) on the tooltip card below. */
const TOOLTIP_W = 208;

function dayTotal(day: UsageStatsDayBucket): number {
  let sum = 0;
  for (const value of Object.values(day.byModel)) sum += value;
  return sum;
}

/** Bar width + gap step down as the window widens (the natural-width grid
 * scrolls horizontally inside the card on narrow screens). */
function barGeometry(count: number): { width: number; gap: number } {
  if (count <= 7) return { width: 24, gap: 8 };
  if (count <= 30) return { width: 14, gap: 5 };
  if (count <= 90) return { width: 7, gap: 2 };
  return { width: 3, gap: 1 };
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

  const { width: barWidth, gap: barGap } = barGeometry(visible.length);
  const chartWidth = visible.length * (barWidth + barGap) - barGap;
  const hovered = hoveredIdx !== null ? visible[hoveredIdx] : undefined;

  // R127-W2 (the edge law): the hovered bar's tooltip position — center on
  // the bar only while the tooltip fits inside the chart's content box (the
  // Y_AXIS offset included — the clamp's coordinate space is the svg's);
  // near the first/last bars the shared clampTooltipX clamps it.
  const tooltipX =
    hoveredIdx !== null && hovered !== undefined
      ? clampTooltipX(
          Y_AXIS + hoveredIdx * (barWidth + barGap) + barWidth / 2,
          Y_AXIS + chartWidth,
          TOOLTIP_W,
        )
      : null;

  // R127-W2 (the newest-end law): the overflow-x scroller MOUNTS at the
  // newest end and re-lands there on every range/window swap
  // (`scrollLeft = scrollWidth` clamps to 0 when the content fits — the
  // 7/30-day centered fits are untouched). data-scrolled-to-latest is the
  // effect's observable contract (happy-dom's scroll geometry is 0/0, so
  // the pin reads the hook).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollLeft = el.scrollWidth;
    el.dataset.scrolledToLatest = "true";
  }, [range, visible.length]);

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
                              // R127-W2 (the full-column law): the painted
                              // segment is DISPLAY-ONLY — pointer-events:none
                              // lets the pointer resolve through the
                              // transparent data-bar-idx column underneath
                              // (hovering a colored segment's BODY works, not
                              // just the air above the stack).
                              style={{ pointerEvents: "none" }}
                              // R126-3b (MOTION §2): grow from the baseline —
                              // 350ms, 12ms stagger, once per data load.
                              initial={{ y: CHART_HEIGHT, height: 0 }}
                              animate={{ y: seg.y, height: seg.height }}
                              transition={{
                                duration: CHART_BAR_GROW_MS,
                                ease,
                                delay: i * CHART_BAR_STAGGER_MS,
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
                  // R127-W2 (the edge law): when the clamp engages, `left` IS
                  // the tooltip's left edge (no shift). When it doesn't,
                  // `left` is the bar's center — x:"-50%" is framer's own
                  // transform slot, so the centering composes WITH the
                  // animated y/scale (a raw style.transform would be
                  // clobbered by framer's transform writes — the pre-R126
                  // lesson, kept).
                  style={{
                    left: tooltipX.left,
                    ...(tooltipX.clamped ? {} : { x: "-50%" }),
                  }}
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
