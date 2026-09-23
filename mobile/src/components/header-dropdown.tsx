/**
 * HeaderDropdown — the ANCHORED header menu (R116-l — components.md §Dropdown
 * menus, motion.md §4.8): a kebab/overflow control on a header opens its menu
 * DIRECTLY BELOW the control (top-right corner), springing in on the house
 * spring (scale 0.96→1 + opacity, origin top-right, ~180ms) and dismissing on
 * a scrim-less tap-outside with a 120ms fade — NOT a bottom sheet. Reserved
 * for header chrome; body rows keep sheets (the round-116 idiom).
 *
 * POSITIONING CONTRACT (the simplest honest shape): the caller renders this
 * component inside an absolutely-positioned anchor View aligned to the header
 * row's right/bottom (the session screen: {position:"absolute", top:<header
 * height>, left:0, right:0, bottom:0} with pointerEvents="box-none"). THIS
 * component then fills that anchor with one transparent tap-outside Pressable
 * (every tap below the header dismisses — the header row itself stays live so
 * the kebab toggles closed and the back chip keeps its own tap) and floats the
 * panel at the anchor's top-right. The anchor carries box-none so an empty
 * (closed) layer never steals a touch from the content beneath it.
 *
 * Rows are label (TypeBodyStrong) + live value (TypeCaption, right-aligned,
 * ONE line — the single-line law) + a ChevronRight for detail-routed rows; the
 * danger arm carries the stop glyph instead (the KebabRow grammar the old
 * sheet owned, restated for the menu). Presentation only — no data, no sheets:
 * every row's onPress routes the CALLER's surface.
 *
 * R118-D — THE SUB-LEVEL GRAMMAR (the owner's verdict: the kebab's rows used
 * to close the menu and open the composer's bottom SHEETS — exactly what he
 * rejected; the levels now render IN this panel):
 *   · `onBack` — when present, the title row gains a leading back chevron
 *     (ChevronLeft 18, a 40×32 Pressable with hitSlop 8): the sub-level's
 *     way back to the caller's main level (still presentation-only — the
 *     caller owns the level state);
 *   · `HeaderDropdownItem.selected` — a selected row swaps the ChevronRight
 *     for Check 16 in the accent (the in-place option list's marker);
 *   · `children` — arbitrary content under the title row (the Context
 *     readout, the Model level's sections, the busy rows);
 *   · `contentMaxHeight` — wraps the rows in a ScrollView when set (the
 *     model list scrolls INSIDE the panel; overScrollMode="never" — the
 *     house's no-stretch law).
 *
 * R119-B — THE LEVEL TRANSITIONS ANIMATE (the owner's verdict: "I would like
 * some animation while switching between the menus"): the panel's BODY (the
 * title row + the ScrollView content) becomes a view KEYED by `level`, so a
 * level swap crossfades the bodies with a DIRECTIONAL 12dp horizontal slide
 * — drilling INTO a sub-level enters from the RIGHT (180ms ease-out, the
 * house DISCLOSURE family's beat), going BACK returns from the LEFT, and
 * the old level mirrors out over 120ms (sub-levels exit RIGHT — the way
 * they came in; the root exits LEFT under whatever drills in over it). The
 * direction derives from the levels' DEPTH (the root "main" = 0, every
 * named sub-level = 1) through `levelSwapDirection` (pure, exported for the
 * tests). The panel's own entrance/exit (the spring 0.96→1 + the 120ms exit
 * fade) is UNTOUCHED — its constants stay frozen; a freshly-opened panel
 * rides its own spring with no body slide. Reduced motion gates the slide
 * to a plain 120ms fade (motion.md §5).
 *
 * Reduced motion snaps (motion.md §5): the entrance lands at 1 with no spring,
 * the exit unmounts immediately.
 *
 * R120-P — THE SEPARATOR (the owner's item 33: "The kebab menu gains a
 * separator + 'Task list' option at the bottom"): a row carrying
 * `separator: true` renders the R118-B STRONG inset rule (1dp borderStrong,
 * gutter-inset) above itself — the visible tier break between the menu's
 * control rows and the session's own tools. Additive + optional; every
 * pre-R120 call site renders byte-identical.
 */

import { useEffect, useLayoutEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  Keyframe,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Check, ChevronLeft, ChevronRight, Square } from "lucide-react-native";
import { useTheme } from "@/design/theme";
import { TypeBodyStrong, TypeCaption, TypeMicro } from "@/design/primitives";
import { SPRING } from "@/design/motion";
import { RADIUS_INPUT, spacing, TOUCH_TARGET } from "@/design/tokens";

/** One menu row: label + live value + the route. */
export interface HeaderDropdownItem {
  /** The row's stable key — also its testID suffix ({testID}-{key}). */
  key: string;
  label: string;
  /** The row's CURRENT value, right-aligned ("Full Access", "42%", …). */
  value?: string;
  /** The danger tone (the stop arm) — a filled stop glyph, no chevron. */
  danger?: boolean;
  /** R118-D — the option-list marker: a selected row swaps the ChevronRight
   *  for Check 16 in the accent (the sub-levels' in-place pickers). */
  selected?: boolean;
  /** ── ROUND-120 (why): ── the owner's item 33 — "The kebab menu gains a
   *  separator + 'Task list' option at the bottom." A row carrying
   *  `separator` renders the R118-B STRONG inset rule above itself — the
   *  visible break between the menu's control tier and the session's own
   *  tools. Additive + optional: every existing call site is unchanged. */
  separator?: boolean;
  onPress: () => void;
}

export interface HeaderDropdownProps {
  /** Whether the menu is open (the caller owns the state). */
  open: boolean;
  /** Dismiss handler (the tap-outside catcher; the caller closes its state). */
  onClose: () => void;
  items: HeaderDropdownItem[];
  /** The panel's testID; each row carries {testID}-{item.key}. */
  testID?: string;
  /** The quiet title row above the items ("Session options"). */
  title?: string;
  /** R118-D — when present, the title row renders a leading back chevron
   *  (the sub-level's way back to the caller's main level). */
  onBack?: () => void;
  /** R118-D — arbitrary content under the title row (the Context readout,
   *  the Model level's provider sections, the busy rows). */
  children?: React.ReactNode;
  /** R118-D — when set, the rows scroll inside the panel (the model list). */
  contentMaxHeight?: number;
  /** R119-B — the level the panel is showing (the caller's level machine's
   *  CURRENT key — "main" for the root, the sub-level's own name).
   *  The panel BODY is keyed by this: a change swaps the levels with the
   *  directional 12dp slide+crossfade. Optional + defaulted to the root —
   *  a single-level dropdown (every pre-R119-B call site) never animates. */
  level?: string;
}

/** The panel's fixed width (~200-240 per components.md §Dropdown menus). */
export const PANEL_WIDTH = 220;

/** motion.md §4.8 — the entrance scale floor (0.96→1, origin top-right). */
export const ENTRANCE_SCALE = 0.96;

/** motion.md §4.8 — the tap-outside dismissal fade. */
export const EXIT_FADE_MS = 120;

// ── R119-B — the level-swap motion (round-119.md §2 Track B) ─────────────────

/** The root level's key (the caller's level machine's depth-0). */
export const MAIN_LEVEL_KEY = "main";

/** R119-B — the level-swap body slide (dp): the new level's horizontal
 *  offset — in from the right (a drill-down) or the left (the way back). */
export const LEVEL_SLIDE_DP = 12;

/** R119-B — the entering level's slide+crossfade (ms, ease-out — the house
 *  DISCLOSURE family's beat). */
export const LEVEL_ENTER_MS = 180;

/** R119-B — the exiting level's mirrored fade+slide (ms) — deliberately the
 *  same beat as the panel's own EXIT_FADE_MS so a level swap and a panel
 *  dismissal read as one cadence; also the reduced-motion plain fade. */
export const LEVEL_EXIT_MS = 120;

/** R119-B — the direction of a level swap: "forward" (drilling INTO a
 *  sub-level — the new body enters from the RIGHT), "back" (returning to
 *  the root — from the LEFT), "none" (same depth or no previous — a fresh
 *  panel rides the panel's own entrance; an equal-depth swap dissolves). */
export type LevelSwapDirection = "forward" | "back" | "none";

/** The level machine's depth: the root is 0, every named sub-level is 1. */
function levelDepth(level: string): number {
  return level === MAIN_LEVEL_KEY ? 0 : 1;
}

/** R119-B — the direction of the swap between two levels, derived from
 *  depth (main is 0; mode/model/thinking/context… are all 1). Deeper =
 *  forward, shallower = back, equal depth or an unknown previous = none.
 *  Pure — exported for the tests. */
export function levelSwapDirection(prev: string | null, next: string | null): LevelSwapDirection {
  if (prev === null || next === null || prev === next) return "none";
  const delta = levelDepth(next) - levelDepth(prev);
  if (delta > 0) return "forward";
  if (delta < 0) return "back";
  return "none";
}

// ── R119-B — the level-swap keyframes (the drill-down grammar) ──────────────
// Keyframe-based definitions (plain data — no user worklets for the babel
// plugin to transform; constructed with `new`, the reanimated-4 shape —
// the class is not callable bare), built once at module scope so the
// `exiting` prop's reference stays STABLE across renders (reanimated
// re-configures a CHANGED exiting builder on update; a stable one is a
// no-op). The entering side is chosen per swap (forward = from the RIGHT,
// back = from the LEFT); the exiting side mirrors it — a sub-level rides
// back out to the RIGHT (the way it came in), the root exits LEFT under
// whatever drills in over it.

/** Entering FORWARD — the drilled-in level slides in from the RIGHT. */
const LEVEL_IN_FROM_RIGHT = new Keyframe({
  from: { opacity: 0, transform: [{ translateX: LEVEL_SLIDE_DP }] },
  to: { opacity: 1, transform: [{ translateX: 0 }], easing: Easing.out(Easing.cubic) },
}).duration(LEVEL_ENTER_MS);

/** Entering BACK — the returned root slides in from the LEFT. */
const LEVEL_IN_FROM_LEFT = new Keyframe({
  from: { opacity: 0, transform: [{ translateX: -LEVEL_SLIDE_DP }] },
  to: { opacity: 1, transform: [{ translateX: 0 }], easing: Easing.out(Easing.cubic) },
}).duration(LEVEL_ENTER_MS);

/** Exiting LEFT — the root's mirrored farewell under a drill-in. */
const LEVEL_OUT_TO_LEFT = new Keyframe({
  from: { opacity: 1, transform: [{ translateX: 0 }] },
  to: { opacity: 0, transform: [{ translateX: -LEVEL_SLIDE_DP }], easing: Easing.out(Easing.cubic) },
}).duration(LEVEL_EXIT_MS);

/** Exiting RIGHT — the sub-level rides back out the way it came. */
const LEVEL_OUT_TO_RIGHT = new Keyframe({
  from: { opacity: 1, transform: [{ translateX: 0 }] },
  to: { opacity: 0, transform: [{ translateX: LEVEL_SLIDE_DP }], easing: Easing.out(Easing.cubic) },
}).duration(LEVEL_EXIT_MS);

export function HeaderDropdown({
  open,
  onClose,
  items,
  testID,
  title,
  onBack,
  children,
  contentMaxHeight,
  level,
}: HeaderDropdownProps) {
  const { tokens } = useTheme();
  const reduced = useReducedMotion();
  const progress = useSharedValue(0);
  // The measured panel height — the scale origin's translateY pin needs it
  // (origin top-right: the top edge stays put while the panel grows).
  const panelHeight = useSharedValue(0);
  // Mount/unmount discipline (the Sheet's): the panel springs in on open,
  // fades out over EXIT_FADE_MS on close, and unmounts only after the exit
  // settles — one clean animation, never a hard cut.
  const [rendered, setRendered] = useState(open);

  // ── R119-B — the level-swap machine ──────────────────────────────────
  // The panel's BODY (the title row + the content) is keyed by the level;
  // when the key changes, the levels crossfade with the directional 12dp
  // slide. The direction is derived from the PREVIOUS level's depth vs the
  // new one, held in STATE (not a render-phase ref — a StrictMode or
  // concurrent double render must compute the same swap twice, not eat it
  // on the second pass); the memory updates in a layout effect after the
  // swap commits. `enteredFrom` records how the CURRENTLY-mounted body
  // entered, which is the exit direction it will ride out on: a sub-level
  // came in from the right and leaves to the right (back nav); the root
  // (fresh-opened or returned) leaves to the left under a drill-in — the
  // mirrored halves of every swap, derivable at the OLD body's own last
  // render, before the swap is even requested.
  const levelKey = level ?? MAIN_LEVEL_KEY;
  const [levelMemory, setLevelMemory] = useState<{ level: string; enteredFrom: LevelSwapDirection }>(() => ({
    // Seeded from the FIRST level so a dropdown that MOUNTS at a sub-level
    // (not this screen's machine — it always opens at the root) reads swap
    // "none" on its first frame: the panel's own entrance owns the motion.
    level: level ?? MAIN_LEVEL_KEY,
    enteredFrom: "none",
  }));
  const swap = levelSwapDirection(levelMemory.level, levelKey);
  useLayoutEffect(() => {
    if (levelMemory.level === levelKey) return;
    // A re-render WITHOUT a level change must never reset the memory; only
    // an actual swap writes it, and only with the swap's own direction.
    setLevelMemory({
      level: levelKey,
      enteredFrom: swap === "none" ? levelMemory.enteredFrom : swap,
    });
  }, [levelKey, swap, levelMemory.level, levelMemory.enteredFrom]);

  // The entering builder rides the CURRENT swap (reanimated reads
  // `entering` only at MOUNT, so the post-commit memory re-render can never
  // restart it); a fresh panel (swap "none") rides the panel's own spring,
  // and a closing panel drops the prop so the body never animates under the
  // panel's fade. Reduced motion: the plain LEVEL_EXIT_MS fade (motion.md §5).
  const bodyEntering =
    !open || swap === "none"
      ? undefined
      : reduced
        ? FadeIn.duration(LEVEL_EXIT_MS)
        : swap === "forward"
          ? LEVEL_IN_FROM_RIGHT
          : LEVEL_IN_FROM_LEFT;
  // The exiting builder rides the body's OWN entry memory — "exit the way
  // you came in" — so the prop frozen on the old body at its last render is
  // already the mirrored direction of the swap about to remove it.
  const bodyExiting =
    !open
      ? undefined
      : reduced
        ? FadeOut.duration(LEVEL_EXIT_MS)
        : levelMemory.enteredFrom === "forward"
          ? LEVEL_OUT_TO_RIGHT
          : LEVEL_OUT_TO_LEFT;

  useEffect(() => {
    if (open) {
      setRendered(true);
      progress.value = reduced ? 1 : withSpring(1, SPRING);
      return;
    }
    if (!rendered) return;
    if (reduced) {
      // motion.md §5 — reduced motion snaps: no exit animation at all.
      progress.value = 0;
      setRendered(false);
      return;
    }
    progress.value = withTiming(0, { duration: EXIT_FADE_MS }, (finished) => {
      if (finished) runOnJS(setRendered)(false);
    });
  }, [open, rendered, reduced, progress]);

  // The entrance: opacity + scale 0.96→1 with the TOP-RIGHT corner pinned —
  // the deterministic origin pin (scale about center + the compensating
  // translations keeps the right and top edges exactly where they rest).
  const panelStyle = useAnimatedStyle(() => {
    const p = Math.max(0, Math.min(1, progress.value));
    const s = ENTRANCE_SCALE + (1 - ENTRANCE_SCALE) * p;
    return {
      opacity: p,
      transform: [
        { translateX: (1 - s) * (PANEL_WIDTH / 2) },
        { translateY: -((1 - s) * (panelHeight.value / 2)) },
        { scale: s },
      ],
    };
  });

  const onPanelLayout = (event: LayoutChangeEvent): void => {
    const measured = event.nativeEvent.layout.height;
    if (measured > 0) panelHeight.value = measured;
  };

  if (!rendered) return null;

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {/* The tap-outside catcher — full-layer, transparent, scrim-less
          (components.md §Dropdown menus: never a bottom sheet's dim). */}
      <Pressable
        accessibilityLabel="Dismiss the menu"
        accessibilityRole="button"
        onPress={onClose}
        style={StyleSheet.absoluteFill}
      />
      {/* The panel — ClayCard-class: card surface, r14, the matte clay top
          edge, clayShadow2 (the floating menu's elevation). */}
      <Animated.View
        accessibilityLabel={title !== undefined ? title : "Menu"}
        onLayout={onPanelLayout}
        style={[
          styles.panel,
          panelStyle,
          {
            backgroundColor: tokens.card,
            borderTopColor: tokens.clayTopEdge,
            boxShadow: tokens.clayShadow2,
          },
        ]}
        testID={testID}
      >
        {/* R119-B — THE LEVEL BODY (the title row + the content), keyed by
            the level: a swap crossfades the bodies with the directional 12dp
            slide (the new level enters from the RIGHT drilling in / from the
            LEFT on the way back; the old level mirrors out over 120ms).
            Deliberately UNSTYLED — reanimated's entering/exiting own the
            transform/opacity, and a style prop here would fight them; the
            exiting ghost overlays the entering body inside the panel's
            overflow-hidden clip until its fade settles. */}
        <Animated.View key={levelKey} entering={bodyEntering} exiting={bodyExiting}>
          {title !== undefined ? (
            <View style={[styles.titleRow, { borderBottomColor: tokens.borderSubtle }]}>
              {/* R118-D — the sub-level's way back: a leading back chevron
                  (40×32 Pressable, hitSlop 8) beside the title. */}
              {onBack !== undefined ? (
                <Pressable
                  accessibilityLabel="Back"
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={onBack}
                  style={styles.backTarget}
                >
                  <ChevronLeft size={18} color={tokens.text} strokeWidth={2.2} />
                </Pressable>
              ) : null}
              <TypeMicro style={{ color: tokens.textTertiary, flex: 1 }} numberOfLines={1}>
                {title}
              </TypeMicro>
            </View>
          ) : null}
          {/* R118-D — the content: `children` (the readouts/sections) under the
              title row, then the rows — wrapped in a ScrollView when
              contentMaxHeight is set (the model list scrolls in place; the
              house's no-stretch law carries over from the Sheet). */}
          {contentMaxHeight !== undefined ? (
            <ScrollView style={{ maxHeight: contentMaxHeight }} overScrollMode="never" nestedScrollEnabled>
              {children}
              {items.map((item) => (
                <DropdownRow
                  key={item.key}
                  item={item}
                  testID={testID !== undefined ? `${testID}-${item.key}` : undefined}
                />
              ))}
            </ScrollView>
          ) : (
            <>
              {children}
              {items.map((item) => (
                <DropdownRow
                  key={item.key}
                  item={item}
                  testID={testID !== undefined ? `${testID}-${item.key}` : undefined}
                />
              ))}
            </>
          )}
        </Animated.View>
      </Animated.View>
    </View>
  );
}

/** One menu row — label + CURRENT value right-aligned + the chevron (the
 * danger arm carries the stop affordance instead; a R118-D `selected` row
 * carries the accent Check; a R120-P `separator` row carries the strong
 * inset rule above it — the tier break). The old kebab sheet's KebabRow
 * grammar, restated for the anchored menu. */
function DropdownRow({ item, testID }: { item: HeaderDropdownItem; testID?: string }) {
  const { tokens } = useTheme();
  const danger = item.danger === true;
  const selected = item.selected === true;
  return (
    <View>
      {item.separator === true ? (
        // ── ROUND-120 (why): ── the owner's item 33 — "a separator + 'Task
        // list' at the bottom." The R118-B STRONG recipe: a full 1dp
        // borderStrong rule inset by the gutter (a hairline divider is
        // arithmetically invisible — not a divider).
        <View style={[styles.rowSeparator, { backgroundColor: tokens.borderStrong }]} />
      ) : null}
      <Pressable
        testID={testID}
        accessibilityLabel={item.value !== undefined ? `${item.label} — ${item.value}` : item.label}
        accessibilityRole="button"
        accessibilityState={selected ? { selected: true } : undefined}
        onPress={item.onPress}
        style={({ pressed }) => [styles.row, { backgroundColor: pressed ? tokens.subtleHover : "transparent" }]}
      >
        <TypeBodyStrong style={{ flex: 1, color: danger ? tokens.danger : tokens.text }} numberOfLines={1}>
          {item.label}
        </TypeBodyStrong>
        {item.value !== undefined ? (
          <TypeCaption style={{ color: tokens.textSecondary, flexShrink: 1 }} numberOfLines={1}>
            {item.value}
          </TypeCaption>
        ) : null}
        {danger ? (
          <Square size={13} color={tokens.danger} strokeWidth={2.4} fill={tokens.danger} />
        ) : selected ? (
          <Check size={16} color={tokens.accent} strokeWidth={2.4} />
        ) : (
          <ChevronRight size={16} color={tokens.textTertiary} strokeWidth={2.2} />
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  /** The anchored panel — top-right of the caller's layer, fixed width,
   * r14, the matte top edge + clayShadow2 (the ClayCard elevation idiom). */
  panel: {
    position: "absolute",
    top: spacing.xs,
    right: spacing.sm,
    width: PANEL_WIDTH,
    borderRadius: RADIUS_INPUT,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.xs,
    overflow: "hidden",
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  /** R118-D — the sub-level's back chevron: a 40×32 Pressable (hitSlop 8
   *  carries the 44px law) leading the title row. */
  backTarget: {
    width: 40,
    height: 32,
    marginLeft: -spacing.xs,
    alignItems: "center",
    justifyContent: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
  },
  /** ── ROUND-120 (why): ── the R118-B STRONG inset rule above a
   *  `separator` row — the visible tier break (1dp borderStrong, inset
   *  by the gutter; never after the last row — the flag lives on the row
   *  that NEEDS the break above it). */
  rowSeparator: {
    height: 1,
    marginLeft: spacing.md,
    marginRight: spacing.md,
    marginTop: spacing.xs,
    marginBottom: 2,
  },
});
