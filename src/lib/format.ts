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
 * Compact token count for stat cards and chart labels ("12K", "1.3K",
 * "850", "2.4M", "300M"), ported from the dashboard demo's fmtTokens.
 * R91-H (the owner: "the total amount of tokens used can be shown in
 * millions too… If the user has used 300 million tokens, then it will show
 * 300m instead of showing 300 and then more zeros"): the MILLION tier —
 * ≥ 1M renders as M (one decimal below 10M, whole numbers above). The
 * dashboard + usage stat cards both render through this helper.
 */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    // parseFloat strips the trailing ".0" — 1M reads "1M", 300M reads
    // "300M" (the owner's exact example), 2.4M keeps its decimal.
    const v = parseFloat((n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1));
    return `${v}M`;
  }
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}

/**
 * ROUND-50 (R50-c2): the composer's shared token formatter — identical math to
 * formatTokenCount (lowercase "k"/"m" to stay consistent with the chat's
 * existing per-reply stat chips) so every context-donut / breakdown /
 * session-total number in the composer renders through ONE helper. Additive
 * only. R91-H: the million tier mirrors formatTokenCount.
 */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    const v = parseFloat((n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1));
    return `${v}m`;
  }
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
