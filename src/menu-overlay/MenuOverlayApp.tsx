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
import { Activity, Bot, Brain, FolderTree, Globe, Terminal as TerminalIcon, type LucideIcon } from "lucide-react";
import type { MenuItemPayload, MenuPayload } from "../lib/menu-overlay";

/** The lucide icons the payload addresses by name (the quick menu's set). */
const ICONS: Record<string, LucideIcon> = {
  "folder-tree": FolderTree,
  globe: Globe,
  terminal: TerminalIcon,
  brain: Brain,
  activity: Activity,
  bot: Bot,
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
function parsePayload(raw: unknown): MenuPayload | null {
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
  const [payload, setPayload] = useState<MenuPayload | null>(null);

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
    void sh.event
      .emit("menu-overlay-pick", { kind: item.kind === "quick" ? "quick" : "subagents", item })
      .catch(() => {});
  }, []);

  if (payload === null) {
    // No payload yet (the window prewarms hidden at sidebar mount — a
    // transparent nothing is the correct idle render).
    return <></>;
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
          ) : (
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
