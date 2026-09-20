// @vitest-environment happy-dom
/**
 * ROUND-115 (R115-E2) — the events stream's NAVIGATION BRIDGE, end to end:
 * handleEventsFrame deposits a device-sourced session route into the
 * session-nav store (pinned in src/lib/events-stream.test.ts), and the
 * AppShell-mounted EventStreamStarter performs the actual navigate() with
 * the Router it lives inside (the Toaster openSession mechanism). This
 * suite pins the SECOND half: store → starter → the router's location.
 *
 * The SSE transport itself stays asleep (demo mode — resetTestState's
 * defaults), which is exactly the production split: the nav leg is
 * independent of the stream's connection state.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, screen } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { resetTestState, renderWithProviders } from "../../test-utils";
import { useSessionNavStore } from "../../lib/session-nav-store";
import { EventStreamStarter } from "./EventStreamStarter";

afterEach(() => {
  cleanup();
  useSessionNavStore.setState({ navSeq: 0, lastNav: null });
});

describe("EventStreamStarter (R115-E2: the navigation leg)", () => {
  it("a session-nav request navigates the Router (the store → starter → navigate bridge)", async () => {
    resetTestState();
    renderWithProviders(
      <>
        <EventStreamStarter />
        <Routes>
          <Route path="/" element={<div>home stub</div>} />
          <Route path="/project/:id/chat" element={<div>chat stub</div>} />
        </Routes>
      </>,
    );
    expect(screen.getByText("home stub")).toBeTruthy();

    // The dispatcher's write (handleEventsFrame does exactly this on a
    // device-sourced created frame while the desktop is idle).
    act(() => {
      useSessionNavStore.getState().requestNav("/project/proj_7/chat?session=sess_r115");
    });
    // Navigation is asserted by the stub route's CONTENT (the Toaster test
    // pattern — never window.location).
    expect(await screen.findByText("chat stub", {}, { timeout: 3_000 })).toBeTruthy();
    expect(screen.queryByText("home stub")).toBeNull();
  });

  it("no replay on remount: a fresh subscription never re-fires the LAST intent", async () => {
    resetTestState();
    // An intent from a "previous mount" sits in the store.
    useSessionNavStore.setState({ navSeq: 5, lastNav: { url: "/project/proj_9/chat?session=sess_old" } });
    const { unmount } = renderWithProviders(
      <>
        <EventStreamStarter />
        <Routes>
          <Route path="/" element={<div>home stub</div>} />
          <Route path="/project/:id/chat" element={<div>chat stub</div>} />
        </Routes>
      </>,
    );
    expect(screen.getByText("home stub")).toBeTruthy();
    // A beat passes — the stale intent must NOT navigate (the subscription
    // only fires on NEW writes).
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(screen.queryByText("chat stub")).toBeNull();
    expect(screen.getByText("home stub")).toBeTruthy();
    unmount();
  });
});
