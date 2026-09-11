import { useState } from "react";
import { Check, ChevronDown, ClipboardList, ShieldCheck, Zap } from "lucide-react";
import type { PermissionMode } from "shared";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import { withAlpha } from "../../dashboard/helpers";
import { MODE_OPTIONS, modeOption, useDismiss } from "./composer-utils";

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
  const [open, setOpen] = useState(false);
  const menuRef = useDismiss(open, () => setOpen(false));
  const current = modeOption(mode);
  const Icon = ICONS[current.icon];

  return (
    <div className="relative shrink-0" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Operating mode: ${current.label}`}
        title={
          disabled
            ? current.description
            : `${current.label} — ${current.description}`
        }
        className="flex items-center gap-1.5 h-7 px-2 rounded-[10px] text-[11px] font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ color: styles.textSecondary }}
        onMouseEnter={(e) => {
          if (!disabled) e.currentTarget.style.background = styles.subtleHover;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        <Icon size={12} className="shrink-0" style={{ color: styles.accent }} />
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
      {open ? (
        <div
          role="menu"
          aria-label="Operating mode"
          className="absolute bottom-9 left-0 w-64 rounded-2xl border p-1.5 z-50"
          style={{ background: styles.card, borderColor: styles.border, boxShadow: styles.bentoShadow }}
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
                  setOpen(false);
                  if (!isSelected) onChange(option.id);
                }}
                className="w-full flex items-start gap-2 text-left px-2 py-1.5 rounded-lg transition-colors"
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
                <OptionIcon size={12} className="shrink-0 mt-0.5" style={{ color: styles.accent }} />
                <span className="min-w-0 flex-1 flex items-center gap-1">
                  <span
                    className="text-[11.5px] font-bold"
                    style={{ color: isSelected ? styles.accent : styles.text }}
                  >
                    {option.label}
                  </span>
                  {option.id === "ask" ? (
                    <span className="font-mono text-[9px] font-normal" style={{ color: styles.textTertiary }}>
                      default
                    </span>
                  ) : null}
                </span>
                {isSelected ? (
                  <Check size={12} className="shrink-0 mt-0.5" style={{ color: styles.accent }} />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
