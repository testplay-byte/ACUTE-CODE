/**
 * CapabilityIcon — the model capability icon set (R120-M, round-120 §1
 * item 18 — the owner's ruling: "The input/output capabilities: actual
 * color-coded SVG icons (not text), laid out on a single line"): a small
 * inline SVG vocabulary drawn with react-native-svg (the dependency the
 * app already ships — no new package), ONE glyph per capability:
 *
 *   text (T-bar) · vision (eye) · audio (wave bars) · video (camera)
 *   pdf (document) · image (picture) · tools (wrench) · reasoning (spark)
 *
 * Each glyph is a 24×24 stroke drawing (strokeWidth 1.8, round joins —
 * the lucide house weight at small sizes) that takes its COLOR from the
 * caller: the capability rows color-code through capabilityHue (one hue
 * per capability, resolved off the theme's own token hues — never a
 * hardcoded color), so the icon set itself stays hue-agnostic.
 *
 * Pure seams exported for the jest pins: CAPABILITY_KINDS /
 * capabilityHue(kind, tokens) / CAPABILITY_ICON_SIZE — no React Native
 * import in those helpers' graph (type-only tokens import).
 */

import Svg, { Circle, Path } from "react-native-svg";
import type { ResolvedTheme } from "@/design/tokens";

/** The capability glyph vocabulary (the editor's rows + the fetch summary). */
export const CAPABILITY_KINDS = [
  "text",
  "vision",
  "audio",
  "video",
  "pdf",
  "image",
  "tools",
  "reasoning",
] as const;

export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

/** The glyph edge — stroke drawings at 13–16px read best at this weight. */
export const CAPABILITY_ICON_STROKE = 1.8;
/** The inline row's glyph size (the pills carry 13px icons + 11px labels). */
export const CAPABILITY_ICON_SIZE = 13;

/**
 * The COLOR CODING (the owner's word): each capability reads in its own
 * hue, resolved off the theme's EXISTING token hues (donts #12 — no
 * hardcoded colors; the one-accent law governs selection chrome, not a
 * per-capability identity vocabulary). Within any one row the hues are
 * distinct (text·vision·video·pdf·audio = neutral·ember·amber·secondary·
 * green), which is where the coding has to discriminate.
 */
export function capabilityHue(kind: CapabilityKind, tokens: ResolvedTheme): string {
  switch (kind) {
    case "text":
      return tokens.textSecondary;
    case "vision":
      return tokens.accentDeep;
    case "audio":
      return tokens.successDeep;
    case "video":
      return tokens.warningDeep;
    case "pdf":
      return tokens.accent2;
    case "image":
      return tokens.accent2;
    case "tools":
      return tokens.accentDeep;
    case "reasoning":
      return tokens.warningDeep;
  }
}

/** One glyph's drawing (stroke paths in the shared 24×24 box). */
const CAPABILITY_PATHS: Record<CapabilityKind, { paths: string[]; circles: Array<[number, number, number]> }> = {
  // The T-bar: a text run's own shape.
  text: {
    paths: ["M5 7V5h14v2", "M12 5v14", "M9 19h6"],
    circles: [],
  },
  // The eye: the classic almond + pupil.
  vision: {
    paths: ["M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"],
    circles: [[12, 12, 3]],
  },
  // The wave: an audio meter's bars.
  audio: {
    paths: ["M4 10v4", "M8 7v10", "M12 4.5v15", "M16 7v10", "M20 10v4"],
    circles: [],
  },
  // The camera: a body + the lens wedge.
  video: {
    paths: ["M3 7h12v10H3z", "M15 10.5l6-3.5v10l-6-3.5"],
    circles: [],
  },
  // The document: a page with the folded corner + lines.
  pdf: {
    paths: ["M6.5 3h7L18 7.5V21H6.5z", "M13.5 3v4.5H18", "M9 12.5h6", "M9 15.5h4"],
    circles: [],
  },
  // The picture: a frame + sun + the horizon.
  image: {
    paths: ["M3.5 5.5h17v13h-17z", "M4 16.5l4.5-4 3.5 3 3-2.5 5 4"],
    circles: [[8.5, 9.5, 1.5]],
  },
  // The wrench: the agent's tool.
  tools: {
    paths: [
      "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
    ],
    circles: [],
  },
  // The spark: the reasoning/thinking burst.
  reasoning: {
    paths: ["M12 4l1.9 5.6 5.6 1.9-5.6 1.9L12 19l-1.9-5.6-5.6-1.9 5.6-1.9Z"],
    circles: [],
  },
};

/**
 * The glyph: `size` is the square edge; `color` the caller's hue (the
 * capability rows pass capabilityHue's resolution). strokeWidth 1.8 +
 * round caps/joins — the lucide house weight at small sizes.
 */
export interface CapabilityIconProps {
  kind: CapabilityKind;
  /** The square glyph edge (defaults to the inline row's 13). */
  size?: number;
  /** The caller's hue — capabilityHue's resolution off the resolved theme. */
  color: string;
  testID?: string;
}

export function CapabilityIcon({
  kind,
  size = CAPABILITY_ICON_SIZE,
  color,
  testID,
}: CapabilityIconProps) {
  const drawing = CAPABILITY_PATHS[kind];
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" testID={testID}>
      {drawing.paths.map((d, index) => (
        <Path
          key={index}
          d={d}
          stroke={color}
          strokeWidth={CAPABILITY_ICON_STROKE}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {drawing.circles.map(([cx, cy, r], index) => (
        <Circle
          key={`c${index}`}
          cx={cx}
          cy={cy}
          r={r}
          stroke={color}
          strokeWidth={CAPABILITY_ICON_STROKE}
        />
      ))}
    </Svg>
  );
}
