import { motion } from "framer-motion";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { cn } from "../../lib/utils";
import { TAB_SPRING } from "./usage-helpers";

/**
 * ROUND-126 (R126-3b, the Clay Companion redesign): the day/month window
 * picker — the mobile SegmentedControl grammar (mobile/src/design/
 * primitives.tsx) adapted to PC density. The pre-R126 pill group (bordered
 * bento track + per-button accent fills) retires.
 *
 * The grammar (MOTION §4 "Segmented control" + TOKENS §10):
 *   · track  — THE recess: `bg-well` + the warm rim hairline (`border-clay-rim`)
 *     + `rounded-lg`, h-8 (32px — the PC density; mobile's 52px touch tier
 *     does not apply to pointer-first chrome);
 *   · knob   — ONE solid `bg-accent-deep` pill, NO border (the §1d deep tier
 *     as a fill), gliding in INDEX space on TAB_SPRING (the calm slide,
 *     {200, 26} — imported, never hand-rolled). Selected label rides it in
 *     `accentText` (the explicit pair) at 12px/600; unselected 12px/400
 *     `text-muted`. The weight flips with the knob (MOTION §4).
 *
 * Buttons keep the pre-R126 a11y contract verbatim (role=group + per-button
 * aria-pressed + "Last N days/months" labels) — UsageScreen.test and
 * DataStatsPanel.test pin those names.
 */
export function RangeSelector({
  options,
  selected,
  onChange,
  groupLabel,
  optionAriaLabel,
  suffix = "d",
  className,
  testId,
}: {
  /** The window sizes in ascending order (labels render compact: "7d"/"6mo"). */
  options: ReadonlyArray<number>;
  selected: number;
  onChange: (value: number) => void;
  /** The group's accessible name ("Activity chart day range"…). */
  groupLabel: string;
  /** Builds each button's accessible label ("Last 30 days"…). */
  optionAriaLabel: (value: number) => string;
  /** The compact label suffix — "d" ("30d") or "mo" ("12mo"). */
  suffix?: "d" | "mo";
  className?: string;
  testId?: string;
}) {
  const styles = useThemeStyles();
  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o === selected),
  );
  const segment = 100 / options.length;

  return (
    <div
      role="group"
      aria-label={groupLabel}
      data-testid={testId}
      className={cn(
        "flex h-8 shrink-0 items-center rounded-lg border border-clay-rim bg-well p-1",
        className,
      )}
    >
      <div className="relative flex h-full min-w-0 flex-1">
        {/* The gliding knob — pure index-space motion (percent left on the
            equal-width segments), so it never measures the DOM. */}
        <motion.span
          aria-hidden
          data-testid="range-selector-knob"
          className="absolute inset-y-0 rounded-full bg-accent-deep"
          style={{ width: `${segment}%` }}
          initial={false}
          animate={{ left: `${activeIndex * segment}%` }}
          transition={TAB_SPRING}
        />
        {options.map((option) => {
          const active = option === selected;
          return (
            <button
              key={option}
              type="button"
              onClick={() => onChange(option)}
              aria-pressed={active}
              aria-label={optionAriaLabel(option)}
              className={cn(
                "relative z-10 flex h-full min-w-0 flex-1 cursor-pointer items-center justify-center rounded-full px-3 text-[12px] tabular-nums transition-colors duration-100",
                active ? "font-semibold" : "font-normal text-muted hover:text-ink",
              )}
              style={active ? { color: styles.accentText } : undefined}
            >
              {`${option}${suffix}`}
            </button>
          );
        })}
      </div>
    </div>
  );
}
