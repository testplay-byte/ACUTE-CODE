// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  filterConfiguredProviders,
  filterModelsForPicker,
  isFreeModelEntry,
  useSettingsStore,
} from "./settings-store";

function reset() {
  localStorage.clear();
  useSettingsStore.setState({ modelsFreeOnly: true });
}

beforeEach(reset);

describe("settings store (round-43)", () => {
  it("defaults modelsFreeOnly to true (free-only is the owner default)", () => {
    expect(useSettingsStore.getState().modelsFreeOnly).toBe(true);
  });

  it("setModelsFreeOnly toggles the preference", () => {
    useSettingsStore.getState().setModelsFreeOnly(false);
    expect(useSettingsStore.getState().modelsFreeOnly).toBe(false);
    useSettingsStore.getState().setModelsFreeOnly(true);
    expect(useSettingsStore.getState().modelsFreeOnly).toBe(true);
  });

  it("persists modelsFreeOnly to localStorage (zustand persist)", () => {
    useSettingsStore.getState().setModelsFreeOnly(false);
    const raw = localStorage.getItem("acute-code.settings");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).state).toEqual({ modelsFreeOnly: false });
  });
});

describe("isFreeModelEntry", () => {
  it("detects the :free suffix, the meta-router, and $0 pricing", () => {
    expect(isFreeModelEntry({ modelId: "z-ai/glm-5.2:free" })).toBe(true);
    expect(isFreeModelEntry({ modelId: "vendor/brand-new:free" })).toBe(true);
    expect(isFreeModelEntry({ modelId: "openrouter/free" })).toBe(true);
    expect(isFreeModelEntry({ modelId: "local/llama3", inputPricePerMtok: 0 })).toBe(true);
    expect(isFreeModelEntry({ modelId: "openai/gpt-4o", inputPricePerMtok: 2.5 })).toBe(false);
    expect(isFreeModelEntry({ modelId: "unknown/model", inputPricePerMtok: null })).toBe(false);
  });
});

describe("filterModelsForPicker (the shared free-only filter)", () => {
  const rows = [
    { modelId: "z-ai/glm-5.2:free", inputPricePerMtok: 0 as number | null },
    { modelId: "minimax/minimax-m3:free", inputPricePerMtok: 0 as number | null },
    { modelId: "openai/gpt-4o", inputPricePerMtok: 2.5 as number | null },
    { modelId: "anthropic/claude-sonnet-4.5", inputPricePerMtok: 3 as number | null },
  ];

  it("freeOnly=true keeps only the free models", () => {
    expect(filterModelsForPicker(rows, true).map((r) => r.modelId)).toEqual([
      "z-ai/glm-5.2:free",
      "minimax/minimax-m3:free",
    ]);
  });

  it("freeOnly=false passes everything through in order", () => {
    expect(filterModelsForPicker(rows, false)).toHaveLength(4);
  });

  it("returns a copy, never the caller's array (React-safe)", () => {
    const out = filterModelsForPicker(rows, false);
    expect(out).not.toBe(rows);
    expect(out).toEqual(rows);
  });
});

// ── ROUND-114 (R114-e, the ModelSelector audit): the CONFIGURED-provider
// filter every model picker shares — a provider is pickable only when it is
// ENABLED and holds a key (owner: "the picker shows providers I haven't
// added"). ──
describe("filterConfiguredProviders (R114-e — the shared configured-provider filter)", () => {
  const providers = [
    { id: "openrouter", name: "OpenRouter", enabled: true, hasKey: true },
    // Disabled in Settings — never a pickable source.
    { id: "openai", name: "OpenAI", enabled: false, hasKey: true },
    // The seeded preset the owner never added a key to — the owner's exact
    // complaint ("the picker shows providers I haven't added").
    { id: "anthropic", name: "Anthropic", enabled: true, hasKey: false },
    // hasKey absent (unknown — an older sidecar row): allowed, never guessed.
    { id: "zai", name: "Z.ai", enabled: true },
    { id: "local", name: "Local", enabled: false },
  ];

  it("keeps only enabled providers holding a key (hasKey undefined = allowed)", () => {
    expect(filterConfiguredProviders(providers).map((p) => p.id)).toEqual(["openrouter", "zai"]);
  });

  it("preserves order and returns a copy, never the caller's array", () => {
    const out = filterConfiguredProviders(providers);
    expect(out).not.toBe(providers);
    expect(out).toEqual([providers[0], providers[3]]);
  });

  it("an empty input yields the empty list (never throws)", () => {
    expect(filterConfiguredProviders([])).toEqual([]);
  });
});
