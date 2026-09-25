import { useMemo, useState } from "react";
import { Check, FileText, Search } from "lucide-react";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import { filterProjectFiles } from "./composer-utils";

/**
 * ROUND-50 (R50-c2): Add Context → "Add project files…" — a searchable
 * multi-select picker over the project's files (the same flattened tree the
 * @ quick-picker uses). Confirm hands the chosen root-relative paths to the
 * composer, which reads them server-side (readAttachmentFiles with the
 * project id) and stages chips.
 */
export function ProjectFilePicker({
  files,
  isLoading,
  onConfirm,
  onCancel,
}: {
  files: readonly string[];
  isLoading: boolean;
  onConfirm: (paths: string[]) => void;
  onCancel: () => void;
}) {
  const styles = useThemeStyles();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const matches = useMemo(() => filterProjectFiles(files, query, 200), [files, query]);

  const toggle = (path: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="flex flex-col min-w-0" data-project-file-picker>
      <div className="flex items-center justify-between gap-2 px-2 pb-1.5 mb-1 border-b" style={{ borderColor: styles.borderSubtle }}>
        <span className="text-[10px] font-medium uppercase tracking-[0.08em]" style={{ color: styles.textTertiary }}>
          Project files
        </span>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Back to Add Context menu"
          // R126-3d-4: accent-as-TEXT rides the DEEP tier (TOKENS §1d).
          className="text-[10px] font-medium text-accent-deep"
        >
          Back
        </button>
      </div>
      <div className="flex items-center gap-1.5 px-1.5 pb-1.5">
        <Search size={11} className="shrink-0" style={{ color: styles.textTertiary }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
          aria-label="Search project files"
          placeholder="Filter files…"
          className="flex-1 min-w-0 bg-transparent outline-none text-[12px]"
          style={{ color: styles.text }}
        />
      </div>
      <div role="listbox" aria-label="Project files" aria-multiselectable className="max-h-56 overflow-y-auto auto-scroll px-1">
        {isLoading ? (
          <div className="text-[11px] px-2 py-1.5" style={{ color: styles.textTertiary }}>
            loading project files…
          </div>
        ) : matches.length === 0 ? (
          <div className="text-[11px] px-2 py-1.5" style={{ color: styles.textTertiary }}>
            {query === "" ? "no files found in this project" : "no files match"}
          </div>
        ) : (
          matches.map((path) => {
            const isSelected = selected.has(path);
            return (
              <button
                key={path}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => toggle(path)}
                title={path}
                className={`w-full flex items-center gap-1.5 text-left px-2 py-1.5 rounded-lg font-mono text-[10px] truncate transition-colors ${
                  // R126-3d-4: the selected row = accentTint + accentDeep
                  // ink (the pickers' selected-row grammar).
                  isSelected ? "bg-accent-tint text-accent-deep" : "hover:bg-hover text-muted"
                }`}
              >
                {isSelected ? (
                  <Check size={11} className="shrink-0 text-accent-deep" />
                ) : (
                  <FileText size={11} className="shrink-0" style={{ color: styles.textTertiary }} />
                )}
                <span className="min-w-0 flex-1 truncate">{path}</span>
              </button>
            );
          })
        )}
      </div>
      <button
        type="button"
        onClick={() => onConfirm([...selected])}
        disabled={selected.size === 0}
        aria-label={`Attach ${selected.size} project file${selected.size === 1 ? "" : "s"}`}
        className="mt-1.5 mx-1 h-7 rounded-lg text-[11px] font-semibold transition-colors bg-accent-deep disabled:bg-subtle disabled:cursor-not-allowed"
        // R126-3d-4: the quiet-solid accentDeep CTA (COMPONENTS §4 — the
        // class fill + the accentText INK on the JS leg; text-accent-text
        // is a PHANTOM utility). Disabled = bg-subtle + tertiary ink,
        // opacity intact.
        style={{ color: selected.size === 0 ? styles.textTertiary : styles.accentText }}
      >
        {selected.size === 0 ? "Select files" : `Attach ${selected.size} file${selected.size === 1 ? "" : "s"}`}
      </button>
    </div>
  );
}
