import { useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Accent theme catalog (ids/names/accents mirror the CSS token blocks in
 * src/index.css — nova + bento from the owner's dashboard demo). The colors
 * here are for UI chrome (swatch dots); the real palette lives in CSS.
 */
export const THEMES = [
  { id: "nova", name: "Nova", accent: "#ff6b2c" },
  { id: "bento", name: "Bento", accent: "#6366f1" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
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

/** Mirror the store onto <html data-theme data-mode>; call before first paint. */
export function applyTheme(themeId: ThemeId, mode: ThemeMode) {
  const root = document.documentElement;
  root.dataset.theme = themeId;
  root.dataset.mode = mode;
}

/** Subscribe the document to the store for the app's lifetime. */
export function useThemeSync() {
  const themeId = useThemeStore((s) => s.themeId);
  const mode = useThemeStore((s) => s.mode);
  useEffect(() => {
    applyTheme(themeId, mode);
  }, [themeId, mode]);
}
