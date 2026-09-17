// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionGate } from "./ConnectionGate";

/**
 * ROUND-54 (R54): the offline screen must explain itself IN-APP — the engine
 * log tail (via the sidecar_log_tail shell command) renders on screen with a
 * Copy-diagnostics button, replacing the R53 "go find sidecar.log in
 * %APPDATA%" instruction that the owner understandably never followed.
 */

const sidecarMock = vi.hoisted(() => ({
  isTauri: vi.fn((): boolean => false),
  getSidecarLogTail: vi.fn(),
}));

vi.mock("../../lib/sidecar", () => sidecarMock);

const connectionMock = vi.hoisted(() => ({
  beginSidecarConnect: vi.fn(),
  retryConnection: vi.fn(),
}));

vi.mock("../../lib/sidecar-connection", () => connectionMock);

// AcuteLogo lives in Sidebar (a heavy module) — stub the import.
vi.mock("./Sidebar", () => ({
  AcuteLogo: () => <div data-testid="acute-logo" />,
}));

import { useConfigStore } from "../../lib/config-store";

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sidecarMock.isTauri.mockReturnValue(true);
  sidecarMock.getSidecarLogTail.mockResolvedValue(null);
  useConfigStore.setState({
    baseUrl: "http://127.0.0.1:5178",
    token: null,
    demoData: true,
    connection: "connecting",
    connectionError: null,
    updateInFlight: null,
  });
});

describe("ConnectionGate — connected / connecting", () => {
  it("renders children immediately when connected", () => {
    useConfigStore.setState({ connection: "connected" });
    render(
      <ConnectionGate>
        <p>APP TREE</p>
      </ConnectionGate>,
    );
    expect(screen.getByText("APP TREE")).toBeTruthy();
  });

  it("shows the connecting splash (no children mounted, no queries fire)", () => {
    render(
      <ConnectionGate>
        <p>APP TREE</p>
      </ConnectionGate>,
    );
    expect(screen.queryByText("APP TREE")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Connecting to agent-core");
  });
});

describe("ConnectionGate — R54 offline screen", () => {
  it("renders the shell error and the engine log tail with a copy button", async () => {
    sidecarMock.getSidecarLogTail.mockResolvedValue({
      path: "C:\\Users\\khurr\\AppData\\Roaming\\acute-code\\sidecar.log",
      lines: [
        "[t] sidecar: spawning `node.exe` …",
        "[t] sidecar:stderr] sidecar failed to start: SQLITE_CANTOPEN",
        "[t] sidecar: startup failed (all 3 attempts): boom",
      ],
    });
    useConfigStore.setState({
      connection: "offline",
      connectionError: "spawning `node.exe` failed: program not found",
    });

    render(
      <ConnectionGate>
        <p>APP TREE</p>
      </ConnectionGate>,
    );

    expect(screen.getByText("Can't reach agent-core")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("program not found");
    // The tail arrived and rendered — the owner reads the WHY on screen.
    await waitFor(() => {
      expect(screen.getByLabelText("Engine log tail").textContent).toContain(
        "SQLITE_CANTOPEN",
      );
    });
    expect(screen.getByLabelText("Engine log tail").textContent).toContain(
      "all 3 attempts",
    );
    expect(screen.getByRole("button", { name: /copy diagnostics/i })).toBeTruthy();
    expect(screen.getByText(/full log:/i).textContent).toContain("sidecar.log");
    // Children stay unmounted while offline.
    expect(screen.queryByText("APP TREE")).toBeNull();
    expect(sidecarMock.getSidecarLogTail).toHaveBeenCalledWith(60);
  });

  it("falls back to the %APPDATA% pointer when no log is available", async () => {
    sidecarMock.getSidecarLogTail.mockResolvedValue(null);
    useConfigStore.setState({
      connection: "offline",
      connectionError: "spawning `node.exe` failed",
    });

    render(
      <ConnectionGate>
        <p>APP TREE</p>
      </ConnectionGate>,
    );

    await waitFor(() => {
      expect(screen.getByText(/sidecar\.log/i)).toBeTruthy();
    });
    expect(screen.queryByLabelText("Engine log tail")).toBeNull();
    expect(screen.queryByRole("button", { name: /copy diagnostics/i })).toBeNull();
  });

  it("Retry drives the shell restart (retryConnection)", async () => {
    const { fireEvent } = await import("@testing-library/react");
    connectionMock.retryConnection.mockResolvedValue(undefined);
    useConfigStore.setState({
      connection: "offline",
      connectionError: "boom",
    });

    render(
      <ConnectionGate>
        <p>APP TREE</p>
      </ConnectionGate>,
    );

    fireEvent.click(screen.getByRole("button", { name: /restart engine/i }));
    await waitFor(() => {
      expect(connectionMock.retryConnection).toHaveBeenCalledTimes(1);
    });
  });
});

describe("ConnectionGate — R101-B the update hand-off", () => {
  it("renders the calm Restarting splash (not the app tree) while an update installs", () => {
    useConfigStore.setState({ connection: "connected", updateInFlight: { version: "0.99.0" } });
    render(
      <ConnectionGate>
        <p>APP TREE</p>
      </ConnectionGate>,
    );
    // Children unmount → every in-flight query cancels, no error banner flash.
    expect(screen.queryByText("APP TREE")).toBeNull();
    const splash = screen.getByTestId("update-restarting-splash");
    expect(splash.textContent).toContain("Restarting into 0.99.0");
    expect(splash.textContent).toContain("your data is kept");
  });

  it("the OFFLINE screen never shows mid-update — the splash outranks it", () => {
    // The v0.98.0 report: the deliberately-killed sidecar flipped the app to
    // the "Can't reach agent-core" error screen seconds before the exit.
    useConfigStore.setState({
      connection: "offline",
      connectionError: "agent-core stopped — restart it from the app",
      updateInFlight: { version: null },
    });
    render(
      <ConnectionGate>
        <p>APP TREE</p>
      </ConnectionGate>,
    );
    expect(screen.queryByText("Can't reach agent-core")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    const splash = screen.getByTestId("update-restarting-splash");
    expect(splash.textContent).toContain("Restarting into the new version");
  });

  it("listens for the shell's update-installing event and arms the flag (belt-and-suspenders leg)", async () => {
    const listen = vi.fn().mockResolvedValue(() => {});
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = { event: { listen } };
    try {
      render(
        <ConnectionGate>
          <p>APP TREE</p>
        </ConnectionGate>,
      );
      expect(listen).toHaveBeenCalledWith("update-installing", expect.any(Function));
      // Fire the handler the way the shell would — the flag arms, the splash
      // takes over even though nothing else in the app set it.
      const handler = listen.mock.calls[0]![1] as (ev: { payload: unknown }) => void;
      handler({ payload: null });
      expect(useConfigStore.getState().updateInFlight).toEqual({ version: null });
      await waitFor(() => {
        expect(screen.getByTestId("update-restarting-splash")).toBeTruthy();
      });
    } finally {
      delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
    }
  });
});
