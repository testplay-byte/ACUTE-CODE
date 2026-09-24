/**
 * chart-donut.tsx — the R115-N model-usage donut (mobile/src's port of the
 * PC's ModelDonut, src/components/usage/ModelDonut.tsx: the R98-I2
 * strokeDasharray + per-segment-rotation ring math applied to N segments
 * instead of one fill). The phone's dashboard renders it inside the "Top
 * models" card: the ring carries the token shares, the legend rows beside it
 * are the leaderboard folded in, and the center hole carries the total
 * (the caller's `center` slot — theme primitives live there, this module
 * stays theme-free and takes hues/colors as data).
 *
 * R124 (the owner's round-124 verdict — "the model's last month donut chart
 * is not proper. It is looking ugly and bad"): the R120-S full-card-width
 * stretch is RETIRED — a ~300dp ring wearing an 8dp stroke read as a thin
 * wireframe hoop with an echoing hole. The dashboard now composes the ring
 * at a PROPORTIONATE size BESIDE the ranked legend (one row, no dead bands,
 * no wire ring) and passes the new `strokeWidth` prop so the ring carries a
 * solid, scaled stroke (~11% of its diameter, clamped 12–18) instead of the
 * 120px-era fixed 8. The prop is ADDITIVE with the old default, so every
 * other DonutChart caller (none today) renders byte-identically.
 *
 * MOTION (motion.md §4.6): the ring SWEEPS in once per data load — every arc
 * animates its visible length 0 → its share with withTiming 500ms
 * (DONUT_SWEEP_MS), keyed on the `dataKey` prop (the caller's data identity)
 * so window switches and reloads re-trigger it. Never loops; reduced motion
 * snaps straight to the resting ring.
 *
 * THE SWEEP MECHANISM (a strokeDashoffset draw, not a dasharray animation):
 * each arc renders its FINAL `strokeDasharray` (the PC math: `${dash} ${C}`)
 * and the sweep animates `strokeDashoffset` from `dash` → 0 — a positive
 * offset of `dash` hides the arc entirely, and easing it down to 0 grows the
 * visible arc from its start point (the classic SVG line-draw).
 * strokeDashoffset is a NUMERIC prop — the exact animated-prop class the
 * connect hub's AnimatedLine already ships — while every string prop
 * (dasharray, rotation) stays static.
 *
 * FAIL-STATIC HEDGE (no device in this sandbox): every animated prop also
 * carries its FINAL value as a plain prop (full arc, resting opacity). If
 * reanimated-on-SVG ever fails to apply on a device, the donut renders
 * complete and static — the failure mode is "no animation", never "no ring".
 *
 * MUTUAL HIGHLIGHT (the PC's hover contract, phone-translated): the OWNER of
 * the highlight is the caller (the legend rows — the 44px targets); this
 * component receives `highlighted: number | null` and springs each arc's
 * opacity 1 ↔ DONUT_DIM_OPACITY (0.35 — round-117: the selected segment pops harder) on the house spring. The concentric
 * strokes themselves are NOT tappable — a bbox hit-test would route every
 * tap to the last-drawn circle, so the legend row is the one honest surface.
 *
 * PURE + EXPORTED for tests: donutShares (share-of-total), donutSegments
 * (the arc math), shortModelName (the PC usage-helpers port for the center
 * headline). The mobile suite is pure-logic by convention (jest.config.js),
 * so the component half is untested surface and the math is pinned in
 * __tests__/chart-donut.test.ts.
 */

import { useMemo, useLayoutEffect } from "react";
import { StyleSheet, View } from "react-native";
import type { ReactNode } from "react";
import Svg, { Circle } from "react-native-svg";
import Animated, {
  Easing,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import type { SharedValue } from "react-native-reanimated";
import { DONUT_SWEEP_MS, SPRING } from "@/design/motion";

/** The ring's stroke width — PC parity (ModelDonut's 6px track) at the
 *  R115-N 120px ring's scale; the R124 proportionate rings pass their own
 *  scaled stroke through the `strokeWidth` prop (this stays the default). */
export const DONUT_STROKE = 8;

/** The resting opacity of NON-highlighted arcs (the mutual-highlight dim). */
export const DONUT_DIM_OPACITY = 0.35;

// ── the pure math (exported + table-tested) ─────────────────────────────────

/** One ring input: what the caller knows about a model (hue pre-resolved). */
export interface DonutSegment {
  label: string;
  value: number;
  hue: string;
}

/** One rendered arc — the PC's segment math, materialized. */
export interface DonutArc {
  label: string;
  hue: string;
  value: number;
  /** Share of the ring, 0..1 (0 when the total is ≤ 0 or the value isn't usable). */
  share: number;
  /** Cumulative share BEFORE this arc (0..1) — the rotation's offset. */
  start: number;
  /** The arc's stroke-dash length: circumference × share. */
  dash: number;
  /** The SVG rotation that parks the arc's start at 12 o'clock: −90° + start × 360°. */
  rotation: number;
}

/**
 * Each value's share of the total — the honest ring denominator is the WHOLE
 * model list (the PC passes every model, never a top-slice), so a share is
 * "of the window's tokens", not "of the top 6". Non-finite and non-positive
 * values contribute nothing (guarded, never NaN).
 */
export function donutShares(values: number[]): number[] {
  const clean = values.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  const total = clean.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return clean.map(() => 0);
  return clean.map((value) => value / total);
}

/**
 * The PC's ModelDonut math: share per segment, `start` accumulating before
 * each arc, `dash` = the arc's length on THIS circumference, and the rotation
 * that puts rank 0's start at 12 o'clock (SVG circles begin at 3 o'clock).
 */
export function donutSegments(segments: DonutSegment[], circumference: number): DonutArc[] {
  const shares = donutShares(segments.map((segment) => segment.value));
  let start = 0;
  return segments.map((segment, index) => {
    const share = shares[index] ?? 0;
    const arc: DonutArc = {
      label: segment.label,
      hue: segment.hue,
      value: segment.value,
      share,
      start,
      dash: circumference * share,
      rotation: -90 + start * 360,
    };
    start += share;
    return arc;
  });
}

/**
 * "z-ai/glm-5.2:free" → "glm-5.2" — the PC usage-helpers port: the tail
 * after the last "/" minus the ":variant", falling back to the full name
 * when either cut leaves nothing (the donut center's headline is tight).
 */
export function shortModelName(name: string): string {
  const tail = name.split("/").pop() ?? name;
  const beforeVariant = tail.split(":")[0];
  return beforeVariant.trim() !== "" ? beforeVariant : name;
}

// ── the component ───────────────────────────────────────────────────────────

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

function DonutArcView({
  arc,
  circumference,
  radius,
  size,
  strokeWidth,
  active,
  progress,
}: {
  arc: DonutArc;
  circumference: number;
  radius: number;
  size: number;
  strokeWidth: number;
  active: boolean;
  progress: SharedValue<number>;
}) {
  const reduced = useReducedMotion();
  // The mutual-highlight leg: 1 when lit, DONUT_DIM_OPACITY when dimmed.
  const opacity = useSharedValue(active ? 1 : DONUT_DIM_OPACITY);

  // Layout effect: the spring starts BEFORE the next paint, so a highlight
  // flip can never flash the static (resting) opacity for a frame.
  useLayoutEffect(() => {
    const target = active ? 1 : DONUT_DIM_OPACITY;
    if (reduced) {
      opacity.value = target;
      return;
    }
    opacity.value = withSpring(target, SPRING);
  }, [active, reduced, opacity]);

  const animatedProps = useAnimatedProps(() => ({
    // The sweep: offset dash → 0 grows the visible arc from its start.
    strokeDashoffset: arc.dash * (1 - progress.value),
    opacity: opacity.value,
  }));

  return (
    <AnimatedCircle
      cx={size / 2}
      cy={size / 2}
      r={radius}
      fill="none"
      stroke={arc.hue}
      strokeWidth={strokeWidth}
      strokeDasharray={`${arc.dash} ${circumference}`}
      strokeDashoffset={0}
      transform={`rotate(${arc.rotation.toFixed(3)} ${size / 2} ${size / 2})`}
      opacity={active ? 1 : DONUT_DIM_OPACITY}
      animatedProps={animatedProps}
    />
  );
}

export interface DonutChartProps {
  /** The models to ring — order = rank (the caller sorts; hue by that rank). */
  segments: DonutSegment[];
  /** Ring diameter (px) — default 120, PC parity. The R120-S full-card-width
   *  stretch is RETIRED by R124: the dashboard now passes a PROPORTIONATE
   *  size and composes the ranked legend beside the ring (one row — no dead
   *  side bands, no wire-thin hoop). */
  size?: number;
  /** The ring's stroke width (px) — default 8 (DONUT_STROKE, the 120px-era
   *  PC-parity default). R124: proportionate rings pass a scaled stroke
   *  (~11% of the diameter, clamped 12–18) so a 140–170dp ring reads as a
   *  SOLID chart, not a wireframe. */
  strokeWidth?: number;
  /**
   * The dataset's identity — the sweep re-triggers whenever it changes (once
   * per data load; window switches and reloads change it, identical refreshes
   * don't). The caller derives it from its own loaded data.
   */
  dataKey: string;
  /** The highlighted segment's index (a legend row's rank), or null for none. */
  highlighted?: number | null;
  /** The quiet track color — the caller's tokens (this module is theme-free). */
  trackColor: string;
  /** The center slot — the top model + its share (the caller renders it). */
  center?: ReactNode;
  accessibilityLabel?: string;
  testID?: string;
}

export function DonutChart({
  segments,
  size = 120,
  strokeWidth = DONUT_STROKE,
  dataKey,
  highlighted = null,
  trackColor,
  center,
  accessibilityLabel,
  testID,
}: DonutChartProps) {
  const reduced = useReducedMotion();
  const progress = useSharedValue(0);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const arcs = useMemo(
    () => donutSegments(segments, circumference),
    [segments, circumference],
  );

  // §4.6 — the sweep, once per data load (the dataKey IS the load identity).
  // Layout effect: the reset-to-0 lands before the next paint, so a reloaded
  // dataset can never flash its static (full) arcs for a frame.
  useLayoutEffect(() => {
    if (reduced) {
      progress.value = 1;
      return;
    }
    progress.value = 0;
    progress.value = withTiming(1, {
      duration: DONUT_SWEEP_MS,
      easing: Easing.inOut(Easing.sin),
    });
  }, [dataKey, reduced, progress]);

  return (
    <View
      testID={testID}
      style={{ width: size, height: size }}
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
    >
      <Svg width={size} height={size}>
        {/* The quiet track — the ring the arcs sweep over. */}
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={trackColor}
          strokeWidth={strokeWidth}
        />
        {arcs.map((arc, index) =>
          arc.share > 0 ? (
            <DonutArcView
              key={arc.label}
              arc={arc}
              circumference={circumference}
              radius={radius}
              size={size}
              strokeWidth={strokeWidth}
              active={highlighted === null || highlighted === index}
              progress={progress}
            />
          ) : null,
        )}
      </Svg>
      {center !== undefined ? (
        <View style={styles.center} pointerEvents="none">
          {center}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
});
