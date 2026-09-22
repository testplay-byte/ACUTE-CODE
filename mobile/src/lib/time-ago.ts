/**
 * time-ago.ts — the short relative time the list rows share (R118-E, hoisted
 * verbatim from projects.tsx's private helper so the provider detail's key
 * meta line and any future row can reuse ONE spelling). Pure; no React
 * Native import (the jest suite is pure-logic by convention).
 */

/** The short relative time for list rows (s/m/h/d, honest at any age).
 *  "just now" under a MINUTE — the unified boundary across every spelling
 *  (R118-review WARN 2: the three helpers forked at 45s vs 60s, and the
 *  45–59s band produced "0m ago" in two of them — one law now: under 60s
 *  is "just now", the minutes band starts at 1); a future or unparseable
 *  timestamp clamps to "just now" (Math.max(0, …)) — never a negative age
 *  on screen. `now` is injectable for the tests. */
export function timeAgoShort(then: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.max(1, Math.floor(s / 60));
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
