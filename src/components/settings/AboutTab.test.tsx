// @vitest-environment happy-dom
/**
 * ROUND-89 (R89-A) — the About tab's three owner verdicts:
 *
 *  A1 · the reset flow must clear the FIRST-RUN GATE key `acute.setupDone`
 *       (the owner reset everything and the app restarted on the DASHBOARD,
 *       not the setup wizard — even after a full close+reopen).
 *  A2 · "Check for updates" goes through the SIDECAR (GET /system/updates —
 *       the repo is private; the old anonymous api.github.com fetch from the
 *       webview answered HTTP 404). Up-to-date, update-available, and the
 *       honest-error surfaces all render from the sidecar's answer.
 *  A3 · ROUND-99 (R99-A): the Releases button routes through the CENTRAL
 *       link router — in-app browser by default (a browser tab lands in the
 *       active project's sidebar), the honest no-project fallback to the
 *       device browser, and the EXPLICIT external affordance beside it
 *       (forceExternal) riding the Tauri open_external_url command. The
 *       pre-R99 plain <a target="_blank"> was swallowed by WebView2.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  fetchSystemUpdates,
  fetchUpdateDownloadProgress,
  resetApplication,
  startUpdateDownload,
  type SystemUpdateDownload,
} from "../../lib/api";
import { APP_VERSION } from "../../lib/version";
// R99-A: the link router’s preference cache + the stores it resolves the
// active project from (in-app routing + the no-project fallback).
import { setLinkOpeningMode } from "../../lib/open-link";
import { useProjectChatStore } from "../../lib/project-chat-store";
import { useRightSidebarStore } from "../../lib/right-sidebar-store";
// R99-C: the badge-sync store (the manual check refreshes the sidebar dot).
import { useUpdateCheckerStore } from "../../lib/update-checker";
import { resetTestState, renderWithProviders } from "../../test-utils";
import { useConfigStore } from "../../lib/config-store";
import { AboutTab } from "./AboutTab";

vi.mock("../../lib/api", () => ({
  fetchSystemUpdates: vi.fn(),
  fetchUpdateDownloadProgress: vi.fn(),
  resetApplication: vi.fn(),
  startUpdateDownload: vi.fn(),
  // R99-A: open-link.ts imports this from the same module — present in
  // the mock so the import never lands on undefined (hydration is never
  // kicked in these tests; the router’s default cache stands).
  fetchBrowserSettings: vi.fn(),
}));

// R101-B: the launch leg's recovery — a REJECTED invoke auto-restarts the
// engine instead of stranding the owner on the offline screen. Mocked so
// the real connect loop never runs inside these DOM tests.
const sidecarConnectionMock = vi.hoisted(() => ({
  retryConnection: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../lib/sidecar-connection", () => sidecarConnectionMock);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

beforeEach(() => {
  resetTestState();
  window.localStorage.clear();
  // R99-A: deterministic link routing — the in-app default, no project
  // context (each routing test sets exactly the context it pins).
  setLinkOpeningMode("in-app");
  useProjectChatStore.setState({ activeProjectId: null });
  useRightSidebarStore.setState({ activeProjectId: null, byProject: {} });
  vi.mocked(fetchSystemUpdates).mockReset();
  vi.mocked(resetApplication).mockReset();
  vi.mocked(startUpdateDownload).mockReset();
  vi.mocked(fetchUpdateDownloadProgress).mockReset();
  sidecarConnectionMock.retryConnection.mockClear();
});

describe("AboutTab (ROUND-89 R89-A)", () => {
  it("R100-A: the About rows state the ENGINE honestly (the platform answer, not 'embedded webview shell')", async () => {
    vi.mocked(fetchSystemUpdates).mockResolvedValue({
      current: "0.97.0",
      releasesUrl: "https://github.com/testplay-byte/ACUTE-CODE/releases",
      ok: true,
      latest: "0.97.0",
      updateAvailable: false,
    });
    renderWithProviders(<AboutTab />);

    // The About dl's Engine row — the owner's "which browser is this?"
    // answered platform-explicitly (R100-A's honesty surface).
    const row = await screen.findByText("Engine", { exact: true });
    expect(row.textContent).toBe("Engine");
    // The dd beside it carries the honest platform answer.
    const dd = row.parentElement?.querySelector("dd");
    expect(dd?.textContent).toContain("Windows: WebView2 (Chromium, ACUTE-branded UA)");
    expect(dd?.textContent).toContain("Linux: WebKitGTK");
    expect(dd?.textContent).toContain("local sidecar (agent-core)");
  });

  it("A2: check-for-updates asks the SIDECAR and reports up-to-date", async () => {
    vi.mocked(fetchSystemUpdates).mockResolvedValue({
      current: "0.87.0",
      releasesUrl: "https://github.com/testplay-byte/ACUTE-CODE/releases",
      ok: true,
      latest: "0.87.0",
      updateAvailable: false,
    });
    renderWithProviders(<AboutTab />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    await waitFor(() => {
      expect(screen.getByTestId("update-state").textContent).toContain("Up to date");
    });
    expect(vi.mocked(fetchSystemUpdates)).toHaveBeenCalledTimes(1);
    // The OLD bug: the webview fetched api.github.com directly (404 on the
    // private repo). The api module is the only path now.
  });

  it("A2: an available update renders the download line", async () => {
    vi.mocked(fetchSystemUpdates).mockResolvedValue({
      current: "0.86.0",
      releasesUrl: "https://github.com/testplay-byte/ACUTE-CODE/releases",
      ok: true,
      latest: "0.87.0",
      updateAvailable: true,
      releaseUrl: "https://github.com/testplay-byte/ACUTE-CODE/releases/tag/v0.87.0",
    });
    renderWithProviders(<AboutTab />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    await waitFor(() => {
      expect(screen.getByTestId("update-state").textContent).toContain("0.87.0");
    });
  });

  it("A2: a failed check renders the honest error (no raw fetch, no 404 wall)", async () => {
    vi.mocked(fetchSystemUpdates).mockResolvedValue({
      current: "0.87.0",
      releasesUrl: "https://github.com/testplay-byte/ACUTE-CODE/releases",
      ok: false,
      reason: "no-token",
      error: "the launcher's GitHub token is not saved on this machine",
    });
    renderWithProviders(<AboutTab />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    await waitFor(() => {
      expect(screen.getByTestId("update-state").textContent).toContain(
        "the launcher's GitHub token is not saved",
      );
    });
  });

  it("A1: reset clears the first-run gate key (acute.setupDone) with the rest", async () => {
    // The gate key set = the app believes setup is done (dashboard boot).
    window.localStorage.setItem("acute.setupDone", "1");
    window.localStorage.setItem("acute-code.theme", "dark");
    vi.mocked(resetApplication).mockResolvedValue({
      ok: true,
      abortedTurns: 0,
      wipedTables: 12,
      purgedFiles: 2,
    });
    // The reload the real flow performs — capture + cancel it.
    const originalHref = window.location.href;
    const hrefSetter = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, set href(v: string) { hrefSetter(v); } },
      writable: true,
    });

    renderWithProviders(<AboutTab />);
    fireEvent.change(screen.getByTestId("reset-confirm-input"), { target: { value: "RESET" } });
    fireEvent.click(screen.getByTestId("reset-confirm-button"));

    await waitFor(() => {
      expect(vi.mocked(resetApplication)).toHaveBeenCalledTimes(1);
    });
    // THE R89-A1 ASSERTION: the gate key is gone — the next boot runs the
    // setup wizard (shouldRunSetup reads exactly this key).
    expect(window.localStorage.getItem("acute.setupDone")).toBeNull();
    expect(window.localStorage.getItem("acute-code.theme")).toBeNull();
    expect(hrefSetter).toHaveBeenCalledWith("/");

    // Restore the real location for the remaining tests in the file.
    Object.defineProperty(window, "location", { value: originalHref, writable: true });
  });

  it("A3/R99-A: the Releases button routes IN-APP — a browser tab lands in the active project's sidebar", async () => {
    useProjectChatStore.setState({ activeProjectId: "prj_about" });
    renderWithProviders(<AboutTab />);

    fireEvent.click(screen.getByTestId("about-releases-button"));

    await waitFor(() => {
      const tabs = Object.values(useRightSidebarStore.getState().byProject).flatMap((slice) =>
        slice.tabs.filter((t) => t.type === "browser"),
      );
      expect(tabs).toEqual([
        expect.objectContaining({
          type: "browser",
          browserUrl: "https://github.com/testplay-byte/ACUTE-CODE/releases",
        }),
      ]);
    });
  });

  it("A3/R99-A: with NO project context the Releases button falls back to the device browser (window.open in web mode)", async () => {
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    renderWithProviders(<AboutTab />);

    fireEvent.click(screen.getByTestId("about-releases-button"));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        "https://github.com/testplay-byte/ACUTE-CODE/releases",
        "_blank",
        "noreferrer",
      );
    });
  });

  it("A3/R99-A: the EXPLICIT external affordance hands the URL to the Tauri open_external_url command", async () => {
    // isTauri() probes `"__TAURI__" in window` — setting the global before
    // render is the whole mock (sidecar.ts line 38).
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
    renderWithProviders(<AboutTab />);

    fireEvent.click(screen.getByTestId("about-releases-external"));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("open_external_url", {
        url: "https://github.com/testplay-byte/ACUTE-CODE/releases",
      });
    });
    // The in-app leg never fired — forceExternal is the deliberate device-browser gesture.
    expect(Object.values(useRightSidebarStore.getState().byProject)).toHaveLength(0);
  });
});

// ── R99-C: THE ONE-CLICK SILENT UPDATE. The owner's directive: "I click
// the update button in the application and everything else happens
// automatically afterwards by itself without me having to make any
// changes." The available-update card becomes a real card (version line +
// collapsible "What's new" + the ONE button), the flow is honest at every
// step (byte-true MB + %, the checksum verify, the silent launch), and a
// REJECTED silent launch keeps the legacy interactive wizard one click
// away — reusing the already-verified installer, never re-downloading.
describe("AboutTab R99-C: the one-click silent update", () => {
  /** The full happy-path progress sequence updateNow walks: the reuse
   * check (idle) → download poll (partial bytes) → verify poll → ready.
   * The sticky DEFAULT is "ready": the sidecar's single-flight state stays
   * ready once an installer is verified, so the fallback's reuse check (a
   * 5th call) still finds it — that reuse IS the no-re-download contract. */
  function mockDownloadSequence(): void {
    const state = (patch: Partial<SystemUpdateDownload>): SystemUpdateDownload => ({
      status: "idle",
      received: 0,
      total: 0,
      path: null,
      version: null,
      error: null,
      ...patch,
    });
    const ready = state({
      status: "ready",
      path: "C:\\Temp\\ACUTE-CODE-0.87.0-x64-setup.exe",
      version: "0.87.0",
    });
    vi.mocked(fetchUpdateDownloadProgress)
      .mockResolvedValue(ready)
      .mockResolvedValueOnce(state({})) // the reuse check (nothing ready yet)
      .mockResolvedValueOnce(state({ status: "downloading", received: 13_000_000, total: 38_700_000 }))
      .mockResolvedValueOnce(state({ status: "verifying" }))
      .mockResolvedValueOnce(ready);
    vi.mocked(startUpdateDownload).mockResolvedValue({ ok: true, status: "downloading" });
  }

  function mockAvailableRelease(): void {
    vi.mocked(fetchSystemUpdates).mockResolvedValue({
      current: APP_VERSION,
      releasesUrl: "https://github.com/testplay-byte/ACUTE-CODE/releases",
      ok: true,
      latest: "0.87.0",
      updateAvailable: true,
      releaseUrl: "https://github.com/testplay-byte/ACUTE-CODE/releases/tag/v0.87.0",
      body: "## What's new\n\n- the one-click silent update\n- the startup auto-check",
      asset: {
        url: "https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/42",
        size: 38_700_000,
        digest: `sha256:${"ab".repeat(32)}`,
      },
    });
  }

  it("renders the one-click card — the version line, the What's-new block, the Update now button, the auto-check toggle — and SYNCs the badge", async () => {
    mockAvailableRelease();
    // The Update now button is desktop-only (a browser has no installer) —
    // the __TAURI__ global is the whole shell mock.
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke: vi.fn().mockResolvedValue(undefined) },
    };
    renderWithProviders(<AboutTab />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    await waitFor(() => {
      expect(screen.getByTestId("update-state").textContent).toContain("Update available — v0.87.0");
    });
    // The current → new version line (tabular-nums mono).
    expect(screen.getByTestId("update-state").textContent).toContain(`v${APP_VERSION} → v0.87.0`);
    // The release notes block (collapsible; the route's body passthrough).
    expect(screen.getByTestId("update-notes-body").textContent).toContain("the one-click silent update");
    // The ONE button + the persisted auto-check toggle.
    expect(screen.getByTestId("update-now-button")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Check for updates automatically" })).toBeTruthy();
    // The manual check refreshes the sidebar's pending-update dot (the
    // R99-C badge-sync contract: one sync, two callers).
    expect(useUpdateCheckerStore.getState().pendingVersion).toBe("0.87.0");
  });

  it("the manual check CLEARS the badge when the answer is up-to-date", async () => {
    useUpdateCheckerStore.setState({ pendingVersion: "0.87.0" });
    vi.mocked(fetchSystemUpdates).mockResolvedValue({
      current: APP_VERSION,
      releasesUrl: "x",
      ok: true,
      latest: APP_VERSION,
      updateAvailable: false,
    });
    renderWithProviders(<AboutTab />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    await waitFor(() => {
      expect(screen.getByTestId("update-state").textContent).toContain("Up to date");
    });
    expect(useUpdateCheckerStore.getState().pendingVersion).toBeNull();
  });

  it("the What's-new block collapses blank-line runs + expands via the chevron", async () => {
    vi.mocked(fetchSystemUpdates).mockResolvedValue({
      current: APP_VERSION,
      releasesUrl: "x",
      ok: true,
      latest: "0.87.0",
      updateAvailable: true,
      body: "Line one\n\n\n\n\nLine two",
    });
    renderWithProviders(<AboutTab />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    await waitFor(() => {
      expect(screen.getByTestId("update-notes-body")).toBeTruthy();
    });
    // Runs of blank lines collapse to ONE blank line (the markdown source's
    // 3+ newlines are vertical noise in the mono block).
    expect(screen.getByTestId("update-notes-body").textContent).toBe("Line one\n\nLine two");
    const toggle = screen.getByTestId("update-notes-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("Update now runs the automatic sequence — byte-true progress (MB + %), then the SILENT invoke, then the restarting line", async () => {
    mockAvailableRelease();
    mockDownloadSequence();
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
    renderWithProviders(<AboutTab />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => {
      expect(screen.getByTestId("update-now-button")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("update-now-button"));

    // Step 1 — DOWNLOADING with the byte-true readout: 13,000,000 B =
    // 12.4 MB of the 38,700,000 B total = 36.9 MB · 33% (real chunk data
    // only, tabular-nums — never a fabricated indeterminate percentage).
    await waitFor(
      () => {
        expect(screen.getByTestId("update-progress").textContent).toContain(
          "Downloading — 12.4 MB of 36.9 MB · 33%",
        );
      },
      { timeout: 6_000 },
    );
    // Step 2 — VERIFYING (the sha256 checksum leg).
    await waitFor(
      () => {
        expect(screen.getByTestId("update-verifying")).toBeTruthy();
      },
      { timeout: 6_000 },
    );
    // Step 3 — the SILENT INSTALL invoke: the exact IPC arg the Rust
    // command's NSIS "/S /R" leg keys on.
    await waitFor(
      () => {
        expect(invoke).toHaveBeenCalledWith("run_update_installer", {
          path: "C:\\Temp\\ACUTE-CODE-0.87.0-x64-setup.exe",
          silent: true,
        });
      },
      { timeout: 6_000 },
    );
    // Step 4 — the terminal line for the 1.5s the window survives.
    await waitFor(
      () => {
        expect(screen.getByTestId("update-launched").textContent).toContain("Restarting into v0.87.0");
      },
      { timeout: 6_000 },
    );
    expect(screen.getByTestId("update-launched").textContent).toContain("your data is kept");
    // R101-B: the hand-off flag armed BEFORE the invoke (the ConnectionGate
    // shows the Restarting splash from the moment the kill starts) — and it
    // STAYS armed: the app is exiting, nothing clears it on the success leg.
    expect(useConfigStore.getState().updateInFlight).toEqual({ version: "0.87.0" });
  });

  it("a REJECTED silent invoke shows the honest error + the wizard escape hatch — which reuses the verified installer (no re-download)", async () => {
    mockAvailableRelease();
    mockDownloadSequence();
    // The silent launch leg rejects with the Rust error string (the ShellExecuteW
    // SE_ERR path); the wizard retry resolves.
    const invoke = vi.fn()
      .mockRejectedValueOnce("launching the silent installer failed: ShellExecuteW answered 5 — the OS refused the launch (access denied)")
      .mockResolvedValue(undefined);
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
    renderWithProviders(<AboutTab />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => {
      expect(screen.getByTestId("update-now-button")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("update-now-button"));

    // The honest error (role=alert, the Rust string verbatim) + the button.
    await waitFor(
      () => {
        expect(screen.getByTestId("update-flow-error").textContent).toContain("ShellExecuteW answered 5");
      },
      { timeout: 6_000 },
    );
    expect(screen.getByTestId("update-flow-error").getAttribute("role")).toBe("alert");
    // R101-B: the failed launch left the engine dead for nothing — the flag
    // is CLEARED and the engine auto-restarts (no manual Restart chore, no
    // offline screen for a backend the update path killed on purpose).
    expect(useConfigStore.getState().updateInFlight).toBeNull();
    expect(sidecarConnectionMock.retryConnection).toHaveBeenCalledTimes(1);
    const fallback = screen.getByTestId("update-wizard-fallback");
    expect(fallback.textContent).toBe("Run the setup wizard manually");

    // The escape hatch re-runs with silent:false — and REUSES the verified
    // installer (the single-flight state is still "ready"): exactly ONE
    // download for the whole journey.
    fireEvent.click(fallback);
    await waitFor(
      () => {
        expect(invoke).toHaveBeenCalledWith("run_update_installer", {
          path: "C:\\Temp\\ACUTE-CODE-0.87.0-x64-setup.exe",
          silent: false,
        });
      },
      { timeout: 6_000 },
    );
    expect(vi.mocked(startUpdateDownload)).toHaveBeenCalledTimes(1);
    // The wizard leg's honest terminal copy (the pre-R99 line, re-pinned).
    await waitFor(
      () => {
        expect(screen.getByTestId("update-launched").textContent).toContain(
          "the setup wizard will close this app and install v0.87.0",
        );
      },
      { timeout: 6_000 },
    );
  });

  it("the auto-check toggle flips the persisted update-checker store", async () => {
    renderWithProviders(<AboutTab />);

    expect(useUpdateCheckerStore.getState().autoCheck).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Check for updates automatically" }));
    expect(useUpdateCheckerStore.getState().autoCheck).toBe(false);
    // And back — the toggle is live in both directions.
    fireEvent.click(screen.getByRole("switch", { name: "Check for updates automatically" }));
    expect(useUpdateCheckerStore.getState().autoCheck).toBe(true);
  });
});
