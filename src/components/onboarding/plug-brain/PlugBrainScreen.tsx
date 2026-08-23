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
 * Layout (owner round-7): the step lives in the wizard's shared scroll
 * wrapper — the WHOLE screen scrolls as one unit (configuration sections at
 * the top, Model Summary at the bottom of the flow; on wide windows the two
 * sit side by side, summary right). No internal column scroll and no fixed
 * rail: nothing can be clipped out of reach on short or tall displays.
 */
export function PlugBrainScreen() {
  const s = useThemeStyles();
  const setStep = useOnboardingStore((st) => st.setStep);
  const apiKey = useOnboardingStore((st) => st.apiKey);
  const modelId = useOnboardingStore((st) => st.modelId);

  const canProceed = apiKey.length > 6 && modelId.length > 2;

  return (
    <div className="mx-auto w-full max-w-[1280px] xl:max-w-[1480px] 2xl:max-w-[1640px] flex min-h-full flex-col pt-4 md:pt-8 short:pt-2 pb-8 md:pb-10">
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

      {/* Two-section grid. Wide windows: configuration left · summary right.
          Narrow/short windows: stacks with the summary below the
          configuration — the page scrolls as ONE flow either way. */}
      <div className="mt-4 md:mt-6 short:mt-3 grid gap-5 md:gap-8 items-start lg:grid-cols-[minmax(0,1fr)_clamp(360px,30vw,540px)] lg:pr-2 xl:pr-8">
        {/* LEFT SECTION — provider, connection, tuning */}
        <div className="min-w-0 flex flex-col gap-4 md:gap-5">
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

        {/* RIGHT SECTION — model summary + actions; top-aligned with
            breathing room inset from the right edge */}
        <div className="min-w-0">
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
