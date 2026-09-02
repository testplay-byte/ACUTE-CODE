// @vitest-environment happy-dom
/**
 * ROUND-61 (R61-2-a) — the Computer use settings tab (the R61 centerpiece):
 *
 *  1. loading → data flow; the default OFF state (switch, posture hidden,
 *     platform line, capability chips, safety card).
 *  2. The master switch PUTs {enabled:true} (optimistic) and the posture
 *     radio appears once ON.
 *  3. The posture radio PUTs {permission}.
 *  4. Test readiness → POST /computer-use/test: ok renders "Ready"; !ok
 *     renders "Issues" + the report's issue lines.
 *  5. The vision mode radio PUTs {vision:{mode}}; "separate" mounts the
 *     provider/model/key card.
 *  6. "separate" + no key: paste + Save → setVisionKey(provider, value).
 *  7. "separate" + key saved: masked value + "Key saved" chip + Replace →
 *     replacement input + Clear → clearVisionKey(provider). The key is
 *     never shown in full.
 *  8. "separate": Save model → updateComputerUseConfig({vision:{provider,
 *     modelId}}).
 *  9. "main": the hint card + the compact configured-models list with the
 *     eye toggle → updateProviderModelConfig(id, {supportsVision}).
 * 10. The load-error hint (coreUnreachableHint) on both config cards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  clearVisionKey,
  fetchComputerUseConfig,
  fetchModelsCatalog,
  fetchProviderModelConfig,
  fetchProviders,
  fetchVisionKey,
  setVisionKey,
  testComputerUse,
  updateComputerUseConfig,
  updateProviderModelConfig,
} from "../../lib/api";
import type {
  ComputerUseConfigResponse,
  ModelsCatalog,
  ProviderModelConfig,
  ProviderView,
} from "../../lib/api";
import { renderWithProviders, resetTestState } from "../../test-utils";
import ComputerUseTab from "./ComputerUseTab";

// The tab is a VIEW over the computer-use REST surface — the api module is
// mocked exactly as the real sidecar shapes it (MemoryPanel.test.tsx
// pattern). The config is MUTABLE: PUT /computer-use/config patches it so
// the invalidation → refetch cycle behaves like the server.
vi.mock("../../lib/api", () => ({
  fetchComputerUseConfig: vi.fn(),
  updateComputerUseConfig: vi.fn(),
  testComputerUse: vi.fn(),
  fetchVisionKey: vi.fn(),
  setVisionKey: vi.fn(),
  clearVisionKey: vi.fn(),
  fetchProviders: vi.fn(),
  fetchModelsCatalog: vi.fn(),
  fetchProviderModelConfig: vi.fn(),
  updateProviderModelConfig: vi.fn(),
}));

afterEach(cleanup);

const PROVIDERS: ProviderView[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    apiFormat: "chat-completions",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    hasKey: true,
  },
];

const CATALOG: ModelsCatalog = {
  models: [
    {
      modelId: "z-ai/glm-5.2:free",
      displayName: "Z.ai: GLM 5.2",
      contextWindow: 256000,
      maxOutputTokens: 65536,
      inputPricePerMtok: 0,
      inputPriceCachedPerMtok: 0,
      outputPricePerMtok: 0,
      free: true,
      supportsTools: true,
      supportsStructuredOutputs: true,
      supportsVision: false,
    },
    {
      modelId: "nvidia/nemotron-3.5-lightning:free",
      displayName: "NVIDIA: Nemotron 3.5 Lightning",
      contextWindow: 1000000,
      maxOutputTokens: 32768,
      inputPricePerMtok: 0,
      inputPriceCachedPerMtok: 0,
      outputPricePerMtok: 0,
      free: true,
      supportsTools: true,
      supportsStructuredOutputs: true,
      supportsVision: true,
    },
  ],
  defaultModelId: "z-ai/glm-5.2:free",
  subagentDefaultModelId: "nvidia/nemotron-3.5-lightning:free",
  recommendedModelIds: ["z-ai/glm-5.2:free"],
};

function modelRowFactory(m: {
  id: string;
  modelId: string;
  displayName: string;
  supportsVision: boolean;
}): ProviderModelConfig {
  return {
    id: m.id,
    providerId: "openrouter",
    modelId: m.modelId,
    displayName: m.displayName,
    contextWindow: 256000,
    maxOutputTokens: 32768,
    inputPricePerMtok: 0,
    inputPriceCachedPerMtok: 0,
    outputPricePerMtok: 0,
    supportsThinking: false,
    supportsVision: m.supportsVision,
    hidden: false,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const MODEL_ROWS: ProviderModelConfig[] = [
  modelRowFactory({
    id: "mrow_1",
    modelId: "z-ai/glm-5.2:free",
    displayName: "Z.ai: GLM 5.2",
    supportsVision: false,
  }),
  modelRowFactory({
    id: "mrow_2",
    modelId: "nvidia/nemotron-3.5-lightning:free",
    displayName: "NVIDIA: Nemotron 3.5 Lightning",
    supportsVision: true,
  }),
];

function makeConfig(): ComputerUseConfigResponse {
  return {
    settings: {
      enabled: false,
      permission: "observe",
      vision: { mode: "off", provider: null, modelId: null },
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
    if (patch.vision) {
      if (patch.vision.mode !== undefined) config.settings.vision.mode = patch.vision.mode;
      if (patch.vision.provider !== undefined) config.settings.vision.provider = patch.vision.provider;
      if (patch.vision.modelId !== undefined) config.settings.vision.modelId = patch.vision.modelId;
    }
    return { ...config.settings };
  });
  vi.mocked(testComputerUse)
    .mockReset()
    .mockResolvedValue({ report: { ok: true }, capabilities: config.capabilities, platform: "linux" });
  vi.mocked(fetchVisionKey)
    .mockReset()
    .mockResolvedValue({ providerId: "openrouter", hasKey: false, masked: null });
  vi.mocked(setVisionKey).mockReset().mockResolvedValue(undefined);
  vi.mocked(clearVisionKey).mockReset().mockResolvedValue(undefined);
  vi.mocked(fetchProviders).mockReset().mockResolvedValue(PROVIDERS);
  vi.mocked(fetchModelsCatalog).mockReset().mockResolvedValue(CATALOG);
  vi.mocked(fetchProviderModelConfig).mockReset().mockResolvedValue(MODEL_ROWS);
  vi.mocked(updateProviderModelConfig)
    .mockReset()
    .mockResolvedValue(undefined as unknown as ProviderModelConfig);
});

describe("ComputerUseTab (ROUND-61 R61-2-a)", () => {
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
    // The vision mode radio renders with Off selected (default).
    expect(
      screen.getByRole("radio", { name: "Vision mode: Off" }).getAttribute("aria-checked"),
    ).toBe("true");
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

  it("vision mode radio → updateComputerUseConfig({vision:{mode}}); 'separate' mounts the picker", async () => {
    renderWithProviders(<ComputerUseTab />);

    await screen.findByRole("radio", { name: "Vision mode: Separate model" });
    fireEvent.click(screen.getByRole("radio", { name: "Vision mode: Separate model" }));
    await waitFor(() =>
      expect(updateComputerUseConfig).toHaveBeenCalledWith({ vision: { mode: "separate" } }),
    );
    // The refetch lands "separate": the provider/model/key card mounts.
    const card = await screen.findByTestId("separate-vision-card");
    expect(card.textContent).toContain("Provider");
    expect(screen.getByLabelText("Vision provider")).toBeTruthy();
    expect(screen.getByLabelText("Vision model id")).toBeTruthy();
  });

  it("'separate' + no key: paste + Save → setVisionKey(provider, value)", async () => {
    config.settings.vision = { mode: "separate", provider: "openrouter", modelId: null };
    renderWithProviders(<ComputerUseTab />);

    await screen.findByTestId("vision-key-row");
    // No key: the paste input + Save (disabled until text).
    const input = screen.getByLabelText("Vision key for openrouter");
    const save = screen.getByRole("button", { name: "Save vision key for openrouter" });
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.change(input, { target: { value: "sk-or-vision-123" } });
    expect(save.hasAttribute("disabled")).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(setVisionKey).toHaveBeenCalledWith("openrouter", "sk-or-vision-123"));
  });

  it("'separate' + key saved: masked value + Key saved chip + Replace → Clear", async () => {
    config.settings.vision = { mode: "separate", provider: "openrouter", modelId: null };
    vi.mocked(fetchVisionKey).mockResolvedValue({
      providerId: "openrouter",
      hasKey: true,
      masked: "sk-or-v…f9c2",
    });
    renderWithProviders(<ComputerUseTab />);

    const row = await screen.findByTestId("vision-key-row");
    // Masked only — the full key is NEVER displayed.
    expect(row.textContent).toContain("sk-or-v…f9c2");
    expect(screen.getByText("Key saved")).toBeTruthy();
    // Replace reveals the paste input.
    fireEvent.click(screen.getByRole("button", { name: "Replace vision key for openrouter" }));
    expect(screen.getByLabelText("Replacement vision key for openrouter")).toBeTruthy();
    // Clear removes the slot.
    fireEvent.click(screen.getByRole("button", { name: "Clear vision key for openrouter" }));
    await waitFor(() => expect(clearVisionKey).toHaveBeenCalledWith("openrouter"));
  });

  it("'separate': Save model persists provider + modelId via updateComputerUseConfig", async () => {
    config.settings.vision = { mode: "separate", provider: null, modelId: null };
    renderWithProviders(<ComputerUseTab />);

    await screen.findByTestId("separate-vision-card");
    fireEvent.change(screen.getByLabelText("Vision provider"), { target: { value: "openrouter" } });
    fireEvent.change(screen.getByLabelText("Vision model id"), {
      target: { value: "nvidia/nemotron-3.5-lightning:free" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save vision model" }));
    await waitFor(() =>
      expect(updateComputerUseConfig).toHaveBeenCalledWith({
        vision: {
          provider: "openrouter",
          modelId: "nvidia/nemotron-3.5-lightning:free",
        },
      }),
    );
  });

  it("'main': the hint card + configured model rows + the eye toggle PATCHes supportsVision", async () => {
    config.settings.vision = { mode: "main", provider: null, modelId: null };
    renderWithProviders(<ComputerUseTab />);

    const card = await screen.findByTestId("main-vision-card");
    // The hint points at Models & Providers.
    expect(card.textContent).toContain("must be marked supports vision");
    // The compact rows render with their current state.
    expect(await screen.findByText("supports vision")).toBeTruthy();
    expect(screen.getByText("no images")).toBeTruthy();
    // The eye toggle on the no-vision row PATCHes the flag.
    fireEvent.click(screen.getByRole("button", { name: "Toggle supports vision for z-ai/glm-5.2:free" }));
    await waitFor(() =>
      expect(updateProviderModelConfig).toHaveBeenCalledWith("mrow_1", { supportsVision: true }),
    );
  });

  it("shows the load-error hint on the config cards when the sidecar fails", async () => {
    vi.mocked(fetchComputerUseConfig).mockRejectedValue(new Error("sidecar down"));
    renderWithProviders(<ComputerUseTab />);

    const alerts = await screen.findAllByRole("alert");
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0].textContent).toContain("Agent core unreachable");
    expect(alerts[0].textContent).toContain("to configure computer use.");
  });
});
