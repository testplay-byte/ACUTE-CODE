// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { fetchComputerUseSession, stopComputerUse, type ComputerUseSessionState } from "../lib/api";
import { resetComputerMonitorForTests, useComputerMonitorStore } from "../lib/computer-monitor-store";
import { ComputerMiniWindow } from "./ComputerMiniWindow";
import { renderWithProviders, resetTestState } from "../test-utils";

/**
 * ROUND-64 (R64-b) — the floating computer monitor's CONTROLLER tests.
 *
 * The monitor is no longer a manually-opened card: live SSE computer-use
 * frames (pushLiveEvent — the stream-store intercept) AUTO-show the surface,
 * and the session ending AUTO-hides it. In TAURI the surface is the
 * always-on-top OS window (mini.rs): the controller invokes
 * open/close_computer_mini and renders NOTHING in-app. In WEB mode the
 * surface is the minimal top-center pill (label + activity + STOP).
 *
 * The api module is mocked exactly as the sidecar shapes it; the Tauri
 * global is faked with a minimal `__TAURI__` stub whose core.invoke doubles
 * as the command recorder (the popout.test.tsx pattern — isTauri() from
 * lib/sidecar stays real). Timing: delays come in as tiny props so the
 * tests drive REAL timers.
 */

vi.mock("../lib/api", () => ({
  fetchComputerUseSession: vi.fn(),
  stopComputerUse: vi.fn().mockResolvedValue({ ok: true, reason: "" }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

/** Seed the monitor store directly (the web pill's poll normally does this). */
function seedSession(over: Partial<ComputerUseSessionState> = {}) {
  useComputerMonitorStore.getState().refreshFromServer(sessionFixture(over));
}

/** A live computer-use SSE frame (what stream-store's intercept pushes). */
function liveFrame(kind: string, tool?: string) {
  act(() => {
    useComputerMonitorStore.getState().pushLiveEvent({ kind, tool });
  });
}

beforeEach(() => {
  resetTestState();
  resetComputerMonitorForTests();
  nextSession = sessionFixture();
  vi.mocked(fetchComputerUseSession).mockReset().mockImplementation(async () => nextSession);
  vi.mocked(stopComputerUse).mockReset().mockResolvedValue({ ok: true, reason: "" });
  vi.unstubAllGlobals();
});

describe("ComputerMiniWindow — web mode (no Tauri shell)", () => {
  it("renders nothing by default — the pill only appears when the agent acts", async () => {
    renderWithProviders(<ComputerMiniWindow />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("computer-mini-pill")).toBeNull();
  });

  it("AUTO-shows on the first live computer-use frame with label, activity and elapsed", async () => {
    // The sidecar's ring already carries the dispatched action (server rows
    // are the authoritative feed the one-shot seed lands).
    nextSession = sessionFixture({
      events: [
        { seq: 9, ts: Date.now() - 1_000, kind: "action", label: "Action: computer_click", tool: "computer_click" },
      ],
    });
    renderWithProviders(<ComputerMiniWindow />);
    expect(screen.queryByTestId("computer-mini-pill")).toBeNull();

    // The agent starts using the computer skill — live SSE frames land.
    liveFrame("action", "computer_click");
    expect(await screen.findByTestId("computer-mini-pill")).toBeTruthy();
    expect(screen.getByTestId("mini-label").textContent).toBe("Agent is using your computer");
    expect(screen.getByTestId("mini-activity").textContent).toContain("Action: computer_click");

    // The one-shot seed lands the session truth (elapsed from startedAt).
    await waitFor(() => expect(screen.getByTestId("mini-elapsed").textContent).toMatch(/2m 1[0-9]s/));
  });

  it("AUTO-hides ~8s-equivalent after the session ends, and stays while active", async () => {
    renderWithProviders(<ComputerMiniWindow hideDelayMs={120} />);

    liveFrame("action", "computer_click");
    await screen.findByTestId("computer-mini-pill");

    // The session ends: the session_stop frame + the server truth going
    // inactive (the pill's poll / the store refresh).
    liveFrame("session_stop");
    act(() => {
      useComputerMonitorStore
        .getState()
        .refreshFromServer(sessionFixture({ active: false, killSwitch: false }));
    });

    await waitFor(() => expect(screen.queryByTestId("computer-mini-pill")).toBeNull(), {
      timeout: 2_500,
    });
  });

  it("STOP posts the floating-monitor reason and locks into the stopped state", async () => {
    seedSession({ active: true });
    renderWithProviders(<ComputerMiniWindow />);
    liveFrame("action", "computer_click");
    const stopBtn = await screen.findByTestId("mini-stop-button");

    // The post-stop session will report the kill switch engaged.
    nextSession = sessionFixture({
      active: false,
      killSwitch: true,
      stopReason: "stopped by the owner from the floating monitor",
    });

    fireEvent.click(stopBtn);
    await waitFor(() =>
      expect(stopComputerUse).toHaveBeenCalledWith("stopped by the owner from the floating monitor"),
    );
    await waitFor(() => {
      const btn = screen.getByTestId("mini-stop-button") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(btn.textContent).toContain("Stopped");
    });
    expect(screen.getByTestId("mini-label").textContent).toBe("Agent computer control stopped");
    expect(useComputerMonitorStore.getState().session?.killSwitch).toBe(true);
  });

  it("a failing STOP surfaces the honest error line and keeps the button armed", async () => {
    seedSession({ active: true });
    vi.mocked(stopComputerUse).mockRejectedValueOnce(new Error("boom: sidecar down"));
    renderWithProviders(<ComputerMiniWindow />);
    liveFrame("action", "computer_click");

    fireEvent.click(await screen.findByTestId("mini-stop-button"));
    await waitFor(() =>
      expect(screen.getByTestId("mini-activity").textContent).toContain("boom: sidecar down"),
    );
    const btn = screen.getByTestId("mini-stop-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
});

describe("ComputerMiniWindow — desktop (Tauri shell)", () => {
  /** The recorded invokes (open/close_computer_mini + sidecar_info). */
  let calls: { cmd: string }[] = [];

  function stubTauri(): void {
    calls = [];
    vi.stubGlobal("__TAURI__", {
      core: {
        invoke: vi.fn(async (cmd: string) => {
          calls.push({ cmd });
          if (cmd === "sidecar_info") return { port: 5178, token: "tok" };
          return null;
        }),
      },
    });
  }

  it("renders NOTHING in-app — the always-on-top OS window is the surface", async () => {
    stubTauri();
    renderWithProviders(<ComputerMiniWindow />);

    liveFrame("action", "computer_click");
    await waitFor(() => expect(calls.some((c) => c.cmd === "open_computer_mini")).toBe(true));
    expect(screen.queryByTestId("computer-mini-pill")).toBeNull();
  });

  it("live activity AUTO-OPENS the OS window (once per burst) and the session end CLOSES it", async () => {
    stubTauri();
    renderWithProviders(<ComputerMiniWindow closeDelayMs={100} />);

    // The burst begins: open_computer_mini fires.
    liveFrame("action", "computer_click");
    await waitFor(() => expect(calls.filter((c) => c.cmd === "open_computer_mini").length).toBe(1));

    // More frames in the SAME burst — still open, never a second open call
    // (the edge-triggered controller opens once per burst; Rust focuses any
    // existing window anyway).
    liveFrame("vision");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(calls.filter((c) => c.cmd === "open_computer_mini").length).toBe(1);
    expect(calls.filter((c) => c.cmd === "close_computer_mini")).toHaveLength(0);

    // The session ends (the session_stop SSE frame) → close after the
    // backstop delay.
    liveFrame("session_stop");
    await waitFor(() => expect(calls.some((c) => c.cmd === "close_computer_mini")).toBe(true), {
      timeout: 1_000,
    });
  });

  it("activity resuming inside the grace period CANCELS the close (the window stays)", async () => {
    stubTauri();
    renderWithProviders(<ComputerMiniWindow closeDelayMs={120} />);

    liveFrame("action", "computer_click");
    await waitFor(() => expect(calls.some((c) => c.cmd === "open_computer_mini")).toBe(true));

    // Session stops… and a NEW burst begins before the close fires.
    liveFrame("session_stop");
    liveFrame("action", "computer_click");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 260));
    });
    expect(calls.filter((c) => c.cmd === "close_computer_mini")).toHaveLength(0);
  });
});
