import { Brain, Check, ChevronDown } from "lucide-react";
import type { ModelReasoningSupport, ThinkingLevel } from "shared";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import { withAlpha } from "../../dashboard/helpers";
import {
  displayThinkingLevel,
  thinkingOption,
  thinkingMenuSpec,
  useDismiss,
} from "./composer-utils";
import { useNativeOptionsMenu } from "./useNativeOptionsMenu";

/**
 * ROUND-50 (R50-c2): the thinking-level button (owner: "Adjust the thinking
 * level… only four options: The default option, Low, High, Max"). A compact
 * Brain-icon button showing the current level; the menu offers EXACTLY the
 * accepted levels. The selected level persists per session in
 * localStorage (acute-thinking:<sessionId> — handled by the panel) and rides
 * every send as thinkingLevel.
 *
 * ROUND-92 (R92-A): inside the Tauri shell the menu opens in the MENU
 * OVERLAY WINDOW (useNativeOptionsMenu) — it rides ABOVE the OS-level
 * browser webview, so picking a level never blanks the embedded browser
 * (the DOM dropdown's w-56 right-aligned geometry used to cross into the
 * browser panel at the squeezed chat-column floor). The DOM dropdown below
 * is the web-mode / overlay-failed fallback, unchanged.
 *
 * ROUND-95 (R95-E, the owner: "The thinking level was supposed to be
 * model-specific… Our program should be able to properly detect the models'
 * thinking options, like which options it supports and such"): the menu is
 * now MODEL-AWARE via the optional `reasoningSupport` prop (Composer
 * resolves it for the CURRENT effective model from its provider's configured
 * rows — R95-B's detected capability blob):
 *  · null/absent (UNKNOWN) — the R50 classic four + an honest "capabilities
 *    unknown for this model" footer note (never blocked on a guess);
 *  · supported: false — the button renders DISABLED ("No thinking") with an
 *    honest tooltip; no menu at all (chat.ts injects no reasoning either);
 *  · supported: true — ONLY the rungs the model's own ladder holds, and a
 *    stored level the model doesn't support falls back VISUALLY to the
 *    nearest supported one (chat.ts maps the wire value anyway, the
 *    mapping is the safety net).
 *
 * ROUND-96 (R96-F, the owner: "I tested a model which supported high and
 * max but it apparently did not detect that properly and was showing the
 * default options. This should not happen. It needs to be improved and
 * handled better"): detection is VISIBLE — the footer note names its source
 * ("detected from provider: low, high, max", plus "model default: …" when
 * the provider publishes one), every rung rides VERBATIM (an X-High row
 * appears for xhigh-ladder models, Max only when the ladder holds max), and
 * the model's own default rung carries a quiet "default" mark so the owner
 * can see what the model would use on its own.
 */
export function ThinkingLevelButton({
  level,
  onChange,
  reasoningSupport = null,
}: {
  level: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
  /** ROUND-95 (R95-E): the CURRENT effective model's detected reasoning
   * capability (default null = unknown — the classic four). */
  reasoningSupport?: ModelReasoningSupport | null;
}) {
  const styles = useThemeStyles();
  // R95-E: the support-aware menu spec — options, footer note, and the
  // unsupported verdict all derive from ONE place (composer-utils).
  const spec = thinkingMenuSpec(reasoningSupport);
  const displayLevel = displayThinkingLevel(level, spec.options);
  const current = thinkingOption(displayLevel);

  // R92-A: the overlay-first ladder — `open` is the DOM leg only. R95-E: a
  // non-reasoning model never opens a menu at all (the button is disabled).
  const menu = useNativeOptionsMenu({
    title: "Thinking level",
    menuWidth: 224, // the DOM menu's w-56
    align: "right", // the DOM menu's right-0
    rowHeight: 42, // label + desc rows (quick-menu rhythm)
    buildItems: () => [
      ...spec.options.map((option) => ({
        id: option.id,
        label: option.label,
        // R96-F: the model's own default rung carries the quiet mark on the
        // OVERLAY leg too (desc suffix — the overlay payload has no footer
        // concept and its page is not this round's file set).
        desc:
          option.description +
          (option.id === spec.defaultRow && option.id !== "default" ? " · the model's default" : ""),
        selected: option.id === displayLevel,
      })),
      // R95-E: the honest footer note rides the OVERLAY leg as a desc-only
      // pseudo-row (the overlay payload has no footer concept and its page
      // is not this round's file set): an empty label + the note text, and
      // onPick ignores the unknown id — the menu just closes, nothing
      // changes. The DOM leg below renders a proper footer instead.
      ...(spec.note !== null && !spec.unsupported
        ? [{ id: "r95-thinking-note", label: "", desc: spec.note, selected: false }]
        : []),
    ],
    onPick: (id) => {
      const option = spec.options.find((o) => o.id === id);
      if (option !== undefined && option.id !== level) onChange(option.id);
    },
  });
  const menuRef = useDismiss(menu.open, () => menu.closeAll());

  // R95-E: the model takes no reasoning parameter — a disabled, honestly
  // labeled button (the Brain icon keeps the composer's toolbar rhythm).
  if (spec.unsupported) {
    return (
      <div className="relative shrink-0" ref={menuRef}>
        <button
          type="button"
          disabled
          aria-label="Thinking level: No thinking"
          title="This model does not support reasoning"
          className="flex items-center gap-1.5 h-7 px-2 rounded-[10px] text-[11px] font-semibold"
          style={{ color: styles.textTertiary }}
        >
          <Brain size={12} className="shrink-0" style={{ color: styles.textTertiary }} />
          <span
            data-thinking-label
            className="max-w-[240px] overflow-hidden whitespace-nowrap transition-all duration-200 @max-[500px]:max-w-0 @max-[500px]:opacity-0 @max-[500px]:-mr-1.5"
          >
            No thinking
          </span>
        </button>
      </div>
    );
  }

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
          ModeSwitcher's comment). R95-E: the rows come from the support-aware
          spec, and the note (when one exists) rides a small honest footer. */}
      {menu.open ? (
        <div
          role="menu"
          aria-label="Thinking level"
          className="absolute bottom-9 right-0 w-56 rounded-2xl border p-1.5 z-50"
          style={{ background: styles.card, borderColor: styles.border, boxShadow: styles.bentoShadow }}
        >
          {spec.options.map((option) => {
            const isSelected = option.id === displayLevel;
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
                  {/* R96-F: the model's own default rung — a quiet "default"
                      mark, never a shout. */}
                  {option.id === spec.defaultRow && option.id !== "default" ? (
                    <span
                      data-thinking-default-rung
                      className="ml-1.5 text-[9px] font-semibold uppercase tracking-wide"
                      style={{ color: styles.textTertiary }}
                    >
                      default
                    </span>
                  ) : null}
                </span>
                <span className="text-[9.5px] min-w-0 truncate" style={{ color: styles.textTertiary }}>
                  {option.description}
                </span>
                {isSelected ? <Check size={11} className="shrink-0" style={{ color: styles.accent }} /> : null}
              </button>
            );
          })}
          {/* R95-E → R96-F: the honest footer note — "capabilities unknown",
              "no discrete efforts listed", or (the owner's ask) the VISIBLE
              detection line naming the provider's ladder and its default.
              textTertiary, one small line, never a lie. */}
          {spec.note !== null ? (
            <div
              data-thinking-menu-note
              className="px-2 pt-1 pb-0.5 text-[9.5px] leading-tight"
              style={{ color: styles.textTertiary }}
            >
              {spec.note}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
