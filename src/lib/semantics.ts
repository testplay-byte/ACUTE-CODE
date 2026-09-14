/**
 * Single home for the semantic status colors used by the project-chat
 * screen (tool-status chip ok/failed, diff +/- counters). These are
 * intentional, documented exceptions to the only-useThemeStyles()/--ac-* rule:
 * like traffic-light colors they carry meaning (green = success, red = danger,
 * amber = wait/attention) across every theme and mode. To be folded into
 * ThemeStyles if the theme table ever grows per-mode semantic tokens.
 *
 * ROUND-97 (R97-I): `warning` is the amber the chat already spoke in ~31
 * undocumented sites (RetryStatusCard, the queued-message chips, the
 * thinking-loop stop card) — promoted to the documented home so the amber
 * is one value, not a scattered literal.
 */
export const SEMANTIC_COLORS = {
  success: "#22c55e",
  danger: "#ef4444",
  warning: "#f59e0b",
} as const;
