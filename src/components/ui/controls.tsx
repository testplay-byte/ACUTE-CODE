import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { cn } from "../../lib/utils";

/**
 * Small control kit for the settings surfaces. Deliberately not a shadcn
 * snapshot — just the primitives the current screens need.
 *
 * ROUND-126 (R126-3f-1): the Button's PRIMARY variant is the quiet-solid
 * clay species (COMPONENTS §4 / TOKENS §1d) — `bg-accent-deep` fill with
 * the `accentText` ink pair on the JS leg (`styles.accentText` — the
 * documented route: `text-accent-text` is a phantom utility, the @theme leg
 * never gained `--color-accent-text`). The gradient-ish hover (brightness
 * + scale fidget) died with the bento grammar: hover is nothing, press is
 * the house `active:scale-[0.98]`. `inputClass` rides THE WELL + rim
 * (TOKENS §10): `bg-well` fill + the 1px `border-clay-rim` hairline, the
 * accent focus edge kept.
 *
 * ROUND-126 (R126-3h, the flagged-debt ledger — 3f-1's caveat): the
 * OUTLINE/DANGER variants + Badge join the grammar. OUTLINE = the outlined
 * secondary species (1px `border-line-strong` + `text-muted`, TOKENS §5/§1a
 * — the 1.5px `border-line` card-border spelling dies). DANGER = the
 * OUTLINED-danger species (1px `border-danger-deep` + `text-danger-deep` on
 * transparent, the composer Stop spelling — the red-500 wash fill dies).
 * Badge's default tone = the §11 NEUTRAL pair; the accent tone = the §11
 * ACCENT pair (`bg-badge-accent` + `text-badge-accent-fg` — the
 * accent-soft/accent flat-hue pair dies).
 */

type ButtonVariant = "primary" | "outline" | "ghost" | "danger";

export function Button({
  variant = "outline",
  className,
  style,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const styles = useThemeStyles();
  return (
    <button
      className={cn(
        "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold",
        "transition-colors duration-100 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50",
        {
          // R126: quiet-solid clay — the deep-tier fill + the accentText
          // ink pair (JS leg below). No glow, no scale hover.
          primary: "bg-accent-deep",
          // R126-3h: the outlined SECONDARY species — 1px border-strong +
          // text-secondary ink (the 1.5px border-line card spelling dies).
          outline: "border border-line-strong bg-card text-muted hover:bg-hover hover:text-ink",
          ghost: "text-muted hover:bg-hover hover:text-ink",
          // R126-3h: the OUTLINED-danger species — 1px border-danger-deep +
          // danger-deep ink on transparent (the red-500 wash fill dies).
          danger: "border border-danger-deep text-danger-deep hover:bg-badge-danger",
        }[variant],
        className,
      )}
      style={variant === "primary" ? { color: styles.accentText, ...style } : style}
      {...props}
    />
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  /** Secondary line under the control (hints or validation errors). */
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("block", className)}>
      <label className="block">
        <span className="mb-1.5 block text-[11px] font-semibold text-muted">{label}</span>
        {children}
      </label>
      {hint ? <span className="mt-1 block text-[10px] text-muted">{hint}</span> : null}
    </div>
  );
}

export const inputClass = cn(
  // R126: THE WELL + rim (TOKENS §10) — inputs are recesses, one step down
  // from the card; the accent focus edge survives the conversion.
  "w-full rounded-lg border border-clay-rim bg-well px-2.5 py-2 text-[13px] text-ink",
  "outline-none transition-colors placeholder:text-muted/70 focus:border-accent",
);

export function Badge({
  children,
  tone = "muted",
  className,
}: {
  children: ReactNode;
  tone?: "muted" | "accent";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold",
        // R126-3h (TOKENS §11): both tones ride the badge-tone pairs — the
        // neutral container + secondary ink (was bg-hover/text-muted) and
        // the accent container + its own fg ink (was the flat accent-soft/
        // accent pair).
        tone === "accent" ? "bg-badge-accent text-badge-accent-fg" : "bg-badge-neutral text-badge-neutral-fg",
        className,
      )}
    >
      {children}
    </span>
  );
}
