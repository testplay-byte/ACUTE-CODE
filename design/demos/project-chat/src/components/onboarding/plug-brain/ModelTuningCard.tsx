'use client';

import { useCallback } from 'react';
import { useOnboardingStore } from '@/lib/onboarding-store';
import { REASONING_LEVELS } from '@/lib/onboarding-types';
import { useThemeStyles } from '@/lib/use-theme-styles';

const CONTEXT_OPTIONS = [
  { value: 1000, label: '1K' },
  { value: 10000, label: '10K' },
  { value: 100000, label: '100K' },
  { value: 500000, label: '500K' },
  { value: 1000000, label: '1M' },
] as const;

export default function ModelTuningCard() {
  const s = useThemeStyles();
  const store = useOnboardingStore();

  const handleContextSelect = useCallback(
    (val: number) => {
      store.setContextWindow(val);
      store.setContextManual(true);
    },
    [store],
  );

  const handleTempSlider = useCallback(
    (val: string) => store.setTemperature(parseFloat(val)),
    [store],
  );

  const activeContext = store.contextWindow;
  const estimatePages = Math.round(activeContext / 750);

  return (
    <div
      className="rounded-[24px] border-[1.5px] p-4 md:p-5"
      style={{
        background: s.card,
        borderColor: s.borderStrong,
        boxShadow: s.softShadow,
      }}
    >
      <div className="flex items-center justify-between">
        <span className="font-bold tracking-tight" style={{ color: s.text }}>Model Tuning</span>
        <span
          className="text-[10px] font-bold px-2 py-1 rounded-full"
          style={{ background: s.pillBg, color: s.pillText }}
        >
          ADVANCED
        </span>
      </div>

      <div className="mt-5 grid gap-5">
        {/* 1. Context Window */}
        <div
          className="rounded-[16px] border p-3"
          style={{ background: s.subtle, borderColor: s.border }}
        >
          <div className="flex items-center justify-between mb-3">
            <span
              className="text-[11px] font-bold uppercase tracking-widest"
              style={{ color: s.textTertiary }}
            >
              Context window
            </span>
            {/* Themed auto/manual toggle */}
            <div className="flex items-center rounded-full p-0.5" style={{ background: s.subtle }}>
              <button
                type="button"
                className="px-2.5 py-1 rounded-full text-[10px] font-bold transition-colors cursor-pointer"
                style={{
                  background: !store.contextManual ? s.accent : 'transparent',
                  color: !store.contextManual ? s.accentText : s.textTertiary,
                }}
                onClick={() => store.setContextManual(false)}
              >
                AUTO
              </button>
              <button
                type="button"
                className="px-2.5 py-1 rounded-full text-[10px] font-bold transition-colors cursor-pointer"
                style={{
                  background: store.contextManual ? s.accent : 'transparent',
                  color: store.contextManual ? s.accentText : s.textTertiary,
                }}
                onClick={() => store.setContextManual(true)}
              >
                MANUAL
              </button>
            </div>
          </div>

          {/* Discrete context buttons */}
          <div className="flex items-center gap-2">
            {CONTEXT_OPTIONS.map((opt) => {
              const isActive = activeContext === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  className="flex-1 h-10 rounded-[12px] border-[1.5px] text-[12px] font-bold cursor-pointer transition-all"
                  style={{
                    background: isActive ? s.accent : s.card,
                    borderColor: isActive ? s.accent : s.border,
                    color: isActive ? s.accentText : s.text,
                    boxShadow: isActive ? 'none' : s.softShadow,
                  }}
                  onClick={() => handleContextSelect(opt.value)}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] font-mono font-bold" style={{ color: s.text }}>
              {String(activeContext)} tokens
            </span>
            <span className="text-[11px] font-medium" style={{ color: s.textTertiary }}>
              ~{estimatePages} pages
            </span>
          </div>
        </div>

        {/* 2. Max Output + Temperature (2-col) */}
        <div className="grid-cols-2 gap-3 grid">
          <div>
            <label
              className="block text-[11px] font-bold uppercase tracking-widest mb-1.5"
              style={{ color: s.textTertiary }}
            >
              Max output
            </label>
            <input
              type="number"
              className="w-full h-11 rounded-[12px] border-[1.5px] px-3 text-[13px] font-mono outline-none transition-colors"
              style={{
                background: s.inputBg,
                borderColor: s.inputBorder,
                color: s.text,
              }}
              onFocus={(e) => (e.target.style.borderColor = s.inputFocusBorder)}
              onBlur={(e) => (e.target.style.borderColor = s.inputBorder)}
              value={store.maxOutput}
              onChange={(e) => store.setMaxOutput(parseInt(e.target.value, 10) || 0)}
            />
          </div>
          <div>
            <label
              className="block text-[11px] font-bold uppercase tracking-widest mb-1.5"
              style={{ color: s.textTertiary }}
            >
              Temperature
            </label>
            <div
              className="h-11 rounded-[12px] border-[1.5px] px-3 flex items-center gap-2"
              style={{
                background: s.inputBg,
                borderColor: s.inputBorder,
              }}
            >
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={store.temperature}
                onChange={(e) => handleTempSlider(e.target.value)}
                className="flex-1"
                style={{
                  background: `linear-gradient(to right, ${s.accent} ${(store.temperature / 2) * 100}%, ${s.border} ${(store.temperature / 2) * 100}%)`,
                }}
              />
              <span
                className="px-2 py-1 rounded-full text-[11px] font-bold shrink-0"
                style={{ background: s.pillBg, color: s.pillText }}
              >
                {store.temperature.toFixed(1)}
              </span>
            </div>
          </div>
        </div>

        {/* 3. Input $/1M and Output $/1M (2-col) */}
        <div className="grid-cols-2 gap-3 grid">
          <div>
            <label
              className="block text-[11px] font-bold uppercase tracking-widest mb-1.5"
              style={{ color: s.textTertiary }}
            >
              Input $/1M tokens
            </label>
            <input
              type="number"
              step={0.01}
              className="w-full h-11 rounded-[12px] border-[1.5px] px-3 text-[13px] font-mono outline-none transition-colors"
              style={{
                background: s.inputBg,
                borderColor: s.inputBorder,
                color: s.text,
              }}
              onFocus={(e) => (e.target.style.borderColor = s.inputFocusBorder)}
              onBlur={(e) => (e.target.style.borderColor = s.inputBorder)}
              value={store.inputCost}
              onChange={(e) => store.setInputCost(parseFloat(e.target.value) || 0)}
            />
          </div>
          <div>
            <label
              className="block text-[11px] font-bold uppercase tracking-widest mb-1.5"
              style={{ color: s.textTertiary }}
            >
              Output $/1M tokens
            </label>
            <input
              type="number"
              step={0.01}
              className="w-full h-11 rounded-[12px] border-[1.5px] px-3 text-[13px] font-mono outline-none transition-colors"
              style={{
                background: s.inputBg,
                borderColor: s.inputBorder,
                color: s.text,
              }}
              onFocus={(e) => (e.target.style.borderColor = s.inputFocusBorder)}
              onBlur={(e) => (e.target.style.borderColor = s.inputBorder)}
              value={store.outputCost}
              onChange={(e) => store.setOutputCost(parseFloat(e.target.value) || 0)}
            />
          </div>
        </div>

        {/* 4. Reasoning Effort - themed with accent */}
        <div>
          <label
            className="block text-[11px] font-bold uppercase tracking-widest mb-2"
            style={{ color: s.textTertiary }}
          >
            Reasoning Effort
          </label>
          <div className="grid grid-cols-5 gap-1.5">
            {REASONING_LEVELS.map((level) => {
              const isActive = store.reasoning === level.id;
              return (
                <button
                  key={level.id}
                  type="button"
                  className="h-[48px] rounded-[14px] border-[1.5px] grid place-items-center gap-0.5 transition-all cursor-pointer"
                  style={{
                    borderColor: isActive ? s.accent : s.border,
                    background: isActive ? s.accent : s.card,
                    color: isActive ? s.accentText : s.text,
                    boxShadow: isActive ? 'none' : s.softShadow,
                  }}
                  onClick={() => store.setReasoning(level.id)}
                >
                  <span className="text-[14px]">{level.icon}</span>
                  <span className="text-[10px] font-bold leading-none">{level.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
