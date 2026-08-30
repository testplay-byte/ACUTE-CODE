import { useState } from "react";
import { Brain, Check, ChevronDown } from "lucide-react";
import type { ThinkingLevel } from "shared";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import { withAlpha } from "../../dashboard/helpers";
import { THINKING_OPTIONS, thinkingOption, useDismiss } from "./composer-utils";

/**
 * ROUND-50 (R50-c2): the thinking-level button (owner: "Adjust the thinking
 * level… only four options: The default option, Low, High, Max"). A compact
 * Brain-icon button showing the current level; the menu offers EXACTLY the
 * four accepted levels. The selected level persists per session in
 * localStorage (acute-thinking:<sessionId> — handled by the panel) and rides
 * every send as thinkingLevel.
 */
export function ThinkingLevelButton({
  level,
  onChange,
}: {
  level: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
}) {
  const styles = useThemeStyles();
  const [open, setOpen] = useState(false);
  const menuRef = useDismiss(open, () => setOpen(false));
  const current = thinkingOption(level);

  return (
    <div className="relative shrink-0" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Thinking level: ${current.label}`}
        title={`Thinking level — ${current.description}`}
        className="flex items-center gap-1.5 h-7 px-2 rounded-[10px] text-[11px] font-semibold transition-colors"
        style={{ color: styles.textSecondary }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = styles.subtleHover;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        <Brain size={12} className="shrink-0" style={{ color: styles.accent }} />
        <span data-thinking-label>{current.label}</span>
        <ChevronDown size={10} className="shrink-0" />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Thinking level"
          className="absolute bottom-9 right-0 w-56 rounded-2xl border p-1.5 z-50"
          style={{ background: styles.card, borderColor: styles.border, boxShadow: styles.bentoShadow }}
        >
          {THINKING_OPTIONS.map((option) => {
            const isSelected = option.id === level;
            return (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                onClick={() => {
                  setOpen(false);
                  if (!isSelected) onChange(option.id);
                }}
                className="w-full flex items-center gap-2 text-left px-2 py-1.5 rounded-lg transition-colors"
                style={{
                  background: isSelected ? withAlpha(styles.accent, 0.09) : "transparent",
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) e.currentTarget.style.background = styles.subtleHover;
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) e.currentTarget.style.background = "transparent";
                }}
              >
                <span
                  className="text-[11.5px] font-bold min-w-0 flex-1"
                  style={{ color: isSelected ? styles.accent : styles.text }}
                >
                  {option.label}
                </span>
                <span className="text-[9.5px] min-w-0 truncate" style={{ color: styles.textTertiary }}>
                  {option.description}
                </span>
                {isSelected ? <Check size={11} className="shrink-0" style={{ color: styles.accent }} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
