/**
 * ROUND-52 (R52-b): shared formatting for the Usage screen — ported from the
 * DASHBOARD build's fmt helpers (build.mjs) so the in-app numbers read exactly
 * like the owner-approved public usage page. App-wide formatters live in
 * src/lib/format.ts; these three are usage-screen-specific (duration, money,
 * compact counts for dense rows).
 */

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
