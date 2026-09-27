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
 *
 * R90-D1: the optional `handsInitScript` (the main app's
 * buildHandsBootScript) becomes the webview's INITIALIZATION SCRIPT — it
 * runs at document creation on EVERY navigation, painting the agent's
 * cursor from the first frame of every page (the owner: "the mouse pointer
 * should ALWAYS be visible"). Omitting it keeps the R60 scrollbar-only
 * behavior (the popout's content tab, for instance, opts out).
 */
export function nativeTabCreate(tabId: string, url: string, handsInitScript?: string): Promise<void> {
  return runCommand("browser_tab_create", {
    tabId,
    url,
    ...(handsInitScript !== undefined ? { handsInitScript } : {}),
  });
}

/**
 * R91-B3: does this tab's native webview exist RIGHT NOW? A cheap,
 * in-memory Rust lookup (no dispatcher round-trip — it answers even while
 * the main thread is busy). The BrowserPanel's visibility watchdog polls
 * it to heal the "webview never got created" case by recreating the tab.
 * False outside Tauri (the watchdog is native-mode-only by construction).
 */
export async function nativeTabExists(tabId: string): Promise<boolean> {
  const tauri = tauriGlobal();
  if (tauri === null) return false;
  try {
    return (await tauri.core.invoke("browser_tab_exists", { tabId })) === true;
  } catch {
    return false;
  }
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
 *
 * ROUND-124 (R124): every SUCCESSFUL command is also recorded in the module's
 * TAB GEOMETRY MEMORY (`tabBoundsMemory` below) — the last bounds the FRONTEND
 * commanded for this tab. The staged screenshot capture
 * (agent-browser-capture.ts) temporarily re-sizes the webview to the fixed
 * capture resolution and needs the PRE-STAGE geometry to restore; the Rust
 * side's own TAB_LAST_BOUNDS re-assert would restore the STAGED bounds (our
 * staging overwrites them), so the frontend keeps its own memory. There is no
 * `browser_tab_get_bounds` command (adding one is a Rust change this round
 * deliberately avoids) — the panel re-commands bounds on a 500ms safety net,
 * so the memory is at worst half a second stale, and a restore from it is
 * healed by the next panel sync anyway.
 */
export function nativeTabSetBounds(tabId: string, x: number, y: number, w: number, h: number): Promise<void> {
  return runCommand("browser_tab_set_bounds", { tabId, x, y, w, h }).then(() => {
    tabBoundsMemory.set(tabId, { x, y, w, h });
  });
}

/**
 * ROUND-124 (R124): the tab geometry memory — last COMMANDED bounds per tab.
 * Written only by successful `nativeTabSetBounds` calls (see above); read by
 * the staged capture's restore path. Never a lie: a tab whose bounds were
 * never commanded through this module answers null.
 */
const tabBoundsMemory = new Map<string, { x: number; y: number; w: number; h: number }>();

/**
 * ROUND-124 (R124): the last bounds THIS module commanded for the tab
 * (logical px), or null when none were ever commanded. Module state only —
 * nothing persists.
 */
export function lastCommandedTabBounds(tabId: string): { x: number; y: number; w: number; h: number } | null {
  return tabBoundsMemory.get(tabId) ?? null;
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
  const url = (await tauri.core.invoke("browser_tab_url", { tabId })) as string;
  // R131-B-ui (BU3): a successful read refreshes the module's last-known-URL
  // memory (the eval diagnostics quote it).
  if (typeof url === "string" && url !== "") tabUrlMemory.set(tabId, url);
  return url;
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
    // R67/E2: same WebView2 double-encoding as nativeTabEval — the probe
    // script also returns JSON.stringify(...), so on Windows the callback
    // string arrives double-encoded and the old single parse silently
    // returned null (the pop-out gutter scrollbar was dead on Windows).
    const parsed = parseWebViewEvalJson(raw) as Partial<TabScrollState> | string | null;
    if (parsed === null || typeof parsed !== "object") {
      return null;
    }
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

/**
 * ROUND-131 (R131-B-ui, BU3): the module's LAST KNOWN URL per tab — written
 * by every `browser-navigated` event this module funnels (regardless of any
 * panel being mounted) and by every successful `nativeTabUrl` read. The
 * eval decoder's diagnostics quote it (the ledger's defect: "eval
 * null-payload with no diagnostics" — the agent had no way to know the eval
 * context was gone because the page had navigated). Module state only —
 * never a lie: a tab the module never saw answers null.
 */
const tabUrlMemory = new Map<string, string>();

/**
 * R131-B-ui (BU3): the last URL this module saw for the tab (a navigation
 * event or an explicit url read), or null when none was ever seen.
 */
export function lastKnownTabUrl(tabId: string): string | null {
  return tabUrlMemory.get(tabId) ?? null;
}

/**
 * R67/E2 — the WebView2 eval double-encoding normalizer.
 *
 * THE bug: on Windows, wry's `eval_with_callback` rides WebView2's
 * `ExecuteScriptAsync`, which returns the script's return value
 * **JSON-encoded**. Our eval scripts end with `return JSON.stringify(...)` —
 * a STRING — so the callback receives that string JSON-encoded TWICE (the
 * JSON of a string that is itself JSON). A single `JSON.parse` then yields
 * a STRING, `data.ok` is undefined, and every click/type/eval/read_dom/
 * source action failed with "the page rejected the script" on the owner's
 * real Windows machine (the sandbox's mocks — and webkitgtk — single-
 * encode, which is exactly why this survived every test).
 *
 * The tolerant double-parse below handles BOTH transports: parse once; if
 * the result is still a string, parse it again (WebKit yields the object
 * after one parse; WebView2 after two). A non-JSON string survives as the
 * raw string (honest — the caller validates the shape).
 */
export function parseWebViewEvalJson(raw: string): unknown {
  try {
    const first: unknown = JSON.parse(raw);
    if (typeof first === "string") {
      try {
        return JSON.parse(first) as unknown;
      } catch {
        return first;
      }
    }
    return first;
  } catch {
    return raw;
  }
}

export async function nativeTabEval(tabId: string, script: string): Promise<TabEvalResult | null> {
  const tauri = tauriGlobal();
  if (tauri === null) return null;
  try {
    const raw = (await tauri.core.invoke("browser_tab_eval", { tabId, script })) as unknown;
    if (typeof raw !== "string") return { ok: false, error: "browser_tab_eval returned a non-string" };
    const parsed = parseWebViewEvalJson(raw) as Partial<TabEvalResult> | string | null;
    if (parsed === null) {
      // R131-B-ui (BU3 — the ledger's "eval null-payload with no
      // diagnostics" defect): the literal-"null" answer is a REAL signal,
      // not garbage — WebView2's ExecuteScriptAsync answers the JSON null
      // when the page NAVIGATED AWAY under the eval (the old document is
      // destroyed, the callback fires with nothing) or the script itself
      // evaluated to undefined (the Rust wrap maps undefined → null). The
      // old message ("unexpected payload: null") told the agent neither.
      // Name both causes + the recovery (re-probe with get_state) + the
      // tab's last known URL so the next field report pinpoints the case.
      const lastUrl = tabUrlMemory.get(tabId) ?? null;
      return {
        ok: false,
        error:
          "the page navigated away or the script returned undefined — the eval context is gone; re-probe with get_state" +
          (lastUrl !== null ? ` (last known URL: ${lastUrl.slice(0, 200)})` : ""),
      };
    }
    if (typeof parsed !== "object" || typeof parsed.ok !== "boolean") {
      // Still not the {ok, value|error} envelope — report the shape honestly
      // (this is the old "the page rejected the script" class of failure).
      return { ok: false, error: `browser_tab_eval returned an unexpected payload: ${String(raw).slice(0, 200)}` };
    }
    return parsed as TabEvalResult;
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
 *
 * ROUND-124 (R124): successful commands are recorded in the tab ZOOM memory
 * (`tabZoomMemory` below) — the staged screenshot capture sets zoom to 1 for
 * the 1:1 raster and needs the pre-stage factor to restore (a preset-mode
 * panel composes fit-scale × user-zoom, so a leaked 1.0 would silently
 * un-scale the user's view until the next syncBounds re-asserts).
 */
export function nativeTabSetZoom(tabId: string, factor: number): Promise<void> {
  return runCommand("browser_tab_set_zoom", { tabId, factor }).then(() => {
    tabZoomMemory.set(tabId, factor);
  });
}

/**
 * ROUND-124 (R124): the tab zoom memory — last COMMANDED factor per tab.
 * Written only by successful `nativeTabSetZoom` calls; read by the staged
 * capture's restore path. Null when none were ever commanded (the Rust
 * default 1× applies).
 */
const tabZoomMemory = new Map<string, number>();

/**
 * ROUND-124 (R124): the last zoom factor THIS module commanded for the tab,
 * or null when none was ever commanded. Module state only — nothing persists.
 */
export function lastCommandedTabZoom(tabId: string): number | null {
  return tabZoomMemory.get(tabId) ?? null;
}

/**
 * ROUND-124 (R124): test/inspection hook — forget every recorded bounds and
 * zoom (the staged-capture suites start from a clean memory so a leaked
 * recording from a prior test can never answer as "pre-stage geometry").
 */
export function resetTabGeometryMemoryForTest(): void {
  tabBoundsMemory.clear();
  tabZoomMemory.clear();
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
 * ROUND-128 (R128-W7a): restore the MAIN window from minimized — the Rust
 * `window_unminimize` command (src-tauri/src/browser.rs; unminimize + show,
 * best-effort, no arguments). The staged screenshot capture's guard-3
 * recovery leg: a minimized Windows window parks at (-32000,-32000) and
 * paints nothing, so the capture used to refuse flatly; now it calls this,
 * waits a short bounded beat, re-reads the window metrics, and only a
 * STILL-minimized window refuses (with the honest "restored the window and
 * retried" copy). Outside Tauri a safe no-op (the web-mode capture path
 * refuses earlier at the bridge guard anyway).
 */
export function unminimizeMainWindow(): Promise<void> {
  return runCommand("window_unminimize");
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
        // R131-B-ui (BU3): every navigation the module funnels refreshes the
        // last-known-URL memory — the eval diagnostics quote it when the
        // eval context is gone (the page navigated away under the script).
        if (payload.url !== "") tabUrlMemory.set(payload.tab_id, payload.url);
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

// ── ROUND-131 (R131-B-ui, BU2/BU3): the native downloads ───────────────────

/**
 * R131-B-ui (BU2): `<root>/downloads` — the per-project download dir the
 * Rust `browser_tab_set_download_dir` command records for the tab (the
 * ROUND-115-pinned save location: "when a 'save this download' affordance
 * lands, its save location is pinned: <projectRoot>/downloads/"). Pure;
 * exported for the tests. Handles both separator styles + trailing
 * separators; an empty/blank root answers "/downloads" (the Rust side's
 * own absolute-path validation is the real gate).
 */
export function downloadDirForRoot(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  return `${trimmed === "" ? "" : trimmed}/downloads`;
}

/**
 * R131-B-ui (BU2): tell Rust where THIS tab's downloads land (validated on
 * the Rust side: absolute + created recursively). The PANEL calls it when
 * it resolves the bound project's rootPath. Outside Tauri a safe no-op; on
 * the Linux shell the command refuses honestly ("downloads are Windows-only
 * in this build") — a rejection callers log once and swallow.
 *
 * The invoke key is `dir` (the Rust command's parameter is
 * `browser_tab_set_download_dir(tab_id, dir)` — the audit caught the
 * interrupted run sending `path`, which Tauri would reject as a missing
 * `dir` key at RUNTIME even though every test-level mock stayed green).
 */
export function nativeTabSetDownloadDir(tabId: string, path: string): Promise<void> {
  return runCommand("browser_tab_set_download_dir", { tabId, dir: path });
}

/**
 * R131-B-ui (BU3): the `browser-download` event payload — emitted by the
 * Rust DownloadStarting handler (state "starting") and its StateChanged
 * follower ("completed" / "interrupted") with the bytes read at emit time.
 * Serde keeps snake_case (same convention as `browser-navigated`).
 */
export interface NativeDownloadInfo {
  /** "starting" | "completed" | "interrupted". */
  state: "starting" | "completed" | "interrupted";
  /** The absolute local path the bytes land at. */
  path: string;
  /** The download's file name (the path's final component). */
  fileName: string;
  /** Bytes received at emit time. */
  receivedBytes: number;
  /** The total when known (WebView2 answers -1 for unknown). */
  totalBytes: number | null;
}

/**
 * R131-B-ui (BU3): subscribe to `browser-download` — the Rust DownloadStarting
 * pipeline's DOM-side channel (the panel surfaces a quiet toast; the sibling
 * B-core's same-named SSE frame is the agent-side twin for the download
 * ACTION — separate transports, no stream-store intercept needed here). The
 * callback receives them as arguments; the returned function unsubscribes.
 * Outside Tauri this is a permanent no-op subscription.
 */
export function onBrowserDownload(callback: (tabId: string, info: NativeDownloadInfo) => void): () => void {
  const tauri = tauriGlobal();
  if (tauri === null || typeof tauri.event?.listen !== "function") return () => {};

  let unlisten: (() => void) | null = null;
  let disposed = false;
  void tauri.event
    .listen("browser-download", (event) => {
      const payload = event.payload as Record<string, unknown> | null;
      if (payload === null || typeof payload !== "object") return;
      const { tab_id, state, path, file_name, received_bytes, total_bytes } = payload as {
        tab_id?: unknown;
        state?: unknown;
        path?: unknown;
        file_name?: unknown;
        received_bytes?: unknown;
        total_bytes?: unknown;
      };
      if (typeof tab_id !== "string" || typeof state !== "string" || typeof path !== "string") return;
      if (state !== "starting" && state !== "completed" && state !== "interrupted") return;
      if (typeof file_name !== "string") return;
      if (typeof received_bytes !== "number" || !Number.isFinite(received_bytes)) return;
      if (total_bytes !== null && typeof total_bytes !== "number") return;
      callback(tab_id, {
        state,
        path,
        fileName: file_name,
        receivedBytes: Math.max(0, received_bytes),
        totalBytes: typeof total_bytes === "number" && Number.isFinite(total_bytes) && total_bytes >= 0 ? total_bytes : null,
      });
    })
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch(() => {
      // Event channel unavailable — downloads still land on disk; the
      // panel just won't toast (the files remain in the downloads dir).
    });
  return () => {
    disposed = true;
    unlisten?.();
  };
}
