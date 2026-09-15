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

// ── ROUND-97 (R97-C): the context-bar palette + the visual payload ─────────
//
// The owner's eighth report: the usage card (R96-G) reads as a plain
// label/value list — the DOM popover's visuals (the donut, the breakdown
// mini-bars, the full session rows with cost) never crossed the payload
// boundary. R97-C grows the payload into the full visual card, headed by
// the Kilo-Code-style segmented context bar the owner named ("in the Kilo
// Code at the very top, it shows the stats of the various things used, the
// tokens used for, and such, in bar format" — one colored segment per
// context category + the reserved-for-output block + the free track, with
// the Cursor-style mutual hover-highlight between segments and rows).

/** R97-C: the category-segment color palette — ONE palette shared by the
 * overlay usage card and the DOM popover (the context bar's segments + the
 * breakdown rows' dots/mini-bars paint from the SAME keys, so both views
 * stay identical). Keys are JSON-safe (the payload crosses the process
 * boundary); the hex values are theme-aware (light/dark variants chosen to
 * stay distinguishable at 4-6px bar height on the card surface). */
export type UsageSegmentColor =
  | "accent"
  | "blue"
  | "teal"
  | "violet"
  | "amber"
  | "rose"
  | "reserved";

/** R97-C: the palette itself. `accent` resolves to the THEME accent (the
 * biggest segment — Messages — reads as the app's own color); the rest are
 * fixed hues. `reserved` is the dimmed output-reserve segment (Kilo's
 * insight: free space ≠ usable space — the max_output_tokens reserve gets
 * its own muted block, never a category color). */
const SEGMENT_PALETTE: Record<Exclude<UsageSegmentColor, "accent">, { light: string; dark: string }> = {
  blue: { light: "#3b82f6", dark: "#60a5fa" },
  teal: { light: "#0d9488", dark: "#2dd4bf" },
  violet: { light: "#8b5cf6", dark: "#a78bfa" },
  amber: { light: "#d97706", dark: "#fbbf24" },
  rose: { light: "#e11d48", dark: "#fb7185" },
  reserved: { light: "#9ca3af", dark: "#6b7280" },
};

/** R97-C: resolve a segment key to a paintable hex. Pure; exported for the
 * DOM popover + the overlay renderer + tests. */
export function usageSegmentHex(color: UsageSegmentColor, isDark: boolean, accent: string): string {
  if (color === "accent") return accent;
  const entry = SEGMENT_PALETTE[color];
  return isDark ? entry.dark : entry.light;
}

/** R97-C: one category segment of the context bar. */
export interface UsageBarSegmentPayload {
  /** The category label ("Messages", "System prompt", …). */
  label: string;
  /** The category's estimated tokens. */
  tokens: number;
  /** The palette key (see usageSegmentHex). */
  color: UsageSegmentColor;
}

/** R97-C: the CONTEXT BAR — the owner's named Kilo-Code-style element: a
 * horizontal bar of colored segments (one per context category) + the
 * reserved-for-output block + free space as the track, used/window counts
 * flanking in compact numerals. Hovering a segment (or its breakdown row)
 * cross-highlights both (the Cursor interaction, mirrored). */
export interface UsageContextBarPayload {
  /** The sum of the category segments (== data.usedTokens, estimated). */
  usedTokens: number;
  /** The model's context window. */
  windowTokens: number;
  /** The output reserve (maxOutputTokens; 0 when unknown) — rendered as the
   * dimmed reserved block so "free" never reads as fully usable. */
  reservedTokens: number;
  /** used/window * 100, clamped 0-100 (the bar's fill fraction). */
  usedPct: number;
  /** The category segments, in display order. */
  segments: UsageBarSegmentPayload[];
  /** R98-C3: the pane's label ("Window composition") — the sectioned layout. */
  label?: string;
}

/** R97-C: the big donut visual riding the card's header (the DOM popover's
 * twin — ring + % center + the budget tick + the header's line column).
 * R98-C3: `label` names the pane ("Overview") — the sectioned layout. */
export interface UsageDonutPayload {
  used: number;
  limit: number;
  /** The budget-line tick fraction (available/window; 0 hides it). */
  markerFrac: number;
  /** The graded ring color key — matches CONTEXT_DONUT_WARN/DANGER. */
  ringColor: "accent" | "warn" | "danger";
  /** The header's line rows beside the ring (projected / estimated /
   * measured / model / the session cost headline — the DOM popover's header
   * text column). */
  lines: UsageLinePayload[];
  /** R98-C3: the pane's label ("Overview") — the renderer paints it as the
   * pane's uppercase tracked header. */
  label?: string;
}

/** R97-C: one row of the session table (Main agent / Sub-agents / Combined
 * × Turns / Calls / Sent ↑ / Received ↓ / Cost). R98-C3: `id` is the stable
 * DOM-test pin key ("main" / "subagents" / "combined"). */
export interface UsageTableRowPayload {
  id?: string;
  label: string;
  cells: string[];
  strong?: boolean;
}

/** R96-G: one label/value line of a usage section. R97-C adds the mini-bar
 * fields (the breakdown rows + the cache hit-rate row paint a 3px bar). */
export interface UsageLinePayload {
  label: string;
  value: string;
  /** An optional tertiary note riding after the value (" · not reported by
   * this provider"). */
  note?: string;
  /** The emphasized rows (the projected %, the MEASURED line) — primary text
   * color + bolder value instead of the muted default. */
  strong?: boolean;
  /** R97-C: the mini-bar fraction (0-1 of the line's own track). */
  barFrac?: number;
  /** R97-C: which palette color the dot + mini-bar paint (matches the
   * context-bar segment of the same category — the hover-highlight pairing). */
  barColor?: UsageSegmentColor;
}

/** R96-G: one titled section of the usage card (Window / Breakdown / Cache /
 * Session totals — the donut popover's visual groups). R97-C adds the
 * optional compact table (the session split). */
export interface UsageSectionPayload {
  title: string;
  lines: UsageLinePayload[];
  /** R97-C: an optional compact table under the lines (the session split —
   * Turns / Provider calls / Tokens sent ↑ / received ↓ / Cost per group;
   * the DOM popover's UsageGroup rows, compacted). */
  table?: {
    columns: string[];
    rows: UsageTableRowPayload[];
  };
}

/** R96-G: the usage rich card — the ContextDonut popover's content as a
 * structured payload for the overlay window (no items, no picks: it is a
 * hover READ, not a menu). R97-C grew the payload from the plain label/value
 * sections into the full visual card: the context bar (the Kilo-style
 * segmented usage bar), the big donut, per-line mini-bars, and the session
 * table with cost — the DOM popover's richness crossed the boundary. */
export interface UsageCardPayload {
  kind: "usage";
  title: string;
  /** The card's CSS width (the DOM popover's 288). */
  width: number;
  /** R97-C: the Kilo-style segmented context bar (the card's headline). */
  contextBar?: UsageContextBarPayload;
  /** R97-C: the big donut (the header's visual anchor). */
  donut?: UsageDonutPayload;
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
 * room; an UNDER-estimate would clip the last row behind the card's scroll).
 *
 * R98-C3: the card is a STACK OF SECTIONED PANES (the owner: "proper
 * separation between the elements… a wider aspect ratio") — the chrome
 * constants grew the pane overhead (border + padding + the gap below) and
 * every visual block (donut / bar / section) is a pane now. */
export const USAGE_CARD_CHROME_PX = 55; // strip + title row + outer paddings
export const USAGE_SECTION_TITLE_PX = 17; // a pane's label row + its gap
/** R98-C3: the per-pane overhead — border(2) + padding(18) + the gap below
 * the pane (8). The LAST pane's gap is never subtracted (biased tall — the
 * safe direction: a few px of breathing room, never a clipped row). */
export const USAGE_PANE_PX = 28;
export const USAGE_LINE_PX = 17; // one label/value line
export const USAGE_NOTE_PX = 20; // the footnote row + its gap
/** R97-C: the context-bar CONTENT — the flanking counts row (16) + the bar
 * itself (6) + its breathing room (8). */
export const USAGE_CONTEXT_BAR_PX = 30;
/** R97-C: the donut content — the 46px ring (+ breathing). */
export const USAGE_DONUT_PX = 54;
/** R97-C: one table row (the compact 10px cells + padding). */
export const USAGE_TABLE_ROW_PX = 18;
/** R97-C: the table's header row (same rhythm, +1 for the divider). */
export const USAGE_TABLE_HEAD_PX = 19;

/** R97-C → R98-C3: the overlay window's height for a usage card — the
 * pane arithmetic: chrome + every pane's overhead + every pane's content
 * (donut / bar / each section's lines + table) + the note), floored at the
 * Rust command's 40px minimum. Pure; exported for tests. */
export function estimateUsageCardHeight(payload: UsageCardPayload): number {
  const panes =
    (payload.contextBar !== undefined ? 1 : 0) +
    (payload.donut !== undefined ? 1 : 0) +
    payload.sections.length;
  const paneOverhead = panes * USAGE_PANE_PX + panes * USAGE_SECTION_TITLE_PX;
  const contextBar = payload.contextBar !== undefined ? USAGE_CONTEXT_BAR_PX : 0;
  // The donut content: the header LINES stack beside the 46px ring — the
  // block is whichever is taller (5-6 lines at 17px ≈ 85-102px) + breathing.
  const donut =
    payload.donut !== undefined
      ? Math.max(USAGE_DONUT_PX, payload.donut.lines.length * USAGE_LINE_PX + 10)
      : 0;
  const sections = payload.sections.reduce(
    (acc, s) =>
      acc +
      s.lines.length * USAGE_LINE_PX +
      (s.table !== undefined ? USAGE_TABLE_HEAD_PX + s.table.rows.length * USAGE_TABLE_ROW_PX : 0),
    0,
  );
  const note = payload.note !== undefined && payload.note !== "" ? USAGE_NOTE_PX : 0;
  return Math.max(40, USAGE_CARD_CHROME_PX + paneOverhead + contextBar + donut + sections + note);
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
