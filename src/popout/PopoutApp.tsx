import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Copy,
  ExternalLink,
  Globe,
  LoaderCircle,
  Minus,
  RotateCw,
  Square,
  X,
} from "lucide-react";
import { useThemeStyles } from "../lib/use-theme-styles";
import {
  nativeTabGo,
  nativeTabSetBounds,
  nativeTabSetVisible,
  onBrowserNavigated,
  openExternalUrl,
} from "../lib/native-browser";
import { popoutShell, type PopoutShellShape } from "./tauri";
import { normalizeAddressInput } from "./url";
import { GutterScrollbar } from "./GutterScrollbar";
import {
  createPopoutTab,
  popoutCurrentUrl,
  popoutInitialUrl,
  POPOUT_TAB_ID,
} from "./popout-tab";

/**
 * ROUND-59 (R59-b) — the pop-out browser window's custom chrome.
 *
 * The owner's R59 verdict on the R58 pop-out: it worked and shared the
 * profile, BUT "the native title bar is still there… It should be a custom
 * one but apparently it was not", and the injected URL bar "needs to be
 * improved and handled better". This page IS the fix: the window is built
 * with `decorations(false)` hosting popout.html, and this component paints
 * all the chrome the native bar used to provide plus a proper themed URL
 * bar, while the page CONTENT renders in a child webview — the same
 * architecture as the in-app BrowserPanel, one shared browser profile.
 *
 *   - title bar: a drag region (`data-tauri-drag-region` — Tauri's injected
 *     script owns dragging and double-click-maximize) with the Acute Browser
 *     identity and minimize / maximize-restore / close driving
 *     `window.__TAURI__.window.getCurrentWindow()` (the TitleBar.tsx
 *     patterns, including the `tauri://resize` re-query that swaps the
 *     maximize icon);
 *   - URL bar: back / forward / reload (the webview's own session history),
 *     an EDITABLE input with the panel's URL-or-search heuristic and its
 *     R58-b focus guard (never overwrite the field mid-typing; a blurred
 *     field falls back to the live URL), a Go affordance, and an
 *     "Open in system browser" button (the Rust open_external_url command —
 *     window.open is swallowed inside WebView2);
 *   - content: a ROUNDED CARD (R60-A — the owner: "the thing which was not
 *     rounded off was the actual view") containing a placeholder <div> whose
 *     rectangle the child webview is positioned over (browser_tab_set_bounds
 *     — logical px == CSS px because this app webview fills the window) via a
 *     ResizeObserver; the boot flow reads the stashed initial URL
 *     (popout_initial_url) and creates the webview in THIS window
 *     (browser_tab_create with our window label); and the GUTTER scrollbar
 *     (GutterScrollbar) in the window frame's right gutter, OUTSIDE the card,
 *     driving the page's scroll through browser_tab_scroll_state/to.
 *
 * Web mode (no __TAURI__): the honest "needs the desktop app" notice — this
 * page has no shell to draw window controls or host a webview.
 */

/** The title-bar identity label (mirrors Rust's .title("Acute Browser")). */
const POPOUT_IDENTITY = "ACUTE BROWSER";

/** Every window promise is logged and swallowed — chrome never crashes. */
function onWindowError(action: string): (err: unknown) => void {
  return (err) => {
    console.warn(`[popout] ${action} failed`, err);
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function PopoutApp() {
  const styles = useThemeStyles();
  // Captured once (lazy initializer): __TAURI__ is injected before the bundle
  // evaluates and can never appear mid-session (the TitleBar discipline) —
  // and a stable object keeps the effect deps below honest.
  const [shell] = useState<PopoutShellShape | null>(() => popoutShell());

  const placeholderRef = useRef<HTMLDivElement | null>(null);
  /** R58-b focus guard: true while the user is editing the address field. */
  const urlFocusedRef = useRef(false);

  const [maximized, setMaximized] = useState(false);
  const [draft, setDraft] = useState("");
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── title bar: maximize/restore state (the TitleBar.tsx pattern) ─────────
  // The window can maximize/restore from OUTSIDE our buttons (drag-region
  // double-click, Aero Snap, keyboard) — re-query on every resize event.
  useEffect(() => {
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
  }, [shell]);

  // ── the content webview's bounds (the BrowserPanel pattern) ────────────
  // The placeholder's getBoundingClientRect IS the webview's rectangle: this
  // app webview fills the pop-out window, so viewport CSS px == window
  // -relative logical px (same reasoning as browser_tab_set_bounds's doc
  // comment, applied to this window). Idempotent — Rust clamps degenerate
  // measurements to ≥1px. "No native webview" rejections are logged and
  // swallowed: that is the expected state until the boot flow creates it.
  const syncBounds = useCallback(() => {
    const rect = placeholderRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    nativeTabSetBounds(POPOUT_TAB_ID, rect.left, rect.top, rect.width, rect.height)
      .then(() => nativeTabSetVisible(POPOUT_TAB_ID, true))
      .catch(onWindowError("set_bounds"));
  }, []);

  useEffect(() => {
    if (shell === null) return;
    let raf = 0;
    const schedule = () => {
      if (raf !== 0) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        syncBounds();
      });
    };
    // ResizeObserver covers every layout change of the placeholder (window
    // resizes flow through it — the placeholder is flex-1); the window
    // listener is belt-and-suspenders, and the test environment's inert RO
    // rides it.
    const observer = new ResizeObserver(schedule);
    if (placeholderRef.current !== null) observer.observe(placeholderRef.current);
    window.addEventListener("resize", schedule);
    return () => {
      if (raf !== 0) window.cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [shell, syncBounds]);

  // ── boot: adopt a surviving webview, or create one at the stashed URL ──
  useEffect(() => {
    if (shell === null) return;
    const windowLabel = shell.window.getCurrentWindow().label;
    let disposed = false;
    (async () => {
      // A SURVIVING webview (page reload — the webview belongs to the WINDOW,
      // not this document) keeps its position: adopt it, don't yank the user
      // back to the stashed URL.
      const existing = await popoutCurrentUrl();
      if (disposed) return;
      if (existing !== null) {
        setCurrentUrl(existing);
        setDraft(existing);
        setBooting(false);
        syncBounds();
        return;
      }
      const initial = await popoutInitialUrl();
      if (disposed) return;
      if (initial === null) {
        // Opened outside open_browser_window (a plain web-dev visit) — the
        // URL bar is live; the first Go creates the webview.
        setBooting(false);
        return;
      }
      try {
        await createPopoutTab(initial, windowLabel);
        if (disposed) return;
        setCurrentUrl(initial);
        setDraft(initial);
        syncBounds();
      } catch (err) {
        if (!disposed) {
          setError(`Starting the browser page failed (${errorMessage(err)}).`);
        }
      }
      setBooting(false);
    })();
    return () => {
      disposed = true;
    };
  }, [shell, syncBounds]);

  // Navigate = the idempotent create (an existing webview just navigates) —
  // the same contract the panel rides, so the address bar works both before
  // and after the webview exists.
  const navigateTo = useCallback(
    (url: string) => {
      if (shell === null) return;
      const windowLabel = shell.window.getCurrentWindow().label;
      createPopoutTab(url, windowLabel)
        .then(() => {
          setCurrentUrl(url);
          // Focus guard (BrowserPanel pattern): never overwrite what the
          // user is typing — the onBlur fallback still lands on the live URL.
          if (!urlFocusedRef.current) setDraft(url);
          setError(null);
        })
        .catch((err) => {
          setError(`Navigation failed (${errorMessage(err)}).`);
        });
    },
    [shell],
  );

  // ── user navigations INSIDE the webview → sync the URL bar ────────────
  // The Rust on_navigation hook emits browser-navigated {tab_id, url} for
  // every http/https navigation; ours carry the "popout" tab id.
  useEffect(() => {
    if (shell === null) return;
    return onBrowserNavigated((tabId, url) => {
      if (tabId !== POPOUT_TAB_ID) return;
      setCurrentUrl(url);
      // R58-b focus guard: the field is NEVER reset mid-edit.
      if (!urlFocusedRef.current) setDraft(url);
    });
  }, [shell]);

  // ── open_browser_window / navigate_browser racing this page's mount ────
  // The Rust side navigates the content webview directly when it exists;
  // this event covers the window-exists-but-webview-not-yet race — the page
  // owns the webview, so it finishes the navigation itself.
  useEffect(() => {
    if (shell === null) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    shell.event
      .listen("popout-navigate", (ev) => {
        const payload = ev.payload as { url?: unknown } | null;
        if (
          payload !== null &&
          typeof payload === "object" &&
          typeof payload.url === "string"
        ) {
          navigateTo(payload.url);
        }
      })
      .then((unlistenFn) => {
        if (disposed) unlistenFn();
        else unlisten = unlistenFn;
      })
      .catch(onWindowError("listen(popout-navigate)"));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [shell, navigateTo]);

  const submitAddress = () => {
    const url = normalizeAddressInput(draft);
    if (url === "") return;
    setDraft(url);
    navigateTo(url);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submitAddress();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setDraft(currentUrl ?? "");
      e.currentTarget.blur();
    }
  };

  const goDirection = (direction: "back" | "forward" | "reload") => {
    nativeTabGo(POPOUT_TAB_ID, direction).catch((err) => {
      setError(`Going ${direction} failed (${errorMessage(err)}).`);
    });
  };

  const onOpenExternally = () => {
    if (currentUrl === null) return;
    openExternalUrl(currentUrl).catch((err) => {
      setError(`Opening the page in your system browser failed (${errorMessage(err)}).`);
    });
  };

  const onMinimize = () => {
    shell?.window.getCurrentWindow().minimize().catch(onWindowError("minimize"));
  };
  const onToggleMaximize = () => {
    shell?.window.getCurrentWindow().toggleMaximize().catch(onWindowError("toggleMaximize"));
  };
  const onClose = () => {
    shell?.window.getCurrentWindow().close().catch(onWindowError("close"));
  };

  // ── web mode: the honest notice ─────────────────────────────────────────
  if (shell === null) {
    return (
      <div className="grid h-screen w-screen place-items-center p-6" style={{ background: styles.bg }}>
        <div
          className="max-w-sm rounded-2xl border p-6 text-center"
          style={{ background: styles.card, borderColor: styles.border }}
          data-testid="popout-web-notice"
          role="note"
        >
          <Globe size={22} className="mx-auto mb-3" style={{ color: styles.accent }} aria-hidden />
          <p className="text-sm font-semibold" style={{ color: styles.text }}>
            The pop-out browser needs the desktop app
          </p>
          <p className="mt-2 text-xs leading-relaxed" style={{ color: styles.textSecondary }}>
            This page is the pop-out browser window's chrome. In plain web mode
            there is no Tauri shell to draw window controls or host the embedded
            webview — open it from the app's browser panel instead.
          </p>
        </div>
      </div>
    );
  }

  // ── the chrome ───────────────────────────────────────────────────────────
  return (
    <div
      className="flex h-screen w-screen flex-col gap-2 overflow-hidden p-2"
      style={{ background: "var(--ac-frame-bg, var(--ac-bg))" }}
      data-testid="popout-root"
    >
      {/* The custom title bar — R59-A design language: a rounded card on the
          window's ambient strip. The drag-region attribute repeats on the
          non-interactive children because Tauri only starts a drag when the
          mousedown TARGET carries it (which is also why the buttons work). */}
      <header
        data-tauri-drag-region
        className="flex h-10 w-full shrink-0 select-none items-center justify-between rounded-[14px] border-[1.5px] backdrop-blur"
        style={{
          backgroundColor: "color-mix(in srgb, var(--ac-bg) 72%, transparent)",
          borderColor: "var(--ac-border-subtle)",
        }}
      >
        <div data-tauri-drag-region className="flex items-center gap-2.5 pl-3.5">
          <Globe size={15} style={{ color: styles.accent }} aria-hidden />
          <span
            data-tauri-drag-region
            className="text-[11px] font-semibold tracking-[0.18em]"
            style={{ color: "var(--ac-text-secondary)" }}
          >
            {POPOUT_IDENTITY}
          </span>
        </div>

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

      {/* The themed URL bar — the BrowserPanel's address row, restated for a
          standalone window: nav buttons, the guarded editable field, Go, and
          the explicit system-browser handoff. */}
      <div
        className="flex h-11 shrink-0 items-center gap-1.5 rounded-[14px] border-[1.5px] px-2"
        style={{ background: styles.card, borderColor: styles.border }}
      >
        <button
          onClick={() => goDirection("back")}
          disabled={currentUrl === null}
          aria-label="Back"
          title="Back"
          data-testid="popout-back"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md transition-colors disabled:opacity-30"
          style={{ color: styles.textSecondary }}
        >
          <ArrowLeft size={13} aria-hidden />
        </button>
        <button
          onClick={() => goDirection("forward")}
          disabled={currentUrl === null}
          aria-label="Forward"
          title="Forward"
          data-testid="popout-forward"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md transition-colors disabled:opacity-30"
          style={{ color: styles.textSecondary }}
        >
          <ArrowRight size={13} aria-hidden />
        </button>
        <button
          onClick={() => goDirection("reload")}
          disabled={currentUrl === null}
          aria-label="Reload"
          title="Reload"
          data-testid="popout-reload"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md transition-colors disabled:opacity-30"
          style={{ color: styles.textSecondary }}
        >
          <RotateCw size={12} aria-hidden />
        </button>

        <form onSubmit={onSubmit} className="flex min-w-0 flex-1 items-center">
          <div
            className="flex h-7 flex-1 items-center gap-1.5 rounded-full border px-2.5"
            style={{ background: styles.subtle, borderColor: styles.border }}
          >
            <Globe size={11} className="shrink-0" style={{ color: styles.textTertiary }} aria-hidden />
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={(e) => {
                urlFocusedRef.current = true;
                e.target.select();
              }}
              onBlur={() => {
                urlFocusedRef.current = false;
                // A blurred field shows the live URL, never stale typing
                // (the focus-guard suppressed the sync above).
                if (currentUrl !== null) setDraft(currentUrl);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search or enter address"
              aria-label="Browser address"
              data-testid="popout-address-input"
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-[11.5px] outline-none"
              style={{ color: styles.text }}
            />
          </div>
        </form>

        <button
          type="button"
          onClick={submitAddress}
          aria-label="Go"
          title="Go"
          data-testid="popout-go"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-full"
          style={{ background: styles.accent, color: styles.accentText }}
        >
          <ArrowRight size={12} aria-hidden />
        </button>
        <button
          type="button"
          onClick={onOpenExternally}
          disabled={currentUrl === null}
          aria-label="Open in system browser"
          title="Open the current page in your system browser (explicit action)"
          data-testid="popout-open-external"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md transition-colors disabled:opacity-30"
          style={{ color: styles.textSecondary }}
        >
          <ExternalLink size={13} aria-hidden />
        </button>
      </div>

      {/* A failed invoke surfaces HERE, never inside the content area — the
          content webview is a native layer floating ABOVE anything this page
          renders there, so an in-area banner would be invisible under it. */}
      {error !== null ? (
        <div
          role="alert"
          data-testid="popout-error"
          className="flex shrink-0 items-center gap-2 rounded-[14px] border-[1.5px] px-3 py-2 text-[11px]"
          style={{
            background: styles.isDark ? "rgba(220,38,38,0.12)" : "rgba(254,226,226,1)",
            color: styles.isDark ? "#fca5a5" : "#b91c1c",
            borderColor: styles.border,
          }}
        >
          <AlertTriangle size={12} className="shrink-0" aria-hidden />
          <span className="flex-1">{error}</span>
          <button
            onClick={() => setError(null)}
            aria-label="Dismiss"
            className="shrink-0 opacity-60 hover:opacity-100"
            style={{ color: "inherit" }}
          >
            ×
          </button>
        </div>
      ) : null}

      {/* The content ROW — R60-A: the rounded CONTENT CARD + the GUTTER
          column. The card is the visible frame whose rounded corners +
          border read as the VIEW's rounding (the owner's "It should be a bit
          more rounded, actually like the actual web pages and such, on the
          corners"), and the gutter scrollbar lives OUTSIDE the card in the
          window frame area (the owner's "not inside the section but on the
          right side outside it"). */}
      <div className="m-1.5 flex min-h-0 flex-1 gap-2">
        {/* The content card — the title-bar/URL-bar card language applied to
            the view itself. The webview is a native SQUARE floating above;
            the placeholder is inset 4px so the square's corners stay inside
            the card's 14px corner curve (the R59 m-1.5 honesty math, now
            with a real visible border), and the card's background shows
            through as the frame around the page. Nothing interactive renders
            here — the webview floats above it. */}
        <div
          className="relative min-h-0 flex-1 rounded-[14px] border-[1.5px]"
          style={{
            background: styles.isDark ? "rgba(0,0,0,0.22)" : styles.subtle,
            borderColor: "var(--ac-border-subtle)",
          }}
        >
          {/* The placeholder whose rectangle the child webview covers —
              inset 4px from the card's inner edge (p-[4px] equivalent via
              absolute inset). */}
          <div
            ref={placeholderRef}
            data-testid="popout-content"
            className="absolute inset-[4px]"
          >
            {booting ? (
              <div
                className="absolute inset-0 grid place-items-center"
                data-testid="popout-booting"
              >
                <LoaderCircle
                  size={20}
                  className="animate-spin"
                  style={{ color: styles.accent }}
                  aria-hidden
                />
              </div>
            ) : currentUrl === null ? (
              <div className="absolute inset-0 grid place-items-center px-6 text-center">
                <div>
                  <Globe size={26} className="mx-auto mb-2" style={{ color: styles.accent }} aria-hidden />
                  <p className="text-xs" style={{ color: styles.textSecondary }}>
                    Enter an address above to start browsing — the first Go creates the page.
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {/* The gutter scrollbar — the window's own themed scrollbar in the
            frame's right gutter (GutterScrollbar owns its honesty: hidden
            until the page overflows and our CSS actually took). */}
        <GutterScrollbar tabId={POPOUT_TAB_ID} />
      </div>
    </div>
  );
}
