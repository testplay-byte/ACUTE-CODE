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
 * ROUND-96 (R96-G): the payload space grew one more kind — the USAGE rich
 * card (UsageCardPayload below), the ContextDonut's hover popover riding the
 * same window so hovering the token usage never pauses the embedded browser
 * ("Browser paused while the menu is open" — the owner's report). It is a
 * read-only card (no picks); `onMenuOverlayHover` bridges its pointer
 * enter/leave back so the popover's hover-grace semantics survive the window
 * boundary.
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

/** The lucide icons the overlay page knows by name (quick-menu items +
 * R92-A: the composer option menus' rows — mode zap/shield/clipboard,
 * add-context hard-drive-upload/folder-open). */
export type MenuIconName =
  | "folder-tree"
  | "globe"
  | "terminal"
  | "brain"
  | "activity"
  | "bot"
  | "zap"
  | "shield"
  | "clipboard"
  | "hard-drive-upload"
  | "folder-open";

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

/** R92-A: one generic option row (the composer's mode / thinking-level /
 * add-context menus). `selected` drives the checkmark + the accent-tinted
 * row the DOM menus show (ModeSwitcher's role=menuitemradio twin). */
export interface OptionsItemPayload {
  kind: "options";
  id: string;
  label: string;
  /** Optional one-line description (a second row, quick-menu style). */
  desc?: string;
  icon?: MenuIconName;
  selected?: boolean;
}

export type MenuItemPayload = QuickMenuItemPayload | SubAgentItemPayload | OptionsItemPayload;

/** The whole payload the overlay page renders. R92-A adds the generic
 * "options" kind (the composer's three simple menus ride the same window). */
export interface MenuPayload {
  kind: "quick" | "subagents" | "options";
  title: string;
  /** The menu card's intended CSS width (220 quick / 260 sub-agents / the
   * DOM menu's width for options — 256 for w-64, 224 for w-56). */
  width: number;
  items: MenuItemPayload[];
  theme: MenuTheme;
}

// ── ROUND-96 (R96-G): the USAGE rich card ────────────────────────────────────
//
// The owner: "when I try to hover over the total number of token usage that
// has been done, it apparently hides the browser and says, 'Browser paused
// while the menu is open.' This is not a great experience." The ContextDonut's
// hover popover is a DOM overlay, and a DOM overlay can NEVER paint above the
// OS-level browser webview — so its rect intersecting the panel correctly hid
// the page behind that caption. The popover now rides the SAME overlay window
// the R90-C2/R92-A menus use (an owned transparent OS window that DOES ride
// above the webview) via this "usage" kind: a read-only, structured
// label/value card mirroring the donut popover's content (JSON-safe strings
// only — the payload crosses the process boundary as one JSON string).

/** R96-G: one label/value line of a usage section. */
export interface UsageLinePayload {
  label: string;
  value: string;
  /** An optional tertiary note riding after the value (" · not reported by
   * this provider"). */
  note?: string;
  /** The emphasized rows (the projected %, the MEASURED line) — primary text
   * color + bolder value instead of the muted default. */
  strong?: boolean;
}

/** R96-G: one titled section of the usage card (Window / Breakdown / Cache /
 * Session totals — the donut popover's visual groups). */
export interface UsageSectionPayload {
  title: string;
  lines: UsageLinePayload[];
}

/** R96-G: the usage rich card — the ContextDonut popover's content as a
 * structured payload for the overlay window (no items, no picks: it is a
 * hover READ, not a menu). */
export interface UsageCardPayload {
  kind: "usage";
  title: string;
  /** The card's CSS width (the DOM popover's 288). */
  width: number;
  sections: UsageSectionPayload[];
  /** The one-line footnote under the sections (compaction / window
   * provenance — the donut popover's note row). */
  note?: string;
  theme: MenuTheme;
}

/** Everything the overlay window can be asked to show (the menu kinds +
 * R96-G's usage rich card). */
export type MenuOverlayPayload = MenuPayload | UsageCardPayload;

/** R96-G: the usage card's LAYOUT CONTRACT (px) — the OS window's height must
 * be ESTIMATED in the main window (showMenuOverlay sizes the window), so the
 * arithmetic lives HERE and MenuOverlayApp paints to the same numbers. The
 * estimate is biased a touch TALL (a few px of card padding read as breathing
 * room; an UNDER-estimate would clip the last row behind the card's scroll). */
export const USAGE_CARD_CHROME_PX = 26; // the card head row + outer paddings
export const USAGE_SECTION_TITLE_PX = 22; // one section's title row + its gap
export const USAGE_LINE_PX = 17; // one label/value line
export const USAGE_NOTE_PX = 20; // the footnote row + its gap

/** R96-G: the overlay window's height for a usage card — the payload's own
 * arithmetic (chrome + every section title + every line + the note), floored
 * at the Rust command's 40px minimum. Pure; exported for tests. */
export function estimateUsageCardHeight(payload: UsageCardPayload): number {
  const sections = payload.sections.reduce(
    (acc, s) => acc + USAGE_SECTION_TITLE_PX + s.lines.length * USAGE_LINE_PX,
    0,
  );
  const note = payload.note !== undefined && payload.note !== "" ? USAGE_NOTE_PX : 0;
  return Math.max(40, USAGE_CARD_CHROME_PX + sections + note);
}

/** A picked item as reported back (kind + the discriminated item). */
export interface MenuPick {
  kind: "quick" | "subagents" | "options";
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
 * R96-G: the payload may be a menu (quick/subagents/options) or the USAGE
 * rich card (the ContextDonut popover) — the Rust side forwards the JSON
 * string opaquely, so the kinds need no plumbing of their own.
 */
export async function showMenuOverlay(
  anchor: { left: number; top: number; width: number; height: number },
  payload: MenuOverlayPayload,
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

/**
 * R96-G: subscribe to the USAGE card's HOVER reports — the overlay window
 * owns the pointer while it is over the card, so the main window's own
 * mouseenter/mouseleave can no longer bridge the gap (the R51 hover-bridge
 * problem, restated across an OS window boundary). The usage page emits
 * `hovering: true` on card pointer-enter and `false` on pointer-leave; the
 * ContextDonut maps them onto the SAME close-grace timer the DOM popover
 * uses, so parking the pointer on the overlay card keeps it open exactly
 * like hovering the DOM popover did. Returns an unlisten function.
 */
export function onMenuOverlayHover(callback: (hovering: boolean) => void): () => void {
  const tauri = tauriGlobal();
  if (tauri === null) return () => {};
  let unlisten: (() => void) | null = null;
  let alive = true;
  void tauri.event.listen("menu-overlay-hover", (ev) => {
    const payload = ev.payload as { hovering?: unknown } | null;
    if (payload !== null && typeof payload === "object") {
      callback(payload.hovering === true);
    }
  }).then((fn) => {
    if (!alive) fn();
    else unlisten = fn;
  }).catch(() => {});
  return () => {
    alive = false;
    unlisten?.();
  };
}
