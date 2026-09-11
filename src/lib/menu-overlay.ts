/**
 * ROUND-90 (R90-C2) — THE MENU OVERLAY BRIDGE (the main window's half).
 *
 * The owner's verdict: clicking the right sidebar's "+" while a page was
 * open paused the embedded browser ("browser paused while the menu is
 * open… the menu was supposed to be shown on top of the browser window
 * itself"). A DOM popover can NEVER paint above the OS-level browser
 * webview — so the sidebar's two popovers (quick menu + sub-agent picker)
 * now render inside an OWNED, transparent, borderless OS WINDOW that DOES
 * ride above it (see browser.rs's menu_overlay_* commands + the
 * menu-overlay.html page).
 *
 * This module is the main window's half of that contract:
 *  · `showMenuOverlay` — viewport anchor → LOGICAL SCREEN coords (the main
 *    window's physical origin ÷ its scale factor + the CSS-px rect), then
 *    `menu_overlay_show` positions + shows the window and delivers the
 *    payload. False when anything is unavailable (web dev, e2e, a failed
 *    command) — the caller then falls back to the plain DOM popover.
 *  · `hideMenuOverlay` — the close half (pick / Escape / outside click).
 *  · `prewarmMenuOverlay` — create the window hidden at sidebar mount so
 *    the FIRST open is a cheap reposition instead of a webview spawn.
 *  · `onMenuOverlayPick` / `onMenuOverlayClose` — the overlay page's
 *    reports (clicks land in ITS window, so the main window only hears
 *    about them through these events).
 *
 * Outside the Tauri shell every function degrades to a no-op/false — the
 * DOM popover path is the default, tests included.
 */

import { isTauri } from "./sidecar";
import { nativeWindowMetrics } from "./native-browser";

/** The theme fields the overlay page paints with (a subset of
 * useThemeStyles — JSON-safe strings + the dark flag). */
export interface MenuTheme {
  card: string;
  border: string;
  softShadow: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  accent: string;
  subtleHover: string;
  isDark: boolean;
}

/** The lucide icons the overlay page knows by name (quick-menu items). */
export type MenuIconName = "folder-tree" | "globe" | "terminal" | "brain" | "activity" | "bot";

/** One quick-menu item (Files / Browser / Terminal / Memory / Console /
 * Sub-agents — the RightSidebar's QuickMenu content). */
export interface QuickMenuItemPayload {
  kind: "quick";
  /** The RightSidebarTabType to open on pick. */
  type: string;
  label: string;
  desc: string;
  icon: MenuIconName;
}

/** One sub-agent row (the SubAgentPicker content). */
export interface SubAgentItemPayload {
  kind: "sub";
  id: string;
  code: string;
  role: string;
  roleColor: string;
  title: string;
  status: string;
  /** The raw subRole (null → the display "agent") — openSubAgent needs it. */
  subRole: string | null;
}

export type MenuItemPayload = QuickMenuItemPayload | SubAgentItemPayload;

/** The whole payload the overlay page renders. */
export interface MenuPayload {
  kind: "quick" | "subagents";
  title: string;
  /** The menu card's intended CSS width (220 quick / 260 sub-agents). */
  width: number;
  items: MenuItemPayload[];
  theme: MenuTheme;
}

/** A picked item as reported back (kind + the discriminated item). */
export interface MenuPick {
  kind: "quick" | "subagents";
  item: MenuItemPayload;
}

type TauriInvokeFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type TauriListenFn = (
  event: string,
  handler: (ev: { payload: unknown }) => void,
) => Promise<() => void>;

interface TauriGlobalShape {
  core: { invoke: TauriInvokeFn };
  event: { listen: TauriListenFn };
}

function tauriGlobal(): TauriGlobalShape | null {
  if (!isTauri()) return null;
  const tauri = (window as unknown as { __TAURI__?: TauriGlobalShape }).__TAURI__;
  if (tauri === undefined || typeof tauri?.core?.invoke !== "function") return null;
  return tauri;
}

/**
 * The viewport anchor the sidebar computed (CSS px, main-window-relative) →
 * the overlay window's LOGICAL SCREEN rectangle, clamped to the main
 * window's own viewport so a menu at the right edge shifts left exactly
 * like the DOM popover's anchor math does.
 */
function anchorToScreen(
  metrics: { x: number; y: number; scaleFactor: number },
  anchor: { left: number; top: number; width: number; height: number },
): { x: number; y: number; w: number; h: number } {
  // Physical outer position → logical screen coords (same monitor ⇒ same
  // scale factor; the overlay lives with the main window's DPI).
  const originX = metrics.x / metrics.scaleFactor;
  const originY = metrics.y / metrics.scaleFactor;
  return {
    x: originX + anchor.left,
    y: originY + anchor.top,
    w: anchor.width,
    h: anchor.height,
  };
}

/**
 * Show the menu overlay window at the anchor. Resolves FALSE whenever the
 * overlay path is unusable (web dev, no window metrics, a rejected
 * command) — the caller must then fall back to the plain DOM popover.
 */
export async function showMenuOverlay(
  anchor: { left: number; top: number; width: number; height: number },
  payload: MenuPayload,
): Promise<boolean> {
  const tauri = tauriGlobal();
  if (tauri === null) return false;
  const metrics = await nativeWindowMetrics();
  if (metrics === null) return false;
  const { x, y, w, h } = anchorToScreen(metrics, anchor);
  try {
    await tauri.core.invoke("menu_overlay_show", {
      x,
      y,
      w,
      h,
      payload: JSON.stringify(payload),
    });
    return true;
  } catch {
    return false;
  }
}

/** Create the overlay window hidden (call at sidebar mount — the first
 * open is then an instant reposition). Best-effort; outside Tauri a no-op. */
export function prewarmMenuOverlay(): void {
  const tauri = tauriGlobal();
  if (tauri === null) return;
  void tauri.core.invoke("menu_overlay_prewarm").catch(() => {
    // Pre-warm failure is silent: the first show falls back to create.
  });
}

/** Hide the overlay window (it stays alive for the next open). */
export function hideMenuOverlay(): void {
  const tauri = tauriGlobal();
  if (tauri === null) return;
  void tauri.core.invoke("menu_overlay_hide").catch(() => {});
}

/**
 * Subscribe to the overlay page's PICK reports. The handler receives the
 * kind + the picked item; hiding the window is the CALLER's job (it usually
 * closes the popover state which does that). Returns an unlisten function.
 */
export function onMenuOverlayPick(callback: (pick: MenuPick) => void): () => void {
  const tauri = tauriGlobal();
  if (tauri === null) return () => {};
  let unlisten: (() => void) | null = null;
  let alive = true;
  void tauri.event.listen("menu-overlay-pick", (ev) => {
    const payload = ev.payload as MenuPick | null;
    if (payload !== null && typeof payload?.kind === "string") callback(payload);
  }).then((fn) => {
    if (!alive) fn();
    else unlisten = fn;
  }).catch(() => {});
  return () => {
    alive = false;
    unlisten?.();
  };
}

/**
 * Subscribe to the overlay page's CLOSE request (Escape pressed while the
 * overlay somehow holds focus). Returns an unlisten function.
 */
export function onMenuOverlayClose(callback: () => void): () => void {
  const tauri = tauriGlobal();
  if (tauri === null) return () => {};
  let unlisten: (() => void) | null = null;
  let alive = true;
  void tauri.event.listen("menu-overlay-close", () => {
    callback();
  }).then((fn) => {
    if (!alive) fn();
    else unlisten = fn;
  }).catch(() => {});
  return () => {
    alive = false;
    unlisten?.();
  };
}
