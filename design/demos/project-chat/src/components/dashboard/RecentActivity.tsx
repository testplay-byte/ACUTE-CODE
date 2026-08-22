'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { useTheme, bdr, staggerContainer, staggerItem, fmtTokens, useScrollReveal, useAllSessions } from '@/lib/dashboard-helpers';

// ============================================================
// RECENT SESSION CARD (for welcome page)
// ============================================================
function RecentSessionCard({
  session, projectName, projectColor,
}: {
  session: { id: string; title: string; preview: string; timestamp: string; tokensUsed: number }; projectName: string; projectColor: string;
}) {
  const { isDark, text, muted, border } = useTheme();
  return (
    <motion.div
      variants={staggerItem}
      className="p-3 rounded-lg cursor-pointer transition-all duration-200"
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
      <div className="flex items-start gap-2.5">
        <div
          className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0 text-[9px] font-bold text-white mt-0.5"
          style={{ backgroundColor: projectColor + 'BB' }}
        >
          {projectName.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold truncate" style={{ color: text }}>{session.title}</div>
          <div className="text-[10px] leading-relaxed mt-0.5 line-clamp-1" style={{ color: muted }}>{session.preview}</div>
          <div className="flex items-center gap-1.5 mt-1.5">
            <span className="text-[9px] font-medium" style={{ color: projectColor + 'CC' }}>{projectName}</span>
            <span className="text-[9px]" style={{ color: border }}>·</span>
            <span className="text-[9px]" style={{ color: muted }}>{session.timestamp}</span>
            <span className="text-[9px]" style={{ color: border }}>·</span>
            <span className="text-[9px] font-semibold" style={{ color: muted }}>{fmtTokens(session.tokensUsed)} tokens</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ============================================================
// RECENT ACTIVITY (scroll-reveal section)
// ============================================================
export function RecentActivity() {
  const { ref, visible } = useScrollReveal(40);
  const allSessions = useAllSessions(6);
  const { text, muted } = useTheme();

  return (
    <div ref={ref} className="min-h-[200px]">
      <AnimatePresence>
        {visible && (
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ duration: 0.45, ease: [0.25, 0.1, 0.25, 1] }}
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[13px] font-bold" style={{ color: text }}>Recent Activity</h2>
              <span className="text-[10px] font-medium" style={{ color: muted }}>Across all projects</span>
            </div>
            <motion.div variants={staggerContainer} initial="initial" animate="animate" className="grid gap-2">
              {allSessions.map((s) => (
                <RecentSessionCard key={s.id} session={s} projectName={s.projectName} projectColor={s.projectColor} />
              ))}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}