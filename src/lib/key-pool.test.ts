import { describe, expect, it } from "vitest";
import { MAX_POOL_SLOT, MIN_POOL_SLOT, nextFreeSlot } from "./key-pool";

// ROUND-47 (R47-c1): the KeyPoolSection slot-collision fix — pure unit tests
// (gaps, full pool, empty pool, bounds). The component-level regression test
// (slots 2 & 4 held → the next add writes slot 3) lives in
// ModelsProvidersTab.test.tsx.
describe("nextFreeSlot (ROUND-47 R47-c1)", () => {
  it("empty pool → the first pool slot (2)", () => {
    expect(nextFreeSlot([])).toBe(2);
  });

  it("contiguous held slots → one past the last", () => {
    expect(nextFreeSlot([2, 3, 4])).toBe(5);
  });

  it("GAP (the old `slots.length + 2` collision): slots 2 & 4 held → 3, never 4", () => {
    // The old code computed 2 + 2 = 4 and overwrote the held slot-4 key.
    expect(nextFreeSlot([2, 4])).toBe(3);
    expect(nextFreeSlot([3, 5, 7])).toBe(2);
  });

  it("ignores ordering, duplicates and out-of-range held slots", () => {
    expect(nextFreeSlot([4, 2, 4])).toBe(3);
    // Slots outside [2, 31] never block the scan (slot 0 is the primary key).
    expect(nextFreeSlot([0, 1, 32, 99])).toBe(2);
  });

  it("full pool (every slot 2–31 held) → -1", () => {
    const all = Array.from({ length: MAX_POOL_SLOT - MIN_POOL_SLOT + 1 }, (_, i) => MIN_POOL_SLOT + i);
    expect(nextFreeSlot(all)).toBe(-1);
  });

  it("honors custom bounds", () => {
    expect(nextFreeSlot([5], 5, 7)).toBe(6);
    expect(nextFreeSlot([5, 6, 7], 5, 7)).toBe(-1);
    // Empty range (min > max) → nothing free.
    expect(nextFreeSlot([], 8, 3)).toBe(-1);
  });
});
