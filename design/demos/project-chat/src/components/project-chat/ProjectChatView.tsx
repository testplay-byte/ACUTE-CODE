'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useTheme } from '@/lib/dashboard-helpers';
import { useProjectChatStore } from '@/lib/project-chat-store';
import { TopBar } from './TopBar';
import { LeftSidebar } from './LeftSidebar';
import { AgentChatPanel } from './AgentChatPanel';
import { CodeView } from './CodeView';
import { ExperimentalLayout } from './ExperimentalLayout';

const ease = [0.25, 0.1, 0.25, 1] as const;

const MIN_SIDEBAR = 180;
const MAX_SIDEBAR = 400;
const DEFAULT_SIDEBAR = 250;
const MIN_CHAT = 320;
const MAX_CHAT = 800;
const DEFAULT_CHAT = 400;

// ============================================================
// GAP RESIZE HANDLE — sits in the gap between panels
// ============================================================
function GapHandle({ onResize, side }: { onResize: (delta: number) => void; side?: 'left' | 'right' }) {
  const isResizing = useRef(false);
  const startX = useRef(0);
  const { border } = useTheme();

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const delta = e.clientX - startX.current;
      onResize(delta);
      startX.current = e.clientX;
    };
    const handleUp = () => {
      isResizing.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [onResize]);

  return (
    <div
      className="w-[10px] shrink-0 cursor-ew-resize relative group flex items-center justify-center"
      onMouseDown={(e) => {
        e.preventDefault();
        isResizing.current = true;
        startX.current = e.clientX;
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
      }}
    >
      <div
        className="absolute inset-y-2 w-[2px] rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-200"
        style={{ background: border }}
      />
    </div>
  );
}

// ============================================================
// SCROLL FADE HOOK — exported for reuse by other components
// Actual implementation is in /src/lib/useScrollFade.ts
// ============================================================
export { useScrollFade } from '@/lib/useScrollFade';

function NormalLayout() {
  const { bg } = useTheme();
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR);
  const [chatWidth, setChatWidth] = useState(DEFAULT_CHAT);
  const sidebarOpen = useProjectChatStore((s) => s.sidebarOpen);
  const codeVisible = useProjectChatStore((s) => s.codeVisible);

  const handleSidebarResize = useCallback((delta: number) => {
    setSidebarWidth((w) => Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, w + delta)));
  }, []);

  const handleChatResize = useCallback((delta: number) => {
    setChatWidth((w) => Math.max(MIN_CHAT, Math.min(MAX_CHAT, w + delta)));
  }, []);

  const onlyChat = !sidebarOpen && !codeVisible;

  return (
    <div
      className={`flex-1 flex min-h-0 ${onlyChat ? 'justify-center items-center' : ''} overflow-hidden`}
      style={{ backgroundColor: bg }}
    >
      {!onlyChat && (
        <>
          <LeftSidebar sidebarWidth={sidebarWidth} />
          <GapHandle onResize={handleSidebarResize} />
        </>
      )}

      {codeVisible && (
        <>
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            <CodeView />
          </div>
          <GapHandle onResize={handleChatResize} />
        </>
      )}

      <div
        className={`shrink-0 overflow-hidden rounded-2xl ${onlyChat ? '' : ''}`}
        style={{
          width: onlyChat ? chatWidth : chatWidth,
          maxWidth: onlyChat ? '90%' : undefined,
        }}
      >
        <AgentChatPanel />
      </div>
    </div>
  );
}

export function ProjectChatView() {
  const { bg, border } = useTheme();
  const experimentalMode = useProjectChatStore((s) => s.experimentalMode);

  return (
    <motion.div
      className="flex flex-col h-screen w-screen overflow-hidden p-2 gap-2"
      style={{ backgroundColor: bg, transition: 'background-color 0.3s ease' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3, ease }}
    >
      <style>{`
        @keyframes bounceDot {
          0%, 80%, 100% { transform: translateY(0); }
          40% { transform: translateY(-4px); }
        }
        .auto-scroll {
          scrollbar-width: none;
        }
        .auto-scroll.scrolling {
          scrollbar-width: thin;
          scrollbar-color: ${border} transparent;
        }
        .auto-scroll::-webkit-scrollbar { width: 5px; height: 5px; }
        .auto-scroll::-webkit-scrollbar-thumb {
          background: transparent;
          border-radius: 10px;
          transition: background 0.4s ease;
        }
        .auto-scroll.scrolling::-webkit-scrollbar-thumb {
          background: ${border};
        }
        .auto-scroll::-webkit-scrollbar-track { background: transparent; }
      `}</style>

      <TopBar />

      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {experimentalMode ? <ExperimentalLayout /> : <NormalLayout />}
      </div>
    </motion.div>
  );
}
