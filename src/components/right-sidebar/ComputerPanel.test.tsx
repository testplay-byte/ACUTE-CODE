// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  fetchComputerUseConfig,
  fetchComputerUseSession,
  stopComputerUse,
  type ComputerUseSessionState,
} from "../../lib/api";
import { resetComputerMonitorForTests, useComputerMonitorStore } from "../../lib/computer-monitor-store";
import { ComputerPanel } from "./ComputerPanel";
import type { RightSidebarTab } from "../../lib/right-sidebar-store";
import { renderWithProviders, resetTestState } from "../../test-utils";

// The panel is a VIEW over the computer-use REST surface + the monitor
// store — the api module is mocked exactly as the sidecar shapes it
// (GET session ring + GET config + POST stop).
vi.mock("../../lib/api", () => ({
  fetchComputerUseSession: vi.fn(),
  fetchComputerUseConfig: vi.fn(),
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

function configFixture(enabled: boolean) {
  return {
    settings: {
      enabled,
      permission: "observe" as const,
      vision: { mode: "off" as const, provider: null, modelId: null },
    },
    platform: "linux",
    capabilities: {},
  };
}

beforeEach(() => {
  resetTestState();
  resetComputerMonitorForTests();
  nextSession = sessionFixture();
  vi.mocked(fetchComputerUseSession).mockReset().mockImplementation(async () => nextSession);
  vi.mocked(fetchComputerUseConfig).mockReset().mockResolvedValue(configFixture(true));
  vi.mocked(stopComputerUse).mockReset().mockResolvedValue({ ok: true, reason: "" });
});

const tab: RightSidebarTab = {
  id: "tab-cpu",
  type: "computer",
  title: "Computer",
  createdAt: Date.now(),
};

describe("ComputerPanel (ROUND-61 R61-2-b)", () => {
  it("shows the OFF chip + the Settings notice when computer use is disabled; no notice while enabled", async () => {
    nextSession = sessionFixture({ active: true });
    vi.mocked(fetchComputerUseConfig).mockResolvedValue(configFixture(false));
    renderWithProviders(<ComputerPanel projectId="prj_1" tab={tab} />);

    const notice = await screen.findByTestId("computer-off-notice");
    expect(notice.textContent).toContain("turned off");
    expect(notice.textContent).toContain("Settings → Computer Use");
    // The master switch wins over the (stale) active session in the chip.
    const chip = screen.getByTestId("computer-status-chip");
    expect(chip.textContent).toContain("OFF");
    expect(chip.textContent).not.toContain("LIVE");

    // Enabled → no notice.
    cleanup();
    vi.mocked(fetchComputerUseConfig).mockResolvedValue(configFixture(true));
    renderWithProviders(<ComputerPanel projectId="prj_1" tab={tab} />);
    await screen.findByTestId("computer-stats");
    expect(screen.queryByTestId("computer-off-notice")).toBeNull();
  });

  it("shows the LIVE status chip while the control session is active", async () => {
    nextSession = sessionFixture({ active: true });
    renderWithProviders(<ComputerPanel projectId="prj_1" tab={tab} />);

    const chip = await screen.findByTestId("computer-status-chip");
    expect(chip.textContent).toContain("LIVE");
    expect(screen.queryByTestId("computer-stop-button")).toBeTruthy();
  });

  it("renders the session stat chips + the elapsed clock from the polled session", async () => {
    nextSession = sessionFixture({
      active: true,
      stats: {
        startedAt: Date.now() - 134_000,
        actionsSent: 12,
        actionsRefused: 3,
        observations: 45,
        visionCalls: 6,
      },
    });
    renderWithProviders(<ComputerPanel projectId="prj_1" tab={tab} />);

    const stats = await screen.findByTestId("computer-stats");
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("45")).toBeTruthy();
    expect(screen.getByText("6")).toBeTruthy();
    // 134s since start → "2m 14s" (±1s of render timing).
    expect(screen.getByTestId("computer-elapsed").textContent).toMatch(/2m 1[0-9]s/);
    expect(stats.textContent).toContain("enigo");
  });

  it("renders the event feed from the polled ring (labels, tool chips, refusal codes) and merges it into the store", async () => {
    nextSession = sessionFixture({
      active: true,
      events: [
        {
          seq: 3,
          ts: Date.now() - 2_000,
          kind: "refusal",
          label: "Owner declined: computer_click",
          tool: "computer_click",
          detail: { code: "host_policy_denied" },
        },
        {
          seq: 2,
          ts: Date.now() - 5_000,
          kind: "vision",
          label: "Vision (main): a login form with email and password fields",
        },
        {
          seq: 1,
          ts: Date.now() - 9_000,
          kind: "action",
          label: "Action: computer_click",
          tool: "computer_click",
        },
      ],
    });
    renderWithProviders(<ComputerPanel projectId="prj_1" tab={tab} />);

    expect(await screen.findByText("Owner declined: computer_click")).toBeTruthy();
    expect(screen.getByText("Vision (main): a login form with email and password fields")).toBeTruthy();
    expect(screen.getByText("Action: computer_click")).toBeTruthy();

    const refusalRow = document.querySelector('[data-testid="computer-event-row"][data-kind="refusal"]');
    expect(refusalRow?.textContent).toContain("computer_click");
    expect(refusalRow?.textContent).toContain("host_policy_denied");
    const actionRow = document.querySelector('[data-testid="computer-event-row"][data-kind="action"]');
    expect(actionRow?.textContent).toContain("computer_click");

    // The poll merged the server ring into the monitor store, newest first.
    await waitFor(() => {
      expect(useComputerMonitorStore.getState().events.map((e) => e.label)).toEqual([
        "Owner declined: computer_click",
        "Vision (main): a login form with email and password fields",
        "Action: computer_click",
      ]);
    });
  });

  it("STOP calls stopComputerUse with the monitor reason; the post-stop poll lands the kill switch as the disabled Stopped state", async () => {
    nextSession = sessionFixture({ active: true });
    renderWithProviders(<ComputerPanel projectId="prj_1" tab={tab} />);
    const stopBtn = await screen.findByTestId("computer-stop-button");

    // The post-stop poll will report the kill switch engaged.
    nextSession = sessionFixture({
      active: false,
      killSwitch: true,
      stopReason: "stopped by the owner from the monitor panel",
    });

    fireEvent.click(stopBtn);
    await waitFor(() =>
      expect(stopComputerUse).toHaveBeenCalledWith("stopped by the owner from the monitor panel"),
    );
    await waitFor(() => {
      const stopped = screen.getByTestId("computer-stopped-button") as HTMLButtonElement;
      expect(stopped.disabled).toBe(true);
      expect(stopped.textContent).toContain("Stopped");
    });
    // The live STOP control is gone once the kill switch is engaged.
    expect(screen.queryByTestId("computer-stop-button")).toBeNull();
    expect(useComputerMonitorStore.getState().session?.killSwitch).toBe(true);
  });

  it("shows the honest error card with a retry when the sidecar fails", async () => {
    vi.mocked(fetchComputerUseSession).mockReset().mockRejectedValue(new Error("sidecar down"));
    renderWithProviders(<ComputerPanel projectId="prj_1" tab={tab} />);

    const card = await screen.findByTestId("computer-error-card");
    expect(card.textContent).toContain("Couldn't load the computer session");
    expect(card.textContent).toContain("sidecar down");
    // The failure also lands in the monitor store (the mini window's truth).
    expect(useComputerMonitorStore.getState().error).toContain("sidecar down");

    fireEvent.click(screen.getByRole("button", { name: /Try again/i }));
    await waitFor(() => expect(fetchComputerUseSession).toHaveBeenCalledTimes(2));
  });

  it("the pop-out button floats the mini window (miniWindowOpen)", async () => {
    nextSession = sessionFixture({ active: true });
    renderWithProviders(<ComputerPanel projectId="prj_1" tab={tab} />);

    fireEvent.click(await screen.findByTestId("computer-popout-button"));
    expect(useComputerMonitorStore.getState().miniWindowOpen).toBe(true);
  });

  it("a live computer-use frame renders in the feed instantly (no poll round-trip)", async () => {
    nextSession = sessionFixture(); // idle session, empty ring
    renderWithProviders(<ComputerPanel projectId="prj_1" tab={tab} />);
    await waitFor(() => expect(fetchComputerUseSession).toHaveBeenCalledTimes(1));

    useComputerMonitorStore.getState().pushLiveEvent({ kind: "action", tool: "computer_type" });
    expect(await screen.findByText("Action: computer_type")).toBeTruthy();
    const row = document.querySelector('[data-testid="computer-event-row"][data-kind="action"]');
    expect(row?.textContent).toContain("computer_type");
    expect(useComputerMonitorStore.getState().liveActivity).toBe(true);
  });
});
