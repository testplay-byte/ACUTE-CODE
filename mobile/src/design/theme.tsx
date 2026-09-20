/**
 * ThemeProvider + useTheme — the theme's runtime leg: system-follow PLUS a
 * manual override, both persisted; the resolved token palette flows through
 * React context so every screen reads ONE shape (`ResolvedTheme`).
 *
 * ROUND-109: the provider also owns the HOUSE FONTS gate — Manrope 400–800
 * + JetBrains Mono load via useFonts BEFORE the children paint (the splash
 * covers the gap; `fontsReady` lets the root hold the first frame). The
 * default theme is now Clay Studio (the owner's R109 direction).
 *
 * ROUND-113 (R113-e — the phone's live-sync round): the appearance became
 * SERVER-BACKED. The local AsyncStorage prefs stay the offline fallback
 * (instant boot, never a spinner); when the link is up the server wins:
 * the sync leg (features/appearance-sync.ts, mounted by the provider)
 * hydrates GET /settings/appearance on every (re)connect + hello, applies
 * {domain:"appearance"} settings frames LIVE as they land off the events
 * stream, and every local setTheme/setMode optimistically PUTs the domain
 * (the write-through). The ECHO GUARD lives in appearance-sync: applying a
 * server value suppresses the PUT-back — otherwise the phone would PUT the
 * value it just received, the sidecar would broadcast another frame, and
 * the devices would loop forever. The six-theme token system is untouched —
 * this changes WHERE the preference comes from, not what it drives.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  Manrope_800ExtraBold,
} from "@expo-google-fonts/manrope";
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
} from "@expo-google-fonts/jetbrains-mono";
import { useFonts } from "expo-font";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useColorScheme } from "react-native";
import { DEFAULT_THEME_ID, ResolvedTheme, getTheme, resolveTheme } from "./tokens";

export type ThemeMode = "system" | "light" | "dark";

// ── R113-e: the appearance domain's wire value (the server pair lives in
// features/appearance-sync.ts; the parser stays HERE — the theme module owns
// the vocabulary) ─────────────────────────────────────────────────────────

/** GET/PUT /settings/appearance's value: the six shared flavor ids or null
 * (null = "no server preference" — the local flavor stands), plus the
 * three-mode enum. */
export interface AppearanceValue {
  themeId: string | null;
  mode: ThemeMode;
}

/** Shape-check a server appearance value — null when malformed (a
 * non-object, a non-string/non-null themeId, or a mode outside the enum —
 * never a guess, never a crash). Pure. */
export function parseAppearanceValue(value: unknown): AppearanceValue | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const themeId = raw.themeId;
  if (themeId !== null && typeof themeId !== "string") return null;
  const mode = raw.mode;
  if (mode !== "system" && mode !== "light" && mode !== "dark") return null;
  return { themeId: themeId as string | null, mode };
}

const PREFS_KEY_THEME = "acute.prefs.themeId";
const PREFS_KEY_MODE = "acute.prefs.mode";

export interface ThemeContextValue {
  /** The resolved, mode-aware palette — what screens actually consume. */
  tokens: ResolvedTheme;
  /** The raw theme id ("clay" | "nova" | "bento" | "midnight" | "sunset" | "mono"). */
  themeId: string;
  /** "system" follows the OS; "light"/"dark" pin the mode manually. */
  mode: ThemeMode;
  /** The mode the system reports (useful for the settings row's caption). */
  systemIsDark: boolean;
  setTheme: (themeId: string) => void;
  setMode: (mode: ThemeMode) => void;
  /** R113-e: apply a SERVER-pushed appearance value (the sync leg calls
   * this — hydrations and live frames both land here; the echo guard in
   * appearance-sync suppresses the write-through PUT). Returns whether a
   * valid value applied. */
  applyServerAppearance: (value: unknown) => boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [themeId, setThemeIdState] = useState<string>(DEFAULT_THEME_ID);
  const [mode, setModeState] = useState<ThemeMode>("system");

  // The house fonts (DESIGN.md §4). Cosmetic-fail-open: if a weight fails to
  // load the platform stack still renders — but in practice useFonts resolves
  // from the bundled assets synchronously-fast.
  const [fontsLoaded] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Manrope_800ExtraBold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
  });

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

  /**
   * R113-e: the optimistic write-through — push one local appearance change
   * to the server. The lazy requires keep this module's EVAL free of the
   * link layer (tests + the boot order never pay for it); the push itself
   * is fire-and-forget, connection-gated, and echo-guarded inside
   * appearance-sync (applying a remote value suppresses the PUT-back).
   */
  const pushAppearance = useCallback((patch: { themeId?: string; mode?: ThemeMode }) => {
    try {
      const { getLinkManager } = require("../link/runtime") as typeof import("../link/runtime");
      const { pushAppearancePatch } = require("../features/appearance-sync") as typeof import("../features/appearance-sync");
      pushAppearancePatch(getLinkManager(), patch);
    } catch {
      // unpaired / not yet started — the local flip stands as the offline
      // fallback; the next successful PUT re-converges the devices.
    }
  }, []);

  const setTheme = useCallback((nextThemeId: string) => {
    setThemeIdState(getTheme(nextThemeId).id);
    void AsyncStorage.setItem(PREFS_KEY_THEME, nextThemeId).catch(() => {});
    // R113-e: the optimistic write-through — the local flip already applied;
    // the PUT is fire-and-forget and guarded against the remote echo.
    pushAppearance({ themeId: nextThemeId });
  }, [pushAppearance]);

  const setMode = useCallback((nextMode: ThemeMode) => {
    setModeState(nextMode);
    void AsyncStorage.setItem(PREFS_KEY_MODE, nextMode).catch(() => {});
    pushAppearance({ mode: nextMode }); // the same write-through
  }, [pushAppearance]);

  /** R113-e: the remote path — hydrations and live frames both land here.
   * The echo guard (appearance-sync) suppresses the PUT while the control's
   * setters run, so applying a server value never writes it back. */
  const applyServerAppearance = useCallback(
    (value: unknown): boolean => {
      const { applyServerAppearanceValue } = require("../features/appearance-sync") as typeof import("../features/appearance-sync");
      return applyServerAppearanceValue(value, { setTheme, setMode });
    },
    [setTheme, setMode],
  );

  const systemIsDark = systemScheme === "dark";
  const isDark = mode === "system" ? systemIsDark : mode === "dark";
  const tokens = useMemo(() => resolveTheme(themeId, isDark), [themeId, isDark]);

  const value = useMemo<ThemeContextValue>(
    () => ({ tokens, themeId, mode, systemIsDark, setTheme, setMode, applyServerAppearance }),
    [tokens, themeId, mode, systemIsDark, setTheme, setMode, applyServerAppearance],
  );

  // Hold the tree (opacity handled by the root) until fonts are in — the
  // first painted frame then carries the house typography.
  if (!fontsLoaded) return null;

  return (
    <ThemeContext.Provider value={value}>
      {/* R113-e: the appearance live-sync leg — hydrate on (re)connect +
          hello, apply settings/appearance frames as they land. A null render
          INSIDE the provider so it can reach the context's remote-apply. */}
      <AppearanceSyncLeg />
      {children}
    </ThemeContext.Provider>
  );
}

/**
 * R113-e: the appearance sync leg — the provider's own child so it can read
 * the context. Mounts startAppearanceSync (features/appearance-sync.ts) for
 * the app's lifetime: GET /settings/appearance on every (re)connect + hello
 * (the server wins when reachable) and live application of appearance
 * settings frames off the events store. The lazy requires keep the theme
 * module's eval free of the link/events layer.
 */
function AppearanceSyncLeg() {
  const { applyServerAppearance } = useTheme();
  useEffect(() => {
    try {
      const { getLinkManager } = require("../link/runtime") as typeof import("../link/runtime");
      const { getEventsStore } = require("../features/events") as typeof import("../features/events");
      const { startAppearanceSync } = require("../features/appearance-sync") as typeof import("../features/appearance-sync");
      return startAppearanceSync(applyServerAppearance, {
        manager: getLinkManager(),
        events: getEventsStore(),
      });
    } catch {
      return undefined; // unpaired-boot edge — the local prefs stand
    }
  }, [applyServerAppearance]);
  return null;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === null) {
    throw new Error("useTheme must be used inside <ThemeProvider>");
  }
  return ctx;
}
