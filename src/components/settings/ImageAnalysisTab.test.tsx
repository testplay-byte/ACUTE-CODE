// @vitest-environment happy-dom
/**
 * ROUND-66 (R66-2-b) — the DEDICATED Image analysis settings tab (the
 * owner's B3+B5 directive: the vision model removed from Computer Use into
 * its own section — provider + model + API key + supports-vision rows):
 *
 *  1. loading → data flow; the default OFF state (mode radio Off selected,
 *     the off hint of what enabling gives, the readiness line).
 *  2. The mode radio PUTs {mode:"separate"} (PUT /vision/settings) and the
 *     provider/model/key card mounts.
 *  3. "separate": provider select + model input + Save model →
 *     updateVisionSettings({provider, modelId}).
 *  4. "separate" + no key: paste + Save → setVisionKey(provider, value)
 *     (web-mode REST fallback — the Tauri shell is absent in tests).
 *  5. "separate" + key saved: masked value + "Key saved" chip + Replace
 *     reveals the replacement input; the key is never shown in full.
 *  6. Clear → clearVisionKey(provider).
 *  7. "main": the amber hint + the compact configured-models list with the
 *     eye toggle → updateProviderModelConfig(id, {supportsVision}).
 *  8. The readiness line reads the settings state (off / unconfigured /
 *     configured + key saved).
 *  9. The load-error hint (coreUnreachableHint) when the sidecar fails.
 * 10. OFF: no model/key cards mount at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  clearVisionKey,
  fetchModelsCatalog,
  fetchProviderModelConfig,
  fetchProviders,
  fetchVisionKey,
  fetchVisionSettings,
  setVisionKey,
  updateProviderModelConfig,
  updateVisionSettings,
} from "../../lib/api";
import type {
  ModelsCatalog,
  ProviderModelConfig,
  ProviderView,
  VisionSettings,
} from "../../lib/api";
import { renderWithProviders, resetTestState } from "../../test-utils";
import ImageAnalysisTab from "./ImageAnalysisTab";

// The tab is a VIEW over the /vision/settings + /computer-use/vision-key
// REST surfaces — the api module is mocked exactly as the real sidecar
// shapes it (MemoryPanel.test.tsx pattern). The settings object is MUTABLE:
// PUT /vision/settings patches it so the invalidation → refetch cycle
// behaves like the server.
vi.mock("../../lib/api", () => ({
  fetchVisionSettings: vi.fn(),
  updateVisionSettings: vi.fn(),
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
  {
    id: "anthropic",
    name: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiFormat: "anthropic-messages",
    enabled: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    hasKey: false,
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
    // ROUND-82: the tri-state capability flags (null = unknown).
    supportsTools: true,
    supportsAudio: null,
    supportsVideo: null,
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

/** The live settings the mocked GET serves / PUT patches. */
let settings: VisionSettings;
/** The live key-slot state the mocked GET serves / PUT+DELETE patch. */
let keyState: { providerId: string; hasKey: boolean; masked: string | null };

beforeEach(() => {
  resetTestState();
  settings = { mode: "off", provider: null, modelId: null };
  keyState = { providerId: "openrouter", hasKey: false, masked: null };
  vi.mocked(fetchVisionSettings).mockReset().mockImplementation(async () => settings);
  vi.mocked(updateVisionSettings).mockReset().mockImplementation(async (patch) => {
    if (patch.mode !== undefined) settings.mode = patch.mode;
    if (patch.provider !== undefined) settings.provider = patch.provider;
    if (patch.modelId !== undefined) settings.modelId = patch.modelId;
    return { ...settings };
  });
  vi.mocked(fetchVisionKey)
    .mockReset()
    .mockImplementation(async (providerId: string) => ({ ...keyState, providerId }));
  vi.mocked(setVisionKey).mockReset().mockImplementation(async (providerId: string) => {
    keyState = { providerId, hasKey: true, masked: "sk-or-v…f9c2" };
    return undefined;
  });
  vi.mocked(clearVisionKey).mockReset().mockImplementation(async (providerId: string) => {
    keyState = { providerId, hasKey: false, masked: null };
    return undefined;
  });
  vi.mocked(fetchProviders).mockReset().mockResolvedValue(PROVIDERS);
  vi.mocked(fetchModelsCatalog).mockReset().mockResolvedValue(CATALOG);
  vi.mocked(fetchProviderModelConfig)
    .mockReset()
    .mockImplementation(async (providerId: string) =>
      providerId === "openrouter" ? MODEL_ROWS : [],
    );
  vi.mocked(updateProviderModelConfig)
    .mockReset()
    .mockResolvedValue(undefined as unknown as ProviderModelConfig);
});

describe("ImageAnalysisTab (ROUND-66 R66-2-b)", () => {
  it("renders loading → data with the default OFF state (off hint + readiness line)", async () => {
    renderWithProviders(<ImageAnalysisTab />);

    expect(screen.getByText("loading image analysis settings…")).toBeTruthy();
    // The mode radio resolves with Off selected (the default).
    const off = await screen.findByRole("radio", { name: "Image analysis mode: Off" });
    expect(off.getAttribute("aria-checked")).toBe("true");
    // The off hint (and the header) tell the owner what enabling gives.
    expect(screen.getAllByText(/analyze_image tool/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/screenshot descriptions/).length).toBeGreaterThan(0);
    // The readiness line says off.
    expect((await screen.findByTestId("vision-readiness")).textContent).toContain("Off");
    // OFF: no model/key cards mount at all.
    expect(screen.queryByTestId("separate-vision-card")).toBeNull();
    expect(screen.queryByTestId("main-vision-card")).toBeNull();
    expect(screen.queryByTestId("vision-key-row")).toBeNull();
  });

  it("mode radio → updateVisionSettings({mode:'separate'}) and the picker card mounts", async () => {
    renderWithProviders(<ImageAnalysisTab />);

    const separate = await screen.findByRole("radio", { name: "Image analysis mode: Separate model" });
    expect(separate.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(separate);
    await waitFor(() => expect(updateVisionSettings).toHaveBeenCalledWith({ mode: "separate" }));
    // The refetch (post-invalidation) lands "separate": the provider/model
    // card mounts with the recommended badge on the separate row.
    const card = await screen.findByTestId("separate-vision-card");
    expect(card.textContent).toContain("Provider");
    expect(screen.getByLabelText("Vision provider")).toBeTruthy();
    expect(screen.getByLabelText("Vision model id")).toBeTruthy();
    expect(screen.getByText("recommended")).toBeTruthy();
  });

  it("'separate': provider select + model input + Save model → updateVisionSettings({provider, modelId})", async () => {
    settings = { mode: "separate", provider: null, modelId: null };
    renderWithProviders(<ImageAnalysisTab />);

    await screen.findByTestId("separate-vision-card");
    fireEvent.change(screen.getByLabelText("Vision provider"), { target: { value: "openrouter" } });
    fireEvent.change(screen.getByLabelText("Vision model id"), {
      target: { value: "nvidia/nemotron-3.5-lightning:free" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save vision model" }));
    await waitFor(() =>
      expect(updateVisionSettings).toHaveBeenCalledWith({
        provider: "openrouter",
        modelId: "nvidia/nemotron-3.5-lightning:free",
      }),
    );
  });

  it("'separate' + saved provider + no key: the paste row mounts; paste + Save → setVisionKey (REST fallback)", async () => {
    settings = { mode: "separate", provider: "openrouter", modelId: null };
    renderWithProviders(<ImageAnalysisTab />);

    await screen.findByTestId("vision-key-row");
    const input = screen.getByLabelText("Vision key for openrouter");
    const save = screen.getByRole("button", { name: "Save vision key for openrouter" });
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.change(input, { target: { value: "sk-or-vision-123" } });
    expect(save.hasAttribute("disabled")).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(setVisionKey).toHaveBeenCalledWith("openrouter", "sk-or-vision-123"));
  });

  it("'separate' + key saved: masked value + Key saved chip + Replace reveals the replacement input; never the full key", async () => {
    settings = { mode: "separate", provider: "openrouter", modelId: "google/gemini-2.5-flash" };
    keyState = { providerId: "openrouter", hasKey: true, masked: "sk-or-v…f9c2" };
    renderWithProviders(<ImageAnalysisTab />);

    const row = await screen.findByTestId("vision-key-row");
    // Masked only — the full key is NEVER displayed.
    expect(row.textContent).toContain("sk-or-v…f9c2");
    expect(row.textContent).not.toContain("sk-or-vision-123");
    expect(screen.getByText("Key saved")).toBeTruthy();
    // Replace reveals the paste input + its Save.
    fireEvent.click(screen.getByRole("button", { name: "Replace vision key for openrouter" }));
    const replacement = screen.getByLabelText("Replacement vision key for openrouter");
    fireEvent.change(replacement, { target: { value: "sk-or-vision-456" } });
    fireEvent.click(screen.getByRole("button", { name: "Save vision key for openrouter" }));
    await waitFor(() => expect(setVisionKey).toHaveBeenCalledWith("openrouter", "sk-or-vision-456"));
  });

  it("'separate' + key saved: Clear → clearVisionKey(provider)", async () => {
    settings = { mode: "separate", provider: "openrouter", modelId: null };
    keyState = { providerId: "openrouter", hasKey: true, masked: "sk-or-v…f9c2" };
    renderWithProviders(<ImageAnalysisTab />);

    await screen.findByTestId("vision-key-row");
    fireEvent.click(screen.getByRole("button", { name: "Clear vision key for openrouter" }));
    await waitFor(() => expect(clearVisionKey).toHaveBeenCalledWith("openrouter"));
  });

  it("'separate' with no SAVED provider: the key row asks to save a provider first", async () => {
    settings = { mode: "separate", provider: null, modelId: null };
    renderWithProviders(<ImageAnalysisTab />);

    await screen.findByTestId("separate-vision-card");
    expect(screen.getByText(/Save a provider first/)).toBeTruthy();
    expect(screen.queryByTestId("vision-key-row")).toBeNull();
    // The key endpoint was never called (nothing to query yet).
    expect(fetchVisionKey).not.toHaveBeenCalled();
  });

  it("'main': the amber hint + configured model rows + the eye toggle PATCHes supportsVision", async () => {
    settings = { mode: "main", provider: null, modelId: null };
    renderWithProviders(<ImageAnalysisTab />);

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

  it("the readiness line reads the settings state (configured + key saved → the green reading)", async () => {
    settings = { mode: "separate", provider: "openrouter", modelId: "google/gemini-2.5-flash" };
    keyState = { providerId: "openrouter", hasKey: true, masked: "sk-or-v…f9c2" };
    renderWithProviders(<ImageAnalysisTab />);

    const readiness = await screen.findByTestId("vision-readiness");
    await waitFor(() =>
      expect(readiness.textContent).toContain("openrouter/google/gemini-2.5-flash"),
    );
    expect(readiness.textContent).toContain("dedicated key saved");
  });

  it("the readiness line stays honest when separate is unconfigured", async () => {
    settings = { mode: "separate", provider: null, modelId: null };
    renderWithProviders(<ImageAnalysisTab />);

    const readiness = await screen.findByTestId("vision-readiness");
    expect(readiness.textContent).toContain("no provider/model is saved yet");
  });

  it("shows the load-error hint when the sidecar fails", async () => {
    vi.mocked(fetchVisionSettings).mockRejectedValue(new Error("sidecar down"));
    renderWithProviders(<ImageAnalysisTab />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Agent core unreachable");
    expect(alert.textContent).toContain("to configure image analysis.");
  });
});
