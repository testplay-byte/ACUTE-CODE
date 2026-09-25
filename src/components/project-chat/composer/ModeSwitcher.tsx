import { Check, ChevronDown, ClipboardList, ShieldCheck, Zap } from "lucide-react";
import type { PermissionMode } from "shared";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import { MODE_OPTIONS, modeOption, useDismiss } from "./composer-utils";
import { useNativeOptionsMenu } from "./useNativeOptionsMenu";

const ICONS = {
  zap: Zap,
  shield: ShieldCheck,
  clipboard: ClipboardList,
} as const;

/**
 * ROUND-50 (R50-c2) / ROUND-81 (the unified mode picker): THE mode selector
 * — one dropdown of exactly THREE operating modes (Full Access / Ask / Plan),
 * replacing the old 4-value permission switcher AND the R73 task-mode
 * picker. The owner: full access does everything without asks (the agent
 * decides how to work and switches postures itself); ask gates important
 * commands/changes on the owner; plan is read-only research. ROUND-75 (R75,
 * owner: descriptions "should not be shown by default… only when the user
 * hovers"): each row renders its LABEL only — the one-line description
 * rides the row's native title tooltip. The PANEL performs the
 * patchSessionPermissions round-trip (optimistic + rollback) — this
 * component only reports the choice.
 *
 * ROUND-92 (R92-A — the owner: tapping "the plan mode, full access mode, or
 * ask mode" cleared out the embedded browser): inside the Tauri shell the
 * menu opens in the MENU OVERLAY WINDOW (useNativeOptionsMenu) so it rides
 * ABOVE the OS-level browser webview and the browser never pauses; the DOM
 * dropdown below is the web-mode / overlay-failed fallback, unchanged from
 * before R92 (its w-64 geometry is what used to blank the browser at the
 * squeezed chat-column floor — see the hook's header).
 */
export function ModeSwitcher({
  mode,
  disabled,
  onChange,
}: {
  mode: PermissionMode;
  disabled: boolean;
  onChange: (mode: PermissionMode) => void;
}) {
  const styles = useThemeStyles();
  // R92-A: the overlay-first ladder — `open` is the DOM leg only.
  const menu = useNativeOptionsMenu({
    title: "Operating mode",
    menuWidth: 256, // the DOM menu's w-64
    align: "left", // the DOM menu's left-0
    rowHeight: 30, // label-only rows (R75: no descriptions by default)
    buildItems: () =>
      MODE_OPTIONS.map((option) => ({
        id: option.id,
        label: option.label,
        icon: option.icon,
        selected: option.id === mode,
      })),
    onPick: (id) => {
      const option = MODE_OPTIONS.find((o) => o.id === id);
      if (option !== undefined && option.id !== mode) onChange(option.id);
    },
  });
  const menuRef = useDismiss(menu.open, () => menu.closeAll());
  const current = modeOption(mode);
  const Icon = ICONS[current.icon];

  return (
    <div className="relative shrink-0" ref={menuRef}>
      <button
        type="button"
        onClick={() => menu.toggle(menuRef.current)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={menu.isOpen}
        aria-label={`Operating mode: ${current.label}`}
        title={
          disabled
            ? current.description
            : `${current.label} — ${current.description}`
        }
        className="flex items-center gap-1.5 h-7 px-2 rounded-lg border border-clay-rim bg-well text-muted text-[12px] font-semibold transition-colors duration-100 hover:border-accent hover:bg-accent-tint disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:border-clay-rim"
      >
        <Icon size={12} className="shrink-0 text-accent" />
        {/* R87-A1 (owner: "when I make it smaller, at a point every single
            thing becomes minimized… it should smoothly be handled"): the
            label COLLAPSES (animated max-width + fade) instead of hard-
            hiding. Tier 1 of the staggered composer shrink — the mode label
            is the widest text, so it goes FIRST at the 560px @container
            floor; thinking follows at 500px; the model label never hides,
            it just narrows (240 → 170 → 90px). The collapsed tier also
            pulls the span's own gap-1.5 slot shut (-mr-1.5) so the
            icon-only pill doesn't keep a dead 12px gap where the label
            used to sit. */}
        <span
          data-mode-label
          className="max-w-[240px] overflow-hidden whitespace-nowrap transition-all duration-200 @max-[560px]:max-w-0 @max-[560px]:opacity-0 @max-[560px]:-mr-1.5"
        >
          {current.label}
        </span>
        <ChevronDown size={10} className="shrink-0" />
      </button>
      {/* R92-A: the DOM dropdown renders ONLY on the web/fallback leg —
          while the overlay window is the menu a hidden duplicate here would
          fire the overlay guard and blank the browser (the bug this round
          fixes). */}
      {menu.open ? (
        <div
          role="menu"
          aria-label="Operating mode"
          // R126-3d-4: the flyout = the clay card (card + rim + .ac-clay-sm
          // — the small-surface shadow step; the bentoShadow/border JS legs
          // retired).
          className="absolute bottom-9 left-0 w-64 rounded-2xl border border-clay-rim bg-card p-1.5 z-50 ac-clay-sm"
        >
          {MODE_OPTIONS.map((option) => {
            const OptionIcon = ICONS[option.icon];
            const isSelected = option.id === mode;
            return (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                title={option.description}
                onClick={() => {
                  menu.closeAll();
                  if (!isSelected) onChange(option.id);
                }}
                className={`w-full flex items-start gap-2 text-left px-2 py-1.5 rounded-lg transition-colors ${
                  isSelected ? "bg-accent-tint" : "hover:bg-hover"
                }`}
              >
                <OptionIcon size={12} className="shrink-0 mt-0.5 text-accent" />
                <span className="min-w-0 flex-1 flex items-center gap-1">
                  <span
                    // R126-3d-4: the selected row = accentTint + accentDeep
                    // ink (the pickers' selected-row grammar); the JS color
                    // ternary is gone.
                    className={`text-[12px] font-medium ${
                      isSelected ? "text-accent-deep" : "text-muted"
                    }`}
                  >
                    {option.label}
                  </span>
                  {option.id === "ask" ? (
                    <span className="font-mono text-[10px] font-normal" style={{ color: styles.textTertiary }}>
                      default
                    </span>
                  ) : null}
                </span>
                {isSelected ? (
                  <Check size={12} className="shrink-0 mt-0.5 text-accent-deep" />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
