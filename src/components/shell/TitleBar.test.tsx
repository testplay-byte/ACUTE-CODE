// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TitleBar } from "./TitleBar";
import { useProjectChatStore } from "../../lib/project-chat-store";

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
 * swaps the maximize/restore icon. R60-C adds the identity block's sidebar
 * toggle contract (the REAL project-chat-store — no mock — so the flip lands
 * in the actual store state the AppShell reads).
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

beforeEach(() => {
  clearTauri();
  // R60-C: the identity toggle reads the real store — reset its state so a
  // flipped flag can never leak between tests.
  useProjectChatStore.setState({ appSidebarVisible: true });
});

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

  // R60-C (owner: "I would need to click on the app's logo at the top left
  // corner… the project, the name of the application and such. Also I can
  // click that exact same one to show the sidebar again") — the identity
  // block (logo + name) IS the sidebar toggle now.
  it("R60-C: the identity block is a toggle button that flips appSidebarVisible both ways", () => {
    stubTauri();
    render(<TitleBar />);

    // Default store state: sidebar visible → the affordance says "Hide".
    const toggle = screen.getByRole("button", { name: "Hide sidebar" });
    // CRITICAL Tauri detail: the button carries NO drag region — a drag
    // region swallows clicks (the same reason the window controls work).
    expect(toggle.hasAttribute("data-tauri-drag-region")).toBe(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    // The identity itself is unchanged: the Acute mark + the product name.
    expect(screen.getByTestId("acute-logo")).toBeTruthy();
    expect(screen.getByText("ACUTE-CODE")).toBeTruthy();

    // Click → the whole sidebar hides.
    fireEvent.click(toggle);
    expect(useProjectChatStore.getState().appSidebarVisible).toBe(false);
    const show = screen.getByRole("button", { name: "Show sidebar" });
    expect(show.getAttribute("aria-pressed")).toBe("false");

    // The exact same control shows it again.
    fireEvent.click(show);
    expect(useProjectChatStore.getState().appSidebarVisible).toBe(true);
    expect(screen.getByRole("button", { name: "Hide sidebar" })).toBeTruthy();
  });

  it("R60-C: starting hidden renders the Show affordance (the store is the single source of truth)", () => {
    stubTauri();
    useProjectChatStore.setState({ appSidebarVisible: false });
    render(<TitleBar />);

    const show = screen.getByRole("button", { name: "Show sidebar" });
    expect(show.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(show);
    expect(useProjectChatStore.getState().appSidebarVisible).toBe(true);
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

  // R98-C1 (owner round-98: "giving them a background, with each one of them
  // getting a distinct background… when I hover the colors will shift a
  // little bit and maybe some animations will play too") — the window
  // controls are VISIBLE chips now (subtle wash + hairline border), each
  // with its own hover identity, the press contract, and the true restore
  // glyph (the two-overlapping-squares window shape — the pre-R98 lucide
  // `Copy` duplicate-action metaphor is dead).
  it("R98-C1: distinct resting surfaces + hover identities + press motion", () => {
    stubTauri();
    render(<TitleBar />);

    const rest = {
      min: screen.getByRole("button", { name: "Minimize window" }) as HTMLElement,
      max: screen.getByRole("button", { name: "Maximize window" }) as HTMLElement,
      close: screen.getByRole("button", { name: "Close window" }) as HTMLElement,
    };

    for (const btn of Object.values(rest)) {
      // The resting chip: a subtle wash + hairline border (never a ghost).
      expect(btn.className).toContain("bg-[color-mix(in_srgb,var(--ac-subtle)_70%,transparent)]");
      expect(btn.className).toContain("border-[color:var(--ac-border-subtle)]");
      // The universal press contract.
      expect(btn.className).toContain("active:scale-[0.96]");
      // The 150ms color-shift transition the owner asked for.
      expect(btn.className).toContain("duration-150");
    }

    // Each hover is its OWN identity: minimize = the quiet accent nudge,
    // maximize = the stronger accent grow, close = the destructive danger.
    expect(rest.min.className).toContain("var(--ac-accent)_14%");
    expect(rest.max.className).toContain("var(--ac-accent)_22%");
    expect(rest.close.className).toContain("var(--ac-danger)_16%");
    expect(rest.close.className).not.toContain("var(--ac-accent)");
  });

  it("R98-C1: the restore glyph is the two-squares window shape, not a copy icon", async () => {
    stubTauri({ isMaximized: () => Promise.resolve(true) });
    render(<TitleBar />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Restore window" })).toBeTruthy(),
    );
    const restore = screen.getByRole("button", { name: "Restore window" }) as HTMLElement;
    // The custom SVG glyph (with its occlusion mask), never lucide `Copy`.
    const svg = restore.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.querySelector("mask")).toBeTruthy();
    expect(restore.querySelector("svg.lucide-copy")).toBeNull();
    // The icon motion rides the hover group.
    expect(restore.textContent).toBe("");
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
    // R100-F re-pin: the radius snapped to the 5-step scale — rounded-2xl
    // (16px) for the top-level bar card (was the arbitrary 14px).
    expect(bar.className).toContain("rounded-2xl");
    expect(bar.className).toContain("border-[1.5px]");
    // The old full-bleed bottom-strip chrome is gone.
    expect(bar.className).not.toContain("border-b");
    expect(bar.className).toContain("backdrop-blur");

    // The controls carry their own rounding (inset buttons, not slabs).
    for (const name of ["Minimize window", "Maximize window", "Close window"]) {
      const btn = screen.getByRole("button", { name }) as HTMLElement;
      // R100-F re-pin: the controls snapped to rounded-lg (8px, was 9px).
      expect(btn.className).toContain("rounded-lg");
      expect(btn.className).toContain("h-8");
    }
  });
});
