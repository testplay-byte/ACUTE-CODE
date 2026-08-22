'use client';

import { motion } from 'framer-motion';
import { useTheme, bdr, scaleIn, fmtTokens, useDashboardStats } from '@/lib/dashboard-helpers';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card';

// ============================================================
// STAT TOOLTIP (portrait-style, per-project breakdown)
// ============================================================
function StatTooltip({ type }: { type: 'sessions' | 'tokens' | 'apiCalls' }) {
  const { perProjectStats } = useDashboardStats();
  const { card, text, muted, accent, border, isDark } = useTheme();

  const sortedStats = [...perProjectStats].filter((p) =>
    type === 'sessions' ? p.sessions > 0 : type === 'tokens' ? p.tokens > 0 : p.apiCalls > 0
  ).sort((a, b) => {
    if (type === 'sessions') return b.sessions - a.sessions;
    if (type === 'tokens') return b.tokens - a.tokens;
    return b.apiCalls - a.apiCalls;
  });

  const label = type === 'sessions' ? 'Sessions' : type === 'tokens' ? 'Tokens' : 'API Calls';
  const total = sortedStats.reduce((s, p) => {
    if (type === 'sessions') return s + p.sessions;
    if (type === 'tokens') return s + p.tokens;
    return s + p.apiCalls;
  }, 0);

  return (
    <div
      className="w-52 p-3.5 space-y-2.5"
      style={{ backgroundColor: card, border: bdr('1.5px', border), borderRadius: '10px' }}
    >
      <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: muted }}>
        {label} Breakdown
      </div>

      <div className="space-y-1.5">
        {sortedStats.map(({ project, sessions: sess, tokens, apiCalls }) => {
          const value = type === 'sessions' ? sess : type === 'tokens' ? tokens : apiCalls;
          const displayValue = type === 'tokens' ? fmtTokens(value) : String(value);
          const pct = total > 0 ? Math.round((value / total) * 100) : 0;
          return (
            <div key={project.id} className="flex items-center gap-2.5">
              <div
                className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0 text-[9px] font-bold text-white"
                style={{ backgroundColor: project.color + 'BB' }}
              >
                {project.name.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium truncate" style={{ color: text }}>{project.name}</span>
                  <span className="text-[11px] font-bold ml-2 flex-shrink-0" style={{ color: accent }}>{displayValue}</span>
                </div>
                <div className="mt-1 h-1 rounded-full overflow-hidden" style={{ backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }}>
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${pct}%`, backgroundColor: project.color + '99' }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="pt-1.5 flex items-center justify-between" style={{ borderTop: bdr('1px', border) }}>
        <span className="text-[10px]" style={{ color: muted }}>Total</span>
        <span className="text-[11px] font-bold" style={{ color: text }}>
          {type === 'tokens' ? fmtTokens(total) : String(total)}
        </span>
      </div>
    </div>
  );
}

// ============================================================
// STAT CARD (no top gradient bar, cleaner UI, faded colors)
// ============================================================
export function StatCard({ value, label, icon: Icon, delay = 0, tooltipType }: {
  value: string; label: string; icon: React.ElementType; delay?: number; tooltipType?: 'sessions' | 'tokens' | 'apiCalls';
}) {
  const { card, border, text, muted, accent, accentSoft, isDark } = useTheme();

  const cardEl = (
    <motion.div
      variants={scaleIn}
      whileHover={{ y: -1, transition: { duration: 0.2 } }}
      className="relative p-3.5 rounded-lg overflow-hidden cursor-default"
      style={{ backgroundColor: card, border: bdr('1.5px', border) }}
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xl font-bold tracking-tight" style={{ color: text }}>{value}</div>
          <div className="text-[11px] font-medium mt-0.5" style={{ color: muted }}>{label}</div>
        </div>
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: accentSoft }}
        >
          <Icon size={16} style={{ color: accent, opacity: 0.7 }} />
        </div>
      </div>
    </motion.div>
  );

  if (!tooltipType) return cardEl;

  return (
    <HoverCard openDelay={350} closeDelay={150}>
      <HoverCardTrigger asChild>{cardEl}</HoverCardTrigger>
      <HoverCardContent side="bottom" align="start" sideOffset={8} className="p-0 border-0 bg-transparent shadow-none">
        <StatTooltip type={tooltipType} />
      </HoverCardContent>
    </HoverCard>
  );
}