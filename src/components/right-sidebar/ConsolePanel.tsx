import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { Activity, Copy, LoaderCircle, RefreshCw, Trash2, X } from "lucide-react";
import {
  clearDiagnosticErrors,
  listDiagnosticErrors,
  type DiagnosticError,
} from "../../lib/api";
import { clearAll, dismiss, errors, subscribe, type AppError } from "../../lib/error-bus";
import { formatWhen } from "../../lib/format";
import type { RightSidebarTab } from "../../lib/right-sidebar-store";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useScrollFade } from "../../lib/useScrollFade";
import { ease } from "../../lib/motion";
import { withAlpha } from "../dashboard/helpers";
import { ClampedText } from "../shared/ClampedText";

/**
 * ROUND-59 (R59-E) right-sidebar CONSOLE tab — the visible half of the
 * diagnostics system (owner: "proper console-like error monitoring and error
 * handling… If there are any errors along the way then you can easily detect
 * them by yourself").
 *
 * ONE list, newest-first, merging BOTH halves of the system:
 *   - the FRONTEND error bus (src/lib/error-bus.ts — window.onerror,
 *     unhandledrejection, render boundary, query failures; live via
 *     useSyncExternalStore over the bus's subscribe/errors);
 *   - the ENGINE ring (GET /diagnostics/errors, 5s polling — the sidecar's
 *     thrown ≥500 errors).
 *
 * Every row: colored source/kind chip, mono message, timestamp, ×count badge
 * when identical errors piled up, click-to-expand detail + component stack,
 * hover-revealed Copy (full formatted entry) and per-row dismiss. Header
 * actions: Refresh, Copy all, Clear all (DELETEs the engine ring AND empties
 * the frontend bus). Empty state says exactly what this console watches.
 */

/** The merged view-model both halves normalize into. */
interface ConsoleEntry {
  id: string;
  /** Epoch ms (sidecar ISO parsed). */
  ts: number;
  source: "frontend" | "sidecar";
  kind: string;
  message: string;
  detail?: string;
  componentStack?: string;
  count: number;
}

/** Sidecar ring row → ConsoleEntry (detail = the request context line). */
function toConsoleEntry(row: DiagnosticError): ConsoleEntry {
  const ts = Date.parse(row.ts);
  return {
    id: row.id,
    ts: Number.isNaN(ts) ? 0 : ts,
    source: "sidecar",
    kind: row.kind,
    message: row.message,
    detail: `${row.method} ${row.url} → HTTP ${row.statusCode} (${row.code})`,
    count: row.count,
  };
}

/** Frontend bus row → ConsoleEntry (identity mapping). */
function fromBusEntry(row: AppError): ConsoleEntry {
  return {
    id: row.id,
    ts: row.ts,
    source: row.source,
    kind: row.kind,
    message: row.message,
    detail: row.detail,
    componentStack: row.componentStack,
    count: row.count,
  };
}

/** The Copy/Copy-all payload: one formatted block per entry. */
function formatEntry(entry: ConsoleEntry): string {
  return [
    `[${new Date(entry.ts).toISOString()}] ${entry.source}/${entry.kind}${
      entry.count > 1 ? ` (×${entry.count})` : ""
    }`,
    entry.message,
    entry.detail ?? "",
    entry.componentStack ?? "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Source chip colors — documented exception like MemoryPanel's KIND_COLORS:
 * they carry source meaning across every theme/mode. Frontend = data blue
 * (the app's own code), sidecar = danger red (the engine itself failed).
 */
const SOURCE_COLORS: Record<ConsoleEntry["source"], string> = {
  frontend: "#82aaff",
  sidecar: SEMANTIC_COLORS.danger,
};

export function ConsolePanel({ projectId, tab }: { projectId: string; tab: RightSidebarTab }) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();

  // The frontend half: live subscription to the error bus (stable snapshot —
  // the bus hands back the same array until the next mutation).
  const busSnapshot = useSyncExternalStore(subscribe, () => errors());

  // The engine half: 5s polling (the MemoryPanel/SubAgentPanel cadence).
  const sidecarQuery = useQuery({
    queryKey: ["diagnostics-errors"],
    queryFn: () => listDiagnosticErrors(50),
    staleTime: 2_000,
    refetchInterval: 5_000,
  });

  // Per-row dismissal for SIDEcar rows: the engine ring only supports a full
  // clear, so dismissal is a panel-local filter (frontend rows dismiss in the
  // bus itself — dismissal survives remounts there).
  const [dismissedSidecarIds, setDismissedSidecarIds] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  const sidecarErrors = sidecarQuery.data ?? [];
  const entries = useMemo<ConsoleEntry[]>(() => {
    const merged = [
      ...busSnapshot.map(fromBusEntry),
      ...sidecarErrors.filter((e) => !dismissedSidecarIds.has(e.id)).map(toConsoleEntry),
    ];
    merged.sort((a, b) => b.ts - a.ts);
    return merged;
  }, [busSnapshot, sidecarErrors, dismissedSidecarIds]);

  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollFade(scrollRef);

  const onDismissRow = (entry: ConsoleEntry) => {
    if (entry.source === "frontend") {
      dismiss(entry.id);
    } else {
      setDismissedSidecarIds((prev) => {
        const next = new Set(prev);
        next.add(entry.id);
        return next;
      });
    }
    if (expandedId === entry.id) setExpandedId(null);
  };

  /** Clear all — BOTH halves: DELETE the engine ring, empty the frontend bus. */
  const onClearAll = async () => {
    if (clearing) return;
    setClearing(true);
    setClearError(null);
    try {
      await clearDiagnosticErrors();
    } catch (err) {
      // Engine unreachable — say so, but still clear the frontend half (the
      // console must never wedge on a dead engine).
      setClearError(
        err instanceof Error ? err.message : "Could not clear the engine error ring.",
      );
    } finally {
      clearAll();
      setDismissedSidecarIds(new Set());
      setExpandedId(null);
      setClearing(false);
      await queryClient.invalidateQueries({ queryKey: ["diagnostics-errors"] });
    }
  };

  const onCopyAll = async () => {
    try {
      await navigator.clipboard.writeText(entries.map(formatEntry).join("\n\n"));
    } catch {
      // Clipboard unavailable (permissions/context) — nothing to fall back to.
    }
  };

  const onCopyRow = async (entry: ConsoleEntry) => {
    try {
      await navigator.clipboard.writeText(formatEntry(entry));
    } catch {
      // Same as copy-all: silent on clipboard failure.
    }
  };

  const showLoadSpinner = sidecarQuery.isPending && entries.length === 0;
  const showSidecarError =
    sidecarQuery.isError &&
    (entries.length > 0 || busSnapshot.length > 0 || sidecarErrors.length > 0);

  return (
    <div
      className="h-full flex flex-col min-h-0"
      data-testid="console-panel"
      data-tab-id={tab.id}
      data-project-id={projectId}
    >
      {/* ── Panel header: label + live count + actions ── */}
      <div
        className="shrink-0 flex items-center gap-2 px-3 h-9 border-b"
        style={{ borderColor: styles.border, background: styles.isDark ? "rgba(0,0,0,0.18)" : styles.subtle }}
      >
        <Activity size={13} style={{ color: styles.accent }} className="shrink-0" />
        <div className="flex-1 min-w-0 truncate text-[11.5px] font-semibold" style={{ color: styles.text }}>
          Console
        </div>
        <span
          className="shrink-0 text-[9.5px] font-mono font-bold uppercase px-1.5 py-0.5 rounded-md"
          style={{ color: styles.textTertiary, background: withAlpha(styles.textTertiary, 0.1) }}
          data-testid="console-count"
        >
          {entries.length} errors
        </span>
        {/* Refresh: re-poll the engine ring now (frontend half is live). */}
        <button
          onClick={() => void sidecarQuery.refetch()}
          aria-label="Refresh engine errors"
          title="Refresh engine errors"
          className="w-5 h-5 grid place-items-center rounded shrink-0 transition-colors"
          style={{ color: styles.textTertiary }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = withAlpha(styles.accent, 0.12);
            e.currentTarget.style.color = styles.accent;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = styles.textTertiary;
          }}
        >
          <RefreshCw size={11} />
        </button>
        {/* Copy all: every visible entry, formatted. */}
        <button
          onClick={() => void onCopyAll()}
          aria-label="Copy all entries"
          title="Copy all entries"
          disabled={entries.length === 0}
          className="w-5 h-5 grid place-items-center rounded shrink-0 transition-colors disabled:opacity-40"
          style={{ color: styles.textTertiary }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = withAlpha(styles.accent, 0.12);
            e.currentTarget.style.color = styles.accent;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = styles.textTertiary;
          }}
        >
          <Copy size={11} />
        </button>
        {/* Clear all: BOTH halves (engine DELETE + frontend bus). */}
        <button
          onClick={() => void onClearAll()}
          aria-label="Clear all errors"
          title="Clear all errors (frontend + engine)"
          disabled={clearing || entries.length === 0}
          className="w-5 h-5 grid place-items-center rounded shrink-0 transition-colors disabled:opacity-40"
          style={{ color: styles.textTertiary }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = withAlpha(SEMANTIC_COLORS.danger, 0.12);
            e.currentTarget.style.color = SEMANTIC_COLORS.danger;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = styles.textTertiary;
          }}
        >
          {clearing ? <LoaderCircle size={11} className="animate-spin" /> : <Trash2 size={11} />}
        </button>
      </div>

      {/* ── Scrollable entry list ── */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto auto-scroll">
        {showLoadSpinner ? (
          <div className="py-10 flex flex-col items-center gap-2" style={{ color: styles.textTertiary }}>
            <LoaderCircle size={16} className="animate-spin" style={{ color: styles.accent }} />
            <span className="text-[11px]">Loading console…</span>
          </div>
        ) : sidecarQuery.isError && !showSidecarError ? (
          // Engine unreachable AND nothing to show from the frontend half —
          // the sibling error card (MemoryPanel's visual language).
          <div className="px-3 py-3">
            <div
              className="rounded-[12px] px-3 py-3 flex flex-col gap-2"
              style={{
                background: withAlpha(SEMANTIC_COLORS.danger, 0.08),
                border: `1px solid ${withAlpha(SEMANTIC_COLORS.danger, 0.3)}`,
              }}
            >
              <div className="flex items-center gap-1.5 text-[11px] font-bold" style={{ color: SEMANTIC_COLORS.danger }}>
                Couldn&apos;t load engine errors
              </div>
              <div className="text-[10.5px]" style={{ color: styles.textSecondary }}>
                {sidecarQuery.error instanceof Error
                  ? sidecarQuery.error.message
                  : "The sidecar didn't answer."}
              </div>
              <button
                onClick={() => void sidecarQuery.refetch()}
                className="self-start h-6 px-2.5 rounded-full text-[10px] font-bold inline-flex items-center gap-1.5"
                style={{ background: styles.card, color: styles.text, border: `1px solid ${styles.border}` }}
              >
                <RefreshCw size={10} /> Try again
              </button>
            </div>
          </div>
        ) : entries.length === 0 ? (
          <div className="h-full grid place-items-center px-6 text-center">
            <div className="max-w-[240px]">
              <div
                className="w-11 h-11 mx-auto mb-3 grid place-items-center rounded-2xl border-2 border-dashed"
                style={{ borderColor: styles.border, color: styles.textTertiary }}
              >
                <Activity size={18} />
              </div>
              <div className="text-[12px] font-medium" style={{ color: styles.textSecondary }}>
                No errors captured
              </div>
              <div className="text-[11px] mt-1.5 leading-[1.55]" style={{ color: styles.textTertiary }}>
                The console records frontend and engine errors as they happen.
              </div>
            </div>
          </div>
        ) : (
          <div className="px-2.5 py-2.5 flex flex-col gap-1.5" data-testid="console-entries">
            {clearError !== null || showSidecarError ? (
              <div
                className="rounded-[12px] px-3 py-2 text-[10.5px]"
                style={{ color: SEMANTIC_COLORS.danger, background: withAlpha(SEMANTIC_COLORS.danger, 0.08) }}
                role="alert"
                data-testid="console-sidecar-error-note"
              >
                {clearError ??
                  (sidecarQuery.error instanceof Error
                    ? sidecarQuery.error.message
                    : "The sidecar didn't answer.")}
              </div>
            ) : null}
            <AnimatePresence initial={false}>
              {entries.map((entry) => (
                <ConsoleRow
                  key={entry.id}
                  entry={entry}
                  expanded={expandedId === entry.id}
                  onToggle={() =>
                    setExpandedId((prev) => (prev === entry.id ? null : entry.id))
                  }
                  onCopy={() => void onCopyRow(entry)}
                  onDismiss={() => onDismissRow(entry)}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* ── Footer hint: what this console watches ── */}
      <div
        className="shrink-0 flex items-center gap-1.5 px-3 h-7 border-t text-[9.5px]"
        style={{ borderColor: styles.border, color: styles.textTertiary, background: styles.isDark ? "rgba(0,0,0,0.18)" : styles.subtle }}
      >
        <Activity size={10} style={{ color: styles.accent }} className="shrink-0" />
        <span className="truncate">Frontend + engine errors · live</span>
      </div>
    </div>
  );
}

/** One console row: source/kind chip, mono message, ts, ×count, expand,
 * hover Copy + dismiss. Clicking the row toggles the detail expansion. */
function ConsoleRow({
  entry,
  expanded,
  onToggle,
  onCopy,
  onDismiss,
}: {
  entry: ConsoleEntry;
  expanded: boolean;
  onToggle: () => void;
  onCopy: () => void;
  onDismiss: () => void;
}) {
  const styles = useThemeStyles();
  const color = SOURCE_COLORS[entry.source];
  const hasDetail = entry.detail !== undefined || entry.componentStack !== undefined;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -3 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.14, ease }}
      className="rounded-[12px] px-2.5 py-2 group relative"
      style={{
        background: styles.isDark ? "rgba(0,0,0,0.14)" : styles.card,
        border: `1px solid ${styles.border}`,
      }}
      data-testid="console-entry"
      data-entry-id={entry.id}
      data-entry-source={entry.source}
    >
      {/* Chip row: source+kind chip · ts · ×count badge */}
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="text-[9px] font-mono font-bold uppercase px-1.5 py-0.5 rounded-md shrink-0 max-w-[45%] truncate"
          style={{ color, background: withAlpha(color, 0.14) }}
          data-kind-chip={`${entry.source}/${entry.kind}`}
          title={`${entry.source} · ${entry.kind}`}
        >
          {entry.source}/{entry.kind}
        </span>
        <span
          className="text-[9.5px] shrink-0"
          style={{ color: styles.textTertiary }}
          title={new Date(entry.ts).toISOString()}
        >
          {formatWhen(new Date(entry.ts).toISOString())}
        </span>
        {entry.count > 1 ? (
          <span
            className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-md shrink-0"
            style={{ color: SEMANTIC_COLORS.danger, background: withAlpha(SEMANTIC_COLORS.danger, 0.12) }}
            data-testid="console-entry-count"
            title={`fired ${entry.count} times`}
          >
            ×{entry.count}
          </span>
        ) : null}
        <span className="flex-1" />
        {/* Hover-revealed row actions: copy + dismiss. */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onCopy();
          }}
          aria-label={`Copy error: ${entry.message.slice(0, 60)}`}
          title="Copy this entry"
          className="w-5 h-5 grid place-items-center rounded shrink-0 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
          style={{ color: styles.textTertiary }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = withAlpha(styles.accent, 0.12);
            e.currentTarget.style.color = styles.accent;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = styles.textTertiary;
          }}
        >
          <Copy size={11} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          aria-label={`Dismiss error: ${entry.message.slice(0, 60)}`}
          title="Dismiss this entry"
          className="w-5 h-5 grid place-items-center rounded shrink-0 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
          style={{ color: styles.textTertiary }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = withAlpha(SEMANTIC_COLORS.danger, 0.12);
            e.currentTarget.style.color = SEMANTIC_COLORS.danger;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = styles.textTertiary;
          }}
        >
          <X size={11} />
        </button>
      </div>
      {/* The message — mono, clamped; click anywhere on the card expands. */}
      <div
        onClick={hasDetail ? onToggle : undefined}
        className={hasDetail ? "cursor-pointer" : undefined}
        role={hasDetail ? "button" : undefined}
        aria-expanded={hasDetail ? expanded : undefined}
        aria-label={hasDetail ? `Toggle detail: ${entry.message.slice(0, 60)}` : undefined}
      >
        <ClampedText
          text={entry.message}
          lines={expanded ? 200 : 3}
          className="text-[11px] font-mono leading-[1.55] whitespace-pre-wrap break-words pr-1"
          style={{ color: styles.text }}
        />
      </div>
      {/* Expanded detail: full detail + component stack in a <pre>. */}
      {expanded ? (
        <pre
          data-testid="console-entry-detail"
          className="mt-1.5 max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-[8px] px-2 py-1.5 text-[10px] font-mono leading-[1.5] custom-scrollbar"
          style={{ background: styles.isDark ? "rgba(0,0,0,0.2)" : styles.subtle, color: styles.textSecondary }}
        >
          {[entry.detail, entry.componentStack].filter((s) => s !== undefined).join("\n\n") ||
            "(no detail)"}
        </pre>
      ) : null}
    </motion.div>
  );
}
