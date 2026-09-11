/**
 * ROUND-88 (R88, owner: "the to-do list … will show at the top-right corner
 * of the chat window, and it will be a floating view. The user will be shown
 * only the current task at hand … When the user clicks on it, the to-do list
 * will expand and show all the other to-do list entries … It will show only
 * the top 10 to-do list entries, and the user will be able to scroll and see
 * the other ones too … adding the functionality to manually edit the
 * to-do list and make some changes so that the agent can properly and easily
 * work with them") — the FLOATING TODO WIDGET.
 *
 * The R87 TodoCard stays as the per-turn record INSIDE the working stream;
 * this widget is the always-visible CURRENT-STATE surface, pinned to the
 * chat card's top-right (it scrolls WITH nothing — the transcript slides
 * under it). Collapsed it is a single pill naming the task at hand; one
 * click expands the full list (10 rows visible, scroll for more); a pencil
 * opens the manual editor (content edit + status cycle + delete + add +
 * reorder via the move buttons) whose Save POSTs the FULL snapshot through
 * the R88 route (source:"user") — the agent's NEXT turn sees the owner's
 * list in its CURRENT TODO LIST prompt section and works with the changes.
 */
import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  saveSessionTodo,
  toLatestTodo,
  type TodoSnapshot,
} from "../../lib/api";
import { useStreamStore } from "../../lib/stream-store";
import { useSession } from "../../hooks/use-sessions";
import { pushLocalToast } from "../../hooks/use-notifications";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ListTodo,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

type TodoItem = TodoSnapshot["todos"][number];
type TodoStatus = TodoItem["status"];

/** The rows are h-9 (36px) + 3px gap = 39px per row — the container's
 * maxHeight 393px caps the VISIBLE window at ten rows (scroll reveals
 * the rest — the owner's "only the top 10 … scroll and see the other
 * ones too"). */
const ROWS_MAX_H = "393px";
const VISIBLE_ROWS = 10;

export interface TodoFloatState {
  todos: TodoItem[];
  source: "agent" | "user" | undefined;
  streamBusy: boolean;
}

/**
 * The widget's data hook — live wins over folded (exactly like the chat's
 * working stream): while a turn is streaming, the liveTurn's todo entry is
 * the truth; after it ends the refetched fold (toLatestTodo over the
 * session's events) takes over. An empty latest snapshot (the owner's clear)
 * reads as "no list" → the widget hides.
 */
export function useTodoFloatState(sessionId: string | null): TodoFloatState {
  const sessionDetail = useSession(sessionId);
  const liveEntry = useStreamStore((s) => {
    if (sessionId === null) return undefined;
    const live = s.bySession[sessionId]?.liveTurn;
    if (live == null) return undefined;
    return live.working.find((entry) => entry.type === "todo");
  });
  const streamBusy = useStreamStore((s) =>
    sessionId !== null ? (s.bySession[sessionId]?.streamBusy ?? false) : false,
  );

  const folded = sessionDetail.data ? toLatestTodo(sessionDetail.data.events) : null;
  const live =
    liveEntry !== undefined && liveEntry.type === "todo" && liveEntry.items.length > 0
      ? { todos: liveEntry.items, source: liveEntry.source }
      : null;

  const winner = live ?? (folded !== null && folded.todos.length > 0 ? folded : null);
  return {
    todos: winner?.todos ?? [],
    source: winner?.source,
    streamBusy,
  };
}

/** One draft row of the editor — local state until Save POSTs the snapshot. */
interface DraftRow {
  content: string;
  status: TodoStatus;
}

export function TodoFloat({ sessionId }: { sessionId: string | null }) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const state = useTodoFloatState(sessionId);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DraftRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const items = state.todos;
  const done = items.filter((item) => item.status === "completed").length;
  const total = items.length;
  const complete = total > 0 && done === total;

  // The task AT HAND: the first in_progress item, else the next pending,
  // else "all done" (the collapsed pill's whole content).
  const current = useMemo(() => {
    if (items.length === 0) return null;
    return items.find((item) => item.status === "in_progress") ?? items.find((item) => item.status === "pending") ?? null;
  }, [items]);

  // No list at all (never created, or the owner's clear) → render nothing.
  if (sessionId === null || total === 0) return null;

  const beginEdit = () => {
    setDraft(items.map((item) => ({ content: item.content, status: item.status })));
    setEditing(true);
    setSaveError(null);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft([]);
    setSaveError(null);
  };

  const save = async () => {
    if (sessionId === null) return;
    const cleaned = draft
      .map((row) => ({ content: row.content.trim().slice(0, 200), status: row.status }))
      .filter((row) => row.content.length > 0);
    if (cleaned.length === 0 && draft.length > 0) {
      setSaveError("Every row is empty — add content or delete the rows.");
      return;
    }
    if (cleaned.length > 30) {
      setSaveError("Too many tasks (max 30).");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await saveSessionTodo(sessionId, cleaned);
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      setEditing(false);
      setDraft([]);
      pushLocalToast(
        "To-do list saved",
        cleaned.length === 0
          ? "The list is cleared — the agent sees no plan."
          : "The agent works with your list from its next message.",
      );
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const cycleStatus = (index: number) => {
    setDraft((rows) =>
      rows.map((row, i) =>
        i === index
          ? { ...row, status: row.status === "pending" ? "in_progress" : row.status === "in_progress" ? "completed" : "pending" }
          : row,
      ),
    );
  };

  const move = (index: number, delta: -1 | 1) => {
    setDraft((rows) => {
      const target = index + delta;
      if (target < 0 || target >= rows.length) return rows;
      const next = [...rows];
      const [row] = next.splice(index, 1);
      next.splice(target, 0, row);
      return next;
    });
  };

  const cardBorder = withAlpha(styles.accent, 0.28);
  const userEdit = state.source === "user";

  return (
    <div
      ref={containerRef}
      className="absolute top-3 right-4 z-20 flex flex-col items-end gap-2 max-w-[min(92vw,380px)]"
      data-testid="todo-float"
    >
      {expanded ? (
        <div
          className="w-full rounded-[14px] border-[1.5px] shadow-lg overflow-hidden"
          style={{
            borderColor: cardBorder,
            // R89-F1 (the owner: "there should be a blur around its corners so
            // that the elements around it are blurred and the task list is a
            // bit more highlighted"): a FROSTED card — translucent surface +
            // backdrop blur, so the transcript scrolling under it blurs at
            // the rounded corners and the list reads as HIGHLIGHTED glass.
            background: styles.isDark ? "rgba(44,44,46,0.72)" : "rgba(255,255,255,0.72)",
            backdropFilter: "blur(12px) saturate(1.15)",
            WebkitBackdropFilter: "blur(12px) saturate(1.15)",
            boxShadow: `0 12px 32px ${withAlpha(styles.isDark ? "#000000" : "#24292f", 0.18)}`,
          }}
          role="dialog"
          aria-label="To-do list"
        >
          {/* header */}
          <div
            className="flex items-center gap-2 px-3 py-2 border-b"
            style={{ borderColor: withAlpha(styles.text, 0.08) }}
          >
            <ListTodo size={13} style={{ color: styles.accent }} aria-hidden />
            <span className="text-[11px] font-bold tracking-wide" style={{ color: styles.text }}>
              TO-DO LIST
            </span>
            {userEdit ? (
              <span
                className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-full"
                style={{ background: withAlpha(styles.accent, 0.12), color: styles.accent }}
                title="You edited this list — the agent follows your changes."
              >
                EDITED BY YOU
              </span>
            ) : null}
            {state.streamBusy ? (
              <span
                className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-full"
                style={{ background: withAlpha(styles.accent, 0.08), color: styles.textTertiary }}
                title="A turn is running — edits reach the agent on its next message."
              >
                LIVE
              </span>
            ) : null}
            <div className="flex-1" />
            <span className="text-[10px] font-mono font-bold" style={{ color: complete ? "#22c55e" : styles.textTertiary }}>
              {done}/{total}
            </span>
            {!editing ? (
              <button
                type="button"
                onClick={beginEdit}
                aria-label="Edit the to-do list"
                title="Edit the to-do list — the agent works with your changes"
                className="flex items-center justify-center w-6 h-6 rounded-[7px] transition-colors hover:bg-black/5"
                style={{ color: styles.textTertiary }}
              >
                <Pencil size={12} />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setExpanded(false)}
              aria-label="Collapse the to-do list"
              className="flex items-center justify-center w-6 h-6 rounded-[7px] transition-colors hover:bg-black/5"
              style={{ color: styles.textTertiary }}
            >
              <ChevronDown size={13} />
            </button>
          </div>

          {editing ? (
            <>
              {/* the editor — every row editable: content, status, order, delete */}
              <div
                className="flex flex-col overflow-y-auto px-2 py-2 gap-1"
                style={{ maxHeight: ROWS_MAX_H }}
                data-testid="todo-float-edit-rows"
              >
                {draft.map((row, i) => (
                  <div key={i} className="flex items-center gap-1.5 min-w-0">
                    <button
                      type="button"
                      onClick={() => cycleStatus(i)}
                      aria-label={`Cycle status (now ${row.status})`}
                      title={`Status: ${row.status} — click to cycle`}
                      className="flex items-center justify-center w-[18px] h-[18px] rounded-[5px] border-[1.5px] shrink-0 transition-colors"
                      style={{
                        borderColor:
                          row.status === "completed" ? "#22c55e" : row.status === "in_progress" ? styles.accent : withAlpha(styles.text, 0.25),
                        background: row.status === "completed" ? "#22c55e" : "transparent",
                      }}
                    >
                      {row.status === "completed" ? (
                        <Check size={10} strokeWidth={3.5} color="#fff" />
                      ) : row.status === "in_progress" ? (
                        <span className="w-1.5 h-1.5 rounded-full ac-pulse" style={{ background: styles.accent }} />
                      ) : null}
                    </button>
                    <input
                      value={row.content}
                      onChange={(e) =>
                        setDraft((rows) => rows.map((r, ri) => (ri === i ? { ...r, content: e.target.value } : r)))
                      }
                      aria-label={`Task ${i + 1} content`}
                      className="flex-1 min-w-0 text-[11.5px] rounded-[7px] border px-2 py-1.5 outline-none focus:border-current"
                      style={{
                        background: styles.isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.02)",
                        borderColor: withAlpha(styles.text, 0.12),
                        color: styles.text,
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => move(i, -1)}
                      aria-label={`Move task ${i + 1} up`}
                      disabled={i === 0}
                      className="flex items-center justify-center w-6 h-6 rounded-[7px] transition-colors hover:bg-black/5 disabled:opacity-25"
                      style={{ color: styles.textTertiary }}
                    >
                      <ArrowUp size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(i, 1)}
                      aria-label={`Move task ${i + 1} down`}
                      disabled={i === draft.length - 1}
                      className="flex items-center justify-center w-6 h-6 rounded-[7px] transition-colors hover:bg-black/5 disabled:opacity-25"
                      style={{ color: styles.textTertiary }}
                    >
                      <ArrowDown size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDraft((rows) => rows.filter((_, ri) => ri !== i))}
                      aria-label={`Delete task ${i + 1}`}
                      className="flex items-center justify-center w-6 h-6 rounded-[7px] transition-colors hover:bg-black/5"
                      style={{ color: withAlpha("#ef4444", 0.75) }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setDraft((rows) => [...rows, { content: "", status: "pending" }])}
                  className="flex items-center gap-1.5 text-[11px] font-medium px-2 py-1.5 rounded-[7px] transition-colors self-start mt-0.5"
                  style={{ color: styles.accent, background: withAlpha(styles.accent, 0.07) }}
                  data-testid="todo-float-add-row"
                >
                  <Plus size={12} /> Add task
                </button>
              </div>
              <div
                className="flex items-center gap-2 px-3 py-2 border-t"
                style={{ borderColor: withAlpha(styles.text, 0.08) }}
              >
                {saveError !== null ? (
                  <span className="text-[10px] flex-1 min-w-0" style={{ color: "#ef4444" }} data-testid="todo-float-save-error">
                    {saveError}
                  </span>
                ) : (
                  <span className="text-[10px] flex-1 min-w-0" style={{ color: styles.textTertiary }}>
                    The agent sees your list from its next message.
                  </span>
                )}
                <button
                  type="button"
                  onClick={cancelEdit}
                  disabled={saving}
                  className="text-[11px] font-semibold px-2.5 py-1 rounded-[7px] transition-colors"
                  style={{ color: styles.textTertiary }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving}
                  className="flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-[7px] transition-colors disabled:opacity-60"
                  style={{ background: styles.accent, color: "#fff" }}
                  data-testid="todo-float-save"
                >
                  {saving ? <Loader2 size={11} className="animate-spin" /> : null}
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </>
          ) : (
            <>
              {/* the list — ALL rows rendered, the container caps at TEN visible
                  (scroll reveals the rest — the owner's spec). */}
              <ul
                className="flex flex-col overflow-y-auto px-3 py-2 gap-[3px]"
                style={{ maxHeight: ROWS_MAX_H }}
                data-testid="todo-float-rows"
              >
                {items.map((item, i) => {
                  const isDone = item.status === "completed";
                  const isActive = item.status === "in_progress";
                  return (
                    <li key={i} className="flex items-start gap-2 min-w-0 h-9 py-1" data-testid="todo-float-row">
                      <span
                        className="flex items-center justify-center w-[15px] h-[15px] rounded-[4px] border-[1.5px] shrink-0 mt-[2px] transition-colors"
                        style={{
                          borderColor: isDone ? "#22c55e" : isActive ? styles.accent : withAlpha(styles.text, 0.25),
                          background: isDone ? "#22c55e" : "transparent",
                        }}
                        aria-hidden
                      >
                        {isDone ? (
                          <Check size={10} strokeWidth={3.5} color="#fff" />
                        ) : isActive ? (
                          <span className="w-1.5 h-1.5 rounded-full ac-pulse" style={{ background: styles.accent }} />
                        ) : null}
                      </span>
                      <span
                        className={`text-[11.5px] leading-[1.45] break-words ${isDone ? "line-through" : ""}`}
                        style={{
                          color: isDone ? styles.textTertiary : isActive ? styles.text : withAlpha(styles.text, 0.75),
                          fontWeight: isActive ? 600 : 400,
                        }}
                      >
                        {item.content}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {total > VISIBLE_ROWS ? (
                <div
                  className="text-[10px] text-center py-1 border-t"
                  style={{ borderColor: withAlpha(styles.text, 0.06), color: styles.textTertiary }}
                >
                  scroll for {total - VISIBLE_ROWS} more
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {/* the collapsed pill — ONLY the task at hand (the owner's spec) */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse the to-do list" : "Expand the to-do list"}
        className="group flex items-center gap-2 rounded-full border-[1.5px] pl-2.5 pr-2 py-1.5 shadow-sm transition-all hover:shadow-md max-w-full"
        style={{
          borderColor: complete ? withAlpha("#22c55e", 0.45) : cardBorder,
          // R89-F1: the same frosted treatment on the pill.
          background: styles.isDark ? "rgba(44,44,46,0.72)" : "rgba(255,255,255,0.72)",
          backdropFilter: "blur(12px) saturate(1.15)",
          WebkitBackdropFilter: "blur(12px) saturate(1.15)",
        }}
        data-testid="todo-float-pill"
      >
        <span
          className="flex items-center justify-center w-[15px] h-[15px] rounded-[4px] border-[1.5px] shrink-0"
          style={{
            borderColor: complete ? "#22c55e" : current !== null ? styles.accent : "#22c55e",
            background: complete ? "#22c55e" : "transparent",
          }}
          aria-hidden
        >
          {complete ? (
            <Check size={10} strokeWidth={3.5} color="#fff" />
          ) : current !== null && current.status === "in_progress" ? (
            <span className="w-1.5 h-1.5 rounded-full ac-pulse" style={{ background: styles.accent }} />
          ) : null}
        </span>
        <span
          className="text-[11px] font-semibold truncate min-w-0"
          style={{ color: styles.text }}
          title={current !== null ? current.content : "All tasks done"}
        >
          {current !== null ? current.content : "All tasks done"}
        </span>
        <span
          className="text-[9.5px] font-mono font-bold shrink-0 px-1.5 py-0.5 rounded-full"
          style={{ background: withAlpha(complete ? "#22c55e" : styles.accent, 0.1), color: complete ? "#22c55e" : styles.accent }}
        >
          {done}/{total}
        </span>
        <ChevronDown
          size={12}
          className={`shrink-0 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
          style={{ color: styles.textTertiary }}
          aria-hidden
        />
      </button>
    </div>
  );
}
