// ─────────────────────────────────────────────────────────────────────────────
// R84 (Wave 2-a): the settings domain — the four owner-facing settings
// sections the General Settings tab drives.
//
// Registers, in the original server.ts registration order: GET/PUT
// /settings/orchestration (ROUND-36), GET/PUT /settings/memory (ROUND-49
// master switch), GET/PUT /settings/debug (ROUND-65 agent self-report),
// GET/PUT /settings/retry (ROUND-78 per-class auto-retry + ROUND-80
// schedule knobs).
//
// Provenance: extracted verbatim from server.ts in R84 (Wave 2-a) —
// behavior-identical, test-guarded. The R82 subagentModel object-form
// helpers (isSubagentModelRefBody + normalizeSubagentModelRef) moved with
// the domain; they are this domain's private gate. The turn machinery
// still reads the SAME storage accessors directly (getDebugSettings for
// the R66 debug-analyst gate, getRetrySettings for the R80 retry-schedule
// error line) — storage/settings.js stays the one source of truth. The
// VISION settings (GET/PUT /vision/settings) are a different domain and
// stay in server.ts.
// ─────────────────────────────────────────────────────────────────────────────

import type { FastifyInstance } from "fastify";
import type { RouteContext } from "./context.js";
import {
  getDebugSettings,
  getMemorySettings,
  getOrchestrationSettings,
  getRetrySettings,
  setDebugSettings,
  setMemorySettings,
  setOrchestrationSettings,
  setRetrySettings,
} from "../storage/settings.js";
import { errorBody } from "./helpers.js";

/**
 * ROUND-82 (R82, §2.4.5): shape check for the orchestration PATCH's
 * subagentModel object form — {providerId: string, modelId: string}, both
 * non-blank. Anything else (wrong types, missing fields) is NOT the object
 * form and falls through to the legacy string/null branches.
 */
function isSubagentModelRefBody(value: unknown): value is { providerId: unknown; modelId: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return "providerId" in record && "modelId" in record;
}

/** ROUND-82: normalize the validated object form (trim + type-check the
 * two fields; blank strings 400 via the settings validator downstream —
 * this returns the typed shape). */
function normalizeSubagentModelRef(
  value: { providerId: unknown; modelId: unknown },
): { providerId: string; modelId: string } {
  return {
    providerId: typeof value.providerId === "string" ? value.providerId.trim() : "",
    modelId: typeof value.modelId === "string" ? value.modelId.trim() : "",
  };
}

export function registerSettingsRoutes(scope: FastifyInstance, ctx: RouteContext): void {
  const { db } = ctx;
  // ── ROUND-36: orchestration settings ──────────────────────────────

  scope.get("/settings/orchestration", async () => {
    return getOrchestrationSettings(db);
  });

  scope.put("/settings/orchestration", async (request, reply) => {
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    const raw = body as Record<string, unknown>;
    try {
      return setOrchestrationSettings(db, {
        ...(typeof raw.maxParallel === "number" ? { maxParallel: raw.maxParallel } : {}),
        ...(typeof raw.perKeyLimit === "number" ? { perKeyLimit: raw.perKeyLimit } : {}),
        // ROUND-43 (R43-5): temporary sub-agent model override — string id
        // (catalog-validated in settings.ts) or null to re-inherit.
        // ROUND-82 (R82, §2.4.5): the provider-scoped {providerId,
        // modelId} object form — a NIM/custom configured row can be the
        // sub-agent model (validated in settings.ts: provider exists,
        // explicit tools=false rejects).
        ...(typeof raw.subagentModel === "string" ? { subagentModel: raw.subagentModel } : {}),
        ...(raw.subagentModel === null ? { subagentModel: null } : {}),
        ...(isSubagentModelRefBody(raw.subagentModel)
          ? { subagentModel: normalizeSubagentModelRef(raw.subagentModel) }
          : {}),
        // ROUND-52 (R52-b): the child-supervisor knobs (heartbeat cadence
        // + stall threshold) — validated + clamped in settings.ts.
        ...(typeof raw.childWatchdogMs === "number" ? { childWatchdogMs: raw.childWatchdogMs } : {}),
        ...(typeof raw.childStallTimeoutMs === "number"
          ? { childStallTimeoutMs: raw.childStallTimeoutMs }
          : {}),
      });
    } catch (error) {
      return reply.code(400).send(
        errorBody("VALIDATION", error instanceof Error ? error.message : "invalid settings", {
          field: "body",
        }),
      );
    }
  });

  // ── ROUND-49: memory settings (the master switch) ───────────────────

  scope.get("/settings/memory", async () => {
    return getMemorySettings(db);
  });

  scope.put("/settings/memory", async (request, reply) => {
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    const raw = body as Record<string, unknown>;
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body.enabled must be a boolean", { field: "body.enabled" }));
    }
    try {
      return setMemorySettings(db, {
        ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
      });
    } catch (error) {
      return reply.code(400).send(
        errorBody("VALIDATION", error instanceof Error ? error.message : "invalid settings", {
          field: "body",
        }),
      );
    }
  });

  // ── ROUND-65: debug settings (the agent self-report switch) ──────

  scope.get("/settings/debug", async () => {
    return getDebugSettings(db);
  });

  scope.put("/settings/debug", async (request, reply) => {
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    const raw = body as Record<string, unknown>;
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body.enabled must be a boolean", { field: "body.enabled" }));
    }
    try {
      return setDebugSettings(db, {
        ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
      });
    } catch (error) {
      return reply.code(400).send(
        errorBody("VALIDATION", error instanceof Error ? error.message : "invalid settings", {
          field: "body",
        }),
      );
    }
  });

  // ── ROUND-78 (R78, owner: "General Settings 重试配置"): the per-class
  // auto-retry switches. Same shape/behavior as /settings/debug — GET
  // returns the full RetrySettings, PUT accepts a partial patch and
  // returns the updated object. The runtime's retry ladder reads these
  // per turn (a disabled class fails fast with the provider's real error
  // text). ROUND-80 (R80): the object gained maxAttempts + waitMinutes +
  // providerTimeoutSeconds (the customizable schedule; validated against
  // the same bounds the runtime resolves with).

  scope.get("/settings/retry", async () => {
    return getRetrySettings(db);
  });

  scope.put("/settings/retry", async (request, reply) => {
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    const raw = body as Record<string, unknown>;
    for (const field of ["autoRetryRateLimit", "autoRetryTimeout", "autoRetryNetwork"] as const) {
      if (raw[field] !== undefined && typeof raw[field] !== "boolean") {
        return reply
          .code(400)
          .send(errorBody("VALIDATION", `body.${field} must be a boolean`, { field: `body.${field}` }));
      }
    }
    // ROUND-80 (R80): the numeric schedule fields — validated here with
    // the exact bounds setRetrySettings enforces (the route names the
    // offending field; the storage error is the backstop).
    if (raw.maxAttempts !== undefined) {
      if (
        typeof raw.maxAttempts !== "number" ||
        !Number.isInteger(raw.maxAttempts) ||
        raw.maxAttempts < 2 ||
        raw.maxAttempts > 10
      ) {
        return reply.code(400).send(
          errorBody("VALIDATION", "body.maxAttempts must be an integer between 2 and 10", {
            field: "body.maxAttempts",
          }),
        );
      }
    }
    if (raw.waitMinutes !== undefined) {
      if (!Array.isArray(raw.waitMinutes) || raw.waitMinutes.length === 0 || raw.waitMinutes.length > 9) {
        return reply
          .code(400)
          .send(errorBody("VALIDATION", "body.waitMinutes must be an array of 1 to 9 numbers", { field: "body.waitMinutes" }));
      }
      for (const entry of raw.waitMinutes) {
        if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0 || entry > 1440) {
          return reply.code(400).send(
            errorBody("VALIDATION", "body.waitMinutes entries must be numbers between 0 and 1440 (minutes)", {
              field: "body.waitMinutes",
            }),
          );
        }
      }
    }
    if (raw.providerTimeoutSeconds !== undefined) {
      if (
        typeof raw.providerTimeoutSeconds !== "number" ||
        !Number.isInteger(raw.providerTimeoutSeconds) ||
        raw.providerTimeoutSeconds < 60 ||
        raw.providerTimeoutSeconds > 3600
      ) {
        return reply.code(400).send(
          errorBody("VALIDATION", "body.providerTimeoutSeconds must be an integer between 60 and 3600", {
            field: "body.providerTimeoutSeconds",
          }),
        );
      }
    }
    try {
      return setRetrySettings(db, {
        ...(typeof raw.autoRetryRateLimit === "boolean" ? { autoRetryRateLimit: raw.autoRetryRateLimit } : {}),
        ...(typeof raw.autoRetryTimeout === "boolean" ? { autoRetryTimeout: raw.autoRetryTimeout } : {}),
        ...(typeof raw.autoRetryNetwork === "boolean" ? { autoRetryNetwork: raw.autoRetryNetwork } : {}),
        ...(typeof raw.maxAttempts === "number" ? { maxAttempts: raw.maxAttempts } : {}),
        ...(Array.isArray(raw.waitMinutes) ? { waitMinutes: raw.waitMinutes as number[] } : {}),
        ...(typeof raw.providerTimeoutSeconds === "number"
          ? { providerTimeoutSeconds: raw.providerTimeoutSeconds }
          : {}),
      });
    } catch (error) {
      return reply.code(400).send(
        errorBody("VALIDATION", error instanceof Error ? error.message : "invalid settings", {
          field: "body",
        }),
      );
    }
  });
}
