'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useDashboardStore, DASHBOARD_THEMES, type Project, type Session } from './dashboard-store';

// ============================================================
// EASING & ANIMATION VARIANTS
// ============================================================
export const ease = [0.25, 0.1, 0.25, 1] as const;

export const bdr = (w: string, c: string) => w + ' solid ' + c;

export const fadeInUp = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.4, ease } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.2, ease } },
};

export const staggerContainer = {
  animate: { transition: { staggerChildren: 0.06, delayChildren: 0.1 } },
};

export const staggerItem = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.3, ease } },
};

export const scaleIn = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1, transition: { duration: 0.3, ease } },
};

// ============================================================
// THEME HOOK
// ============================================================
export function useTheme() {
  const isDark = useDashboardStore((s) => s.isDark);
  const themeId = useDashboardStore((s) => s.themeId);
  const theme = DASHBOARD_THEMES.find((t) => t.id === themeId) || DASHBOARD_THEMES[0];
  return {
    isDark, theme,
    bg: isDark ? theme.bgDark : theme.bgLight,
    card: isDark ? theme.cardDark : theme.cardLight,
    text: isDark ? theme.textDark : theme.textLight,
    border: isDark ? theme.borderDark : theme.borderLight,
    muted: isDark ? theme.mutedDark : theme.mutedLight,
    inputBg: isDark ? theme.inputBgDark : theme.inputBgLight,
    accent: theme.accent,
    accent2: theme.accent2,
    hover: isDark ? theme.hoverDark : theme.hoverLight,
    // Faded accent variants for softer look
    accentFaded: isDark ? theme.accent + '40' : theme.accent + '25',
    accentSoft: isDark ? theme.accent + '18' : theme.accent + '12',
  };
}

// ============================================================
// GREETING HOOK
// ============================================================
export function useGreeting() {
  const [greeting] = useState(() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    if (h < 21) return 'Good evening';
    return 'Good night';
  });
  return greeting;
}

// ============================================================
// FORMATTING
// ============================================================
export function fmtTokens(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}

// ============================================================
// SCROLL REVEAL HOOK (shows on scroll down, hides on scroll up)
// ============================================================
export function useScrollReveal(threshold = 100) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const container = el.closest('.overflow-y-auto') || el.parentElement;
    if (!container) return;

    const handleScroll = () => {
      setVisible(container.scrollTop > threshold);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [threshold]);

  return { ref, visible };
}

// ============================================================
// STATS COMPUTATION
// ============================================================
export function useDashboardStats() {
  const projects = useDashboardStore((s) => s.projects);
  const sessions = useDashboardStore((s) => s.sessions);

  return {
    projects,
    sessions,
    totalSessions: Object.values(sessions).reduce((s, sess) => s + sess.length, 0),
    totalTokens: Object.values(sessions).flat().reduce((s, sess) => s + sess.tokensUsed, 0),
    totalApiCalls: Object.values(sessions).flat().reduce((s, sess) => s + sess.apiCalls, 0),
    perProjectStats: projects.map((p) => {
      const projSessions = sessions[p.id] || [];
      return {
        project: p,
        sessions: projSessions.length,
        tokens: projSessions.reduce((s, sess) => s + sess.tokensUsed, 0),
        apiCalls: projSessions.reduce((s, sess) => s + sess.apiCalls, 0),
      };
    }),
  };
}

// ============================================================
// ALL SESSIONS (flat, sorted)
// ============================================================
export function useAllSessions(limit = 6) {
  const projects = useDashboardStore((s) => s.projects);
  const sessions = useDashboardStore((s) => s.sessions);
  const accent = useTheme().accent;

  const all = Object.entries(sessions).reduce<(Session & { projectName: string; projectColor: string })[]>((acc, [pid, sess]) => {
    const proj = projects.find((p) => p.id === pid);
    for (const s of sess) {
      acc.push({ ...s, projectName: proj?.name || '', projectColor: proj?.color || accent });
    }
    return acc;
  }, []);

  return all.slice(0, limit);
}
