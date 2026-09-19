/**
 * The theme table (owner directive, plan-ui-fidelity.md): the single source of
 * truth for every palette in the app. Ported verbatim from the design demo
 * design/demos/acute-agent-ui/acute-agent-ui/lib/onboarding-types.ts.
 *
 * ADDING A THEME = appending one object literal to THEMES below. Nothing else
 * changes: no CSS blocks, no id checks anywhere in the codebase. Derived
 * values (borders, inputs, shadows, contrast text) are computed per mode by
 * deriveThemeStyles() and bridged onto :root CSS custom properties.
 *
 * Seeded with nova + bento copied from the demo; more themes are appended,
 * never hard-coded.
 */

export interface ThemeColors {
  id: string;
  name: string;
  accent: string;
  /**
   * Accent for DARK mode. Optional — themes whose accent stays legible on a
   * dark background omit it. Needed when the light-mode accent is too dark
   * (Mono Stone's #111111 disappears against #242426); the dark-mode accent
   * must keep ~4.5:1 against bgDark for text/icons/charts.
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
  {
    // R107-g (owner: "go with the Clay Studio aesthetic… a mixture of liquid
    // chrome"): the clay substrate theme — hand-thrown-ceramics warmth for the
    // whole app. Muted terracotta accent (the warm family the owner asked for;
    // indigo/blue defaults are banned house-wide), sand neutrals with a
    // brown-tinted charcoal for dark mode (never a blue-black), all inside the
    // contrast envelope the existing five themes already tolerate (measured:
    // accent/bgLight 3.45:1 — above nova 2.75; accentDark/bgDark 5.90:1 — over
    // the ~4.5:1 accent-dark bar; text 12–15:1 both modes). The liquid-chrome
    // counterpoint lives in the --ac-chrome-* ramp (TOKENS §8) — theme-
    // independent jewelry, not part of this table.
    id: "clay",
    name: "Clay Studio",
    accent: "#C4653F",
    accentDark: "#D98A63",
    accent2: "#E3A67F",
    bgLight: "#F4EEE5",
    bgDark: "#26211C",
    cardLight: "#FDFBF7",
    cardDark: "#2F2924",
    textLight: "#2A2018",
    textDark: "#F2EBE1",
    dot: "#C4653F",
    dotDark: "#D98A63",
    paletteLight: ["#C4653F", "#E3A67F", "#F4EEE5", "#FDFBF7", "#2A2018"],
    paletteDark: ["#D98A63", "#C4653F", "#26211C", "#2F2924", "#F2EBE1"],
    selectedBg: "#C4653F",
    selectedText: "#FFFFFF",
    unselectedBg: "#EFE6DA",
    unselectedBorder: "#D9C7B2",
    blockBg: "#FBF8F2",
    blockBorder: "#E6DACA",
    sidebarBg: "#F0E9DE",
    sidebarBorder: "#DFD2C0",
  },
];

/** Placeholder card at the end of the picker ("new themes coming soon"). */
export const COMING_SOON_THEME: ThemeColors = {
  id: "coming-soon",
  name: "New themes coming soon",
  accent: "#C0C0C0",
  accent2: "#E0E0E0",
  bgLight: "#F8F8F8",
  bgDark: "#242426",
  cardLight: "#FFFFFF",
  cardDark: "#2C2C2E",
  textLight: "#999999",
  textDark: "#999999",
  dot: "#C0C0C0",
  dotDark: "#C0C0C0",
  paletteLight: ["#C0C0C0", "#E0E0E0", "#F8F8F8", "#FFFFFF", "#999999"],
  paletteDark: ["#C0C0C0", "#E0E0E0", "#242426", "#2C2C2E", "#999999"],
  selectedBg: "#C0C0C0",
  selectedText: "#FFFFFF",
  unselectedBg: "#F0F0F0",
  unselectedBorder: "#DDDDDD",
  blockBg: "#F5F5F5",
  blockBorder: "#E0E0E0",
  sidebarBg: "#FAFAFA",
  sidebarBorder: "#EEEEEE",
};

export function getTheme(themeId: string): ThemeColors {
  return THEMES.find((t) => t.id === themeId) ?? THEMES[0];
}

// ---------------------------------------------------------------------------
// Color utilities (ported from the demo's lib/color-utils.ts)
// ---------------------------------------------------------------------------

/** Parse any CSS color to [r, g, b] (0-255) via canvas; hex/named both work. */
const colorCache = new Map<string, [number, number, number]>();
let canvasCtx: CanvasRenderingContext2D | null = null;

function parseColor(color: string): [number, number, number] {
  const cached = colorCache.get(color);
  if (cached) return cached;

  if (typeof document === "undefined") {
    // Non-DOM fallback (tests): hex only.
    const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
    if (!m) return [0, 0, 0];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  if (!canvasCtx) {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    canvasCtx = c.getContext("2d");
  }
  if (!canvasCtx) return [0, 0, 0];
  canvasCtx.fillStyle = color;
  canvasCtx.fillRect(0, 0, 1, 1);
  const [r, g, b] = canvasCtx.getImageData(0, 0, 1, 1).data;
  const result: [number, number, number] = [r, g, b];
  colorCache.set(color, result);
  return result;
}

/**
 * Returns black or white text based on background luminance — used for text
 * sitting on top of accent/themed colors.
 */
export function getContrastText(color: string): string {
  const [r, g, b] = parseColor(color);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? "#111111" : "#FFFFFF";
}

/** Check if a color is considered "light" (high luminance). */
export function isLightColor(color: string): boolean {
  const [r, g, b] = parseColor(color);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55;
}

/**
 * Linear-interpolate two colors (round-30). `t=0` returns `a`, `t=1` returns
 * `b`. Used to derive the distinct sidebar surface from bg + accent so every
 * theme gets a harmonious tint without per-theme hand-picking. Falls back to
 * `a` when either input can't be parsed (non-DOM fallback parses hex only).
 */
export function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseColor(a);
  const [br, bg, bb] = parseColor(b);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Derived style object — the exact key set of the demo's useThemeStyles hook
// (design/demos/acute-agent-ui/acute-agent-ui/lib/use-theme-styles.ts).
// Pure so both the React hook and the pre-paint CSS bridge can use it.
// ---------------------------------------------------------------------------

export interface ThemeStyles {
  theme: ThemeColors;
  isDark: boolean;
  isMono: boolean;
  // Core
  bg: string;
  card: string;
  text: string;
  accent: string;
  accentText: string;
  // Round-30: distinct sidebar surface (owner: "give the sidebar a different
  // kind of color and try to make it separate from the other elements").
  // Derived from the theme accent so EVERY theme gets a harmonious but
  // clearly-different sidebar without per-theme hand-picking.
  sidebarBg: string;
  sidebarBorder: string;
  sidebarHover: string;
  // Borders
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
  // Shadows
  bentoShadow: string;
  bentoShadowSm: string;
  softShadow: string;
  primaryBtnShadow: string;
  // R108-e: the clay material's layered depth (see deriveThemeStyles).
  clayShadow: string;
  clayShadowSm: string;
  // Text helpers
  textSecondary: string;
  textTertiary: string;
  // Pill / badge
  pillBg: string;
  pillText: string;
  // Toggle
  toggleTrack: string;
  toggleActive: string;
  // Dot grid
  dotColor: string;
}

/**
 * A theme counts as monochrome when its accent carries almost no chroma —
 * derived from the color itself so no theme id is ever special-cased here
 * (the demo checked `id === 'mono'`; that would violate the append-only rule).
 */
function achromaticAccent(theme: ThemeColors): boolean {
  const [r, g, b] = parseColor(theme.accent);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 || (max - min) / max < 0.08;
}

/** Compute every dark/light-mode-aware style value for a theme + mode. */
/** ROUND-34: sidebar tint strength (settings appearance) → mix percentages.
 * subtle = the R32 owner-design values; warm/bold step up the accent mix. */
const SIDEBAR_TINT_MIX: Record<SidebarTintStrength, { light: number; dark: number }> = {
  subtle: { light: 0.045, dark: 0.055 },
  warm: { light: 0.08, dark: 0.09 },
  bold: { light: 0.16, dark: 0.18 },
};
type SidebarTintStrength = "subtle" | "warm" | "bold";

export function deriveThemeStyles(
  themeIdOrTheme: string | ThemeColors,
  isDark: boolean,
  sidebarTint: SidebarTintStrength = "subtle",
): ThemeStyles {
  const theme =
    typeof themeIdOrTheme === "string" ? getTheme(themeIdOrTheme) : themeIdOrTheme;

  return {
    theme,
    isDark,
    isMono: achromaticAccent(theme),
    // Core
    bg: isDark ? theme.bgDark : theme.bgLight,
    card: isDark ? theme.cardDark : theme.cardLight,
    text: isDark ? theme.textDark : theme.textLight,
    accent: isDark ? theme.accentDark ?? theme.accent : theme.accent,
    accentText: getContrastText(isDark ? theme.accentDark ?? theme.accent : theme.accent),

    // Round-32 sidebar surface (owner-approved design Acute-Ui-Screens.html,
    // Frame 1): a SUBTLE warm tint — light #FFF6E5 ≈ 4.5% accent into bgLight,
    // dark #2E2A26 ≈ 5.5% accent into cardDark. The separation from the main
    // area comes from the floating-panel treatment + the pure-white chat
    // panel, NOT from a strong tint (the R30 12–16% mix read as muddy).
    sidebarBg: isDark
      ? mixHex(theme.cardDark, theme.accentDark ?? theme.accent, SIDEBAR_TINT_MIX[sidebarTint].dark)
      : mixHex(theme.bgLight, theme.accent, SIDEBAR_TINT_MIX[sidebarTint].light),
    sidebarBorder: isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.14)",
    sidebarHover: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)",

    // Borders
    border: isDark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.10)",
    borderStrong: isDark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.18)",
    borderSubtle: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",

    // Subtle fills
    subtle: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)",
    subtleHover: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)",

    // Inputs
    inputBg: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.02)",
    inputBorder: isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.10)",
    inputFocusBorder: isDark ? "rgba(255,255,255,0.30)" : "rgba(0,0,0,0.90)",

    // Shadows (bento style: offset solid/soft block)
    bentoShadow: isDark
      ? "4px 4px 0px 0px rgba(255,255,255,0.08)"
      : "4px 4px 0px 0px black",
    bentoShadowSm: isDark
      ? "3px 3px 0px 0px rgba(255,255,255,0.06)"
      : "3px 3px 0px 0px black",
    softShadow: isDark
      ? "0 8px 32px rgba(0,0,0,0.3), 0 2px 8px rgba(0,0,0,0.2)"
      : "0 8px 32px rgba(0,0,0,0.06), 0 2px 8px rgba(0,0,0,0.04)",
    primaryBtnShadow: isDark
      ? "3px 3px 0px 0px rgba(255,255,255,0.08)"
      : "3px 3px 0px 0px black",

    // R108-e (owner verdict on R107-g's execution: "You implemented clay but
    // it was not implemented properly… at the very top you implemented some
    // glow fade and other stuff like that"): clay depth is FORM, not paint —
    // layered SOFT SHADOWS instead of gradient top-lights. Each recipe stacks
    // a tight directional contact shadow (the card resting on the surface)
    // under a larger, very soft ambient one, tinted with the clay ink family
    // in light mode (hand-thrown ceramics cast WARM shadows, never cold
    // black) and deepened toward black in dark mode. Mode-aware,
    // theme-independent — same pipeline slot as softShadow above; consumed
    // via the .ac-clay pattern class (COMPONENTS §8), TOKENS §9.
    clayShadow: isDark
      ? "0 2px 4px rgba(0,0,0,0.35), 0 16px 40px -8px rgba(0,0,0,0.45)"
      : "0 2px 4px rgba(42,32,24,0.08), 0 16px 40px -8px rgba(42,32,24,0.13)",
    // The small-surface step of the same recipe (chips, small tiles, the
    // pickers' compact cards) — the ambient leg halves with the footprint.
    clayShadowSm: isDark
      ? "0 1px 2px rgba(0,0,0,0.30), 0 8px 20px -4px rgba(0,0,0,0.40)"
      : "0 1px 2px rgba(42,32,24,0.08), 0 8px 20px -4px rgba(42,32,24,0.10)",

    // Text helpers
    textSecondary: isDark ? "rgba(255,255,255,0.60)" : "rgba(0,0,0,0.60)",
    textTertiary: isDark ? "rgba(255,255,255,0.40)" : "rgba(0,0,0,0.40)",

    // Pill / badge
    pillBg: isDark ? "rgba(255,255,255,0.10)" : "black",
    pillText: isDark ? theme.textDark : "white",

    // Toggle
    toggleTrack: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.04)",
    toggleActive: isDark ? "white" : "black",

    // Dot grid
    dotColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
  };
}

/**
 * Bridge the derived values onto :root as --ac-* custom properties so plain
 * CSS and the legacy token mapping in index.css (--bg, --card, --accent, …)
 * follow whatever theme+mode is active — including themes added later without
 * any CSS edit. Inline styles on documentElement also beat any static CSS, so
 * this can run before first paint (applyTheme does exactly that).
 */
export function syncThemeCssVars(styles: ThemeStyles): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement.style;
  const t = styles.theme;
  const vars: Record<string, string> = {
    "--ac-bg": styles.bg,
    "--ac-card": styles.card,
    "--ac-text": styles.text,
    "--ac-accent": styles.accent,
    "--ac-accent-2": t.accent2,
    "--ac-accent-text": styles.accentText,
    "--ac-border": styles.border,
    "--ac-border-strong": styles.borderStrong,
    "--ac-border-subtle": styles.borderSubtle,
    "--ac-subtle": styles.subtle,
    "--ac-subtle-hover": styles.subtleHover,
    "--ac-input-bg": styles.inputBg,
    "--ac-input-border": styles.inputBorder,
    "--ac-input-focus-border": styles.inputFocusBorder,
    "--ac-bento-shadow": styles.bentoShadow,
    "--ac-bento-shadow-sm": styles.bentoShadowSm,
    "--ac-soft-shadow": styles.softShadow,
    "--ac-primary-btn-shadow": styles.primaryBtnShadow,
    "--ac-clay-shadow": styles.clayShadow,
    "--ac-clay-shadow-sm": styles.clayShadowSm,
    "--ac-text-secondary": styles.textSecondary,
    "--ac-text-tertiary": styles.textTertiary,
    "--ac-pill-bg": styles.pillBg,
    "--ac-pill-text": styles.pillText,
    "--ac-toggle-track": styles.toggleTrack,
    "--ac-toggle-active": styles.toggleActive,
    "--ac-dot-color": styles.dotColor,
    "--ac-dot": styles.isDark ? t.dotDark : t.dot,
    "--ac-selected-bg": t.selectedBg,
    "--ac-selected-text": t.selectedText,
    "--ac-sidebar-bg": styles.sidebarBg,
    "--ac-sidebar-border": styles.sidebarBorder,
    "--ac-sidebar-hover": styles.sidebarHover,
    // R98-C1 (design-language TOKENS §4): the fixed semantic hues ride the
    // CSS-var leg too, so hover-capable utilities (window controls, status
    // chips) can express danger/success/warning without JS handlers. Same
    // values as SEMANTIC_COLORS — the single documented exception set.
    "--ac-danger": "#ef4444",
    "--ac-success": "#22c55e",
    "--ac-warning": "#f59e0b",
    // R98-C2: the informative running-blue (in-flight tool rows) + the
    // frosted pill surface (the chat's jump-to-latest / sticky affordances)
    // join the CSS-var leg — one spelling, hover-capable, theme-aware.
    "--ac-running": "#3b82f6",
    "--ac-frosted": styles.isDark ? "rgba(44,44,46,0.72)" : "rgba(255,255,255,0.72)",
    // R107-g (owner: "a mixture of liquid chrome"): the CHROME ramp — the
    // metallic counterpoint to the clay substrate (TOKENS §8). Deliberately
    // theme-INDEPENDENT (liquid chrome reads as the same platinum on every
    // palette — the jewelry, not the cloth) but mode-aware: light mode gets
    // warm-platinum opaque stops (the full-metal surface + hairline glints),
    // dark mode gets white-alpha stops that layer over whatever surface
    // carries them. Values live HERE (the token pipeline), never in a
    // component — the patterns that consume them (.ac-chrome-* in
    // index.css) are documented in COMPONENTS §8.
    // R108-e: the sheen stops were HALVED (0.55→0.30 light, 0.16→0.10 dark)
    // — the owner's round-108 verdict demoted anything that reads as a glow;
    // the moving band is jewelry at a whisper now, not a shine sweep.
    "--ac-chrome-hi": styles.isDark ? "rgba(255,255,255,0.55)" : "#FFFFFF",
    "--ac-chrome-mid": styles.isDark ? "rgba(255,255,255,0.08)" : "#EDE8E0",
    "--ac-chrome-lo": styles.isDark ? "rgba(255,255,255,0.03)" : "#D8D1C6",
    "--ac-chrome-sheen": styles.isDark ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.30)",
  };
  for (const [name, value] of Object.entries(vars)) {
    root.setProperty(name, value);
  }
}
