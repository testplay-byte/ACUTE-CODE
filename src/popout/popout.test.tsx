// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PopoutApp } from "./PopoutApp";
import { normalizeAddressInput } from "./url";
import { POPOUT_TAB_ID } from "./popout-tab";

/**
 * ROUND-59 (R59-b) — unit tests for the pop-out browser window's custom
 * chrome page.
 *
 * The Tauri global is faked with a minimal `__TAURI__` stub (the
 * TitleBar.test.tsx / native-browser.test.tsx patterns — `isTauri()` from
 * lib/sidecar stays REAL so the web-mode notice is tested through the actual
 * shell detection, and the native-browser bridge runs unmocked so the
 * invoke ARGUMENT MAPPING (camelCase JS keys → snake_case Rust parameters)
 * is what's under test, exactly like native-browser.test.tsx). The stub's
 * `core.invoke` doubles as the command recorder; its `event.listen` captures
 * the page's subscriptions (tauri://resize, browser-navigated,
 * popout-navigate) so tests can fire them like the Rust side would.
 *
 * ROUND-60 (R60-A): the stub also answers `browser_tab_scroll_state` (JSON
 * strings, the Rust wire shape) and records `browser_tab_scroll_to`, so the
 * content CARD + GUTTER scrollbar integration rides the same wiring — the
 * component's own unit tests live in GutterScrollbar.test.tsx.
 */

type StubWindow = {
  label: string;
  minimize: ReturnType<typeof vi.fn>;
  toggleMaximize: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  isMaximized: ReturnType<typeof vi.fn>;
};

type InvokeCall = { cmd: string; args?: Record<string, unknown> };

interface StubOptions {
  /** What `popout_initial_url` resolves with (default: a start URL). */
  initialUrl?: string | null;
  /** What `browser_tab_url` resolves with (default: reject = no webview). */
  existingUrl?: string | null;
  /** When set, `browser_tab_create` rejects with this message. */
  createError?: string;
  /** Drives the maximize-icon swap (default: always false). */
  isMaximized?: () => Promise<boolean>;
  /** R60-A: what `browser_tab_scroll_state` resolves with (default: null —
   * a non-string payload, which the bridge maps to "no data" → hidden). */
  scrollState?: () => string;
}

/** Installs a capturable `window.__TAURI__` (cleared by unstubAllGlobals). */
function stubTauri(options: StubOptions = {}): {
  win: StubWindow;
  calls: InvokeCall[];
  listeners: Map<string, (ev: { payload: unknown }) => void>;
  listen: ReturnType<typeof vi.fn>;
} {
  const calls: InvokeCall[] = [];
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "browser_tab_url") {
      if (options.existingUrl) return options.existingUrl;
      // The expected boot state — no webview yet (popoutCurrentUrl swallows).
      throw new Error(`no native webview for tab "${POPOUT_TAB_ID}"`);
    }
    if (cmd === "popout_initial_url") {
      return options.initialUrl === undefined ? "https://example.com/start" : options.initialUrl;
    }
    if (cmd === "browser_tab_create" && options.createError !== undefined) {
      throw new Error(options.createError);
    }
    if (cmd === "browser_tab_scroll_state" && options.scrollState !== undefined) {
      return options.scrollState();
    }
    return null;
  });
  const listeners = new Map<string, (ev: { payload: unknown }) => void>();
  const listen = vi.fn((event: string, handler: (ev: { payload: unknown }) => void) => {
    listeners.set(event, handler);
    return Promise.resolve(vi.fn());
  });
  const win: StubWindow = {
    label: "acute-browser",
    minimize: vi.fn(() => Promise.resolve()),
    toggleMaximize: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    isMaximized: vi.fn(() =>
      options.isMaximized ? options.isMaximized() : Promise.resolve(false),
    ),
  };
  vi.stubGlobal("__TAURI__", {
    core: { invoke },
    event: { listen },
    window: { getCurrentWindow: () => win },
  });
  return { win, calls, listeners, listen };
}

/** Fires one captured listener (like the Rust emit would). */
function fire(listeners: Map<string, (ev: { payload: unknown }) => void>, event: string, payload: unknown): void {
  const handler = listeners.get(event);
  if (handler === undefined) throw new Error(`no listener for ${event}`);
  handler({ payload });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks(); // the R60-A geometry spies (getBoundingClientRect)
  cleanup();
});

/** R60-A: pins every element's rect to a fixed 200px-tall box — the gutter
 *  scrollbar measures its track through getBoundingClientRect ONLY, so one
 *  mock pins the whole thumb math (the bounds sync over the placeholder
 *  reads the same mocked rect; the tests never assert its values). */
function mockRects(height = 200): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 800,
    height,
    top: 0,
    left: 0,
    right: 800,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

describe("normalizeAddressInput (the URL-or-search heuristic)", () => {
  it("a plain term becomes a DuckDuckGo search", () => {
    expect(normalizeAddressInput("hello world")).toBe("https://duckduckgo.com/?q=hello%20world");
  });

  it("a bare domain gets https:// prefixed (path, query and hash kept)", () => {
    expect(normalizeAddressInput("example.com")).toBe("https://example.com");
    expect(normalizeAddressInput("example.com/docs?x=1#frag")).toBe("https://example.com/docs?x=1#frag");
  });

  it("explicit http(s) URLs pass through unchanged", () => {
    expect(normalizeAddressInput("http://example.com")).toBe("http://example.com");
    expect(normalizeAddressInput("https://example.com/a?b#c")).toBe("https://example.com/a?b#c");
  });

  it("other schemes with :// pass through (the same chain as the panel)", () => {
    expect(normalizeAddressInput("ftp://files.example.com")).toBe("ftp://files.example.com");
  });

  it("whitespace-only input is a no-op", () => {
    expect(normalizeAddressInput("   ")).toBe("");
  });
});

describe("PopoutApp — web mode", () => {
  it("shows the honest needs-the-desktop-app notice instead of chrome", () => {
    render(<PopoutApp />);
    expect(screen.getByTestId("popout-web-notice")).toBeTruthy();
    expect(screen.getByText("The pop-out browser needs the desktop app")).toBeTruthy();
    // No chrome in web mode — nothing to click, nothing to crash on.
    expect(screen.queryByRole("button", { name: /window/i })).toBeNull();
    expect(screen.queryByTestId("popout-address-input")).toBeNull();
    expect(screen.queryByTestId("popout-root")).toBeNull();
  });
});

describe("PopoutApp — the custom title bar (Tauri chrome)", () => {
  it("renders the drag-region bar, the Acute Browser identity, and the three controls", () => {
    stubTauri();
    const { container } = render(<PopoutApp />);

    const bar = container.querySelector("header") as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.hasAttribute("data-tauri-drag-region")).toBe(true);
    // App identity for the browser window.
    expect(screen.getByText("ACUTE BROWSER")).toBeTruthy();

    expect(screen.getByRole("button", { name: "Minimize window" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Maximize window" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close window" })).toBeTruthy();
  });

  it("each control drives exactly its own window method", () => {
    const { win } = stubTauri();
    render(<PopoutApp />);

    fireEvent.click(screen.getByRole("button", { name: "Minimize window" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize window" }));
    fireEvent.click(screen.getByRole("button", { name: "Close window" }));

    // No cross-talk: each method was called exactly once.
    expect(win.minimize).toHaveBeenCalledTimes(1);
    expect(win.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it("queries isMaximized on mount and subscribes to tauri://resize", async () => {
    const { win, listen } = stubTauri();
    render(<PopoutApp />);

    await waitFor(() => expect(win.isMaximized).toHaveBeenCalledTimes(1));
    expect(listen).toHaveBeenCalledWith("tauri://resize", expect.any(Function));
  });

  it("swaps maximize → restore when tauri://resize says the window maximized", async () => {
    let maximized = false;
    const { win, listeners } = stubTauri({ isMaximized: () => Promise.resolve(maximized) });
    render(<PopoutApp />);

    // Starts unmaximized (mount query).
    await waitFor(() => expect(win.isMaximized).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Maximize window" })).toBeTruthy();

    // The window maximized from OUTSIDE our buttons (drag-region
    // double-click, Aero Snap) — the resize handler re-queries and swaps.
    maximized = true;
    fire(listeners, "tauri://resize", null);
    await waitFor(() => expect(screen.getByRole("button", { name: "Restore window" })).toBeTruthy());
    expect(win.isMaximized).toHaveBeenCalledTimes(2);
  });
});

describe("PopoutApp — URL bar and the content webview", () => {
  it("boot: reads the stashed initial URL and creates the webview in the POP-OUT window, then positions + shows it", async () => {
    const { calls } = stubTauri();
    render(<PopoutApp />);

    await waitFor(() => {
      const create = calls.find((c) => c.cmd === "browser_tab_create");
      expect(create).toBeDefined();
      expect(create?.args).toEqual({
        tabId: "popout",
        url: "https://example.com/start",
        windowLabel: "acute-browser",
        // R60: the pop-out hides the page's viewport scrollbar — the window
        // paints its own gutter bar OUTSIDE the content card.
        hideViewportScrollbar: true,
      });
    });
    // The position sync over the placeholder ran too (bounds + visible).
    await waitFor(() => {
      expect(calls.some((c) => c.cmd === "browser_tab_set_bounds")).toBe(true);
      expect(
        calls.some((c) => c.cmd === "browser_tab_set_visible" && c.args?.visible === true),
      ).toBe(true);
    });
    // The address bar shows where we are.
    await waitFor(() =>
      expect((screen.getByTestId("popout-address-input") as HTMLInputElement).value).toBe(
        "https://example.com/start",
      ),
    );
  });

  it("Enter on a plain term navigates through the URL-or-search heuristic", async () => {
    const { calls } = stubTauri();
    render(<PopoutApp />);
    await waitFor(() => expect(calls.some((c) => c.cmd === "browser_tab_create")).toBe(true));

    const input = screen.getByTestId("popout-address-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "hello world" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => {
      const create = calls.filter((c) => c.cmd === "browser_tab_create").at(-1);
      expect(create?.args).toEqual({
        tabId: "popout",
        url: "https://duckduckgo.com/?q=hello%20world",
        windowLabel: "acute-browser",
        hideViewportScrollbar: true,
      });
    });
  });

  it("the Go affordance button navigates too (not only Enter)", async () => {
    const { calls } = stubTauri();
    render(<PopoutApp />);
    await waitFor(() => expect(calls.some((c) => c.cmd === "browser_tab_create")).toBe(true));

    const input = screen.getByTestId("popout-address-input");
    fireEvent.change(input, { target: { value: "example.com" } });
    fireEvent.click(screen.getByTestId("popout-go"));

    await waitFor(() => {
      const create = calls.filter((c) => c.cmd === "browser_tab_create").at(-1);
      expect(create?.args).toMatchObject({ url: "https://example.com" });
    });
  });

  it("back / forward / reload drive browser_tab_go with the right direction", async () => {
    const { calls } = stubTauri();
    render(<PopoutApp />);
    await waitFor(() => expect(calls.some((c) => c.cmd === "browser_tab_create")).toBe(true));

    fireEvent.click(screen.getByTestId("popout-back"));
    fireEvent.click(screen.getByTestId("popout-forward"));
    fireEvent.click(screen.getByTestId("popout-reload"));

    await waitFor(() => {
      const directions = calls
        .filter((c) => c.cmd === "browser_tab_go")
        .map((c) => c.args?.direction);
      expect(directions).toEqual(["back", "forward", "reload"]);
    });
  });

  it("focus guard: a navigation event never overwrites the field mid-edit; blur falls back to the live URL", async () => {
    const { listeners, calls } = stubTauri();
    render(<PopoutApp />);
    await waitFor(() => expect(calls.some((c) => c.cmd === "browser_tab_create")).toBe(true));

    const input = screen.getByTestId("popout-address-input") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "typing something" } });

    // The page navigated underneath (a link click inside the webview).
    fire(listeners, "browser-navigated", { tab_id: "popout", url: "https://elsewhere.example/" });
    await waitFor(() => expect(input.value).toBe("typing something"));

    // Blurring falls back to the live URL — never stale typing.
    fireEvent.blur(input);
    await waitFor(() => expect(input.value).toBe("https://elsewhere.example/"));
  });

  it("navigation events for OTHER tabs are ignored (the panel's tabs never leak in)", async () => {
    const { listeners, calls } = stubTauri();
    render(<PopoutApp />);
    const input = screen.getByTestId("popout-address-input") as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("https://example.com/start"));
    await waitFor(() => expect(calls.some((c) => c.cmd === "browser_tab_create")).toBe(true));

    fire(listeners, "browser-navigated", { tab_id: "tab-xyz", url: "https://other.example/" });
    expect(input.value).toBe("https://example.com/start");
  });

  it("a popout-navigate event (open_browser_window racing the mount) creates + navigates", async () => {
    const { listeners, calls } = stubTauri();
    render(<PopoutApp />);
    await waitFor(() => expect(calls.some((c) => c.cmd === "browser_tab_create")).toBe(true));

    fire(listeners, "popout-navigate", { url: "https://raced.example/" });

    await waitFor(() => {
      const create = calls.filter((c) => c.cmd === "browser_tab_create").at(-1);
      expect(create?.args).toMatchObject({ url: "https://raced.example/" });
    });
  });

  it("Open in system browser invokes open_external_url with the current URL", async () => {
    const { calls } = stubTauri();
    render(<PopoutApp />);
    await waitFor(() => expect(calls.some((c) => c.cmd === "browser_tab_create")).toBe(true));

    fireEvent.click(screen.getByTestId("popout-open-external"));

    await waitFor(() => {
      expect(
        calls.some((c) => c.cmd === "open_external_url" && c.args?.url === "https://example.com/start"),
      ).toBe(true);
    });
  });

  it("a failing create surfaces an honest error banner (dismissable, never a crash)", async () => {
    stubTauri({ createError: "create failed" });
    render(<PopoutApp />);

    const banner = await waitFor(() => expect(screen.getByTestId("popout-error")).toBeTruthy());
    void banner;
    expect(screen.getByTestId("popout-error").textContent).toContain("create failed");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByTestId("popout-error")).toBeNull());
    // The chrome survives the failure.
    expect(screen.getByRole("button", { name: "Minimize window" })).toBeTruthy();
  });

  it("no stashed URL → the idle empty state; the first Go creates the webview", async () => {
    const { calls } = stubTauri({ initialUrl: null });
    render(<PopoutApp />);

    await waitFor(() => expect(calls.some((c) => c.cmd === "popout_initial_url")).toBe(true));
    // Boot finished WITHOUT a create (and without the booting spinner).
    await waitFor(() => expect(screen.queryByTestId("popout-booting")).toBeNull());
    expect(calls.some((c) => c.cmd === "browser_tab_create")).toBe(false);

    // …and the first address submission creates it.
    const input = screen.getByTestId("popout-address-input");
    fireEvent.change(input, { target: { value: "example.com" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() => expect(calls.some((c) => c.cmd === "browser_tab_create")).toBe(true));
  });

  it("a surviving webview (page reload) is ADOPTED, not re-navigated back to the stash", async () => {
    const { calls } = stubTauri({ existingUrl: "https://where-i-was.example/" });
    render(<PopoutApp />);

    await waitFor(() =>
      expect((screen.getByTestId("popout-address-input") as HTMLInputElement).value).toBe(
        "https://where-i-was.example/",
      ),
    );
    // Neither the stash read nor a create happened — the webview's own
    // position was adopted.
    expect(calls.some((c) => c.cmd === "popout_initial_url")).toBe(false);
    expect(calls.some((c) => c.cmd === "browser_tab_create")).toBe(false);
    // But its position/visibility were re-asserted over the placeholder.
    await waitFor(() => expect(calls.some((c) => c.cmd === "browser_tab_set_bounds")).toBe(true));
  });
});

describe("PopoutApp — R60-A: the rounded content card + the gutter scrollbar", () => {
  it("the content placeholder sits INSIDE a rounded, bordered card (the view reads rounded like the chrome)", async () => {
    const { calls } = stubTauri();
    render(<PopoutApp />);
    await waitFor(() => expect(calls.some((c) => c.cmd === "browser_tab_create")).toBe(true));

    // The placeholder keeps its testid and stays the webview's rectangle…
    const placeholder = screen.getByTestId("popout-content");
    // …but its parent is now the visible CARD — rounded 14px with a 1.5px
    // subtle border (the title-bar/URL-bar card language).
    const card = placeholder.parentElement as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.className).toContain("rounded-[14px]");
    expect(card.className).toContain("border-[1.5px]");
    expect(card.className).toContain("flex-1");
    expect(card.style.borderColor).toBe("var(--ac-border-subtle)");
    // The placeholder is inset 4px inside the card, so the (square) webview
    // floats inside the visible rounded frame — never over its corners.
    expect(placeholder.className).toContain("inset-[4px]");
  });

  it("the gutter scrollbar column renders OUTSIDE the content card (in the window frame)", async () => {
    const { calls } = stubTauri();
    render(<PopoutApp />);
    await waitFor(() => expect(calls.some((c) => c.cmd === "browser_tab_create")).toBe(true));

    const gutter = screen.getByTestId("popout-gutter-scrollbar");
    const card = screen.getByTestId("popout-content").parentElement as HTMLElement;
    // Siblings inside the content row: the scrollbar is NOT inside the card.
    expect(gutter.parentElement).toBe(card.parentElement);
    expect(card.contains(gutter)).toBe(false);
    // With no scroll state (the default stub) it renders nothing visible —
    // no second scrollbar before a page even exists.
    expect(screen.queryByTestId("popout-gutter-thumb")).toBeNull();
    expect(screen.queryByRole("scrollbar")).toBeNull();
  });

  it("an overflowing page (css applied) shows the themed thumb through the full app wiring", async () => {
    mockRects(200);
    const { calls } = stubTauri({
      scrollState: () => JSON.stringify({ y: 100, vh: 400, ch: 1600, css: true }),
    });
    render(<PopoutApp />);

    // T=200, vh=400, ch=1600 → thumbH = 50; y=100 → top = 150 * 100/1200.
    const thumb = await waitFor(() => screen.getByTestId("popout-gutter-thumb"));
    expect(thumb.style.height).toBe("50px");
    expect(thumb.style.top).toBe("12.5px");
    // The poll probed the pop-out's OWN tab through the real bridge.
    await waitFor(() =>
      expect(
        calls.some((c) => c.cmd === "browser_tab_scroll_state" && c.args?.tabId === POPOUT_TAB_ID),
      ).toBe(true),
    );
  });

  it("a CSP-strict page (css:false) keeps the gutter hidden — the page's own scrollbar stays the ONE", async () => {
    mockRects(200);
    stubTauri({
      scrollState: () => JSON.stringify({ y: 100, vh: 400, ch: 1600, css: false }),
    });
    render(<PopoutApp />);

    await actPromise();
    expect(screen.getByTestId("popout-gutter-scrollbar")).toBeTruthy();
    expect(screen.queryByTestId("popout-gutter-thumb")).toBeNull();
  });
});

/** Flushes the mount poll's microtask chain without waitFor noise. */
async function actPromise(): Promise<void> {
  await act(async () => {});
}
