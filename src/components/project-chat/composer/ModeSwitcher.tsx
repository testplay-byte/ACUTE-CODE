import { useState } from "react";
import { Check, ChevronDown, ClipboardList, FileEdit, ShieldCheck, Zap } from "lucide-react";
import type { PermissionMode } from "shared";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import { withAlpha } from "../../dashboard/helpers";
import { MODE_OPTIONS, modeOption, useDismiss } from "./composer-utils";

const ICONS = {
  zap: Zap,
  shield: ShieldCheck,
  clipboard: ClipboardList,
  editor: FileEdit,
} as const;

/**
 * ROUND-50 (R50-c2): the permission-mode switcher (owner: "Switch between the
 * access I want to grant it. Full access… ask me before running any huge
 * changes… plan mode: no edits, only plan… [editor]: no commands or
 * terminals; can edit files; cannot delete without permission."). A segmented
 * dropdown button showing the current mode with an icon; the menu lists the
 * 4 modes. ROUND-75 (R75, owner: descriptions "should not be shown by
 * default… only when the user hovers"): each row renders its LABEL only —
 * the one-line description rides the row's native title tooltip. The PANEL
 * performs the patchSessionPermissions round-trip (optimistic + rollback) —
 * this component only reports the choice.
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
        aria-label={`Permission mode: ${current.label}`}
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
        <span data-mode-label className="@max-[560px]:hidden">
          {current.label}
        </span>
        <ChevronDown size={10} className="shrink-0" />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Permission mode"
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
