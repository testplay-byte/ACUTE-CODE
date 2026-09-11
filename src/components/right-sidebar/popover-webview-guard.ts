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

export const useWebviewGuardStore = create<WebviewGuardState>()((set) => ({
  overlayRects: [],
  overlaySeq: 0,
  popoverTabId: null,
  setOverlayRects: (overlayRects) =>
    set((s) => ({ overlayRects, overlaySeq: s.overlaySeq + 1 })),
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

/** The rects of every non-tooltip overlay present in the DOM right now.
 * An overlay that cannot be MEASURED (zero rect — detached, or a test DOM
 * without layout) is recorded as the FULL viewport: conservatively
 * covering, exactly the pre-R89 behavior for the unmeasurable case. */
function overlayRectsPresent(): OverlayRect[] {
  const nodes = document.querySelectorAll(OVERLAY_SELECTOR);
  const rects: OverlayRect[] = [];
  for (const el of nodes) {
    if (el.closest('[role="tooltip"]') !== null) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      rects.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    } else {
      const w = typeof window === "undefined" ? 0 : window.innerWidth || 1280;
      const h = typeof window === "undefined" ? 0 : window.innerHeight || 800;
      rects.push({ left: 0, top: 0, right: w, bottom: h });
    }
  }
  return rects;
}

let watcherInstalled = false;
/** Debounce handle — streaming DOM churn must not spin the check. */
let watcherTimer: number | null = null;
/** The installed observer (module-scoped so the test reset disconnects it). */
let watcherObserver: MutationObserver | null = null;

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
    // CI-stability guard (the e9848a6 flake): a pending 80ms debounce can
    // fire AFTER a test file's environment tore down — `document` is gone
    // by then. In the real app document always exists; inert there.
    if (typeof document === "undefined") return;
    useWebviewGuardStore.getState().setOverlayRects(overlayRectsPresent());
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
  useWebviewGuardStore.getState().setOverlayRects(overlayRectsPresent());
}

/** Test hook: reset the module-level install guard between suites. */
export function resetOverlayWatcherForTests(): void {
  watcherInstalled = false;
  watcherObserver?.disconnect();
  watcherObserver = null;
  if (watcherTimer !== null && typeof window !== "undefined") {
    window.clearTimeout(watcherTimer);
  }
  watcherTimer = null;
  useWebviewGuardStore.setState({ overlayRects: [], overlaySeq: 0, popoverTabId: null });
}
