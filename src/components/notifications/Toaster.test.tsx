// @vitest-environment happy-dom
/**
 * ROUND-99 (R99-C) — the Toaster's ACTIONABLE-toast leg.
 *
 * The update-available ping is a local toast carrying a `link`
 * ("/settings?tab=about"). The policy this file pins (the docblock's
 * R64-c + R99-C contract):
 *   · a LINKED toast is PERSISTENT — it needs a click, the same
 *     needs-attention class as permission_request; the 1.5s auto-dismiss
 *     covers read-only pings only (a View action must outlive it);
 *   · clicking the body navigates to the LINK (the openSession leg for
 *     session records is unchanged — pinned here too, as the control);
 *   · an UNLINKED local toast still auto-dismisses after 1.5s (the
 *     owner's ROUND-64 verdict, byte-identical).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { Toaster, toastNeedsAttention } from "./Toaster";
import { pushLocalToast, useNotificationStreamStore } from "../../hooks/use-notifications";
import { renderWithProviders, resetTestState } from "../../test-utils";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  resetTestState();
  useNotificationStreamStore.getState().reset();
});

describe("Toaster R99-C: the actionable (linked) local toast", () => {
  it("toastNeedsAttention: a link joins the persistent kinds; a plain record does not", () => {
    expect(
      toastNeedsAttention({
        id: "x",
        ts: new Date().toISOString(),
        kind: "task_complete",
        title: "t",
        body: null,
        sessionId: null,
        projectId: null,
        read: 1,
        link: "/settings?tab=about",
      }),
    ).toBe(true);
    expect(
      toastNeedsAttention({
        id: "x",
        ts: new Date().toISOString(),
        kind: "permission_request",
        title: "t",
        body: null,
        sessionId: null,
        projectId: null,
        read: 1,
      }),
    ).toBe(true);
    expect(
      toastNeedsAttention({
        id: "x",
        ts: new Date().toISOString(),
        kind: "task_complete",
        title: "t",
        body: null,
        sessionId: null,
        projectId: null,
        read: 1,
      }),
    ).toBe(false);
  });

  it("stays on screen past the 1.5s auto-dismiss (it needs a click) and navigates to its link on click", async () => {
    // REAL timers on purpose: framer-motion's enter/exit transitions ride
    // rAF, which vi.useFakeTimers() freezes — the first draft hung exactly
    // there. The honest cost is a real ~2s wait for the R64-c window.
    renderWithProviders(
      <>
        <Toaster />
        <Routes>
          <Route path="/" element={<div>home stub</div>} />
          <Route path="/settings" element={<div>settings stub</div>} />
        </Routes>
      </>,
    );

    pushLocalToast(
      "ACUTE-CODE v0.99.0 is available",
      "Review and install it in Settings → About.",
      "task_complete",
      "/settings?tab=about",
    );

    expect(await screen.findByText("ACUTE-CODE v0.99.0 is available")).toBeTruthy();
    // The R64-c auto-dismiss window passes — the linked toast is still here
    // (actionable = persistent; a View action must outlive 1.5s).
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(screen.getByText("ACUTE-CODE v0.99.0 is available")).toBeTruthy();

    // Click the body → the View action: navigate to the link + dismiss.
    // The router is a MemoryRouter (renderWithProviders) — navigation is
    // asserted by the stub route's CONTENT, never window.location.
    fireEvent.click(
      screen.getByRole("button", { name: /Open notification: ACUTE-CODE v0\.99\.0 is available/ }),
    );
    expect(await screen.findByText("settings stub", {}, { timeout: 3_000 })).toBeTruthy();
    await waitFor(
      () => {
        expect(screen.queryByText("ACUTE-CODE v0.99.0 is available")).toBeNull();
      },
      { timeout: 3_000 },
    );
  }, 15_000);

  it("an UNLINKED local toast still auto-dismisses after 1.5s (the R64-c verdict untouched)", async () => {
    // REAL timers (same framer-motion/rAF reason as above): the honest cost
    // is waiting out the real 1.5s dismiss + the exit transition beat.
    renderWithProviders(
      <>
        <Toaster />
        <Routes>
          <Route path="/" element={<div>home stub</div>} />
        </Routes>
      </>,
    );

    pushLocalToast("File restored", "The file is back.");
    expect(await screen.findByText("File restored")).toBeTruthy();

    await waitFor(
      () => {
        expect(screen.queryByText("File restored")).toBeNull();
      },
      { timeout: 4_000 },
    );
  }, 10_000);
});
