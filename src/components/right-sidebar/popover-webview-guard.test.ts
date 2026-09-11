// @vitest-environment happy-dom
/**
 * ROUND-62 (D9) — the webview overlay guard unit tests.
 *
 * The watcher must: accept a VALID overlay selector (a stray quote in the
 * selector once crashed the whole AppShell at boot — caught only by the
 * live battery, pinned here forever), flip the store's overlayOpen while a
 * menu/dialog is open, ignore tooltips, and flip back when it closes.
 *
 * ROUND-92 (R92-A) — the hardening pins:
 *  · PURE BACKDROPS ([data-webview-backdrop]) never count as covering
 *    overlays (the ModelSelector scrim used to blank the browser for a dim
 *    layer the OS webview never even shows).
 *  · An UNMEASURABLE (0×0) overlay is SKIPPED — the pre-R92 conservative
 *    fallback recorded the FULL viewport — and a rAF follow-up measures it
 *    once laid out.
 *  · While anything is open, the 600ms periodic re-check keeps the rects
 *    fresh even with ZERO structural mutations (a stale covering rect used
 *    to pin the browser hidden forever).
 *  · refreshOverlayRectsNow forces a fresh sweep for the BrowserPanel's
 *    watchdog (Part 5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installOverlayWebviewWatcher,
  isWebviewHiddenNow,
  overlayCoversRect,
  refreshOverlayRectsNow,
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

/** A measurable viewport rect for a test overlay (happy-dom does no layout —
 * every element is 0×0 there, so tests that want an overlay RECORDED give
 * it a real rect, exactly like a laid-out portal in the real DOM). */
const LAID_OUT_RECT = { left: 20, top: 20, right: 300, bottom: 220, width: 280, height: 200 } as DOMRect;

/** Give the element a measurable rect (replacing the default 0×0). */
function measureAs(el: HTMLElement, rect: DOMRect = LAID_OUT_RECT): void {
  el.getBoundingClientRect = () => rect;
}

/** Append an overlay node (Radix-style portal) and flush the debounce. */
async function openOverlay(attrs: Record<string, string>, role?: string): Promise<HTMLElement> {
  const el = document.createElement("div");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (role !== undefined) el.setAttribute("role", role);
  measureAs(el);
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
      document.querySelectorAll('[role="menu"], [role="dialog"], [data-radix-popper-content-wrapper], [data-overlay]'),
    ).not.toThrow();
  });

  it("installOverlayWebviewWatcher flips overlayOpen when a dialog opens and back when it closes", async () => {
    installOverlayWebviewWatcher();
    expect(anyOverlay()).toBe(false);

    const dialog = await openOverlay({ "data-state": "open" }, "dialog");
    expect(anyOverlay()).toBe(true);
    // R89-E5: without geometry the call is conservative (any overlay hides).
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
    measureAs(marker);
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


// ── ROUND-92 (R92-A): the hardening — backdrop exemption, the zero-rect
// skip + rAF follow-up, the periodic re-check, and the forced refresh. ──────
describe("webview overlay guard — the R92-A hardening", () => {
  it("R92-A: a PURE BACKDROP ([data-webview-backdrop]) never counts — even full-viewport", async () => {
    installOverlayWebviewWatcher();
    // The ModelSelector scrim's exact shape: a full-viewport fixed div,
    // MEASURABLE (it would record {0,0,1024,768} without the exemption).
    const scrim = document.createElement("div");
    scrim.setAttribute("data-webview-backdrop", "");
    scrim.className = "fixed inset-0 z-40";
    measureAs(scrim, { left: 0, top: 0, right: 1024, bottom: 768, width: 1024, height: 768 } as DOMRect);
    document.body.appendChild(scrim);
    await new Promise((r) => setTimeout(r, 150));
    expect(anyOverlay()).toBe(false);
    // …and it never blanks the browser, geometry or not.
    expect(isWebviewHiddenNow("tab-any")).toBe(false);

    // The sibling CONTENT panel still counts (the popover's own box).
    const content = document.createElement("div");
    content.setAttribute("role", "menu");
    measureAs(content);
    document.body.appendChild(content);
    await vi.waitFor(() => {
      if (!anyOverlay()) throw new Error("content not seen");
    });
    // Exactly ONE rect recorded — the scrim stayed exempt.
    expect(useWebviewGuardStore.getState().overlayRects).toHaveLength(1);
    content.remove();
    scrim.remove();
    await vi.waitFor(() => {
      if (anyOverlay()) throw new Error("not closed");
    });
  });

  it("R92-A: an UNMEASURABLE (0×0) overlay is SKIPPED, then measured after a rAF once laid out", async () => {
    installOverlayWebviewWatcher();
    // No measureAs here: happy-dom's native 0×0 rect — the pre-R92 watcher
    // recorded this as the FULL viewport (conservatively covering); the
    // R92-A watcher must SKIP it instead (the blanked-browser bug).
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.appendChild(menu);
    await new Promise((r) => setTimeout(r, 150));
    expect(anyOverlay()).toBe(false);

    // The element gets laid out (a real portal's first frame after mount)
    // — the rAF follow-up pass measures it and records the real rect.
    measureAs(menu, { left: 800, top: 300, right: 1200, bottom: 700, width: 400, height: 400 } as DOMRect);
    await vi.waitFor(() => {
      if (!anyOverlay()) throw new Error("not re-measured after layout");
    });
    expect(overlayCoversRect({ left: 900, top: 350, right: 1100, bottom: 650 })).toBe(true);
    expect(overlayCoversRect({ left: 0, top: 0, right: 100, bottom: 100 })).toBe(false);

    menu.remove();
    await vi.waitFor(() => {
      if (anyOverlay()) throw new Error("not closed");
    });
  });

  it("R92-A: the 600ms periodic re-check self-heals a STALE covering rect with zero DOM mutations", async () => {
    installOverlayWebviewWatcher();
    // The panel's page area — the overlay initially covers it.
    const panelArea = { left: 800, top: 100, right: 1200, bottom: 800 };
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    measureAs(menu, { left: 700, top: 300, right: 1400, bottom: 900, width: 700, height: 600 } as DOMRect);
    document.body.appendChild(menu);
    await vi.waitFor(() => {
      if (!anyOverlay()) throw new Error("not seen");
    });
    expect(overlayCoversRect(panelArea)).toBe(true);

    // The overlay MOVES away (a reposition with no added/removed nodes —
    // the exact stale-rect scenario the R92 plan called out). Only the
    // periodic re-check can notice: no structural mutation ever fires the
    // MutationObserver again.
    measureAs(menu, { left: 0, top: 0, right: 400, bottom: 280, width: 400, height: 280 } as DOMRect);
    await vi.waitFor(
      () => {
        if (overlayCoversRect(panelArea)) throw new Error("stale rect still pinned");
      },
      // The interval is 600ms — allow it a comfortable margin.
      { timeout: 2500 },
    );
    expect(anyOverlay()).toBe(true); // still open — just not covering anymore

    menu.remove();
    await vi.waitFor(() => {
      if (anyOverlay()) throw new Error("not closed");
    });
  });

  it("R92-A: refreshOverlayRectsNow forces a fresh sweep — a stale store record heals immediately", async () => {
    installOverlayWebviewWatcher();
    // A stale covering rect is sitting in the store (recorded before the
    // overlay closed — the watchdog-suppression scenario from Part 5).
    useWebviewGuardStore
      .getState()
      .setOverlayRects([{ left: 700, top: 300, right: 1400, bottom: 900 }]);
    const panelArea = { left: 800, top: 100, right: 1200, bottom: 800 };
    expect(overlayCoversRect(panelArea)).toBe(true);

    // Nothing is open in the DOM anymore — the forced refresh sweeps and
    // clears the store WITHOUT waiting for a mutation that never comes.
    refreshOverlayRectsNow();
    expect(overlayCoversRect(panelArea)).toBe(false);
    expect(anyOverlay()).toBe(false);

    // And with a live measurable overlay, the forced refresh records it.
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    measureAs(menu, { left: 700, top: 300, right: 1400, bottom: 900, width: 700, height: 600 } as DOMRect);
    document.body.appendChild(menu);
    refreshOverlayRectsNow();
    expect(overlayCoversRect(panelArea)).toBe(true);
    menu.remove();
    refreshOverlayRectsNow();
    expect(anyOverlay()).toBe(false);
  });

  it("R92-A: an identical rect sweep does NOT bump the seq (the periodic re-check stays render-free)", () => {
    const seqBefore = useWebviewGuardStore.getState().overlaySeq;
    const rect = { left: 20, top: 20, right: 300, bottom: 220 };
    useWebviewGuardStore.getState().setOverlayRects([rect]);
    const seqAfterSet = useWebviewGuardStore.getState().overlaySeq;
    expect(seqAfterSet).toBe(seqBefore + 1);
    // The same sweep again (the 600ms tick with nothing moved) — no bump.
    useWebviewGuardStore.getState().setOverlayRects([{ ...rect }]);
    expect(useWebviewGuardStore.getState().overlaySeq).toBe(seqAfterSet);
    // A real change still bumps.
    useWebviewGuardStore.getState().setOverlayRects([{ left: 0, top: 0, right: 10, bottom: 10 }]);
    expect(useWebviewGuardStore.getState().overlaySeq).toBe(seqAfterSet + 1);
  });
});
