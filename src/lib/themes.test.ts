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
    expect(light.bg).toBe("#F4EEE5");
    expect(light.card).toBe("#FDFBF7");
    expect(light.text).toBe("#2A2018");
    // (isMono is deliberately NOT asserted here: happy-dom ships no canvas
    // 2d context, so parseColor degrades to [0,0,0] and achromaticAccent
    // reads every accent as achromatic under the test runner. In a real
    // browser #C4653F's chroma is 0.68 — far off the 0.08 mono line.)

    const dark = deriveThemeStyles("clay", true);
    expect(dark.accent).toBe("#D98A63"); // accentDark lifts for dark-mode legibility
    expect(dark.bg).toBe("#26211C");
    expect(dark.card).toBe("#2F2924");
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
    // rgba(42,32,24,…), never cold black — hand-thrown ceramics cast warm
    // shadows (the R108-e rework's whole point).
    expect(light["--ac-clay-shadow"]).toContain("rgba(42,32,24,");
    expect(light["--ac-clay-shadow-sm"]).toContain("rgba(42,32,24,");
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
