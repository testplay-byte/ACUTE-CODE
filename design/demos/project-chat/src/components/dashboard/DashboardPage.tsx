'use client';

import { AnimatePresence } from 'framer-motion';
import { useDashboardStore } from '@/lib/dashboard-store';
import { useTheme } from '@/lib/dashboard-helpers';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TopBar } from './TopBar';
import { DesktopSidebar, MobileSidebar } from './Sidebar';
import { WelcomeView } from './WelcomeView';
import { ProjectChatView } from '@/components/project-chat';

// ============================================================
// MAIN DASHBOARD PAGE
// ============================================================
export function DashboardPage() {
  const selectedProjectId = useDashboardStore((s) => s.selectedProjectId);
  const { isDark, bg, text, accent, border, card } = useTheme();

  // When a project is selected, show the full chat view
  if (selectedProjectId) {
    return (
      <TooltipProvider>
        <div
          className="h-screen w-full flex flex-col overflow-hidden relative"
          style={{
            backgroundColor: bg,
            color: text,
            fontFamily: "'Space Grotesk', ui-sans-serif, system-ui, sans-serif",
            letterSpacing: '-0.01em',
            transition: 'background-color 0.35s ease, color 0.35s ease',
          }}
        >
          <ProjectChatView />
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <div
        className="h-screen w-full flex flex-col overflow-hidden relative"
        style={{
          backgroundColor: bg,
          color: text,
          fontFamily: "'Space Grotesk', ui-sans-serif, system-ui, sans-serif",
          letterSpacing: '-0.01em',
          transition: 'background-color 0.35s ease, color 0.35s ease',
        }}
      >
        {/* Subtle dot grid background */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            opacity: isDark ? 0.02 : 0.025,
            backgroundImage: `radial-gradient(circle at 1px 1px, ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)'} 1px, transparent 0)`,
            backgroundSize: '24px 24px',
            transition: 'opacity 0.35s ease',
          }}
        />

        {/* Ambient glow blobs (very faded) */}
        <div
          className="absolute -top-32 -right-32 w-[350px] h-[350px] rounded-full blur-[100px] pointer-events-none"
          style={{ background: accent, opacity: isDark ? 0.04 : 0.06, transition: 'opacity 0.35s ease' }}
        />
        <div
          className="absolute -bottom-40 -left-40 w-[400px] h-[400px] rounded-full blur-[120px] pointer-events-none"
          style={{ background: accent, opacity: isDark ? 0.02 : 0.03, transition: 'opacity 0.35s ease' }}
        />

        <TopBar />
        <MobileSidebar />

        <div className="relative z-10 flex-1 min-h-0 flex gap-3 p-3 md:p-4">
          <DesktopSidebar />
          <AnimatePresence mode="wait">
            <WelcomeView />
          </AnimatePresence>
        </div>
      </div>
    </TooltipProvider>
  );
}
