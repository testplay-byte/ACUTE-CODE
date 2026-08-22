import { useState } from "react";
import { useThemeStyles } from "../../../lib/use-theme-styles";

/**
 * Themed form controls for PlugBrain. The browser's native number spinners
 * and range slider clash with the app's bento design language, so both are
 * replaced: NumberField hides the native spinners and renders themed ▲/▼
 * steppers, ThemedSlider draws its own track/fill and styles only the thumb
 * natively (see .ac-slider in index.css).
 */

function decimalsOf(step: number): number {
  const s = String(step);
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}

export function NumberField({
  value,
  onChange,
  step = 1,
  min,
  max,
  ariaLabel,
}: {
  value: number;
  onChange: (next: number) => void;
  step?: number;
  min?: number;
  max?: number;
  ariaLabel?: string;
}) {
  const s = useThemeStyles();
  const [focused, setFocused] = useState(false);
  const [hoverBtn, setHoverBtn] = useState<"up" | "down" | null>(null);

  const stepBy = (dir: 1 | -1) => {
    const decimals = decimalsOf(step);
    let next = Number((value + dir * step).toFixed(decimals));
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    onChange(next);
  };

  const btnStyle = (dir: "up" | "down", active: boolean) => ({
    background: hoverBtn === dir ? s.accent : s.subtle,
    borderColor: hoverBtn === dir ? s.accent : s.border,
    color: hoverBtn === dir ? s.accentText : s.textSecondary,
    opacity: active ? 1 : undefined,
  });

  return (
    <div className="relative group/num">
      <input
        type="number"
        inputMode="decimal"
        aria-label={ariaLabel}
        step={step}
        min={min}
        max={max}
        className="w-full h-11 rounded-[12px] border-[1.5px] pl-3 pr-12 text-[13px] font-mono outline-none transition-colors appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0 [&::-webkit-outer-spin-button]:appearance-none [-moz-appearance:textfield]"
        style={{
          background: s.inputBg,
          borderColor: focused ? s.inputFocusBorder : s.inputBorder,
          color: s.text,
        }}
        onFocus={(e) => {
          setFocused(true);
          e.target.style.borderColor = s.inputFocusBorder;
        }}
        onBlur={() => setFocused(false)}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      />
      {/* Owner round-5: steppers appear on hover/focus only — like the
          browser's native spinners, not permanently bolted onto the field. */}
      <div
        className={`absolute right-1.5 top-1.5 bottom-1.5 flex flex-col gap-[2px] transition-opacity duration-150 ${
          focused ? "opacity-100" : "opacity-0 group-hover/num:opacity-100"
        }`}
      >
        <button
          type="button"
          tabIndex={-1}
          aria-label="Increase"
          className="flex-1 w-7 rounded-[7px] border text-[8px] leading-none grid place-items-center cursor-pointer transition-colors"
          style={btnStyle("up", true)}
          onMouseEnter={() => setHoverBtn("up")}
          onMouseLeave={() => setHoverBtn(null)}
          onClick={() => stepBy(1)}
        >
          ▲
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label="Decrease"
          className="flex-1 w-7 rounded-[7px] border text-[8px] leading-none grid place-items-center cursor-pointer transition-colors"
          style={btnStyle("down", true)}
          onMouseEnter={() => setHoverBtn("down")}
          onMouseLeave={() => setHoverBtn(null)}
          onClick={() => stepBy(-1)}
        >
          ▼
        </button>
      </div>
    </div>
  );
}

/** Themed range slider — native input for a11y/keyboard, custom visuals. */
export function ThemedSlider({
  value,
  min,
  max,
  step,
  onChange,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
  ariaLabel?: string;
}) {
  const s = useThemeStyles();
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div className="relative flex-1 h-5 flex items-center min-w-0">
      {/* Track + fill behind the transparent native control */}
      <div className="absolute inset-x-0 h-[7px] rounded-full" style={{ background: s.border }} />
      <div
        className="absolute left-0 h-[7px] rounded-full"
        style={{
          width: `${pct}%`,
          background: `linear-gradient(to right, ${s.accent}, ${s.theme.accent2})`,
        }}
      />
      <input
        type="range"
        aria-label={ariaLabel}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="ac-slider relative z-10 w-full"
      />
    </div>
  );
}
