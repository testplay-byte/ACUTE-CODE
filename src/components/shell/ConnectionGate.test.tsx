// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionGate } from "./ConnectionGate";
import { APP_VERSION } from "../../lib/version";

/**
 * ROUND-54 (R54): the offline screen must explain itself IN-APP — the engine
 * log tail (via the sidecar_log_tail shell command) renders on screen with a
 * Copy-diagnostics button, replacing the R53 "go find sidecar.log in
 * %APPDATA%" instruction that the owner understandably never followed.
 *
 * ROUND-118 (R118-F, round-118 §1 item 50): the update-restart marker — the
 * localStorage hand-off AboutTab.launchInstaller writes before the window
 * exits. The gate consumes it at mount: a VALID marker (this build's
 * APP_VERSION, written within the last 10 minutes) turns the connecting
 * splash into "Setting up v{VERSION}… / finishing the update — your data is
 * kept" until the sidecar connects (then the key clears, one-shot); an
 * INVALID one (mismatched version, aged out, malformed) is removed +
 * ignored — the normal connecting splash.
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

// R128-W1: the update's OS-level completion confirmation — mocked so the
// real plugin bridge never runs inside these DOM tests.
const notificationsMock = vi.hoisted(() => ({
  notifyDesktop: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/desktop-notifications", () => notificationsMock);

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
    // R118-F: the subline now sets the expectation for the WHOLE dark (the
    // window closing + the UI-less install + the relaunch) instead of the
    // old "installing the update — your data is kept, the app comes back by
    // itself" line.
    expect(splash.textContent).toContain(
      "the window will close for a moment while v0.99.0 installs — it reopens by itself",
    );
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
    // R118-F: the GENERIC subline spelling (version unknown).
    expect(splash.textContent).toContain(
      "the window will close for a moment while the new version installs — it reopens by itself",
    );
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

// ── R118-F: the update-restart marker (round-118 §1 item 50) ────────────────
//
// The relaunch's bridge over the NSIS dark: AboutTab writes
// "acute-code.update-restart" = {version, at} beside the in-flight flag
// BEFORE the invoke; this gate consumes it at mount. The tests below pin the
// full validation ladder + the one-shot consumption.

describe("ConnectionGate — R118-F the update-restart marker", () => {
  const MARKER_KEY = "acute-code.update-restart";

  /** Write a marker exactly as AboutTab.launchInstaller does. */
  function writeMarker(version: string, at: number = Date.now()): void {
    window.localStorage.setItem(MARKER_KEY, JSON.stringify({ version, at }));
  }

  it("a VALID marker (this build's version, fresh) turns the connecting splash into the setup variant", () => {
    writeMarker(APP_VERSION);
    render(
      <ConnectionGate>
        <p>APP TREE</p>
      </ConnectionGate>,
    );
    // The variant lines — same logo/spinner/layout, the update named.
    const splash = screen.getByTestId("update-setup-splash");
    expect(splash.textContent).toContain(`Setting up v${APP_VERSION}…`);
    expect(splash.textContent).toContain("finishing the update — your data is kept");
    // The generic connecting line is gone.
    expect(splash.textContent).not.toContain("Connecting to agent-core");
    // Children stay unmounted while connecting.
    expect(screen.queryByText("APP TREE")).toBeNull();
    // The key is STILL LIVE while connecting — it clears on connect only.
    expect(window.localStorage.getItem(MARKER_KEY)).not.toBeNull();
  });

  it("the marker is ONE-SHOT: it clears the moment the connection lands", async () => {
    writeMarker(APP_VERSION);
    useConfigStore.setState({ connection: "connecting" });
    const { rerender } = render(
      <ConnectionGate>
        <p>APP TREE</p>
      </ConnectionGate>,
    );
    expect(screen.getByTestId("update-setup-splash")).toBeTruthy();
    // The sidecar answers → the app tree renders + the key leaves storage…
    useConfigStore.setState({ connection: "connected" });
    rerender(
      <ConnectionGate>
        <p>APP TREE</p>
      </ConnectionGate>,
    );
    expect(screen.getByText("APP TREE")).toBeTruthy();
    expect(window.localStorage.getItem(MARKER_KEY)).toBeNull();
    // …and a LATER reconnect never re-shows the setup splash (one-shot).
    useConfigStore.setState({ connection: "connecting" });
    rerender(
      <ConnectionGate>
        <p>APP TREE</p>
      </ConnectionGate>,
    );
    expect(screen.queryByTestId("update-setup-splash")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Connecting to agent-core");
  });

  it("R128-W1: consuming a VALID marker fires the update_installed OS notification ONCE — and later reconnects never refire it", async () => {
    writeMarker(APP_VERSION);
    useConfigStore.setState({ connection: "connecting" });
    const { rerender } = render(
      <ConnectionGate>
        <p>APP TREE</p>
      </ConnectionGate>,
    );
    // The sidecar answers → the marker is consumed → the completion
    // confirmation goes to the OS (the owner's "it did not show me any
    // system or anything" report) with the exact pinned copy.
    useConfigStore.setState({ connection: "connected" });
    rerender(
      <ConnectionGate>
        <p>APP TREE</p>
      </ConnectionGate>,
    );
    await waitFor(() => {
      expect(notificationsMock.notifyDesktop).toHaveBeenCalledTimes(1);
    });
    expect(notificationsMock.notifyDesktop).toHaveBeenCalledWith({
      kind: "update_installed",
      title: "ACUTE-CODE updated",
      body: `Now running v${APP_VERSION} — your data is kept`,
    });
    // A later offline→connected cycle never refires (the one-shot marker +
    // the mount-scoped state can both only ever reach consumption once).
    useConfigStore.setState({ connection: "connecting" });
    rerender(
      <ConnectionGate>
        <p>APP TREE</p>
      </ConnectionGate>,
    );
    useConfigStore.setState({ connection: "connected" });
    rerender(
      <ConnectionGate>
        <p>APP TREE</p>
      </ConnectionGate>,
    );
    expect(notificationsMock.notifyDesktop).toHaveBeenCalledTimes(1);
  });

  it("R128-W1: a marker that never VALIDATES (the install failed — this build is not the version it names) fires NO notification", () => {
    writeMarker("0.0.0-old");
    render(
      <ConnectionGate>
        <p>APP TREE</p>
      </ConnectionGate>,
    );
    // The bad key is removed at mount (the validation's own removal) and
    // the consumption effect never sees a marker — no toast over a failed
    // install (that would be a lie).
    expect(window.localStorage.getItem(MARKER_KEY)).toBeNull();
    expect(notificationsMock.notifyDesktop).not.toHaveBeenCalled();
  });

  it("a marker for a DIFFERENT version is removed + ignored (a stale marker means the install failed)", () => {
    writeMarker("0.0.0-old");
    render(
      <ConnectionGate>
        <p>APP TREE</p>
      </ConnectionGate>,
    );
    // The normal connecting splash — and the bad key is GONE (it can never
    // resurface on a later boot).
    expect(screen.queryByTestId("update-setup-splash")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Connecting to agent-core");
    expect(window.localStorage.getItem(MARKER_KEY)).toBeNull();
  });

  it("a marker older than 10 minutes is removed + ignored (an aged marker is a failed install's leftovers)", () => {
    writeMarker(APP_VERSION, Date.now() - 11 * 60 * 1000);
    render(
      <ConnectionGate>
        <p>APP TREE</p>
      </ConnectionGate>,
    );
    expect(screen.queryByTestId("update-setup-splash")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Connecting to agent-core");
    expect(window.localStorage.getItem(MARKER_KEY)).toBeNull();
  });

  it("a malformed marker (broken JSON / wrong shape) is removed + ignored — never a crash", () => {
    for (const bad of ["{not json", "42", '{"version":123}', `{"version":"${APP_VERSION}"}`, "null"]) {
      window.localStorage.setItem(MARKER_KEY, bad);
      render(
        <ConnectionGate>
          <p>APP TREE</p>
        </ConnectionGate>,
      );
      expect(screen.queryByTestId("update-setup-splash")).toBeNull();
      expect(screen.getByRole("status").textContent).toContain("Connecting to agent-core");
      expect(window.localStorage.getItem(MARKER_KEY)).toBeNull();
      cleanup();
    }
  });
});
