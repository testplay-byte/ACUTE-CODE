import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Layers } from "lucide-react";
import type { ThemeStyles } from "../../lib/themes";
import type { UsageStatsDayBucket, UsageStatsModel } from "../../lib/api";
import { bdr, utcDateLabel, withAlpha } from "../dashboard/helpers";
import { formatCompactTokens, modelColor } from "./usage-helpers";

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
 * R100-G (research §C2 P3, the ladder sweep): the header label snapped to
 * the label tier (11px/500/0.08em — the ONE kicker spelling), the range
 * picker snapped to the DataStatsPanel picker grammar (rounded-xl segments,
 * rounded-lg buttons, 600 weights), the axis/label font sizes sit at the
 * 10px floor, and the card rides the 16px radius step (rounded-2xl). The
 * model palette + the fixed-height reserves stay untouched.
 */

const RANGE_OPTIONS = [7, 30, 90, 365] as const;
const CHART_HEIGHT = 150;
const LABEL_AREA = 22;
const Y_AXIS = 36;
const BAR_RADIUS = 3;

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
  const { card, border, text, textSecondary, textTertiary, accent, isDark, softShadow } = styles;
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

  return (
    <div
      data-testid="model-stack-chart"
      className="flex min-h-[264px] flex-col rounded-2xl border-[1.5px] p-4 md:min-h-[272px] md:p-5"
      style={{ backgroundColor: card, borderColor: border, boxShadow: softShadow }}
    >
      <div className="mb-4 flex shrink-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Layers size={13} style={{ color: accent, opacity: 0.7 }} />
          <span
            className="truncate text-[11px] font-medium uppercase leading-none tracking-[0.08em] tabular-nums"
            style={{ color: textTertiary }}
          >
            Model Mix · {visible.length} {visible.length === 1 ? "day" : "days"}
          </span>
        </div>
        <div
          role="group"
          aria-label="Model mix day range"
          className="flex shrink-0 items-center gap-1 rounded-xl border-[1.5px] p-1"
          style={{ backgroundColor: card, borderColor: border, boxShadow: softShadow }}
        >
          {RANGE_OPTIONS.map((option) => {
            const active = option === range;
            return (
              <button
                key={option}
                type="button"
                onClick={() => {
                  setRange(option);
                  setHoveredIdx(null);
                }}
                aria-pressed={active}
                aria-label={`Last ${option} days`}
                className="cursor-pointer rounded-lg px-2.5 py-1.5 text-[12px] font-semibold tabular-nums transition-colors duration-200"
                style={{
                  backgroundColor: active ? accent : "transparent",
                  color: active ? styles.accentText : textSecondary,
                }}
              >
                {option}d
              </button>
            );
          })}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="flex h-[172px] flex-col items-center justify-center gap-1 text-center">
          <p className="text-[12px] font-semibold" style={{ color: text }}>
            No usage recorded yet
          </p>
          <p className="max-w-[240px] text-[11px]" style={{ color: textSecondary }}>
            The model mix fills in once agents start making model calls.
          </p>
        </div>
      ) : (
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
                    stroke={withAlpha(text, isDark ? 0.07 : 0.06)}
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
                stroke={withAlpha(text, isDark ? 0.12 : 0.1)}
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
                            <rect
                              key={seg.name}
                              x={x}
                              y={seg.y}
                              width={barWidth}
                              height={seg.height}
                              rx={BAR_RADIUS}
                              fill={seg.color}
                              opacity={hoveredIdx === null || isHovered ? 1 : 0.35}
                              data-stack-model={seg.name}
                            />
                          ),
                      )}
                    </g>
                  );
                })}
              </g>

              {visible.length > 1 &&
                [0, Math.floor((visible.length - 1) / 3), Math.floor((2 * (visible.length - 1)) / 3), visible.length - 1].map(
                  (tick, i) => {
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
                  },
                )}
            </svg>

            <AnimatePresence>
              {hovered ? (
                <motion.div
                  key="tooltip"
                  initial={{ opacity: 0, y: 4, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 4, scale: 0.96 }}
                  transition={{ duration: 0.15 }}
                  className="pointer-events-none absolute top-0 z-50"
                  style={{
                    left: Y_AXIS + (hoveredIdx ?? 0) * (barWidth + barGap) + barWidth / 2,
                    transform: "translateX(-50%)",
                  }}
                >
                  <div
                    className="w-52 space-y-1.5 p-3"
                    style={{
                      backgroundColor: card,
                      border: bdr("1.5px", border),
                      borderRadius: "12px",
                      boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold" style={{ color: text }}>
                        {utcDateLabel(hovered.date)}
                      </span>
                      <span className="text-[11px] font-semibold tabular-nums" style={{ color: accent }}>
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
                      style={{ borderTop: bdr("1px", border) }}
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
