/**
 * Provider registry service layer (API.md §8) on top of storage/providers.ts.
 *
 * API keys are NEVER persisted: the shell injects them as environment
 * variables `ACUTE_PROVIDER_<ID_UPPER>` (e.g. ACUTE_PROVIDER_OPENROUTER) at
 * sidecar spawn (ARCHITECTURE §7) and the keyring below snapshots them into
 * memory. Nothing in this module ever returns a key value — only `hasKey`
 * booleans — and error messages are scrubbed of key material before surfacing.
 */
import type Database from "better-sqlite3";
import { scrubSecretShapes } from "../lib/secret-shapes.js";
// ROUND-95 (R95-B): the per-model reasoning-capability vocabulary + blob
// type live in shared (the wire contract both sides consume). Type-only —
// the runtime const REASONING_EFFORT_LEVELS is used here for normalization.
import {
  REASONING_EFFORT_LEVELS,
  type ModelReasoningSupport,
  type ReasoningEffortLevel,
} from "shared";
import {
  getProviderRecord,
  listProviderRecords,
  type ProviderRecord,
} from "../storage/providers.js";

export type SqliteDatabase = Database.Database;

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const MODEL_FETCH_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 15_000;

/** Provider JSON as served by the API: the row plus key-presence flags, never the key. */
export interface ProviderView {
  id: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  /** ROUND-37: the provider's wire format — surfaced so Settings can show
   * and change it (chat-completions | anthropic-messages | responses). */
  apiFormat?: string;
  enabled: boolean;
  createdAt: string;
  hasKey: boolean;
  /** ROUND-92 (R92-D): the size of the provider's DEDUPED key pool — how
   * many distinct key VALUES the turn runners will juggle (same value in
   * two slots counts once). 0 = no key at all; 1 = the pre-R92 single-key
   * world; ≥ 2 = the owner's multi-key pool. Never the key itself. */
  keyCount: number;
}

/** In-memory map of provider id -> API key, snapshotted from the spawn environment. */
export class ProviderKeyring {
  readonly #env: Record<string, string | undefined>;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.#env = { ...env };
  }

  /** `ACUTE_PROVIDER_<ID_UPPER>` with non-alphanumerics folded to underscores. */
  static envVarName(providerId: string): string {
    return `ACUTE_PROVIDER_${providerId.toUpperCase().replace(/[^A-Za-z0-9]/g, "_")}`;
  }

  has(providerId: string): boolean {
    return this.get(providerId) !== undefined;
  }

  get(providerId: string): string | undefined {
    const value = this.#env[ProviderKeyring.envVarName(providerId)];
    return typeof value === "string" && value !== "" ? value : undefined;
  }

  /**
   * ROUND-34: all held key VALUES (ids not included) — used by the runtime to
   * scrub secrets from persisted tool-output summaries. Never logged.
   */
  list(): string[] {
    return Object.entries(this.#env)
      .filter(([name]) => name.startsWith("ACUTE_PROVIDER_"))
      .map(([, value]) => value)
      .filter((value): value is string => typeof value === "string" && value !== "");
  }

  // ── ROUND-36 (ADR-0022): the API key POOL ──────────────────────────────
  // Primary = ACUTE_PROVIDER_<ID>; pool slots = ACUTE_PROVIDER_<ID>_SLOT<N>
  // (N ≥ 1). ROUND-92 (R92-D) supersedes ROUND-36's "sub-agents prefer pool
  // slots so the primary isn't burdened" split: ONE pool now serves the main
  // agent AND sub-agents alike (load-spreading by reservation, juggling on
  // failure — see resolveKeyPool below and runtime.ts's turn runners).

  static slotEnvVarName(providerId: string, slot: number): string {
    return slot === 0
      ? ProviderKeyring.envVarName(providerId)
      : `${ProviderKeyring.envVarName(providerId)}_SLOT${slot}`;
  }

  /** One pool entry per held key (slot 0 = primary). Never logged. */
  getPool(providerId: string): Array<{ slot: number; key: string }> {
    const pool: Array<{ slot: number; key: string }> = [];
    for (let slot = 0; slot < 32; slot++) {
      const value = this.#env[ProviderKeyring.slotEnvVarName(providerId, slot)];
      if (typeof value === "string" && value !== "") pool.push({ slot, key: value });
    }
    return pool;
  }

  /** Pool metadata for the UI (masked — the key value NEVER leaves). */
  poolInfo(providerId: string): Array<{ slot: number; hasKey: boolean; masked: string | null }> {
    const info: Array<{ slot: number; hasKey: boolean; masked: string | null }> = [];
    const maxSlot = Math.max(
      0,
      ...Object.keys(this.#env)
        .filter((name) => name.startsWith(`${ProviderKeyring.envVarName(providerId)}_SLOT`))
        .map((name) => Number(name.split("_SLOT")[1] ?? 0))
        // R93: slot 1 counts. The R92-D3 UI lowered the pool floor to slot 1
        // (MIN_POOL_SLOT = 1), so the FIRST added key lands at slot 1 — a
        // provider holding [primary + slot 1] computed maxSlot = 0 here and
        // the Settings keys card listed only Key 1 while the provider row's
        // chip said "2 keys" (getPool/resolveKeyPool scan 0..31 and never
        // had the hole). >= 1, not >= 2.
        .filter((n) => Number.isInteger(n) && n >= 1),
    );
    for (let slot = 0; slot <= Math.max(maxSlot, 0); slot++) {
      const value = this.#env[ProviderKeyring.slotEnvVarName(providerId, slot)];
      info.push({
        slot,
        hasKey: typeof value === "string" && value !== "",
        masked:
          typeof value === "string" && value !== ""
            ? `${value.slice(0, 4)}…${value.slice(-4)}`
            : null,
      });
    }
    return info;
  }

  /**
   * ROUND-47 (R47-b): read ONE pool slot (0 = primary). Undefined when that
   * slot holds no key — the route turns that into a 409 naming the slot.
   * Symmetric with setSlot; the value never leaves the process except as a
   * Bearer header inside testProviderConnection.
   */
  getSlot(providerId: string, slot: number): string | undefined {
    const value = this.#env[ProviderKeyring.slotEnvVarName(providerId, slot)];
    return typeof value === "string" && value !== "" ? value : undefined;
  }

  /** Write a pool slot (0 = primary; the existing set() alias). */
  setSlot(providerId: string, slot: number, key: string): void {
    if (slot === 0) {
      this.set(providerId, key);
      return;
    }
    const name = ProviderKeyring.slotEnvVarName(providerId, slot);
    if (key === "") delete this.#env[name];
    else this.#env[name] = key;
    modelCache.delete(providerId);
  }

  /**
   * Shell handoff (POST /internal/providers/keys): rotate a key in-memory so
   * a connection test right after Save uses the new key without a respawn.
   * Empty string deletes. Never logged, never returned.
   */
  set(providerId: string, key: string): void {
    const name = ProviderKeyring.envVarName(providerId);
    if (key === "") delete this.#env[name];
    else this.#env[name] = key;
    modelCache.delete(providerId);
  }

  /**
   * ROUND-87 (R87, POST /system/reset): drop EVERY ACUTE_PROVIDER_* entry
   * from the in-memory snapshot. The running sidecar outlives the webview
   * reload, so without this the reset would leave the spawn-time env keys
   * (Credential Manager values injected at boot) alive in memory — a
   * provider test right after reset would still succeed on a key the owner
   * just erased. Never logged, never returned.
   */
  clear(): void {
    for (const name of Object.keys(this.#env)) {
      if (name.startsWith("ACUTE_PROVIDER_")) delete this.#env[name];
    }
    modelCache.clear();
  }
}

/* ── ROUND-92 (R92-D): the pool RESOLUTION policy ────────────────────────── */

/** One entry of a provider's RESOLVED key pool (R92-D). */
export interface ResolvedPoolKey {
  slot: number;
  key: string;
}

/**
 * ROUND-92 (R92-D, the owner's multi-key pool with automatic juggling):
 * resolve a provider's key pool for TURN USE — `keyring.getPool`'s raw
 * slot list, DEDUPED by key VALUE (the same key saved into two slots is
 * ONE key: swapping to it would "retry" the identical credentials),
 * slot-order preserved (slot 0 = the primary first), empty entries
 * dropped.
 *
 * WHY this lives in registry.ts (and not next to prepareTurn, the other
 * candidate): the derivation is provider-keyring POLICY with THREE
 * consumers that must never disagree — prepareTurn (the turn's juggling
 * pool), the orchestrator's tryReserveSlot (load-spreading + perKeyLimit
 * must count per distinct KEY, not per slot label), and toView's
 * keyCount (what the Settings UI shows). Keeping it beside the keyring it
 * reads gives all three ONE truth without importing runtime.ts (which
 * would cycle: runtime → registry is already an edge).
 *
 * Never logs; returns key VALUES only to in-process callers (the turn
 * runners), never through an HTTP response.
 */
export function resolveKeyPool(keyring: ProviderKeyring, providerId: string): ResolvedPoolKey[] {
  const seen = new Set<string>();
  const pool: ResolvedPoolKey[] = [];
  for (const entry of keyring.getPool(providerId)) {
    if (entry.key === "" || seen.has(entry.key)) continue;
    seen.add(entry.key);
    pool.push({ slot: entry.slot, key: entry.key });
  }
  return pool;
}

function toView(record: ProviderRecord, keyring: ProviderKeyring): ProviderView {
  return {
    ...record,
    hasKey: keyring.has(record.id),
    // R92-D: the deduped pool size — the number of keys the turn runners
    // would actually juggle for this provider.
    keyCount: resolveKeyPool(keyring, record.id).length,
  };
}

/** The openrouter row is seeded by openDatabase (storage/providers.ts), so this is a plain read. */
export function listProviderViews(db: SqliteDatabase, keyring: ProviderKeyring): ProviderView[] {
  return listProviderRecords(db).map((record) => toView(record, keyring));
}

export function resolveProvider(db: SqliteDatabase, id: string): ProviderRecord | undefined {
  return getProviderRecord(db, id);
}

export interface ModelSummary {
  id: string;
  name: string;
  /** ROUND-95 (R95-B): the model's DETECTED reasoning capability, read off
   * the provider's /models catalog when it exposes one (OpenRouter:
   * `supported_parameters` containing "reasoning" + the `reasoning`
   * object — see extractReasoningSupport below). ABSENT = the catalog said
   * nothing (a provider that exposes no reasoning metadata — NVIDIA NIM,
   * Anthropic's own /v1/models, …): UNKNOWN, never "unsupported", and
   * never something a consumer blocks on. Served additively by GET
   * /providers/:id/models (the Add Models dialog) and consumed by the
   * reasoning merge/prefill in routes/providers.ts. */
  reasoningSupport?: ModelReasoningSupport;
}

export interface ProviderModelsResult {
  models: ModelSummary[];
  cached: boolean;
}

/** Distinguishes upstream fetch failures (route-mapped to 502 PROVIDER_ERROR). */
export class ProviderFetchError extends Error {}

/**
 * The probe RAN and the provider answered negatively (bad key, unknown
 * model, …). The route maps this to HTTP 200 {ok:false, message} — a test
 * that executed and failed is a successful test call, not a server error.
 */
export class ProviderTestError extends Error {}

const modelCache = new Map<string, { expiresAt: number; models: ModelSummary[] }>();

/** Test hook: the cache is module-level state. */
export function clearModelCache(): void {
  modelCache.clear();
}

/** Strips key material from any error text before it reaches a response or log.
 * ROUND-80 (R80, owner: "for error messages raw messages should be shown
 * too"): the readability cap 500 → 4000 — the Settings connection-test and
 * models-fetch surfaces show the provider's REAL error body; the old cap
 * hid everything past the first 500 chars. */
function scrub(text: string, secret: string | undefined): string {
  const base = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
  return secret === undefined || secret === "" ? base : base.split(secret).join("***");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Maps an OpenAI-compatible `{data: [{id, name?}, …]}` /models body. */
function parseModels(body: unknown): ModelSummary[] {
  if (typeof body !== "object" || body === null || !Array.isArray((body as { data?: unknown }).data)) {
    return [];
  }
  const models: ModelSummary[] = [];
  for (const entry of (body as { data: unknown[] }).data) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== "string" || id === "") continue;
    const name = record.name;
    // ROUND-95 (R95-B): the reasoning bit rides along when the provider's
    // catalog carries one (additive — absent for providers without the
    // metadata).
    const reasoning = extractReasoningSupport(record);
    models.push({
      id,
      name: typeof name === "string" && name !== "" ? name : id,
      ...(reasoning !== null ? { reasoningSupport: reasoning } : {}),
    });
  }
  return models;
}

/* ── ROUND-95 (R95-B): catalog reasoning detection ─────────────────────── */

/**
 * Fold a provider's raw reasoning-effort list into the shared
 * ReasoningEffortLevel vocabulary. OpenRouter's live ladder is wider than
 * the R50-era wire side (verified against the 2026-09 /api/v1/models
 * snapshot):
 *
 * ROUND-96 (R96-F, the owner: "I tested a model which supported high and
 * max but it apparently did not detect that properly and was showing the
 * default options. This should not happen"): "xhigh" and "max" are now
 * REAL rungs — kept VERBATIM, never folded down (the R95 fold made a
 * detected ['max','high','low'] model render exactly like the
 * unknown-capabilities default). "none" is a DISABLE switch rather than an
 * effort and is DROPPED, and anything else unrecognized is dropped.
 * Deduped and ordered by the shared vocabulary so every stored blob is
 * canonical.
 */
export function normalizeReasoningEfforts(raw: readonly string[]): ReasoningEffortLevel[] {
  return REASONING_EFFORT_LEVELS.filter((level) => raw.includes(level));
}

/** Membership in the shared wire vocabulary (shared owns the truth). */
function isReasoningEffortLevel(value: string): value is ReasoningEffortLevel {
  return (REASONING_EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * ROUND-95 (R95-B): read ONE catalog entry's reasoning capability — the
 * OpenRouter /models shape (the only provider observed carrying these
 * fields; any OpenAI-compatible gateway that mirrors the shape gets the
 * same detection for free):
 *   · supported_parameters: string[] — contains "reasoning" when the model
 *     accepts the reasoning parameter (312 of 445 entries on the 2026-09
 *     snapshot). AUTHORITATIVE when present: a few entries carry a `reasoning`
 *     object without listing the parameter (rekaai/reka-edge,
 *     qwen/qwen3-max, … — re-verified live) and those read as NOT supported,
 *     while openrouter/auto* list the parameter with NO reasoning object
 *     (supported, empty ladder);
 *   · reasoning?: { mandatory?, default_enabled?, supported_efforts?:
 *     string[], default_effort? } — the effort ladder when the provider
 *     publishes one (e.g. ["max","xhigh","high","medium","low"],
 *     ["high","medium","low"]); plain reasoning-only entries (deepseek-r1)
 *     carry the object with NO supported_efforts → supported with an
 *     empty ladder.
 *
 * ROUND-96 (R96-F): `default_effort` is parsed too — the provider's own
 * published default rung (live 2026-09-13: deepseek-v4.1-flash defaults
 * "high" on ['max','high','low'], z-ai/glm-5.3 defaults "max",
 * grok-4.6 "high", nemotron-3-super "medium"). Normalized through the same
 * vocabulary membership as the ladder (a "none"/unrecognized default reads
 * as ABSENT — "none" is a disable switch, not a rung). Absent → undefined.
 *
 * Returns null when the entry carries NEITHER field — a provider that
 * exposes no reasoning metadata must stay UNKNOWN, never "unsupported"
 * (the never-block-on-null contract the runtime relies on).
 */
function extractReasoningSupport(entry: Record<string, unknown>): ModelReasoningSupport | null {
  const params = entry.supported_parameters;
  const reasoning = entry.reasoning;
  const hasParams = Array.isArray(params);
  const hasReasoningObject = typeof reasoning === "object" && reasoning !== null;
  if (!hasParams && !hasReasoningObject) return null;
  // supported_parameters is the authoritative signal when present; a bare
  // reasoning object (no parameter list) still means supported.
  const supported = hasParams ? (params as unknown[]).includes("reasoning") : true;
  const effortsRaw = hasReasoningObject
    ? (reasoning as { supported_efforts?: unknown }).supported_efforts
    : undefined;
  const efforts = Array.isArray(effortsRaw)
    ? normalizeReasoningEfforts(effortsRaw.filter((e): e is string => typeof e === "string"))
    : [];
  const defaultRaw = hasReasoningObject
    ? (reasoning as { default_effort?: unknown }).default_effort
    : undefined;
  const defaultEffort =
    typeof defaultRaw === "string" && isReasoningEffortLevel(defaultRaw) ? defaultRaw : undefined;
  return {
    supported,
    efforts,
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
  };
}

/**
 * Fetches `{baseUrl}/models` with plain fetch, caching successful responses in
 * memory for 5 minutes. Returns undefined when the provider id is unknown.
 */
export async function fetchProviderModels(
  db: SqliteDatabase,
  keyring: ProviderKeyring,
  id: string,
): Promise<ProviderModelsResult | undefined> {
  const provider = resolveProvider(db, id);
  if (provider === undefined || provider.baseUrl === null) return undefined;

  const cached = modelCache.get(id);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return { models: cached.models, cached: true };
  }

  const apiKey = keyring.get(id);
  const endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/models`;
  const headers: Record<string, string> =
    apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` };

  let response: Response;
  try {
    response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw new ProviderFetchError(scrub(`GET ${endpoint} failed: ${errorMessage(error)}`, apiKey));
  }
  if (!response.ok) {
    throw new ProviderFetchError(`GET ${endpoint} answered HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new ProviderFetchError(scrub(`GET ${endpoint} returned a non-JSON body: ${errorMessage(error)}`, apiKey));
  }
  const models = parseModels(body);
  if (models.length === 0) {
    throw new ProviderFetchError(`GET ${endpoint} returned no usable model entries`);
  }
  modelCache.set(id, { expiresAt: Date.now() + MODEL_CACHE_TTL_MS, models });
  return { models, cached: false };
}

/** Result of the wizard's usability probe (API.md §8.6): `model` echoes the requested one. */
export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  model?: string;
  /** Present on ok:false (reason) and on model-less reachability probes. */
  message?: string;
}

/**
 * Minimal authenticated usability probe behind POST /providers/:id/test: a
 * cheap `GET {baseUrl}/models` WITH the key (no tokens spent). Deliberately
 * bypasses the model cache and never writes it; failures surface as
 * ProviderFetchError with key-scrubbed messages (route maps to 502).
 * The caller has already checked provider existence (404) and key presence
 * (409); the empty-header fallback keeps this function safe standalone.
 *
 * ROUND-47 (R47-b): `keyOverride` probes a specific KEY-POOL slot instead of
 * the primary (the route resolves the slot's key and 409s when it is empty).
 * Omitted → the primary key, exactly the pre-R47 behavior. Every downstream
 * use (Bearer header + scrub) carries whichever key was resolved.
 */
export async function testProviderConnection(
  keyring: ProviderKeyring,
  provider: ProviderRecord,
  model?: string,
  keyOverride?: string,
): Promise<ProviderTestResult> {
  if (provider.baseUrl === null) {
    throw new ProviderFetchError(`provider '${provider.id}' has no baseUrl to test`);
  }
  const apiKey = keyOverride ?? keyring.get(provider.id);
  if (apiKey === undefined) {
    throw new ProviderTestError(`no API key held for provider '${provider.id}'`);
  }
  const base = provider.baseUrl.replace(/\/+$/, "");

  // With a model: REAL probe — a one-token completion. This is the only way
  // to validate both the key and the model (owner round-8: the old /models
  // ping "succeeded" for garbage keys — OpenRouter's catalog is public — and
  // never checked the model id at all).
  if (model !== undefined) {
    const endpoint = `${base}/chat/completions`;
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ProviderFetchError(
        scrub(`POST ${endpoint} failed: ${errorMessage(error)}`, apiKey),
      );
    }
    const latencyMs = Date.now() - startedAt;
    if (response.ok) {
      // Drain so the socket is released; the status already proved both sides.
      try {
        await response.arrayBuffer();
      } catch {
        // Truncated 200 body still proves key + model accepted.
      }
      return { ok: true, latencyMs, model };
    }
    const detail = await upstreamErrorDetail(response, apiKey);
    if (response.status === 401 || response.status === 403) {
      throw new ProviderTestError(`key rejected by provider (HTTP ${response.status})${detail}`);
    }
    if (response.status === 404 || response.status === 400 || response.status === 422) {
      throw new ProviderTestError(
        `provider rejected the request (HTTP ${response.status})${detail} — check the model id`,
      );
    }
    throw new ProviderTestError(`provider answered HTTP ${response.status}${detail}`);
  }

  // Without a model: transport-level reachability probe only (some providers'
  // /models endpoints are public, so this does NOT prove the key).
  const endpoint = `${base}/models`;
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProviderFetchError(scrub(`GET ${endpoint} failed: ${errorMessage(error)}`, apiKey));
  }
  const latencyMs = Date.now() - startedAt;
  if (!response.ok) {
    // ROUND-95 (R95-B, owner: "By just directly checking it, it does not
    // give the actual error message which I got"): the reachability-only
    // branch now surfaces the provider's REAL error body — the same
    // upstreamErrorDetail call the model branch already made (scrubbed,
    // 2000-char cap). The old bare "key rejected by provider (HTTP 401)"
    // forced the owner to guess at what the provider actually said.
    const detail = await upstreamErrorDetail(response, apiKey);
    if (response.status === 401 || response.status === 403) {
      throw new ProviderTestError(`key rejected by provider (HTTP ${response.status})${detail}`);
    }
    throw new ProviderFetchError(`GET ${endpoint} answered HTTP ${response.status}${detail}`);
  }
  try {
    await response.arrayBuffer();
  } catch {
    // A truncated body after HTTP 200 still proves the connection worked.
  }
  return {
    ok: true,
    latencyMs,
    message: "Reachable — pick a model for a full key + model test.",
  };
}

/** Best-effort upstream error message, scrubbed and length-capped. */
async function upstreamErrorDetail(response: Response, apiKey: string): Promise<string> {
  try {
    const text = await response.text();
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && "error" in parsed) {
      const err = (parsed as { error?: { message?: unknown } }).error;
      if (err !== null && typeof err === "object" && typeof err.message === "string") {
        // ROUND-80 (R80): raw error bodies — 160 → 2000 (the same
        // raw-messages ask; the connection-test line carries the real text).
        return `: ${scrub(err.message.slice(0, 2000), apiKey)}`;
      }
    }
  } catch {
    // Non-JSON body — no extra detail.
  }
  return "";
}

// ── ROUND-82 (R82, owner: "a test button … check if the model is working
//    properly or not" + "not only check for a response, but also check if
//    the response is reasonable"): the PER-MODEL test probe. ────────────────
//
// The provider-level probe above (testProviderConnection) validates the KEY
// and the provider; its model branch spends ONE token and never reads the
// body. This probe validates the MODEL ROW: a real 64-token completion whose
// CONTENT is checked (non-empty, shown to the owner as a preview), with the
// verdict broken into named checks (http / auth / modelAccepted /
// nonEmptyContent) and the provider's raw error body surfaced verbatim (the
// R80 raw-messages discipline) — so "NVIDIA model X is EOL'd" shows the real
// 410 body instead of a generic failure.

/** 30 s — reasoning models are slow to first token; the provider-level 15 s
 * probe stays as-is (it spends 1 token and drains). */
const MODEL_TEST_TIMEOUT_MS = 30_000;

const MODEL_TEST_PROMPT = "Reply with exactly one word: pong";

/** The checks the probe runs, in order — surfaced individually so the UI can
 * show exactly WHICH stage failed (e.g. auth ok, model id rejected). */
export interface ModelTestChecks {
  /** The HTTP round-trip completed (DNS/TLS/route ok, any status). */
  http: boolean;
  /** The key was accepted (non-401/403). */
  auth: boolean;
  /** The provider accepted the model id (non-400/404/410/422, no
   * error object in a 200 body — some OpenAI-compatible gateways do that). */
  modelAccepted: boolean;
  /** The parsed reply had non-blank text. */
  nonEmptyContent: boolean;
}

/** POST /models/:id/test result. ok:true means every check passed; ok:false
 * carries the first failing check's reason (HTTP 200 either way — a probe
 * that RAN and got a NO is a successful test call, the same semantics as
 * the provider test above). */
export interface ModelTestResult {
  ok: boolean;
  latencyMs: number;
  providerId: string;
  model: string;
  checks: ModelTestChecks;
  /** First ≤200 chars of the reply, scrubbed — the owner's eyeball-judge of
   * "is the response reasonable" (deliberately NOT LLM-graded; see the
   * spec: a second model call adds cost + a second failure mode). */
  contentPreview?: string;
  /** Provider-reported usage when present (chat-completions usage /
   * anthropic usage / responses usage). */
  usage?: { inputTokens: number; outputTokens: number };
  /** Present on ok:false — the reason the probe failed, scrubbed. */
  reason?: string;
}

/** Parse the reply text + usage from a chat-completions body. */
function parseChatCompletionsBody(
  body: unknown,
): { text: string; usage: { inputTokens: number; outputTokens: number } | undefined } {
  if (typeof body !== "object" || body === null) return { text: "", usage: undefined };
  const record = body as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0];
  const message =
    typeof first === "object" && first !== null
      ? (first as { message?: { content?: unknown } }).message
      : undefined;
  const content = message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((c) =>
              typeof c === "object" && c !== null && "text" in (c as Record<string, unknown>)
                ? String((c as { text?: unknown }).text ?? "")
                : "",
            )
            .join("")
        : "";
  const usageRecord =
    typeof record.usage === "object" && record.usage !== null
      ? (record.usage as { prompt_tokens?: unknown; completion_tokens?: unknown })
      : undefined;
  const usage =
    usageRecord !== undefined &&
    typeof usageRecord.prompt_tokens === "number" &&
    typeof usageRecord.completion_tokens === "number"
      ? { inputTokens: usageRecord.prompt_tokens, outputTokens: usageRecord.completion_tokens }
      : undefined;
  return { text: text.trim(), usage };
}

/** Parse the reply text + usage from an anthropic-messages body. */
function parseAnthropicBody(
  body: unknown,
): { text: string; usage: { inputTokens: number; outputTokens: number } | undefined } {
  if (typeof body !== "object" || body === null) return { text: "", usage: undefined };
  const record = body as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  const text = content
    .map((c) => {
      if (typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text") {
        return String((c as { text?: unknown }).text ?? "");
      }
      return "";
    })
    .join("")
    .trim();
  const usageRecord =
    typeof record.usage === "object" && record.usage !== null
      ? (record.usage as { input_tokens?: unknown; output_tokens?: unknown })
      : undefined;
  const usage =
    usageRecord !== undefined &&
    typeof usageRecord.input_tokens === "number" &&
    typeof usageRecord.output_tokens === "number"
      ? { inputTokens: usageRecord.input_tokens, outputTokens: usageRecord.output_tokens }
      : undefined;
  return { text, usage };
}

/**
 * The per-model probe behind POST /models/:id/test. Sends a REAL one-word
 * completion request and grades the response:
 *   1. http — the round-trip completed;
 *   2. auth — 401/403 means the key was rejected;
 *   3. modelAccepted — 400/404/410/422 (or an error object in a 200 body)
 *      means the model id is wrong/EOL'd for this provider;
 *   4. nonEmptyContent — the parsed reply is non-blank.
 *
 * Branches on provider.apiFormat (the provider-level probe's gap — it
 * hardcodes /chat/completions): chat-completions, anthropic-messages (the
 * exact header/body pattern the vision relay uses — x-api-key +
 * anthropic-version), and responses (implemented: POST /responses with the
 * OpenAI Responses shape; honest ok:false when the provider's dialect
 * differs — surfaced verbatim).
 *
 * Scrubbing: the resolved key value (exact-match) PLUS the shared
 * secret-shape prefixes (sk-…/nvapi-…/github_pat_… — lib/secret-shapes.ts,
 * the R82 consolidation). Content previews cap at 200 chars.
 *
 * The caller (the route) has already 404'd unknown model rows and 409'd
 * missing keys — this function still guards both for standalone safety
 * (ProviderTestError/ProviderFetchError, same mapping as above).
 */
export async function testModelResponse(
  keyring: ProviderKeyring,
  provider: ProviderRecord,
  modelId: string,
  keyOverride?: string,
): Promise<ModelTestResult> {
  if (provider.baseUrl === null) {
    throw new ProviderFetchError(`provider '${provider.id}' has no baseUrl to test`);
  }
  const apiKey = keyOverride ?? keyring.get(provider.id);
  if (apiKey === undefined) {
    throw new ProviderTestError(`no API key held for provider '${provider.id}'`);
  }
  const base = provider.baseUrl.replace(/\/+$/, "");
  const apiFormat = provider.apiFormat ?? "chat-completions";
  const startedAt = Date.now();

  /** All-scrub: exact key + shape prefixes. */
  const clean = (text: string): string => scrubSecretShapes(scrub(text, apiKey));

  let response: Response;
  try {
    if (apiFormat === "anthropic-messages") {
      response = await fetch(`${base}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 64,
          messages: [{ role: "user", content: MODEL_TEST_PROMPT }],
        }),
        signal: AbortSignal.timeout(MODEL_TEST_TIMEOUT_MS),
      });
    } else if (apiFormat === "responses") {
      response = await fetch(`${base}/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
          input: MODEL_TEST_PROMPT,
          max_output_tokens: 64,
        }),
        signal: AbortSignal.timeout(MODEL_TEST_TIMEOUT_MS),
      });
    } else {
      response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: MODEL_TEST_PROMPT }],
          max_tokens: 64,
          temperature: 0,
          stream: false,
        }),
        signal: AbortSignal.timeout(MODEL_TEST_TIMEOUT_MS),
      });
    }
  } catch (error) {
    // Transport failure (timeout/DNS/refused) — http itself failed.
    throw new ProviderFetchError(
      clean(`POST ${base} model test failed: ${errorMessage(error)}`),
    );
  }
  const latencyMs = Date.now() - startedAt;
  const checks: ModelTestChecks = {
    http: true,
    auth: response.status !== 401 && response.status !== 403,
    modelAccepted: true,
    nonEmptyContent: false,
  };

  if (response.status === 401 || response.status === 403) {
    const detail = await upstreamErrorDetail(response, apiKey);
    return {
      ok: false,
      latencyMs,
      providerId: provider.id,
      model: modelId,
      checks: { ...checks, auth: false },
      reason: `key rejected by provider (HTTP ${response.status})${detail}`,
    };
  }
  if (
    response.status === 400 ||
    response.status === 404 ||
    response.status === 410 ||
    response.status === 422
  ) {
    const detail = await upstreamErrorDetail(response, apiKey);
    return {
      ok: false,
      latencyMs,
      providerId: provider.id,
      model: modelId,
      checks: { ...checks, modelAccepted: false },
      reason: `provider rejected the request (HTTP ${response.status})${detail} — check the model id`,
    };
  }
  if (!response.ok) {
    const detail = await upstreamErrorDetail(response, apiKey);
    return {
      ok: false,
      latencyMs,
      providerId: provider.id,
      model: modelId,
      checks,
      reason: `provider answered HTTP ${response.status}${detail}`,
    };
  }

  // HTTP 200 — parse the body per format; a 200-with-error-body (some
  // OpenAI-compatible gateways) fails modelAccepted.
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return {
      ok: false,
      latencyMs,
      providerId: provider.id,
      model: modelId,
      checks: { ...checks, modelAccepted: false },
      reason: clean(`provider returned a non-JSON 200 body: ${errorMessage(error)}`),
    };
  }
  const errorInBody = readErrorFromOkBody(body);
  if (errorInBody !== null) {
    return {
      ok: false,
      latencyMs,
      providerId: provider.id,
      model: modelId,
      checks: { ...checks, modelAccepted: false },
      reason: clean(`provider returned HTTP 200 with an error body: ${errorInBody}`),
    };
  }

  const parsed =
    apiFormat === "anthropic-messages"
      ? parseAnthropicBody(body)
      : apiFormat === "responses"
        ? parseResponsesBody(body)
        : parseChatCompletionsBody(body);
  if (parsed.text === "") {
    return {
      ok: false,
      latencyMs,
      providerId: provider.id,
      model: modelId,
      checks,
      reason: "model returned an empty response (HTTP 200, no content)",
    };
  }
  return {
    ok: true,
    latencyMs,
    providerId: provider.id,
    model: modelId,
    checks: { ...checks, nonEmptyContent: true },
    contentPreview: clean(parsed.text.slice(0, 200)),
    ...(parsed.usage !== undefined ? { usage: parsed.usage } : {}),
  };
}

/** Some OpenAI-compatible gateways answer 200 with `{"error": …}` — read the
 * message when present (the modelAccepted failure class). */
function readErrorFromOkBody(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as { error?: unknown };
  if (record.error === undefined || record.error === null) return null;
  if (typeof record.error === "string") return record.error;
  if (typeof record.error === "object") {
    const message = (record.error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "unrecognized error object in a 200 body";
}

/** Parse the reply text + usage from an OpenAI Responses-format body. */
function parseResponsesBody(
  body: unknown,
): { text: string; usage: { inputTokens: number; outputTokens: number } | undefined } {
  if (typeof body !== "object" || body === null) return { text: "", usage: undefined };
  const record = body as Record<string, unknown>;
  // output_text convenience field first (OpenAI), then the output array.
  const outputText =
    typeof record.output_text === "string"
      ? record.output_text
      : Array.isArray(record.output)
        ? (record.output as unknown[])
            .map((item) => {
              if (typeof item !== "object" || item === null) return "";
              const itemRecord = item as { type?: unknown; content?: unknown };
              if (itemRecord.type !== "message") return "";
              const parts = Array.isArray(itemRecord.content) ? itemRecord.content : [];
              return parts
                .map((p) =>
                  typeof p === "object" && p !== null && "text" in (p as Record<string, unknown>)
                    ? String((p as { text?: unknown }).text ?? "")
                    : "",
                )
                .join("");
            })
            .join("")
        : "";
  const usageRecord =
    typeof record.usage === "object" && record.usage !== null
      ? (record.usage as { input_tokens?: unknown; output_tokens?: unknown })
      : undefined;
  const usage =
    usageRecord !== undefined &&
    typeof usageRecord.input_tokens === "number" &&
    typeof usageRecord.output_tokens === "number"
      ? { inputTokens: usageRecord.input_tokens, outputTokens: usageRecord.output_tokens }
      : undefined;
  return { text: outputText.trim(), usage };
}
