'use client';

import { useOnboardingStore } from '@/lib/onboarding-store';
import { useThemeStyles } from '@/lib/use-theme-styles';
import ProviderSelector from './plug-brain/ProviderSelector';
import ConnectionCard from './plug-brain/ConnectionCard';
import ModelTuningCard from './plug-brain/ModelTuningCard';
import ModelSummary from './plug-brain/ModelSummary';

export default function PlugBrainScreen() {
  const s = useThemeStyles();
  const setStep = useOnboardingStore((st) => st.setStep);
  const apiKey = useOnboardingStore((st) => st.apiKey);
  const modelId = useOnboardingStore((st) => st.modelId);

  const canProceed = apiKey.length > 6 && modelId.length > 2;

  return (
    <div className="h-full flex flex-col">
      {/* Header row */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[32px] md:text-[44px] font-black tracking-[-0.04em] leading-[0.95]" style={{ color: s.text }}>
            Plug in your brain
          </h1>
          <p className="mt-2 text-[14px] font-medium" style={{ color: s.textSecondary }}>
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

      {/* Grid layout - fills remaining space */}
      <div className="mt-6 flex-1 min-h-0 grid lg:grid-cols-[1.15fr_380px] gap-6 items-start">
        {/* LEFT COLUMN (scrollable) */}
        <div className={`max-h-full overflow-y-auto pr-2 flex flex-col gap-5 pb-8 ${s.isDark ? 'custom-scrollbar dark-scroll' : 'custom-scrollbar'}`}>
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

        {/* RIGHT COLUMN (sticky, no scroll) */}
        <div className="lg:sticky lg:top-0">
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
