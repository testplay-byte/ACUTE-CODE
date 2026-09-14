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
  USAGE_CARD_CHROME_PX,
  USAGE_LINE_PX,
  USAGE_NOTE_PX,
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
// R97-J (m3): the danger/warn ring hexes ride the documented semantic tokens
// (same values — one source of truth, not literals).
import { SEMANTIC_COLORS } from "../lib/semantics";

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

  if (payload === null) {
    // No payload yet (the window prewarms hidden at sidebar mount — a
    // transparent nothing is the correct idle render).
    return <></>;
  }
  if (payload.kind === "usage") {
    return <UsageCard payload={payload} reportHover={reportHover} />;
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
          border: `1px solid ${t.border}`,
          background: t.card,
          boxShadow: t.softShadow,
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
                  background: withAlpha(t.accent, 0.12),
                  color: t.accent,
                }}
              >
                {item.code}
              </span>
              <span
                style={{
                  flexShrink: 0,
                  fontSize: 9,
                  fontFamily: "var(--font-mono, ui-monospace, monospace)",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  padding: "2px 6px",
                  borderRadius: 6,
                  color: item.roleColor,
                  background: withAlpha(item.roleColor, 0.14),
                }}
              >
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
              <span style={{ flexShrink: 0, fontSize: 10, color: t.textTertiary }}>{item.status}</span>
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
                background: item.selected === true ? withAlpha(t.accent, 0.09) : "transparent",
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
                    color: item.selected === true ? t.accent : t.text,
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
                <Check size={14} style={{ color: t.accent, flexShrink: 0, marginTop: 1 }} aria-hidden />
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
 * ROUND-96 (R96-G) → ROUND-97 (R97-C): the USAGE rich card — the ContextDonut's
 * popover painted inside this OS window, so hovering the token usage reads
 * ABOVE the live embedded-browser webview instead of pausing it behind the
 * R89-E5 guard's caption. R97-C grew the card from the plain label/value
 * sections into the full visual twin of the DOM popover — the DONUT header
 * (ring + % + the window lines + the session-cost headline), the
 * KILO-STYLE SEGMENTED CONTEXT BAR (one colored segment per category + the
 * reserved-for-output block + the free track, used/window counts flanking),
 * the breakdown rows with palette dots + mini-bars, the session TABLE with
 * the Cost column, and the note footer. Hovering a bar segment highlights its
 * breakdown row and vice versa (the Cursor-style mutual highlight).
 *
 * The card FILLS the window (the main window estimated its height from the
 * same px contract the lines below paint to — USAGE_* in lib/menu-overlay.ts)
 * and scrolls when the estimate came in short, never clipping silently.
 */
function UsageCard({
  payload,
  reportHover,
}: {
  payload: UsageCardPayload;
  reportHover: (hovering: boolean) => void;
}): React.ReactElement {
  const t = payload.theme;
  // R97-C: the mutual hover-highlight's shared state — the currently hovered
  // category label (a bar segment OR its breakdown row owns it; both paint
  // the highlight from the same string).
  const [hoverSeg, setHoverSeg] = useState<string | null>(null);
  const segHex = useCallback(
    (color: UsageSegmentColor): string => usageSegmentHex(color, t.isDark, t.accent),
    [t.isDark, t.accent],
  );
  const ringHex =
    payload.donut?.ringColor === "danger"
      ? SEMANTIC_COLORS.danger
      : payload.donut?.ringColor === "warn"
        ? SEMANTIC_COLORS.warning
        : t.accent;
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
          border: `1px solid ${t.border}`,
          background: t.card,
          boxShadow: t.softShadow,
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
            paddingBottom: 6,
            marginBottom: 6,
            borderBottom: `1px solid ${t.border}`,
          }}
        >
          {payload.title}
        </div>

        {/* ── R97-C: the DONUT header block — the ring (graded color + the
            budget tick + the % center) beside the window line column. */}
        {payload.donut !== undefined ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <UsageDonutRing
              used={payload.donut.used}
              limit={payload.donut.limit}
              markerFrac={payload.donut.markerFrac}
              color={ringHex}
              track={withAlpha(t.text, 0.12)}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              {payload.donut.lines.map((line, li) => (
                <div
                  key={`${li}-${line.label}`}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    gap: 8,
                    minHeight: USAGE_LINE_PX,
                  }}
                >
                  <span style={{ fontSize: 10, color: t.textTertiary, whiteSpace: "nowrap" }}>{line.label}</span>
                  <span
                    style={{
                      fontFamily: "var(--font-mono, ui-monospace, monospace)",
                      fontSize: 10.5,
                      fontWeight: line.strong === true ? 700 : 500,
                      color: line.strong === true ? t.text : t.textSecondary,
                      textAlign: "right",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {line.value}
                    {line.note !== undefined && line.note !== "" ? (
                      <span style={{ fontWeight: 400, color: t.textTertiary }}> · {line.note}</span>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* ── R97-C: the CONTEXT BAR — the Kilo-style segmented usage bar.
            Used/window counts flank the track; each category paints its
            colored segment (hover: the tooltip + the matching breakdown row
            highlight); the output reserve paints its dimmed block; the rest
            stays the free track. */}
        {payload.contextBar !== undefined ? (
          <div data-usage-context-bar style={{ marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  fontFamily: "var(--font-mono, ui-monospace, monospace)",
                  fontSize: 9.5,
                  fontWeight: 700,
                  color: t.text,
                  fontVariantNumeric: "tabular-nums",
                  flexShrink: 0,
                }}
              >
                {formatTokenCount(payload.contextBar.usedTokens)}
              </span>
              <div
                role="img"
                aria-label={`context window ${Math.round(payload.contextBar.usedPct)}% used`}
                style={{
                  flex: 1,
                  height: 6,
                  borderRadius: 3,
                  background: withAlpha(t.text, 0.1),
                  overflow: "hidden",
                  display: "flex",
                }}
              >
                {payload.contextBar.segments.map((seg) => {
                  const frac =
                    payload.contextBar !== undefined && payload.contextBar.windowTokens > 0
                      ? Math.min(1, seg.tokens / payload.contextBar.windowTokens)
                      : 0;
                  const lit = hoverSeg === seg.label;
                  return (
                    <div
                      key={seg.label}
                      title={`${seg.label} · ${formatTokenCount(seg.tokens)} tokens · ${Math.round(frac * 100)}% of window`}
                      onMouseEnter={() => setHoverSeg(seg.label)}
                      onMouseLeave={() => setHoverSeg(null)}
                      style={{
                        width: `${frac * 100}%`,
                        height: "100%",
                        background: segHex(seg.color),
                        opacity: hoverSeg === null || lit ? 1 : 0.35,
                        transition: "opacity 120ms ease",
                        ...(lit ? { boxShadow: `0 0 0 1px ${withAlpha(segHex(seg.color), 0.6)}` } : {}),
                      }}
                    />
                  );
                })}
                {/* The reserved-for-output block — dimmed, after the used
                    segments, so "free" never reads as fully usable (Kilo's
                    three-segment insight, restated on our category bar). */}
                {payload.contextBar.windowTokens > 0 &&
                payload.contextBar.reservedTokens > 0 ? (
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
              <span
                style={{
                  fontFamily: "var(--font-mono, ui-monospace, monospace)",
                  fontSize: 9.5,
                  fontWeight: 700,
                  color: t.textTertiary,
                  fontVariantNumeric: "tabular-nums",
                  flexShrink: 0,
                }}
              >
                {formatTokenCount(payload.contextBar.windowTokens)}
              </span>
            </div>
          </div>
        ) : null}

        {payload.sections.map((section, si) => (
          <div key={`${si}-${section.title}`} style={{ marginBottom: si === payload.sections.length - 1 ? 0 : 8 }}>
            <div
              style={{
                fontSize: 9,
                fontWeight: 700,
                textTransform: "uppercase" as const,
                letterSpacing: "0.08em",
                color: t.textTertiary,
                marginBottom: 3,
                minHeight: USAGE_SECTION_TITLE_PX,
              }}
            >
              {section.title}
            </div>
            {section.lines.map((line, li) => {
              const lit = hoverSeg !== null && line.label === hoverSeg;
              return (
                <div
                  key={`${li}-${line.label}`}
                  onMouseEnter={line.barColor !== undefined ? () => setHoverSeg(line.label) : undefined}
                  onMouseLeave={line.barColor !== undefined ? () => setHoverSeg(null) : undefined}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    minHeight: USAGE_LINE_PX,
                    paddingTop: 2,
                    paddingBottom: 2,
                    borderRadius: 5,
                    ...(lit ? { background: withAlpha(t.text, 0.05) } : {}),
                  }}
                >
                  <span
                    style={{
                      fontSize: 10.5,
                      color: lit ? t.text : t.textSecondary,
                      whiteSpace: "nowrap",
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      minWidth: 0,
                    }}
                  >
                    {/* R97-C: the category DOT — the segment's palette color,
                        the legend for the context bar above. */}
                    {line.barColor !== undefined ? (
                      <span
                        aria-hidden
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: 999,
                          background: segHex(line.barColor),
                          flexShrink: 0,
                          opacity: hoverSeg === null || lit ? 1 : 0.4,
                          transition: "opacity 120ms ease",
                        }}
                      />
                    ) : null}
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        ...(lit ? { fontWeight: 700 } : {}),
                      }}
                    >
                      {line.label}
                    </span>
                  </span>
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      minWidth: 0,
                    }}
                  >
                    {/* R97-C: the MINI-BAR — the line's share as a 3px bar
                        in its palette color (the DOM popover's BreakdownRow,
                        crossed over). */}
                    {line.barFrac !== undefined && line.barColor !== undefined ? (
                      <span
                        aria-hidden
                        style={{
                          width: 34,
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
                            opacity: hoverSeg === null || lit ? 1 : 0.4,
                            transition: "opacity 120ms ease",
                          }}
                        />
                      </span>
                    ) : null}
                    <span
                      style={{
                        fontFamily: "var(--font-mono, ui-monospace, monospace)",
                        fontSize: 10.5,
                        fontWeight: line.strong === true ? 700 : 500,
                        color: line.strong === true ? t.text : t.textSecondary,
                        textAlign: "right",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {line.value}
                      {line.note !== undefined && line.note !== "" ? (
                        <span style={{ fontWeight: 400, color: t.textTertiary }}> · {line.note}</span>
                      ) : null}
                    </span>
                  </span>
                </div>
              );
            })}
            {/* R97-C: the session TABLE — the compact split (Turns / Calls /
                Sent / Received / Cost per group), the strong row emphasized. */}
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
                          fontFamily: "var(--font-mono, ui-monospace, monospace)",
                          fontSize: 10,
                          fontWeight: row.strong === true ? 700 : 500,
                          color: row.strong === true ? t.text : t.textSecondary,
                          textAlign: "right",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
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
        {payload.note !== undefined && payload.note !== "" ? (
          <div
            style={{
              marginTop: 6,
              paddingTop: 6,
              borderTop: `1px solid ${t.border}`,
              fontSize: 9.5,
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              color: t.textTertiary,
              minHeight: USAGE_NOTE_PX,
            }}
          >
            {payload.note}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** R97-C: the usage card's donut ring — the DOM popover's DonutRing as a
 * self-contained SVG (this page does not import the composer's component;
 * same math: the -90° origin, the graded color, the budget tick). */
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
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        fontSize={10}
        fontWeight={700}
        fill={color}
        fontFamily="var(--font-mono, ui-monospace, monospace)"
      >
        {limit > 0 ? Math.round(Math.min(100, (used / limit) * 100)) : 0}%
      </text>
    </svg>
  );
}

/*
 * The px contract's honesty guard: the estimator (lib/menu-overlay.ts) and
 * this card MUST agree on how tall a usage card is — the constants imported
 * above are the same ones the estimator sums (USAGE_LINE_PX is the lines'
 * minHeight, USAGE_SECTION_TITLE_PX the section title's, USAGE_NOTE_PX the
 * footnote's, USAGE_TABLE_ROW_PX the session table's rows; USAGE_CARD_CHROME_PX
 * covers the head strip + title row + the card paddings painted around them
 * here). A drift between the two sides shows up as clipped rows or dead card
 * space — pinned by menu-overlay.test.
 */
void USAGE_CARD_CHROME_PX;
