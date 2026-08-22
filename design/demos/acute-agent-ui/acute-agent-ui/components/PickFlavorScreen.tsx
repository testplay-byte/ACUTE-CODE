'use client';

import { useOnboardingStore } from '@/lib/onboarding-store';
import { THEMES } from '@/lib/onboarding-types';
import { useThemeStyles } from '@/lib/use-theme-styles';
import { getContrastText } from '@/lib/color-utils';

/* ── SVG Icons ────────────────────────────────────────── */
function SunIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />
    </svg>
  );
}

/* ── Palette strip showing theme colors (mode-aware) ─── */
function PaletteStrip({ theme, isDark }: { theme: typeof THEMES[0]; isDark: boolean }) {
  const colors = isDark ? theme.paletteDark : theme.paletteLight;
  return (
    <div className="flex gap-1 mt-3">
      {colors.map((c, i) => (
        <div
          key={i}
          className="flex-1 h-3 rounded-full first:rounded-l-[6px] last:rounded-r-[6px] border"
          style={{
            background: c,
            borderColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)',
          }}
        />
      ))}
    </div>
  );
}

/* ── Mini preview (mode-aware) ───────────────────────── */
function MiniPreview({ theme, isDark, border }: { theme: typeof THEMES[0]; isDark: boolean; border: string }) {
  const previewBg = isDark ? theme.bgDark : theme.bgLight;
  const previewCard = isDark ? theme.cardDark : theme.cardLight;
  const dotColor = isDark ? (theme.dotDark || theme.dot) : theme.dot;
  const barColor = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)';
  const sidebarBg = isDark ? theme.bgDark : theme.sidebarBg;

  return (
    <div
      className="mt-3 h-[54px] rounded-[14px] border overflow-hidden relative flex"
      style={{
        borderColor: border,
        background: previewBg,
      }}
    >
      <div className="flex-1 p-2">
        <div className="flex gap-1">
          <div className="w-2 h-2 rounded-full" style={{ background: barColor }} />
          <div className="w-2 h-2 rounded-full" style={{ background: barColor }} />
          <div className="w-2 h-2 rounded-full" style={{ background: barColor }} />
        </div>
        <div
          className="mt-1.5 h-1.5 w-12 rounded-full"
          style={{ background: theme.accent }}
        />\n        <div className="mt-1.5 h-1.5 w-8 rounded-full" style={{ background: barColor }} />
      </div>
      <div className="w-[34%] border-l p-2 flex flex-col gap-1.5" style={{ borderColor: border }}>
        <div className="h-1.5 rounded-full w-full" style={{ background: barColor }} />
        <div className="h-1.5 rounded-full w-3/4" style={{ background: barColor }} />
        <div
          className="mt-auto w-6 h-6 rounded-full mx-auto"
          style={{ background: dotColor }}
        />
      </div>
    </div>
  );
}

export default function PickFlavorScreen() {
  const { themeId, setTheme, toggleDark, setStep } = useOnboardingStore();
  const s = useThemeStyles();
  const theme = s.theme;

  // Active toggle text color: dark when active, secondary when inactive
  const lightBtnColor = !s.isDark ? (getContrastText(s.toggleActive)) : s.textSecondary;
  const darkBtnColor = s.isDark ? (getContrastText(s.toggleActive)) : s.textSecondary;

  return (
    <div className="mt-8 md:mt-10 grid lg:grid-cols-[1.2fr_0.8fr] gap-6 md:gap-8 items-start pb-12">
      {/* LEFT COLUMN */}
      <div>
        <h1 className="text-[32px] md:text-[44px] font-black tracking-[-0.03em] leading-[0.95]" style={{ color: s.text }}>
          Pick your flavor.
        </h1>
        <p className="mt-2 text-[15px] font-medium" style={{ color: s.textSecondary }}>
          Make it yours. You can always change this later.
        </p>

        {/* MODE TOGGLE */}
        <div
          className="mt-8 rounded-[22px] border-[1.5px] p-1.5 md:p-2"
          style={{
            background: s.card,
            borderColor: s.border,
            boxShadow: s.softShadow,
          }}
        >
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-[12px] font-bold uppercase tracking-widest" style={{ color: s.textTertiary }}>
              Mode
            </span>
            <span
              className="text-[11px] px-2 py-1 rounded-full border font-bold"
              style={{
                background: s.subtle,
                borderColor: s.border,
                color: s.textSecondary,
              }}
            >
              {s.isDark ? 'DARK' : 'LIGHT'} • LIVE
            </span>
          </div>
          <div
            className="mt-2 relative grid grid-cols-2 gap-1.5 p-1 rounded-[16px]"
            style={{
              background: s.toggleTrack,
              border: `1px solid ${s.borderSubtle}`,
            }}
          >
            {/* Sliding indicator */}
            <div
              className="absolute top-1 bottom-1 w-[calc(50%-6px)] rounded-[12px] transition-all duration-300"
              style={{
                left: s.isDark ? 'calc(50% + 2px)' : '4px',
                background: s.toggleActive,
              }}
            />
            <button
              onClick={toggleDark}
              className="relative z-10 h-11 rounded-[12px] font-bold text-[14px] transition-colors cursor-pointer bg-transparent border-none flex items-center justify-center gap-2"
              style={{ color: lightBtnColor }}
            >
              <SunIcon className="w-4 h-4" /> Light
            </button>
            <button
              onClick={toggleDark}
              className="relative z-10 h-11 rounded-[12px] font-bold text-[14px] transition-colors cursor-pointer bg-transparent border-none flex items-center justify-center gap-2"
              style={{ color: darkBtnColor }}
            >
              <MoonIcon className="w-4 h-4" /> Dark
            </button>
          </div>
        </div>

        {/* THEME CARDS - Palette Style */}
        <div className="mt-6 grid grid-cols-2 md:grid-cols-3 gap-3 md:gap-4">
          {THEMES.map((t) => {
            const selected = t.id === themeId;
            return (
              <button
                key={t.id}
                onClick={() => setTheme(t.id)}
                className="group relative rounded-[20px] border-[1.5px] p-3 transition-all hover:translate-y-[-2px] text-left"
                style={{
                  background: s.card,
                  borderColor: selected ? s.borderStrong : s.border,
                  boxShadow: selected ? s.bentoShadowSm : s.softShadow,
                }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div
                      className="w-8 h-8 rounded-full border grid place-items-center text-[13px] font-black"
                      style={{
                        background: t.accent,
                        borderColor: s.border,
                        color: getContrastText(t.accent),
                      }}
                    >
                      Aa
                    </div>
                    <span className="text-[13px] font-bold tracking-tight" style={{ color: s.text }}>
                      {t.name}
                    </span>
                  </div>
                  {selected && (
                    <div
                      className="w-6 h-6 rounded-full grid place-items-center text-[11px]"
                      style={{ background: s.accent, color: s.accentText }}
                    >
                      ✓
                    </div>
                  )}
                </div>

                {/* Palette strip (mode-aware) */}
                <PaletteStrip theme={t} isDark={s.isDark} />

                {/* Mini preview (mode-aware) */}
                <MiniPreview theme={t} isDark={s.isDark} border={s.border} />
              </button>
            );
          })}

          {/* COMING SOON CARD */}
          <div
            className="relative rounded-[20px] border-[1.5px] border-dashed p-3 opacity-70 cursor-not-allowed"
            style={{
              background: s.card,
              borderColor: s.border,
            }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div
                  className="w-8 h-8 rounded-full border grid place-items-center text-[13px] font-black"
                  style={{
                    background: s.subtle,
                    borderColor: s.border,
                    color: s.textTertiary,
                  }}
                >
                  Aa
                </div>
                <span className="text-[13px] font-bold tracking-tight" style={{ color: s.textTertiary }}>
                  New themes coming soon
                </span>
              </div>
            </div>
            <div
              className="mt-3 h-[54px] rounded-[14px] border overflow-hidden relative flex"
              style={{ borderColor: s.border, background: s.subtle }}
            >
              <div className="flex-1 p-2">
                <div className="flex gap-1">
                  <div className="w-2 h-2 rounded-full" style={{ background: s.border }} />
                  <div className="w-2 h-2 rounded-full" style={{ background: s.border }} />
                  <div className="w-2 h-2 rounded-full" style={{ background: s.border }} />
                </div>
                <div className="mt-1.5 h-1.5 w-12 rounded-full" style={{ background: s.border }} />
                <div className="mt-1.5 h-1.5 w-8 rounded-full" style={{ background: s.border }} />
              </div>
              <div className="w-[34%] border-l p-2 flex flex-col gap-1.5" style={{ borderColor: s.border }}>
                <div className="h-1.5 rounded-full w-full" style={{ background: s.border }} />
                <div className="h-1.5 rounded-full w-3/4" style={{ background: s.border }} />
                <div className="mt-auto w-6 h-6 rounded-full mx-auto" style={{ background: s.border }} />
              </div>
            </div>
          </div>
        </div>

        {/* BUTTONS */}
        <div className="mt-8 flex items-center justify-between gap-3">
          <button
            onClick={() => setStep(0)}
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
            onClick={() => setStep(2)}
            className="h-12 px-7 rounded-full font-bold text-[14px] flex items-center gap-2 hover:scale-[1.02] active:scale-[0.98] transition-transform cursor-pointer border-[1.5px]"
            style={{
              background: s.accent,
              color: s.accentText,
              borderColor: s.accent,
              boxShadow: s.bentoShadow,
            }}
          >
            Continue → <span className="opacity-60 text-[11px]">↵</span>
          </button>
        </div>
      </div>

      {/* RIGHT COLUMN */}
      <div className="lg:sticky lg:top-8">
        {/* LIVE PREVIEW */}
        <div
          className="rounded-[28px] border-[1.5px] p-4 md:p-5"
          style={{
            background: s.bg,
            borderColor: s.borderStrong,
            boxShadow: s.bentoShadow,
          }}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold tracking-widest" style={{ color: s.textTertiary }}>
              LIVE PREVIEW
            </span>
            <span
              className="px-2 py-1 rounded-full text-[10px] font-bold border"
              style={{
                background: s.accent,
                color: s.accentText,
                borderColor: s.accent,
              }}
            >
              ● ACTIVE
            </span>
          </div>

          {/* Code window */}
          <div
            className="mt-4 rounded-[18px] border-[1.5px] overflow-hidden"
            style={{
              background: s.isDark ? '#141418' : '#FAFAFA',
              borderColor: s.borderStrong,
              boxShadow: s.isDark ? '4px 4px 0px 0px rgba(255,255,255,0.08)' : '4px 4px 0px 0px black',
            }}
          >
            {/* Title bar */}
            <div
              className="h-9 flex items-center px-3 gap-2 border-b"
              style={{
                background: s.isDark ? '#1E1E22' : '#F0F0F0',
                borderColor: s.border,
              }}
            >
              <div className="w-3 h-3 rounded-full" style={{ background: '#FF5F56' }} />
              <div className="w-3 h-3 rounded-full" style={{ background: '#FFBD2E' }} />
              <div className="w-3 h-3 rounded-full" style={{ background: '#28C840' }} />
              <span className="ml-2 text-[11px] font-mono" style={{ color: s.textTertiary }}>
                preview.tsx
              </span>
            </div>

            {/* Code body */}
            <div
              className="p-4 font-mono text-[12px] leading-[1.6]"
              style={{ color: s.isDark ? 'rgba(255,255,255,0.9)' : '#333333' }}
            >
              <div>
                <span style={{ opacity: 0.4 }}>function </span>
                <span style={{ color: s.accent }}>acute</span>
                {'() {'}
              </div>
              <div>
                {'  '}return{' '}
                <span style={{ color: s.accent }}>
                  &apos;{theme.name} ready&apos;
                </span>
              </div>
              <div>{'}'}</div>
              <div>
                <span style={{ opacity: 0.3 }}>
                  {'// theme: '}{theme.id} • mode: {s.isDark ? 'dark' : 'light'}
                </span>
              </div>
              <div className="mt-2">
                <span
                  className="inline-flex px-2 py-1 rounded-full text-[10px] font-bold"
                  style={{
                    background: s.accent,
                    color: s.accentText,
                  }}
                >
                  {s.accent}
                </span>
              </div>
            </div>
          </div>

          {/* Stats row */}
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div
              className="rounded-[14px] border p-3"
              style={{
                background: s.subtle,
                borderColor: s.border,
              }}
            >
              <div className="text-[11px] font-bold uppercase tracking-widest" style={{ color: s.textTertiary }}>
                Contrast
              </div>
              <div className="mt-1 text-[13px] font-bold" style={{ color: s.text }}>AAA • 12.4:1</div>
            </div>
            <div
              className="rounded-[14px] border p-3"
              style={{
                background: s.subtle,
                borderColor: s.border,
              }}
            >
              <div className="text-[11px] font-bold uppercase tracking-widest" style={{ color: s.textTertiary }}>
                Vibe
              </div>
              <div className="mt-1 text-[13px] font-bold" style={{ color: s.text }}>Playful • Bento</div>
            </div>
          </div>
        </div>

        {/* TIP CARD - themed */}
        <div
          className="mt-3 rounded-[16px] border-[1.5px] px-4 py-3 flex items-center gap-2 rotate-[-0.6deg]"
          style={{
            background: s.accent,
            color: s.accentText,
            borderColor: s.borderStrong,
            boxShadow: s.bentoShadowSm,
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={s.accentText} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18h6M10 22h4M12 2v1M4.93 4.93l.7.7M2 12h1M20 12h1M18.36 4.93l-.7.7" />
            <path d="M12 6a6 6 0 0 0-3.6 10.8V18h7.2v-1.2A6 6 0 0 0 12 6z" />
          </svg>
          <span className="text-[12px] font-bold">
            Tip: Midnight Lab loves dark mode.
          </span>
        </div>
      </div>
    </div>
  );
}
