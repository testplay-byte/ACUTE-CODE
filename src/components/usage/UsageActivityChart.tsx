import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Zap } from "lucide-react";
import type { ThemeStyles } from "../../lib/themes";
import { ease } from "../../lib/motion";
import type { UsageDayBucket } from "../../lib/api";
import { Kicker } from "../ui/Kicker";
import { shortUtcDay, utcDateLabel, withAlpha } from "../dashboard/helpers";
import { CHART_BAR_GROW_MS, CHART_BAR_STAGGER_MS, CLAY_CARD, CLAY_TOOLTIP } from "./usage-helpers";
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
 */

const BAR_WIDTH = 20;
const BAR_GAP = 6;
const CHART_HEIGHT = 140;
const LABEL_AREA = 28;
const BAR_RADIUS = 6;

function dayTotal(d: UsageDayBucket): number {
  return d.inputTokens + d.outputTokens;
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
  isPending,
  isError,
  delay = 0,
  styles,
}: {
  days: UsageDayBucket[];
  /** Label only — the range selector's window (bars render whatever `days` holds). */
  dayCount: number;
  isPending: boolean;
  isError: boolean;
  delay?: number;
  styles: ThemeStyles;
}) {
  const { text, textSecondary, accentDeep, isDark } = styles;
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const maxTokens = useMemo(() => Math.max(0, ...days.map(dayTotal)), [days]);
  const totalTokens = useMemo(() => days.reduce((s, d) => s + dayTotal(d), 0), [days]);

  const chartWidth = days.length * (BAR_WIDTH + BAR_GAP) - BAR_GAP;

  return (
    <div className={cn(CLAY_CARD, "p-4 md:p-5")}>
      <div className="mb-4 flex items-center justify-between">
        <Kicker icon={Zap} className="tabular-nums">
          Token Activity · {dayCount} {dayCount === 1 ? "day" : "days"}
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
        // The bar grid keeps its natural width (20px bars) — wider windows
        // (30/90 days, narrow phones) scroll INSIDE the card instead of
        // breaking the page layout. w-fit + mx-auto centers when it fits.
        <div className="custom-scrollbar overflow-x-auto">
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
              height={CHART_HEIGHT + LABEL_AREA}
              viewBox={`0 0 ${chartWidth} ${CHART_HEIGHT + LABEL_AREA}`}
              role="img"
              aria-label={`Token usage per day, ${totalTokens.toLocaleString()} tokens over ${days.length} days`}
            >
              <defs>
                {/* Hides the bottom rounded corners of bars, like the demo. */}
                <clipPath id="usage-screen-bar-clip">
                  <rect x={0} y={-BAR_RADIUS} width={chartWidth} height={CHART_HEIGHT + BAR_RADIUS} />
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
                  const x = i * (BAR_WIDTH + BAR_GAP);
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
                        width={BAR_WIDTH}
                        height={CHART_HEIGHT}
                        fill="transparent"
                        style={{ cursor: "pointer" }}
                        data-bar-idx={i}
                      />
                      <motion.rect
                        x={x}
                        width={BAR_WIDTH}
                        rx={BAR_RADIUS}
                        ry={BAR_RADIUS}
                        fill={fill}
                        // R126-3b (MOTION §2): grow from the baseline —
                        // 350ms, 12ms stagger, once per data load.
                        initial={{ y: CHART_HEIGHT, height: 0 }}
                        animate={{ y, height: barH }}
                        transition={{
                          duration: CHART_BAR_GROW_MS,
                          ease,
                          delay: delay + i * CHART_BAR_STAGGER_MS,
                        }}
                      />
                    </g>
                  );
                })}
              </g>

              {days.map((day, i) => {
                const cx = i * (BAR_WIDTH + BAR_GAP) + BAR_WIDTH / 2;
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
              {hoveredIdx !== null && days[hoveredIdx] ? (
                <motion.div
                  key="tooltip"
                  initial={{ opacity: 0, y: 4, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 4, scale: 0.96 }}
                  transition={{ duration: 0.15 }}
                  className="pointer-events-none absolute top-0 z-50"
                  style={{
                    left: hoveredIdx * (BAR_WIDTH + BAR_GAP) + BAR_WIDTH / 2,
                    transform: "translateX(-50%)",
                  }}
                >
                  {/* R126-3b: the tooltip surface is the clay popover —
                      card fill + rim + the small-surface clay shadow. */}
                  <div className={cn(CLAY_TOOLTIP, "w-44 space-y-2 p-3")}>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold" style={{ color: text }}>
                        {utcDateLabel(days[hoveredIdx].date)}
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
