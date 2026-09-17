import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { cn } from "../../lib/utils";

/**
 * ROUND-100 (R100-C) — THE label-tier heading, the ONE kicker idiom
 * (research §C1.1 + docs/design-language/TOKENS.md §2, the revised ladder).
 *
 * Before round-100 the app spelled this tier four different ways (10.5px
 * font-black, 11px font-bold, tracking 0.1–0.18em — the audit's "AI
 * generated" tell). The single spelling is now: 11px / 500 / uppercase /
 * tracking-[0.08em] / tertiary ink, optional 12px lucide glyph. The weight
 * law (TOKENS §2) puts this tier at 500 — never 700/900.
 *
 * The tertiary ink rides the useThemeStyles JS leg (the documented pipeline
 * route for colors Tailwind's utility set can't reach — TOKENS §1 rule 4:
 * no hover state here, so the CSS-var leg isn't required); it re-syncs the
 * --ac-* bridge as a side effect, so it is correct in light AND dark mode.
 */
export function Kicker({
  children,
  icon: Icon,
  as: Tag = "div",
  className,
  testId,
}: {
  children: ReactNode;
  /** Optional 12px lucide glyph (the label tier's only sanctioned icon size). */
  icon?: LucideIcon;
  /** Element to render as — h2/h3 when the kicker heads a section, div (default) for in-card labels. */
  as?: "h2" | "h3" | "div";
  className?: string;
  testId?: string;
}) {
  const styles = useThemeStyles();
  return (
    <Tag
      data-testid={testId}
      className={cn(
        "flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em]",
        className,
      )}
      style={{ color: styles.textTertiary }}
    >
      {Icon ? <Icon size={12} className="shrink-0" aria-hidden /> : null}
      {children}
    </Tag>
  );
}
