// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GutterScrollbar } from "./GutterScrollbar";

/**
 * ROUND-60 (R60-A) — unit tests for the pop-out window's GUTTER scrollbar.
 *
 * The popout.test.tsx stub pattern, focused on the one component: a minimal
 * `__TAURI__` whose `core.invoke` records every command and answers
 * `browser_tab_scroll_state` with JSON strings (what the Rust command
 * actually returns — the parsing/validation path in native-browser.ts runs
 * unmocked, so the wire contract is what's under test) and records
 * `browser_tab_scroll_to` calls.
 *
 * Geometry: jsdom-style DOMs return 0 for every measurement, so each test
 * mocks HTMLElement.prototype.getBoundingClientRect with a fixed track rect
 * (the component deliberately measures ONLY through that one channel, so a
 * single mock pins the whole thumb math). Drag tests drive PointerEvents
 * with clientY — happy-dom implements PointerEvent, but NOT pointer capture,
 * which is exactly why the component guards every capture call.
 */

type InvokeCall = { cmd: string; args?: Record<string, unknown> };

interface StubOptions {
  /**
   * What `browser_tab_scroll_state` resolves with — a JSON string (the Rust
   * wire shape) or null to reject like "no native webview for tab". Default:
   * reject (the pre-boot state).
   */
  scrollState?: () => string | null;
  /** When set, `browser_tab_scroll_to` rejects with this message. */
  scrollToError?: string;
}

function stubTauri(options: StubOptions = {}): { calls: InvokeCall[] } {
  const calls: InvokeCall[] = [];
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "browser_tab_scroll_state") {
      const raw = options.scrollState === undefined ? null : options.scrollState();
      if (raw === null) throw new Error(`no native webview for tab "popout"`);
      return raw;
    }
    if (cmd === "browser_tab_scroll_to" && options.scrollToError !== undefined) {
      throw new Error(options.scrollToError);
    }
    return null;
  });
  vi.stubGlobal("__TAURI__", { core: { invoke } });
  return { calls };
}

/** The scroll-state JSON the Rust probe returns (snake-free: {y, vh, ch, css}). */
function stateJson(state: { y: number; vh: number; ch: number; css: boolean }): string {
  return JSON.stringify(state);
}

/** Pins EVERY element's rect to one fixed track box (height = the track height). */
function mockTrackRect(height: number, top = 0): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 12,
    height,
    top,
    left: 0,
    right: 12,
    bottom: top + height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect);
}

/** The one geometry every math test uses: T=200, vh=400, ch=1600, maxScroll=1200. */
const BASE = { y: 300, vh: 400, ch: 1600, css: true } as const;

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  cleanup();
});

describe("GutterScrollbar — visibility honesty", () => {
  it("hidden while there is no state (no webview yet: the invoke rejects) — the column still renders", async () => {
    mockTrackRect(200);
    const { calls } = stubTauri(); // default: reject like "no native webview"
    render(<GutterScrollbar tabId="popout" />);

    // Stable layout: the column exists, but nothing interactive renders.
    await act(async () => {});
    expect(screen.getByTestId("popout-gutter-scrollbar")).toBeTruthy();
    expect(screen.queryByTestId("popout-gutter-thumb")).toBeNull();
    expect(screen.queryByRole("scrollbar")).toBeNull();
    expect(screen.queryByTestId("popout-gutter-track")).toBeNull();
    // The poll still ran (and keeps running — the webview may appear later).
    expect(calls.some((c) => c.cmd === "browser_tab_scroll_state")).toBe(true);
  });

  it("hidden when css is false — a CSP-strict page keeps its OWN viewport bar (never two scrollbars)", async () => {
    mockTrackRect(200);
    stubTauri({ scrollState: () => stateJson({ y: 300, vh: 400, ch: 1600, css: false }) });
    render(<GutterScrollbar tabId="popout" />);

    await act(async () => {});
    expect(screen.queryByTestId("popout-gutter-thumb")).toBeNull();
    expect(screen.queryByRole("scrollbar")).toBeNull();
  });

  it("hidden when the page does not overflow (ch <= vh + 2)", async () => {
    mockTrackRect(200);
    stubTauri({ scrollState: () => stateJson({ y: 0, vh: 800, ch: 800, css: true }) });
    render(<GutterScrollbar tabId="popout" />);

    await act(async () => {});
    expect(screen.queryByTestId("popout-gutter-thumb")).toBeNull();

    // …and again at exactly the +2 tolerance edge.
    cleanup();
    vi.unstubAllGlobals();
    stubTauri({ scrollState: () => stateJson({ y: 0, vh: 800, ch: 802, css: true }) });
    render(<GutterScrollbar tabId="popout" />);
    await act(async () => {});
    expect(screen.queryByTestId("popout-gutter-thumb")).toBeNull();
  });

  it("hidden when the track measures 0 (degenerate layout never paints a pill)", async () => {
    stubTauri({ scrollState: () => stateJson({ ...BASE }) });
    render(<GutterScrollbar tabId="popout" />); // no rect mock → 0 height

    await act(async () => {});
    expect(screen.queryByTestId("popout-gutter-thumb")).toBeNull();
  });

  it("visible with overflow: the thumb's height and position come from the probed geometry", async () => {
    mockTrackRect(200);
    const { calls } = stubTauri({ scrollState: () => stateJson({ ...BASE }) });
    render(<GutterScrollbar tabId="popout" />);

    const thumb = await waitFor(() => screen.getByTestId("popout-gutter-thumb"));
    // T=200, vh=400, ch=1600 → thumbH = 200*400/1600 = 50;
    // maxScroll=1200, y=300 → thumbTop = (200-50) * 300/1200 = 37.5.
    expect(thumb.style.height).toBe("50px");
    expect(thumb.style.top).toBe("37.5px");

    // The track carries the full scrollbar semantics.
    const track = screen.getByRole("scrollbar");
    expect(track.getAttribute("aria-label")).toBe("Page scroll position");
    expect(track.getAttribute("aria-orientation")).toBe("vertical");
    expect(track.getAttribute("aria-valuemin")).toBe("0");
    expect(track.getAttribute("aria-valuemax")).toBe("1200");
    expect(track.getAttribute("aria-valuenow")).toBe("300");

    // The poll probed the RIGHT tab through the real bridge argument mapping.
    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "browser_tab_scroll_state" && c.args?.tabId === "popout")).toBe(true),
    );
  });

  it("the thumb never shrinks below the 24px grab floor", async () => {
    mockTrackRect(200);
    stubTauri({ scrollState: () => stateJson({ y: 0, vh: 20, ch: 10000, css: true }) });
    render(<GutterScrollbar tabId="popout" />);

    const thumb = await waitFor(() => screen.getByTestId("popout-gutter-thumb"));
    // Proportional would be 200*20/10000 = 0.4px — unusable; the floor wins.
    expect(thumb.style.height).toBe("24px");
  });
});

describe("GutterScrollbar — drag and track clicks", () => {
  it("dragging the thumb fires browser_tab_scroll_to with the mapped, clamped offset", async () => {
    mockTrackRect(200);
    const { calls } = stubTauri({
      scrollState: () => stateJson({ y: 0, vh: 200, ch: 1000, css: true }),
    });
    render(<GutterScrollbar tabId="popout" />);
    const thumb = await waitFor(() => screen.getByTestId("popout-gutter-thumb"));

    // T=200, vh=200, ch=1000 → thumbH=40, maxScroll=800. Grab the thumb at
    // its 20px mark, drag to clientY 100 → (100-0-20)/(200-40)*800 = 400.
    fireEvent.pointerDown(thumb, { pointerId: 1, clientY: 20 });
    fireEvent.pointerMove(thumb, { pointerId: 1, clientY: 100 });
    await waitFor(() =>
      expect(
        calls.some((c) => c.cmd === "browser_tab_scroll_to" && c.args?.y === 400),
      ).toBe(true),
    );

    // Drag far past the end → clamped to maxScroll (800), never beyond.
    fireEvent.pointerMove(thumb, { pointerId: 1, clientY: 600 });
    await waitFor(() =>
      expect(
        calls.some((c) => c.cmd === "browser_tab_scroll_to" && c.args?.y === 800),
      ).toBe(true),
    );
    expect(calls.some((c) => c.cmd === "browser_tab_scroll_to" && (c.args?.y as number) > 800)).toBe(false);

    // Drag above the top → clamped to 0, never negative.
    fireEvent.pointerMove(thumb, { pointerId: 1, clientY: -400 });
    await waitFor(() =>
      expect(
        calls.some((c) => c.cmd === "browser_tab_scroll_to" && c.args?.y === 0),
      ).toBe(true),
    );

    // pointerup ends the session (a move afterwards moves nothing).
    fireEvent.pointerUp(thumb, { pointerId: 1, clientY: -400 });
    const count = calls.filter((c) => c.cmd === "browser_tab_scroll_to").length;
    fireEvent.pointerMove(thumb, { pointerId: 1, clientY: 150 });
    await new Promise((r) => setTimeout(r, 60)); // let any stray rAF fire
    expect(calls.filter((c) => c.cmd === "browser_tab_scroll_to").length).toBe(count);

    // The drag target always carried the tab id.
    expect(
      calls.every((c) => c.cmd !== "browser_tab_scroll_to" || c.args?.tabId === "popout"),
    ).toBe(true);
  });

  it("the thumb follows the pointer OPTIMISTICALLY (no poll round-trip per move)", async () => {
    mockTrackRect(200);
    stubTauri({ scrollState: () => stateJson({ y: 0, vh: 200, ch: 1000, css: true }) });
    render(<GutterScrollbar tabId="popout" />);
    const thumb = await waitFor(() => screen.getByTestId("popout-gutter-thumb"));
    const track = screen.getByRole("scrollbar");

    // Before: y=0 → thumbTop 0. Drag to y=400 → thumbTop = 160*(400/800) = 80.
    fireEvent.pointerDown(thumb, { pointerId: 1, clientY: 20 });
    fireEvent.pointerMove(thumb, { pointerId: 1, clientY: 100 });
    await waitFor(() => expect(thumb.style.top).toBe("80px"));
    expect(track.getAttribute("aria-valuenow")).toBe("400");
  });

  it("clicking the track jumps one page toward the click and hands over to a drag", async () => {
    mockTrackRect(200);
    const { calls } = stubTauri({
      scrollState: () => stateJson({ y: 400, vh: 200, ch: 1000, css: true }),
    });
    render(<GutterScrollbar tabId="popout" />);
    const track = await waitFor(() => screen.getByRole("scrollbar"));

    // y=400 → thumbTop = 160*(400/800) = 80, thumb spans 80..120. A click at
    // 150 is BELOW the thumb → one vh (200) toward it, clamped into [0, 800].
    fireEvent.pointerDown(track, { pointerId: 3, clientY: 150 });
    await waitFor(() =>
      expect(
        calls.some((c) => c.cmd === "browser_tab_scroll_to" && c.args?.y === 600),
      ).toBe(true),
    );

    // The jump turned into a drag session: the next move drives from the
    // thumb's CENTER (grabOffset = thumbH/2 = 20).
    // y=600 → thumbTop = 160*(600/800) = 120, center at 140. Move to 180:
    // target = ((180 - 0 - 20) / 160) * 800 = 800 (clamped from 800 exactly).
    fireEvent.pointerMove(track, { pointerId: 3, clientY: 180 });
    await waitFor(() =>
      expect(
        calls.some((c) => c.cmd === "browser_tab_scroll_to" && c.args?.y === 800),
      ).toBe(true),
    );

    // A click ABOVE the thumb pages up instead: at y=800 (thumbTop 160) a
    // click at 20 → 800 - 200 = 600.
    fireEvent.pointerUp(track, { pointerId: 3, clientY: 180 });
    fireEvent.pointerDown(track, { pointerId: 4, clientY: 20 });
    await waitFor(() =>
      expect(
        calls.filter((c) => c.cmd === "browser_tab_scroll_to").some((c) => c.args?.y === 600),
      ).toBe(true),
    );
  });

  it("a failing scroll_to is warned, never an error UI (the chrome never crashes)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockTrackRect(200);
    stubTauri({
      scrollState: () => stateJson({ y: 0, vh: 200, ch: 1000, css: true }),
      scrollToError: "scroll_to failed",
    });
    render(<GutterScrollbar tabId="popout" />);
    const track = await waitFor(() => screen.getByRole("scrollbar"));

    // Track click → the jump's scroll_to rejects → warn, bar stays healthy.
    fireEvent.pointerDown(track, { pointerId: 1, clientY: 150 });
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(screen.getByTestId("popout-gutter-thumb")).toBeTruthy();
  });
});

describe("GutterScrollbar — the 250ms poll", () => {
  it("re-probes every 250ms and refreshes the thumb as the page scrolls on its own", async () => {
    vi.useFakeTimers();
    mockTrackRect(200);
    let currentY = 100; // the page scrolls underneath
    const { calls } = stubTauri({
      scrollState: () => stateJson({ y: currentY, vh: 400, ch: 1600, css: true }),
    });
    render(<GutterScrollbar tabId="popout" />);

    // Mount poll (immediate, not on the interval).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("popout-gutter-thumb").style.top).toBe(
      `${(200 - 50) * (100 / 1200)}px`, // y=100 → 12.5
    );

    // The page scrolled to 500 — the next tick picks it up.
    currentY = 500;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(screen.getByTestId("popout-gutter-thumb").style.top).toBe(
      `${(200 - 50) * (500 / 1200)}px`, // 62.5
    );
    expect(screen.getByRole("scrollbar").getAttribute("aria-valuenow")).toBe("500");

    // Two ticks landed total (mount + interval) — the cadence is honest.
    expect(calls.filter((c) => c.cmd === "browser_tab_scroll_state").length).toBe(2);
  });

  it("while a drag is ACTIVE the poll pauses; pointerup resumes it and re-syncs", async () => {
    vi.useFakeTimers();
    mockTrackRect(200);
    let currentY = 0;
    const { calls } = stubTauri({
      scrollState: () => stateJson({ y: currentY, vh: 200, ch: 1000, css: true }),
    });
    render(<GutterScrollbar tabId="popout" />);
    // Flush the mount poll BEFORE querying — waitFor's own polling interval
    // is faked too and would never fire under fake timers.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const thumb = screen.getByTestId("popout-gutter-thumb");

    // A drag starts (y=0 → grab at 20, move to 100 → target 400; the rAF is
    // faked too, so flush it with the advance).
    fireEvent.pointerDown(thumb, { pointerId: 1, clientY: 20 });
    fireEvent.pointerMove(thumb, { pointerId: 1, clientY: 100 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20); // rAF fires the scroll_to
    });

    // The page (or a rival) reports y=700 — but the drag OWNS the position:
    // two full poll periods pass and the optimistic 400 stands.
    currentY = 700;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(screen.getByRole("scrollbar").getAttribute("aria-valuenow")).toBe("400");
    // And the poll actually paused: through 600ms of ticks the ONLY probe is
    // the mount one — the drag owned the position.
    expect(calls.filter((c) => c.cmd === "browser_tab_scroll_state").length).toBe(1);

    // Release → the next tick re-syncs to the probe.
    fireEvent.pointerUp(thumb, { pointerId: 1, clientY: 100 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByRole("scrollbar").getAttribute("aria-valuenow")).toBe("700");
    // …and that re-sync IS a fresh probe (the poll resumed after the drag).
    expect(calls.filter((c) => c.cmd === "browser_tab_scroll_state").length).toBe(2);
  });

  it("unmounting clears the interval and the pending rAF (no zombie invokes)", async () => {
    vi.useFakeTimers();
    mockTrackRect(200);
    const { calls } = stubTauri({
      scrollState: () => stateJson({ y: 0, vh: 200, ch: 1000, css: true }),
    });
    const { unmount } = render(<GutterScrollbar tabId="popout" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(calls.filter((c) => c.cmd === "browser_tab_scroll_state").length).toBe(1);
  });
});

describe("GutterScrollbar — keyboard", () => {
  it("ArrowDown / ArrowUp / PageDown / Home / End all scroll through browser_tab_scroll_to", async () => {
    mockTrackRect(200);
    const { calls } = stubTauri({ scrollState: () => stateJson({ ...BASE }) });
    render(<GutterScrollbar tabId="popout" />);
    const track = await waitFor(() => screen.getByRole("scrollbar"));

    // BASE: y=300, vh=400, maxScroll=1200. Each key awaits its scroll_to so
    // the shared rAF throttle never coalesces two steps into one.
    const key = async (keyName: string, expected: number) => {
      fireEvent.keyDown(track, { key: keyName });
      await waitFor(() =>
        expect(
          calls.some((c) => c.cmd === "browser_tab_scroll_to" && c.args?.y === expected),
        ).toBe(true),
      );
    };

    await key("ArrowDown", 340); // +40
    await key("ArrowUp", 300); // -40
    await key("PageDown", 700); // +vh
    await key("Home", 0); // top
    await key("End", 1200); // bottom — clamped exactly to maxScroll

    // No trailing aria-snapshot assertion here ON PURPOSE: with real timers
    // the 250ms poll re-probes the (static) mock mid-test and honestly
    // re-syncs the offset back to its probed value — the aria snapshot is
    // pinned by the visibility test above instead.
  });
});
