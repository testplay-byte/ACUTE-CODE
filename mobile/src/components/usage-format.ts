/**
 * usage-format.ts — R118-C §3.3: the dashboard's PURE formatting + status
 * vocabulary. Every number/date/status spelling the screen and its section
 * components share lives here, in ONE module with ZERO React Native imports
 * (the mobile suite's pure-logic convention, jest.config.js — the jest suite
 * pins these tables in __tests__/usage-format.test.ts without pulling the
 * native bridge off the shelf).
 *
 * The component module (usage-cards.tsx) RE-EXPORTS every name below, so the
 * existing `@/components/usage-cards` import paths keep working — zero
 * consumer churn. The functions themselves moved verbatim from
 * usage-cards.tsx (their call-site shapes are do-not-touch, R118-C §6).
 *
 *   formatTokens / formatUsd / formatCount — the number ladder
 *   shortDate / formatClock / localDateString — the calendar-LOCAL dates
 *   timeAgoFromIso — the shared "5m ago" vocabulary (host-card's grammar,
 *                    inlined so this module stays RN-free)
 *   sessionStatusBadge — the honest status law (§2.6: queued shows NOTHING)
 *   sessionLastActivityIso — endedAt ?? startedAt
 *   PERIOD_OPTIONS — the 14d/30d/3mo selector's vocabulary
 *   chartAxisTicks — R124: the daily chart's date-tick index ladder (pure)
 */

// ── the period selector's vocabulary (§2.1) ─────────────────────────────────

/** The dashboard's three windows — the wire's own days/months vocabulary. */
export type PeriodKey = "14d" | "30d" | "3mo";

export interface PeriodOption {
  key: PeriodKey;
  /** The display label — SHORT (≤4 chars; the segmented control's tier). */
  label: string;
  /** The full window name for screen readers (the display label is terse). */
  accessibilityLabel: string;
}

/** The three segments, in selector order — 14d · 30d · 3mo. */
export const PERIOD_OPTIONS: ReadonlyArray<PeriodOption> = [
  { key: "14d", label: "14d", accessibilityLabel: "last 14 days" },
  { key: "30d", label: "30d", accessibilityLabel: "last 30 days" },
  { key: "3mo", label: "3mo", accessibilityLabel: "last 3 months" },
];

// ── the number ladder (moved verbatim from usage-cards.tsx) ─────────────────

/** 999 → "999" · 1234 → "1.2k" · 3_400_000 → "3.4M" · 2_100_000_000 → "2.1B". */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  const units: ReadonlyArray<readonly [number, string]> = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "k"],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const scaled = value / size;
      const text =
        Math.abs(scaled) >= 100 ? String(Math.round(scaled)) : String(Math.round(scaled * 10) / 10);
      return `${text}${suffix}`;
    }
  }
  return String(value);
}

/** "$0.0000" for dust → "$0.500" → "$1.23" — 2 decimals once it matters, 4 when it doesn't. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs === 0) return "$0.00";
  if (abs >= 1) return `$${value.toFixed(2)}`;
  if (abs >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

/** 1234 → "1,234" (deterministic en-US grouping). */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("en-US");
}

// ── the dates (calendar-LOCAL, never timezone-shifted) ──────────────────────

/** "2026-09-01" → "Sep 1" — parsed calendar-LOCAL, never timezone-shifted. */
export function shortDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (m !== null) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  }
  const t = new Date(date).getTime();
  return Number.isNaN(t) ? date : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** ISO → "3:42 PM" (the generated-at footer's clock). */
export function formatClock(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

/** The calendar-LOCAL "YYYY-MM-DD" for a Date — the today-anchor's honest
 *  comparison key (a day bucket IS today only when its date string matches
 *  the device's own calendar day, never a UTC-shifted one). */
export function localDateString(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ── the relative-time vocabulary ─────────────────────────────────────────────

/**
 * The quiet relative word — "just now" … "2h ago" … "3d ago" — byte-identical
 * to host-card's timeAgo grammar, INLINED here so this module carries zero
 * React Native imports (host-card renders). If the vocabulary ever forks,
 * __tests__/usage-format.test.ts fails on the table.
 */
function relativeTimeWord(then: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  // R118-review WARN 2 — the unified boundary: "just now" under a MINUTE and
  // the minutes band starts at 1 (the old <45s fork rendered "0m ago" for
  // 45–59s across two of the three spellings).
  if (seconds < 60) return "just now";
  const minutes = Math.max(1, Math.floor(seconds / 60));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** ISO → "5m ago" / "3d ago" (the shared timeAgo vocabulary; `now` injectable
 *  so the test table is deterministic). An unparseable ISO passes through. */
export function timeAgoFromIso(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : relativeTimeWord(t, now);
}

// ── the daily chart's time axis (R124 — the redesigned chart's tick ladder) ──

/**
 * R124 — the daily chart's axis-tick ladder: which day indices carry a date
 * label. The wire's series is zero-filled and contiguous (config.ts's own
 * contract note on UsageSummary.days), so even INDEX spacing is even DATE
 * spacing — no calendar math needed for evenness. The FIRST and LAST indices
 * are always included (the last is the "today" edge whenever the series ends
 * on the device's calendar day), the count never exceeds `maxTicks`, and no
 * index ever repeats. Pure (the component maps each index to shortDate).
 */
export function chartAxisTicks(dayCount: number, maxTicks: number): number[] {
  if (!Number.isFinite(dayCount) || dayCount <= 0) return [];
  const n = Math.floor(dayCount);
  const cap = Math.max(2, Math.floor(maxTicks));
  if (n <= cap) return Array.from({ length: n }, (_, index) => index);
  const step = (n - 1) / (cap - 1);
  const ticks: number[] = [];
  for (let i = 0; i < cap; i++) {
    const index = Math.min(n - 1, Math.round(i * step));
    if (ticks.length === 0 || ticks[ticks.length - 1] !== index) ticks.push(index);
  }
  return ticks;
}

// ── the session status law (§2.6 — the honest tag) ──────────────────────────

export type SessionBadgeTone = "success" | "warning" | "danger" | "neutral";

export interface SessionStatusBadge {
  label: string;
  tone: SessionBadgeTone;
}

/**
 * THE HONEST STATUS LAW (R118-C §2.6): a Badge renders ONLY when the status
 * says something — `queued` returns NULL and the absence of the badge IS the
 * information (the old every-row "open" was noise with zero variance).
 * running → warning, completed → "done" success, failed/cancelled → danger
 * ("failed"/"stopped"), an unknown RAW wire status → neutral under its own
 * spelling, an empty string → nothing at all.
 */
export function sessionStatusBadge(status: string): SessionStatusBadge | null {
  switch (status) {
    case "queued":
      return null;
    case "running":
      return { label: "running", tone: "warning" };
    case "completed":
      return { label: "done", tone: "success" };
    case "failed":
      return { label: "failed", tone: "danger" };
    case "cancelled":
      return { label: "stopped", tone: "danger" };
    default:
      return status.trim() === "" ? null : { label: status, tone: "neutral" };
  }
}

/** The session's last-activity timestamp — endedAt ?? startedAt (a running
 *  session's activity is its start; an empty well is null). */
export function sessionLastActivityIso(session: {
  endedAt: string | null;
  startedAt: string | null;
}): string | null {
  return session.endedAt ?? session.startedAt;
}
