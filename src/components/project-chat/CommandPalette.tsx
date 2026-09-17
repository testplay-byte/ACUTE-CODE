import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { FileCode2, Hash, Search, X } from "lucide-react";
import { searchProject } from "../../lib/api";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";

/**
 * CommandPalette (Round-28 WS-H): the ⌘K search popover. Opens on Cmd/Ctrl+K.
 * Three search modes: Files (filename substring), Symbols (codebase index
 * prefix match), Content (grep over file contents). Clicking a result opens
 * the file in CodeView (flips chatFocusMode off → 3-panel layout).
 *
 * Owner R28 directive: "Utilize advanced searching techniques too, like a
 * grep or other kinds of things."
 *
 * Built with existing primitives (motion + input + a results list) — no new
 * cmdk dependency (6-f R-H3 flagged pnpm install time growth). The dialog
 * is a fixed-position card; Escape closes.
 */
export function CommandPalette({
  open,
  onClose,
  projectId,
  onPickFile,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string | null;
  onPickFile: (path: string, line?: number) => void;
}) {
  const styles = useThemeStyles();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"files" | "symbols" | "content">("symbols");
  const [results, setResults] = useState<string>("");
  const [loading, setLoading] = useState(false);

  // Auto-focus + clear on open
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (!open || !projectId || query.trim().length < 2) {
      setResults("");
      return;
    }
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const res = await searchProject(projectId, query.trim(), mode, { maxResults: 30 });
        const r = res.results as string;
        setResults(typeof r === "string" ? r : "");
      } catch {
        setResults("");
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [open, projectId, query, mode]);

  // ⌘K + Escape handlers (global)
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const parsed = useMemo(() => {
    if (!results) return [] as Array<{ path: string; line?: number; text?: string }>;
    return results
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        // Format: "path:line: text" (content mode) or "path" (files mode)
        // or "symbol\tpath\tline\tkind" (symbols mode returns objects, but
        // the stringified form varies; handle the path:line: format)
        const m = line.match(/^([^:]+):(\d+):\s*(.*)$/);
        if (m) return { path: m[1], line: parseInt(m[2], 10), text: m[3] };
        return { path: line };
      });
  }, [results]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]"
          style={{ background: "rgba(0,0,0,0.4)" }}
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="w-full max-w-[640px] mx-4 rounded-2xl border-[1.5px] overflow-hidden shadow-2xl"
            style={{ background: styles.card, borderColor: styles.border, boxShadow: styles.bentoShadowSm }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Search input */}
            <div className="flex items-center gap-2.5 px-3.5 h-12 border-b" style={{ borderColor: styles.border }}>
              <Search size={15} style={{ color: styles.textTertiary }} />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={mode === "symbols" ? "Search symbols (useThemeStyles, greet, Agent)…" : mode === "files" ? "Search files (*.ts, Sidebar, AgentChatPanel)…" : "Search content (grep — where is X used?)…"}
                className="flex-1 min-w-0 bg-transparent outline-none text-[13px]"
                style={{ color: styles.text }}
              />
              <button onClick={onClose} aria-label="Close palette" className="w-6 h-6 rounded-md grid place-items-center" style={{ color: styles.textTertiary }}>
                <X size={14} />
              </button>
            </div>
            {/* Mode tabs */}
            <div className="flex items-center gap-1 px-2.5 py-1.5 border-b" style={{ borderColor: styles.border }}>
              {(["symbols", "files", "content"] as const).map((m) => {
                const Icon = m === "symbols" ? Hash : m === "files" ? FileCode2 : Search;
                const active = mode === m;
                return (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    aria-pressed={active}
                    // R100-D: rounded-[8px] → rounded-lg; the segmented pills
                    // are 500 (the toolbar idiom — bold is off-law in chrome).
                    className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] font-medium capitalize transition-colors hover:bg-hover"
                    style={{
                      // R100-D: the inactive pills leave background to the
                      // hover class (inline "transparent" would beat it).
                      background: active ? withAlpha(styles.accent, 0.12) : undefined,
                      color: active ? styles.accent : styles.textTertiary,
                    }}
                  >
                    <Icon size={11} /> {m}
                  </button>
                );
              })}
            </div>
            {/* Results */}
            <div className="max-h-[50vh] overflow-y-auto py-1" style={{ scrollbarWidth: "thin" }}>
              {loading ? (
                <div className="px-3.5 py-3 text-[12px]" style={{ color: styles.textTertiary }}>Searching…</div>
              ) : parsed.length === 0 ? (
                query.trim().length < 2 ? (
                  <div className="px-3.5 py-3 text-[12px]" style={{ color: styles.textTertiary }}>Type 2+ characters to search.</div>
                ) : (
                  <div className="px-3.5 py-3 text-[12px]" style={{ color: styles.textTertiary }}>No results.</div>
                )
              ) : (
                parsed.map((r, i) => (
                  <button
                    key={`${r.path}-${i}`}
                    onClick={() => onPickFile(r.path, r.line)}
                    // R100-D (TOKENS §6): the hover wash is the CSS class
                    // (hover:bg-hover — the CSS-var leg; no JS painting).
                    className="w-full flex items-center gap-2 px-3.5 py-2 text-left transition-colors hover:bg-hover"
                  >
                    {r.line !== undefined ? (
                      <Hash size={11} style={{ color: styles.accent }} className="shrink-0" />
                    ) : (
                      <FileCode2 size={11} style={{ color: styles.textTertiary }} className="shrink-0" />
                    )}
                    <span className="font-mono text-[11px] truncate" style={{ color: styles.textSecondary }}>
                      {r.path}{r.line !== undefined ? `:${r.line}` : ""}
                    </span>
                    {r.text !== undefined && (
                      <span className="ml-auto truncate text-[11px]" style={{ color: styles.textTertiary }}>
                        {r.text.slice(0, 60)}
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
            {/* Footer hint */}
            <div className="flex items-center justify-between px-3.5 h-8 border-t text-[10px]" style={{ borderColor: styles.border, color: styles.textTertiary }}>
              <span>⌘K to toggle · Esc to close</span>
              <span>{mode === "symbols" ? "from codebase index" : mode === "content" ? "grep over files" : "filename substring"}</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
