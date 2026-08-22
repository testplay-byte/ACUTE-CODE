'use client';

import { motion } from 'framer-motion';
import { MessageSquare, Clock, Trash2, ArrowRight } from 'lucide-react';
import { useDashboardStore, type Session } from '@/lib/dashboard-store';
import { useTheme, bdr, staggerItem, fmtTokens } from '@/lib/dashboard-helpers';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card';

// ============================================================
// SESSION CARD (with hover detail panel)
// ============================================================
export function SessionCard({ session, onDelete }: { session: Session; onDelete: () => void }) {
  const projects = useDashboardStore((s) => s.projects);
  const project = projects.find((p) => p.id === session.projectId);
  const { isDark, text, muted, accent, border, card } = useTheme();

  return (
    <motion.div variants={staggerItem}>
      <HoverCard openDelay={400} closeDelay={150}>
        <HoverCardTrigger asChild>
          <div
            className="group relative p-3.5 rounded-lg cursor-pointer transition-all duration-200"
            style={{ border: bdr('1.5px', border) }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLDivElement).style.backgroundColor = isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.01)';
              (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-1px)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent';
              (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)';
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <MessageSquare size={12} style={{ color: accent, opacity: 0.7 }} className="flex-shrink-0" />
                  <h3 className="text-[12px] font-bold truncate" style={{ color: text }}>{session.title}</h3>
                </div>
                <p className="text-[10px] leading-relaxed mb-2.5 line-clamp-2" style={{ color: muted }}>{session.preview}</p>
                <div className="flex items-center gap-2.5">
                  <span className="text-[9px] font-medium flex items-center gap-1" style={{ color: muted }}>
                    <Clock size={9} />{session.timestamp}
                  </span>
                  <span
                    className="text-[9px] font-bold px-1.5 py-px rounded-md"
                    style={{ backgroundColor: accent + '12', color: accent }}
                  >
                    {session.model}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(); }}
                  className="w-6 h-6 rounded-md flex items-center justify-center transition-all duration-150 cursor-pointer hover:scale-110"
                  style={{ color: muted }}
                >
                  <Trash2 size={11} />
                </button>
                <div
                  className="w-6 h-6 rounded-md flex items-center justify-center"
                  style={{ backgroundColor: accent + '10', color: accent }}
                >
                  <ArrowRight size={12} />
                </div>
              </div>
            </div>
          </div>
        </HoverCardTrigger>
        <HoverCardContent side="right" align="start" sideOffset={10} className="p-0 border-0 bg-transparent shadow-none">
          <div
            className="w-64 p-3.5 space-y-3"
            style={{ backgroundColor: card, border: bdr('1.5px', border), borderRadius: '10px' }}
          >
            <div className="text-[12px] font-bold" style={{ color: text }}>{session.title}</div>
            <p className="text-[10px] leading-relaxed" style={{ color: muted }}>{session.preview}</p>
            <div className="flex gap-2">
              <div className="text-center flex-1 py-2 rounded-md" style={{ backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.025)' }}>
                <div className="text-[12px] font-bold" style={{ color: accent }}>{fmtTokens(session.tokensUsed)}</div>
                <div className="text-[9px]" style={{ color: muted }}>Tokens</div>
              </div>
              <div className="text-center flex-1 py-2 rounded-md" style={{ backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.025)' }}>
                <div className="text-[12px] font-bold" style={{ color: accent }}>{session.apiCalls}</div>
                <div className="text-[9px]" style={{ color: muted }}>API Calls</div>
              </div>
            </div>
            <div className="flex items-center gap-2 text-[10px]" style={{ color: muted }}>
              <div
                className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0 text-[8px] font-bold text-white"
                style={{ backgroundColor: (project?.color || accent) + 'BB' }}
              >
                {project?.name.charAt(0).toUpperCase() || '?'}
              </div>
              <span>{project?.name}</span>
              <span>·</span>
              <span>{session.model}</span>
              <span>·</span>
              <span>{session.timestamp}</span>
            </div>
          </div>
        </HoverCardContent>
      </HoverCard>
    </motion.div>
  );
}