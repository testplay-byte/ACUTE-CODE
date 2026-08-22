import { motion } from "framer-motion";
import { Moon, Sun } from "lucide-react";
import { APP_NAME } from "../../lib/version";
import { THEMES, useThemeStore } from "../../lib/theme-store";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { dropIn } from "../../lib/motion";
import { bdr, withAlpha } from "../dashboard/helpers";

/** Accent-theme switcher ported from the demo's ThemeToggles.tsx ThemeToggle. */
function ThemeSwitch() {
  const themeId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);
  const { isDark, textSecondary } = useThemeStyles();
  return (
    <div
      className="flex items-center gap-0.5 rounded-lg p-0.5"
      style={{
        backgroundColor: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.03)",
      }}
      role="group"
      aria-label="Accent theme"
    >
      {THEMES.map((t) => (
        <button
          key={t.id}
          onClick={() => setTheme(t.id)}
          aria-pressed={themeId === t.id}
          className="cursor-pointer rounded-md px-2 py-1.5 text-[11px] font-semibold transition-all duration-200"
          style={{
            backgroundColor: themeId === t.id ? withAlpha(t.accent, 0.2) : "transparent",
            color: themeId === t.id ? t.accent : textSecondary,
            border: bdr("1.5px", themeId === t.id ? withAlpha(t.accent, 0.4) : "transparent"),
          }}
        >
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: t.accent }} />
            {t.name.split(" ")[0]}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Light/dark toggle ported from the demo's DarkLightToggle icon button. */
function ModeToggle() {
  const mode = useThemeStore((s) => s.mode);
  const toggleMode = useThemeStore((s) => s.toggleMode);
  const { card, border, text } = useThemeStyles();
  return (
    <button
      onClick={toggleMode}
      aria-label={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg transition-all duration-200 hover:scale-105 active:scale-95"
      style={{ backgroundColor: card, border: bdr("1.5px", border), color: text }}
    >
      {mode === "dark" ? <Sun size={14} /> : <Moon size={14} />}
    </button>
  );
}

export function TopBar() {
  return (
    <motion.header
      variants={dropIn}
      initial="initial"
      animate="animate"
      className="relative z-20 flex items-center gap-3 px-4 py-2.5"
      style={{ borderBottom: "1.5px solid var(--ac-border)" }}
    >
      <span className="text-[13px] font-bold tracking-tight">{APP_NAME}</span>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <ThemeSwitch />
        <ModeToggle />
      </div>
    </motion.header>
  );
}
