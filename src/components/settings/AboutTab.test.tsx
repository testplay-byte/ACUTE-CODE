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
import { fetchSystemUpdates, resetApplication } from "../../lib/api";
// R99-A: the link router’s preference cache + the stores it resolves the
// active project from (in-app routing + the no-project fallback).
import { setLinkOpeningMode } from "../../lib/open-link";
import { useProjectChatStore } from "../../lib/project-chat-store";
import { useRightSidebarStore } from "../../lib/right-sidebar-store";
import { resetTestState, renderWithProviders } from "../../test-utils";
import { AboutTab } from "./AboutTab";

vi.mock("../../lib/api", () => ({
  fetchSystemUpdates: vi.fn(),
  resetApplication: vi.fn(),
  // R99-A: open-link.ts imports this from the same module — present in
  // the mock so the import never lands on undefined (hydration is never
  // kicked in these tests; the router’s default cache stands).
  fetchBrowserSettings: vi.fn(),
}));

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
});

describe("AboutTab (ROUND-89 R89-A)", () => {
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
