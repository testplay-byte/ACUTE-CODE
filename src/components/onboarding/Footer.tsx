import { useThemeStyles } from "../../lib/use-theme-styles";

/** Wizard footer — ported from the demo's components/onboarding/Footer.tsx. */
export function Footer() {
  const s = useThemeStyles();

  return (
    <footer className="mt-auto">
      <div className="relative z-10 max-w-[1200px] mx-auto px-5 md:px-8 pb-8 pt-12">
        <div
          className="flex items-center justify-between text-[11px] font-bold"
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
