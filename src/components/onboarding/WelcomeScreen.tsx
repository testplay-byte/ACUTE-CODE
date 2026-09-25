import { useCallback, useEffect, useRef, useState } from "react";
import { useOnboardingStore } from "./onboarding-store";
import { useThemeStyles } from "../../lib/use-theme-styles";

// R126-3g (the clay palette pass): the hardcoded per-step hues
// (#D6FF57 / #A5B4FF / #FFB88A — other themes' accents pasted in) retired;
// every icon tile is now the ClayIconChip grammar — bg-accent-tint fill +
// clayRim hairline + the accentDeep glyph (the mobile welcome row recipe).
const STEP_CARDS = [
  { num: "01", title: "Pick flavor", desc: "Choose theme & vibe", icon: "◑", rot: "-1deg" },
  { num: "02", title: "Plug brain", desc: "Connect your model", icon: "◒", rot: "1deg" },
  { num: "03", title: "Ship code", desc: "Start building instantly", icon: "rocket", rot: "-0.5deg" },
] as const;

const CODE_LINES = `acute> init --theme nova --brain gpt-4o
✓ workspace ready
✓ theme synced
✓ brain connected
→ ready to ship_`;

/** Step 0 — ported from the demo's components/onboarding/WelcomeScreen.tsx. */
export function WelcomeScreen() {
  const setStep = useOnboardingStore((s) => s.setStep);
  const s = useThemeStyles();

  const [typed, setTyped] = useState("");
  const idxRef = useRef(0);

  useEffect(() => {
    idxRef.current = 0;
    const iv = setInterval(() => {
      idxRef.current++;
      setTyped(CODE_LINES.slice(0, idxRef.current));
      if (idxRef.current >= CODE_LINES.length) clearInterval(iv);
    }, 22);
    return () => {
      clearInterval(iv);
      setTyped("");
    };
  }, []);

  const handleGetStarted = useCallback(() => {
    setStep(1);
  }, [setStep]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter") handleGetStarted();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleGetStarted]);

  // R126-3g: the fake terminal's hardcoded dark/light body hexes retired —
  // the body rides the recessed mono surface tokens (TOKENS §10).
  return (
    // Owner directive (adaptable layouts): the hero composition is vertically
    // CENTERED in the available height and bounded to a readable width — wide
    // displays get larger type (2xl bumps) instead of a stretched, sparse grid.
    <div className="flex flex-1 flex-col justify-center py-6 short:py-2">
      {/* Bounded, centered composition: on very wide displays the layout stays
          proportional and centered instead of stretching into sparse columns. */}
      <div className="grid mx-auto w-full max-w-[1280px] 2xl:max-w-[1480px] flex-1 items-center gap-6 pb-4 md:gap-8 lg:grid-cols-[0.85fr_1.15fr] 2xl:gap-14">
        {/* LEFT COLUMN */}
        <div className="space-y-4 short:space-y-3 md:space-y-5">
        {/* Step Cards Grid — R126-3g: clay cards (clayRim hairline +
            .ac-clay-sm) with the ClayIconChip icon tiles; the micro-rotations
            + hover counter-rotate (the DNA's deliberate imperfection) stay. */}
        <div className="grid gap-3">
          {STEP_CARDS.map((card) => (
            <div
              key={card.num}
              className="group relative rounded-[22px] border p-4 md:p-5 short:p-3 flex items-center gap-4 transition-all hover:translate-y-[-2px] hover:rotate-[0.3deg] border-clay-rim ac-clay-sm bg-card"
              style={{ transform: `rotate(${card.rot})` }}
            >
              <div
                className="w-12 h-12 rounded-[14px] border grid place-items-center text-[18px] font-black shrink-0 bg-accent-tint text-accent-deep border-clay-rim"
              >
                {card.icon === "rocket" ? (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={s.accentDeep} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
                    <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
                    <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
                    <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
                  </svg>
                ) : (
                  card.icon
                )}
              </div>
              <span
                className="text-[11px] font-black px-1.5 py-0.5 rounded-full bg-badge-neutral text-badge-neutral-fg"
              >
                {card.num}
              </span>
              <div className="flex-1">
                <div className="font-bold tracking-tight text-[15px]" style={{ color: s.text }}>{card.title}</div>
                <div className="text-[13px] font-medium" style={{ color: s.textSecondary }}>{card.desc}</div>
              </div>
              <div
                className="w-7 h-7 rounded-full border grid place-items-center text-[12px] border-clay-rim"
                style={{ color: s.textTertiary }}
              >
                ↗
              </div>
            </div>
          ))}
        </div>

        {/* Code Block — R126-3g: the fake terminal keeps its macOS traffic
            lights (the documented theatrical prop) but the body is now the
            recessed mono surface (.ac-mono-block, TOKENS §10) and the shell
            is a clay card. */}
        <div
          className="rounded-[24px] border overflow-hidden relative border-clay-rim ac-clay bg-card"
        >
          <div className="flex items-center justify-between p-4 pb-0">
            <div className="flex items-center gap-2">
              {/* The macOS traffic-light dots — a deliberate theatrical prop
                  (WIZARD-DNA §5): the documented hex exception. */}
              <div className="w-3 h-3 rounded-full bg-[#FF5F56]" />
              <div className="w-3 h-3 rounded-full bg-[#FFBD2E]" />
              <div className="w-3 h-3 rounded-full bg-[#28C840]" />
            </div>
            <div className="flex items-center gap-2">
              <span
                className="px-2.5 py-1 rounded-full border text-[11px] font-bold bg-badge-neutral text-badge-neutral-fg"
              >
                acute.config.ts
              </span>
              <span
                className="px-2 py-1 rounded-full text-[10px] font-bold bg-badge-accent text-badge-accent-fg"
              >
                LIVE
              </span>
              <span
                className="px-2 py-1 rounded-full border text-[10px] font-bold bg-badge-neutral text-badge-neutral-fg"
              >
                42ms
              </span>
            </div>
          </div>
          <pre
            className="ac-mono-block p-4 pt-3 font-mono text-[12px] md:text-[13px] leading-[1.6] whitespace-pre-wrap min-h-[120px] short:min-h-[84px]"
            style={{ color: s.monoText }}
          >
            {typed}
          </pre>
          <div
            className="absolute -right-6 -bottom-6 w-24 h-24 rounded-full blur-[12px] pointer-events-none"
            style={{ backgroundColor: "var(--ac-accent)", opacity: 0.15 }}
          />
        </div>

        {/* Tip Bar — R126-3g: clay card + the ClayIconChip ✦ tile. */}
        <div
          className="rounded-[18px] border px-4 py-3 short:py-2 flex items-center gap-3 text-[12px] font-medium border-clay-rim ac-clay-sm bg-card"
          style={{ color: s.text }}
        >
          <div
            className="w-8 h-8 rounded-full grid place-items-center text-[12px] bg-accent-tint text-accent-deep"
          >
            ✦
          </div>
          <span>Tip: Your keys never leave your machine. 100% local.</span>
        </div>
      </div>

      {/* RIGHT COLUMN */}
      <div className="relative">
        {/* Badge — R126-3g: the accent badge tone (accentDeep fill +
            accentText ink, TOKENS §11); the rotation + pulse dot stay. */}
        <span
          className="inline-flex items-center gap-2 px-3 py-1 rounded-full border-[1.5px] rotate-[-1.5deg] text-[12px] font-bold tracking-wide ac-clay-sm bg-badge-accent"
          style={{ color: s.accentText }}
        >
          <span className="w-2 h-2 rounded-full animate-pulse-dot" style={{ background: s.accentText }} />
          NEW ONBOARDING • UNDER 60 SEC
        </span>

        {/* Heading */}
        <h1 className="mt-8 short:mt-4">
          <span
            className="block text-[14px] md:text-[15px] font-bold tracking-[0.18em] mb-3"
            style={{ color: s.textSecondary }}
          >
            WELCOME TO
          </span>
          <span className="block text-[56px] md:text-[86px] short:text-[42px] 2xl:text-[104px] font-black leading-none" style={{ color: s.text }}>
            ACUTE
          </span>
          <span
            className="ac-chrome-metal ac-chrome-sheen inline-block px-3 md:px-4 -ml-1 md:-ml-2 rounded-[18px] md:rounded-[24px] text-[56px] md:text-[86px] short:text-[42px] 2xl:text-[104px] font-black leading-none border-[2.5px] rotate-[-1deg]"
            style={{
              // R107-g (the clay/chrome round): the hero block is LIQUID
              // CHROME — the platinum ramp (.ac-chrome-metal) + the ambient
              // sheen pass (.ac-chrome-sheen), ink in the theme's text color
              // (dark-on-platinum in light mode, light-on-dark-metal in
              // dark mode — both contrast-checked by construction). The
              // accent stays the badge's + CTA's job; the brand block is
              // the one metal jewel of the composition (WIZARD-DNA §2).
              // R108-e: the sheen rides on at HALF brightness/reach (the
              // --ac-chrome-sheen stop halved + the band narrowed) — the
              // metal reads as material, not as a glow.
              color: s.text,
              borderColor: s.borderStrong,
              boxShadow: s.bentoShadow,
            }}
          >
            CODE.
          </span>
        </h1>

        {/* Description */}
        <p
          className="mt-6 short:mt-3 max-w-[520px] text-[16px] md:text-[18px] 2xl:text-[20px] leading-[1.4] font-medium"
          style={{ color: s.text, opacity: 0.8 }}
        >
          {"Let's get you set up in under 1 minute. We'll configure your first workspace, theme, and first brain."}
          <span
            className="inline-block ml-2 px-2 py-0.5 rounded-full text-[11px] font-bold rotate-[1deg] bg-badge-neutral text-badge-neutral-fg"
          >
            fun &amp; fast
          </span>
        </p>

        {/* Get Started Button — R126-3g: the ActionButton grammar on its
            home step — accent → accentDeep gradient stops + the sheen + the
            bentoShadow (WIZARD-DNA §7); the kbd hint sinks into the well. */}
        <div className="mt-8 short:mt-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <kbd
              className="px-2 py-1 rounded-md border text-[11px] font-bold border-clay-rim"
              style={{
                background: s.surfaceWell,
                color: s.text,
              }}
            >
              Enter
            </kbd>
            <span className="text-[12px] font-medium" style={{ color: s.textTertiary }}>or press to continue</span>
          </div>
          <button
            onClick={handleGetStarted}
            className="ac-chrome-sheen group h-12 px-8 rounded-full text-[16px] font-bold tracking-[-0.01em] flex items-center gap-3 border-[1.5px] transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer shrink-0"
            style={{
              background: `linear-gradient(135deg, ${s.accent}, ${s.accentDeep})`,
              color: s.accentText,
              borderColor: s.accentDeep,
              boxShadow: s.bentoShadow,
            }}
          >
            Get Started
            <span
              className="w-8 h-8 rounded-full grid place-items-center group-hover:translate-x-1 transition-transform"
              style={{ background: s.accentText, color: s.accentDeep }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </span>
          </button>
        </div>

        {/* Stats — R126-3g: the trio rides clay cards (rim + .ac-clay-sm). */}
        <div className="mt-10 short:mt-5 grid grid-cols-3 gap-3 max-w-[520px]">
          {[
            { value: "100%", label: "local" },
            { value: "<1m", label: "setup" },
            { value: "5", label: "agents max" },
          ].map((stat) => (
            <div
              key={stat.label}
              className="rounded-[18px] border p-3 short:p-2 border-clay-rim ac-clay-sm bg-card"
            >
              <div className="text-[18px] font-black tracking-tighter" style={{ color: s.text }}>{stat.value}</div>
              <div className="text-[11px] font-bold uppercase tracking-widest" style={{ color: s.textTertiary }}>{stat.label}</div>
            </div>
          ))}
        </div>

        {/* Floating Decorations — R126-3g: clay tiles; the ✦ square carries
            the accent as the tint + deep glyph (hue without loudness). */}
        <div
          className="absolute -right-6 top-[38%] hidden lg:block w-16 h-16 rounded-[16px] border grid place-items-center text-[22px] animate-float pointer-events-none bg-accent-tint text-accent-deep border-clay-rim ac-clay-sm"
        >
          ✦
        </div>
        <div
          className="absolute left-[58%] -bottom-10 hidden xl:flex w-12 h-12 rounded-full border items-center justify-center text-[18px] animate-float2 pointer-events-none border-clay-rim ac-clay-sm bg-card"
          style={{ color: s.text }}
        >
          ◐
        </div>
      </div>
      </div>
    </div>
  );
}
