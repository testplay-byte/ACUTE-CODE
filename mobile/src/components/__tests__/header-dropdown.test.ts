/**
 * header-dropdown.test.ts — the R116-l anchored dropdown + the R118-D
 * sub-level grammar (spec-d-session.md §2.2) + the R119-B animated level
 * transitions (round-119.md §2 Track B), pinned in the chart-donut.test.ts
 * idiom: the PROP surface is TYPE-ONLY (erased at runtime — typecheck is the
 * gate that runs it), the MOTION/WIDTH constants are VALUE imports, and the
 * R119-B level-swap DIRECTION derivation is a pure function pinned in a
 * table (the native-heavy leaves — reanimated (now including the
 * layout-animation builders the component imports at module scope:
 * Easing/FadeIn/FadeOut/Keyframe), lucide, nothing else reaches past them
 * here — jest-mocked, never loaded).
 *
 * What is pinned:
 *   · the panel's grammar constants — PANEL_WIDTH 220 (components.md
 *     §Dropdown menus' ~200-240 band), EXIT_FADE_MS 120 (motion.md §4.8's
 *     tap-outside dismissal fade), ENTRANCE_SCALE 0.96 (the spring-in floor);
 *     all three FROZEN through R119-B;
 *   · `HeaderDropdownItem.selected` — the in-place option list's marker
 *     (Check 16 accent replaces the chevron);
 *   · `onBack` / `children` / `contentMaxHeight` — the sub-level grammar the
 *     session screen's kebab state machine renders its levels through
 *     (back chevron on the title row, arbitrary content under it, the rows
 *     scrolling INSIDE the panel when capped);
 *   · `level` — the R119-B key the panel's BODY is keyed by (the level
 *     swaps animate: a 12dp directional slide + crossfade, 180ms in /
 *     120ms out); MAIN_LEVEL_KEY + the LEVEL_* constants pin the motion's
 *     values, and `levelSwapDirection` pins the drill-down derivation
 *     (forward = into a sub-level, back = returning to the root, none =
 *     same depth / a fresh panel).
 */

import { describe, expect, it, jest } from "@jest/globals";

jest.mock("react-native-reanimated", () => ({
  __esModule: true,
  default: { createAnimatedComponent: () => () => null, View: () => null },
  // R119-B — the layout-animation leaves header-dropdown.tsx imports at
  // module scope (the Keyframes construct there with `new` — the reanimated-4
  // class shape — and chain .duration; FadeIn/FadeOut.duration chain at
  // render): stubbed as inert chainables so the module loads clean. The
  // Keyframe mock is a CONSTRUCTIBLE plain function (new-able), matching
  // the class it stands in for.
  Easing: { out: (e: unknown) => e, cubic: { cubic: true } },
  FadeIn: { duration: () => ({ builder: "fadeIn" }) },
  FadeOut: { duration: () => ({ builder: "fadeOut" }) },
  Keyframe: function KeyframeMock() {
    return { duration: () => ({ builder: "keyframe" }) };
  },
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
  LEVEL_ENTER_MS,
  LEVEL_EXIT_MS,
  LEVEL_SLIDE_DP,
  MAIN_LEVEL_KEY,
  PANEL_WIDTH,
  levelSwapDirection,
  type HeaderDropdownItem,
  type HeaderDropdownProps,
} from "@/components/header-dropdown";

// The panel's own vocabulary — no accidental API creep beyond the sub-level
// grammar + the presentation plumbing + the R119-B level key.
type ExpectedKeys =
  | "open"
  | "onClose"
  | "items"
  | "testID"
  | "title"
  | "onBack"
  | "children"
  | "contentMaxHeight"
  | "level";
type PropKeys = keyof HeaderDropdownProps;
type NoVocabularyDrift = Exclude<PropKeys, ExpectedKeys> extends never
  ? Exclude<ExpectedKeys, PropKeys> extends never
    ? true
    : never
  : never;
const vocabularyPinned: NoVocabularyDrift = true;

// The sub-level additions are all OPTIONAL (a main-level dropdown — every
// pre-R118-D call site — renders byte-identical without them); the R119-B
// `level` key joins that law (an unkeyed dropdown never animates).
type SubLevelAdditionsAreOptional =
  undefined extends HeaderDropdownProps["onBack"]
    ? undefined extends HeaderDropdownProps["children"]
      ? undefined extends HeaderDropdownProps["contentMaxHeight"]
        ? undefined extends HeaderDropdownProps["level"]
          ? true
          : never
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
// the R118-D selected marker + the R120-P separator flag + the press.
// Nothing else.
type ExpectedItemKeys =
  | "key"
  | "label"
  | "value"
  | "danger"
  | "selected"
  | "separator"
  | "onPress";
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

// ── ROUND-120 (why): ── the owner's item 33 — "The kebab menu gains a
// separator + 'Task list' option at the bottom." The separator flag is
// OPTIONAL like every row addition before it — a row without it renders
// byte-identical (every pre-R120 call site unchanged).
type SeparatorIsOptional = undefined extends HeaderDropdownItem["separator"] ? true : never;
const separatorOptional: SeparatorIsOptional = true;

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

  it("the row carries the R120-P separator flag — optional, additive to every call site", () => {
    expect(separatorOptional).toBe(true);
  });

  it("PANEL_WIDTH is 220 (components.md §Dropdown menus' band)", () => {
    expect(PANEL_WIDTH).toBe(220);
  });

  it("the exit fade is 120ms; the entrance scale floor is 0.96 (motion.md §4.8)", () => {
    expect(EXIT_FADE_MS).toBe(120);
    expect(ENTRANCE_SCALE).toBe(0.96);
  });
});

describe("HeaderDropdown — the R119-B animated level transitions", () => {
  it("the motion values pin: the 12dp slide, 180ms in, 120ms out", () => {
    expect(MAIN_LEVEL_KEY).toBe("main");
    expect(LEVEL_SLIDE_DP).toBe(12);
    expect(LEVEL_ENTER_MS).toBe(180);
    // the exit rides the SAME beat as the panel's own EXIT_FADE_MS — one
    // cadence, never a lagging ghost under a dismissed panel
    expect(LEVEL_EXIT_MS).toBe(120);
    expect(LEVEL_EXIT_MS).toBe(EXIT_FADE_MS);
  });

  it("levelSwapDirection — the pure drill-down derivation", () => {
    // a fresh panel (or the closed fade-out frame) has no direction: the
    // panel's own entrance owns the motion
    expect(levelSwapDirection(null, "main")).toBe("none");
    expect(levelSwapDirection(null, "model")).toBe("none");
    // drilling INTO a sub-level is FORWARD — the new body enters from the right
    expect(levelSwapDirection("main", "mode")).toBe("forward");
    expect(levelSwapDirection("main", "model")).toBe("forward");
    expect(levelSwapDirection("main", "thinking")).toBe("forward");
    expect(levelSwapDirection("main", "context")).toBe("forward");
    // returning to the root is BACK — from the left
    expect(levelSwapDirection("model", "main")).toBe("back");
    expect(levelSwapDirection("context", "main")).toBe("back");
    // same level re-renders (a value flip on the SAME level) never animate
    expect(levelSwapDirection("main", "main")).toBe("none");
    expect(levelSwapDirection("model", "model")).toBe("none");
    // an equal-depth swap (a sub-level straight to another sub-level — not
    // reachable from this screen's machine) dissolves without a slide
    expect(levelSwapDirection("mode", "thinking")).toBe("none");
  });
});
