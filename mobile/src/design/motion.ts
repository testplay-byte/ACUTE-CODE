/**
 * The shared motion language (R1 §6) — "spring physics ~stiffness 180 /
 * damping 22 everywhere (no linear easing)". NO linear easings live in this
 * file, and none may be imported anywhere else: springs own every animated
 * value. Pure constants + pure helpers — no reanimated import, so tests and
 * non-animated code can read the recipes too.
 *
 * The three named recipes (consumed via reanimated in components):
 *
 *   SPRING           — the one config: withSpring(v, SPRING)
 *   staggerDelay(i)  — the 30ms list stagger: withDelay(staggerDelay(i), …)
 *   ENTRANCE_DELTA   — the fade-in-up entrance's rise, in px
 */

import type { WithSpringConfig } from "react-native-reanimated";

/** The single spring: stiffness 180 / damping 22. Everything uses this. */
export const SPRING: WithSpringConfig = {
  stiffness: 180,
  damping: 22,
};

/** The 30ms list stagger — item N of a list enters 30ms × N after the first. */
export const STAGGER_STEP_MS = 30;

/** The delay (ms) list item `index` should wait before its spring starts. */
export function staggerDelay(index: number): number {
  return index * STAGGER_STEP_MS;
}

/** The entrance delta (px) — how far an entering block rises from below. */
export const ENTRANCE_DELTA = 8;

/** The press scale — 0.98, the "quiet instrument" press state (no ripple). */
export const PRESS_SCALE = 0.98;

// ── the R115 animated moments (motion.md §4 — the round-115 mandates) ──────

/** The hero tile's entrance scale start — motion.md §4.1: scale 0.9→1 on the
 *  house spring (welcome's logo tile, the camera-ask tile). */
export const ENTRANCE_SCALE_FROM = 0.9;

/** The welcome hero icon's idle-float amplitude (px) — motion.md §4.1, the
 *  ONE sanctioned continuous idle animation (the wizard's hero only). */
export const IDLE_FLOAT_DELTA = 4;

/** One leg of the idle float's ~2.4s period (ms): down 1200, back 1200. */
export const IDLE_FLOAT_LEG_MS = 1200;

/** The granted moment's icon crossfade (motion.md §4.2, ~200ms). */
export const CROSSFADE_MS = 200;

// ── the R115-D connect-flow moments (motion.md §4.3/§4.4 + the QR scanner) ──

/** The connect hero's traveling-dash loop (motion.md §4.3, ~1.6s). */
export const LINK_LOOP_MS = 1600;

/** The scanner's traveling scan line — one full top→bottom pass (~1.8s). */
export const SCAN_TRAVEL_MS = 1800;

/** The full-screen pairing moment, chips→merge→typed name (motion.md §4.4, ~1.4s). */
export const PAIRING_MERGE_MS = 1400;

/** The pairing content crossfade (motion.md §4.4 — the whole screen swaps, 150ms). */
export const PAIRING_FADE_MS = 150;

// ── the R116 mechanical springs (motion.md §1 — the over-damped pair) ───────

/**
 * The SHEET spring — panels: no overshoot, EVER (motion.md §1). Anything that
 * carries a panel or a large surface rides this config; a bounce that reveals
 * the page background is a defect, not personality.
 */
export const SHEET_SPRING: WithSpringConfig = {
  stiffness: 210,
  damping: 30,
};

/**
 * The TAB spring — the calm indicator slide (motion.md §1): over-damped so
 * the selection pill glides to its slot and settles without overshoot.
 */
export const TAB_SPRING: WithSpringConfig = {
  stiffness: 200,
  damping: 26,
};

/**
 * The tab label's expand/collapse timing (motion.md §4.7, ~200ms): the
 * selected item's label breathes in (maxWidth + opacity) while the previous
 * one collapses out — the icon never jumps, the reflow stays animated.
 */
export const TAB_LABEL_MS = 200;

// ── the R115-N chart entries (motion.md §4.6 — once per data load) ──────────

/** The daily bars' baseline grow (motion.md §4.6: withTiming 350ms, staggered). */
export const CHART_BAR_GROW_MS = 350;

/** The per-bar entry stagger (motion.md §4.6: 12ms between columns). */
export const CHART_BAR_STAGGER_MS = 12;

/** The donut's arc sweep (motion.md §4.6 + §7's "deliberate" tier: 500ms). */
export const DONUT_SWEEP_MS = 500;

// ── the R118 disclosure motion (the owner's round-118 rulings: the expand
// keeps its bounce but SMOOTHER — one soft settle, no jelly; the collapse
// NEVER bounces — a timing curve cannot overshoot by construction) ──────────

/**
 * The accordion/disclosure EXPAND — the house spring one damping step up:
 * ζ = 24/(2√180) = 0.894 (SPRING's 0.820 settles in 2–3 visible cycles ≈
 * 1.2s; this settles in one ≈ 0.6s). A 420px well that pogoed ~4.6px now
 * breathes ~0.8px past — the bounce the owner likes survives as a whisper.
 */
export const DISCLOSURE_SPRING: WithSpringConfig = {
  stiffness: 180,
  damping: 24,
};

/** The COLLAPSE timing — 200ms ease-out, zero overshoot by construction. */
export const DISCLOSURE_COLLAPSE_MS = 200;

/** The collapse's content fade — lands slightly ahead of the height. */
export const DISCLOSURE_FADE_MS = 150;
