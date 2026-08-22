import { useOnboardingStore } from "../onboarding-store";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import { ProviderSelector } from "./ProviderSelector";
import { ConnectionCard } from "./ConnectionCard";
import { ModelTuningCard } from "./ModelTuningCard";
import { ModelSummary } from "./ModelSummary";

/**
 * Step 3 — ported from the demo's components/onboarding/PlugBrainScreen.tsx.
 * Wired LIVE: providers come from GET /api/v1/providers, models from
 * GET /providers/{id}/models, connection test from POST /providers/{id}/test,
 * and the key is stored through the Tauri shell command (Credential Manager)
 * — never a REST body, never localStorage.
 *
 * Layout: fixed header band, then a two-region grid that fills the remaining
 * height. The summary rail's width grows smoothly with the window via
 * clamp() (no breakpoint jumps); each column scrolls INTERNALLY when its
 * content overflows, so the page itself never double-scrolls.
 */
export function PlugBrainScreen() {
  const s = useThemeStyles();
  const setStep = useOnboardingStore((st) => st.setStep);
  const apiKey = useOnboardingStore((st) => st.apiKey);
  const modelId = useOnboardingStore((st) => st.modelId);

  const canProceed = apiKey.length > 6 && modelId.length > 2;

  return (
    <div className="h-full flex flex-col pt-2 md:pt-4 short:pt-1">
      {/* Header row */}
      <div className="flex flex-wrap items-end justify-between gap-3 shrink-0">
        <div>
          <h1 className="text-[32px] md:text-[44px] short:text-[28px] font-black tracking-[-0.04em] leading-[0.95]" style={{ color: s.text }}>
            Plug in your brain
          </h1>
          <p className="mt-2 short:mt-1 text-[14px] font-medium" style={{ color: s.textSecondary }}>
            Connect a provider, paste a key, tune it how you like.
          </p>
        </div>
        <div
          className="flex items-center gap-2 px-3 py-1.5 rounded-full border text-[11px] font-bold"
          style={{
            background: s.card,
            borderColor: s.border,
            color: s.text,
            boxShadow: s.softShadow,
          }}
        >
          <span className="w-2 h-2 rounded-full bg-[#27C93F] animate-pulse" />
          Secure &bull; Encrypted &bull; Local
        </div>
      </div>

      {/* Two-region grid — fills remaining height; summary rail scales
          smoothly 320→460px with the viewport (clamp), no discrete jumps */}
      <div className="mt-4 md:mt-6 short:mt-3 flex-1 min-h-0 grid gap-5 md:gap-6 lg:grid-cols-[minmax(0,1fr)_clamp(320px,26vw,460px)]">
        {/* LEFT COLUMN (scrolls internally) */}
        <div className={`min-h-0 overflow-y-auto pr-1 md:pr-2 pb-6 flex flex-col gap-4 md:gap-5 custom-scrollbar ${s.isDark ? "dark-scroll" : ""}`}>
          {/* Provider card */}
          <div
            className="rounded-[24px] border-[1.5px] p-4 md:p-5"
            style={{
              background: s.card,
              borderColor: s.border,
              boxShadow: s.softShadow,
            }}
          >
            <div className="flex items-center justify-between">
              <span className="font-bold tracking-tight" style={{ color: s.text }}>Provider</span>
              <span
                className="text-[10px] font-bold px-2 py-1 rounded-full"
                style={{ background: s.pillBg, color: s.pillText }}
              >
                STEP 1
              </span>
            </div>
            <ProviderSelector />
          </div>

          {/* Connection card */}
          <ConnectionCard />

          {/* Model tuning card */}
          <ModelTuningCard />
        </div>

        {/* RIGHT COLUMN (summary rail; scrolls internally on short windows) */}
        <div className={`min-h-0 overflow-y-auto pb-6 custom-scrollbar ${s.isDark ? "dark-scroll" : ""}`}>
          <ModelSummary
            onBack={() => setStep(2)}
            onSave={() => {
              if (canProceed) setStep(4);
            }}
          />
        </div>
      </div>
    </div>
  );
}
