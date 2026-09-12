/**
 * R93 (the computer-use v2 rework) — GHOST-BOX RECT VERIFICATION. Ported
 * from the ClickScope reference (detection/screen_verify.py): before an
 * element's bounds reach the agent, the rect is checked against the live
 * capture — a rect whose pixels are FLAT (stddev < 5) or carry no ink
 * (Otsu minority mask < 3%) is a GHOST: a stale or hidden element the tree
 * still reports. Ghosts waste the model's attention (it clicks dead space)
 * and pollute the element registry, so they are dropped from the snapshot
 * and counted.
 *
 * HONESTY LIMITS (the fail-open rule): verification never HIDES a real
 * element on a false positive — a rect that cannot be checked (no raster,
 * undecodable, out of bounds, tiny) PASSES. Only a rect that is
 * demonstrably empty fails.
 *
 * See docs/architecture/COMPUTER-USE-V2.md §2.4.
 */
import { PNG } from "pngjs";

/** A decoded grayscale raster (RGBA collapsed to Rec.601 luma). */
export interface GrayRaster {
  width: number;
  height: number;
  gray: Uint8Array;
}

/** Decode a base64 PNG into grayscale, or null (undecodable → fail-open). */
export function decodeGray(base64Png: string): GrayRaster | null {
  let png: PNG;
  try {
    png = PNG.sync.read(Buffer.from(base64Png, "base64"));
  } catch {
    return null;
  }
  if (png.width <= 0 || png.height <= 0 || png.data.length < png.width * png.height * 4) {
    return null;
  }
  const gray = new Uint8Array(png.width * png.height);
  for (let i = 0; i < gray.length; i++) {
    const o = i * 4;
    gray[i] = Math.round(0.299 * png.data[o]! + 0.587 * png.data[o + 1]! + 0.114 * png.data[o + 2]!);
  }
  return { width: png.width, height: png.height, gray };
}

/** The ClickScope thresholds, verbatim. */
const FLAT_STDDEV_MAX = 5;
const MINORITY_INK_MIN = 0.03; // < 3% minority-mask ink = empty

/**
 * Is this rect EMPTY (a ghost)? True only on POSITIVE evidence of
 * emptiness; every failure mode (out of bounds, tiny rect, decode missing)
 * returns false — the fail-open rule.
 */
export function rectIsEmpty(raster: GrayRaster, rect: [number, number, number, number]): boolean {
  const [x, y, w, h] = rect;
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(raster.width, Math.round(x + w));
  const y1 = Math.min(raster.height, Math.round(y + h));
  if (x1 - x0 < 2 || y1 - y0 < 2) return false; // too small to judge
  const n = (x1 - x0) * (y1 - y0);
  if (n < 16) return false; // ditto — never judge a handful of pixels

  // (1) The luma stats.
  let sum = 0;
  for (let py = y0; py < y1; py++) {
    const row = py * raster.width;
    for (let px = x0; px < x1; px++) sum += raster.gray[row + px]!;
  }
  const mean = sum / n;
  let variance = 0;
  for (let py = y0; py < y1; py++) {
    const row = py * raster.width;
    for (let px = x0; px < x1; px++) {
      const d = raster.gray[row + px]! - mean;
      variance += d * d;
    }
  }
  const stddev = Math.sqrt(variance / n);
  if (stddev < FLAT_STDDEV_MAX) return true; // flat = empty

  // (2) The Otsu threshold + the minority-mask ink ratio. Otsu splits the
  // histogram into two classes; the MINORITY class is whichever side has
  // fewer pixels. Real content (text on a background, a button face, an
  // icon) puts meaningful pixels on the minority side; a ghost's "texture"
  // is noise spread evenly, leaving the minority class tiny.
  const histogram = new Uint32Array(256);
  for (let py = y0; py < y1; py++) {
    const row = py * raster.width;
    for (let px = x0; px < x1; px++) histogram[raster.gray[row + px]!]! += 1;
  }
  // Otsu: maximize inter-class variance over candidate thresholds.
  let total = 0;
  let weightedTotal = 0;
  for (let v = 0; v < 256; v++) {
    total += histogram[v]!;
    weightedTotal += v * histogram[v]!;
  }
  let sumB = 0;
  let wB = 0;
  let bestBetween = -1;
  let bestThreshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += histogram[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * histogram[t]!;
    const mB = sumB / wB;
    const mF = (weightedTotal - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestBetween) {
      bestBetween = between;
      bestThreshold = t;
    }
  }
  let minority = 0;
  for (let v = 0; v < 256; v++) {
    if (v > bestThreshold) minority += histogram[v]!;
  }
  minority = Math.min(minority, total - minority);
  return minority / total < MINORITY_INK_MIN;
}

/**
 * The snapshot filter: drop GHOST elements (bounds that are demonstrably
 * empty in the raster). Elements without bounds pass untouched (the
 * detail:"compact" walk has no rects to judge — the fail-open rule).
 * Returns the surviving elements + the dropped count.
 */
export function dropGhostElements<T extends { bounds?: [number, number, number, number] }>(
  raster: GrayRaster | null,
  elements: T[],
): { elements: T[]; droppedGhostCount: number } {
  if (raster === null) return { elements, droppedGhostCount: 0 };
  const kept: T[] = [];
  let dropped = 0;
  for (const el of elements) {
    if (el.bounds === undefined) {
      kept.push(el);
      continue;
    }
    if (rectIsEmpty(raster, el.bounds)) {
      dropped += 1;
      continue;
    }
    kept.push(el);
  }
  return { elements: kept, droppedGhostCount: dropped };
}
