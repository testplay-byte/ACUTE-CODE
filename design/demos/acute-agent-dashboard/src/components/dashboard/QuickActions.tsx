'use client';

import { Plus, Terminal } from 'lucide-react';
import { motion } from 'framer-motion';
import { useDashboardStore } from '@/lib/dashboard-store';
import { useTheme, bdr, scaleIn } from '@/lib/dashboard-helpers';

export function QuickActions({ delay = 0 }: { delay?: number }) {
  const addProject = useDashboardStore((s) => s.addProject);
  const { isDark, card, border, text, muted, accent } = useTheme();

  return (
    <motion.div
      variants={scaleIn}
      className="p-4 rounded-lg"
      style={{ backgroundColor: card, border: bdr('1.5px', border) }}
    >
      <div className="flex items-center gap-2 mb-3">
        <Terminal size={13} style={{ color: accent, opacity: 0.7 }} />
        <span className="text-[12px] font-semibold" style={{ color: text }}>Quick Actions</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <button
          onClick={() => addProject('new-project', '~/projects/new-project')}
          className="w-full text-left px-3 py-2.5 rounded-lg text-[12px] font-medium transition-all duration-200 cursor-pointer hover:translate-x-0.5"
          style={{
            backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.015)',
            border: bdr('1.5px', border),
            color: text,
          }}
        >
          <span className="flex items-center gap-2">
            <Plus size={12} style={{ color: accent, opacity: 0.7 }} />
            Create new project
          </span>
        </button>
        <button
          className="w-full text-left px-3 py-2.5 rounded-lg text-[12px] font-medium transition-all duration-200 cursor-pointer hover:translate-x-0.5"
          style={{
            backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.015)',
            border: bdr('1.5px', border),
            color: text,
          }}
        >
          <span className="flex items-center gap-2">
            <Terminal size={12} style={{ color: accent, opacity: 0.7 }} />
            Start a session
          </span>
        </button>
      </div>
    </motion.div>
  );
}
