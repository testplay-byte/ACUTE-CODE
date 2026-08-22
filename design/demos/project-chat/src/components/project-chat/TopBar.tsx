'use client';

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Sun, Moon, Search, Menu, FlaskConical,
  Palette, ChevronRight, Check, Settings, Cpu,
  Code2,
} from 'lucide-react';
import { useDashboardStore, DASHBOARD_THEMES } from '@/lib/dashboard-store';
import { useTheme } from '@/lib/dashboard-helpers';
import { useProjectChatStore, MODEL_OPTIONS } from '@/lib/project-chat-store';

const ease = [0.25, 0.1, 0.25, 1] as const;

// ============================================================
// VIEW TOGGLE BUTTON
// ============================================================
function ViewToggle({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const { isDark, accent, muted, inputBg, border, hover } = useTheme();

  return (
    <button
      onClick={onClick}
      className="h-7 px-2.5 rounded-lg border flex items-center gap-1.5 transition-all active:scale-95 text-[11px] font-medium"
      style={{
        background: active ? accent : inputBg,
        color: active ? (isDark ? '#000' : '#fff') : muted,
        borderColor: active ? accent : border,
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = hover;
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = inputBg;
      }}
      title={label}
    >
      <Icon size={13} />
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}

// ============================================================
// HAMBURGER MENU DROPDOWN
// ============================================================
function HamburgerMenu() {
  const { isDark, card, text, border, muted, accent, inputBg, hover } = useTheme();
  const hamburgerOpen = useProjectChatStore((s) => s.hamburgerOpen);
  const setHamburgerOpen = useProjectChatStore((s) => s.setHamburgerOpen);
  const themeId = useDashboardStore((s) => s.themeId);
  const setTheme = useDashboardStore((s) => s.setTheme);
  const selectedModelId = useProjectChatStore((s) => s.selectedModelId);
  const setSelectedModelId = useProjectChatStore((s) => s.setSelectedModelId);
  const sidebarOpen = useProjectChatStore((s) => s.sidebarOpen);
  const setSidebarOpen = useProjectChatStore((s) => s.setSidebarOpen);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hamburgerOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setHamburgerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [hamburgerOpen, setHamburgerOpen]);

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setHamburgerOpen(!hamburgerOpen)}
        className="w-8 h-8 rounded-xl grid place-items-center transition-all active:scale-95 hover:scale-105"
        style={{
          background: inputBg,
          color: muted,
          border: '1px solid ' + border,
        }}
        aria-label="Menu"
      >
        <Menu size={16} />
      </button>

      <AnimatePresence>
        {hamburgerOpen && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.2, ease }}
            className="absolute top-12 left-0 w-72 rounded-2xl border overflow-hidden z-50"
            style={{
              background: card,
              borderColor: border,
              boxShadow: isDark
                ? '0 16px 48px rgba(0,0,0,0.5)'
                : '0 16px 48px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.04)',
            }}
          >
            {/* Model Selection */}
            <div className="p-3">
              <div className="flex items-center gap-2 mb-2.5 px-1">
                <Cpu size={13} style={{ color: muted }} />
                <span className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: muted }}>
                  Model
                </span>
              </div>
              <div className="space-y-1">
                {MODEL_OPTIONS.map((model) => (
                  <button
                    key={model.id}
                    onClick={() => { setSelectedModelId(model.id); }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all text-left"
                    style={{
                      background: selectedModelId === model.id
                        ? (isDark ? accent + '18' : accent + '12')
                        : 'transparent',
                    }}
                    onMouseEnter={(e) => {
                      if (selectedModelId !== model.id)
                        e.currentTarget.style.background = isDark ? inputBg : hover;
                    }}
                    onMouseLeave={(e) => {
                      if (selectedModelId !== model.id)
                        e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    <div
                      className="w-8 h-8 rounded-xl grid place-items-center shrink-0 text-[12px] font-bold"
                      style={{
                        background: selectedModelId === model.id ? accent : inputBg,
                        color: selectedModelId === model.id ? (isDark ? '#000' : '#fff') : muted,
                        border: '1px solid ' + (selectedModelId === model.id ? accent : border),
                      }}
                    >
                      {model.name.charAt(0)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[13px] font-semibold" style={{ color: text }}>
                          {model.name}
                        </span>
                        {selectedModelId === model.id && (
                          <Check size={12} style={{ color: accent }} />
                        )}
                      </div>
                      <span className="text-[11px]" style={{ color: muted }}>
                        {model.provider} &middot; {model.description}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="mx-3 h-px" style={{ background: border }} />

            {/* Theme Switcher */}
            <div className="p-3">
              <div className="flex items-center gap-2 mb-2.5 px-1">
                <Palette size={13} style={{ color: muted }} />
                <span className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: muted }}>
                  Theme
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {DASHBOARD_THEMES.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTheme(t.id)}
                    className="relative flex flex-col items-center gap-2 p-3 rounded-2xl border-2 transition-all"
                    style={{
                      borderColor: themeId === t.id ? accent : border,
                      background: themeId === t.id
                        ? (isDark ? accent + '12' : accent + '08')
                        : inputBg,
                    }}
                  >
                    <div className="w-8 h-8 rounded-full" style={{ background: t.accent }} />
                    <span className="text-[12px] font-semibold" style={{ color: text }}>
                      {t.name}
                    </span>
                    {themeId === t.id && (
                      <div
                        className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full grid place-items-center"
                        style={{ background: accent, color: isDark ? '#000' : '#fff' }}
                      >
                        <Check size={10} strokeWidth={3} />
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div className="mx-3 h-px" style={{ background: border }} />

            {/* Toggle Sidebar */}
            <div className="p-3">
              <button
                onClick={() => { setSidebarOpen(!sidebarOpen); setHamburgerOpen(false); }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all text-left"
                style={{ background: inputBg }}
                onMouseEnter={(e) => { e.currentTarget.style.background = hover; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = inputBg; }}
              >
                <Settings size={15} style={{ color: muted }} />
                <span className="text-[13px] font-medium" style={{ color: text }}>
                  {sidebarOpen ? 'Hide Sidebar' : 'Show Sidebar'}
                </span>
                <ChevronRight size={14} style={{ color: muted, marginLeft: 'auto' }} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ============================================================
// TOP BAR
// ============================================================
export function TopBar() {
  const { isDark, card, text, border, muted, accent, inputBg } = useTheme();
  const toggleDark = useDashboardStore((s) => s.toggleDark);
  const experimentalMode = useProjectChatStore((s) => s.experimentalMode);
  const setExperimentalMode = useProjectChatStore((s) => s.setExperimentalMode);
  const codeVisible = useProjectChatStore((s) => s.codeVisible);
  const setCodeVisible = useProjectChatStore((s) => s.setCodeVisible);
  const [searchFocused, setSearchFocused] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <header
      className="relative z-40 flex items-center gap-3 h-[48px] shrink-0 px-3 rounded-2xl border"
      style={{
        backgroundColor: card,
        borderColor: border,
        transition: 'background-color 0.3s ease, border-color 0.3s ease',
      }}
    >
      {/* Left: Hamburger + Logo */}
      <div className="flex items-center gap-2.5 shrink-0">
        <HamburgerMenu />
        <div className="flex items-center gap-2">
          <span
            className="w-7 h-7 rounded-xl grid place-items-center text-[14px] font-bold"
            style={{ background: accent, color: isDark ? '#000' : '#fff' }}
          >
            {'\u25D0'}
          </span>
          <span
            className="font-bold text-[13px] tracking-[-0.02em] hidden sm:inline"
            style={{ color: text }}
          >
            ACUTE AGENT
          </span>
        </div>
      </div>

      {/* Center: Search bar */}
      <div className="flex-1 max-w-md mx-auto">
        <div
          className="flex items-center gap-2.5 h-8 px-3.5 rounded-xl border transition-all"
          style={{
            background: inputBg,
            borderColor: searchFocused ? accent : border,
            boxShadow: searchFocused ? '0 0 0 3px ' + accent + '20' : 'none',
          }}
        >
          <Search size={14} style={{ color: searchFocused ? accent : muted, flexShrink: 0 }} />
          <input
            ref={searchRef}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            placeholder="Search files, commands..."
            className="flex-1 bg-transparent outline-none text-[13px] placeholder:opacity-50"
            style={{ color: text }}
          />
          <kbd
            className="hidden sm:inline-flex items-center h-5 px-1.5 rounded-lg text-[10px] font-mono font-medium"
            style={{ background: card, color: muted, border: '1px solid ' + border }}
          >
            {'\u2318K'}
          </kbd>
        </div>
      </div>

      {/* Right: Code toggle + Experimental + Dark/Light */}
      <div className="flex items-center gap-1.5 shrink-0">
        <ViewToggle
          icon={Code2}
          label="Code"
          active={codeVisible}
          onClick={() => setCodeVisible(!codeVisible)}
        />

        <button
          onClick={() => setExperimentalMode(!experimentalMode)}
          className="h-7 px-2.5 rounded-lg border flex items-center gap-1.5 transition-all active:scale-95 text-[11px] font-medium"
          style={{
            background: experimentalMode ? accent : inputBg,
            color: experimentalMode ? (isDark ? '#000' : '#fff') : muted,
            borderColor: experimentalMode ? accent : border,
          }}
          title={experimentalMode ? 'Exit experimental layout' : 'Try experimental layout'}
        >
          <FlaskConical size={13} />
          <span className="hidden md:inline">Experimental</span>
        </button>

        <button
          onClick={toggleDark}
          className="w-8 h-8 rounded-xl grid place-items-center border transition-all active:scale-95 hover:scale-105"
          style={{ background: inputBg, borderColor: border, color: text }}
          aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {isDark ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </div>
    </header>
  );
}
