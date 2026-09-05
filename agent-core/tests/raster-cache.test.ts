/**
 * ROUND-67 (R67-D): the raster-registry tests — the route-side leg of the
 * live chat screenshot THUMBNAILS. Pins the three honesty limits the strip
 * relies on: the LRU cap (12 — oldest evicted), the 10-minute TTL (an
 * expired entry answers null FOREVER after, and is dropped), and the test
 * reset. The registry is deliberately EPHEMERAL: nothing persists, nothing
 * is model-facing — these tests pin exactly that contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rasterFor, registerRaster, resetRasterCacheForTest } from "../src/computer/raster-cache";

beforeEach(() => {
  resetRasterCacheForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ROUND-67 (R67-D): the raster registry (LRU + TTL)", () => {
  it("round-trips a registered raster (pngBase64 + ts)", () => {
    registerRaster("f-1", "aGk=");
    const entry = rasterFor("f-1");
    expect(entry).not.toBeNull();
    expect(entry!.pngBase64).toBe("aGk=");
    expect(typeof entry!.ts).toBe("number");
  });

  it("unknown ids answer an honest null (never an exception)", () => {
    expect(rasterFor("f-nope")).toBeNull();
  });

  it("LRU: the 13th registration EVICTS the OLDEST (cap 12)", () => {
    for (let i = 1; i <= 12; i++) registerRaster(`f-${i}`, `png${i}`);
    expect(rasterFor("f-1")).not.toBeNull();
    registerRaster("f-13", "png13");
    expect(rasterFor("f-1")).toBeNull(); // evicted
    expect(rasterFor("f-2")).not.toBeNull(); // survives
    expect(rasterFor("f-13")).not.toBeNull();
  });

  it("LRU: re-registering an existing id refreshes its recency (moves it to the tail)", () => {
    for (let i = 1; i <= 12; i++) registerRaster(`f-${i}`, `png${i}`);
    // Touch f-1 (moves to tail) → the 13th insert evicts f-2 instead.
    registerRaster("f-1", "png1-fresh");
    registerRaster("f-13", "png13");
    expect(rasterFor("f-1")).not.toBeNull();
    expect(rasterFor("f-1")!.pngBase64).toBe("png1-fresh");
    expect(rasterFor("f-2")).toBeNull();
  });

  it("TTL: an entry expires after 10 minutes and stays null FOREVER after (dropped, not resurrected)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T10:00:00Z"));
    registerRaster("f-9", "aGk=");
    expect(rasterFor("f-9")).not.toBeNull();
    // The full 10 minutes: still alive (alive FOR 10 minutes, then gone).
    vi.setSystemTime(new Date("2026-09-06T10:09:59.999Z"));
    expect(rasterFor("f-9")).not.toBeNull();
    // 1ms PAST the 10-minute boundary: expired → null.
    vi.setSystemTime(new Date("2026-09-06T10:10:00.001Z"));
    expect(rasterFor("f-9")).toBeNull();
    // And a LATER lookup never resurrects it.
    vi.setSystemTime(new Date("2026-09-06T10:11:00Z"));
    expect(rasterFor("f-9")).toBeNull();
  });

  it("TTL: a re-registration RESETS the 10-minute clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T10:00:00Z"));
    registerRaster("f-1", "aGk=");
    vi.setSystemTime(new Date("2026-09-06T10:09:00Z"));
    registerRaster("f-1", "aGk="); // fresh ts — 9 minutes in
    vi.setSystemTime(new Date("2026-09-06T10:18:59.999Z")); // 9m59.999s after the re-set
    expect(rasterFor("f-1")).not.toBeNull();
    vi.setSystemTime(new Date("2026-09-06T10:19:00.001Z")); // just past 10 minutes after the re-set
    expect(rasterFor("f-1")).toBeNull();
  });

  it("resetRasterCacheForTest: empties the registry (the honest between-tests contract)", () => {
    registerRaster("f-1", "aGk=");
    resetRasterCacheForTest();
    expect(rasterFor("f-1")).toBeNull();
  });
});
