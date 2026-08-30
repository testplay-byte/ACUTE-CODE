/**
 * ROUND-50 (R50-a) — the NATIVE embedded browser bridge.
 *
 * Typed, safe wrappers over the Rust `browser_tab_*` commands (src-tauri/src/
 * browser.rs): one CHILD WEBVIEW per right-sidebar browser tab inside the main
 * app window (Tauri multiwebview — WebView2, which IS Chromium, on Windows).
 * The BrowserPanel positions each webview exactly over its page area; no
 * proxy, no tickets, full CSS/JS.
 *
 * Mirrors the sidecar.ts pattern: `window.__TAURI__` comes from
 * `withGlobalTauri` in tauri.conf.json, so no @tauri-apps/api dependency.
 * Tauri detection has ONE source of truth — `isTauri()` from sidecar.ts.
 *
 * Non-Tauri environments (plain browser dev server / e2e tests) never see
 * `window.__TAURI__`: every wrapper degrades to a resolved no-op and
 * `isNativeBrowserAvailable()` returns false — the BrowserPanel then renders
 * the R43 fetch-proxy iframe path unchanged. The two backends share the SAME
 * store + server-side history, so the agent's `browser_control` tool works
 * against either.
 *
 * Argument-name note: Tauri 2 converts camelCase JS keys to snake_case Rust
 * parameters — `invoke("browser_tab_create", { tabId, url })` reaches
 * `browser_tab_create(tab_id: String, url: String)`.
 */

import { isTauri } from "./sidecar";

/** `__TAURI__.core.invoke` — the command channel (undefined outside Tauri). */
type TauriInvokeFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/** `__TAURI__.event.listen` — returns an unlisten function via promise. */
type TauriListenFn = (
  event: string,
  handler: (ev: { payload: unknown }) => void,
) => Promise<() => void>;

interface TauriGlobalShape {
  core: { invoke: TauriInvokeFn };
  event: { listen: TauriListenFn };
}

/** The Tauri global, or null when not running inside the desktop shell. */
function tauriGlobal(): TauriGlobalShape | null {
  if (!isTauri()) return null;
  const tauri = (window as unknown as { __TAURI__?: TauriGlobalShape }).__TAURI__;
  if (tauri === undefined || typeof tauri?.core?.invoke !== "function") return null;
  return tauri;
}

/**
 * The raw invoke channel — exported for the BrowserPanel's R41 "pop out"
 * affordance (`open_browser_window`), which is NOT a tab command. Null when
 * not in Tauri (callers must treat that as a no-op).
 */
export function nativeInvoke(): TauriInvokeFn | null {
  const tauri = tauriGlobal();
  return tauri === null ? null : tauri.core.invoke;
}

/**
 * Whether the native child-webview browser can be used (i.e. we are inside
 * the Tauri shell and the invoke bridge is present). The BrowserPanel uses
 * this once per render to pick native mode vs the iframe-proxy fallback.
 */
export function isNativeBrowserAvailable(): boolean {
  return tauriGlobal() !== null;
}

/**
 * Runs an invoke, mapping rejections to a readable message. Outside Tauri
 * every command resolves immediately (safe no-op).
 */
async function runCommand(command: string, args?: Record<string, unknown>): Promise<void> {
  const tauri = tauriGlobal();
  if (tauri === null) return;
  try {
    await tauri.core.invoke(command, args);
  } catch (err) {
    // Rust commands reject with a plain string message (our Result<_, String>
    // error type) — normalize whatever arrives.
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Create (idempotently) the tab's child webview and load `url`. If the
 * webview already exists this is just a navigation — the Rust side handles
 * both, which is why the panel calls this on every activation AND on every
 * address-bar navigation.
 */
export function nativeTabCreate(tabId: string, url: string): Promise<void> {
  return runCommand("browser_tab_create", { tabId, url });
}

/**
 * Navigate the tab's EXISTING webview (errors if it was never created —
 * unlike `nativeTabCreate`, which creates on demand).
 */
export function nativeTabNavigate(tabId: string, url: string): Promise<void> {
  return runCommand("browser_tab_navigate", { tabId, url });
}

/**
 * Position/size the tab's webview (logical px == CSS px — see browser.rs for
 * why getBoundingClientRect maps 1:1 onto child-webview coordinates).
 */
export function nativeTabSetBounds(tabId: string, x: number, y: number, w: number, h: number): Promise<void> {
  return runCommand("browser_tab_set_bounds", { tabId, x, y, w, h });
}

/**
 * Show/hide the tab's webview. Hiding is how a tab goes to the background
 * (panel switched away) WITHOUT losing its session — the webview stays alive.
 */
export function nativeTabSetVisible(tabId: string, visible: boolean): Promise<void> {
  return runCommand("browser_tab_set_visible", { tabId, visible });
}

/** Walk the webview's own history: back | forward | reload. */
export function nativeTabGo(tabId: string, direction: "back" | "forward" | "reload"): Promise<void> {
  return runCommand("browser_tab_go", { tabId, direction });
}

/**
 * The webview's CURRENT url (null outside Tauri). Includes in-page
 * navigations the panel was never told about — useful for reconciling state.
 */
export async function nativeTabUrl(tabId: string): Promise<string | null> {
  const tauri = tauriGlobal();
  if (tauri === null) return null;
  return (await tauri.core.invoke("browser_tab_url", { tabId })) as string;
}

/** Destroy the tab's webview (idempotent — closing twice is a no-op). */
export function nativeTabClose(tabId: string): Promise<void> {
  return runCommand("browser_tab_close", { tabId });
}

/**
 * Destroy EVERY tab webview (anything labeled `acute-tab-*` on the Rust
 * side). Escape hatch for shutdown flows; never touches the R41 pop-out
 * window or the main app webview.
 */
export function nativeTabsCloseAll(): Promise<void> {
  return runCommand("browser_tabs_close_all");
}

/**
 * Subscribe to `browser-navigated` — emitted by the Rust `on_navigation`
 * hook for every http/https navigation of every tab (initial loads, link
 * clicks, redirects). Payload is `{ tab_id, url }` (serde keeps snake_case).
 * The callback receives them as arguments; the returned function unsubscribes.
 * Outside Tauri this is a permanent no-op subscription.
 */
export function onBrowserNavigated(callback: (tabId: string, url: string) => void): () => void {
  const tauri = tauriGlobal();
  if (tauri === null || typeof tauri.event?.listen !== "function") return () => {};

  let unlisten: (() => void) | null = null;
  let disposed = false;
  void tauri.event
    .listen("browser-navigated", (event) => {
      const payload = event.payload as { tab_id?: unknown; url?: unknown } | null;
      if (
        payload !== null &&
        typeof payload === "object" &&
        typeof payload.tab_id === "string" &&
        typeof payload.url === "string"
      ) {
        callback(payload.tab_id, payload.url);
      }
    })
    .then((fn) => {
      // The listen promise can resolve after the caller unsubscribed —
      // immediately release the listener in that case (no leak).
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch(() => {
      // Event channel unavailable — the panel still works; it just won't
      // see in-webview navigations (address bar + poll keep running).
    });
  return () => {
    disposed = true;
    unlisten?.();
  };
}
