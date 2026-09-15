import { useMemo } from "react";
import { CalendarDays } from "lucide-react";
import type { ThemeStyles } from "../../lib/themes";
import type { UsageStatsDayBucket } from "../../lib/api";
import { withAlpha } from "../dashboard/helpers";
import { formatCompactTokens } from "./usage-helpers";

/**
 * ROUND-98 (R98-I2, owner: "the 12-month token-activity heatmap"): the
 * GitHub-style contribution grid over the stats window's zero-filled day
 * series — one 10px cell per UTC day (2px gaps), weeks as columns,
 * weekdays as rows, month labels along the top. Intensity rides the
 * COMPONENTS.md §6 accent-alpha ladder (0 → transparent; quartiles of
 * the max day → 0.15 / 0.35 / 0.6 / 0.85 / 1), so the chart is readable
 * in EVERY theme without a second palette.
 *
 * Accessibility contract (the Skeletons.tsx idiom): the SVG grid is
 * DECORATIVE (aria-hidden — 371 cells would drown a screen reader); the
 * container carries exactly ONE aria-label summary. Per-cell hover titles
 * carry "YYYY-MM-DD · X tokens" for sighted inspection.
 *
 * R99-E (anti-jitter kit): the card reserves its final height
 * (min-h-[184px]/md:192px — header + the fixed 98px grid + legend) and the
 * header rows render leading-none so the height is data-independent; every
 * number renders tabular-nums. The DataStatsPanel's loading skeleton
 * mirrors this exact geometry.
 */

const CELL = 10;
const GAP = 2;
const PITCH = CELL + GAP;
/** Left gutter for the weekday labels + top row for the month labels. */
const WEEKDAY_GUTTER = 26;
const MONTH_ROW = 16;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
/** Rows 1 / 3 / 5 of the Sun–Sat week — the GitHub label set. */
const WEEKDAY_LABELS: ReadonlyArray<{ row: number; label: string }> = [
  { row: 1, label: "Mon" },
  { row: 3, label: "Wed" },
  { row: 5, label: "Fri" },
];

/** The §6 intensity ladder — index 0 (transparent) is the no-traffic day. */
const INTENSITY_ALPHAS = [0.15, 0.35, 0.6, 0.85, 1] as const;

function dayTotal(day: UsageStatsDayBucket): number {
  let sum = 0;
  for (const value of Object.values(day.byModel)) sum += value;
  return sum;
}

export function UsageHeatmap({
  days,
  styles,
}: {
  days: UsageStatsDayBucket[];
  styles: ThemeStyles;
}) {
  const { card, border, text, textSecondary, textTertiary, accent, softShadow, isDark } = styles;

  const layout = useMemo(() => {
    if (days.length === 0) return null;
    const totals = new Map<string, number>();
    let maxDay = 0;
    let totalTokens = 0;
    for (const day of days) {
      const total = dayTotal(day);
      totals.set(day.date, total);
      totalTokens += total;
      if (total > maxDay) maxDay = total;
    }
    // Weeks are Sunday-anchored columns; the window's first day lands on
    // its weekday row (leading cells of the first column simply do not
    // exist — no fake zero days before the window).
    const firstDow = new Date(`${days[0].date}T00:00:00Z`).getUTCDay();
    const columns = Math.floor((firstDow + days.length - 1) / 7) + 1;
    return { totals, maxDay, totalTokens, firstDow, columns };
  }, [days]);

  const gridWidth = layout ? layout.columns * PITCH - GAP : 0;
  const gridHeight = 7 * PITCH - GAP;

  /** Intensity bucket of a day's total: 0 = no traffic (the ink wash),
   * 1–5 = the §6 ladder (quartiles of the max day, the max itself at 1). */
  const levelFor = (tokens: number): number => {
    if (tokens <= 0 || layout === null || layout.maxDay <= 0) return 0;
    return Math.min(4, Math.floor(tokens / (layout.maxDay / 4))) + 1;
  };

  const monthLabels = useMemo(() => {
    if (layout === null) return [] as Array<{ col: number; label: string }>;
    const labels: Array<{ col: number; label: string }> = [];
    const firstMs = Date.parse(`${days[0].date}T00:00:00Z`);
    let prevMonth = new Date(firstMs).getUTCMonth();
    for (let col = 1; col < layout.columns; col += 1) {
      // The Sunday that starts this column: first day + (col*7 - firstDow).
      const weekStart = new Date(firstMs + (col * 7 - layout.firstDow) * 86_400_000);
      const month = weekStart.getUTCMonth();
      if (month !== prevMonth) {
        prevMonth = month;
        labels.push({ col, label: MONTHS[month] });
      }
    }
    return labels;
  }, [days, layout]);

  return (
    <div
      data-testid="usage-heatmap"
      className="flex min-h-[184px] flex-col rounded-[24px] border-[1.5px] p-4 md:min-h-[192px] md:p-5"
      style={{ backgroundColor: card, borderColor: border, boxShadow: softShadow }}
      aria-label={
        layout === null
          ? "Token activity heatmap"
          : `Token activity heatmap, ${formatCompactTokens(layout.totalTokens)} tokens over ${days.length} days`
      }
    >
      <div className="mb-4 flex shrink-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <CalendarDays size={13} style={{ color: accent, opacity: 0.7 }} />
          <span
            className="truncate text-[11px] font-bold uppercase leading-none tracking-widest tabular-nums"
            style={{ color: textTertiary }}
          >
            Token Activity · {days.length} {days.length === 1 ? "day" : "days"}
          </span>
        </div>
        <span className="shrink-0 text-[11px] font-medium leading-none tabular-nums" style={{ color: textSecondary }}>
          {layout === null ? "…" : `${layout.totalTokens.toLocaleString()} total`}
        </span>
      </div>

      {layout === null ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center">
          <p className="text-[12px] font-semibold" style={{ color: text }}>
            No usage recorded yet
          </p>
          <p className="max-w-[240px] text-[11px]" style={{ color: textSecondary }}>
            The heatmap fills in day by day once agents start making model calls.
          </p>
        </div>
      ) : (
        <div className="custom-scrollbar overflow-x-auto">
          <svg
            width={WEEKDAY_GUTTER + gridWidth}
            height={MONTH_ROW + gridHeight}
            viewBox={`0 0 ${WEEKDAY_GUTTER + gridWidth} ${MONTH_ROW + gridHeight}`}
            aria-hidden
            focusable="false"
            className="mx-auto block w-fit"
          >
            {WEEKDAY_LABELS.map(({ row, label }) => (
              <text
                key={label}
                x={WEEKDAY_GUTTER - 4}
                y={MONTH_ROW + row * PITCH + CELL / 2 + 3}
                textAnchor="end"
                fill={textTertiary}
                fontSize={9}
                fontWeight={500}
              >
                {label}
              </text>
            ))}
            {monthLabels.map(({ col, label }) => (
              <text
                key={`${label}-${col}`}
                x={WEEKDAY_GUTTER + col * PITCH}
                y={10}
                fill={textTertiary}
                fontSize={9}
                fontWeight={500}
              >
                {label}
              </text>
            ))}
            <g transform={`translate(${WEEKDAY_GUTTER}, ${MONTH_ROW})`}>
              {days.map((day, i) => {
                const col = Math.floor((layout.firstDow + i) / 7);
                const row = (layout.firstDow + i) % 7;
                const tokens = layout.totals.get(day.date) ?? 0;
                const level = levelFor(tokens);
                const fill =
                  level === 0
                    ? withAlpha(text, isDark ? 0.06 : 0.05)
                    : withAlpha(accent, INTENSITY_ALPHAS[level - 1]);
                return (
                  <rect
                    key={day.date}
                    x={col * PITCH}
                    y={row * PITCH}
                    width={CELL}
                    height={CELL}
                    rx={2}
                    fill={fill}
                    data-heatmap-date={day.date}
                    data-heatmap-level={level}
                  >
                    <title>{`${day.date} · ${tokens} tokens`}</title>
                  </rect>
                );
              })}
            </g>
          </svg>
          {/* The §6 legend — the ladder's five non-zero rungs. */}
          <div className="mt-3 flex shrink-0 items-center justify-end gap-1.5">
            <span className="text-[10px] leading-none" style={{ color: textTertiary }}>
              Less
            </span>
            {INTENSITY_ALPHAS.map((alpha) => (
              <span
                key={alpha}
                aria-hidden
                className="h-[10px] w-[10px] rounded-[2px]"
                style={{ backgroundColor: withAlpha(accent, alpha) }}
              />
            ))}
            <span className="text-[10px] leading-none" style={{ color: textTertiary }}>
              More
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
