import type { ReactNode } from "react";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { cn } from "../../lib/utils";

/**
 * ROUND-100 (R100-C) — the settings control row primitive (research §C1.2 +
 * §C2 P1(b), docs/design-language/TOKENS.md §3 — the row-height table's
 * "Settings control row (label + control): 36px").
 *
 * One spelling of label-left / control-right: a 36px min-height flex row
 * (IDE-density, TOKENS §3 — 36–44px is the FORMS band), the label block is
 * 13px/400 body ink (the weight law: chrome text is regular weight) with an
 * optional 11px tertiary description, `flex-1 min-w-[200px]` so long labels
 * wrap instead of squeezing the control; the control slot is right-aligned
 * and never shrinks. Stacked rows get the optional 1px `border-line`
 * hairline divider on top (TOKENS §5: hairlines inside panels).
 *
 * NO JS hover: if a row needs a hover wash, the PARENT adds the CSS class
 * (`hover:bg-hover` — TOKENS §6); a layout row never owns interaction.
 * The description's tertiary ink rides the useThemeStyles JS leg (TOKENS
 * §1 rule 4 — no hover state on static text), theme-aware in light + dark.
 */
export function SettingsRow({
  label,
  description,
  children,
  divider = false,
  className,
  testId,
}: {
  label: ReactNode;
  /** Optional one-line 11px tertiary hint under the label. */
  description?: ReactNode;
  /** The control slot — right-aligned, shrink-0 (toggle, input, button, …). */
  children?: ReactNode;
  /** Top hairline divider for stacked rows (1px border-line, TOKENS §5). */
  divider?: boolean;
  className?: string;
  testId?: string;
}) {
  const styles = useThemeStyles();
  return (
    <div
      data-testid={testId}
      className={cn(
        "flex min-h-[36px] items-center gap-4 py-2",
        divider && "border-t border-line",
        className,
      )}
    >
      <div className="min-w-[200px] flex-1">
        <div className="text-[13px] font-normal text-ink">{label}</div>
        {description !== undefined ? (
          <div className="text-[11px]" style={{ color: styles.textTertiary }}>
            {description}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center justify-end">{children}</div>
    </div>
  );
}
