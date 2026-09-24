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
//   GET    /api/v1/feedback/status → ROUND-125 (R125-B): the LIVE writing
//                                    state — the registry the reporter
//                                    reports into (writing/phase/session/
//                                    last write) + the setting + the file's
//                                    own numbers. This is the route the
//                                    owner's complaint asked for ("it did
//                                    not show me the processing of the
//                                    feedback ledger … the info of when it
//                                    was being written"): the file route
//                                    can only show FINISHED entries — the
//                                    strip needs the in-flight write.
//                                    Phone-reachable exactly like the file
//                                    GET (viewing is the R109 "view" trust
//                                    level; STATUS is not CONTENT, so the
//                                    separation law holds — no entry words
//                                    ever ride this reply).
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
// The GETs never 404: a ledger that was never written serves its honest
// empty state { exists:false, content:"", … } (the mobile-link off-state
// pattern). All routes answer 503 when ctx.dataDir is undefined (the R42
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
// R125-B: the live registry (the reporter's own begin/end reports) + the
// clear-route reset. getFeedbackSettings is imported the same way sse.ts
// imports it — the SAME accessor the /settings/feedback routes use, so the
// status route and the turn-time gate can never disagree about "enabled".
import { readFeedbackStatus, resetFeedbackWriteStatus } from "../agents/feedback-status.js";
import { getFeedbackSettings } from "../storage/settings.js";

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

  // ── ROUND-125 (R125-B): the LIVE STATUS surface — GET /feedback/status.
  // One object joins THREE sources, each owned by its own module: the
  // in-process registry the reporter reports into (writing/phase/session/
  // last write — the part NO file read can show), the settings row
  // (enabled, via the same accessor the turn-time gate uses), and the
  // ledger file's own honest numbers (entries/bytes — re-measured HERE so
  // the strip and the viewer can never disagree after a clear or a delete).
  // Phone-reachable by the same reasoning as the file GET above: status is
  // the R109 "view" trust level, and the reply carries NO entry content.
  scope.get("/feedback/status", async (_request, reply) => {
    if (ctx.dataDir === undefined) {
      return reply.code(503).send(
        errorBody("SERVICE_UNAVAILABLE", "the feedback ledger requires the machine-scoped data directory", {
          hint: "the sidecar passes the SQLite file's directory; dev servers without one have no ledger",
        }),
      );
    }
    const status = readFeedbackStatus();
    const ledger = readFeedbackLedger(ctx.dataDir);
    return {
      enabled: getFeedbackSettings(ctx.db).enabled,
      writing: status.writing,
      phase: status.phase,
      sessionId: status.sessionId,
      startedAt: status.startedAt,
      lastWriteTs: status.lastWriteTs,
      lastWriteOutcome: status.lastWriteOutcome,
      // The FILE's live numbers — the registry's lastEntries describes the
      // moment of the last write; these two describe RIGHT NOW (a Clear or
      // a per-entry delete between writes must be reflected immediately).
      entries: ledger.entries,
      bytes: ledger.bytes,
      lastError: status.lastError,
    };
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
    // R125-B: the wipe also resets the status registry's LAST-WRITE fields
    // — after a Clear there is no "last entry" to point at, and the live
    // strip's "Last entry … · N entries" line would describe a file that
    // no longer exists (the registry's LIVE fields stay: a write in flight
    // while the owner clears is still in flight, and its entry re-creates
    // the file when it lands — the write chain orders them honestly).
    resetFeedbackWriteStatus();
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
