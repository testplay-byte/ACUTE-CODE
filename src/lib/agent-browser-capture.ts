/**
 * ROUND-124 (R124) — the STAGED browser screenshot capture.
 *
 * THE OWNER'S VERDICT (the feedback ledger's browser-screenshot round), three
 * rulings this module exists to satisfy:
 *   1. "if I have the application closed, then it cannot take screenshots of
 *      the inbuilt browser" → the capture must work even when the browser
 *      VIEW is not visible/attached — the owner may be in Settings (a route
 *      swap that unmounts every BrowserPanel), on another sidebar tab, or
 *      anywhere else in the app while an agent turn runs the browser tool.
 *   2. "if the browser window is way too small, then the resolution of the
 *      screenshot is way too less… the screenshot… should be taken in a
 *      higher resolution, even if the total area being taken up by the
 *      browser window is way too small… should not be based on the actual
 *      device's resolution, but it should be based on some other factors" →
 *      a FIXED logical capture resolution (BROWSER_CAPTURE_WIDTH/HEIGHT),
 *      independent of the visible webview size.
 *   3. "this should also happen if the user is in some other application, is
 *      in the settings of the program or something else, but the screenshot
 *      should still be successfully taken as needed."
 *
 * THE MECHANISM DECISION (why resize-for-capture + the existing screen-region
 * engine, and not the "underlying engine's own screenshot API"):
 *   · The old pipeline answered `screenshot_meta` with the panel's ON-SCREEN
 *     rect and let agent-core grab that physical region — so the raster
 *     resolution was the VIEW's size (a preset-mode panel renders a 1280×800
 *     layout through a fit-scaled ~0.3× zoom: full layout, tiny pixels — the
 *     owner's exact complaint), and a hidden/unmounted panel answered an
 *     honest REFUSAL ("Switch the right sidebar to the Browser panel first")
 *     — complaint 1/3.
 *   · The tab webview IS real Chromium (WebView2) and CAN be re-staged purely
 *     from the frontend: `browser_tab_set_bounds` (logical px) + a DPI zoom of
 *     1× renders the page at TRUE CSS PIXELS whatever the user's panel size
 *     is. Re-staging at 1280×720 gives the page a standard high-res viewport
 *     to lay out against — the "some other factors" the owner asked for.
 *   · The raster engine stays the platform screen-capture backends that live
 *     in agent-core (PowerShell GDI CopyFromScreen / scrot -a / screencapture
 *     -R): tauri 2.11 / wry expose NO webview raster API to the frontend,
 *     there is no CDP channel into the WebView2 child, and a Rust
 *     `ICoreWebView2::CapturePreview` port would be ~150 lines of unverifiable
 *     COM plumbing (this sandbox has no cargo toolchain and no Windows GUI —
 *     the R123-i rustup setup did not survive the sandbox restore). The
 *     screen-region engine is the mechanism the repo already ships and the
 *     owner's machine already exercises; R124 re-stages the webview IN FRONT
 *     of it instead of replacing it.
 *   · THE HONEST COST of that decision: the page must be ON SCREEN for the
 *     ~1-2s of the grab, so a capture while the user is elsewhere in the app
 *     briefly FLASHES the staged page over the app UI (the child webview is
 *     an OS-level layer above all app DOM — showing it is the ONLY way a
 *     screen capture can see it), and if the app window sits BEHIND another
 *     application's window the grab contains THAT window's pixels (the
 *     pre-existing screen-scrape limitation, unchanged by this round; a
 *     minimized window is detected and refused honestly below). A true
 *     off-screen engine capture (CapturePreview/CDP) remains the documented
 *     follow-up if the flash ever bothers the owner.
 *
 *   · ROUND-125 (R125-A) — the OCCLUSION half of that cost is FIXED on
 *     Windows: the sidecar's capture route now runs PrintWindow
 *     (PW_RENDERFULLCONTENT) on the app's own CHILD webview (window-scoped
 *     pixels, valid while another application covers the app) and its reply
 *     carries `source` ("window" | "screen") — THIS module threads that field
 *     into the capture result, the browser_control tool's note states it,
 *     and a "screen" capture carries the honest caveat (the occluder may
 *     have leaked in), never a silent pass. The FLASH cost remains (the
 *     staged page still shows for the grab — the staging choreography is
 *     unchanged). An older sidecar omits `source` → the field is absent here
 *     too (optional-tolerant, never guessed).
 *
 * THE LAWS this module keeps:
 *   · CAPTURE-WHILE-HIDDEN: the webview is ALIVE whenever the browser tab
 *     exists (R87's keep-alive + the tab-close reaper only destroy on tab
 *     close), so staging merely SHOWS a live page — nothing is resurrected
 *     behind the user's back. A MISSING webview (tab closed / app restarted
 *     mid-turn) is an honest error, never a silent recreate.
 *   · CLAMP-TO-WINDOW: a Win32 CHILD webview is clipped to the main window's
 *     client area — a staged rect wider than the window would photograph the
 *     DESKTOP beside the app (leaking the owner's screen), so the target
 *     resolution is clamped to the client area and the clamp is REPORTED
 *     honestly (`clamped: true`) rather than padded or fabricated.
 *   · ALWAYS-RESTORE: bounds → zoom → visibility are re-commanded in a
 *     finally block (in THAT order — the Rust show-reassert re-applies
 *     TAB_LAST_BOUNDS, so the ORIGINAL bounds must be re-commanded BEFORE any
 *     `set_visible(true)` or the staged geometry would be re-asserted). The
 *     panel's own 500ms bounds safety net + reveal path heal any residue.
 *     A surface that unmounted MID-CAPTURE (the route swap to Settings)
 *     DEFERS its hide (deferTabHideUntilCaptureRestores) — the deferred
 *     hide wins over the pre-stage visibility truth at the restore.
 *   · ONE AT A TIME: a module-level in-flight latch refuses overlapping
 *     captures of the same tab (interleaved stage/restore pairs would produce
 *     garbage rasters and leaked staging).
 *
 * Callers: the BrowserPanel's `screenshot_capture` bridge action (panel-aware
 * restore hooks) and the agent-browser-bridge's module-level fallback for
 * tabs with NO mounted panel (the Settings case). The agent-core tool
 * (tools/plugins/browser.ts) sends the command carrying
 * BROWSER_CAPTURE_WIDTH/HEIGHT from ITS side — this module's constants are the
 * fallback defaults when the payload omits them (the two sides cannot share
 * code across the sidecar boundary; the tool's constants are the source of
 * truth and the payload threads them through, the
 * normalizeLocalFileUrl-lockstep precedent).
 */
import { captureBrowserRegion } from "./api";
import {
  isNativeBrowserAvailable,
  lastCommandedTabBounds,
  lastCommandedTabZoom,
  nativeTabExists,
  nativeTabSetBounds,
  nativeTabSetVisible,
  nativeTabSetZoom,
  nativeWindowMetrics,
  unminimizeMainWindow,
} from "./native-browser";

/**
 * R124: the FIXED logical capture width (CSS px). 1280 is the "laptop" band
 * (the viewport preset family's own mid step): wide enough that the owner's
 * "higher resolution" ruling is satisfied on every realistic display, narrow
 * enough to fit inside a 1280-wide app window (the clamp-to-window law) and
 * inside vision-model image budgets. The agent-core tool carries the SAME
 * number in the command payload — this default only answers a payload that
 * omits it.
 */
export const BROWSER_CAPTURE_WIDTH = 1280;

/**
 * R124: the FIXED logical capture height (CSS px). 720 = 1280×720 (16:9, the
 * HD band) — deliberately TALLER than a right-sidebar panel ever is, so the
 * capture sees more of the page than the user's small view does, exactly the
 * owner's ruling.
 */
export const BROWSER_CAPTURE_HEIGHT = 720;

/**
 * R124: how long the staged geometry is left to settle before the grab. A
 * WebView2 resize dispatches asynchronously (bounds message → relayout →
 * repaint); grabbing in the same tick can photograph the PRE-resize frame.
 * 400ms is the judgement call: comfortably past a relayout on a loaded page,
 * short enough that the flash stays sub-second. Not a magic number to tune
 * blind — if field reports show torn captures, this is the dial.
 */
export const BROWSER_CAPTURE_SETTLE_MS = 400;

/**
 * R128-W7a: how long the guard-3 recovery waits after `window_unminimize`
 * before re-reading the window metrics. A Windows un-minimize is a short
 * animated OS transition — the outer position moves off (-32000,-32000)
 * within a few frames; 600ms is the bounded beat that covers it without
 * stretching a refused capture into a hang (the capture itself still has
 * the R124 30s round-trip budget).
 */
export const BROWSER_CAPTURE_UNMINIMIZE_WAIT_MS = 600;

/**
 * R124: the honest floor for a staged dimension. The tool's REGION_MIN_PX
 * (50) guards the LEGACY path; the staged path clamps its TARGET into this
 * range so a caller cannot ask for a sliver, and a degenerate window
 * (client area below the floor) is refused rather than captured.
 */
export const BROWSER_CAPTURE_MIN_LOGICAL_PX = 200;

/**
 * R124: the honest ceiling for a staged dimension — the viewport preset
 * family's own 3840 cap (browser-proxy's PUT /browser/viewport validation),
 * reused so the staged viewport never exceeds what the app itself would
 * accept as a page viewport.
 */
export const BROWSER_CAPTURE_MAX_LOGICAL_PX = 3840;

/** The staged rect the webview will occupy (window-relative LOGICAL px). */
export interface StagedCaptureGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
  /** True when the target had to shrink to fit the window's client area. */
  clamped: boolean;
}

/** A measurable area the geometry math can consume (a DOMRect subset). */
export interface CaptureAreaRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * R124: the pure staging geometry (unit-tested in
 * agent-browser-capture.test.ts):
 *   · target dims are clamped into [MIN, MAX];
 *   · then into the window's client area (the clamp-to-window law — a child
 *     webview cannot paint outside the main window, and a region beyond it
 *     would photograph the desktop, i.e. the owner's screen leaking);
 *   · position: the anchor rect's top-left (the panel placeholder — the flash
 *     happens where the browser BELONGS) when one is measurable, else the
 *     client area's center; always pulled inside the client area so the
 *     staged rect is fully on-window.
 * Degenerate inputs (NaN/negative) collapse to the floors — the CALLER's
 * guards own the honest refusals; this function never invents geometry.
 */
export function computeStagedCaptureGeometry(
  target: { width: number; height: number },
  clientArea: { width: number; height: number },
  anchor: CaptureAreaRect | null,
): StagedCaptureGeometry {
  const clampDim = (v: number): number =>
    Number.isFinite(v) ? Math.min(BROWSER_CAPTURE_MAX_LOGICAL_PX, Math.max(BROWSER_CAPTURE_MIN_LOGICAL_PX, v)) : BROWSER_CAPTURE_MIN_LOGICAL_PX;
  const targetW = clampDim(target.width);
  const targetH = clampDim(target.height);
  // The client area itself is floored — a degenerate window is the caller's
  // honest refusal, but the math must still be total.
  const areaW = Math.max(BROWSER_CAPTURE_MIN_LOGICAL_PX, Number.isFinite(clientArea.width) ? clientArea.width : BROWSER_CAPTURE_MIN_LOGICAL_PX);
  const areaH = Math.max(BROWSER_CAPTURE_MIN_LOGICAL_PX, Number.isFinite(clientArea.height) ? clientArea.height : BROWSER_CAPTURE_MIN_LOGICAL_PX);
  const w = Math.min(targetW, areaW);
  const h = Math.min(targetH, areaH);
  const anchorX = anchor !== null && Number.isFinite(anchor.left) ? anchor.left : null;
  const anchorY = anchor !== null && Number.isFinite(anchor.top) ? anchor.top : null;
  // Anchor when available, else center; clamped so the whole staged rect
  // stays inside the client area (never off-window, never negative).
  const rawX = anchorX !== null ? anchorX : (areaW - w) / 2;
  const rawY = anchorY !== null ? anchorY : (areaH - h) / 2;
  const x = Math.min(Math.max(0, rawX), Math.max(0, areaW - w));
  const y = Math.min(Math.max(0, rawY), Math.max(0, areaH - h));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), clamped: w < targetW || h < targetH };
}

/** Options the two callers (panel handler / bridge fallback) provide. */
export interface StagedCaptureOptions {
  /** Target logical width (the tool threads its constant; default = module's). */
  width?: number;
  /** Target logical height (the tool threads its constant; default = module's). */
  height?: number;
  /**
   * The webview's CURRENT visibility truth, read LIVE by the caller. The
   * panel computes it from its hidden/homeView/popover/overlay facts; the
   * bridge fallback omits it — a tab with NO mounted panel is hidden by the
   * background-tab contract (the unmount cleanup hides the webview), so the
   * safe default is false (stage shows it, restore hides it).
   */
  expectVisible?: boolean;
  /**
   * Live read of the panel placeholder's rect (the staging anchor — where
   * the flash belongs). Returns null when unmeasurable; the geometry then
   * centers in the window.
   */
  anchorRect?: () => CaptureAreaRect | null;
  /**
   * Panel hook fired after the restore commands land — the panel resets its
   * zoom spam-guard and re-runs its bounds sync so the pre-stage geometry is
   * re-asserted immediately instead of waiting for the 500ms safety net.
   */
  onRestored?: () => void;
}

/** The successful capture: the raster + the honest geometry it came from. */
export interface StagedCaptureResult {
  /** PNG bytes, base64 — exactly what the sidecar's backend produced. */
  pngBase64: string;
  /** Raster width (physical px — logical × the window's scale factor). */
  width: number;
  /** Raster height (physical px). */
  height: number;
  /** The staged LOGICAL width the page laid out against (CSS px). */
  logicalWidth: number;
  /** The staged LOGICAL height (CSS px). */
  logicalHeight: number;
  /** True when the target resolution was clamped to the app window. */
  clamped: boolean;
  /**
   * ROUND-125 (R125-A): WHICH pixels the sidecar's backend captured —
   * "window" (Windows PrintWindow on the app's own child webview:
   * occlusion-proof, the grab is the PAGE even when another application
   * covers the app) or "screen" (the legacy screen-region grab: another
   * window on top may have leaked in — the owner's v0.117.0 complaint).
   * OPTIONAL: an older sidecar omits the field and so does this result
   * (absence = "don't know", never a guessed "window"). The browser_control
   * tool reads it to state the capture's provenance in its reply.
   */
  source?: "window" | "screen";
}

/**
 * R124: the in-flight latch — the tab id currently being captured, or null.
 * Overlapping captures of the same tab would interleave stage/restore pairs
 * (the second restore would fight the first stage) and could hand the grab a
 * half-restored webview; a second call while one runs refuses honestly.
 *
 * The latch is also the panel's SUPPRESSION signal: syncBounds (the 500ms
 * bounds safety net + ResizeObserver) and the R91-B3 visibility watchdog
 * re-assert the panel's OWN geometry on a timer — during a staged capture
 * that would shrink the webview back to the panel view MID-GRAB (the capture
 * window is ~450ms vs the 500ms safety net — near-certain collision) and the
 * grab would photograph the small view, the exact defect R124 fixes. The
 * panel's writers consult isStagedCaptureInFlightFor(tabId) and stand down
 * for the capture's duration; the capture's own finally restores the world.
 */
let inFlightCaptureTab: string | null = null;

/** Test/inspection hook: the current in-flight capture tab (or null). */
export function stagedCaptureInFlightTab(): string | null {
  return inFlightCaptureTab;
}

/**
 * R124: is a staged capture in flight for THIS tab right now? The panel's
 * bounds/visibility writers (syncBounds, the watchdog, the visibility
 * effect) consult this to stand down while the capture owns the webview's
 * geometry.
 */
export function isStagedCaptureInFlightFor(tabId: string): boolean {
  return inFlightCaptureTab === tabId;
}

/**
 * R124: the tabs whose owning surfaces asked to HIDE the webview while a
 * staged capture was in flight — the panel's unmount cleanup (a route swap
 * to Settings, the owner's own ruling-#3 scenario) and the sidebar's R60-D
 * popover fallback both hide on their way out, and landing that hide
 * MID-GRAB would (a) photograph whatever sits behind the staged webview
 * (dishonest bytes shown in the chat thumbnail) and (b) leave the capture's
 * restore re-showing a webview with NO owner panel (the page floating over
 * whatever route the user swapped to, until some panel remounts).
 *
 * The deferred hide WINS over the pre-stage visibility truth at the
 * capture's restore (an unmounted panel's webview ends hidden — the
 * background-tab contract), and a stale entry cannot misfire later: the
 * defer is only ever registered while the latch is set, so the SAME
 * capture's restore (or its post-latch sweep, for a defer that lands in
 * the restore's final awaits) consumes it.
 */
const deferredHides = new Set<string>();

/**
 * R124: hide this tab's webview WHEN the in-flight staged capture restores,
 * instead of NOW. Only legal while isStagedCaptureInFlightFor(tabId) is
 * true (the caller checks); the capture's restore consumes the defer.
 */
export function deferTabHideUntilCaptureRestores(tabId: string): void {
  deferredHides.add(tabId);
}

/** Best-effort logging for restore commands that must never break the reply. */
function restoreWarn(err: unknown): void {
  console.warn("[agent-browser-capture] restore", err);
}

/**
 * R124: the staged capture itself. One ATOMIC choreography — stage, settle,
 * grab (sidecar round trip), restore — with the restore in a finally so a
 * failed grab still un-stages the webview. Throws Error with the honest
 * cause on every refusal; NEVER fabricates a raster.
 */
export async function performStagedBrowserCapture(
  tabId: string,
  options: StagedCaptureOptions = {},
): Promise<StagedCaptureResult> {
  if (!isNativeBrowserAvailable()) {
    // Web dev mode / e2e: no native webview exists at all — the honest
    // refusal (the bridge fallback keeps its own no-panel message for this
    // case; this guard covers the panel-handler path in a non-Tauri shell).
    throw new Error(
      "screenshot_capture: the native browser bridge is not present (web dev mode has no webview to capture) — use action 'read' or 'read_dom' for the page content",
    );
  }
  if (inFlightCaptureTab === tabId) {
    throw new Error(
      `screenshot_capture: a capture is already in flight for tab '${tabId}' — wait for it to finish before requesting another`,
    );
  }
  // ── guard 1: the webview must EXIST (the keep-alive law's other half) ────
  // The webview lives as long as the browser TAB lives (R87 keep-alive; the
  // tab-close reaper destroys only on close). Missing = the tab itself is
  // gone (user closed it mid-turn, or the app restarted) — we do NOT
  // resurrect a page the user explicitly closed just to photograph it.
  const exists = await nativeTabExists(tabId);
  if (!exists) {
    throw new Error(
      `screenshot_capture: no native webview exists for tab '${tabId}' (the browser tab was closed, or the app restarted mid-turn) — the capture needs the tab's live page; action 'read'/'read_dom' can still fetch the page server-side`,
    );
  }
  // ── guard 2: the window metrics (the physical-region transform) ──────────
  let metrics = await nativeWindowMetrics();
  if (metrics === null) {
    throw new Error(
      "screenshot_capture: the desktop window API is unavailable (no outer position / scale factor) — the physical capture region cannot be computed",
    );
  }
  // ── guard 3: the minimized window — RECOVER FIRST, refuse honestly ───────
  // A minimized Windows window parks at (-32000,-32000); a capture there
  // would photograph empty screen coordinates. R128-W7a: instead of the
  // pre-R128 flat refusal, call the Rust `window_unminimize` command
  // (best-effort), wait the bounded beat, and re-read the metrics ONCE — a
  // restored window proceeds with the LIVE position (the region math below
  // uses the re-read metrics, never the minimized parking spot). Only a
  // STILL-minimized window refuses, and the copy says the restore was
  // attempted ("restored the window and retried; still minimized").
  if (metrics.x <= -10_000 || metrics.y <= -10_000) {
    let live: { x: number; y: number; scaleFactor: number } | null = null;
    try {
      await unminimizeMainWindow();
      await new Promise<void>((resolve) => setTimeout(resolve, BROWSER_CAPTURE_UNMINIMIZE_WAIT_MS));
      live = await nativeWindowMetrics();
    } catch {
      // The un-minimize command itself failed (bridge gone mid-call, the
      // window API refusing) — the honest refusal below owns the answer.
    }
    if (live === null || live.x <= -10_000 || live.y <= -10_000) {
      throw new Error(
        "screenshot_capture: the app window is minimized — restored the window and retried, but it still reports minimized coordinates; keep the app un-minimized in the background and retry (a minimized window paints nothing on screen to capture)",
      );
    }
    metrics = live;
  }
  // ── the staged geometry (clamp-to-window law) ────────────────────────────
  const clientArea =
    typeof window === "object" && window !== null
      ? { width: window.innerWidth, height: window.innerHeight }
      : { width: BROWSER_CAPTURE_MIN_LOGICAL_PX, height: BROWSER_CAPTURE_MIN_LOGICAL_PX };
  if (
    clientArea.width < BROWSER_CAPTURE_MIN_LOGICAL_PX ||
    clientArea.height < BROWSER_CAPTURE_MIN_LOGICAL_PX
  ) {
    throw new Error(
      `screenshot_capture: the app window's client area measures ${Math.round(clientArea.width)}×${Math.round(clientArea.height)}px — too small to stage an honest capture (floor ${BROWSER_CAPTURE_MIN_LOGICAL_PX}px); enlarge the window and retry`,
    );
  }
  const target = {
    width: typeof options.width === "number" && Number.isFinite(options.width) ? options.width : BROWSER_CAPTURE_WIDTH,
    height: typeof options.height === "number" && Number.isFinite(options.height) ? options.height : BROWSER_CAPTURE_HEIGHT,
  };
  let anchor: CaptureAreaRect | null = null;
  if (typeof options.anchorRect === "function") {
    try {
      anchor = options.anchorRect();
    } catch {
      anchor = null; // an unmeasurable anchor is not an error — center instead
    }
  }
  const geo = computeStagedCaptureGeometry(target, clientArea, anchor);
  // ── the pre-stage snapshot (what the restore re-commands) ────────────────
  const preBounds = lastCommandedTabBounds(tabId);
  const preZoom = lastCommandedTabZoom(tabId);
  const preVisible = options.expectVisible === true;

  inFlightCaptureTab = tabId;
  try {
    // ── STAGE: the capture resolution at 1:1 CSS px ────────────────────────
    // set_bounds + zoom 1 re-renders the page at TRUE pixel scale: a
    // preset-mode panel that was fit-scaled to ~0.3× now renders its full
    // layout at full raster; a natural-mode small panel now lays the page
    // out against the STANDARD 1280×720 viewport. Showing the webview (when
    // it was hidden) is the honest flash — the only way a screen capture
    // can see the page (see the mechanism decision above).
    await nativeTabSetBounds(tabId, geo.x, geo.y, geo.w, geo.h);
    await nativeTabSetZoom(tabId, 1);
    if (!preVisible) {
      await nativeTabSetVisible(tabId, true);
    }
    // ── SETTLE: let the resize land + the page re-layout + repaint ─────────
    await new Promise<void>((resolve) => setTimeout(resolve, BROWSER_CAPTURE_SETTLE_MS));
    // ── GRAB: the physical region of the staged logical rect ──────────────
    const region = {
      x: Math.round(metrics.x + geo.x * metrics.scaleFactor),
      y: Math.round(metrics.y + geo.y * metrics.scaleFactor),
      w: Math.round(geo.w * metrics.scaleFactor),
      h: Math.round(geo.h * metrics.scaleFactor),
    };
    const raster = await captureBrowserRegion(region);
    if (
      typeof raster?.pngBase64 !== "string" ||
      raster.pngBase64.length < 64 ||
      typeof raster.width !== "number" ||
      typeof raster.height !== "number"
    ) {
      throw new Error(
        `screenshot_capture: the capture backend answered a malformed raster (no PNG bytes) for region ${region.w}×${region.h}px`,
      );
    }
    // R125-A: thread the backend's honest source marker through — ONLY the
    // two known strings survive (anything else on the wire is dropped: the
    // conservative absence, never a guessed "window").
    const rasterSource = raster.source === "window" || raster.source === "screen" ? raster.source : undefined;
    return {
      pngBase64: raster.pngBase64,
      width: raster.width,
      height: raster.height,
      logicalWidth: geo.w,
      logicalHeight: geo.h,
      clamped: geo.clamped,
      ...(rasterSource !== undefined ? { source: rasterSource } : {}),
    };
  } finally {
    // ── RESTORE (always — even when the grab failed) ──────────────────────
    // ORDER IS LOAD-BEARING: the Rust show-reassert re-applies TAB_LAST_BOUNDS
    // on set_visible(true), and our staging OVERWROTE that memory — so the
    // ORIGINAL bounds must be re-commanded FIRST (which also re-records the
    // Rust-side memory), then zoom, then visibility. A restore failure never
    // masks the capture result or the honest error: the panel's 500ms bounds
    // safety net, its reveal path, and the R91-B3 watchdog each heal residue.
    try {
      if (preBounds !== null) {
        await nativeTabSetBounds(tabId, preBounds.x, preBounds.y, preBounds.w, preBounds.h);
      }
    } catch (err) {
      restoreWarn(err);
    }
    try {
      if (preZoom !== null) {
        await nativeTabSetZoom(tabId, preZoom);
      }
    } catch (err) {
      restoreWarn(err);
    }
    try {
      // R124: a surface that unmounted mid-capture (the route swap to
      // Settings — the owner's ruling #3 in flight) deferred its hide here;
      // the deferred hide WINS over the pre-stage truth (an unmounted
      // panel's webview must end hidden — re-showing it would float the
      // page over the user's next route with no owner panel).
      const hideAfter = deferredHides.delete(tabId);
      await nativeTabSetVisible(tabId, preVisible && !hideAfter);
    } catch (err) {
      restoreWarn(err);
    }
    try {
      options.onRestored?.();
    } catch (err) {
      restoreWarn(err);
    }
    inFlightCaptureTab = null;
    // R124 sweep: a defer can still land between the visibility restore
    // above and this line (the unmount raced the capture's tail). The
    // deferred surface is gone by definition, so the hide is the honest
    // end state; a panel that somehow remounted in that instant re-asserts
    // its own truth within its R91-B3 watchdog window (≤2s).
    if (deferredHides.delete(tabId)) {
      try {
        await nativeTabSetVisible(tabId, false);
      } catch (err) {
        restoreWarn(err);
      }
    }
  }
}

/**
 * R124: parse a screenshot_capture payload's width/height (the tool threads
 * its constants; anything non-numeric is dropped so the module defaults
 * answer). Pure — unit-tested.
 */
export function parseCapturePayloadDims(
  payload: Record<string, unknown>,
): { width?: number; height?: number } {
  const width = typeof payload.width === "number" && Number.isFinite(payload.width) ? payload.width : undefined;
  const height = typeof payload.height === "number" && Number.isFinite(payload.height) ? payload.height : undefined;
  return width !== undefined || height !== undefined ? { ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) } : {};
}
