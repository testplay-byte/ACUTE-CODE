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
// ROUND-113 (R113-a): every domain PUT now BROADCASTS on the events bus
// ({type:"settings",domain,value}) — a settings change made on ONE device
// (desktop, phone, CLI) propagates to every watcher on
// GET /api/v1/events/stream live. The domain also gains APPEARANCE
// (GET/PUT /settings/appearance — the theme-sync backbone; see the route
// below and storage/settings.ts's AppearanceSettings).
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

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RouteContext } from "./context.js";
import { deviceAuthOf } from "./context.js";
// R113-a: the events-bus broadcast (every domain PUT fans out) — imported
// BEFORE the storage accessors it rides beside.
import { getEventsBus } from "../lib/events-bus.js";
import {
  getAppearanceSettings,
  getBrowserSettings,
  getCloudConnectorSettings,
  getDebugSettings,
  getDesktopNotificationsSettings,
  getDeviceLinkSettings,
  getMemorySettings,
  getOrchestrationSettings,
  getRetrySettings,
  getThinkingLoopSettings,
  isAppearanceThemeId,
  // ROUND-114 (R114-b): the appearance domain's four new chat-density
  // vocabularies (the PUT route's name-the-field validation).
  APPEARANCE_CHAT_DENSITIES,
  APPEARANCE_TEXT_SIZES,
  APPEARANCE_TIMESTAMPS_MODES,
  APPEARANCE_TOOL_ACTIVITY,
  setAppearanceSettings,
  setBrowserSettings,
  setCloudConnectorSettings,
  setDebugSettings,
  setDesktopNotificationsSettings,
  setDeviceLinkSettings,
  setMemorySettings,
  setOrchestrationSettings,
  setRetrySettings,
  setThinkingLoopSettings,
  type AppearanceChatDensity,
  type AppearanceMode,
  type AppearanceSettings,
  type AppearanceTextSize,
  type AppearanceThemeId,
  type AppearanceTimestampsMode,
  type AppearanceToolActivity,
} from "../storage/settings.js";
import { errorBody } from "./helpers.js";
import {
  getCloudConnectorStatus,
  normalizeRelayUrl,
  reconfigureCloudConnector,
  stopCloudConnector,
} from "../lib/cloud-connector.js";

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

/**
 * ROUND-112 (R112-a): shell-only rejection for the cloud-connector routes —
 * remote access is a MANAGEMENT-surface setting (the desktop window's
 * Devices tab), so a paired device token must never read or flip it. The
 * app-level bearer wall's device-token BLOCKLIST already covers this path
 * (server.ts's DEVICE_BLOCKED_EXACT — defense in depth); this route-local
 * guard is the mobile.ts rejectDeviceTokens pattern, kept so the intent is
 * legible where the route lives. True = rejected (reply already sent).
 */
function rejectDeviceTokens(request: FastifyRequest, reply: FastifyReply): boolean {
  if (deviceAuthOf(request) === null) return false;
  reply.code(403).send(
    errorBody("FORBIDDEN", "this route requires the shell token (device tokens are not allowed here)", {
      hint: "remote access is a desktop-side setting",
    }),
  );
  return true;
}

/**
 * R113-a: the settings PUT broadcast — persist succeeded, so tell every
 * watcher (desktop / phone / CLI holding GET /events/stream open) that the
 * domain changed. `value` is the UPDATED settings object exactly as the
 * domain's GET serves it — SECRETS NEVER RIDE THIS FRAME (the
 * cloud-connector domain broadcasts hostKeyPresent, not the host key —
 * see its PUT below). Fire-and-forget by construction (the bus wraps its
 * subscribers); called only on the success path so a 400 never announces a
 * write that did not happen.
 */
function broadcastSettings(domain: string, value: unknown): void {
  getEventsBus().publishSettingsFrame(domain, value);
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
      const updated = setOrchestrationSettings(db, {
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
      broadcastSettings("orchestration", updated);
      return updated;
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
      const updated = setMemorySettings(db, {
        ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
      });
      broadcastSettings("memory", updated);
      return updated;
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
      const updated = setDebugSettings(db, {
        ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
      });
      broadcastSettings("debug", updated);
      return updated;
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
      const updated = setRetrySettings(db, {
        ...(typeof raw.autoRetryRateLimit === "boolean" ? { autoRetryRateLimit: raw.autoRetryRateLimit } : {}),
        ...(typeof raw.autoRetryTimeout === "boolean" ? { autoRetryTimeout: raw.autoRetryTimeout } : {}),
        ...(typeof raw.autoRetryNetwork === "boolean" ? { autoRetryNetwork: raw.autoRetryNetwork } : {}),
        ...(typeof raw.maxAttempts === "number" ? { maxAttempts: raw.maxAttempts } : {}),
        ...(Array.isArray(raw.waitMinutes) ? { waitMinutes: raw.waitMinutes as number[] } : {}),
        ...(typeof raw.providerTimeoutSeconds === "number"
          ? { providerTimeoutSeconds: raw.providerTimeoutSeconds }
          : {}),
      });
      broadcastSettings("retry", updated);
      return updated;
    } catch (error) {
      return reply.code(400).send(
        errorBody("VALIDATION", error instanceof Error ? error.message : "invalid settings", {
          field: "body",
        }),
      );
    }
  });

  // ── ROUND-97 (R97-D, owner: "give the user the option in the settings to
  // turn it on or off. By default it will be turned off… also give the user
  // the option and flexibility to edit the thinking loop management"): the
  // thinking-loop guard's OWN settings domain. GET returns the full
  // ThinkingLoopSettings; PUT accepts a partial patch. The streamed turn's
  // watchdog reads these per call (enabled=false → NO guard at all — the
  // model thinks as long as it needs to).

  scope.get("/settings/thinking-loop", async () => {
    return getThinkingLoopSettings(db);
  });

  scope.put("/settings/thinking-loop", async (request, reply) => {
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
    if (
      raw.stallSeconds !== undefined &&
      (typeof raw.stallSeconds !== "number" ||
        !Number.isInteger(raw.stallSeconds) ||
        raw.stallSeconds < 30 ||
        raw.stallSeconds > 600)
    ) {
      return reply.code(400).send(
        errorBody("VALIDATION", "body.stallSeconds must be an integer between 30 and 600", {
          field: "body.stallSeconds",
        }),
      );
    }
    if (
      raw.reasoningBytesKB !== undefined &&
      (typeof raw.reasoningBytesKB !== "number" ||
        !Number.isInteger(raw.reasoningBytesKB) ||
        raw.reasoningBytesKB < 8 ||
        raw.reasoningBytesKB > 256)
    ) {
      return reply.code(400).send(
        errorBody("VALIDATION", "body.reasoningBytesKB must be an integer between 8 and 256", {
          field: "body.reasoningBytesKB",
        }),
      );
    }
    try {
      const updated = setThinkingLoopSettings(db, {
        ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
        ...(typeof raw.stallSeconds === "number" ? { stallSeconds: raw.stallSeconds } : {}),
        ...(typeof raw.reasoningBytesKB === "number" ? { reasoningBytesKB: raw.reasoningBytesKB } : {}),
      });
      broadcastSettings("thinking-loop", updated);
      return updated;
    } catch (error) {
      return reply.code(400).send(
        errorBody("VALIDATION", error instanceof Error ? error.message : "invalid settings", {
          field: "body",
        }),
      );
    }
  });

  // ── ROUND-97 (R97-G, owner: "add a dedicated section in the settings for
  // the browser… which I can use to edit some settings of the browsers,
  // manage the browser"): the BROWSER settings domain — the search engine
  // (the address bar's query fallback), the homepage, the default zoom, and
  // the editable quick links. ROUND-99 (R99-A) adds linkOpeningMode: where
  // in-app links open (the embedded browser panel vs the device's default
  // browser — the central link router in src/lib/open-link.ts reads this
  // preference). GET returns the full BrowserSettings; PUT accepts a
  // partial patch (the storage throw is the 400 backstop).

  scope.get("/settings/browser", async () => {
    return getBrowserSettings(db);
  });

  scope.put("/settings/browser", async (request, reply) => {
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    try {
      const raw = body as Record<string, unknown>;
      const updated = setBrowserSettings(db, {
        ...(typeof raw.searchEngine === "string"
          ? { searchEngine: raw.searchEngine as "duckduckgo" | "google" | "bing" | "brave" }
          : {}),
        ...(typeof raw.homepage === "string" ? { homepage: raw.homepage } : {}),
        ...(typeof raw.defaultZoom === "number" ? { defaultZoom: raw.defaultZoom } : {}),
        ...(Array.isArray(raw.quickLinks)
          ? { quickLinks: raw.quickLinks as Array<{ label: string; url: string }> }
          : {}),
        ...(typeof raw.linkOpeningMode === "string"
          ? { linkOpeningMode: raw.linkOpeningMode as "in-app" | "system" }
          : {}),
      });
      broadcastSettings("browser", updated);
      return updated;
    } catch (error) {
      return reply.code(400).send(
        errorBody("VALIDATION", error instanceof Error ? error.message : "invalid settings", {
          field: "body",
        }),
      );
    }
  });

  // ── ROUND-98 (R98-J, owner: task complete / failed / permission needed
  // → the user's PC): the DESKTOP-NOTIFICATIONS switch. The r97 browser
  // pattern exactly — GET returns the full DesktopNotificationsSettings,
  // PUT accepts a partial {enabled} patch (a non-boolean 400s with the
  // field named; the storage throw is the backstop). The frontend bridge
  // reads this per flip via its in-memory cache — the route is the truth.

  scope.get("/settings/desktop-notifications", async () => {
    return getDesktopNotificationsSettings(db);
  });

  scope.put("/settings/desktop-notifications", async (request, reply) => {
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
      const updated = setDesktopNotificationsSettings(db, {
        ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
      });
      broadcastSettings("desktop-notifications", updated);
      return updated;
    } catch (error) {
      return reply.code(400).send(
        errorBody("VALIDATION", error instanceof Error ? error.message : "invalid settings", {
          field: "body",
        }),
      );
    }
  });

  // ── ROUND-106 (R106-S1, the mobile-link round): the DEVICE-LINK switch —
  // "Allow device links" in the Settings → Devices tab. Same one-boolean
  // GET/PUT shape as /settings/desktop-notifications, PLUS the runtime
  // listener effect: a flip to true STARTS the TLS device listener (0.0.0.0,
  // own ephemeral port, the per-machine cert); a flip to false STOPS it —
  // no process restart either way (the dual-listener contract). The start
  // is attempted BEFORE the setting persists, so a failed start (cert
  // generation error, port bind error) leaves the link honestly OFF with
  // the cause in the 400. The frontend's full status read (port, addresses,
  // fingerprint, pairing window) is GET /api/v1/mobile/link-info.

  scope.get("/settings/device-link", async () => {
    return getDeviceLinkSettings(db);
  });

  scope.put("/settings/device-link", async (request, reply) => {
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
    const enabled = typeof raw.enabled === "boolean" ? raw.enabled : getDeviceLinkSettings(db).enabled;
    if (ctx.mobileLink === undefined) {
      if (!enabled) return getDeviceLinkSettings(db);
      // The listener can't exist without a machine data dir (the cert's
      // home). Hermetic test builds hit this; the real sidecar always has
      // one (the SQLite file's directory).
      return reply.code(503).send(
        errorBody("UNAVAILABLE", "device links are unavailable on this sidecar (no machine data dir)"),
      );
    }
    if (enabled) {
      try {
        await ctx.mobileLink.start();
      } catch (error) {
        return reply.code(400).send(
          errorBody("VALIDATION", error instanceof Error ? error.message : "the device listener failed to start", {
            hint: "the device link stays disabled",
          }),
        );
      }
    } else {
      await ctx.mobileLink.stop();
    }
    try {
      const updated = setDeviceLinkSettings(db, { enabled });
      broadcastSettings("device-link", updated);
      return updated;
    } catch (error) {
      // The listener moved but the row refused (corrupt settings write) —
      // reconcile by stopping again so state and setting agree.
      await ctx.mobileLink.stop();
      return reply.code(400).send(
        errorBody("VALIDATION", error instanceof Error ? error.message : "invalid settings", {
          field: "body",
        }),
      );
    }
  });

  // ── ROUND-112 (R112-a, the remote-access round): the CLOUD-CONNECTOR
  // settings — "Remote access (internet)" in the Settings → Devices tab.
  // GET answers the saved config (the hostKey NEVER echoes — presence
  // only) plus the connector's live status; PUT accepts
  // {enabled, relayUrl, hostKey?} where hostKey omitted = keep the saved
  // key and "" = clear it, then applies at runtime (stop or
  // stop→reconfigure). The connector's own failures are NEVER fatal — its
  // status carries them (the boot-time rule carried into the route).

  scope.get("/settings/cloud-connector", async (request, reply) => {
    if (rejectDeviceTokens(request, reply)) return reply;
    const settings = getCloudConnectorSettings(db);
    return {
      enabled: settings.enabled,
      relayUrl: settings.relayUrl,
      hostKeyPresent: settings.hostKey !== "",
      status: getCloudConnectorStatus(),
    };
  });

  scope.put("/settings/cloud-connector", async (request, reply) => {
    if (rejectDeviceTokens(request, reply)) return reply;
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
    if (raw.relayUrl !== undefined && (typeof raw.relayUrl !== "string" || raw.relayUrl.length > 500)) {
      return reply.code(400).send(
        errorBody("VALIDATION", "body.relayUrl must be a string of at most 500 characters", {
          field: "body.relayUrl",
        }),
      );
    }
    if (raw.hostKey !== undefined && (typeof raw.hostKey !== "string" || raw.hostKey.length > 500)) {
      return reply.code(400).send(
        errorBody("VALIDATION", "body.hostKey must be a string of at most 500 characters", {
          field: "body.hostKey",
        }),
      );
    }

    const current = getCloudConnectorSettings(db);
    const enabled = typeof raw.enabled === "boolean" ? raw.enabled : current.enabled;
    // relayUrl: absent = keep; present = replace (trimmed + slash-normalized
    // via the connector module's own normalizer — the saved row is the
    // boot block's truth).
    const relayUrl =
      raw.relayUrl !== undefined ? normalizeRelayUrl(raw.relayUrl) : normalizeRelayUrl(current.relayUrl);
    // hostKey: undefined = keep the saved key; "" = clear it.
    const hostKey = raw.hostKey !== undefined ? raw.hostKey : current.hostKey;

    // Enabling requires the full config — an honest 400 up front (the
    // device-link PUT's failed-start pattern: the setting stays as-is).
    if (enabled && relayUrl === "") {
      return reply.code(400).send(
        errorBody("VALIDATION", "enabling remote access requires a relay URL", {
          field: "body.relayUrl",
        }),
      );
    }
    if (enabled && hostKey === "") {
      return reply.code(400).send(
        errorBody("VALIDATION", "enabling remote access requires a host key", {
          field: "body.hostKey",
        }),
      );
    }
    // The tunnel's Room address IS the machine identity — the device link
    // must have produced its certificate at least once.
    const identity = ctx.mobileLink?.identity() ?? null;
    if (enabled && identity === null) {
      return reply.code(400).send(
        errorBody("VALIDATION", "device links are unavailable on this sidecar (no machine identity)", {
          hint: "enable device links once first — the relay address is derived from the link's certificate",
        }),
      );
    }

    // Save FIRST (the persisted row is what the next boot reads), then
    // apply at runtime — the apply is never fatal.
    try {
      setCloudConnectorSettings(db, { enabled, relayUrl, hostKey });
    } catch (error) {
      return reply.code(400).send(
        errorBody("VALIDATION", error instanceof Error ? error.message : "invalid settings", {
          field: "body",
        }),
      );
    }
    if (!enabled) {
      await stopCloudConnector();
    } else if (identity !== null) {
      try {
        await reconfigureCloudConnector({
          relayUrl,
          hostKey,
          machineId: identity.machineId,
          tlsPort: () => ctx.mobileLink?.status().port ?? null,
        });
      } catch {
        // Never fatal — the status snapshot below carries the honest state.
      }
    }
    const saved = getCloudConnectorSettings(db);
    // R113-a: the broadcast — the SECRET-FREE GET shape (hostKeyPresent,
    // never the key itself; the runtime `status` object is deliberately
    // left out too: it is live tunnel state, not a settings value).
    broadcastSettings("cloud-connector", {
      enabled: saved.enabled,
      relayUrl: saved.relayUrl,
      hostKeyPresent: saved.hostKey !== "",
    });
    return {
      enabled: saved.enabled,
      relayUrl: saved.relayUrl,
      hostKeyPresent: saved.hostKey !== "",
      status: getCloudConnectorStatus(),
    };
  });

  // ── ROUND-113 (R113-a, the backend event fan-out round): the APPEARANCE
  // settings domain — the theme-sync backbone. GET answers the stored
  // preference or the default {themeId: null, mode: "system", ...} (null =
  // no server preference — each client falls back to its LOCAL default, the
  // honest pre-R113 behavior); PUT accepts a partial patch, validates (the
  // six shared flavor ids or null; the enum vocabularies — R114-b adds
  // chatDensity / chatTextSize / timestampsMode / toolActivity), persists,
  // and BROADCASTS {type:"settings",domain:"appearance"} on the events bus
  // so the change lands live on every other device. Device tokens are
  // WELCOME here — the phone changing the desktop's theme is a first-class
  // use case (the route is not on the device blocklist; only
  // management-surface domains reject device tokens).

  scope.get("/settings/appearance", async () => {
    return getAppearanceSettings(db);
  });

  scope.put("/settings/appearance", async (request, reply) => {
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return reply
        .code(400)
        .send(errorBody("VALIDATION", "body must be a JSON object", { field: "body" }));
    }
    const raw = body as Record<string, unknown>;
    // themeId: one of the six shared flavor ids, or null (clear the server
    // preference). The route names the offending field; the storage throw
    // is the backstop.
    if (
      raw.themeId !== undefined &&
      raw.themeId !== null &&
      !isAppearanceThemeId(raw.themeId)
    ) {
      return reply.code(400).send(
        errorBody(
          "VALIDATION",
          "body.themeId must be one of nova, bento, midnight, sunset, mono, clay — or null (no server preference)",
          { field: "body.themeId" },
        ),
      );
    }
    // mode: the three-value enum (the desktop maps "system" as it can).
    if (
      raw.mode !== undefined &&
      (typeof raw.mode !== "string" || !["system", "light", "dark"].includes(raw.mode))
    ) {
      return reply.code(400).send(
        errorBody("VALIDATION", "body.mode must be one of system, light, dark", { field: "body.mode" }),
      );
    }
    // ROUND-114 (R114-b): the four chat-density fields — same honest
    // name-the-field validation, one guard each (an absent field = untouched
    // partial-patch semantics; the storage throw is the backstop).
    if (
      raw.chatDensity !== undefined &&
      (typeof raw.chatDensity !== "string" || !APPEARANCE_CHAT_DENSITIES.includes(raw.chatDensity as AppearanceChatDensity))
    ) {
      return reply.code(400).send(
        errorBody("VALIDATION", `body.chatDensity must be one of ${APPEARANCE_CHAT_DENSITIES.join(", ")}`, {
          field: "body.chatDensity",
        }),
      );
    }
    if (
      raw.chatTextSize !== undefined &&
      (typeof raw.chatTextSize !== "string" || !APPEARANCE_TEXT_SIZES.includes(raw.chatTextSize as AppearanceTextSize))
    ) {
      return reply.code(400).send(
        errorBody("VALIDATION", `body.chatTextSize must be one of ${APPEARANCE_TEXT_SIZES.join(", ")}`, {
          field: "body.chatTextSize",
        }),
      );
    }
    if (
      raw.timestampsMode !== undefined &&
      (typeof raw.timestampsMode !== "string" || !APPEARANCE_TIMESTAMPS_MODES.includes(raw.timestampsMode as AppearanceTimestampsMode))
    ) {
      return reply.code(400).send(
        errorBody("VALIDATION", `body.timestampsMode must be one of ${APPEARANCE_TIMESTAMPS_MODES.join(", ")}`, {
          field: "body.timestampsMode",
        }),
      );
    }
    if (
      raw.toolActivity !== undefined &&
      (typeof raw.toolActivity !== "string" || !APPEARANCE_TOOL_ACTIVITY.includes(raw.toolActivity as AppearanceToolActivity))
    ) {
      return reply.code(400).send(
        errorBody("VALIDATION", `body.toolActivity must be one of ${APPEARANCE_TOOL_ACTIVITY.join(", ")}`, {
          field: "body.toolActivity",
        }),
      );
    }
    // The guards above returned 400 for anything else, so the casts are
    // safe — the browser domain's `as` pattern.
    const patch: Partial<AppearanceSettings> = {};
    if (raw.themeId !== undefined) {
      patch.themeId = raw.themeId === null ? null : (raw.themeId as AppearanceThemeId);
    }
    if (raw.mode !== undefined) {
      patch.mode = raw.mode as AppearanceMode;
    }
    // R114-b: the four density fields join the patch (validated above).
    if (raw.chatDensity !== undefined) {
      patch.chatDensity = raw.chatDensity as AppearanceChatDensity;
    }
    if (raw.chatTextSize !== undefined) {
      patch.chatTextSize = raw.chatTextSize as AppearanceTextSize;
    }
    if (raw.timestampsMode !== undefined) {
      patch.timestampsMode = raw.timestampsMode as AppearanceTimestampsMode;
    }
    if (raw.toolActivity !== undefined) {
      patch.toolActivity = raw.toolActivity as AppearanceToolActivity;
    }
    try {
      const updated = setAppearanceSettings(db, patch);
      broadcastSettings("appearance", updated);
      return updated;
    } catch (error) {
      return reply.code(400).send(
        errorBody("VALIDATION", error instanceof Error ? error.message : "invalid settings", {
          field: "body",
        }),
      );
    }
  });
}
