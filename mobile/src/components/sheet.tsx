/**
 * Sheet — the reusable BOTTOM SHEET, built from the house primitives +
 * Reanimated inside a RN <Modal> (R113-c; NO new dependency): a scrim that
 * fades in, a clay panel that slides up under the over-damped SHEET spring
 * (R116-b: panels never bounce), and the honest close affordances (the scrim
 * tap, the X circle, Android's back button — the Modal's own
 * onRequestClose). The Modal host keeps the sheet above EVERYTHING (keyboard
 * included) without position tricks inside the composer's subtree. The
 * design language stays Clay Studio — the elevated card surface, the matte
 * top edge, the house radii — exactly like the preferences/provider screens'
 * expand patterns, just anchored to the bottom. Every row the callers render
 * must keep the 44px touch discipline.
 *
 * R115 — the ghost-panel fix: the panel now enters FULLY OPAQUE, sliding its
 * whole height from below the fold. The scrim rides its own faster timing
 * so the dim completes as the panel crosses the fold.
 *
 * R116-b — the round-116 mechanics (components.md §Sheets, motion.md §1): the
 * entrance rides the over-damped SHEET_SPRING (no overshoot, no
 * settle-wobble), the progress value is CLAMPED to [0,1], and the panel
 * carries a below-the-fold SKIRT (sacrificial card pixels hanging past the
 * fold) so the page background is never visible under it mid-animation. The
 * inner ScrollView sets overScrollMode="never" (no Android stretch).
 *
 * R118-A (the owner's round-118 verdict — "the bottom-up menu is trash"):
 * (1) THE FIRST-FRAME LAW: the Modal surfaces a NEW Android window whose
 * first frame(s) can composite BEFORE Reanimated's UI thread attaches the
 * animated props — and `useAnimatedStyle`'s JS-side return for those frames
 * is an EMPTY style object, so the panel painted at its layout position
 * (fully OPEN at rest) and the scrim at opacity 1. That was the owner's
 * "it just directly opens up from the bottom, then after a small while it
 * plays the animation" artifact. The fix is the STATIC INITIAL POSE in the
 * style arrays: a plain `transform: translateY(panelTravel)` / `opacity: 0`
 * placed BEFORE the animated style — RN's array flattening is last-wins per
 * key, so the static pose holds every frame until the worklet reports, then
 * silently loses. Deterministic, inert after frame one, zero timing
 * dependency. (2) THE HEADER: the grip is DELETED (a non-draggable sheet
 * wears no drag handle — the owner read it as "a simple line"), and the
 * title row becomes the header grammar: TypeTitle 20/700 left + a 36px
 * QuietIconButton close (the back-button circle, per the owner's "just like
 * how the back button is"). (3) SHEET_CHROME stays 64 — re-derived: sm 8 +
 * header 48 + xs 4 + 4 buffer.
 *
 * R118-E (the keyboard law): the sheet is KEYBOARD-AWARE — the panel rides
 * the IME (translateY -= min(kbHeight, headroom) on the SHEET spring, fed by
 * RN-core Keyboard events — guaranteed to fire from the Modal's own window,
 * unlike inset-plumbing libraries), and the ScrollView's content padding
 * absorbs the unrisen remainder so bottom fields scroll clear even when a
 * tall panel cannot rise further. KeyboardAvoidingView stays BANNED inside
 * sheets (the R115-K ruling — its padding math is parent-frame-relative and
 * under-reports on inset devices).
 *
 * R119-P (the owner's round-119 verdict — the Add-Provider sheet's UI was
 * right but "the animations were not that good"): the entrance moved to the
 * house DISCLOSURE settle (SHEET_SPRING {180, 24}), the scrim's timed legs
 * were re-curved, and the content row gained a delayed fade-in. All of that
 * is SUPERSEDED by R120-S below (the spring VALUE survives; the legs and the
 * content ride do not).
 *
 * R120-S (the owner's round-120 verdict — the round's sheet-motion authority:
 * "the animations are bad, they look ugly, they are stuttering, and they do
 * not play in the proper time when needed"). The DIAGNOSIS — the motion was
 * already native (Reanimated runs every spring/timing here on its UI thread;
 * there is no JS-driven Animated anywhere in this file), so the stutter was
 * never the driver. Three real defects:
 *
 *   (1) THE START RACE. The entrance was armed in the SAME effect that calls
 *       setRendered(true) — i.e. the spring started BEFORE the Modal's
 *       Android dialog window existed. Reanimated begins animating the
 *       shared value at assignment; the dialog's window creation + first
 *       composite land several frames later, so the sheet SURFACED
 *       mid-rise (at {180,24} it had already covered a third of its travel
 *       by the time it was visible) and finished its settle from there —
 *       "opens, then replays", the exact R118 artifact wearing a new mask.
 *       The frames that DID show ran concurrently with the window-creation
 *       work on the native threads — the stutter. FIX: the entrance arms
 *       from the Modal's own onShow (Android wires the Dialog's
 *       OnShowListener — the window EXISTS when it fires), with a 150ms JS
 *       timeout guard so a platform that never fires onShow cannot leave
 *       the sheet hanging below the fold. The static pose holds every
 *       pre-arm frame, so the owner now sees 100% of the rise, on frame one.
 *   (2) THE OVER-TRAVEL. panelTravel was maxHeightFraction × window + 48
 *       (~670dp on a tall phone) regardless of the panel's real content
 *       height — a settle tuned for a 300-400dp disclosure ran at ~2x
 *       velocity, the "zip" that read as ugly. FIX: the travel is the
 *       panel's MEASURED height (the fraction bound only holds the
 *       pre-layout frames, while the panel is fully below the fold either
 *       way). Height updates are accepted only while the progress is at
 *       rest (0 or 1) so a mid-flight layout — the keyboard remainder
 *       growing the scroller's padding — can never re-base the travel under
 *       a moving panel, while a level swap that grows the panel at rest
 *       still updates the close's travel (the exit always hides the WHOLE
 *       panel).
 *   (3) THE CLOSE + THE CONTENT RIDE. The R119 close was an ease-IN quad:
 *       it covered 2.7% of its travel in the first two frames — the sheet
 *       visibly LINGERED after the dismissal tap ("do not play in the
 *       proper time"), and the content pre-faded out (120ms) while the
 *       panel still sat there — the sheet emptied itself, then left. FIX:
 *       one coordinated timeline — the close departs on frame one
 *       (ease-OUT cubic, 220ms, BOTH legs, the exact callback owning the
 *       unmount so the Modal can never zombie past its own exit eating
 *       taps), the content never fades (the fold reveals it on the way in,
 *       the panel carries it away on the way out), and the R119 content
 *       ride (120ms fade, 40ms late) is DELETED — it was a patch on the
 *       start race and read as a late pop now that the rise is whole.
 *
 * R124 (the owner's round-124 verdict — "the bottom up menus are most
 * definitely not proper. They have bad animations. Like I need you to
 * properly and thoroughly work on these systems and improve them with
 * proper planning and with proper care.") — the round's sheet-motion
 * authority, SUPERSEDING the R120-S close law in two places and adding
 * the one interaction the sheet never owned:
 *
 *   (1) DRAG-TO-DISMISS. Every platform bottom sheet owns the swipe-away;
 *       this one offered only the scrim tap, the X, and Android's back
 *       button — and its one visual grab affordance had been DELETED by
 *       R118-A precisely because it was a lie ("a non-draggable sheet wears
 *       no drag handle"). R124 makes the sheet GENUINELY draggable: the
 *       header row (marked by a real grab pill) is the drag surface — a
 *       native RNGH Pan gesture (react-native-gesture-handler is already a
 *       dependency — the scanner rides it) feeds a Reanimated dragY shared
 *       value, the panel follows the finger 1:1, the upward leg is a rubber
 *       band (sheetRubberBandPx — the panel is bottom-anchored and must
 *       never detach from the screen's edge), and the release obeys the
 *       pure sheetDismissOnRelease law (velocity ≥ 900px/s downward OR ≥40%
 *       of the measured travel ⇒ dismiss; anything less springs home on
 *       the SHEET spring). The dismissal FOLDS the live drag into the
 *       progress value — interp(1 − d/travel) + 0 === interp(1) + d on the
 *       linear interpolation, so the handoff to the close timeline is
 *       frame-identical — and then rides the ordinary onClose flow (the
 *       caller's own state drives the exit; the API contract is untouched).
 *       The Modal's content gains its own GestureHandlerRootView (RNGH's
 *       documented Modal rule: an Android Modal is a separate native
 *       window; the app root's gesture root does not reach it).
 *   (2) THE EXIT MIRRORS THE ENTER. The R120-S close rode an ease-out-cubic
 *       TIMING while the rise rode the SHEET spring — two different
 *       physical materials for the same panel. The exit now falls the same
 *       way it rises: withSpring(0, SHEET_SPRING), with the spring's own
 *       completion callback owning the unmount (the never-zombie law
 *       survives verbatim). The spring departs FAST (ζ 0.894 covers half
 *       its travel in ~150ms) — the R119 linger defect does not return.
 *       The SCRIM keeps its timed 220ms ease-out fade (SHEET_CLOSE_MS — a
 *       pure fade is timing territory, motion.md §1).
 *   (3) THE DIM BREATHES WITH THE SHEET. The scrim's opacity is now the
 *       entrance fade MULTIPLIED by the panel's visible extent (how far
 *       the panel still covers the screen): the dim grows with the rise,
 *       thins with the finger during a drag, and fades with the exit — one
 *       coupled system instead of two independent legs. A panel below the
 *       fold never dims the page (the R118-A first-frame guard's spirit,
 *       extended to every frame).
 *
 * Frozen (verified untouched): the R118-A first-frame static poses,
 * SHEET_CHROME/SHEET_HEADER_ROW, SKIRT_PX, the clamp + skirt +
 * overScrollMode, maxHeightFraction, and the R118-E keyboard-ride mechanics
 * (the ride inherits the same SHEET_SPRING). Reduced motion: the panel
 * never travels — it snaps to its rest pose and the SCRIM fades (the only
 * leg that is a pure fade); the close snaps both and unmounts on the
 * scrim's callback; a released drag snaps home (direct manipulation stays,
 * its SETTLE animation goes).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { X } from "lucide-react-native";
import { useTheme } from "@/design/theme";
import { QuietIconButton } from "@/design/primitives";
import { RADIUS_TILE, SHEET_HEADER_ROW, spacing, TYPE_TITLE, fontFamily } from "@/design/tokens";
import {
  SHEET_CLOSE_MS,
  SHEET_SCRIM_OPEN_MS,
  SHEET_SHOW_ARM_FALLBACK_MS,
  SHEET_SPRING,
  sheetDismissOnRelease,
  sheetPanelTravelPx,
  sheetRubberBandPx,
} from "@/design/motion";

export interface SheetProps {
  /** Whether the sheet is open (the caller owns the state). */
  open: boolean;
  /** Close handler (the scrim tap, the X, and Android's back button). */
  onClose: () => void;
  /** The sheet's title (the header row's TypeTitle). */
  title: string;
  children: React.ReactNode;
  /** Max height fraction of the viewport (default 0.78 — scrolls inside). */
  maxHeightFraction?: number;
  testID?: string;
}

export function Sheet({
  open,
  onClose,
  title,
  children,
  maxHeightFraction = 0.78,
  testID,
}: SheetProps) {
  const { tokens } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  // R116-b — the skirt's depth: the fixed share plus the safe-area/legroom
  // maximum, i.e. exactly the region under the fold that a mid-animation dip
  // could otherwise expose. The panel hangs this far below the fold; the
  // resting top edge and the visible content padding are compensated to stay
  // byte-identical to R115 (see maxContentHeight + the scroller's padding).
  const skirtDepth = SKIRT_PX + Math.max(insets.bottom, spacing.lg);
  // R114 — the systemic empty-sheet fix: Android's Yoga collapses a flex:1
  // ScrollView inside a content-sized (auto-height) panel to ZERO height —
  // every sheet rendered as just the title row + X. The scroller is now
  // clamped in PIXELS (resolved against the live window height) so the panel
  // can wrap its content without the flex chicken-and-egg.
  // R118-A — the scroller's max grows by the skirt so the panel's RESTING top
  // edge stays exactly where R115 put it (the skirt hangs below the fold, it
  // never steals screen real estate).
  const maxContentHeight =
    Math.max(240, Math.round(windowHeight * maxHeightFraction) - SHEET_CHROME) +
    skirtDepth;
  // R115 — two independent values: the panel spring and the scrim's timed
  // fade. Mount/unmount discipline: the panel springs IN on open, springs
  // OUT on close (R124 — the exit mirrors the rise), and the Modal unmounts
  // only after the exit settles — one clean animation, never a hard cut,
  // never a flash of unanimated content.
  // R120-S — the values are armed from the Modal's own onShow (see the
  // R120-S header note (1)): the spring never burns frames against a window
  // that does not exist yet.
  // R124 — dragY is the live drag offset (0 at rest; the finger's pull while
  // the header drag is active). translateY = interp(progress) − rise + dragY.
  const panelProgress = useSharedValue(0);
  const scrimProgress = useSharedValue(0);
  const dragY = useSharedValue(0);
  /** The drag's continuity base: dragY at activation minus the activation-time
   *  translation, so the panel never snaps by the ~6px the gesture needed to
   *  activate. */
  const dragBase = useSharedValue(0);
  const [rendered, setRendered] = useState(open);
  const reducedMotion = useReducedMotion();

  // R120-S — the frame-one law's plumbing: `openRef` (the arm reads the LIVE
  // open state — native events land between renders), `armedRef` (one arm
  // per open cycle), `shownRef` (this Modal instance's window is up — the
  // reopen-during-close shortcut), and the fallback timer (the onShow
  // guard). `renderedRef` mirrors the state for the effect's branch reads.
  const openRef = useRef(open);
  const armedRef = useRef(false);
  const shownRef = useRef(false);
  const renderedRef = useRef(open);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hideRendered = useCallback(() => {
    // The race guard: a close callback that was already dispatched when the
    // owner re-opened must NOT tear the window down under the rising panel.
    if (openRef.current) return;
    renderedRef.current = false;
    shownRef.current = false;
    setRendered(false);
  }, []);

  const clearArmTimer = useCallback(() => {
    if (armTimerRef.current !== null) {
      clearTimeout(armTimerRef.current);
      armTimerRef.current = null;
    }
  }, []);

  // R120-S — THE ENTRANCE, armed on the first frame the window exists. Both
  // legs start together (one coordinated timeline): the scrim fades in over
  // SHEET_SCRIM_OPEN_MS ease-out cubic (completing as the settle lands) while
  // the panel rises its own measured height on the SHEET spring. Reduced
  // motion snaps the panel to rest — the scrim's fade is the only leg left.
  // R124 — a fresh open begins from REST: any stale drag offset from an
  // interrupted dismissal dies here (the gesture's dismissal fold already
  // zeroes it — this is the belt to that suspenders).
  const armEntrance = useCallback(() => {
    if (armedRef.current || !openRef.current) return;
    armedRef.current = true;
    clearArmTimer();
    dragY.value = 0;
    scrimProgress.value = withTiming(1, {
      duration: SHEET_SCRIM_OPEN_MS,
      easing: Easing.out(Easing.cubic),
    });
    panelProgress.value = reducedMotion ? 1 : withSpring(1, SHEET_SPRING);
  }, [reducedMotion, clearArmTimer, scrimProgress, panelProgress, dragY]);

  // R120-S — the panel's MEASURED height (the travel tuning): accepted only
  // while the progress sits at a rest end (0 or 1) so a mid-flight layout
  // (the keyboard remainder growing the scroller's padding) can never
  // re-base the travel under a moving panel — while a content swap that
  // grows the panel AT REST still updates it, so the close always hides the
  // whole panel.
  const [panelHeight, setPanelHeight] = useState(0);
  const acceptMeasuredHeight = useCallback(
    (height: number) => {
      const atRest = panelProgress.value === 0 || panelProgress.value === 1;
      if (atRest) setPanelHeight(height);
    },
    [panelProgress],
  );

  // R120-S — the panel's slide travel: its OWN measured height once layout
  // has reported (the settle is tuned for a 300-400dp disclosure — the old
  // maxHeightFraction × window + 48 bound ran the same settle at ~2x
  // velocity, the "zip" the owner read as ugly). The fraction bound holds
  // only the pre-layout frames, while the panel is fully below the fold
  // either way — the swap to the measured travel is invisible.
  // (R124: declared above the open/close effect — the close's live-drag fold
  // reads it, and the fold's math must see the SAME travel the panel style
  // interpolates over.)
  const panelTravel = sheetPanelTravelPx(
    panelHeight,
    Math.round(windowHeight * maxHeightFraction) + 48,
  );

  useEffect(() => {
    openRef.current = open;
    if (open) {
      armedRef.current = false;
      if (shownRef.current) {
        // The window is already up — a close was interrupted mid-flight (no
        // second onShow will fire for the live window): arm immediately.
        armEntrance();
        return;
      }
      renderedRef.current = true;
      setRendered(true);
      // The onShow guard: if the platform's onShow never lands, arm anyway —
      // the sheet can never hang below the fold.
      clearArmTimer();
      armTimerRef.current = setTimeout(() => armEntrance(), SHEET_SHOW_ARM_FALLBACK_MS);
      return;
    }
    // R124 — THE CLOSE: the exit MIRRORS the enter (superseding R120-S's
    // ease-out-cubic panel leg — a timing curve on the way down against a
    // spring on the way up read as two different materials for the same
    // panel). The panel falls on the SHEET spring with the spring's own
    // completion callback owning the unmount (the never-zombie law survives
    // verbatim — the Modal cannot outlive its own exit and eat taps); the
    // spring departs FAST (ζ 0.894 covers half its travel in ~150ms — the
    // R119 linger does not return). The SCRIM keeps its timed 220ms
    // ease-out fade (a pure fade is timing territory, motion.md §1).
    clearArmTimer();
    if (!renderedRef.current) return;
    // A LIVE drag folds into the progress value first — the SAME
    // frame-identical handoff the gesture's dismissal branch rides (a close
    // landing mid-drag: Android's back button while the finger is down, or
    // the rebuilt disabled gesture cancelling an active one) — so the exit
    // spring departs from the panel's exact current pose, never a snap.
    if (dragY.value !== 0) {
      panelProgress.value = Math.min(
        1,
        Math.max(0, panelProgress.value - dragY.value / Math.max(panelTravel, 1)),
      );
      dragY.value = 0;
    }
    if (reducedMotion) {
      // motion.md §5 — reduced motion: the panel never travels. Both legs
      // snap; the scrim's fade carries the exit and its callback unmounts.
      panelProgress.value = 0;
      scrimProgress.value = withTiming(
        0,
        { duration: SHEET_CLOSE_MS, easing: Easing.out(Easing.cubic) },
        (finished) => {
          if (finished) runOnJS(hideRendered)();
        },
      );
      return;
    }
    scrimProgress.value = withTiming(0, {
      duration: SHEET_CLOSE_MS,
      easing: Easing.out(Easing.cubic),
    });
    panelProgress.value = withSpring(0, SHEET_SPRING, (finished) => {
      if (finished) runOnJS(hideRendered)();
    });
  }, [open, reducedMotion, armEntrance, clearArmTimer, hideRendered, panelProgress, scrimProgress, dragY, panelTravel]);

  // The fallback timer must never outlive the component.
  useEffect(() => clearArmTimer, [clearArmTimer]);

  // R118-E — the keyboard ride: how far the panel lifts when the IME shows
  // (clamped to the headroom between the panel's resting top and the screen
  // top), animated on the same over-damped SHEET spring. The unrisen
  // remainder grows the scroller's bottom padding (JS state — one re-render
  // per keyboard transition, none per frame).
  const rise = useSharedValue(0);
  const [panelRestTopY, setPanelRestTopY] = useState(windowHeight);
  const [kbRemainder, setKbRemainder] = useState(0);

  useEffect(() => {
    if (!rendered) return;
    const show = Keyboard.addListener("keyboardDidShow", (e) => {
      const headroom = Math.max(0, panelRestTopY - insets.top - spacing.xl);
      const kb = e.endCoordinates.height;
      rise.value = withSpring(Math.min(kb, headroom), SHEET_SPRING);
      setKbRemainder(Math.max(0, Math.round(kb - headroom)));
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      rise.value = withSpring(0, SHEET_SPRING);
      setKbRemainder(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [rendered, panelRestTopY, insets.top, rise]);

  useEffect(() => {
    if (!rendered) {
      rise.value = 0;
      setKbRemainder(0);
    }
  }, [rendered, rise]);

  // ── R124 — THE DRAG-TO-DISMISS (the header row is the drag surface) ────────

  // The stable close proxy: a worklet captures its closure BY VALUE, so it
  // cannot read a React ref's live `.current` — the gesture captures THIS
  // stable callback instead, and it reads the ref on the JS thread at call
  // time (the API contract is untouched: the caller's own `open` state still
  // drives the exit; the drag only ever asks for the same onClose the scrim
  // tap and the X circle ask for).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const requestClose = useCallback(() => {
    onCloseRef.current();
  }, []);

  // The travel the RELEASE law reads: a shared-value mirror of the
  // React-side panelTravel (the worklet cannot read state), refreshed the
  // moment the measured height lands.
  const travelSv = useSharedValue(panelTravel);
  useEffect(() => {
    travelSv.value = panelTravel;
  }, [panelTravel, travelSv]);

  const panGesture = useMemo(() => {
    return (
      Gesture.Pan()
        // Vertical intent claims the band: 12px of vertical travel either
        // direction activates (down dismisses, up rubber-bands); a decisive
        // horizontal move (±24px) FAILS the pan so the header's taps and the
        // X circle's press never fight the drag.
        .activeOffsetY([-12, 12])
        .failOffsetX([-24, 24])
        // Only while open — a falling (exiting) panel cannot be re-caught.
        .enabled(open)
        .onStart((event) => {
          // The continuity base: dragY at activation minus the activation-time
          // translation — the ~12px the gesture needed to activate never
          // snaps the panel (the first onUpdate resumes the exact pose).
          dragBase.value = dragY.value - event.translationY;
        })
        .onUpdate((event) => {
          // Downward follows the finger 1:1; upward is the rubber band
          // (sheetRubberBandPx — the panel is bottom-anchored, it must never
          // detach from the screen's edge; a pure worklet-callable helper).
          const raw = event.translationY + dragBase.value;
          dragY.value = raw >= 0 ? raw : -sheetRubberBandPx(-raw);
        })
        .onEnd((event) => {
          const travel = travelSv.value;
          if (sheetDismissOnRelease(dragY.value, event.velocityY, travel)) {
            // THE FOLD — frame-identical handoff into the exit: the panel's
            // translateY is travel × (1 − progress) + dragY on the linear
            // interpolation, so folding dragY into progress (p′ = p − d/travel)
            // keeps the pose EXACTLY where the finger left it; the exit
            // spring then departs from that pose with zero jump.
            panelProgress.value = Math.min(
              1,
              Math.max(0, panelProgress.value - dragY.value / Math.max(travel, 1)),
            );
            dragY.value = 0;
            runOnJS(requestClose)();
          } else if (reducedMotion) {
            // Direct manipulation stays; the settle animation goes.
            dragY.value = 0;
          } else {
            // Springs home on the SHEET spring, carrying the release
            // velocity — the panel returns the way it came.
            dragY.value = withSpring(0, { ...SHEET_SPRING, velocity: event.velocityY });
          }
        })
        .onFinalize((_event, success) => {
          // A CANCELLED gesture (another handler claimed it, or `open`
          // flipped false mid-drag and the rebuilt disabled gesture
          // cancelled this one) must never strand the panel at a dragged
          // offset — spring home. The success path already ran onEnd.
          if (!success && dragY.value !== 0) {
            dragY.value = reducedMotion ? 0 : withSpring(0, SHEET_SPRING);
          }
        })
    );
  }, [open, requestClose, travelSv, panelProgress, dragY, dragBase, reducedMotion]);

  const scrim = useAnimatedStyle(() => {
    // R124 — THE DIM BREATHES WITH THE SHEET: the entrance fade × the
    // panel's visible extent (how far the panel still covers the screen).
    // The dim grows with the rise, thins with the finger during a drag, and
    // collapses with the exit — one coupled system instead of two
    // independent legs; a panel below the fold never dims the page (the
    // R118-A first-frame guard's spirit, extended to every frame).
    const y =
      interpolate(panelProgress.value, [0, 1], [panelTravel, 0], Extrapolation.CLAMP) -
      rise.value +
      dragY.value;
    const extent = 1 - Math.min(1, Math.max(0, y) / Math.max(panelTravel, 1));
    return { opacity: scrimProgress.value * extent };
  });
  // R116-b — the clamp: the progress is interpolated on [0,1] with
  // Extrapolation.CLAMP, so even if a spring ever overshoots 1 the translateY
  // can never go positive past the resting position. R118-E — the keyboard
  // rise subtracts INSIDE the same worklet so the entrance and the IME ride
  // compose without drift. R124 — dragY adds last: the live drag (and its
  // rubber band, already clamped ≥ −SHEET_DRAG_RUBBER_PX) composes with the
  // entrance and the keyboard ride as pure geometry.
  const panel = useAnimatedStyle(() => ({
    transform: [
      {
        translateY:
          interpolate(
            panelProgress.value,
            [0, 1],
            [panelTravel, 0],
            Extrapolation.CLAMP,
          ) -
          rise.value +
          dragY.value,
      },
    ],
  }));

  // R120-S — the Modal's own onShow (Android wires the Dialog's
  // OnShowListener): the window EXISTS when this fires, so arming here means
  // the spring's first visible frame is its first animated frame. The
  // SHEET_SHOW_ARM_FALLBACK_MS timer in the open effect is the guard if a
  // platform never delivers the event.
  const onModalShown = useCallback(() => {
    shownRef.current = true;
    armEntrance();
  }, [armEntrance]);

  return (
    <Modal
      visible={rendered}
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
      onShow={onModalShown}
      testID={testID}
    >
      {/* R124 — RNGH's documented Modal rule: an Android <Modal> is a
          separate native window; the app root's GestureHandlerRootView does
          not reach into it, so the sheet's own tree hosts its own gesture
          root (the drag lives entirely inside this window). */}
      <GestureHandlerRootView style={StyleSheet.absoluteFill}>
      <View style={StyleSheet.absoluteFill}>
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            // R118-A — the first-frame guard: an unset opacity renders 1 (a
            // one-frame full-black scrim before the fade-in). Zero until
            // `scrim` lands, then last-wins takes over.
            { opacity: 0 },
            scrim,
            { backgroundColor: tokens.isDark ? "rgba(0,0,0,0.62)" : "rgba(26,18,10,0.45)" },
          ]}
        >
          <Pressable
            accessibilityLabel="Close the sheet"
            accessibilityRole="button"
            style={StyleSheet.absoluteFill}
            onPress={onClose}
          />
        </Animated.View>
        <View style={styles.anchor}>
          <Animated.View
            // No accessibilityRole — RN's type surface carries no "dialog"
            // (the Modal itself is the native dialog window on Android).
            accessibilityLabel={title}
            onLayout={(e) => {
              // R118-E — the panel's RESTING top edge (layout ignores the
              // transform, so y is stable at rest) — the keyboard ride's
              // headroom reference.
              setPanelRestTopY(e.nativeEvent.layout.y);
              // R120-S — the measured height (see acceptMeasuredHeight for
              // the at-rest gate).
              acceptMeasuredHeight(e.nativeEvent.layout.height);
            }}
            style={[
              styles.panel,
              // R118-A — the static initial pose: the Modal's NEW Android
              // window can composite a frame BEFORE Reanimated's UI thread
              // applies the animated transform; those frames must find the
              // panel BELOW THE FOLD, never at rest. Array flattening is
              // last-wins: once `panel` reports its transform this line is
              // inert; until then it holds the pose.
              { transform: [{ translateY: panelTravel }] },
              panel,
              {
                backgroundColor: tokens.card,
                borderTopColor: tokens.clayTopEdge,
                // round-117-elevation §2.2: the panel's upward shadow rides the
                // theme token (clayShadowSheet) — the hardcoded string is gone.
                boxShadow: tokens.clayShadowSheet,
                // R116-b — the skirt: the panel's border box hangs this far
                // below the fold (sacrificial card pixels), so a mid-animation
                // dip can never reveal the page background under the sheet.
                marginBottom: -skirtDepth,
              },
            ]}
          >
            {/* R124 — THE DRAG SURFACE: the grab band + the header row.
                The header row keeps its R118-A anatomy (TypeTitle left + the
                quiet circle close — the back-button grammar the owner ruled);
                the GRAB PILL returns because the sheet is GENUINELY draggable
                now — R118-A deleted the grip BECAUSE it was a lie ("a
                non-draggable sheet wears no drag handle"), and R124 made it
                the truth. The pill rides the panel's own paddingTop band
                (marginTop −sm pulls the band up into it; the pill's 2+4+2 ===
                sm — SHEET_CHROME's arithmetic is untouched). Vertical intent
                (±12px) claims the drag; taps stay taps, the X circle's press
                never fights the pan. */}
            <GestureDetector gesture={panGesture}>
              <View style={styles.headerWrap}>
                <View
                  accessibilityElementsHidden
                  pointerEvents="none"
                  style={[styles.grabPill, { backgroundColor: tokens.borderStrong }]}
                />
                <View style={styles.headerRow}>
                  <Text
                    numberOfLines={1}
                    ellipsizeMode="tail"
                    style={[styles.headerTitle, { color: tokens.text }]}
                  >
                    {title}
                  </Text>
                  <QuietIconButton
                    icon={X}
                    iconSize={18}
                    size={36}
                    hitSlop={8}
                    onPress={onClose}
                    accessibilityLabel="Close"
                  />
                </View>
              </View>
            </GestureDetector>
            {/* R120-S — the R119 content ride is DELETED (a 120ms fade
                starting 40ms late — a patch on the start race that read as a
                pop): the panel is fully opaque and the fold itself reveals
                the content top-first as the panel rises its own height. The
                scroller keeps its R114 pixel clamp + the R116-b/R118-E
                padding laws byte-identical. */}
            <ScrollView
              style={{ maxHeight: maxContentHeight }}
              contentContainerStyle={[
                styles.content,
                {
                  // R116-b: the skirt's inner compensation — the content's
                  // bottom padding grows by the skirt so the VISIBLE breathing
                  // room above the fold is exactly what R115 rendered.
                  // R118-E: plus the unrisen keyboard remainder — the scroll
                  // floor ends above the IME even when the panel cannot ride
                  // fully onto it.
                  paddingBottom:
                    Math.max(insets.bottom, spacing.lg) +
                    spacing.sm +
                    skirtDepth +
                    kbRemainder,
                },
              ]}
              keyboardShouldPersistTaps="handled"
              overScrollMode="never"
            >
              {children}
            </ScrollView>
          </Animated.View>
        </View>
      </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

/** The non-content chrome above the scroller.
 *  R118-A re-derivation: paddingTop sm (8) + header row 48 + content
 *  paddingTop xs (4) + buffer 4 = 64 — the R114 clamp math is preserved
 *  byte-for-byte. */
const SHEET_CHROME = 64;

/**
 * R116-b — the below-the-fold skirt's fixed share (components.md §Sheets).
 * The panel hangs SKIRT_PX + the safe-area/legroom maximum below the fold;
 * the resting top edge and the visible content padding are unchanged (the
 * scroller max + the content's bottom padding grow by the same depth).
 */
const SKIRT_PX = 28;

const styles = StyleSheet.create({
  anchor: {
    ...StyleSheet.absoluteFill,
    justifyContent: "flex-end",
  },
  panel: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: RADIUS_TILE,
    borderTopRightRadius: RADIUS_TILE,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  /** R124 — THE DRAG SURFACE: the grab band + the header row in ONE
   *  GestureDetector subtree. marginTop −sm pulls the band up into the
   *  panel's own paddingTop (the band re-spends the same 8px: pill 2+4+2),
   *  so the panel's total chrome — and SHEET_CHROME's arithmetic — is
   *  byte-identical to R118-A. */
  headerWrap: { marginTop: -spacing.sm },
  /** R124 — THE GRAB PILL: 36×4 rounded, centered in the band, in the quiet
   *  borderStrong gray (18% ink) — the visible affordance that the header is
   *  the drag surface; decorative (pointerEvents none, hidden from a11y —
   *  the X circle stays the explicit close affordance for screen readers). */
  grabPill: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    marginTop: 2,
    marginBottom: 2,
  },
  /** R118-A — the header row: 48 tall, the title left-aligned with the
   *  fields below (the panel's own lg gutter is the row's gutter), the
   *  close circle right (its hitSlop reaches past the panel's edge). */
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    height: SHEET_HEADER_ROW,
    paddingHorizontal: spacing.xs,
  },
  headerTitle: {
    flex: 1,
    fontSize: TYPE_TITLE,
    fontFamily: fontFamily.bold,
    letterSpacing: -0.2,
  },
  content: {
    gap: spacing.sm,
    paddingTop: spacing.xs,
  },
});
