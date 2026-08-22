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

/** Provider JSON as served by the API: the row plus a key-presence flag, never the key. */
export interface ProviderView {
  id: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  enabled: boolean;
  createdAt: string;
  hasKey: boolean;
}

/** In-memory map of provider id -> API key, snapshotted from the spawn environment. */
export class ProviderKeyring {
  readonly #env: Record<string, string | undefined>;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.#env = env;
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
  const endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/models`;
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProviderFetchError(scrub(`GET ${endpoint} failed: ${errorMessage(error)}`, apiKey));
  }
  const latencyMs = Date.now() - startedAt;
  if (!response.ok) {
    throw new ProviderFetchError(`GET ${endpoint} answered HTTP ${response.status}`);
  }
  // Drain the body so the socket is released — only the status proves reachability.
  try {
    await response.arrayBuffer();
  } catch {
    // A truncated body after HTTP 200 still proves the connection worked.
  }
  return { ok: true, latencyMs, ...(model === undefined ? {} : { model }) };
}
