/**
 * ROUND-47 (R47-c1): pure key-pool slot math.
 *
 * KeyPoolSection (Models & Providers) used to compute the next add-slot as
 * `slots.length + 2` — which COLLIDES whenever the pool has a gap (slots 2
 * and 4 held → length 2 → the next add silently OVERWRITES slot 4's key).
 * This helper is the fix: the first slot in [min, max] that is not held.
 *
 * ROUND-92 (R92-D3): the pool floor moved 2 → 1. The owner's multi-key
 * rework made slot 1 a first-class pool slot (the Tauri shell validates
 * 1..=31, and every key joggles — there is no “sub-agent-only” slot range
 * anymore), and the old hardcoded SubAgentsTab paste-slot UI that started
 * at 2 is deleted. `nextFreeSlot` now defaults to [1, 31].
 *
 * ROUND-58 (R58-d): also home to the key-REVEAL client fn (the owner's
 * explicit "every single one of the API keys, without any issues" demand —
 * POST /providers/:id/keys/reveal, the one route that returns key values).
 * It lives HERE rather than api.ts deliberately: api.ts is another agent's
 * file this round, and the reveal contract (full values, explicit user
 * action, never auto-fetched) is key-pool domain logic.
 */
import { ApiError } from "./api";
import { useConfigStore } from "./config-store";

/** Pool slots are addressable 1–31 (slot 0 = the PRIMARY key — its editor
 * writes it through the primary store path, never through the pool math). */
export const MIN_POOL_SLOT = 1;
export const MAX_POOL_SLOT = 31;

/**
 * The first free slot in [min, max] not present in `heldSlots`, or -1 when
 * the whole range is held (the caller surfaces "pool is full"). Pure: no
 * mutation, order/duplicates/out-of-range entries in `heldSlots` are fine —
 * a held slot 0 (the primary) never blocks the scan, which starts at 1.
 */
export function nextFreeSlot(heldSlots: number[], min = MIN_POOL_SLOT, max = MAX_POOL_SLOT): number {
  const held = new Set(heldSlots);
  for (let slot = min; slot <= max; slot++) {
    if (!held.has(slot)) return slot;
  }
  return -1;
}

/** One revealed key: the slot number plus the FULL value (R58-d contract). */
export interface RevealedKey {
  slot: number;
  value: string;
}

/**
 * ROUND-58 (R58-d): POST /providers/:id/keys/reveal — fetches the FULL key
 * values for every slot the provider holds (slot 0 = the primary, plus the
 * pool slots). Mirrors src/lib/api.ts's request() conventions (baseUrl +
 * bearer token from the config store, typed error envelopes → ApiError)
 * without touching that file. Call this ONLY on an explicit user action —
 * revealed values are for display, never for logging.
 */
export async function revealProviderKeys(providerId: string): Promise<RevealedKey[]> {
  const { baseUrl, token } = useConfigStore.getState();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/v1/providers/${encodeURIComponent(providerId)}/keys/reveal`, {
      method: "POST",
      headers,
    });
  } catch (cause) {
    throw new ApiError(
      0,
      "NETWORK",
      `Could not reach agent-core at ${baseUrl} (${String(cause)})`,
    );
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }

  if (!res.ok) {
    const envelope =
      body && typeof body === "object" && "error" in body
        ? (body as { error?: { code?: unknown; message?: unknown } }).error
        : undefined;
    throw new ApiError(
      res.status,
      typeof envelope?.code === "string" ? envelope.code : "UNKNOWN",
      typeof envelope?.message === "string" ? envelope.message : `Request failed with HTTP ${res.status}`,
    );
  }

  const keys = body && typeof body === "object" ? (body as { keys?: unknown }).keys : undefined;
  if (!Array.isArray(keys)) throw new ApiError(res.status, "UNKNOWN", "reveal response missing keys array");
  return keys
    .filter(
      (k): k is { slot: number; value: string } =>
        typeof k === "object" &&
        k !== null &&
        typeof (k as { slot?: unknown }).slot === "number" &&
        typeof (k as { value?: unknown }).value === "string",
    )
    .map((k) => ({ slot: k.slot, value: k.value }));
}
