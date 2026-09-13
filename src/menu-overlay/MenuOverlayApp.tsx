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
  type MenuOverlayPayload,
  type UsageCardPayload,
  type MenuItemPayload,
  type MenuPayload,
} from "../lib/menu-overlay";

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
 * ROUND-96 (R96-G): the USAGE rich card — the ContextDonut's hover popover
 * painted inside this OS window, so hovering the token usage reads ABOVE the
 * live embedded-browser webview instead of pausing it behind the R89-E5
 * guard's caption. A read-only twin of the DOM popover: the head row, the
 * titled sections of label/value lines, and the footnote — same theme
 * fields the menus use, same card rhythm (border, radius, shadow, 6px
 * padding), no rows to pick. The card FILLS the window (the main window
 * estimated its height from the same px contract the lines below paint to
 * — USAGE_* in lib/menu-overlay.ts) and scrolls when the estimate came in
 * short, never clipping silently.
 */
function UsageCard({
  payload,
  reportHover,
}: {
  payload: UsageCardPayload;
  reportHover: (hovering: boolean) => void;
}): React.ReactElement {
  const t = payload.theme;
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
            {section.lines.map((line, li) => (
              <div
                key={`${li}-${line.label}`}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 10,
                  minHeight: USAGE_LINE_PX,
                  paddingTop: 2,
                  paddingBottom: 2,
                }}
              >
                <span style={{ fontSize: 10.5, color: t.textSecondary, whiteSpace: "nowrap" }}>{line.label}</span>
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

/*
 * The px contract's honesty guard: the estimator (lib/menu-overlay.ts) and
 * this card MUST agree on how tall a usage card is — the constants imported
 * above are the same ones the estimator sums (USAGE_LINE_PX is the lines'
 * minHeight, USAGE_SECTION_TITLE_PX the section title's, USAGE_NOTE_PX the
 * footnote's; USAGE_CARD_CHROME_PX covers the head strip + title row + the
 * card paddings painted around them here). A drift between the two sides
 * shows up as clipped rows or dead card space — pinned by menu-overlay.test.
 */
void USAGE_CARD_CHROME_PX;
