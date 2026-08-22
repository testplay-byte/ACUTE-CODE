'use client';

import { useDashboardStore, DASHBOARD_THEMES } from '@/lib/dashboard-store';
import { useTheme, bdr } from '@/lib/dashboard-helpers';
import { Sun, Moon } from 'lucide-react';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';

export function ThemeToggle() {
  const themeId = useDashboardStore((s) => s.themeId);
  const setTheme = useDashboardStore((s) => s.setTheme);
  const { isDark, muted, accent } = useTheme();
  return (
    <div className="flex items-center rounded-lg p-0.5 gap-0.5" style={{ backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)' }}>
      {DASHBOARD_THEMES.map((t) => (
        <button
          key={t.id} onClick={() => setTheme(t.id)}
          className="px-2 py-1.5 rounded-md text-[11px] font-semibold transition-all duration-200 cursor-pointer"
          style={{
            backgroundColor: themeId === t.id ? t.accent + '20' : 'transparent',
            color: themeId === t.id ? t.accent : muted,
            border: bdr('1.5px', themeId === t.id ? t.accent + '40' : 'transparent'),
          }}
        >
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: t.accent }} />
            {t.name.split(' ')[0]}
          </span>
        </button>
      ))}
    </div>
  );
}

export function DarkLightToggle() {
  const isDark = useDashboardStore((s) => s.isDark);
  const toggleDark = useDashboardStore((s) => s.toggleDark);
  const { card, border, text } = useTheme();
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={toggleDark}
            className="w-8 h-8 rounded-lg flex items-center justify-center transition-all duration-200 hover:scale-105 active:scale-95 cursor-pointer"
            style={{ backgroundColor: card, border: bdr('1.5px', border), color: text }}
          >
            {isDark ? <Sun size={14} /> : <Moon size={14} />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom"><p className="text-xs">{isDark ? 'Light mode' : 'Dark mode'}</p></TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
