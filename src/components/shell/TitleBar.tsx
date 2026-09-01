import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { isTauri } from "../../lib/sidecar";
import { useProjectChatStore } from "../../lib/project-chat-store";
import { APP_NAME } from "../../lib/version";
import { AcuteLogo } from "./Sidebar";

/**
 * ROUND-58 (R58-a) — the custom title bar for the frameless main window.
 *
 * tauri.conf.json ships the window with `decorations: false` (owner: the
 * native strip had to go so the app looks "a full-fledged application in and
 * of itself"), so the app paints its OWN chrome here — a VS Code-style
 * integrated title bar mounted at the App root so it covers EVERY screen
 * (setup wizard, connection splash/offline, all AppShell routes).
 *
 *   - the bar's background is a drag region (`data-tauri-drag-region` —
 *     Tauri's injected script turns a left-button mousedown on the TARGET
 *     element into window dragging and a double-click into maximize/restore,
 *     no JS here; the attribute is repeated on the non-interactive children
 *     because it only fires on the element that carries it, which is also
 *     why the buttons below work naturally);
 *   - left: the Acute cat-face mark + the product name — R60-C (owner): this
 *     identity block is now THE SIDEBAR TOGGLE. Click hides the whole left
 *     panel (the main content takes the full width), click again shows it.
 *     It renders as a real <button> that deliberately carries NO drag-region
 *     attribute (a drag region swallows clicks — the same reason the window
 *     controls work), and the AcuteLogo inside renders its NON-interactive
 *     span variant so no interactive element nests inside the button;
 *   - right: full-height window controls (minimize / maximize-restore /
 *     close) over the global Tauri window API.
 *
 * Renders null in web mode — `isTauri()` from sidecar.ts is the single
 * source of truth for shell detection, so browser dev and the vitest suite
 * see the exact pre-R58 layout (the App root's flex column degenerates to
 * one full-height child). Web mode keeps the AppShell's floating Acute logo
 * as the show-sidebar fallback — there is no title bar to click there.
 */

/** `__TAURI__.window.getCurrentWindow()` — the webview's own OS window. */
type TauriWindowHandle = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
};

/** `__TAURI__.event.listen` — returns an unlisten function via promise. */
type TauriListenFn = (
  event: string,
  handler: (ev: { payload: unknown }) => void,
) => Promise<() => void>;

interface TauriGlobalShape {
  window: { getCurrentWindow: () => TauriWindowHandle };
  event: { listen: TauriListenFn };
}

/**
 * The Tauri global, or null when not running inside the desktop shell (the
 * native-browser.ts tauriGlobal pattern: isTauri() is the single source of
 * truth, the shape is re-verified before use so a malformed global degrades
 * to a no-op instead of a crash).
 */
function tauriGlobal(): TauriGlobalShape | null {
  if (!isTauri()) return null;
  const tauri = (window as unknown as { __TAURI__?: TauriGlobalShape }).__TAURI__;
  if (tauri === undefined || typeof tauri?.window?.getCurrentWindow !== "function") {
    return null;
  }
  return tauri;
}

/** Every window promise is logged and swallowed — chrome never crashes the app. */
function onWindowError(action: string): (err: unknown) => void {
  return (err) => {
    console.warn(`[titlebar] ${action} failed`, err);
  };
}

export function TitleBar() {
  // Drives the maximize/restore icon swap. Hooks run before the web-mode
  // early return (rules-of-hooks); the effect no-ops outside Tauri and
  // __TAURI__ can never appear mid-session (the shell injects it before the
  // bundle evaluates).
  const [maximized, setMaximized] = useState(false);
  // R60-C: the identity control's state — the GLOBAL app-sidebar visibility
  // (project-chat-store, default true). The zustand hooks are shell-
  // independent: they subscribe fine in web mode too (the early return
  // below only skips the RENDER; the store subscription itself is inert).
  const appSidebarVisible = useProjectChatStore((s) => s.appSidebarVisible);
  const setAppSidebarVisible = useProjectChatStore((s) => s.setAppSidebarVisible);

  useEffect(() => {
    const shell = tauriGlobal();
    if (shell === null) return;
    const win = shell.window.getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const syncMaximized = () => {
      win.isMaximized()
        .then((value) => {
          if (!disposed) setMaximized(value);
        })
        .catch(onWindowError("isMaximized"));
    };
    syncMaximized();

    // The window can also maximize/restore from OUTSIDE our buttons (Tauri's
    // own double-click-to-maximize on the drag region, Aero Snap, keyboard
    // shortcuts) — re-query the state on every resize event.
    shell.event
      .listen("tauri://resize", syncMaximized)
      .then((unlistenFn) => {
        // Unmounted before the subscription landed → release it right away.
        if (disposed) unlistenFn();
        else unlisten = unlistenFn;
      })
      .catch(onWindowError("listen(tauri://resize)"));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!isTauri()) return null;

  const onMinimize = () => {
    tauriGlobal()?.window.getCurrentWindow().minimize().catch(onWindowError("minimize"));
  };
  const onToggleMaximize = () => {
    tauriGlobal()?.window.getCurrentWindow().toggleMaximize().catch(onWindowError("toggleMaximize"));
  };
  const onClose = () => {
    tauriGlobal()?.window.getCurrentWindow().close().catch(onWindowError("close"));
  };

  return (
    // R59-A (owner: "make that top navigation bar rounded and give it padding
    // on all four sides"): the bar is now a ROUNDED CARD floating on the
    // window frame's ambient strip (the App root's p-2 + gap-2 supply the
    // four-sided padding). Rounded on all four corners, hairline border,
    // same frosted chrome; the window controls become inset rounded buttons
    // so their hover fills never break the corner radii.
    <header
      data-tauri-drag-region
      className="flex h-10 w-full shrink-0 select-none items-center justify-between rounded-[14px] border-[1.5px] backdrop-blur"
      style={{
        // Translucent frosted chrome over the app's ambient background (the
        // color-mix idiom from index.css/ActionButton) — never a hard edge.
        backgroundColor: "color-mix(in srgb, var(--ac-bg) 72%, transparent)",
        borderColor: "var(--ac-border-subtle)",
      }}
    >
      {/* App identity — R60-C (owner): the Acute mark + product name is the
          ONE sidebar toggle. Click → hide the whole left panel (the main
          content takes the full width); click again → show it. The BUTTON
          itself must NOT carry data-tauri-drag-region — a drag region
          swallows clicks (that is exactly why the window controls to the
          right work); the header around it keeps the attribute so the rest
          of the strip stays draggable, and neither the logo nor the label
          carries it either so every click lands on this button. Same
          spacing/typography as the old quiet chrome, plus a subtle
          ghost-hover affordance. */}
      <button
        type="button"
        onClick={() => setAppSidebarVisible(!appSidebarVisible)}
        aria-label={appSidebarVisible ? "Hide sidebar" : "Show sidebar"}
        aria-pressed={appSidebarVisible}
        title={appSidebarVisible ? "Hide sidebar" : "Show sidebar"}
        className="flex h-8 shrink-0 items-center gap-2.5 rounded-[10px] pl-3.5 pr-3 transition-colors hover:bg-hover"
      >
        <AcuteLogo size={18} ariaLabel={APP_NAME} />
        <span
          className="text-[11px] font-semibold tracking-[0.18em]"
          style={{ color: "var(--ac-text-secondary)" }}
        >
          {APP_NAME}
        </span>
      </button>

      {/* Window controls — R59-A: inset rounded buttons with a little breathing
          room (pr-1.5 + gap-0.5) so the hover fills stay INSIDE the card's
          corner radii; the ghost-hover language matches the app's buttons,
          close keeps the destructive red. */}
      <div className="flex h-full items-center gap-0.5 pr-1.5">
        <button
          type="button"
          aria-label="Minimize window"
          title="Minimize"
          onClick={onMinimize}
          className="grid h-8 w-10 place-items-center rounded-[9px] text-muted transition-colors hover:bg-hover hover:text-ink"
        >
          <Minus className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={maximized ? "Restore window" : "Maximize window"}
          title={maximized ? "Restore" : "Maximize"}
          onClick={onToggleMaximize}
          className="grid h-8 w-10 place-items-center rounded-[9px] text-muted transition-colors hover:bg-hover hover:text-ink"
        >
          {maximized ? (
            <Copy className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <Square className="h-3.5 w-3.5" aria-hidden />
          )}
        </button>
        <button
          type="button"
          aria-label="Close window"
          title="Close"
          onClick={onClose}
          className="grid h-8 w-10 place-items-center rounded-[9px] text-muted transition-colors hover:bg-red-500/10 hover:text-red-500"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </header>
  );
}
