import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useOnboardingStore } from "./onboarding-store";
import { markSetupDone } from "./providers-api";
import { useThemeStyles } from "../../lib/use-theme-styles";

/** Step 4 — ported from the demo's components/onboarding/AllSetScreen.tsx:
 * canvas confetti, animated check, summary cards, and the CTA back into the
 * app. Mounting this screen marks first-run setup done. */
export function AllSetScreen() {
  const s = useThemeStyles();
  const navigate = useNavigate();
  const providerId = useOnboardingStore((st) => st.providerId);
  const modelId = useOnboardingStore((st) => st.modelId);
  const brainChoice = useOnboardingStore((st) => st.brainChoice);
  const setStep = useOnboardingStore((st) => st.setStep);

  // Completion (either path through the wizard) clears the first-run flag.
  useEffect(() => {
    markSetupDone();
  }, []);

  const isSkip = brainChoice === "later" || !providerId;
  const modelLabel = isSkip ? "Not configured yet" : `${providerId} • ${modelId}`;
  const providerLetter = providerId ? providerId.charAt(0).toUpperCase() : "?";

  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener("resize", resize);

    const colors = [s.accent, "#D6FF57", "#7A5CFA", "#5A8CFF", "#FF6B2C"];
    const particles: {
      x: number;
      y: number;
      w: number;
      h: number;
      color: string;
      vx: number;
      vy: number;
      rotation: number;
      rotationSpeed: number;
      opacity: number;
    }[] = [];

    for (let i = 0; i < 160; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: -Math.random() * canvas.height * 0.5,
        w: 4 + Math.random() * 8,
        h: 4 + Math.random() * 8,
        color: colors[Math.floor(Math.random() * colors.length)],
        vx: (Math.random() - 0.5) * 2,
        vy: Math.random() * 2 + 1,
        rotation: Math.random() * 360,
        rotationSpeed: (Math.random() - 0.5) * 4,
        opacity: 1,
      });
    }

    let animId = 0;
    let stopped = false;
    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = false;
      for (const p of particles) {
        p.vy += 0.07;
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.rotationSpeed;
        if (p.y > canvas.height + 20) {
          p.opacity -= 0.02;
        }
        if (p.opacity <= 0) continue;
        alive = true;
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.opacity);
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (alive && !stopped) {
        animId = requestAnimationFrame(animate);
      }
    };
    animate();

    return () => {
      stopped = true;
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", resize);
    };
  }, [s.accent]);

  return (
    <div className="relative pb-12">
      {/* Confetti canvas */}
      <canvas
        ref={canvasRef}
        className="fixed inset-0 pointer-events-none z-0"
      />

      {/* Content */}
      <div className="mt-12 md:mt-16 max-w-[820px] mx-auto text-center relative z-10">
        {/* Success icon */}
        <div
          className="mx-auto w-[96px] h-[96px] rounded-[28px] grid place-items-center"
          style={{
            background: s.accent,
            border: `2.5px solid ${s.borderStrong}`,
            boxShadow: s.bentoShadow,
            animation: "bounce-in 0.7s cubic-bezier(.2,1.4,.4,1)",
          }}
        >
          <svg viewBox="0 0 42 42" className="w-12 h-12">
            <path
              d="M8 22 L18 30 L34 14"
              fill="none"
              stroke={s.accentText}
              strokeWidth="4.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="animate-draw"
            />
          </svg>
        </div>

        {/* Heading */}
        <h1
          className="mt-6 text-[40px] md:text-[64px] font-black tracking-[-0.04em] leading-[0.9]"
          style={{ color: s.text }}
        >
          You&apos;re all set!
        </h1>

        {/* Description */}
        <p
          className="mt-4 text-[15px] md:text-[17px] font-medium max-w-[560px] mx-auto leading-[1.5]"
          style={{ color: s.textSecondary }}
        >
          ACUTE-CODE is configured and ready to rip. Your theme is{" "}
          <span
            className="inline-block px-2 py-1 rounded-full text-[12px] font-bold mx-0.5"
            style={{ background: s.pillBg, color: s.pillText }}
          >
            {s.theme.name}
          </span>{" "}
          and your brain is{" "}
          <span
            className="inline-block px-2 py-1 rounded-full text-[12px] font-mono font-bold mx-0.5"
            style={{
              background: s.subtle,
              border: `1px solid ${s.border}`,
              color: s.text,
            }}
          >
            {modelLabel}
          </span>
          .
        </p>

        {/* Summary cards */}
        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-3 text-left">
          {/* Theme card */}
          <div
            className="rounded-[20px] p-4 flex gap-3 items-center"
            style={{
              background: s.card,
              border: `1.5px solid ${s.border}`,
              boxShadow: s.softShadow,
            }}
          >
            <div
              className="w-10 h-10 rounded-[12px] grid place-items-center font-bold text-[14px] shrink-0"
              style={{ background: s.accent, color: s.accentText }}
            >
              Aa
            </div>
            <div className="min-w-0">
              <div className="text-[11px] font-bold uppercase tracking-widest" style={{ color: s.textTertiary }}>
                THEME
              </div>
              <div className="text-[13px] font-bold" style={{ color: s.text }}>
                {s.theme.name} • {s.isDark ? "Dark" : "Light"}
              </div>
            </div>
          </div>

          {/* Model card */}
          <div
            className="rounded-[20px] p-4 flex gap-3 items-center"
            style={{
              background: s.card,
              border: `1.5px solid ${s.border}`,
              boxShadow: s.softShadow,
            }}
          >
            <div
              className="w-10 h-10 rounded-[12px] grid place-items-center font-black text-[13px] shrink-0"
              style={{ background: s.pillBg, color: s.pillText }}
            >
              {providerLetter}
            </div>
            <div className="min-w-0">
              <div className="text-[11px] font-bold uppercase tracking-widest" style={{ color: s.textTertiary }}>
                MODEL
              </div>
              <div className="text-[13px] font-bold truncate max-w-[140px]" style={{ color: s.text }}>
                {modelLabel}
              </div>
            </div>
          </div>

          {/* Secure card */}
          <div
            className="rounded-[20px] p-4 flex gap-3 items-center"
            style={{
              background: s.card,
              border: `1.5px solid ${s.border}`,
              boxShadow: s.softShadow,
            }}
          >
            <div
              className="w-10 h-10 rounded-[12px] grid place-items-center shrink-0"
              style={{ background: s.accent, color: s.accentText }}
            >
              <svg
                width={20}
                height={20}
                viewBox="0 0 24 24"
                fill="none"
                stroke={s.accentText}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect width={18} height={11} x={3} y={11} rx={2} ry={2} />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <div className="min-w-0">
              <div className="text-[11px] font-bold uppercase tracking-widest" style={{ color: s.textTertiary }}>
                SECURE
              </div>
              <div className="text-[13px] font-bold" style={{ color: s.text }}>
                Local • Encrypted
              </div>
            </div>
          </div>
        </div>

        {/* CTA buttons */}
        <div className="mt-8 flex flex-col md:flex-row items-center justify-center gap-3">
          {/* Primary button */}
          <button
            onClick={() => navigate("/")}
            className="group relative h-[58px] px-8 rounded-full font-bold text-[16px] flex items-center gap-3 border-[1.5px] overflow-hidden hover:scale-[1.02] active:scale-[0.98] transition-transform cursor-pointer animate-shine"
            style={{
              background: s.accent,
              borderColor: s.accent,
              color: s.accentText,
              boxShadow: s.bentoShadow,
            }}
          >
            Open ACUTE-CODE
            <span
              className="w-8 h-8 rounded-full grid place-items-center group-hover:translate-x-0.5 transition-transform font-bold z-10"
              style={{ background: s.accentText, color: s.accent }}
            >
              →
            </span>
          </button>
        </div>

        {/* Tip bar */}
        <div
          className="mt-8 inline-flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-medium"
          style={{
            background: s.card,
            border: `1.5px solid ${s.border}`,
            boxShadow: s.softShadow,
            color: s.text,
          }}
        >
          <span
            className="px-2 py-1 rounded-full text-[10px] font-bold"
            style={{ background: s.pillBg, color: s.pillText }}
          >
            TIP
          </span>
          {" "}You can change theme & brain anytime in{" "}
          <span
            className="px-1.5 py-0.5 rounded font-mono text-[11px]"
            style={{
              background: s.subtle,
              border: `1px solid ${s.border}`,
              color: s.text,
            }}
          >
            Settings
          </span>
        </div>

        {/* Restart link */}
        <div className="mt-12 flex justify-center pb-4">
          <button
            className="text-[12px] font-bold hover:underline underline-offset-4 cursor-pointer bg-transparent border-none p-0 transition-opacity"
            style={{ color: s.textTertiary }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.8"; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
            onClick={() => setStep(0)}
          >
            Restart onboarding • replay experience
          </button>
        </div>
      </div>
    </div>
  );
}
