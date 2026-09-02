/**
 * ROUND-64 (R64-b) — the Tauri shell discovery for the floating computer-use
 * mini monitor page.
 *
 * Same discipline as popout/tauri.ts and lib/native-browser.ts:
 * `isTauri()` from lib/sidecar is the single source of truth for shell
 * detection, and `window.__TAURI__` comes from tauri.conf.json's
 * `withGlobalTauri` (no @tauri-apps/api dependency). The mini page needs
 * only ONE half of the global — `core.invoke`, for `sidecar_info` (the
 * engine endpoint, via getSidecarInfo) and `close_computer_mini` (the
 * page's self-close when the control session ends). A malformed global
 * degrades to the web-mode notice instead of a crash.
 */

import { isTauri } from "../lib/sidecar";

/** `__TAURI__.core.invoke` — the command channel. */
export type MiniInvokeFn = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/** The subset of `__TAURI__` the mini monitor page uses. */
export interface MiniShellShape {
  core: { invoke: MiniInvokeFn };
}

/**
 * The Tauri global shaped for the mini monitor page, or null when not
 * running inside the desktop shell (a plain web-dev visit of mini.html →
 * MiniApp's honest "needs the desktop app" notice).
 */
export function miniShell(): MiniShellShape | null {
  if (!isTauri()) return null;
  const tauri = (window as unknown as { __TAURI__?: MiniShellShape }).__TAURI__;
  if (
    tauri === undefined ||
    typeof tauri?.core?.invoke !== "function"
  ) {
    return null;
  }
  return tauri;
}
