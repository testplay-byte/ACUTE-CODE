'use client';

import { useState, useMemo, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Zap } from 'lucide-react';
import { useDashboardStore, WEEKLY_TOKENS } from '@/lib/dashboard-store';
import { useTheme, bdr, scaleIn, ease, fmtTokens } from '@/lib/dashboard-helpers';

export function TokenBarChart({ delay = 0 }: { delay?: number }) {
  const { card, border, text, muted, accent, isDark } = useTheme();
  const projects = useDashboardStore((s) => s.projects);

  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const chartRef = useRef<HTMLDivElement>(null);

  const maxTokens = useMemo(() => Math.max(...WEEKLY_TOKENS.map((d) => d.tokens)), []);
  const totalWeek = useMemo(() => WEEKLY_TOKENS.reduce((s, d) => s + d.tokens, 0), []);

  const barWidth = 32;
  const barGap = 8;
  const chartWidth = WEEKLY_TOKENS.length * (barWidth + barGap) - barGap;
  const chartHeight = 140;
  const barRadius = 7;
  const labelArea = 28;

  const handleBarEnter = useCallback((
    idx: number, e: React.MouseEvent<SVGGElement>
  ) => {
    if (!chartRef.current) return;
    const rect = chartRef.current.getBoundingClientRect();
    const barX = idx * (barWidth + barGap) + barWidth / 2;
    setTooltipPos({
      x: barX,
      y: chartHeight / 2,
    });
    setHoveredIdx(idx);
  }, []);

  const handleBarLeave = useCallback(() => {
    setHoveredIdx(null);
  }, []);

  const hoveredDay = hoveredIdx !== null ? WEEKLY_TOKENS[hoveredIdx] : null;

  return (
    <motion.div
      variants={scaleIn}
      className="p-4 rounded-lg"
      style={{ backgroundColor: card, border: bdr('1.5px', border) }}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Zap size={13} style={{ color: accent, opacity: 0.7 }} />
          <span className="text-[12px] font-semibold" style={{ color: text }}>Weekly Token Usage</span>
        </div>
        <span className="text-[11px] font-medium" style={{ color: muted }}>
          {fmtTokens(totalWeek)} total
        </span>
      </div>

      {/* Bar chart */}
      <div className="relative flex justify-center" ref={chartRef}>
        <svg
          width={chartWidth}
          height={chartHeight + labelArea}
          viewBox={`0 0 ${chartWidth} ${chartHeight + labelArea}`}
        >
          {/* Clip path: hides bottom rounded corners of bars */}
          <defs>
            <clipPath id="barClip">
              <rect x={0} y={-barRadius} width={chartWidth} height={chartHeight + barRadius} />
            </clipPath>
          </defs>

          {/* Subtle grid lines */}
          {[0.25, 0.5, 0.75, 1].map((pct) => (
            <line
              key={pct}
              x1={0}
              y1={chartHeight - chartHeight * pct}
              x2={chartWidth}
              y2={chartHeight - chartHeight * pct}
              stroke={isDark ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.035)'}
              strokeWidth={1}
              strokeDasharray="3 5"
            />
          ))}

          {/* Baseline */}
          <line
            x1={0} y1={chartHeight}
            x2={chartWidth} y2={chartHeight}
            stroke={isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'}
            strokeWidth={1}
          />

          {/* Bars (clipped so only top corners are rounded) */}
          <g clipPath="url(#barClip)">
            {WEEKLY_TOKENS.map((day, i) => {
              const barH = Math.max((day.tokens / maxTokens) * chartHeight, 4);
              const x = i * (barWidth + barGap);
              const y = chartHeight - barH;
              const isToday = i === WEEKLY_TOKENS.length - 1;
              const isHovered = hoveredIdx === i;

              return (
                <g key={day.day}>
                  {/* Invisible hover target (full height for easier hover) */}
                  <rect
                    x={x}
                    y={0}
                    width={barWidth}
                    height={chartHeight}
                    fill="transparent"
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={(e) => handleBarEnter(i, e)}
                    onMouseLeave={handleBarLeave}
                  />
                  {/* Bar fill */}
                  <motion.rect
                    x={x}
                    y={chartHeight}
                    width={barWidth}
                    height={0}
                    rx={barRadius}
                    ry={barRadius}
                    fill={isHovered || isToday ? accent : accent + '45'}
                    initial={{ y: chartHeight, height: 0 }}
                    animate={{ y, height: barH }}
                    transition={{
                      duration: 0.6,
                      ease: [0.25, 0.1, 0.25, 1],
                      delay: delay + 0.1 + i * 0.06,
                    }}
                  />
                </g>
              );
            })}
          </g>

          {/* Day labels below baseline */}
          {WEEKLY_TOKENS.map((day, i) => {
            const x = i * (barWidth + barGap) + barWidth / 2;
            const isToday = i === WEEKLY_TOKENS.length - 1;
            const isHovered = hoveredIdx === i;
            return (
              <text
                key={day.day + '-label'}
                x={x}
                y={chartHeight + 18}
                textAnchor="middle"
                fill={isHovered || isToday ? accent : muted}
                fontSize={10}
                fontWeight={isHovered || isToday ? 700 : 500}
                fontFamily="'Space Grotesk', sans-serif"
              >
                {day.shortDay}
              </text>
            );
          })}
        </svg>

        {/* Custom hover tooltip */}
        <AnimatePresence>
          {hoveredDay && (
            <motion.div
              initial={{ opacity: 0, y: 4, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.96 }}
              transition={{ duration: 0.15 }}
              className="absolute z-50 pointer-events-none"
              style={{
                left: tooltipPos.x,
                top: tooltipPos.y,
                transform: 'translate(-50%, -50%)',
              }}
            >
              <div
                className="w-56 p-3 space-y-2.5"
                style={{
                  backgroundColor: card,
                  border: bdr('1.5px', border),
                  borderRadius: '10px',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                }}
              >
                {/* Day header */}
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-bold" style={{ color: text }}>
                    {hoveredDay.day}
                  </span>
                  <span className="text-[11px] font-bold" style={{ color: accent }}>
                    {fmtTokens(hoveredDay.tokens)}
                  </span>
                </div>

                {/* Per-project breakdown */}
                <div className="space-y-1.5">
                  {hoveredDay.breakdown.map((pb) => {
                    const proj = projects.find((p) => p.id === pb.projectId);
                    if (!proj) return null;
                    const pct = hoveredDay.tokens > 0
                      ? Math.round((pb.tokens / hoveredDay.tokens) * 100)
                      : 0;
                    return (
                      <div key={pb.projectId} className="flex items-center gap-2">
                        <div
                          className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0 text-[8px] font-bold text-white"
                          style={{ backgroundColor: proj.color + 'CC' }}
                        >
                          {proj.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-medium truncate" style={{ color: text }}>
                              {proj.name}
                            </span>
                            <span className="text-[10px] font-semibold ml-1" style={{ color: muted }}>
                              {fmtTokens(pb.tokens)}
                            </span>
                          </div>
                          <div
                            className="mt-0.5 h-[3px] rounded-full overflow-hidden"
                            style={{
                              backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                            }}
                          >
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${pct}%`,
                                backgroundColor: proj.color + '99',
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
