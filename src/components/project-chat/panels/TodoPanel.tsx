import { useState } from "react";
import { Check, Plus } from "lucide-react";
import { motion } from "framer-motion";
import { useProjectChatStore, type TodoItem } from "../../../lib/project-chat-store";
import { useThemeStyles } from "../../../lib/use-theme-styles";

/** Stable reference — a fresh `[]` in the selector would re-render forever
 * (React's getSnapshot caching contract). */
const NO_TODOS: TodoItem[] = [];

/**
 * Demo TodoPanel ported 1:1 (progress ring, MISSION header, counter, toggle
 * rows) with real per-project data: items live in the persisted project-chat
 * store (no backend task events until Phase 3), plus a minimal add-row so the
 * panel is actually usable. Mission line = the project's name.
 */
export function TodoPanel({ projectId, mission }: { projectId: string; mission: string }) {
  const styles = useThemeStyles();
  const todos = useProjectChatStore((s) => s.todos[projectId] ?? NO_TODOS);
  const addTodo = useProjectChatStore((s) => s.addTodo);
  const toggleTodo = useProjectChatStore((s) => s.toggleTodo);
  const [draft, setDraft] = useState("");

  const done = todos.filter((x) => x.done).length;
  const total = todos.length;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  const submit = () => {
    const text = draft.trim();
    if (text === "") return;
    addTodo(projectId, text);
    setDraft("");
  };

  return (
    <div className="p-3">
      {/* Progress ring + mission header (demo-exact) */}
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
            <span className="text-[12px] font-bold font-mono" style={{ color: styles.text }}>
              {percent}%
            </span>
          </div>
        </div>
        <div className="min-w-0">
          <p
            className="text-[10px] uppercase tracking-widest font-semibold"
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
          className="text-[10px] uppercase tracking-widest font-semibold"
          style={{ color: styles.textSecondary }}
        >
          To-Do
        </span>
        <span
          className="text-[10px] font-mono px-2 py-0.5 rounded-full border"
          style={{ background: styles.inputBg, borderColor: styles.border, color: styles.textSecondary }}
        >
          {done}/{total}
        </span>
      </div>

      {/* Items (demo-exact rows) */}
      <div className="space-y-1">
        {todos.map((item) => (
          <button
            key={item.id}
            onClick={() => toggleTodo(projectId, item.id)}
            className="w-full flex items-center gap-2.5 p-2 rounded-xl border transition-all text-left"
            style={{
              background: item.done ? styles.inputBg : "transparent",
              borderColor: item.done ? styles.border : "transparent",
            }}
          >
            <motion.div
              className="w-[18px] h-[18px] rounded-full border grid place-items-center shrink-0"
              style={{
                background: item.done ? styles.accent : "transparent",
                borderColor: item.done ? styles.accent : styles.border,
                color: styles.accentText,
              }}
              whileTap={{ scale: 0.9 }}
            >
              {item.done && <Check size={11} strokeWidth={3} />}
            </motion.div>
            <span
              className="text-[12px] leading-tight text-left"
              style={{
                color: item.done ? styles.textSecondary : styles.text,
                textDecoration: item.done ? "line-through" : "none",
              }}
            >
              {item.text}
            </span>
          </button>
        ))}

        {/* Add row (minimal, demo-styled) */}
        <div
          className="flex items-center gap-2.5 p-2 rounded-xl border"
          style={{ borderColor: styles.border, borderStyle: "dashed" }}
        >
          <div
            className="w-[18px] h-[18px] rounded-full border grid place-items-center shrink-0"
            style={{ borderColor: styles.border, color: styles.textSecondary }}
          >
            <Plus size={10} />
          </div>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="Add a task…"
            className="flex-1 bg-transparent outline-none text-[12px] min-w-0"
            style={{ color: styles.text }}
          />
        </div>
      </div>
    </div>
  );
}
