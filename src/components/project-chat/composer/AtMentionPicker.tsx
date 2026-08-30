import { FileText } from "lucide-react";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import { withAlpha } from "../../dashboard/helpers";

/**
 * ROUND-50 (R50-c2): the @ quick-picker — typing "@" in the composer's
 * textarea opens this small popup above the caret listing project files
 * filtered live by the text after the @ (up to ~8 rows). Enter/click
 * attaches the file (chip) and removes the @token; Esc closes (handled by
 * the Composer's keydown). Presentational — the Composer owns filtering +
 * highlight state so keyboard events stay in one place.
 */
export function AtMentionPicker({
  query,
  matches,
  highlighted,
  onHighlight,
  onPick,
}: {
  /** The live text after the @ (shown in the header). */
  query: string;
  matches: readonly string[];
  /** 0-based highlighted row (Enter attaches this one). */
  highlighted: number;
  onHighlight: (index: number) => void;
  onPick: (path: string) => void;
}) {
  const styles = useThemeStyles();
  return (
    <div
      role="listbox"
      aria-label="Mention a project file"
      data-at-mention-picker
      className="absolute bottom-full left-2 mb-1.5 w-72 max-w-[calc(100%-1rem)] rounded-2xl border p-1.5 z-50"
      style={{ background: styles.card, borderColor: styles.border, boxShadow: styles.bentoShadow }}
    >
      <div className="px-2 pb-1.5 mb-1 border-b font-mono text-[9.5px]" style={{ borderColor: styles.borderSubtle, color: styles.textTertiary }}>
        @ {query}
      </div>
      <div className="max-h-52 overflow-y-auto auto-scroll">
        {matches.map((path, i) => (
          <button
            key={path}
            type="button"
            role="option"
            aria-selected={i === highlighted}
            onClick={() => onPick(path)}
            onMouseEnter={() => onHighlight(i)}
            title={path}
            className="w-full flex items-center gap-1.5 text-left px-2 py-1.5 rounded-lg font-mono text-[10.5px] truncate transition-colors"
            style={{
              color: styles.textSecondary,
              background: i === highlighted ? withAlpha(styles.accent, 0.1) : "transparent",
            }}
          >
            <FileText size={11} className="shrink-0" style={{ color: i === highlighted ? styles.accent : styles.textTertiary }} />
            <span className="min-w-0 flex-1 truncate">{path}</span>
          </button>
        ))}
      </div>
      <div className="px-2 pt-1 font-mono text-[9px]" style={{ color: styles.textTertiary }}>
        ↵ attach · esc close
      </div>
    </div>
  );
}
