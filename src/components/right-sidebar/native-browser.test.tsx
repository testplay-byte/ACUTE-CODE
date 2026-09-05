// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
/**
 * ROUND-50 (R50-a) — unit tests for the native embedded browser's pure
 * helpers: `computeNativeBounds` (BrowserPanel.tsx — the geometry that
 * positions a child webview over the panel's page area) and the
 * `native-browser.ts` bridge (typed wrappers over the Rust `browser_tab_*`
 * commands + the `browser-navigated` event subscription).
 *
 * The Tauri global is faked with a minimal `__TAURI__` stub — the contract
 * under test is the ARGUMENT MAPPING (camelCase JS keys → snake_case Rust
 * parameters) and the no-op fallback outside Tauri, not Tauri itself.
 */
import { computeNativeBounds } from "./BrowserPanel";
import {
  isNativeBrowserAvailable,
  nativeInvoke,
  // R67/E2: the WebView2 double-encoding normalizer + the eval/scroll probes.
  nativeTabEval,
  nativeTabScrollState,
  parseWebViewEvalJson,
  nativeTabClose,
  nativeTabCreate,
  nativeTabGo,
  nativeTabNavigate,
  nativeTabSetBounds,
  nativeTabSetVisible,
  nativeTabUrl,
  nativeTabsCloseAll,
  onBrowserNavigated,
  openExternalUrl,
} from "../../lib/native-browser";

const AREA = { left: 80, top: 120, width: 400, height: 500 };

describe("computeNativeBounds (R50-a native geometry · R62 aspect-fit)", () => {
  it("natural mode (viewport null) fills the area exactly, scale 1", () => {
    expect(computeNativeBounds(AREA, null)).toEqual({ x: 80, y: 120, w: 400, h: 500, scale: 1 });
  });

  it("a preset smaller than the area renders 1:1 centered (scale 1)", () => {
    expect(computeNativeBounds(AREA, { width: 200, height: 100 })).toEqual({
      x: 80 + (400 - 200) / 2,
      y: 120 + (500 - 100) / 2,
      w: 200,
      h: 100,
      scale: 1,
    });
  });

  it("R62: a preset larger than the area is ASPECT-FIT — never clamped (owner: 'the view is not respecting the dimensions set by the user')", () => {
    // 1280×800 into 400×500 → scale 0.3125 → 400×250, centered vertically.
    // The page still sees 1280×800 CSS px (the caller composes the scale
    // into the DPI zoom) — the panel shows a scaled-down VIEW of the true
    // preset instead of a clamped 400px layout.
    const b = computeNativeBounds(AREA, { width: 1280, height: 800 });
    expect(b.scale).toBeCloseTo(0.3125);
    expect(b.w).toBe(400);
    expect(b.h).toBe(250);
    expect(b.x).toBe(80);
    expect(b.y).toBe(120 + (500 - 250) / 2);
  });

  it("R62: the fit is bound by the TIGHTER dimension (aspect preserved)", () => {
    // 200 fits horizontally; 1000 overflows vertically → scale 0.5 →
    // 100×500 centered horizontally. (The pre-R62 per-dimension clamp
    // stretched the preset to the area's shape — the shape lie.)
    expect(computeNativeBounds(AREA, { width: 200, height: 1000 })).toEqual({
      x: 80 + (400 - 100) / 2,
      y: 120,
      w: 100,
      h: 500,
      scale: 0.5,
    });
  });

  it("degenerate (zero) dimensions collapse to 1px, never a zero-sized webview", () => {
    expect(computeNativeBounds({ left: 0, top: 0, width: 0, height: 0 }, null)).toEqual({
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      scale: 1,
    });
    // Zero area + preset: the 0.05 scale floor keeps the webview alive
    // (1×1) instead of dividing by zero.
    const b = computeNativeBounds({ left: 0, top: 0, width: 0, height: 0 }, { width: 300, height: 300 });
    expect(b.w).toBeGreaterThanOrEqual(1);
    expect(b.h).toBeGreaterThanOrEqual(1);
  });

  it("non-finite measurements collapse to 1px instead of NaN", () => {
    expect(computeNativeBounds({ left: 10, top: 10, width: Number.NaN, height: 100 }, null)).toEqual({
      x: 10,
      y: 10,
      w: 1,
      h: 100,
      scale: 1,
    });
    expect(computeNativeBounds({ left: 10, top: 10, width: 100, height: Number.NaN }, null)).toEqual({
      x: 10,
      y: 10,
      w: 100,
      h: 1,
      scale: 1,
    });
  });
});

/** A minimal `window.__TAURI__` fake capturing every invoke. */
function stubTauri(invokeImpl?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>): {
  calls: Array<{ cmd: string; args?: Record<string, unknown> }>;
  listen: ReturnType<typeof vi.fn>;
} {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    return invokeImpl ? invokeImpl(cmd, args) : undefined;
  });
  const listen = vi.fn(() => Promise.resolve(vi.fn()));
  vi.stubGlobal("__TAURI__", { core: { invoke }, event: { listen } });
  return { calls, listen };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("native-browser bridge (R50-a wrappers)", () => {
  it("outside Tauri everything is a safe no-op", async () => {
    expect(isNativeBrowserAvailable()).toBe(false);
    expect(nativeInvoke()).toBeNull();
    // All command wrappers resolve (never throw, never reject).
    await expect(nativeTabCreate("t1", "https://example.com")).resolves.toBeUndefined();
    await expect(nativeTabNavigate("t1", "https://example.com")).resolves.toBeUndefined();
    await expect(nativeTabSetBounds("t1", 0, 0, 10, 10)).resolves.toBeUndefined();
    await expect(nativeTabSetVisible("t1", true)).resolves.toBeUndefined();
    await expect(nativeTabGo("t1", "back")).resolves.toBeUndefined();
    await expect(nativeTabClose("t1")).resolves.toBeUndefined();
    await expect(nativeTabsCloseAll()).resolves.toBeUndefined();
    await expect(nativeTabUrl("t1")).resolves.toBeNull();
    // R58-b: the OS-browser handoff degrades to a no-op too (web mode keeps
    // its own window.open path).
    await expect(openExternalUrl("https://example.com")).resolves.toBeUndefined();
    // The event subscription is a permanent no-op and returns an unlisten.
    let fired = 0;
    const unlisten = onBrowserNavigated(() => {
      fired += 1;
    });
    expect(typeof unlisten).toBe("function");
    expect(() => unlisten()).not.toThrow();
    expect(fired).toBe(0);
  });

  it("inside Tauri the wrappers map to the Rust commands with camelCase args", async () => {
    const { calls } = stubTauri();
    expect(isNativeBrowserAvailable()).toBe(true);

    await nativeTabCreate("tab-1", "https://example.com");
    await nativeTabNavigate("tab-1", "https://example.com/page");
    await nativeTabSetBounds("tab-1", 12.5, 30, 400.5, 600);
    await nativeTabSetVisible("tab-1", false);
    await nativeTabGo("tab-1", "reload");
    await nativeTabClose("tab-1");
    await nativeTabsCloseAll();
    await nativeTabUrl("tab-1");
    // R58-b: the BrowserPanel's "Open externally" affordance (OS default
    // browser handoff — window.open inside WebView2 is swallowed).
    await openExternalUrl("https://example.com/externally");

    expect(calls).toEqual([
      { cmd: "browser_tab_create", args: { tabId: "tab-1", url: "https://example.com" } },
      { cmd: "browser_tab_navigate", args: { tabId: "tab-1", url: "https://example.com/page" } },
      { cmd: "browser_tab_set_bounds", args: { tabId: "tab-1", x: 12.5, y: 30, w: 400.5, h: 600 } },
      { cmd: "browser_tab_set_visible", args: { tabId: "tab-1", visible: false } },
      { cmd: "browser_tab_go", args: { tabId: "tab-1", direction: "reload" } },
      { cmd: "browser_tab_close", args: { tabId: "tab-1" } },
      { cmd: "browser_tabs_close_all", args: undefined },
      { cmd: "browser_tab_url", args: { tabId: "tab-1" } },
      { cmd: "open_external_url", args: { url: "https://example.com/externally" } },
    ]);
  });

  it("nativeTabUrl returns the command's string result", async () => {
    stubTauri(async () => "https://example.com/live");
    await expect(nativeTabUrl("tab-1")).resolves.toBe("https://example.com/live");
  });

  it("command rejections propagate (the panel surfaces them)", async () => {
    stubTauri(async () => {
      throw "only http/https URLs are supported";
    });
    await expect(nativeTabCreate("t1", "ftp://nope")).rejects.toThrow(
      "only http/https URLs are supported",
    );
  });

  it("onBrowserNavigated unwraps the snake_case payload and unsubscribes via the resolved unlisten", async () => {
    let handler: ((ev: { payload: unknown }) => void) | null = null;
    const unlistenFn = vi.fn();
    vi.stubGlobal("__TAURI__", {
      core: { invoke: vi.fn() },
      event: {
        listen: vi.fn(async (_event: string, h: (ev: { payload: unknown }) => void) => {
          handler = h;
          return unlistenFn;
        }),
      },
    });

    const seen: Array<[string, string]> = [];
    const unlisten = onBrowserNavigated((tabId, url) => seen.push([tabId, url]));
    // The listen promise resolves asynchronously — let it land.
    await vi.waitFor(() => expect(handler).not.toBeNull());

    const emit = (payload: unknown) => (handler as (ev: { payload: unknown }) => void)({ payload });
    emit({ tab_id: "tab-1", url: "https://example.com/a" });
    emit({ tab_id: "tab-2", url: "https://example.com/b" }); // other tabs pass through verbatim
    emit({ tab_id: 42, url: "https://example.com/c" }); // malformed → ignored
    emit(null); // malformed → ignored
    expect(seen).toEqual([
      ["tab-1", "https://example.com/a"],
      ["tab-2", "https://example.com/b"],
    ]);

    unlisten();
    expect(unlistenFn).toHaveBeenCalledTimes(1);
  });

  it("onBrowserNavigated releases the listener when unsubscribed before listen resolves", async () => {
    let resolveListen!: (fn: () => void) => void;
    const unlistenFn = vi.fn();
    vi.stubGlobal("__TAURI__", {
      core: { invoke: vi.fn() },
      event: {
        listen: vi.fn(
          () =>
            new Promise<() => void>((resolve) => {
              resolveListen = resolve;
            }),
        ),
      },
    });

    const unlisten = onBrowserNavigated(() => {});
    unlisten(); // disposed BEFORE the listen promise resolves
    resolveListen(unlistenFn);
    await vi.waitFor(() => expect(unlistenFn).toHaveBeenCalledTimes(1));
  });
});

// ── ROUND-67 (R67/E2): the WebView2 eval double-encoding normalizer ─────────
describe("R67 parseWebViewEvalJson — the WebView2 double-encoding fix", () => {
  it("single-encoded (WebKit/webkitgtk shape) parses to the object after ONE parse", () => {
    const single = JSON.stringify({ ok: true, value: 42 });
    expect(parseWebViewEvalJson(single)).toEqual({ ok: true, value: 42 });
  });

  it("DOUBLE-encoded (WebView2 ExecuteScriptAsync shape) parses to the object after the tolerant second parse", () => {
    // The page script returned JSON.stringify({...}) — a STRING — so
    // WebView2's ExecuteScriptAsync delivers the JSON OF that string (the
    // outer quotes + escaping). The old single parse yielded the STRING,
    // data.ok was undefined, and every action failed with "the page
    // rejected the script" on real Windows.
    const payload = JSON.stringify({ ok: true, value: { title: "Google" } });
    const doubleEncoded = JSON.stringify(payload);
    expect(parseWebViewEvalJson(doubleEncoded)).toEqual({ ok: true, value: { title: "Google" } });
  });

  it("a non-JSON string survives as the raw string (the caller validates the shape)", () => {
    expect(parseWebViewEvalJson("plain text")).toBe("plain text");
    expect(parseWebViewEvalJson(JSON.stringify("inner text"))).toBe("inner text");
  });

  it("an object shape (no string round-trip) passes through", () => {
    // scroll-state style: a script returning an object literal would arrive
    // single-encoded; a script returning JSON.stringify arrives double —
    // both normalize to the same object.
    const obj = JSON.stringify({ y: 10, vh: 800, ch: 2000, css: true });
    expect(parseWebViewEvalJson(obj)).toEqual({ y: 10, vh: 800, ch: 2000, css: true });
    expect(parseWebViewEvalJson(JSON.stringify(obj))).toEqual({ y: 10, vh: 800, ch: 2000, css: true });
  });
});

describe("R67 nativeTabEval / nativeTabScrollState — both transports return data", () => {
  it("nativeTabEval: a DOUBLE-encoded eval reply yields {ok:true, value} (the Windows fix)", async () => {
    const payload = JSON.stringify({ ok: true, value: { clicked: { tag: "a" } } });
    stubTauri(async () => JSON.stringify(payload)); // the double-encoded string
    const result = await nativeTabEval("tab-1", "return 1");
    expect(result).toEqual({ ok: true, value: { clicked: { tag: "a" } } });
  });

  it("nativeTabEval: a SINGLE-encoded reply (web-mode/mock shape) still works", async () => {
    stubTauri(async () => JSON.stringify({ ok: true, value: null }));
    const result = await nativeTabEval("tab-1", "return null");
    expect(result).toEqual({ ok: true, value: null });
  });

  it("nativeTabEval: a payload that is still not the envelope reports honestly (no more silent 'page rejected the script')", async () => {
    stubTauri(async () => JSON.stringify("definitely not json"));
    const result = await nativeTabEval("tab-1", "return 1");
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("unexpected payload");
  });

  it("nativeTabScrollState: a DOUBLE-encoded probe reply yields the state (the Windows gutter-scrollbar fix)", async () => {
    const payload = JSON.stringify({ y: 12, vh: 800, ch: 4321, css: false });
    stubTauri(async () => JSON.stringify(payload));
    const state = await nativeTabScrollState("tab-1");
    expect(state).toEqual({ y: 12, vh: 800, ch: 4321, css: false });
  });

  it("nativeTabScrollState: a garbage reply returns null (never throws)", async () => {
    stubTauri(async () => "###");
    expect(await nativeTabScrollState("tab-1")).toBeNull();
  });
});
