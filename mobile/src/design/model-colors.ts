/**
 * model-colors.ts — R116-g: the MODEL COLOR PALETTE port (round-116 §1.6,
 * verdict #31: "model usage with the EXACT PC colors"). The PC's spelling is
 * src/components/usage/usage-helpers.ts (R98-I2): 12 fixed hue pairs assigned
 * by a STABLE NAME HASH — same model name = same color, on every surface, in
 * every session, in both modes. This module is its byte-identical mobile port
 * (palette values, hash, and resolution semantics copied verbatim), so the
 * phone's model surfaces (donut segments, legend rows, per-model cards,
 * per-project session model dots) finally agree with the desktop's.
 *
 * WHY A NAME HASH, NOT A RANK: the pre-R116 mobile spelling assigned hues BY
 * RANK (tokens.ts modelHue) — the same model changed color whenever the
 * ranking shifted, and never matched the PC. Hue IDENTITY is the data
 * encoding here (this model, that color), which is also why these hex values
 * are a documented fixed-palette exception that CANNOT flow from the theme
 * pipeline: a categorical palette is data, not a surface color.
 *
 * PURE MODULE — no react-native import (the jest suite is pure-logic by
 * convention; the table tests in __tests__/model-colors.test.ts pin the port
 * against the PC's expected indices).
 */

/** One palette slot's mode pair (the PC's {light, dark} spelling). */
export interface ModelColorPair {
  light: string;
  dark: string;
}

/**
 * The 12 fixed hue pairs — copied verbatim from the PC's
 * MODEL_COLOR_PALETTE (usage-helpers.ts). Light/dark variants keep ~10px
 * swatches distinguishable on both card surfaces.
 */
export const MODEL_COLOR_PALETTE: ReadonlyArray<ModelColorPair> = [
  { light: "#2563eb", dark: "#60a5fa" }, // blue
  { light: "#0d9488", dark: "#2dd4bf" }, // teal
  { light: "#7c3aed", dark: "#a78bfa" }, // violet
  { light: "#db2777", dark: "#f472b6" }, // pink
  { light: "#ea580c", dark: "#fb923c" }, // orange
  { light: "#16a34a", dark: "#4ade80" }, // green
  { light: "#ca8a04", dark: "#facc15" }, // yellow
  { light: "#0284c7", dark: "#38bdf8" }, // sky
  { light: "#9333ea", dark: "#c084fc" }, // purple
  { light: "#dc2626", dark: "#f87171" }, // red
  { light: "#475569", dark: "#94a3b8" }, // slate
  { light: "#be185d", dark: "#ec4899" }, // rose
];

/** The palette's length — the hash's modulus (12). */
export const MODEL_PALETTE_SIZE = MODEL_COLOR_PALETTE.length;

/**
 * Deterministic palette slot for a model name — the PC's djb31-style hash,
 * copied VERBATIM (the `| 0` keeps the accumulator a 32-bit int so the
 * multiplication can't drift into float precision; Math.abs handles the
 * negative-overflow case). Same name ⇒ same slot across renders, surfaces,
 * sessions, and both apps.
 */
export function modelPaletteIndex(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % MODEL_PALETTE_SIZE;
}

/**
 * The paintable color for a model name — ONE spelling everywhere. The
 * dashboard's every model surface resolves through this; CHART_HUES stays
 * the palette for input/output/peak (the chart bars' semantic hues).
 */
export function modelColor(name: string, isDark: boolean): string {
  const entry = MODEL_COLOR_PALETTE[modelPaletteIndex(name)];
  return isDark ? entry.dark : entry.light;
}
