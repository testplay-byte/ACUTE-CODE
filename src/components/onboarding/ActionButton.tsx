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
 *
 * R108-e: the sheen pass is now half as bright and half as wide a band
 * (the --ac-chrome-sheen stop halved in themes.ts + the narrowed gradient
 * in index.css) — "jewelry, rationed": a glint catching the light, not a
 * shine sweep. The class grammar is unchanged.
 *
 * R126-3g (the clay palette pass): the gradient stops re-derive from the
 * ONE accent family — accent → accentDeep (TOKENS §1d) — replacing the
 * pre-R126 accent→accent2 second-hue ramp; the keycap hint chip sinks into
 * the recessed well (surfaceWell + clayRim hairline, TOKENS §10) instead
 * of the accentText color-mix tint. The gradient + sheen + bentoShadow
 * grammar itself is UNTOUCHED (WIZARD-DNA §7 — the one sanctioned CTA
 * surface).
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
        className="h-12 px-5 rounded-full border font-bold text-[14px] hover:opacity-80 transition-opacity cursor-pointer border-clay-rim ac-clay-sm bg-card"
        style={{ color: s.text }}
      >
        {children}
      </button>
    );
  }

  // R126-3g: the gradient stops re-derive from the accent family —
  // accent → accentDeep (the second-hue accent2 stop retired).
  const idle =
    variant === "primary" && !disabled
      ? {
          background: `linear-gradient(135deg, ${s.accent}, ${s.accentDeep})`,
          color: s.accentText,
          borderColor: s.accentDeep,
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
            // R126-3g: the keycap hint chip = the recessed well
            // (surfaceWell fill + clayRim hairline, TOKENS §10) with
            // primary ink — the accentText color-mix tint retired.
            color: s.text,
            background: s.surfaceWell,
            border: `1px solid ${s.clayRim}`,
          }}
        >
          {hint}
        </span>
      )}
    </button>
  );
}
