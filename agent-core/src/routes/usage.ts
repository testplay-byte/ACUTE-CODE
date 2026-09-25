// ─────────────────────────────────────────────────────────────────────────────
// R84 (Wave 2-a): the usage-analytics domain (SPEC §F7 + ROUND-52 R52-b).
//
// Registers, in the original server.ts registration order: GET
// /usage/summary (the dashboard chart) and GET /usage/detailed (the in-app
// /usage screen), then ROUND-98's GET /usage/stats + DELETE /usage/data
// (the Data & Statistics surface — R98-I2).
//
// Provenance: extracted verbatim from server.ts in R84 (Wave 2-a) —
// behavior-identical, test-guarded. The PUBLIC usage.json export lives in
// scripts/export-usage.mjs (same aggregation plus redaction); these links
// are the private bearer-token loopback, so real ids/titles/roles are the
// point. No usage EXPORT route exists server-side (checked honestly — the
// export is the script, not a route).
// ─────────────────────────────────────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.js";
import { getDetailedUsage, getUsageStats, getUsageSummary, clearUsageData } from "../storage/usage.js";
import { errorBody } from "./helpers.js";

export function registerUsageRoutes(scope: FastifyInstance, ctx: RouteContext): void {
  const { db } = ctx;
  // ---- Usage summary (SPEC §F7 dashboard chart) ----

  scope.get("/usage/summary", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    let days = 14;
    if (query.days !== undefined) {
      const parsed = Number(query.days);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 90) {
        return reply.code(400).send(
          errorBody("VALIDATION", "days must be an integer between 1 and 90", {
            field: "query.days",
          }),
        );
      }
      days = parsed;
    }
    return getUsageSummary(db, { days });
  });

  // ---- ROUND-52 (R52-b): detailed usage analytics — the in-app /usage
  // screen (owner: "Usage screen section 2 … you apparently did not
  // implement the usage properly"). Same aggregation the PUBLIC
  // usage.json export runs (scripts/export-usage.mjs) minus its
  // redaction: this link is the private bearer-token loopback, so real
  // ids/titles/roles are the point. `days` scopes only the zero-filled
  // activity series; totals/tools/models/projects are whole-history. ----

  scope.get("/usage/detailed", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    let days = 30;
    if (query.days !== undefined) {
      const parsed = Number(query.days);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 90) {
        return reply.code(400).send(
          errorBody("VALIDATION", "days must be an integer between 1 and 90", {
            field: "query.days",
          }),
        );
      }
      days = parsed;
    }
    // ROUND-127 (the hourly view): `granularity=hour` re-buckets the
    // activity series by UTC hour (the 7-day view's dense rendering — the
    // owner: "instead of seven days, it would show me a much better kind of
    // view, like hourly based"). Bounded to days ≤ 14 (≤ 336 zero-filled
    // buckets) so the response stays lean; absent/`day` keeps the
    // byte-identical historical shape (mobile + dashboard + tests green).
    let granularity: "day" | "hour" = "day";
    if (query.granularity !== undefined) {
      if (query.granularity !== "day" && query.granularity !== "hour") {
        return reply.code(400).send(
          errorBody("VALIDATION", "granularity must be 'day' or 'hour'", {
            field: "query.granularity",
          }),
        );
      }
      if (query.granularity === "hour" && days > 14) {
        return reply.code(400).send(
          errorBody("VALIDATION", "granularity=hour requires days ≤ 14 (hourly windows cap at 336 buckets)", {
            field: "query.granularity",
          }),
        );
      }
      granularity = query.granularity;
    }
    return getDetailedUsage(db, { days, granularity });
  });

  // ---- ROUND-98 (R98-I2, owner: "Data & statistics"): the windowed stats
  // surface (GET /usage/stats) — totals, peak day, the per-day × per-model
  // series for the heatmap + model-mix chart, the model leaderboard, and
  // agent health over a calendar-month window. `months` defaults to 12,
  // validates as an integer 1–24 (the same 400 idiom as days above).
  // Same bearer wall as the two routes above. ----

  scope.get("/usage/stats", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    let months = 12;
    if (query.months !== undefined) {
      const parsed = Number(query.months);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 24) {
        return reply.code(400).send(
          errorBody("VALIDATION", "months must be an integer between 1 and 24", {
            field: "query.months",
          }),
        );
      }
      months = parsed;
    }
    return getUsageStats(db, { months });
  });

  // ---- ROUND-98 (R98-I2, owner: "clear-all-data"): DELETE /usage/data —
  // wipes the usage_events LEDGER ONLY (see clearUsageData's docblock for
  // the exact cleared/untouched enumeration) and returns the deleted-row
  // count as {deleted}. ----

  scope.delete("/usage/data", async () => {
    return { deleted: clearUsageData(db) };
  });
}
