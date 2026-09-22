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
 *  §a2 · (ROUND-112 R112-a) the remote-access card — INDEPENDENT of §a:
 *       the toggle + relay URL + write-only host key; Save PUTs
 *       {enabled, relayUrl, hostKey?} (untouched key input = hostKey
 *       OMITTED = keep); the live status line reads the polled connector
 *       status (Connected to <host> / Connecting… / Error: …). (R116-e:
 *       the pairing dialog's "Reachable over the internet" hint — the
 *       cloud cache's second consumer — was DELETED per verdict #16; the
 *       suite pins its absence.)
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
 *
 * ROUND-116 (R116-e — the owner's verdicts #15-#20, the PC pairing dialog):
 * the fullscreen QR magnifier renders through createPortal(…, document.body)
 * (round-116.md §1.3 — the z-order trap: AppShell's `relative z-10` wrapper
 * vs the BODY-level portaled z-50 Radix dialog) and its big QR is tappable
 * back to the popup; the machineLabel is the dialog's BIG BOLD hero (a small
 * eyebrow above the text-2xl/3xl font-bold name); the header description is
 * ONE line; the manual panel carries its own bounded scroll; the action row
 * centers; and the copied pairing text grows the trailing `· cert <colon-hex
 * fp>` — the manual-LAN TLS fix's PC half, matching the phone's
 * parsePairingText CERT_FP_SEARCH exactly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  fetchCloudConnectorSettings,
  fetchDeviceLinkSettings,
  fetchMobileDevices,
  fetchMobileLinkInfo,
  revokeMobileDevice,
  startMobilePairing,
  updateCloudConnectorSettings,
  updateDeviceLinkSettings,
  type CloudConnectorSettingsView,
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
  // ROUND-112 (R112-a): §a2's remote-access surface (GET/PUT
  // /settings/cloud-connector — the same manual-fetcher mocking).
  fetchCloudConnectorSettings: vi.fn(),
  updateCloudConnectorSettings: vi.fn(),
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
  // R112-a: the disabled default — remote access is OFF until the owner
  // flips it (the whole cloud path ships dark by default).
  vi.mocked(fetchCloudConnectorSettings).mockReset().mockResolvedValue(cloudSettingsFactory());
  vi.mocked(updateCloudConnectorSettings).mockReset().mockResolvedValue(cloudSettingsFactory());
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

/** The cloud-connector settings view exactly as GET /settings/cloud-connector
 * serves it (the hostKey itself NEVER rides this shape — presence only). */
function cloudSettingsFactory(
  patch: Partial<CloudConnectorSettingsView> = {},
): CloudConnectorSettingsView {
  return {
    enabled: false,
    relayUrl: "",
    hostKeyPresent: false,
    status: { state: "disabled", relayUrl: "", lastConnectedAt: null, lastError: null },
    ...patch,
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

// ── §a2 (ROUND-112 R112-a): the remote-access card — INDEPENDENT of the LAN
//    link (both ON at once; the phone tries LAN first, relay fallback). ──────

describe("DevicesTab §a2: the remote-access card (ROUND-112 R112-a)", () => {
  it("renders the INDEPENDENT card beside the LAN card — off by default, empty inputs, no status line", async () => {
    renderWithProviders(<DevicesTab />);

    // The card exists alongside §a's LAN card (the independence ruling).
    expect(await screen.findByText("Remote access (internet)")).toBeTruthy();
    expect(screen.getByText("Device links")).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Toggle remote access" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    // The disabled default: no live status line, empty relay input.
    expect(screen.queryByTestId("remote-status")).toBeNull();
    expect((screen.getByTestId("remote-relay-input") as HTMLInputElement).value).toBe("");
    expect(screen.queryByTestId("remote-key-saved")).toBeNull();
  });

  it("Save PUTs the typed draft {enabled, relayUrl, hostKey} and notes the save", async () => {
    renderWithProviders(<DevicesTab />);
    await screen.findByText("Remote access (internet)");

    // Flip the toggle + type the relay URL + a host key, then Save.
    fireEvent.click(screen.getByRole("switch", { name: "Toggle remote access" }));
    fireEvent.change(screen.getByTestId("remote-relay-input"), {
      target: { value: "https://acute-relay.example.workers.dev" },
    });
    fireEvent.change(screen.getByTestId("remote-hostkey-input"), {
      target: { value: "host-key-r112" },
    });
    fireEvent.click(screen.getByTestId("remote-save"));

    await waitFor(() => {
      expect(vi.mocked(updateCloudConnectorSettings)).toHaveBeenCalledWith({
        enabled: true,
        relayUrl: "https://acute-relay.example.workers.dev",
        hostKey: "host-key-r112",
      });
    });
    await waitFor(() => {
      expect(screen.getByText("Remote access settings saved.")).toBeTruthy();
    });
  });

  it("an UNTOUCHED key input is OMITTED from the PUT (keep semantics); the 'Key saved' chip shows while enabled", async () => {
    // Saved config: enabled + a key present + the tunnel connected.
    vi.mocked(fetchCloudConnectorSettings).mockResolvedValue(
      cloudSettingsFactory({
        enabled: true,
        relayUrl: "https://acute-relay.example.workers.dev",
        hostKeyPresent: true,
        status: {
          state: "connected",
          relayUrl: "https://acute-relay.example.workers.dev",
          lastConnectedAt: null,
          lastError: null,
        },
      }),
    );
    renderWithProviders(<DevicesTab />);

    // The write-only placeholder + the saved-key chip (enabled + present).
    await waitFor(() => {
      expect(screen.getByTestId("remote-key-saved")).toBeTruthy();
    });
    expect(
      (screen.getByTestId("remote-hostkey-input") as HTMLInputElement).placeholder,
    ).toContain("saved — type to replace");

    // Save with the key input untouched → hostKey rides NOWHERE (keep).
    fireEvent.click(screen.getByTestId("remote-save"));
    await waitFor(() => {
      expect(vi.mocked(updateCloudConnectorSettings)).toHaveBeenCalledWith({
        enabled: true,
        relayUrl: "https://acute-relay.example.workers.dev",
      });
    });
  });

  it("the live status line reads the POLLED connector status — connected host / honest error", async () => {
    vi.mocked(fetchCloudConnectorSettings).mockResolvedValue(
      cloudSettingsFactory({
        enabled: true,
        relayUrl: "https://acute-relay.example.workers.dev",
        status: {
          state: "connected",
          relayUrl: "https://acute-relay.example.workers.dev",
          lastConnectedAt: null,
          lastError: null,
        },
      }),
    );
    renderWithProviders(<DevicesTab />);
    await waitFor(() => {
      expect(screen.getByTestId("remote-status").textContent).toContain(
        "Connected to acute-relay.example.workers.dev",
      );
    });
    cleanup();

    // The error state — the honest failure line, never a silent blank.
    vi.mocked(fetchCloudConnectorSettings).mockResolvedValue(
      cloudSettingsFactory({
        enabled: true,
        relayUrl: "https://acute-relay.example.workers.dev",
        status: {
          state: "error",
          relayUrl: "https://acute-relay.example.workers.dev",
          lastConnectedAt: 1,
          lastError: "no pong within 10000 ms — treating the tunnel as dead",
        },
      }),
    );
    renderWithProviders(<DevicesTab />);
    await waitFor(() => {
      expect(screen.getByTestId("remote-status").textContent).toContain("Error: no pong within");
    });
  });

  it("the pairing dialog carries NO relay hint — R116-e (verdict #16) deleted it, even while the tunnel is connected", async () => {
    enableLinks();
    const payload = pairingPayload(Date.now() + 120_000);
    vi.mocked(startMobilePairing).mockResolvedValue(payload);

    // The CONNECTED tunnel — the old hint's exact precondition. The cloud
    // card's own status line still tells the relay truth…
    vi.mocked(fetchCloudConnectorSettings).mockResolvedValue(
      cloudSettingsFactory({
        enabled: true,
        relayUrl: "https://acute-relay.example.workers.dev",
        status: {
          state: "connected",
          relayUrl: "https://acute-relay.example.workers.dev",
          lastConnectedAt: null,
          lastError: null,
        },
      }),
    );
    renderWithProviders(<DevicesTab />);
    await screen.findByTestId("link-status");
    fireEvent.click(screen.getByTestId("pair-start-button"));
    await waitFor(() => {
      expect(screen.getByTestId("pair-pin").textContent).toBe("49301182");
    });
    expect(screen.getByTestId("remote-status").textContent).toContain(
      "Connected to acute-relay.example.workers.dev",
    );
    // …but the pairing dialog no longer carries the "Reachable over the
    // internet" line — the QR payload's own `relay` field is the phone's
    // internet path, and the dialog's text shrinks to the essentials.
    expect(screen.queryByTestId("pair-relay-hint")).toBeNull();
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

// ── §b ROUND-115 (R115-E1): the pairing dialog's round-115 upgrades — the
//    word-pair machine name line, the copy-pairing-text button (+ its
//    clipboard-missing fallback), the fullscreen QR magnifier, and the
//    manual fallback's per-block copy affordances. R116-e re-pins the
//    three surfaces it reshaped: the machine name is now the BIG BOLD
//    hero, the copied text carries the cert fingerprint, and the
//    fullscreen magnifier portals to body with a tappable QR. ────────────

describe("DevicesTab §b R115: the pairing dialog upgrades (ROUND-115 R115-E1)", () => {
  /** The happy-dom clipboard swap (the ChatMarkdown.test.tsx pattern —
   * happy-dom exposes navigator.clipboard as getter-only). */
  function stubClipboard(write: ReturnType<typeof vi.fn>): void {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: write },
      configurable: true,
    });
  }

  /** Open the pairing dialog with the given payload; resolves when the PIN
   * row is live (the dialog's "ready" signal every test below shares). */
  async function openDialog(payload: MobilePairingPayload): Promise<void> {
    enableLinks();
    vi.mocked(startMobilePairing).mockResolvedValue(payload);
    renderWithProviders(<DevicesTab />);
    await screen.findByTestId("link-status");
    fireEvent.click(screen.getByTestId("pair-start-button"));
    await waitFor(() => {
      expect(screen.getByTestId("pair-pin").textContent).toBe(payload.pin);
    });
  }

  it("the payload's machineLabel is the dialog's BIG BOLD hero — a small eyebrow above the big name; absent gracefully on old payloads", async () => {
    await openDialog({ ...pairingPayload(Date.now() + 120_000), machineLabel: "Confused Coconut" });
    // R116-e (verdict #19): the pair-machine-label testID KEPT, now on the
    // hero BLOCK — the honest framing is a small "This desktop is" eyebrow
    // ABOVE the big bold word-pair name.
    const hero = screen.getByTestId("pair-machine-label");
    expect(hero.textContent).toContain("This desktop is");
    const eyebrow = hero.firstElementChild as HTMLElement;
    expect(eyebrow.textContent).toBe("This desktop is");
    // The name dominates: text-2xl/3xl font-bold, and it renders AFTER
    // (below) the eyebrow.
    const name = screen.getByTestId("pair-machine-name");
    expect(name.textContent).toBe("Confused Coconut");
    expect(name.className).toContain("font-bold");
    expect(name.className).toContain("text-2xl");
    expect(eyebrow.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // A pre-R115 payload (no machineLabel) — the hero simply does not render.
    cleanup();
    await openDialog(pairingPayload(Date.now() + 120_000));
    expect(screen.queryByTestId("pair-machine-label")).toBeNull();
    expect(screen.queryByTestId("pair-machine-name")).toBeNull();
  });

  it("'Copy pairing text' copies the FULL address ladder `addr1:port · addr2:port · PIN pin · cert <colon-hex fp>` and flips to Copied", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    stubClipboard(write);
    await openDialog(pairingPayload(Date.now() + 120_000));

    const button = screen.getByTestId("pair-copy-text");
    expect(button.textContent).toContain("Copy pairing text");
    fireEvent.click(button);
    // R116-e: the trailing colon-hex fingerprint is what the phone's
    // parsePairingText CERT_FP_SEARCH parses anywhere in the pasted text
    // (the "cert " prefix word rides along harmlessly), so a pasted
    // manual-LAN entry pins the self-signed cert like the QR does.
    // R118-F (round-118 §1 item 53): the text now carries EVERY address, not
    // just addrs[0] — the phone's smart-paste collects the whole ladder and
    // probes them in order (a one-rung manual ladder died "unreachable"
    // whenever the first address was a virtual adapter). The factory's two
    // addresses (192.168.1.42 + 10.0.0.7, same port) pin the exact format.
    expect(write).toHaveBeenCalledWith(
      `192.168.1.42:45999 · 10.0.0.7:45999 · PIN 49301182 · cert ${CERT_FP}`,
    );
    await waitFor(() => {
      expect(screen.getByTestId("pair-copy-text").textContent).toContain("Copied");
    });
    // No fallback note — the clipboard worked.
    expect(screen.queryByTestId("pair-copy-note")).toBeNull();
  });

  it("R118-F pins: the fullscreen overlay carries pointer-events-auto + the manual wrapper carries shrink-0 (the two one-class fixes)", async () => {
    await openDialog(pairingPayload(Date.now() + 120_000));

    // WHY THE CLASS IS THE PIN (not behavior): Radix's modal scroll-lock
    // sets document.body{pointer-events:none} while the pairing dialog is
    // open, and the fullscreen overlay — portaled to document.body — INHERITED
    // it, so every pointer interaction fell through to the dialog underneath
    // (a click on the big QR re-fired the tile's own open handler = "nothing
    // happens"; the top-right X landed on the dialog's Close = "closes the
    // whole pop-up"). PROVEN in real Chromium (/home/z/my-project/qr-repro —
    // the repo's exact @radix-ui/react-dialog + React 18.3). jsdom's
    // fireEvent.click NEVER models hit-testing (it dispatches straight to the
    // target), so the BEHAVIOR cannot regress-test here — the class itself is
    // the honest pin. Esc always worked (keyboard is not a pointer event),
    // which is exactly why the bug survived two rounds of green tests.
    fireEvent.click(screen.getByTestId("pair-qr"));
    const fullscreen = screen.getByTestId("pair-qr-fullscreen");
    expect(fullscreen.className).toContain("pointer-events-auto");
    fireEvent.click(screen.getByTestId("pair-qr-fullscreen-close"));

    // The flexbox shrink trap (round-118 §1 item 52): the manual panel's
    // wrapper has overflow-hidden → its automatic minimum size is ZERO (CSS
    // Flexbox §4.5) → it absorbed the ENTIRE height deficit created by the
    // rigid QR tile inside the capped max-h-[86vh] flex column → it collapsed
    // below its content and clipped the PIN with its own overflow. shrink-0
    // keeps the panel at its natural height and hands the scroll back to the
    // dialog body — jsdom does no layout either, so the class is the pin.
    const manualWrapper = screen.getByTestId("pair-manual-toggle").parentElement;
    expect(manualWrapper?.className).toContain("shrink-0");
    expect(manualWrapper?.className).toContain("overflow-hidden");
  });

  it("a MISSING clipboard falls back to the legacy select-text leg: the manual section opens + the quiet note", async () => {
    // navigator.clipboard undefined — the writeText path is unavailable.
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    await openDialog(pairingPayload(Date.now() + 120_000));

    expect(screen.queryByTestId("pair-manual")).toBeNull();
    fireEvent.click(screen.getByTestId("pair-copy-text"));
    expect(screen.getByTestId("pair-manual")).toBeTruthy();
    expect(screen.getByTestId("pair-copy-note").textContent).toContain(
      "Clipboard unavailable — select the details below instead.",
    );
  });

  it("clicking the QR opens the fullscreen magnifier (portaled to body); Esc, the X, and tapping the big QR close it (the dialog stays open)", async () => {
    await openDialog(pairingPayload(Date.now() + 120_000));

    // Closed by default.
    expect(screen.queryByTestId("pair-qr-fullscreen")).toBeNull();
    // Click the tile → the magnifier: same payload, the scan hint, the X.
    // R116-e: the overlay renders through createPortal(…, document.body)
    // (the §1.3 z-order fix) — it is a direct child of <body>, no longer a
    // descendant of AppShell's `relative z-10` wrapper under the z-50
    // portaled Radix dialog.
    fireEvent.click(screen.getByTestId("pair-qr"));
    const fullscreen = screen.getByTestId("pair-qr-fullscreen");
    expect(fullscreen).toBeTruthy();
    expect(fullscreen.parentElement).toBe(document.body);
    expect(screen.getByTestId("pair-qr-fullscreen-hint").textContent).toBe(
      "Scan with ACUTE on your phone",
    );
    // The QR canvas is ASYNC (qrcode.toString) — its svg gets its OWN
    // waitFor, scoped to the code block (the X chip's lucide icon is an
    // svg too, and it now comes FIRST in the DOM).
    const codeWrap = screen.getByTestId("pair-qr-fullscreen-code");
    await waitFor(() => {
      expect(codeWrap.querySelector("svg")).toBeTruthy();
    });

    // R116-e structure: the hint rides ABOVE the code, and the X is the
    // top-right corner affordance (a 40px white/80-bordered chip).
    const hint = screen.getByTestId("pair-qr-fullscreen-hint");
    const code = codeWrap.querySelector("svg") as SVGElement;
    expect(hint.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const closeBtn = screen.getByTestId("pair-qr-fullscreen-close");
    expect(closeBtn.className).toContain("absolute");
    expect(closeBtn.className).toContain("w-10");
    expect(closeBtn.className).toContain("h-10");
    expect(closeBtn.className).toContain("border-white/80");

    // R116-e: tapping the BIG QR ITSELF returns to the popup form — the
    // code no longer swallows clicks (tapping the QR IS tapping the
    // overlay; same action).
    fireEvent.click(code);
    expect(screen.queryByTestId("pair-qr-fullscreen")).toBeNull();
    expect(screen.getByTestId("pair-pin").textContent).toBe("49301182");

    // Esc closes the magnifier — AND the pairing dialog itself stays open
    // (the overlay swallows the key before the Radix layer under it).
    fireEvent.click(screen.getByTestId("pair-qr"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("pair-qr-fullscreen")).toBeNull();
    expect(screen.getByTestId("pair-pin").textContent).toBe("49301182");

    // Re-open, then the X button closes it too.
    fireEvent.click(screen.getByTestId("pair-qr"));
    fireEvent.click(screen.getByTestId("pair-qr-fullscreen-close"));
    expect(screen.queryByTestId("pair-qr-fullscreen")).toBeNull();
    expect(screen.getByTestId("pair-pin").textContent).toBe("49301182");
  });

  it("the expired window's tile is NOT a magnifier (a dead code teaches nothing magnified)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
    try {
      enableLinks();
      const payload = pairingPayload(Date.now() + 120_000);
      vi.mocked(startMobilePairing).mockResolvedValue(payload);
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
      await tick(120_000);

      expect(screen.getByTestId("pair-expired")).toBeTruthy();
      expect(screen.getByTestId("pair-qr").getAttribute("role")).toBeNull();
      fireEvent.click(screen.getByTestId("pair-qr"));
      expect(screen.queryByTestId("pair-qr-fullscreen")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the manual fallback's blocks carry copy affordances — first addr:port and the PIN", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    stubClipboard(write);
    await openDialog(pairingPayload(Date.now() + 120_000));

    fireEvent.click(screen.getByTestId("pair-manual-toggle"));
    // Address block: the FIRST LAN address + port (the QR ladder's pick).
    fireEvent.click(screen.getByTestId("pair-manual-addrs-copy"));
    expect(write).toHaveBeenCalledWith("192.168.1.42:45999");
    // PIN block: the 8-digit PIN alone (the phone's paste flow splits them).
    fireEvent.click(screen.getByTestId("pair-manual-pin-copy"));
    expect(write).toHaveBeenCalledWith("49301182");
    expect(write).toHaveBeenCalledTimes(2);
  });
});
