// @vitest-environment happy-dom
/**
 * ROUND-66 (R66-2-b) — the DEDICATED Image analysis settings tab (the
 * owner's B3+B5 directive: the vision model removed from Computer Use into
 * its own section).
 * ROUND-114 (R114-e re-pin + additions — the owner's directive: "remove the
 * off mode — main model and separate model only; the separate picker must
 * show the models that support vision, from the ones I actually have"):
 *
 *  1. loading → data flow; the DEFAULT state is MAIN (mode radio Main
 *     selected + the recommended badge, the main-mode hint + model rows,
 *     the readiness line). The "off" radio is GONE (two options only).
 *  2. The mode radio PUTs {mode:"separate"} (PUT /vision/settings) and the
 *     separate picker card mounts.
 *  3. "separate": the picker lists CONFIGURED ∩ supportsVision rows only
 *     (visionCapableModelRows — non-vision rows, hidden rows and rows under
 *     unconfigured providers never render); selecting a row PUTs
 *     updateVisionSettings({provider, modelId}).
 *  4. A saved pair that is no longer pickable renders the honest
 *     re-point note; the empty state points at Models & Providers.
 *  5. "separate" + no key: paste + Save → setVisionKey(provider, value)
 *     (web-mode REST fallback — the Tauri shell is absent in tests).
 *  6. "separate" + key saved: masked value + "Key saved" chip + Replace
 *     reveals the replacement input; the key is never shown in full.
 *  7. Clear → clearVisionKey(provider).
 *  8. "main": the amber hint + the configured-models list with the eye
 *     toggle → updateProviderModelConfig(id, {supportsVision}).
 *  9. The readiness line reads the settings state (unconfigured /
 *     configured + key saved).
 * 10. The load-error hint (coreUnreachableHint) when the sidecar fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  clearVisionKey,
  fetchConfiguredModels,
  fetchProviders,
  fetchVisionKey,
  fetchVisionSettings,
  setVisionKey,
  updateProviderModelConfig,
  updateVisionSettings,
} from "../../lib/api";
import type {
  ProviderModelConfig,
  ProviderView,
  VisionSettings,
} from "../../lib/api";
import { visionCapableModelRows } from "./ImageAnalysisTab";
import { renderWithProviders, resetTestState } from "../../test-utils";
import ImageAnalysisTab from "./ImageAnalysisTab";

// The tab is a VIEW over the /vision/settings + /computer-use/vision-key +
// /models/configured + /providers REST surfaces — the api module is mocked
// exactly as the real sidecar shapes it (MemoryPanel.test.tsx pattern). The
// settings object is MUTABLE: PUT /vision/settings patches it so the
// invalidation → refetch cycle behaves like the server.
vi.mock("../../lib/api", () => ({
  fetchVisionSettings: vi.fn(),
  updateVisionSettings: vi.fn(),
  fetchVisionKey: vi.fn(),
  setVisionKey: vi.fn(),
  clearVisionKey: vi.fn(),
  fetchProviders: vi.fn(),
  fetchModelsCatalog: vi.fn(),
  fetchConfiguredModels: vi.fn(),
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
    id: "zai",
    name: "Z.ai",
    kind: "openai-compatible",
    baseUrl: "https://api.z.ai/v1",
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

function modelRowFactory(m: {
  id: string;
  providerId?: string;
  modelId: string;
  displayName: string;
  supportsVision: boolean;
  hidden?: boolean;
}): ProviderModelConfig {
  return {
    id: m.id,
    providerId: m.providerId ?? "openrouter",
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
    supportsPdf: null,
    supportsTextOutput: true,
    supportsImageOutput: null,
    supportsVideoOutput: null,
    supportsAudioOutput: null,
    sizeLabel: null,
    hidden: m.hidden ?? false,
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
  // Hidden + vision-capable: curated OFF — never pickable.
  modelRowFactory({
    id: "mrow_3",
    modelId: "hidden/gemini-2.5-flash",
    displayName: "Hidden Gemini",
    supportsVision: true,
    hidden: true,
  }),
  // Vision-capable but under an UNCONFIGURED provider (disabled + keyless).
  modelRowFactory({
    id: "mrow_4",
    providerId: "anthropic",
    modelId: "anthropic/claude-sonnet-4.5",
    displayName: "Claude Sonnet 4.5",
    supportsVision: true,
  }),
  // A second vision-capable row under the second configured provider.
  modelRowFactory({
    id: "mrow_5",
    providerId: "zai",
    modelId: "zai/glm-4.6v",
    displayName: "GLM 4.6V",
    supportsVision: true,
  }),
];

/** The live settings the mocked GET serves / PUT patches. */
let settings: VisionSettings;
/** The live key-slot state the mocked GET serves / PUT+DELETE patch. */
let keyState: { providerId: string; hasKey: boolean; masked: string | null };

beforeEach(() => {
  resetTestState();
  // R114-e: "off" is retired server-side (coerced to "main" on read) — the
  // default the mocked GET serves is the honest post-R114 fresh default.
  settings = { mode: "main", provider: null, modelId: null };
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
  vi.mocked(fetchConfiguredModels).mockReset().mockResolvedValue(MODEL_ROWS);
  vi.mocked(updateProviderModelConfig)
    .mockReset()
    .mockResolvedValue(undefined as unknown as ProviderModelConfig);
});

describe("visionCapableModelRows (R114-e — the pure picker filter)", () => {
  it("lists configured ∩ supportsVision rows only — non-vision, hidden, and unconfigured-provider rows never render", () => {
    const rows = visionCapableModelRows(MODEL_ROWS, PROVIDERS);
    expect(rows.map((r) => r.model.id)).toEqual(["mrow_2", "mrow_5"]);
    expect(rows[0]).toMatchObject({
      providerId: "openrouter",
      providerName: "OpenRouter",
      model: { modelId: "nvidia/nemotron-3.5-lightning:free" },
    });
    expect(rows[1]).toMatchObject({ providerId: "zai", providerName: "Z.ai" });
  });

  it("an empty provider/model input yields the empty list (never throws)", () => {
    expect(visionCapableModelRows([], PROVIDERS)).toEqual([]);
    expect(visionCapableModelRows(MODEL_ROWS, [])).toEqual([]);
  });
});

describe("ImageAnalysisTab (ROUND-66 R66-2-b · R114-e re-pin)", () => {
  it("renders loading → data with the default MAIN state (two-option radio, main hint + rows, readiness line)", async () => {
    renderWithProviders(<ImageAnalysisTab />);

    expect(screen.getByText("loading image analysis settings…")).toBeTruthy();
    // The mode radio resolves with Main selected (the post-R114 default).
    const main = await screen.findByRole("radio", { name: "Image analysis mode: Main model" });
    expect(main.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("recommended")).toBeTruthy();
    // R114-e: the OFF radio is GONE — exactly two options.
    expect(screen.queryByRole("radio", { name: "Image analysis mode: Off" })).toBeNull();
    expect(screen.getAllByRole("radio", { name: /Image analysis mode/ })).toHaveLength(2);
    // MAIN: the main-mode card mounts (the eye-toggle list).
    expect(await screen.findByTestId("main-vision-card")).toBeTruthy();
    // The readiness line speaks main-mode semantics.
    expect((await screen.findByTestId("vision-readiness")).textContent).toContain(
      "marked supports vision",
    );
    // MAIN: no separate picker / key row.
    expect(screen.queryByTestId("separate-vision-card")).toBeNull();
    expect(screen.queryByTestId("vision-key-row")).toBeNull();
  });

  it("mode radio → updateVisionSettings({mode:'separate'}) and the picker card mounts", async () => {
    renderWithProviders(<ImageAnalysisTab />);

    const separate = await screen.findByRole("radio", { name: "Image analysis mode: Separate model" });
    expect(separate.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(separate);
    await waitFor(() => expect(updateVisionSettings).toHaveBeenCalledWith({ mode: "separate" }));
    // The refetch (post-invalidation) lands "separate": the picker card
    // mounts (its rows render — the radiogroup's aria-label is not visible
    // text) with the recommended badge on the MAIN row above it.
    const card = await screen.findByTestId("separate-vision-card");
    expect(card.textContent).toContain("NVIDIA: Nemotron 3.5 Lightning");
    expect(screen.getByText("recommended")).toBeTruthy();
  });

  it("'separate': the picker lists CONFIGURED ∩ supportsVision rows; selecting one PUTs the pair", async () => {
    settings = { mode: "separate", provider: null, modelId: null };
    renderWithProviders(<ImageAnalysisTab />);

    // Only the two pickable rows render (non-vision, hidden and
    // unconfigured-provider rows are filtered by visionCapableModelRows).
    const picker = await screen.findByRole("radiogroup", { name: "Separate vision model" });
    expect(picker.textContent).toContain("NVIDIA: Nemotron 3.5 Lightning");
    expect(picker.textContent).toContain("GLM 4.6V");
    expect(picker.textContent).not.toContain("Z.ai: GLM 5.2");
    expect(picker.textContent).not.toContain("Hidden Gemini");
    expect(picker.textContent).not.toContain("Claude Sonnet 4.5");
    // Each row shows its provider label + the vision badge.
    expect(picker.textContent).toContain("OpenRouter");
    expect(picker.textContent).toContain("Z.ai");
    expect(screen.getAllByText("vision").length).toBeGreaterThanOrEqual(2);

    // No saved pair yet → no row selected.
    expect(picker.querySelector('[aria-checked="true"]')).toBeNull();

    // Selecting the Nemotron row PUTs the pair through the existing route.
    fireEvent.click(screen.getByRole("radio", { name: "Vision model OpenRouter nvidia/nemotron-3.5-lightning:free" }));
    await waitFor(() =>
      expect(updateVisionSettings).toHaveBeenCalledWith({
        provider: "openrouter",
        modelId: "nvidia/nemotron-3.5-lightning:free",
      }),
    );
  });

  it("'separate' with a SAVED pair: the saved row renders selected; clicking it again is a no-op", async () => {
    settings = { mode: "separate", provider: "openrouter", modelId: "nvidia/nemotron-3.5-lightning:free" };
    renderWithProviders(<ImageAnalysisTab />);

    const saved = await screen.findByRole("radio", {
      name: "Vision model OpenRouter nvidia/nemotron-3.5-lightning:free",
    });
    expect(saved.getAttribute("aria-checked")).toBe("true");

    vi.mocked(updateVisionSettings).mockClear();
    fireEvent.click(saved);
    await waitFor(() => expect(screen.getByTestId("separate-vision-card")).toBeTruthy());
    // The already-saved row never re-PUTs (the honest dirty check).
    expect(updateVisionSettings).not.toHaveBeenCalled();
  });

  it("'separate' with a saved pair that is NO LONGER pickable: the honest re-point note", async () => {
    settings = { mode: "separate", provider: "anthropic", modelId: "anthropic/claude-sonnet-4.5" };
    renderWithProviders(<ImageAnalysisTab />);

    const card = await screen.findByTestId("separate-vision-card");
    await waitFor(() =>
      expect(card.textContent).toContain("no longer in the list"),
    );
  });

  it("'separate' with NOTHING vision-capable: the empty state + the link to Models & Providers", async () => {
    settings = { mode: "separate", provider: null, modelId: null };
    vi.mocked(fetchConfiguredModels).mockResolvedValue(
      MODEL_ROWS.filter((m) => m.supportsVision !== true),
    );
    renderWithProviders(<ImageAnalysisTab />);

    const empty = await screen.findByTestId("vision-picker-empty");
    expect(empty.textContent).toContain("No vision-capable models yet");
    expect(
      screen.getByRole("button", { name: "Open Models and Providers" }),
    ).toBeTruthy();
    // No picker radiogroup, no saved-pair note (nothing to re-point).
    expect(screen.queryByRole("radiogroup", { name: "Separate vision model" })).toBeNull();
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
    settings = { mode: "separate", provider: "openrouter", modelId: "nvidia/nemotron-3.5-lightning:free" };
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

  it("'separate' with no SAVED provider: the key row asks to pick a model first", async () => {
    settings = { mode: "separate", provider: null, modelId: null };
    renderWithProviders(<ImageAnalysisTab />);

    await screen.findByTestId("separate-vision-card");
    expect(screen.getByText(/Pick a model above first/)).toBeTruthy();
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
    // The compact rows render with their current state (ALL configured rows
    // list here — the eye toggle manages the flag wherever the row lives).
    expect((await screen.findAllByText("supports vision")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("no images")).toBeTruthy();
    // The eye toggle on the no-vision row PATCHes the flag.
    fireEvent.click(screen.getByRole("button", { name: "Toggle supports vision for z-ai/glm-5.2:free" }));
    await waitFor(() =>
      expect(updateProviderModelConfig).toHaveBeenCalledWith("mrow_1", { supportsVision: true }),
    );
  });

  it("the readiness line reads the settings state (configured + key saved → the green reading)", async () => {
    settings = { mode: "separate", provider: "openrouter", modelId: "nvidia/nemotron-3.5-lightning:free" };
    keyState = { providerId: "openrouter", hasKey: true, masked: "sk-or-v…f9c2" };
    renderWithProviders(<ImageAnalysisTab />);

    const readiness = await screen.findByTestId("vision-readiness");
    await waitFor(() =>
      expect(readiness.textContent).toContain("openrouter/nvidia/nemotron-3.5-lightning:free"),
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
