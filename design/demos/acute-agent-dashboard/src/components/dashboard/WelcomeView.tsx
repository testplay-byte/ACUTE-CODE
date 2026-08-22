'use client';

import { motion } from 'framer-motion';
import { FolderOpen, MessageSquare, Zap, Activity } from 'lucide-react';
import { useTheme, useGreeting, useDashboardStats, fmtTokens, fadeInUp, staggerContainer, ease } from '@/lib/dashboard-helpers';
import { StatCard } from './StatCard';
import { TokenBarChart } from './TokenBarChart';
import { QuickActions } from './QuickActions';
import { RecentActivity } from './RecentActivity';

// ============================================================
// WELCOME VIEW
// ============================================================
export function WelcomeView() {
  const greeting = useGreeting();
  const { totalSessions, totalTokens, totalApiCalls, projects } = useDashboardStats();
  const { isDark, text, muted, accent, accent2, border } = useTheme();

  return (
    <motion.div
      key="welcome"
      initial="initial"
      animate="animate"
      exit="exit"
      variants={fadeInUp}
      className="flex-1 overflow-y-auto p-4 md:p-6 custom-scrollbar"
    >
      <div className="max-w-3xl mx-auto relative pb-32">
        {/* Decorative shapes (subtle, faded) */}
        <div
          className="absolute -top-8 -left-16 w-32 h-32 rounded-full blur-3xl pointer-events-none"
          style={{ backgroundColor: accent, opacity: 0.04 }}
        />
        <div
          className="absolute -top-4 right-0 w-24 h-24 rounded-2xl blur-2xl pointer-events-none rotate-12"
          style={{ backgroundColor: accent2, opacity: 0.03 }}
        />
        <div
          className="absolute top-24 -right-8 w-16 h-16 rounded-full blur-2xl pointer-events-none"
          style={{ backgroundColor: accent, opacity: 0.025 }}
        />

        {/* Big, bold greeting — two lines, 3x size, softer feel */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease }}
          className="mb-8 pt-2"
        >
          <h1
            className="font-bold tracking-tight leading-[1.1]"
            style={{
              color: text,
              fontSize: 'clamp(2.5rem, 5vw, 4.5rem)',
              fontFamily: "'Space Grotesk', ui-sans-serif, system-ui, sans-serif",
            }}
          >
            {greeting}
          </h1>
          <h2
            className="font-medium tracking-tight leading-[1.15]"
            style={{
              color: accent,
              fontSize: 'clamp(2rem, 4vw, 3.5rem)',
              fontFamily: "'Space Grotesk', ui-sans-serif, system-ui, sans-serif",
              opacity: 0.8,
            }}
          >
            Welcome back to{' '}
            <span className="font-bold" style={{ opacity: 1 }}>
              Acute Agent
            </span>
          </h2>
          <p
            className="text-sm md:text-base mt-3"
            style={{ color: muted }}
          >
            Here’s what’s happening across your workspace.
          </p>
        </motion.div>

        {/* Stats grid */}
        <motion.div
          variants={staggerContainer}
          initial="initial"
          animate="animate"
          className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-5"
        >
          <StatCard value={String(projects.length)} label="Projects" icon={FolderOpen} />
          <StatCard value={String(totalSessions)} label="Sessions" icon={MessageSquare} tooltipType="sessions" delay={0.05} />
          <StatCard value={fmtTokens(totalTokens)} label="Tokens Used" icon={Zap} tooltipType="tokens" delay={0.1} />
          <StatCard value={String(totalApiCalls)} label="API Calls" icon={Activity} tooltipType="apiCalls" delay={0.15} />
        </motion.div>

        {/* Weekly chart + Quick Actions */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 mb-6">
          <TokenBarChart delay={0.2} />
          <QuickActions delay={0.25} />
        </div>

        {/* Scroll-to-reveal Recent Activity */}
        <RecentActivity />
      </div>
    </motion.div>
  );
}
