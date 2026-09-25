import { useCallback } from "react";
import { useOnboardingStore } from "../onboarding-store";
import { CONTEXT_OPTIONS, REASONING_LEVELS } from "../onboarding-types";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import { NumberField, ThemedSlider } from "./controls";

/** Tuning card — ported from the demo's plug-brain/ModelTuningCard.tsx. */
export function ModelTuningCard() {
  const s = useThemeStyles();
  const contextWindow = useOnboardingStore((st) => st.contextWindow);
  const setContextWindow = useOnboardingStore((st) => st.setContextWindow);
  const contextManual = useOnboardingStore((st) => st.contextManual);
  const setContextManual = useOnboardingStore((st) => st.setContextManual);
  const maxOutput = useOnboardingStore((st) => st.maxOutput);
  const setMaxOutput = useOnboardingStore((st) => st.setMaxOutput);
  const temperature = useOnboardingStore((st) => st.temperature);
  const setTemperature = useOnboardingStore((st) => st.setTemperature);
  const inputCost = useOnboardingStore((st) => st.inputCost);
  const setInputCost = useOnboardingStore((st) => st.setInputCost);
  const outputCost = useOnboardingStore((st) => st.outputCost);
  const setOutputCost = useOnboardingStore((st) => st.setOutputCost);
  const reasoning = useOnboardingStore((st) => st.reasoning);
  const setReasoning = useOnboardingStore((st) => st.setReasoning);

  // Presets just pick a value — the MANUAL toggle alone controls whether the
  // free-form token field is shown.
  const handleContextSelect = useCallback(
    (val: number) => {
      setContextWindow(val);
    },
    [setContextWindow],
  );

  const activeContext = contextWindow;
  const estimatePages = Math.round(activeContext / 750);

  return (
    <div
      className="rounded-[24px] border p-4 md:p-5 border-clay-rim ac-clay bg-card"
    >
      <div className="flex items-center justify-between">
        <span className="font-bold tracking-tight" style={{ color: s.text }}>Model Tuning</span>
        <span
          className="text-[10px] font-bold px-2 py-1 rounded-full bg-badge-neutral text-badge-neutral-fg"
        >
          ADVANCED
        </span>
      </div>

      <div className="mt-5 grid gap-5">
        {/* 1. Context Window — R126-3g: the recessed well. */}
        <div
          className="ac-well rounded-[16px] p-3"
        >
          <div className="flex items-center justify-between mb-3">
            <span
              className="text-[11px] font-bold uppercase tracking-widest"
              style={{ color: s.textTertiary }}
            >
              Context window
            </span>
            {/* Themed auto/manual toggle — R126-3g: the segmented grammar
                (well track + the accentDeep knob). */}
            <div className="flex items-center rounded-full p-0.5 bg-well">
              <button
                type="button"
                className="px-2.5 py-1 rounded-full text-[10px] font-bold transition-colors cursor-pointer border-none"
                style={{
                  background: !contextManual ? s.accentDeep : "transparent",
                  color: !contextManual ? s.accentText : s.textTertiary,
                }}
                onClick={() => setContextManual(false)}
              >
                AUTO
              </button>
              <button
                type="button"
                className="px-2.5 py-1 rounded-full text-[10px] font-bold transition-colors cursor-pointer border-none"
                style={{
                  background: contextManual ? s.accentDeep : "transparent",
                  color: contextManual ? s.accentText : s.textTertiary,
                }}
                onClick={() => setContextManual(true)}
              >
                MANUAL
              </button>
            </div>
          </div>

          {/* AUTO → preset chips only · MANUAL → free token entry only
              (owner round-5: the two modes must be genuinely different,
              not the same chips plus an extra input) */}
          {contextManual ? (
            <div className="flex items-center gap-3">
              <div className="w-[180px] shrink-0">
                <NumberField
                  value={contextWindow}
                  onChange={setContextWindow}
                  step={1000}
                  min={1000}
                  ariaLabel="Custom context window in tokens"
                />
              </div>
              <span className="text-[11px] font-medium" style={{ color: s.textTertiary }}>
                Exact tokens — switch to AUTO for quick presets.
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              {CONTEXT_OPTIONS.map((opt) => {
                const isActive = activeContext === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    className={`flex-1 h-10 rounded-[12px] border text-[12px] font-bold cursor-pointer transition-all ${
                      isActive ? "border-accent-deep bg-accent-tint text-accent-deep" : "border-clay-rim bg-card"
                    }`}
                    style={isActive ? undefined : { color: s.text }}
                    onClick={() => handleContextSelect(opt.value)}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          )}

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
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label
              className="block text-[11px] font-bold uppercase tracking-widest mb-1.5"
              style={{ color: s.textTertiary }}
            >
              Max output
            </label>
            <NumberField
              value={maxOutput}
              onChange={setMaxOutput}
              step={256}
              min={256}
              ariaLabel="Max output tokens"
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
              className="h-11 rounded-[12px] border-[1.5px] px-3 flex items-center gap-3"
              style={{
                background: s.inputBg,
                borderColor: s.inputBorder,
              }}
            >
              <ThemedSlider
                value={temperature}
                min={0}
                max={2}
                step={0.1}
                onChange={setTemperature}
                ariaLabel="Temperature"
              />
              <span
                className="px-2 py-1 rounded-full text-[11px] font-bold shrink-0 font-mono w-[44px] text-center bg-badge-neutral text-badge-neutral-fg"
              >
                {temperature.toFixed(1)}
              </span>
            </div>
          </div>
        </div>

        {/* 3. Input $/1M and Output $/1M (2-col) */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label
              className="block text-[11px] font-bold uppercase tracking-widest mb-1.5"
              style={{ color: s.textTertiary }}
            >
              Input $/1M tokens
            </label>
            <NumberField
              value={inputCost}
              onChange={setInputCost}
              step={0.01}
              min={0}
              ariaLabel="Input cost per million tokens"
            />
          </div>
          <div>
            <label
              className="block text-[11px] font-bold uppercase tracking-widest mb-1.5"
              style={{ color: s.textTertiary }}
            >
              Output $/1M tokens
            </label>
            <NumberField
              value={outputCost}
              onChange={setOutputCost}
              step={0.01}
              min={0}
              ariaLabel="Output cost per million tokens"
            />
          </div>
        </div>

        {/* 4. Reasoning Effort — R126-3g: the selection grammar chips. */}
        <div>
          <label
            className="block text-[11px] font-bold uppercase tracking-widest mb-2"
            style={{ color: s.textTertiary }}
          >
            Reasoning Effort
          </label>
          <div className="grid grid-cols-5 gap-1.5">
            {REASONING_LEVELS.map((level) => {
              const isActive = reasoning === level.id;
              return (
                <button
                  key={level.id}
                  type="button"
                  className={`h-[48px] rounded-[14px] border grid place-items-center gap-0.5 transition-all cursor-pointer ${
                    isActive ? "border-accent-deep bg-accent-tint" : "border-clay-rim bg-card ac-clay-sm"
                  }`}
                  style={isActive ? { color: s.accentDeep } : { color: s.text }}
                  onClick={() => setReasoning(level.id)}
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
