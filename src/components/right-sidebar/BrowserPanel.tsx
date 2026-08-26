import { useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Globe, RotateCw, PanelTopOpen } from "lucide-react";
import { useRightSidebarStore, type RightSidebarTab } from "../../lib/right-sidebar-store";
import { useThemeStyles } from "../../lib/use-theme-styles";

/**
 * ROUND-38/39 right-sidebar Browser tab (owner: "a full-fledged kind of a
 * browser… storing the credentials, saving the sessions… kept logged in…
 * used throughout all of the sessions, projects").
 *
 * ROUND-39: each browser tab has its OWN URL + history (keyed by tab id in
 * right-sidebar-store). The address bar accepts URLs or search terms
 * (defaults to a search engine).
 *
 * HONEST SCOPE: full credential/session persistence across the app requires
 * the native Tauri shell (WebView2 on Windows) configured with a persistent
 * user-data directory — that's where cookies + login state survive across
 * app launches. An in-page iframe can't replicate that (browsers isolate
 * iframe storage + many sites block framing via X-Frame-Options). The native
 * shell wiring (src-tauri) is the production path; this panel is the
 * functional UI + per-tab history that the native webview mounts into. The
 * "Open in browser" button (ROUND-40) launches a separate persistent
 * Tauri WebviewWindow — the native window is the ONLY browser path; if the
 * invoke is unavailable (plain Vite preview / capability missing), an inline
 * error is surfaced and the panel deliberately does NOT fall through to the
 * system browser (that path leaked to Microsoft Edge via Tauri's window.open
 * interception).
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

export function BrowserPanel({ projectId, tab }: { projectId: string; tab: RightSidebarTab }) {
  const styles = useThemeStyles();
  const setBrowserUrl = useRightSidebarStore((s) => s.setBrowserUrl);
  const tabId = tab.id;
  const browserUrl = tab.browserUrl ?? null;
  const history = tab.browserHistory ?? [];
  // Pointer into history for back/forward.
  const [histIdx, setHistIdx] = useState(0);
  const [draft, setDraft] = useState(browserUrl ?? "");
  const [iframeKey, setIframeKey] = useState(0);
  // ROUND-40: when the native acute-browser window can't be opened (running in
  // plain Vite, capability missing, or invoke throws), surface an inline
  // error in the panel. We deliberately DO NOT fall through to window.open —
  // that path was the Edge leak the owner flagged.
  const [browserError, setBrowserError] = useState<string | null>(null);

  const go = (raw: string) => {
    const url = normalizeUrl(raw);
    if (url === "") return;
    setBrowserUrl(projectId, tabId, url);
    setHistIdx(0);
    setDraft(url);
    setBrowserError(null);
  };

  const onBack = () => {
    if (histIdx + 1 < history.length) {
      const next = histIdx + 1;
      setHistIdx(next);
      setBrowserUrl(projectId, tabId, history[next]);
      setDraft(history[next]);
    }
  };
  const onForward = () => {
    if (histIdx > 0) {
      const next = histIdx - 1;
      setHistIdx(next);
      setBrowserUrl(projectId, tabId, history[next]);
      setDraft(history[next]);
    }
  };
  const onReload = () => setIframeKey((k) => k + 1);

  // ROUND-40: open the URL in the persistent native `acute-browser` window
  // (separate Chromium profile → isolated cookies/logins from system Edge).
  // This is the ONLY browser path. If the invoke is unavailable (plain Vite
  // preview) or throws (capability missing), we surface an inline error in the
  // panel — we DO NOT fall through to window.open, because Tauri v2
  // intercepts window.open(_blank) → OS default browser → Microsoft Edge,
  // which is exactly the leak the owner reported.
  const onOpenAppBrowser = async () => {
    const url = browserUrl ?? normalizeUrl(draft);
    if (url === "") return;
    setBrowserError(null);
    const w = (window as unknown as { __TAURI__?: { core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } } }).__TAURI__?.core;
    if (!w?.invoke) {
      console.warn("open_browser_window: not in Tauri shell (window.__TAURI__.core.invoke missing)");
      setBrowserError("Embedded browser is only available in the Tauri desktop app.");
      return;
    }
    try {
      await w.invoke("open_browser_window", { url });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("open_browser_window failed:", err);
      setBrowserError(`Embedded browser is only available in the Tauri desktop app. (${msg})`);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    go(draft);
  };

  const canBack = histIdx + 1 < history.length;
  const canForward = histIdx > 0;

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Address bar */}
      <div
        className="shrink-0 flex items-center gap-1 px-2 h-9 border-b"
        style={{ borderColor: styles.border, background: styles.isDark ? "rgba(0,0,0,0.15)" : styles.subtle }}
      >
        <button
          onClick={onBack}
          disabled={!canBack}
          aria-label="Back"
          title="Back"
          className="w-6 h-6 grid place-items-center rounded-md transition-colors disabled:opacity-30"
          style={{ color: styles.textSecondary }}
          onMouseEnter={(e) => { if (canBack) e.currentTarget.style.background = styles.subtleHover; }}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <ArrowLeft size={13} />
        </button>
        <button
          onClick={onForward}
          disabled={!canForward}
          aria-label="Forward"
          title="Forward"
          className="w-6 h-6 grid place-items-center rounded-md transition-colors disabled:opacity-30"
          style={{ color: styles.textSecondary }}
          onMouseEnter={(e) => { if (canForward) e.currentTarget.style.background = styles.subtleHover; }}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <ArrowRight size={13} />
        </button>
        <button
          onClick={onReload}
          aria-label="Reload"
          title="Reload"
          className="w-6 h-6 grid place-items-center rounded-md transition-colors"
          style={{ color: styles.textSecondary }}
          onMouseEnter={(e) => (e.currentTarget.style.background = styles.subtleHover)}
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
        {/* ROUND-40: PRIMARY action — open the persistent native
            `acute-browser` window (isolated Chromium profile, persistent
            logins). The inline iframe below is a secondary preview only. */}
        <button
          onClick={onOpenAppBrowser}
          aria-label="Open in browser"
          title="Open in browser (persistent logins, isolated profile)"
          className="shrink-0 flex items-center gap-1 h-7 px-2.5 rounded-full text-[11px] font-medium transition-colors"
          style={{
            color: styles.isDark ? "#fff" : styles.card,
            background: styles.isDark ? styles.text : styles.textSecondary,
          }}
        >
          <PanelTopOpen size={12} />
          <span>Open in browser</span>
        </button>
      </div>

      {/* ROUND-40: inline error surface — shown when the native window can't
          be opened (running outside the Tauri shell, capability missing, or
          invoke threw). We deliberately do NOT fall through to window.open. */}
      {browserError !== null && (
        <div
          className="shrink-0 flex items-start gap-2 px-3 py-2 text-[11px] border-b"
          style={{
            background: styles.isDark ? "rgba(220,38,38,0.12)" : "rgba(254,226,226,1)",
            color: styles.isDark ? "#fca5a5" : "#b91c1c",
            borderColor: styles.border,
          }}
        >
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
      )}

      {/* Viewport */}
      <div className="flex-1 min-h-0 relative" style={{ background: "#fff" }}>
        {browserUrl === null ? (
          <div className="absolute inset-0 grid place-items-center px-6 text-center" style={{ background: styles.card }}>
            <div>
              <Globe size={28} style={{ color: styles.textTertiary }} className="mx-auto mb-2" />
              <div className="text-[12.5px] font-medium" style={{ color: styles.textSecondary }}>
                Browse the web while the agent works
              </div>
              <div className="text-[11px] mt-1.5 max-w-xs" style={{ color: styles.textTertiary }}>
                Enter a URL above. Per-project history is saved here. Full login persistence requires the native app shell.
              </div>
            </div>
          </div>
        ) : (
          <iframe
            key={iframeKey}
            src={browserUrl}
            title="Acute browser"
            className="absolute inset-0 w-full h-full border-0"
            referrerPolicy="no-referrer"
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
          />
        )}
      </div>
    </div>
  );
}
