import { resolveThemeMode, useThemeStore } from "../../lib/theme-store";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useOnboardingStore } from "./onboarding-store";
import { WIZARD_EDGE } from "./onboarding-types";
import { Header } from "./Header";
import { Footer } from "./Footer";
import { WelcomeScreen } from "./WelcomeScreen";
import { PickFlavorScreen } from "./PickFlavorScreen";
import { NeedBrainScreen } from "./NeedBrainScreen";
import { PlugBrainScreen } from "./plug-brain/PlugBrainScreen";
import { AllSetScreen } from "./AllSetScreen";

/**
 * /setup — five-step first-run wizard, ported from the design demo's
 * app/page.tsx: full-bleed themed background, 28px dot-grid overlay at 4%
 * opacity, three ambient accent glows, Header/Footer chrome, and a CSS
 * keyframe transition per step (.wizard-step in index.css).
 *
 * Layout contract (owner directive: full-fledged adaptable layouts):
 * - Header/Footer are fixed-height chrome; the step area fills the rest.
 * - The content container widens with the window (1280 → 1480 → 1640) so
 *   wide viewports get wider grids instead of dead side gutters.
 * - Each screen is a `min-h-full flex flex-col` region: content fills the
 *   height, action rows pin to the bottom, and only genuinely overflowing
 *   content scrolls (inside this wrapper or inside PlugBrain's columns).
 */

export function SetupWizard() {
  const step = useOnboardingStore((s) => s.step);
  // R113-b: "system" resolves (the wizard's dot-grid + scrollbar follow the
  // same palette the rest of the app paints).
  const isDark = resolveThemeMode(useThemeStore((s) => s.mode)) === "dark";
  const s = useThemeStyles();

  return (
    // R58: h-full (was h-screen) — the App root's flex column sizes the
    // wizard (the custom TitleBar sits above it in Tauri; web unchanged).
    <div
      className="h-full w-full flex flex-col overflow-hidden relative"
      style={{
        backgroundColor: s.bg,
        color: s.text,
        fontFamily:
          "'Space Grotesk', 'General Sans', ui-sans-serif, system-ui, sans-serif",
        letterSpacing: "-0.01em",
      }}
    >
      {/* Background effects */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.04]"
        style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, ${isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.12)"} 1px, transparent 0)`,
          backgroundSize: "28px 28px",
        }}
      />
      <div
        className="absolute -top-24 -right-24 w-[420px] h-[420px] rounded-full blur-[80px] opacity-20 pointer-events-none"
        style={{ background: s.accent }}
      />
      <div
        className="absolute -bottom-32 -left-32 w-[520px] h-[520px] rounded-full blur-[90px] opacity-[0.08] pointer-events-none"
        style={{ background: s.accent }}
      />
      {/* R108-e: the third ambient glow is back to the SECOND ACCENT at its
          original 6% (the round-98 owner-approved wizard stage — three warm
          washes; WIZARD-DNA §1). R107-g had swapped it for a platinum/chrome
          wash (--ac-chrome-hi at 18%, a blurred WHITE light); that read as
          the "glow fade… and other stuff like that" the owner rejected in
          round-108, so the wizard's stage light is warm again — the chrome
          lives in the hero block + CTA sheen, never in ambient light. */}
      <div
        className="absolute top-[35%] right-[10%] w-[220px] h-[220px] rounded-full blur-[70px] opacity-[0.06] pointer-events-none"
        style={{ background: s.theme.accent2 }}
      />

      <Header />

      <main className="relative z-10 flex-1 min-h-0 overflow-hidden">
        {/* All steps share ONE scroll wrapper (owner round-7: PlugBrain used
            to manage internal column scroll, which clipped the fixed summary
            rail on short/tall windows — the whole step now scrolls as one). */}
        <div
          className={`h-full flex flex-col overflow-y-auto overflow-x-clip custom-scrollbar ${WIZARD_EDGE} ${isDark ? "dark-scroll" : ""}`}
        >
          <div key={step} className="wizard-step flex min-h-0 flex-1 flex-col">
            {step === 0 && <WelcomeScreen />}
            {step === 1 && <PickFlavorScreen />}
            {step === 2 && <NeedBrainScreen />}
            {step === 3 && <PlugBrainScreen />}
            {step === 4 && <AllSetScreen />}
          </div>
        </div>
      </main>

      {/* Footer chrome only on Welcome (owner directive: the ©/status band
          wasted vertical space on every working step). */}
      {step === 0 && <Footer />}
    </div>
  );
}
