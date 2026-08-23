import { motion } from "framer-motion";
import { useState, type ElementType } from "react";
import type { ThemeStyles } from "../../lib/themes";
import { scaleIn } from "../../lib/motion";

/**
 * Stat card (round-21 wizard DNA): 20px-radius card with softShadow,
 * solid accent icon tile (w-10 h-10, full opacity — no translucent soup),
 * font-black value + uppercase tracked label. Hover = 2px lift + shadow
 * deepen. `highlight` fills the whole card with accent (the bold moment).
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
  const [hovered, setHovered] = useState(false);
  const { card, border, text, textTertiary, accent, accentText, softShadow, bentoShadowSm } = styles;

  return (
    <motion.div
      variants={scaleIn}
      className="relative cursor-default overflow-hidden rounded-[20px] border-[1.5px] p-4 transition-all duration-200"
      style={{
        backgroundColor: highlight ? accent : card,
        borderColor: highlight ? accent : border,
        boxShadow: hovered ? bentoShadowSm : softShadow,
        transform: hovered ? "translateY(-2px)" : "translateY(0)",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={title}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div
            className="truncate text-[22px] font-black tracking-tighter leading-none"
            style={{ color: highlight ? accentText : text }}
          >
            {value}
          </div>
          <div
            className="mt-1.5 text-[11px] font-bold uppercase tracking-widest"
            style={{ color: highlight ? withAlphaF(accentText, 0.8) : textTertiary }}
          >
            {label}
          </div>
        </div>
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px]"
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
