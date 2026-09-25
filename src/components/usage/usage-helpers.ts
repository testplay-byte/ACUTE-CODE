import { DISCLOSURE_SPRING, TAB_SPRING } from "../../lib/motion";

/**
 * ROUND-52 (R52-b): shared formatting for the Usage screen — ported from the
 * DASHBOARD build's fmt helpers (build.mjs) so the in-app numbers read exactly
 * like the owner-approved public usage page. App-wide formatters live in
 * src/lib/format.ts; these three are usage-screen-specific (duration, money,
 * compact counts for dense rows).
 */

/* ── ROUND-126 (R126-3b, the Clay Companion redesign): the usage screen's
 * MOTION.md §2 constants that src/lib/motion.ts doesn't export (it owns the
 * springs; the timed chart legs live here, next to their only consumers).
 * The values are the registry's, verbatim — never re-roll them locally. */

/** MOTION §2 CHART_BAR_GROW_MS — bars grow from baseline, once per data load. */
export const CHART_BAR_GROW_MS = 0.35;

/** MOTION §2 CHART_BAR_STAGGER_MS — the per-bar stagger. */
export const CHART_BAR_STAGGER_MS = 0.012;

/** MOTION §2 DONUT_SWEEP_MS — the donut's arc draw, once per data load. */
export const DONUT_SWEEP_MS = 0.5;

/** MOTION §2 DISCLOSURE_COLLAPSE_MS — collapse is a TIMING, never a spring
 * (closing never bounces — the mobile R118-C law). */
export const DISCLOSURE_COLLAPSE_MS = 0.2;

/** MOTION §2 DISCLOSURE_FADE_MS — the collapse's opacity fade. */
export const DISCLOSURE_FADE_MS = 0.15;

/** Re-exported so usage files import the spring grammar from ONE place. */
export { DISCLOSURE_SPRING, TAB_SPRING };

/* ── ROUND-126 (R126-3b): the clay card class spelling for the usage screen
 * (COMPONENTS §3 species 1, adapted PC densities): `card` surface + the warm
 * clayRim hairline on all four sides (`border-clay-rim`) + 16px radius
 * (`rounded-2xl`) + the clay two-leg shadow (`.ac-clay` / `.ac-clay-sm`,
 * TOKENS §9) + the dark-mode-only matte top edge (`.ac-clay-edge-dark`).
 * The class legs paint shadow/border/bg from the --ac-* bridge so a theme
 * switch restyles them with no rebuild; a local spelling because the shared
 * ui/SectionCard still carries the pre-R126 bento border (its wave will
 * convert it; adoption is then a one-line swap per call site). */

/** The top-level clay card (charts, leaderboard, project groups, stat row). */
export const CLAY_CARD =
  "rounded-2xl border border-clay-rim bg-card ac-clay ac-clay-edge-dark";

/** The compact-tile step (model/key cards, health blocks — shadow `-sm`). */
export const CLAY_CARD_SM =
  "rounded-2xl border border-clay-rim bg-card ac-clay-sm ac-clay-edge-dark";

/** The clay tooltip surface (charts' hover popovers): 12px radius step +
 * the small-surface clay shadow + rim (COMPONENTS §8 pattern classes). */
export const CLAY_TOOLTIP =
  "rounded-xl border border-clay-rim bg-card ac-clay-sm";

/** "1h 03m" / "2m 04s" / "45s" / "—" — a session's wall-clock span. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "$12.34" — the usage page's money format (always two decimals). */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** "1.2M" / "12k" / "850" — compact token counts for dense rows. */
export function formatCompactTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

/* ── ROUND-98 (R98-I2, owner: "time-range graphs color-coded by model
 * name — the same name across providers IS one model"): the MODEL COLOR
 * PALETTE — the one spelling of per-model color everywhere in the app
 * (the heatmap is accent-only; the model-mix stack chart, the donut, and
 * every model dot paint from HERE). Same model name = same color, on
 * every surface, in every session — a deterministic name→index hash
 * (the dashboard chipColor idiom) into 12 fixed hue pairs.
 *
 * TOKENS.md §1 hex-exception #4: these hex values are the documented
 * second fixed-hue palette (the segment palette in src/lib/menu-overlay.ts
 * is the precedent — a categorical palette cannot flow from the theme
 * pipeline because hue IDENTITY is the data encoding, not a surface
 * color). Light/dark variants keep 10px swatches distinguishable on both
 * card surfaces. */

const MODEL_COLOR_PALETTE: ReadonlyArray<{ light: string; dark: string }> = [
  { light: "#2563eb", dark: "#60a5fa" }, // blue
  { light: "#0d9488", dark: "#2dd4bf" }, // teal
  { light: "#7c3aed", dark: "#a78bfa" }, // violet
  { light: "#db2777", dark: "#f472b6" }, // pink
  { light: "#ea580c", dark: "#fb923c" }, // orange
  { light: "#16a34a", dark: "#4ade80" }, // green
  { light: "#ca8a04", dark: "#facc15" }, // yellow
  { light: "#0284c7", dark: "#38bdf8" }, // sky
  { light: "#9333ea", dark: "#c084fc" }, // purple
  { light: "#dc2626", dark: "#f87171" }, // red
  { light: "#475569", dark: "#94a3b8" }, // slate
  { light: "#be185d", dark: "#ec4899" }, // rose
];

/** Deterministic palette slot for a model name (the chipColor hash
 * idiom — same name ⇒ same slot across renders, surfaces, sessions). */
export function modelPaletteIndex(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % MODEL_COLOR_PALETTE.length;
}

/** The paintable color for a model name — ONE spelling everywhere. */
export function modelColor(name: string, isDark: boolean): string {
  const entry = MODEL_COLOR_PALETTE[modelPaletteIndex(name)];
  return isDark ? entry.dark : entry.light;
}

/** "z-ai/glm-5.2:free" → "glm-5.2" — the short name for tight centers
 * (chips, the donut's headline); falls back to the full name. */
export function shortModelName(name: string): string {
  const tail = name.split("/").pop() ?? name;
  const beforeVariant = tail.split(":")[0];
  return beforeVariant.trim() !== "" ? beforeVariant : name;
}

/* ── ROUND-127 (the chart-interaction laws — COMPONENTS §6): the shared
 * tooltip EDGE-CLAMP + the hour-label helpers. One spelling for every chart
 * (the owner's complaints: tooltips that overflow the card at the right
 * end; the 7-day view's fat bars + empty sides). Pure math — pinnable
 * without a DOM. */

/** The tooltip's clamp inset from the chart's content-box edges (px). */
export const TOOLTIP_EDGE_INSET_PX = 8;

/**
 * R127 (the edge law): clamp a tooltip's left edge so the tooltip stays
 * INSIDE the chart's content box. `barCenterX` is the hovered bar's center
 * in the same coordinate space as `containerWidth`; `tooltipWidth` the
 * rendered tooltip's width (the w-44/w-52 classes = 176/208px). The return
 * is the tooltip's LEFT position (add a transform of NONE — the caller
 * stops using translateX(-50%) and positions by the returned left directly,
 * or keeps -50% only when the clamp didn't engage: the returned
 * `clamped: false` flag tells the caller the center fit).
 *
 *   const { left, clamped } = clampTooltipX(centerX, containerW, tipW);
 *   style = clamped ? { left } : { left, transform: "translateX(-50%)" }
 */
export function clampTooltipX(
  barCenterX: number,
  containerWidth: number,
  tooltipWidth: number,
): { left: number; clamped: boolean } {
  const half = tooltipWidth / 2;
  const minLeft = TOOLTIP_EDGE_INSET_PX;
  const maxLeft = Math.max(minLeft, containerWidth - tooltipWidth - TOOLTIP_EDGE_INSET_PX);
  if (barCenterX - half < minLeft) {
    return { left: minLeft, clamped: true };
  }
  if (barCenterX + half > containerWidth - TOOLTIP_EDGE_INSET_PX) {
    return { left: maxLeft, clamped: true };
  }
  return { left: barCenterX, clamped: false };
}

/* ── ROUND-128 (COMPONENTS §6 — the side-placement law, the fill law, the
 * stagger cap): the R128 amendments' shared math. The R127 center-on-bar
 * law is RETIRED (the owner's "it was showing the details exactly on the
 * top, centered on it" complaint); clampTooltipX stays above for
 * back-compat/pure-law pinning, but every chart tooltip now positions
 * through placeTooltipBeside. Pure math — pinnable without a DOM. */

/** R128 (the newest-end law): the LAST bar's entrance delay ceiling — every
 * chart's grow stagger is capped so a 365-bar window never sweeps 4.4s
 * old→new (an uncapped sweep reads as "starts from the oldest month").
 * ONE spelling for every chart (UsageActivityChart's local R127 constant
 * moved here when ModelStackChart needed it too). */
export const STAGGER_CAP_S = 0.4;

/**
 * R128 (the side-placement law): place the hover tooltip BESIDE the hovered
 * column — to its RIGHT when the column sits in the plot's left half, to
 * its LEFT when it sits in the right half — pinned to the plot's top edge
 * by the caller. `columnLeft`/`columnWidth` are the hovered column's
 * rectangle in the same coordinate space as `plotWidth` (the chart's
 * content box; ModelStackChart adds its Y_AXIS offset to both). The return
 * `left` is the tooltip's LEFT edge — the caller renders NO translateX
 * (never `x: "-50%"`), the retired R127 centering.
 *
 * Edge clamping keeps the tooltip inside the content box's inset
 * (TOOLTIP_EDGE_INSET_PX). When the clamped placement would still overlap
 * the hovered column horizontally, the side with more room wins and clamps
 * to its edge — a near-degenerate net for plots too narrow to host the
 * tooltip beside the column at all (e.g. a 176px tooltip inside a 254px
 * day chart): there the overlap is unavoidable and this picks the
 * least-bad side, exactly per the letter.
 *
 *   const { left, side } = placeTooltipBeside(colLeft, colW, plotW, tipW);
 *   style = { left }   // no x slot, no transform
 */
export function placeTooltipBeside(
  columnLeft: number,
  columnWidth: number,
  plotWidth: number,
  tooltipWidth: number,
  gap = 8,
): { left: number; side: "left" | "right" } {
  const columnCenter = columnLeft + columnWidth / 2;
  // The side law: right of a left-half column, left of a right-half column.
  let side: "left" | "right" = columnCenter < plotWidth / 2 ? "right" : "left";
  // Degenerate guard: the tooltip cannot fit the usable plot at all — park
  // at the inset and keep the computed side (the caller still renders it).
  if (tooltipWidth >= plotWidth - 2 * TOOLTIP_EDGE_INSET_PX) {
    return { left: TOOLTIP_EDGE_INSET_PX, side };
  }
  const columnRight = columnLeft + columnWidth;
  const minLeft = TOOLTIP_EDGE_INSET_PX;
  const maxLeft = plotWidth - tooltipWidth - TOOLTIP_EDGE_INSET_PX;
  const ideal = side === "right" ? columnRight + gap : columnLeft - tooltipWidth - gap;
  let left = Math.max(minLeft, Math.min(ideal, maxLeft));
  // Overlap net: the clamped placement would cover the hovered column —
  // pick the side with more room and clamp to its edge.
  if (left < columnRight && left + tooltipWidth > columnLeft) {
    const roomRight = plotWidth - TOOLTIP_EDGE_INSET_PX - columnRight;
    const roomLeft = columnLeft - TOOLTIP_EDGE_INSET_PX;
    side = roomRight >= roomLeft ? "right" : "left";
    left =
      side === "right"
        ? Math.min(columnRight + gap, maxLeft)
        : Math.max(columnLeft - tooltipWidth - gap, minLeft);
  }
  return { left, side };
}

/** R128 (the fill law): the stretched DAY bar's comfortable maximum width
 * (px) — the stretch never inflates a bar past this. */
export const DAY_FILL_MAX_BAR_PX = 42;

/** R128 (the fill law): the stretched DAY gap's comfortable maximum (px). */
export const DAY_FILL_MAX_GAP_PX = 16;

/**
 * R128 (the fill law): a day-granularity series whose natural width FITS
 * the measured container stretches its pitch to FILL it — a 14-day view
 * never parks a 358px chart inside a ~900px card with dead margins on both
 * sides. `availableWidth` is the measured scroller/container content width
 * (0 = unmeasured — happy-dom and the pre-observer frame — keeps the
 * natural geometry). Overflowing series keep the natural pitch and ride the
 * newest-end law instead. Both the bar width and the gap scale by the SAME
 * factor, capped so width ≤ DAY_FILL_MAX_BAR_PX and gap ≤ DAY_FILL_MAX_GAP_PX.
 * HOUR geometry never stretches (the hour views always scroll) — the caller
 * gates on granularity. Pure; deterministic.
 */
export function stretchDayBarGeometry(
  count: number,
  naturalBarWidth: number,
  naturalBarGap: number,
  availableWidth: number,
): { barWidth: number; barGap: number } {
  if (count <= 0 || availableWidth <= 0) {
    return { barWidth: naturalBarWidth, barGap: naturalBarGap };
  }
  const naturalWidth = count * (naturalBarWidth + naturalBarGap) - naturalBarGap;
  if (naturalWidth >= availableWidth) {
    return { barWidth: naturalBarWidth, barGap: naturalBarGap };
  }
  const factorMax = Math.min(
    DAY_FILL_MAX_BAR_PX / naturalBarWidth,
    DAY_FILL_MAX_GAP_PX / naturalBarGap,
  );
  const factor = Math.min(availableWidth / naturalWidth, factorMax);
  return { barWidth: naturalBarWidth * factor, barGap: naturalBarGap * factor };
}

/* ── ROUND-127 (the hour laws — COMPONENTS §6's dense-series rule): the
 * 7-day HOURLY view's label helpers. Hour bucket dates arrive as
 * "YYYY-MM-DDThh" (the granularity=hour series from /usage/detailed) and
 * MUST NEVER reach the `${date}T00:00:00Z` day-label helpers (they
 * template-append and yield Invalid Date — the R127-Rb research's trap
 * list). These are the dedicated branches. */

/** Is this series bucket an HOUR bucket ("YYYY-MM-DDThh", 13 chars)? */
export function isHourBucket(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(date);
}

/** "2025-06-15T14" → "Jun 15 · 14:00" — the hourly tooltip header. */
export function hourBucketLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(date);
  if (m === null) return date;
  const [, y, mo, d, h] = m;
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[dt.getUTCMonth()]} ${dt.getUTCDate()} · ${h}:00`;
}

/** "2025-06-15T14" → "14:00" — the hourly x-axis tick. */
export function hourTickLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(date);
  return m !== null ? `${m[4]}:00` : date;
}

/** The DAY a bucket belongs to ("2025-06-15T14" → "2025-06-15") — for
 * day-boundary tick dividers in the hourly view. */
export function hourBucketDay(date: string): string {
  return date.slice(0, 10);
}

/**
 * R127 (the sparse-tick law): pick ≤maxTicks evenly spaced indices over a
 * series of `count` buckets (the ModelStackChart 4-tick pattern,
 * generalized — first, ~⅓, ~⅔, last at maxTicks=4). Pure; deterministic.
 * Degenerate guards: count 0 → []; maxTicks ≤ 1 → the first bucket only
 * (the 0/0 spread would otherwise yield NaN).
 */
export function sparseTickIndices(count: number, maxTicks: number): number[] {
  if (count <= 0) return [];
  if (maxTicks <= 1) return [0];
  if (count <= maxTicks) return Array.from({ length: count }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < maxTicks; i++) {
    out.push(Math.round((i / (maxTicks - 1)) * (count - 1)));
  }
  return [...new Set(out)];
}
