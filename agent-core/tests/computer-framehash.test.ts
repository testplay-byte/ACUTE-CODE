/**
 * ROUND-69 (R69, task 4-c-1): the FRAME PERCEPTUAL-HASH module tests —
 * synthetic PNGs built programmatically with pngjs (the same library the
 * module decodes with): identical → Hamming 0; materially different → high;
 * region crops stable under out-of-region changes; the decode LRU actually
 * caches. These pin the PRIMITIVE the dispatcher's auto-refresh thresholds
 * (full ≤ 8, region ≤ 6) and the spam guard (≤ 4) ride on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import { hamming, hashFrame, hashRegion, resetFramehashCacheForTests } from "../src/computer/framehash";

/* ── synthetic PNG builders ────────────────────────────────────────────────── */

/** Grayscale PNG from a per-pixel value function. */
function makePng(w: number, h: number, fn: (x: number, y: number) => number): string {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = fn(x, y);
      const i = (y * w + x) * 4;
      png.data[i] = v;
      png.data[i + 1] = v;
      png.data[i + 2] = v;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png).toString("base64");
}

/** 32×32 solid gray. */
const SOLID = (v: number) => makePng(32, 32, () => v);

/** Left→right horizontal gradient over w. */
const GRADIENT_X = (w: number, h: number) => makePng(w, h, (x) => Math.round((x / (w - 1)) * 255));

/** The SAME horizontal gradient, shifted by s px (the classic aHash shift case). */
const GRADIENT_SHIFTED = (w: number, h: number, s: number) =>
  makePng(w, h, (x) => Math.round((Math.min(w - 1, Math.max(0, x - s)) / (w - 1)) * 255));

beforeEach(() => {
  resetFramehashCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ── hamming (pure bigint math) ────────────────────────────────────────────── */

describe("R69 (4-c-1): hamming — pure 64-bit distance", () => {
  it("identical hashes → 0; disjoint bit sets → 64", () => {
    expect(hamming(0b0000n, 0b0000n)).toBe(0);
    expect(hamming(0b0001n, 0b0011n)).toBe(1);
    expect(hamming(0b0001n, 0b1110n)).toBe(4);
    expect(hamming(0n, 0xffffffffffffffffn)).toBe(64);
  });
});

/* ── hashFrame ─────────────────────────────────────────────────────────────── */

describe("R69 (4-c-1): hashFrame — the full-frame aHash", () => {
  it("identical images → identical hashes (Hamming 0), dimensions reported", () => {
    const a = hashFrame(GRADIENT_X(64, 64));
    const b = hashFrame(GRADIENT_X(64, 64));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(hamming(a!.aHash, b!.aHash)).toBe(0);
    expect(a!.width).toBe(64);
    expect(a!.height).toBe(64);
  });

  it("materially different images → high Hamming (solid 32 vs gradient 32... vs solid 200)", () => {
    // A flat image hashes to 0n (every cell == mean); compare two DIFFERENT
    // structures instead of two flats.
    const grad = hashFrame(GRADIENT_X(32, 32))!;
    const solid = hashFrame(SOLID(200))!;
    expect(hamming(grad.aHash, solid.aHash)).toBeGreaterThan(8);
  });

  it("a shifted gradient is a DIFFERENT screen (the shift-sensitivity case)", () => {
    const base = hashFrame(GRADIENT_X(64, 64))!;
    const shifted = hashFrame(GRADIENT_SHIFTED(64, 64, 40))!;
    // A 40px shift moves the gradient's pooled column bits wholesale.
    expect(hamming(base.aHash, shifted.aHash)).toBeGreaterThan(8);
  });

  it("undecodable bytes → null (honest, callers degrade — never throw)", () => {
    expect(hashFrame("not-a-png")).toBeNull();
    expect(hashFrame(Buffer.from("fakepng").toString("base64"))).toBeNull();
    expect(hashFrame("")).toBeNull();
  });
});

/* ── hashRegion ────────────────────────────────────────────────────────────── */

describe("R69 (4-c-1): hashRegion — the target-region crop", () => {
  const W = 128;
  const H = 128;
  const BASE_FN = (x: number) => Math.round((x / (W - 1)) * 255);
  const BASE = makePng(W, H, BASE_FN);
  // A big change in the top-left quadrant — far from the region at (96,96).
  const CHANGED_FAR = makePng(W, H, (x, y) => (x < 64 && y < 64 ? 255 : BASE_FN(x)));
  // The same far change PLUS the ENTIRE target region overwritten (the
  // unstable-target case — the region at (96,96)±48 is [48,128)²).
  const CHANGED_NEAR = makePng(W, H, (x, y) => (x < 64 && y < 64) || (x >= 48 && y >= 48) ? 255 : BASE_FN(x));
  // The region around the click point: (96,96) ± 48px clamped to the frame.
  const REGION = { x: 48, y: 48, w: 80, h: 80 };

  it("crop stability: an out-of-region change leaves the region hash IDENTICAL", () => {
    const a = hashRegion(BASE, REGION);
    const b = hashRegion(CHANGED_FAR, REGION);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(hamming(a!.aHash, b!.aHash)).toBe(0);
    expect(a!.width).toBe(REGION.w);
    expect(a!.height).toBe(REGION.h);
  });

  it("a change INSIDE the region moves the region hash beyond the stability threshold", () => {
    const a = hashRegion(BASE, REGION);
    const b = hashRegion(CHANGED_NEAR, REGION);
    expect(hamming(a!.aHash, b!.aHash)).toBeGreaterThan(6);
  });

  it("the full-frame hash DOES see the far change (the auto-refresh's tier-1 signal)", () => {
    const a = hashFrame(BASE);
    const b = hashFrame(CHANGED_FAR);
    expect(hamming(a!.aHash, b!.aHash)).toBeGreaterThan(8);
  });

  it("out-of-bounds rects are honest: fully outside → null; partially outside → clamped", () => {
    expect(hashRegion(BASE, { x: 500, y: 500, w: 10, h: 10 })).toBeNull();
    expect(hashRegion(BASE, { x: 0, y: 0, w: 0, h: 10 })).toBeNull();
    // Partially outside: clamps to the image, still hashes the visible part.
    const clamped = hashRegion(BASE, { x: 100, y: 100, w: 80, h: 80 });
    expect(clamped).not.toBeNull();
    expect(clamped!.width).toBe(28);
    expect(clamped!.height).toBe(28);
  });
});

/* ── the decode LRU ────────────────────────────────────────────────────────── */

describe("R69 (4-c-1): the decode LRU — repeated hashes of the same raster do not re-decode", () => {
  it("hashFrame + hashRegion with the SAME cacheKey share ONE PNG decode", () => {
    const readSpy = vi.spyOn(PNG.sync, "read");
    const png = makePng(64, 64, (x, y) => (x + y) % 256);
    hashFrame(png, "f-1");
    expect(readSpy).toHaveBeenCalledTimes(1);
    hashRegion(png, { x: 8, y: 8, w: 32, h: 32 }, "f-1");
    expect(readSpy).toHaveBeenCalledTimes(1); // cache hit — no re-decode
    hashRegion(png, { x: 0, y: 0, w: 16, h: 16 }, "f-2");
    expect(readSpy).toHaveBeenCalledTimes(2); // new key → one decode
  });

  it("the LRU evicts the OLDEST decoded raster at 4 entries (re-hash re-decodes)", () => {
    const readSpy = vi.spyOn(PNG.sync, "read");
    const png = makePng(64, 64, (x, y) => (x * 2 + y) % 256);
    // Five distinct keys: f-1..f-4 fill the cache; f-5 evicts f-1.
    for (let i = 1; i <= 5; i++) hashFrame(png, `f-${i}`);
    expect(readSpy).toHaveBeenCalledTimes(5);
    // Re-touching f-2 (still cached) must NOT re-decode; f-1 (evicted) MUST.
    hashRegion(png, { x: 0, y: 0, w: 8, h: 8 }, "f-2");
    expect(readSpy).toHaveBeenCalledTimes(5);
    hashFrame(png, "f-1");
    expect(readSpy).toHaveBeenCalledTimes(6);
  });

  it("a cache HIT refreshes recency (the LRU clock is access-ordered)", () => {
    const readSpy = vi.spyOn(PNG.sync, "read");
    const png = makePng(64, 64, (x, y) => (x + 3 * y) % 256);
    hashFrame(png, "f-1");
    hashFrame(png, "f-2");
    hashFrame(png, "f-3");
    hashFrame(png, "f-4");
    // Touch f-1 → it becomes the MOST recent; f-2 is now the oldest.
    hashFrame(png, "f-1");
    hashFrame(png, "f-5"); // evicts f-2, NOT f-1
    expect(readSpy).toHaveBeenCalledTimes(5);
    hashFrame(png, "f-1");
    expect(readSpy).toHaveBeenCalledTimes(5); // f-1 survived (was re-touched)
    hashFrame(png, "f-2");
    expect(readSpy).toHaveBeenCalledTimes(6); // f-2 was evicted
  });

  it("no cacheKey → pure function (decodes every call, caches nothing)", () => {
    const readSpy = vi.spyOn(PNG.sync, "read");
    const png = makePng(32, 32, () => 128);
    hashFrame(png);
    hashFrame(png);
    expect(readSpy).toHaveBeenCalledTimes(2);
  });
});
