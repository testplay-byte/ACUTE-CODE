// ─────────────────────────────────────────────────────────────────────────────
// R84 (Wave 2-a): the response-ratings domain (ROUND-59, R59-D — the owner's
// flagship request that round: "add the options to mark the responses as
// good or bad, and all of these will be tracked and saved… The full context
// will be properly shared").
//
// Registers, in the original server.ts registration order: POST
// /sessions/:id/ratings (the upsert on (session_id, assistant_seq)),
// GET /sessions/:id/ratings (the chat UI's rating map), GET /ratings (the
// ANALYSIS/EXPORT path with the full frozen context), and DELETE
// /ratings/:id (the same-thumb clear).
//
// Provenance: extracted verbatim from server.ts in R84 (Wave 2-a) —
// behavior-identical, test-guarded. Re-rating overwrites; one verdict per
// reply. The 200 body of the POST carries the row WITHOUT context (the chat
// UI only needs the verdict); the frozen snapshot is read back via GET
// /ratings. Storage + typed errors live in storage/ratings.ts.
// ─────────────────────────────────────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.js";
import { getSession } from "../storage/sessions.js";
// ROUND-59 (R59-D): the RESPONSE RATING system — every assistant reply can
// be rated good/bad and is persisted WITH a full context snapshot (the
// owner's "full context will be properly shared"), exportable for failure
// analysis. Storage + typed errors live in storage/ratings.ts.
import {
  MAX_RATING_NOTE_CHARS,
  RatingError,
  deleteRating,
  listRatings,
  listSessionRatings,
  rateReply,
} from "../storage/ratings.js";
import { errorBody } from "./helpers.js";

export function registerRatingRoutes(scope: FastifyInstance, ctx: RouteContext): void {
  const { db } = ctx;
  // ── ROUND-59 (R59-D): response ratings (the owner's flagship request
  // this round: "add the options to mark the responses as good or bad,
  // and all of these will be tracked and saved… The full context will be
  // properly shared"). POST upserts on (session_id, assistant_seq) —
  // re-rating overwrites, one verdict per reply. The 200 body carries the
  // row WITHOUT context (the chat UI only needs the verdict); the frozen
  // snapshot is read back via GET /ratings (the analysis path).
  scope.post("/sessions/:id/ratings", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    const raw = body as Record<string, unknown>;
    if (
      typeof raw.assistantSeq !== "number" ||
      !Number.isInteger(raw.assistantSeq) ||
      raw.assistantSeq <= 0
    ) {
      return reply.code(400).send(
        errorBody(
          "VALIDATION",
          "assistantSeq must be a positive integer (the event seq of the assistant reply being rated)",
          { field: "body.assistantSeq" },
        ),
      );
    }
    if (raw.rating !== "good" && raw.rating !== "bad") {
      return reply.code(400).send(
        errorBody("VALIDATION", "rating must be 'good' or 'bad'", { field: "body.rating" }),
      );
    }
    let note: string | undefined;
    if (raw.note !== undefined && raw.note !== null) {
      if (typeof raw.note !== "string") {
        return reply
          .code(400)
          .send(errorBody("VALIDATION", "note must be a string", { field: "body.note" }));
      }
      if (raw.note.length > MAX_RATING_NOTE_CHARS) {
        return reply.code(400).send(
          errorBody(
            "VALIDATION",
            `note must be at most ${MAX_RATING_NOTE_CHARS} characters`,
            { field: "body.note" },
          ),
        );
      }
      note = raw.note;
    }
    try {
      const rating = rateReply(db, {
        sessionId: id,
        assistantSeq: raw.assistantSeq,
        rating: raw.rating,
        note,
      });
      return reply.code(200).send({ rating });
    } catch (err) {
      if (err instanceof RatingError) {
        return reply.code(err.status).send(
          errorBody(err.code, err.message, err.field !== undefined ? { field: err.field } : undefined),
        );
      }
      throw err;
    }
  });

  // The session's verdicts for the chat UI's rating map — light views
  // (no context; the panel only needs {assistantSeq, rating, note}).
  scope.get("/sessions/:id/ratings", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    if (getSession(db, id) === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no session with id ${id}`));
    }
    return { ratings: listSessionRatings(db, id) };
  });

  // The ANALYSIS/EXPORT path: newest-first with the FULL frozen context
  // per rating (the data the dev agent dumps to determine "did it
  // perform the request which it was given properly or not"). Ratings
  // deliberately outlive session deletes, so an unknown sessionId filter
  // just yields an empty list. limit follows the /sessions tolerance
  // (clamped, default 200); a bad rating filter is an honest 400.
  scope.get("/ratings", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    let rating: "good" | "bad" | undefined;
    if (query.rating !== undefined) {
      if (query.rating !== "good" && query.rating !== "bad") {
        return reply.code(400).send(
          errorBody("VALIDATION", "rating filter must be 'good' or 'bad'", {
            field: "query.rating",
          }),
        );
      }
      rating = query.rating;
    }
    const limitRaw = Number(query.limit ?? 200);
    const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 200;
    return {
      ratings: listRatings(db, {
        ...(query.sessionId !== undefined && query.sessionId.trim() !== ""
          ? { sessionId: query.sessionId }
          : {}),
        ...(rating !== undefined ? { rating } : {}),
        limit,
      }),
    };
  });

  // Remove one verdict (the chat UI's same-thumb click clears it).
  scope.delete("/ratings/:id", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const rowId = Number(id);
    if (!Number.isInteger(rowId) || rowId <= 0) {
      return reply.code(400).send(
        errorBody("VALIDATION", "rating id must be a positive integer", {
          field: "params.id",
        }),
      );
    }
    if (!deleteRating(db, rowId)) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no rating with id ${rowId}`));
    }
    return { ok: true };
  });
}
