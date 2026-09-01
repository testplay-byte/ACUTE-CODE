/**
 * ROUND-59 (R59-b) — the pop-out window's content-webview driver.
 *
 * The pop-out page owns a child webview exactly like the in-app panel's
 * browser tabs (same Rust `browser_tab_*` command family in
 * src-tauri/src/browser.rs, same shared browser-profile dir — the owner's
 * explicit demand), with ONE difference: `browser_tab_create` must attach the
 * webview to the POP-OUT window, not the main window, so the page passes its
 * own window label (getCurrentWindow().label). Bounds/visibility/go/navigate
 * resolve the webview through its globally-unique label (`acute-tab-<id>`)
 * on the Rust side, so the native-browser.ts wrappers work as-is; only
 * create + the pop-out's initial-URL command are popout-specific.
 */

import { nativeInvoke } from "../lib/native-browser";

/**
 * The fixed browser-tab id of the pop-out's content webview — MUST stay in
 * lockstep with POPOUT_TAB_ID in src-tauri/src/browser.rs (the webview label
 * becomes `acute-tab-popout`).
 */
export const POPOUT_TAB_ID = "popout";

/**
 * Create (idempotently) or navigate the pop-out's content webview.
 * `windowLabel` decides which window the webview is a child of — the pop-out
 * page passes its own label so the webview floats over THIS window (an
 * existing webview just navigates, which is what makes this safe to call for
 * every address-bar Go, exactly like the panel's nativeTabCreate usage).
 */
export async function createPopoutTab(url: string, windowLabel: string): Promise<void> {
  const invoke = nativeInvoke();
  if (invoke === null) return;
  await invoke("browser_tab_create", { tabId: POPOUT_TAB_ID, url, windowLabel });
}

/**
 * The content webview's CURRENT url, or null when it doesn't exist yet (the
 * expected boot state — the rejection is swallowed on purpose). This is also
 * the page-reload probe: a webview SURVIVES a reload of the host page (it
 * belongs to the window, not this document), so a non-null answer means
 * "adopt the webview's position" instead of yanking the user back to the
 * stashed initial URL.
 */
export async function popoutCurrentUrl(): Promise<string | null> {
  const invoke = nativeInvoke();
  if (invoke === null) return null;
  try {
    const url = await invoke("browser_tab_url", { tabId: POPOUT_TAB_ID });
    return typeof url === "string" && url !== "" ? url : null;
  } catch {
    // "no native webview for tab" — the boot state, not an error.
    return null;
  }
}

/**
 * The URL `open_browser_window` stashed for this window (null when the page
 * wasn't opened through it — e.g. a plain web-dev visit; the pop-out then
 * idles until the first address-bar Go).
 */
export async function popoutInitialUrl(): Promise<string | null> {
  const invoke = nativeInvoke();
  if (invoke === null) return null;
  try {
    const url = await invoke("popout_initial_url");
    return typeof url === "string" && url !== "" ? url : null;
  } catch {
    return null;
  }
}
