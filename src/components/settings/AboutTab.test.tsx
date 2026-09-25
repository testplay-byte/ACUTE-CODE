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
 *  A3 · ROUND-99 (R99-A) → ROUND-120 (R120-U): the Releases button routes
 *       through the CENTRAL link router and now ALWAYS takes the
 *       force-external leg (the Tauri open_external_url command; window.open
 *       in web mode). The owner's v0.113.0 report: the in-app default
 *       no-oped from the Settings surface (the tab lands in the active
 *       project's sidebar, out of sight) and the embedded browser itself
 *       was "not a good experience" — so release links NEVER open in-app,
 *       and the separate external escape-hatch icon button is retired (the
 *       plain button does exactly what it did). The pre-R99 plain
 *       <a target="_blank"> was swallowed by WebView2.
 *
 * ROUND-120 (R120-U) — the updater's PAT-rotation resilience:
 *  · a check answer carrying tokenWarning (the sidecar's dead-PAT anonymous
 *    retry carried it) renders the amber hint line + AUTO-OPENS the quiet
 *    "GitHub token" re-pairing row;
 *  · a check answer with reason "token-rejected" (both legs failed) does
 *    the same on the honest error surface;
 *  · the row's Save PUTs the token through the sidecar (never the webview),
 *    then RE-RUNS the check — the success feedback is the card's own fresh
 *    answer; a refused save renders the honest thrown message, no re-run;
 *  · the footer disclosure opens the row ANY time (the health line rides
 *    GET /system/updates/token, never the token's value).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  discardUpdateDownload,
  fetchSystemUpdates,
  fetchUpdateDownloadProgress,
  fetchUpdateTokenStatus,
  removeUpdateToken,
  resetApplication,
  saveUpdateToken,
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
  removeUpdateToken: vi.fn(),
  fetchUpdateDownloadProgress: vi.fn(),
  discardUpdateDownload: vi.fn(),
  resetApplication: vi.fn(),
  startUpdateDownload: vi.fn(),
  // R120-U: the token re-pairing path's two client fns.
  fetchUpdateTokenStatus: vi.fn(),
  saveUpdateToken: vi.fn(),
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
  vi.mocked(discardUpdateDownload).mockReset().mockResolvedValue({ ok: true, status: "idle" });
  // R120-U: the token row's default health answer — no token saved (each
  // test that opens the row overrides what it needs to pin).
  vi.mocked(fetchUpdateTokenStatus).mockReset().mockResolvedValue({ present: false, valid: null });
  vi.mocked(saveUpdateToken).mockReset().mockResolvedValue({ ok: true, valid: true });
  // R123: the removal route's default answer — nothing removed (each test
  // that exercises the Remove flow overrides what it needs to pin).
  vi.mocked(removeUpdateToken).mockReset().mockResolvedValue({ ok: true, removed: false });
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

  it("A3/R120-U: the Releases button hands the URL to the Tauri open_external_url command — EVEN with an active project (never the in-app tab)", async () => {
    // The owner's v0.113.0 report: the plain "Releases" button did nothing
    // from the Settings surface. The root cause: the R99-A router's IN-APP
    // leg resolves the active project and lands the link as a browser tab
    // in that project's right sidebar — a tab the owner cannot see from
    // Settings. The fix under test: the button ALWAYS takes the external
    // leg, active project or not, and the right-sidebar store stays empty.
    useProjectChatStore.setState({ activeProjectId: "prj_about" });
    // isTauri() probes `"__TAURI__" in window` — setting the global before
    // render is the whole mock (sidecar.ts line 38).
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
    renderWithProviders(<AboutTab />);

    fireEvent.click(screen.getByTestId("about-releases-button"));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("open_external_url", {
        url: "https://github.com/testplay-byte/ACUTE-CODE/releases",
      });
    });
    // The in-app leg NEVER fired — release links never open the embedded
    // browser (the R99-A in-app routing law's one carve-out, this round).
    expect(Object.values(useRightSidebarStore.getState().byProject)).toHaveLength(0);
  });

  it("A3/R120-U: web mode opens the device browser via window.open (the external leg's fallback)", async () => {
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
    // And no in-app tab either — the same one-path law in web mode.
    expect(Object.values(useRightSidebarStore.getState().byProject)).toHaveLength(0);
  });
});

// ── R99-C + R104: THE UPDATE HAND-SHAKE. R99-C's directive ("I click the
// update button… everything else happens automatically") became the
// v0.100.0 report's retirement of the auto-install ("I want the ability
// to download it then confirm to update it, or click the update button in
// the About section to update it"): the flow is now TWO stages — Download
// (byte-true progress + the checksum verify) STOPS at a verified staged
// file, and ONLY the explicit "Restart and update now" confirmation
// launches the install. The staged row also SURVIVES the About tab (the
// mount-resume adoption) so the owner can confirm any time, and a
// REJECTED launch keeps the legacy interactive wizard one click away on
// WINDOWS setups only (an AppImage has no wizard) — reusing the
// already-verified installer, never re-downloading.
describe("AboutTab R99-C/R104: the two-stage update hand-shake", () => {
  /** A staged/progress state factory (the sidecar's single-flight shape). */
  const dlState = (patch: Partial<SystemUpdateDownload>): SystemUpdateDownload => ({
    status: "idle",
    received: 0,
    total: 0,
    path: null,
    version: null,
    error: null,
    ...patch,
  });

  /** A version strictly NEWER than the engine's — the mount-resume
   * adoption + the stale self-heal compare against the LIVE APP_VERSION
   * (the R101-hotfix pin-rot lesson: a hardcoded future version ages out
   * the moment the engine reaches it). */
  const NEWER_VERSION: string = (() => {
    const [maj, min, patch] = APP_VERSION.split(".").map((n) => Number.parseInt(n, 10));
    return `${maj}.${min}.${patch + 1}`;
  })();

  /** The full happy-path progress sequence the two-stage flow walks:
   * the MOUNT-resume probe (idle — nothing in flight) → downloadUpdate's
   * reuse check (idle) → download poll (partial bytes) → verify poll →
   * ready. The sticky DEFAULT is "ready": the sidecar's single-flight
   * state stays ready once the file is verified, so the wizard fallback's
   * belt re-read (any later call) still finds it — that reuse IS the
   * no-re-download contract. */
  function mockDownloadSequence(): void {
    const ready = dlState({
      status: "ready",
      path: "C:\\Temp\\ACUTE-CODE_0.87.0_x64-setup.exe",
      version: "0.87.0",
    });
    vi.mocked(fetchUpdateDownloadProgress)
      .mockResolvedValue(ready)
      .mockResolvedValueOnce(dlState({})) // the MOUNT-resume probe (nothing in flight)
      .mockResolvedValueOnce(dlState({})) // downloadUpdate's reuse check (nothing ready yet)
      .mockResolvedValueOnce(dlState({ status: "downloading", received: 13_000_000, total: 38_700_000 }))
      .mockResolvedValueOnce(dlState({ status: "verifying" }))
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
      body: "## What's new\n\n- the two-stage update hand-shake\n- the startup auto-check",
      // R104: the platform-aware asset carries the kind + the REAL asset
      // filename (the staged file keeps GitHub's extension).
      asset: {
        url: "https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/42",
        size: 38_700_000,
        digest: `sha256:${"ab".repeat(32)}`,
        kind: "windows-setup",
        name: "ACUTE-CODE_0.87.0_x64-setup.exe",
      },
    });
  }

  it("renders the available-update card — the version line, the What's-new block, the Download button, the auto-check toggle — and SYNCs the badge", async () => {
    mockAvailableRelease();
    // The Download button is desktop-only (a browser has no updater) —
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
    expect(screen.getByTestId("update-notes-body").textContent).toContain("the two-stage update hand-shake");
    // The STAGE-1 button + the persisted auto-check toggle.
    expect(screen.getByTestId("update-download-button")).toBeTruthy();
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

  it("R104: the two-stage hand-shake — Download stops at the STAGED row (no install), the confirm invokes the silent install, then the restarting line", async () => {
    mockAvailableRelease();
    mockDownloadSequence();
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
    renderWithProviders(<AboutTab />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => {
      expect(screen.getByTestId("update-download-button")).toBeTruthy();
    });
    // STAGE 1 — the download (and nothing else).
    fireEvent.click(screen.getByTestId("update-download-button"));

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
    // Step 3 — READY: the flow STOPS. The staged row renders with the
    // confirmation button + the walk-back — and the install invoke has
    // NOT fired (the v0.100.0 report's core ask: nothing auto-installs
    // after a download).
    await waitFor(
      () => {
        expect(screen.getByTestId("update-staged").textContent).toContain(
          "Downloaded and verified — v0.87.0 is ready to install",
        );
      },
      { timeout: 6_000 },
    );
    expect(screen.getByTestId("update-install-button").textContent).toContain("Restart and update now");
    expect(screen.getByTestId("update-discard-button").textContent).toBe("Discard download");
    expect(invoke).not.toHaveBeenCalled();

    // STAGE 2 — the explicit confirmation.
    fireEvent.click(screen.getByTestId("update-install-button"));
    // The SILENT INSTALL invoke: the exact IPC arg the Rust command's
    // NSIS "/S /R" leg keys on.
    await waitFor(
      () => {
        expect(invoke).toHaveBeenCalledWith("run_update_installer", {
          path: "C:\\Temp\\ACUTE-CODE_0.87.0_x64-setup.exe",
          silent: true,
          version: "0.87.0",
        });
      },
      { timeout: 6_000 },
    );
    // The terminal line for the 1.5s the window survives.
    await waitFor(
      () => {
        expect(screen.getByTestId("update-launched").textContent).toContain("Restarting into v0.87.0");
      },
      { timeout: 6_000 },
    );
    expect(screen.getByTestId("update-launched").textContent).toContain("your data is kept");
    // R128-W1: the honest supervisor line under the terminal copy — the
    // owner's "it did not auto-start at all" incident is answered by a
    // process OUTSIDE the app, and the card says so plainly.
    expect(screen.getByTestId("update-supervisor-line").textContent).toBe(
      "An external supervisor guarantees the restart — even if the window closes.",
    );
    // R101-B: the hand-off flag armed BEFORE the invoke (the ConnectionGate
    // shows the Restarting splash from the moment the kill starts) — and it
    // STAYS armed: the app is exiting, nothing clears it on the success leg.
    expect(useConfigStore.getState().updateInFlight).toEqual({ version: "0.87.0" });
    // One download for the whole journey — the confirm reuses the staged
    // file, never re-streaming it.
    expect(vi.mocked(startUpdateDownload)).toHaveBeenCalledTimes(1);
  });

  it("R128-W1: the INSTALLING state carries the supervisor line too (the belt copy is on the card before the invoke even answers)", async () => {
    mockAvailableRelease();
    mockDownloadSequence();
    // A DEFERRED invoke — the card is pinned while the Rust command is
    // still running (the exact window the supervisor line addresses: the
    // app may close at ANY moment of the install, not just after launch).
    let releaseInvoke: () => void = () => {};
    const invoke = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => (releaseInvoke = resolve)),
    );
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
    renderWithProviders(<AboutTab />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => {
      expect(screen.getByTestId("update-download-button")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("update-download-button"));
    await waitFor(
      () => {
        expect(screen.getByTestId("update-staged").textContent).toContain("ready to install");
      },
      { timeout: 6_000 },
    );
    fireEvent.click(screen.getByTestId("update-install-button"));

    // The invoke is pending — the card sits in the INSTALLING state and
    // the honest supervisor subline is ALREADY there (the same single
    // sentence the launched leg carries; silent installs only).
    await waitFor(
      () => {
        expect(screen.getByTestId("update-installing")).toBeTruthy();
      },
      { timeout: 6_000 },
    );
    expect(screen.getByTestId("update-supervisor-line").textContent).toBe(
      "An external supervisor guarantees the restart — even if the window closes.",
    );
    expect(invoke).toHaveBeenCalledWith("run_update_installer", {
      path: "C:\\Temp\\ACUTE-CODE_0.87.0_x64-setup.exe",
      silent: true,
      version: "0.87.0",
    });
    // Release the invoke — the card advances to the launched line (no
    // dangling pending state for the next test's cleanup).
    releaseInvoke();
    await waitFor(
      () => {
        expect(screen.getByTestId("update-launched").textContent).toContain("Restarting into v0.87.0");
      },
      { timeout: 6_000 },
    );
  });

  it("R104: the Linux AppImage leg — the staged aarch64.AppImage invokes the same command, and a REJECTED replace shows the honest error with NO wizard fallback", async () => {
    // The check answers THIS machine's asset: the arch-matched AppImage.
    vi.mocked(fetchSystemUpdates).mockResolvedValue({
      current: APP_VERSION,
      releasesUrl: "x",
      ok: true,
      latest: "0.87.0",
      updateAvailable: true,
      body: "",
      asset: {
        url: "https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/43",
        size: 132_729_352,
        digest: `sha256:${"cd".repeat(32)}`,
        kind: "linux-appimage",
        name: "ACUTE-CODE_0.87.0_aarch64.AppImage",
      },
    });
    const ready = dlState({
      status: "ready",
      path: "/tmp/ACUTE-CODE_0.87.0_aarch64.AppImage",
      version: "0.87.0",
    });
    vi.mocked(fetchUpdateDownloadProgress)
      .mockResolvedValue(ready)
      .mockResolvedValueOnce(dlState({})) // the mount-resume probe
      .mockResolvedValueOnce(dlState({})) // the reuse check
      .mockResolvedValueOnce(ready); // the poll settles immediately
    vi.mocked(startUpdateDownload).mockResolvedValue({ ok: true, status: "downloading" });
    // The Rust AppImage replace leg rejects (the honest read-only-dir case).
    const invoke = vi.fn().mockRejectedValue(
      "staging the new AppImage beside the current one failed: Permission denied (os error 13) — is the AppImage's directory writable by this user?",
    );
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
    renderWithProviders(<AboutTab />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => {
      expect(screen.getByTestId("update-download-button")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("update-download-button"));

    // The staged row (the AppImage this time).
    await waitFor(
      () => {
        expect(screen.getByTestId("update-staged").textContent).toContain(
          "Downloaded and verified — v0.87.0 is ready to install",
        );
      },
      { timeout: 6_000 },
    );
    fireEvent.click(screen.getByTestId("update-install-button"));

    // The same command, the same silent flag — the Rust side dispatches on
    // the .AppImage extension to the replace leg.
    await waitFor(
      () => {
        expect(invoke).toHaveBeenCalledWith("run_update_installer", {
          path: "/tmp/ACUTE-CODE_0.87.0_aarch64.AppImage",
          silent: true,
          version: "0.87.0",
        });
      },
      { timeout: 6_000 },
    );
    // The honest error (role=alert, the Rust string verbatim) — and NO
    // wizard escape hatch: there is no interactive wizard for an AppImage.
    await waitFor(
      () => {
        expect(screen.getByTestId("update-flow-error").textContent).toContain("Permission denied");
      },
      { timeout: 6_000 },
    );
    expect(screen.queryByTestId("update-wizard-fallback")).toBeNull();
    // R101-B: the recovery still ran (the engine restarts — the "Connecting
    // to Agent Core" the v0.100.0 report saw, but now with an honest error
    // instead of a silent nothing-updated).
    expect(useConfigStore.getState().updateInFlight).toBeNull();
    expect(sidecarConnectionMock.retryConnection).toHaveBeenCalledTimes(1);
  });

  it("R104: the mount-resume — a staged download renders WITHOUT a check, and the confirm installs it straight from the sidecar's state", async () => {
    // The sidecar already holds a verified download for a NEWER version
    // (downloaded in an earlier About visit — the single-flight state
    // outlives the tab). No fetchSystemUpdates mock: the flow must not
    // need a check at all.
    vi.mocked(fetchUpdateDownloadProgress).mockResolvedValue(
      dlState({
        status: "ready",
        path: "/tmp/ACUTE-CODE_" + NEWER_VERSION + "_x64-setup.exe",
        version: NEWER_VERSION,
      }),
    );
    const invoke = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
    renderWithProviders(<AboutTab />);

    // The STANDALONE staged row renders on mount (no available-update card,
    // no check) — the owner's "click the update button in the About section
    // to update it", days later, zero clicks spent on finding the update.
    await waitFor(() => {
      expect(screen.getByTestId("update-staged").textContent).toContain(
        `Downloaded and verified — v${NEWER_VERSION} is ready to install`,
      );
    });
    expect(vi.mocked(fetchSystemUpdates)).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("update-install-button"));
    await waitFor(
      () => {
        expect(invoke).toHaveBeenCalledWith("run_update_installer", {
          path: "/tmp/ACUTE-CODE_" + NEWER_VERSION + "_x64-setup.exe",
          silent: true,
          version: NEWER_VERSION,
        });
      },
      { timeout: 6_000 },
    );
    await waitFor(
      () => {
        expect(screen.getByTestId("update-launched").textContent).toContain(
          `Restarting into v${NEWER_VERSION}`,
        );
      },
      { timeout: 6_000 },
    );
  });

  it("R104: the stale self-heal — a staged download the app already moved past is DISCARDED on mount (never offered)", async () => {
    // The sidecar holds a ready download for the CURRENT version — the app
    // reached it through another path; the staged file's purpose is gone.
    vi.mocked(fetchUpdateDownloadProgress).mockResolvedValue(
      dlState({
        status: "ready",
        path: "/tmp/ACUTE-CODE_" + APP_VERSION + "_x64-setup.exe",
        version: APP_VERSION,
      }),
    );
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke: vi.fn().mockResolvedValue(undefined) },
    };
    renderWithProviders(<AboutTab />);

    // The discard fires (the pendingVersion self-heal pattern) and the
    // staged row never renders.
    await waitFor(() => {
      expect(vi.mocked(discardUpdateDownload)).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("update-staged")).toBeNull();
  });

  it("R104: Discard walks the staged download back — the file is unlinked and the card returns to the Download button", async () => {
    vi.mocked(fetchUpdateDownloadProgress).mockResolvedValue(
      dlState({
        status: "ready",
        path: "/tmp/ACUTE-CODE_" + NEWER_VERSION + "_x64-setup.exe",
        version: NEWER_VERSION,
      }),
    );
    vi.mocked(discardUpdateDownload).mockResolvedValue({ ok: true, status: "idle" });
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke: vi.fn().mockResolvedValue(undefined) },
    };
    renderWithProviders(<AboutTab />);

    await waitFor(() => {
      expect(screen.getByTestId("update-staged")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("update-discard-button"));

    await waitFor(() => {
      expect(vi.mocked(discardUpdateDownload)).toHaveBeenCalledTimes(1);
    });
    // The staged row is gone — the idle surface again (the Download button
    // only renders inside an available-update card; without a check the
    // card is simply empty, which is the truth: nothing is staged).
    await waitFor(() => {
      expect(screen.queryByTestId("update-staged")).toBeNull();
    });
  });

  it("R104: the re-check staleness sweep — a check that announces a DIFFERENT version retires the staged download", async () => {
    // A staged download for NEWER_VERSION, adopted on mount.
    vi.mocked(fetchUpdateDownloadProgress).mockResolvedValue(
      dlState({
        status: "ready",
        path: "/tmp/ACUTE-CODE_" + NEWER_VERSION + "_x64-setup.exe",
        version: NEWER_VERSION,
      }),
    );
    // The check answers an EVEN NEWER release — the staged file is stale.
    const superseding = (() => {
      const [maj, min, patch] = NEWER_VERSION.split(".").map((n) => Number.parseInt(n, 10));
      return `${maj}.${min}.${patch + 1}`;
    })();
    vi.mocked(fetchSystemUpdates).mockResolvedValue({
      current: APP_VERSION,
      releasesUrl: "x",
      ok: true,
      latest: superseding,
      updateAvailable: true,
      body: "",
      asset: {
        url: "https://api.github.com/repos/testplay-byte/ACUTE-CODE/releases/assets/44",
        size: 38_700_000,
        digest: null,
        kind: "windows-setup",
        name: `ACUTE-CODE_${superseding}_x64-setup.exe`,
      },
    });
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke: vi.fn().mockResolvedValue(undefined) },
    };
    renderWithProviders(<AboutTab />);
    await waitFor(() => {
      expect(screen.getByTestId("update-staged")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    // The sweep: the staged 0.x.(n) download is discarded, the card offers
    // the NEW version's Download button fresh.
    await waitFor(() => {
      expect(vi.mocked(discardUpdateDownload)).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("update-staged")).toBeNull();
    });
    expect(screen.getByTestId("update-download-button")).toBeTruthy();
    expect(screen.getByTestId("update-state").textContent).toContain(`v${superseding}`);
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
      expect(screen.getByTestId("update-download-button")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("update-download-button"));

    // The download lands at the staged row; the confirm launches.
    await waitFor(
      () => {
        expect(screen.getByTestId("update-staged")).toBeTruthy();
      },
      { timeout: 6_000 },
    );
    fireEvent.click(screen.getByTestId("update-install-button"));

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
          path: "C:\\Temp\\ACUTE-CODE_0.87.0_x64-setup.exe",
          silent: false,
          version: "0.87.0",
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

// ── ROUND-120 (R120-U): the updater's PAT-rotation resilience. The owner
// rotated his GitHub PAT and "Check for updates" answered HTTP 401 (GitHub
// rejects bad credentials even on public repos); the sidecar now retries
// ANONYMOUSLY and flags the dead token, and this card turns that flag into
// the quiet re-pairing row: auto-opened on a token-rejected answer, always
// available behind the footer disclosure, saved through the SIDECAR (the
// PAT never touches the webview's fetch), and confirmed by a re-run of the
// check itself.
describe("AboutTab R120-U → R123: the optional GitHub token row (anonymous-first)", () => {
  it("a tokenWarning answer (the saved token rejected on the retry leg) renders the amber hint + AUTO-OPENS the row — the check still answers its state", async () => {
    vi.mocked(fetchSystemUpdates).mockResolvedValue({
      current: APP_VERSION,
      releasesUrl: "x",
      ok: true,
      latest: APP_VERSION,
      updateAvailable: false,
      tokenSaved: true,
      tokenWarning: "the saved GitHub token was rejected — a new token is needed for private/rate-limited access",
    });
    renderWithProviders(<AboutTab />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    // The check itself ANSWERED (up to date — the anonymous leg carried it).
    await waitFor(() => {
      expect(screen.getByTestId("update-state").textContent).toContain("Up to date");
    });
    // The amber hint line rides below the state line (the R123 copy names
    // both honest ways out: replace it, or remove it to run anonymously).
    await waitFor(() => {
      expect(screen.getByTestId("update-token-warning").textContent).toContain(
        "The saved GitHub token was rejected",
      );
      expect(screen.getByTestId("update-token-warning").textContent).toContain(
        "remove it to keep checking anonymously",
      );
    });
    // ...and the re-pairing row is ALREADY open (no toggle click needed).
    expect(screen.getByTestId("update-token-row")).toBeTruthy();
    // The Remove affordance renders (a token IS saved — tokenSaved:true).
    expect(screen.getByTestId("update-token-remove")).toBeTruthy();
  });

  it("a token-rejected check (both legs failed) renders the honest error + the auto-opened row", async () => {
    vi.mocked(fetchSystemUpdates).mockResolvedValue({
      current: APP_VERSION,
      releasesUrl: "x",
      ok: false,
      reason: "token-rejected",
      error:
        "the anonymous check answered HTTP 403 and GitHub rejected the saved token (HTTP 401) — save a new GitHub token, or remove the saved one to keep checking anonymously",
      tokenSaved: true,
      tokenWarning: "the saved GitHub token was rejected — a new token is needed for private/rate-limited access",
    });
    renderWithProviders(<AboutTab />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    await waitFor(() => {
      expect(screen.getByTestId("update-state").textContent).toContain(
        "GitHub rejected the saved token (HTTP 401)",
      );
    });
    // The row auto-opened beside the honest error.
    expect(screen.getByTestId("update-token-row")).toBeTruthy();
  });

  it("R123: the DEFAULT public-repo answer (no token saved, check ok) renders NO token UI at all", async () => {
    vi.mocked(fetchSystemUpdates).mockResolvedValue({
      current: APP_VERSION,
      releasesUrl: "x",
      ok: true,
      latest: APP_VERSION,
      updateAvailable: false,
      tokenSaved: false,
    });
    renderWithProviders(<AboutTab />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => {
      expect(screen.getByTestId("update-state").textContent).toContain("Up to date");
    });
    // The owner's "why does it even require a GitHub token?" answered
    // structurally: no toggle, no row, no warning — the anonymous check is
    // the whole experience.
    expect(screen.queryByTestId("update-token-toggle")).toBeNull();
    expect(screen.queryByTestId("update-token-row")).toBeNull();
    expect(screen.queryByTestId("update-token-warning")).toBeNull();
  });

  it("R123: a RATE-LIMITED anonymous check (no token saved) auto-opens the row with the save affordance — and no Remove button (nothing is saved)", async () => {
    vi.mocked(fetchSystemUpdates).mockResolvedValue({
      current: APP_VERSION,
      releasesUrl: "x",
      ok: false,
      reason: "rate-limited",
      error:
        "GitHub's anonymous rate limit answered HTTP 403 — saving an optional GitHub token raises it (60 → 5,000 checks/hour)",
      tokenSaved: false,
    });
    renderWithProviders(<AboutTab />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => {
      expect(screen.getByTestId("update-token-row")).toBeTruthy();
    });
    // The ONE case a token genuinely helps: the row is the suggestion.
    expect(screen.getByTestId("update-state").textContent).toContain("rate limit");
    // No token is saved — the Remove affordance does not render.
    expect(screen.queryByTestId("update-token-remove")).toBeNull();
    // The optionality line is the row's own first line.
    expect(screen.getByTestId("update-token-row").textContent).toContain("Optional");
  });

  it("Save PUTs the token through the SIDECAR, re-runs the check, and shows the saved note (the fresh answer is the feedback)", async () => {
    // First answer: both legs failed (the rotated-PAT state). Second
    // answer: the re-paired token answers clean — no warning field at all.
    vi.mocked(fetchSystemUpdates)
      .mockResolvedValueOnce({
        current: APP_VERSION,
        releasesUrl: "x",
        ok: false,
        reason: "token-rejected",
        error: "the anonymous check answered HTTP 403 and GitHub rejected the saved token (HTTP 401)",
        tokenSaved: true,
        tokenWarning: "the saved GitHub token was rejected — a new token is needed for private/rate-limited access",
      })
      .mockResolvedValue({
        current: APP_VERSION,
        releasesUrl: "x",
        ok: true,
        latest: APP_VERSION,
        updateAvailable: false,
        tokenSaved: true,
      });
    renderWithProviders(<AboutTab />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => {
      expect(screen.getByTestId("update-token-row")).toBeTruthy();
    });

    // Type the re-paired token + save. The value is TRIMMED on the wire
    // (the route's own contract) — the leading/trailing spaces below pin
    // that the webview sends the cleaned form.
    fireEvent.change(screen.getByTestId("update-token-input"), {
      target: { value: "  github_pat_repaired_round120  " },
    });
    fireEvent.click(screen.getByTestId("update-token-save"));

    await waitFor(() => {
      expect(vi.mocked(saveUpdateToken)).toHaveBeenCalledWith("github_pat_repaired_round120");
    });
    // The re-run: the check fired a SECOND time (the card's own fresh
    // answer is the success feedback — the route cleared the stale env
    // snapshot server-side, so the re-run rides the fresh token).
    await waitFor(() => {
      expect(vi.mocked(fetchSystemUpdates)).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId("update-token-saved").textContent).toContain(
        "GitHub token saved — re-running the check",
      );
    });
    // The fresh answer cleared the warning line (and the input).
    await waitFor(() => {
      expect(screen.queryByTestId("update-token-warning")).toBeNull();
    });
    expect((screen.getByTestId("update-token-input") as HTMLInputElement).value).toBe("");
    expect(screen.getByTestId("update-state").textContent).toContain("Up to date");
  });

  it("R123: Remove DELETEs the token through the SIDECAR, re-runs the check, and the fresh anonymous answer retires the row", async () => {
    // First answer: a token IS saved (the launcher-era state). Second
    // answer (after the removal): no token saved — the anonymous check
    // carried, and tokenRowVisible flips false with it.
    vi.mocked(fetchSystemUpdates)
      .mockResolvedValueOnce({
        current: APP_VERSION,
        releasesUrl: "x",
        ok: true,
        latest: APP_VERSION,
        updateAvailable: false,
        tokenSaved: true,
      })
      .mockResolvedValue({
        current: APP_VERSION,
        releasesUrl: "x",
        ok: true,
        latest: APP_VERSION,
        updateAvailable: false,
        tokenSaved: false,
      });
    renderWithProviders(<AboutTab />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => {
      expect(screen.getByTestId("update-token-toggle")).toBeTruthy();
    });
    // The row auto-opens? No — a healthy saved token stays collapsed; open it.
    fireEvent.click(screen.getByTestId("update-token-toggle"));
    await waitFor(() => {
      expect(screen.getByTestId("update-token-row")).toBeTruthy();
    });

    // Remove: the DELETE fires, then the check re-runs.
    fireEvent.click(screen.getByTestId("update-token-remove"));
    await waitFor(() => {
      expect(vi.mocked(removeUpdateToken)).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(vi.mocked(fetchSystemUpdates)).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId("update-token-saved").textContent).toContain(
        "GitHub token removed — checks run anonymously",
      );
    });
    // The fresh answer's tokenSaved:false retires the toggle (the row was
    // seen this mount, but the row block itself collapses with the answer).
    await waitFor(() => {
      expect(screen.queryByTestId("update-token-toggle")).toBeNull();
    });
  });

  it("a REFUSED save renders the honest thrown message and does NOT re-run the check", async () => {
    vi.mocked(fetchSystemUpdates).mockResolvedValue({
      current: APP_VERSION,
      releasesUrl: "x",
      ok: false,
      reason: "token-rejected",
      error: "the anonymous check answered HTTP 403 and GitHub rejected the saved token (HTTP 401)",
      tokenSaved: true,
      tokenWarning: "the saved GitHub token was rejected — a new token is needed for private/rate-limited access",
    });
    // The sidecar's 401 UNAUTHORIZED refusal — the ApiError's message
    // verbatim (the PAT never rides it; the route scrubs as the belt).
    vi.mocked(saveUpdateToken).mockRejectedValue(
      new Error("GitHub rejected this token (HTTP 401) — check that it is a valid, unexpired token"),
    );
    renderWithProviders(<AboutTab />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => {
      expect(screen.getByTestId("update-token-row")).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId("update-token-input"), {
      target: { value: "github_pat_still_dead" },
    });
    fireEvent.click(screen.getByTestId("update-token-save"));

    await waitFor(() => {
      expect(screen.getByTestId("update-token-error").textContent).toContain(
        "GitHub rejected this token (HTTP 401)",
      );
    });
    expect(screen.getByTestId("update-token-error").getAttribute("role")).toBe("alert");
    // No re-run (the save failed — the check state is untouched) and no
    // saved note.
    expect(vi.mocked(fetchSystemUpdates)).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("update-token-saved")).toBeNull();
  });

  it("the footer disclosure opens the row after a tokenSaved answer (the row is conditional) and renders the health line from GET /system/updates/token", async () => {
    // A saved, ACCEPTED token — the health line's success spelling. The
    // check's answer carries tokenSaved:true so the toggle renders.
    vi.mocked(fetchSystemUpdates).mockResolvedValue({
      current: APP_VERSION,
      releasesUrl: "x",
      ok: true,
      latest: APP_VERSION,
      updateAvailable: false,
      tokenSaved: true,
    });
    vi.mocked(fetchUpdateTokenStatus).mockResolvedValue({ present: true, valid: true });
    renderWithProviders(<AboutTab />);

    // No toggle before any check — the default experience shows no token UI.
    expect(screen.queryByTestId("update-token-toggle")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => {
      expect(screen.getByTestId("update-token-toggle")).toBeTruthy();
    });

    // Collapsed — the power-user affordance stays quiet.
    expect(screen.queryByTestId("update-token-row")).toBeNull();
    fireEvent.click(screen.getByTestId("update-token-toggle"));

    await waitFor(() => {
      expect(screen.getByTestId("update-token-row")).toBeTruthy();
    });
    // The health probe fired once (on open, never on mount) and its line
    // rendered — the TOKEN'S VALUE never crosses this boundary.
    await waitFor(() => {
      expect(vi.mocked(fetchUpdateTokenStatus)).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId("update-token-health").textContent).toContain(
        "A GitHub token is saved and GitHub accepts it",
      );
    });
    // The check ran exactly once (the disclosure adds no second check).
    expect(vi.mocked(fetchSystemUpdates)).toHaveBeenCalledTimes(1);
  });

  it("the health line's REJECTED spelling (a saved token GitHub refuses) renders the replace-or-remove copy", async () => {
    vi.mocked(fetchSystemUpdates).mockResolvedValue({
      current: APP_VERSION,
      releasesUrl: "x",
      ok: true,
      latest: APP_VERSION,
      updateAvailable: false,
      tokenSaved: true,
    });
    vi.mocked(fetchUpdateTokenStatus).mockResolvedValue({ present: true, valid: false });
    renderWithProviders(<AboutTab />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => {
      expect(screen.getByTestId("update-token-toggle")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("update-token-toggle"));
    await waitFor(() => {
      expect(screen.getByTestId("update-token-health").textContent).toContain(
        "A GitHub token is saved but GitHub rejected it — replace it below, or remove it to run anonymously",
      );
    });
  });
});
