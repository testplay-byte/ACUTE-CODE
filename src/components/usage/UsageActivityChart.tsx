import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Zap } from "lucide-react";
import type { ThemeStyles } from "../../lib/themes";
import { scaleIn } from "../../lib/motion";
import type { UsageDayBucket } from "../../lib/api";
import { bdr, shortUtcDay, utcDateLabel, withAlpha } from "../dashboard/helpers";

/**
 * ROUND-52 (R52-b): activity chart for the /usage screen — TokenBarChart's
 * exact rendering (ported, not imported, because the dashboard component
 * hardcodes its "· 14 days" header while this screen's range selector drives
 * the label). Bars are total tokens per UTC day; the hover tooltip breaks the
 * day into input/output/requests/cost.
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
  const { text, textSecondary, isDark } = styles;
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium" style={{ color: text }}>
          {label}
        </span>
        <span className="ml-2 text-[10px] font-semibold" style={{ color: color ?? textSecondary }}>
          {value}
        </span>
      </div>
      {share !== undefined ? (
        <div
          className="mt-0.5 h-[3px] overflow-hidden rounded-full"
          style={{ backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)" }}
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
  const { card, border, text, textSecondary, textTertiary, accent, isDark, softShadow } = styles;
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const maxTokens = useMemo(() => Math.max(0, ...days.map(dayTotal)), [days]);
  const totalTokens = useMemo(() => days.reduce((s, d) => s + dayTotal(d), 0), [days]);

  const chartWidth = days.length * (BAR_WIDTH + BAR_GAP) - BAR_GAP;

  return (
    <motion.div
      variants={scaleIn}
      className="rounded-2xl border-[1.5px] p-4 md:p-5"
      style={{ backgroundColor: card, borderColor: border, boxShadow: softShadow }}
    >
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap size={13} style={{ color: accent, opacity: 0.7 }} />
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] tabular-nums" style={{ color: textTertiary }}>
            Token Activity · {dayCount} {dayCount === 1 ? "day" : "days"}
          </span>
        </div>
        <span className="text-[11px] font-medium tabular-nums" style={{ color: textSecondary }}>
          {isPending ? "…" : `${totalTokens.toLocaleString()} total`}
        </span>
      </div>

      {isPending ? (
        <div
          aria-label="Loading usage chart"
          className="flex h-[168px] items-end justify-center gap-2"
        >
          {[0.45, 0.75, 0.55, 0.9, 0.65].map((h, i) => (
            <div
              key={i}
              className="w-5 animate-pulse rounded-t-md"
              style={{ height: `${h * 100}%`, backgroundColor: withAlpha(accent, 0.25) }}
            />
          ))}
        </div>
      ) : isError || days.length === 0 ? (
        <div className="flex h-[168px] flex-col items-center justify-center gap-1 text-center">
          <p className="text-[12px] font-semibold" style={{ color: text }}>
            {isError ? "Usage data unavailable" : "No usage recorded yet"}
          </p>
          <p className="max-w-[240px] text-[11px]" style={{ color: textSecondary }}>
            {isError
              ? "The sidecar's /usage/detailed call failed — check the sidecar and reload."
              : "Token burn per day shows up here once agents start making model calls."}
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
                  stroke={isDark ? "rgba(255,255,255,0.035)" : "rgba(0,0,0,0.035)"}
                  strokeWidth={1}
                  strokeDasharray="3 5"
                />
              ))}
              <line
                x1={0}
                y1={CHART_HEIGHT}
                x2={chartWidth}
                y2={CHART_HEIGHT}
                stroke={isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)"}
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
                  const fill =
                    isHovered || isLast ? accent : withAlpha(accent, isDark ? 0.36 : 0.27);
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
                        initial={{ y: CHART_HEIGHT, height: 0 }}
                        animate={{ y, height: barH }}
                        transition={{
                          duration: 0.6,
                          ease: [0.25, 0.1, 0.25, 1],
                          delay: delay + 0.1 + i * 0.05,
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
                    fill={isHovered || isLast ? accent : textSecondary}
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
                  <div
                    className="w-44 space-y-2 p-3"
                    style={{
                      backgroundColor: card,
                      border: bdr("1.5px", border),
                      borderRadius: "12px",
                      boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold" style={{ color: text }}>
                        {utcDateLabel(days[hoveredIdx].date)}
                      </span>
                      <span className="text-[11px] font-semibold tabular-nums" style={{ color: accent }}>
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
                      color={accent}
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
                      color={isDark ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.45)"}
                      styles={styles}
                    />
                    <div
                      className="flex items-center justify-between pt-1"
                      style={{ borderTop: bdr("1px", border) }}
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
    </motion.div>
  );
}
