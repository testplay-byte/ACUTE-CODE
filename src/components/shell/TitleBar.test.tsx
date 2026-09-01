// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TitleBar } from "./TitleBar";

/**
 * ROUND-58 (R58-a) — unit tests for the custom title bar of the frameless
 * main window.
 *
 * The Tauri global is faked with a minimal `__TAURI__` stub (the
 * sidecar.test.ts direct-assignment pattern — `isTauri()` from lib/sidecar
 * stays REAL so the web-mode null render is tested through the actual shell
 * detection, not a mock). The contract under test is the component's wiring:
 * null in web mode, the drag-region chrome in Tauri mode, and that the three
 * window controls drive `getCurrentWindow()`'s minimize / toggleMaximize /
 * close (never the wrong method), plus the `tauri://resize` re-query that
 * swaps the maximize/restore icon.
 */

// AcuteLogo lives in Sidebar (a heavy module) — stub the import
// (ConnectionGate.test.tsx pattern).
vi.mock("./Sidebar", () => ({
  AcuteLogo: () => <div data-testid="acute-logo" />,
}));

type StubWindow = {
  minimize: ReturnType<typeof vi.fn>;
  toggleMaximize: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  isMaximized: ReturnType<typeof vi.fn>;
};

function clearTauri(): void {
  delete (window as { __TAURI__?: unknown }).__TAURI__;
}

/**
 * Installs a minimal `window.__TAURI__` whose window handle is fully
 * capturable. `emit()` fires the subscribed `tauri://resize` handler.
 */
function stubTauri(overrides: { isMaximized?: () => Promise<boolean> } = {}): {
  win: StubWindow;
  listen: ReturnType<typeof vi.fn>;
  emit: () => void;
  unlisten: ReturnType<typeof vi.fn>;
} {
  const win: StubWindow = {
    minimize: vi.fn(() => Promise.resolve()),
    toggleMaximize: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    isMaximized: vi.fn(() =>
      overrides.isMaximized ? overrides.isMaximized() : Promise.resolve(false),
    ),
  };
  let handler: ((ev: { payload: unknown }) => void) | null = null;
  const unlisten = vi.fn();
  const listen = vi.fn((event: string, h: (ev: { payload: unknown }) => void) => {
    expect(event).toBe("tauri://resize");
    handler = h;
    return Promise.resolve(unlisten);
  });
  (window as { __TAURI__?: unknown }).__TAURI__ = {
    window: { getCurrentWindow: () => win },
    event: { listen },
  };
  return {
    win,
    listen,
    emit: () => (handler as (ev: { payload: unknown }) => void)({ payload: null }),
    unlisten,
  };
}

beforeEach(clearTauri);

afterEach(() => {
  clearTauri();
  cleanup();
});

describe("TitleBar — web mode", () => {
  it("renders nothing without window.__TAURI__ (browser dev / tests unchanged)", () => {
    const { container } = render(<TitleBar />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("ACUTE-CODE")).toBeNull();
    expect(screen.queryByRole("button", { name: /window/i })).toBeNull();
  });
});

describe("TitleBar — Tauri chrome", () => {
  it("renders the drag-region bar, the app identity, and the three controls", () => {
    stubTauri();
    const { container } = render(<TitleBar />);

    // The bar's background is the drag region (Tauri owns drag + double-click
    // maximize from this attribute).
    const bar = container.firstElementChild as HTMLElement;
    expect(bar.hasAttribute("data-tauri-drag-region")).toBe(true);

    // App identity: the Acute mark (stubbed here) + the product name.
    expect(screen.getByTestId("acute-logo")).toBeTruthy();
    expect(screen.getByText("ACUTE-CODE")).toBeTruthy();

    expect(screen.getByRole("button", { name: "Minimize window" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Maximize window" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close window" })).toBeTruthy();
  });

  it("each control drives exactly its own window method", () => {
    const { win } = stubTauri();
    render(<TitleBar />);

    fireEvent.click(screen.getByRole("button", { name: "Minimize window" }));
    expect(win.minimize).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Maximize window" }));
    expect(win.toggleMaximize).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Close window" }));
    expect(win.close).toHaveBeenCalledTimes(1);

    // No cross-talk: the other methods were never touched.
    expect(win.minimize).toHaveBeenCalledTimes(1);
    expect(win.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it("subscribes to tauri://resize and queries isMaximized on mount", async () => {
    const { win, listen } = stubTauri();
    render(<TitleBar />);

    await waitFor(() => expect(win.isMaximized).toHaveBeenCalledTimes(1));
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith("tauri://resize", expect.any(Function));
  });

  it("swaps maximize → restore (and back) when the resize event says so", async () => {
    let maximized = false;
    const { win, emit } = stubTauri({ isMaximized: () => Promise.resolve(maximized) });
    render(<TitleBar />);

    // Starts unmaximized (mount query).
    await waitFor(() => expect(win.isMaximized).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Maximize window" })).toBeTruthy();

    // The window maximized from OUTSIDE our buttons (double-click on the drag
    // region, Aero Snap) — the resize handler re-queries and swaps the icon.
    maximized = true;
    emit();
    await waitFor(() => expect(screen.getByRole("button", { name: "Restore window" })).toBeTruthy());
    expect(win.isMaximized).toHaveBeenCalledTimes(2);

    maximized = false;
    emit();
    await waitFor(() => expect(screen.getByRole("button", { name: "Maximize window" })).toBeTruthy());
  });

  it("starts in restore mode when the window is already maximized on mount", async () => {
    stubTauri({ isMaximized: () => Promise.resolve(true) });
    render(<TitleBar />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Restore window" })).toBeTruthy(),
    );
  });

  it("releases the resize listener on unmount", async () => {
    const { listen, unlisten } = stubTauri();
    const { unmount } = render(<TitleBar />);
    // Let the listen promise resolve so the unlisten handle is installed.
    await waitFor(() => expect(listen).toHaveBeenCalled());
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("a rejecting window API is logged and swallowed — chrome never crashes the app", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const minimize = vi.fn(() => Promise.reject(new Error("not permitted")));
    const toggleMaximize = vi.fn(() => Promise.resolve());
    const close = vi.fn(() => Promise.resolve());
    const isMaximized = vi.fn(() => Promise.resolve(false));
    const unlisten = vi.fn();
    const listen = vi.fn(() => Promise.resolve(unlisten));
    (window as { __TAURI__?: unknown }).__TAURI__ = {
      window: { getCurrentWindow: () => ({ minimize, toggleMaximize, close, isMaximized }) },
      event: { listen },
    };

    render(<TitleBar />);
    fireEvent.click(screen.getByRole("button", { name: "Minimize window" }));

    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn.mock.calls[0]?.[0]).toContain("[titlebar]");
    // The bar (and its buttons) survive the failure.
    expect(screen.getByRole("button", { name: "Minimize window" })).toBeTruthy();
    warn.mockRestore();
  });

  // R59-A (owner: "make that top navigation bar rounded and give it padding
  // on all four sides") — the bar is a rounded CARD now: rounded on all four
  // corners, bordered all around (no more flat border-b strip), and the
  // window controls are inset rounded buttons instead of edge-to-edge
  // full-height slabs so hovers never break the corner radii.
  it("R59-A: the bar renders as a rounded card with inset, rounded window controls", () => {
    stubTauri();
    const { container } = render(<TitleBar />);

    const bar = container.firstElementChild as HTMLElement;
    expect(bar.tagName).toBe("HEADER");
    expect(bar.className).toContain("rounded-[14px]");
    expect(bar.className).toContain("border-[1.5px]");
    // The old full-bleed bottom-strip chrome is gone.
    expect(bar.className).not.toContain("border-b");
    expect(bar.className).toContain("backdrop-blur");

    // The controls carry their own rounding (inset buttons, not slabs).
    for (const name of ["Minimize window", "Maximize window", "Close window"]) {
      const btn = screen.getByRole("button", { name }) as HTMLElement;
      expect(btn.className).toContain("rounded-[9px]");
      expect(btn.className).toContain("h-8");
    }
  });
});
