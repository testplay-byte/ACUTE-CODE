/**
 * raster.ts — the LIVE screenshot tiles' byte pipeline (R113-c).
 *
 * THE WIRE (agent-core server.ts R67-D, read not invented): the browser /
 * computer-use plugins copy each successful capture into the in-memory raster
 * registry and announce it over the turn SSE as a sideband frame
 * `{type:"screenshot", frameId, tool, ts}`; the bytes themselves live at
 *
 *   GET /computer-use/frames/:frameId/raster  → PNG (binary, no-store)
 *
 * HONESTY LIMITS (inherited verbatim from the desktop's ScreenshotRow): the
 * rasters are EPHEMERAL server-side — in-memory only, capped (12), 10-minute
 * TTL, never persisted, never model-facing. A 404 after the TTL renders the
 * quiet "expired" tile, and the tiles are LIVE-ONLY by design: the persisted
 * event log carries NO rasters, so the folded transcript never shows them
 * (the bytes are gone by then anyway).
 *
 * THE MOBILE HALF: the bytes cross the bridge through the link manager's
 * api() with `responseBase64: true` (the R113-c native-module leg — the
 * default UTF-8 bodyText would mojibake PNG bytes), then land in the app's
 * cache directory as a real FILE whose URI feeds RN <Image> (data URIs carry
 * a size ceiling on Android; a cache file does not).
 */

import { File, Paths } from "expo-file-system";
import type { ApiSender } from "./api";
import { API_PREFIX } from "./api";

/** The raster fetch outcome — the cache URI, or the honest expired state. */
export type RasterState =
  | { uri: string; expired: false }
  | { uri: null; expired: true }
  | { uri: null; expired: false };

/**
 * Fetch one frame's PNG bytes and persist them in the cache directory
 * (`raster-<frameId>.png`) — resolves with the file URI the Image renders.
 * A 404 (TTL / LRU eviction / a restarted sidecar) resolves EXPIRED — never
 * a crash, never a retry loop (the bytes are unrecoverable by design).
 * Transport failures resolve NOT-EXPIRED/uri-null so the caller can retry on
 * its own cadence; the file write is best-effort (a failed write = expired).
 */
export async function fetchRasterFile(sender: ApiSender, frameId: string): Promise<RasterState> {
  let res;
  try {
    // responseBase64 is the R113-c native-module leg (connection.ts): the
    // PNG bytes come back as `bodyBase64` instead of a mojibake'd bodyText.
    res = await sender.api(
      `${API_PREFIX}/computer-use/frames/${encodeURIComponent(frameId)}/raster`,
      { responseBase64: true },
    );
  } catch {
    // Transport loss — transient; the caller may retry on its own cadence.
    return { uri: null, expired: false };
  }
  if (!res.ok) {
    // The honest 404 (and any other refusal) — the raster is gone for good.
    return { uri: null, expired: true };
  }
  const base64 = res.bodyBase64;
  if (base64 === undefined || base64 === "") {
    return { uri: null, expired: true };
  }
  try {
    const file = new File(Paths.cache, `raster-${frameId}.png`);
    file.write(base64, { encoding: "base64" });
    return { uri: file.uri, expired: false };
  } catch {
    // The write failed — treat as expired (never block the transcript).
    return { uri: null, expired: true };
  }
}
