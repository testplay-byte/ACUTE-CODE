'use client';

import { useOnboardingStore } from '@/lib/onboarding-store';
import { useThemeStyles } from '@/lib/use-theme-styles';

export default function Header() {
  const step = useOnboardingStore((s) => s.step);
  const s = useThemeStyles();

  const showSteps = step >= 1 && step <= 3;
  const currentStep = step === 3 ? 2 : step;

  return (
    <header>
      <div className="relative z-10 max-w-[1200px] mx-auto px-5 md:px-8 py-5 md:py-7">
        <div className="flex items-center justify-between">
          {/* Logo pill */}
          <div
            className="flex items-center gap-2.5 px-4 h-10 rounded-full border-[1.5px]"
            style={{
              background: s.card,
              borderColor: s.borderStrong,
              boxShadow: s.bentoShadowSm,
            }}
          >
            <span
              className="w-6 h-6 rounded-full grid place-items-center text-[11px] font-black tracking-tighter"
              style={{ background: s.accent, color: s.accentText }}
            >
              A
            </span>
            <span className="text-[13px] font-bold tracking-[-0.02em]" style={{ color: s.text }}>
              ACUTE AGENT
            </span>
            <span
              className="ml-1 px-2 py-0.5 rounded-full text-[10px] font-bold border"
              style={{
                backgroundColor: s.accent,
                color: s.accentText,
                borderColor: s.accent,
              }}
            >
              v2.0 BETA
            </span>
          </div>

          {/* Step indicator */}
          {showSteps && (
            <div className="flex items-center gap-3">
              <div
                className="hidden md:flex items-center gap-2 px-3 h-9 rounded-full border-[1.5px]"
                style={{
                  background: s.card,
                  borderColor: s.border,
                  boxShadow: s.softShadow,
                }}
              >
                <span className="text-[11px] font-bold" style={{ color: s.textTertiary }}>
                  STEP
                </span>
                <div className="flex gap-1.5">
                  {[0, 1, 2].map((g) => {
                    const isCurrent = g === currentStep;
                    const isDone = g < currentStep;
                    return (
                      <div
                        key={g}
                        className="h-1.5 rounded-full transition-all duration-300"
                        style={{
                          width: isCurrent ? '24px' : '14px',
                          background: isCurrent
                            ? s.toggleActive
                            : isDone
                              ? s.accent
                              : s.border,
                        }}
                      />
                    );
                  })}
                </div>
                <span className="text-[11px] font-bold" style={{ color: s.text }}>
                  {currentStep}/3
                </span>
              </div>
              <div
                className="w-9 h-9 rounded-full grid place-items-center border-[1.5px]"
                style={{
                  background: s.card,
                  borderColor: s.borderStrong,
                  boxShadow: s.softShadow,
                }}
              >
                <span style={{ color: s.text }} className="text-[13px]">✦</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
