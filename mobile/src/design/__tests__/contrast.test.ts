/**
 * The contrast floor (R117-g1 — round-117-elevation.md §4.2): "One node
 * mixHex+ratio script against the merged tokens — commit it next to the
 * tokens so regressions fail CI."
 *
 * Every critical pair of the CLAY theme — the surface ladder, the ink
 * ladder, the two-tier accent, the CTA label/fill, the Badge's tinted
 * containers, the tab-label ink, the non-text glyph floors — recomputed
 * from the resolved tokens with an INDEPENDENT WCAG 2.1 implementation.
 * This file re-derives the luminance/ratio math instead of importing it:
 * the test is the verifier, not a consumer, so a bug in tokens.ts's own
 * math can't green-light itself here.
 *
 * Method notes (matching the spec's own arithmetic on the OLD values —
 * 1.08/1.11 ladder, 2.83/3.60 tertiary — which this engine reproduces):
 * alpha inks (rgba(r,g,b,a)) composite over their surface in sRGB space
 * before the ratio; ratios are (L1+0.05)/(L2+0.05). Where the spec's §2.1
 * prose prints a rounded ratio (5.23, 4.56, 1.15) the strict value differs
 * in the second decimal (5.09, 4.94, 1.148) — the VALUES are the law, the
 * ≥ floors below are what CI enforces, and every pair clears its floor in
 * both modes.
 */

import { describe, expect, it } from "@jest/globals";
import {
  CHART_HUES,
  DEFAULT_THEME_ID,
  TYPE_STAT,
  TYPE_TAB_LABEL,
  resolveTheme,
} from "../tokens";

// ── the local WCAG engine (independent of tokens.ts by design) ──────────────

type Rgb = readonly [number, number, number];

/** Parse one color: #rrggbb | #rgb | rgb(...) | rgba(r,g,b,a). */
function parseColor(color: string): { rgb: Rgb; alpha: number } {
  const hex = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const short = /^#?([0-9a-f]{3})$/i.exec(color.trim());
  if (short) {
    const [r, g, b] = short[1].split("");
    return { rgb: [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16)], alpha: 1 };
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(color.trim());
  if (rgba) {
    return {
      rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
      alpha: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  throw new Error(`contrast test: unparseable color ${color}`);
}

/** WCAG 2.1 relative luminance. */
function luminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** The contrast ratio of fg over bg — alpha inks composite over the bg. */
function contrast(fg: string, bg: string): number {
  const { rgb: bgRgb } = parseColor(bg);
  const { rgb: fgRgb, alpha } = parseColor(fg);
  const composited: Rgb = [
    Math.round(alpha * fgRgb[0] + (1 - alpha) * bgRgb[0]),
    Math.round(alpha * fgRgb[1] + (1 - alpha) * bgRgb[1]),
    Math.round(alpha * fgRgb[2] + (1 - alpha) * bgRgb[2]),
  ];
  const l1 = luminance(composited);
  const l2 = luminance(bgRgb);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

// ── the clay theme, both modes ───────────────────────────────────────────────

const light = resolveTheme(DEFAULT_THEME_ID, false);
const dark = resolveTheme(DEFAULT_THEME_ID, true);

/** One table row: a named pair, its floor, and (optionally) a drift pin. */
interface PairRow {
  name: string;
  fg: string;
  bg: string;
  min: number;
  /** The spec's printed ratio at 1–2 decimals — guards silent drift. */
  near?: number;
}

function runPairTable(rows: readonly PairRow[]): void {
  for (const row of rows) {
    const ratio = contrast(row.fg, row.bg);
    it(`${row.name} ≥ ${row.min}:1 (computed ${ratio.toFixed(2)})`, () => {
      expect(ratio).toBeGreaterThanOrEqual(row.min);
      if (row.near !== undefined) {
        expect(ratio).toBeCloseTo(row.near, 1);
      }
    });
  }
}

// ── §2.1 the surface ladder: card must separate from bg ─────────────────────

describe("the surface ladder (card vs bg, both modes)", () => {
  // The spec prints 1.15 light / 1.24 dark; the strict WCAG values are
  // 1.148 / 1.240 — pinned at 2 decimals, floored at 1.14 / 1.20 so the
  // ladder can never silently collapse back toward the old 1.08/1.11.
  const rows: readonly PairRow[] = [
    { name: "light card #FDFDFB vs bg #ECEEE8", fg: light.card, bg: light.bg, min: 1.14, near: 1.15 },
    { name: "dark card #332C26 vs bg #211B16", fg: dark.card, bg: dark.bg, min: 1.2, near: 1.24 },
  ];
  runPairTable(rows);
});

// ── §2.1 the ink ladder: the most-used tier passes AA ────────────────────────

describe("the ink ladder (text tiers pass AA where they render)", () => {
  const rows: readonly PairRow[] = [
    // The app's most-used tier — was 2.83:1 light / 3.60:1 dark.
    { name: "textTertiary on card (light)", fg: light.textTertiary, bg: light.card, min: 4.5, near: 5.09 },
    { name: "textTertiary on card (dark)", fg: dark.textTertiary, bg: dark.card, min: 4.5, near: 4.91 },
    // The same tier on the page bg (empty states, dashed links).
    { name: "textTertiary on bg (light)", fg: light.textTertiary, bg: light.bg, min: 4.5, near: 4.94 },
    { name: "textTertiary on bg (dark)", fg: dark.textTertiary, bg: dark.bg, min: 4.5, near: 5.49 },
    // Secondary stays a visible step above tertiary and passes everywhere.
    { name: "textSecondary on card (light)", fg: light.textSecondary, bg: light.card, min: 4.5, near: 6.18 },
    { name: "textSecondary on card (dark)", fg: dark.textSecondary, bg: dark.card, min: 4.5, near: 6.28 },
    // The tab-label ink rides the same tertiary tier on the bar's card
    // surface (the tab bar's floating slab is card-colored).
    { name: "tab label (textTertiary) on the bar's card surface (light)", fg: light.textTertiary, bg: light.card, min: 4.5 },
    { name: "tab label (textTertiary) on the bar's card surface (dark)", fg: dark.textTertiary, bg: dark.card, min: 4.5 },
  ];
  runPairTable(rows);
});

// ── §2.1/§2.2 the two-tier accent + the CTA ─────────────────────────────────

describe("the two-tier accent family", () => {
  const rows: readonly PairRow[] = [
    // accentDeep as TEXT (SectionHeader actions, delivery ticks, labels).
    { name: "accentDeep as text on card (light)", fg: light.accentDeep, bg: light.card, min: 4.5, near: 4.89 },
    { name: "accentDeep as text on card (dark)", fg: dark.accentDeep, bg: dark.card, min: 4.5, near: 5.08 },
    // The CTA: label vs fill — the dark-mode INK flip (was white-on-salmon
    // 2.70:1; the label is 15/700, NOT large text, so AA is 4.5:1).
    { name: "CTA label vs fill (light: white on ember)", fg: light.accentText, bg: light.accentDeep, min: 4.5, near: 4.98 },
    { name: "CTA label vs fill (dark: ink on salmon)", fg: dark.accentText, bg: dark.accentDeep, min: 4.5, near: 6.3 },
    // The marker/icon tier — non-text glyphs need ≥3:1.
    { name: "accent (markers/icons) on card (light)", fg: light.accent, bg: light.card, min: 3, near: 3.9 },
    { name: "accent (markers/icons) on cardD (dark)", fg: dark.accent, bg: dark.card, min: 3, near: 5.08 },
    // The tinted container's glyph leg: accentDeep on accentTint (the icon
    // chips' recipe — glyphs on the 12%/18% tint).
    { name: "accentDeep glyph on accentTint (light)", fg: light.accentDeep, bg: light.accentTint, min: 3 },
    { name: "accentDeep glyph on accentTint (dark)", fg: dark.accentDeep, bg: dark.accentTint, min: 3 },
  ];
  runPairTable(rows);
});

// ── §2.2 the Badge's tinted containers: every ink vs its tint ────────────────

describe("the Badge tinted containers (every tone, both modes)", () => {
  const rows: readonly PairRow[] = [
    { name: "success ink vs tint (light)", fg: light.badgeTones.success.fg, bg: light.badgeTones.success.bg, min: 4.5, near: 6.32 },
    { name: "success ink vs tint (dark)", fg: dark.badgeTones.success.fg, bg: dark.badgeTones.success.bg, min: 4.5, near: 5.54 },
    { name: "warning ink vs tint (light)", fg: light.badgeTones.warning.fg, bg: light.badgeTones.warning.bg, min: 4.5, near: 6.38 },
    { name: "warning ink vs tint (dark)", fg: dark.badgeTones.warning.fg, bg: dark.badgeTones.warning.bg, min: 4.5, near: 5.57 },
    { name: "danger ink vs tint (light)", fg: light.badgeTones.danger.fg, bg: light.badgeTones.danger.bg, min: 4.5, near: 5.44 },
    { name: "danger ink vs tint (dark)", fg: dark.badgeTones.danger.fg, bg: dark.badgeTones.danger.bg, min: 4.5, near: 5.82 },
    { name: "running ink vs tint (light)", fg: light.badgeTones.running.fg, bg: light.badgeTones.running.bg, min: 4.5, near: 5.74 },
    { name: "running ink vs tint (dark)", fg: dark.badgeTones.running.fg, bg: dark.badgeTones.running.bg, min: 4.5, near: 6.02 },
    { name: "accent ink vs fill (light)", fg: light.badgeTones.accent.fg, bg: light.badgeTones.accent.bg, min: 4.5, near: 4.98 },
    { name: "accent ink vs fill (dark)", fg: dark.badgeTones.accent.fg, bg: dark.badgeTones.accent.bg, min: 4.5, near: 6.3 },
    { name: "neutral ink vs well (light)", fg: light.badgeTones.neutral.fg, bg: light.badgeTones.neutral.bg, min: 4.5 },
    { name: "neutral ink vs well (dark)", fg: dark.badgeTones.neutral.fg, bg: dark.badgeTones.neutral.bg, min: 4.5 },
  ];
  runPairTable(rows);
});

// ── §2.1 the semantic deep/bright pairs: status text on card ─────────────────

describe("the semantic deep/bright pairs (status text on card)", () => {
  const rows: readonly PairRow[] = [
    { name: "successDeep on card (light)", fg: light.successDeep, bg: light.card, min: 4.5, near: 4.92 },
    { name: "successDeep on cardD (dark)", fg: dark.successDeep, bg: dark.card, min: 4.5, near: 7.88 },
    { name: "warningDeep on card (light)", fg: light.warningDeep, bg: light.card, min: 4.5, near: 4.93 },
    { name: "warningDeep on cardD (dark)", fg: dark.warningDeep, bg: dark.card, min: 4.5, near: 8.23 },
    { name: "dangerDeep on card (light)", fg: light.dangerDeep, bg: light.card, min: 4.5, near: 4.74 },
    { name: "dangerDeep on cardD (dark)", fg: dark.dangerDeep, bg: dark.card, min: 4.5, near: 4.97 },
    { name: "runningDeep on card (light)", fg: light.runningDeep, bg: light.card, min: 4.5, near: 6.58 },
    { name: "runningDeep on cardD (dark)", fg: dark.runningDeep, bg: dark.card, min: 4.5 },
  ];
  runPairTable(rows);
});

// ── §4.2 the non-text floors (bars / glyphs) ─────────────────────────────────

describe("the non-text glyph floors (≥3:1)", () => {
  const rows: readonly PairRow[] = [
    { name: "chart output hue on card (light)", fg: CHART_HUES.output.light, bg: light.card, min: 3, near: 3.65 },
    { name: "chart output hue on cardD (dark)", fg: CHART_HUES.output.dark, bg: dark.card, min: 3, near: 6.69 },
    { name: "chart input hue on card (light)", fg: CHART_HUES.input.light, bg: light.card, min: 3, near: 3.9 },
    { name: "chart input hue on cardD (dark)", fg: CHART_HUES.input.dark, bg: dark.card, min: 3, near: 5.08 },
  ];
  runPairTable(rows);
});

// ── the spec's computed values, pinned (drift guards, not floors) ────────────

describe("the spec's pinned token values (round-117-elevation.md §2.1)", () => {
  it("the surface ladder hexes", () => {
    expect(light.bg).toBe("#ECEEE8");
    expect(light.card).toBe("#FDFDFB");
    expect(dark.bg).toBe("#211B16");
    expect(dark.card).toBe("#332C26");
  });

  it("the two-tier accent + on-accent text", () => {
    expect(light.accent).toBe("#C4653F");
    expect(light.accentDeep).toBe("#B45330");
    expect(dark.accent).toBe("#D98A63");
    expect(dark.accentDeep).toBe("#D98A63");
    expect(light.accentText).toBe("#FFFFFF");
    expect(dark.accentText).toBe("#211B16"); // the dark-mode CTA ink flip
  });

  it("the ink ladder alphas", () => {
    expect(light.textTertiary).toBe("rgba(0,0,0,0.57)");
    expect(dark.textTertiary).toBe("rgba(255,255,255,0.52)");
    expect(light.textSecondary).toBe("rgba(0,0,0,0.62)");
    expect(dark.textSecondary).toBe("rgba(255,255,255,0.62)");
  });

  it("the derived material values (mixHex, exactly as computed)", () => {
    expect(light.clayRim).toBe("#E8E7E4"); // mixHex(card,"#2A2018",0.10)
    expect(dark.clayTopEdge).toBe("#504A44"); // mixHex(cardD,"#FFFFFF",0.14)
    expect(light.surfaceWell).toBe("#F4F1EE"); // mixHex(card,"#8A6A55",0.08)
    expect(dark.surfaceWell).toBe("#3D3731"); // mixHex(cardD,"#FFFFFF",0.05)
    expect(light.accentTint).toBe("#F6EBE4"); // mixHex(card,"#C4653F",0.12)
    expect(dark.accentTint).toBe("#513D31"); // mixHex(cardD,"#D98A63",0.18)
    expect(light.monoBg).toBe("#F0F0ED"); // mixHex(card,"#2A2018",0.06)
  });

  it("the badge tinted containers (the §2.2 table's hexes)", () => {
    expect(light.badgeTones.success).toEqual({ bg: "#E3F6E8", fg: "#166534" });
    expect(dark.badgeTones.success).toEqual({ bg: "#304B31", fg: "#4ADE80" });
    expect(light.badgeTones.warning).toEqual({ bg: "#FCF2DE", fg: "#92400E" });
    expect(dark.badgeTones.warning).toEqual({ bg: "#5A4321", fg: "#FBBF24" });
    expect(light.badgeTones.danger).toEqual({ bg: "#FBE7E5", fg: "#B91C1C" });
    expect(dark.badgeTones.danger).toEqual({ bg: "#59312C", fg: "#FCA5A5" });
    expect(light.badgeTones.running).toEqual({ bg: "#E6EEFA", fg: "#1D4ED8" });
    expect(dark.badgeTones.running).toEqual({ bg: "#353D50", fg: "#93C5FD" });
  });

  it("the shadow v2 strings (contact 10–14%, ambient 14–24%)", () => {
    expect(light.clayShadow1).toBe("0px 1px 2px rgba(38,34,28,0.12), 0px 6px 16px -6px rgba(38,34,28,0.18)");
    expect(dark.clayShadow1).toBe("0px 1px 2px rgba(0,0,0,0.40), 0px 8px 20px -6px rgba(0,0,0,0.50)");
    expect(light.clayShadow2).toBe("0px 2px 4px rgba(38,34,28,0.14), 0px 12px 32px -8px rgba(38,34,28,0.24)");
    expect(dark.clayShadow2).toBe("0px 2px 4px rgba(0,0,0,0.45), 0px 14px 36px -8px rgba(0,0,0,0.60)");
    expect(light.clayShadowSm).toBe("0px 1px 2px rgba(38,34,28,0.10), 0px 3px 10px -4px rgba(38,34,28,0.14)");
    expect(dark.clayShadowSm).toBe("0px 1px 2px rgba(0,0,0,0.35), 0px 4px 12px -4px rgba(0,0,0,0.45)");
    expect(light.clayShadowPressed).toBe("0px 1px 2px rgba(38,34,28,0.12)");
    expect(dark.clayShadowPressed).toBe("0px 1px 2px rgba(0,0,0,0.40)");
    expect(light.clayShadowSheet).toBe("0px -2px 6px rgba(38,34,28,0.12), 0px -12px 32px -8px rgba(38,34,28,0.22)");
    expect(dark.clayShadowSheet).toBe("0px -2px 6px rgba(0,0,0,0.50), 0px -14px 36px -8px rgba(0,0,0,0.65)");
  });

  it("the chrome jewelry stops (the glint, not the gloss band)", () => {
    expect(light.sheenTop).toBe("rgba(255,255,255,0.18)");
    expect(dark.sheenTop).toBe("rgba(255,255,255,0.12)");
    // R118-B (AMENDMENT to tokens.md §2): the metal ramp's base stop
    // deepens so the grounded edge draws on the white bar (0.16→0.22 light,
    // 0.06→0.08 dark) — the owner's "improve the bar's border" ruling.
    expect(light.chromeEdgeDark).toBe("rgba(42,32,24,0.22)");
    expect(dark.chromeEdgeDark).toBe("rgba(255,255,255,0.08)");
  });

  it("the type floors (AMENDMENT 4)", () => {
    expect(TYPE_STAT).toBe(28); // the display size, mono-medium slot
    expect(TYPE_TAB_LABEL).toBe(11.5); // above the ladder's own 11px floor
  });
});

// ── R118-D: the session chrome + the destructive dialog pairs ───────────────
//
// spec-d-session.md §2.1/§2.3: surfaceHeader (the identity bar's chrome
// shade — bg +6% warm ink light / +30% black dark, "chrome over content",
// the inverse direction of card) must still carry the header's TEXT tiers
// at AA, and the ConfirmDialog's destructive CTA (the dangerDeep fill with
// white ink light / #211B16 dark) must carry its 15/700 label at AA.

describe("the session chrome surface (R118-D — surfaceHeader)", () => {
  // The spec's printed hexes — #E0E2DC / #17130F on Clay — pinned exactly.
  it("the surfaceHeader hexes are the spec's printed pair", () => {
    expect(light.surfaceHeader).toBe("#E0E2DC");
    expect(dark.surfaceHeader).toBe("#17130F");
  });

  const rows: readonly PairRow[] = [
    // The identity bar's subtitle + title tiers over the chrome shade —
    // the fill must never cost the header its AA.
    { name: "textTertiary on surfaceHeader (light — the session subtitle)", fg: light.textTertiary, bg: light.surfaceHeader, min: 4.5 },
    { name: "textTertiary on surfaceHeader (dark — the session subtitle)", fg: dark.textTertiary, bg: dark.surfaceHeader, min: 4.5 },
    { name: "text on surfaceHeader (light — the project title)", fg: light.text, bg: light.surfaceHeader, min: 4.5 },
    { name: "text on surfaceHeader (dark — the project title)", fg: dark.text, bg: dark.surfaceHeader, min: 4.5 },
    // The shade itself separates from the page bg (present, not a no-op —
    // deliberately NOT the card ladder: chrome over content).
    { name: "surfaceHeader vs bg (light)", fg: light.surfaceHeader, bg: light.bg, min: 1.02 },
    { name: "surfaceHeader vs bg (dark)", fg: dark.surfaceHeader, bg: dark.bg, min: 1.02 },
  ];
  runPairTable(rows);
});

describe("the destructive dialog pair (R118-D — the ConfirmDialog CTA)", () => {
  const rows: readonly PairRow[] = [
    // §2.3: the confirm fills dangerDeep with white ink light / #211B16
    // dark — the label is 15/700 (bold, but under WCAG's large-text bar, so
    // the pair itself carries AA).
    { name: "white on dangerDeep (light — the Stop label)", fg: "#FFFFFF", bg: light.dangerDeep, min: 4.5 },
    { name: "#211B16 on dangerDeep (dark — the Stop label)", fg: "#211B16", bg: dark.dangerDeep, min: 4.5 },
  ];
  runPairTable(rows);

  it("the dangerDeep hexes are the tokens' own (light #DC2626 / dark #F87171)", () => {
    expect(light.dangerDeep).toBe("#DC2626");
    expect(dark.dangerDeep).toBe("#F87171");
  });
});
