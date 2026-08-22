import type { Variants } from "framer-motion";

/**
 * Shared motion language ported from the owner's dashboard demo
 * (acute-agent-dashboard/src/lib/dashboard-helpers.ts). Subtle 0.2–0.4 s
 * transitions on one easing curve — keep every animated surface on these.
 */
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
