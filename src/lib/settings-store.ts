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
