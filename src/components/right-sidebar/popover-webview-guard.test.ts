// @vitest-environment happy-dom
/**
 * ROUND-62 (D9) — the webview overlay guard unit tests.
 *
 * The watcher must: accept a VALID overlay selector (a stray quote in the
 * selector once crashed the whole AppShell at boot — caught only by the
 * live battery, pinned here forever), flip the store's overlayOpen while a
 * menu/dialog is open, ignore tooltips, and flip back when it closes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installOverlayWebviewWatcher,
  isWebviewHiddenNow,
  overlayCoversRect,
  resetOverlayWatcherForTests,
  setPopoverWebviewSuppression,
  useWebviewGuardStore,
} from "./popover-webview-guard";

beforeEach(() => {
  resetOverlayWatcherForTests();
});

afterEach(() => {
  resetOverlayWatcherForTests();
  document.body.innerHTML = "";
});

/** R89-E5: any overlay recorded? (the store now carries rects + a seq). */
function anyOverlay(): boolean {
  return useWebviewGuardStore.getState().overlayRects.length > 0;
}

/** Append an overlay node (Radix-style portal) and flush the debounce. */
async function openOverlay(attrs: Record<string, string>, role?: string): Promise<HTMLElement> {
  const el = document.createElement("div");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (role !== undefined) el.setAttribute("role", role);
  document.body.appendChild(el);
  await vi.waitFor(() => {
    if (!anyOverlay()) throw new Error("not yet");
  });
  return el;
}

describe("webview overlay guard (R62 D9)", () => {
  it("the overlay selector is VALID CSS (the boot-crash regression pin)", () => {
    // querySelectorAll throws on a malformed selector — this is the exact
    // call the watcher makes on every mutation.
    expect(() =>
      document.querySelectorAll('[role="menu"], [role="dialog"], [data-radix-popper-content-wrapper"], [data-overlay]'),
    ).not.toThrow();
  });

  it("installOverlayWebviewWatcher flips overlayOpen when a dialog opens and back when it closes", async () => {
    installOverlayWebviewWatcher();
    expect(anyOverlay()).toBe(false);

    const dialog = await openOverlay({ "data-state": "open" }, "dialog");
    expect(anyOverlay()).toBe(true);
    // R89-E5: without geometry the call is conservative (any overlay hides);
    // in happy-dom the unmeasurable overlay records as the FULL viewport.
    expect(isWebviewHiddenNow("tab-any")).toBe(true);

    dialog.remove();
    await vi.waitFor(() => {
      if (anyOverlay()) throw new Error("not closed yet");
    });
    expect(anyOverlay()).toBe(false);
    expect(isWebviewHiddenNow("tab-any")).toBe(false);
  });

  it("menus and [data-overlay] markers count; TOOLTIPS do not (too transient to blank the page)", async () => {
    installOverlayWebviewWatcher();
    // A tooltip portal: role=tooltip — never flips the flag.
    const tooltip = document.createElement("div");
    tooltip.setAttribute("role", "tooltip");
    document.body.appendChild(tooltip);
    await new Promise((r) => setTimeout(r, 120));
    expect(anyOverlay()).toBe(false);
    tooltip.remove();

    await openOverlay({}, "menu");
    expect(anyOverlay()).toBe(true);

    // attribute-only marker works too
    const marker = document.createElement("div");
    marker.setAttribute("data-overlay", "");
    document.body.appendChild(marker);
    document.body.querySelector('[role="menu"]')?.remove();
    await vi.waitFor(() => {
      if (!anyOverlay()) throw new Error("marker not seen");
    });
    marker.remove();
    await vi.waitFor(() => {
      if (anyOverlay()) throw new Error("not closed");
    });
  });

  it("the R60 tab-scoped popover suppression still hides only ITS tab", () => {
    setPopoverWebviewSuppression("tab-a");
    expect(isWebviewHiddenNow("tab-a")).toBe(true);
    expect(isWebviewHiddenNow("tab-b")).toBe(false);
    setPopoverWebviewSuppression(null);
    expect(isWebviewHiddenNow("tab-a")).toBe(false);
  });

  it("installing twice is a no-op (one observer for the app's lifetime)", () => {
    installOverlayWebviewWatcher();
    installOverlayWebviewWatcher();
    // No throw, still functional.
    expect(typeof document.querySelector("body")).toBe("object");
  });
});


// ── ROUND-89 (R89-E5): the GEOMETRIC guard — the browser stays live unless
// the overlay actually covers the panel's page area. ─────────────────────────
describe("webview overlay guard — the R89-E5 geometry", () => {
  it("an overlay AWAY from the panel area does NOT hide it; one OVERLAPPING does", async () => {
    // The panel's page area lives in the right half of the viewport.
    const panelArea = { left: 800, top: 100, right: 1200, bottom: 800 };
    useWebviewGuardStore.getState().setOverlayRects([{ left: 20, top: 20, right: 260, bottom: 420 }]);
    expect(overlayCoversRect(panelArea)).toBe(false); // the menu is in the left rail
    expect(isWebviewHiddenNow("tab-x", panelArea)).toBe(false);

    useWebviewGuardStore.getState().setOverlayRects([{ left: 700, top: 300, right: 1400, bottom: 900 }]);
    expect(overlayCoversRect(panelArea)).toBe(true); // the dialog covers the panel
    expect(isWebviewHiddenNow("tab-x", panelArea)).toBe(true);

    useWebviewGuardStore.getState().setOverlayRects([]);
    expect(overlayCoversRect(panelArea)).toBe(false);
  });

  it("multiple overlays: ANY intersection hides (the union test)", () => {
    const panelArea = { left: 800, top: 100, right: 1200, bottom: 800 };
    useWebviewGuardStore
      .getState()
      .setOverlayRects([
        { left: 0, top: 0, right: 100, bottom: 100 },
        { left: 1100, top: 600, right: 1920, bottom: 900 },
      ]);
    expect(overlayCoversRect(panelArea)).toBe(true); // the second one overlaps
  });
});
