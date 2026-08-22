/**
 * Usage-summary repository (SPEC §F7 dashboard): SQL aggregation over the
 * append-only `usage_events` log grouped by calendar day, zero-filled in JS
 * for days without traffic so the chart gets a dense ascending series.
 */
import type Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;

/** One day bucket as served by GET /api/v1/usage/summary. */
export interface UsageDayBucket {
  /** UTC calendar date, "YYYY-MM-DD" — matches SQLite date(ts) on ISO strings. */
  date: string;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  costUsd: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  requests: number;
  costUsd: number;
}

export interface UsageSummary {
  days: UsageDayBucket[];
  totals: UsageTotals;
  generatedAt: string;
}

interface UsageAggregateRow {
  date: string;
  input_tokens: number | null;
  output_tokens: number | null;
  requests: number;
  cost_usd: number | null;
}

const MS_PER_DAY = 86_400_000;

/** UTC day key `daysBack` days before today (UTC arithmetic; DST-immune). */
function utcDayKey(daysBack: number): string {
  const now = new Date();
  const todayUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(todayUtcMidnight - daysBack * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Sums of REAL columns pick up binary-float noise; money fields get trimmed. */
function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Per-day usage for the last `options.days` UTC calendar days ending today,
 * ordered ascending and zero-filled. Days are cut on UTC boundaries because
 * that is exactly what SQLite's date(ts) buckets the stored ISO-8601 ts by.
 */
export function getUsageSummary(db: SqliteDatabase, options: { days: number }): UsageSummary {
  const firstDay = utcDayKey(options.days - 1);
  const rows = db
    .prepare(
      `SELECT date(ts) AS date,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              COUNT(*) AS requests,
              SUM(cost_usd) AS cost_usd
       FROM usage_events
       WHERE date(ts) >= ? AND date(ts) <= ?
       GROUP BY date(ts)`,
    )
    .all(firstDay, utcDayKey(0)) as UsageAggregateRow[];

  const byDate = new Map(rows.map((row) => [row.date, row]));
  const days: UsageDayBucket[] = [];
  for (let back = options.days - 1; back >= 0; back -= 1) {
    const date = utcDayKey(back);
    const row = byDate.get(date);
    days.push({
      date,
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      requests: row?.requests ?? 0,
      costUsd: roundUsd(row?.cost_usd ?? 0),
    });
  }

  const totals = days.reduce<UsageTotals>(
    (sum, day) => ({
      inputTokens: sum.inputTokens + day.inputTokens,
      outputTokens: sum.outputTokens + day.outputTokens,
      requests: sum.requests + day.requests,
      costUsd: roundUsd(sum.costUsd + day.costUsd),
    }),
    { inputTokens: 0, outputTokens: 0, requests: 0, costUsd: 0 },
  );

  return { days, totals, generatedAt: new Date().toISOString() };
}
