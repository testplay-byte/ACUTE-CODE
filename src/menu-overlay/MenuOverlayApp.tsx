/**
 * ROUND-90 (R90-C2) — the menu overlay window's page (menu-overlay.html).
 *
 * Renders the right sidebar's popovers (the quick menu / the sub-agent
 * picker) INSIDE the owned transparent OS window browser.rs positions
 * above the live embedded browser — the visual twin of the DOM QuickMenu /
 * SubAgentPicker in RightSidebar.tsx (same card rhythm, same row layout,
 * same hover treatment), painted from the payload the main window sends.
 *
 * Data flow: the payload arrives from the `menu_overlay_pending` stash on
 * mount (a page still loading when `menu_overlay_show` fired) or from the
 * "menu-overlay-data" event on every subsequent show. Clicks report back
 * through "menu-overlay-pick"; Escape (when this window somehow holds
 * focus — it is built focusable(false)) reports "menu-overlay-close". The
 * main window's bridge (src/lib/menu-overlay.ts) owns both ends.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  Bot,
  Brain,
  Check,
  ClipboardList,
  FolderOpen,
  FolderTree,
  Globe,
  HardDriveUpload,
  ShieldCheck,
  Terminal as TerminalIcon,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  USAGE_BAR_LABEL_MIN_FRAC,
  USAGE_CARD_CHROME_PX,
  USAGE_LINE_PX,
  USAGE_SECTION_TITLE_PX,
  USAGE_TABLE_ROW_PX,
  usageSegmentHex,
  type MenuOverlayPayload,
  type UsageCardPayload,
  type MenuItemPayload,
  type MenuPayload,
  type UsageSegmentColor,
} from "../lib/menu-overlay";
import { formatTokenCount } from "../lib/format";
// R99-D: the bar labels' ink — the theme pipeline's own contrast helper
// (black/white by luminance, same spelling as every other surface).
// R126-3h: the SEMANTIC_COLORS import is retired — the ring's warn/danger
// legs + every status/role ink now arrive through the payload's deep-tier
// values (MenuTheme's new fields; the overlay never resolves flat hexes).
import { getContrastText } from "../lib/themes";

/** The lucide icons the payload addresses by name (the quick menu's set +
 * R92-A: the composer option menus' rows). */
const ICONS: Record<string, LucideIcon> = {
  "folder-tree": FolderTree,
  globe: Globe,
  terminal: TerminalIcon,
  brain: Brain,
  activity: Activity,
  bot: Bot,
  zap: Zap,
  shield: ShieldCheck,
  clipboard: ClipboardList,
  "hard-drive-upload": HardDriveUpload,
  "folder-open": FolderOpen,
};

type TauriInvokeFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type TauriListenFn = (event: string, handler: (ev: { payload: unknown }) => void) => Promise<() => void>;
type TauriEmitFn = (event: string, payload?: unknown) => Promise<void>;

interface MenuOverlayShell {
  core: { invoke: TauriInvokeFn };
  event: { listen: TauriListenFn; emit: TauriEmitFn };
}

function shell(): MenuOverlayShell | null {
  const tauri = (window as unknown as { __TAURI__?: MenuOverlayShell }).__TAURI__;
  if (
    tauri === undefined ||
    typeof tauri?.core?.invoke !== "function" ||
    typeof tauri?.event?.listen !== "function" ||
    typeof tauri?.event?.emit !== "function"
  ) {
    return null;
  }
  return tauri;
}

/** Parse a payload event value (string JSON or already-decoded object). */
function parsePayload(raw: unknown): MenuOverlayPayload | null {
  if (typeof raw !== "string") {
    if (raw !== null && typeof raw === "object" && (raw as MenuPayload).kind !== undefined) {
      return raw as MenuPayload;
    }
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && (parsed as MenuPayload).kind !== undefined) {
      return parsed as MenuPayload;
    }
    return null;
  } catch {
    return null;
  }
}

export function MenuOverlayApp(): React.ReactElement {
  const [payload, setPayload] = useState<MenuOverlayPayload | null>(null);

  useEffect(() => {
    const sh = shell();
    if (sh === null) return;
    let unlisten: (() => void) | null = null;
    let alive = true;
    // The mount race: the show command stashed the payload BEFORE this
    // page finished loading (the popout pending-URL pattern). Read it once,
    // then subscribe for live re-shows.
    void sh.core
      .invoke("menu_overlay_pending")
      .then((raw) => {
        if (!alive) return;
        const parsed = parsePayload(raw);
        if (parsed !== null) setPayload(parsed);
      })
      .catch(() => {});
    void sh.event
      .listen("menu-overlay-data", (ev) => {
        const parsed = parsePayload(ev.payload);
        if (parsed !== null) setPayload(parsed);
      })
      .then((fn) => {
        if (!alive) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // Escape closes (only fires when this window holds keyboard focus — it is
  // built focusable(false), so the MAIN window's Escape is the usual path;
  // this is the belt to its braces).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        const sh = shell();
        if (sh !== null) void sh.event.emit("menu-overlay-close").catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pick = useCallback((item: MenuItemPayload) => {
    const sh = shell();
    if (sh === null) return;
    // R92-A: the item's own discriminated kind maps onto the MENU's pick
    // kind ("sub" items belong to the "subagents" menu; "options" items to
    // the composer's generic option menus).
    const menuKind = item.kind === "quick" ? "quick" : item.kind === "sub" ? "subagents" : "options";
    void sh.event.emit("menu-overlay-pick", { kind: menuKind, item }).catch(() => {});
  }, []);

  // R96-G: the USAGE card's hover bridge — the window owns the pointer while
  // it is over the card, so the main window's mouseleave fired the moment
  // the pointer crossed into this OS window. Report enter/leave back so the
  // ContextDonut can keep its hover-grace semantics (parking the pointer on
  // the card keeps it open, leaving closes it) — the R51 hover-bridge
  // problem, restated across a window boundary.
  const reportHover = useCallback((hovering: boolean) => {
    const sh = shell();
    if (sh === null) return;
    void sh.event.emit("menu-overlay-hover", { hovering }).catch(() => {});
  }, []);

  // R99-D: the USAGE card's LINK picks — the legend's "manage in Settings"
  // chips report their deep-link target through the same pick channel the
  // menus use (the "usage-link" kind; every menu subscriber filters by its
  // own kind). The main window's ContextDonut closes the popover +
  // router-navigates — the Claude Code /context "every number paired with
  // an action" pattern, alive on the overlay leg too (the desktop's
  // primary one).
  const reportLink = useCallback((target: string) => {
    const sh = shell();
    if (sh === null) return;
    void sh.event.emit("menu-overlay-pick", { kind: "usage-link", target }).catch(() => {});
  }, []);

  if (payload === null) {
    // No payload yet (the window prewarms hidden at sidebar mount — a
    // transparent nothing is the correct idle render).
    return <></>;
  }
  if (payload.kind === "usage") {
    return <UsageCard payload={payload} reportHover={reportHover} reportLink={reportLink} />;
  }
  const t = payload.theme;
  return (
    <div
      className="acute-menu-card"
      style={{
        boxSizing: "border-box",
        width: "100%",
        height: "100%",
        padding: 6,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          boxSizing: "border-box",
          width: payload.width,
          maxWidth: "100%",
          maxHeight: "100%",
          overflowY: payload.items.length > 7 ? "auto" : "hidden",
          borderRadius: 12,
          // R126-3h (TOKENS §5/§9 — the menu card RISES): the clay card —
          // the clay-rim hairline + the UPWARD sheet shadow from the
          // payload (the border/softShadow legs the pre-R126 theme sent
          // are retired for the card chrome).
          border: `1px solid ${t.clayRim}`,
          background: t.card,
          boxShadow: t.claySheetShadow,
          padding: 6,
        }}
        role="menu"
        aria-label={payload.title}
      >
        <div
          style={{
            padding: "2px 6px 4px",
            fontSize: 9.5,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: t.textTertiary,
          }}
        >
          {payload.title}
        </div>
        {payload.items.map((item) =>
          item.kind === "quick" ? (
            <button
              key={item.type}
              onClick={() => pick(item)}
              style={{
                all: "unset",
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                width: "100%",
                boxSizing: "border-box",
                padding: "6px",
                borderRadius: 8,
                cursor: "pointer",
                textAlign: "left",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = t.subtleHover;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              {(() => {
                const Icon = ICONS[item.icon] ?? Globe;
                return <Icon size={16} style={{ color: t.accent, flexShrink: 0, marginTop: 1 }} aria-hidden />;
              })()}
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 12, fontWeight: 600, lineHeight: 1.2, color: t.text }}>
                  {item.label}
                </span>
                <span style={{ display: "block", fontSize: 10.5, lineHeight: 1.2, marginTop: 2, color: t.textTertiary }}>
                  {item.desc}
                </span>
              </span>
            </button>
          ) : item.kind === "sub" ? (
            <button
              key={item.id}
              onClick={() => pick(item)}
              style={{
                all: "unset",
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                boxSizing: "border-box",
                padding: "6px",
                borderRadius: 8,
                cursor: "pointer",
                textAlign: "left",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = t.subtleHover;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  fontFamily: "var(--font-mono, ui-monospace, monospace)",
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "2px 6px",
                  borderRadius: 6,
                  letterSpacing: "0.08em",
                  // R126-3h: the code chip = the selection grammar
                  // (accentTint container + accentDeep ink — the DOM
                  // twin's WorkingSection code-chip spelling; the
                  // withAlpha(accent) fill dies).
                  background: t.accentTint,
                  color: t.accentDeep,
                }}
              >
                {item.code}
              </span>
              <span
                style={{
                  flexShrink: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 9,
                  fontFamily: "var(--font-mono, ui-monospace, monospace)",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  padding: "2px 6px",
                  borderRadius: 6,
                  // R126-3h (TOKENS §11 — hue-as-data is dots-only): the
                  // role chip = the NEUTRAL badge tone container + the role
                  // hue as a DOT (the DOM twin's spelling; the
                  // withAlpha(roleColor) fill + roleColor text die).
                  background: t.badgeNeutralBg,
                  color: t.badgeNeutralFg,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 999,
                    background: item.roleColor,
                    flexShrink: 0,
                  }}
                />
                {item.role}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: 11,
                  fontWeight: 500,
                  color: t.text,
                }}
              >
                {item.title}
              </span>
              <span
                // R126-3h: the status text rides the §11 deep/bright pairs
                // (the flat tertiary ink dies) — the DOM twin's exact
                // status-to-tier mapping.
                style={{
                  flexShrink: 0,
                  fontSize: 10,
                  color:
                    item.status === "running" || item.status === "queued"
                      ? t.runningDeep
                      : item.status === "failed"
                        ? t.dangerDeep
                        : item.status === "completed"
                          ? t.successDeep
                          : t.textSecondary,
                }}
              >
                {item.status}
              </span>
            </button>
          ) : (
            /* R92-A: the OPTIONS kind — the composer's mode / thinking /
             * add-context menus. The same visual language as the quick menu
             * (icon + label + optional desc, hover tint, click → pick) PLUS
             * the DOM menus' selected treatment: a checkmark on the selected
             * row + its accent-tinted background + accent label (the twin
             * of ModeSwitcher's role=menuitemradio rows). */
            <button
              key={item.id}
              onClick={() => pick(item)}
              title={item.desc ?? ""}
              style={{
                all: "unset",
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                width: "100%",
                boxSizing: "border-box",
                padding: "6px",
                borderRadius: 8,
                cursor: "pointer",
                textAlign: "left",
                background: item.selected === true ? t.accentTint : "transparent",
              }}
              onMouseEnter={(e) => {
                if (item.selected !== true) e.currentTarget.style.background = t.subtleHover;
              }}
              onMouseLeave={(e) => {
                if (item.selected !== true) e.currentTarget.style.background = "transparent";
              }}
            >
              {(() => {
                const Icon = item.icon !== undefined ? (ICONS[item.icon] ?? Globe) : null;
                return Icon !== null ? (
                  <Icon size={16} style={{ color: t.accent, flexShrink: 0, marginTop: 1 }} aria-hidden />
                ) : null;
              })()}
              <span style={{ minWidth: 0, flex: 1 }}>
                <span
                  style={{
                    display: "block",
                    fontSize: 12,
                    fontWeight: 600,
                    lineHeight: 1.2,
                    // R126-3h: the selected label = accentDeep ink (the
                    // selection grammar's text tier — the flat accent
                    // label dies; the row bg is accentTint above).
                    color: item.selected === true ? t.accentDeep : t.text,
                  }}
                >
                  {item.label}
                </span>
                {item.desc !== undefined ? (
                  <span style={{ display: "block", fontSize: 10.5, lineHeight: 1.2, marginTop: 2, color: t.textTertiary }}>
                    {item.desc}
                  </span>
                ) : null}
              </span>
              {item.selected === true ? (
                <Check size={14} style={{ color: t.accentDeep, flexShrink: 0, marginTop: 1 }} aria-hidden />
              ) : null}
            </button>
          ),
        )}
        {payload.items.length === 0 ? (
          <div style={{ padding: "8px 6px", fontSize: 11, color: t.textTertiary }}>
            No sub-agents in this session.
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** hex/#rrggbb → rgba() with alpha (the dashboard helpers' trick, local copy
 * so this page stays standalone). Falls back to the input for unknown forms. */
function withAlpha(color: string, alpha: number): string {
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if ([r, g, b].every(Number.isFinite)) return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    if (hex.length === 3) {
      const r = parseInt(hex.slice(0, 1) + hex.slice(0, 1), 16);
      const g = parseInt(hex.slice(1, 2) + hex.slice(1, 2), 16);
      const b = parseInt(hex.slice(2, 3) + hex.slice(2, 3), 16);
      if ([r, g, b].every(Number.isFinite)) return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
  }
  return color;
}

/**
 * ROUND-96 (R96-G) → R97-C → R99-D: the USAGE rich card — the ContextDonut's
 * popover painted inside this OS window, so hovering the token usage reads
 * ABOVE the live embedded-browser webview instead of pausing it behind the
 * R89-E5 guard's caption. R99-D repaints it as the DOM popover's twin from
 * the SAME payload build (buildUsageCardSections): the OVERVIEW HERO (the
 * big token line + ONE %-first meta line + ≤3 honesty pairs + the
 * compaction/reserve line + the compacted badge on the header row — the ring
 * stays the left anchor with NO center %: one source of truth per number),
 * the full-width STACKED BAR with per-segment % labels (segments ≥12% of the
 * window only) + the LEGEND rows under it (palette dot + label + tokens +
 * % of used; the label is a link-chip where a management surface exists —
 * the pick reports back through reportLink), the one-row CACHE, and the
 * session TABLE. Hovering a bar segment highlights its legend row and vice
 * versa (the Cursor-style mutual highlight).
 *
 * The card FILLS the window (the main window estimated its height from the
 * same px contract the lines below paint to — USAGE_* in lib/menu-overlay.ts)
 * and scrolls when the estimate came in short, never clipping silently.
 */
function UsageCard({
  payload,
  reportHover,
  reportLink,
}: {
  payload: UsageCardPayload;
  reportHover: (hovering: boolean) => void;
  reportLink: (target: string) => void;
}): React.ReactElement {
  const t = payload.theme;
  // R97-C: the mutual hover-highlight's shared state — the currently hovered
  // category label (a bar segment OR its legend row owns it; both paint the
  // highlight from the same string).
  const [hoverSeg, setHoverSeg] = useState<string | null>(null);
  const segHex = useCallback(
    (color: UsageSegmentColor): string => usageSegmentHex(color, t.isDark, t.accent),
    [t.isDark, t.accent],
  );
  const ringHex =
    payload.overview?.ringColor === "danger"
      ? t.dangerDeep
      : payload.overview?.ringColor === "warn"
        ? t.warningDeep
        : t.accentDeep;
  // R98-C3 → R99-D: THE PANE — the sectioned card's building block, the DOM
  // popover's Pane twin (subtle wash + hairline border + the micro-header —
  // the ONE grammar: 10px uppercase tracked label + the 8px margin below).
  const paneStyle: React.CSSProperties = {
    borderRadius: 10,
    border: `1px solid ${t.border}`,
    background: withAlpha(t.text, 0.04),
    padding: 9,
    marginBottom: 8,
  };
  const paneLabelStyle: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.1em",
    color: t.textTertiary,
    marginBottom: 8,
    // The estimator's USAGE_SECTION_TITLE_PX (21) is this label's row
    // height (13 label + 8 margin) — minHeight keeps the two sides honest.
    minHeight: USAGE_SECTION_TITLE_PX,
  };
  const monoFamily = "var(--font-mono, ui-monospace, monospace)";
  const tabular: React.CSSProperties = { fontVariantNumeric: "tabular-nums" as const };
  return (
    <div
      className="acute-menu-card"
      style={{ boxSizing: "border-box", width: "100%", height: "100%", padding: 6, overflow: "hidden" }}
      onMouseEnter={() => reportHover(true)}
      onMouseLeave={() => reportHover(false)}
    >
      <div
        role="group"
        aria-label={payload.title}
        style={{
          boxSizing: "border-box",
          width: payload.width,
          maxWidth: "100%",
          height: "100%",
          overflowY: "auto",
          borderRadius: 12,
          // R126-3h (TOKENS §5/§9 — the card RISES): the clay card chrome
          // (clay-rim hairline + the UPWARD sheet shadow from the payload).
          border: `1px solid ${t.clayRim}`,
          background: t.card,
          boxShadow: t.claySheetShadow,
          padding: 10,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* The head — the DOM popover's 3px accent strip, restated. */}
        <div
          aria-hidden
          style={{
            height: 3,
            borderRadius: 999,
            background: `linear-gradient(90deg, ${t.accent}, ${withAlpha(t.accent, 0.15)})`,
            marginBottom: 8,
          }}
        />
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: t.text,
            paddingBottom: 8,
          }}
        >
          {payload.title}
        </div>

        {/* ── R99-D: the OVERVIEW HERO — the card's unboxed head (no section
            header: it IS the top), the DOM popover's twin. The big token line
            is the primary read; ONE % line under it (percentage first); the
            honesty pairs; the compaction/reserve line; the badge on the
            header row. */}
        {payload.overview !== undefined ? (
          <div data-usage-overview style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
              <UsageDonutRing
                used={payload.overview.used}
                limit={payload.overview.limit}
                markerFrac={payload.overview.markerFrac}
                color={ringHex}
                track={withAlpha(t.text, 0.12)}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                {/* The big number line + the compacted badge. */}
                <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
                  <span
                    style={{
                      fontFamily: monoFamily,
                      fontSize: 19,
                      fontWeight: 600,
                      lineHeight: 1,
                      color: t.text,
                      ...tabular,
                    }}
                  >
                    {payload.overview.bigUsed}
                  </span>
                  <span style={{ fontSize: 11, color: t.textTertiary, whiteSpace: "nowrap", ...tabular }}>
                    {" "}
                    of {payload.overview.bigLimit}
                  </span>
                  {payload.overview.compactedBadge !== undefined ? (
                    <span
                      title={`${payload.overview.compactedBadge.label} · ${payload.overview.compactedBadge.detail}`}
                      style={{ marginLeft: "auto", display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}
                    >
                      <span style={{ fontSize: 10, fontWeight: 700, color: t.accent, whiteSpace: "nowrap" }}>
                        {payload.overview.compactedBadge.label}
                      </span>
                      <span
                        style={{
                          fontFamily: monoFamily,
                          fontSize: 9.5,
                          color: t.textTertiary,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          ...tabular,
                        }}
                      >
                        {payload.overview.compactedBadge.detail}
                      </span>
                    </span>
                  ) : null}
                </div>
                {/* The ONE % meta line — percentage first. */}
                <div
                  style={{
                    marginTop: 4,
                    fontFamily: monoFamily,
                    fontSize: 12,
                    fontWeight: 600,
                    color: t.text,
                    ...tabular,
                  }}
                >
                  {payload.overview.pctLine}
                </div>
                {/* The honesty block — ≤3 label:value pairs at 10px. */}
                <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }}>
                  {payload.overview.meta.map((pair) => (
                    <div
                      key={pair.id ?? pair.label}
                      title={pair.title}
                      style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}
                    >
                      <span style={{ fontSize: 10, color: t.textTertiary, whiteSpace: "nowrap" }}>
                        {pair.label}
                      </span>
                      <span
                        style={{
                          fontFamily: monoFamily,
                          fontSize: 10,
                          color: t.textSecondary,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          minWidth: 0,
                          ...tabular,
                        }}
                      >
                        {pair.value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            {/* The compaction/reserve line — ONE line. */}
            {payload.overview.budgetLine !== undefined ? (
              <div
                style={{
                  marginTop: 6,
                  fontFamily: monoFamily,
                  fontSize: 9.5,
                  color: t.textTertiary,
                  ...tabular,
                }}
              >
                {payload.overview.budgetLine}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* ── R97-C → R99-D: the CONTEXT BAR pane — the stacked bar (the
            star: full width, 14px tall, per-segment % labels at ≥12% of the
            window, the reserved hatched block, the free track) + its LEGEND
            (the old Breakdown merged under the bar; the mini-bars retired). */}
        {payload.contextBar !== undefined ? (
          <div style={paneStyle} data-usage-pane="window">
            <div style={paneLabelStyle}>{payload.contextBar.label ?? "Window composition"}</div>
            <div
              data-usage-context-bar
              role="img"
              aria-label={
                "Context composition (share of window): " +
                payload.contextBar.segments
                  .map((seg) => {
                    const frac =
                      payload.contextBar !== undefined && payload.contextBar.windowTokens > 0
                        ? Math.min(1, seg.tokens / payload.contextBar.windowTokens)
                        : 0;
                    return `${seg.label} ${Math.round(frac * 100)}%`;
                  })
                  .join(", ")
              }
              style={{
                display: "flex",
                width: "100%",
                height: 14,
                borderRadius: 7,
                background: withAlpha(t.text, 0.1),
                overflow: "hidden",
              }}
            >
              {payload.contextBar.segments.map((seg) => {
                const frac =
                  payload.contextBar !== undefined && payload.contextBar.windowTokens > 0
                    ? Math.min(1, seg.tokens / payload.contextBar.windowTokens)
                    : 0;
                const lit = hoverSeg === seg.label;
                const hex = segHex(seg.color);
                // R99-D: the inline % label — only for segments ≥12% of the
                // window (narrower ones stay honest-quiet; the legend carries
                // their numbers). The ink rides the theme pipeline's own
                // contrast helper.
                const showLabel = frac >= USAGE_BAR_LABEL_MIN_FRAC;
                return (
                  <div
                    key={seg.label}
                    title={`${seg.label} · ${formatTokenCount(seg.tokens)} tokens · ${Math.round(frac * 100)}% of window`}
                    onMouseEnter={() => setHoverSeg(seg.label)}
                    onMouseLeave={() => setHoverSeg(null)}
                    style={{
                      width: `${frac * 100}%`,
                      height: "100%",
                      background: hex,
                      opacity: hoverSeg === null || lit ? 1 : 0.35,
                      transition: "opacity 120ms ease",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      overflow: "hidden",
                      ...(lit ? { boxShadow: `0 0 0 1px ${withAlpha(hex, 0.6)}` } : {}),
                    }}
                  >
                    {showLabel ? (
                      <span
                        style={{
                          fontFamily: monoFamily,
                          fontSize: 9,
                          fontWeight: 700,
                          lineHeight: 1,
                          color: getContrastText(hex),
                          whiteSpace: "nowrap",
                          ...tabular,
                        }}
                      >
                        {`${Math.round(frac * 100)}%`}
                      </span>
                    ) : null}
                  </div>
                );
              })}
              {/* The reserved-for-output block — dimmed + hatched, after the
                  used segments, so "free" never reads as fully usable. */}
              {payload.contextBar.windowTokens > 0 && payload.contextBar.reservedTokens > 0 ? (
                <div
                  title={`Reserved for output · ${formatTokenCount(payload.contextBar.reservedTokens)} tokens`}
                  style={{
                    width: `${Math.min(
                      100 - payload.contextBar.usedPct,
                      (payload.contextBar.reservedTokens / payload.contextBar.windowTokens) * 100,
                    )}%`,
                    height: "100%",
                    background: `repeating-linear-gradient(45deg, ${withAlpha(segHex("reserved"), 0.55)}, ${withAlpha(
                      segHex("reserved"),
                      0.55,
                    )} 2px, ${withAlpha(segHex("reserved"), 0.25)} 2px, ${withAlpha(segHex("reserved"), 0.25)} 4px)`,
                  }}
                />
              ) : null}
            </div>
            {/* R99-D: the legend's column hint — the % base named once. */}
            <div
              style={{
                marginTop: 6,
                textAlign: "right",
                fontFamily: monoFamily,
                fontSize: 9,
                textTransform: "uppercase" as const,
                letterSpacing: "0.06em",
                color: t.textTertiary,
              }}
            >
              tokens · % of used
            </div>
            {/* R99-D: the LEGEND rows — one per category (dot + label + tokens
                + % of used); a management surface turns the label into a
                link-chip whose pick reports back through reportLink. */}
            <div style={{ marginTop: 2, display: "flex", flexDirection: "column", gap: 3 }}>
              {payload.contextBar.segments.map((seg) => {
                const lit = hoverSeg === seg.label;
                const manage = seg.manage;
                return (
                  <div
                    key={seg.label}
                    data-usage-legend={seg.label}
                    onMouseEnter={() => setHoverSeg(seg.label)}
                    onMouseLeave={() => setHoverSeg(null)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      paddingTop: 2,
                      paddingBottom: 2,
                      borderRadius: 5,
                      ...(lit ? { background: withAlpha(t.text, 0.05) } : {}),
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 999,
                        background: segHex(seg.color),
                        flexShrink: 0,
                        opacity: hoverSeg === null || lit ? 1 : 0.4,
                        transition: "opacity 120ms ease",
                      }}
                    />
                    {manage !== undefined ? (
                      <button
                        type="button"
                        onClick={() => reportLink(manage.target)}
                        title={manage.title}
                        aria-label={`${seg.label} — manage in Settings`}
                        style={{
                          all: "unset",
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          gap: 3,
                          minWidth: 0,
                          flex: 1,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 10.5,
                            color: lit ? t.text : t.textSecondary,
                            ...(lit ? { fontWeight: 700 } : {}),
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {seg.label}
                        </span>
                        <ArrowUpRight
                          aria-hidden
                          size={9}
                          style={{ color: t.accent, flexShrink: 0, opacity: 0.6 }}
                        />
                      </button>
                    ) : (
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: 10.5,
                          color: lit ? t.text : t.textSecondary,
                          ...(lit ? { fontWeight: 700 } : {}),
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {seg.label}
                      </span>
                    )}
                    <span
                      style={{
                        fontFamily: monoFamily,
                        fontSize: 10,
                        color: t.textTertiary,
                        flexShrink: 0,
                        ...tabular,
                      }}
                    >
                      {seg.tokensLabel}
                    </span>
                    <span
                      style={{
                        fontFamily: monoFamily,
                        fontSize: 10,
                        color: lit ? t.text : t.textSecondary,
                        flexShrink: 0,
                        width: 32,
                        textAlign: "right",
                        ...tabular,
                      }}
                    >
                      {seg.pctOfUsed}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {payload.sections.map((section, si) => (
          <div key={`${si}-${section.title}`} style={paneStyle} data-usage-pane={section.title}>
            <div style={paneLabelStyle}>{section.title}</div>
            {section.lines.map((line, li) => (
              <div
                key={`${li}-${line.label}`}
                style={{ display: "flex", alignItems: "center", gap: 8, minHeight: USAGE_LINE_PX }}
              >
                <span style={{ fontSize: 10.5, color: t.textSecondary, whiteSpace: "nowrap" }}>
                  {line.label}
                </span>
                {/* R99-D: the line's own slim bar (the cache hit rate). */}
                {line.barFrac !== undefined && line.barColor !== undefined ? (
                  <span
                    aria-hidden
                    style={{
                      width: 48,
                      height: 3,
                      borderRadius: 2,
                      background: withAlpha(t.text, 0.1),
                      overflow: "hidden",
                      flexShrink: 0,
                      display: "block",
                    }}
                  >
                    <span
                      style={{
                        display: "block",
                        width: `${Math.max(2, Math.min(100, line.barFrac * 100))}%`,
                        height: "100%",
                        borderRadius: 2,
                        background: segHex(line.barColor),
                      }}
                    />
                  </span>
                ) : null}
                <span
                  style={{
                    marginLeft: "auto",
                    fontFamily: monoFamily,
                    fontSize: 10.5,
                    fontWeight: line.strong === true ? 700 : 500,
                    color: line.strong === true ? t.text : t.textSecondary,
                    textAlign: "right",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                    flex: 1,
                    ...tabular,
                  }}
                >
                  {line.value}
                  {line.note !== undefined && line.note !== "" ? (
                    <span style={{ fontWeight: 400, color: t.textTertiary }}> · {line.note}</span>
                  ) : null}
                </span>
              </div>
            ))}
            {/* R97-C → R99-D: the session TABLE — the compact split (Turns /
                Calls / Sent / Received / Cost per group), the strong row
                emphasized, tabular-nums on every numeric. */}
            {section.table !== undefined ? (
              <div data-usage-table style={{ display: "flex", flexDirection: "column" }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1.2fr) repeat(5, minmax(0, 1fr))",
                    gap: "0 4px",
                    paddingBottom: 2,
                    marginBottom: 2,
                    borderBottom: `1px solid ${t.border}`,
                  }}
                >
                  {section.table.columns.map((col, ci) => (
                    <span
                      key={ci}
                      style={{
                        fontSize: 8.5,
                        fontWeight: 700,
                        textTransform: "uppercase" as const,
                        letterSpacing: "0.06em",
                        color: t.textTertiary,
                        textAlign: ci === 0 ? "left" : "right",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {col}
                    </span>
                  ))}
                </div>
                {section.table.rows.map((row, ri) => (
                  <div
                    key={`${ri}-${row.label}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(0, 1.2fr) repeat(5, minmax(0, 1fr))",
                      gap: "0 4px",
                      alignItems: "baseline",
                      minHeight: USAGE_TABLE_ROW_PX,
                      paddingTop: 1,
                      paddingBottom: 1,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: row.strong === true ? 700 : 500,
                        color: row.strong === true ? t.text : t.textSecondary,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {row.label}
                    </span>
                    {row.cells.map((cell, ci) => (
                      <span
                        key={ci}
                        style={{
                          fontFamily: monoFamily,
                          fontSize: 10,
                          fontWeight: row.strong === true ? 700 : 500,
                          color: row.strong === true ? t.text : t.textSecondary,
                          textAlign: "right",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          ...tabular,
                        }}
                      >
                        {cell}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** R97-C → R99-D: the usage card's donut ring — the DOM popover's DonutRing
 * as a self-contained SVG (this page does not import the composer's
 * component; same math: the -90° origin, the graded color, the budget
 * tick). R99-D: NO center % anymore — the hero's % line is the one source
 * of truth for that number (the ring is the visual anchor, not a readout). */
function UsageDonutRing({
  used,
  limit,
  markerFrac,
  color,
  track,
}: {
  used: number;
  limit: number;
  markerFrac: number;
  color: string;
  track: string;
}): React.ReactElement {
  const size = 46;
  const stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = limit > 0 ? Math.min(1, used / limit) : 0;
  const marker =
    markerFrac > 0 && markerFrac < 1
      ? (() => {
          const angle = -Math.PI / 2 + markerFrac * 2 * Math.PI;
          const cx = size / 2;
          const cy = size / 2;
          const x1 = cx + Math.cos(angle) * (r - stroke / 2 - 2);
          const y1 = cy + Math.sin(angle) * (r - stroke / 2 - 2);
          const x2 = cx + Math.cos(angle) * (r + stroke / 2 + 2);
          const y2 = cy + Math.sin(angle) * (r + stroke / 2 + 2);
          return (
            <line x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={1.5} stroke={track} strokeLinecap="round" />
          );
        })()
      : null;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeDasharray={`${frac * c} ${c}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dasharray 300ms ease-out" }}
      />
      {marker}
    </svg>
  );
}

/*
 * The px contract's honesty guard: the estimator (lib/menu-overlay.ts) and
 * this card MUST agree on how tall a usage card is — the constants imported
 * above are the same ones the estimator sums (USAGE_LINE_PX is the section
 * lines' minHeight, USAGE_SECTION_TITLE_PX the pane label's, USAGE_TABLE_ROW_PX
 * the session table's rows, USAGE_BAR_LABEL_MIN_FRAC the inline-label gate
 * both legs share; USAGE_CARD_CHROME_PX covers the head strip + title row +
 * the card paddings painted around them here). A drift between the two sides
 * shows up as clipped rows or dead card space — pinned by menu-overlay.test.
 */
void USAGE_CARD_CHROME_PX;
