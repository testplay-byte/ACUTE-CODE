// ─────────────────────────────────────────────────────────────────────────────
// ROUND-122 (the owner's self-feedback directive): the FEEDBACK LEDGER
// domain — the settings section's file surface.
//
//   GET    /api/v1/feedback/file   → the raw ledger (content + honest
//                                    meta: exists/bytes/updatedAt/entries).
//                                    Phone-reachable (the device-token
//                                    blocklist does NOT include this path):
//                                    a paired phone viewing the ledger is
//                                    exactly the R109 "view" trust level.
//   DELETE /api/v1/feedback/file   → wipe the ledger (the settings
//                                    viewer's Clear action). SHELL-ONLY:
//                                    the route-local rejectDeviceTokens
//                                    guard (the settings.ts cloud-connector
//                                    pattern) — the PATH blocklist cannot
//                                    split GET from DELETE on one path, so
//                                    the method split is enforced here,
//                                    where it lives.
//   DELETE /api/v1/feedback/file/entry/:index → delete ONE entry by its
//                                    0-based top-down index (ROUND-123: the
//                                    viewer's per-entry Delete). SHELL-ONLY
//                                    (the same wipe-class guard); the answer
//                                    is idempotent-honest ({removed:false}
//                                    for a stale index, never a 404).
//
// The GET never 404s: a ledger that was never written serves its honest
// empty state { exists:false, content:"", … } (the mobile-link off-state
// pattern). Both routes answer 503 when ctx.dataDir is undefined (the R42
// hermetic-tests contract — no machine-scoped directory, no ledger).
//
// The toggle itself is NOT here: GET/PUT /settings/feedback lives in
// routes/settings.ts beside its debug sibling (one domain registry, the
// R113 broadcast rides every PUT).
// ─────────────────────────────────────────────────────────────────────────────
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RouteContext } from "./context.js";
import { deviceAuthOf } from "./context.js";
import { errorBody } from "./helpers.js";
import {
  clearFeedbackLedger,
  deleteFeedbackEntry,
  readFeedbackLedger,
} from "../storage/feedback-ledger.js";

/** The settings.ts cloud-connector pattern, verbatim in intent: true =
 * rejected (the 403 reply is already sent). The route-local guard is the
 * ONLY device wall for this path — GET on the same path must stay
 * phone-reachable, so the server-level PATH blocklist cannot be used. */
function rejectDeviceTokens(request: FastifyRequest, reply: FastifyReply): boolean {
  if (deviceAuthOf(request) === null) return false;
  reply.code(403).send(
    errorBody("FORBIDDEN", "this route requires the shell token (device tokens are not allowed here)", {
      hint: "clearing the feedback ledger is a desktop-side action; viewing it is open to paired devices",
    }),
  );
  return true;
}

export function registerFeedbackRoutes(scope: FastifyInstance, ctx: RouteContext): void {
  // The ledger file lives in the machine-scoped data directory (beside
  // vapid.json); without it there is no honest answer except the R42
  // off-state (hermetic tests / no machine identity).
  scope.get("/feedback/file", async (_request, reply) => {
    if (ctx.dataDir === undefined) {
      return reply.code(503).send(
        errorBody("SERVICE_UNAVAILABLE", "the feedback ledger requires the machine-scoped data directory", {
          hint: "the sidecar passes the SQLite file's directory; dev servers without one have no ledger",
        }),
      );
    }
    return readFeedbackLedger(ctx.dataDir);
  });

  scope.delete("/feedback/file", async (request, reply) => {
    if (rejectDeviceTokens(request, reply)) return reply;
    if (ctx.dataDir === undefined) {
      return reply.code(503).send(
        errorBody("SERVICE_UNAVAILABLE", "the feedback ledger requires the machine-scoped data directory", {
          hint: "the sidecar passes the SQLite file's directory; dev servers without one have no ledger",
        }),
      );
    }
    // Serialized on the ledger's write chain (a concurrent append lands
    // AFTER the wipe, never half-cleared). The wiped entry count rides
    // the reply — the confirmation line is honest, never assumed.
    const wiped = await clearFeedbackLedger(ctx.dataDir);
    return { cleared: true, entries: wiped.entries };
  });

  // ROUND-123 (R123): the PER-ENTRY delete — the viewer's per-card Delete
  // action. The index is the file's own top-down "## Entry — " order (the
  // same order the viewer renders); a stale index answers the honest
  // {removed:false} idempotent no-op, never a 404 (the viewer's list may
  // simply be one refresh behind a fresh append).
  scope.delete("/feedback/file/entry/:index", async (request, reply) => {
    if (rejectDeviceTokens(request, reply)) return reply;
    if (ctx.dataDir === undefined) {
      return reply.code(503).send(
        errorBody("SERVICE_UNAVAILABLE", "the feedback ledger requires the machine-scoped data directory", {
          hint: "the sidecar passes the SQLite file's directory; dev servers without one have no ledger",
        }),
      );
    }
    const params = request.params as { index?: string };
    const index = Number.parseInt(params.index ?? "", 10);
    if (!Number.isInteger(index) || index < 0) {
      return reply.code(400).send(
        errorBody("VALIDATION", "the entry index must be a non-negative integer", {
          field: "params.index",
        }),
      );
    }
    const outcome = await deleteFeedbackEntry(ctx.dataDir, index);
    return { removed: outcome.removed, entries: outcome.entries };
  });
}
