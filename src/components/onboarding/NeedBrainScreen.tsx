import { useOnboardingStore } from "./onboarding-store";
import { isSetupDone, markSetupDone } from "./providers-api";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { ActionButton } from "./ActionButton";

/** Step 2 — ported from the demo's components/onboarding/NeedBrainScreen.tsx.
 * "Skip for now" (brainChoice 'later') dismisses setup: it jumps straight to
 * AllSet and clears the first-run flag. */
export function NeedBrainScreen() {
  const brainChoice = useOnboardingStore((s) => s.brainChoice);
  const setBrainChoice = useOnboardingStore((s) => s.setBrainChoice);
  const setStep = useOnboardingStore((s) => s.setStep);
  const s = useThemeStyles();

  const isNow = brainChoice === "now";
  const isLater = brainChoice === "later";
  // R126-3g: the choice cards speak the selection grammar — the selected
  // card = the accentTint fill + the 2px accentDeep ring (the mobile
  // "2px when selected" law); the radio = the accentDeep fill + accentText
  // check. The pre-R126 toggleActive fill + #111/white check ink retired.
  const checkColor = s.accentText;
  const choiceCard = (on: boolean) => ({
    background: on ? s.accentTint : s.card,
    border: on ? `2px solid ${s.accentDeep}` : `1px solid ${s.clayRim}`,
  });

  const handleBack = () => setStep(1);
  const handleNext = () => {
    if (isLater && !isSetupDone()) markSetupDone(); // dismissal counts as done
    setStep(isNow ? 3 : 4);
  };

  return (
    <div className="mx-auto w-full max-w-[1280px] xl:max-w-[1480px] 2xl:max-w-[1640px] flex min-h-full flex-col pt-4 md:pt-8 short:pt-2">
      {/* Heading */}
      <h2 className="text-center text-[36px] md:text-[52px] short:text-[30px] font-black tracking-[-0.03em] leading-[0.9]" style={{ color: s.text }}>
        Need a brain?
      </h2>
      <p className="mt-3 short:mt-2 text-center text-[15px] md:text-[16px] font-medium max-w-[520px] mx-auto" style={{ color: s.textSecondary }}>
        ACUTE-CODE needs a model to think with. Set it up now or skip for later.
      </p>

      {/* Cards Grid — two equal-height choices, centered in the leftover
          height (content-center) so tall windows don't leave them stranded
          at the top */}
      <div className="mt-6 md:mt-8 short:mt-4 grid flex-1 content-center md:grid-cols-2 gap-4 md:gap-5 2xl:gap-8">
        {/* Card 1 – Configure Now */}
        <div
          className={`h-full flex flex-col text-left rounded-[24px] border p-5 md:p-6 short:p-4 transition-all group cursor-pointer ac-clay ${
            isNow ? "translate-y-[-2px]" : ""
          }`}
          style={choiceCard(isNow)}
          onClick={() => setBrainChoice("now")}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setBrainChoice("now"); }}
        >
          {/* Top row */}
          <div className="flex justify-between items-start">
            {/* Brain SVG icon — R126-3g: the ClayIconChip tile (accentTint +
                rim + the accentDeep glyph). */}
            <div
              className="w-12 h-12 rounded-[14px] border grid place-items-center bg-accent-tint border-clay-rim"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke={s.accentDeep} strokeWidth="1.5" className="w-6 h-6">
                <path d="M12 2C8.5 2 5 4.5 5 8.5c0 2 1 3.5 2 4.5v5c0 1.5 1 3 2.5 3.5.5-1 1.5-1.5 2.5-1.5s2 .5 2.5 1.5c1.5-.5 2.5-2 2.5-3.5v-5c1-1 2-2.5 2-4.5C19 4.5 15.5 2 12 2z" />
              </svg>
            </div>

            {/* Right column: badge + radio */}
            <div className="flex items-center gap-2">
              <span
                className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-badge-accent text-badge-accent-fg"
              >
                RECOMMENDED
              </span>
              {/* Radio */}
              <div
                className="w-6 h-6 rounded-full border-[1.5px] grid place-items-center"
                style={{
                  borderColor: s.borderStrong,
                  background: isNow ? s.accentDeep : "transparent",
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

          {/* Checklist — R126-3g: the ✓ chips ride the accentTint +
              accentDeep icon-chip pair. */}
          <div className="mt-5 short:mt-3 space-y-2">
            {["Connect API • secure & local", "Test connection • instant feedback", "Tune reasoning • none → extra"].map((item) => (
              <div key={item} className="flex items-center gap-2 text-[13px] font-medium" style={{ color: s.text }}>
                <span
                  className="w-5 h-5 rounded-full grid place-items-center text-[10px] bg-accent-tint text-accent-deep"
                >
                  ✓
                </span>
                {item}
              </div>
            ))}
          </div>

          {/* Provider logos — R126-3g: the ghost avatars sink into wells. */}
          <div className="mt-5 short:mt-3 flex items-center gap-2">
            {["O", "A", "G", "R"].map((letter) => (
              <span
                key={letter}
                className="w-8 h-8 rounded-full border grid place-items-center text-[11px] font-black border-clay-rim bg-well"
                style={{ color: s.text }}
              >
                {letter}
              </span>
            ))}
            <span className="text-[11px] font-bold" style={{ color: s.textTertiary }}>+ custom</span>
          </div>

          {/* EST. TIME — anchored to the card bottom so equal-height cards
              align their footers */}
          <div
            className="mt-auto pt-5 short:pt-3"
          >
            <div
              className="ac-well rounded-[14px] px-3 py-2.5 flex items-center justify-between"
            >
              <span className="text-[11px] font-bold" style={{ color: s.textTertiary }}>EST. TIME</span>
              <span className="text-[12px] font-bold" style={{ color: s.text }}>~35 sec</span>
            </div>
          </div>
        </div>

        {/* Card 2 – I'll do it later */}
        <div
          className={`h-full flex flex-col text-left rounded-[24px] border p-5 md:p-6 short:p-4 transition-all group cursor-pointer ac-clay ${
            isLater ? "translate-y-[-2px]" : ""
          }`}
          style={choiceCard(isLater)}
          onClick={() => setBrainChoice("later")}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setBrainChoice("later"); }}
        >
          {/* Top row */}
          <div className="flex justify-between items-start">
            {/* Clock SVG icon — R126-3g: the quiet choice's tile sinks into
                the well (the unselected tier). */}
            <div
              className="w-12 h-12 rounded-[14px] border grid place-items-center border-clay-rim bg-well"
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
                background: isLater ? s.accentDeep : "transparent",
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
            Start exploring without a model. Add one whenever you&apos;re ready. No keys needed.
          </p>

          {/* Demo brain card — R126-3g: dashed clay rim. */}
          <div
            className="mt-6 short:mt-4 rounded-[14px] border border-dashed p-3 flex items-center gap-3 border-clay-rim"
          >
            <span
              className="w-10 h-10 rounded-full grid place-items-center text-[16px] bg-well"
              style={{ color: s.textTertiary }}
            >
              ◐
            </span>
            <div>
              <div className="text-[12px] font-bold" style={{ color: s.text }}>No brain configured</div>
              <div className="text-[11px]" style={{ color: s.textTertiary }}>Add one in Settings → Brain anytime</div>
            </div>
          </div>

          {/* Footer note — anchored to the card bottom to match card 1 */}
          <p className="mt-auto pt-5 short:pt-3 text-[11px] font-bold" style={{ color: s.textTertiary }}>
            You can configure in Settings anytime.
          </p>
        </div>
      </div>

      {/* Bottom Buttons — primary on the right (same action-row contract as
          every other step). Bottom padding keeps the pair off the window edge
          even when mt-auto pins the row down (owner directive). */}
      <div className="mt-auto pt-5 md:pt-8 short:pt-3 pb-6 md:pb-8 short:pb-4 flex items-center justify-between">
        <ActionButton variant="secondary" onClick={handleBack}>
          ← Back
        </ActionButton>
        <ActionButton variant="primary" onClick={handleNext}>
          {isNow ? "Configure Model →" : "Skip to Finish →"}
        </ActionButton>
      </div>
    </div>
  );
}
