import type { Transition, Variants } from "framer-motion";

/**
 * Shared motion language ported from the owner's dashboard demo
 * (acute-agent-dashboard/src/lib/dashboard-helpers.ts). Subtle 0.2–0.4 s
 * transitions on one easing curve — keep every animated surface on these.
 *
 * ROUND-126 (the Clay Companion redesign): the mobile constitution's
 * spring grammar joins (mobile/src/design/motion.ts, verbatim numbers —
 * framer-motion takes the same {stiffness, damping} reanimated does).
 * Springs own INTERACTIVE moments (presses, entrances, panels, tabs);
 * the timed `ease` legs own ambient/CSS transitions. MOTION.md §1–2 is
 * the binding contract — never hand-roll a spring in a component; import
 * it here so the numbers stay one-palace.
 */

/** The one house spring — presses, toggles, entrances, state morphs. */
export const SPRING: Transition = { type: "spring", stiffness: 180, damping: 22 };

/** Mechanical panels/dialogs — one soft settle (ζ ≈ 0.89), never jelly. */
export const SHEET_SPRING: Transition = { type: "spring", stiffness: 180, damping: 24 };

/** Accordion/disclosure expand — the same over-damped settle as sheets
 * (mobile DISCLOSURE_SPRING; collapse is a TIMING, never a spring —
 * MOTION.md §2). */
export const DISCLOSURE_SPRING: Transition = SHEET_SPRING;

/** The calm slide — tab indicators, segmented-control knobs. */
export const TAB_SPRING: Transition = { type: "spring", stiffness: 200, damping: 26 };

/** List entrance stagger (mobile STAGGER_STEP_MS). */
export const STAGGER_STEP_MS = 0.03;

/** The fade-in-up rise (mobile ENTRANCE_DELTA). */
export const ENTRANCE_DELTA = 8;

/** The house press scale (mobile PRESS_SCALE). */
export const PRESS_SCALE = 0.98;

/** The live rhythm — opacity 0.25↔1, each way (chat carets, live tails). */
export const LIVE_CARET_LEG_MS = 550;

export const ease = [0.25, 0.1, 0.25, 1] as const;

export const fadeInUp: Variants = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.4, ease } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.2, ease } },
};

export const staggerContainer: Variants = {
  animate: { transition: { staggerChildren: 0.06, delayChildren: 0.1 } },
};

export const staggerItem: Variants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.3, ease } },
};

export const scaleIn: Variants = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1, transition: { duration: 0.3, ease } },
};

/** Shell-level entrance for panels (sidebar slides, topbar drops). */
export const slideInLeft: Variants = {
  initial: { opacity: 0, x: -16 },
  animate: { opacity: 1, x: 0, transition: { duration: 0.35, ease, delay: 0.05 } },
};

export const dropIn: Variants = {
  initial: { opacity: 0, y: -8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.35, ease } },
};
