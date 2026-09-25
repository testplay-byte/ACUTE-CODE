// @vitest-environment happy-dom
/**
 * ROUND-124 (R124) — the STAGED browser screenshot capture's unit suite.
 *
 * The owner's three rulings, pinned here as laws of the choreography:
 *   (a) FIXED RESOLUTION — the staged webview is sized
 *       BROWSER_CAPTURE_WIDTH×BROWSER_CAPTURE_HEIGHT logical px (1280×720)
 *       with zoom 1, whatever the visible panel's size is (ruling: "the
 *       screenshots… should be taken in a higher resolution, even if the
 *       total area being taken up by the browser window is way too small");
 *   (b) CAPTURE-WHILE-HIDDEN — a webview the caller reports hidden
 *       (expectVisible:false, the bridge-fallback/unmounted-panel default)
 *       is SHOWN for the grab and re-HIDDEN by the restore (ruling: "if I
 *       have the application closed, then it cannot take screenshots of the
 *       inbuilt browser" / "this should also happen if the user is in the
 *       settings of the program or something else");
 *   (c) HONEST GEOMETRY — a target larger than the app window's client area
 *       is CLAMPED and the clamp is reported (never padded, never
 *       fabricated), and every refusal names its cause (missing webview,
 *       minimized window, degenerate client area, failed grab).
 *
 * The native bridge + the sidecar capture POST are mocked at the module
 * boundary (native-browser / api) — the Rust + PowerShell legs are the
 * owner's-machine territory; these tests pin the CHOREOGRAPHY: which
 * commands, in which ORDER, with which values, and what the restore
 * re-commands. The mock's bounds/zoom recording mirrors the REAL module's
 * tab geometry memory (see native-browser.ts) so the restore path is
 * exercised against recorded pre-stage geometry, exactly as in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The mocked native-browser's stateful geometry memory (mirrors the real module). */
const nativeState = vi.hoisted(() => {
  const bounds = new Map<string, { x: number; y: number; w: number; h: number }>();
  const zoom = new Map<string, number>();
  return {
    available: true,
    exists: true,
    metrics: { x: 1920, y: 0, scaleFactor: 2 } as { x: number; y: number; scaleFactor: number } | null,
    // R128-W7a: a scripted SEQUENTIAL metrics queue — when non-empty each
    // nativeWindowMetrics call shifts the next reply (the guard-3 recovery
    // re-reads the metrics after window_unminimize; the first reply is the
    // minimized parking spot, the second the restored position).
    metricsQueue: [] as Array<{ x: number; y: number; scaleFactor: number } | null>,
    bounds,
    zoom,
  };
});

/** The mocked api's capture replies / failures. R125-A: `source` mirrors
 * the sidecar route's additive field (absent = an old sidecar). */
const apiState = vi.hoisted(() => ({
  reply: { pngBase64: "aW1n".repeat(40), width: 2560, height: 1440 } as {
    pngBase64: string;
    width: number;
    height: number;
    source?: "window" | "screen";
  },
  failWith: null as Error | null,
  regions: [] as Array<{ x: number; y: number; w: number; h: number }>,
}));

vi.mock("./native-browser", () => ({
  isNativeBrowserAvailable: () => nativeState.available,
  nativeTabExists: vi.fn(async () => nativeState.exists),
  // R128-W7a: the metrics queue takes precedence (the un-minimize recovery
  // pins script minimized → live sequences through it).
  nativeWindowMetrics: vi.fn(async () => {
    if (nativeState.metricsQueue.length > 0) return nativeState.metricsQueue.shift()!;
    return nativeState.metrics;
  }),
  // R128-W7a: the Rust window_unminimize command's bridge fake.
  unminimizeMainWindow: vi.fn(async () => {}),
  // Faithful to the real module: successful commands RECORD into the tab
  // geometry memory the restore path reads.
  nativeTabSetBounds: vi.fn(async (tabId: string, x: number, y: number, w: number, h: number) => {
    nativeState.bounds.set(tabId, { x, y, w, h });
  }),
  nativeTabSetZoom: vi.fn(async (tabId: string, factor: number) => {
    nativeState.zoom.set(tabId, factor);
  }),
  nativeTabSetVisible: vi.fn(async () => {}),
  lastCommandedTabBounds: vi.fn((tabId: string) => nativeState.bounds.get(tabId) ?? null),
  lastCommandedTabZoom: vi.fn((tabId: string) => nativeState.zoom.get(tabId) ?? null),
  resetTabGeometryMemoryForTest: vi.fn(() => {
    nativeState.bounds.clear();
    nativeState.zoom.clear();
  }),
}));

vi.mock("./api", () => ({
  captureBrowserRegion: vi.fn(async (region: { x: number; y: number; w: number; h: number }) => {
    apiState.regions.push(region);
    if (apiState.failWith !== null) throw apiState.failWith;
    return apiState.reply;
  }),
}));

import {
  BROWSER_CAPTURE_HEIGHT,
  BROWSER_CAPTURE_MAX_LOGICAL_PX,
  BROWSER_CAPTURE_MIN_LOGICAL_PX,
  BROWSER_CAPTURE_WIDTH,
  computeStagedCaptureGeometry,
  deferTabHideUntilCaptureRestores,
  parseCapturePayloadDims,
  performStagedBrowserCapture,
  stagedCaptureInFlightTab,
} from "./agent-browser-capture";
import {
  lastCommandedTabBounds,
  lastCommandedTabZoom,
  nativeTabSetBounds,
  nativeTabSetVisible,
  nativeTabSetZoom,
  resetTabGeometryMemoryForTest,
  unminimizeMainWindow,
} from "./native-browser";
import { captureBrowserRegion } from "./api";

const setBoundsMock = vi.mocked(nativeTabSetBounds);
const setZoomMock = vi.mocked(nativeTabSetZoom);
const setVisibleMock = vi.mocked(nativeTabSetVisible);
const unminimizeMock = vi.mocked(unminimizeMainWindow);
const captureMock = vi.mocked(captureBrowserRegion);

beforeEach(() => {
  vi.clearAllMocks();
  resetTabGeometryMemoryForTest();
  nativeState.available = true;
  nativeState.exists = true;
  nativeState.metrics = { x: 1920, y: 0, scaleFactor: 2 };
  // R128-W7a: no scripted metrics sequence by default.
  nativeState.metricsQueue.length = 0;
  apiState.failWith = null;
  apiState.reply = { pngBase64: "aW1n".repeat(40), width: 2560, height: 1440 };
  apiState.regions.length = 0;
  // A deterministic window client area for the choreography tests (the
  // geometry math tests pass their own client areas explicitly).
  window.innerWidth = 1600;
  window.innerHeight = 900;
});

afterEach(() => {
  // The in-flight latch must never leak across tests.
  expect(stagedCaptureInFlightTab()).toBeNull();
});

describe("R124: the fixed capture resolution constants", () => {
  it("1280×720 logical px — the owner's \"higher resolution\" ruling, one place", () => {
    // The LOCKSTEP pin: agent-core's tools/plugins/browser.ts carries the
    // SAME numbers (BROWSER_CAPTURE_WIDTH/HEIGHT) and threads them through
    // the command payload — its suite pins them independently; these two
    // assertions together are the cross-side lockstep guard.
    expect(BROWSER_CAPTURE_WIDTH).toBe(1280);
    expect(BROWSER_CAPTURE_HEIGHT).toBe(720);
    expect(BROWSER_CAPTURE_MIN_LOGICAL_PX).toBe(200);
    expect(BROWSER_CAPTURE_MAX_LOGICAL_PX).toBe(3840);
  });
});

describe("R124: computeStagedCaptureGeometry (the pure law)", () => {
  it("a window bigger than the target → the full fixed resolution, anchored at the panel rect", () => {
    const geo = computeStagedCaptureGeometry(
      { width: 1280, height: 720 },
      { width: 1600, height: 900 },
      { left: 80, top: 120, width: 400, height: 900 },
    );
    expect(geo).toEqual({ x: 80, y: 120, w: 1280, h: 720, clamped: false });
  });

  it("a window SMALLER than the target → clamped to the client area AND reported (never padded, never fabricated)", () => {
    const geo = computeStagedCaptureGeometry(
      { width: 1280, height: 720 },
      { width: 900, height: 500 },
      { left: 80, top: 120, width: 400, height: 400 },
    );
    // The clamp-to-window law: a child webview cannot paint outside the main
    // window — a wider staged rect would photograph the DESKTOP beside the
    // app (the owner's screen leaking). The clamp is honest, and flagged.
    // The staged rect fills the client area exactly, so the anchor position
    // collapses to (0,0) — there is nowhere else for it to sit.
    expect(geo).toEqual({ x: 0, y: 0, w: 900, h: 500, clamped: true });
  });

  it("no anchor → centered in the client area", () => {
    const geo = computeStagedCaptureGeometry({ width: 1280, height: 720 }, { width: 1600, height: 900 }, null);
    expect(geo).toEqual({ x: 160, y: 90, w: 1280, h: 720, clamped: false });
  });

  it("an anchor near the edge is pulled inside the window (the staged rect never straddles the edge)", () => {
    const geo = computeStagedCaptureGeometry(
      { width: 1280, height: 720 },
      { width: 1300, height: 800 },
      { left: 1290, top: 700, width: 10, height: 10 },
    );
    expect(geo.x).toBe(1300 - 1280);
    expect(geo.y).toBe(800 - 720);
    expect(geo.w).toBe(1280);
    expect(geo.h).toBe(720);
  });

  it("degenerate targets collapse to the honest floors (the caller's guards own the refusals)", () => {
    const geo = computeStagedCaptureGeometry({ width: Number.NaN, height: -5 }, { width: 1600, height: 900 }, null);
    expect(geo.w).toBe(BROWSER_CAPTURE_MIN_LOGICAL_PX);
    expect(geo.h).toBe(BROWSER_CAPTURE_MIN_LOGICAL_PX);
    // clamped reflects the WINDOW fit only — the floored target fits, so it
    // is not clamped (the degenerate input itself is the caller's refusal,
    // not a window clamp to report).
    expect(geo.clamped).toBe(false);
  });
});

describe("R124: parseCapturePayloadDims (the tool's threaded constants)", () => {
  it("numeric width/height pass through; junk is dropped (the module defaults answer)", () => {
    expect(parseCapturePayloadDims({ width: 1280, height: 720 })).toEqual({ width: 1280, height: 720 });
    expect(parseCapturePayloadDims({ width: "1280", height: null })).toEqual({});
    expect(parseCapturePayloadDims({})).toEqual({});
  });
});

describe("R124: performStagedBrowserCapture — the choreography", () => {
  it("the happy path: stage at 1280×720 + zoom 1, show, grab the PHYSICAL region, restore bounds → zoom → visibility", async () => {
    // Pre-stage geometry as the panel's sync would have commanded it: a
    // small fit-scaled view (the owner's "browser window is way too small").
    await nativeTabSetBounds("tab-a", 80, 120, 420, 260);
    await nativeTabSetZoom("tab-a", 0.33);

    const onRestored = vi.fn();
    const result = await performStagedBrowserCapture("tab-a", {
      width: 1280,
      height: 720,
      expectVisible: false,
      anchorRect: () => ({ left: 80, top: 120, width: 420, height: 260 }),
      onRestored,
    });

    // THE FIXED-RESOLUTION LAW: the staged bounds are 1280×720 logical px
    // (NOT the 420×260 view), at the anchor, and the zoom is 1 for the 1:1
    // raster (NOT the panel's composed 0.33 fit-scale).
    expect(setBoundsMock).toHaveBeenCalledWith("tab-a", 80, 120, 1280, 720);
    expect(setZoomMock).toHaveBeenCalledWith("tab-a", 1);
    // CAPTURE-WHILE-HIDDEN: the hidden webview is SHOWN for the grab…
    expect(setVisibleMock).toHaveBeenCalledWith("tab-a", true);
    // …and the grab asked the sidecar for the staged PHYSICAL region:
    // window origin (1920,0) + logical (80,120) × scale 2 → (2080,240),
    // 1280×720 logical × 2 → 2560×1440 physical.
    expect(captureMock).toHaveBeenCalledWith({ x: 2080, y: 240, w: 2560, h: 1440 });
    // The honest result reports BOTH geometries.
    expect(result).toEqual({
      pngBase64: apiState.reply.pngBase64,
      width: 2560,
      height: 1440,
      logicalWidth: 1280,
      logicalHeight: 720,
      clamped: false,
    });

    // THE ALWAYS-RESTORE LAW, in ORDER: bounds FIRST (the Rust show-reassert
    // re-applies the LAST COMMANDED bounds on set_visible(true), so the
    // original must be back on record before any show), then zoom, then
    // visibility (hidden again — the pre-stage truth), then the hook.
    expect(setBoundsMock).toHaveBeenLastCalledWith("tab-a", 80, 120, 420, 260);
    expect(setZoomMock).toHaveBeenLastCalledWith("tab-a", 0.33);
    expect(setVisibleMock).toHaveBeenLastCalledWith("tab-a", false);
    expect(setVisibleMock.mock.invocationCallOrder[0]).toBeLessThan(setBoundsMock.mock.invocationCallOrder.at(-1)!);
    expect(setBoundsMock.mock.invocationCallOrder.at(-1)!).toBeLessThan(setZoomMock.mock.invocationCallOrder.at(-1)!);
    expect(setZoomMock.mock.invocationCallOrder.at(-1)!).toBeLessThan(setVisibleMock.mock.invocationCallOrder.at(-1)!);
    expect(onRestored).toHaveBeenCalledTimes(1);
    // The geometry memory is back to the panel's truth — a second capture
    // would restore to the same place.
    expect(lastCommandedTabBounds("tab-a")).toEqual({ x: 80, y: 120, w: 420, h: 260 });
    expect(lastCommandedTabZoom("tab-a")).toBe(0.33);
  });

  it("a VISIBLE webview stays visible through the restore (expectVisible:true)", async () => {
    await nativeTabSetBounds("tab-b", 0, 0, 900, 700);
    const result = await performStagedBrowserCapture("tab-b", { expectVisible: true });
    expect(result.logicalWidth).toBe(1280);
    // No STAGE-show happens (it was already visible) — the only visibility
    // command is the RESTORE's keep-visible re-assert, which lands AFTER the
    // bounds + zoom restores.
    expect(setVisibleMock).toHaveBeenCalledTimes(1);
    expect(setVisibleMock).toHaveBeenCalledWith("tab-b", true);
    expect(setBoundsMock.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      setVisibleMock.mock.invocationCallOrder.at(-1)!,
    );
    expect(setZoomMock.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      setVisibleMock.mock.invocationCallOrder.at(-1)!,
    );
  });

  it("the clamp-to-window law: a small app window → the honest smaller capture, clamped:true", async () => {
    window.innerWidth = 900;
    window.innerHeight = 500;
    const result = await performStagedBrowserCapture("tab-c", { width: 1280, height: 720 });
    // Staged at the window's full client area — never a fabricated 1280×720
    // and never a rect that straddles the window edge.
    expect(setBoundsMock).toHaveBeenCalledWith("tab-c", 0, 0, 900, 500);
    expect(result.logicalWidth).toBe(900);
    expect(result.logicalHeight).toBe(500);
    expect(result.clamped).toBe(true);
  });

  it("a missing webview → the honest refusal (the keep-alive law: we never resurrect a closed tab)", async () => {
    nativeState.exists = false;
    await expect(performStagedBrowserCapture("tab-gone", {})).rejects.toThrow(/no native webview exists for tab 'tab-gone'/);
    expect(setBoundsMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("a MINIMIZED window is RECOVERED, not refused — unminimize called, the metrics re-read, the capture proceeds at the LIVE position (R128-W7a)", async () => {
    // The guard-3 recovery: the first metrics read answers the minimized
    // parking spot (-32000,-32000); the Rust window_unminimize command
    // runs; the bounded wait passes; the re-read answers the restored
    // position — and the capture's physical region uses the LIVE metrics,
    // never the parking spot.
    nativeState.metricsQueue = [
      { x: -32000, y: -32000, scaleFactor: 1 },
      { x: 100, y: 50, scaleFactor: 2 },
    ];
    const result = await performStagedBrowserCapture("tab-unmin", {});
    expect(unminimizeMock).toHaveBeenCalledTimes(1);
    // The staged geometry is the standard centered 1280×720 (1600×900
    // client area, no anchor): x=160, y=90 → the region adds the LIVE
    // window origin (100,50) at scale 2: (100+320, 50+180) = (420, 230).
    expect(captureMock).toHaveBeenCalledWith({ x: 420, y: 230, w: 2560, h: 1440 });
    expect(result.logicalWidth).toBe(1280);
    expect(result.logicalHeight).toBe(720);
  });

  it("a window STILL minimized after the un-minimize retry → the honest refusal that says the restore was attempted (R128-W7a)", async () => {
    nativeState.metricsQueue = [
      { x: -32000, y: -32000, scaleFactor: 1 },
      { x: -32000, y: -32000, scaleFactor: 1 },
    ];
    await expect(performStagedBrowserCapture("tab-still-min", {})).rejects.toThrow(
      /restored the window and retried, but it still reports minimized coordinates/,
    );
    expect(unminimizeMock).toHaveBeenCalledTimes(1);
    // Nothing was staged — the refusal owns the answer.
    expect(setBoundsMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("a minimized window whose re-read answers NO metrics (the window API gone mid-recovery) → the same honest refusal, never a hang", async () => {
    nativeState.metricsQueue = [{ x: -32000, y: -32000, scaleFactor: 1 }, null];
    await expect(performStagedBrowserCapture("tab-unmin-null", {})).rejects.toThrow(
      /restored the window and retried, but it still reports minimized coordinates/,
    );
    expect(unminimizeMock).toHaveBeenCalledTimes(1);
  });

  it("no window metrics → the honest refusal (the physical region cannot be computed)", async () => {
    nativeState.metrics = null;
    await expect(performStagedBrowserCapture("tab-nm", {})).rejects.toThrow(/window API is unavailable/);
  });

  it("web dev mode (no native bridge) → the honest refusal", async () => {
    nativeState.available = false;
    await expect(performStagedBrowserCapture("tab-web", {})).rejects.toThrow(/native browser bridge is not present/);
  });

  it("a degenerate client area → the honest refusal naming the measurement", async () => {
    window.innerWidth = 120;
    window.innerHeight = 90;
    await expect(performStagedBrowserCapture("tab-tiny", {})).rejects.toThrow(/too small to stage an honest capture/);
    expect(setBoundsMock).not.toHaveBeenCalled();
  });

  it("a FAILED grab still restores the pre-stage geometry (the finally law) and surfaces the cause", async () => {
    await nativeTabSetBounds("tab-fail", 10, 20, 300, 200);
    await nativeTabSetZoom("tab-fail", 0.5);
    apiState.failWith = new Error("screen capture failed: no scrot, no import");

    await expect(performStagedBrowserCapture("tab-fail", {})).rejects.toThrow(/no scrot, no import/);
    // The restore ran DESPITE the failure — no leaked staging.
    expect(setBoundsMock).toHaveBeenLastCalledWith("tab-fail", 10, 20, 300, 200);
    expect(setZoomMock).toHaveBeenLastCalledWith("tab-fail", 0.5);
    expect(setVisibleMock).toHaveBeenLastCalledWith("tab-fail", false);
  });

  it("a malformed capture reply (ok:true, no PNG) is refused honestly — never a fabricated raster", async () => {
    apiState.reply = { pngBase64: "short", width: 10, height: 10 };
    await expect(performStagedBrowserCapture("tab-malformed", {})).rejects.toThrow(/malformed raster/);
    // And the staging was still undone.
    expect(setVisibleMock).toHaveBeenLastCalledWith("tab-malformed", false);
  });

  it("overlapping captures of the same tab → the honest in-flight refusal", async () => {
    // Hold the first capture open across the sidecar POST, then ask again.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    captureMock.mockImplementationOnce(async (region) => {
      apiState.regions.push(region);
      await gate;
      return apiState.reply;
    });
    const first = performStagedBrowserCapture("tab-race", {});
    await vi.waitFor(() => expect(stagedCaptureInFlightTab()).toBe("tab-race"));
    await expect(performStagedBrowserCapture("tab-race", {})).rejects.toThrow(/already in flight/);
    release!();
    await expect(first).resolves.toMatchObject({ logicalWidth: 1280, logicalHeight: 720 });
  });

  it("payload dims thread through (the tool's constants win over the module defaults)", async () => {
    const result = await performStagedBrowserCapture("tab-dims", { width: 1000, height: 600 });
    expect(result.logicalWidth).toBe(1000);
    expect(result.logicalHeight).toBe(600);
    expect(setBoundsMock).toHaveBeenCalledWith("tab-dims", expect.any(Number), expect.any(Number), 1000, 600);
  });

  // ── R125-A: the honest SOURCE threading ─────────────────────────────────
  // The sidecar's capture route now answers `source` ("window" = Windows
  // PrintWindow on the app's own child webview — occlusion-proof, the
  // owner's "it takes a screenshot of that application instead" verdict
  // fixed; "screen" = the legacy region grab — the occluder may have leaked
  // in). The choreography threads it into the capture result so the
  // browser_control tool's note can state WHICH pixels arrived; the field is
  // OPTIONAL-TOLERANT (an older sidecar omits it — absence is absence, never
  // a guessed "window").
  it("the raster's source \"window\" threads through to the capture result (the occlusion-proof grab)", async () => {
    apiState.reply = { pngBase64: "aW1n".repeat(40), width: 2560, height: 1440, source: "window" };
    const result = await performStagedBrowserCapture("tab-src-win", {});
    expect(result.source).toBe("window");
    // The rest of the honest geometry is unchanged by the new field.
    expect(result.logicalWidth).toBe(1280);
    expect(result.clamped).toBe(false);
  });

  it("the raster's source \"screen\" threads through (the fallback is named, never silent)", async () => {
    apiState.reply = { pngBase64: "aW1n".repeat(40), width: 2560, height: 1440, source: "screen" };
    const result = await performStagedBrowserCapture("tab-src-scr", {});
    expect(result.source).toBe("screen");
  });

  it("an OLD sidecar (no source on the raster) → the result carries NO source key (never guessed)", async () => {
    // apiState.reply has no source (the beforeEach reset) — the exact-shape
    // pin: the key is ABSENT, not undefined-valued, so the tool's note logic
    // and old pins treat it as "don't know".
    const result = await performStagedBrowserCapture("tab-src-none", {});
    expect("source" in result).toBe(false);
    expect(result).toEqual({
      pngBase64: apiState.reply.pngBase64,
      width: 2560,
      height: 1440,
      logicalWidth: 1280,
      logicalHeight: 720,
      clamped: false,
    });
  });

  it("a junk source on the wire is DROPPED (only the two known strings survive)", async () => {
    apiState.reply = {
      pngBase64: "aW1n".repeat(40),
      width: 2560,
      height: 1440,
      // Simulate a future/buggy sidecar sending an unknown marker — the
      // threading must not pass it through as if it meant something.
      source: "hologram" as "window" | "screen",
    };
    const result = await performStagedBrowserCapture("tab-src-junk", {});
    expect("source" in result).toBe(false);
  });

  // ── R124: the DEFERRED HIDE — a surface that unmounted mid-capture ─────
  // The owner's ruling #3 scenario IN FLIGHT: the user swaps to Settings
  // (the route unmounts every BrowserPanel) while the staged grab is still
  // running. The panel's unmount cleanup defers its hide instead of hiding
  // NOW; the capture's restore consumes the defer — the webview ends HIDDEN
  // (the background-tab contract) even though the pre-stage truth was
  // visible, and the raster was never corrupted by a mid-grab hide.
  it("a deferred hide (a panel unmounted mid-capture) WINS over the pre-stage visibility at the restore", async () => {
    await nativeTabSetBounds("tab-defer", 0, 0, 800, 600);
    // The defer lands MID-CAPTURE (the realistic point: the unmount happens
    // while the grab pends) — hooked onto the sidecar POST.
    captureMock.mockImplementationOnce(async (region) => {
      apiState.regions.push(region);
      deferTabHideUntilCaptureRestores("tab-defer");
      return apiState.reply;
    });
    const result = await performStagedBrowserCapture("tab-defer", { expectVisible: true });
    expect(result.logicalWidth).toBe(1280);
    // The pre-stage truth was VISIBLE, so the stage issued NO visibility
    // command — but the RESTORE ends it hidden: the deferred hide (the
    // unmounted panel's contract) wins over the pre-stage truth. No
    // floating webview over the user's next route.
    expect(setVisibleMock).toHaveBeenCalledTimes(1);
    expect(setVisibleMock).toHaveBeenLastCalledWith("tab-defer", false);
    // The sweep found nothing left over (the defer was consumed by the
    // visibility restore — exactly ONE visibility command in total).
    expect(stagedCaptureInFlightTab()).toBeNull();
  });

  it("a defer landing in the restore's TAIL (the unmount raced the capture's end) is swept — still hidden, never leaked", async () => {
    await nativeTabSetBounds("tab-sweep", 0, 0, 800, 600);
    // The defer lands inside onRestored — AFTER the visibility restore has
    // already re-commanded the pre-stage truth, BEFORE the latch clears:
    // the post-latch sweep's exact window.
    const result = await performStagedBrowserCapture("tab-sweep", {
      expectVisible: true,
      onRestored: () => {
        deferTabHideUntilCaptureRestores("tab-sweep");
      },
    });
    expect(result.logicalWidth).toBe(1280);
    // The restore re-commanded the pre-stage truth FIRST (visible)…
    expect(setVisibleMock).toHaveBeenCalledWith("tab-sweep", true);
    // …then the sweep applied the late defer: the LAST visibility command
    // is the hide, and nothing leaks into a later capture.
    expect(setVisibleMock).toHaveBeenLastCalledWith("tab-sweep", false);
    expect(setVisibleMock).toHaveBeenCalledTimes(2);
    // A FOLLOW-UP capture on the same tab restores normally (no stale defer
    // hides it wrongly — the leak law).
    setVisibleMock.mockClear();
    const second = await performStagedBrowserCapture("tab-sweep", { expectVisible: true });
    expect(second.logicalWidth).toBe(1280);
    expect(setVisibleMock).toHaveBeenLastCalledWith("tab-sweep", true);
    expect(setVisibleMock).toHaveBeenCalledTimes(1);
  });
});
