import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  ChevronRight,
  Code2,
  Cpu,
  FlaskConical,
  Menu,
  Moon,
  Palette,
  Search,
  Settings,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { useAgents } from "../../hooks/use-agents";
import { withAlpha } from "../dashboard/helpers";
import { ease } from "../../lib/motion";
import { useProjectChatStore } from "../../lib/project-chat-store";
import { useThemeStore, THEMES } from "../../lib/theme-store";
import { useThemeStyles } from "../../lib/use-theme-styles";

/**
 * Demo TopBar ported 1:1 (round-14 parity) onto live data:
 * hamburger → AGENT picker (real agents; sets the agent for NEW sessions) +
 * THEME grid (the app's real theme engine) + Show/Hide Sidebar; center search
 * filters the project tree (real files) and selects a file on click; right =
 * Code toggle + Experimental layout toggle + dark/light toggle.
 */

function ViewToggle({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const styles = useThemeStyles();
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className="h-7 px-2.5 rounded-lg border flex items-center gap-1.5 transition-all active:scale-95 text-[11px] font-medium shrink-0"
      style={{
        background: active ? styles.accent : styles.inputBg,
        color: active ? styles.accentText : styles.textSecondary,
        borderColor: active ? styles.accent : styles.border,
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = styles.subtleHover;
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = styles.inputBg;
      }}
      title={label}
    >
      <Icon size={13} />
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}

/** Flatten a tree into file paths (used by the screen to feed the search). */
export function flattenTreeFiles(
  nodes: { name: string; type: string; path: string; children?: unknown[] }[],
): string[] {
  const out: string[] = [];
  const walk = (list: typeof nodes) => {
    for (const n of list) {
      if (n.type === "file") out.push(n.path);
      else if (n.children) walk(n.children as typeof nodes);
    }
  };
  walk(nodes);
  return out;
}

function HamburgerMenu({ onPickFile, files }: { onPickFile: (path: string) => void; files: string[] }) {
  const styles = useThemeStyles();
  const agents = useAgents(false).data ?? [];
  const hamburgerOpen = useProjectChatStore((s) => s.hamburgerOpen);
  const setHamburgerOpen = useProjectChatStore((s) => s.setHamburgerOpen);
  const selectedAgentId = useProjectChatStore((s) => s.selectedAgentId);
  const setSelectedAgentId = useProjectChatStore((s) => s.setSelectedAgentId);
  const sidebarOpen = useProjectChatStore((s) => s.sidebarOpen);
  const setSidebarOpen = useProjectChatStore((s) => s.setSidebarOpen);
  const themeId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!hamburgerOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setHamburgerOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [hamburgerOpen, setHamburgerOpen]);

  const activeAgentId = selectedAgentId ?? agents[0]?.id ?? null;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return [];
    return files.filter((p) => p.toLowerCase().includes(q)).slice(0, 8);
  }, [query, files]);

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setHamburgerOpen(!hamburgerOpen)}
        className="w-8 h-8 rounded-xl grid place-items-center transition-all active:scale-95 hover:scale-105"
        style={{ background: styles.inputBg, color: styles.textSecondary, border: `1px solid ${styles.border}` }}
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
            className="absolute top-12 left-0 w-72 rounded-2xl border overflow-hidden z-50 max-h-[80vh] overflow-y-auto auto-scroll"
            style={{ background: styles.card, borderColor: styles.border, boxShadow: styles.bentoShadow }}
          >
            {/* Agent selection (live agents; used for NEW sessions) */}
            <div className="p-3">
              <div className="flex items-center gap-2 mb-2.5 px-1">
                <Cpu size={13} style={{ color: styles.textSecondary }} />
                <span
                  className="text-[11px] font-semibold uppercase tracking-widest"
                  style={{ color: styles.textSecondary }}
                >
                  Agent
                </span>
              </div>
              {agents.length === 0 ? (
                <div className="text-[12px] px-1 py-2" style={{ color: styles.textSecondary }}>
                  No agents yet — create one in Settings → Agents.
                </div>
              ) : (
                <div className="space-y-1">
                  {agents.map((agent) => (
                    <button
                      key={agent.id}
                      onClick={() => {
                        setSelectedAgentId(agent.id);
                        setHamburgerOpen(false);
                      }}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all text-left"
                      style={{
                        background:
                          activeAgentId === agent.id ? withAlpha(styles.accent, 0.09) : "transparent",
                      }}
                      onMouseEnter={(e) => {
                        if (activeAgentId !== agent.id)
                          e.currentTarget.style.background = styles.subtleHover;
                      }}
                      onMouseLeave={(e) => {
                        if (activeAgentId !== agent.id) e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <div
                        className="w-8 h-8 rounded-xl grid place-items-center shrink-0 text-[12px] font-bold"
                        style={{
                          background: activeAgentId === agent.id ? styles.accent : styles.inputBg,
                          color: activeAgentId === agent.id ? styles.accentText : styles.textSecondary,
                          border: `1px solid ${activeAgentId === agent.id ? styles.accent : styles.border}`,
                        }}
                      >
                        {agent.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[13px] font-semibold truncate" style={{ color: styles.text }}>
                            {agent.name}
                          </span>
                          {activeAgentId === agent.id && <Check size={12} style={{ color: styles.accent }} />}
                        </div>
                        <span className="text-[11px] truncate block" style={{ color: styles.textSecondary }}>
                          {agent.providerId ?? "no provider"} · {agent.model ?? "no model"}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="mx-3 h-px" style={{ background: styles.border }} />

            {/* File search (real project tree) */}
            <div className="p-3">
              <div className="flex items-center gap-2 mb-2.5 px-1">
                <Search size={13} style={{ color: styles.textSecondary }} />
                <span
                  className="text-[11px] font-semibold uppercase tracking-widest"
                  style={{ color: styles.textSecondary }}
                >
                  Files
                </span>
              </div>
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search project files…"
                className="w-full h-8 px-3 rounded-xl border outline-none text-[12px]"
                style={{
                  background: styles.inputBg,
                  borderColor: styles.border,
                  color: styles.text,
                }}
              />
              {matches.length > 0 && (
                <div className="mt-2 space-y-0.5">
                  {matches.map((path) => (
                    <button
                      key={path}
                      onClick={() => {
                        onPickFile(path);
                        setHamburgerOpen(false);
                        setQuery("");
                      }}
                      className="w-full text-left px-3 py-1.5 rounded-lg font-mono text-[11px] truncate"
                      style={{ color: styles.textSecondary }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = styles.subtleHover;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                      }}
                      title={path}
                    >
                      {path}
                    </button>
                  ))}
                </div>
              )}
              {query.trim() !== "" && matches.length === 0 && (
                <div className="mt-2 text-[11px] px-1" style={{ color: styles.textTertiary }}>
                  no matching files
                </div>
              )}
            </div>

            <div className="mx-3 h-px" style={{ background: styles.border }} />

            {/* Theme switcher (the app's real theme engine) */}
            <div className="p-3">
              <div className="flex items-center gap-2 mb-2.5 px-1">
                <Palette size={13} style={{ color: styles.textSecondary }} />
                <span
                  className="text-[11px] font-semibold uppercase tracking-widest"
                  style={{ color: styles.textSecondary }}
                >
                  Theme
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTheme(t.id)}
                    className="relative flex flex-col items-center gap-2 p-3 rounded-2xl border-2 transition-all"
                    style={{
                      borderColor: themeId === t.id ? styles.accent : styles.border,
                      background: themeId === t.id ? withAlpha(styles.accent, 0.08) : styles.inputBg,
                    }}
                  >
                    <div className="w-8 h-8 rounded-full" style={{ background: t.accent }} />
                    <span className="text-[12px] font-semibold" style={{ color: styles.text }}>
                      {t.name}
                    </span>
                    {themeId === t.id && (
                      <div
                        className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full grid place-items-center"
                        style={{ background: styles.accent, color: styles.accentText }}
                      >
                        <Check size={10} strokeWidth={3} />
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div className="mx-3 h-px" style={{ background: styles.border }} />

            {/* Toggle sidebar */}
            <div className="p-3">
              <button
                onClick={() => {
                  setSidebarOpen(!sidebarOpen);
                  setHamburgerOpen(false);
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all text-left"
                style={{ background: styles.inputBg }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = styles.subtleHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = styles.inputBg;
                }}
              >
                <Settings size={15} style={{ color: styles.textSecondary }} />
                <span className="text-[13px] font-medium" style={{ color: styles.text }}>
                  {sidebarOpen ? "Hide Sidebar" : "Show Sidebar"}
                </span>
                <ChevronRight size={14} style={{ color: styles.textSecondary, marginLeft: "auto" }} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function TopBar({ onPickFile, files }: { onPickFile: (path: string) => void; files: string[] }) {
  const styles = useThemeStyles();
  const mode = useThemeStore((s) => s.mode);
  const toggleMode = useThemeStore((s) => s.toggleMode);
  const experimentalMode = useProjectChatStore((s) => s.experimentalMode);
  const setExperimentalMode = useProjectChatStore((s) => s.setExperimentalMode);
  const codeVisible = useProjectChatStore((s) => s.codeVisible);
  const setCodeVisible = useProjectChatStore((s) => s.setCodeVisible);

  // Demo center search: ⌘K focuses it; results are REAL project files.
  const [searchFocused, setSearchFocused] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return [];
    return files.filter((p) => p.toLowerCase().includes(q)).slice(0, 8);
  }, [query, files]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <header
      className="relative z-40 flex items-center gap-3 h-[48px] shrink-0 px-3 rounded-2xl border"
      style={{
        backgroundColor: styles.card,
        borderColor: styles.border,
        transition: "background-color 0.3s ease, border-color 0.3s ease",
      }}
    >
      {/* Left: hamburger + logo (demo-exact; the screen-level brand) */}
      <div className="flex items-center gap-2.5 shrink-0">
        <HamburgerMenu onPickFile={onPickFile} files={files} />
        <div className="flex items-center gap-2">
          <span
            className="w-7 h-7 rounded-xl grid place-items-center text-[14px] font-bold"
            style={{ background: styles.accent, color: styles.accentText }}
          >
            {"\u25D0"}
          </span>
          <span
            className="font-bold text-[13px] tracking-[-0.02em] hidden sm:inline"
            style={{ color: styles.text }}
          >
            ACUTE AGENT
          </span>
        </div>
      </div>

      <div className="flex-1" />

      {/* Center: file search (demo search bar, live project files) */}
      <div className="relative flex-1 max-w-md mx-auto min-w-0">
        <div
          className="flex items-center gap-2.5 h-8 px-3.5 rounded-xl border transition-all"
          style={{
            background: styles.inputBg,
            borderColor: searchFocused ? styles.accent : styles.border,
            boxShadow: searchFocused ? `0 0 0 3px ${withAlpha(styles.accent, 0.13)}` : "none",
          }}
        >
          <Search
            size={14}
            style={{ color: searchFocused ? styles.accent : styles.textSecondary, flexShrink: 0 }}
          />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => {
              setSearchFocused(false);
              // Let result clicks land before the dropdown unmounts.
              setTimeout(() => setQuery(""), 150);
            }}
            placeholder="Search files…"
            className="flex-1 bg-transparent outline-none text-[13px] placeholder:opacity-50 min-w-0"
            style={{ color: styles.text }}
          />
          <kbd
            className="hidden sm:inline-flex items-center h-5 px-1.5 rounded-lg text-[10px] font-mono font-medium"
            style={{ background: styles.card, color: styles.textSecondary, border: `1px solid ${styles.border}` }}
          >
            {"\u2318K"}
          </kbd>
        </div>
        {searchFocused && matches.length > 0 && (
          <div
            className="absolute top-10 left-0 right-0 rounded-2xl border overflow-hidden z-50 p-1.5"
            style={{ background: styles.card, borderColor: styles.border, boxShadow: styles.bentoShadow }}
          >
            {matches.map((path) => (
              <button
                key={path}
                onClick={() => {
                  onPickFile(path);
                  setQuery("");
                }}
                className="w-full text-left px-3 py-1.5 rounded-lg font-mono text-[11px] truncate"
                style={{ color: styles.textSecondary }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = styles.subtleHover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
                title={path}
              >
                {path}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Right: Code toggle + Experimental + dark/light (demo-exact) */}
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
            background: experimentalMode ? styles.accent : styles.inputBg,
            color: experimentalMode ? styles.accentText : styles.textSecondary,
            borderColor: experimentalMode ? styles.accent : styles.border,
          }}
          title={experimentalMode ? "Exit experimental layout" : "Try experimental layout"}
        >
          <FlaskConical size={13} />
          <span className="hidden md:inline">Experimental</span>
        </button>
        <button
          onClick={toggleMode}
          className="w-8 h-8 rounded-xl grid place-items-center border transition-all active:scale-95 hover:scale-105"
          style={{ background: styles.inputBg, borderColor: styles.border, color: styles.text }}
          aria-label={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {mode === "dark" ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </div>
    </header>
  );
}
