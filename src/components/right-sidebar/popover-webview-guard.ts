/**
 * R60-D — the popover-over-webview suppression guard.
 * R62 (D9) — generalized into the WEBVIEW OVERLAY GUARD.
 * R89 (R89-E5) — the guard became GEOMETRIC.
 *
 * The RightSidebar's QuickMenu / SubAgentPicker popovers are portaled to
 * document.body with position:fixed — in WEB mode that is enough to render
 * above the panel. In TAURI mode the browser panel's page renderer is a
 * NATIVE CHILD WEBVIEW: an OS-level layer that floats above ALL app HTML,
 * so any app overlay that opens over the page area (popovers, dropdown
 * menus, dialogs, selects, the command palette) renders BEHIND the webview.
 *
 * The R62 answer hid EVERY webview while ANY overlay was open — the owner's
 * R89 verdict: "When I click on any kind of menu… the browser shows
 * 'paused' while the menu is open… it does not seem like the browser is
 * part of our application." The R89 answer keeps the browser LIVE unless
 * the open overlay GEOMETRICALLY INTERSECTS the panel's page area: the
 * watcher now records each overlay's viewport rect, and the BrowserPanel
 * hides its webview only when one actually covers it (a menu opening in
 * the top bar or the left rail never pauses the browser again).
 *
 * Architecture (the R60 popover part unchanged):
 *  · `setPopoverWebviewSuppression(tabId|null)` — the sidebar's tab-scoped
 *    popover flow (the popover covers the ACTIVE browser tab's area).
 *  · `installOverlayWebviewWatcher()` — a MutationObserver over
 *    document.body (installed once by the AppShell) that records the open
 *    overlays' RECTS (plus a bump counter) while any is present. Tooltips
 *    are excluded (tiny, transient).
 *  · The BrowserPanel subscribes to the bump counter and re-evaluates
 *    `overlayCoversRect(placeholder.getBoundingClientRect())`; the
 *    `nativeCreate` path consults the same geometry at show-time.
 *
 * ROUND-92 (R92-A, the owner: "tapping the model / plan / full access / ask
 * options made the right-side browser get cleared out… I still don't feel
 * like the browser is an embedded part of the application") hardened the
 * watcher three ways:
 *  · PURE BACKDROPS are exempt — elements marked `[data-webview-backdrop]`
 *    (the ModelSelector scrim, the Radix dialog overlay, the mobile drawer
 *    scrim) are translucent DIM layers that render BELOW the OS webview, so
 *    they can never visually cover the browser; recording their full-viewport
 *    rect blanked the browser for a dim the user never sees on it. Content
 *    panels (role=dialog boxes, menus) are NEVER tagged — DOM genuinely
 *    cannot paint above the webview, so those must still hide it when they
 *    geometrically cover it.
 *  · UNMEASURABLE (0×0) overlays are SKIPPED, not recorded as the full
 *    viewport (the old conservative fallback blanked the browser on a test
 *    DOM without layout AND on mid-animation portals); a rAF follow-up pass
 *    re-measures once laid out.
 *  · While any rect is recorded, a low-frequency (600ms) re-check keeps the
 *    rects fresh even with ZERO structural mutations — a stale covering
 *    rect (an overlay that moved/shrank without DOM churn) can no longer pin
 *    the browser hidden forever.
 *
 * Backed by a zustand store (the panel must REACT to overlay changes).
 * Nothing here persists — a transient UI overlay must never survive a
 * reload.
 */
import { create } from "zustand";

/** One open overlay's viewport rect (CSS px). */
export interface OverlayRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface WebviewGuardState {
  /** R89-E5: the open overlays' rects (empty when none). */
  overlayRects: OverlayRect[];
  /** Bumped whenever overlayRects changes — the panel's re-eval trigger. */
  overlaySeq: number;
  /** R60-D: the tab id whose webview is hidden under the sidebar popover. */
  popoverTabId: string | null;
  setOverlayRects: (rects: OverlayRect[]) => void;
  setPopoverTabId: (tabId: string | null) => void;
}

/** R92-A: shallow rect-list equality (order-sensitive — querySelectorAll
 * order is stable, so this is exact for our use). */
function sameRects(a: OverlayRect[], b: OverlayRect[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].left !== b[i].left || a[i].top !== b[i].top || a[i].right !== b[i].right || a[i].bottom !== b[i].bottom) {
      return false;
    }
  }
  return true;
}

export const useWebviewGuardStore = create<WebviewGuardState>()((set) => ({
  overlayRects: [],
  overlaySeq: 0,
  popoverTabId: null,
  // R92-A: an identical rect list does NOT bump the seq — the periodic
  // 600ms re-check would otherwise re-render every panel subscriber twice a
  // second for as long as any overlay stays open (the rects usually haven't
  // moved; a real change still bumps as before).
  setOverlayRects: (overlayRects) =>
    set((s) =>
      sameRects(s.overlayRects, overlayRects)
        ? {}
        : { overlayRects, overlaySeq: s.overlaySeq + 1 },
    ),
  setPopoverTabId: (popoverTabId) => set({ popoverTabId }),
}));

/**
 * Record which tab's webview must stay hidden (an open sidebar popover
 * covers it), or null when no popover is suppressing anything.
 */
export function setPopoverWebviewSuppression(tabId: string | null): void {
  useWebviewGuardStore.getState().setPopoverTabId(tabId);
}

/** Whether `tabId`'s webview must be hidden right now (popover guard). */
export function isPopoverWebviewSuppressed(tabId: string): boolean {
  return useWebviewGuardStore.getState().popoverTabId === tabId;
}

/** R89-E5: does any open overlay rect INTERSECT the given viewport rect? */
export function overlayCoversRect(rect: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}): boolean {
  const rects = useWebviewGuardStore.getState().overlayRects;
  for (const o of rects) {
    if (rect.left < o.right && o.left < rect.right && rect.top < o.bottom && o.top < rect.bottom) {
      return true;
    }
  }
  return false;
}

/**
 * Whether `tabId`'s webview must be hidden right now for EITHER reason —
 * the tab-scoped popover guard or a covering overlay. R89-E5: pass the
 * panel area's rect for the GEOMETRIC overlay test; without one, ANY open
 * overlay hides (the conservative default for call sites without geometry,
 * e.g. the create-while-overlay-open race).
 */
export function isWebviewHiddenNow(
  tabId: string,
  area?: { left: number; top: number; right: number; bottom: number } | null,
): boolean {
  if (useWebviewGuardStore.getState().popoverTabId === tabId) return true;
  if (area === undefined || area === null) {
    return useWebviewGuardStore.getState().overlayRects.length > 0;
  }
  return overlayCoversRect(area);
}

// ── R62-D9 → R89-E5: the DOM overlay watcher ────────────────────────────────

/** What counts as an overlay: Radix/shadcn portals + explicit markers.
 * (role="listbox" rides inside a popper wrapper for Select; tooltips are
 * filtered out below — they are too transient to blank the page for.
 * R89-E5 adds the full-screen dialog SCRIMS — `.fixed.inset-0` — because a
 * modal's dim layer genuinely covers the whole viewport.) */
const OVERLAY_SELECTOR =
  '[role="menu"], [role="dialog"], [data-radix-popper-content-wrapper], [data-overlay], .fixed.inset-0';

/** The result of one DOM sweep: the measured rects + whether any matching
 * overlay had to be SKIPPED as unmeasurable (drives the R92-A rAF retry). */
interface OverlaySweep {
  rects: OverlayRect[];
  sawUnmeasured: boolean;
}

/** The rects of every non-tooltip, non-backdrop overlay present in the DOM
 * right now.
 * R92-A: an overlay that cannot be MEASURED (zero rect — detached, a test
 * DOM without layout, or a portal caught mid-animation before its first
 * layout) is SKIPPED and flagged for a rAF re-check — the old conservative
 * "record the full viewport" fallback is what blanked the owner's browser
 * behind the ModelSelector scrim chain. */
function overlayRectsPresent(): OverlaySweep {
  const nodes = document.querySelectorAll(OVERLAY_SELECTOR);
  const rects: OverlayRect[] = [];
  let sawUnmeasured = false;
  for (const el of nodes) {
    if (el.closest('[role="tooltip"]') !== null) continue;
    // R92-A: pure backdrops render BELOW the OS webview — they can never
    // visually cover the browser, so they never count as covering overlays
    // (see the module header). Content panels are deliberately NOT tagged.
    if (el.closest("[data-webview-backdrop]") !== null) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      rects.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    } else {
      sawUnmeasured = true;
    }
  }
  return { rects, sawUnmeasured };
}

let watcherInstalled = false;
/** Debounce handle — streaming DOM churn must not spin the check. */
let watcherTimer: number | null = null;
/** The installed observer (module-scoped so the test reset disconnects it). */
let watcherObserver: MutationObserver | null = null;
/** R92-A: consecutive rAF follow-ups already spent on the current
 * unmeasurable episode (reset the moment a sweep finds none). THREE frames
 * covers the caught-mid-mount case without spinning at 60fps forever on a
 * permanently 0×0 matching element — past that the 600ms periodic sweep
 * below owns the re-measure at a gentle pace. */
let unmeasuredRetryCount = 0;
/** R92-A: pending rAF handle for the unmeasurable-overlay follow-up pass. */
let unmeasuredRetryHandle: number | null = null;
/** R92-A: the periodic re-check handle — set ONLY while something is open
 * (rects recorded OR an unmeasurable matching element exists). */
let periodicRefreshHandle: number | null = null;
/** R92-A: how often the recorded rects are re-measured while any is open
 * (ms). 600ms is far below human perception for a menu's own lifetime, and
 * the sameRects no-bump in the store makes an unchanged sweep free. */
const OVERLAY_RECT_REFRESH_MS = 600;

/** R92-A: the ONE recording path — a fresh DOM sweep written into the
 * store, plus the two self-healing follow-ups (a short rAF retry burst for
 * a skipped unmeasurable overlay; the 600ms periodic re-check while
 * anything is open). Every trigger (the debounced observer, the rAF retry,
 * the periodic timer, refreshOverlayRectsNow) funnels through here so they
 * can never disagree about the recorded state. */
function runOverlaySync(): void {
  // CI-stability guard (the e9848a6 flake): a pending timer can fire AFTER
  // a test file's environment tore down — `document` is gone by then. In
  // the real app document always exists; inert there.
  if (typeof document === "undefined") return;
  const { rects, sawUnmeasured } = overlayRectsPresent();
  useWebviewGuardStore.getState().setOverlayRects(rects);
  if (!sawUnmeasured) {
    unmeasuredRetryCount = 0;
  } else if (unmeasuredRetryCount < 3 && unmeasuredRetryHandle === null && typeof window !== "undefined") {
    // A matching overlay exists but has no layout yet (a portal caught
    // mid-mount, or a CSS animation's first frame) — re-measure after the
    // next frame instead of guessing the full viewport at it.
    unmeasuredRetryCount += 1;
    unmeasuredRetryHandle = window.requestAnimationFrame(() => {
      unmeasuredRetryHandle = null;
      runOverlaySync();
    });
  }
  // While anything is open — rects recorded, or a skipped unmeasurable
  // overlay waiting for layout — keep sweeping at a low frequency so the
  // state self-heals even with ZERO structural mutations: a stale covering
  // rect used to pin the browser hidden forever (the R91 watchdog
  // deliberately skips while covered, so it could never heal this either).
  // Stop the timer once nothing is open.
  if (rects.length > 0 || sawUnmeasured) {
    if (periodicRefreshHandle === null && typeof window !== "undefined") {
      periodicRefreshHandle = window.setInterval(() => runOverlaySync(), OVERLAY_RECT_REFRESH_MS);
    }
  } else if (periodicRefreshHandle !== null) {
    window.clearInterval(periodicRefreshHandle);
    periodicRefreshHandle = null;
  }
}

/**
 * R92-A: force a fresh overlay evaluation RIGHT NOW (a fresh DOM sweep +
 * store write + the self-healing follow-ups). The BrowserPanel's watchdog
 * calls this before its "an overlay covers the panel" skip decision, so a
 * STALE covering rect can never suppress it — the skip must be based on
 * rects measured this instant, not on whatever the observer last saw.
 * Sync by design (getBoundingClientRect is sync); inert without a DOM.
 */
export function refreshOverlayRectsNow(): void {
  runOverlaySync();
}

/**
 * Install the overlay watcher (ONCE per app — the AppShell calls this on
 * mount). A MutationObserver over document.body re-records the overlay
 * rects only when nodes are ADDED/REMOVED (attribute-only mutations can
 * never open or close a portal) and debounced 80ms so bursts (chat
 * streaming, list updates) collapse into one check. Happy-dom safe:
 * MutationObserver exists there too, and the store flip is a no-op for web
 * mode (panels only act on it in native mode).
 */
export function installOverlayWebviewWatcher(): void {
  if (watcherInstalled || typeof document === "undefined") return;
  watcherInstalled = true;
  const check = () => {
    watcherTimer = null;
    runOverlaySync();
  };
  const observer = new MutationObserver((mutations) => {
    let structural = false;
    for (const m of mutations) {
      if (m.addedNodes.length > 0 || m.removedNodes.length > 0) {
        structural = true;
        break;
      }
    }
    if (!structural) return;
    if (watcherTimer !== null) return;
    watcherTimer = window.setTimeout(check, 80);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  watcherObserver = observer;
  // Baseline state (an overlay could already be open at install time).
  runOverlaySync();
}

/** Test hook: reset the module-level install guard between suites. R92-A:
 * also clears the rAF retry + the periodic re-check handles the hardened
 * watcher now owns, so no timer outlives its suite. */
export function resetOverlayWatcherForTests(): void {
  watcherInstalled = false;
  watcherObserver?.disconnect();
  watcherObserver = null;
  if (watcherTimer !== null && typeof window !== "undefined") {
    window.clearTimeout(watcherTimer);
  }
  watcherTimer = null;
  if (unmeasuredRetryHandle !== null && typeof window !== "undefined") {
    window.cancelAnimationFrame(unmeasuredRetryHandle);
  }
  unmeasuredRetryHandle = null;
  if (periodicRefreshHandle !== null && typeof window !== "undefined") {
    window.clearInterval(periodicRefreshHandle);
  }
  periodicRefreshHandle = null;
  useWebviewGuardStore.setState({ overlayRects: [], overlaySeq: 0, popoverTabId: null });
}
