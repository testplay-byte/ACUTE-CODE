import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { Brain, LoaderCircle, RefreshCw, Trash2, Zap } from "lucide-react";
import { deleteProjectMemory, listProjectMemory, type ProjectMemory } from "../../lib/api";
import { formatWhen } from "../../lib/format";
import type { RightSidebarTab } from "../../lib/right-sidebar-store";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useScrollFade } from "../../lib/useScrollFade";
import { ease } from "../../lib/motion";
import { withAlpha } from "../dashboard/helpers";
import { ClampedText } from "../shared/ClampedText";

/**
 * ROUND-44 (R44-a) right-sidebar Memory tab — the visible half of the agent
 * MEMORY SYSTEM (owner directive "complete the agentic coding environment").
 * Agents forgot everything between sessions; now the agent's memory_save tool
 * persists durable per-project knowledge and this panel lets the owner READ
 * it (grouped by kind, colored chips) and PRUNE it (per-row delete).
 *
 * Data: GET /projects/:id/memory polled at 5s (the SubAgentPanel cadence —
 * memories change only when the agent saves one, so this is cheap and
 * near-live). Deletes hit DELETE /projects/:id/memory/:memoryId and
 * invalidate the listing. The newest memories are auto-injected into every
 * agent turn (the digest in agents/prompts.ts) — the footer hint says so.
 */
const KIND_ORDER: ProjectMemory["kind"][] = ["fact", "decision", "preference", "note"];

/** Kind chip colors — documented exceptions like SubAgentPanel's ROLE_COLORS:
 * they carry kind meaning across every theme/mode (fact = data blue,
 * decision = architecture purple, preference = taste green, note = amber). */
const KIND_COLORS: Record<ProjectMemory["kind"], string> = {
  fact: "#82aaff",
  decision: "#c792ea",
  preference: "#a5d6a7",
  note: "#f9a825",
};

export function MemoryPanel({ projectId, tab }: { projectId: string; tab: RightSidebarTab }) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const memoryQuery = useQuery({
    queryKey: ["project-memory", projectId],
    queryFn: () => listProjectMemory(projectId),
    staleTime: 2_000,
    refetchInterval: 5_000,
  });
  const memories = memoryQuery.data ?? [];

  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollFade(scrollRef);

  const doDelete = async (memoryId: string) => {
    if (deletingId !== null) return;
    setDeletingId(memoryId);
    setDeleteError(null);
    try {
      await deleteProjectMemory(projectId, memoryId);
      await queryClient.invalidateQueries({ queryKey: ["project-memory", projectId] });
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="h-full flex flex-col min-h-0" data-testid="memory-panel" data-tab-id={tab.id}>
      {/* ── Panel header: label + live count ── */}
      <div
        className="shrink-0 flex items-center gap-2 px-3 h-9 border-b"
        style={{ borderColor: styles.border, background: styles.isDark ? "rgba(0,0,0,0.18)" : styles.subtle }}
      >
        <Brain size={13} style={{ color: styles.accent }} className="shrink-0" />
        <div className="flex-1 min-w-0 truncate text-[11.5px] font-semibold" style={{ color: styles.text }}>
          Project memory
        </div>
        <span
          className="shrink-0 text-[9.5px] font-mono font-bold uppercase px-1.5 py-0.5 rounded-md"
          style={{ color: styles.textTertiary, background: withAlpha(styles.textTertiary, 0.1) }}
        >
          {memories.length} saved
        </span>
      </div>

      {/* ── Scrollable grouped list ── */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto auto-scroll">
        {memoryQuery.isPending ? (
          <div className="py-10 flex flex-col items-center gap-2" style={{ color: styles.textTertiary }}>
            <LoaderCircle size={16} className="animate-spin" style={{ color: styles.accent }} />
            <span className="text-[11px]">Loading memory…</span>
          </div>
        ) : memoryQuery.isError ? (
          <div className="px-3 py-3">
            <div
              className="rounded-[12px] px-3 py-3 flex flex-col gap-2"
              style={{ background: withAlpha(SEMANTIC_COLORS.danger, 0.08), border: `1px solid ${withAlpha(SEMANTIC_COLORS.danger, 0.3)}` }}
            >
              <div className="flex items-center gap-1.5 text-[11px] font-bold" style={{ color: SEMANTIC_COLORS.danger }}>
                Couldn&apos;t load project memory
              </div>
              <div className="text-[10.5px]" style={{ color: styles.textSecondary }}>
                {memoryQuery.error instanceof Error ? memoryQuery.error.message : "The sidecar didn't answer."}
              </div>
              <button
                onClick={() => void memoryQuery.refetch()}
                className="self-start h-6 px-2.5 rounded-full text-[10px] font-bold inline-flex items-center gap-1.5"
                style={{ background: styles.card, color: styles.text, border: `1px solid ${styles.border}` }}
              >
                <RefreshCw size={10} /> Try again
              </button>
            </div>
          </div>
        ) : memories.length === 0 ? (
          <div className="h-full grid place-items-center px-6 text-center">
            <div className="max-w-[240px]">
              <div
                className="w-11 h-11 mx-auto mb-3 grid place-items-center rounded-2xl border-2 border-dashed"
                style={{ borderColor: styles.border, color: styles.textTertiary }}
              >
                <Brain size={18} />
              </div>
              <div className="text-[12px] font-medium" style={{ color: styles.textSecondary }}>
                No memories yet
              </div>
              <div className="text-[11px] mt-1.5 leading-[1.55]" style={{ color: styles.textTertiary }}>
                The agent saves durable project knowledge here via memory_save — facts, decisions, preferences.
              </div>
            </div>
          </div>
        ) : (
          <div className="px-2.5 py-2.5 flex flex-col gap-2.5">
            {deleteError !== null ? (
              <div
                className="rounded-[12px] px-3 py-2 text-[10.5px]"
                style={{ color: SEMANTIC_COLORS.danger, background: withAlpha(SEMANTIC_COLORS.danger, 0.08) }}
                role="alert"
              >
                {deleteError}
              </div>
            ) : null}
            {KIND_ORDER.filter((kind) => memories.some((m) => m.kind === kind)).map((kind) => {
              const items = memories.filter((m) => m.kind === kind);
              const color = KIND_COLORS[kind];
              return (
                <section key={kind} data-kind={kind}>
                  {/* Kind group header: colored chip + count */}
                  <div className="flex items-center gap-1.5 px-1 pb-1.5">
                    <span
                      className="text-[9px] font-mono font-bold uppercase px-1.5 py-0.5 rounded-md"
                      style={{ color, background: withAlpha(color, 0.14) }}
                    >
                      {kind}
                    </span>
                    <span className="text-[9.5px]" style={{ color: styles.textTertiary }}>
                      {items.length}
                    </span>
                    <span className="flex-1 h-px" style={{ background: withAlpha(styles.border, 0.6) }} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <AnimatePresence initial={false}>
                      {items.map((m) => (
                        <MemoryRow
                          key={m.id}
                          memory={m}
                          deleting={deletingId === m.id}
                          onDelete={() => void doDelete(m.id)}
                        />
                      ))}
                    </AnimatePresence>
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Footer hint: why this panel matters ── */}
      <div
        className="shrink-0 flex items-center gap-1.5 px-3 h-7 border-t text-[9.5px]"
        style={{ borderColor: styles.border, color: styles.textTertiary, background: styles.isDark ? "rgba(0,0,0,0.18)" : styles.subtle }}
      >
        <Zap size={10} style={{ color: styles.accent }} className="shrink-0" />
        <span className="truncate">Auto-loaded into every agent turn</span>
      </div>
    </div>
  );
}

/** One memory card: content (clamped) + meta row (when · source) + delete.
 * ROUND-48 (R48-a): the per-kind left accent bar (borderLeft 2.5px) is GONE
 * (owner: the colored left border "looks way too bad") — every card now
 * carries the same clean uniform 1px border; kind identity stays in the
 * group-header chips above. */
function MemoryRow({
  memory,
  deleting,
  onDelete,
}: {
  memory: ProjectMemory;
  deleting: boolean;
  onDelete: () => void;
}) {
  const styles = useThemeStyles();
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
    >
      <ClampedText
        text={memory.content}
        lines={6}
        className="text-[11.5px] leading-[1.55] whitespace-pre-wrap break-words pr-5"
        style={{ color: styles.text }}
      />
      <div className="flex items-center gap-2 mt-1">
        <span className="text-[9.5px] shrink-0" style={{ color: styles.textTertiary }} title={memory.updatedAt}>
          {formatWhen(memory.updatedAt)}
        </span>
        {memory.source !== "agent" ? (
          <span className="text-[9.5px] shrink-0" style={{ color: styles.textTertiary }}>
            · {memory.source}
          </span>
        ) : null}
        <span className="flex-1" />
        <button
          onClick={onDelete}
          disabled={deleting}
          aria-label={`Delete memory: ${memory.content.slice(0, 60)}`}
          title="Delete this memory"
          className="w-5 h-5 grid place-items-center rounded shrink-0 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:opacity-50"
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
          {deleting ? <LoaderCircle size={11} className="animate-spin" /> : <Trash2 size={11} />}
        </button>
      </div>
    </motion.div>
  );
}
