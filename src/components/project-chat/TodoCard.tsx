/**
 * ROUND-87 (R87, owner: "the agent apparently does not have a proper to-do
 * list. It does not properly show the to-do list. Maybe adding a to-do list
 * will be a great option") — the turn's todo-list card, rendered INLINE in
 * the working stream.
 *
 * The todo_write tool already persisted todo.update session events (round
 * 25) but the card only lived in the left-sidebar TodoPanel — invisible in
 * the default ChatFocus layout. R87: one entry per turn in the working
 * stream (upserted live via the todo-updated SSE frame), showing the LATEST
 * snapshot — the agent's progress contract, exactly like Claude Code's
 * todo list.
 */
import type { WorkingEntry } from "../../lib/api";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";
import { Check, Minus } from "lucide-react";

export type TodoEntry = Extract<WorkingEntry, { type: "todo" }>;

export function TodoCard({ entry }: { entry: TodoEntry }) {
  const styles = useThemeStyles();
  const items = entry.items;
  const done = items.filter((item) => item.status === "completed").length;
  const total = items.length;
  const complete = total > 0 && done === total;

  return (
    <div
      className="rounded-[12px] border-[1.5px] px-3 py-2.5 my-1"
      style={{
        borderColor: complete
          ? withAlpha("#22c55e", 0.45)
          : withAlpha(styles.accent, 0.35),
        background: styles.isDark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.015)",
      }}
      data-testid="todo-card"
    >
      <div className="flex items-center gap-2 mb-2">
        <span
          className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-full tracking-[0.08em] shrink-0"
          style={{
            background: complete ? withAlpha("#22c55e", 0.12) : withAlpha(styles.accent, 0.12),
            color: complete ? "#22c55e" : styles.accent,
          }}
        >
          TASK LIST
        </span>
        {/* the progress meter — a thin bar + the N/M readout */}
        <div
          className="h-1 flex-1 rounded-full overflow-hidden min-w-[40px]"
          style={{ background: styles.subtle }}
          aria-hidden
        >
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: total === 0 ? "0%" : `${(done / total) * 100}%`,
              background: complete ? "#22c55e" : styles.accent,
            }}
          />
        </div>
        <span
          className="text-[10px] font-mono font-bold shrink-0"
          style={{ color: complete ? "#22c55e" : styles.textTertiary }}
        >
          {done}/{total}
        </span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {items.map((item, i) => {
          const isDone = item.status === "completed";
          const isActive = item.status === "in_progress";
          return (
            <li key={i} className="flex items-start gap-2 min-w-0">
              <span
                className="flex items-center justify-center w-[15px] h-[15px] rounded-[4px] border-[1.5px] shrink-0 mt-[1px] transition-colors"
                style={{
                  borderColor: isDone ? "#22c55e" : isActive ? styles.accent : withAlpha(styles.text, 0.25),
                  background: isDone ? "#22c55e" : "transparent",
                }}
                aria-hidden
              >
                {isDone ? (
                  <Check size={10} strokeWidth={3.5} color="#fff" />
                ) : isActive ? (
                  <span
                    className="w-1.5 h-1.5 rounded-full ac-pulse"
                    style={{ background: styles.accent }}
                  />
                ) : (
                  <Minus size={0} />
                )}
              </span>
              <span
                className={`text-[11.5px] leading-[1.45] break-words ${isDone ? "line-through" : ""}`}
                style={{
                  color: isDone
                    ? styles.textTertiary
                    : isActive
                      ? styles.text
                      : withAlpha(styles.text, 0.75),
                  fontWeight: isActive ? 600 : 400,
                }}
              >
                {item.content}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
