// @vitest-environment happy-dom
/**
 * ROUND-92 (R92-A) — the composer menus' overlay-first ladder unit tests.
 *
 * The hook owns the choice between the MENU OVERLAY WINDOW (native mode —
 * the OS window that rides ABOVE the browser webview, so picking a mode /
 * thinking level / add-context action never blanks the embedded browser)
 * and the plain DOM dropdown (web mode / a failed overlay command). These
 * tests pin the ladder's decision table with the bridge mocked:
 *
 *  · web mode (no native browser)  → the DOM dropdown, exactly as pre-R92.
 *  · native + showMenuOverlay ok   → the overlay window; the DOM dropdown
 *    must NOT render while it is up; a pick applies onPick + closes.
 *  · native + showMenuOverlay NO   → the DOM dropdown fallback.
 *  · outside mousedown / Escape in the main window closes the overlay leg.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { useNativeOptionsMenu, type NativeOptionsMenuConfig } from "./useNativeOptionsMenu";

/** The menu-overlay bridge mock's mutable state (hoisted above the mocks). */
const overlayState = vi.hoisted(() => ({
  available: false,
  showResult: true as boolean,
  showCalls: [] as Array<{ left: number; top: number; width: number; height: number; payload: unknown }>,
  pickHandler: null as ((pick: { kind: string; item: { kind: string; id: string } }) => void) | null,
  closeHandler: null as (() => void) | null,
  hidden: 0,
}));

vi.mock("../../../lib/native-browser", () => ({
  isNativeBrowserAvailable: () => overlayState.available,
}));

vi.mock("../../../lib/menu-overlay", () => ({
  showMenuOverlay: vi.fn((anchor: { left: number; top: number; width: number; height: number }, payload: unknown) => {
    overlayState.showCalls.push({ ...anchor, payload });
    return Promise.resolve(overlayState.showResult);
  }),
  hideMenuOverlay: vi.fn(() => {
    overlayState.hidden += 1;
  }),
  prewarmMenuOverlay: vi.fn(() => {}),
  // R126-3h: the hook now builds its payload theme through the shared
  // menuThemeFromStyles builder — a stub is enough (the theme's VALUES are
  // pinned by lib/menu-overlay.test.ts, not here).
  menuThemeFromStyles: vi.fn(() => ({ isDark: false }) as never),
  onMenuOverlayPick: vi.fn((cb: (pick: { kind: string; item: { kind: string; id: string } }) => void) => {
    overlayState.pickHandler = cb;
    return () => {
      if (overlayState.pickHandler === cb) overlayState.pickHandler = null;
    };
  }),
  onMenuOverlayClose: vi.fn((cb: () => void) => {
    overlayState.closeHandler = cb;
    return () => {
      if (overlayState.closeHandler === cb) overlayState.closeHandler = null;
    };
  }),
}));

/** A minimal probe component: one pill + the DOM dropdown the hook gates. */
function Probe(props: { onPick: (id: string) => void }): React.ReactElement {
  const anchorRef = useRef<HTMLDivElement>(null);
  const config: NativeOptionsMenuConfig = {
    title: "Operating mode",
    menuWidth: 256,
    align: "left",
    rowHeight: 30,
    buildItems: () => [
      { id: "full", label: "Full Access", selected: false },
      { id: "ask", label: "Ask", selected: true },
    ],
    onPick: props.onPick,
  };
  const menu = useNativeOptionsMenu(config);
  return (
    <div>
      <div ref={anchorRef}>
        <button type="button" aria-expanded={menu.isOpen} aria-label="pill" onClick={() => menu.toggle(anchorRef.current)}>
          pill
        </button>
      </div>
      {menu.open ? (
        <div role="menu" aria-label="Operating mode">
          <button type="button" role="menuitemradio" onClick={() => menu.closeAll()}>
            Full Access
          </button>
        </div>
      ) : null}
      <span data-testid="overlay-active">{menu.overlayActive ? "yes" : "no"}</span>
    </div>
  );
}

beforeEach(() => {
  overlayState.available = false;
  overlayState.showResult = true;
  overlayState.showCalls = [];
  overlayState.pickHandler = null;
  overlayState.closeHandler = null;
  overlayState.hidden = 0;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useNativeOptionsMenu (R92-A)", () => {
  it("WEB mode: the pill toggles the plain DOM dropdown — the pre-R92 behavior, untouched", async () => {
    const onPick = vi.fn();
    render(<Probe onPick={onPick} />);

    expect(screen.queryByRole("menu", { name: "Operating mode" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "pill" }));
    });
    expect(screen.getByRole("menu", { name: "Operating mode" })).toBeTruthy();
    expect(screen.getByTestId("overlay-active").textContent).toBe("no");
    // No overlay command ever fired.
    expect(overlayState.showCalls).toHaveLength(0);

    // Toggling again closes it.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "pill" }));
    });
    expect(screen.queryByRole("menu", { name: "Operating mode" })).toBeNull();
  });

  it("NATIVE mode + a healthy overlay: the overlay window is the menu — the DOM dropdown never renders", async () => {
    overlayState.available = true;
    const onPick = vi.fn();
    render(<Probe onPick={onPick} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "pill" }));
    });
    // The overlay leg is up: aria-expanded reads true, the DOM menu is NOT
    // mounted (a hidden duplicate would fire the overlay guard), and the
    // anchor math mirrored the DOM geometry (the menu above the pill).
    expect(screen.getByRole("button", { name: "pill" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("menu", { name: "Operating mode" })).toBeNull();
    expect(screen.getByTestId("overlay-active").textContent).toBe("yes");
    expect(overlayState.showCalls).toHaveLength(1);
    const call = overlayState.showCalls[0]!;
    expect(call.payload).toMatchObject({ kind: "options", title: "Operating mode", width: 256 });
    expect(call.top).toBeGreaterThanOrEqual(0); // clamped like the DOM geometry
    expect(call.left).toBeGreaterThanOrEqual(0);
    // The pill's DOM rect is 0×0 in happy-dom → the menu anchors above a
    // 0×0 pill at the origin with the height derived from the row estimate.
    expect(call.height).toBe(6 + 20 + 10 + 2 * 30);

    // A PICK applies the choice exactly like the DOM onClick, then closes.
    await act(async () => {
      overlayState.pickHandler?.({ kind: "options", item: { kind: "options", id: "full" } });
    });
    expect(onPick).toHaveBeenCalledWith("full");
    expect(screen.getByTestId("overlay-active").textContent).toBe("no");
    expect(overlayState.hidden).toBeGreaterThanOrEqual(1);

    // A foreign pick (the sidebar's quick menu) must NOT act on this hook.
    await act(async () => {
      overlayState.pickHandler?.({ kind: "quick", item: { kind: "quick", id: "browser" } });
    });
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("NATIVE mode + a REFUSED overlay command: the DOM dropdown is the fallback", async () => {
    overlayState.available = true;
    overlayState.showResult = false;
    const onPick = vi.fn();
    render(<Probe onPick={onPick} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "pill" }));
    });
    expect(overlayState.showCalls).toHaveLength(1);
    expect(screen.getByRole("menu", { name: "Operating mode" })).toBeTruthy();
    expect(screen.getByTestId("overlay-active").textContent).toBe("no");
  });

  it("NATIVE mode: an outside mousedown or Escape in the MAIN window closes the overlay leg", async () => {
    overlayState.available = true;
    render(<Probe onPick={vi.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "pill" }));
    });
    expect(screen.getByTestId("overlay-active").textContent).toBe("yes");

    // A mousedown on the pill itself is a TOGGLE, not a dismiss (the
    // useDismiss semantics — the click that follows toggles the menu shut).
    await act(async () => {
      fireEvent.mouseDown(screen.getByRole("button", { name: "pill" }));
    });
    expect(screen.getByTestId("overlay-active").textContent).toBe("yes");

    // Escape in the main window closes it.
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.getByTestId("overlay-active").textContent).toBe("no");
    expect(overlayState.hidden).toBeGreaterThanOrEqual(1);

    // Reopen, then a mousedown OUTSIDE the anchor closes it too.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "pill" }));
    });
    expect(screen.getByTestId("overlay-active").textContent).toBe("yes");
    await act(async () => {
      fireEvent.mouseDown(document.body);
    });
    expect(screen.getByTestId("overlay-active").textContent).toBe("no");
  });

  it("NATIVE mode: the overlay page's own close report (Escape in ITS window) closes the leg", async () => {
    overlayState.available = true;
    render(<Probe onPick={vi.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "pill" }));
    });
    expect(screen.getByTestId("overlay-active").textContent).toBe("yes");
    await act(async () => {
      overlayState.closeHandler?.();
    });
    expect(screen.getByTestId("overlay-active").textContent).toBe("no");
  });
});
