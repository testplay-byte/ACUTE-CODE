import { useMemo } from 'react';
import { useOnboardingStore } from './onboarding-store';
import { THEMES } from './onboarding-types';
import { getContrastText } from './color-utils';

/**
 * Central hook that returns all dark/light-mode-aware style values.
 * Every onboarding component should use this instead of hard-coding colors.
 */
export function useThemeStyles() {
  const themeId = useOnboardingStore((s) => s.themeId);
  const isDark = useOnboardingStore((s) => s.isDark);

  return useMemo(() => {
    const theme = THEMES.find((t) => t.id === themeId) ?? THEMES[0];
    const isMono = theme.id === 'mono';
    const accentText = getContrastText(theme.accent);

    return {
      theme,
      isDark,
      isMono,
      // ── Core ──────────────────────────────────────────────
      bg: isDark ? theme.bgDark : theme.bgLight,
      card: isDark ? theme.cardDark : theme.cardLight,
      text: isDark ? theme.textDark : theme.textLight,
      accent: theme.accent,
      accentText,

      // ── Borders ───────────────────────────────────────────
      border: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)',
      borderStrong: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)',
      borderSubtle: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',

      // ── Subtle fills ─────────────────────────────────────
      subtle: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
      subtleHover: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',

      // ── Inputs ───────────────────────────────────────────
      inputBg: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.02)',
      inputBorder: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)',
      inputFocusBorder: isDark ? 'rgba(255,255,255,0.30)' : 'rgba(0,0,0,0.90)',

      // ── Shadows ──────────────────────────────────────────
      bentoShadow: isDark
        ? '4px 4px 0px 0px rgba(255,255,255,0.08)'
        : '4px 4px 0px 0px black',
      bentoShadowSm: isDark
        ? '3px 3px 0px 0px rgba(255,255,255,0.06)'
        : '3px 3px 0px 0px black',
      softShadow: isDark
        ? '0 8px 32px rgba(0,0,0,0.3), 0 2px 8px rgba(0,0,0,0.2)'
        : '0 8px 32px rgba(0,0,0,0.06), 0 2px 8px rgba(0,0,0,0.04)',

      // ── Text helpers ─────────────────────────────────────
      textSecondary: isDark
        ? 'rgba(255,255,255,0.60)'
        : 'rgba(0,0,0,0.60)',
      textTertiary: isDark
        ? 'rgba(255,255,255,0.40)'
        : 'rgba(0,0,0,0.40)',

      // ── Pill / badge ─────────────────────────────────────
      pillBg: isDark ? 'rgba(255,255,255,0.10)' : 'black',
      pillText: isDark ? theme.textDark : 'white',

      // ── Buttons ──────────────────────────────────────────
      primaryBtnShadow: isDark
        ? '3px 3px 0px 0px rgba(255,255,255,0.08)'
        : '3px 3px 0px 0px black',

      // ── Toggle ───────────────────────────────────────────
      toggleTrack: isDark
        ? 'rgba(255,255,255,0.08)'
        : 'rgba(0,0,0,0.04)',
      toggleActive: isDark ? 'white' : 'black',

      // ── Dot grid ─────────────────────────────────────────
      dotColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
    };
  }, [themeId, isDark]);
}
