/** Subtle timestamp formatting for chat bubbles and session rows. */

/** "14:05" style clock time for message bubbles. */
export function formatTime(iso: string): string {
  if (!iso) return "sending…";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** "14:05" today, otherwise "Aug 21" — for session list rows. */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (new Date().toDateString() === date.toDateString()) return formatTime(iso);
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Compact token count for stat cards and chart labels ("12K", "1.3K", "850"),
 * ported from the dashboard demo's fmtTokens.
 */
export function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}
