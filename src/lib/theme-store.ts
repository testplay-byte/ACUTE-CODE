import { useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { deriveThemeStyles, syncThemeCssVars, THEMES } from "./themes";

/**
 * Theme state store — absorbed into the demo-fidelity theme engine
 * (src/lib/themes.ts + use-theme-styles.ts). This module keeps its original
 * public surface so existing consumers (TopBar theme toggles, main.tsx
 * pre-paint sync) keep working unchanged:
 *
 * - THEMES now re-exports the full ThemeColors table (superset of the old
 *   {id, name, accent} shape TopBar reads).
 * - applyTheme() mirrors themeId/mode onto <html data-theme data-mode> AND
 *   bridges the derived palette onto :root as --ac-* custom properties before
 *   first paint.
 */
export { THEMES };
export type ThemeId = string;
export type ThemeMode = "light" | "dark";

interface ThemeState {
  themeId: ThemeId;
  mode: ThemeMode;
  setTheme: (id: ThemeId) => void;
  setMode: (mode: ThemeMode) => void;
  toggleMode: () => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      themeId: "nova",
      mode: "dark",
      setTheme: (themeId) => set({ themeId }),
      setMode: (mode) => set({ mode }),
      toggleMode: () => set((s) => ({ mode: s.mode === "dark" ? "light" : "dark" })),
    }),
    { name: "acute-code.theme", version: 1 },
  ),
);

/** Mirror the store onto <html> attributes + :root --ac-* vars; run pre-paint. */
export function applyTheme(themeId: ThemeId, mode: ThemeMode) {
  const root = document.documentElement;
  root.dataset.theme = themeId;
  root.dataset.mode = mode;
  // Unknown ids fall back to THEMES[0] inside deriveThemeStyles, so a stale
  // persisted id can never leave the bridge unstyled.
  syncThemeCssVars(deriveThemeStyles(themeId, mode === "dark"));
}

/** Subscribe the document to the store for the app's lifetime. */
export function useThemeSync() {
  const themeId = useThemeStore((s) => s.themeId);
  const mode = useThemeStore((s) => s.mode);
  useEffect(() => {
    applyTheme(themeId, mode);
  }, [themeId, mode]);
}
