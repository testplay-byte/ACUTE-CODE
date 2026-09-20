/**
 * Shared helpers for the dashboard screen, ported from the owner's demo
 * (acute-agent-dashboard/src/lib/dashboard-helpers.ts): hex alpha compositing
 * for accent washes and the demo border-string helper. Motion variants live
 * in src/lib/motion.ts (shared app-wide). R113-d: useGreeting (the
 * time-of-day greeting hook) is deleted — the dashboard's page header died
 * with the owner's "unnecessary, unneeded, and not required" directive and
 * the greeting was NOT relocated anywhere.
 */

/** Compose an rgba() wash over a hex color; non-hex inputs pass through. */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (!m) return c;
  const int = Number.parseInt(m[1], 16);
  const r = (int >> 16) & 0xff;
  const g = (int >> 8) & 0xff;
  const b = int & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Demo `bdr()` — inline-style border shorthand. */
export const bdr = (width: string, color: string): string => `${width} solid ${color}`;

/** "Mon"-style UTC weekday for a YYYY-MM-DD bucket from the usage API. */
export function shortUtcDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
}

/** "Aug 9"-style UTC label for a YYYY-MM-DD bucket (tooltip header). */
export function utcDateLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
}

const CHIP_HUES = [22, 152, 210, 262, 340, 45, 96, 178] as const;

/**
 * Deterministic letter-chip color for an entity id (the demo colored chips per
 * project; we have no project colors yet, so hash stable ids into a fixed
 * pleasant-hue palette). Same id → same color across renders/sessions.
 */
export function chipColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  const h = Math.abs(hash) % CHIP_HUES.length;
  return `hsl(${CHIP_HUES[h]}, 72%, 52%)`;
}

/** First grapheme upper-cased for letter chips (demo pattern). */
export function initialOf(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}
