import { useThemeStore } from "../../lib/theme-store";
import { COMING_SOON_THEME, getContrastText, THEMES, type ThemeColors } from "../../lib/themes";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useOnboardingStore } from "./onboarding-store";
import { ActionButton } from "./ActionButton";

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
function PaletteStrip({ theme, isDark }: { theme: ThemeColors; isDark: boolean }) {
  const colors = isDark ? theme.paletteDark : theme.paletteLight;
  return (
    <div className="flex gap-1 mt-3">
      {colors.map((c, i) => (
        <div
          key={i}
          className="flex-1 h-3 rounded-full first:rounded-l-[6px] last:rounded-r-[6px] border"
          style={{
            background: c,
            borderColor: isDark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.08)",
          }}
        />
      ))}
    </div>
  );
}

/* ── Mini preview (mode-aware) ───────────────────────── */
function MiniPreview({ theme, isDark, border }: { theme: ThemeColors; isDark: boolean; border: string }) {
  const previewBg = isDark ? theme.bgDark : theme.bgLight;
  const dotColor = isDark ? theme.dotDark || theme.dot : theme.dot;
  const barColor = isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.10)";
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
        <div className="mt-1.5 h-1.5 w-12 rounded-full" style={{ background: theme.accent }} />
        <div className="mt-1.5 h-1.5 w-8 rounded-full" style={{ background: barColor }} />
      </div>
      <div className="w-[34%] border-l p-2 flex flex-col gap-1.5" style={{ borderColor: border, background: sidebarBg }}>
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

/**
 * Step 1 — ported verbatim from the demo's components/onboarding/PickFlavorScreen.tsx
 * (owner round-3 verdict: previous two-half layout rejected; this anatomy is the normative one).
 * Theme choices come straight from the THEMES table; adding a theme there adds a card here
 * with zero code changes.
 *
 * Layout contract:
 * - Left column (~60%): heading · MODE toggle · rich theme-card grid (2 → 3 across) · Back/Continue
 *   directly beneath the grid (NOT pinned to the window bottom — owner directive).
 * - Right column (~40%, sticky): LIVE PREVIEW panel at natural height + themed tip bar below it.
 */
export function PickFlavorScreen() {
  const themeId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);
  const toggleMode = useThemeStore((s) => s.toggleMode);
  const setStep = useOnboardingStore((s) => s.setStep);
  const s = useThemeStyles();

  // R126-3g: the mode toggle speaks the segmented grammar — the ACTIVE
  // button's ink is the accentDeep knob's own pair (accentText), the
  // inactive one secondary (the old getContrastText(toggleActive) white/black
  // derivation retired with the knob).
  const lightBtnColor = !s.isDark ? s.accentText : s.textSecondary;
  const darkBtnColor = s.isDark ? s.accentText : s.textSecondary;

  return (
    <div className="mx-auto w-full max-w-[1280px] xl:max-w-[1480px] 2xl:max-w-[1640px] flex min-h-full flex-col justify-center pt-4 md:pt-8 short:pt-2 pb-8 md:pb-10">
      <div className="grid lg:grid-cols-[1.2fr_0.8fr] gap-6 md:gap-8 items-start">
        {/* LEFT COLUMN */}
        <div className="min-w-0">
          <h1
            className="text-[32px] md:text-[44px] font-black tracking-[-0.03em] leading-[0.95]"
            style={{ color: s.text }}
          >
            Pick your flavor.
          </h1>
          <p className="mt-2 text-[15px] font-medium" style={{ color: s.textSecondary }}>
            Make it yours. You can always change this later.
          </p>

          {/* MODE TOGGLE — R126-3g: the segmented grammar — a well track +
              the gliding accentDeep knob (TOKENS §10/§1d). */}
          <div
            className="mt-8 rounded-[22px] border p-1.5 md:p-2 border-clay-rim ac-clay-sm bg-card"
          >
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-[12px] font-bold uppercase tracking-widest" style={{ color: s.textTertiary }}>
                Mode
              </span>
              <span
                className="text-[11px] px-2 py-1 rounded-full border font-bold bg-badge-neutral text-badge-neutral-fg"
              >
                {s.isDark ? "DARK" : "LIGHT"} • LIVE
              </span>
            </div>
            <div
              className="mt-2 relative grid grid-cols-2 gap-1.5 p-1 rounded-[16px] ac-well"
            >
              {/* Sliding indicator — the accentDeep knob */}
              <div
                className="absolute top-1 bottom-1 w-[calc(50%-6px)] rounded-[12px] transition-all duration-300"
                style={{
                  left: s.isDark ? "calc(50% + 2px)" : "4px",
                  background: s.accentDeep,
                }}
              />
              <button
                onClick={toggleMode}
                className="relative z-10 h-11 rounded-[12px] font-bold text-[14px] transition-colors cursor-pointer bg-transparent border-none flex items-center justify-center gap-2"
                style={{ color: lightBtnColor }}
              >
                <SunIcon className="w-4 h-4" /> Light
              </button>
              <button
                onClick={toggleMode}
                className="relative z-10 h-11 rounded-[12px] font-bold text-[14px] transition-colors cursor-pointer bg-transparent border-none flex items-center justify-center gap-2"
                style={{ color: darkBtnColor }}
              >
                <MoonIcon className="w-4 h-4" /> Dark
              </button>
            </div>
          </div>

          {/* THEME CARDS - Palette Style — R126-3g: clay cards; the selected
              card carries the accentTint fill + the 2px accentDeep ring (the
              mobile "2px when selected" law); the CLAY card carries the
              Default badge (the §11 accent pair). */}
          <div className="mt-6 grid grid-cols-2 md:grid-cols-3 gap-3 md:gap-4">
            {THEMES.map((t) => {
              const selected = t.id === themeId;
              return (
                <button
                  key={t.id}
                  onClick={() => setTheme(t.id)}
                  className={`group relative rounded-[20px] border p-3 transition-all hover:translate-y-[-2px] text-left cursor-pointer ac-clay-sm${
                    selected ? "" : " border-clay-rim bg-card"
                  }`}
                  style={
                    selected
                      ? { background: s.accentTint, border: `2px solid ${s.accentDeep}` }
                      : undefined
                  }
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <div
                        className="w-8 h-8 shrink-0 rounded-full border grid place-items-center text-[13px] font-black"
                        style={{
                          background: t.accent,
                          borderColor: s.clayRim,
                          color: getContrastText(t.accent),
                        }}
                      >
                        Aa
                      </div>
                      <span className="text-[13px] font-bold tracking-tight truncate" style={{ color: s.text }}>
                        {t.name}
                      </span>
                      {t.id === "clay" && (
                        <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-badge-accent text-badge-accent-fg">
                          Default
                        </span>
                      )}
                    </div>
                    {selected && (
                      <div
                        className="w-6 h-6 shrink-0 rounded-full grid place-items-center text-[11px]"
                        style={{ background: s.accentDeep, color: s.accentText }}
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
              className="relative rounded-[20px] border border-dashed p-3 opacity-70 cursor-not-allowed border-clay-rim bg-card"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <div
                    className="w-8 h-8 shrink-0 rounded-full border grid place-items-center text-[13px] font-black"
                    style={{
                      background: s.subtle,
                      borderColor: s.clayRim,
                      color: s.textTertiary,
                    }}
                  >
                    Aa
                  </div>
                  <span className="text-[13px] font-bold tracking-tight truncate" style={{ color: s.textTertiary }}>
                    New themes coming soon
                  </span>
                </div>
              </div>
              <MiniPreview theme={COMING_SOON_THEME} isDark={false} border={s.border} />
            </div>
          </div>

          {/* BUTTONS — flow directly under the grid inside the left column
              (owner directive: never glued to the window bottom edge) */}
          <div className="mt-8 flex items-center justify-between gap-3">
            <ActionButton variant="secondary" onClick={() => setStep(0)}>
              ← Back
            </ActionButton>
            <ActionButton variant="primary" onClick={() => setStep(2)} hint="↵">
              Continue →
            </ActionButton>
          </div>
        </div>

        {/* RIGHT COLUMN — sticky live preview */}
        <div className="min-w-0 lg:sticky lg:top-8">
          {/* LIVE PREVIEW — R126-3g: clay card materials (rim + .ac-clay);
              the panel still paints the theme's own bg — it IS the preview. */}
          <div
            className="rounded-[24px] border p-4 md:p-5 border-clay-rim ac-clay"
            style={{ background: s.bg }}
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold tracking-widest" style={{ color: s.textTertiary }}>
                LIVE PREVIEW
              </span>
              <span
                className="px-2 py-1 rounded-full text-[10px] font-bold bg-badge-success text-badge-success-fg"
              >
                ● ACTIVE
              </span>
            </div>

            {/* Code window — R126-3g: the recessed mono block body + the
                surfaceHeader title bar; the traffic lights stay (the
                documented theatrical prop). */}
            <div
              className="mt-4 rounded-[18px] border overflow-hidden ac-mono-block"
              style={{ borderColor: s.monoBorder }}
            >
              {/* Title bar */}
              <div
                className="h-9 flex items-center px-3 gap-2 border-b"
                style={{
                  background: s.surfaceHeader,
                  borderColor: s.border,
                }}
              >
                <div className="w-3 h-3 rounded-full" style={{ background: "#FF5F56" }} />
                <div className="w-3 h-3 rounded-full" style={{ background: "#FFBD2E" }} />
                <div className="w-3 h-3 rounded-full" style={{ background: "#28C840" }} />
                <span className="ml-2 text-[11px] font-mono" style={{ color: s.textTertiary }}>
                  preview.tsx
                </span>
              </div>

              {/* Code body */}
              <div
                className="p-4 font-mono text-[12px] leading-[1.6]"
                style={{ color: s.monoText }}
              >
                <div>
                  <span style={{ opacity: 0.4 }}>function </span>
                  <span style={{ color: s.accentDeep }}>acute</span>
                  {"() {"}
                </div>
                <div>
                  {"  "}return{" "}
                  <span style={{ color: s.accentDeep }}>
                    &apos;{s.theme.name} ready&apos;
                  </span>
                </div>
                <div>{"}"}</div>
                <div>
                  <span style={{ opacity: 0.3 }}>
                    {"// theme: "}{s.theme.id} • mode: {s.isDark ? "dark" : "light"}
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

            {/* Stats row — Contrast & Vibe inside the preview panel:
                recessed wells (TOKENS §10). */}
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="ac-well rounded-[14px] p-3">
                <div className="text-[11px] font-bold uppercase tracking-widest" style={{ color: s.textTertiary }}>
                  Contrast
                </div>
                <div className="mt-1 text-[13px] font-bold" style={{ color: s.text }}>AAA • 12.4:1</div>
              </div>
              <div className="ac-well rounded-[14px] p-3">
                <div className="text-[11px] font-bold uppercase tracking-widest" style={{ color: s.textTertiary }}>
                  Vibe
                </div>
                <div className="mt-1 text-[13px] font-bold" style={{ color: s.text }}>Playful • Bento</div>
              </div>
            </div>
          </div>

          {/* TIP CARD - themed, below the preview panel — R126-3g: the
              accentDeep fill + accentText ink (the §11 accent badge pair). */}
          <div
            className="mt-3 rounded-[16px] px-4 py-3 flex items-center gap-2 rotate-[-0.6deg] ac-clay-sm"
            style={{
              background: s.accentDeep,
              color: s.accentText,
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
    </div>
  );
}
