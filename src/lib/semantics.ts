/**
 * Single home for the two semantic status colors used by the project-chat
 * screen (tool-status chip ok/failed, diff +/- counters). These are
 * intentional, documented exceptions to the only-useThemeStyles()/--ac-* rule:
 * like traffic-light colors they carry meaning (green = success, red = danger)
 * across every theme and mode. To be folded into ThemeStyles if the theme
 * table ever grows per-mode semantic tokens.
 */
export const SEMANTIC_COLORS = {
  success: "#22c55e",
  danger: "#ef4444",
} as const;
