import { motion } from "framer-motion";
import type { ElementType } from "react";
import type { ThemeStyles } from "../../lib/themes";
import { scaleIn } from "../../lib/motion";

/**
 * Stat card (round-21 wizard DNA, de-costumed R100-G per research §C2 P3 +
 * §C3 — the wizard-DNA boundary: working screens earn trust through
 * restraint): 16px-radius card (rounded-2xl, the 5-step scale) with
 * softShadow, solid accent icon tile (w-10 h-10, full opacity — no
 * translucent soup), 22px/600 tabular value (the ladder's `value` token —
 * font-black + tracking-tighter were the wizard display tell) and the
 * label-tier label (11px/500/0.08em uppercase, TOKENS §2). Hover = the
 * CSS-class border-strong swap (TOKENS §1a/§6 — the borderLineStrong
 * utility; the old useState lift + bentoShadowSm deepen are gone: resting
 * UI never fidgets). `highlight` fills the whole card with accent (the one
 * bold moment).
 *
 * R107-g (the clay/chrome round): the card surface gains the two
 * cross-theme surface patterns — `ac-clay-light` (the soft top-light
 * diffusion; hand-thrown warmth) + `ac-chrome-edge` (the 1px reflective
 * hairline; the light-catching edge of polished metal). Both are
 * background-image/pseudo-element treatments, so they compose with the
 * inline backgroundColor + softShadow untouched, and both ride the
 * --ac-chrome-* vars — on the Clay Studio theme the card reads as glazed
 * ceramic, on every other theme as quietly lit studio material.
 *
 * R99-E (the usage anti-jitter kit, research §3.2): the card is pinned at
 * h-[92px] — the height every StatCard-shaped skeleton across the app
 * already reserves (dashboard, usage screen, the DataStatsPanel) — and the
 * value renders tabular-nums so live-updating numbers hold their width.
 */
export function StatCard({
  value,
  label,
  icon: Icon,
  title,
  styles,
  highlight = false,
}: {
  value: string;
  label: string;
  icon: ElementType;
  title?: string;
  styles: ThemeStyles;
  /** The "bold moment" card — accent-filled with accentText (wizard recipe). */
  highlight?: boolean;
}) {
  const { card, text, textTertiary, accent, accentText, softShadow } = styles;

  return (
    <motion.div
      variants={scaleIn}
      className="relative flex h-[92px] cursor-default flex-col justify-center overflow-hidden rounded-2xl border-[1.5px] border-line p-4 transition-colors duration-150 hover:border-line-strong ac-clay-light ac-chrome-edge"
      style={{
        backgroundColor: highlight ? accent : card,
        borderColor: highlight ? accent : undefined,
        boxShadow: softShadow,
      }}
      title={title}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div
            className="truncate text-[22px] font-semibold tabular-nums leading-none"
            style={{ color: highlight ? accentText : text }}
          >
            {value}
          </div>
          <div
            className="mt-1.5 text-[11px] font-medium uppercase tracking-[0.08em]"
            style={{ color: highlight ? withAlphaF(accentText, 0.8) : textTertiary }}
          >
            {label}
          </div>
        </div>
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
          style={{
            backgroundColor: highlight ? withAlphaF(accentText, 0.2) : accent,
            color: highlight ? accentText : accentText,
          }}
        >
          <Icon size={16} strokeWidth={2} style={{ opacity: 1 }} />
        </div>
      </div>
    </motion.div>
  );
}

/** Local alpha helper for the highlight card (accentText needs its own fade). */
function withAlphaF(color: string, alpha: number): string {
  if (color.startsWith("#") && color.length === 7) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}
