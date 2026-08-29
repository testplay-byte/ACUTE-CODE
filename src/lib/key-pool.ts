/**
 * ROUND-47 (R47-c1): pure key-pool slot math.
 *
 * KeyPoolSection (Models & Providers) used to compute the next add-slot as
 * `slots.length + 2` — which COLLIDES whenever the pool has a gap (slots 2
 * and 4 held → length 2 → the next add silently OVERWRITES slot 4's key).
 * This helper is the fix: the first slot in [min, max] that is not held.
 * SubAgentsTab's add-row does the same scan inline; this is the shared,
 * unit-tested version.
 */

/** Pool slots are addressable 0–31 (slot 0 = the primary key, never written
 * from the pool UI; the pool convention starts at 2 — see SubAgentsTab). */
export const MIN_POOL_SLOT = 2;
export const MAX_POOL_SLOT = 31;

/**
 * The first free slot in [min, max] not present in `heldSlots`, or -1 when
 * the whole range is held (the caller surfaces "pool is full"). Pure: no
 * mutation, order/duplicates/out-of-range entries in `heldSlots` are fine.
 */
export function nextFreeSlot(heldSlots: number[], min = MIN_POOL_SLOT, max = MAX_POOL_SLOT): number {
  const held = new Set(heldSlots);
  for (let slot = min; slot <= max; slot++) {
    if (!held.has(slot)) return slot;
  }
  return -1;
}
