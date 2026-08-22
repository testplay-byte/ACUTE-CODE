import { motion } from "framer-motion";
import { Moon, Sun } from "lucide-react";
import { APP_NAME } from "../../lib/version";
import { THEMES, useThemeStore } from "../../lib/theme-store";
import { dropIn } from "../../lib/motion";
import { cn } from "../../lib/utils";

/** Accent-theme switcher (the demo's ThemeToggle pill group). */
function ThemeSwitch() {
  const themeId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);
  return (
    <div
      className="flex items-center gap-0.5 rounded-lg bg-hover p-0.5"
      role="group"
      aria-label="Accent theme"
    >
      {THEMES.map((t) => (
        <button
          key={t.id}
          onClick={() => setTheme(t.id)}
          aria-pressed={themeId === t.id}
          className={cn(
            "flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-semibold transition-all duration-200",
            themeId === t.id
              ? "border-[1.5px] border-accent-faded bg-accent-soft text-accent"
              : "border-[1.5px] border-transparent text-muted hover:text-ink",
          )}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: t.accent }} />
          {t.name}
        </button>
      ))}
    </div>
  );
}

/** Light/dark toggle (the demo's DarkLightToggle icon button). */
function ModeToggle() {
  const mode = useThemeStore((s) => s.mode);
  const toggleMode = useThemeStore((s) => s.toggleMode);
  return (
    <button
      onClick={toggleMode}
      aria-label={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border-[1.5px] border-line bg-card text-ink transition-all duration-200 hover:scale-105 active:scale-95"
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
      className="relative z-20 flex items-center gap-3 border-b-[1.5px] border-line px-4 py-2.5"
    >
      <span className="text-[13px] font-bold tracking-tight">{APP_NAME}</span>
      <span className="hidden rounded-full bg-hover px-2 py-0.5 text-[10px] font-semibold text-muted sm:inline">
        workbench
      </span>
      <div className="ml-auto flex items-center gap-1.5">
        <ThemeSwitch />
        <ModeToggle />
      </div>
    </motion.header>
  );
}
