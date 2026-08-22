import { create } from "zustand";
import type { ReasoningLevel } from "./onboarding-types";

/**
 * Wizard session state — ported from the demo's lib/onboarding-store.ts with
 * two deliberate differences:
 *
 * 1. themeId/isDark live in the app-wide persisted theme store
 *    (src/lib/theme-store.ts) — picking a flavor during setup IS the app's
 *    theme choice and must survive restarts.
 * 2. Deliberately NOT persisted (no zustand persist middleware): `apiKey`
 *    lives in memory only and is handed to the Tauri keyring command on save —
 *    it never touches localStorage, REST bodies, or this store's lifetime
 *    beyond the wizard.
 */
interface OnboardingState {
  step: number;
  brainChoice: "now" | "later";
  // Model config
  providerId: string;
  baseUrl: string;
  apiKey: string;
  showApiKey: boolean;
  modelId: string;
  showModelDropdown: boolean;
  contextWindow: number;
  contextManual: boolean;
  maxOutput: number;
  temperature: number;
  inputCost: number;
  outputCost: number;
  reasoning: ReasoningLevel;
  // Actions
  setStep: (step: number) => void;
  setBrainChoice: (choice: "now" | "later") => void;
  setProvider: (id: string) => void;
  setBaseUrl: (url: string) => void;
  setApiKey: (key: string) => void;
  toggleShowApiKey: () => void;
  setModelId: (id: string) => void;
  setShowModelDropdown: (show: boolean) => void;
  setContextWindow: (val: number) => void;
  setContextManual: (manual: boolean) => void;
  setMaxOutput: (val: number) => void;
  setTemperature: (val: number) => void;
  setInputCost: (val: number) => void;
  setOutputCost: (val: number) => void;
  setReasoning: (level: ReasoningLevel) => void;
}

export const useOnboardingStore = create<OnboardingState>((set) => ({
  step: 0,
  brainChoice: "now",
  providerId: "",
  baseUrl: "",
  apiKey: "",
  showApiKey: false,
  modelId: "",
  showModelDropdown: false,
  contextWindow: 100000,
  contextManual: false,
  maxOutput: 8192,
  temperature: 0.7,
  inputCost: 2.5,
  outputCost: 10,
  reasoning: "med",
  setStep: (step) => set({ step }),
  setBrainChoice: (brainChoice) => set({ brainChoice }),
  setProvider: (providerId) => set({ providerId }),
  setBaseUrl: (baseUrl) => set({ baseUrl }),
  setApiKey: (apiKey) => set({ apiKey }),
  toggleShowApiKey: () => set((s) => ({ showApiKey: !s.showApiKey })),
  setModelId: (modelId) => set({ modelId, showModelDropdown: false }),
  setShowModelDropdown: (showModelDropdown) => set({ showModelDropdown }),
  setContextWindow: (contextWindow) => set({ contextWindow }),
  setContextManual: (contextManual) => set({ contextManual }),
  setMaxOutput: (maxOutput) => set({ maxOutput }),
  setTemperature: (temperature) => set({ temperature }),
  setInputCost: (inputCost) => set({ inputCost }),
  setOutputCost: (outputCost) => set({ outputCost }),
  setReasoning: (reasoning) => set({ reasoning }),
}));
