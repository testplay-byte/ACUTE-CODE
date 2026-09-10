// ─────────────────────────────────────────────────────────────────────────────
// R84 (Wave 2-a): the usage-analytics domain (SPEC §F7 + ROUND-52 R52-b).
//
// Registers, in the original server.ts registration order: GET
// /usage/summary (the dashboard chart) and GET /usage/detailed (the in-app
// /usage screen).
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
import { getDetailedUsage, getUsageSummary } from "../storage/usage.js";
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
    return getDetailedUsage(db, { days });
  });
}
