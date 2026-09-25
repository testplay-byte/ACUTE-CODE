import { motion } from "framer-motion";
import type { ElementType } from "react";
import type { ThemeStyles } from "../../lib/themes";
import { cn } from "../../lib/utils";
import { scaleIn } from "../../lib/motion";

/**
 * ROUND-126 (R126-3a — the Instrument archetype, SCREENS §3 "the stat row"):
 * the dashboard's four numbers ride ONE clay card with inset-divided cells —
 * `StatRow` below (the mobile stat-grid law at PC densities). The single-cell
 * `StatCard` export stays for the usage screens (UsageScreen/DataStatsPanel —
 * their own wave converts them to the row) and is re-skinned onto the SAME
 * clay idiom so both spellings agree in the meantime:
 *
 * · Material: `bg-card` + the warm 1px clay rim hairline (TOKENS §5 — the
 *   1.5px bento border is retired) + `.ac-clay` (TOKENS §9's two-leg
 *   shadow). Hover = the rim→border-strong swap, nothing more (MOTION §4:
 *   the clay card is already elevated; hover confirms, never performs).
 * · Cell anatomy: Kicker-tier label (11px/500 uppercase tracked tertiary) →
 *   the value at 26px/700 `tabular-nums` (R127, SCREENS §3 — the DASHBOARD
 *   BOLDNESS LAW: "the stat row's numbers at display weight"; TOKENS §2's
 *   weight law names the StatCard value as the ONE 700/900 chrome seat) →
 *   ONE 11px tertiary supporting line (the copy-length law: one line or
 *   absent). The usage screens' own UsageStatRow keeps the 22px/600 `value`
 *   tier — their wave, their call. NO icon chips — the mobile stat-grid law;
 *   the icon tiles retired with the redesign (the `icon` prop survives on
 *   StatCard only so the usage screens' call sites compile until their wave
 *   lands).
 * · Highlight (the Tokens cell): kicker + value render in `accentDeep` —
 *   the accent-as-ink tier (TOKENS §1d). NEVER a solid accent fill: the
 *   VLM's R126 review flagged that fill as an anomaly against the clay
 *   material, and the quiet clay card carries the emphasis by ink alone.
 * · R99-E stands: every cell is pinned at `h-[92px]` — the exact height
 *   every StatCard-shaped skeleton reserves app-wide — and values render
 *   `tabular-nums` (the anti-jitter kit, COMPONENTS §6 — binding). The pin
 *   lives on the CELLS (not the card) so the card auto-heights: the 4-across
 *   tier (md+, the desktop app's only reachable tier — the Tauri window's
 *   minWidth 1000 keeps the viewport over the md breakpoint) is exactly one
 *   92px row, while the 2×2 fallback below md (web demo only) grows to two
 *   honest 92px rows instead of clipping the cell content — the same
 *   spelling the usage wave's UsageStatRow pinned (one grammar app-wide).
 */

/** One cell of the stat row (the mobile StatGridCell grammar, adapted). */
export interface StatRowCell {
  key: string;
  /** The Kicker-tier label ("Projects", "Tokens", …). */
  label: string;
  /** The headline figure — 26px/700 tabular (R127 display weight). */
  value: string;
  /** The optional ONE-line supporting line (11px tertiary — the honesty scope). */
  caption?: string;
  /** Optional tooltip/a11y note riding the cell (raw detail the caption trims). */
  title?: string;
  /** The emphasized cell — kicker + value in accentDeep ink (never a fill). */
  highlight?: boolean;
}

/** One cell's body — the shared spelling `StatRow` cells and the single-cell
 *  `StatCard` both render (one spelling, per COMPONENTS §1's table rule). */
function StatCellBody({ cell, styles }: { cell: StatRowCell; styles: ThemeStyles }) {
  const { text, textTertiary, accentDeep } = styles;
  return (
    <>
      <div
        className="truncate text-[11px] font-medium uppercase tracking-[0.08em]"
        style={{ color: cell.highlight ? accentDeep : textTertiary }}
      >
        {cell.label}
      </div>
      <div
        className="mt-1 text-[26px] font-bold leading-none tabular-nums"
        style={{ color: cell.highlight ? accentDeep : text }}
      >
        {cell.value}
      </div>
      {cell.caption !== undefined ? (
        <div className="mt-1 truncate text-[11px]" style={{ color: textTertiary }}>
          {cell.caption}
        </div>
      ) : null}
    </>
  );
}

/**
 * THE STAT ROW (R126-3a): ONE `rounded-2xl` clay card (1px `border-clay-rim`
 * + `.ac-clay` + `bg-card`) carrying the four cells, split by 1px INSET
 * `border-strong` vertical dividers — full cell height, inset by the card's
 * horizontal padding (the mobile stat-grid law; 2×2 below `md` gains the
 * horizontal divider the same way). Every cell is pinned `h-[92px]`
 * (R99-E's skeleton contract — see the file header for why the pin sits on
 * the cells; 26px value + 11px label + 11px caption ≈ 60px of type in the
 * 92px cell — the R127 display weight still fits with room). The Tokens
 * cell's `highlight` is ink-only (see the file header).
 */
export function StatRow({
  cells,
  styles,
  testId,
}: {
  cells: ReadonlyArray<StatRowCell>;
  styles: ThemeStyles;
  testId?: string;
}) {
  if (cells.length === 0) return null;
  // The last cell of each row never carries the trailing divider; in the
  // 2×2 (below md) layout the first row keeps a bottom divider instead.
  const lastRowStart2 = Math.max(0, Math.ceil(cells.length / 2) * 2 - 2);
  return (
    <div
      data-testid={testId}
      className="ac-clay grid grid-cols-2 overflow-hidden rounded-2xl border border-clay-rim bg-card px-5 md:grid-cols-4"
    >
      {cells.map((cell, i) => {
        const twoLast = (i + 1) % 2 === 0 || i === cells.length - 1;
        const fourLast = (i + 1) % 4 === 0 || i === cells.length - 1;
        return (
          <div
            key={cell.key}
            title={cell.title}
            className={cn(
              "flex h-[92px] min-w-0 flex-col justify-center border-line-strong px-4 md:px-5",
              !twoLast && !fourLast && "border-r",
              twoLast && !fourLast && "md:border-r",
              !twoLast && fourLast && "max-md:border-r",
              i < lastRowStart2 && "border-b md:border-b-0",
            )}
          >
            <StatCellBody cell={cell} styles={styles} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * The single-cell clay stat card (the pre-R126 shape, kept for the usage
 * screens until their wave adopts `StatRow`). Same material + cell anatomy
 * as the row's cells; the `icon` prop is accepted but RETIRED (no icon
 * chips — SCREENS §3) and the `highlight` is the accentDeep ink idiom, never
 * the solid accent fill the VLM flagged.
 */
export function StatCard({
  value,
  label,
  title,
  styles,
  highlight = false,
}: {
  value: string;
  label: string;
  /** R126: retired (no icon chips in stat cells) — kept optional so the
   *  usage screens' call sites compile until their own wave converts them. */
  icon?: ElementType;
  title?: string;
  styles: ThemeStyles;
  /** The emphasized card — kicker + value in accentDeep ink (R126 idiom). */
  highlight?: boolean;
}) {
  return (
    <motion.div
      variants={scaleIn}
      className="flex h-[92px] cursor-default flex-col justify-center overflow-hidden rounded-2xl border border-clay-rim bg-card p-4 transition-colors duration-100 hover:border-line-strong ac-clay"
      title={title}
    >
      <StatCellBody cell={{ key: label, label, value, highlight }} styles={styles} />
    </motion.div>
  );
}
