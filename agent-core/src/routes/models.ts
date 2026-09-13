// ─────────────────────────────────────────────────────────────────────────────
// R84 (Wave 2-a): the models domain (round-19 per-provider model metadata
// + pricing; R82's per-model test button).
//
// Registers, in the original server.ts registration order: PATCH
// /models/:id, DELETE /models/:id, POST /models/:id/test (the real
// completion probe), GET /models/catalog (the R47-b static catalog), and
// GET /models/configured (the R82 configured-rows listing).
//
// Provenance: extracted verbatim from server.ts in R84 (Wave 2-a) —
// behavior-identical, test-guarded. This module also owns the R50-d
// model-config field gate (readModelNumericFields / readModelScalarFields
// / readTriStateField), exported for routes/providers.ts' upsert route —
// both files validate identically by construction.
// ─────────────────────────────────────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.js";
import {
  ProviderTestError,
  resolveProvider,
  testModelResponse,
} from "../providers/registry.js";
import {
  DEFAULT_MODEL_ID,
  MODEL_CATALOG,
  RECOMMENDED_MODEL_IDS,
  SUBAGENT_DEFAULT_MODEL_ID,
  deleteModel,
  getModel,
  listAllModels,
  updateModel,
} from "../storage/models.js";
import { errorBody } from "./helpers.js";
// ROUND-95 (R95-B): the reasoning-support wire types (shared owns the
// vocabulary — never re-declared locally).
import {
  REASONING_EFFORT_LEVELS,
  type ModelReasoningSupport,
  type ReasoningEffortLevel,
} from "shared";

/* ── ROUND-50 (R50-d): model-config field gate ────────────────────────────────
 *
 * The owner now edits per-model pricing/context/limits through the Settings
 * → Models & Providers config dialog (POST /providers/:id/models upsert +
 * PATCH /models/:id). Both routes previously WHITELISTED the fields but
 * silently DROPPED any value of the wrong type — a patch that "saved" while
 * discarding the pricing the user typed. Every whitelisted field is now
 * validated strictly: a malformed value is a 400 VALIDATION naming the field.
 *
 * Nullability contract (mirrored by storage/models.ts upsertModel):
 *   number        → set the field
 *   null          → clear it back to "unknown" (NULL in the DB)
 *   absent        → leave the stored value untouched (upsert semantics)
 */
const MODEL_NUMERIC_FIELDS = [
  "contextWindow",
  "maxOutputTokens",
  "inputPricePerMtok",
  "inputPriceCachedPerMtok",
  "outputPricePerMtok",
] as const;

/** ROUND-87 (R87): the full tri-state capability set — the R82 trio plus
 * the R87 input/output columns. Shared by both routes' validation and
 * error messages so the upsert + PATCH gates stay identical by
 * construction (the module's own provenance contract). */
const MODEL_TRISTATE_FIELDS = [
  "supportsTools",
  "supportsAudio",
  "supportsVideo",
  "supportsPdf",
  "supportsTextOutput",
  "supportsImageOutput",
  "supportsVideoOutput",
  "supportsAudioOutput",
] as const;

export type ModelTriStateField = (typeof MODEL_TRISTATE_FIELDS)[number];

type ModelNumericValues = Partial<
  Record<(typeof MODEL_NUMERIC_FIELDS)[number], number | null>
>;

/** Reads the whitelisted numeric model fields off a raw JSON body.
 * Returns the values that are present, or the first offending field name
 * (mapped by the routes to 400 VALIDATION). */
export function readModelNumericFields(
  raw: Record<string, unknown>,
): { ok: true; values: ModelNumericValues } | { ok: false; field: string } {
  const values: ModelNumericValues = {};
  for (const field of MODEL_NUMERIC_FIELDS) {
    const value = raw[field];
    if (value === undefined) continue;
    if (value === null || typeof value === "number") {
      values[field] = value;
      continue;
    }
    return { ok: false, field };
  }
  return { ok: true, values };
}

/** Strict gate for the non-numeric model-config fields: displayName must be a
 * string, the toggles booleans. Returns the offending field name for 400s. */
export function readModelScalarFields(
  raw: Record<string, unknown>,
): { ok: true } | { ok: false; field: string } {
  if (raw.displayName !== undefined && typeof raw.displayName !== "string") {
    return { ok: false, field: "displayName" };
  }
  if (raw.supportsThinking !== undefined && typeof raw.supportsThinking !== "boolean") {
    return { ok: false, field: "supportsThinking" };
  }
  if (raw.hidden !== undefined && typeof raw.hidden !== "boolean") {
    return { ok: false, field: "hidden" };
  }
  // ROUND-61 (R61): the vision flag — same boolean gate as thinking.
  if (raw.supportsVision !== undefined && typeof raw.supportsVision !== "boolean") {
    return { ok: false, field: "supportsVision" };
  }
  // ROUND-82 (R82) + ROUND-87 (R87): the tri-state capability flags —
  // boolean OR null (null = reset to unknown, the numeric fields'
  // null-clearing contract). A non-boolean-non-null type 400s (never a
  // silent drop).
  for (const field of MODEL_TRISTATE_FIELDS) {
    if (
      raw[field] !== undefined &&
      raw[field] !== null &&
      typeof raw[field] !== "boolean"
    ) {
      return { ok: false, field };
    }
  }
  // ROUND-87 (R87): the size label — string or null (null clears).
  if (
    raw.sizeLabel !== undefined &&
    raw.sizeLabel !== null &&
    typeof raw.sizeLabel !== "string"
  ) {
    return { ok: false, field: "sizeLabel" };
  }
  return { ok: true };
}

/** ROUND-82 (R82): read a tri-state capability field — boolean sets, null
 * clears to unknown, anything else (incl. absent) → undefined (keep). The
 * scalar gate above has already 400'd wrong types, so this is a pure
 * passthrough filter. */
export function readTriStateField(
  value: unknown,
): boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  return undefined;
}

/** ROUND-87 (R87): true when the field rides the tri-state contract (for
 * the 400 messages' "a boolean or null (unknown)" phrasing). */
export function isModelTriStateField(field: string): boolean {
  return (MODEL_TRISTATE_FIELDS as readonly string[]).includes(field);
}

/* ── ROUND-95 (R95-B): the reasoningSupport field gate ───────────────────── */

/** Membership in the shared wire vocabulary (shared owns the truth). */
function isReasoningEffortLevel(value: string): value is ReasoningEffortLevel {
  return (REASONING_EFFORT_LEVELS as readonly string[]).includes(value);
}

/** The 400 message for a malformed reasoningSupport value (both routes). */
export function reasoningSupportValidationMessage(): string {
  return (
    "reasoningSupport must be null or {supported: boolean, efforts: ReasoningEffortLevel[]} " +
    `(efforts values: ${REASONING_EFFORT_LEVELS.join(", ")})`
  );
}

/**
 * ROUND-95 (R95-B, the owner's per-model thinking-level detection): strict
 * gate for the reasoningSupport model-config field, shared by PATCH
 * /models/:id (this module) and POST /providers/:id/models
 * (routes/providers.ts — the R50-d identical-validation contract):
 *   · absent  → undefined (upsert KEEPS the stored value);
 *   · null    → null (clears back to UNKNOWN);
 *   · object  → {supported: boolean, efforts: ReasoningEffortLevel[]} —
 *               every effort must sit inside the shared vocabulary (a
 *               provider's wider ladder — "none" — is normalized at the
 *               catalog-merge edge in registry.ts, never accepted raw);
 *               anything else is a 400 VALIDATION naming the field (never
 *               a silently dropped "successful" save, the R50-d
 *               discipline).
 *
 * ROUND-96 (R96-F, the owner: "I tested a model which supported high and
 * max but it apparently did not detect that properly"): the vocabulary is
 * the WIDER six-rung one — "xhigh" and "max" are accepted verbatim (old
 * rows' stored values included), and an OPTIONAL defaultEffort rides the
 * object (the provider's published default rung — same vocabulary, or a
 * 400 naming the field; "none" is never accepted as a default: it is a
 * disable switch, not a rung).
 */
export function readModelReasoningSupportField(
  raw: Record<string, unknown>,
): { ok: true; value: ModelReasoningSupport | null | undefined } | { ok: false; field: string } {
  const value = raw.reasoningSupport;
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, field: "reasoningSupport" };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.supported !== "boolean") return { ok: false, field: "reasoningSupport" };
  if (!Array.isArray(record.efforts)) return { ok: false, field: "reasoningSupport" };
  for (const effort of record.efforts) {
    if (typeof effort !== "string" || !isReasoningEffortLevel(effort)) {
      return { ok: false, field: "reasoningSupport" };
    }
  }
  // ROUND-96 (R96-F): the optional published-default rung — absent keeps
  // the stored default, a valid vocabulary value sets it, anything else
  // 400s (never a silent drop).
  let defaultEffort: ReasoningEffortLevel | undefined;
  if (record.defaultEffort !== undefined) {
    if (typeof record.defaultEffort !== "string" || !isReasoningEffortLevel(record.defaultEffort)) {
      return { ok: false, field: "reasoningSupport" };
    }
    defaultEffort = record.defaultEffort;
  }
  return {
    ok: true,
    value: {
      supported: record.supported,
      efforts: record.efforts as ReasoningEffortLevel[],
      ...(defaultEffort !== undefined ? { defaultEffort } : {}),
    },
  };
}

export function registerModelRoutes(scope: FastifyInstance, ctx: RouteContext): void {
  const { db, keyring } = ctx;
  scope.patch("/models/:id", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    const raw = body as Record<string, unknown>;
    // ROUND-50 (R50-d): same strict gate as the POST route — number sets,
    // null clears to "unknown", absent leaves the stored value; a wrong
    // type is a 400 VALIDATION naming the field (never a silent drop).
    const numerics = readModelNumericFields(raw);
    if (!numerics.ok) {
      return reply.code(400).send(
        errorBody("VALIDATION", `${numerics.field} must be a number or null`, {
          field: `body.${numerics.field}`,
        }),
      );
    }
    const scalars = readModelScalarFields(raw);
    if (!scalars.ok) {
      const triState = isModelTriStateField(scalars.field);
      return reply.code(400).send(
        errorBody(
          "VALIDATION",
          `${scalars.field} must be ${
            triState
              ? "a boolean or null (unknown)"
              : scalars.field === "displayName" || scalars.field === "sizeLabel"
                ? "a string"
                : "a boolean"
          }`,
          { field: `body.${scalars.field}` },
        ),
      );
    }
    // ROUND-95 (R95-B): the reasoningSupport gate — null clears to unknown,
    // {supported, efforts} sets (efforts within the shared vocabulary).
    const reasoning = readModelReasoningSupportField(raw);
    if (!reasoning.ok) {
      return reply
        .code(400)
        .send(
          errorBody("VALIDATION", reasoningSupportValidationMessage(), {
            field: `body.${reasoning.field}`,
          }),
        );
    }
    const patch: Record<string, unknown> = {};
    if (typeof raw.displayName === "string") patch.displayName = raw.displayName;
    Object.assign(patch, numerics.values);
    if (typeof raw.supportsThinking === "boolean") patch.supportsThinking = raw.supportsThinking;
    if (typeof raw.supportsVision === "boolean") patch.supportsVision = raw.supportsVision;
    // ROUND-82 (R82): tri-state PATCH — boolean sets, null clears to
    // unknown, absent keeps.
    if (raw.supportsTools !== undefined) {
      if (raw.supportsTools === null || typeof raw.supportsTools === "boolean") {
        patch.supportsTools = raw.supportsTools;
      }
    }
    if (raw.supportsAudio !== undefined) {
      if (raw.supportsAudio === null || typeof raw.supportsAudio === "boolean") {
        patch.supportsAudio = raw.supportsAudio;
      }
    }
    if (raw.supportsVideo !== undefined) {
      if (raw.supportsVideo === null || typeof raw.supportsVideo === "boolean") {
        patch.supportsVideo = raw.supportsVideo;
      }
    }
    // ROUND-87 (R87): the input/output capability columns — same tri-state
    // PATCH contract (boolean sets, null clears to unknown, absent keeps).
    if (raw.supportsPdf !== undefined) {
      if (raw.supportsPdf === null || typeof raw.supportsPdf === "boolean") {
        patch.supportsPdf = raw.supportsPdf;
      }
    }
    if (raw.supportsTextOutput !== undefined) {
      if (raw.supportsTextOutput === null || typeof raw.supportsTextOutput === "boolean") {
        patch.supportsTextOutput = raw.supportsTextOutput;
      }
    }
    if (raw.supportsImageOutput !== undefined) {
      if (raw.supportsImageOutput === null || typeof raw.supportsImageOutput === "boolean") {
        patch.supportsImageOutput = raw.supportsImageOutput;
      }
    }
    if (raw.supportsVideoOutput !== undefined) {
      if (raw.supportsVideoOutput === null || typeof raw.supportsVideoOutput === "boolean") {
        patch.supportsVideoOutput = raw.supportsVideoOutput;
      }
    }
    if (raw.supportsAudioOutput !== undefined) {
      if (raw.supportsAudioOutput === null || typeof raw.supportsAudioOutput === "boolean") {
        patch.supportsAudioOutput = raw.supportsAudioOutput;
      }
    }
    // ROUND-87 (R87): the size label — string sets, null clears, absent keeps.
    if (raw.sizeLabel !== undefined) {
      if (raw.sizeLabel === null || typeof raw.sizeLabel === "string") {
        patch.sizeLabel = raw.sizeLabel;
      }
    }
    // ROUND-95 (R95-B): the reasoning-capability blob — value sets, null
    // clears to unknown, absent keeps (the same tri-state contract; the
    // storage layer serializes canonically).
    if (reasoning.value !== undefined) {
      patch.reasoningSupport = reasoning.value;
    }
    if (typeof raw.hidden === "boolean") patch.hidden = raw.hidden;
    const model = updateModel(db, id, patch);
    if (model === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no model with id ${id}`));
    }
    return model;
  });

  scope.delete("/models/:id", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    if (!deleteModel(db, id)) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no model with id ${id}`));
    }
    return reply.code(204).send();
  });

  // ROUND-82 (R82, owner: "a test button on the models page … check if
  // the model is working properly or not"): the PER-MODEL test — a real
  // 64-token completion against the row's provider, graded (http / auth /
  // modelAccepted / nonEmptyContent) with the reply preview and raw
  // provider error bodies (the EOL'd-NIM 410 case shows verbatim). The
  // same key-pool slot contract as POST /providers/:id/test (R47-b);
  // a probe that RAN and got a NO is HTTP 200 {ok:false} — a successful
  // test call, not a server error.
  scope.post("/models/:id/test", async (request, reply) => {
    const { id } = request.params as Record<string, string>;
    const modelRow = getModel(db, id);
    if (modelRow === undefined) {
      return reply.code(404).send(errorBody("NOT_FOUND", `no model with id ${id}`));
    }
    const provider = resolveProvider(db, modelRow.providerId);
    if (provider === undefined) {
      return reply.code(409).send(
        errorBody(
          "CONFLICT",
          `model '${modelRow.modelId}' references provider '${modelRow.providerId}' which no longer exists — remove or re-add the model`,
          { providerId: modelRow.providerId, modelId: modelRow.modelId },
        ),
      );
    }
    if (provider.baseUrl === null) {
      return reply.code(409).send(
        errorBody(
          "CONFLICT",
          `provider '${provider.id}' has no baseUrl configured — set one before testing`,
          { providerId: provider.id },
        ),
      );
    }
    // Body: optional { slot } — the R47-b key-pool contract verbatim.
    let slot: number | undefined;
    const body: unknown = request.body;
    if (body !== undefined && body !== null) {
      if (typeof body !== "object" || Array.isArray(body)) {
        return reply
          .code(400)
          .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
      }
      const raw = body as Record<string, unknown>;
      const rawSlot = raw.slot;
      if (rawSlot !== undefined) {
        if (
          typeof rawSlot !== "number" ||
          !Number.isInteger(rawSlot) ||
          rawSlot < 0 ||
          rawSlot > 31
        ) {
          return reply.code(400).send(
            errorBody("VALIDATION", "slot must be an integer between 0 and 31", {
              field: "body.slot",
            }),
          );
        }
        slot = rawSlot;
      }
    }
    let keyOverride: string | undefined;
    if (slot === undefined) {
      if (!keyring.has(provider.id)) {
        return reply.code(409).send(
          errorBody(
            "CONFLICT",
            `no API key stored for provider '${provider.id}' — save one in Settings → Models & Providers before testing`,
            { providerId: provider.id },
          ),
        );
      }
    } else {
      keyOverride = keyring.getSlot(provider.id, slot);
      if (keyOverride === undefined) {
        return reply.code(409).send(
          errorBody(
            "CONFLICT",
            `no API key stored for provider '${provider.id}' slot ${slot} — save one in Settings → Models & Providers`,
            { providerId: provider.id, slot },
          ),
        );
      }
    }
    try {
      return await testModelResponse(keyring, provider, modelRow.modelId, keyOverride);
    } catch (error) {
      if (error instanceof ProviderTestError) {
        // Standalone-safety no-key guard — the route pre-checked, so
        // this is belt-and-suspenders; same 409 shape.
        return reply.code(409).send(
          errorBody("CONFLICT", error.message, { providerId: provider.id }),
        );
      }
      const message =
        error instanceof Error ? error.message : `model '${id}' test failed`;
      return reply
        .code(502)
        .send(errorBody("PROVIDER_ERROR", message, { providerId: provider.id, modelId: modelRow.modelId }));
    }
  });

  // ROUND-47 (R47-b): the STATIC model catalog for every picker. The
  // frontend hand-copied this 47-entry list into two components — a
  // guaranteed drift trap (SubAgentsTab already diverged). One route,
  // sourced from the constants themselves: no cache, no DB rows, nothing
  // stale. Same authenticated scope as the provider routes above.
  scope.get("/models/catalog", async () => {
    return {
      models: MODEL_CATALOG,
      defaultModelId: DEFAULT_MODEL_ID,
      subagentDefaultModelId: SUBAGENT_DEFAULT_MODEL_ID,
      recommendedModelIds: RECOMMENDED_MODEL_IDS,
    };
  });

  // ROUND-82 (R82, §2.4.5 — the NVIDIA sub-agent gap): every CONFIGURED
  // model row across all providers. The Sub-agents picker pairs this
  // with the static catalog so a NIM/custom row can be picked as the
  // sub-agent model (previously impossible — the picker was
  // catalog-only, and catalog validation rejected non-catalog ids).
  scope.get("/models/configured", async () => {
    return { models: listAllModels(db) };
  });
}
