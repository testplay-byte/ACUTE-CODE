import type { ReactNode } from "react";
import { useThemeStyles } from "../../lib/use-theme-styles";

/**
 * Wizard action buttons (owner round-5: the primary pill felt "dialed out" —
 * flat accent fill with a washed-out ↵ hint). Primary now carries a subtle
 * accent→accent2 gradient, a key-cap style hint chip, and a slightly bolder
 * label; Secondary is the quiet card-colored pill for Back. One component so
 * every step's action row stays visually identical.
 *
 * R107-g (the clay/chrome round): the primary CTA gains the liquid-chrome
 * sheen — the accent gradient stays (the accent owns the action's identity;
 * WIZARD-DNA §7), and `ac-chrome-sheen` layers a soft metallic highlight
 * that sweeps across the pill once every ~9s and rests between passes
 * (index.css pattern over the --ac-chrome-* vars; transform-only,
 * reduced-motion safe — the band hides entirely under
 * prefers-reduced-motion). This is the SPARING signature use: the wizard's
 * CTAs only, never working-UI buttons (MOTION rule 3).
 */
export function ActionButton({
  variant,
  onClick,
  disabled,
  children,
  hint,
  ariaLabel,
}: {
  variant: "primary" | "secondary";
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
  /** Small key-cap chip appended to the label (e.g. "↵"). Primary only. */
  hint?: string;
  ariaLabel?: string;
}) {
  const s = useThemeStyles();

  if (variant === "secondary") {
    return (
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={onClick}
        className="h-12 px-5 rounded-full border-[1.5px] font-bold text-[14px] hover:opacity-80 transition-opacity cursor-pointer"
        style={{
          background: s.card,
          borderColor: s.border,
          color: s.text,
          boxShadow: s.softShadow,
        }}
      >
        {children}
      </button>
    );
  }

  const idle =
    variant === "primary" && !disabled
      ? {
          background: `linear-gradient(135deg, ${s.accent}, ${s.theme.accent2})`,
          color: s.accentText,
          borderColor: s.accent,
          boxShadow: s.bentoShadow,
        }
      : {
          background: s.subtle,
          color: s.textTertiary,
          borderColor: s.border,
          boxShadow: "none",
        };

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={disabled}
      // The sheen rides the ENABLED primary only — a disabled pill must sit
      // perfectly still (MOTION rule 3: nothing animates that the user
      // didn't act on).
      className={`h-12 px-7 rounded-full font-black tracking-[-0.01em] text-[15px] flex items-center gap-2.5 hover:scale-[1.03] active:scale-[0.98] transition-transform cursor-pointer border-[1.5px] disabled:cursor-not-allowed disabled:hover:scale-100${disabled ? "" : " ac-chrome-sheen"}`}
      style={idle}
    >
      {children}
      {hint && !disabled && (
        <span
          className="px-1.5 py-0.5 rounded-md text-[10px] font-mono font-bold grid place-items-center leading-none"
          style={{
            color: s.accentText,
            background: `color-mix(in srgb, ${s.accentText} 18%, transparent)`,
            border: `1px solid color-mix(in srgb, ${s.accentText} 38%, transparent)`,
          }}
        >
          {hint}
        </span>
      )}
    </button>
  );
}
