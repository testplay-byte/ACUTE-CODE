/**
 * R93 (the computer-use v2 rework): the GHOST-BOX VERIFICATION tests —
 * synthetic PNG fixtures separate real content (text/button rects) from
 * ghosts (flat / no-ink rects), and every failure mode fails OPEN (a rect
 * that cannot be judged passes — verification never hides a real element).
 */
import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import {
  decodeGray,
  dropGhostElements,
  rectIsEmpty,
  type GrayRaster,
} from "../src/computer/verify-rects";

/** A gray raster filled with a base color + optional content. */
function raster(
  w: number,
  h: number,
  fill: (x: number, y: number) => number,
): GrayRaster {
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) gray[y * w + x] = Math.max(0, Math.min(255, Math.round(fill(x, y))));
  }
  return { width: w, height: h, gray };
}

describe("R93: rectIsEmpty", () => {
  it("a FLAT rect is empty (stddev < 5)", () => {
    const r = raster(200, 100, () => 240);
    expect(rectIsEmpty(r, [10, 10, 80, 60])).toBe(true);
  });

  it("a rect with TEXT-like content is NOT empty", () => {
    // Background 240 with dark 20 "glyph" stripes every few px — the shape
    // of text on a white UI.
    const r = raster(200, 100, (x) => (x % 6 < 2 ? 20 : 240));
    expect(rectIsEmpty(r, [10, 10, 180, 80])).toBe(false);
  });

  it("a rect with a border ring is NOT empty (a button face)", () => {
    const r = raster(100, 100, (x, y) =>
      x < 2 || y < 2 || x > 97 || y > 97 ? 40 : 245,
    );
    expect(rectIsEmpty(r, [0, 0, 100, 100])).toBe(false);
  });

  it("out-of-bounds rects fail OPEN (never judged)", () => {
    const r = raster(50, 50, () => 200);
    expect(rectIsEmpty(r, [400, 400, 80, 60])).toBe(false);
  });

  it("tiny rects (< 16 px) fail open — too small to judge", () => {
    const r = raster(200, 100, () => 240);
    expect(rectIsEmpty(r, [10, 10, 3, 3])).toBe(false);
  });
});

describe("R93: dropGhostElements", () => {
  it("drops the flat-bounds elements, keeps the rest, counts", () => {
    // Left half flat white; right half has stripes.
    const r = raster(200, 100, (x) => (x < 100 ? 250 : x % 6 < 2 ? 20 : 240));
    const elements = [
      { name: "ghost", bounds: [0, 0, 80, 60] as [number, number, number, number] },
      { name: "real", bounds: [110, 0, 80, 60] as [number, number, number, number] },
      { name: "no-bounds (compact walk)", bounds: undefined },
    ];
    const out = dropGhostElements(r, elements);
    expect(out.droppedGhostCount).toBe(1);
    expect(out.elements.map((e) => e.name)).toEqual(["real", "no-bounds (compact walk)"]);
  });

  it("a null raster (no capture) passes everything through", () => {
    const elements = [{ name: "a", bounds: [0, 0, 10, 10] as [number, number, number, number] }];
    const out = dropGhostElements(null, elements);
    expect(out.elements).toHaveLength(1);
    expect(out.droppedGhostCount).toBe(0);
  });
});

describe("R93: decodeGray", () => {
  it("decodes a real PNG (round-trips through base64)", () => {
    const png = new PNG({ width: 8, height: 8 });
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        const idx = (i * 8 + j) * 4;
        const v = i < 4 ? 255 : 0;
        png.data[idx] = v;
        png.data[idx + 1] = v;
        png.data[idx + 2] = v;
        png.data[idx + 3] = 255;
      }
    }
    const b64 = PNG.sync.write(png).toString("base64");
    const gray = decodeGray(b64);
    expect(gray).not.toBeNull();
    expect(gray!.width).toBe(8);
    expect(gray!.gray[0]).toBe(255);
    expect(gray!.gray[63]).toBe(0);
  });

  it("garbage bytes decode to null (the fail-open path)", () => {
    expect(decodeGray("not-a-png")).toBeNull();
  });
});
