import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
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
  nativeTabExists,
  nativeTabGo,
  nativeTabNavigate,
  nativeTabSetBounds,
  nativeTabSetVisible,
  // R60: REAL DPI zoom (Rust browser_tab_set_zoom — WebView2 zoomFactor).
  nativeTabSetZoom,
  onBrowserNavigated,
  openExternalUrl,
} from "../../lib/native-browser";
// ROUND-58 (R58-b): Tauri detection for the "Open externally" handoff —
// ONE source of truth, same as native-browser.ts itself.
import { isTauri } from "../../lib/sidecar";
// R60-D: the shared popover-suppression guard — a webview must never show
// itself while a RightSidebar popover covers the page area. R62: the guard
// module is now store-backed + also carries the GLOBAL overlay flag (any
// open menu/dialog/popover hides every webview — the owner's z-order fix).
import { isWebviewHiddenNow, overlayCoversRect, refreshOverlayRectsNow, useWebviewGuardStore } from "./popover-webview-guard";
// R90-D1: the always-visible cursor's boot script (the webview's
// initialization script — see src/lib/agent-hands-boot.ts).
import { buildHandsBootScript } from "../../lib/agent-hands-boot";
// R62 (D8): the agent-browser command bridge — this panel is the handler:
// eval runs in THIS tab's webview; screenshot_meta reports this panel's
// on-screen rect + window metrics for the computer-use region capture.
import { registerBrowserCommandHandler } from "../../lib/agent-browser-bridge";
import { nativeTabEval, nativeWindowMetrics } from "../../lib/native-browser";

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
 * ROUND-60 (R60-D) — three owner fixes on top: (1) REAL zoom — the R50
 * divide-viewport-by-zoom approximation is retired (tauri 2.11 exposes
 * `Webview::set_zoom`); the store's zoom now drives the Rust
 * `browser_tab_set_zoom` command so media queries + rem layout re-evaluate
 * like a browser's Ctrl+±, in natural AND preset mode. (2) The viewport
 * bar is regrouped (size | view) with flex-wrap so a ~380px sidebar never
 * clips controls, and the FIT button is honestly DISABLED in native mode
 * (presets are already auto-clamped to the panel by computeNativeBounds —
 * there is nothing left to scale down). (3) The R59 rounded design
 * language: the chrome/viewport/content rows are rounded cards on the
 * panel's ambient strip, and the content card insets the native webview
 * so its square OS-level corners stay inside the card's rounded frame.
 * The proxy/iframe path below keeps its exact geometry math (zoom stays a
 * transform scale there).
 *
 * ROUND-62 (D7) — the status footnote (engine badge + renderer blurb) is
 * REMOVED entirely (owner: "at the bottom this is not needed to be shown so
 * just remove this"). The fallback error CARD still explains a native
 * failure when one actually happens — the standing footnote was the noise.
 *
 * ROUND-51 (R51-a) — native-failure honesty: if the native backend REJECTS
 * (`nativeTabCreate` failing = WebView2 runtime missing/broken, command
 * error…), the panel flips itself into the proxy path for the rest of the
 * mount (`nativeDisabled`) instead of sitting on a dead panel — the owner
 * still browses, the error card explains the fallback, and the status
 * footnote's ENGINE BADGE shows which renderer is live ("Chromium
 * (native)" vs "Proxy fallback") so nobody has to guess.
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
 * in-panel). The ONLY unconditional window.open left in this panel is the
 * explicit, clearly-labeled "Open externally" ghost button — and R58-b:
 * inside the Tauri shell even that one goes through the Rust
 * `open_external_url` command instead (window.open inside WebView2 is
 * silently swallowed by wry); window.open survives as the web-mode path and
 * the fallback when the Rust handoff fails.
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

/**
 * R91-B3: the VISIBILITY WATCHDOG's period. Every 2s the panel re-asserts
 * the ACTIVE, unguarded tab's webview visibility + bounds, and recreates
 * the webview outright when it discovers it never came to exist. This is
 * the self-healing layer for the v0.88.0 field report class — a webview
 * that is ALIVE (evals answer, the agent drives it) but INVISIBLE (a
 * hide/show race, a lost bounds sync, a create that never landed) heals
 * within one period, without the user ever knowing a race happened.
 * Paused while the panel is inactive (keep-alive hidden) or suppressed
 * (a popover legitimately owns the hidden webview) — those states WANT
 * the webview hidden; the watchdog must never fight them.
 */
const NATIVE_WATCHDOG_INTERVAL_MS = 2000;

/**
 * R91-B3: how long an explicit affordance (pop-out, open-externally) waits
 * for its invoke before declaring the shell wedged. A hung main thread
 * never REJECTS an invoke — the promise just never settles — and the
 * pre-R91 code let that silence read as "the button does nothing". The
 * timeout converts the silence into the honest error card.
 */
const NATIVE_AFFORDANCE_TIMEOUT_MS = 6000;

/** R91-B3: reject with a readable timeout error after `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)}s — the desktop shell may be busy; try again`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

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
  /** R62: the aspect-fit scale the webview renders at (1 = true size). The
   *  panel composes this into the DPI zoom so the page sees the full preset
   *  CSS px — the native twin of the proxy path's transform scale. */
  scale: number;
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
 *    (x/y at the area's top-left corner), scale 1 — what a browser
 *    side-panel does.
 *  - viewport set → PRESET mode (R62, owner: "the view is actually not
 *    respecting the dimensions set by the user"): the webview renders the
 *    preset at TRUE CSS PIXELS — it is ASPECT-FIT into the area (scale =
 *    min(1, areaW/vw, areaH/vh)) and CENTERED, exactly like the proxy
 *    path's scaled iframe frame. The caller composes `scale` into the DPI
 *    zoom (browser_tab_set_zoom), so the PAGE still sees the full preset
 *    viewport — a 1280×800 preset in a 420px panel renders as a 420×262
 *    scaled-down VIEW of a real 1280×800 page, not a clamped 420px-wide
 *    layout. (The pre-R62 behavior clamped w/h to the area and lied with
 *    the preset readout — the defect the owner reported.)
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
  if (viewport === null) {
    return { x: area.left, y: area.top, w: areaW, h: areaH, scale: 1 };
  }
  const vw = dim(viewport.width);
  const vh = dim(viewport.height);
  // Aspect-fit: never ABOVE 1 (a preset smaller than the area renders 1:1,
  // centered — like the proxy frame); never so small the webview vanishes.
  const scale = Math.max(0.05, Math.min(1, areaW / vw, areaH / vh));
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));
  return {
    x: area.left + Math.max(0, (areaW - w) / 2),
    y: area.top + Math.max(0, (areaH - h) / 2),
    w,
    h,
    scale,
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
      className="px-1 rounded-full border text-center outline-none"
      style={{ width, height: 24, background: styles.card, borderColor: styles.border, color: styles.textSecondary }}
    />
  );
}

export function BrowserPanel({
  projectId,
  tab,
  hidden = false,
}: {
  projectId: string;
  tab: RightSidebarTab;
  /** ROUND-87 (R87, owner: "Make sure to properly embed the browser window
   * as a complete part of the application itself … If I click on the new
   * tab button, the whole browser window apparently disappears … the
   * browser itself apparently closes in the background … If I try to
   * switch the tabs, then the previous tab apparently gets somewhat
   * glitched out"): KEEP-ALIVE — the RightSidebar now keeps every browser
   * tab's panel MOUNTED (display:none when inactive) so the page never
   * reloads, the webview never re-creates, and tab switches are instant.
   * `hidden` folds into the webview-visibility math (the native webview
   * hides but STAYS ALIVE) and pauses the bounds sync (a display:none
   * rect is 0×0 — never write that to a live webview). */
  hidden?: boolean;
}) {
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
  //
  // ROUND-51 (R51-a): `nativeMode` is the EFFECTIVE mode — availability
  // minus a native failure already seen this mount (`nativeDisabled`). A
  // rejected native call flips the panel into the proxy path (see
  // nativeFail), so a broken webview backend degrades instead of dying.
  const nativeAvailable = isNativeBrowserAvailable();
  const [nativeDisabled, setNativeDisabled] = useState(false);
  const nativeMode = nativeAvailable && !nativeDisabled;
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
   * Natural mode (the webview fills the page area, no preset). R89-E4: this
   * now reads the STORE's per-tab `natural` flag (persisted, default FALSE
   * — the stored desktop 1440×900 preset applies on mount, exactly as the
   * owner directed: "keep the dimensions as I told you"). The pre-R89
   * panel-local `useState(true)` silently ignored the default preset —
   * the readout said 1440×900 while the page rendered at the panel's
   * natural size (the owner's "dimensions were not being applied"
   * verdict).
   *
   * ROUND-66 (A5 — the owner's "the agent changed the view… the improvements
   * were not applied, I had to manually change one number"): agent-side
   * viewport changes (browser_control set_viewport) bump agentViewportSeq,
   * and THIS effect clears the natural flag in response — the agent's
   * display-size change applies live, exactly like the owner manually
   * picking the preset.
   */
  const naturalSize = state?.natural ?? false;
  const setNaturalSize = useCallback(
    (value: boolean) => {
      useBrowserTabStore.getState().setNatural(tabId, value);
    },
    [tabId],
  );
  // R90-C1: the unmount latch — true while THIS panel is mounted. The
  // nativeCreate .then() reads it so a create that resolves AFTER the panel
  // unmounted (the owner's "the old browser window was floating in the new
  // chat" glitch) HIDES the webview instead of showing it: pre-R90 the
  // stale closure's hiddenRef (last-render value — false for an ACTIVE tab)
  // plus the detached placeholder's 0×0 rect (never "covered" by any overlay)
  // made isWebviewHiddenNow() false → nativeTabSetVisible(true) re-SHOWED a
  // webview over the new chat at its stale last bounds. The unmount cleanup's
  // hide had already fired — this show was the race's losing leg.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const agentViewportSeq = state?.agentViewportSeq ?? 0;
  const agentViewportSeqRef = useRef(agentViewportSeq);
  useEffect(() => {
    if (agentViewportSeq === agentViewportSeqRef.current) return;
    agentViewportSeqRef.current = agentViewportSeq;
    if (agentViewportSeq > 0) setNaturalSize(false);
  }, [agentViewportSeq, setNaturalSize]);

  /**
   * ROUND-67 (R67, E1): the agent-navigation driver. The store bumps
   * agentNavSeq on every browser-navigate SSE frame (navigate /
   * back / forward / reload from the browser_control tool — applied
   * server-side + announced instantly). THIS effect commands the native
   * webview the moment the frame lands: NAVIGATE when the webview is
   * alive, CREATE when it never existed (the owner's blank-panel bug: a
   * fresh agent tab whose webview was never created stayed empty until a
   * manual address-bar Enter — the poll's reconcile only ADOPTED the
   * URL). User navigations never bump agentNavSeq (navigateUrl drives the
   * webview itself); the 4s poll stays as the backfill.
   */
  const agentNavSeq = state?.agentNavSeq ?? 0;
  const agentNavSeqRef = useRef(agentNavSeq);
  useEffect(() => {
    if (agentNavSeq === agentNavSeqRef.current) return;
    agentNavSeqRef.current = agentNavSeq;
    if (agentNavSeq === 0 || currentUrl === null) return;
    if (lastCommandedUrlRef.current === currentUrl) return; // echo of our own command
    lastCommandedUrlRef.current = currentUrl;
    if (!nativeMode) return; // iframe path: the navSeq key remount handles it
    if (nativeReadyRef.current) {
      void nativeTabNavigate(tabId, currentUrl).catch(nativeWarn);
    } else {
      void nativeCreate(currentUrl).catch(nativeFail);
    }
    // Deps note: currentUrl/nativeCreate are read at frame time; the seq is
    // the trigger (the values above are the frame's own, captured at fire).
  }, [agentNavSeq]);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  /** Did the loaded document postMessage us? Error pages never do. */
  const locationSeenRef = useRef(false);
  /** Timestamps of recent dead-ticket recoveries (rolling cap, R48-d). */
  const recoveryLogRef = useRef<number[]>([]);

  /**
   * R58-b: true while the address input has focus. The draft-sync effect
   * below must NOT stomp the field mid-typing — currentUrl changes on every
   * 4s poll tick and every navigation event, and the pre-R58 effect reset
   * the draft to the live URL while the owner was still typing. (Ref, not
   * state: the guard is read inside effects/handlers and must never itself
   * trigger a re-render.)
   */
  const urlFocusedRef = useRef(false);
  /**
   * R58-b: the dims the native webview ACTUALLY renders at (after
   * computeNativeBounds clamping), or null until the first bounds sync.
   * Powers the honest viewport readout — a clamped preset is reported as
   * the clamped size, not the preset. State + change-detection ref pair:
   * syncBounds runs on a 500ms interval, so it must only re-render when the
   * rendered size actually moves.
   */
  const [nativeRendered, setNativeRendered] = useState<{ w: number; h: number } | null>(null);
  const nativeRenderedRef = useRef<{ w: number; h: number } | null>(null);
  /**
   * R62: the aspect-fit scale of the CURRENT bounds (1 in natural mode).
   * Mirrored into a ref so the interval-driven syncBounds always composes
   * the latest fit into the DPI zoom (the effect below re-triggers sync on
   * viewport changes; the interval keeps it glued regardless).
   */
  const fitScaleRef = useRef(1);
  /** R62: last composed zoom actually pushed to Rust (spam guard — the
   * 500ms safety net re-runs syncBounds forever). */
  const lastZoomRef = useRef<number | null>(null);

  const [draft, setDraft] = useState<string>(tab.browserUrl ?? "");
  const [availWidth, setAvailWidth] = useState(420);

  const currentUrl = state?.currentUrl ?? null;
  const navSeq = state?.navSeq ?? 0;

  // ── mount: initialize the slice + mint the ticket ──────────────────────
  useEffect(() => {
    ensureTab(tabId);
    // R67/E4: the mint carries the project id — the sidecar binds the
    // session's cookie PROFILE to the project (the R46 wire-up: logins stay
    // project-scoped, sessions of different projects never share a jar).
    void mint(tabId, projectId);
  }, [tabId, ensureTab, mint, projectId]);

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
   * R60: zoom is REAL now. The R50 approximation divided these dims by the
   * zoom factor to fake a DPI change ("zoom" in = smaller CSS viewport);
   * tauri 2.11 exposes `Webview::set_zoom` (WebView2 zoomFactor), so the
   * panel instead drives the Rust `browser_tab_set_zoom` command with the
   * store's zoom — media queries and rem layout re-evaluate exactly like a
   * browser's Ctrl+±, in natural AND preset mode. The webview renders the
   * preset's true CSS px; zoom is a DPI layer on top of that size, so the
   * effective viewport here is the plain rotated dims (NO division).
   */
  const effectiveViewport: { width: number; height: number } | null =
    !nativeMode || naturalSize ? null : { width: viewW, height: viewH };
  // Mirror into a ref so the interval/rAF callbacks (which must NOT depend on
  // these values for their identity) always read the latest dims.
  useEffect(() => {
    effectiveViewportRef.current = effectiveViewport;
  });

  // ── native: create/show the tab webview while the panel is mounted ──────
  //
  // Push the placeholder's bounds to Rust. Deps are only [tabId, nativeMode]
  // on purpose: the latest geometry (viewport preset/zoom/rotate/natural) is
  // read through effectiveViewportRef + the zoomRef below so this callback's
  // identity stays stable across viewport changes (the bounds EFFECT below
  // owns re-syncing on those changes — see its deps).
  //
  // R62: syncBounds ALSO composes the DPI zoom (fit scale × user zoom) —
  // that is what makes a preset render at TRUE CSS pixels inside a smaller
  // panel (the "dimensions must be respected" fix). The zoom persists on
  // the webview; re-applying per sync is idempotent and change-guarded.
  const syncBounds = useCallback(() => {
    if (!nativeMode || !nativeReadyRef.current) return;
    // R87: a hidden (keep-alive) panel has a 0×0 rect — never write those
    // bounds to the live webview; the ResizeObserver re-fires on reveal.
    if (hiddenRef.current) return;
    const el = placeholderRef.current;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    const b = computeNativeBounds(rect, effectiveViewportRef.current);
    void nativeTabSetBounds(tabId, b.x, b.y, b.w, b.h).catch(nativeWarn);
    // R62: the composed DPI zoom — fit scale × user zoom, clamped to the
    // Rust command's 0.1–5.0 window (a 3840px preset in a tiny panel at
    // 25% user zoom would ask for 0.03; the page then renders at a slightly
    // larger CSS viewport than requested — the honest floor).
    const composed = Math.min(5, Math.max(0.1, b.scale * zoomRef.current));
    if (lastZoomRef.current !== composed) {
      lastZoomRef.current = composed;
      void nativeTabSetZoom(tabId, composed).catch(nativeWarn);
    }
    fitScaleRef.current = b.scale;
    // R58-b/R62: remember what actually rendered — in natural mode the
    // readout reports the REAL area; in preset mode the readout reports
    // the preset (the page sees it) plus the fit percentage. Only on
    // change — this callback runs on a 500ms interval.
    const prev = nativeRenderedRef.current;
    if (prev === null || prev.w !== b.w || prev.h !== b.h) {
      nativeRenderedRef.current = { w: b.w, h: b.h };
      setNativeRendered({ w: b.w, h: b.h });
    }
  }, [tabId, nativeMode]);

  /** rAF-debounced sync — bursts of resize events collapse into one invoke. */
  const scheduleBoundsSync = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      syncBounds();
    });
  }, [syncBounds]);

  const zoomRef = useRef(zoom);
  // R87: the keep-alive hidden flag as a REF (syncBounds + the 500ms safety
  // interval read it without re-subscribing; the prop drives the reactive
  // webview-visibility effect directly).
  const hiddenRef = useRef(hidden);
  useEffect(() => {
    hiddenRef.current = hidden;
  }, [hidden]);
  useEffect(() => {
    zoomRef.current = zoom;
    // A user-zoom change must reach the webview immediately: reset the
    // spam guard AND push a bounds sync (syncBounds composes fit×zoom and
    // only invokes when the composed value actually changed).
    lastZoomRef.current = null;
    if (nativeMode && nativeReadyRef.current) scheduleBoundsSync();
  }, [zoom, nativeMode, scheduleBoundsSync]);

  /**
   * Create (idempotently) + show this tab's native webview at `url`. Shared
   * by the mount lifecycle (panel activation) and every navigation path.
   * R60/R62: also (re-)applies the store's zoom after creation — set_zoom
   * persists per webview so this is idempotent, but a re-created webview
   * (teardown + fresh create) starts at 1× and must be told the zoom (the
   * syncBounds compose takes over from the first sync — this is just the
   * creation-time seed, using the current zoom as a plain DPI factor).
   * R62: the show consults the overlay guard — a webview created while ANY
   * overlay (popover, menu, dialog) is open must NOT show itself over it
   * (isWebviewHiddenNow = the R60 tab-scoped popover guard OR the R62 global
   * overlay flag); the guard's subscription effect below owns the restore.
   */
  const nativeCreate = useCallback(
    (url: string): Promise<void> => {
      lastCommandedUrlRef.current = url;
      // R90-D1: the ALWAYS-VISIBLE CURSOR — the webview is created with the
      // hands boot as its initialization script, so every page paints the
      // agent's resting cursor from document creation (the owner: "the mouse
      // pointer should always be visible. It should not go away"). The
      // script is idempotent + CSP-tolerant; the agent-hands runtime adopts
      // the booted cursor via window.__acuteHandsRest.
      return nativeTabCreate(tabId, url, buildHandsBootScript())
        .then(() => {
          // R90-C1: the panel went away while the create was in flight
          // (project switch / sidebar close racing the agent's navigation
          // frame). Keep the webview ALIVE (the background-tab contract)
          // but HIDDEN — never float it over whatever replaced this panel.
          if (!mountedRef.current) {
            return nativeTabSetVisible(tabId, false).catch(() => {});
          }
          nativeReadyRef.current = true;
          scheduleBoundsSync();
          const factor = useBrowserTabStore.getState().tabs[tabId]?.viewport.zoom ?? 1;
          void nativeTabSetZoom(tabId, factor).catch(nativeWarn);
          // R87: a KEEP-ALIVE-hidden panel (an inactive browser tab) must
          // NOT show its webview at create time — it would float above the
          // active tab's content (OS-level webviews sit above all HTML).
          // The hidden-prop effect below owns its reveal on activation.
          if (hiddenRef.current || isWebviewHiddenNow(tabId, placeholderRef.current?.getBoundingClientRect() ?? null)) {
            // Created hidden (Rust builds webviews hidden until the first
            // bounds sync) — keep it that way; the guard subscription's
            // restore owns the first show.
            return Promise.resolve();
          }
          return nativeTabSetVisible(tabId, true);
        });
    },
    [tabId, scheduleBoundsSync],
  );

  const nativeFail = useCallback(
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      // ROUND-51 (R51-a): a native backend that REJECTS (WebView2 runtime
      // missing/broken, command failure) must not leave a dead panel. Flip
      // this panel into the proxy path for the rest of the mount — the
      // store still holds the URL, so the iframe renders it and browsing
      // continues — and say so in the error card. nativeDisabled never
      // resets this mount: retrying a broken webview backend automatically
      // would flip-flop the renderer under the user.
      setNativeDisabled(true);
      useBrowserTabStore
        .getState()
        .setError(tabId, `Native browser unavailable (${message}) — fell back to the proxied renderer.`);
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

  // ── native: the overlay-hide subscription (R62 → R89-E5 GEOMETRIC) ──
  // hide/show the webview whenever the overlay guard changes. The guard
  // (popover-webview-guard.ts) is store-backed: the sidebar's popover flow
  // flips `popoverTabId`, and the AppShell's DOM watcher records the open
  // overlays' RECTS. R89-E5 (the owner: "When I click on any kind of menu…
  // the browser shows 'paused'… it does not seem like the browser is part
  // of our application"): the webview hides only when an overlay actually
  // INTERSECTS this panel's page area — a menu opening in the top bar or
  // the left rail keeps the browser LIVE. This panel stays the single
  // visibility writer for ITS tab.
  const overlaySeq = useWebviewGuardStore((s) => s.overlaySeq);
  const popoverTabId = useWebviewGuardStore((s) => s.popoverTabId);
  const [overlayCoversPanel, setOverlayCoversPanel] = useState(false);
  useEffect(() => {
    const el = placeholderRef.current;
    setOverlayCoversPanel(el !== null && overlayCoversRect(el.getBoundingClientRect()));
  }, [overlaySeq]);
  const webviewHidden = overlayCoversPanel || popoverTabId === tabId || hidden;
  useEffect(() => {
    if (!nativeMode || !nativeReadyRef.current) return;
    void nativeTabSetVisible(tabId, !webviewHidden).catch(nativeWarn);
  }, [nativeMode, tabId, webviewHidden]);

  // ── R62 (D8): the agent-browser command handler for THIS tab ───────────
  // Registered while the panel is mounted in native mode (the only mode
  // with a live webview). eval → browser_tab_eval in this tab's page;
  // screenshot_meta → this panel's on-screen rectangle (logical rect ×
  // scale + window origin = PHYSICAL px region) for the computer-use
  // capture. Unregistered on unmount so a stale handler can never answer
  // for a hidden/closed webview.
  useEffect(() => {
    if (!nativeMode) return;
    return registerBrowserCommandHandler(tabId, async (action, payload) => {
      if (action === "eval") {
        const script = typeof payload.script === "string" ? payload.script : "";
        if (script === "") return { ok: false, error: "eval: empty script" };
        const result = await nativeTabEval(tabId, script);
        if (result === null) {
          return { ok: false, error: "eval unavailable — the native browser bridge is not present" };
        }
        // data IS the Rust command's {ok, value|error} envelope — the tool
        // reads data.ok/data.value directly.
        return { ok: true, data: result };
      }
      // ── R89-E: the AGENT-HANDS job protocol ─────────────────────────────
      // The hands script installs the cursor runtime, starts the async job
      // (window.__acuteJob — the human-paced animation runs in the page
      // BEYOND the Rust eval's 3s callback budget), and returns
      // {started:true} at once. THIS handler then polls the job's state
      // every 120ms and answers with the final result — each poll is its
      // own short eval, so no Rust changes were needed.
      if (action === "evalJob") {
        const script = typeof payload.script === "string" ? payload.script : "";
        if (script === "") return { ok: false, error: "evalJob: empty script" };
        const start = await nativeTabEval(tabId, script);
        if (start === null) {
          return { ok: false, error: "evalJob unavailable — the native browser bridge is not present" };
        }
        if (!start.ok) {
          return { ok: false, error: start.error ?? "the page rejected the hands script" };
        }
        const started = (start.value ?? {}) as { started?: unknown; error?: unknown };
        if (typeof started.error === "string" && started.error !== "") {
          return { ok: false, error: started.error };
        }
        if (started.started !== true) {
          return { ok: false, error: "evalJob: unexpected start payload (no job started)" };
        }
        const POLL_MS = 120;
        // R90-D1: 60s — the human-paced jobs grew (tap → ~1s → typing at
        // ~150 WPM → ~1s → Enter; a full 600-char type is ~48s of typing
        // alone). The agent-core sidecar's outer round-trip budget is 75s.
        const JOB_BUDGET_MS = 60_000;
        const deadline = Date.now() + JOB_BUDGET_MS;
        for (;;) {
          await new Promise((r) => setTimeout(r, POLL_MS));
          const poll = await nativeTabEval(
            tabId,
            "return window.__acuteJob ? {done: window.__acuteJob.done, error: (window.__acuteJob.error || null), result: (window.__acuteJob.result === undefined ? null : window.__acuteJob.result)} : {done: true, error: 'the job vanished (the page navigated away)'};",
          );
          if (poll === null) {
            return { ok: false, error: "evalJob poll unavailable — the native browser bridge is not present" };
          }
          if (!poll.ok) {
            return { ok: false, error: poll.error ?? "the job state poll failed" };
          }
          const state = (poll.value ?? {}) as { done?: unknown; error?: unknown; result?: unknown };
          if (typeof state.error === "string" && state.error !== "") {
            return { ok: false, error: `the page job failed: ${state.error}` };
          }
          if (state.done === true) {
            return { ok: true, data: { ok: true, value: state.result ?? null } };
          }
          if (Date.now() > deadline) {
            return { ok: false, error: "the page job timed out (60s — the page may be wedged)" };
          }
        }
      }
      if (action === "screenshot_meta") {
        const el = placeholderRef.current;
        if (el === null) return { ok: false, error: "screenshot_meta: the panel area is not measurable right now" };
        const rect = el.getBoundingClientRect();
        const metrics = await nativeWindowMetrics();
        if (metrics === null) {
          // No window API — still answer supported with no region; the
          // tool falls back to a full-display capture.
          return { ok: true, data: { supported: true, region: null, mode: "native" } };
        }
        const region = {
          x: Math.round(metrics.x + rect.left * metrics.scaleFactor),
          y: Math.round(metrics.y + rect.top * metrics.scaleFactor),
          w: Math.max(1, Math.round(rect.width * metrics.scaleFactor)),
          h: Math.max(1, Math.round(rect.height * metrics.scaleFactor)),
        };
        return { ok: true, data: { supported: true, region, scaleFactor: metrics.scaleFactor, mode: "native" } };
      }
      return { ok: false, error: `unknown browser command '${action}'` };
    });
  }, [nativeMode, tabId]);

  // ── native: keep the webview glued to the placeholder ───────────────────
  useEffect(() => {
    if (!nativeMode) return;
    // Initial sync + re-sync whenever the effective viewport (preset /
    // rotate / natural toggle) or the active tab changes — R60: zoom is no
    // longer part of this set (it is a DPI layer, not a size change).
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
  }, [nativeMode, scheduleBoundsSync, tabId, viewW, viewH, rotate, naturalSize]);

  // ── R91-B3: the VISIBILITY WATCHDOG ───────────────────────────────────────
  // The v0.88.0 field report: the agent's browser actions executed (the
  // webview was alive — evals answered) but the page area showed NOTHING.
  // Whatever the exact race — a show that never landed, a bounds sync lost
  // to a state churn, a create swallowed mid-transition — the panel had NO
  // self-healing layer: once the show was missed, nothing ever retried it.
  // This watchdog closes the class: every 2s, for the ACTIVE, unguarded
  // tab, it (1) verifies the webview still EXISTS (recreating it at the
  // live URL when it vanished) and (2) re-asserts show + bounds. An invoke
  // that never settles (a wedged shell) is caught by the timeout and
  // surfaces the honest error card instead of a silent nothing. The R91-B1
  // Rust fix (async menu-overlay commands) removes the deadlock class that
  // could wedge the shell in the first place; this is the belt to that
  // suspenders — a missed show can never persist past one period.
  //
  // R92-A (Part 5 — watchdog self-heal): BEFORE the geometric skip, force a
  // FRESH guard evaluation (refreshOverlayRectsNow) and re-read the rects.
  // The recorded rects only refresh on structural DOM mutations (plus the
  // guard's own 600ms periodic re-check), so a STALE covering rect — an
  // overlay that moved or shrank without DOM churn — used to pin this
  // watchdog off forever; now the skip decision is always based on rects
  // measured THIS instant, and the moment nothing truly covers the panel
  // the watchdog resumes its show + bounds re-assert.
  useEffect(() => {
    if (!nativeMode) return;
    let stopped = false;
    const tick = (): void => {
      if (stopped) return;
      // The panel's own states first: an inactive (keep-alive hidden) tab
      // and a guard-suppressed tab legitimately want the webview HIDDEN —
      // re-asserting here would fight the panel's own lifecycle.
      if (hiddenRef.current || !nativeReadyRef.current) return;
      if (useWebviewGuardStore.getState().popoverTabId === tabId) return;
      // R92-A: fresh guard evaluation BEFORE the geometric skip — see the
      // watchdog's header comment above. Sync by design; cheap (one DOM
      // sweep) at the 2s cadence.
      refreshOverlayRectsNow();
      const el = placeholderRef.current;
      if (el !== null && overlayCoversRect(el.getBoundingClientRect())) return;
      const live = useBrowserTabStore.getState().tabs[tabId];
      const url = live?.currentUrl ?? null;
      void nativeTabExists(tabId)
        .then((exists) => {
          if (stopped) return;
          if (!exists) {
            // The webview never came to exist (or died): create it at the
            // live URL — the same idempotent path a navigation takes. A
            // missing URL means there is nothing to show yet (fresh tab —
            // the first navigation creates it, by design).
            if (url !== null) {
              nativeReadyRef.current = false;
              void nativeCreate(url).catch(nativeFail);
            }
            return;
          }
          // Exists: re-assert the show + bounds (idempotent, and the Rust
          // side re-applies the remembered bounds with every show — R91-B2).
          void withTimeout(nativeTabSetVisible(tabId, true), NATIVE_AFFORDANCE_TIMEOUT_MS, "showing the browser").catch(
            (err: unknown) => {
              useBrowserTabStore
                .getState()
                .setError(
                  tabId,
                  `The embedded browser stopped answering (${err instanceof Error ? err.message : String(err)}). The page session is preserved — try pop-out or reopen the tab.`,
                );
            },
          );
          syncBounds();
        })
        .catch(() => {
          /* nativeTabExists never throws — outside Tauri it is false */
        });
    };
    const interval = window.setInterval(tick, NATIVE_WATCHDOG_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
    // nativeCreate/syncBounds/nativeFail identities are stable per tab; the
    // watchdog reads the live guard + store state at tick time on purpose.
  }, [nativeMode, tabId, nativeCreate, syncBounds, nativeFail]);

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

  // Address bar follows the live URL (agent navigations included) — but
  // NEVER while the user is typing (R58-b): the 4s poll + navigation events
  // used to reset the field mid-edit. On blur the draft falls back to the
  // live URL (an un-focused field must never show stale typing — same as a
  // real browser's address bar).
  useEffect(() => {
    if (!urlFocusedRef.current && currentUrl !== null) setDraft(currentUrl);
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
          // R67/E1 backstop: UNKNOWN commanded URL with NO webview yet —
          // the tab was auto-opened blank and the agent navigated while the
          // panel was unmounted (or the instant frame was missed). The old
          // code ADOPTED the URL here without ever creating the webview —
          // THE blank-panel bug (the owner had to press Enter in the
          // address bar to make the page appear). CREATE it now instead.
          if (!nativeReadyRef.current) {
            lastCommandedUrlRef.current = serverUrl;
            void nativeCreate(serverUrl).catch(nativeFail);
            return;
          }
          // Webview alive + unknown commanded URL (back/forward walked the
          // webview's own history) — adopt the server URL WITHOUT
          // re-navigating; the webview already moved.
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
    if (isTauri()) {
      // R58-b: inside the Tauri shell, window.open is silently swallowed by
      // WebView2/wry — hand the URL to the OS default browser on the Rust
      // side (tauri-plugin-shell's OS-level open).
      // R91-B3: the timeout — a wedged shell never settles the invoke, and
      // the silence read as "the button does nothing" (the owner's v0.88.0
      // report). Now it becomes the honest error card.
      void withTimeout(openExternalUrl(url), NATIVE_AFFORDANCE_TIMEOUT_MS, "opening the page in your system browser").catch(
        (err) => {
          const message = err instanceof Error ? err.message : String(err);
          useBrowserTabStore
            .getState()
            .setError(tabId, `Opening the page in your system browser failed (${message}). Retrying with a plain webview tab.`);
          // Fallback: the Rust handoff failed — let the webview itself try.
          window.open(url, "_blank", "noopener,noreferrer");
        },
      );
      return;
    }
    // Web mode: the ONLY unconditional window.open in the panel — an
    // explicit, labeled action.
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const onPopOut = async () => {
    const invoke = nativeInvoke();
    const url = currentUrl;
    if (invoke === null || url === null) return;
    try {
      // R91-B3: the timeout — a window creation that never lands leaves the
      // user clicking a dead button ("not working at all", the v0.88.0
      // report). A wedged shell now answers with the honest error card; a
      // REJECTED command always did.
      await withTimeout(
        Promise.resolve(invoke("open_browser_window", { url })),
        NATIVE_AFFORDANCE_TIMEOUT_MS,
        "opening the pop-out window",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      useBrowserTabStore
        .getState()
        .setError(tabId, `Opening the pop-out browser window failed (${msg}). The page stays open in this panel.`);
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
  /**
   * R62: honest native readout, post aspect-fit. A preset's PAGE now sees
   * the full preset CSS px (the fit scale rides the DPI zoom), so the
   * readout reports the REQUESTED dims + zoom, plus the fit percentage when
   * the visible footprint is scaled down (the native twin of the proxy
   * path's "fit" note). Natural mode reports the ACTUAL rendered area (what
   * the page really sees). The proxy path is unchanged: its iframe renders
   * the true preset px (the transform only scales the footprint).
   */
  const nativeFit = naturalSize ? 1 : fitScaleRef.current;
  const readout = nativeMode
    ? naturalSize
      ? nativeRendered !== null
        ? `${Math.round(nativeRendered.w)}×${Math.round(nativeRendered.h)} @ ${Math.round(zoom * 100)}%`
        : `Natural @ ${Math.round(zoom * 100)}%`
      : `${viewW}×${viewH} @ ${Math.round(zoom * 100)}%` +
        (nativeFit < 0.999 ? ` · fits ${Math.round(nativeFit * 100)}%` : "")
    : `${viewW}×${viewH} @ ${Math.round(zoom * 100)}%` +
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
    <div
      className="h-full flex flex-col min-h-0 gap-1.5 p-1.5"
      data-testid="browser-panel"
      style={{ background: styles.isDark ? "rgba(0,0,0,0.10)" : styles.subtle }}
    >
      {/* ── Chrome bar: navigation + address + explicit external actions.
          R60-D: the R59 rounded-card language — each panel row is a rounded
          card on the panel's ambient strip (the pop-out window's exact
          rhythm, at side-panel scale). ── */}
      <div
        className="shrink-0 flex items-center gap-1 px-2 h-9 rounded-[12px] border"
        style={{ borderColor: styles.border, background: styles.isDark ? "rgba(0,0,0,0.15)" : styles.card }}
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
              onFocus={(e) => {
                urlFocusedRef.current = true;
                e.target.select();
              }}
              onBlur={() => {
                urlFocusedRef.current = false;
                // R58-b: a blurred field shows the live URL, never stale
                // typing (the focus-guard suppressed the sync above).
                if (currentUrl !== null) setDraft(currentUrl);
              }}
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
            title="Pop out to the native Acute browser window (shared profile — same browser profile as the embedded browser)"
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

      {/* ── Viewport bar: the display-size controls (R43-10 core feature).
          R60-D restructure (owner: "layout management does not work
          properly… could be made cleaner"): the row is now a rounded card
          with TWO visible groups — [size: preset | W×H | zoom] and
          [view: rotate | fit] — separated by a hairline divider, and it
          WRAPS (flex-wrap + min-height instead of a fixed h-8) so a
          ~380px-wide sidebar never clips or overflows the controls; the
          readout rides at the row's end. The FIT button is honestly
          DISABLED in native mode: computeNativeBounds already clamps every
          preset to the panel, so there is nothing to scale down — the
          title says so instead of a dead click. ── */}
      <div
        data-testid="browser-viewport-bar"
        className="shrink-0 flex min-h-8 flex-wrap items-center gap-x-1.5 gap-y-1 px-2 py-1 rounded-[12px] border text-[10.5px]"
        style={{ borderColor: styles.border, color: styles.textTertiary, background: styles.isDark ? "rgba(0,0,0,0.08)" : "transparent" }}
      >
        {/* Group 1 — size: preset, W×H, zoom. */}
        <span className="flex min-w-0 items-center gap-1">
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
            className="h-6 min-w-0 max-w-[118px] rounded-full border px-2 outline-none cursor-pointer"
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
          {/* R60: REAL DPI zoom in native mode (Rust browser_tab_set_zoom);
              the proxy path keeps its iframe transform scale. */}
          <select
            value={String(Math.round(zoom * 100))}
            onChange={(e) => void setViewport(tabId, { zoom: Number(e.target.value) / 100 })}
            aria-label="Zoom"
            data-testid="browser-zoom-select"
            className="h-6 rounded-full border px-2 outline-none cursor-pointer"
            style={{ background: styles.card, borderColor: styles.border, color: styles.textSecondary }}
          >
            {ZOOM_STEPS.map((z) => (
              <option key={z} value={String(Math.round(z * 100))}>
                {Math.round(z * 100)}%
              </option>
            ))}
          </select>
        </span>
        {/* Hairline separator between the size and view groups. */}
        <span aria-hidden className="h-4 w-px shrink-0" style={{ background: styles.border }} />
        {/* Group 2 — view: rotate, fit. */}
        <span className="flex items-center gap-0.5">
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
            disabled={nativeMode}
            aria-pressed={fit}
            aria-label="Fit to panel"
            title={
              nativeMode
                ? "Native mode: presets render at true size, automatically scaled to fit the panel — the page always sees the dimensions you set"
                : fit
                  ? "Fit: scaled down to the panel width (true px preserved)"
                  : "1:1 — scroll the panel instead"
            }
            data-testid="browser-fit"
            className="w-6 h-6 grid place-items-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-30"
            style={{ color: fit && !nativeMode ? styles.accent : styles.textTertiary }}
            onMouseEnter={(e) => { if (!nativeMode) e.currentTarget.style.background = styles.subtleHover; }}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            {fit ? <Shrink size={12} /> : <Expand size={12} />}
          </button>
        </span>
        <span
          className="ml-auto shrink-0 font-mono text-[10px] px-1.5 py-0.5 rounded-full"
          data-testid="browser-readout"
          style={{ background: styles.subtle, color: styles.textTertiary }}
          title={
            nativeMode
              ? `Native mode: the page sees the preset's true CSS pixels — larger presets are scaled down to fit (the fit % is shown); the page always sees the dimensions you set`
              : `True viewport ${viewW}×${viewH}px — the page sees these CSS pixels`
          }
        >
          {readout}
        </span>
      </div>

      {/* ── Panel-level error (session mint / navigation failures) — a
          rounded card in the same row rhythm (R60-D). ── */}
      {state?.error != null ? (
        <div
          className="shrink-0 flex items-start gap-2 px-3 py-2 text-[11px] rounded-[12px] border"
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

      {/* ── Content: empty state or the scaled viewport frame. R60-D: the
          R59 rounded CONTENT CARD — the card's border + rounded corners read
          as the page's frame; in native mode the placeholder (the webview's
          rect) is inset 4px so the webview's square OS-level corners stay
          inside the card's 12px corner curve and the card's background shows
          through as the frame around the page (the pop-out's exact pattern).
          The proxy path's geometry below is EXACTLY as before. ── */}
      <div
        ref={contentRef}
        className="relative flex-1 min-h-0 overflow-auto rounded-[12px] border"
        style={{ background: styles.isDark ? "rgba(0,0,0,0.22)" : styles.subtle, borderColor: styles.border }}
      >
        {nativeMode ? (
          /* ROUND-50 (R50-a): the page area placeholder. The native child
             webview is NOT a DOM child — it is an OS-level child of the
             window floating ABOVE the web UI, positioned over this div by
             the bounds sync above. It renders the page (full CSS/JS); this
             div only marks the rectangle + hosts the empty state.
             ROUND-87 (R87): while a POPOVER hides the webview (the quick
             menu / overlay guard), a dimmed hint makes the pause read as
             DELIBERATE rather than the page vanishing.
             R92-A (owner: the browser "would apparently get cleared out and
             would disappear"): the caption now renders on BOTH hide legs —
             the popoverTabId fallback AND the GEOMETRIC overlay leg
             (overlayCoversPanel) — so any residual webview hide reads as a
             deliberate pause, NEVER a blank cleared-out card. The keep-alive
             `hidden` leg (an inactive background tab) stays captionless: no
             menu is open there, the panel itself is not the active surface. */
          <div
            ref={placeholderRef}
            data-testid="browser-native-placeholder"
            className="absolute inset-[4px] rounded-[12px]"
          >
            {!hasPage ? (
              emptyState
            ) : popoverTabId === tabId || overlayCoversPanel ? (
              <div
                className="absolute inset-0 grid place-items-center rounded-[12px]"
                style={{
                  background: styles.isDark ? "rgba(0,0,0,0.45)" : "rgba(0,0,0,0.25)",
                  backdropFilter: "blur(2px)",
                }}
                aria-hidden
              >
                <span
                  className="text-[11px] font-bold tracking-widest uppercase"
                  style={{ color: "rgba(255,255,255,0.75)" }}
                >
                  browser paused while the menu is open
                </span>
              </div>
            ) : null}
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
                borderRadius: 8,
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

    </div>
  );
}
