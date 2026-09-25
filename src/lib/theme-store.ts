import { useEffect, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { deriveThemeStyles, syncThemeCssVars, THEMES } from "./themes";
// ROUND-113 (R113-b): the appearance domain's server pair — hydration on
// boot, optimistic write-through on every local flip. api.ts's graph never
// imports this module (verified: fixtures/config-store/sidecar only), so the
// edge is acyclic.
import { fetchAppearanceSettings, updateAppearanceSettings } from "./api";
import { useConfigStore } from "./config-store";

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
 *
 * ROUND-113 (R113-b, the live-sync round): the mode gains "system" (resolved
 * against prefers-color-scheme at apply time — <html data-mode> only ever
 * carries the RESOLVED "light"/"dark", because index.css keys on those two
 * spellings) and the whole appearance became SERVER-BACKED: boot hydrates
 * from GET /settings/appearance (local values stay the offline fallback),
 * every local setTheme/setMode optimistically PUTs the domain, and a
 * settings-event frame pushes another device's change straight into the store
 * (the write-through is suppressed while applying a remote value — the echo
 * guard; otherwise the desktop would PUT back the value it just received,
 * bouncing the bus frame to every other device forever).
 */
export { THEMES };
export type ThemeId = string;
/** R113-b: "system" follows the OS (prefers-color-scheme) — resolved at
 * apply/render time, never persisted resolved (an OS flip while the app is
 * open re-resolves live). Existing persisted "light"/"dark" values stay
 * valid; version stays 1 (zustand shallow-merges them over the default). */
export type ThemeMode = "light" | "dark" | "system";
/** ROUND-34 (settings appearance page): layout density + sidebar tint strength. */
export type Density = "comfortable" | "compact";
export type SidebarTint = "subtle" | "warm" | "bold";
/** ROUND-35 (owner: "in the settings I would like to see the ability of the
 * tool calls preferences"): how agent tool activity renders in the chat. */
export type ActivityMode = "detailed" | "compact" | "hidden";
/** ROUND-97 (R97-H, owner: the chat window's "overall functionality,
 * usability, customizability"): the chat text size — small/medium/large ride
 * a CSS variable on the transcript root so every text row scales together
 * (the answer text, the thinking block, the tool lines). Default medium =
 * the pre-R97 sizes byte-identical. */
export type ChatTextSize = "small" | "medium" | "large";
/** R97-H: message timestamps — a hover-visible time chip per bubble when on
 * (default off = the current clean look). */
export type TimestampsMode = "hidden" | "hover";

interface ThemeState {
  themeId: ThemeId;
  mode: ThemeMode;
  density: Density;
  sidebarTint: SidebarTint;
  activityMode: ActivityMode;
  /** R97-H: the chat customizability pair. */
  chatTextSize: ChatTextSize;
  timestampsMode: TimestampsMode;
  setTheme: (id: ThemeId) => void;
  setMode: (mode: ThemeMode) => void;
  toggleMode: () => void;
  setDensity: (density: Density) => void;
  setSidebarTint: (sidebarTint: SidebarTint) => void;
  setActivityMode: (mode: ActivityMode) => void;
  setChatTextSize: (size: ChatTextSize) => void;
  setTimestampsMode: (mode: TimestampsMode) => void;
}

// ── R113-b: server-backed appearance ────────────────────────────────────────

/**
 * The echo guard: true while a server-pushed/hydrated value is being applied
 * through setTheme/setMode. The write-through in those actions checks this
 * flag and skips the PUT — otherwise applying {"themeId":"bento"} from the
 * events stream would PUT {"themeId":"bento"} right back, the sidecar would
 * broadcast another settings frame, and every device would loop forever.
 */
let applyingRemoteAppearance = false;

/** The boot hydration's memo — null until hydrateAppearanceFromServer() is
 * first called (the hydrateLinkOpeningMode pattern). */
let appearanceHydration: Promise<void> | null = null;

/**
 * R113-b: push one local appearance change to the server. Fire-and-forget
 * and STRICTLY optional — the local flip already applied (optimistic; the
 * server is a sync backbone, not the source of truth for THIS device's
 * clicks). Skipped while applying a remote value (the echo guard) and in
 * demo/unauthenticated mode (no sidecar to sync with). A failed PUT is a
 * silent no-op: the local value stays, the next successful PUT re-converges
 * the devices.
 * ROUND-114 (R114-e): the patch widened to the FULL six-field domain — the
 * four chat-density fields (chatDensity/chatTextSize/timestampsMode/
 * toolActivity) write through exactly like themeId/mode always have, so the
 * PC's Settings → Appearance flips land on the phone and vice versa
 * (sidebarTint stays local-only: it is not part of the server domain). */
function pushAppearanceToServer(patch: {
  themeId?: string;
  mode?: ThemeMode;
  chatDensity?: Density;
  chatTextSize?: ChatTextSize;
  timestampsMode?: TimestampsMode;
  toolActivity?: ActivityMode;
}): void {
  if (applyingRemoteAppearance) return; // echo guard — see the doc above
  const { demoData, token } = useConfigStore.getState();
  if (demoData || !token) return;
  void updateAppearanceSettings(patch).catch(() => undefined);
}

/**
 * R113-b: apply a SERVER-pushed appearance value (the boot hydration AND the
 * events-stream settings frame both land here — one path, one echo guard).
 * Shape-checked, never trusted: a non-object value, an unknown mode or a
 * non-string themeId is ignored (never a reason to guess). themeId === null
 * means "no server preference" — the local flavor stands (the R113-a GET
 * default); a non-null id applies. Invalidates nothing: zustand's set
 * notifies useThemeSync/useThemeStyles subscribers and the palette applies
 * on their re-render.
 * ROUND-114 (R114-e): the FULL six-field domain applies here — every PRESENT
 * chat-density field (chatDensity/chatTextSize/timestampsMode/toolActivity)
 * rides the same echo-guarded application, so a phone-side flip lands on the
 * desktop live (and the boot hydration converges the fields like `mode`
 * always converged). Validation posture: a present-but-INVALID value rejects
 * the WHOLE frame (malformed is malformed — a half-applied patch would leave
 * the devices disagreeing); an ABSENT field simply doesn't touch its local
 * twin (the pre-R114-b server omits all four — every local value stands,
 * which is byte-identical because the server defaults match the local ones).
 */
export function applyServerAppearance(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const raw = value as {
    themeId?: unknown;
    mode?: unknown;
    chatDensity?: unknown;
    chatTextSize?: unknown;
    timestampsMode?: unknown;
    toolActivity?: unknown;
  };
  const themeId = raw.themeId;
  const mode = raw.mode;
  if (
    themeId !== undefined &&
    themeId !== null &&
    typeof themeId !== "string"
  ) {
    return;
  }
  if (
    mode !== undefined &&
    mode !== "system" &&
    mode !== "light" &&
    mode !== "dark"
  ) {
    return;
  }
  // R114-e: the four chat-density vocabularies — same strict per-field
  // check, same reject-the-whole-frame posture (see the doc above).
  if (
    raw.chatDensity !== undefined &&
    raw.chatDensity !== "comfortable" &&
    raw.chatDensity !== "compact"
  ) {
    return;
  }
  if (
    raw.chatTextSize !== undefined &&
    raw.chatTextSize !== "small" &&
    raw.chatTextSize !== "medium" &&
    raw.chatTextSize !== "large"
  ) {
    return;
  }
  if (
    raw.timestampsMode !== undefined &&
    raw.timestampsMode !== "hidden" &&
    raw.timestampsMode !== "hover"
  ) {
    return;
  }
  if (
    raw.toolActivity !== undefined &&
    raw.toolActivity !== "detailed" &&
    raw.toolActivity !== "compact" &&
    raw.toolActivity !== "hidden"
  ) {
    return;
  }
  applyingRemoteAppearance = true;
  // R126 (the Clay Companion redesign — the SERVER leg of the one-time
  // nova→clay identity migration): a server "nova" from a pre-redesign
  // install would resurrect the retired default right after the local
  // persist migration flipped it to clay (boot hydrates from the server
  // AFTER zustand rehydrates localStorage). The guard maps server "nova"
  // to clay EXACTLY ONCE per profile — a dedicated localStorage flag (not
  // the persist version: this boundary also serves the live events frame).
  // The flag is set inside the echo-guarded block, but the SERVER
  // convergence push runs AFTER the guard lifts (pushAppearanceToServer is
  // a no-op while applyingRemoteAppearance is true — the echo guard exists
  // precisely so an applied remote value never bounces back; the migration
  // push is the ONE sanctioned counter-push, and it must actually fire or
  // the next boot's flag-set hydration would apply the stale server
  // "nova" verbatim). A deliberate nova picked AFTER the flag is set rides
  // untouched forever.
  let appliedThemeId = typeof themeId === "string" ? themeId : undefined;
  let r126ConvergeServer = false;
  const R126_FLAG = "acute-code.theme.r126-nova-migrated";
  if (appliedThemeId === "nova") {
    let alreadyMigrated = false;
    try {
      alreadyMigrated =
        typeof localStorage !== "undefined" && localStorage.getItem(R126_FLAG) === "1";
    } catch {
      alreadyMigrated = false;
    }
    if (!alreadyMigrated) {
      appliedThemeId = "clay";
      r126ConvergeServer = true;
      try {
        if (typeof localStorage !== "undefined") {
          localStorage.setItem(R126_FLAG, "1");
        }
      } catch {
        // A refused flag store only means the guard may re-map once more
        // on the next boot — self-healing, never a crash.
      }
    }
  }
  try {
    if (appliedThemeId !== undefined) {
      useThemeStore.getState().setTheme(appliedThemeId);
    }
    if (mode === "system" || mode === "light" || mode === "dark") {
      useThemeStore.getState().setMode(mode);
    }
    // R114-e: every present chat field applies under the same guard (the
    // casts are narrowed by the validation ladder above).
    if (raw.chatDensity !== undefined) {
      useThemeStore.getState().setDensity(raw.chatDensity as Density);
    }
    if (raw.chatTextSize !== undefined) {
      useThemeStore.getState().setChatTextSize(raw.chatTextSize as ChatTextSize);
    }
    if (raw.timestampsMode !== undefined) {
      useThemeStore.getState().setTimestampsMode(raw.timestampsMode as TimestampsMode);
    }
    if (raw.toolActivity !== undefined) {
      useThemeStore.getState().setActivityMode(raw.toolActivity as ActivityMode);
    }
  } finally {
    applyingRemoteAppearance = false;
  }
  // R126: the migration's counter-push — OUTSIDE the echo guard so it
  // actually fires (see the block comment above). Fire-and-forget exactly
  // like every other push; a failed PUT leaves the flag set and the local
  // clay standing, and the NEXT deliberate flip re-converges the server.
  if (r126ConvergeServer) {
    pushAppearanceToServer({ themeId: "clay" });
  }
}

/**
 * R113-b: app-boot hydration — one best-effort GET /settings/appearance. The
 * server wins when reachable (themeId applied only when it carries a real
 * preference; mode applied outright — that IS the sync semantic); a failure
 * keeps the local persisted values (the offline fallback) and is silent.
 * Memoized: the second call returns the same settled promise (AppShell's
 * boot effect + any late test both converge on one request).
 */
export function hydrateAppearanceFromServer(): Promise<void> {
  if (appearanceHydration === null) {
    const { demoData, token } = useConfigStore.getState();
    appearanceHydration =
      demoData || !token
        ? Promise.resolve()
        : fetchAppearanceSettings()
            .then((settings) => {
              applyServerAppearance(settings);
            })
            .catch(() => undefined);
  }
  return appearanceHydration;
}

/** Test hook: forget the hydration memo so the next call re-fetches. */
export function resetAppearanceHydrationForTest(): void {
  appearanceHydration = null;
}

// ── system-mode resolution ─────────────────────────────────────────────────

/** The media query "system" mode resolves against. */
const PREFERS_DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * R113-b: resolve a ThemeMode to the concrete palette mode. "light"/"dark"
 * pass through; "system" reads the OS preference (matchMedia unavailable —
 * SSR/odd sandboxes — resolves LIGHT: the same default the CSS fallback
 * `:root:not([data-mode])` paints).
 */
export function resolveThemeMode(mode: ThemeMode): "light" | "dark" {
  if (mode === "dark") return "dark";
  if (mode === "light") return "light";
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    // Null-safe on the RESULT too: a half-implemented matchMedia (or a
    // mocked one returning undefined) must never throw — it resolves LIGHT,
    // the same default the CSS fallback `:root:not([data-mode])` paints.
    const mql = window.matchMedia(PREFERS_DARK_QUERY);
    if (mql !== null && mql !== undefined && mql.matches === true) {
      return "dark";
    }
  }
  return "light";
}

/**
 * R113-b: reactive prefers-color-scheme for any component (useThemeStyles,
 * useThemeSync, the mermaid diagram). Subscribes for the hook's lifetime and
 * re-renders on OS flips — a "system" desktop follows a live OS theme change
 * without re-opening settings. Cheap: one matchMedia listener per consumer.
 */
export function usePrefersColorSchemeDark(): boolean {
  const [dark, setDark] = useState(() => resolveThemeMode("system") === "dark");
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(PREFERS_DARK_QUERY);
    const onChange = () => setDark(mql.matches);
    // happy-dom/JSDOM-era safety: addEventListener is the standard path
    // (MediaQueryList has been an EventTarget everywhere since 2020); the
    // legacy addListener backstop keeps very old webviews correct too.
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    const legacy = mql as MediaQueryList & {
      addListener?: (cb: () => void) => void;
      removeListener?: (cb: () => void) => void;
    };
    legacy.addListener?.(onChange);
    return () => legacy.removeListener?.(onChange);
  }, []);
  return dark;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      // R126 (the Clay Companion redesign): clay is the app's identity
      // language now — the default flips from nova, and a ONE-TIME migration
      // (the version bump below) walks every existing profile off the
      // never-re-designed nova onto the new default ONCE. A user who
      // deliberately picks nova (or any other flavor) AFTER the migration
      // keeps that pick forever — the migration never runs again.
      themeId: "clay",
      mode: "dark",
      density: "comfortable",
      // R97-H: the defaults keep the pre-R97 look byte-identical.
      chatTextSize: "medium",
      timestampsMode: "hidden",
      sidebarTint: "subtle",
      activityMode: "detailed",
      // R113-b: every local flavor/mode flip ALSO pushes to the server
      // (optimistic write-through — see pushAppearanceToServer). The local
      // set stays the UX source: a failed PUT never rolls the click back.
      // ROUND-114 (R114-e): the four chat-density setters join the
      // write-through — density/text size/timestamps/tool activity now land
      // on every device watching this sidecar (the server domain's four new
      // fields, R114-b). sidebarTint stays local-only (not in the domain).
      setTheme: (themeId) => {
        set({ themeId });
        pushAppearanceToServer({ themeId });
      },
      setMode: (mode) => {
        set({ mode });
        pushAppearanceToServer({ mode });
      },
      // The onboarding flavor picker's light/dark toggle stays a CONCRETE
      // pick (never lands on "system" — that is the picker's whole point);
      // from "system" the first toggle resolves to the OS's opposite.
      // R113-b: the toggle write-throughs too — the wizard's flavor cards
      // PUT their themeId, so a mode flip that stayed local-only would
      // leave the server holding a stale mode for the next boot's
      // hydration to resurrect (the same convergence setTheme/setMode own).
      toggleMode: () =>
        set((s) => {
          const mode: ThemeMode = resolveThemeMode(s.mode) === "dark" ? "light" : "dark";
          pushAppearanceToServer({ mode });
          return { mode };
        }),
      setDensity: (density) => {
        set({ density });
        // R114-e: the server domain spells this field chatDensity.
        pushAppearanceToServer({ chatDensity: density });
      },
      setSidebarTint: (sidebarTint) => set({ sidebarTint }),
      setActivityMode: (activityMode) => {
        set({ activityMode });
        // R114-e: the server domain spells this field toolActivity.
        pushAppearanceToServer({ toolActivity: activityMode });
      },
      setChatTextSize: (chatTextSize) => {
        set({ chatTextSize });
        pushAppearanceToServer({ chatTextSize });
      },
      setTimestampsMode: (timestampsMode) => {
        set({ timestampsMode });
        pushAppearanceToServer({ timestampsMode });
      },
    }),
    // R126: version 1→2 — the ONE-TIME nova→clay identity migration. The
    // Clay Companion redesign changed the app's default language; profiles
    // still holding the pre-redesign nova default move to clay so they
    // actually SEE the redesign (a silent keep would have buried the new
    // language under persisted localStorage). Any OTHER persisted flavor is
    // a deliberate pick and rides untouched; after this migration runs the
    // profile is v2 forever and future defaults never re-clobber a choice.
    {
      name: "acute-code.theme",
      version: 2,
      migrate: (persisted, _version) => {
        const state = persisted as Partial<ThemeState> | undefined;
        if (state && state.themeId === "nova") {
          return { ...state, themeId: "clay" } as Partial<ThemeState>;
        }
        return state ?? {};
      },
    },
  ),
);

/**
 * Mirror the store onto <html> attributes + :root --ac-* vars; run pre-paint.
 * R113-b: a "system" mode RESOLVES here — data-mode only ever carries
 * "light"/"dark" (index.css keys its selector pairs on exactly those two
 * spellings), and the derived palette follows the resolved value.
 */
export function applyTheme(themeId: ThemeId, mode: ThemeMode, sidebarTint?: SidebarTint) {
  const resolved = resolveThemeMode(mode);
  const root = document.documentElement;
  root.dataset.theme = themeId;
  root.dataset.mode = resolved;
  // Unknown ids fall back to THEMES[0] inside deriveThemeStyles, so a stale
  // persisted id can never leave the bridge unstyled.
  syncThemeCssVars(deriveThemeStyles(themeId, resolved === "dark", sidebarTint));
}

/**
 * Subscribe the document to the store for the app's lifetime.
 * R113-b: while in "system" mode the OS preference is a RENDER input — an
 * OS theme flip re-runs the effect and re-applies the palette live (the
 * usePrefersColorSchemeDark subscription re-renders this component).
 */
export function useThemeSync() {
  const themeId = useThemeStore((s) => s.themeId);
  const mode = useThemeStore((s) => s.mode);
  const sidebarTint = useThemeStore((s) => s.sidebarTint);
  const systemDark = usePrefersColorSchemeDark();
  // Re-resolve on OS flips: `mode` alone would miss a system change.
  const resolved = mode === "system" ? (systemDark ? "dark" : "light") : mode;
  useEffect(() => {
    applyTheme(themeId, resolved, sidebarTint);
  }, [themeId, resolved, sidebarTint]);
}
