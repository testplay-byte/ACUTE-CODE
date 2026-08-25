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
import {
  getProviderRecord,
  listProviderRecords,
  type ProviderRecord,
} from "../storage/providers.js";

export type SqliteDatabase = Database.Database;

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const MODEL_FETCH_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 15_000;

/** Provider JSON as served by the API: the row plus a key-presence flag, never the key. */
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
  // (N ≥ 2). Sub-agents prefer pool slots so the primary key isn't burdened.

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
        .filter((n) => Number.isInteger(n) && n >= 2),
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
}

function toView(record: ProviderRecord, keyring: ProviderKeyring): ProviderView {
  return { ...record, hasKey: keyring.has(record.id) };
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

/** Strips key material from any error text before it reaches a response or log. */
function scrub(text: string, secret: string | undefined): string {
  const base = text.length > 500 ? `${text.slice(0, 500)}…` : text;
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
    const id = (entry as Record<string, unknown>).id;
    if (typeof id !== "string" || id === "") continue;
    const name = (entry as Record<string, unknown>).name;
    models.push({ id, name: typeof name === "string" && name !== "" ? name : id });
  }
  return models;
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
 */
export async function testProviderConnection(
  keyring: ProviderKeyring,
  provider: ProviderRecord,
  model?: string,
): Promise<ProviderTestResult> {
  if (provider.baseUrl === null) {
    throw new ProviderFetchError(`provider '${provider.id}' has no baseUrl to test`);
  }
  const apiKey = keyring.get(provider.id);
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
    if (response.status === 401 || response.status === 403) {
      throw new ProviderTestError(`key rejected by provider (HTTP ${response.status})`);
    }
    throw new ProviderFetchError(`GET ${endpoint} answered HTTP ${response.status}`);
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
        return `: ${scrub(err.message.slice(0, 160), apiKey)}`;
      }
    }
  } catch {
    // Non-JSON body — no extra detail.
  }
  return "";
}
