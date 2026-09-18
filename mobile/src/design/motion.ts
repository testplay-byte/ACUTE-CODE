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
