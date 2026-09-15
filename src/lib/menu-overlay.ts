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
 * read card; R99-D adds the legend's management link-chips, whose picks ride
 * the same "menu-overlay-pick" channel as the usage-link kind;
 * `onMenuOverlayHover` bridges its pointer enter/leave back so the popover's
 * hover-grace semantics survive the window boundary.
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

// ── ROUND-97 (R97-C) + ROUND-99 (R99-D): the visual payload ─────────────────
//
// The owner's eighth report grew the payload into the full visual card; the
// R99-D redesign (owner: "the context window management popup… in terms of
// its stats, the details, and everything, it does not look like it is
// properly thought of… the context window composition does not look proper…
// the overview is not proper") restructures it after the Claude Code
// /context reference: the OVERVIEW HERO (big token line + ONE %-first meta
// line + ≤3 honesty pairs + the compaction/reserve line + the badge on the
// header row — the ring keeps its left-anchor role but LOSES its center %:
// one source of truth per number), the full-width stacked bar with
// per-segment % labels (only for segments ≥12% of the window — narrower
// ones stay honest-quiet, the legend carries them), the LEGEND under the
// bar that REPLACES the old Breakdown section (palette dot + label + tokens
// + % of used, the mutual hover-highlight kept, the duplicate mini-bars
// retired), the cache as ONE row, and the session table.

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

/** R97-C: one category segment of the context bar. R99-D: the segment now
 * carries its OWN legend row (the Breakdown section is retired — the legend
 * under the bar replaces it) — the pre-formatted tokens + the % of used ride
 * the payload so both legs paint ONE spelling, and `manage` names the
 * management surface where one exists (the Claude Code /context pattern:
 * every number paired with an action). */
export interface UsageBarSegmentPayload {
  /** The category label ("Messages", "System prompt", …). */
  label: string;
  /** The category's estimated tokens. */
  tokens: number;
  /** The palette key (see usageSegmentHex). */
  color: UsageSegmentColor;
  /** R99-D: the legend row's right-aligned tokens ("34.5k"; "none
   * configured" for an MCP-less session) — pre-formatted by the builder. */
  tokensLabel: string;
  /** R99-D: the legend row's share of the USED context ("86%") —
   * pre-formatted by the builder (one spelling on both legs). */
  pctOfUsed: string;
  /** R99-D: the management deep-link — present ONLY where a real surface
   * exists (system prompt / Memory & skills → the Prompts tab, MCP tools →
   * the MCP tab); the DOM leg renders the link-chip, the overlay leg emits
   * the usage-link pick. Absent = honestly no surface (no dead links). */
  manage?: { target: string; title: string };
}

/** R97-C: the CONTEXT BAR — now the star of the card (R99-D): a full-width
 * horizontal bar of colored segments (one per context category, each ≥12%
 * segment carrying its % label inside) + the reserved-for-output block +
 * free space as the track. The pre-R99 flanking used/window counts are
 * RETIRED — the hero's big line carries them (one source of truth). Hovering
 * a segment (or its legend row) cross-highlights both (kept). */
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
  /** The category segments, in display order (each its own legend row). */
  segments: UsageBarSegmentPayload[];
  /** R98-C3: the pane's label ("Window composition") — the sectioned layout. */
  label?: string;
}

/** R99-D: one honesty pair of the overview's meta block — label:value rows
 * at 10px tertiary ("measured at last request" → "45k", "model" → the id,
 * "window" → the provenance). JSON-safe; NEVER more than 3 rows. */
export interface UsageMetaPair {
  /** The pair's stable id ("measured" | "model" | "window") — the DOM leg
   * maps it onto its legacy testids (data-context-measured / -window-source). */
  id?: string;
  label: string;
  value: string;
  /** Optional tooltip (the measured pair carries its timestamp). */
  title?: string;
}

/** R99-D: the OVERVIEW HERO — the popover's head, replacing the R97-C donut
 * header (ring + five label/value lines). The BIG TOKEN LINE is the primary
 * read ("40k" 19px semibold tabular-nums + "of 200k" smaller); ONE meta line
 * under it carries the percentage FIRST ("~20% projected" — one source of
 * truth per number: the ring lost its center %); the honesty lines collapse
 * into ≤3 label:value pairs; the compaction/reserve stays ONE line; the
 * "Context compacted" badge rides the header row's right side. The ring
 * stays the left visual anchor (46px, the graded color, the budget tick). */
export interface UsageOverviewPayload {
  /** Ring math (raw): used/limit drive the arc, markerFrac the budget tick. */
  used: number;
  limit: number;
  /** The budget-line tick fraction (available/window; 0 hides it). */
  markerFrac: number;
  /** The graded ring color key — matches CONTEXT_DONUT_WARN/DANGER. */
  ringColor: "accent" | "warn" | "danger";
  /** The big number line, pre-formatted: "40k" + "200k" (fmtTokens). */
  bigUsed: string;
  bigLimit: string;
  /** The ONE % line, percentage first: "~20% projected". */
  pctLine: string;
  /** The honesty block — 2-3 label:value pairs (measured / model / window). */
  meta: UsageMetaPair[];
  /** The compaction/reserve line ("compaction line 159k · reserve 33k output"). */
  budgetLine?: string;
  /** The header-row badge (chip + mono detail) when a compaction happened. */
  compactedBadge?: { label: string; detail: string };
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

/** R96-G: one label/value line of a usage section. R97-C added the mini-bar
 * fields; R99-D they survive ONLY on the cache hit-rate row (the breakdown
 * mini-bars retired with the Breakdown section itself — the stacked bar
 * already shows the proportion, the duplicate encoding was the smell). */
export interface UsageLinePayload {
  label: string;
  value: string;
  /** An optional tertiary note riding after the value (" · not reported by
   * this provider"). */
  note?: string;
  /** The emphasized rows — primary text color + bolder value. */
  strong?: boolean;
  /** The bar fraction (0-1 of the line's own track) — the cache hit-rate bar. */
  barFrac?: number;
  /** Which palette color the bar paints (teal for the cache hit rate). */
  barColor?: UsageSegmentColor;
}

/** R96-G: one titled section of the usage card. R97-C added the optional
 * compact table (the session split); R99-D the section list is Cache (one
 * row) + Session totals — the Breakdown merged into the context bar's
 * legend, the overview hero unboxed above them. */
export interface UsageSectionPayload {
  title: string;
  lines: UsageLinePayload[];
  /** An optional compact table under the lines (the session split —
   * Turns / Provider calls / Tokens sent ↑ / received ↓ / Cost per group). */
  table?: {
    columns: string[];
    rows: UsageTableRowPayload[];
  };
}

/** R96-G: the usage rich card — the ContextDonut popover's content as a
 * structured payload for the overlay window (no items: it is a hover READ).
 * R97-C grew it into the full visual card; R99-D restructures it after the
 * Claude Code /context reference: the overview HERO (big token line + %
 * line + honesty pairs), the full-width stacked bar with per-segment labels
 * + its legend rows (tokens/%/manage), the one-row Cache, and the session
 * table. The R97-C bottom `note` is RETIRED — its content moved into the
 * badge (compaction) and the meta pairs (window provenance), killing the
 * duplicate encodings. */
export interface UsageCardPayload {
  kind: "usage";
  title: string;
  /** The card's CSS width (the DOM popover's 420). */
  width: number;
  /** R97-C: the stacked context bar + its legend (the star of the card). */
  contextBar?: UsageContextBarPayload;
  /** R99-D: the overview hero (the card's unboxed head). */
  overview?: UsageOverviewPayload;
  sections: UsageSectionPayload[];
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
 * R98-C3: the card became a stack of sectioned panes. R99-D: the OVERVIEW
 * HERO is unboxed (the card's own head — no pane overhead, its rows counted
 * directly: big line + % line + meta pairs + the budget line + the block's
 * gap); the panes below are Window composition (bar + hint + legend rows)
 * / Cache (one line) / Session totals (the table). The note row is retired
 * (its content moved into the badge + the meta pairs). */
export const USAGE_CARD_CHROME_PX = 55; // strip + title row + outer paddings
/** R99-D: the micro-header grammar — a 10px uppercase tracked label (13)
 * + the 8px margin below it. */
export const USAGE_SECTION_TITLE_PX = 21;
/** R98-C3: the per-pane overhead — border(2) + padding(18) + the gap below
 * the pane (8). The LAST pane's gap is never subtracted (biased tall — the
 * safe direction: a few px of breathing room, never a clipped row). */
export const USAGE_PANE_PX = 28;
/** R99-D: the overview hero's rows — the big token line (19px + leading),
 * the ONE % meta line, one 10px label:value pair, the 46px ring floor, the
 * compaction/reserve line, and the gap below the whole block. */
export const USAGE_HERO_BIG_PX = 24;
export const USAGE_HERO_PCT_PX = 15;
export const USAGE_HERO_META_PX = 13;
export const USAGE_HERO_RING_PX = 46;
export const USAGE_HERO_BUDGET_PX = 17;
export const USAGE_HERO_GAP_PX = 10;
/** R99-D: the full-width composition bar (14px tall, the flanking counts
 * retired — the hero's big line carries them) + its gap below. */
export const USAGE_CONTEXT_BAR_PX = 20;
/** R99-D: the legend's column-hint row ("tokens · % of used"). */
export const USAGE_LEGEND_HINT_PX = 13;
/** R99-D: one legend row (dot + label + tokens + % — the mini-bars retired). */
export const USAGE_LEGEND_ROW_PX = 22;
/** R99-D: one label/value line (the cache row). */
export const USAGE_LINE_PX = 17;
/** R97-C: one table row (the compact 10px cells + padding). */
export const USAGE_TABLE_ROW_PX = 18;
/** R97-C: the table's header row (same rhythm, +1 for the divider). */
export const USAGE_TABLE_HEAD_PX = 19;
/** R99-D: a bar segment earns its inline % label only at/above this fraction
 * of the WINDOW (≈ its share of the bar's width) — narrower segments stay
 * unlabeled (truncating honestly; the legend carries their numbers). Exported
 * so BOTH legs (DOM popover + overlay window) gate on ONE threshold. */
export const USAGE_BAR_LABEL_MIN_FRAC = 0.12;

/** R99-D: the overlay window's height for a usage card — the honest row
 * count: chrome + the unboxed overview hero (big/%/meta rows vs the ring
 * floor + the budget line + the block gap) + every pane's overhead (border+
 * padding+gap + the label row) + the bar/hint/legend rows + each section's
 * lines + the table, floored at the Rust command's 40px minimum. Pure;
 * exported for tests. */
export function estimateUsageCardHeight(payload: UsageCardPayload): number {
  const overview =
    payload.overview !== undefined
      ? Math.max(
          USAGE_HERO_RING_PX,
          USAGE_HERO_BIG_PX + USAGE_HERO_PCT_PX + payload.overview.meta.length * USAGE_HERO_META_PX,
        ) +
        (payload.overview.budgetLine !== undefined ? USAGE_HERO_BUDGET_PX : 0) +
        USAGE_HERO_GAP_PX
      : 0;
  const panes =
    (payload.contextBar !== undefined ? 1 : 0) + payload.sections.length;
  const paneOverhead = panes * (USAGE_PANE_PX + USAGE_SECTION_TITLE_PX);
  const contextBar =
    payload.contextBar !== undefined
      ? USAGE_CONTEXT_BAR_PX +
        USAGE_LEGEND_HINT_PX +
        payload.contextBar.segments.length * USAGE_LEGEND_ROW_PX
      : 0;
  const sections = payload.sections.reduce(
    (acc, s) =>
      acc +
      s.lines.length * USAGE_LINE_PX +
      (s.table !== undefined ? USAGE_TABLE_HEAD_PX + s.table.rows.length * USAGE_TABLE_ROW_PX : 0),
    0,
  );
  return Math.max(40, USAGE_CARD_CHROME_PX + overview + paneOverhead + contextBar + sections);
}

/** A picked item as reported back (kind + the discriminated item). R99-D
 * adds the "usage-link" kind: the usage card's legend link-chips (the
 * Claude Code /context "every number paired with an action" pattern) report
 * their deep-link target through the SAME channel the menu picks use — the
 * main window's ContextDonut closes the popover + router-navigates. */
export interface UsageLinkPick {
  kind: "usage-link";
  /** The router target ("/settings?tab=prompts"). */
  target: string;
}

export type MenuPick =
  | { kind: "quick" | "subagents" | "options"; item: MenuItemPayload }
  | UsageLinkPick;

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
