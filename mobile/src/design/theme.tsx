/**
 * ThemeProvider + useTheme — the theme's runtime leg (R1 §6): system-follow
 * PLUS a manual override, both persisted; the resolved token palette flows
 * through React context so every screen reads ONE shape (`ResolvedTheme`).
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useColorScheme } from "react-native";
import { ResolvedTheme, getTheme, resolveTheme } from "./tokens";

export type ThemeMode = "system" | "light" | "dark";

const PREFS_KEY_THEME = "acute.prefs.themeId";
const PREFS_KEY_MODE = "acute.prefs.mode";

export interface ThemeContextValue {
  /** The resolved, mode-aware palette — what screens actually consume. */
  tokens: ResolvedTheme;
  /** The raw theme id ("nova" | "bento" | "midnight" | "sunset" | "mono"). */
  themeId: string;
  /** "system" follows the OS; "light"/"dark" pin the mode manually. */
  mode: ThemeMode;
  /** The mode the system reports (useful for the settings row's caption). */
  systemIsDark: boolean;
  setTheme: (themeId: string) => void;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [themeId, setThemeIdState] = useState<string>("nova");
  const [mode, setModeState] = useState<ThemeMode>("system");

  // Load the persisted prefs once. Prefs are cosmetic — a failed read keeps
  // the defaults (splash covers the first frame).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [storedTheme, storedMode] = await Promise.all([
          AsyncStorage.getItem(PREFS_KEY_THEME),
          AsyncStorage.getItem(PREFS_KEY_MODE),
        ]);
        if (!alive) return;
        if (storedTheme !== null && getTheme(storedTheme).id === storedTheme) {
          setThemeIdState(storedTheme);
        }
        if (storedMode === "system" || storedMode === "light" || storedMode === "dark") {
          setModeState(storedMode);
        }
      } catch {
        // Prefs are cosmetic — a failed read keeps the defaults, honestly.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const setTheme = useCallback((nextThemeId: string) => {
    setThemeIdState(getTheme(nextThemeId).id);
    void AsyncStorage.setItem(PREFS_KEY_THEME, nextThemeId).catch(() => {});
  }, []);

  const setMode = useCallback((nextMode: ThemeMode) => {
    setModeState(nextMode);
    void AsyncStorage.setItem(PREFS_KEY_MODE, nextMode).catch(() => {});
  }, []);

  const systemIsDark = systemScheme === "dark";
  const isDark = mode === "system" ? systemIsDark : mode === "dark";
  const tokens = useMemo(() => resolveTheme(themeId, isDark), [themeId, isDark]);

  const value = useMemo<ThemeContextValue>(
    () => ({ tokens, themeId, mode, systemIsDark, setTheme, setMode }),
    [tokens, themeId, mode, systemIsDark, setTheme, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === null) {
    throw new Error("useTheme must be used inside <ThemeProvider>");
  }
  return ctx;
}
