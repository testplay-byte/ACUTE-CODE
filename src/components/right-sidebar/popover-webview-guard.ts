/**
 * R60-D — the popover-over-webview suppression guard.
 * R62 (D9) — generalized into the WEBVIEW OVERLAY GUARD.
 *
 * The RightSidebar's QuickMenu / SubAgentPicker popovers are portaled to
 * document.body with position:fixed — in WEB mode that is enough to render
 * above the panel. In TAURI mode the browser panel's page renderer is a
 * NATIVE CHILD WEBVIEW: an OS-level layer that floats above ALL app HTML,
 * so ANY app overlay that opens over the page area (popovers, dropdown
 * menus, dialogs, selects, the command palette) renders BEHIND the webview
 * (the owner, R62: "the browser content was showing as an overlay on top of
 * everything so if a menu opened up then it would show under the browser").
 *
 * The R60 fix only covered the sidebar's two popovers. The R62 fix watches
 * the DOM for ANY open overlay (role=menu / role=dialog / Radix popper
 * content / explicit [data-overlay]) and hides every native webview while
 * one is open — the webview session stays alive (same background-tab
 * mechanism the panel itself uses; `browser_tab_set_visible` false).
 *
 * Architecture (unchanged from R60 for the popover part, extended for the
 * general part): this module is the SHARED TRUTH both sides consult —
 *  · `setPopoverWebviewSuppression(tabId|null)` — the sidebar's R60 popover
 *    flow (tab-scoped: the popover covers the ACTIVE browser tab's area).
 *  · `installOverlayWebviewWatcher()` — a MutationObserver over
 *    document.body (installed once by the AppShell) that flips the store's
 *    `overlayOpen` flag while any overlay is present. Tooltips are excluded
 *    (tiny, transient — hiding the page under every hover tooltip would
 *    flash constantly).
 *  · The BrowserPanel subscribes to the store and hides/shows its webview;
 *    `nativeCreate` consults the CURRENT state at show-time (the
 *    created-while-popover-open race the R60 module fixed stays fixed).
 *
 * Backed by a zustand store now (plain module state before) because the
 * panel must REACT to overlay changes, not just poll them. Nothing here
 * persists — a transient UI overlay must never survive a reload.
 */
import { create } from "zustand";

interface WebviewGuardState {
  /** R62-D9: any app overlay (menu/dialog/popover/listbox) is open. */
  overlayOpen: boolean;
  /** R60-D: the tab id whose webview is hidden under the sidebar popover. */
  popoverTabId: string | null;
  setOverlayOpen: (open: boolean) => void;
  setPopoverTabId: (tabId: string | null) => void;
}

export const useWebviewGuardStore = create<WebviewGuardState>()((set) => ({
  overlayOpen: false,
  popoverTabId: null,
  setOverlayOpen: (overlayOpen) => set({ overlayOpen }),
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

/**
 * Whether `tabId`'s webview must be hidden right now for EITHER reason —
 * the tab-scoped popover guard or a global overlay (R62). This is the
 * single show/hide predicate the BrowserPanel's create path consults.
 */
export function isWebviewHiddenNow(tabId: string): boolean {
  const s = useWebviewGuardStore.getState();
  return s.overlayOpen || s.popoverTabId === tabId;
}

// ── R62-D9: the DOM overlay watcher ────────────────────────────────────────

/** What counts as an overlay: Radix/shadcn portals + explicit markers.
 * (role="listbox" rides inside a popper wrapper for Select; tooltips are
 * filtered out below — they are too transient to blank the page for.) */
const OVERLAY_SELECTOR =
  '[role="menu"], [role="dialog"], [data-radix-popper-content-wrapper], [data-overlay]';

/** Is at least one non-tooltip overlay present in the DOM right now? */
function overlayPresent(): boolean {
  const nodes = document.querySelectorAll(OVERLAY_SELECTOR);
  for (const el of nodes) {
    if (el.closest('[role="tooltip"]') === null) return true;
  }
  return false;
}

let watcherInstalled = false;
/** Debounce handle — streaming DOM churn must not spin the check. */
let watcherTimer: number | null = null;

/**
 * Install the overlay watcher (ONCE per app — the AppShell calls this on
 * mount). A MutationObserver over document.body re-checks overlay presence
 * only when nodes are ADDED/REMOVED (attribute-only mutations can never
 * open or close a portal) and debounced 80ms so bursts (chat streaming,
 * list updates) collapse into one check. Happy-dom safe: MutationObserver
 * exists there too, and the store flip is a no-op for web mode (panels
 * only act on it in native mode).
 */
export function installOverlayWebviewWatcher(): void {
  if (watcherInstalled || typeof document === "undefined") return;
  watcherInstalled = true;
  const check = () => {
    watcherTimer = null;
    useWebviewGuardStore.getState().setOverlayOpen(overlayPresent());
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
  // Baseline state (an overlay could already be open at install time).
  useWebviewGuardStore.getState().setOverlayOpen(overlayPresent());
}

/** Test hook: reset the module-level install guard between suites. */
export function resetOverlayWatcherForTests(): void {
  watcherInstalled = false;
  if (watcherTimer !== null) {
    window.clearTimeout(watcherTimer);
    watcherTimer = null;
  }
  useWebviewGuardStore.setState({ overlayOpen: false, popoverTabId: null });
}
