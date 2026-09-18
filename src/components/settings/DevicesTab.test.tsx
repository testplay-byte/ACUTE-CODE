// @vitest-environment happy-dom
/**
 * ROUND-106 (R106-S2) — the Devices tab (the desktop half of device
 * linking), per ANDROID-R3-OWNER-RULINGS.md §3.2 + LINKING-PROTOCOL.md §2/§5:
 *
 *  §a · the master toggle — GET /settings/device-link renders the switch;
 *       a flip PUTs {enabled}; a failed enable (400 — the listener refused
 *       to bind) rolls the switch back to OFF with the honest error note.
 *       While ON, the live listener state line reads link-info (port + LAN
 *       addresses).
 *  §b · the pairing flow — "Pair a device" (gated on links being ON) calls
 *       POST /mobile/pair/start and opens the dialog: the QR encodes the
 *       EXACT response JSON (one compact object, fields untouched), the
 *       8-digit PIN renders large, the 120s countdown ticks live (faked
 *       timers), expiry swaps to the closed-window state, "Generate new
 *       PIN" re-mints, and the 2s link-info poll turns a disappearing
 *       activePairing into the "Device linked ✓" state + a devices-list
 *       refresh. The manual fallback carries addrs:port + PIN + the full
 *       certFP as selectable text.
 *  §c · the linked-devices list — rows render label/scopes/last-seen/
 *       created; Revoke rides the styled ConfirmDialog → DELETE → refresh
 *       + the success note; empty state; 404 tolerance (the honest message
 *       AND the refresh, so a stale row always leaves).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  fetchDeviceLinkSettings,
  fetchMobileDevices,
  fetchMobileLinkInfo,
  revokeMobileDevice,
  startMobilePairing,
  updateDeviceLinkSettings,
  type DeviceLinkSettings,
  type MobileDeviceInfo,
  type MobileLinkInfo,
  type MobilePairingPayload,
} from "../../lib/api";
import { resetTestState, renderWithProviders } from "../../test-utils";
import DevicesTab from "./DevicesTab";

// The tab is a VIEW over the R106-S1 mobile-link REST surface — the api
// module is mocked exactly as the sidecar shapes it (the McpTab.test.tsx
// pattern; no fetch, no msw — the established manual-fetcher mocking).
vi.mock("../../lib/api", () => ({
  fetchDeviceLinkSettings: vi.fn(),
  updateDeviceLinkSettings: vi.fn(),
  fetchMobileLinkInfo: vi.fn(),
  startMobilePairing: vi.fn(),
  fetchMobileDevices: vi.fn(),
  revokeMobileDevice: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  resetTestState();
  vi.mocked(fetchDeviceLinkSettings).mockReset().mockResolvedValue({ enabled: false });
  vi.mocked(updateDeviceLinkSettings).mockReset().mockResolvedValue({ enabled: true });
  vi.mocked(fetchMobileLinkInfo).mockReset().mockResolvedValue(linkInfoFactory());
  vi.mocked(startMobilePairing).mockReset();
  vi.mocked(fetchMobileDevices).mockReset().mockResolvedValue([]);
  vi.mocked(revokeMobileDevice).mockReset().mockResolvedValue({ ok: true, revoked: "dev_1" });
});

/* ── Fixtures (the backend's exact wire shapes) ───────────────────────────── */

const CERT_FP =
  "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
const MACHINE_ID = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

function linkInfoFactory(patch: Partial<MobileLinkInfo> = {}): MobileLinkInfo {
  return {
    enabled: false,
    port: null,
    addrs: [],
    certFP: null,
    machineId: null,
    activePairing: null,
    ...patch,
  };
}

/** The QR payload exactly as pair/start serves it (field order = the wire
 * order; JSON.stringify below reproduces the string the dialog encodes). */
function pairingPayload(expiresAt: number, pin = "49301182"): MobilePairingPayload {
  return {
    v: 1,
    addrs: ["192.168.1.42", "10.0.0.7"],
    port: 45999,
    certFP: CERT_FP,
    machineId: MACHINE_ID,
    pin,
    ttl: 120_000,
    expiresAt,
  };
}

function deviceFactory(m: Partial<MobileDeviceInfo> & { id: string }): MobileDeviceInfo {
  return {
    label: "Pixel 9",
    scopes: ["view-input"],
    createdAt: Date.now() - 3_600_000,
    lastSeenAt: Date.now() - 120_000,
    ...m,
  };
}

/** Advance the FAKE clock inside act — fires react-query's notify timers
 * (v5's notifyManager rides setTimeout(0), so a plain microtask flush
 * leaves every query stuck in "loading" under fake timers) AND flushes the
 * microtask generations the fired timers schedule. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Enable links + stand up the link-info truth the tab reads while ON. */
function enableLinks(settings: Partial<DeviceLinkSettings> = { enabled: true }): void {
  vi.mocked(fetchDeviceLinkSettings).mockResolvedValue({ enabled: false, ...settings });
  vi.mocked(fetchMobileLinkInfo).mockResolvedValue(
    linkInfoFactory({
      enabled: settings.enabled !== false,
      port: 45999,
      addrs: ["192.168.1.42", "10.0.0.7"],
      certFP: CERT_FP,
      machineId: MACHINE_ID,
      activePairing: null,
    }),
  );
}

describe("DevicesTab (ROUND-106 R106-S2)", () => {
  it("renders the loading states, then the three cards (loading → data flow)", async () => {
    vi.mocked(fetchDeviceLinkSettings).mockResolvedValue({ enabled: false });
    renderWithProviders(<DevicesTab />);

    expect(screen.getByText("loading device link settings…")).toBeTruthy();
    expect(screen.getByText("loading linked devices…")).toBeTruthy();
    expect(await screen.findByText("Device links")).toBeTruthy();
    expect(screen.getByText("Link a device")).toBeTruthy();
    expect(screen.getByText("Linked devices")).toBeTruthy();
    expect(screen.queryByText("loading device link settings…")).toBeNull();
  });

  it("§a: renders the OFF state — switch off, no listener line, the pair button disabled", async () => {
    vi.mocked(fetchDeviceLinkSettings).mockResolvedValue({ enabled: false });
    renderWithProviders(<DevicesTab />);

    const toggle = await screen.findByRole("switch", { name: "Toggle device links" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByTestId("link-status")).toBeNull();
    // §b's button is gated on the master switch.
    expect(screen.getByTestId("pair-start-button").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("pair-needs-links").textContent).toContain(
      "Device links are off",
    );
  });

  it("§a: while ON, the live listener status line reads link-info (port + LAN addresses)", async () => {
    enableLinks();
    renderWithProviders(<DevicesTab />);

    const status = await screen.findByTestId("link-status");
    expect(status.textContent).toContain("Listening on port 45999");
    expect(status.textContent).toContain("192.168.1.42, 10.0.0.7");
    expect(screen.getByRole("switch", { name: "Toggle device links" }).getAttribute("aria-checked")).toBe("true");
    // Links ON → the pair button is armed.
    expect(screen.getByTestId("pair-start-button").hasAttribute("disabled")).toBe(false);
  });

  it("§a: flipping the switch PUTs {enabled:false} and invalidates the listener status", async () => {
    enableLinks();
    renderWithProviders(<DevicesTab />);

    await screen.findByTestId("link-status");
    fireEvent.click(screen.getByRole("switch", { name: "Toggle device links" }));

    await waitFor(() => {
      expect(vi.mocked(updateDeviceLinkSettings)).toHaveBeenCalledWith({ enabled: false });
    });
    // The settle invalidates BOTH the setting + link-info (the status line
    // re-reads the listener truth after a toggle).
    await waitFor(() => {
      expect(vi.mocked(fetchMobileLinkInfo)).toHaveBeenCalledTimes(2);
    });
  });

  it("§a: a failed enable rolls the switch back to OFF with the honest error (the setting stays off)", async () => {
    vi.mocked(fetchDeviceLinkSettings).mockResolvedValue({ enabled: false });
    vi.mocked(updateDeviceLinkSettings).mockRejectedValue(
      new Error("the device listener failed to start"),
    );
    renderWithProviders(<DevicesTab />);

    const toggle = await screen.findByRole("switch", { name: "Toggle device links" });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByText(/the device listener failed to start/)).toBeTruthy();
    });
    // The optimistic flip is rolled back — the switch reads OFF again.
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "Toggle device links" }).getAttribute("aria-checked")).toBe("false");
    });
  });
});

describe("DevicesTab §b: the pairing dialog", () => {
  it("opens via pair/start — the QR renders the EXACT payload JSON, the PIN large, the countdown live", async () => {
    enableLinks();
    const payload = pairingPayload(Date.now() + 120_000);
    vi.mocked(startMobilePairing).mockResolvedValue(payload);

    renderWithProviders(<DevicesTab />);
    await screen.findByTestId("link-status");
    fireEvent.click(screen.getByTestId("pair-start-button"));

    // pair/start fired once; the PIN + countdown render.
    await waitFor(() => {
      expect(screen.getByTestId("pair-pin").textContent).toBe("49301182");
    });
    expect(vi.mocked(startMobilePairing)).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("pair-countdown").textContent).toMatch(/expires in 1(19|20)s/);

    // THE QR CONTRACT: the exact pair/start response JSON — one compact
    // object, same fields, same order (the phone parses this payload).
    const qr = screen.getByTestId("pair-qr");
    expect(qr.getAttribute("data-payload")).toBe(JSON.stringify(payload));
    // The REAL encoder's SVG output is in the tile (module paths, light
    // ground — scannable regardless of the app's dark mode). The encoder
    // is ASYNC (qrcode.toString) — the PIN waitFor above can resolve
    // before the SVG lands on the slower CI runners (the R73 lesson:
    // windows-latest runs 3-4x slow; run 35396963611 caught exactly this
    // race), so the SVG gets its OWN waitFor.
    await waitFor(() => {
      expect(qr.querySelector("svg")).toBeTruthy();
    });
  });

  it("carries the manual fallback — addrs:port + PIN + the full certFP as selectable text", async () => {
    enableLinks();
    const payload = pairingPayload(Date.now() + 120_000);
    vi.mocked(startMobilePairing).mockResolvedValue(payload);

    renderWithProviders(<DevicesTab />);
    await screen.findByTestId("link-status");
    fireEvent.click(screen.getByTestId("pair-start-button"));
    await waitFor(() => {
      expect(screen.getByTestId("pair-pin").textContent).toBe("49301182");
    });

    // Collapsed by default; the disclosure opens.
    expect(screen.queryByTestId("pair-manual")).toBeNull();
    fireEvent.click(screen.getByTestId("pair-manual-toggle"));
    expect(screen.getByTestId("pair-manual-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("pair-manual-addrs").textContent).toContain("192.168.1.42:45999");
    expect(screen.getByTestId("pair-manual-addrs").textContent).toContain("10.0.0.7:45999");
    expect(screen.getByTestId("pair-manual-pin").textContent).toBe("49301182");
    expect(screen.getByTestId("pair-manual-certfp").textContent).toBe(CERT_FP);
  });

  it("the countdown ticks down (faked clock) and the window expires to the closed state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
    enableLinks();
    const payload = pairingPayload(Date.now() + 120_000);
    vi.mocked(startMobilePairing).mockResolvedValue(payload);
    // The poll must see a LIVE session while the window is open (null would
    // read as "claimed" — the claim test below pins that leg).
    vi.mocked(fetchMobileLinkInfo).mockResolvedValue(
      linkInfoFactory({
        enabled: true,
        port: 45999,
        addrs: ["192.168.1.42"],
        certFP: CERT_FP,
        machineId: MACHINE_ID,
        activePairing: { pin: payload.pin, expiresAt: payload.expiresAt },
      }),
    );

    renderWithProviders(<DevicesTab />);
    await tick(0);
    fireEvent.click(screen.getByTestId("pair-start-button"));
    await tick(0);

    expect(screen.getByTestId("pair-pin").textContent).toBe("49301182");
    expect(screen.getByTestId("pair-countdown").textContent).toBe("expires in 120s");
    // The tick is FAKED-deterministic (the BrowserCheckpointCard lesson):
    // freeze the clock, advance it, assert the exact flip.
    await tick(1_100);
    expect(screen.getByTestId("pair-countdown").textContent).toBe("expires in 119s");

    // The window's hard end: the expiry state + the dead (dimmed) QR.
    await tick(120_000);
    expect(screen.getByTestId("pair-expired").textContent).toContain(
      "Pairing window closed — generate a new PIN",
    );
    expect(screen.queryByTestId("pair-pin")).toBeNull();
    expect(screen.getByTestId("pair-qr").style.opacity).toBe("0.35");
  });

  it("'Generate new PIN' re-mints the session — a fresh PIN + a fresh QR payload", async () => {
    enableLinks();
    const firstPayload = pairingPayload(Date.now() + 120_000, "49301182");
    const secondPayload = pairingPayload(Date.now() + 120_000, "58201174");
    vi.mocked(startMobilePairing)
      .mockResolvedValueOnce(firstPayload)
      .mockResolvedValueOnce(secondPayload);

    renderWithProviders(<DevicesTab />);
    await screen.findByTestId("link-status");
    fireEvent.click(screen.getByTestId("pair-start-button"));
    await waitFor(() => {
      expect(screen.getByTestId("pair-pin").textContent).toBe("49301182");
    });

    fireEvent.click(screen.getByTestId("pair-new-pin"));
    await waitFor(() => {
      expect(screen.getByTestId("pair-pin").textContent).toBe("58201174");
    });
    // A second pair/start (the route invalidates the prior session).
    expect(vi.mocked(startMobilePairing)).toHaveBeenCalledTimes(2);
    // The QR re-encoded with the new payload — the exact second response.
    expect(screen.getByTestId("pair-qr").getAttribute("data-payload")).toBe(
      JSON.stringify(secondPayload),
    );
  });

  it("a failed pair/start surfaces the honest error with the retry leg", async () => {
    enableLinks();
    vi.mocked(startMobilePairing)
      .mockRejectedValueOnce(new Error("device links are disabled — enable the link before pairing"))
      .mockResolvedValue(pairingPayload(Date.now() + 120_000));

    renderWithProviders(<DevicesTab />);
    await screen.findByTestId("link-status");
    fireEvent.click(screen.getByTestId("pair-start-button"));

    await waitFor(() => {
      expect(screen.getByTestId("pair-error").textContent).toContain(
        "device links are disabled",
      );
    });
    fireEvent.click(screen.getByTestId("pair-retry"));
    await waitFor(() => {
      expect(screen.getByTestId("pair-pin").textContent).toBe("49301182");
    });
  });

  it("the claim poll: activePairing disappearing (while the window is live) → 'Device linked ✓' + the devices list refreshes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
    enableLinks();
    const payload = pairingPayload(Date.now() + 120_000);
    vi.mocked(startMobilePairing).mockResolvedValue(payload);
    // The mount query sees the live session; the FIRST POLL (t+2s) sees it
    // gone — the phone claimed in between.
    vi.mocked(fetchMobileLinkInfo)
      .mockResolvedValueOnce(
        linkInfoFactory({
          enabled: true,
          port: 45999,
          addrs: ["192.168.1.42"],
          certFP: CERT_FP,
          machineId: MACHINE_ID,
          activePairing: { pin: payload.pin, expiresAt: payload.expiresAt },
        }),
      )
      .mockResolvedValue(
        linkInfoFactory({
          enabled: true,
          port: 45999,
          addrs: ["192.168.1.42"],
          certFP: CERT_FP,
          machineId: MACHINE_ID,
          activePairing: null,
        }),
      );
    // The mount list is empty; the claim-refresh refetch carries the new row.
    vi.mocked(fetchMobileDevices)
      .mockResolvedValueOnce([])
      .mockResolvedValue([deviceFactory({ id: "dev_1" })]);

    renderWithProviders(<DevicesTab />);
    await tick(0);
    expect(screen.getByTestId("devices-empty")).toBeTruthy();
    fireEvent.click(screen.getByTestId("pair-start-button"));
    await tick(0);
    expect(screen.getByTestId("pair-pin").textContent).toBe("49301182");

    // The calm 2s poll fires and sees the claim (the notify + refetch
    // cascade rides the same fake-clock advance).
    await tick(2_100);
    await tick(0);

    expect(screen.getByTestId("pair-linked").textContent).toContain("Device linked ✓");
    // The devices list refreshed behind the dialog — the new row is there.
    expect(screen.getByText("Pixel 9")).toBeTruthy();
    expect(vi.mocked(fetchMobileDevices)).toHaveBeenCalledTimes(2);
  });
});

describe("DevicesTab §c: the linked-devices list", () => {
  it("renders rows — label, scopes chip, last seen (relative), created date", async () => {
    vi.mocked(fetchMobileDevices).mockResolvedValue([
      deviceFactory({ id: "dev_1" }),
      deviceFactory({ id: "dev_2", label: "Galaxy S25", lastSeenAt: Date.now() - 7_200_000 }),
    ]);
    renderWithProviders(<DevicesTab />);

    expect(await screen.findByText("Pixel 9")).toBeTruthy();
    expect(screen.getByText("Galaxy S25")).toBeTruthy();
    // Scopes badge (the v1 capability grant).
    expect(screen.getByTestId("device-scope-dev_1").textContent).toBe("view-input");
    // Relative last-seen (the repo's timeAgo spelling).
    expect(screen.getByTestId("device-lastseen-dev_1").textContent).toBe("last seen 2m ago");
    expect(screen.getByTestId("device-lastseen-dev_2").textContent).toBe("last seen 2h ago");
    // Created date.
    expect(screen.getByTestId("device-created-dev_1").textContent).toMatch(/^Added /);
  });

  it("revoke rides the styled ConfirmDialog → DELETE → refresh + the success note", async () => {
    vi.mocked(fetchMobileDevices)
      .mockResolvedValueOnce([deviceFactory({ id: "dev_1" }), deviceFactory({ id: "dev_2", label: "Galaxy S25" })])
      .mockResolvedValue([deviceFactory({ id: "dev_2", label: "Galaxy S25" })]);
    renderWithProviders(<DevicesTab />);

    await screen.findByText("Pixel 9");
    fireEvent.click(screen.getByTestId("device-revoke-dev_1"));
    // The styled confirm (R95-A — never the browser's window.confirm).
    expect(screen.getByTestId("confirm-dialog")).toBeTruthy();
    expect(screen.getByTestId("confirm-dialog").textContent).toContain("Pixel 9");
    // Cancel first: nothing fires, the dialog closes.
    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    expect(vi.mocked(revokeMobileDevice)).not.toHaveBeenCalled();

    // Re-open and confirm: DELETE + the invalidated refetch.
    fireEvent.click(screen.getByTestId("device-revoke-dev_1"));
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    await waitFor(() => {
      expect(vi.mocked(revokeMobileDevice)).toHaveBeenCalledWith("dev_1");
    });
    await waitFor(() => {
      expect(screen.queryByText("Pixel 9")).toBeNull();
    });
    expect(screen.getByText("Galaxy S25")).toBeTruthy();
    expect(screen.getByText("Device revoked — its token is dead.")).toBeTruthy();
  });

  it("renders the empty state when nothing is linked", async () => {
    vi.mocked(fetchMobileDevices).mockResolvedValue([]);
    renderWithProviders(<DevicesTab />);

    expect(await screen.findByTestId("devices-empty")).toBeTruthy();
    expect(screen.getByTestId("devices-empty").textContent).toBe(
      "No devices linked yet — pair your phone above.",
    );
  });

  it("404 tolerance — a rejected DELETE surfaces the honest message AND refreshes the stale row away", async () => {
    vi.mocked(fetchMobileDevices)
      .mockResolvedValueOnce([deviceFactory({ id: "dev_1" })])
      .mockResolvedValue([]);
    vi.mocked(revokeMobileDevice).mockRejectedValue(
      new Error("no linked device with id dev_1"),
    );
    renderWithProviders(<DevicesTab />);

    await screen.findByText("Pixel 9");
    fireEvent.click(screen.getByTestId("device-revoke-dev_1"));
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

    await waitFor(() => {
      expect(screen.getByText(/no linked device with id dev_1/)).toBeTruthy();
    });
    // The list still refreshed — the stale row is gone either way.
    await waitFor(() => {
      expect(screen.getByTestId("devices-empty")).toBeTruthy();
    });
  });
});
