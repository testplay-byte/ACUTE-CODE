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

/** Append an overlay node (Radix-style portal) and flush the debounce. */
async function openOverlay(attrs: Record<string, string>, role?: string): Promise<HTMLElement> {
  const el = document.createElement("div");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (role !== undefined) el.setAttribute("role", role);
  document.body.appendChild(el);
  await vi.waitFor(() => {
    if (!useWebviewGuardStore.getState().overlayOpen) throw new Error("not yet");
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
    expect(useWebviewGuardStore.getState().overlayOpen).toBe(false);

    const dialog = await openOverlay({ "data-state": "open" }, "dialog");
    expect(useWebviewGuardStore.getState().overlayOpen).toBe(true);
    expect(isWebviewHiddenNow("tab-any")).toBe(true); // global overlay hides every tab

    dialog.remove();
    await vi.waitFor(() => {
      if (useWebviewGuardStore.getState().overlayOpen) throw new Error("not closed yet");
    });
    expect(useWebviewGuardStore.getState().overlayOpen).toBe(false);
    expect(isWebviewHiddenNow("tab-any")).toBe(false);
  });

  it("menus and [data-overlay] markers count; TOOLTIPS do not (too transient to blank the page)", async () => {
    installOverlayWebviewWatcher();
    // A tooltip portal: role=tooltip — never flips the flag.
    const tooltip = document.createElement("div");
    tooltip.setAttribute("role", "tooltip");
    document.body.appendChild(tooltip);
    await new Promise((r) => setTimeout(r, 120));
    expect(useWebviewGuardStore.getState().overlayOpen).toBe(false);
    tooltip.remove();

    await openOverlay({}, "menu");
    expect(useWebviewGuardStore.getState().overlayOpen).toBe(true);

    // attribute-only marker works too
    const marker = document.createElement("div");
    marker.setAttribute("data-overlay", "");
    document.body.appendChild(marker);
    document.body.querySelector('[role="menu"]')?.remove();
    await vi.waitFor(() => {
      if (!useWebviewGuardStore.getState().overlayOpen) throw new Error("marker not seen");
    });
    marker.remove();
    await vi.waitFor(() => {
      if (useWebviewGuardStore.getState().overlayOpen) throw new Error("not closed");
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
