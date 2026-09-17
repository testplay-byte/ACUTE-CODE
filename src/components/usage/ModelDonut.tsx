import { useMemo, useState } from "react";
import { ChartPie } from "lucide-react";
import type { ThemeStyles } from "../../lib/themes";
import type { UsageStatsModel } from "../../lib/api";
import { formatCompactTokens, formatCost, modelColor, shortModelName } from "./usage-helpers";

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
 * R99-E (anti-jitter kit): the card reserves its final height
 * (min-h-[184px]/md:192px — header + the fixed 120px ring); legend rows
 * truncate (never wrap-jitter) and every number renders tabular-nums.
 *
 * R100-G (research §C2 P3, the ladder sweep): the header label snapped to
 * the label tier (11px/500/0.08em), the ring's headline stat snapped to the
 * ladder's `value` token (22px/600, tabular — font-black + tracking-tighter
 * were the wizard display tell), and the card rides the 16px radius step
 * (rounded-2xl). The model palette + the fixed-height reserves stay.
 */

const SIZE = 120;
const STROKE = 6;
const R = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * R;

export function ModelDonut({
  models,
  styles,
}: {
  models: UsageStatsModel[];
  styles: ThemeStyles;
}) {
  const { card, border, text, textSecondary, textTertiary, accent, softShadow, isDark } = styles;
  const [hovered, setHovered] = useState<number | null>(null);

  const { segments, totalTokens } = useMemo(() => {
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
    return { segments: out, totalTokens: total };
  }, [models, isDark]);

  const top = segments[0];
  const topSharePct = top !== undefined ? Math.round(top.share * 100) : 0;

  return (
    <div
      data-testid="model-donut"
      className="flex min-h-[184px] flex-col rounded-2xl border-[1.5px] p-4 md:min-h-[192px] md:p-5"
      style={{ backgroundColor: card, borderColor: border, boxShadow: softShadow }}
    >
      <div className="mb-4 flex shrink-0 items-center gap-2">
        <ChartPie size={13} style={{ color: accent, opacity: 0.7 }} />
        <span
          className="text-[11px] font-medium uppercase leading-none tracking-[0.08em]"
          style={{ color: textTertiary }}
        >
          Model Usage · Share of Tokens
        </span>
      </div>

      {top === undefined || totalTokens === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center">
          <p className="text-[12px] font-semibold" style={{ color: text }}>
            No model usage in this window
          </p>
          <p className="max-w-[240px] text-[11px]" style={{ color: textSecondary }}>
            The donut appears once the ledger records model calls.
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-5">
          <div className="relative grid shrink-0 place-items-center">
            <svg
              width={SIZE}
              height={SIZE}
              viewBox={`0 0 ${SIZE} ${SIZE}`}
              aria-hidden
              focusable="false"
              className="shrink-0"
            >
              {/* The §6 6px track */}
              <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke={styles.subtle} strokeWidth={STROKE} />
              {segments.map(
                (seg, i) =>
                  seg.share > 0 && (
                    <circle
                      key={seg.model}
                      cx={SIZE / 2}
                      cy={SIZE / 2}
                      r={R}
                      fill="none"
                      stroke={seg.color}
                      strokeWidth={STROKE}
                      strokeDasharray={`${CIRCUMFERENCE * seg.share} ${CIRCUMFERENCE}`}
                      transform={`rotate(${(-90 + seg.start * 360).toFixed(3)} ${SIZE / 2} ${SIZE / 2})`}
                      opacity={hovered === null || hovered === i ? 1 : 0.3}
                      data-donut-model={seg.model}
                      onMouseEnter={() => setHovered(i)}
                      onMouseLeave={() => setHovered(null)}
                      style={{ cursor: "pointer" }}
                    >
                      <title>{`${seg.model} · ${Math.round(seg.share * 100)}% · ${seg.tokens.toLocaleString()} tokens`}</title>
                    </circle>
                  ),
              )}
            </svg>
            {/* The center hole carries the headline stat — the top model's
                short name + its share of the window's tokens. */}
            <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
              <div>
                <div className="font-mono text-[10px] font-semibold" style={{ color: textSecondary }}>
                  {shortModelName(top.model)}
                </div>
                <div className="text-[22px] font-semibold leading-none tabular-nums" style={{ color: text }}>
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
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
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
