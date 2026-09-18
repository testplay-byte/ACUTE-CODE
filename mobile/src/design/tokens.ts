/**
 * The design tokens — the "quiet instrument" foundation (R1 §6).
 *
 * THE THEME TABLE is ported 1:1 from the desktop's src/lib/themes.ts
 * (verified against a19a144, R106-S4a): every hex token, all five themes,
 * light + dark variants. The desktop is the single source of truth for
 * palette identity; the phone never invents a color the desktop doesn't
 * know. ADDING A THEME = appending one object literal to THEMES below.
 *
 * The rest of the system: the 8-pt spacing grid, the 15/13/11pt grotesque
 * type ladder (system font stack — San Francisco / Roboto grotesques, no
 * font files to license or load), the JetBrains-Mono-class monospace for
 * commands/tool output, 12px-radius soft cards, hairline borders, and
 * NO shadows anywhere (the flat token aesthetic the desktop carries).
 */

import { Platform } from "react-native";

// ── the theme table (1:1 with src/lib/themes.ts) ────────────────────────────

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

export function getTheme(themeId: string): ThemeColors {
  return THEMES.find((t) => t.id === themeId) ?? THEMES[0];
}

// ── derived palette (the desktop's deriveThemeStyles, mobile-shaped) ─────────

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
 * The pressed-surface color — the "8% bg tint" of the quiet instrument's
 * press state (R1 §6): 8% toward white in dark mode, 8% toward black in
 * light mode. Flat and quiet; NO ripple, NO elevation.
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
 * The resolved, mode-aware palette every screen consumes. Flat by decree:
 * hairlines and tints only — the shadow keys of the desktop's ThemeStyles
 * are deliberately NOT ported ("no shadows" is the phone's own language).
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
  // The fixed semantic hues (the desktop's single documented exception set)
  danger: string;
  success: string;
  warning: string;
  running: string;
}

export function resolveTheme(themeId: string, isDark: boolean): ResolvedTheme {
  const theme = getTheme(themeId);
  const accent = isDark ? theme.accentDark ?? theme.accent : theme.accent;
  return {
    theme,
    isDark,
    bg: isDark ? theme.bgDark : theme.bgLight,
    card: isDark ? theme.cardDark : theme.cardLight,
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
    textSecondary: isDark ? "rgba(255,255,255,0.60)" : "rgba(0,0,0,0.60)",
    textTertiary: isDark ? "rgba(255,255,255,0.40)" : "rgba(0,0,0,0.40)",
    selectedBg: theme.selectedBg,
    selectedText: theme.selectedText,
    pillBg: isDark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.06)",
    pillText: isDark ? theme.textDark : theme.textLight,
    // The fixed semantic hues — 1:1 with the desktop's SEMANTIC_COLORS leg.
    danger: "#ef4444",
    success: "#22c55e",
    warning: "#f59e0b",
    running: "#3b82f6",
  };
}

// ── the 8-pt spacing grid ───────────────────────────────────────────────────

export const spacing = {
  /** 4 — the half-step compact rows use. */
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

// ── the type ladder (grotesque system stack + mono for machine text) ────────

/**
 * The grotesque ladder rides the SYSTEM stack — San Francisco on iOS,
 * Roboto on Android — the same "Inter-class grotesque" reading the desktop
 * has, with zero font files to license, bundle, or load. Machine text
 * (commands, tool output, fingerprints, PINs) is the platform mono.
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

/** 15pt / 600 — titles and the host card's machine name. */
export const TYPE_TITLE = 15;
/** 13pt / 400 — body and list rows. */
export const TYPE_BODY = 13;
/** 11pt / 400 — captions, status lines, metadata. */
export const TYPE_CAPTION = 11;

// ── radii + hairlines ────────────────────────────────────────────────────────

/** Soft cards: 12 (the desktop's 12px-radius soft-card language). */
export const RADIUS_CARD = 12;
/** Small pills and badges: 8. */
export const RADIUS_PILL = 8;
/** Round dots + the scan overlay's corner brackets. */
export const RADIUS_ROUND = 999;
