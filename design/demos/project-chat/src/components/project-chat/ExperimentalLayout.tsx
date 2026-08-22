'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Sparkles, GripHorizontal, Minus, Maximize2,
} from 'lucide-react';
import { useTheme } from '@/lib/dashboard-helpers';
import {
  useProjectChatStore,
  type FreeformPanel,
  MODEL_OPTIONS,
  MOCK_CODE,
} from '@/lib/project-chat-store';
import { ExplorerPanel } from './panels/ExplorerPanel';
import { TodoPanel } from './panels/TodoPanel';

const MIN_SIZE = 120;
const TITLE_BAR_H = 40;

// ============================================================
// Simple code display for experimental mode
// ============================================================
function SimpleCodeView() {
  const { text, muted, inputBg, isDark, bg, card, border } = useTheme();
  const lines = MOCK_CODE.split('\n');
  const keywords = ['import', 'export', 'from', 'const', 'let', 'var', 'function', 'return', 'async', 'await', 'if', 'else', 'new', 'typeof', 'interface', 'type', 'extends'];
  const types = ['string', 'number', 'boolean', 'void', 'NextRequest', 'NextResponse', 'RateLimiter', 'AuthGuard'];
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let timeout: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      el.classList.add('scrolling');
      clearTimeout(timeout);
      timeout = setTimeout(() => el.classList.remove('scrolling'), 1200);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); clearTimeout(timeout); };
  }, []);

  const highlightLine = (line: string) => {
    const tokens = line.split(/(\b(?:'[^']*'|"[^"]*"|`[^`]*`|\d+\.?\d*|\b[a-zA-Z_$][a-zA-Z0-9_$]*\b)\b|[{}()<>:;,=+\-*/&|!?.@\[\]]|\/\/.*$)/g);
    return tokens.map((token, i) => {
      if ((token.startsWith("'") && token.endsWith("'")) ||
          (token.startsWith('"') && token.endsWith('"')) ||
          (token.startsWith('`') && token.endsWith('`'))) {
        return <span key={i} style={{ color: '#a5d6a7' }}>{token}</span>;
      }
      if (token.startsWith('//')) return <span key={i} style={{ color: '#6a737d' }}>{token}</span>;
      if (/^\d+\.?\d*$/.test(token)) return <span key={i} style={{ color: '#f9a825' }}>{token}</span>;
      if (keywords.includes(token)) return <span key={i} style={{ color: '#c792ea' }}>{token}</span>;
      if (types.includes(token)) return <span key={i} style={{ color: '#82aaff' }}>{token}</span>;
      return <span key={i}>{token}</span>;
    });
  };

  return (
    <div ref={scrollRef} className="flex-1 overflow-auto flex min-h-0 auto-scroll">
      <div
        className="w-12 shrink-0 py-3 text-right pr-3 select-none font-mono text-[11px] leading-[20px]"
        style={{ color: muted, background: inputBg + '60' }}
      >
        {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
      </div>
      <pre className="flex-1 py-3 pl-3 pr-4 font-mono text-[11px] leading-[20px] whitespace-pre-wrap break-words" style={{ color: text }}>
        {lines.map((line, i) => (
          <div key={i}>{highlightLine(line)}</div>
        ))}
      </pre>
    </div>
  );
}

// ============================================================
// Simple chat for experimental mode
// ============================================================
function SimpleChatView() {
  const { text, muted, accent, border, inputBg, card, isDark } = useTheme();
  const selectedModelId = useProjectChatStore((s) => s.selectedModelId);
  const model = MODEL_OPTIONS.find((m) => m.id === selectedModelId);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let timeout: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      el.classList.add('scrolling');
      clearTimeout(timeout);
      timeout = setTimeout(() => el.classList.remove('scrolling'), 1200);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); clearTimeout(timeout); };
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3 auto-scroll">
        <div className="flex items-center gap-2.5 mb-3">
          <div className="w-8 h-8 rounded-xl grid place-items-center" style={{ background: accent, color: isDark ? '#000' : '#fff' }}>
            <Sparkles size={14} />
          </div>
          <div>
            <div className="text-[13px] font-semibold" style={{ color: text }}>Nova</div>
            <div className="text-[10px] font-mono" style={{ color: muted }}>{model?.name || 'Claude 4'}</div>
          </div>
        </div>
        <div className="text-[13px] leading-[1.5] rounded-2xl p-3 border" style={{ background: card, borderColor: border, color: muted }}>
          {'This is the experimental layout mode. Drag any window to reposition. Resize from left, right, or bottom edges.'}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// FREEFORM WINDOW
// ============================================================
type ResizeEdge = 'left' | 'right' | 'bottom' | 'bottom-left' | 'bottom-right';

function FreeformWindow({
  panel,
  containerRef,
}: {
  panel: FreeformPanel;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { isDark, card, text, border, muted, accent, inputBg } = useTheme();
  const updateFreeformPanel = useProjectChatStore((s) => s.updateFreeformPanel);
  const [isDragging, setIsDragging] = useState(false);
  const [activeResize, setActiveResize] = useState<ResizeEdge | null>(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0, px: 0, py: 0 });

  const bringToFront = useCallback(() => {
    const allPanels = useProjectChatStore.getState().freeformPanels;
    const maxZ = Math.max(...allPanels.map((p) => p.zIndex));
    if (panel.zIndex < maxZ) {
      updateFreeformPanel(panel.id, { zIndex: maxZ + 1 });
    }
  }, [panel.id, panel.zIndex, updateFreeformPanel]);

  const handleDragStart = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, a, [contenteditable], pre, [data-resize]')) return;
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    setIsDragging(true);
    dragOffset.current = { x: e.clientX - rect.left - panel.x, y: e.clientY - rect.top - panel.y };
    bringToFront();
  };

  const handleResizeStart = (e: React.MouseEvent, edge: ResizeEdge) => {
    e.preventDefault();
    e.stopPropagation();
    setActiveResize(edge);
    resizeStart.current = {
      x: e.clientX, y: e.clientY,
      w: panel.width,
      h: panel.minimized ? TITLE_BAR_H : panel.height,
      px: panel.x,
      py: panel.y,
    };
    bringToFront();
  };

  // Drag handling with viewport constraints
  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const maxX = Math.max(0, rect.width - panel.width);
      const maxY = Math.max(0, rect.height - (panel.minimized ? TITLE_BAR_H : panel.height));
      updateFreeformPanel(panel.id, {
        x: Math.max(0, Math.min(maxX, e.clientX - rect.left - dragOffset.current.x)),
        y: Math.max(0, Math.min(maxY, e.clientY - rect.top - dragOffset.current.y)),
      });
    };
    const handleUp = () => setIsDragging(false);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [isDragging, panel.id, panel.width, panel.height, panel.minimized, updateFreeformPanel, containerRef]);

  // Resize handling from multiple edges
  useEffect(() => {
    if (!activeResize) return;
    const container = containerRef.current;
    if (!container) return;

    const handleMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const dx = e.clientX - resizeStart.current.x;
      const dy = e.clientY - resizeStart.current.y;
      const s = resizeStart.current;
      let newX = s.px;
      let newY = s.py;
      let newW = s.w;
      let newH = s.h;

      // Left edge: moves left, increases width
      if (activeResize === 'left' || activeResize === 'bottom-left') {
        const minW = MIN_SIZE;
        const proposedW = s.w - dx;
        if (proposedW >= minW) {
          newW = proposedW;
          newX = s.px + dx;
        } else {
          newW = minW;
          newX = s.px + (s.w - minW);
        }
      }
      // Right edge or bottom-right: increases width
      if (activeResize === 'right' || activeResize === 'bottom-right') {
        newW = Math.max(MIN_SIZE, s.w + dx);
      }
      // Bottom edges: increases height
      if (activeResize === 'bottom' || activeResize === 'bottom-left' || activeResize === 'bottom-right') {
        newH = Math.max(MIN_SIZE, s.h + dy);
      }

      // Constrain to container
      const maxX = Math.max(0, rect.width - newW);
      const maxY = Math.max(0, rect.height - newH);
      newX = Math.max(0, Math.min(maxX, newX));
      newY = Math.max(0, Math.min(maxY, newY));

      updateFreeformPanel(panel.id, { x: newX, y: newY, width: newW, height: newH });
    };
    const handleUp = () => setActiveResize(null);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [activeResize, panel.id, updateFreeformPanel, containerRef]);

  let content: React.ReactNode = null;
  if (panel.id === 'sidebar') content = <ExplorerPanel />;
  if (panel.id === 'code') content = <SimpleCodeView />;
  if (panel.id === 'chat') content = <SimpleChatView />;
  if (panel.id === 'todo') content = <TodoPanel />;

  const displayHeight = panel.minimized ? TITLE_BAR_H : panel.height;

  return (
    <div
      className="absolute rounded-2xl border overflow-hidden flex flex-col"
      style={{
        left: panel.x,
        top: panel.y,
        width: panel.width,
        height: displayHeight,
        zIndex: panel.zIndex,
        background: card,
        borderColor: isDragging ? accent : border,
        boxShadow: isDark
          ? (isDragging ? '0 16px 48px rgba(0,0,0,0.4)' : '0 8px 32px rgba(0,0,0,0.3)')
          : (isDragging ? '0 16px 48px rgba(0,0,0,0.15)' : '0 8px 32px rgba(0,0,0,0.08)'),
        transition: panel.minimized ? 'height 0.25s cubic-bezier(0.25,0.1,0.25,1)' : 'none',
      }}
      onMouseDown={bringToFront}
    >
      {/* Title bar */}
      <div
        className="shrink-0 h-10 flex items-center justify-between px-3 border-b cursor-grab active:cursor-grabbing"
        style={{ borderColor: border, background: inputBg }}
        onMouseDown={handleDragStart}
      >
        <div className="flex items-center gap-2">
          <GripHorizontal size={12} style={{ color: muted, opacity: 0.4 }} />
          <span className="text-[12px] font-semibold" style={{ color: text }}>{panel.title}</span>
        </div>
        <button
          className="w-6 h-6 rounded-lg grid place-items-center transition-colors"
          style={{ color: muted }}
          onMouseEnter={(e) => { e.currentTarget.style.background = accent + '10'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          onClick={(e) => {
            e.stopPropagation();
            updateFreeformPanel(panel.id, { minimized: !panel.minimized });
          }}
        >
          {panel.minimized ? <Maximize2 size={11} /> : <Minus size={11} />}
        </button>
      </div>

      {/* Content — hidden when minimized */}
      {!panel.minimized && (
        <div className="flex-1 overflow-auto min-h-0 auto-scroll">
          {content}
        </div>
      )}

      {/* Resize handles — left, right, bottom, bottom-left, bottom-right */}
      {!panel.minimized && (
        <>
          {/* Left edge */}
          <div
            data-resize="left"
            className="absolute top-10 bottom-0 w-[6px] left-0 cursor-ew-resize z-10"
            onMouseDown={(e) => handleResizeStart(e, 'left')}
          />
          {/* Right edge */}
          <div
            data-resize="right"
            className="absolute top-10 bottom-0 w-[6px] right-0 cursor-ew-resize z-10"
            onMouseDown={(e) => handleResizeStart(e, 'right')}
          />
          {/* Bottom edge */}
          <div
            data-resize="bottom"
            className="absolute left-0 right-0 h-[6px] bottom-0 cursor-ns-resize z-10"
            onMouseDown={(e) => handleResizeStart(e, 'bottom')}
          />
          {/* Bottom-left corner */}
          <div
            data-resize="bl"
            className="absolute bottom-0 left-0 w-4 h-4 cursor-nesw-resize z-20"
            onMouseDown={(e) => handleResizeStart(e, 'bottom-left')}
          />
          {/* Bottom-right corner */}
          <div
            data-resize="br"
            className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize z-20"
            onMouseDown={(e) => handleResizeStart(e, 'bottom-right')}
          />
        </>
      )}
    </div>
  );
}

// ============================================================
// EXPERIMENTAL LAYOUT
// ============================================================
export function ExperimentalLayout() {
  const { bg, accent, border, card } = useTheme();
  const freeformPanels = useProjectChatStore((s) => s.freeformPanels);
  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden" style={{ background: bg }}>
      {/* Floating banner */}
      <div
        className="absolute top-4 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-2.5 h-9 px-5 rounded-full border font-mono text-[11px]"
        style={{
          background: card,
          borderColor: border,
          color: accent,
          boxShadow: '0 4px 16px rgba(0,0,0,0.1)',
        }}
      >
        <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: accent }} />
        {'Experimental Mode — Drag & resize any panel'}
      </div>

      {freeformPanels.map((panel) => (
        <FreeformWindow key={panel.id} panel={panel} containerRef={containerRef} />
      ))}
    </div>
  );
}
