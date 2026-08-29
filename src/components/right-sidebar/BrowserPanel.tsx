import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Info,
  LoaderCircle,
  PanelTopOpen,
  RotateCw,
  Smartphone,
  Shrink,
  Expand,
  X,
} from "lucide-react";
import { useRightSidebarStore, type RightSidebarTab } from "../../lib/right-sidebar-store";
import { useThemeStyles } from "../../lib/use-theme-styles";
import {
  BROWSER_VIEWPORT_PRESETS,
  buildProxySrc,
  probeBrowserTicket,
  useBrowserTabStore,
} from "../../lib/browser-store";

/**
 * ROUND-43 (R43-10) — the EMBEDDED BROWSER, finally inside the right sidebar.
 *
 * History: R41 opened a native Tauri WebviewWindow (separate OS window); R42
 * web mode window.open'd the URL into the owner's system browser — he rejected
 * BOTH ("a real embedded browser inside the app"). This panel is the R43
 * design: pages render in a SANDBOXED iframe through the sidecar proxy
 * (/api/v1/browser/proxy — framing headers stripped server-side, so
 * X-Frame-Options sites like github.com render), with server-side history +
 * display-size (viewport) state per tab that the `browser_control` agent tool
 * reads/writes live.
 *
 * Ticket auth: iframes cannot send Authorization headers, so each tab mints a
 * `bt` ticket (POST /browser/session) and every proxy URL carries it. A dead
 * ticket renders the backend's HTML 401 page INSIDE the iframe — since the
 * sandbox (deliberately no allow-same-origin) hides the frame's DOM from us,
 * the panel detects that case by "loaded but the escape hatch never
 * postMessaged" + a cheap ticket probe, re-mints and reloads — capped at
 * RECOVERY_MAX recoveries per rolling RECOVERY_WINDOW_MS (R48-d), after
 * which it parks on the error card with a manual Retry instead of looping.
 *
 * window.open from inside pages is intercepted by the backend's escape hatch
 * and postMessaged to us ({type:"acute:open"}) — the PANEL decides (navigate
 * in-panel). The ONLY window.open left in this panel is the explicit,
 * clearly-labeled "Open externally" ghost button.
 */

/** How long after an iframe load without an escape-hatch postMessage we wait
 * before probing whether the ticket died (an error page never postMessages). */
const ERROR_DETECT_MS = 900;
/** Live-follow poll: agent navigations/viewport changes land here. */
const POLL_MS = 4000;
/**
 * ROUND-48 (R48-d): dead-ticket recovery is capped by a ROLLING TIME window
 * — max RECOVERY_MAX re-mints per RECOVERY_WINDOW_MS — never by navSeq. The
 * pre-R48 per-navSeq counter reset on every recovery (each recovery reloads
 * the iframe, bumping navSeq), so a persistently dead ticket flashed forever;
 * past the cap the panel parks on the error card with the manual Retry
 * affordance instead of reloading. Manual Retry/Reload stay user-paced and
 * always work; the window empties itself as entries age out.
 */
const RECOVERY_MAX = 3;
const RECOVERY_WINDOW_MS = 60_000;

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

const IS_TAURI = tauriInvoke() !== null;

const QUICK_LINKS: Array<{ label: string; url: string }> = [
  { label: "GitHub", url: "https://github.com" },
  { label: "MDN", url: "https://developer.mozilla.org" },
  // The backend's private-net allowlist lets the owner test HIS OWN app here.
  { label: "This app (dev)", url: "http://localhost:5173" },
];

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];

/**
 * Number input that lets the user TYPE freely ("3", "30", "300"…) instead
 * of snapping back mid-edit: keeps a local draft, commits only values inside
 * [min, max] (the backend's validation range), re-syncs when the prop moves
 * (preset pick, agent set_viewport, poll).
 */
function ViewportNumberInput({
  value,
  min,
  max,
  onCommit,
  label,
  testId,
  width,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (v: number) => void;
  label: string;
  testId: string;
  width: number;
}) {
  const styles = useThemeStyles();
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(String(value));
  }, [value, focused]);
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={draft}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        const v = Number(draft);
        if (Number.isFinite(v) && v >= min && v <= max && Math.round(v) !== value) onCommit(Math.round(v));
        else setDraft(String(value));
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        const v = Number(e.target.value);
        if (Number.isFinite(v) && v >= min && v <= max) onCommit(Math.round(v));
      }}
      aria-label={label}
      data-testid={testId}
      className="px-1 rounded-md border text-center outline-none"
      style={{ width, height: 24, background: styles.card, borderColor: styles.border, color: styles.textSecondary }}
    />
  );
}

export function BrowserPanel({ projectId, tab }: { projectId: string; tab: RightSidebarTab }) {
  const styles = useThemeStyles();
  const tabId = tab.id;
  const patchTab = useRightSidebarStore((s) => s.patchTab);
  const setBrowserUrl = useRightSidebarStore((s) => s.setBrowserUrl);

  const state = useBrowserTabStore((s) => s.tabs[tabId]) ?? null;
  const ensureTab = useBrowserTabStore((s) => s.ensureTab);
  const mint = useBrowserTabStore((s) => s.mint);
  const navigate = useBrowserTabStore((s) => s.navigate);
  const go = useBrowserTabStore((s) => s.go);
  const setViewport = useBrowserTabStore((s) => s.setViewport);
  const setFit = useBrowserTabStore((s) => s.setFit);
  const refresh = useBrowserTabStore((s) => s.refresh);
  const handleLocationMessage = useBrowserTabStore((s) => s.handleLocationMessage);
  const handleTitleMessage = useBrowserTabStore((s) => s.handleTitleMessage);
  const handleOpenMessage = useBrowserTabStore((s) => s.handleOpenMessage);
  const setLoading = useBrowserTabStore((s) => s.setLoading);
  const clearError = useBrowserTabStore((s) => s.clearError);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  /** Did the loaded document postMessage us? Error pages never do. */
  const locationSeenRef = useRef(false);
  /** Timestamps of recent dead-ticket recoveries (rolling cap, R48-d). */
  const recoveryLogRef = useRef<number[]>([]);

  const [draft, setDraft] = useState<string>(tab.browserUrl ?? "");
  const [availWidth, setAvailWidth] = useState(420);

  const currentUrl = state?.currentUrl ?? null;
  const navSeq = state?.navSeq ?? 0;

  // ── mount: initialize the slice + mint the ticket ──────────────────────
  useEffect(() => {
    ensureTab(tabId);
    void mint(tabId);
  }, [tabId, ensureTab, mint]);

  // A tab opened WITH a url (openBrowser(projectId, url)) navigates once the
  // ticket exists.
  useEffect(() => {
    if (state?.status === "ready" && state.ticket !== null && state.currentUrl === null && tab.browserUrl != null) {
      void navigate(tabId, normalizeUrl(tab.browserUrl));
    }
  }, [state?.status, state?.ticket, state?.currentUrl, tab.browserUrl, tabId, navigate]);

  // Address bar follows the live URL (agent navigations included).
  useEffect(() => {
    if (currentUrl !== null) setDraft(currentUrl);
  }, [currentUrl]);

  // Tab strip + persisted tab state track host/title.
  useEffect(() => {
    if (currentUrl === null) return;
    setBrowserUrl(projectId, tabId, currentUrl);
    const host = currentUrl.replace(/^https?:\/\//, "").split("/")[0];
    patchTab(projectId, tabId, { title: state?.currentTitle ?? host ?? "Browser" });
  }, [currentUrl, state?.currentTitle, projectId, tabId, setBrowserUrl, patchTab]);

  // ── the live-follow poll (agent-driven changes land here) ──────────────
  useEffect(() => {
    if (state?.ticket === null || state?.ticket === undefined) return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void refresh(tabId);
    };
    const interval = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(interval);
  }, [tabId, refresh, state?.ticket]);

  // ── escape-hatch postMessages from the proxied page ────────────────────
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // The iframe is sandboxed WITHOUT allow-same-origin → opaque origin,
      // reported as the literal string "null". Anything else is not ours.
      if (event.origin !== "null") return;
      if (event.source !== null && iframeRef.current !== null && event.source !== iframeRef.current.contentWindow) {
        return;
      }
      const data = event.data as { type?: unknown; url?: unknown; title?: unknown } | null;
      if (data === null || typeof data !== "object" || typeof data.type !== "string") return;
      if (data.type === "acute:location") {
        locationSeenRef.current = true;
        if (typeof data.url === "string" && /^https?:\/\//i.test(data.url)) {
          void handleLocationMessage(tabId, data.url);
        }
        return;
      }
      if (data.type === "acute:title") {
        if (typeof data.title === "string" && data.title !== "" && data.title.length <= 300) {
          locationSeenRef.current = true;
          void handleTitleMessage(tabId, data.title);
        }
        return;
      }
      if (data.type === "acute:open") {
        // window.open from inside the page — the PANEL decides. Default: stay
        // in-panel (the R42 external-tab behavior is what the owner rejected).
        if (typeof data.url === "string" && /^https?:\/\//i.test(data.url)) {
          void handleOpenMessage(tabId, data.url);
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [tabId, handleLocationMessage, handleTitleMessage, handleOpenMessage]);

  // ── error-page / dead-ticket detection after each iframe load ──────────
  const onIframeLoad = useCallback(() => {
    setLoading(tabId, false);
    // Capture the seq this load belongs to: a newer navigation supersedes
    // it and will run its own detection (probing a stale ticket mid-flight
    // would fire bogus recoveries).
    const seq = navSeq;
    window.setTimeout(async () => {
      if (locationSeenRef.current) return;
      const live = useBrowserTabStore.getState().tabs[tabId];
      if (live === undefined || live.ticket === null || live.currentUrl === null) return;
      if (live.navSeq !== seq) return;
      // Nothing postMessaged — either the backend rendered an error page
      // (fine, it is informative) or the ticket died (401 page). Probe.
      const alive = await probeBrowserTicket("x", live.sessionId, live.ticket);
      if (alive) return;
      // R48-d rolling cap: count recoveries by TIME so the navSeq bump every
      // recovery causes cannot reset the guard (that reset was the flash
      // loop's engine). Park once the window is exhausted.
      const now = Date.now();
      recoveryLogRef.current = recoveryLogRef.current.filter((ts) => now - ts < RECOVERY_WINDOW_MS);
      if (recoveryLogRef.current.length >= RECOVERY_MAX) {
        useBrowserTabStore
          .getState()
          .setError(tabId, "The browser session keeps failing — automatic recovery paused. Click Retry to mint a fresh ticket.");
        return;
      }
      recoveryLogRef.current.push(now);
      // Re-mint once (POST /browser/session rotates the ticket; the panel
      // adopts the new one) and reload the current page.
      await mint(tabId);
      await go(tabId, "reload");
    }, ERROR_DETECT_MS);
  }, [tabId, setLoading, mint, go, navSeq]);

  // Reset per-navigation tracking so a fresh load re-arms detection. The
  // recovery LOG deliberately survives navSeq bumps (R48-d) — resetting it
  // here is what used to un-cap the loop.
  useEffect(() => {
    locationSeenRef.current = false;
  }, [navSeq]);

  // Measure the content area for the Fit scale.
  useEffect(() => {
    const el = contentRef.current;
    if (el === null) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 420;
      setAvailWidth(Math.max(120, width - 24));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // ── actions ─────────────────────────────────────────────────────────────
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const url = normalizeUrl(draft);
    if (url === "") return;
    setDraft(url);
    clearError(tabId);
    void navigate(tabId, url);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setDraft(currentUrl ?? "");
      e.currentTarget.blur();
    }
  };

  const onQuickLink = (url: string) => {
    setDraft(url);
    clearError(tabId);
    void navigate(tabId, url);
  };

  const onOpenExternally = () => {
    const url = currentUrl ?? normalizeUrl(draft);
    if (url === "") return;
    // The ONLY window.open in the panel — an explicit, labeled action.
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const onPopOut = async () => {
    const invoke = tauriInvoke();
    const url = currentUrl;
    if (invoke === null || url === null) return;
    try {
      await invoke("open_browser_window", { url });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      useBrowserTabStore.getState().setError(tabId, `Pop-out window failed: ${msg}`);
    }
  };

  const onRetry = () => {
    clearError(tabId);
    void mint(tabId).then(() => {
      const live = useBrowserTabStore.getState().tabs[tabId];
      if (live?.ticket !== null && live?.ticket !== undefined && live.currentUrl !== null) {
        void go(tabId, "reload");
      }
    });
  };

  // ── derived viewport geometry ───────────────────────────────────────────
  const vp = state?.viewport;
  const rotate = vp?.rotate ?? false;
  const rawW = vp?.width ?? 1280;
  const rawH = vp?.height ?? 800;
  const viewW = rotate ? rawH : rawW;
  const viewH = rotate ? rawW : rawH;
  const zoom = vp?.zoom ?? 1;
  const fit = state?.fit ?? true;
  const fitScale = fit ? Math.min(1, availWidth / Math.max(1, viewW * zoom)) : 1;
  const scale = zoom * fitScale;
  const readout =
    `${viewW}×${viewH} @ ${Math.round(zoom * 100)}%` +
    (fit && fitScale < 1 ? ` (fit ${Math.round(scale * 100)}%)` : "");

  const ghostBtn = (extraStyle?: CSSProperties): CSSProperties => ({
    color: styles.textSecondary,
    background: "transparent",
    border: `1px solid ${styles.border}`,
    ...extraStyle,
  });

  const hasPage = state !== null && state.currentUrl !== null && state.ticket !== null;

  return (
    <div className="h-full flex flex-col min-h-0" data-testid="browser-panel">
      {/* ── Chrome bar: navigation + address + explicit external actions ── */}
      <div
        className="shrink-0 flex items-center gap-1 px-2 h-9 border-b"
        style={{ borderColor: styles.border, background: styles.isDark ? "rgba(0,0,0,0.15)" : styles.subtle }}
      >
        <button
          onClick={() => void go(tabId, "back")}
          disabled={!state?.canBack}
          data-testid="browser-back"
          aria-label="Back"
          title="Back"
          className="w-6 h-6 grid place-items-center rounded-md transition-colors disabled:opacity-30"
          style={{ color: styles.textSecondary }}
          onMouseEnter={(e) => { if (state?.canBack) e.currentTarget.style.background = styles.subtleHover; }}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <ArrowLeft size={13} />
        </button>
        <button
          onClick={() => void go(tabId, "forward")}
          disabled={!state?.canForward}
          data-testid="browser-forward"
          aria-label="Forward"
          title="Forward"
          className="w-6 h-6 grid place-items-center rounded-md transition-colors disabled:opacity-30"
          style={{ color: styles.textSecondary }}
          onMouseEnter={(e) => { if (state?.canForward) e.currentTarget.style.background = styles.subtleHover; }}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <ArrowRight size={13} />
        </button>
        <button
          onClick={() => {
            if (state?.currentUrl != null) void go(tabId, "reload");
          }}
          disabled={!hasPage}
          data-testid="browser-reload"
          aria-label={state?.loading ? "Stop and reload" : "Reload"}
          title={state?.loading ? "Stop (reloads)" : "Reload"}
          className="w-6 h-6 grid place-items-center rounded-md transition-colors disabled:opacity-30"
          style={{ color: styles.textSecondary }}
          onMouseEnter={(e) => { if (hasPage) e.currentTarget.style.background = styles.subtleHover; }}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          {state?.loading ? <X size={13} /> : <RotateCw size={12} />}
        </button>

        <form onSubmit={onSubmit} className="flex-1 min-w-0 flex items-center">
          <div
            className="flex-1 flex items-center gap-1.5 h-7 px-2.5 rounded-full border"
            style={{ background: styles.card, borderColor: styles.border }}
          >
            {state?.loading ? (
              <LoaderCircle size={11} className="shrink-0 animate-spin" style={{ color: styles.accent }} data-testid="browser-spinner" />
            ) : (
              <Globe size={11} className="shrink-0" style={{ color: styles.textTertiary }} />
            )}
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={(e) => e.target.select()}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                // Paste-and-go: pasting a bare address navigates immediately.
                const text = e.clipboardData.getData("text").trim();
                if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(text)) {
                  e.preventDefault();
                  onQuickLink(normalizeUrl(text));
                }
              }}
              placeholder="Search or enter address"
              aria-label="Browser address"
              data-testid="browser-address-input"
              spellCheck={false}
              autoComplete="off"
              className="flex-1 min-w-0 bg-transparent outline-none text-[11.5px]"
              style={{ color: styles.text }}
            />
          </div>
        </form>

        {IS_TAURI ? (
          <button
            onClick={() => void onPopOut()}
            aria-label="Pop out window"
            title="Pop out to the native Acute browser window (isolated profile)"
            className="shrink-0 w-6 h-6 grid place-items-center rounded-md transition-colors"
            style={{ color: styles.textTertiary }}
            onMouseEnter={(e) => { e.currentTarget.style.background = styles.subtleHover; }}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <PanelTopOpen size={13} />
          </button>
        ) : null}
        <button
          onClick={onOpenExternally}
          aria-label="Open externally"
          title="Open the current page in your system browser (explicit action)"
          data-testid="browser-open-external"
          className="shrink-0 w-6 h-6 grid place-items-center rounded-md transition-colors"
          style={{ color: styles.textTertiary }}
          onMouseEnter={(e) => { e.currentTarget.style.background = styles.subtleHover; }}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <ExternalLink size={13} />
        </button>
      </div>

      {/* ── Viewport bar: the display-size controls (R43-10 core feature) ── */}
      <div
        className="shrink-0 flex items-center gap-1.5 px-2 h-8 border-b text-[10.5px]"
        style={{ borderColor: styles.border, color: styles.textTertiary, background: styles.isDark ? "rgba(0,0,0,0.08)" : "transparent" }}
      >
        <select
          value={vp?.preset ?? "laptop"}
          onChange={(e) => {
            const value = e.target.value;
            void setViewport(tabId, value === "custom" ? { preset: "custom" } : { preset: value });
          }}
          aria-label="Display size preset"
          data-testid="browser-preset-select"
          className="h-6 px-1 rounded-md border outline-none cursor-pointer max-w-[118px]"
          style={{ background: styles.card, borderColor: styles.border, color: styles.textSecondary }}
        >
          {BROWSER_VIEWPORT_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
        <span className="flex items-center gap-0.5">
          <ViewportNumberInput
            value={rawW}
            min={200}
            max={3840}
            onCommit={(w) => void setViewport(tabId, { width: w })}
            label="Viewport width"
            testId="browser-width-input"
            width={52}
          />
          <span>×</span>
          <ViewportNumberInput
            value={rawH}
            min={200}
            max={4320}
            onCommit={(h) => void setViewport(tabId, { height: h })}
            label="Viewport height"
            testId="browser-height-input"
            width={52}
          />
        </span>
        <select
          value={String(Math.round(zoom * 100))}
          onChange={(e) => void setViewport(tabId, { zoom: Number(e.target.value) / 100 })}
          aria-label="Zoom"
          data-testid="browser-zoom-select"
          className="h-6 px-1 rounded-md border outline-none cursor-pointer"
          style={{ background: styles.card, borderColor: styles.border, color: styles.textSecondary }}
        >
          {ZOOM_STEPS.map((z) => (
            <option key={z} value={String(Math.round(z * 100))}>
              {Math.round(z * 100)}%
            </option>
          ))}
        </select>
        <button
          onClick={() => void setViewport(tabId, { rotate: !rotate })}
          aria-pressed={rotate}
          aria-label="Rotate viewport"
          title={rotate ? "Rotate back to portrait" : "Rotate (swap width/height)"}
          data-testid="browser-rotate"
          className="w-6 h-6 grid place-items-center rounded-md transition-colors"
          style={{ color: rotate ? styles.accent : styles.textTertiary }}
          onMouseEnter={(e) => { e.currentTarget.style.background = styles.subtleHover; }}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <Smartphone size={12} style={rotate ? { transform: "rotate(90deg)" } : undefined} />
        </button>
        <button
          onClick={() => setFit(tabId, !fit)}
          aria-pressed={fit}
          aria-label="Fit to panel"
          title={fit ? "Fit: scaled down to the panel width (true px preserved)" : "1:1 — scroll the panel instead"}
          data-testid="browser-fit"
          className="w-6 h-6 grid place-items-center rounded-md transition-colors"
          style={{ color: fit ? styles.accent : styles.textTertiary }}
          onMouseEnter={(e) => { e.currentTarget.style.background = styles.subtleHover; }}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          {fit ? <Shrink size={12} /> : <Expand size={12} />}
        </button>
        <span
          className="ml-auto shrink-0 font-mono text-[10px] px-1.5 py-0.5 rounded-md"
          data-testid="browser-readout"
          style={{ background: styles.subtle, color: styles.textTertiary }}
          title={`True viewport ${viewW}×${viewH}px — the page sees these CSS pixels`}
        >
          {readout}
        </span>
      </div>

      {/* ── Panel-level error (session mint / navigation failures) ───────── */}
      {state?.error != null ? (
        <div
          className="shrink-0 flex items-start gap-2 px-3 py-2 text-[11px] border-b"
          style={{
            background: styles.isDark ? "rgba(220,38,38,0.12)" : "rgba(254,226,226,1)",
            color: styles.isDark ? "#fca5a5" : "#b91c1c",
            borderColor: styles.border,
          }}
          data-testid="browser-error-card"
          role="alert"
        >
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span className="flex-1">{state.error}</span>
          <button
            onClick={onRetry}
            data-testid="browser-retry"
            className="shrink-0 px-2 py-0.5 rounded-md font-medium"
            style={ghostBtn({ color: styles.isDark ? "#fca5a5" : "#b91c1c", borderColor: styles.isDark ? "rgba(252,165,165,0.4)" : "rgba(185,28,28,0.3)" })}
          >
            Retry
          </button>
          <button
            onClick={() => clearError(tabId)}
            aria-label="Dismiss"
            className="shrink-0 opacity-60 hover:opacity-100"
            style={{ color: "inherit" }}
          >
            ×
          </button>
        </div>
      ) : null}

      {/* ── Content: empty state or the scaled viewport frame ────────────── */}
      <div
        ref={contentRef}
        className="flex-1 min-h-0 overflow-auto"
        style={{ background: styles.isDark ? "rgba(0,0,0,0.22)" : styles.subtle }}
      >
        {!hasPage ? (
          <div className="h-full grid place-items-center px-6 text-center" data-testid="browser-empty">
            <div>
              <div
                className="w-14 h-14 mx-auto mb-3 grid place-items-center rounded-2xl"
                style={{ background: styles.isDark ? "rgba(0,0,0,0.18)" : styles.card, border: `1px solid ${styles.border}` }}
              >
                <Globe size={26} style={{ color: styles.accent }} />
              </div>
              <div className="text-[12.5px] font-medium" style={{ color: styles.textSecondary }}>
                Embedded browser
              </div>
              <div className="text-[11px] mt-1.5 max-w-xs mx-auto leading-relaxed" style={{ color: styles.textTertiary }}>
                Pages render inside the app through the sidecar proxy — no external tabs, no popup
                blockers. Type an address above, pick a display size below, or ask the agent
                (“open github.com and check the mobile layout”).
              </div>
              <div className="mt-4 flex items-center justify-center gap-2">
                {QUICK_LINKS.map((link) => (
                  <button
                    key={link.url}
                    onClick={() => onQuickLink(link.url)}
                    className="inline-flex items-center gap-1 h-7 px-3 rounded-full text-[11px] font-medium transition-colors"
                    style={ghostBtn()}
                    onMouseEnter={(e) => { e.currentTarget.style.background = styles.subtleHover; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    <Globe size={10} />
                    {link.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="min-h-full w-full grid justify-center px-3 py-3">
            <div
              data-testid="browser-viewport-frame"
              className="relative bg-white shadow-md"
              style={{
                width: Math.round(viewW * scale),
                height: Math.round(viewH * scale),
                border: `1px solid ${styles.borderStrong}`,
                borderRadius: 4,
                overflow: "hidden",
              }}
            >
              <iframe
                key={navSeq}
                ref={iframeRef}
                src={buildProxySrc(state.currentUrl as string, state.sessionId, state.ticket as string)}
                onLoad={onIframeLoad}
                title={state.currentTitle ?? "Embedded browser page"}
                data-testid="browser-iframe"
                className="absolute top-0 left-0"
                style={{
                  width: viewW,
                  height: viewH,
                  border: "none",
                  transform: `scale(${scale})`,
                  transformOrigin: "top left",
                  background: "#fff",
                }}
                sandbox="allow-scripts allow-forms allow-popups"
                referrerPolicy="no-referrer"
              />
            </div>
          </div>
        )}
      </div>

      {/* ── status footnote: proxy-mode honesty ──────────────────────────── */}
      <div
        className="shrink-0 flex items-center gap-1.5 px-3 h-6 border-t text-[10px]"
        style={{ borderColor: styles.border, color: styles.textTertiary }}
      >
        <Info size={10} className="shrink-0" />
        <span className="truncate">
          Rendered through the sidecar proxy — logins don’t persist; heavily scripted sites may load
          partially. “Open externally” is always available.
        </span>
      </div>
    </div>
  );
}
