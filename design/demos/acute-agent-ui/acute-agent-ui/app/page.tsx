'use client';

import { useOnboardingStore } from '@/lib/onboarding-store';
import { THEMES } from '@/lib/onboarding-types';
import Header from '@/components/onboarding/Header';
import Footer from '@/components/onboarding/Footer';
import WelcomeScreen from '@/components/onboarding/WelcomeScreen';
import PickFlavorScreen from '@/components/onboarding/PickFlavorScreen';
import NeedBrainScreen from '@/components/onboarding/NeedBrainScreen';
import PlugBrainScreen from '@/components/onboarding/PlugBrainScreen';
import AllSetScreen from '@/components/onboarding/AllSetScreen';

export default function OnboardingPage() {
  const step = useOnboardingStore((s) => s.step);
  const themeId = useOnboardingStore((s) => s.themeId);
  const isDark = useOnboardingStore((s) => s.isDark);
  const theme = THEMES.find((t) => t.id === themeId) || THEMES[0];

  const bg = isDark ? theme.bgDark : theme.bgLight;
  const text = isDark ? theme.textDark : theme.textLight;

  return (
    <div
      className="h-screen w-full flex flex-col overflow-hidden relative"
      style={{
        backgroundColor: bg,
        color: text,
        fontFamily: "'Space Grotesk', 'General Sans', ui-sans-serif, system-ui, sans-serif",
        letterSpacing: '-0.01em',
      }}
    >
      {/* Background effects */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.04]"
        style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'} 1px, transparent 0)`,
          backgroundSize: '28px 28px',
        }}
      />
      <div
        className="absolute -top-24 -right-24 w-[420px] h-[420px] rounded-full blur-[80px] opacity-20 pointer-events-none"
        style={{ background: theme.accent }}
      />
      <div
        className="absolute -bottom-32 -left-32 w-[520px] h-[520px] rounded-full blur-[90px] opacity-[0.08] pointer-events-none"
        style={{ background: theme.accent }}
      />
      <div
        className="absolute top-[35%] right-[10%] w-[220px] h-[220px] rounded-full blur-[70px] opacity-[0.06] pointer-events-none"
        style={{ background: theme.accent2 }}
      />

      <Header />

      <main className="flex-1 min-h-0 overflow-hidden relative z-10">
        {step === 3 ? (
          // PlugBrainScreen manages its own internal scroll
          <div className="h-full max-w-[1200px] mx-auto px-5 md:px-8">
            <PlugBrainScreen />
          </div>
        ) : (
          <div className={`h-full max-w-[1200px] mx-auto px-5 md:px-8 overflow-y-auto ${isDark ? 'custom-scrollbar dark-scroll' : 'custom-scrollbar'}`}>
            {step === 0 && <WelcomeScreen />}
            {step === 1 && <PickFlavorScreen />}
            {step === 2 && <NeedBrainScreen />}
            {step === 4 && <AllSetScreen />}
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}
