// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { resolveBrowserCheckpoint } from "../../lib/api";
import { resetTestState } from "../../test-utils";
import { BrowserCheckpointCard } from "./BrowserCheckpointCard";
import type { LiveBrowserCheckpoint } from "../../lib/stream-store";

/**
 * ROUND-66 (R66, A4) — the human-verification checkpoint card: the owner's
 * directive ("a beautiful format… the timer below… manually marking it as
 * done… the option to stop"). The api module is mocked (the MemoryPanel
 * pattern); the card is props-driven with the resolve POST inside.
 */

vi.mock("../../lib/api", () => ({
  resolveBrowserCheckpoint: vi.fn(),
}));

afterEach(cleanup);

function checkpointFixture(over: Partial<LiveBrowserCheckpoint> = {}): LiveBrowserCheckpoint {
  return {
    checkpointId: "bchk_test1",
    kind: "captcha",
    url: "https://example.com/login",
    waitMs: 15_000,
    startedAtMs: Date.now(),
    state: "waiting",
    ...over,
  };
}

beforeEach(() => {
  resetTestState();
  vi.mocked(resolveBrowserCheckpoint).mockReset();
});

describe("BrowserCheckpointCard (ROUND-66 A4)", () => {
  it("renders the waiting state: kind title, URL, live countdown, progress bar, BOTH controls", async () => {
    // The tick is FAKED-deterministic: the R66 Windows-CI flake was the 1s
    // SECOND-boundary flip racing waitFor's default 1s budget (the display
    // can only change after a full wall second — a loaded runner loses that
    // race). Freeze the clock, advance it, assert the exact flip.
    vi.useFakeTimers();
    try {
      const cp = checkpointFixture();
      renderCard(cp);
      // The owner's exact naming ask: "captcha verification is needed".
      expect(screen.getByText("CAPTCHA verification needed")).toBeTruthy();
      expect(screen.getByText("https://example.com/login")).toBeTruthy();
      expect(screen.getByTestId("browser-checkpoint-countdown").textContent).toMatch(/^0:1[0-5]$/);
      expect(screen.getByRole("progressbar", { name: /time remaining/i })).toBeTruthy();
      expect(screen.getByTestId("browser-checkpoint-done").textContent).toContain("Mark as done");
      expect(screen.getByTestId("browser-checkpoint-stop").textContent).toContain("Stop waiting");
      // The countdown ticks down (100ms interval → the seconds shrink).
      const first = screen.getByTestId("browser-checkpoint-countdown").textContent ?? "";
      act(() => {
        vi.advanceTimersByTime(1_100);
      });
      const now = screen.getByTestId("browser-checkpoint-countdown").textContent ?? "";
      expect(now).not.toBe(first);
      expect(now).toBe("0:14"); // 15.0s frozen start − 1.1s advanced, ceil → 14
    } finally {
      vi.useRealTimers();
    }
  });

  it("titles the wall classes honestly (cloudflare / age / generic)", () => {
    renderCard(checkpointFixture({ kind: "cloudflare" }));
    expect(screen.getByText("Cloudflare verification needed")).toBeTruthy();
    cleanup();
    renderCard(checkpointFixture({ kind: "age" }));
    expect(screen.getByText("Age verification needed")).toBeTruthy();
    cleanup();
    renderCard(checkpointFixture({ kind: "verification" }));
    expect(screen.getByText("Human verification needed")).toBeTruthy();
  });

  it("'Mark as done' POSTs {action:'done'} and resolves to the solved one-liner", async () => {
    vi.mocked(resolveBrowserCheckpoint).mockResolvedValue({ ok: true, resolution: "done" });
    renderCard(checkpointFixture());
    fireEvent.click(screen.getByTestId("browser-checkpoint-done"));
    expect(resolveBrowserCheckpoint).toHaveBeenCalledWith("bchk_test1", "done");
    await waitFor(() => {
      expect(screen.getByTestId("browser-checkpoint-resolution").textContent).toContain(
        "You marked it solved — the agent is re-checking the page and will continue.",
      );
    });
    // Controls gone in the resolved state.
    expect(screen.queryByTestId("browser-checkpoint-done")).toBeNull();
    expect(screen.getByText("Verification solved")).toBeTruthy();
  });

  it("'Stop waiting' POSTs {action:'stop'} and resolves to the stopped one-liner", async () => {
    vi.mocked(resolveBrowserCheckpoint).mockResolvedValue({ ok: true, resolution: "stop" });
    renderCard(checkpointFixture());
    fireEvent.click(screen.getByTestId("browser-checkpoint-stop"));
    expect(resolveBrowserCheckpoint).toHaveBeenCalledWith("bchk_test1", "stop");
    await waitFor(() => {
      expect(screen.getByTestId("browser-checkpoint-resolution").textContent).toContain(
        "You stopped the wait — the agent will not retry the page and will ask how to proceed.",
      );
    });
    expect(screen.getByText("Stopped waiting")).toBeTruthy();
  });

  it("the clock hitting zero mirrors the TIMEOUT state locally (the server resolves a beat later)", async () => {
    renderCard(checkpointFixture({ startedAtMs: Date.now() - 15_000 }));
    await waitFor(() => {
      expect(screen.getByText("Wait timed out")).toBeTruthy();
    });
    expect(screen.getByTestId("browser-checkpoint-resolution").textContent).toContain(
      "The wait ran out while the wall was still up",
    );
  });

  it("an already-settled checkpoint (ok:false) shows the honest follow-along line", async () => {
    vi.mocked(resolveBrowserCheckpoint).mockResolvedValue({ ok: false, resolution: "timeout" });
    renderCard(checkpointFixture());
    fireEvent.click(screen.getByTestId("browser-checkpoint-done"));
    await waitFor(() => {
      expect(screen.getByText(/already settled — following the server's resolution/i)).toBeTruthy();
    });
  });

  it("a network failure on resolve surfaces the honest error inline (still waiting)", async () => {
    vi.mocked(resolveBrowserCheckpoint).mockRejectedValue(new Error("Could not reach agent-core"));
    renderCard(checkpointFixture());
    fireEvent.click(screen.getByTestId("browser-checkpoint-done"));
    await waitFor(() => {
      expect(screen.getByText("Could not reach agent-core")).toBeTruthy();
    });
    // Still waiting — the controls stay available for a retry.
    expect(screen.getByTestId("browser-checkpoint-done")).toBeTruthy();
  });

  it("the store's resolved frame state renders the closing line without any controls", () => {
    renderCard(checkpointFixture({ state: "done" }));
    expect(screen.getByText("Verification solved")).toBeTruthy();
    expect(screen.queryByTestId("browser-checkpoint-countdown")).toBeNull();
    expect(screen.queryByTestId("browser-checkpoint-done")).toBeNull();
  });
});

function renderCard(cp: LiveBrowserCheckpoint) {
  return act(() => {
    render(<BrowserCheckpointCard checkpoint={cp} />);
  });
}
