/**
 * time-ago.ts — the short relative time the list rows share (R118-E, hoisted
 * verbatim from projects.tsx's private helper so the provider detail's key
 * meta line and any future row can reuse ONE spelling). Pure; no React
 * Native import (the jest suite is pure-logic by convention).
 */

/** The short relative time for list rows (s/m/h/d, honest at any age).
 *  "just now" under a minute; a future or unparseable timestamp clamps to
 *  "just now" (Math.max(0, …)) — never a negative age on screen. `now` is
 *  injectable for the tests. */
export function timeAgoShort(then: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
