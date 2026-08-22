'use client';

import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, MessageSquare, Plus, ArrowRight, X } from 'lucide-react';
import { useDashboardStore } from '@/lib/dashboard-store';
import { useTheme, bdr, staggerContainer, fadeInUp, ease } from '@/lib/dashboard-helpers';
import { SessionCard } from './SessionCard';

// ============================================================
// SESSIONS VIEW
// ============================================================
export function SessionsView() {
  const selectedProjectId = useDashboardStore((s) => s.selectedProjectId);
  const projects = useDashboardStore((s) => s.projects);
  const sessions = useDashboardStore((s) => s.sessions);
  const addSession = useDashboardStore((s) => s.addSession);
  const deleteSession = useDashboardStore((s) => s.deleteSession);
  const searchQuery = useDashboardStore((s) => s.searchQuery);
  const { isDark, card, border, text, muted, accent } = useTheme();

  const [isCreating, setIsCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const projectSessions = selectedProjectId ? sessions[selectedProjectId] || [] : [];
  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return projectSessions;
    const q = searchQuery.toLowerCase();
    return projectSessions.filter((s) =>
      s.title.toLowerCase().includes(q) ||
      s.preview.toLowerCase().includes(q) ||
      s.model.toLowerCase().includes(q)
    );
  }, [projectSessions, searchQuery]);

  const handleCreate = useCallback(() => {
    if (newTitle.trim() && selectedProjectId) {
      addSession(selectedProjectId, newTitle.trim());
      setNewTitle('');
      setIsCreating(false);
    }
  }, [newTitle, selectedProjectId, addSession]);

  useEffect(() => {
    if (isCreating) setTimeout(() => inputRef.current?.focus(), 100);
  }, [isCreating]);

  return (
    <motion.main
      key="sessions"
      initial="initial"
      animate="animate"
      exit="exit"
      variants={fadeInUp}
      className="flex-1 flex flex-col rounded-lg overflow-hidden min-w-0"
      style={{ backgroundColor: card, border: bdr('1.5px', border) }}
    >
      {/* Header */}
      <div
        className="px-4 md:px-5 py-3 flex items-center justify-between gap-3 flex-wrap"
        style={{ borderBottom: bdr('1.5px', border) }}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 text-[12px] font-bold text-white"
            style={{ backgroundColor: (selectedProject?.color || accent) + 'CC' }}
          >
            {selectedProject?.name.charAt(0).toUpperCase() || '?'}
          </div>
          <h2 className="text-[13px] font-bold truncate" style={{ color: text }}>
            {selectedProject?.name || 'Sessions'}
          </h2>
          <span
            className="text-[9px] font-bold px-1.5 py-px rounded-md flex-shrink-0"
            style={{ backgroundColor: accent + '12', color: accent }}
          >
            {filtered.length}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <AnimatePresence mode="wait">
            {isCreating ? (
              <motion.div
                key="creating"
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 'auto' }}
                exit={{ opacity: 0, width: 0 }}
                className="flex items-center gap-1.5 overflow-hidden"
              >
                <input
                  ref={inputRef}
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="Session title..."
                  className="text-[12px] w-40 px-3 py-1.5 rounded-lg outline-none"
                  style={{
                    backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.025)',
                    border: bdr('1.5px', accent + '40'),
                    color: text,
                    fontFamily: "'Space Grotesk', sans-serif",
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreate();
                    if (e.key === 'Escape') setIsCreating(false);
                  }}
                  onBlur={() => { if (!newTitle.trim()) setIsCreating(false); }}
                />
                <button
                  onClick={handleCreate}
                  className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer"
                  style={{ backgroundColor: accent, color: '#fff', border: bdr('1.5px', accent) }}
                >
                  <ArrowRight size={13} />
                </button>
                <button
                  onClick={() => setIsCreating(false)}
                  className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer"
                  style={{ backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)', color: muted, border: bdr('1.5px', border) }}
                >
                  <X size={13} />
                </button>
              </motion.div>
            ) : (
              <motion.button
                key="button"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                onClick={() => setIsCreating(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-transform duration-200 hover:scale-[1.03] active:scale-[0.97] cursor-pointer"
                style={{ backgroundColor: accent + 'DD', color: '#fff' }}
              >
                <Plus size={13} strokeWidth={2.5} />
                New Session
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto p-3 md:p-4 custom-scrollbar">
        {filtered.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center justify-center p-10"
          >
            <div className="text-center">
              <div
                className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-3"
                style={{ backgroundColor: accent + '08', border: bdr('1.5px', border) }}
              >
                {searchQuery ? <Search size={20} style={{ color: muted }} /> : <MessageSquare size={20} style={{ color: muted }} />}
              </div>
              <h3 className="text-[13px] font-bold mb-1" style={{ color: text }}>
                {searchQuery ? 'No matching sessions' : 'No sessions yet'}
              </h3>
              <p className="text-[11px]" style={{ color: muted }}>
                {searchQuery ? `No sessions match "${searchQuery}"` : 'Start your first session for this project'}
              </p>
            </div>
          </motion.div>
        ) : (
          <motion.div variants={staggerContainer} initial="initial" animate="animate" className="grid gap-2.5">
            {filtered.map((session) => (
              <SessionCard key={session.id} session={session} onDelete={() => deleteSession(selectedProjectId!, session.id)} />
            ))}
          </motion.div>
        )}
      </div>
    </motion.main>
  );
}