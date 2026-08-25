import { useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Globe, RotateCw } from "lucide-react";
import { useRightSidebarStore } from "../../lib/right-sidebar-store";
import { useThemeStyles } from "../../lib/use-theme-styles";

/**
 * ROUND-38 right-sidebar Browser tab (owner: "a full-fledged kind of a
 * browser… storing the credentials, saving the sessions… kept logged in…
 * used throughout all of the sessions, projects").
 *
 * WHAT'S HERE: an embedded webview (iframe) with an address bar, back/forward
 * through the per-project history, reload, and a per-project history list
 * (persisted in right-sidebar-store). The address bar accepts URLs or search
 * terms (defaults to a search engine).
 *
 * HONEST SCOPE: full credential/session persistence across the app requires
 * the native Tauri shell (WebView2 on Windows) configured with a persistent
 * user-data directory — that's where cookies + login state survive across
 * app launches. An in-page iframe can't replicate that (browsers isolate
 * iframe storage + many sites block framing via X-Frame-Options). The native
 * shell wiring (src-tauri) is the production path; this panel is the
 * functional UI + per-project history that the native webview mounts into.
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

export function BrowserPanel({ projectId }: { projectId: string }) {
  const styles = useThemeStyles();
  const slice = useRightSidebarStore((s) => s.byProject[projectId]);
  const setBrowserUrl = useRightSidebarStore((s) => s.setBrowserUrl);
  const pushBrowserHistory = useRightSidebarStore((s) => s.pushBrowserHistory);
  const browserUrl = slice?.browserUrl ?? null;
  const history = slice?.browserHistory ?? [];
  // Pointer into history for back/forward.
  const [histIdx, setHistIdx] = useState(0);
  const [draft, setDraft] = useState(browserUrl ?? "");
  const [iframeKey, setIframeKey] = useState(0);

  const go = (raw: string) => {
    const url = normalizeUrl(raw);
    if (url === "") return;
    setBrowserUrl(projectId, url);
    pushBrowserHistory(projectId, url);
    setHistIdx(0);
    setDraft(url);
  };

  const onBack = () => {
    if (histIdx + 1 < history.length) {
      const next = histIdx + 1;
      setHistIdx(next);
      setBrowserUrl(projectId, history[next]);
      setDraft(history[next]);
    }
  };
  const onForward = () => {
    if (histIdx > 0) {
      const next = histIdx - 1;
      setHistIdx(next);
      setBrowserUrl(projectId, history[next]);
      setDraft(history[next]);
    }
  };
  const onReload = () => setIframeKey((k) => k + 1);

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
      </div>

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
