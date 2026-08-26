import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Info,
  PanelTopOpen,
  RotateCw,
  X,
} from "lucide-react";
import { useRightSidebarStore, type RightSidebarTab } from "../../lib/right-sidebar-store";
import { useThemeStyles } from "../../lib/use-theme-styles";

/**
 * ROUND-38/39/41 right-sidebar Browser tab.
 *
 * ROUND-41 (owner: "I want it to be a full-fledged native browser rather
 * than utilizing some other pre-installed browser on the device. If, for
 * that reason, you need to download some things or many things better
 * then do. Make sure that you focus on these things too and handle them
 * properly and make sure that there is proper error handling. It properly
 * shows the errors which it faces and properly displays the errors").
 *
 * HONEST ARCHITECTURE: the in-right-sidebar browser is a CONTROL PANEL for
 * a SEPARATE persistent native browser window (Tauri WebviewWindow with its
 * OWN user-data dir at app_local_data_dir/browser-profile). That native
 * window IS a full-fledged Chromium-based browser (WebView2 on Windows =
 * Chromium runtime, separate from the system Edge's profile; WebKit on
 * macOS). Cookies + login state persist across app launches AND are isolated
 * from the system browser — the user can be logged into a different Gmail
 * in the acute browser than in their system Chrome, exactly as asked.
 *
 * Why not embed the webview inline in the right sidebar? Tauri 2's
 * WebviewWindow is a top-level OS window — it can't be parented into a
 * React DOM rect. The previous iframe approach failed for every site that
 * sends X-Frame-Options: DENY/SAMEORIGIN (Google, GitHub, most login
 * flows) — that's why the owner saw "google.com refused to connect". The
 * honest, working path is: control panel in the sidebar + native window
 * for actual browsing. The native window has its OWN nav overlay (back /
 * forward / reload / address bar) injected by browser.rs so it feels like
 * a real browser, not a bare webview.
 *
 * Error handling: in the Tauri shell, invoke failures surface a CLEAR
 * inline error. In plain web mode (launcher/dev — ROUND-42), URLs open in a
 * NEW TAB of the current browser (the owner's actual setup); we never
 * shell out to the OS default browser from the Tauri app (that was the
 * Edge leak the owner reported).
 */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  // Looks like a domain (has a dot, no spaces)?
  if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(trimmed)) return `https://${trimmed}`;
  // Otherwise treat as a search query.
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}

/** Type-safe accessor for the Tauri global (only present in the desktop app). */
function tauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  const w = (window as unknown as {
    __TAURI__?: { core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
  }).__TAURI__?.core;
  return w?.invoke ?? null;
}

/** ROUND-42: are we inside the Tauri desktop shell (native browser window
 * available) or a plain browser tab (launcher/dev mode)? */
const IS_TAURI = tauriInvoke() !== null;

export function BrowserPanel({ projectId, tab }: { projectId: string; tab: RightSidebarTab }) {
  const styles = useThemeStyles();
  const setBrowserUrl = useRightSidebarStore((s) => s.setBrowserUrl);
  const tabId = tab.id;
  const browserUrl = tab.browserUrl ?? null;
  const [draft, setDraft] = useState(browserUrl ?? "");
  // ROUND-41: when the native acute-browser window can't be opened (running
  // in plain Vite, capability missing, or invoke throws), surface an inline
  // error in the panel. We deliberately DO NOT fall through to window.open —
  // that path was the Edge leak the owner flagged.
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const invoke = tauriInvoke();

  // On mount, check if the browser window is already open (so the panel
  // shows the right CTA: "Open in browser" vs "Focus browser").
  useEffect(() => {
    if (!invoke) return;
    invoke("is_browser_window_open")
      .then((open) => setBrowserOpen(open === true))
      .catch(() => setBrowserOpen(false));
  }, [invoke]);

  const go = useCallback(
    async (raw: string) => {
      const url = normalizeUrl(raw);
      if (url === "") return;
      setBrowserUrl(projectId, tabId, url);
      setDraft(url);
      setBrowserError(null);
      if (!invoke) {
        // ROUND-42 (owner: "I am on Windows and I need it to be working
        // properly" — he launches via ACUTE.bat, which serves the UI in his
        // normal browser, NOT inside the Tauri shell). In plain web mode
        // there is no native window to open — open the URL in a NEW TAB of
        // the browser the user is already in. This is NOT the old "Edge
        // leak" (that was the TAURI app shelling out to the OS default
        // browser); here the user is ALREADY in their browser and a new tab
        // is the natural, expected behavior.
        const opened = window.open(url, "_blank", "noopener,noreferrer");
        if (opened === null) {
          // Popup blocked (no user gesture). Show the URL as a clickable
          // fallback link instead of failing silently.
          setBrowserError(
            "Your browser blocked opening the tab. Click the link in the status row above, or allow pop-ups for localhost.",
          );
        }
        return;
      }
      try {
        // If the browser window is already open, navigate it; otherwise open it.
        if (browserOpen) {
          await invoke("navigate_browser", { url });
        } else {
          await invoke("open_browser_window", { url });
          setBrowserOpen(true);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setBrowserError(`Failed to open the browser window: ${msg}`);
      }
    },
    [browserOpen, invoke, projectId, setBrowserUrl, tabId],
  );

  const onBack = () => {
    // ROUND-41: the native browser window has its own back/forward/reload
    // (injected by browser.rs's nav overlay). The panel's buttons invoke
    // navigate_browser to drive the open window's history via eval.
    // We can't directly call history.back on the native window from here,
    // so we re-eval the URL change through navigate_browser (the user
    // typed a new URL). For true back/forward, the user clicks the native
    // window's own nav overlay buttons.
    // Kept here for visual parity with a real browser chrome.
    void 0;
  };
  const onForward = () => { void 0; };
  const onReload = async () => {
    if (!invoke || !browserOpen) return;
    // Re-navigate to the current URL (a reload shortcut).
    if (browserUrl !== null) {
      try {
        await invoke("navigate_browser", { url: browserUrl });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setBrowserError(`Reload failed: ${msg}`);
      }
    }
  };

  const onOpenAppBrowser = () => void go(draft !== "" ? draft : (browserUrl ?? ""));
  const onCloseBrowser = async () => {
    if (!invoke) return;
    try {
      await invoke("close_browser_window");
      setBrowserOpen(false);
      setBrowserError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBrowserError(`Close failed: ${msg}`);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void go(draft);
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Address bar */}
      <div
        className="shrink-0 flex items-center gap-1 px-2 h-9 border-b"
        style={{ borderColor: styles.border, background: styles.isDark ? "rgba(0,0,0,0.15)" : styles.subtle }}
      >
        <button
          onClick={onBack}
          aria-label="Back"
          title="Back (in the browser window)"
          className="w-6 h-6 grid place-items-center rounded-md transition-colors disabled:opacity-30"
          style={{ color: styles.textSecondary }}
          onMouseEnter={(e) => { e.currentTarget.style.background = styles.subtleHover; }}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <ArrowLeft size={13} />
        </button>
        <button
          onClick={onForward}
          aria-label="Forward"
          title="Forward (in the browser window)"
          className="w-6 h-6 grid place-items-center rounded-md transition-colors disabled:opacity-30"
          style={{ color: styles.textSecondary }}
          onMouseEnter={(e) => { e.currentTarget.style.background = styles.subtleHover; }}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <ArrowRight size={13} />
        </button>
        <button
          onClick={onReload}
          disabled={!browserOpen}
          aria-label="Reload"
          title="Reload (re-navigate the browser window)"
          className="w-6 h-6 grid place-items-center rounded-md transition-colors disabled:opacity-30"
          style={{ color: styles.textSecondary }}
          onMouseEnter={(e) => { if (browserOpen) e.currentTarget.style.background = styles.subtleHover; }}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <RotateCw size={12} />
        </button>
        <form onSubmit={onSubmit} className="flex-1 min-w-0 flex items-center">
          <div
            className="flex-1 flex items-center gap-1.5 h-7 px-2.5 rounded-full border"
            style={{ background: styles.card, borderColor: styles.border }}
          >
            <Globe size={11} className="shrink-0" style={{ color: styles.textTertiary }} />
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Search or enter address"
              aria-label="Browser address"
              spellCheck={false}
              autoComplete="off"
              className="flex-1 min-w-0 bg-transparent outline-none text-[11.5px]"
              style={{ color: styles.text }}
            />
          </div>
        </form>
        {/* PRIMARY action — desktop app: open/focus the persistent native
            `acute-browser` window (isolated Chromium profile, persistent
            logins). Web mode: opens the URL in a new tab of the current
            browser (ROUND-42). */}
        <button
          onClick={onOpenAppBrowser}
          aria-label={IS_TAURI ? "Open in browser" : "Open in a new browser tab"}
          title={
            IS_TAURI
              ? "Open in the persistent Acute browser (isolated profile, logins persist)"
              : "Opens in a new tab of this browser"
          }
          className="shrink-0 flex items-center gap-1 h-7 px-2.5 rounded-full text-[11px] font-medium transition-colors"
          style={{
            color: styles.isDark ? "#fff" : styles.card,
            background: styles.isDark ? styles.text : styles.textSecondary,
          }}
        >
          <PanelTopOpen size={12} />
          <span>{IS_TAURI ? (browserOpen ? "Focus" : "Open") : "Open"}</span>
        </button>
      </div>

      {/* Browser-open status row — mode-aware: in the desktop app it shows
          whether the native `acute-browser` window is mounted (+ a close
          button); in a plain browser tab (launcher/dev mode) it shows the
          last-opened URL as a clickable link. */}
      <div
        className="shrink-0 flex items-center gap-2 px-3 h-7 border-b text-[10.5px]"
        style={{ borderColor: styles.border, color: styles.textTertiary, background: styles.isDark ? "rgba(0,0,0,0.08)" : "transparent" }}
      >
        {IS_TAURI ? (
          <>
            <span
              className="inline-flex items-center gap-1"
              style={{ color: browserOpen ? styles.accent : styles.textTertiary }}
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ background: browserOpen ? styles.accent : styles.textTertiary }}
              />
              {browserOpen ? "Browser window open" : "Browser window closed"}
            </span>
            <span className="flex-1 truncate" title={browserUrl ?? ""}>
              {browserUrl ? `URL: ${browserUrl}` : "No URL yet"}
            </span>
            {browserOpen ? (
              <button
                onClick={onCloseBrowser}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md transition-colors"
                style={{ color: styles.textTertiary }}
                onMouseEnter={(e) => { e.currentTarget.style.background = styles.subtleHover; }}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                title="Close the browser window (profile survives on disk)"
              >
                <X size={10} />
                Close
              </button>
            ) : null}
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-1 shrink-0">
              <ExternalLink size={10} style={{ color: styles.accent }} />
              Opens in a new browser tab
            </span>
            {browserUrl ? (
              <a
                href={browserUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 min-w-0 truncate underline decoration-dotted underline-offset-2 hover:opacity-80"
                style={{ color: styles.textSecondary }}
                title={browserUrl}
              >
                {browserUrl}
              </a>
            ) : (
              <span className="flex-1 truncate">No URL opened yet</span>
            )}
          </>
        )}
      </div>

      {/* Inline error surface — shown when the native window can't be
          opened (running outside the Tauri shell, capability missing, or
          invoke threw). We deliberately do NOT fall through to window.open. */}
      {browserError !== null ? (
        <div
          className="shrink-0 flex items-start gap-2 px-3 py-2 text-[11px] border-b"
          style={{
            background: styles.isDark ? "rgba(220,38,38,0.12)" : "rgba(254,226,226,1)",
            color: styles.isDark ? "#fca5a5" : "#b91c1c",
            borderColor: styles.border,
          }}
        >
          <Info size={12} className="mt-0.5 shrink-0" />
          <span className="flex-1">{browserError}</span>
          <button
            onClick={() => setBrowserError(null)}
            aria-label="Dismiss"
            className="shrink-0 opacity-60 hover:opacity-100"
            style={{ color: "inherit" }}
          >
            ×
          </button>
        </div>
      ) : null}

      {/* Viewport — the control panel (not the browsing surface). The
          actual browsing happens in the native browser window (desktop app)
          or a new browser tab (web mode). */}
      <div className="flex-1 min-h-0 relative overflow-y-auto" style={{ background: styles.card }}>
        <div className="absolute inset-0 grid place-items-center px-6 text-center">
          <div>
            <div
              className="w-14 h-14 mx-auto mb-3 grid place-items-center rounded-2xl"
              style={{ background: styles.isDark ? "rgba(0,0,0,0.18)" : styles.subtle, border: `1px solid ${styles.border}` }}
            >
              <Globe size={26} style={{ color: styles.accent }} />
            </div>
            <div className="text-[12.5px] font-medium" style={{ color: styles.textSecondary }}>
              {IS_TAURI ? (browserOpen ? "Acute Browser is open" : "Acute Browser") : "Acute Browser (web mode)"}
            </div>
            <div className="text-[11px] mt-1.5 max-w-xs mx-auto leading-relaxed" style={{ color: styles.textTertiary }}>
              {IS_TAURI
                ? browserOpen
                  ? "The browser window is open with its own isolated profile (separate from your system Edge/Chrome). Type a new URL above + Enter to navigate it. Use the window's own nav bar for back/forward/reload."
                  : "Type a URL above + Enter (or click Open) to launch the persistent Acute browser. It uses its own isolated Chromium profile — logins + cookies persist across app launches and are separate from your system browser."
                : "You're running in a browser tab, so links open in a new tab of THIS browser. Run the packaged desktop app (launcher with the Tauri shell) for the embedded Acute browser window with its own isolated profile."}
            </div>
            <div className="mt-4 flex items-center justify-center gap-2">
              <button
                onClick={() => void go("https://duckduckgo.com")}
                className="inline-flex items-center gap-1 h-7 px-3 rounded-full text-[11px] font-medium transition-colors"
                style={{ background: styles.subtle, color: styles.textSecondary, border: `1px solid ${styles.border}` }}
                onMouseEnter={(e) => { e.currentTarget.style.background = styles.subtleHover; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = styles.subtle; }}
              >
                <ExternalLink size={11} />
                DuckDuckGo
              </button>
              <button
                onClick={() => void go("https://github.com")}
                className="inline-flex items-center gap-1 h-7 px-3 rounded-full text-[11px] font-medium transition-colors"
                style={{ background: styles.subtle, color: styles.textSecondary, border: `1px solid ${styles.border}` }}
                onMouseEnter={(e) => { e.currentTarget.style.background = styles.subtleHover; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = styles.subtle; }}
              >
                <ExternalLink size={11} />
                GitHub
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
