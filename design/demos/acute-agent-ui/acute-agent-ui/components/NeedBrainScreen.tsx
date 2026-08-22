'use client';

import { useOnboardingStore } from '@/lib/onboarding-store';
import { useThemeStyles } from '@/lib/use-theme-styles';

export default function NeedBrainScreen() {
  const { brainChoice, setBrainChoice, setStep } = useOnboardingStore();
  const s = useThemeStyles();

  const isNow = brainChoice === 'now';
  const isLater = brainChoice === 'later';
  const checkColor = s.isDark ? '#111' : 'white';

  const handleBack = () => setStep(1);
  const handleNext = () => setStep(isNow ? 3 : 4);

  return (
    <div className="mt-10 max-w-[980px] mx-auto pb-12">
      {/* Heading */}
      <h2 className="text-center text-[36px] md:text-[52px] font-black tracking-[-0.03em] leading-[0.9]" style={{ color: s.text }}>
        Need a brain?
      </h2>
      <p className="mt-3 text-center text-[15px] md:text-[16px] font-medium max-w-[520px] mx-auto" style={{ color: s.textSecondary }}>
        ACUTE needs a model to think with. Set it up now or skip for later.
      </p>

      {/* Cards Grid */}
      <div className="mt-8 grid md:grid-cols-2 gap-4 md:gap-5">
        {/* Card 1 – Configure Now */}
        <div
          className={`text-left rounded-[28px] border-[2px] p-5 md:p-6 transition-all group cursor-pointer ${
            isNow ? 'translate-y-[-2px]' : ''
          }`}
          style={{
            background: s.card,
            borderColor: isNow ? s.borderStrong : s.border,
            boxShadow: isNow ? s.bentoShadow : s.softShadow,
          }}
          onClick={() => setBrainChoice('now')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setBrainChoice('now'); }}
        >
          {/* Top row */}
          <div className="flex justify-between items-start">
            {/* Brain SVG icon */}
            <div
              className="w-12 h-12 rounded-[14px] border-[1.5px] grid place-items-center"
              style={{ backgroundColor: s.accent, borderColor: s.borderStrong }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke={s.accentText} strokeWidth="1.5" className="w-6 h-6">
                <path d="M12 2C8.5 2 5 4.5 5 8.5c0 2 1 3.5 2 4.5v5c0 1.5 1 3 2.5 3.5.5-1 1.5-1.5 2.5-1.5s2 .5 2.5 1.5c1.5-.5 2.5-2 2.5-3.5v-5c1-1 2-2.5 2-4.5C19 4.5 15.5 2 12 2z" />
              </svg>
            </div>

            {/* Right column: badge + radio */}
            <div className="flex items-center gap-2">
              <span
                className="px-2 py-0.5 rounded-full border text-[10px] font-bold"
                style={{ backgroundColor: s.accent, color: s.accentText, borderColor: s.accent }}
              >
                RECOMMENDED
              </span>
              {/* Radio */}
              <div
                className="w-6 h-6 rounded-full border-[1.5px] grid place-items-center"
                style={{
                  borderColor: s.borderStrong,
                  background: isNow ? s.toggleActive : 'transparent',
                }}
              >
                {isNow && (
                  <svg viewBox="0 0 24 24" fill="none" strokeWidth="3" className="w-3.5 h-3.5" stroke={checkColor}>
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </div>
            </div>
          </div>

          {/* Title & subtitle */}
          <div className="mt-3 font-black text-[16px] tracking-tight" style={{ color: s.text }}>Configure now</div>
          <div className="text-[12px] font-medium" style={{ color: s.textSecondary }}>Most devs start here</div>

          {/* Checklist */}
          <div className="mt-5 space-y-2">
            {["Connect API • secure & local", "Set pricing • cost control", "Tune reasoning • none → extra"].map((item) => (
              <div key={item} className="flex items-center gap-2 text-[13px] font-medium" style={{ color: s.text }}>
                <span
                  className="w-5 h-5 rounded-full grid place-items-center text-[10px]"
                  style={{ background: s.pillBg, color: s.pillText }}
                >
                  ✓
                </span>
                {item}
              </div>
            ))}
          </div>

          {/* Provider logos */}
          <div className="mt-5 flex items-center gap-2">
            {['O', 'A', 'G', 'Q', 'R'].map((letter) => (
              <span
                key={letter}
                className="w-8 h-8 rounded-full border grid place-items-center text-[11px] font-black"
                style={{
                  background: s.subtle,
                  borderColor: s.border,
                  color: s.text,
                }}
              >
                {letter}
              </span>
            ))}
            <span className="text-[11px] font-bold" style={{ color: s.textTertiary }}>+ custom</span>
          </div>

          {/* EST. TIME */}
          <div
            className="mt-5 rounded-[14px] border px-3 py-2.5 flex items-center justify-between"
            style={{
              background: s.subtle,
              borderColor: s.border,
            }}
          >
            <span className="text-[11px] font-bold" style={{ color: s.textTertiary }}>EST. TIME</span>
            <span className="text-[12px] font-bold" style={{ color: s.text }}>~35 sec</span>
          </div>
        </div>

        {/* Card 2 – I'll do it later */}
        <div
          className={`text-left rounded-[28px] border-[2px] p-5 md:p-6 transition-all group cursor-pointer ${
            isLater ? 'translate-y-[-2px]' : ''
          }`}
          style={{
            background: s.card,
            borderColor: isLater ? s.borderStrong : s.border,
            boxShadow: isLater ? s.bentoShadow : s.softShadow,
          }}
          onClick={() => setBrainChoice('later')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setBrainChoice('later'); }}
        >
          {/* Top row */}
          <div className="flex justify-between items-start">
            {/* Clock SVG icon */}
            <div
              className="w-12 h-12 rounded-[14px] border-[1.5px] grid place-items-center"
              style={{
                background: s.subtle,
                borderColor: s.borderStrong,
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke={s.text} strokeWidth="1.5" className="w-6 h-6">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 3" />
              </svg>
            </div>

            {/* Radio */}
            <div
              className="w-6 h-6 rounded-full border-[1.5px] grid place-items-center"
              style={{
                borderColor: s.borderStrong,
                background: isLater ? s.toggleActive : 'transparent',
              }}
            >
              {isLater && (
                <svg viewBox="0 0 24 24" fill="none" strokeWidth="3" className="w-3.5 h-3.5" stroke={checkColor}>
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </div>
          </div>

          {/* Title & subtitle */}
          <div className="mt-3 font-black text-[16px] tracking-tight" style={{ color: s.text }}>I&apos;ll do it later</div>
          <div className="text-[12px] font-medium" style={{ color: s.textSecondary }}>Explore first</div>

          {/* Description */}
          <p className="mt-5 text-[14px] leading-[1.5] font-medium" style={{ color: s.textSecondary }}>
            Start exploring with demo mode. Add model when you&apos;re ready. No keys needed.
          </p>

          {/* Demo brain card */}
          <div
            className="mt-6 rounded-[14px] border-[1.5px] border-dashed p-3 flex items-center gap-3"
            style={{
              borderColor: s.border,
            }}
          >
            <span
              className="w-10 h-10 rounded-full grid place-items-center text-[16px]"
              style={{ background: s.subtle }}
            >
              ◐
            </span>
            <div>
              <div className="text-[12px] font-bold" style={{ color: s.text }}>Demo brain active</div>
              <div className="text-[11px]" style={{ color: s.textTertiary }}>Limited • offline • safe</div>
            </div>
          </div>

          {/* Footer note */}
          <p className="mt-5 text-[11px] font-bold" style={{ color: s.textTertiary }}>
            You can configure in Settings → Brain anytime.
          </p>
        </div>
      </div>

      {/* Bottom Buttons */}
      <div className="mt-8 flex items-center justify-between">
        <button
          onClick={handleBack}
          className="h-12 px-5 rounded-full border-[1.5px] font-bold text-[14px] hover:opacity-80 transition-opacity cursor-pointer"
          style={{
            background: s.card,
            borderColor: s.border,
            color: s.text,
            boxShadow: s.softShadow,
          }}
        >
          ← Back
        </button>
        <button
          onClick={handleNext}
          className="h-12 px-7 rounded-full font-bold text-[14px] flex items-center gap-2 hover:scale-[1.02] active:scale-[0.98] transition-transform cursor-pointer border-[1.5px]"
          style={{
            backgroundColor: s.accent,
            color: s.accentText,
            borderColor: s.accent,
            boxShadow: s.bentoShadow,
          }}
        >
          {isNow ? 'Configure Model →' : 'Skip to Finish →'}
        </button>
      </div>
    </div>
  );
}
