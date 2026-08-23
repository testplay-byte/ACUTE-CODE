import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Sun, Moon, Menu, FlaskConical, Code2 } from "lucide-react";
import { withAlpha } from "../dashboard/helpers";
import { useProjectChatStore } from "../../lib/project-chat-store";
import { useThemeStore } from "../../lib/theme-store";
import { useThemeStyles } from "../../lib/use-theme-styles";

/**
 * Demo TopBar ported onto live data (round-15 revision per owner):
 * the hamburger (three lines) now toggles the APP sidebar — the chat screen
 * is fullscreen — instead of opening a dropdown (the owner explicitly removed
 * those menu options for now; agent selection lives in the chat header).
 * The center search stays: ⌘K focuses it, results are REAL project files,
 * clicking one opens it in the code panel.
 */

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

export function TopBar({ onPickFile, files }: { onPickFile: (path: string) => void; files: string[] }) {
  const styles = useThemeStyles();
  const mode = useThemeStore((s) => s.mode);
  const toggleMode = useThemeStore((s) => s.toggleMode);
  const experimentalMode = useProjectChatStore((s) => s.experimentalMode);
  const setExperimentalMode = useProjectChatStore((s) => s.setExperimentalMode);
  const codeVisible = useProjectChatStore((s) => s.codeVisible);
  const setCodeVisible = useProjectChatStore((s) => s.setCodeVisible);
  const appSidebarVisible = useProjectChatStore((s) => s.appSidebarVisible);
  const setAppSidebarVisible = useProjectChatStore((s) => s.setAppSidebarVisible);

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

  const toggleButton = (
    icon: React.ReactNode,
    label: string,
    active: boolean,
    onClick: () => void,
    extraStyle: React.CSSProperties = {},
  ) => (
    <button
      onClick={onClick}
      aria-pressed={active}
      title={label}
      aria-label={label}
      className="h-7 px-2.5 rounded-lg border flex items-center gap-1.5 transition-all active:scale-95 text-[11px] font-medium shrink-0"
      style={{
        background: active ? styles.accent : styles.inputBg,
        color: active ? styles.accentText : styles.textSecondary,
        borderColor: active ? styles.accent : styles.border,
        ...extraStyle,
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = styles.subtleHover;
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = styles.inputBg;
      }}
    >
      {icon}
    </button>
  );

  return (
    <header
      className="relative z-40 flex items-center gap-3 h-[48px] shrink-0 px-3 rounded-2xl border"
      style={{
        backgroundColor: styles.card,
        borderColor: styles.border,
        transition: "background-color 0.3s ease, border-color 0.3s ease",
      }}
    >
      {/* Left: hamburger toggles the app sidebar (round-15) + brand */}
      <div className="flex items-center gap-2.5 shrink-0">
        <button
          onClick={() => setAppSidebarVisible(!appSidebarVisible)}
          className="w-8 h-8 rounded-xl grid place-items-center transition-all active:scale-95 hover:scale-105"
          style={{ background: styles.inputBg, color: styles.textSecondary, border: `1px solid ${styles.border}` }}
          aria-label={appSidebarVisible ? "Hide menu" : "Show menu"}
          title={appSidebarVisible ? "Hide menu" : "Show menu"}
        >
          <Menu size={16} />
        </button>
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

      {/* Center: file search (live project files) */}
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

      {/* Right: Code toggle + Experimental + dark/light */}
      <div className="flex items-center gap-1.5 shrink-0">
        {toggleButton(<Code2 size={13} />, "Code", codeVisible, () => setCodeVisible(!codeVisible))}
        {toggleButton(
          <>
            <FlaskConical size={13} />
            <span className="hidden md:inline">Experimental</span>
          </>,
          experimentalMode ? "Exit experimental layout" : "Try experimental layout",
          experimentalMode,
          () => setExperimentalMode(!experimentalMode),
        )}
        {toggleButton(
          mode === "dark" ? <Sun size={13} /> : <Moon size={13} />,
          mode === "dark" ? "Switch to light mode" : "Switch to dark mode",
          false,
          toggleMode,
          { width: 32, justifyContent: "center" },
        )}
      </div>
    </header>
  );
}
