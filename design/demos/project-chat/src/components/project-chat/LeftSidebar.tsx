'use client';

import { useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Files, CheckSquare, ChevronDown, ChevronRight, ChevronLeft,
} from 'lucide-react';
import { useTheme } from '@/lib/dashboard-helpers';
import { useProjectChatStore } from '@/lib/project-chat-store';
import { ExplorerPanel } from './panels/ExplorerPanel';
import { TodoPanel } from './panels/TodoPanel';
import { useScrollFade } from '@/lib/useScrollFade';

const ease = [0.25, 0.1, 0.25, 1] as const;

// ============================================================
// COLLAPSED ICON SIDEBAR
// ============================================================
function CollapsedSidebar({ onExpand }: { onExpand: () => void }) {
  const { card, border, muted, accent, inputBg } = useTheme();

  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 48, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: 0.25, ease }}
      className="shrink-0 flex flex-col items-center py-3 gap-1.5 overflow-hidden rounded-2xl border"
      style={{
        backgroundColor: card,
        borderColor: border,
      }}
    >
      <button
        onClick={onExpand}
        className="w-9 h-9 rounded-xl grid place-items-center transition-colors"
        style={{ color: muted, background: inputBg }}
        title="Expand sidebar"
        onMouseEnter={(e) => { e.currentTarget.style.color = accent; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = muted; }}
      >
        <ChevronRight size={16} />
      </button>

      <button
        className="w-9 h-9 rounded-xl grid place-items-center transition-colors"
        style={{ color: accent, background: accent + '14' }}
        title="Explorer"
      >
        <Files size={16} />
      </button>

      <button
        className="w-9 h-9 rounded-xl grid place-items-center transition-colors"
        style={{ color: muted }}
        title="To-Do"
        onMouseEnter={(e) => { e.currentTarget.style.color = accent; e.currentTarget.style.background = accent + '14'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = muted; e.currentTarget.style.background = 'transparent'; }}
      >
        <CheckSquare size={16} />
      </button>
    </motion.div>
  );
}

// ============================================================
// LEFT SIDEBAR
// ============================================================
export function LeftSidebar({
  sidebarWidth,
}: {
  sidebarWidth: number;
}) {
  const { card, border, muted, accent } = useTheme();
  const sidebarOpen = useProjectChatStore((s) => s.sidebarOpen);
  const setSidebarOpen = useProjectChatStore((s) => s.setSidebarOpen);
  const collapsedPanels = useProjectChatStore((s) => s.collapsedPanels);
  const togglePanel = useProjectChatStore((s) => s.togglePanel);
  const explorerCollapsed = collapsedPanels.has('explorer');
  const todoCollapsed = collapsedPanels.has('todo');
  const explorerScrollRef = useRef<HTMLDivElement>(null);
  const todoScrollRef = useRef<HTMLDivElement>(null);

  useScrollFade(explorerScrollRef);
  useScrollFade(todoScrollRef);

  if (!sidebarOpen) return <CollapsedSidebar onExpand={() => setSidebarOpen(true)} />;

  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: sidebarWidth, opacity: 1 }}
      exit={{ width: 48, opacity: 0 }}
      transition={{ duration: 0.25, ease }}
      className="shrink-0 flex flex-col overflow-hidden rounded-2xl border"
      style={{
        backgroundColor: card,
        borderColor: border,
      }}
    >
      {/* Sidebar minimize button — at very top */}
      <div className="shrink-0 flex items-center justify-between px-2 h-9 rounded-t-2xl">
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] px-1" style={{ color: muted }}>
          Project
        </span>
        <button
          onClick={() => setSidebarOpen(false)}
          className="w-7 h-7 rounded-lg grid place-items-center transition-colors"
          style={{ color: muted }}
          onMouseEnter={(e) => { e.currentTarget.style.background = accent + '10'; e.currentTarget.style.color = accent; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = muted; }}
          title="Minimize sidebar"
        >
          <ChevronLeft size={14} />
        </button>
      </div>

      {/* Explorer Section */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {/* Explorer header — inside the section */}
        <button
          className="shrink-0 w-full flex items-center justify-between px-3 h-9 transition-colors"
          style={{ borderBottom: explorerCollapsed ? 'none' : '1px solid ' + border }}
          onClick={() => togglePanel('explorer')}
          onMouseEnter={(e) => { e.currentTarget.style.background = accent + '08'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <div className="flex items-center gap-2">
            <Files size={14} style={{ color: accent }} />
            <span className="text-[11px] font-semibold uppercase tracking-[0.1em]" style={{ color: muted }}>
              Explorer
            </span>
          </div>
          {explorerCollapsed
            ? <ChevronRight size={12} style={{ color: muted }} />
            : <ChevronDown size={12} style={{ color: muted }} />}
        </button>

        <AnimatePresence initial={false}>
          {!explorerCollapsed && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease }}
              className="flex-1 overflow-y-auto min-h-0 auto-scroll"
              ref={explorerScrollRef}
            >
              <ExplorerPanel />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* To-Do Section */}
      <div
        className="shrink-0 border-t"
        style={{ borderColor: border, maxHeight: '45%' }}
      >
        <button
          className="w-full flex items-center justify-between px-3 h-9 transition-colors"
          style={{ borderBottom: todoCollapsed ? 'none' : '1px solid ' + border }}
          onClick={() => togglePanel('todo')}
          onMouseEnter={(e) => { e.currentTarget.style.background = accent + '08'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <div className="flex items-center gap-2">
            <CheckSquare size={14} style={{ color: accent }} />
            <span className="text-[11px] font-semibold uppercase tracking-[0.1em]" style={{ color: muted }}>
              To-Do
            </span>
          </div>
          {todoCollapsed
            ? <ChevronRight size={12} style={{ color: muted }} />
            : <ChevronDown size={12} style={{ color: muted }} />}
        </button>

        <AnimatePresence initial={false}>
          {!todoCollapsed && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease }}
              className="overflow-y-auto auto-scroll"
              style={{ maxHeight: '260px' }}
              ref={todoScrollRef}
            >
              <TodoPanel />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
