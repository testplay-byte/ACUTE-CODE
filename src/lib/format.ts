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

/**
 * ROUND-50 (R50-c2): the composer's shared token formatter — identical math to
 * formatTokenCount (lowercase "k" to stay consistent with the chat's existing
 * per-reply stat chips) so every context-donut / breakdown / session-total
 * number in the composer renders through ONE helper. Additive only.
 */
export function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * ROUND-50 (R50-c2): human byte size for attachment chips ("412 B",
 * "1.2 KB", "3.4 MB"). Additive only.
 */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n >= 10_240 ? 0 : 1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
