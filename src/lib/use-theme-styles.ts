import { useEffect, useMemo } from "react";
import { useThemeStore } from "./theme-store";
import { deriveThemeStyles, syncThemeCssVars, type ThemeStyles } from "./themes";

/**
 * Central hook returning all dark/light-mode-aware style values.
 * Faithful port of the design demo's lib/use-theme-styles.ts
 * (design/demos/acute-agent-ui/acute-agent-ui) — same returned key set,
 * {theme, isDark, isMono, bg, card, text, accent, accentText, border,
 * borderStrong, borderSubtle, subtle, subtleHover, inputBg, inputBorder,
 * inputFocusBorder, bentoShadow, bentoShadowSm, softShadow, primaryBtnShadow,
 * textSecondary, textTertiary, pillBg, pillText, toggleTrack, toggleActive,
 * dotColor} — backed by the persisted app-wide theme store instead of the
 * demo's onboarding-only one, so every screen shares one palette.
 *
 * Every component should use this instead of hard-coding colors. As a side
 * effect it keeps the :root --ac-* CSS-variable bridge in sync (see
 * deriveThemeStyles/syncThemeCssVars in themes.ts).
 */
export function useThemeStyles(): ThemeStyles {
  const themeId = useThemeStore((s) => s.themeId);
  const mode = useThemeStore((s) => s.mode);
  const isDark = mode === "dark";

  const styles = useMemo(
    () => deriveThemeStyles(themeId, isDark),
    [themeId, isDark],
  );

  // Keep the CSS-variable bridge current even if applyTheme wasn't the last
  // writer (idempotent; main.tsx's useThemeSync writes the same values).
  useEffect(() => {
    syncThemeCssVars(styles);
  }, [styles]);

  return styles;
}
