/**
 * The design tokens — the CLAY STUDIO + LIQUID CHROME foundation (R109).
 *
 * The contract lives in mobile/DESIGN.md; this file is its implementation.
 * Clay is the SUBSTRATE (warm sand surfaces, generous radii, two-leg warm
 * shadows, a matte top-edge highlight); chrome is rationed JEWELRY (the
 * floating bar's edge, primary CTAs' quiet sheen, selected markers' ring).
 * The R108-e lesson carries over: NO painted glow, NO gradient washes on
 * resting surfaces, NO cold blue-black shadows.
 *
 * THE THEME TABLE stays 1:1-shaped with the desktop's src/lib/themes.ts —
 * Clay Studio is now FIRST (the mobile default, the owner's R109 direction,
 * palette carried verbatim from the desktop's §1b so both ends read as one
 * household). ADDING A THEME = appending one object literal to THEMES.
 */

import { Platform } from "react-native";

// ── the theme table ─────────────────────────────────────────────────────────

export interface ThemeColors {
  id: string;
  name: string;
  accent: string;
  /**
   * Accent for DARK mode. Optional — themes whose accent stays legible on a
   * dark background omit it (Mono Stone's #111111 disappears against
   * #242426; the dark-mode accent must keep ~4.5:1 against bgDark).
   */
  accentDark?: string;
  accent2: string;
  bgLight: string;
  bgDark: string;
  cardLight: string;
  cardDark: string;
  textLight: string;
  textDark: string;
  dot: string;
  dotDark: string;
  /** Light-mode palette colors for the theme preview strip. */
  paletteLight: string[];
  /** Dark-mode palette colors for the theme preview strip. */
  paletteDark: string[];
  selectedBg: string;
  selectedText: string;
  unselectedBg: string;
  unselectedBorder: string;
  blockBg: string;
  blockBorder: string;
  sidebarBg: string;
  sidebarBorder: string;
}

export const THEMES: ThemeColors[] = [
  {
    // ROUND-109: the Clay Studio substrate — THE mobile default. Palette
    // verbatim from the desktop's tokens §1b: warm sand neutrals, warm ink,
    // a muted terracotta accent (never a blue-black, never a cold gray).
    // ROUND-114-c: the LIGHT whites cooled one step at the owner's ask ("a
    // slightly colder tone of white") — bg #F4EEE5→#F3F4F0, card #FDFBF7→
    // #FDFDFB — a whisper of warmth survives (never a flat gray); DARK
    // surfaces stay as-is.
    id: "clay",
    name: "Clay Studio",
    accent: "#C4653F",
    accent2: "#8A6A55",
    bgLight: "#F3F4F0",
    bgDark: "#26211C",
    cardLight: "#FDFDFB",
    cardDark: "#2F2924",
    textLight: "#2A2018",
    textDark: "#F2EBE1",
    dot: "#C4653F",
    dotDark: "#D98A63",
    paletteLight: ["#C4653F", "#8A6A55", "#F3F4F0", "#FDFDFB", "#2A2018"],
    paletteDark: ["#D98A63", "#B09380", "#26211C", "#2F2924", "#F2EBE1"],
    selectedBg: "#C4653F",
    selectedText: "#FFFFFF",
    unselectedBg: "#EFE7DB",
    unselectedBorder: "#E0D3C2",
    blockBg: "#F8F4EC",
    blockBorder: "#E8DFD0",
    sidebarBg: "#F1EAE0",
    sidebarBorder: "#E3D8C8",
  },
  {
    id: "nova",
    name: "Nova Cream",
    accent: "#FF6B2C",
    accent2: "#FFD9C0",
    bgLight: "#FFFBF0",
    bgDark: "#242426",
    cardLight: "#FFFFFF",
    cardDark: "#2C2C2E",
    textLight: "#111111",
    textDark: "#FFFBF0",
    dot: "#FF6B2C",
    dotDark: "#FF8F55",
    paletteLight: ["#FF6B2C", "#FFD9C0", "#FFFBF0", "#FFFFFF", "#111111"],
    paletteDark: ["#FF6B2C", "#FF8F55", "#242426", "#2C2C2E", "#FFFBF0"],
    selectedBg: "#FF6B2C",
    selectedText: "#FFFFFF",
    unselectedBg: "#FFF3EB",
    unselectedBorder: "#FFD4BC",
    blockBg: "#FFFFFF",
    blockBorder: "#F0E0D0",
    sidebarBg: "#FFF7EE",
    sidebarBorder: "#FFE8D4",
  },
  {
    id: "bento",
    name: "Bento Blue",
    accent: "#6366F1",
    accent2: "#A5B4FF",
    bgLight: "#EFF4FF",
    bgDark: "#222838",
    cardLight: "#FFFFFF",
    cardDark: "#2A2E3E",
    textLight: "#121214",
    textDark: "#EFF4FF",
    dot: "#6366F1",
    dotDark: "#818CF8",
    paletteLight: ["#6366F1", "#A5B4FF", "#EFF4FF", "#FFFFFF", "#121214"],
    paletteDark: ["#6366F1", "#818CF8", "#222838", "#2A2E3E", "#EFF4FF"],
    selectedBg: "#6366F1",
    selectedText: "#FFFFFF",
    unselectedBg: "#E8EDFF",
    unselectedBorder: "#C7D0FE",
    blockBg: "#FFFFFF",
    blockBorder: "#D4DBFF",
    sidebarBg: "#EBF0FF",
    sidebarBorder: "#CDD6FF",
  },
  {
    id: "midnight",
    name: "Midnight Lab",
    accent: "#D6FF57",
    accent2: "#B8F02A",
    bgLight: "#F2F3E8",
    bgDark: "#222224",
    cardLight: "#FFFFFF",
    cardDark: "#2A2A2C",
    textLight: "#121214",
    textDark: "#F2F3E8",
    dot: "#D6FF57",
    dotDark: "#D6FF57",
    paletteLight: ["#D6FF57", "#B8F02A", "#F2F3E8", "#FFFFFF", "#121214"],
    paletteDark: ["#D6FF57", "#B8F02A", "#222224", "#2A2A2C", "#F2F3E8"],
    selectedBg: "#D6FF57",
    selectedText: "#111111",
    unselectedBg: "#F0F1E6",
    unselectedBorder: "#DDE0CC",
    blockBg: "#FAFBF2",
    blockBorder: "#E2E4D0",
    sidebarBg: "#EEF0E2",
    sidebarBorder: "#D8DAC8",
  },
  {
    id: "sunset",
    name: "Sunset Pop",
    accent: "#FF7A3D",
    accent2: "#FFB88A",
    bgLight: "#FFF0E6",
    bgDark: "#2A2018",
    cardLight: "#FFFFFF",
    cardDark: "#322218",
    textLight: "#121214",
    textDark: "#FFF0E6",
    dot: "#FF7A3D",
    dotDark: "#FF9A6D",
    paletteLight: ["#FF7A3D", "#FFB88A", "#FFF0E6", "#FFFFFF", "#121214"],
    paletteDark: ["#FF7A3D", "#FF9A6D", "#2A2018", "#322218", "#FFF0E6"],
    selectedBg: "#FF7A3D",
    selectedText: "#FFFFFF",
    unselectedBg: "#FFE8DA",
    unselectedBorder: "#FFD0B5",
    blockBg: "#FFFFFF",
    blockBorder: "#F5DDD0",
    sidebarBg: "#FFEDE0",
    sidebarBorder: "#FFDBC8",
  },
  {
    id: "mono",
    name: "Mono Stone",
    accent: "#111111",
    accentDark: "#E0E0E0",
    accent2: "#A0A0A0",
    bgLight: "#F5F5F0",
    bgDark: "#242426",
    cardLight: "#FFFFFF",
    cardDark: "#2C2C2E",
    textLight: "#111111",
    textDark: "#F5F5F0",
    dot: "#111111",
    dotDark: "#E0E0E0",
    paletteLight: ["#111111", "#A0A0A0", "#F5F5F0", "#FFFFFF", "#111111"],
    paletteDark: ["#E0E0E0", "#A0A0A0", "#242426", "#2C2C2E", "#F5F5F0"],
    selectedBg: "#111111",
    selectedText: "#FFFFFF",
    unselectedBg: "#EEEEEA",
    unselectedBorder: "#D5D5D0",
    blockBg: "#FAFAF7",
    blockBorder: "#E0E0DB",
    sidebarBg: "#F0F0EB",
    sidebarBorder: "#DDDDE0",
  },
];

/** The mobile default — Clay Studio (R109, the owner's direction). */
export const DEFAULT_THEME_ID = "clay";

export function getTheme(themeId: string): ThemeColors {
  return THEMES.find((t) => t.id === themeId) ?? THEMES[0];
}

// ── derived palette ──────────────────────────────────────────────────────────

/** Pure-hex parse for luminance math (tokens are always #rrggbb). */
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Linear-interpolate two hex colors, round-30 with the desktop's exact
 * spelling (src/lib/themes.ts mixHex) — the press-tint math below and any
 * future derived surface use this so both ends mix identically.
 */
export function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1).toUpperCase()}`;
}

/**
 * The pressed-surface color — 8% toward white in dark mode, 8% toward
 * black in light mode (the quiet press state, unchanged).
 */
export function pressTint(surface: string, isDark: boolean): string {
  return mixHex(surface, isDark ? "#FFFFFF" : "#000000", 0.08);
}

/** Black or white — for text sitting on accent/selected fills. */
export function getContrastText(color: string): string {
  const [r, g, b] = hexToRgb(color);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? "#111111" : "#FFFFFF";
}

/**
 * The resolved, mode-aware palette every screen consumes — now carrying the
 * CLAY MATERIAL (DESIGN.md §1): the two-leg warm shadows, the matte
 * top-edge highlight, and the mono (code) surfaces.
 */
export interface ResolvedTheme {
  /** The raw theme tokens (for palette strips, identity). */
  theme: ThemeColors;
  isDark: boolean;
  // Core
  bg: string;
  card: string;
  text: string;
  accent: string;
  accentText: string;
  accent2: string;
  // Borders (hairlines render at StyleSheet.hairlineWidth)
  border: string;
  borderStrong: string;
  borderSubtle: string;
  // Subtle fills
  subtle: string;
  subtleHover: string;
  // Inputs
  inputBg: string;
  inputBorder: string;
  inputFocusBorder: string;
  // Text helpers
  textSecondary: string;
  textTertiary: string;
  // Selected / pill surfaces
  selectedBg: string;
  selectedText: string;
  pillBg: string;
  pillText: string;
  // The clay material (DESIGN.md §1)
  /** Elevation-1 two-leg clay shadow (list cards). */
  clayShadow1: string;
  /** Elevation-2 two-leg clay shadow (the floating bar, heroes). */
  clayShadow2: string;
  /** The small-surface step (chips, compact tiles). */
  clayShadowSm: string;
  /** The tight leg alone — the pressed state's collapsed shadow. */
  clayShadowPressed: string;
  /** The matte 1px top-edge highlight color for cards (molded, never glow). */
  clayTopEdge: string;
  /** A slightly raised surface between bg and card (list wells, sheets). */
  surfaceRaised: string;
  // Mono / code surfaces (the machine-text family)
  monoBg: string;
  monoBorder: string;
  monoText: string;
  // Chrome jewelry colors (DESIGN.md §2) — the gradient stops
  chromeEdgeLight: string;
  chromeEdgeDark: string;
  sheenTop: string;
  sheenBottom: string;
  // The fixed semantic hues (the desktop's single documented exception set)
  danger: string;
  success: string;
  warning: string;
  running: string;
}

export function resolveTheme(themeId: string, isDark: boolean): ResolvedTheme {
  const theme = getTheme(themeId);
  const accent = isDark ? theme.accentDark ?? theme.accent : theme.accent;
  const card = isDark ? theme.cardDark : theme.cardLight;
  // The clay ink family: warm in light mode (ceramics cast warm shadows —
  // R114-c cools it a half-step to rgba(38,34,28) so the warm cast never
  // reads ORANGE against the colder #F3F4F0 white; still warm family,
  // never the forbidden cold blue-black), deepened toward black in dark
  // mode. Theme-independent, mode-aware — the desktop's R108-e grammar.
  const inkWarm = isDark ? "rgba(0,0,0," : "rgba(38,34,28,";
  return {
    theme,
    isDark,
    bg: isDark ? theme.bgDark : theme.bgLight,
    card,
    text: isDark ? theme.textDark : theme.textLight,
    accent,
    accentText: getContrastText(accent),
    accent2: theme.accent2,
    border: isDark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.10)",
    borderStrong: isDark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.18)",
    borderSubtle: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
    subtle: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)",
    subtleHover: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)",
    inputBg: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.02)",
    inputBorder: isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.10)",
    inputFocusBorder: isDark ? "rgba(255,255,255,0.30)" : "rgba(0,0,0,0.90)",
    textSecondary: isDark ? "rgba(255,255,255,0.62)" : "rgba(0,0,0,0.62)",
    textTertiary: isDark ? "rgba(255,255,255,0.40)" : "rgba(0,0,0,0.40)",
    selectedBg: theme.selectedBg,
    selectedText: theme.selectedText,
    pillBg: isDark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.06)",
    pillText: isDark ? theme.textDark : theme.textLight,
    // ── the clay material (two-leg: tight contact + large soft ambient) ──
    clayShadow1: `0px 1px 3px ${inkWarm}0.08), 0px 8px 24px -6px ${inkWarm}0.10)`,
    clayShadow2: `0px 2px 6px ${inkWarm}0.10), 0px 16px 40px -8px ${inkWarm}0.14)`,
    clayShadowSm: `0px 1px 2px ${inkWarm}0.08), 0px 4px 12px -4px ${inkWarm}0.08)`,
    clayShadowPressed: `0px 1px 3px ${inkWarm}0.10)`,
    clayTopEdge: isDark
      ? mixHex(card, "#FFFFFF", 0.06)
      : mixHex(card, "#FFFFFF", 0.55),
    surfaceRaised: isDark ? mixHex(card, "#FFFFFF", 0.02) : mixHex(card, "#000000", 0.02),
    // ── mono surfaces ──
    monoBg: isDark ? "rgba(0,0,0,0.22)" : mixHex(card, "#2A2018", 0.04),
    monoBorder: isDark ? "rgba(255,255,255,0.08)" : "rgba(42,32,24,0.10)",
    monoText: isDark ? "rgba(242,235,225,0.92)" : "#3A2E22",
    // ── chrome jewelry stops (the metal ramp + the CTA sheen) ──
    chromeEdgeLight: isDark ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.85)",
    chromeEdgeDark: isDark ? "rgba(255,255,255,0.04)" : "rgba(42,32,24,0.10)",
    sheenTop: isDark ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.42)",
    sheenBottom: "rgba(255,255,255,0.00)",
    // The fixed semantic hues — 1:1 with the desktop's SEMANTIC_COLORS leg.
    danger: "#ef4444",
    success: "#22c55e",
    warning: "#f59e0b",
    running: "#3b82f6",
  };
}

// ── the chart palette (R114-c: the color-coded dashboard) ─────────────────

/**
 * The fixed DATA-VIZ hue set — the dashboard's documented exception to
 * "one accent per screen" (DESIGN.md's semantic-hue family, extended for
 * charts). Muted, clay-compatible, NEVER neon; every hue carries a dark
 * variant tuned for ~4.5:1-ish reads against #26211C. Color rides on BARS,
 * DOTS, and ICON CHIPS only — resting surfaces stay card-colored.
 */
export interface ChartHue {
  light: string;
  dark: string;
}

export const CHART_HUES = {
  /** Input tokens — the theme accent terracotta (the dominant mass). */
  input: { light: "#C4653F", dark: "#D98A63" },
  /** Output tokens — a cool sage teal, the in/out contrast hue. */
  output: { light: "#6F9E90", dark: "#8FBFAD" },
  /** The peak-day tile's violet-ish 4th stat hue. */
  peak: { light: "#7C6A9E", dark: "#9C8CC2" },
  /** Per-model leaderboard hues, assigned BY RANK (rank 0 = first).
   *
   *  R116-n — DEAD (tombstoned, not deleted): zero consumers since R116-g
   *  moved every model surface to the PC's 12-hue NAME-HASH palette
   *  (src/design/model-colors.ts — one spelling across the dashboard,
   *  the per-model cards, and the providers list). Only modelHue() (below,
   *  equally dead) reads this array. A future wave that owns tokens.ts
   *  may delete both; nothing else references them. */
  models: [
    { light: "#C4653F", dark: "#D98A63" }, // 1 — terracotta
    { light: "#6F9E90", dark: "#8FBFAD" }, // 2 — sage teal
    { light: "#B08A3C", dark: "#C9A45C" }, // 3 — muted ochre
    { light: "#6B7F9E", dark: "#8FA3C2" }, // 4 — slate
    { light: "#8A6A8E", dark: "#A98FB0" }, // 5 — plum
    { light: "#8A6A55", dark: "#B09380" }, // 6 — taupe (clay accent2)
  ] as ReadonlyArray<ChartHue>,
} as const;

/** Resolve one chart hue against the mode (pure). */
export function chartHue(hue: ChartHue, isDark: boolean): string {
  return isDark ? hue.dark : hue.light;
}

/** The model leaderboard's rank hue (rank 0 = the busiest model).
 *
 *  R116-n — DEAD (tombstoned, not deleted): superseded by
 *  `modelColor(name, isDark)` in src/design/model-colors.ts (R116-g — the
 *  PC's stable name-hash palette; rank hues made the same model change
 *  color with its ranking). Zero callers remain; kept only because this
 *  file is shared and a tokens-owning wave should do the deletion. */
export function modelHue(rank: number, isDark: boolean): string {
  const hue = CHART_HUES.models[rank % CHART_HUES.models.length];
  return isDark ? hue.dark : hue.light;
}

// ── the 8-pt spacing grid ───────────────────────────────────────────────────

export const spacing = {
  /** 4 — the half-step compact rows use. */
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 48,
} as const;

// ── the house fonts — Manrope (bundled) + JetBrains Mono ───────────────────

/**
 * DESIGN.md §4: Manrope is the house font — geometric, softly-rounded
 * terminals, the typographic voice of molded clay. Weights 400–800 bundle
 * as expo-google-fonts; JetBrains Mono carries settled code blocks. The
 * provider loads them BEFORE first paint (theme.tsx useFonts gate).
 */
export const fontFamily = {
  regular: "Manrope_400Regular",
  medium: "Manrope_500Medium",
  semibold: "Manrope_600SemiBold",
  bold: "Manrope_700Bold",
  extrabold: "Manrope_800ExtraBold",
  mono: "JetBrainsMono_400Regular",
  monoMedium: "JetBrainsMono_500Medium",
  /** The platform fallbacks (used by the crash boundary, outside the provider). */
  systemSans: Platform.select<"system-ui" | "normal">({
    ios: "system-ui",
    default: "normal",
  }),
  systemMono: Platform.select<"ui-monospace" | "monospace">({
    ios: "ui-monospace",
    default: "monospace",
  }),
} as const;

// ── the type ladder (DESIGN.md §4) ──────────────────────────────────────────

/** 28 / 800 — display: the large titles (home hero, wizard headlines). */
export const TYPE_DISPLAY = 28;
/** 20 / 700 — title: pushed screens' compact headers. */
export const TYPE_TITLE = 20;
/** 16 / 700 — heading: section headers on scrolling screens. */
export const TYPE_HEADING = 16;
/** 15 / 400 — body: list rows, paragraphs, transcript prose. */
export const TYPE_BODY = 15;
/** 12.5 / 500 — captions, status lines, metadata. */
export const TYPE_CAPTION = 12.5;
/** 11 / 600 — micro: badges, labels, uppercase kickers. */
export const TYPE_MICRO = 11;
/** 13 / 400 mono — commands, tool output, fingerprints, PINs. */
export const TYPE_MONO = 13;
/**
 * 26 / mono-medium — the confirm screen's big grouped pairing PIN (the ONE
 * value-tier display size; onboarding.md "Confirm the host", R115-D).
 */
export const TYPE_PIN_DISPLAY = 26;

// ── radii (DESIGN.md §1) ─────────────────────────────────────────────────────

/** Cards: 20 — the generous clay radius. */
export const RADIUS_CARD = 20;
/** Tiles (hero blocks, stat tiles): 24. */
export const RADIUS_TILE = 24;
/** The floating tab bar: 28. */
export const RADIUS_BAR = 28;
/** Inputs: 14. */
export const RADIUS_INPUT = 14;
/** Small pills and badges: 8. */
export const RADIUS_PILL = 8;
/** Round dots + circular avatars/CTAs. */
export const RADIUS_ROUND = 999;

/**
 * COMPAT alias (pre-R109 components still reference fontStack while they're
 * migrated to the Manrope ladder — removed once the last consumer is gone).
 */
export const fontStack = {
  sans: Platform.select<"system-ui" | "normal">({
    ios: "system-ui",
    default: "normal",
  }),
  mono: Platform.select<"ui-monospace" | "monospace">({
    ios: "ui-monospace",
    default: "monospace",
  }),
};

// ── tile + chip geometry (R115: the wizard / connection option grammar) ────

/** The welcome hero's logo tile — 76 (the top of the archetype's 72–76 range). */
export const TILE_HERO = 76;
/** The compact hero tile (the camera-ask screen) — the archetype's 72. */
export const TILE_HERO_COMPACT = 72;
/** The pair-option row's icon chip — 48 (pair-options.tsx). */
export const TILE_OPTION = 48;
/** The welcome feature row's identity chip — 40. */
export const TILE_ROW = 40;
/** The 48px option chip's corner radius — 16. */
export const RADIUS_CHIP = 16;

// ── touch + layout constants (DESIGN.md §5) ────────────────────────────────

/** Every interactive element's minimum hit target. */
export const TOUCH_TARGET = 44;
/** The floating tab bar's side margins (DESIGN.md §5). */
export const BAR_MARGIN = 12;
/** The floating tab bar's height (content row, excluding insets). */
export const BAR_HEIGHT = 60;
