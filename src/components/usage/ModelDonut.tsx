import { useCallback, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ChartPie } from "lucide-react";
import type { ThemeStyles } from "../../lib/themes";
import type { UsageStatsModel } from "../../lib/api";
import { ease } from "../../lib/motion";
import { Kicker } from "../ui/Kicker";
import { formatCompactTokens, formatCost, modelColor, shortModelName, CLAY_CARD, DONUT_SWEEP_MS } from "./usage-helpers";
import { cn } from "../../lib/utils";

/**
 * ROUND-98 (R98-I2, owner: "the model-usage donut"): the token-share ring
 * over the model leaderboard — the ContextDonut DonutRing dasharray math
 * (strokeDasharray `${c·share} ${c}` with a per-segment rotation) applied
 * to N segments instead of one fill. COMPONENTS.md §6 grammar: 6px track,
 * the center hole carries the headline stat (the top model's short name +
 * its share), and segment ↔ legend-row MUTUAL hover-highlight — hovering
 * either lights that model and dims every other segment AND row (the
 * round-97 context-bar contract, generalized).
 *
 * R121-d (the chart-hover ratchet leg): the highlight is POINTER-OWNED —
 * ONE onPointerMove on the card resolves the hovered index from the DOM
 * hit (`[data-donut-idx]` on the arcs AND the legend rows); the mutual
 * highlight is unchanged.
 *
 * R99-E (anti-jitter kit): the card reserves its final height
 * (min-h-[224px]/md:232px — header + the fixed 160px ring); legend rows
 * truncate and every number renders tabular-nums.
 *
 * R126-3b (the Clay Companion redesign): the card rides the CLAY material
 * (rim + `.ac-clay`), and the ring SWEEPS once per data load — each arc's
 * dasharray animates 0→share over 500ms (MOTION §2 DONUT_SWEEP_MS), keyed
 * by the data fingerprint so a window switch redraws the sweep honestly.
 * The STABLE per-model palette (usage-helpers modelColor) is the sanctioned
 * data-viz exception — untouched (same name = same color, everywhere).
 *
 * ROUND-127 (R127-W2 — COMPONENTS §6's DONUT GAUGE LAW, binding): a share
 * donut the owner squints at is a defect — SIZE 120→160, STROKE 6→14 (a
 * ~9% ring ratio), and the center stat at DISPLAY tier (the share %
 * 22px/600 → 30px/700 tabular; the top model's short name stays 10px).
 * The 6px hairline track survives ONLY for micro-meters (the composer's
 * ContextDonut). The mutual hover-highlight (pointer-owned,
 * data-donut-idx) and the 500ms sweep are untouched.
 */

const SIZE = 160;
const STROKE = 14;
const R = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * R;

export function ModelDonut({
  models,
  styles,
}: {
  models: UsageStatsModel[];
  styles: ThemeStyles;
}) {
  const { text, textSecondary, textTertiary, isDark } = styles;
  const [hovered, setHovered] = useState<number | null>(null);

  // R121-d: the ONE pointer read — the browser's own hit-testing resolves
  // which arc or legend row the pointer is on (data-donut-idx on both), so
  // the mutual highlight rides a single handler pair on the CARD (never a
  // per-row hover pair). Pointer-out clears.
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const hit = (e.target as Element).closest("[data-donut-idx]");
    setHovered(hit !== null ? Number(hit.getAttribute("data-donut-idx")) : null);
  }, []);
  const onPointerLeave = useCallback(() => setHovered(null), []);

  const { segments, totalTokens, dataKey } = useMemo(() => {
    const total = models.reduce((sum, m) => sum + m.tokens, 0);
    let start = 0; // accumulated share fraction
    const out = models.map((m) => {
      const share = total > 0 ? m.tokens / total : 0;
      const entry = {
        model: m.model,
        color: modelColor(m.model, isDark),
        tokens: m.tokens,
        costUsd: m.costUsd,
        share,
        start,
      };
      start += share;
      return entry;
    });
    return { segments: out, totalTokens: total, dataKey: models.map((m) => `${m.model}:${m.tokens}`).join("|") };
  }, [models, isDark]);

  const top = segments[0];
  const topSharePct = top !== undefined ? Math.round(top.share * 100) : 0;

  return (
    <div
      data-testid="model-donut"
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      className={cn(CLAY_CARD, "flex min-h-[224px] flex-col p-4 md:min-h-[232px] md:p-5")}
    >
      <div className="mb-4 flex shrink-0 items-center">
        <Kicker icon={ChartPie}>Model Usage · Share of Tokens</Kicker>
      </div>

      {top === undefined || totalTokens === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center">
          <p className="text-[12px] font-semibold" style={{ color: text }}>
            No model usage in this window
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-5">
          <div className="relative grid shrink-0 place-items-center">
            {/* R126-3b: keyed by the data fingerprint — the sweep plays once
                per data load (a window switch redraws it), never looping. */}
            <svg
              key={dataKey}
              width={SIZE}
              height={SIZE}
              viewBox={`0 0 ${SIZE} ${SIZE}`}
              aria-hidden
              focusable="false"
              className="shrink-0"
            >
              {/* The §6 gauge ring — the recessed well track (R127-W2:
                  the 14px stroke at SIZE 160 — a ~9% ring ratio). */}
              <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="var(--ac-surface-well)" strokeWidth={STROKE} />
              {segments.map(
                (seg, i) =>
                  seg.share > 0 && (
                    <motion.circle
                      key={seg.model}
                      cx={SIZE / 2}
                      cy={SIZE / 2}
                      r={R}
                      fill="none"
                      stroke={seg.color}
                      strokeWidth={STROKE}
                      transform={`rotate(${(-90 + seg.start * 360).toFixed(3)} ${SIZE / 2} ${SIZE / 2})`}
                      opacity={hovered === null || hovered === i ? 1 : 0.3}
                      data-donut-model={seg.model}
                      data-donut-idx={i}
                      style={{ cursor: "pointer" }}
                      // R126-3b (MOTION §2): the 500ms arc-draw sweep, once
                      // per data load.
                      initial={{ strokeDasharray: `0 ${CIRCUMFERENCE}` }}
                      animate={{ strokeDasharray: `${CIRCUMFERENCE * seg.share} ${CIRCUMFERENCE}` }}
                      transition={{ duration: DONUT_SWEEP_MS, ease }}
                    >
                      <title>{`${seg.model} · ${Math.round(seg.share * 100)}% · ${seg.tokens.toLocaleString()} tokens`}</title>
                    </motion.circle>
                  ),
              )}
            </svg>
            {/* The center hole carries the headline stat — the top model's
                short name + its share of the window's tokens. R127-W2 (the
                gauge law): the share % renders at DISPLAY tier (30px/700
                tabular) — the squint test the 22px/600 value failed. */}
            <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
              <div>
                <div className="font-mono text-[10px] font-semibold" style={{ color: textSecondary }}>
                  {shortModelName(top.model)}
                </div>
                <div className="text-[30px] font-bold leading-none tabular-nums" style={{ color: text }}>
                  {topSharePct}%
                </div>
              </div>
            </div>
          </div>

          <div className="min-w-[220px] flex-1 space-y-1">
            {segments.map((seg, i) => (
              <div
                key={seg.model}
                data-donut-model={seg.model}
                data-donut-row={seg.model}
                data-donut-idx={i}
                className="flex items-center gap-2 rounded-md px-1 -mx-1 transition-opacity"
                style={{
                  cursor: "default",
                  opacity: hovered === null || hovered === i ? 1 : 0.35,
                }}
              >
                <span
                  aria-hidden
                  className="h-[9px] w-[9px] shrink-0 rounded-full"
                  style={{ backgroundColor: seg.color }}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]" style={{ color: text }}>
                  {seg.model}
                </span>
                <span className="shrink-0 font-mono text-[11px] font-semibold tabular-nums" style={{ color: textSecondary }}>
                  {formatCompactTokens(seg.tokens)}
                </span>
                <span
                  className="shrink-0 font-mono text-[11px] tabular-nums"
                  style={{ color: textTertiary, minWidth: 52, textAlign: "right" }}
                >
                  {formatCost(seg.costUsd)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
