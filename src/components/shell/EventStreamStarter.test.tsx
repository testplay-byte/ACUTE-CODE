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
 *
 * R132-V (the visual-battery fix — the StrictMode kill): the LIVE-mode
 * describe below pins the regression the R132 visual battery caught — the
 * old startedRef guard meant React 18 StrictMode's double-invoked effects
 * (setup → cleanup → setup) left the app with ZERO live events-stream
 * connections (run 1 aborted by the strict cleanup, run 2 early-returned
 * on the still-true ref). The transport is mocked at its seam so the OPEN
 * COUNT is the assertion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { StrictMode } from "react";
import { resetTestState, renderWithProviders } from "../../test-utils";
import { useSessionNavStore } from "../../lib/session-nav-store";
import { useConfigStore } from "../../lib/config-store";

vi.mock("../../lib/events-stream", () => ({
  handleEventsFrame: vi.fn(),
  openEventsStream: vi.fn(async (): Promise<void> => new Promise<void>(() => undefined)),
}));

import { openEventsStream } from "../../lib/events-stream";
import { EventStreamStarter } from "./EventStreamStarter";

afterEach(() => {
  cleanup();
  useSessionNavStore.setState({ navSeq: 0, lastNav: null });
  vi.mocked(openEventsStream).mockClear();
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

describe("EventStreamStarter (R132-V: the StrictMode kill — the stream must survive the double-mount)", () => {
  beforeEach(() => {
    resetTestState();
    // LIVE mode — the env-wired dev shape (the visual battery's setup).
    useConfigStore.setState({ demoData: false, baseUrl: "http://127.0.0.1:5178", token: "tok" });
  });

  it("a real remount re-opens the stream (unmount aborts, the next mount connects again)", () => {
    const first = renderWithProviders(<EventStreamStarter />);
    expect(openEventsStream).toHaveBeenCalledTimes(1);
    first.unmount();
    // The second mount must open a FRESH connection — the old startedRef
    // guard early-returned here and the app lived streamless forever.
    renderWithProviders(<EventStreamStarter />);
    expect(openEventsStream).toHaveBeenCalledTimes(2);
  });

  it("StrictMode's double-invoked effects end with ONE live connection (setup → abort → setup)", () => {
    // The faithful reproduction of the visual battery's browser: main.tsx
    // mounts the app inside <StrictMode>, whose dev-mode effect cycle is
    // setup → cleanup → setup. The FIRST setup's connection is aborted by
    // the cleanup; the SECOND setup must open its own — with the old
    // startedRef guard the second returned early (1 call, 0 live).
    renderWithProviders(
      <StrictMode>
        <EventStreamStarter />
      </StrictMode>,
    );
    expect(openEventsStream).toHaveBeenCalledTimes(2);
  });

  it("demo mode never opens the stream (the skip arm — unchanged by R132-V)", () => {
    useConfigStore.setState({ demoData: true, token: null });
    renderWithProviders(<EventStreamStarter />);
    expect(openEventsStream).not.toHaveBeenCalled();
  });
});
