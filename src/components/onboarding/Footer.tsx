import { useThemeStyles } from "../../lib/use-theme-styles";
import { WIZARD_EDGE } from "./onboarding-types";

/**
 * Wizard footer — ported from the demo's components/onboarding/Footer.tsx.
 * Slim, fixed-height chrome (the demo's pt-12 ate a fifth of a 640px-tall
 * window): it collapses on short viewports and never participates in step
 * scrolling.
 */
export function Footer() {
  const s = useThemeStyles();

  return (
    <footer className="shrink-0">
      {/* Full-bleed chrome: corner items pin to the true window edges. */}
      <div className={`relative z-10 pb-4 pt-5 md:pb-5 md:pt-6 short:pb-3 short:pt-4 ${WIZARD_EDGE}`}>
        <div
          className="flex h-4 items-center justify-between text-[11px] font-bold"
          style={{ opacity: 0.4, color: s.text }}
        >
          <span>© 2026 ACUTE-CODE • CRAFTED WITH ✦</span>
          <span className="hidden md:inline-flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#27C93F]" />
            all systems nominal
          </span>
        </div>
      </div>
    </footer>
  );
}
