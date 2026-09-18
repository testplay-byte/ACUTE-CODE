/**
 * ROUND-105 (R105-C): the provider LESSONS storage — the persistence half
 * of the rate-limit REASON taxonomy. The runtime's two catch blocks call
 * recordProviderLesson() on every rate_limit failure whose body/status
 * says WHY (quota | rate | capacity — agents/error-classification.ts);
 * the rows accumulate as the honest, queryable memory of what actually
 * fails on the owner's machine, ready for the R106 surfacing
 * (ModelsProvidersTab "this model burned its daily cap N times" badges)
 * and the roles/fallback-chain seeding (docs/planning/
 * OMP-ADOPTION-ROADMAP.md candidate #3/#4).
 *
 * Write-only-by-design this round: no routes, no UI — listProviderLessons
 * exists for tests and the future read paths. The module follows the
 * storage/ idioms (SqliteDatabase in, better-sqlite3 prepared statements,
 * never throws across the API boundary — a failed lesson write must never
 * take a turn down with it).
 */
import type { SqliteDatabase } from "./db.js";

/** The lesson taxonomy — mirrors error-classification.ts's RateLimitReason
 * (string-level here: storage stays free of the agents/ import graph). */
export type ProviderLessonReason = "quota" | "rate" | "capacity";

export interface ProviderLessonRow {
  providerId: string;
  model: string;
  reason: ProviderLessonReason;
  count: number;
  firstTs: number;
  lastTs: number;
}

/**
 * Upsert one lesson: (provider, model, reason) → count + 1, last_ts = now
 * (first_ts survives from the row's birth). Silent no-op on a reason the
 * table's CHECK rejects or any db hiccup — the lesson is telemetry, never
 * a turn-risk. Called from the runtime catches BEFORE the key-swap branch
 * so a lesson lands even when a pool juggle handles the failure.
 */
export function recordProviderLesson(
  db: SqliteDatabase,
  providerId: string,
  model: string,
  reason: ProviderLessonReason,
): void {
  try {
    const now = Date.now();
    db.prepare(
      `INSERT INTO provider_lessons (provider_id, model, reason, count, first_ts, last_ts)
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT (provider_id, model, reason)
       DO UPDATE SET count = count + 1, last_ts = excluded.last_ts`,
    ).run(providerId, model, reason, now, now);
  } catch {
    // A failed lesson write must never take the turn down (the telemetry
    // rule): swallow, move on. The log line in the runtime catch already
    // carries the same reason for post-hoc analysis.
  }
}

/** Every lesson row, most-recent first — the test + future-route read. */
export function listProviderLessons(db: SqliteDatabase): ProviderLessonRow[] {
  try {
    const rows = db
      .prepare(
        `SELECT provider_id, model, reason, count, first_ts, last_ts
         FROM provider_lessons
         ORDER BY last_ts DESC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      providerId: String(row.provider_id),
      model: String(row.model),
      reason: String(row.reason) as ProviderLessonReason,
      count: Number(row.count),
      firstTs: Number(row.first_ts),
      lastTs: Number(row.last_ts),
    }));
  } catch {
    return [];
  }
}
