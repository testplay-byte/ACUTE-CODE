import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Settings store — persisted UI preferences shared across screens.
 *
 * Born in ROUND-43 for the owner's "free only / all models" directive: the
 * OpenRouter default model had been deleted upstream, and the replacement
 * catalog ships a full FREE tier — so model pickers default to free-only.
 *
 * `modelsFreeOnly` is read by Settings → Providers (ModelsProvidersTab) AND,
 * by design, by the chat composer's model picker / sub-agent model picker in
 * later waves: it lives HERE (a shared, persisted zustand store) — never in
 * component state — so every picker honors the same preference.
 */

/** Free-tier detection for any model row (catalog or live-fetched):
 * OpenRouter `:free` suffix, the `openrouter/free` meta-router, or an
 * explicit $0 input price (e.g. a self-hosted gateway). Mirrors
 * agent-core isFreeModelId (kept duplicate on purpose: the frontend cannot
 * import the node sidecar package into the browser bundle). */
export function isFreeModelEntry(model: {
  modelId: string;
  inputPricePerMtok?: number | null;
}): boolean {
  return (
    model.modelId === "openrouter/free" ||
    model.modelId.endsWith(":free") ||
    model.inputPricePerMtok === 0
  );
}

/**
 * The shared free-only filter: when `freeOnly` is true only free models
 * survive; false passes everything through (order preserved).
 */
export function filterModelsForPicker<
  T extends { modelId: string; inputPricePerMtok?: number | null },
>(models: readonly T[], freeOnly: boolean): T[] {
  if (!freeOnly) return [...models];
  return models.filter((m) => isFreeModelEntry(m));
}

/**
 * ROUND-114 (R114-e, the ModelSelector audit): the CONFIGURED-provider
 * filter every model picker shares — a provider is pickable only when it is
 * ENABLED and holds a key (`hasKey !== false`; a seeded preset the owner
 * never added a key to, or a provider switched off in Settings, must never
 * render as a pickable source — the owner: "the picker shows providers I
 * haven't added"). Extracted from ModelSelector's inline filter so the rule
 * is stated once, tested once, and the ImageAnalysisTab's vision picker
 * (same round) reads the exact same verdict. Order preserved; the pickers'
 * BUTTON label lookups keep the UNFILTERED list (an agent wired to a
 * since-disabled provider still resolves its display name).
 */
export function filterConfiguredProviders<
  T extends { enabled: boolean; hasKey?: boolean },
>(providers: readonly T[]): T[] {
  return providers.filter((p) => p.enabled && p.hasKey !== false);
}

interface SettingsState {
  /** Show only free models in model lists/pickers (owner default: true). */
  modelsFreeOnly: boolean;
  setModelsFreeOnly: (freeOnly: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      modelsFreeOnly: true,
      setModelsFreeOnly: (modelsFreeOnly) => set({ modelsFreeOnly }),
    }),
    // version 1: zustand shallow-merges persisted state over the defaults,
    // so existing profiles gain modelsFreeOnly=true automatically.
    { name: "acute-code.settings", version: 1 },
  ),
);
