import { useOnboardingStore } from "./onboarding-store";
import { WIZARD_EDGE } from "./onboarding-types";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { APP_NAME, APP_VERSION } from "../../lib/version";

/**
 * Wizard chrome — ported from the demo's components/onboarding/Header.tsx.
 * Step indicator shows for steps 1–3; the PlugBrain step (3) counts as 2/3.
 * FIXED-HEIGHT: the paddings below are the same on every step and collapse
 * on short windows (`short:`), so the step area gets a predictable share of
 * the viewport at every size.
 */
export function Header() {
  const step = useOnboardingStore((s) => s.step);
  const s = useThemeStyles();

  const showSteps = step >= 1 && step <= 3;
  const currentStep = step === 3 ? 2 : step;

  return (
    <header className="shrink-0">
      {/* Full-bleed chrome: logo/steps pin to the true window corners at every size. */}
      <div className={`relative z-10 py-4 md:py-6 short:py-3 ${WIZARD_EDGE}`}>
        <div className="flex h-10 items-center justify-between">
          {/* Logo pill — R126-3g: the clay chrome chip. */}
          <div
            className="flex items-center gap-2.5 px-4 h-10 rounded-full border border-clay-rim ac-clay-sm bg-card"
          >
            <span
              className="w-6 h-6 rounded-full grid place-items-center text-[11px] font-black tracking-tighter"
              style={{ background: s.accentDeep, color: s.accentText }}
            >
              A
            </span>
            <span className="text-[13px] font-bold tracking-[-0.02em]" style={{ color: s.text }}>
              {APP_NAME}
            </span>
            {/* R126-3g: the vX BETA chip rides the neutral badge + the
                meta-mono face (WIZARD-DNA §2's "meta-type mono suffix"). */}
            <span
              className="ml-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-badge-neutral text-badge-neutral-fg"
            >
              {`v${APP_VERSION}`} BETA
            </span>
          </div>

          {/* Step indicator */}
          {showSteps && (
            <div className="flex items-center gap-3">
              <div
                className="hidden md:flex items-center gap-2 px-3 h-9 rounded-full border border-clay-rim ac-clay-sm bg-card"
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
                          width: isCurrent ? "24px" : "14px",
                          // R126-3g: the morphing dots re-derive from the
                          // accent family — current = accentDeep, done =
                          // accent (the toggleActive white/black retired).
                          background: isCurrent
                            ? s.accentDeep
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
                className="w-9 h-9 rounded-full grid place-items-center border border-clay-rim ac-clay-sm bg-card"
              >
                <span style={{ color: s.text }} className="text-[13px]">
                  ✦
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
