import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * Small control kit in the demo's visual language (1.5px borders, 8px radii,
 * 11–12px semitransparent labels). Deliberately not a shadcn snapshot — just
 * the primitives the current screens need.
 */

type ButtonVariant = "primary" | "outline" | "ghost" | "danger";

export function Button({
  variant = "outline",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      className={cn(
        "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold",
        "transition-all duration-200 hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100",
        {
          primary: "bg-accent text-white shadow-sm hover:brightness-110",
          outline: "border-[1.5px] border-line bg-card text-ink hover:bg-hover",
          ghost: "text-muted hover:bg-hover hover:text-ink",
          danger: "border-[1.5px] border-transparent bg-red-500/10 text-red-500 hover:bg-red-500/20",
        }[variant],
        className,
      )}
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
  "w-full rounded-lg border-[1.5px] border-line bg-input px-2.5 py-2 text-[13px] text-ink",
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
        tone === "accent" ? "bg-accent-soft text-accent" : "bg-hover text-muted",
        className,
      )}
    >
      {children}
    </span>
  );
}
