import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Zap } from "lucide-react";
import type { ThemeStyles } from "../../lib/themes";
import { ease } from "../../lib/motion";
import type { UsageDayBucket } from "../../lib/api";
import { placeTooltipBeside, stretchDayBarGeometry } from "../usage/usage-helpers";
import { shortUtcDay, utcDateLabel, withAlpha } from "./helpers";

/**
 * Token bar chart — the dashboard's primary series. R126-3a (the Instrument
 * archetype, SCREENS §3) → R127-W3 (the chart-interaction laws,
 * COMPONENTS §6):
 *
 * · The card rides the CLAY material: `bg-card` + the 1px warm rim +
 *   `.ac-clay` (TOKENS §5/§9 — the 1.5px bento border and the inline
 *   softShadow retire). The card itself is a plain div: the SCREEN owns the
 *   section entrance now (DashboardScreen's fade-in-up on the house spring).
 * · The bars paint `var(--ac-accent-deep)` — the accent-as-ink tier
 *   (TOKENS §1d), more legible on charts than the marker hue; resting bars
 *   are the same hue at the chart alpha ladder's faded step (withAlpha —
 *   the sanctioned dynamic-tint path). Hovered/last bars ratchet to the
 *   solid deep fill.
 * · R127 — THE FULL-COLUMN HIT-TESTING LAW: the transparent column rect
 *   (`data-bar-idx`, full plot height) is the ONE hit surface per bar; the
 *   PAINTED motion.rect bars render after it and would otherwise eat the
 *   pointer over the bar BODY (the owner's "hover only works at the top"
 *   defect) — they render `pointer-events: none` (display-only) so the
 *   pointer resolves through the column underneath. The painted rects
 *   carry NO `data-bar-idx` of their own.
 * · R127 — THE TOOLTIP EDGE LAW (superseded R128 by the side-placement
 *   law: the tooltip now renders BESIDE the hovered column via the shared
 *   placeTooltipBeside — right of a left-half column, left of a right-half
 *   one — with the edge INSET surviving inside the helper; the R127
 *   center-on-bar behavior and its x:"-50%" slot are RETIRED, the owner's
 *   "it was showing the details exactly on the top, centered on it"
 *   complaint).
 * · R128 — THE FILL LAW: the dashboard card is wide and the fixed 14-day
 *   window is narrow (a 358px natural chart); the measured container width
 *   (ResizeObserver on the chart wrapper) stretches the pitch to fill the
 *   card — capped at 42px bars / 16px gaps (stretchDayBarGeometry, the
 *   shared ONE spelling with the usage activity chart). Overflow keeps the
 *   natural pitch; the chart keeps its fixed height.
 * · The hover tooltip card gets the clay surface: `bg-card` + rim +
 *   `.ac-clay-sm` (the small-surface shadow step) — no hand-rolled shadow.
 * · Axis labels: mono 10px tertiary (the meta-mono tier), the hovered/last
 *   tick emphasized in accentDeep + 600. Fourteen natural-20px bars at a
 *   26px pitch (≈358px unstretched) fit an every-bar 3-char label band —
 *   the sparse-tick law (COMPONENTS §6) does NOT engage at this density
 *   (and the R128 fill law only WIDENS the pitch, never thins the band).
 * · Anti-jitter kit (COMPONENTS §6 — binding): the loading/empty states
 *   reserve the chart's final height (`h-[168px]`), values render
 *   `tabular-nums`, and the ONE pointer read (R121-d) resolves the hovered
 *   bar via the browser's own hit testing.
 */

const BAR_WIDTH = 20;
const BAR_GAP = 6;
const CHART_HEIGHT = 140;
const LABEL_AREA = 28;
const BAR_RADIUS = 6;
/** The tooltip's rendered width — the `w-44` class (176px) on the tooltip
 *  card below. */
const TOOLTIP_W = 176;

function fmtCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function dayTotal(d: UsageDayBucket): number {
  return d.inputTokens + d.outputTokens;
}

/** One row of the hover tooltip: label, value, optional share-of-day mini bar. */
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
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium text-muted">{label}</span>
        <span className="ml-2 text-[10px] font-semibold tabular-nums" style={{ color: color ?? styles.text }}>
          {value}
        </span>
      </div>
      {share !== undefined ? (
        <div
          className="mt-0.5 h-[3px] overflow-hidden rounded-full"
          style={{ backgroundColor: styles.borderSubtle }}
        >
          <div
            className="h-full rounded-full"
            style={{ width: `${Math.round(share * 100)}%`, backgroundColor: color }}
          />
        </div>
      ) : null}
    </div>
  );
}

export function TokenBarChart({
  days,
  isPending,
  isError,
  delay = 0,
  styles,
}: {
  days: UsageDayBucket[];
  isPending: boolean;
  isError: boolean;
  delay?: number;
  styles: ThemeStyles;
}) {
  const { textTertiary, accentDeep, border: lineColor, borderSubtle, isDark } = styles;
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const maxTokens = useMemo(() => Math.max(0, ...days.map(dayTotal)), [days]);
  const totalTokens = useMemo(() => days.reduce((s, d) => s + dayTotal(d), 0), [days]);

  // R128-W2 (the fill law): the chart wrapper's MEASURED width — 0 until the
  // useLayoutEffect below reads it (happy-dom reports 0/0 geometry, so the
  // unmeasured frame keeps the natural pitch; the ResizeObserver keeps it
  // fresh on real cards). The wrapper fills the card's content box (the
  // card's p-4/md:p-5 padding is outside it), so its clientWidth IS the
  // fill law's available width.
  const [containerWidth, setContainerWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The wrapper mounts only in the ready branch — the observer effect is
  // keyed on the ready flag so the pending/error→ready swap attaches it.
  const chartMounted = !isPending && !isError && days.length > 0;
  useLayoutEffect(() => {
    if (!chartMounted) return;
    const el = containerRef.current;
    if (el === null) return;
    setContainerWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [chartMounted]);

  // R128-W2 (the fill law): a fitting 14-day series stretches its pitch to
  // fill the measured container (capped 42px bars / 16px gaps — the shared
  // stretchDayBarGeometry, ONE spelling with the usage activity chart's day
  // view); an unmeasured (0) or overflowing container keeps the natural pitch.
  const { barWidth, barGap } = stretchDayBarGeometry(
    days.length,
    BAR_WIDTH,
    BAR_GAP,
    containerWidth,
  );

  const chartWidth = days.length * (barWidth + barGap) - barGap;

  // R128-W2 (the side-placement law): the hovered bar's tooltip position —
  // BESIDE the hovered column (right of a left-half column, left of a
  // right-half one), clamped inside the chart's content box by the shared
  // placeTooltipBeside. Null while no bar is hovered. `left` IS the
  // tooltip's own left edge — the retired R127 center-on-bar spelling (the
  // x:"-50%" slot) is GONE.
  const tooltipX =
    hoveredIdx !== null && days[hoveredIdx] !== undefined
      ? placeTooltipBeside(
          hoveredIdx * (barWidth + barGap),
          barWidth,
          chartWidth,
          TOOLTIP_W,
        )
      : null;

  return (
    <div className="h-full rounded-2xl border border-clay-rim bg-card p-4 ac-clay md:p-5">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap size={13} style={{ color: accentDeep }} strokeWidth={2} aria-hidden />
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] tabular-nums" style={{ color: textTertiary }}>
            Token Usage · 14 days
          </span>
        </div>
        <span className="text-[11px] font-medium tabular-nums text-muted">
          {isPending ? "…" : `${totalTokens.toLocaleString()} total`}
        </span>
      </div>

      {isPending ? (
        <div
          aria-label="Loading usage chart"
          className="flex h-[168px] items-end justify-center gap-2"
        >
          {/* The loading bars mirror the ready geometry and ride the WELL
              fill (TOKENS §10 law 4 — skeletons are well-shaped, never
              accent-alpha soup). */}
          {[0.45, 0.75, 0.55, 0.9, 0.65].map((h, i) => (
            <div
              key={i}
              className="w-5 animate-pulse rounded-t-md"
              style={{ height: `${h * 100}%`, backgroundColor: styles.surfaceWell }}
            />
          ))}
        </div>
      ) : isError || days.length === 0 ? (
        <div className="flex h-[168px] flex-col items-center justify-center gap-1 text-center">
          <p className="text-[12px] font-semibold text-ink">
            {isError ? "Usage data unavailable" : "No usage recorded yet"}
          </p>
          <p className="truncate text-[11px] text-muted">
            {isError
              ? "The sidecar's /usage/summary call failed — retry from the Usage screen."
              : "Token burn per day shows up here once agents start making model calls."}
          </p>
        </div>
      ) : (
        <div
          ref={containerRef}
          className="relative flex justify-center"
          onPointerMove={(e) => {
            // R121-d: the ONE pointer read (the R5 law — hover is a pointer
            // read, never a per-bar hover pair): the browser's own hit
            // testing resolves the bar under the pointer.
            const hit = (e.target as Element).closest("[data-bar-idx]");
            setHoveredIdx(hit !== null ? Number(hit.getAttribute("data-bar-idx")) : null);
          }}
          onPointerLeave={() => setHoveredIdx(null)}
        >
          {/* The tooltip's coordinate space — a relative wrapper EXACTLY the
              svg's size, so the placed `left` values (computed against
              chartWidth) position the tooltip against the bars themselves;
              the centering of the outer container can never offset it off
              its column. */}
          <div className="relative flex">
            <svg
              width={chartWidth}
              height={CHART_HEIGHT + LABEL_AREA}
              viewBox={`0 0 ${chartWidth} ${CHART_HEIGHT + LABEL_AREA}`}
              role="img"
              aria-label={`Token usage per day, ${totalTokens.toLocaleString()} tokens over ${days.length} days`}
            >
              <defs>
                {/* Hides the bottom rounded corners of bars, like the demo. */}
                <clipPath id="usage-bar-clip">
                  <rect x={0} y={-BAR_RADIUS} width={chartWidth} height={CHART_HEIGHT + BAR_RADIUS} />
                </clipPath>
              </defs>

              {/* The dashed quota gridlines + the baseline ride the pipeline's
                  hairline steps (TOKENS §1a) — never hand-rolled rgba strings. */}
              {[0.25, 0.5, 0.75, 1].map((pct) => (
                <line
                  key={pct}
                  x1={0}
                  y1={CHART_HEIGHT - CHART_HEIGHT * pct}
                  x2={chartWidth}
                  y2={CHART_HEIGHT - CHART_HEIGHT * pct}
                  stroke={borderSubtle}
                  strokeWidth={1}
                  strokeDasharray="3 5"
                />
              ))}
              <line
                x1={0}
                y1={CHART_HEIGHT}
                x2={chartWidth}
                y2={CHART_HEIGHT}
                stroke={lineColor}
                strokeWidth={1}
              />

              <g clipPath="url(#usage-bar-clip)">
                {days.map((day, i) => {
                  const barH =
                    maxTokens > 0 ? Math.max((dayTotal(day) / maxTokens) * CHART_HEIGHT, 4) : 4;
                  const x = i * (barWidth + barGap);
                  const y = CHART_HEIGHT - barH;
                  const isLast = i === days.length - 1;
                  const isHovered = hoveredIdx === i;
                  // R126: the primary series fill is accentDeep (the
                  // accent-as-ink tier) — solid for the hover ratchet + the
                  // last (today) bar, the alpha-ladder's faded step at rest.
                  // The var() rides the style leg (presentation attributes
                  // don't resolve custom properties).
                  const fill =
                    isHovered || isLast
                      ? "var(--ac-accent-deep)"
                      : withAlpha(accentDeep, isDark ? 0.36 : 0.27);
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
                        rx={BAR_RADIUS}
                        ry={BAR_RADIUS}
                        // R127 (the full-column law): the painted bar is
                        // DISPLAY-ONLY — pointer-events:none lets the pointer
                        // resolve through the transparent data-bar-idx column
                        // underneath (hovering the bar BODY works, not just the
                        // air above it). It carries NO data-bar-idx itself.
                        style={{ fill, pointerEvents: "none" }}
                        initial={{ y: CHART_HEIGHT, height: 0 }}
                        animate={{ y, height: barH }}
                        transition={{
                          // MOTION §2: CHART_BAR_GROW_MS 350 /
                          // CHART_BAR_STAGGER_MS 12 — bars grow from the
                          // baseline once per data load, never looping.
                          duration: 0.35,
                          ease,
                          delay: delay + 0.1 + i * 0.012,
                        }}
                      />
                    </g>
                  );
                })}
              </g>

              {days.map((day, i) => {
                const cx = i * (barWidth + barGap) + barWidth / 2;
                const isLast = i === days.length - 1;
                const isHovered = hoveredIdx === i;
                return (
                  <text
                    key={`${day.date}-label`}
                    x={cx}
                    y={CHART_HEIGHT + 18}
                    textAnchor="middle"
                    className="font-mono tabular-nums"
                    fill={isHovered || isLast ? accentDeep : textTertiary}
                    fontSize={10}
                    fontWeight={isHovered || isLast ? 600 : 400}
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
                  {/* The hover card gets the clay surface: card + rim + the
                      small-surface shadow step (TOKENS §9/§10). */}
                  <div className="ac-clay-sm w-44 space-y-2 rounded-xl border border-clay-rim bg-card p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-ink">
                        {utcDateLabel(days[hoveredIdx].date)}
                      </span>
                      <span className="text-[11px] font-semibold tabular-nums text-accent-deep">
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
                      color={textTertiary}
                      styles={styles}
                    />
                    <div className="flex items-center justify-between border-t border-line pt-1">
                      <span className="text-[10px] tabular-nums text-muted">
                        {days[hoveredIdx].requests} requests
                      </span>
                      <span className="text-[10px] font-semibold tabular-nums text-muted">
                        {fmtCost(days[hoveredIdx].costUsd)}
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
