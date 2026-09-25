import { useThemeStyles } from "../../lib/use-theme-styles";
import { cn } from "../../lib/utils";
import { CLAY_CARD } from "./usage-helpers";

/**
 * ROUND-126 (R126-3b, the Clay Companion redesign): the /usage stat row —
 * the SCREENS.md §3 Instrument grammar (the mobile stat-grid adapted):
 * ONE clay card, 2×2-or-4-across cells separated by 1px INSET
 * `border-strong` dividers — never four separate cards — kicker-tier labels,
 * 22px/600 tabular values (TOKENS §2's `value` step), ONE supporting line,
 * and NO icon chips (the pre-R126 StatCard's accent icon tiles + highlight
 * fill retired; the dashboard's StatCard keeps its own export for its wave).
 *
 * R99-E anti-jitter kit (binding, COMPONENTS §6): every cell is pinned at
 * `h-[92px]` — the exact height every StatCard-shaped skeleton across the
 * app already reserves — and every value renders `tabular-nums`.
 */

/** One cell of the stat row. */
export interface StatCell {
  /** The 22px/600 tabular value (pre-formatted by the caller). */
  value: string;
  /** The kicker-tier label ("Tokens", "Turns"…). */
  label: string;
  /** ONE supporting line (11px, secondary ink — a compact in/out split). */
  sub?: string;
  /** The hover tooltip (full precision + provenance). */
  title?: string;
}

export function UsageStatRow({
  cells,
  className,
  testId,
  ariaLabel,
}: {
  cells: StatCell[];
  className?: string;
  testId?: string;
  ariaLabel?: string;
}) {
  const styles = useThemeStyles();
  return (
    <div
      data-testid={testId}
      aria-label={ariaLabel}
      className={cn(
        CLAY_CARD,
        // 2×2 below md, 4-across from md up; the dividers are 1px inset
        // border-strong hairlines between cells (never on the card's rim).
        "grid grid-cols-2 md:grid-cols-4",
        className,
      )}
    >
      {cells.map((cell, i) => (
        <div
          key={cell.label}
          data-stat-cell
          title={cell.title}
          className={cn(
            "flex h-[92px] min-w-0 flex-col justify-center gap-1 px-4",
            // 4-across (md+): every cell after the first carries the left
            // divider; below md the 2×2 grid gets left dividers on the
            // second column and top dividers on the second row.
            i > 0 && i % 2 === 1 && "border-l border-line-strong",
            i >= 2 && "border-t border-line-strong md:border-t-0",
            i > 0 && i % 2 === 0 && "md:border-l md:border-line-strong",
          )}
        >
          <div
            className="truncate text-[11px] font-medium uppercase leading-none tracking-[0.08em]"
            style={{ color: styles.textTertiary }}
          >
            {cell.label}
          </div>
          <div className="truncate text-[22px] font-semibold leading-none tabular-nums" style={{ color: styles.text }}>
            {cell.value}
          </div>
          {cell.sub ? (
            <div className="truncate text-[11px] leading-none tabular-nums" style={{ color: styles.textSecondary }}>
              {cell.sub}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * ROUND-126 (R126-3b): the MINI stat cell — the same grammar at table
 * density for the compact clay tiles (ModelCards/KeyCards): 10px kicker-tier
 * label, 12px/600 tabular value, 1px clay-rim hairline dividers between the
 * cells of one row. ONE spelling for both consumers.
 */
export function UsageMiniStat({
  label,
  value,
  title,
  divider,
  styles,
}: {
  label: string;
  value: string;
  title?: string;
  /** Where the leading hairline divider renders — cells 2/4 always carry
   * it; cell 3 only from sm up (it starts the 2-col row on mobile). */
  divider: "none" | "always" | "sm";
  styles: ReturnType<typeof useThemeStyles>;
}) {
  const { text, textTertiary } = styles;
  return (
    <div
      className={cn(
        "min-w-0 px-2 first:pl-0",
        divider === "always" && "border-l border-clay-rim",
        divider === "sm" && "sm:border-l sm:border-clay-rim",
      )}
      title={title}
    >
      <div
        className="truncate text-[10px] font-medium uppercase leading-none tracking-[0.08em]"
        style={{ color: textTertiary }}
      >
        {label}
      </div>
      <div className="mt-1 truncate text-[12px] font-semibold leading-none tabular-nums" style={{ color: text }}>
        {value}
      </div>
    </div>
  );
}
