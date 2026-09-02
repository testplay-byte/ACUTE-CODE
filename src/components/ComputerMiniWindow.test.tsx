// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { fetchComputerUseSession, stopComputerUse, type ComputerUseSessionState } from "../lib/api";
import { resetComputerMonitorForTests, useComputerMonitorStore } from "../lib/computer-monitor-store";
import { ComputerMiniWindow } from "./ComputerMiniWindow";
import { renderWithProviders, resetTestState } from "../test-utils";

// The mini window self-manages via the monitor store + the computer-use REST
// surface (one-shot session seed on open, POST stop on the kill switch) —
// the api module is mocked exactly as the sidecar shapes it.
vi.mock("../lib/api", () => ({
  fetchComputerUseSession: vi.fn(),
  stopComputerUse: vi.fn().mockResolvedValue({ ok: true, reason: "" }),
}));

afterEach(cleanup);

/** The session the next GET /computer-use/session resolves with (tests
 * mutate it to move the server's truth forward, e.g. after a stop). */
let nextSession: ComputerUseSessionState = sessionFixture();

function sessionFixture(over: Partial<ComputerUseSessionState> = {}): ComputerUseSessionState {
  const startedAt = Date.now() - 134_000; // → "2m 14s" elapsed
  return {
    active: false,
    killSwitch: false,
    backendKind: "enigo",
    startedAt,
    stopReason: null,
    stats: { startedAt, actionsSent: 0, actionsRefused: 0, observations: 0, visionCalls: 0 },
    events: [],
    ...over,
  };
}

/** Seed the monitor store directly (the panel's polls normally do this). */
function seedSession(over: Partial<ComputerUseSessionState> = {}) {
  useComputerMonitorStore.getState().refreshFromServer(sessionFixture(over));
}

beforeEach(() => {
  resetTestState();
  resetComputerMonitorForTests();
  nextSession = sessionFixture();
  vi.mocked(fetchComputerUseSession).mockReset().mockImplementation(async () => nextSession);
  vi.mocked(stopComputerUse).mockReset().mockResolvedValue({ ok: true, reason: "" });
});

describe("ComputerMiniWindow (ROUND-61 R61-2-b)", () => {
  it("renders nothing until the store opens it, then the floating card appears", async () => {
    renderWithProviders(<ComputerMiniWindow />);
    expect(screen.queryByTestId("computer-mini-window")).toBeNull();

    useComputerMonitorStore.getState().setMiniWindowOpen(true);
    await waitFor(() => expect(screen.getByTestId("computer-mini-window")).toBeTruthy());
  });

  it("shows the newest event with the biggest weight, the older rows, and the stats strip", async () => {
    seedSession({
      active: true,
      stats: {
        startedAt: Date.now() - 134_000,
        actionsSent: 12,
        actionsRefused: 3,
        observations: 45,
        visionCalls: 6,
      },
      events: [
        { seq: 2, ts: Date.now() - 2_000, kind: "action", label: "Action: computer_click", tool: "computer_click" },
        { seq: 1, ts: Date.now() - 9_000, kind: "vision", label: "Vision (main): a login form with email and password fields" },
      ],
    });
    useComputerMonitorStore.getState().setMiniWindowOpen(true);
    renderWithProviders(<ComputerMiniWindow />);

    expect(screen.getByText("What it's doing")).toBeTruthy();
    const top = await screen.findByTestId("mini-top-event");
    expect(top.textContent).toContain("Action: computer_click");
    expect(top.textContent).toContain("computer_click");
    // The older event renders as a compact row (and, being the newest vision
    // row, in the vision spotlight too — hence getAllByText).
    expect(
      screen.getAllByText("Vision (main): a login form with email and password fields").length,
    ).toBeGreaterThanOrEqual(1);

    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("45")).toBeTruthy();
    expect(screen.getByText("6")).toBeTruthy();
    expect(screen.getByTestId("mini-elapsed").textContent).toMatch(/2m 1[0-9]s/);
    // Live session → the pulsing LIVE badge.
    expect(screen.getByTestId("mini-live-badge").textContent).toContain("LIVE");
  });

  it("spotlights the newest refusal (tool · code) — the wall the agent must recover from", async () => {
    seedSession({
      active: true,
      events: [
        {
          seq: 1,
          ts: Date.now(),
          kind: "refusal",
          label: "Refused: computer_click",
          tool: "computer_click",
          detail: { code: "host_policy_denied" },
        },
      ],
    });
    useComputerMonitorStore.getState().setMiniWindowOpen(true);
    renderWithProviders(<ComputerMiniWindow />);

    const spot = await screen.findByTestId("mini-refusal-spotlight");
    expect(spot.textContent).toContain("Refused: computer_click · host_policy_denied");
  });

  it("renders the vision spotlight with the newest vision description", async () => {
    seedSession({
      active: true,
      events: [
        { seq: 2, ts: Date.now() - 1_000, kind: "action", label: "Action: computer_type", tool: "computer_type" },
        { seq: 1, ts: Date.now() - 3_000, kind: "vision", label: "Vision (main): a text editor with unsaved changes" },
      ],
    });
    useComputerMonitorStore.getState().setMiniWindowOpen(true);
    renderWithProviders(<ComputerMiniWindow />);

    const spot = await screen.findByTestId("mini-vision-spotlight");
    expect(spot.textContent).toContain("Vision (main): a text editor with unsaved changes");
  });

  it("the STOP kill switch calls stopComputerUse and locks into the stopped state", async () => {
    seedSession({ active: true });
    useComputerMonitorStore.getState().setMiniWindowOpen(true);
    renderWithProviders(<ComputerMiniWindow />);
    const stopBtn = await screen.findByTestId("mini-stop-button");

    // The post-stop session fetch will report the kill switch engaged.
    nextSession = sessionFixture({
      active: false,
      killSwitch: true,
      stopReason: "stopped by the owner from the mini window",
    });

    fireEvent.click(stopBtn);
    await waitFor(() =>
      expect(stopComputerUse).toHaveBeenCalledWith("stopped by the owner from the mini window"),
    );
    await waitFor(() => {
      const btn = screen.getByTestId("mini-stop-button") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(btn.textContent).toContain("Stopped — the kill switch is active");
    });
    expect(useComputerMonitorStore.getState().session?.killSwitch).toBe(true);
  });

  it("the close button clears miniWindowOpen and the window animates away", async () => {
    seedSession({ active: true });
    useComputerMonitorStore.getState().setMiniWindowOpen(true);
    renderWithProviders(<ComputerMiniWindow />);

    fireEvent.click(await screen.findByRole("button", { name: /Close the computer monitor mini window/i }));
    expect(useComputerMonitorStore.getState().miniWindowOpen).toBe(false);
    await waitFor(() => expect(screen.queryByTestId("computer-mini-window")).toBeNull(), { timeout: 2500 });
  });

  it("drags by the title bar (pointer events) and stays clamped inside the viewport", async () => {
    seedSession({ active: true });
    useComputerMonitorStore.getState().setMiniWindowOpen(true);
    renderWithProviders(<ComputerMiniWindow />);

    const win = await screen.findByTestId("computer-mini-window");
    // happy-dom viewport is 1024×768 → the card starts bottom-right (left 664px).
    expect(win.style.left).toBe("664px");

    const bar = screen.getByTestId("computer-mini-titlebar");
    fireEvent.pointerDown(bar, { button: 0, clientX: 700, clientY: 500, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 400, clientY: 300, pointerId: 1 });

    // 664px + (400 − 700) → 364px, inside the viewport bounds.
    await waitFor(() => expect(win.style.left).toBe("364px"));
  });
});
