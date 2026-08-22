import { useThemeStore } from "../../lib/theme-store";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useOnboardingStore } from "./onboarding-store";
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
 */
export function SetupWizard() {
  const step = useOnboardingStore((s) => s.step);
  const isDark = useThemeStore((s) => s.mode) === "dark";
  const s = useThemeStyles();

  return (
    <div
      className="h-screen w-full flex flex-col overflow-hidden relative"
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
      <div
        className="absolute top-[35%] right-[10%] w-[220px] h-[220px] rounded-full blur-[70px] opacity-[0.06] pointer-events-none"
        style={{ background: s.theme.accent2 }}
      />

      <Header />

      <main className="flex-1 min-h-0 overflow-hidden relative z-10">
        {step === 3 ? (
          // PlugBrainScreen manages its own internal scroll
          <div className="h-full max-w-[1200px] mx-auto px-5 md:px-8">
            <PlugBrainScreen />
          </div>
        ) : (
          <div
            className={`h-full max-w-[1200px] mx-auto px-5 md:px-8 overflow-y-auto custom-scrollbar ${isDark ? "dark-scroll" : ""}`}
          >
            <div key={step} className="wizard-step h-full">
              {step === 0 && <WelcomeScreen />}
              {step === 1 && <PickFlavorScreen />}
              {step === 2 && <NeedBrainScreen />}
              {step === 4 && <AllSetScreen />}
            </div>
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}
