// @vitest-environment happy-dom
/**
 * ROUND-99 (R99-C) — the startup auto-check's own suite.
 *
 * The owner's directive: "I click the update button in the application and
 * everything else happens automatically afterwards by itself without me
 * having to make any changes." The auto-check is the quiet half of that
 * promise — the app notices a pending release on its own (24h cadence,
 * post-boot delay, demo-mode gating) and surfaces it as the Sidebar's
 * Settings dot + ONE clickable toast.
 *
 * Pinned here:
 *  · the cadence gate — a fresh (<24h) stamp or autoCheck OFF means NO
 *    fetch at all;
 *  · the success path — pendingVersion set, stamp advanced, ONE local
 *    toast whose link routes to /settings?tab=about;
 *  · the HONEST failure paths — ok:false / a thrown fetch never toast and
 *    never advance the stamp (the next boot retries);
 *  · initUpdateChecker's self-heal — a pendingVersion that is no longer
 *    newer than the running APP_VERSION is cleared at boot (the update
 *    landed through ANY path; the dot must not outlive its release);
 *  · the readiness schedule — nothing fires before BOOT_DELAY_MS, the
 *    demo-mode retries pace out at the documented delays, and an
 *    never-ready sidecar gives up SILENTLY (console.warn, no toast).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_VERSION } from "./version";
import { useConfigStore } from "./config-store";
import { useNotificationStreamStore } from "../hooks/use-notifications";
import { fetchSystemUpdates, type SystemUpdateCheck } from "./api";
import {
  BOOT_DELAY_MS,
  CHECK_INTERVAL_MS,
  SIDECAR_WAIT_RETRY_DELAYS_MS,
  initUpdateChecker,
  isNewerVersion,
  runScheduledUpdateCheck,
  syncPendingVersionFromResult,
  useUpdateCheckerStore,
} from "./update-checker";

vi.mock("./api", () => ({
  fetchSystemUpdates: vi.fn(),
}));

function mockCheck(overrides: Partial<SystemUpdateCheck>): void {
  vi.mocked(fetchSystemUpdates).mockResolvedValue({
    current: APP_VERSION,
    releasesUrl: "https://github.com/testplay-byte/ACUTE-CODE/releases",
    ok: true,
    ...overrides,
  } as SystemUpdateCheck);
}

/** The sidecar-reachable shape the probe gates on (demoData false + token
 * + connection "connected" — the NotificationStreamStarter gate). */
function sidecarReady(on: boolean): void {
  useConfigStore.setState(
    on
      ? { demoData: false, token: "test-token", connection: "connected" }
      : { demoData: true, token: null, connection: "connecting" },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  useUpdateCheckerStore.setState({ autoCheck: true, lastCheckTs: 0, pendingVersion: null });
  useNotificationStreamStore.getState().reset();
  vi.mocked(fetchSystemUpdates).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("isNewerVersion (R99-C — the boot self-heal's tuple walk)", () => {
  it("compares per-segment, tolerating the leading v", () => {
    expect(isNewerVersion("0.97.0", "0.96.0")).toBe(true);
    expect(isNewerVersion("v0.97.0", "0.96.0")).toBe(true);
    expect(isNewerVersion("0.96.1", "0.96.0")).toBe(true);
    expect(isNewerVersion("1.0", "0.99.9")).toBe(true);
    expect(isNewerVersion("0.96.0", "0.96.0")).toBe(false);
    expect(isNewerVersion("0.95.9", "0.96.0")).toBe(false);
  });

  it("R99-H review fix: pre-release suffixes never outrank their own release (the self-heal clears an rc once the release ships)", () => {
    // The first-draft walk parsed "0.97.0-rc.1" as [0,97,0,1] — ranking an
    // rc ABOVE "0.97.0" so the Sidebar dot could never heal off a shipped
    // rc. With the strip, the rc equals its base (not newer → dot clears).
    expect(isNewerVersion("0.97.0-rc.1", "0.97.0")).toBe(false);
    expect(isNewerVersion("0.97.0-rc.1", "0.96.0")).toBe(true); // still newer than an OLDER release
    expect(isNewerVersion("0.97.0+build.2", "0.97.0")).toBe(false);
    expect(isNewerVersion("0.98.0-beta", "0.97.0")).toBe(true);
  });
});

describe("syncPendingVersionFromResult (R99-C — one sync, two callers)", () => {
  it("an available release sets the pending flag", () => {
    syncPendingVersionFromResult({
      current: APP_VERSION,
      releasesUrl: "x",
      ok: true,
      latest: "0.99.0",
      updateAvailable: true,
    });
    expect(useUpdateCheckerStore.getState().pendingVersion).toBe("0.99.0");
  });

  it("an up-to-date answer clears a stale pending flag (the manual button refreshes the badge)", () => {
    useUpdateCheckerStore.setState({ pendingVersion: "0.99.0" });
    syncPendingVersionFromResult({
      current: APP_VERSION,
      releasesUrl: "x",
      ok: true,
      latest: APP_VERSION,
      updateAvailable: false,
    });
    expect(useUpdateCheckerStore.getState().pendingVersion).toBeNull();
  });

  it("a failed answer is a no-op — the badge keeps its last known state", () => {
    useUpdateCheckerStore.setState({ pendingVersion: "0.99.0" });
    syncPendingVersionFromResult({
      current: APP_VERSION,
      releasesUrl: "x",
      ok: false,
      reason: "network",
      error: "boom",
    });
    expect(useUpdateCheckerStore.getState().pendingVersion).toBe("0.99.0");
  });
});

describe("runScheduledUpdateCheck (R99-C — the cadence-gated quiet check)", () => {
  it("autoCheck OFF means no fetch at all", async () => {
    useUpdateCheckerStore.setState({ autoCheck: false });
    await runScheduledUpdateCheck();
    expect(vi.mocked(fetchSystemUpdates)).not.toHaveBeenCalled();
  });

  it("a fresh (<24h) stamp means no fetch — the cadence gate", async () => {
    useUpdateCheckerStore.setState({ lastCheckTs: Date.now() - CHECK_INTERVAL_MS + 60_000 });
    await runScheduledUpdateCheck();
    expect(vi.mocked(fetchSystemUpdates)).not.toHaveBeenCalled();
  });

  it("an available release: pendingVersion set, stamp advanced, ONE linked toast", async () => {
    mockCheck({ latest: "0.99.0", updateAvailable: true, body: "notes" });
    await runScheduledUpdateCheck();
    expect(vi.mocked(fetchSystemUpdates)).toHaveBeenCalledTimes(1);
    expect(useUpdateCheckerStore.getState().pendingVersion).toBe("0.99.0");
    expect(useUpdateCheckerStore.getState().lastCheckTs).toBeGreaterThan(0);
    // ONE toast, clickable — the link routes to the About tab (the Toaster
    // keeps a linked toast on screen until dismissed).
    const toast = useNotificationStreamStore.getState().lastNotification;
    expect(toast).not.toBeNull();
    expect(toast?.title).toBe("ACUTE-CODE v0.99.0 is available");
    expect(toast?.link).toBe("/settings?tab=about");
    // pushLocal NEVER inflates the unread badge (the R44-c contract).
    expect(useNotificationStreamStore.getState().unread).toBe(0);
  });

  it("an up-to-date answer clears the pending flag + advances the stamp (no toast)", async () => {
    useUpdateCheckerStore.setState({ pendingVersion: "0.99.0" });
    mockCheck({ latest: APP_VERSION, updateAvailable: false });
    await runScheduledUpdateCheck();
    expect(useUpdateCheckerStore.getState().pendingVersion).toBeNull();
    expect(useUpdateCheckerStore.getState().lastCheckTs).toBeGreaterThan(0);
    expect(useNotificationStreamStore.getState().lastNotification).toBeNull();
  });

  it("ok:false is silent + honest — no toast, stamp NOT advanced (next boot retries)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockCheck({ ok: false, reason: "network", error: "getaddrinfo ENOTFOUND" });
    await runScheduledUpdateCheck();
    expect(useUpdateCheckerStore.getState().lastCheckTs).toBe(0);
    expect(useNotificationStreamStore.getState().lastNotification).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a thrown fetch is silent + honest too — the stamp stays fresh-boot zero", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fetchSystemUpdates).mockRejectedValue(new Error("Failed to fetch"));
    await runScheduledUpdateCheck();
    expect(useUpdateCheckerStore.getState().lastCheckTs).toBe(0);
    expect(useNotificationStreamStore.getState().lastNotification).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("initUpdateChecker (R99-C — boot self-heal + the readiness schedule)", () => {
  it("clears a pendingVersion that is no longer newer than the running app", () => {
    useUpdateCheckerStore.setState({ pendingVersion: APP_VERSION });
    initUpdateChecker();
    expect(useUpdateCheckerStore.getState().pendingVersion).toBeNull();
    // And the still-newer one survives (the dot's whole job).
    useUpdateCheckerStore.setState({ pendingVersion: "99.0.0" });
    initUpdateChecker();
    expect(useUpdateCheckerStore.getState().pendingVersion).toBe("99.0.0");
  });

  it("fires the check only after the boot delay, once the sidecar is reachable", async () => {
    sidecarReady(true);
    mockCheck({ latest: "0.99.0", updateAvailable: true });
    initUpdateChecker();
    expect(vi.mocked(fetchSystemUpdates)).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS - 1);
    expect(vi.mocked(fetchSystemUpdates)).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(fetchSystemUpdates)).toHaveBeenCalledTimes(1);
  });

  it("a sidecar that becomes ready on a LATER probe still gets checked", async () => {
    // Boot: demo mode (the connect loop is mid-handshake).
    sidecarReady(false);
    mockCheck({ latest: "0.99.0", updateAvailable: true });
    initUpdateChecker();
    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS);
    expect(vi.mocked(fetchSystemUpdates)).not.toHaveBeenCalled();
    // The sidecar lands during the first retry window.
    await vi.advanceTimersByTimeAsync(SIDECAR_WAIT_RETRY_DELAYS_MS[0]! - 1);
    sidecarReady(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(fetchSystemUpdates)).toHaveBeenCalledTimes(1);
  });

  it("a never-ready sidecar gives up SILENTLY after the documented retries — no toast, no fetch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sidecarReady(false);
    initUpdateChecker();
    const total = BOOT_DELAY_MS + SIDECAR_WAIT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    await vi.advanceTimersByTimeAsync(total + 1_000);
    expect(vi.mocked(fetchSystemUpdates)).not.toHaveBeenCalled();
    expect(useNotificationStreamStore.getState().lastNotification).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
