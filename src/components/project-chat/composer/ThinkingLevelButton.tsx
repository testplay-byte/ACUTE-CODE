import { Brain, Check, ChevronDown } from "lucide-react";
import type { ThinkingLevel } from "shared";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import { withAlpha } from "../../dashboard/helpers";
import { THINKING_OPTIONS, thinkingOption, useDismiss } from "./composer-utils";
import { useNativeOptionsMenu } from "./useNativeOptionsMenu";

/**
 * ROUND-50 (R50-c2): the thinking-level button (owner: "Adjust the thinking
 * level… only four options: The default option, Low, High, Max"). A compact
 * Brain-icon button showing the current level; the menu offers EXACTLY the
 * four accepted levels. The selected level persists per session in
 * localStorage (acute-thinking:<sessionId> — handled by the panel) and rides
 * every send as thinkingLevel.
 *
 * ROUND-92 (R92-A): inside the Tauri shell the menu opens in the MENU
 * OVERLAY WINDOW (useNativeOptionsMenu) — it rides ABOVE the OS-level
 * browser webview, so picking a level never blanks the embedded browser
 * (the DOM dropdown's w-56 right-aligned geometry used to cross into the
 * browser panel at the squeezed chat-column floor). The DOM dropdown below
 * is the web-mode / overlay-failed fallback, unchanged.
 */
export function ThinkingLevelButton({
  level,
  onChange,
}: {
  level: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
}) {
  const styles = useThemeStyles();
  // R92-A: the overlay-first ladder — `open` is the DOM leg only.
  const menu = useNativeOptionsMenu({
    title: "Thinking level",
    menuWidth: 224, // the DOM menu's w-56
    align: "right", // the DOM menu's right-0
    rowHeight: 42, // label + desc rows (quick-menu rhythm)
    buildItems: () =>
      THINKING_OPTIONS.map((option) => ({
        id: option.id,
        label: option.label,
        desc: option.description,
        selected: option.id === level,
      })),
    onPick: (id) => {
      const option = THINKING_OPTIONS.find((o) => o.id === id);
      if (option !== undefined && option.id !== level) onChange(option.id);
    },
  });
  const menuRef = useDismiss(menu.open, () => menu.closeAll());
  const current = thinkingOption(level);

  return (
    <div className="relative shrink-0" ref={menuRef}>
      <button
        type="button"
        onClick={() => menu.toggle(menuRef.current)}
        aria-haspopup="menu"
        aria-expanded={menu.isOpen}
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
        {/* R87-A1 staggered composer shrink — tier 2: the thinking label
            collapses (animated max-width + fade) one step AFTER the mode
            label (560px) at the 500px @container floor, so the pills fold in
            stages instead of all at once. -mr-1.5 on the collapsed tier
            shuts the span's gap slot so the icon-only pill stays tight. */}
        <span
          data-thinking-label
          className="max-w-[240px] overflow-hidden whitespace-nowrap transition-all duration-200 @max-[500px]:max-w-0 @max-[500px]:opacity-0 @max-[500px]:-mr-1.5"
        >
          {current.label}
        </span>
        <ChevronDown size={10} className="shrink-0" />
      </button>
      {/* R92-A: the DOM dropdown renders ONLY on the web/fallback leg (see
          ModeSwitcher's comment). */}
      {menu.open ? (
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
                  menu.closeAll();
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
