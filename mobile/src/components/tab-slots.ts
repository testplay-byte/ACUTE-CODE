/**
 * tab-slots.ts — the R118-B ADAPTIVE SLOT algorithm, pure (spec-b §2.1).
 *
 * Extracted beside the bar (not inside it) so the mobile suite's pure-logic
 * convention holds: tab-bar.tsx imports RN/reanimated/keyboard-controller at
 * module time and can never enter the jest sandbox, while THIS file is plain
 * arithmetic — tab-slots.test.ts pins every worked number against it, and
 * tab-bar.tsx re-exports the whole surface for its consumers.
 *
 * The design (components.md §Tab bar, R118 amendment): the bar insets its
 * row TAB_INSET_X from the slab's inner edges; the SELECTED tab's slot grows
 * to its chip's natural width (icon + gutter + measured label + LABEL_EPSILON)
 * plus the pill's PILL_PAD_X pair, floored at the icon-only pill and capped so
 * every other slot still clears its icon; the neighbors rebalance to the equal
 * split of what remains, capped at the legacy barWidth/N width. The pill
 * centers inside the selected slot — the R116 edge clamp is deleted because
 * the slot math makes it unreachable.
 */

/** The row's inset from the slab's inner edges (dp) — the first/last pills'
 * honest margin off the rounded edge (was ~1px, the edge-clamp crowding). */
export const TAB_INSET_X = 12;
/** The selection pill's horizontal breathing around the chip (dp, per side) —
 * R118-B: 8 → 12 (the chip reads as pill-padded, never pill-clamped). */
export const PILL_PAD_X = 12;
/** The measured label's slack (dp) — the expanded maxWidth targets the
 * measurement + 2 so Android's pixel-grid rounding can't clip the last
 * glyph of an exactly-measured box. */
export const LABEL_EPSILON = 2;

/** The inactive chip's icon size (dp) — the fixed anchor the label breathes
 * beside (tab-bar.tsx's frozen constant, mirrored here for the arithmetic). */
export const TAB_ICON_SIZE = 22;
/** The ACTIVE icon's size (dp) — R117-g2's state-weight cue (23/2.5). */
export const TAB_ICON_SIZE_ACTIVE = 23;
/** The icon→label gutter inside the horizontal chip (dp). */
export const TAB_CHIP_GAP = 6;

export interface TabSlotsInput {
  barWidth: number;
  tabCount: number;
  activeIndex: number;
  /** Per-tab measured label widths (dp) — only the ACTIVE tab's is read. */
  labelWidths: readonly number[];
}

export interface TabSlotsLayout {
  /** Per-tab slot widths (dp), index-aligned with the tabs. */
  slots: number[];
  /** Per-tab slot CENTERS (dp), in the bar's FULL-WIDTH coordinate space. */
  centers: number[];
  /** The selection pill's width (dp). */
  pillWidth: number;
}

/**
 * The adaptive slot layout (R118-B spec §2.1, verbatim arithmetic):
 *
 *   avail  = barWidth - 2*TAB_INSET_X
 *   equal  = barWidth / tabCount                  // the CAP
 *   label  = labelWidth > 0 ? labelWidth + 2 : 0
 *   chip   = ICON_SIZE_ACTIVE + CHIP_GAP + label // the selected chip's natural width
 *   selSlot = clamp(chip + 2*PILL_PAD_X, ICON_SIZE_ACTIVE + 2*PILL_PAD_X, avail - ICON_SIZE*(tabCount-1))
 *   unselSlot = min(equal, (avail - selSlot) / (tabCount - 1))
 *   slots = per-tab (selected ? selSlot : unselSlot); centers = prefix-sum + TAB_INSET_X + slotWidth/2
 *   pillWidth = min(chip + 2*PILL_PAD_X, selSlot)
 *
 * The unmeasured pose (the active label still 0) is the MOUNT pose: the
 * selected slot parks at its floor (ICON_SIZE_ACTIVE + 2*PILL_PAD_X — the
 * icon and the pill's own padding; there is no label to gutter from), the
 * others at the equal split — the row blooms to the measured layout when
 * the measurement row reports. The pill centers inside the selected slot,
 * so it always sits ≥ TAB_INSET_X off both slab edges — the old edge clamp
 * (which capped the FIRST/LAST pill to ~1px off the edge and collapsed its
 * padding) is unreachable by construction and deleted.
 */
export function computeTabSlots({
  barWidth,
  tabCount,
  activeIndex,
  labelWidths,
}: TabSlotsInput): TabSlotsLayout {
  if (tabCount <= 0 || barWidth <= 0) return { slots: [], centers: [], pillWidth: 0 };
  const index = Math.min(Math.max(activeIndex, 0), tabCount - 1);
  const avail = barWidth - TAB_INSET_X * 2;
  const equal = barWidth / tabCount;
  const measured = (labelWidths[index] ?? 0) > 0;
  const label = measured ? (labelWidths[index] ?? 0) + LABEL_EPSILON : 0;
  const chip = TAB_ICON_SIZE_ACTIVE + (measured ? TAB_CHIP_GAP : 0) + label;
  const floor = TAB_ICON_SIZE_ACTIVE + PILL_PAD_X * 2;
  const cap = Math.max(avail - TAB_ICON_SIZE * (tabCount - 1), floor);
  const selSlot = measured ? Math.min(Math.max(chip + PILL_PAD_X * 2, floor), cap) : floor;
  const unselSlot = measured && tabCount > 1 ? Math.min(equal, (avail - selSlot) / (tabCount - 1)) : equal;
  const slots: number[] = [];
  for (let i = 0; i < tabCount; i += 1) slots.push(i === index ? selSlot : unselSlot);
  const centers: number[] = [];
  let x = TAB_INSET_X;
  for (let i = 0; i < tabCount; i += 1) {
    const w = slots[i] ?? 0;
    centers.push(x + w / 2);
    x += w;
  }
  return { slots, centers, pillWidth: Math.min(chip + PILL_PAD_X * 2, selSlot) };
}
