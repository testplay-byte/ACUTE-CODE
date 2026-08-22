import { motion } from "framer-motion";
import { Plus, Bot, Settings, Terminal } from "lucide-react";
import type { ThemeStyles } from "../../lib/themes";
import { scaleIn } from "../../lib/motion";
import { bdr } from "./helpers";

/**
 * Quick actions ported from the dashboard demo (QuickActions.tsx), pointed at
 * real app destinations instead of the demo's mock project creation.
 */
const ACTIONS = [
  { label: "Start a session", to: "/sessions", icon: Plus },
  { label: "Manage agents", to: "/agents", icon: Bot },
  { label: "Open settings", to: "/settings", icon: Settings },
] as const;

export function QuickActions({
  onNavigate,
  styles,
}: {
  onNavigate: (to: string) => void;
  styles: ThemeStyles;
}) {
  const { card, border, text, accent, isDark } = styles;
  return (
    <motion.div
      variants={scaleIn}
      className="rounded-lg p-4"
      style={{ backgroundColor: card, border: bdr("1.5px", border) }}
    >
      <div className="mb-3 flex items-center gap-2">
        <Terminal size={13} style={{ color: accent, opacity: 0.7 }} />
        <span className="text-[12px] font-semibold" style={{ color: text }}>
          Quick Actions
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {ACTIONS.map(({ label, to, icon: Icon }) => (
          <button
            key={to}
            onClick={() => onNavigate(to)}
            className="w-full cursor-pointer rounded-lg px-3 py-2.5 text-left text-[12px] font-medium transition-all duration-200 hover:translate-x-0.5"
            style={{
              backgroundColor: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.015)",
              border: bdr("1.5px", border),
              color: text,
            }}
          >
            <span className="flex items-center gap-2">
              <Icon size={12} style={{ color: accent, opacity: 0.7 }} />
              {label}
            </span>
          </button>
        ))}
      </div>
    </motion.div>
  );
}
