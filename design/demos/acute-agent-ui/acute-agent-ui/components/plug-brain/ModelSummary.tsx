'use client';

import { useMemo } from 'react';
import { useOnboardingStore } from '@/lib/onboarding-store';
import { PROVIDERS, REASONING_LEVELS, CONTEXT_LABELS } from '@/lib/onboarding-types';
import { useThemeStyles } from '@/lib/use-theme-styles';

function formatContext(val: number): string {
  if (CONTEXT_LABELS[val]) return CONTEXT_LABELS[val];
  return val >= 1_000_000
    ? `${(val / 1_000_000).toFixed(1)}M`
    : val >= 1_000
      ? `${(val / 1_000).toFixed(val % 1000 === 0 ? 0 : 1)}K`
      : String(val);
}

function formatCost(v: number): string {
  return v > 0 ? `$${v}` : 'Free';
}

function estimateCost(context: number, maxOut: number, inputCost: number, outputCost: number): string {
  const ctxCost = (context / 1_000_000) * inputCost;
  const outCost = (maxOut / 1_000_000) * outputCost;
  const total = ctxCost + outCost;
  return total < 0.001 ? '<$0.001' : `$${total.toFixed(4)}`;
}

export default function ModelSummary({ onBack, onSave }: { onBack: () => void; onSave: () => void }) {
  const s = useThemeStyles();
  const store = useOnboardingStore();

  const provider = useMemo(
    () => PROVIDERS.find((p) => p.id === store.providerId),
    [store.providerId],
  );

  const reasoningIndex = REASONING_LEVELS.findIndex((r) => r.id === store.reasoning);
  const canProceed = store.apiKey.length > 6 && store.modelId.length > 2;
  const estCost = estimateCost(store.contextWindow, store.maxOutput, store.inputCost, store.outputCost);

  return (
    <div className="grid gap-4">
      {/* --- MODEL SUMMARY CARD --- */}
      <div
        className="rounded-[24px] border-[1.5px] p-4"
        style={{
          background: s.card,
          borderColor: s.borderStrong,
          boxShadow: s.bentoShadow,
        }}
      >
        <div className="flex items-center justify-between">
          <span className="font-black tracking-tight" style={{ color: s.text }}>Model Summary</span>
          <span
            className="px-2 py-1 rounded-full border text-[10px] font-bold"
            style={{
              backgroundColor: s.accent,
              color: s.accentText,
              borderColor: s.accent,
            }}
          >
            LIVE
          </span>
        </div>

        {/* Tags */}
        <div className="mt-4 flex flex-wrap gap-2">
          {provider && (
            <span
              className="px-3 py-1.5 rounded-full text-[11px] font-bold flex items-center gap-1.5"
              style={{ background: s.pillBg, color: s.pillText }}
            >
              <span
                className="w-5 h-5 rounded-full grid place-items-center text-[10px] font-bold"
                style={{ background: s.accent, color: s.accentText }}
              >
                {provider.letter}
              </span>
              {provider.name}
            </span>
          )}
          {store.modelId && (
            <span
              className="px-3 py-1.5 rounded-full border text-[11px] font-mono font-bold truncate max-w-[160px]"
              style={{
                background: s.card,
                borderColor: s.border,
                color: s.text,
              }}
            >
              {store.modelId}
            </span>
          )}
        </div>

        {/* Stats grid */}
        <div className="mt-4 grid-cols-2 gap-2 grid">
          {[
            { label: 'Context', value: formatContext(store.contextWindow) },
            { label: 'Max Out', value: formatContext(store.maxOutput) },
            { label: 'Input $', value: formatCost(store.inputCost) },
            { label: 'Output $', value: formatCost(store.outputCost) },
          ].map((item) => (
            <div
              key={item.label}
              className="rounded-[14px] border p-3"
              style={{ background: s.subtle, borderColor: s.border }}
            >
              <div className="text-[10px] font-bold uppercase tracking-widest" style={{ color: s.textTertiary }}>
                {item.label}
              </div>
              <div className="mt-1 font-black text-[14px]" style={{ color: s.text }}>
                {item.value}
              </div>
            </div>
          ))}
        </div>

        {/* Reasoning row */}
        <div
          className="mt-4 rounded-[14px] border p-3 flex items-center justify-between"
          style={{ borderColor: s.border }}
        >
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest" style={{ color: s.textTertiary }}>
              Reasoning
            </div>
            <div className="mt-0.5 text-[13px] font-bold" style={{ color: s.text }}>
              {REASONING_LEVELS[reasoningIndex >= 0 ? reasoningIndex : 0]?.label ?? 'None'}
              <span className="font-medium ml-1" style={{ color: s.textSecondary }}>
                — {REASONING_LEVELS[reasoningIndex >= 0 ? reasoningIndex : 0]?.desc ?? ''}
              </span>
            </div>
          </div>
          <div className="flex items-end gap-1">
            {REASONING_LEVELS.map((_, i) => (
              <span
                key={i}
                className="w-1.5 h-5 rounded-full"
                style={{
                  background: i <= reasoningIndex ? s.toggleActive : s.border,
                }}
              />
            ))}
          </div>
        </div>

        {/* Cost card (THEMED) */}
        <div
          className="mt-4 rounded-[14px] border-[1.5px] p-3 flex items-center justify-between"
          style={{
            backgroundColor: s.accent,
            borderColor: s.accent,
          }}
        >
          <div>
            <div
              className="text-[10px] font-bold uppercase tracking-widest"
              style={{ color: s.accentText, opacity: 0.7 }}
            >
              Est. cost / task
            </div>
            <div className="mt-0.5 font-black text-[16px]" style={{ color: s.accentText }}>
              {estCost}
            </div>
          </div>
          <div
            className="w-10 h-10 rounded-full grid place-items-center text-[12px]"
            style={{ background: s.accentText, color: s.accent }}
          >
            ✦
          </div>
        </div>

        {/* Security note */}
        <div
          className="mt-3 flex items-center gap-2 text-[11px] font-bold px-3 py-2 rounded-full border"
          style={{
            background: s.subtle,
            borderColor: s.border,
            color: s.text,
          }}
        >
          <span
            className="w-5 h-5 rounded-full bg-[#27C93F] grid place-items-center text-[10px] text-black"
          >
            ✓
          </span>
          Secure &bull; Encrypted &bull; Local
        </div>
      </div>

      {/* --- READY TO SHIP STICKER (THEMED) --- */}
      <div
        className="rounded-[18px] border-[1.5px] px-4 py-3 rotate-[1deg] flex items-center justify-between"
        style={{
          backgroundColor: s.accent,
          borderColor: s.accent,
          color: s.accentText,
          boxShadow: s.bentoShadowSm,
        }}
      >
        <span className="font-black tracking-tight text-[15px]">READY TO SHIP</span>
        <span
          className="px-2 py-1 rounded-full text-[10px] font-bold"
          style={{ background: s.accentText, color: s.accent }}
        >
          STICKER
        </span>
      </div>

      {/* --- BUTTONS --- */}
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          className="h-12 px-5 rounded-full border-[1.5px] font-bold text-[14px] flex-1 hover:opacity-80 transition-opacity cursor-pointer"
          style={{
            background: s.card,
            borderColor: s.border,
            color: s.text,
            boxShadow: s.softShadow,
          }}
          onClick={onBack}
        >
          ← Back
        </button>
        <button
          type="button"
          className="h-12 px-7 rounded-full font-bold text-[14px] flex-1 cursor-pointer transition-all border-[1.5px]"
          disabled={!canProceed}
          style={
            canProceed
              ? {
                  backgroundColor: s.accent,
                  color: s.accentText,
                  borderColor: s.accent,
                  boxShadow: s.bentoShadow,
                }
              : {
                  backgroundColor: s.subtle,
                  color: s.textTertiary,
                  borderColor: s.border,
                }
          }
          onClick={onSave}
        >
          Save & Continue →
        </button>
      </div>
    </div>
  );
}
