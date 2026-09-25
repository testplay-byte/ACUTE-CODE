import { useId, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Kicker } from "./Kicker";

/**
 * ROUND-126 (R126-3f-1, the Clay Companion redesign) — the settings/panel
 * card primitive's OWN conversion. The dashboard/usage waves had overridden
 * the material per call site (`className="border border-clay-rim ac-clay…"`
 * resolving over the primitive's own bento border via twMerge); this wave
 * converts the primitive itself, so every consumer gets the clay card by
 * default.
 *
 * The clay card grammar (TOKENS §5/§9 + COMPONENTS §3 species 1): 16px
 * radius (`rounded-2xl`, the 4th step of the 5-step radius scale), the warm
 * 1px `border-clay-rim` hairline on all four sides (the 1.5px bento border
 * is RETIRED — the border-forward look was the nova-era dialect), `bg-card`
 * surface, and the two-leg clay depth via the `.ac-clay` pattern class
 * (box-shadow only, composes with any inline fill). The per-call-site
 * overrides the earlier waves pinned keep resolving to the same material.
 *
 * The `shadow` prop is a documented NO-OP now (kept byte-identical in the
 * prop surface so callers keep compiling): the pre-R126 `softShadow`
 * elevation leg died with the clay conversion — the card's depth IS the
 * `.ac-clay` shadow. Callers still passing `shadow` compile unchanged and
 * simply get the clay card.
 *
 * Every color comes from the Tailwind theme utilities mapped to the --ac-*
 * bridge in src/index.css (`bg-card`, `border-clay-rim`, `text-ink`) — zero
 * inline hex, and the CSS vars flip correctly in light + dark mode.
 * Optional header slot: a Kicker (label tier) and/or a 13px/600 section
 * title (the weight law: 600 = section headers).
 */
export function SectionCard({
  children,
  className,
  size = "md",
  kicker,
  title,
  ariaLabel,
  testId,
}: {
  children: ReactNode;
  className?: string;
  /** md = p-5 (20px), lg = p-6 (24px) — both on the 8px rhythm (TOKENS §3). */
  size?: "md" | "lg";
  /** NO-OP since R126 (the clay card's depth is the `.ac-clay` class) —
   * kept in the prop surface so existing callers keep compiling. */
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
  const titleId = useId();
  return (
    <section
      data-testid={testId}
      aria-label={ariaLabel}
      aria-labelledby={title !== undefined ? titleId : undefined}
      className={cn(
        "rounded-2xl border border-clay-rim bg-card ac-clay",
        size === "lg" ? "p-6" : "p-5",
        className,
      )}
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
