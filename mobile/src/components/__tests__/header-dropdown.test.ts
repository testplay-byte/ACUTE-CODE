/**
 * header-dropdown.test.ts — the R116-l anchored dropdown + the R118-D
 * sub-level grammar (spec-d-session.md §2.2), pinned in the
 * chart-donut.test.ts idiom: the PROP surface is TYPE-ONLY (erased at
 * runtime — typecheck is the gate that runs it), the MOTION/WIDTH constants
 * are VALUE imports (the three native-heavy leaves — reanimated, lucide,
 * nothing else reaches past them here — jest-mocked, never loaded).
 *
 * What is pinned:
 *   · the panel's grammar constants — PANEL_WIDTH 220 (components.md
 *     §Dropdown menus' ~200-240 band), EXIT_FADE_MS 120 (motion.md §4.8's
 *     tap-outside dismissal fade), ENTRANCE_SCALE 0.96 (the spring-in floor);
 *   · `HeaderDropdownItem.selected` — the in-place option list's marker
 *     (Check 16 accent replaces the chevron);
 *   · `onBack` / `children` / `contentMaxHeight` — the sub-level grammar the
 *     session screen's kebab state machine renders its levels through
 *     (back chevron on the title row, arbitrary content under it, the rows
 *     scrolling INSIDE the panel when capped).
 */

import { describe, expect, it, jest } from "@jest/globals";

jest.mock("react-native-reanimated", () => ({
  __esModule: true,
  default: { createAnimatedComponent: () => () => null, View: () => null },
  runOnJS: (fn: unknown) => fn,
  useAnimatedStyle: (fn: () => unknown) => fn(),
  useReducedMotion: () => true,
  useSharedValue: (initial: number) => ({ value: initial }),
  withSpring: (v: number) => v,
  withTiming: (v: number) => v,
}));
jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));

import {
  ENTRANCE_SCALE,
  EXIT_FADE_MS,
  PANEL_WIDTH,
  type HeaderDropdownItem,
  type HeaderDropdownProps,
} from "@/components/header-dropdown";

// The panel's own vocabulary — no accidental API creep beyond the sub-level
// grammar + the presentation plumbing.
type ExpectedKeys =
  | "open"
  | "onClose"
  | "items"
  | "testID"
  | "title"
  | "onBack"
  | "children"
  | "contentMaxHeight";
type PropKeys = keyof HeaderDropdownProps;
type NoVocabularyDrift = Exclude<PropKeys, ExpectedKeys> extends never
  ? Exclude<ExpectedKeys, PropKeys> extends never
    ? true
    : never
  : never;
const vocabularyPinned: NoVocabularyDrift = true;

// The three sub-level additions are all OPTIONAL (a main-level dropdown —
// every pre-R118-D call site — renders byte-identical without them).
type SubLevelAdditionsAreOptional =
  undefined extends HeaderDropdownProps["onBack"]
    ? undefined extends HeaderDropdownProps["children"]
      ? undefined extends HeaderDropdownProps["contentMaxHeight"]
        ? true
        : never
      : never
    : never;
const subLevelOptional: SubLevelAdditionsAreOptional = true;

// The core trio is REQUIRED: open/onClose/items (a dropdown without rows or
// a way to dismiss is not a dropdown).
type CoreIsRequired =
  undefined extends HeaderDropdownProps["open"]
    ? never
    : undefined extends HeaderDropdownProps["onClose"]
      ? never
      : undefined extends HeaderDropdownProps["items"]
        ? never
        : true;
const coreRequired: CoreIsRequired = true;

// The row's vocabulary: the label + the CURRENT value + the danger arm +
// the R118-D selected marker + the press. Nothing else.
type ExpectedItemKeys = "key" | "label" | "value" | "danger" | "selected" | "onPress";
type ItemKeys = keyof HeaderDropdownItem;
type ItemVocabularyPinned = Exclude<ItemKeys, ExpectedItemKeys> extends never
  ? Exclude<ExpectedItemKeys, ItemKeys> extends never
    ? true
    : never
  : never;
const itemVocabulary: ItemVocabularyPinned = true;

// The selected marker is OPTIONAL (an unmarked row is the default shape).
type SelectedIsOptional = undefined extends HeaderDropdownItem["selected"] ? true : never;
const selectedOptional: SelectedIsOptional = true;

describe("HeaderDropdown — the R118-D sub-level grammar", () => {
  it("the prop surface is exactly the anchored panel + the three sub-level additions", () => {
    // The runtime mirror of the compile-time pins above (both would fail to
    // COMPILE first — that is the point: typecheck is the gate that runs them).
    expect(vocabularyPinned).toBe(true);
    expect(subLevelOptional).toBe(true);
    expect(coreRequired).toBe(true);
  });

  it("the row carries the selected marker — optional, beside the danger arm", () => {
    expect(itemVocabulary).toBe(true);
    expect(selectedOptional).toBe(true);
  });

  it("PANEL_WIDTH is 220 (components.md §Dropdown menus' band)", () => {
    expect(PANEL_WIDTH).toBe(220);
  });

  it("the exit fade is 120ms; the entrance scale floor is 0.96 (motion.md §4.8)", () => {
    expect(EXIT_FADE_MS).toBe(120);
    expect(ENTRANCE_SCALE).toBe(0.96);
  });
});
