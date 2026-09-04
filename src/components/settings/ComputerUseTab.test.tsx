// @vitest-environment happy-dom
/**
 * ROUND-61 (R61-2-a) + ROUND-66 (R66-2-b) — the Computer use settings tab:
 *
 *  1. loading → data flow; the default OFF state (switch, posture hidden,
 *     platform line, capability chips, safety card).
 *  2. The master switch PUTs {enabled:true} (optimistic) and the posture
 *     radio appears once ON.
 *  3. The posture radio PUTs {permission}.
 *  4. Test readiness → POST /computer-use/test: ok renders "Ready"; !ok
 *     renders "Issues" + the report's issue lines.
 *  5. R66: the vision card is GONE — a compact pointer card to Settings →
 *     Image Analysis renders instead (the vision model moved out).
 *  6. The load-error hint (coreUnreachableHint) on the config card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  fetchComputerUseConfig,
  testComputerUse,
  updateComputerUseConfig,
} from "../../lib/api";
import type { ComputerUseConfigResponse } from "../../lib/api";
import { renderWithProviders, resetTestState } from "../../test-utils";
import ComputerUseTab from "./ComputerUseTab";

// The tab is a VIEW over the computer-use REST surface — the api module is
// mocked exactly as the real sidecar shapes it (MemoryPanel.test.tsx
// pattern). The config is MUTABLE: PUT /computer-use/config patches it so
// the invalidation → refetch cycle behaves like the server. R66 close-out:
// vision left the computer-use config entirely (GET/PUT /vision/settings
// owns it — ImageAnalysisTab), so the fixture carries no vision field.
vi.mock("../../lib/api", () => ({
  fetchComputerUseConfig: vi.fn(),
  updateComputerUseConfig: vi.fn(),
  testComputerUse: vi.fn(),
}));

afterEach(cleanup);

function makeConfig(): ComputerUseConfigResponse {
  return {
    settings: {
      enabled: false,
      permission: "observe",
    },
    platform: "linux",
    capabilities: { screenshot: true, input: false },
  };
}

/** The live config the mocked GET serves / PUT patches. */
let config: ComputerUseConfigResponse;

beforeEach(() => {
  resetTestState();
  config = makeConfig();
  vi.mocked(fetchComputerUseConfig).mockReset().mockImplementation(async () => config);
  vi.mocked(updateComputerUseConfig).mockReset().mockImplementation(async (patch) => {
    if (patch.enabled !== undefined) config.settings.enabled = patch.enabled;
    if (patch.permission !== undefined) config.settings.permission = patch.permission;
    return { ...config.settings };
  });
  vi.mocked(testComputerUse)
    .mockReset()
    .mockResolvedValue({ report: { ok: true }, capabilities: config.capabilities, platform: "linux" });
});

describe("ComputerUseTab (ROUND-61 R61-2-a + R66 vision extraction)", () => {
  it("renders loading → data with the default OFF state (platform, capability chips, safety card)", async () => {
    renderWithProviders(<ComputerUseTab />);

    expect(screen.getByText("loading computer use settings…")).toBeTruthy();
    // The master card resolves.
    expect(await screen.findByRole("switch", { name: "Toggle computer use" })).toBeTruthy();
    // OFF by default: the switch is unchecked and the posture radio is HIDDEN
    // (its muted hint shows instead).
    const sw = screen.getByRole("switch", { name: "Toggle computer use" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("radiogroup", { name: "Computer use posture" })).toBeNull();
    expect(screen.getByText(/Posture is set while computer use is on/)).toBeTruthy();
    // Platform line + capability chips (true → green, false → muted).
    expect(screen.getByText("backend: linux")).toBeTruthy();
    expect(screen.getByText("screenshot")).toBeTruthy();
    expect(screen.getByText("input")).toBeTruthy();
    // The safety note card.
    expect(screen.getByText(/Computer use is OFF by default/)).toBeTruthy();
    expect(screen.getByText(/STOP kill switch lives in the Computer monitor panel/)).toBeTruthy();
  });

  it("flips the master switch → updateComputerUseConfig({enabled}) and the posture radio appears", async () => {
    renderWithProviders(<ComputerUseTab />);

    const sw = await screen.findByRole("switch", { name: "Toggle computer use" });
    fireEvent.click(sw);
    await waitFor(() => expect(updateComputerUseConfig).toHaveBeenCalledWith({ enabled: true }));
    // The refetch (post-invalidation) lands the ON state: the switch is
    // checked and the posture radio mounts.
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
    const posture = await screen.findByRole("radiogroup", { name: "Computer use posture" });
    expect(posture.textContent).toContain("Observe only");
    expect(posture.textContent).toContain("Act with approval");
    expect(posture.textContent).toContain("Autopilot");
    // The recommended badge rides the act posture.
    expect(screen.getByText("recommended")).toBeTruthy();
  });

  it("clicking a posture radio → updateComputerUseConfig({permission})", async () => {
    config.settings.enabled = true;
    renderWithProviders(<ComputerUseTab />);

    expect(await screen.findByRole("radio", { name: "Posture: Autopilot" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Posture: Autopilot" }));
    await waitFor(() => expect(updateComputerUseConfig).toHaveBeenCalledWith({ permission: "auto" }));
    // The refetch lands the new selection.
    await waitFor(() =>
      expect(
        screen.getByRole("radio", { name: "Posture: Autopilot" }).getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });

  it("Test readiness renders the green Ready chip when the report is ok", async () => {
    vi.mocked(testComputerUse).mockResolvedValue({
      report: { ok: true },
      capabilities: { screenshot: true },
      platform: "linux",
    });
    renderWithProviders(<ComputerUseTab />);

    await screen.findByRole("switch", { name: "Toggle computer use" });
    fireEvent.click(screen.getByRole("button", { name: "Test computer use readiness" }));
    await waitFor(() => expect(testComputerUse).toHaveBeenCalled());
    expect(await screen.findByTestId("readiness-result")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
  });

  it("Test readiness renders Issues + the report's issue lines when !ok", async () => {
    vi.mocked(testComputerUse).mockResolvedValue({
      report: { ok: false, issues: ["no screen capture permission", "input driver missing"] },
      capabilities: {},
      platform: "linux",
    });
    renderWithProviders(<ComputerUseTab />);

    await screen.findByRole("switch", { name: "Toggle computer use" });
    fireEvent.click(screen.getByRole("button", { name: "Test computer use readiness" }));
    expect(await screen.findByTestId("readiness-result")).toBeTruthy();
    expect(screen.getByText("Issues")).toBeTruthy();
    expect(screen.getByText("no screen capture permission")).toBeTruthy();
    expect(screen.getByText("input driver missing")).toBeTruthy();
  });

  it("Test readiness falls back to the honest engine-log hint when !ok with no issues", async () => {
    vi.mocked(testComputerUse).mockResolvedValue({
      report: { ok: false },
      capabilities: {},
      platform: "linux",
    });
    renderWithProviders(<ComputerUseTab />);

    await screen.findByRole("switch", { name: "Toggle computer use" });
    fireEvent.click(screen.getByRole("button", { name: "Test computer use readiness" }));
    expect(await screen.findByTestId("readiness-result")).toBeTruthy();
    expect(screen.getByText(/see the engine log for details/)).toBeTruthy();
  });

  it("R66: the vision card is replaced by the pointer card to Settings → Image Analysis", async () => {
    renderWithProviders(<ComputerUseTab />);

    // The pointer card renders with the new section's name.
    const pointer = await screen.findByTestId("image-analysis-pointer");
    expect(pointer.textContent).toContain("Image analysis");
    expect(pointer.textContent).toContain("Settings → Image Analysis");
    // The old vision surface is GONE: no mode radio, no key row, no
    // separate/main model cards.
    expect(screen.queryByRole("radiogroup", { name: "Vision mode" })).toBeNull();
    expect(screen.queryByTestId("separate-vision-card")).toBeNull();
    expect(screen.queryByTestId("main-vision-card")).toBeNull();
    expect(screen.queryByTestId("vision-key-row")).toBeNull();
  });

  it("shows the load-error hint on the config card when the sidecar fails", async () => {
    vi.mocked(fetchComputerUseConfig).mockRejectedValue(new Error("sidecar down"));
    renderWithProviders(<ComputerUseTab />);

    const alerts = await screen.findAllByRole("alert");
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0].textContent).toContain("Agent core unreachable");
    expect(alerts[0].textContent).toContain("to configure computer use.");
  });
});
