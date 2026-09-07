import { useState } from "react";
import {
  Bug,
  Check,
  ChevronDown,
  ClipboardList,
  Compass,
  FileSearch,
  Hammer,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { TaskModeInfo } from "../../../lib/api";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import { withAlpha } from "../../dashboard/helpers";
import { useDismiss } from "./composer-utils";

/** Row icons per KNOWN builtin mode id (ModeSwitcher's ICONS pattern) — the
 * trigger itself is the Compass (the agent's operating posture = heading);
 * customs fall back to the same Compass. Note: the Check icon is RESERVED
 * for the selected-row marker, so no row icon may be Check. */
const MODE_ICONS: Record<string, LucideIcon> = {
  plan: ClipboardList,
  debug: Bug,
  build: Hammer,
  review: FileSearch,
  explore: Compass,
  refactor: Wrench,
};

const rowIcon = (id: string): LucideIcon => MODE_ICONS[id] ?? Compass;

/** The pill label when NO mode is active (the picker's "Auto" state). */
const AUTO_LABEL = "Mode: Auto";

/**
 * ROUND-73 (R73-c): the TASK-MODE picker — the user-side access path to the
 * posture tier (R73-a's modes.ts core, R73-b's GET /projects/:id/modes +
 * PATCH /sessions/:id activeMode). Sibling of ModeSwitcher in the composer's
 * left toolbar cluster: the permission switcher grants ACCESS (which tools
 * may run), this sets the POSTURE (how the agent holds itself for a class of
 * work — plan/debug/build/review/explore/refactor, or project
 * .acute/agents/*.md customs).
 *
 * A compact pill button: Compass icon + the ACTIVE mode's name (e.g. "Debug")
 * or "Mode: Auto" when none (no posture module active — the agent picks its
 * posture per request). The dropdown lists "Auto (no mode)" first (clears),
 * then one row per mode with its trigger-rich description (clamped to two
 * lines, the full text on the row's title), the current mode Check-marked,
 * and a subtle "custom" chip for source === "file".
 *
 * The PANEL (AgentChatPanel) owns the modes query + the
 * patchSessionActiveMode round-trip (optimistic + rollback) and disables the
 * pill while a turn runs or a PATCH is in flight — this component only
 * REPORTS the choice (the /mode slash command is its keyboard sibling,
 * handled at the panel's send entry).
 */
export function TaskModePicker({
  modes,
  activeMode,
  disabled,
  onChange,
}: {
  /** GET /projects/:id/modes rows (metadata only — bodies are prompt-side). */
  modes: TaskModeInfo[];
  /** The session's active mode id, or null (Auto). */
  activeMode: string | null;
  /** Disabled while demo mode / a turn is running / a PATCH is in flight. */
  disabled: boolean;
  /** Reports the picked mode id (null = clear to Auto). The panel PATCHes. */
  onChange: (mode: string | null) => Promise<void> | void;
}) {
  const styles = useThemeStyles();
  const [open, setOpen] = useState(false);
  const menuRef = useDismiss(open, () => setOpen(false));
  const active = activeMode !== null ? modes.find((m) => m.id === activeMode) ?? null : null;
  // Honest label: the active mode's NAME, the raw id while the list loads (or
  // for a vanished custom — the backend sweeps it clear on the next turn),
  // "Mode: Auto" only when truly no mode is active.
  const label =
    active !== null ? active.name : activeMode !== null ? activeMode : AUTO_LABEL;

  return (
    <div className="relative shrink-0" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Task mode: ${active !== null ? active.name : activeMode ?? "Auto"}`}
        title={
          active !== null
            ? `${active.name} — task mode active: its posture guide rides the agent's system prompt. ${active.description}`
            : activeMode !== null
              ? `${activeMode} — this task mode is no longer in the project's mode list; it clears on the next turn.`
              : "Auto — no task mode active; the agent picks its posture per request."
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
        <Compass size={12} className="shrink-0" style={{ color: styles.accent }} />
        <span data-task-mode-label>{label}</span>
        <ChevronDown size={10} className="shrink-0" />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Task mode"
          className="absolute bottom-9 left-0 w-72 max-h-[320px] overflow-y-auto rounded-2xl border p-1.5 z-50"
          style={{ background: styles.card, borderColor: styles.border, boxShadow: styles.bentoShadow }}
        >
          {/* Auto first — the clear option (aria-checked mirrors ModeSwitcher). */}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={activeMode === null}
            title="No task mode active — the agent picks its posture per request."
            onClick={() => {
              setOpen(false);
              if (activeMode !== null) onChange(null);
            }}
            className="w-full flex items-start gap-2 text-left px-2 py-1.5 rounded-lg transition-colors"
            style={{
              background: activeMode === null ? withAlpha(styles.accent, 0.09) : "transparent",
            }}
            onMouseEnter={(e) => {
              if (activeMode !== null) e.currentTarget.style.background = styles.subtleHover;
            }}
            onMouseLeave={(e) => {
              if (activeMode !== null) e.currentTarget.style.background = "transparent";
            }}
          >
            <Compass size={12} className="shrink-0 mt-0.5" style={{ color: styles.accent }} />
            <span className="min-w-0 flex-1">
              <span
                className="flex items-center gap-1 text-[11.5px] font-bold"
                style={{ color: activeMode === null ? styles.accent : styles.text }}
              >
                Auto (no mode)
              </span>
              <span className="block text-[10.5px] leading-snug" style={{ color: styles.textTertiary }}>
                The agent picks its posture per request.
              </span>
            </span>
            {activeMode === null ? (
              <Check size={12} className="shrink-0 mt-0.5" style={{ color: styles.accent }} />
            ) : null}
          </button>
          {modes.map((mode) => {
            const RowIcon = rowIcon(mode.id);
            const isSelected = mode.id === activeMode;
            return (
              <button
                key={mode.id}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                title={mode.description}
                onClick={() => {
                  setOpen(false);
                  if (!isSelected) onChange(mode.id);
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
                <RowIcon size={12} className="shrink-0 mt-0.5" style={{ color: styles.accent }} />
                <span className="min-w-0 flex-1">
                  <span
                    className="flex items-center gap-1 text-[11.5px] font-bold"
                    style={{ color: isSelected ? styles.accent : styles.text }}
                  >
                    {mode.name}
                    {mode.source === "file" ? (
                      <span
                        className="font-mono text-[9px] font-normal uppercase"
                        style={{ color: styles.textTertiary }}
                      >
                        custom
                      </span>
                    ) : null}
                  </span>
                  {/* Trigger-rich descriptions are long — clamp to ~2 lines
                      (the full text rides the row's title tooltip). */}
                  <span
                    className="block text-[10.5px] leading-snug line-clamp-2 break-words"
                    style={{ color: styles.textTertiary }}
                  >
                    {mode.description}
                  </span>
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
