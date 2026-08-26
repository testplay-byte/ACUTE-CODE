/**
 * Wizard-local constants ported from the design demo's
 * lib/onboarding-types.ts (THEMES/Provider live elsewhere: themes in
 * src/lib/themes.ts, providers fetched LIVE from GET /api/v1/providers).
 */

/**
 * Shared responsive container for the wizard chrome (Header, main, Footer).
 * Widens with the window — 1280 → 1480 (xl) → 1640 (2xl) — so wide viewports
 * get wider grids instead of dead side gutters. Import from here (not from
 * SetupWizard) to keep the chrome modules cycle-free.
 */
export const WIZARD_EDGE =
  "w-full px-5 md:px-8 2xl:px-14";

/** Per-screen readable content cap (chrome is full-bleed via WIZARD_EDGE). */
export const WIZARD_CONTENT =
  "mx-auto w-full max-w-[1280px] xl:max-w-[1480px] 2xl:max-w-[1640px]";

export const WIZARD_CONTAINER =
  "mx-auto w-full max-w-[1280px] xl:max-w-[1480px] 2xl:max-w-[1640px]";

export type ReasoningLevel = "none" | "low" | "med" | "high" | "extra";

/**
 * Model id prefilled for the default provider (ROUND-43: the previous
 * stealth/ox-alpha default was DELETED from OpenRouter and killed every chat
 * that used it — the wizard now prefills the catalog default, a current FREE
 * model with tools + structured outputs, so first-run setups work out of the
 * box at $0).
 */
export const DEFAULT_MODEL_ID = "z-ai/glm-5.2:free";

export const REASONING_LEVELS: {
  id: ReasoningLevel;
  label: string;
  desc: string;
  icon: string;
}[] = [
  { id: "none", label: "None", desc: "Fastest", icon: "○" },
  { id: "low", label: "Low", desc: "Quick thoughts", icon: "◐" },
  { id: "med", label: "Med", desc: "Balanced", icon: "◑" },
  { id: "high", label: "High", desc: "Deep dive", icon: "◒" },
  { id: "extra", label: "Extra", desc: "Max reasoning", icon: "●" },
];

export const CONTEXT_OPTIONS = [
  { value: 1000, label: "1K" },
  { value: 10000, label: "10K" },
  { value: 100000, label: "100K" },
  { value: 500000, label: "500K" },
  { value: 1000000, label: "1M" },
] as const;

export const CONTEXT_LABELS: Record<number, string> = {
  1000: "1K",
  5000: "5K",
  10000: "10K",
  30000: "30K",
  50000: "50K",
  100000: "100K",
  200000: "200K",
  500000: "500K",
  1000000: "1M",
};

export function formatContext(val: number): string {
  if (CONTEXT_LABELS[val]) return CONTEXT_LABELS[val];
  return val >= 1_000_000
    ? `${(val / 1_000_000).toFixed(1)}M`
    : val >= 1_000
      ? `${(val / 1_000).toFixed(val % 1000 === 0 ? 0 : 1)}K`
      : String(val);
}

export function formatCost(v: number): string {
  return v > 0 ? `$${v}` : "Free";
}

export function estimateCost(
  context: number,
  maxOut: number,
  inputCost: number,
  outputCost: number,
): string {
  const ctxCost = (context / 1_000_000) * inputCost;
  const outCost = (maxOut / 1_000_000) * outputCost;
  const total = ctxCost + outCost;
  return total < 0.001 ? "<$0.001" : `$${total.toFixed(4)}`;
}
