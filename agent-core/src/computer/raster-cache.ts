/**
 * ROUND-67 (R67-D): the module-level RASTER REGISTRY behind the live
 * screenshot THUMBNAILS in the agent's chat window. The owner: "if the agent
 * takes screenshots or does some image work, then the images should be shown
 * during its thinking in the agent's chat window itself, in a small view."
 *
 * The computer-use dispatcher already captures PNG rasters (screenshot /
 * zoom / get_app_state includeScreenshot) and the browser_control screenshot
 * action captures the panel region — but those bytes lived ONLY inside the
 * tool call (the dispatcher's private 3-frame cache for the vision relay, or
 * the plugin-local raster that dies with the call). The tool RESULT rides
 * the SSE as outputSummary text, so the chat could never show the image.
 *
 * This registry is the ROUTE-SIDE leg of the pipeline: the plugins copy the
 * png base64 here (keyed by the frame id they already returned, or a minted
 * `bs_<base36>` id for browser captures) and emit a `{type:"screenshot"}`
 * SSE frame; the frontend then fetches
 * GET /computer-use/frames/:frameId/raster (server.ts) for the thumbnail.
 *
 * HONESTY LIMITS (deliberate, documented):
 *   · EPHEMERAL — in-memory only. Rasters are NEVER persisted (no disk, no
 *     event log, no session store) and NEVER fed to the model (the
 *     model-facing tool result is unchanged — metadata + optional vision
 *     text). A restarted sidecar serves 404s; a reloaded chat shows nothing
 *     (screenshots are "what the agent saw WHILE it worked", not a record).
 *   · LRU cap 12 — a screenshot-heavy turn evicts the OLDEST thumbnails.
 *   · TTL 10 minutes — the honest "expired" placeholder tile in the chat
 *     after that; rasterFor returns null forever after (and drops the entry).
 */

/** Max entries kept (LRU: the oldest is evicted on insert overflow). */
const MAX_ENTRIES = 12;

/** A registered raster dies of old age after 10 minutes. */
const TTL_MS = 10 * 60 * 1000;

interface RasterEntry {
  pngBase64: string;
  ts: number;
}

/** Insertion-ordered Map = the LRU clock (newest/re-touched last). */
const cache = new Map<string, RasterEntry>();

/**
 * Register (or re-register — a re-set refreshes both recency and ts) a PNG
 * raster under an id. Called by the plugins right after a successful capture,
 * BEFORE the SSE frame is emitted, so the frontend's immediate fetch always
 * finds the bytes.
 */
export function registerRaster(id: string, pngBase64: string): void {
  // delete-then-set: a re-registration moves the key to the LRU tail AND
  // resets its TTL clock (the freshest capture is the one worth keeping).
  cache.delete(id);
  cache.set(id, { pngBase64, ts: Date.now() });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * The raster for an id, or an honest null: never registered, LRU-evicted, or
 * expired (TTL). Expired entries are DROPPED here — a second lookup can never
 * resurrect them.
 */
export function rasterFor(id: string): { pngBase64: string; ts: number } | null {
  const entry = cache.get(id);
  if (entry === undefined) return null;
  if (Date.now() - entry.ts > TTL_MS) {
    cache.delete(id);
    return null;
  }
  return { pngBase64: entry.pngBase64, ts: entry.ts };
}

/** Test hook: a clean registry between tests (TTL/LRU carry no state). */
export function resetRasterCacheForTest(): void {
  cache.clear();
}
