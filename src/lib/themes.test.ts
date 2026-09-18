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
    // The full set is present in both modes.
    for (const mode of [light, dark]) {
      expect(mode["--ac-chrome-sheen"]).toBeTruthy();
    }
  });

  it("is theme-independent — the same platinum on clay and nova", () => {
    syncThemeCssVars(deriveThemeStyles("clay", false));
    const onClay = pickChromeVars();
    syncThemeCssVars(deriveThemeStyles("nova", false));
    const onNova = pickChromeVars();
    expect(onClay).toEqual(onNova);
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
