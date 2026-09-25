// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { deriveThemeStyles, getTheme, syncThemeCssVars, THEMES } from "./themes";

/**
 * R107-g (the clay/chrome round) — the Clay Studio theme's contract:
 * appended to THEMES (the frozen-shape rule: one object literal, nothing
 * else), it must resolve through the standard pipeline in both modes, keep
 * the warm accent family (the owner's Clay Studio direction — indigo/blue
 * accents are banned house-wide), and stay inside the contrast envelope the
 * other five themes already tolerate. The liquid-chrome ramp rides the
 * CSS-var leg (--ac-chrome-*) and must be mode-aware + theme-independent.
 *
 * R108-e (the clay rework): the clay MATERIAL is now shadow/form-based —
 * the --ac-clay-shadow tokens must land mode-aware + theme-independent,
 * layered (a tight directional leg + a large soft ambient leg), and the
 * light-mode legs must carry the WARM ink tint (clay casts warm shadows,
 * never cold black). The sheen stop is pinned at its halved quiet value.
 */

/** WCAG relative luminance for a #rrggbb literal (test-local, on purpose:
 * the app's parseColor needs a canvas; the math does not). */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

describe("Clay Studio theme (R107-g)", () => {
  const clay = getTheme("clay");

  it("is in the catalog with the owner-facing name", () => {
    expect(THEMES.map((t) => t.id)).toContain("clay");
    expect(clay.name).toBe("Clay Studio");
    // The append-only rule: the five pre-R107 themes are untouched.
    expect(THEMES.map((t) => t.id)).toEqual([
      "nova",
      "bento",
      "midnight",
      "sunset",
      "mono",
      "clay",
    ]);
  });

  it("keeps the accent in the warm family — never indigo/blue", () => {
    const warm = (hex: string) => parseInt(hex.slice(1, 3), 16) > parseInt(hex.slice(5, 7), 16);
    expect(warm(clay.accent)).toBe(true);
    expect(warm(clay.accentDark ?? clay.accent)).toBe(true);
    expect(warm(clay.accent2)).toBe(true);
  });

  it("resolves through deriveThemeStyles in both modes (standard pipeline)", () => {
    const light = deriveThemeStyles("clay", false);
    expect(light.accent).toBe("#C4653F");
    // R126 (the Clay Companion bridge): the literals are the mobile clay
    // entry VERBATIM — the round-117 surface-ladder amendment values (bg
    // #ECEEE8/card #FDFDFB light, #211B16/#332C26 dark), replacing the
    // pre-R126 R107-g literals (#F4EEE5/#FDFBF7/#26211C/#2F2924).
    expect(light.bg).toBe("#ECEEE8");
    expect(light.card).toBe("#FDFDFB");
    expect(light.text).toBe("#2A2018");
    // (isMono is deliberately NOT asserted here: happy-dom ships no canvas
    // 2d context, so parseColor degrades to [0,0,0] and achromaticAccent
    // reads every accent as achromatic under the test runner. In a real
    // browser #C4653F's chroma is 0.68 — far off the 0.08 mono line.)

    const dark = deriveThemeStyles("clay", true);
    expect(dark.accent).toBe("#D98A63"); // accentDark lifts for dark-mode legibility
    expect(dark.bg).toBe("#211B16");
    expect(dark.card).toBe("#332C26");
    expect(dark.text).toBe("#F2EBE1");
  });

  it("stays inside the contrast envelope the existing themes tolerate", () => {
    // Primary ink on surfaces — the app family sits at 13–18:1.
    expect(contrast(clay.textLight, clay.bgLight)).toBeGreaterThan(12);
    expect(contrast(clay.textDark, clay.bgDark)).toBeGreaterThan(12);
    // The dark-mode accent must clear ~4.5:1 against bgDark (the
    // ThemeColors.accentDark contract — mono needed it, clay needs it).
    expect(contrast(clay.accentDark ?? clay.accent, clay.bgDark)).toBeGreaterThanOrEqual(4.5);
    // Light accent as UI ink on the light bg: above nova's 2.75:1.
    expect(contrast(clay.accent, clay.bgLight)).toBeGreaterThan(2.75);
  });
});

describe("the liquid-chrome ramp (R107-g --ac-chrome-* vars)", () => {
  it("is mode-aware and lands on :root for both modes", () => {
    syncThemeCssVars(deriveThemeStyles("nova", false));
    const light = { ...pickChromeVars() };
    syncThemeCssVars(deriveThemeStyles("nova", true));
    const dark = pickChromeVars();

    expect(light["--ac-chrome-hi"]).toBe("#FFFFFF");
    expect(light["--ac-chrome-mid"]).toBe("#EDE8E0");
    expect(light["--ac-chrome-lo"]).toBe("#D8D1C6");
    // Dark mode rides white-alpha stops (layered metal, not opaque paint).
    expect(dark["--ac-chrome-hi"]).toBe("rgba(255,255,255,0.55)");
    expect(dark["--ac-chrome-mid"]).toBe("rgba(255,255,255,0.08)");
    expect(dark["--ac-chrome-lo"]).toBe("rgba(255,255,255,0.03)");
    // R108-e: the sheen is pinned at the HALVED quiet stops (0.30 light /
    // 0.10 dark) — the owner's round-108 verdict demoted glow-reading
    // passes; the band is jewelry at a whisper, never a shine sweep.
    expect(light["--ac-chrome-sheen"]).toBe("rgba(255,255,255,0.30)");
    expect(dark["--ac-chrome-sheen"]).toBe("rgba(255,255,255,0.10)");
  });

  it("is theme-independent — the same platinum on clay and nova", () => {
    syncThemeCssVars(deriveThemeStyles("clay", false));
    const onClay = pickChromeVars();
    syncThemeCssVars(deriveThemeStyles("nova", false));
    const onNova = pickChromeVars();
    expect(onClay).toEqual(onNova);
  });
});

describe("the clay shadow material (R108-e --ac-clay-* vars)", () => {
  it("is mode-aware and lands on :root for both modes", () => {
    syncThemeCssVars(deriveThemeStyles("clay", false));
    const light = pickClayVars();
    syncThemeCssVars(deriveThemeStyles("clay", true));
    const dark = pickClayVars();

    for (const mode of [light, dark]) {
      for (const name of ["--ac-clay-shadow", "--ac-clay-shadow-sm"]) {
        // The FORM contract: exactly TWO layered legs — the tight directional
        // contact shadow + the larger very soft ambient one.
        const legs = mode[name].split(", ");
        expect(legs).toHaveLength(2);
        for (const leg of legs) {
          // every leg is a real shadow leg (offsets, blur, optional spread, color)
          expect(leg).toMatch(/^0(?:px)? \d+px \d+px(?: -\d+px)? rgba\(/);
        }
      }
    }
    // The WARM tint: light-mode shadows carry the clay ink family
    // rgba(38,34,28,…) — R126 moved the warm ink to the mobile
    // constitution's value (R114-c's half-step cooler warm ink — the warm
    // cast never reads ORANGE against the #ECEEE8-class whites; still
    // warm family, never cold black). Hand-thrown ceramics cast warm
    // shadows (the R108-e rework's law; only the exact ink value moved).
    expect(light["--ac-clay-shadow"]).toContain("rgba(38,34,28,");
    expect(light["--ac-clay-shadow-sm"]).toContain("rgba(38,34,28,");
    // Dark mode deepens toward black for real lift on the dark substrate.
    expect(dark["--ac-clay-shadow"]).toContain("rgba(0,0,0,");
    expect(dark["--ac-clay-shadow-sm"]).toContain("rgba(0,0,0,");
  });

  it("is theme-independent — the same clay form on clay and nova", () => {
    syncThemeCssVars(deriveThemeStyles("clay", false));
    const onClay = pickClayVars();
    syncThemeCssVars(deriveThemeStyles("nova", false));
    const onNova = pickClayVars();
    expect(onClay).toEqual(onNova);
  });

  it("has a documented step-down — sm's ambient leg is softer than the full recipe", () => {
    syncThemeCssVars(deriveThemeStyles("clay", false));
    const full = pickClayVars()["--ac-clay-shadow"];
    const sm = pickClayVars()["--ac-clay-shadow-sm"];
    const ambientBlur = (s: string) => parseInt(s.split(", ")[1].split(/ +/)[1], 10);
    expect(ambientBlur(sm)).toBeLessThan(ambientBlur(full));
  });
});

function pickChromeVars(): Record<string, string> {
  const root = document.documentElement.style;
  const out: Record<string, string> = {};
  for (const name of ["--ac-chrome-hi", "--ac-chrome-mid", "--ac-chrome-lo", "--ac-chrome-sheen"]) {
    out[name] = root.getPropertyValue(name);
  }
  return out;
}

function pickClayVars(): Record<string, string> {
  const root = document.documentElement.style;
  const out: Record<string, string> = {};
  for (const name of ["--ac-clay-shadow", "--ac-clay-shadow-sm"]) {
    out[name] = root.getPropertyValue(name);
  }
  return out;
}

// ── ROUND-126 (the Clay Companion bridge): the surface ladder + the status
// grammar — every value the screens will consume, pinned so a future "simpler"
// formula cannot land silently. The formulas are mobile tokens.ts verbatim.
describe("R126: the Clay Companion surface ladder + status grammar", () => {
  it("the two-tier accent family resolves per the mobile law", () => {
    const light = deriveThemeStyles("clay", false);
    const dark = deriveThemeStyles("clay", true);
    // Light: the marker tier + the deepened accent-as-text/CTA tier.
    expect(light.accent).toBe("#C4653F");
    expect(light.accentDeep).toBe("#B45330");
    // Dark: the tiers collapse into the resolved dark accent.
    expect(dark.accent).toBe("#D98A63");
    expect(dark.accentDeep).toBe("#D98A63");
    // Clay's accentText is the explicit hard pin (4.98:1 light / 6.30:1 dark).
    expect(light.accentText).toBe("#FFFFFF");
    expect(dark.accentText).toBe("#211B16");
    // A theme without accentDeep resolves to its own accent (identity).
    const novaLight = deriveThemeStyles("nova", false);
    expect(novaLight.accentDeep).toBe("#FF6B2C");
  });

  it("the ink ladder is the mobile R117-g1 tier (tertiary holds AA)", () => {
    const light = deriveThemeStyles("clay", false);
    const dark = deriveThemeStyles("clay", true);
    expect(light.textSecondary).toBe("rgba(0,0,0,0.62)");
    expect(light.textTertiary).toBe("rgba(0,0,0,0.57)");
    expect(dark.textSecondary).toBe("rgba(255,255,255,0.62)");
    expect(dark.textTertiary).toBe("rgba(255,255,255,0.52)");
  });

  it("the well / header / tint / rim / mono surfaces resolve mode-aware", () => {
    const light = deriveThemeStyles("clay", false);
    const dark = deriveThemeStyles("clay", true);
    // The recessed well: 8% clay taupe into card light / 5% white dark.
    expect(light.surfaceWell).toBe("#F4F1EE");
    expect(dark.surfaceWell).toBe("#3D3731");
    // The header chrome shade: bg +6% warm ink light / +30% black dark.
    expect(light.surfaceHeader).toBe("#E0E2DC");
    expect(dark.surfaceHeader).toBe("#17130F");
    // The accent tint: 12% accent into card light / 18% dark.
    expect(light.accentTint).toBe("#F6EBE4");
    expect(dark.accentTint).toBe("#513D31");
    // The rim: 10% ink into card light / 10% white dark; the top edge is
    // the dark-mode-only device (14% white).
    expect(light.clayRim).toBe("#E8E7E4");
    expect(dark.clayRim).toBe("rgba(255,255,255,0.10)");
    expect(dark.clayTopEdge).toBe("#504A44");
    // Mono surfaces.
    expect(light.monoBg).toBe("#F0F0ED");
    expect(light.monoText).toBe("#3A2E22");
    expect(dark.monoBg).toBe("rgba(0,0,0,0.22)");
    expect(dark.monoText).toBe("rgba(242,235,225,0.92)");
  });

  it("the badge tones are the tinted containers with deep/bright ink", () => {
    const light = deriveThemeStyles("clay", false);
    const dark = deriveThemeStyles("clay", true);
    // 12% of the flat hue into the card light (the mobile #E3F6E8 success
    // container) with the deep green ink.
    expect(light.badgeTones.success.bg).toBe("#E3F6E8");
    expect(light.badgeTones.success.fg).toBe("#166534");
    // 20% into the card dark with the bright ink.
    expect(dark.badgeTones.success.fg).toBe("#4ADE80");
    // The accent tone is the deep fill + contrast ink pair.
    expect(light.badgeTones.accent.bg).toBe("#B45330");
    expect(light.badgeTones.accent.fg).toBe("#FFFFFF");
    // The neutral tone rides the well.
    expect(light.badgeTones.neutral.bg).toBe("#F4F1EE");
    // The deep/bright status pairs.
    expect(light.dangerDeep).toBe("#DC2626");
    expect(dark.dangerDeep).toBe("#F87171");
    expect(light.runningDeep).toBe("#1D4ED8");
    expect(dark.runningDeep).toBe("#93C5FD");
  });

  it("the new tokens ride the :root CSS-var bridge (syncThemeCssVars)", () => {
    syncThemeCssVars(deriveThemeStyles("clay", false));
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--ac-accent-deep")).toBe("#B45330");
    expect(root.getPropertyValue("--ac-surface-well")).toBe("#F4F1EE");
    expect(root.getPropertyValue("--ac-surface-header")).toBe("#E0E2DC");
    expect(root.getPropertyValue("--ac-accent-tint")).toBe("#F6EBE4");
    expect(root.getPropertyValue("--ac-clay-rim")).toBe("#E8E7E4");
    expect(root.getPropertyValue("--ac-clay-shadow-pressed")).toContain("rgba(38,34,28,");
    expect(root.getPropertyValue("--ac-clay-shadow-sheet")).toContain("0px -2px 6px");
    expect(root.getPropertyValue("--ac-mono-bg")).toBe("#F0F0ED");
    expect(root.getPropertyValue("--ac-badge-success-bg")).toBe("#E3F6E8");
    expect(root.getPropertyValue("--ac-badge-accent-bg")).toBe("#B45330");
    expect(root.getPropertyValue("--ac-badge-neutral-fg")).toBe("rgba(0,0,0,0.62)");
  });
});
