'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useOnboardingStore } from '@/lib/onboarding-store'
import { useThemeStyles } from '@/lib/use-theme-styles'

const STEP_CARDS = [
  { num: '01', title: 'Pick flavor', desc: 'Choose theme & vibe', icon: '◑', color: '#D6FF57', rot: '-1deg' },
  { num: '02', title: 'Plug brain', desc: 'Connect your model', icon: '◒', color: '#A5B4FF', rot: '1deg' },
  { num: '03', title: 'Ship code', desc: 'Start building instantly', icon: 'rocket', color: '#FFB88A', rot: '-0.5deg' },
] as const

const CODE_LINES = `acute> init --theme nova --brain gpt-4o
✓ workspace ready
✓ theme synced
✓ brain connected
→ ready to ship_`

export default function WelcomeScreen() {
  const { setStep } = useOnboardingStore()
  const s = useThemeStyles()

  const [typed, setTyped] = useState('')
  const idxRef = useRef(0)

  useEffect(() => {
    idxRef.current = 0
    const iv = setInterval(() => {
      idxRef.current++
      setTyped(CODE_LINES.slice(0, idxRef.current))
      if (idxRef.current >= CODE_LINES.length) clearInterval(iv)
    }, 22)
    return () => {
      clearInterval(iv)
      setTyped('')
    }
  }, [])

  const handleGetStarted = useCallback(() => {
    setStep(1)
  }, [setStep])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter') handleGetStarted()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleGetStarted])

  const codeBg = s.isDark ? '#141418' : '#FAFAFA'
  const codeText = s.isDark ? 'rgba(255,255,255,0.9)' : '#333333'
  const codeTitleBar = s.isDark ? '#1E1E22' : '#F0F0F0'

  return (
    <div className="mt-10 md:mt-16 grid lg:grid-cols-[0.85fr_1.15fr] gap-6 md:gap-8 items-start pb-12">
      {/* LEFT COLUMN */}
      <div className="space-y-5">
        {/* Step Cards Grid */}
        <div className="grid gap-3">
          {STEP_CARDS.map((card) => (
            <div
              key={card.num}
              className="group relative rounded-[22px] border-[1.5px] p-4 md:p-5 flex items-center gap-4 transition-all hover:translate-y-[-2px] hover:rotate-[0.3deg]"
              style={{
                background: s.card,
                borderColor: s.borderStrong,
                boxShadow: s.softShadow,
                transform: `rotate(${card.rot})`,
              }}
            >
              <div
                className="w-12 h-12 rounded-[14px] border-[1.5px] grid place-items-center text-[18px] font-black shrink-0"
                style={{ backgroundColor: card.color, borderColor: s.borderStrong }}
              >
                {card.icon === 'rocket' ? (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={s.isDark ? '#111' : 'black'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
                className="text-[11px] font-black px-1.5 py-0.5 rounded-full"
                style={{ background: s.pillBg, color: s.pillText }}
              >
                {card.num}
              </span>
              <div className="flex-1">
                <div className="font-bold tracking-tight text-[15px]" style={{ color: s.text }}>{card.title}</div>
                <div className="text-[13px] font-medium" style={{ color: s.textSecondary }}>{card.desc}</div>
              </div>
              <div
                className="w-7 h-7 rounded-full border grid place-items-center text-[12px]"
                style={{ borderColor: s.border }}
              >
                ↗
              </div>
            </div>
          ))}
        </div>

        {/* Code Block */}
        <div
          className="rounded-[24px] border-[1.5px] overflow-hidden relative"
          style={{ background: codeBg, borderColor: s.borderStrong, boxShadow: s.bentoShadow }}
        >
          <div className="flex items-center justify-between p-4 pb-0">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-[#FF5F56]" />
              <div className="w-3 h-3 rounded-full bg-[#FFBD2E]" />
              <div className="w-3 h-3 rounded-full bg-[#28C840]" />
            </div>
            <div className="flex items-center gap-2">
              <span
                className="px-2.5 py-1 rounded-full border text-[11px] font-bold"
                style={{ background: s.subtle, borderColor: s.border }}
              >
                acute.config.ts
              </span>
              <span
                className="px-2 py-1 rounded-full text-[10px] font-bold border"
                style={{
                  background: s.accent,
                  color: s.accentText,
                  borderColor: s.accent,
                }}
              >
                LIVE
              </span>
              <span
                className="px-2 py-1 rounded-full border text-[10px] font-bold"
                style={{ background: s.subtle, borderColor: s.border }}
              >
                42ms
              </span>
            </div>
          </div>
          <pre
            className="p-4 pt-3 font-mono text-[12px] md:text-[13px] leading-[1.6] whitespace-pre-wrap min-h-[120px]"
            style={{ color: codeText }}
          >
            {typed}
          </pre>
          <div
            className="absolute -right-6 -bottom-6 w-24 h-24 rounded-full blur-[12px] pointer-events-none"
            style={{ backgroundColor: s.accent, opacity: 0.15 }}
          />
        </div>

        {/* Tip Bar */}
        <div
          className="rounded-[18px] border-[1.5px] px-4 py-3 flex items-center gap-3 text-[12px] font-medium"
          style={{
            background: s.card,
            borderColor: s.border,
            boxShadow: s.softShadow,
            color: s.text,
          }}
        >
          <div
            className="w-8 h-8 rounded-full grid place-items-center text-[12px]"
            style={{ background: s.pillBg, color: s.pillText }}
          >
            ✦
          </div>
          <span>Tip: Your keys never leave your machine. 100% local.</span>
        </div>
      </div>

      {/* RIGHT COLUMN */}
      <div className="relative">
        {/* Badge */}
        <span
          className="inline-flex items-center gap-2 px-3 py-1 rounded-full border-[1.5px] rotate-[-1.5deg] text-[12px] font-bold tracking-wide"
          style={{
            background: s.accent,
            color: s.accentText,
            borderColor: s.accent,
            boxShadow: s.bentoShadowSm,
          }}
        >
          <span className="w-2 h-2 rounded-full animate-pulse-dot" style={{ background: s.accentText }} />
          NEW ONBOARDING • UNDER 60 SEC
        </span>

        {/* Heading */}
        <h1 className="mt-8">
          <span
            className="block text-[14px] md:text-[15px] font-bold tracking-[0.18em] mb-3"
            style={{ color: s.textSecondary }}
          >
            WELCOME TO
          </span>
          <span className="block text-[56px] md:text-[86px] font-black leading-none" style={{ color: s.text }}>
            ACUTE
          </span>
          <span
            className="inline-block px-3 md:px-4 -ml-1 md:-ml-2 rounded-[18px] md:rounded-[24px] text-[56px] md:text-[86px] font-black leading-none border-[2.5px] rotate-[-1deg]"
            style={{
              background: s.accent,
              color: s.isDark ? '#111111' : '#FFFFFF',
              borderColor: s.borderStrong,
              boxShadow: s.bentoShadow,
            }}
          >
            AGENT.
          </span>
        </h1>

        {/* Description */}
        <p
          className="mt-6 max-w-[520px] text-[16px] md:text-[18px] leading-[1.4] font-medium"
          style={{ color: s.text, opacity: 0.8 }}
        >
          {"Let's get you set up in under 1 minute. We'll configure your first workspace, theme, and first brain."}
          <span
            className="inline-block ml-2 px-2 py-0.5 rounded-full text-[11px] font-bold rotate-[1deg]"
            style={{ background: s.pillBg, color: s.pillText }}
          >
            fun &amp; fast
          </span>
        </p>

        {/* Get Started Button */}
        <div className="mt-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <kbd
              className="px-2 py-1 rounded-md border text-[11px] font-bold"
              style={{
                background: s.card,
                borderColor: s.border,
                color: s.text,
              }}
            >
              Enter
            </kbd>
            <span className="text-[12px] font-medium" style={{ color: s.textTertiary }}>or press to continue</span>
          </div>
          <button
            onClick={handleGetStarted}
            className="group h-12 px-8 rounded-full text-[16px] font-bold tracking-[-0.01em] flex items-center gap-3 border-[1.5px] transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer shrink-0"
            style={{
              background: s.accent,
              color: s.accentText,
              borderColor: s.accent,
              boxShadow: s.bentoShadow,
            }}
          >
            Get Started
            <span
              className="w-8 h-8 rounded-full grid place-items-center group-hover:translate-x-1 transition-transform"
              style={{ background: s.accentText, color: s.accent }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </span>
          </button>
        </div>

        {/* Stats */}
        <div className="mt-10 grid grid-cols-3 gap-3 max-w-[520px]">
          {[
            { value: '12k+', label: 'devs' },
            { value: '4.9/5', label: 'rating' },
            { value: '<1m', label: 'setup' },
          ].map((stat) => (
            <div
              key={stat.label}
              className="rounded-[18px] border-[1.5px] p-3"
              style={{
                background: s.card,
                borderColor: s.border,
                boxShadow: s.softShadow,
              }}
            >
              <div className="text-[18px] font-black tracking-tighter" style={{ color: s.text }}>{stat.value}</div>
              <div className="text-[11px] font-bold uppercase tracking-widest" style={{ color: s.textTertiary }}>{stat.label}</div>
            </div>
          ))}
        </div>

        {/* Floating Decorations */}
        <div
          className="absolute -right-6 top-[38%] hidden lg:block w-16 h-16 rounded-[16px] border-[1.5px] grid place-items-center text-[22px] animate-float"
          style={{
            backgroundColor: s.accent,
            borderColor: s.borderStrong,
            boxShadow: s.softShadow,
            transform: 'rotate(12deg)',
          }}
        >
          ✦
        </div>
        <div
          className="absolute left-[58%] -bottom-10 hidden lg:flex w-12 h-12 rounded-full border-[1.5px] items-center justify-center text-[18px] rotate-[-8deg] animate-float2"
          style={{
            background: s.card,
            borderColor: s.borderStrong,
            boxShadow: s.softShadow,
          }}
        >
          ◐
        </div>
      </div>
    </div>
  )
}
