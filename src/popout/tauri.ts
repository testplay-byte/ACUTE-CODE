/**
 * ROUND-59 (R59-b) — the Tauri shell discovery for the pop-out browser page.
 *
 * Same discipline as TitleBar.tsx / native-browser.ts: `isTauri()` from
 * lib/sidecar is the single source of truth for shell detection, and
 * `window.__TAURI__` comes from tauri.conf.json's `withGlobalTauri` (no
 * @tauri-apps/api dependency). The pop-out page needs BOTH halves of the
 * global — `window.getCurrentWindow()` for the custom title bar (plus its
 * `.label` to attach the content webview to THIS window) and `core.invoke`
 * for the child-webview commands — so this gate checks both; a malformed
 * global degrades to the web-mode notice instead of a crash.
 */

import { isTauri } from "../lib/sidecar";

/** `__TAURI__.window.getCurrentWindow()` — the pop-out window's own handle. */
export type PopoutWindowHandle = {
  /** The window's label — passed to browser_tab_create as windowLabel. */
  label: string;
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
};

/** `__TAURI__.event.listen` — returns an unlisten function via promise. */
export type PopoutListenFn = (
  event: string,
  handler: (ev: { payload: unknown }) => void,
) => Promise<() => void>;

/** The subset of `__TAURI__` the pop-out page uses. */
export interface PopoutShellShape {
  window: { getCurrentWindow: () => PopoutWindowHandle };
  event: { listen: PopoutListenFn };
  core: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
}

/**
 * The Tauri global shaped for the pop-out page, or null when not running
 * inside the desktop shell (a plain web-dev visit → PopoutApp's honest
 * "needs the desktop app" notice).
 */
export function popoutShell(): PopoutShellShape | null {
  if (!isTauri()) return null;
  const tauri = (window as unknown as { __TAURI__?: PopoutShellShape }).__TAURI__;
  if (
    tauri === undefined ||
    typeof tauri?.window?.getCurrentWindow !== "function" ||
    typeof tauri?.core?.invoke !== "function" ||
    typeof tauri?.event?.listen !== "function"
  ) {
    return null;
  }
  return tauri;
}
