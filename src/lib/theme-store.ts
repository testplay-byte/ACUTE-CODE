import { useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { deriveThemeStyles, syncThemeCssVars, THEMES } from "./themes";

/**
 * Theme state store — absorbed into the demo-fidelity theme engine
 * (src/lib/themes.ts + use-theme-styles.ts). This module keeps its original
 * public surface so existing consumers (Settings appearance panel, main.tsx
 * pre-paint sync) keep working unchanged:
 *
 * - THEMES now re-exports the full ThemeColors table (superset of the old
 *   {id, name, accent} shape Settings reads).
 * - applyTheme() mirrors themeId/mode onto <html data-theme data-mode> AND
 *   bridges the derived palette onto :root as --ac-* custom properties before
 *   first paint.
 */
export { THEMES };
export type ThemeId = string;
export type ThemeMode = "light" | "dark";
/** ROUND-34 (settings appearance page): layout density + sidebar tint strength. */
export type Density = "comfortable" | "compact";
export type SidebarTint = "subtle" | "warm" | "bold";
/** ROUND-35 (owner: "in the settings I would like to see the ability of the
 * tool calls preferences"): how agent tool activity renders in the chat. */
export type ActivityMode = "detailed" | "compact" | "hidden";

interface ThemeState {
  themeId: ThemeId;
  mode: ThemeMode;
  density: Density;
  sidebarTint: SidebarTint;
  activityMode: ActivityMode;
  setTheme: (id: ThemeId) => void;
  setMode: (mode: ThemeMode) => void;
  toggleMode: () => void;
  setDensity: (density: Density) => void;
  setSidebarTint: (tint: SidebarTint) => void;
  setActivityMode: (mode: ActivityMode) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      themeId: "nova",
      mode: "dark",
      density: "comfortable",
      sidebarTint: "subtle",
      activityMode: "detailed",
      setTheme: (themeId) => set({ themeId }),
      setMode: (mode) => set({ mode }),
      toggleMode: () => set((s) => ({ mode: s.mode === "dark" ? "light" : "dark" })),
      setDensity: (density) => set({ density }),
      setSidebarTint: (sidebarTint) => set({ sidebarTint }),
      setActivityMode: (activityMode) => set({ activityMode }),
    }),
    // version stays 1: zustand shallow-merges persisted state over the new
    // defaults, so existing users keep their theme/mode and gain the defaults.
    { name: "acute-code.theme", version: 1 },
  ),
);

/** Mirror the store onto <html> attributes + :root --ac-* vars; run pre-paint. */
export function applyTheme(themeId: ThemeId, mode: ThemeMode, sidebarTint?: SidebarTint) {
  const root = document.documentElement;
  root.dataset.theme = themeId;
  root.dataset.mode = mode;
  // Unknown ids fall back to THEMES[0] inside deriveThemeStyles, so a stale
  // persisted id can never leave the bridge unstyled.
  syncThemeCssVars(deriveThemeStyles(themeId, mode === "dark", sidebarTint));
}

/** Subscribe the document to the store for the app's lifetime. */
export function useThemeSync() {
  const themeId = useThemeStore((s) => s.themeId);
  const mode = useThemeStore((s) => s.mode);
  const sidebarTint = useThemeStore((s) => s.sidebarTint);
  useEffect(() => {
    applyTheme(themeId, mode, sidebarTint);
  }, [themeId, mode, sidebarTint]);
}
