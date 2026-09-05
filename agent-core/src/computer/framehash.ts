/**
 * ROUND-69 (R69, task 4-c-1): the FRAME PERCEPTUAL-HASH module — the pixel
 * layer's identity primitive for the two behaviors the owner's v0.68 field
 * trace demanded:
 *
 *   · STALE-FRAME AUTO-REFRESH (dispatch.ts): a coordinate action on an
 *     aged frame re-captures and compares the old vs new raster — full-frame
 *     Hamming ≤ 8 means the screen is stable and the model's coordinates are
 *     still trustworthy; a region-level Hamming ≤ 6 around the target means
 *     the TARGET is stable even though the screen moved elsewhere.
 *   · SCREENSHOT-SPAM GUARD (dispatch.ts): the 3rd consecutive
 *     model-initiated capture whose full-frame hash is ≤ 4 bits from the
 *     previous raster's is refused (screen_unchanged) — the #1 reported UX
 *     failure was the model re-capturing a static screen in a loop.
 *
 * The hash is the classic 64-bit aHash (average hash): decode the PNG,
 * grayscale (Rec.601 luma), average-pool down to 8×8, threshold each pooled
 * cell against the mean of all 64. Average pooling (not point sampling)
 * because captures of the same screen differ by sub-pixel noise and
 * anti-aliasing jitter — a cell MEAN is robust where a sampled POINT is not.
 *
 * HONESTY LIMITS (deliberate, documented):
 *   · aHash is COARSE. It answers "did the pixels materially change", never
 *     "what changed" — the caller (dispatch) owns every decision threshold;
 *     this module only computes and compares. Bit-level collisions on
 *     structurally different images are possible in theory and irrelevant
 *     at the chosen thresholds in practice.
 *   · UNDECODABLE input (a backend that returned garbage, a test fixture
 *     that is not a real PNG) returns null — every caller degrades
 *     honestly: the spam guard allows the capture, the auto-refresh falls
 *     back to the frame_stale refusal. A null hash never fails closed into
 *     a wrong decision.
 *   · The LRU below keys by frameId (supplied by the caller): the session
 *     hashes a raster at registration, then dispatch hashes a REGION of the
 *     SAME raster during a refresh — the second call reuses the decode.
 */
import { PNG } from "pngjs";

/** The 8×8 average hash + the dimensions of the hashed area. */
export interface FrameHash {
  /** 64-bit aHash — bit i = pooled cell i > mean (row-major, i = row*8+col). */
  aHash: bigint;
  /** Width of the hashed area in px (the full image, or the crop). */
  width: number;
  /** Height of the hashed area in px. */
  height: number;
}

/** An integer pixel rect (x, y = top-left; w, h ≥ 1). */
export interface HashRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Decoded-and-grayscaled raster (RGBA collapsed to Rec.601 luma bytes). */
interface DecodedRaster {
  width: number;
  height: number;
  gray: Uint8Array;
}

/** Max decoded rasters kept for re-hashing without re-decoding. */
const DECODE_CACHE_MAX = 4;

/** Insertion-ordered Map = the LRU clock (newest last, oldest first). */
const decodeCache = new Map<string, DecodedRaster>();

/**
 * Decode a base64 PNG to a grayscale raster, or null when the bytes are not
 * a decodable PNG. With `cacheKey` the decode is memoized (and a repeat hit
 * refreshes recency) so the registration-time full-frame hash and a
 * later region hash of the SAME raster share one decode.
 */
function decode(base64Png: string, cacheKey?: string): DecodedRaster | null {
  if (cacheKey !== undefined) {
    const cached = decodeCache.get(cacheKey);
    if (cached !== undefined) {
      // delete-then-set: re-touch moves the key to the LRU tail.
      decodeCache.delete(cacheKey);
      decodeCache.set(cacheKey, cached);
      return cached;
    }
  }
  let png: PNG;
  try {
    png = PNG.sync.read(Buffer.from(base64Png, "base64"));
  } catch {
    return null; // not a PNG (test fixtures, backend garbage) — honest null
  }
  if (png.width <= 0 || png.height <= 0 || png.data.length < png.width * png.height * 4) {
    return null;
  }
  const gray = new Uint8Array(png.width * png.height);
  for (let i = 0; i < gray.length; i++) {
    const o = i * 4;
    // Rec.601 luma — the standard grayscale weightings.
    gray[i] = Math.round(0.299 * png.data[o]! + 0.587 * png.data[o + 1]! + 0.114 * png.data[o + 2]!);
  }
  const decoded: DecodedRaster = { width: png.width, height: png.height, gray };
  if (cacheKey !== undefined) {
    decodeCache.set(cacheKey, decoded);
    while (decodeCache.size > DECODE_CACHE_MAX) {
      const oldest = decodeCache.keys().next().value;
      if (oldest === undefined) break;
      decodeCache.delete(oldest);
    }
  }
  return decoded;
}

/**
 * Average-pool a grayscale rect down to an 8×8 grid, threshold against the
 * grid mean, pack into the 64-bit aHash. `rect` is clamped to the raster and
 * must remain ≥ 1px in both axes.
 */
function aHashOf(decoded: DecodedRaster, rect: HashRect): bigint | null {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(decoded.width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(decoded.height, Math.ceil(rect.y + rect.h));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  const cells = new Float64Array(64);
  for (let row = 0; row < 8; row++) {
    const cy0 = y0 + Math.floor(((y1 - y0) * row) / 8);
    const cy1 = y0 + Math.max(cy0 + 1, Math.floor(((y1 - y0) * (row + 1)) / 8));
    for (let col = 0; col < 8; col++) {
      const cx0 = x0 + Math.floor(((x1 - x0) * col) / 8);
      const cx1 = x0 + Math.max(cx0 + 1, Math.floor(((x1 - x0) * (col + 1)) / 8));
      let sum = 0;
      let n = 0;
      for (let y = cy0; y < Math.min(cy1, y1); y++) {
        for (let x = cx0; x < Math.min(cx1, x1); x++) {
          sum += decoded.gray[y * decoded.width + x]!;
          n += 1;
        }
      }
      cells[row * 8 + col] = n > 0 ? sum / n : 0;
    }
  }
  let mean = 0;
  for (const c of cells) mean += c;
  mean /= 64;
  let hash = 0n;
  for (let i = 0; i < 64; i++) {
    // Strictly-greater: a flat image (every cell == mean) hashes to 0n.
    if (cells[i]! > mean) hash |= 1n << BigInt(i);
  }
  return hash;
}

/**
 * The full-frame 64-bit aHash of a base64 PNG. Null when the bytes do not
 * decode (see module honesty limits) — callers degrade, never crash.
 */
export function hashFrame(pngBase64: string, cacheKey?: string): FrameHash | null {
  const decoded = decode(pngBase64, cacheKey);
  if (decoded === null) return null;
  const aHash = aHashOf(decoded, { x: 0, y: 0, w: decoded.width, h: decoded.height });
  if (aHash === null) return null;
  return { aHash, width: decoded.width, height: decoded.height };
}

/**
 * The aHash of a SUB-RECT of the image (image-pixel coordinates) — crop
 * first, then the same 8×8 average-pool pipeline. Used by the stale-frame
 * auto-refresh's target-region comparison. Null when the rect is empty or
 * the bytes do not decode.
 */
export function hashRegion(pngBase64: string, rect: HashRect, cacheKey?: string): FrameHash | null {
  const decoded = decode(pngBase64, cacheKey);
  if (decoded === null) return null;
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const w = Math.max(0, Math.floor(rect.w));
  const h = Math.max(0, Math.floor(rect.h));
  if (w < 1 || h < 1 || x0 >= decoded.width || y0 >= decoded.height) return null;
  // Clamp to the image and report the CLAMPED dims (the area actually hashed).
  const cw = Math.min(w, decoded.width - x0);
  const ch = Math.min(h, decoded.height - y0);
  const aHash = aHashOf(decoded, { x: x0, y: y0, w: cw, h: ch });
  if (aHash === null) return null;
  return { aHash, width: cw, height: ch };
}

/** Hamming distance between two 64-bit hashes (0–64). */
export function hamming(a: bigint, b: bigint): number {
  let diff = a ^ b;
  let count = 0;
  while (diff !== 0n) {
    // Clear the lowest set bit — 64 iterations max, no BigInt shift trickery.
    diff &= diff - 1n;
    count += 1;
  }
  return count;
}

/** Test hook: drop the decode cache (the hashes themselves are pure). */
export function resetFramehashCacheForTests(): void {
  decodeCache.clear();
}
