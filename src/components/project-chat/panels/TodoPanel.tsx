import { Check } from "lucide-react";
import { motion } from "framer-motion";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import { useSession } from "../../../hooks/use-sessions";
import { toLatestTodo } from "../../../lib/api";
import { withAlpha } from "../../dashboard/helpers";

/**
 * TodoPanel (round-25): driven by the model's `todo_write` tool.
 * Reads the LATEST todo snapshot from the session event log (todo.update
 * events) — replaces the fixture store. The model manages the list;
 * the panel renders it with status-aware styling.
 */
export function TodoPanel({ projectId, mission }: { projectId: string; mission: string }) {
  const styles = useThemeStyles();
  const { data: sessionDetail } = useSession(projectId);
  const todoSnapshot = sessionDetail ? toLatestTodo(sessionDetail.events) : null;
  const todos = todoSnapshot?.todos ?? [];

  const done = todos.filter((x) => x.status === "completed").length;
  const total = todos.length;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="p-3">
      {/* Progress ring + mission header */}
      <div className="flex items-center gap-3 mb-3">
        <div className="relative w-11 h-11 shrink-0">
          <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
            <circle cx="50" cy="50" r="42" fill="none" stroke={styles.border} strokeWidth="8" />
            <circle
              cx="50"
              cy="50"
              r="42"
              fill="none"
              stroke={styles.accent}
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={263.89}
              strokeDashoffset={263.89 - (263.89 * percent) / 100}
              style={{ transition: "stroke-dashoffset 0.8s cubic-bezier(0.34,1.56,0.64,1)" }}
            />
          </svg>
          <div className="absolute inset-0 grid place-items-center">
            {/* R100-D (weight law + numbers): the ring's percent is 600
                (value tier), tabular-nums — not font-bold. */}
            <span className="text-[12px] font-semibold font-mono tabular-nums" style={{ color: styles.text }}>
              {percent}%
            </span>
          </div>
        </div>
        <div className="min-w-0">
          {/* R100-D: the kicker snaps to the landed panel idiom — 10px/500
              uppercase tracking-[0.08em] (THE one tracking spelling). */}
          <p
            className="text-[10px] uppercase tracking-[0.08em] font-medium"
            style={{ color: styles.textSecondary }}
          >
            Mission
          </p>
          <p className="text-[12px] font-semibold mt-0.5 leading-tight truncate" style={{ color: styles.text }}>
            {mission}
          </p>
        </div>
      </div>

      {/* Counter */}
      <div className="flex items-center justify-between mb-2 px-0.5">
        <span
          className="text-[10px] uppercase tracking-[0.08em] font-medium"
          style={{ color: styles.textSecondary }}
        >
          To-Do
        </span>
        {/* R100-D: numbers discipline — the counter chip goes tabular. */}
        <span
          className="text-[10px] font-mono tabular-nums px-2 py-0.5 rounded-full border"
          style={{ background: styles.inputBg, borderColor: styles.border, color: styles.textSecondary }}
        >
          {done}/{total}
        </span>
      </div>

      {/* Items — driven by the model's todo_write tool */}
      <div className="space-y-1">
        {todos.map((item, i) => {
          const isDone = item.status === "completed";
          const isProgress = item.status === "in_progress";
          return (
            <div
              key={`${i}-${item.content.slice(0, 20)}`}
              className="w-full flex items-center gap-2.5 p-2 rounded-xl border transition-all text-left"
              style={{
                background: isDone ? styles.inputBg : "transparent",
                borderColor: isDone ? styles.border : isProgress ? withAlpha(styles.accent, 0.3) : "transparent",
              }}
            >
              <motion.div
                className="w-[18px] h-[18px] rounded-full border grid place-items-center shrink-0"
                style={{
                  background: isDone ? styles.accent : isProgress ? withAlpha(styles.accent, 0.3) : "transparent",
                  borderColor: isDone ? styles.accent : isProgress ? styles.accent : styles.border,
                  color: styles.accentText,
                }}
                whileTap={{ scale: 0.9 }}
              >
                {isDone && <Check size={11} strokeWidth={3} />}
              </motion.div>
              <span
                className="text-[12px] leading-tight text-left"
                style={{
                  color: isDone ? styles.textSecondary : styles.text,
                  textDecoration: isDone ? "line-through" : "none",
                }}
              >
                {item.content}
              </span>
              {isProgress && (
                <span
                  // R100-D: 9→10px (the type floor) + font-medium (the
                  // weight law).
                  className="ml-auto shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium font-mono"
                  style={{ background: withAlpha(styles.accent, 0.1), color: styles.accent }}
                >
                  active
                </span>
              )}
            </div>
          );
        })}

        {todos.length === 0 && (
          <p className="px-2 py-3 text-[11px] text-center" style={{ color: styles.textTertiary }}>
            No active todos — the agent will use todo_write for multi-step tasks.
          </p>
        )}

        {todos.length > 0 && (
          <p className="px-2 pt-1.5 text-[10px] font-mono" style={{ color: styles.textTertiary }}>
            managed by the agent · todo_write tool
          </p>
        )}
      </div>
    </div>
  );
}
