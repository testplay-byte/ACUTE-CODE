'use client';

import { Check } from 'lucide-react';
import { useTheme } from '@/lib/dashboard-helpers';
import { useProjectChatStore } from '@/lib/project-chat-store';
import { motion } from 'framer-motion';

export function TodoPanel() {
  const { isDark, text, border, muted, inputBg, accent } = useTheme();
  const todoItems = useProjectChatStore((s) => s.todoItems);
  const toggleTodo = useProjectChatStore((s) => s.toggleTodo);
  const done = todoItems.filter((x) => x.done).length;
  const total = todoItems.length;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="p-3">
      {/* Progress ring + header */}
      <div className="flex items-center gap-3 mb-3">
        <div className="relative w-11 h-11 shrink-0">
          <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
            <circle
              cx="50" cy="50" r="42" fill="none"
              stroke={border}
              strokeWidth="8"
            />
            <circle
              cx="50" cy="50" r="42" fill="none"
              stroke={accent}
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={263.89}
              strokeDashoffset={263.89 - (263.89 * percent) / 100}
              style={{ transition: 'stroke-dashoffset 0.8s cubic-bezier(0.34,1.56,0.64,1)' }}
            />
          </svg>
          <div className="absolute inset-0 grid place-items-center">
            <span className="text-[12px] font-bold font-mono" style={{ color: text }}>
              {percent}%
            </span>
          </div>
        </div>
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-widest font-semibold" style={{ color: muted }}>
            Mission
          </p>
          <p className="text-[12px] font-semibold mt-0.5 leading-tight" style={{ color: text }}>
            Refactor auth to add rate limiting
          </p>
        </div>
      </div>

      {/* Counter */}
      <div className="flex items-center justify-between mb-2 px-0.5">
        <span className="text-[10px] uppercase tracking-widest font-semibold" style={{ color: muted }}>
          To-Do
        </span>
        <span
          className="text-[10px] font-mono px-2 py-0.5 rounded-full border"
          style={{ background: inputBg, borderColor: border, color: muted }}
        >
          {done}/{total}
        </span>
      </div>

      {/* Todo items */}
      <div className="space-y-1">
        {todoItems.map((item) => (
          <button
            key={item.id}
            onClick={() => toggleTodo(item.id)}
            className="w-full flex items-center gap-2.5 p-2 rounded-xl border transition-all text-left"
            style={{
              background: item.done ? inputBg : 'transparent',
              borderColor: item.done ? border : 'transparent',
            }}
          >
            <motion.div
              className="w-[18px] h-[18px] rounded-full border grid place-items-center shrink-0 transition-colors"
              style={{
                background: item.done ? accent : 'transparent',
                borderColor: item.done ? accent : border,
                color: item.done ? (isDark ? '#000' : '#fff') : 'transparent',
              }}
              whileTap={{ scale: 0.9 }}
            >
              {item.done && <Check size={11} strokeWidth={3} />}
            </motion.div>
            <span
              className="text-[12px] leading-tight"
              style={{
                color: item.done ? muted : text,
                textDecoration: item.done ? 'line-through' : 'none',
              }}
            >
              {item.text}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
