import { useId, type ReactNode } from "react";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { cn } from "../../lib/utils";
import { Kicker } from "./Kicker";

/**
 * ROUND-100 (R100-C) — the settings/panel card primitive (research §C1.4 +
 * §C2 P1(b), docs/design-language/TOKENS.md §4–5 + COMPONENTS.md §3).
 *
 * The bento card grammar, one spelling: 16px radius (`rounded-2xl` — the
 * 4th step of the 5-step radius scale, TOKENS §4; the arbitrary
 * `rounded-[16px]` spelling renders the same pixels but trips the design
 * audit's arbitrary-value counter), 1.5px `border-line` (the top-level-card
 * weight, TOKENS §5), `bg-card` surface, p-5 (md) / p-6 (lg) padding on the
 * 8px rhythm. Optional `softShadow` (the floating-surface elevation,
 * TOKENS §5) rides the JS leg — the repo's existing boxShadow idiom.
 *
 * Every color comes from the Tailwind theme utilities mapped to the --ac-*
 * bridge in src/index.css (`bg-card`, `border-line`, `text-ink`) — zero
 * inline hex, and the CSS vars flip correctly in light + dark mode.
 * Optional header slot: a Kicker (label tier) and/or a 13px/600 section
 * title (the weight law: 600 = section headers).
 */
export function SectionCard({
  children,
  className,
  size = "md",
  shadow = false,
  kicker,
  title,
  ariaLabel,
  testId,
}: {
  children: ReactNode;
  className?: string;
  /** md = p-5 (20px), lg = p-6 (24px) — both on the 8px rhythm (TOKENS §3). */
  size?: "md" | "lg";
  /** softShadow elevation (floating surfaces, TOKENS §5) — off by default: cards rest flat. */
  shadow?: boolean;
  /** Optional label-tier kicker for the card header (renders via the Kicker primitive). */
  kicker?: ReactNode;
  /** Optional 13px/600 section title for the card header. */
  title?: ReactNode;
  /** R100-E1: optional accessible name — the adopting screens' pre-primitive
   * cards carried aria-labels their tests pin; adoption must not drop them. */
  ariaLabel?: string;
  testId?: string;
}) {
  const styles = useThemeStyles();
  const titleId = useId();
  return (
    <section
      data-testid={testId}
      aria-label={ariaLabel}
      aria-labelledby={title !== undefined ? titleId : undefined}
      className={cn(
        "rounded-2xl border-[1.5px] border-line bg-card",
        size === "lg" ? "p-6" : "p-5",
        className,
      )}
      style={shadow ? { boxShadow: styles.softShadow } : undefined}
    >
      {kicker !== undefined || title !== undefined ? (
        <header className="mb-4 flex flex-col gap-1.5">
          {kicker !== undefined ? <Kicker>{kicker}</Kicker> : null}
          {title !== undefined ? (
            <h3 id={titleId} className="text-[13px] font-semibold text-ink">
              {title}
            </h3>
          ) : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}
