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
 * R60: the page's main-scroller geometry, read OUT of the webview via
 * `eval_with_callback` (the only channel that returns data from an external
 * page without injecting IPC into it). `css` reports whether the
 * document-start themed-scrollbar style actually APPLIED — a page with a
 * strict CSP blocks the `<style>` element, and the pop-out's gutter
 * scrollbar must then stay hidden so the page's own viewport bar remains
 * the ONE scrollbar.
 *
 * Null (never a throw) when: not in Tauri, no webview yet, the probe
 * timed out (wedged page JS), or the payload failed validation — a poller
 * must treat every miss as "no data", not an error UI.
 */
export interface TabScrollState {
  /** Current scroll offset of the main scroller (px, ≥ 0). */
  y: number;
  /** Viewport height (px). */
  vh: number;
  /** Content height (px). */
  ch: number;
  /** Whether the themed-scrollbar CSS applied (false on CSP-strict pages). */
  css: boolean;
}

export async function nativeTabScrollState(tabId: string): Promise<TabScrollState | null> {
  const tauri = tauriGlobal();
  if (tauri === null) return null;
  try {
    const raw = (await tauri.core.invoke("browser_tab_scroll_state", { tabId })) as unknown;
    if (typeof raw !== "string") return null;
    const parsed = JSON.parse(raw) as Partial<TabScrollState>;
    if (
      typeof parsed.y !== "number" ||
      typeof parsed.vh !== "number" ||
      typeof parsed.ch !== "number" ||
      typeof parsed.css !== "boolean"
    ) {
      return null;
    }
    return { y: parsed.y, vh: parsed.vh, ch: parsed.ch, css: parsed.css };
  } catch {
    return null;
  }
}

/** R60: scroll the tab's main scroller to an absolute offset (px). */
export function nativeTabScrollTo(tabId: string, y: number): Promise<void> {
  return runCommand("browser_tab_scroll_to", { tabId, y });
}

/**
 * R62 (D8, the agent-browser bridge): evaluate a JavaScript snippet INSIDE
 * the tab's live page and get its value back. The Rust command wraps the
 * script as a function BODY (use `return …` for data) and answers a JSON
 * string `{ok:true,value}` / `{ok:false,error}` — page exceptions surface as
 * data, not rejections. Null (never a throw) outside Tauri.
 */
export interface TabEvalResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export async function nativeTabEval(tabId: string, script: string): Promise<TabEvalResult | null> {
  const tauri = tauriGlobal();
  if (tauri === null) return null;
  try {
    const raw = (await tauri.core.invoke("browser_tab_eval", { tabId, script })) as unknown;
    if (typeof raw !== "string") return { ok: false, error: "browser_tab_eval returned a non-string" };
    return JSON.parse(raw) as TabEvalResult;
  } catch (err) {
    // Rust-side rejections (missing webview, timeout, validation) map to
    // the same {ok:false} shape the bridge expects.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * R62 (D8): the main window's on-screen geometry — PHYSICAL px outer
 * position + the display scale factor. Feeds the agent-browser screenshot
 * region (panel rect in logical px × scale + window origin = the physical
 * screen region the computer-use backends capture). Null outside Tauri or
 * when the window API is unavailable (the caller then falls back to a
 * full-display capture).
 */
export async function nativeWindowMetrics(): Promise<{ x: number; y: number; scaleFactor: number } | null> {
  if (!isTauri()) return null;
  const tauri = (window as unknown as {
    __TAURI__?: {
      window?: {
        getCurrentWindow?: () => {
          outerPosition: () => Promise<{ x: number; y: number }>;
          scaleFactor: () => Promise<number>;
        };
      };
    };
  }).__TAURI__;
  const getCurrentWindow = tauri?.window?.getCurrentWindow;
  if (typeof getCurrentWindow !== "function") return null;
  try {
    const win = getCurrentWindow();
    const [position, scaleFactor] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
    if (
      typeof position?.x !== "number" ||
      typeof position?.y !== "number" ||
      typeof scaleFactor !== "number" ||
      !Number.isFinite(scaleFactor) ||
      scaleFactor <= 0
    ) {
      return null;
    }
    return { x: position.x, y: position.y, scaleFactor };
  } catch {
    return null;
  }
}

/**
 * R60: REAL DPI-level page zoom (WebView2 zoomFactor through tauri's
 * `Webview::set_zoom`) — media queries and rem layout re-evaluate like a
 * browser's Ctrl+±, which is what the panel's display-size testing needs.
 * Factor is clamped 0.1–5.0 on the Rust side.
 */
export function nativeTabSetZoom(tabId: string, factor: number): Promise<void> {
  return runCommand("browser_tab_set_zoom", { tabId, factor });
}

/**
 * R58-b: hand `url` to the OPERATING SYSTEM's default browser (the Rust
 * `open_external_url` command — tauri-plugin-shell's OS-level open, NOT the
 * embedded WebView2). The panel's explicit "Open externally" affordance
 * uses this inside the Tauri shell: `window.open` from within a WebView2
 * webview is silently swallowed by wry, so the handoff must happen on the
 * Rust side. The command validates http/https in Rust; outside Tauri this
 * resolves as a safe no-op (callers keep their web-mode `window.open`).
 */
export function openExternalUrl(url: string): Promise<void> {
  return runCommand("open_external_url", { url });
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
