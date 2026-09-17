import { motion } from "framer-motion";
import { Database, Hash } from "lucide-react";
import { useProjectIndex } from "../../../hooks/use-project-index";
import { useProjectChatStore } from "../../../lib/project-chat-store";
import { ease } from "../../../lib/motion";
import { useThemeStyles } from "../../../lib/use-theme-styles";

/**
 * CodebasePanel (Round-28 WS-G2): a tree view of indexed symbols grouped by
 * file. Hidden by default; toggle via the "Show panels" popover in ChatTopBar
 * (when chatFocusMode is off, the 3-panel layout shows this panel).
 *
 * Owner R28 directive: "Implement proper project or such indexing so that
 * our model properly knows about the project, can manage it, can handle
 * things." This panel gives the USER the same codebase awareness the agent
 * gets via the prompt injection.
 */
export function CodebasePanel({ projectId }: { projectId: string }) {
  const styles = useThemeStyles();
  const selectFile = useProjectChatStore((s) => s.selectFile);
  const setCodeVisible = useProjectChatStore((s) => s.setCodeVisible);
  const { data: index, isLoading, isError } = useProjectIndex(projectId);

  if (isLoading) {
    return (
      <div className="h-full grid place-items-center" style={{ color: styles.textTertiary }}>
        <span className="text-[12px]">Loading index…</span>
      </div>
    );
  }
  if (isError) {
    return (
      <div className="h-full grid place-items-center" style={{ color: styles.textTertiary }}>
        <span className="text-[12px]">Index unavailable (sidecar unreachable).</span>
      </div>
    );
  }
  if (!index || index.totalSymbols === 0) {
    return (
      <div className="h-full grid place-items-center p-4 text-center" style={{ color: styles.textTertiary }}>
        <div className="flex flex-col items-center gap-2">
          <Database size={20} style={{ color: styles.textTertiary }} />
          <span className="text-[12px]">
            Project not indexed yet.
          </span>
          <span className="text-[11px]" style={{ color: styles.textTertiary }}>
            Ask the agent "index this project" or it will auto-index on the next turn.
          </span>
        </div>
      </div>
    );
  }

  // Group symbols by file
  const byFile = new Map<string, typeof index.topSymbols>();
  for (const s of index.topSymbols) {
    const list = byFile.get(s.path) ?? [];
    list.push(s);
    byFile.set(s.path, list);
  }
  const files = Array.from(byFile.entries()).sort(([a], [b]) => a.localeCompare(b));

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2, ease }}
      className="h-full flex flex-col"
      style={{ background: styles.card }}
    >
      {/* Header */}
      <div className="shrink-0 h-9 flex items-center justify-between px-3 border-b" style={{ borderColor: styles.border }}>
        {/* R100-D: the header kicker snaps — font-medium + tracking-[0.08em]
            (THE one tracking spelling; bold is off-law for chrome). */}
        <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em]" style={{ color: styles.textTertiary }}>
          <Database size={12} /> Codebase
        </span>
        {/* R100-D: numbers discipline — the counts chip goes tabular. */}
        <span className="text-[10px] font-mono tabular-nums" style={{ color: styles.textTertiary }}>
          {index.totalFiles}f · {index.totalSymbols}s
        </span>
      </div>
      {/* Symbol tree grouped by file */}
      <div className="flex-1 overflow-y-auto px-1.5 py-1.5" style={{ scrollbarWidth: "thin" }}>
        {files.map(([path, syms]) => (
          <div key={path} className="mb-1">
            <button
              onClick={() => { selectFile(path); setCodeVisible(true); }}
              // R100-D: rounded-[6px] → rounded-lg (the 8px scale step) + the
              // hover wash on the CSS-var leg (hover:bg-hover — the JS
              // onMouseEnter/onMouseLeave painting is gone, per TOKENS §6;
              // the no-op hover:bg-opacity-50 went with it).
              className="w-full text-left px-2 py-1 rounded-lg text-[11px] font-mono truncate hover:bg-hover transition-colors"
              style={{ color: styles.textSecondary }}
              title={path}
            >
              {path}
            </button>
            <div className="pl-3 flex flex-col gap-0.5">
              {syms.map((s, i) => (
                <button
                  key={`${s.symbol}-${i}`}
                  onClick={() => { selectFile(s.path); setCodeVisible(true); }}
                  // R100-D: rounded-[4px] → rounded-sm (the scale spelling of
                  // the same 4px) + the hover wash on the CSS-var leg.
                  className="w-full text-left px-1.5 py-0.5 rounded-sm text-[11px] flex items-center gap-1.5 hover:bg-hover transition-colors"
                  style={{ color: styles.text }}
                  title={`${s.kind} ${s.symbol} — line ${s.line}`}
                >
                  <Hash size={9} style={{ color: styles.accent }} className="shrink-0" />
                  <span className="truncate">{s.symbol}</span>
                  {/* R100-D: 9→10px (the type floor) for the kind chip. */}
                  <span className="ml-auto shrink-0 text-[10px] font-mono px-1 rounded" style={{ background: styles.subtle, color: styles.textTertiary }}>
                    {s.kind.slice(0, 4)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  );
}
