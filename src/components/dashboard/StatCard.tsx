import { motion } from "framer-motion";
import type { ElementType } from "react";
import type { ThemeStyles } from "../../lib/themes";
import { scaleIn } from "../../lib/motion";
import { bdr, withAlpha } from "./helpers";

/**
 * Stat card ported from the dashboard demo (StatCard.tsx): value + label left,
 * faded-accent icon chip right, scale-in entrance, 1px hover lift. The demo's
 * HoverCard breakdowns need per-project stats the usage API doesn't serve yet,
 * so the icon carries a native `title` tooltip instead.
 */
export function StatCard({
  value,
  label,
  icon: Icon,
  title,
  styles,
}: {
  value: string;
  label: string;
  icon: ElementType;
  title?: string;
  styles: ThemeStyles;
}) {
  const { card, border, text, textSecondary, accent, isDark } = styles;
  return (
    <motion.div
      variants={scaleIn}
      whileHover={{ y: -1, transition: { duration: 0.2 } }}
      className="relative cursor-default overflow-hidden rounded-lg p-3.5"
      style={{ backgroundColor: card, border: bdr("1.5px", border) }}
      title={title}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-xl font-bold tracking-tight" style={{ color: text }}>
            {value}
          </div>
          <div className="mt-0.5 text-[11px] font-medium" style={{ color: textSecondary }}>
            {label}
          </div>
        </div>
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: withAlpha(accent, isDark ? 0.18 : 0.12) }}
        >
          <Icon size={16} style={{ color: accent, opacity: 0.7 }} />
        </div>
      </div>
    </motion.div>
  );
}
