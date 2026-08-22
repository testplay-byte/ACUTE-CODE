'use client';

import { useRef, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, X, Menu } from 'lucide-react';
import { useDashboardStore, type Session } from '@/lib/dashboard-store';
import { useTheme, bdr, ease } from '@/lib/dashboard-helpers';
import { ThemeToggle, DarkLightToggle } from './ThemeToggles';

// ============================================================
// SEARCH DROPDOWN
// ============================================================
function SearchDropdown() {
  const searchQuery = useDashboardStore((s) => s.searchQuery);
  const searchOpen = useDashboardStore((s) => s.searchOpen);
  const setSearchOpen = useDashboardStore((s) => s.setSearchOpen);
  const selectProject = useDashboardStore((s) => s.selectProject);
  const projects = useDashboardStore((s) => s.projects);
  const sessions = useDashboardStore((s) => s.sessions);
  const { card, border, text, muted, accent, hover } = useTheme();

  const results = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    const flat: (Session & { projectName: string; projectColor: string })[] = [];
    for (const [pid, sess] of Object.entries(sessions)) {
      const proj = projects.find((p) => p.id === pid);
      for (const s of sess) {
        if (
          s.title.toLowerCase().includes(q) ||
          s.preview.toLowerCase().includes(q) ||
          s.model.toLowerCase().includes(q) ||
          (proj?.name || '').toLowerCase().includes(q)
        ) {
          flat.push({ ...s, projectName: proj?.name || '', projectColor: proj?.color || accent });
        }
      }
    }
    return flat.slice(0, 8);
  }, [searchQuery, sessions, projects, accent]);

  if (!searchOpen || !searchQuery.trim() || results.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.98 }}
      className="absolute top-full left-0 right-0 mt-1.5 rounded-lg overflow-hidden z-50"
      style={{ backgroundColor: card, border: bdr('1.5px', border), boxShadow: '0 8px 32px rgba(0,0,0,0.1)' }}
    >
      <div className="max-h-72 overflow-y-auto custom-scrollbar">
        {results.map((s) => (
          <button
            key={s.id}
            onClick={() => { selectProject(s.projectId); setSearchOpen(false); }}
            className="w-full text-left px-3.5 py-2.5 flex items-start gap-3 transition-colors duration-150 cursor-pointer"
            style={{ borderBottom: bdr('1px', border) }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = hover; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
          >
            <div
              className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0 text-[10px] font-bold text-white mt-0.5"
              style={{ backgroundColor: s.projectColor }}
            >
              {s.projectName.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-semibold truncate" style={{ color: text }}>{s.title}</div>
              <div className="text-[10px] mt-0.5 flex items-center gap-1.5" style={{ color: muted }}>
                <span>{s.projectName}</span>
                <span>·</span>
                <span>{s.timestamp}</span>
                <span>·</span>
                <span style={{ color: accent }}>{s.model}</span>
              </div>
            </div>
          </button>
        ))}
      </div>
    </motion.div>
  );
}

// ============================================================
// TOP BAR
// ============================================================
export function TopBar() {
  const searchQuery = useDashboardStore((s) => s.searchQuery);
  const setSearchQuery = useDashboardStore((s) => s.setSearchQuery);
  const searchOpen = useDashboardStore((s) => s.searchOpen);
  const setSearchOpen = useDashboardStore((s) => s.setSearchOpen);
  const toggleSidebar = useDashboardStore((s) => s.toggleSidebar);
  const { isDark, border, text, muted } = useTheme();
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setSearchOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [setSearchOpen]);

  return (
    <motion.header
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease }}
      className="relative z-20 flex items-center gap-3 px-4 py-2.5"
      style={{ borderBottom: bdr('1.5px', border) }}
    >
      <button
        onClick={toggleSidebar}
        className="lg:hidden w-8 h-8 rounded-lg flex items-center justify-center transition-all duration-200 cursor-pointer"
        style={{ backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)', border: bdr('1.5px', border), color: text }}
      >
        <Menu size={15} />
      </button>

      {/* Centered search */}
      <div className="flex-1 flex justify-center">
        <div ref={wrapperRef} className="relative w-full max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: muted }} />
          <input
            ref={inputRef}
            type="text" value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setSearchOpen(true); }}
            onFocus={() => { if (searchQuery) setSearchOpen(true); }}
            onKeyDown={(e) => { if (e.key === 'Escape') setSearchOpen(false); }}
            placeholder="Search sessions..."
            className="w-full pl-8 pr-8 py-2 rounded-lg text-[13px] outline-none transition-colors duration-300"
            style={{
              backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.025)',
              border: bdr('1.5px', border),
              color: text,
              fontFamily: "'Space Grotesk', sans-serif",
            }}
          />
          {searchQuery && (
            <button
              onClick={() => { setSearchQuery(''); setSearchOpen(false); inputRef.current?.focus(); }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 cursor-pointer"
              style={{ color: muted }}
            >
              <X size={13} />
            </button>
          )}
          <AnimatePresence>{searchOpen && <SearchDropdown />}</AnimatePresence>
        </div>
      </div>

      {/* Rightmost controls */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <ThemeToggle />
        <DarkLightToggle />
      </div>
    </motion.header>
  );
}
