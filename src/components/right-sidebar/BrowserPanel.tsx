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
// ROUND-50 (R50-a): the native child-webview bridge (Tauri multiwebview —
// WebView2/Chromium on Windows). When available, the page area is covered by
// a real browser webview instead of the R43 fetch-proxy iframe.
import {
  isNativeBrowserAvailable,
  nativeInvoke,
  nativeTabClose,
  nativeTabCreate,
  nativeTabGo,
  nativeTabNavigate,
  nativeTabSetBounds,
  nativeTabSetVisible,
  onBrowserNavigated,
} from "../../lib/native-browser";

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
 * ROUND-50 (R50-a) — the NATIVE mode. The owner's verdict on the proxy: "a
 * proper full-fledged browser of our own… going with Chromium as the base".
 * On Windows, Tauri's WebView2 IS Chromium, so when the Tauri shell is
 * present (`isNativeBrowserAvailable()`) the page area is covered by a CHILD
 * WEBVIEW of the main window (one per browser tab, Rust side in
 * src-tauri/src/browser.rs) — no proxy, no tickets, full CSS/JS. The iframe
 * path below stays EXACTLY as-is for non-Tauri runs (web dev mode / e2e
 * tests). Both modes share the same store + server-side history, so the
 * agent's browser_control tool drives and reads either one:
 *
 *  - lifecycle: panel mounts → `nativeTabCreate` (idempotent; also called by
 *    the first address-bar navigation of a fresh tab) → bounds sync → show.
 *    Panel unmounts (tab switch / sidebar collapse) → `nativeTabSetVisible
 *    (false)` — the webview STAYS ALIVE so the session persists like a real
 *    browser's background tab. Browser tab closed in the tab strip → the
 *    module-scope reaper below calls `nativeTabClose`.
 *  - bounds: the placeholder div's getBoundingClientRect is piped through
 *    `computeNativeBounds` and pushed to Rust (ResizeObserver + window
 *    resize + a 500ms safety-net interval, rAF-debounced).
 *  - address bar / back / forward / reload drive BOTH the store (server
 *    history — the agent's truth) and the native webview.
 *  - `onBrowserNavigated` (fired by the Rust on_navigation hook) reports
 *    user navigations INSIDE the page (link clicks, redirects) — recorded
 *    into the server history so browser_control get_state stays truthful,
 *    exactly like the iframe path's acute:location handler.
 *  - the live-follow poll reconciles agent-driven navigations: when the
 *    server history's current URL differs from what we last commanded the
 *    webview to load, we navigate the webview (agent actions render live).
 *
 * Ticket auth (iframe path): iframes cannot send Authorization headers, so
 * each tab mints a `bt` ticket (POST /browser/session) and every proxy URL
 * carries it. A dead ticket renders the backend's HTML 401 page INSIDE the
 * iframe — since the sandbox (deliberately no allow-same-origin) hides the
 * frame's DOM from us, the panel detects that case by "loaded but the escape
 * hatch never postMessaged" + a cheap ticket probe, re-mints and reloads —
 * capped at RECOVERY_MAX recoveries per rolling RECOVERY_WINDOW_MS (R48-d),
 * after which it parks on the error card with a manual Retry instead of
 * looping. (The ticket is still minted in native mode — the server-side
 * history/viewport sessions are the agent's browser_control state.)
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
/**
 * ROUND-50 (R50-a): the native-mode bounds safety net. ResizeObserver +
 * window resize cover every layout change we know of, but a DRIFTED child
 * webview is worse than a drifted div — it floats ABOVE the app UI — so
 * bounds are re-asserted on an interval as well (rAF-debounced with the
 * other triggers so bursts collapse into one invoke).
 */
const NATIVE_BOUNDS_INTERVAL_MS = 500;

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

// ── ROUND-50 (R50-a): native-mode geometry ─────────────────────────────────

/** Window-relative bounds for a native child webview (logical px == CSS px). */
export interface NativeBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The measured page area. Structurally satisfied by DOMRect (the panel passes
 * getBoundingClientRect() straight in); a plain subset keeps the helper
 * unit-testable without constructing a full DOMRect.
 */
export interface NativeAreaRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Pure geometry for the native child webview (unit-tested in
 * native-browser.test.tsx):
 *  - viewport === null → NATURAL mode: the webview fills the area exactly
 *    (x/y at the area's top-left corner) — what a browser side-panel does.
 *  - viewport set → PRESET mode: the webview is viewport-sized and CENTERED
 *    in the area, clamped to the area when the preset (after zoom division)
 *    is larger — an overflowing webview would cover the app's own UI, which
 *    is never acceptable.
 * Degenerate dimensions (zero, negative, NaN) collapse to 1px so a bad
 * measurement can never create a zero-sized webview.
 */
export function computeNativeBounds(
  area: NativeAreaRect,
  viewport: { width: number; height: number } | null,
): NativeBounds {
  const dim = (v: number): number => (Number.isFinite(v) && v >= 1 ? v : 1);
  // Sanitize the AREA first — the centering math below must never see NaN.
  const areaW = dim(area.width);
  const areaH = dim(area.height);
  const w = viewport === null ? areaW : dim(Math.min(viewport.width, areaW));
  const h = viewport === null ? areaH : dim(Math.min(viewport.height, areaH));
  return {
    x: area.left + Math.max(0, (areaW - w) / 2),
    y: area.top + Math.max(0, (areaH - h) / 2),
    w,
    h,
  };
}

/**
 * ROUND-50 (R50-a): the tab-close reaper (module scope, installed once).
 *
 * A tab's native webview OUTLIVES its BrowserPanel (hidden when the tab is
 * inactive so the session persists). When a browser tab is CLOSED in the tab
 * strip — possibly while a DIFFERENT tab type is active, so no BrowserPanel
 * for it is mounted — its webview must still be destroyed. This subscription
 * watches the right-sidebar store and closes the native webview of every
 * browser tab id that disappears from ALL slices. Installed by the first
 * native-mode panel mount (never uninstalled — the app is the process).
 */
let nativeTabReaperInstalled = false;
function installNativeTabReaper(): void {
  if (nativeTabReaperInstalled) return;
  nativeTabReaperInstalled = true;
  const collectBrowserTabIds = (
    state: ReturnType<typeof useRightSidebarStore.getState>,
  ): Set<string> => {
    const ids = new Set<string>();
    for (const slice of Object.values(state.byProject)) {
      for (const t of slice.tabs) {
        if (t.type === "browser") ids.add(t.id);
      }
    }
    return ids;
  };
  let known = collectBrowserTabIds(useRightSidebarStore.getState());
  useRightSidebarStore.subscribe((state) => {
    const live = collectBrowserTabIds(state);
    for (const id of known) {
      if (!live.has(id)) void nativeTabClose(id).catch(() => {});
    }
    known = live;
  });
}

/** Best-effort logging for native calls whose failure shouldn't spam the UI. */
function nativeWarn(err: unknown): void {
  console.warn("[native-browser]", err);
}

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

  // ── ROUND-50 (R50-a): native-mode state ─────────────────────────────────
  // Checked per render (NOT module level) so tests can toggle the mocked
  // availability per test. In the shipped app this is constant per process.
  const nativeMode = isNativeBrowserAvailable();
  /** Placeholder for the page area — the native webview floats above it. */
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  /** True once this tab's native webview is known to exist (create resolved). */
  const nativeReadyRef = useRef(false);
  /**
   * The last URL we commanded the native webview to load, or null when
   * unknown (after back/forward — the webview walked its OWN history).
   * Doubles as the echo-suppressor for onBrowserNavigated (we cause the
   * event ourselves) and as the agent-reconcile reference in the poll.
   */
  const lastCommandedUrlRef = useRef<string | null>(null);
  /** Pending rAF handle for the debounced bounds sync. */
  const rafRef = useRef<number | null>(null);
  /** Latest render's effective viewport dims (read inside sync callbacks). */
  const effectiveViewportRef = useRef<{ width: number; height: number } | null>(null);
  /**
   * Natural mode: the webview fills the page area (no preset). The DEFAULT in
   * native mode — a real browser panel just fills — while presets remain one
   * click away for responsive testing (the agent's display-size feature).
   */
  const [naturalSize, setNaturalSize] = useState(true);

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

  // ── derived viewport geometry ───────────────────────────────────────────
  const vp = state?.viewport;
  const rotate = vp?.rotate ?? false;
  const rawW = vp?.width ?? 1280;
  const rawH = vp?.height ?? 800;
  const viewW = rotate ? rawH : rawW;
  const viewH = rotate ? rawW : rawH;
  const zoom = vp?.zoom ?? 1;
  const fit = state?.fit ?? true;

  /**
   * The dims the NATIVE webview should render at, or null for natural mode.
   *
   * ZOOM LIMITATION (R50-a, documented per spec): a child webview cannot be
   * transform-scaled like the iframe — resizing it changes the CSS viewport
   * the page SEES. So zoom divides the target dims (w/zoom, h/zoom): zooming
   * "in" shrinks the CSS viewport so content lays out larger RELATIVE to the
   * (centered) frame. This is a viewport-size approximation of zoom, NOT a
   * DPI zoom — WebView2's zoomFactor is not exposed through Tauri's webview
   * API. Zoom-out (zoom < 1) grows the frame past the panel and is clamped
   * back by computeNativeBounds (effectively 1:1). In natural mode zoom has
   * no effect (null → fill) — pick a preset to zoom.
   */
  const effectiveViewport: { width: number; height: number } | null =
    !nativeMode || naturalSize ? null : { width: viewW / zoom, height: viewH / zoom };
  // Mirror into a ref so the interval/rAF callbacks (which must NOT depend on
  // these values for their identity) always read the latest dims.
  useEffect(() => {
    effectiveViewportRef.current = effectiveViewport;
  });

  // ── native: create/show the tab webview while the panel is mounted ──────
  //
  // Push the placeholder's bounds to Rust. Deps are only [tabId, nativeMode]
  // on purpose: the latest geometry (viewport preset/zoom/rotate/natural) is
  // read through effectiveViewportRef so this callback's identity stays
  // stable across viewport changes (the bounds EFFECT below owns re-syncing
  // on those changes — see its deps).
  const syncBounds = useCallback(() => {
    if (!nativeMode || !nativeReadyRef.current) return;
    const el = placeholderRef.current;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    const b = computeNativeBounds(rect, effectiveViewportRef.current);
    void nativeTabSetBounds(tabId, b.x, b.y, b.w, b.h).catch(nativeWarn);
  }, [tabId, nativeMode]);

  /** rAF-debounced sync — bursts of resize events collapse into one invoke. */
  const scheduleBoundsSync = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      syncBounds();
    });
  }, [syncBounds]);

  /**
   * Create (idempotently) + show this tab's native webview at `url`. Shared
   * by the mount lifecycle (panel activation) and every navigation path.
   */
  const nativeCreate = useCallback(
    (url: string): Promise<void> => {
      lastCommandedUrlRef.current = url;
      return nativeTabCreate(tabId, url)
        .then(() => {
          nativeReadyRef.current = true;
          scheduleBoundsSync();
          return nativeTabSetVisible(tabId, true);
        });
    },
    [tabId, scheduleBoundsSync],
  );

  const nativeFail = useCallback(
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      useBrowserTabStore.getState().setError(tabId, `Native browser failed: ${message}`);
    },
    [tabId],
  );

  useEffect(() => {
    if (!nativeMode) return;
    installNativeTabReaper();
    let cancelled = false;
    // Read from the store at mount (NOT a dep): a tab that already browsed
    // (tab switch back) resumes its live URL; a fresh tab creates lazily on
    // its first navigation instead of loading a blank page.
    const startUrl = useBrowserTabStore.getState().tabs[tabId]?.currentUrl ?? null;
    if (startUrl !== null) {
      void nativeCreate(startUrl).catch((err) => {
        if (!cancelled) nativeFail(err);
      });
    }
    return () => {
      cancelled = true;
      // ANY unmount = the panel went away (active tab switched, sidebar
      // collapsed, tab closed): HIDE the webview but keep it alive — the
      // browsing session persists, exactly like a background tab.
      void nativeTabSetVisible(tabId, false).catch(() => {});
    };
    // Deps note: deliberately NOT keyed on currentUrl — every navigation
    // path drives the webview itself; re-running here would hide + re-create
    // the webview on each URL change. nativeCreate's identity covers tabId.
  }, [tabId, nativeMode, nativeCreate]);

  // ── native: keep the webview glued to the placeholder ───────────────────
  useEffect(() => {
    if (!nativeMode) return;
    // Initial sync + re-sync whenever the effective viewport (preset / zoom /
    // rotate / natural toggle) or the active tab changes.
    scheduleBoundsSync();
    const el = placeholderRef.current;
    const observer = new ResizeObserver(() => scheduleBoundsSync());
    if (el !== null) observer.observe(el);
    const onResize = () => scheduleBoundsSync();
    window.addEventListener("resize", onResize);
    // Safety net — see NATIVE_BOUNDS_INTERVAL_MS.
    const safetyNet = window.setInterval(scheduleBoundsSync, NATIVE_BOUNDS_INTERVAL_MS);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onResize);
      window.clearInterval(safetyNet);
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [nativeMode, scheduleBoundsSync, tabId, viewW, viewH, zoom, rotate, naturalSize]);

  // ── native: user navigations INSIDE the webview ──────────────────────────
  useEffect(() => {
    if (!nativeMode) return;
    return onBrowserNavigated((evtTabId, url) => {
      if (evtTabId !== tabId) return;
      if (!/^https?:\/\//i.test(url)) return;
      // Echo suppression: we caused this navigation (address bar, agent
      // reconcile) — the store already knows; recording it again would add
      // duplicate history entries.
      if (lastCommandedUrlRef.current === url) return;
      lastCommandedUrlRef.current = url;
      // The user clicked a link / submitted a form / got redirected INSIDE
      // the page. Record it into the server-side history so the agent's
      // browser_control get_state stays truthful — the same intent as the
      // iframe path's acute:location handler below.
      void handleLocationMessage(tabId, url);
    });
  }, [nativeMode, tabId, handleLocationMessage]);

  // A tab opened WITH a url (openBrowser(projectId, url)) navigates once the
  // ticket exists.
  useEffect(() => {
    if (state?.status === "ready" && state.ticket !== null && state.currentUrl === null && tab.browserUrl != null) {
      navigateUrl(normalizeUrl(tab.browserUrl));
    }
    // Deps note: navigateUrl is intentionally omitted — it is a stable
    // useCallback over [tabId, nativeMode, store actions]; the guarded
    // condition (currentUrl === null) makes the effect self-disarming.
  }, [state?.status, state?.ticket, state?.currentUrl, tab.browserUrl, tabId]);

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
      void refresh(tabId).then(() => {
        if (!nativeMode) return;
        // ROUND-50: agent-reconcile — the server history is the source of
        // truth for where the tab "should" be. A URL differing from the last
        // one we commanded means the AGENT navigated (browser_control);
        // follow it so agent actions render live.
        const live = useBrowserTabStore.getState().tabs[tabId];
        const serverUrl = live?.currentUrl ?? null;
        if (serverUrl === null) return;
        if (lastCommandedUrlRef.current === null) {
          // Unknown (back/forward walked the webview's own history) — adopt
          // the server URL WITHOUT re-navigating; the webview already moved.
          lastCommandedUrlRef.current = serverUrl;
          return;
        }
        if (serverUrl !== lastCommandedUrlRef.current) {
          lastCommandedUrlRef.current = serverUrl;
          void nativeTabNavigate(tabId, serverUrl).catch(nativeWarn);
        }
      });
    };
    const interval = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(interval);
  }, [tabId, refresh, state?.ticket, nativeMode]);

  // ── escape-hatch postMessages from the proxied page (iframe path) ───────
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
  /**
   * Navigate to `url` through BOTH channels: the store (server-side history —
   * the agent's browser_control truth) AND, in native mode, the child webview
   * (`nativeTabCreate` is create-OR-navigate, so the FIRST navigation of a
   * fresh tab creates the webview).
   */
  const navigateUrl = useCallback(
    (url: string) => {
      if (url === "") return;
      clearError(tabId);
      void navigate(tabId, url);
      if (!nativeMode) return;
      void nativeCreate(url).catch(nativeFail);
    },
    [tabId, nativeMode, clearError, navigate, nativeCreate, nativeFail],
  );

  /**
   * Back / forward / reload through BOTH channels. The native webview walks
   * its OWN session history (eval'd history.back()/forward()/reload — NOT a
   * navigate-to-URL, which would push a new entry), and lastCommandedUrl
   * goes "unknown" until onBrowserNavigated or the poll reports where it
   * landed.
   */
  const goDirection = useCallback(
    (direction: "back" | "forward" | "reload") => {
      if (!nativeMode || !nativeReadyRef.current) {
        void go(tabId, direction);
        return;
      }
      lastCommandedUrlRef.current = null;
      void nativeTabGo(tabId, direction).catch(nativeWarn);
      void go(tabId, direction);
    },
    [tabId, nativeMode, go],
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const url = normalizeUrl(draft);
    if (url === "") return;
    setDraft(url);
    navigateUrl(url);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setDraft(currentUrl ?? "");
      e.currentTarget.blur();
    }
  };

  const onQuickLink = (url: string) => {
    setDraft(url);
    navigateUrl(url);
  };

  const onOpenExternally = () => {
    const url = currentUrl ?? normalizeUrl(draft);
    if (url === "") return;
    // The ONLY window.open in the panel — an explicit, labeled action.
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const onPopOut = async () => {
    const invoke = nativeInvoke();
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
        goDirection("reload");
      }
    });
  };

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

  const emptyState = (
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
          {nativeMode ? (
            <>
              Pages render in the embedded Chromium engine — full CSS and JavaScript, one shared
              profile (logins persist). Type an address above, pick a display size below, or ask
              the agent (“open github.com and check the mobile layout”).
            </>
          ) : (
            <>
              Pages render inside the app through the sidecar proxy — no external tabs, no popup
              blockers. Type an address above, pick a display size below, or ask the agent
              (“open github.com and check the mobile layout”).
            </>
          )}
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
  );

  return (
    <div className="h-full flex flex-col min-h-0" data-testid="browser-panel">
      {/* ── Chrome bar: navigation + address + explicit external actions ── */}
      <div
        className="shrink-0 flex items-center gap-1 px-2 h-9 border-b"
        style={{ borderColor: styles.border, background: styles.isDark ? "rgba(0,0,0,0.15)" : styles.subtle }}
      >
        <button
          onClick={() => goDirection("back")}
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
          onClick={() => goDirection("forward")}
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
            if (state?.currentUrl != null) goDirection("reload");
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

        {nativeMode ? (
          <button
            onClick={() => void onPopOut()}
            aria-label="Pop out window"
            title="Pop out to the native Acute browser window (isolated profile)"
            className="shrink-0 w-6 h-6 grid place-items-center rounded-md transition-colors"
            style={{ color: styles.textTertiary }}
            onMouseEnter={(e) => { e.currentTarget.style.background = styles.subtleHover; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent" }}
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
          value={nativeMode && naturalSize ? "natural" : (vp?.preset ?? "laptop")}
          onChange={(e) => {
            const value = e.target.value;
            if (nativeMode && value === "natural") {
              // Natural mode is PANEL-LOCAL (the webview fills the page
              // area); the server-side display size stays untouched — the
              // agent's display-size testing only applies to fixed presets.
              setNaturalSize(true);
              return;
            }
            if (nativeMode) setNaturalSize(false);
            void setViewport(tabId, value === "custom" ? { preset: "custom" } : { preset: value });
          }}
          aria-label="Display size preset"
          data-testid="browser-preset-select"
          className="h-6 px-1 rounded-md border outline-none cursor-pointer max-w-[118px]"
          style={{ background: styles.card, borderColor: styles.border, color: styles.textSecondary }}
        >
          {/* ROUND-50: native-mode default — fill the panel like a real
              browser side-panel; presets remain one click away. */}
          {nativeMode ? <option value="natural">Natural (fill panel)</option> : null}
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
            onCommit={(w) => {
              if (nativeMode) setNaturalSize(false);
              void setViewport(tabId, { width: w });
            }}
            label="Viewport width"
            testId="browser-width-input"
            width={52}
          />
          <span>×</span>
          <ViewportNumberInput
            value={rawH}
            min={200}
            max={4320}
            onCommit={(h) => {
              if (nativeMode) setNaturalSize(false);
              void setViewport(tabId, { height: h });
            }}
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
          title={
            nativeMode
              ? `Native mode: presets larger than the panel are clamped to the panel — the page sees the clamped CSS pixels`
              : `True viewport ${viewW}×${viewH}px — the page sees these CSS pixels`
          }
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
        {nativeMode ? (
          /* ROUND-50 (R50-a): the page area placeholder. The native child
             webview is NOT a DOM child — it is an OS-level child of the
             window floating ABOVE the web UI, positioned over this div by
             the bounds sync above. It renders the page (full CSS/JS); this
             div only marks the rectangle + hosts the empty state. */
          <div
            ref={placeholderRef}
            data-testid="browser-native-placeholder"
            className="relative h-full w-full"
          >
            {!hasPage ? emptyState : null}
          </div>
        ) : !hasPage ? (
          emptyState
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

      {/* ── status footnote: mode honesty ───────────────────────────────── */}
      <div
        className="shrink-0 flex items-center gap-1.5 px-3 h-6 border-t text-[10px]"
        style={{ borderColor: styles.border, color: styles.textTertiary }}
      >
        <Info size={10} className="shrink-0" />
        <span className="truncate">
          {nativeMode ? (
            <>
              Rendered by the embedded Chromium engine (WebView2) — full CSS/JS, one shared profile,
              logins persist. “Open externally” is always available.
            </>
          ) : (
            <>
              Rendered through the sidecar proxy — logins don’t persist; heavily scripted sites may load
              partially. “Open externally” is always available.
            </>
          )}
        </span>
      </div>
    </div>
  );
}
