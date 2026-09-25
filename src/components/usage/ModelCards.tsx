import { motion } from "framer-motion";
import { Cpu } from "lucide-react";
import type { DetailedUsageModel } from "../../lib/api";
import type { ThemeStyles } from "../../lib/themes";
import { staggerContainer, staggerItem } from "../../lib/motion";
import { Kicker } from "../ui/Kicker";
import { UsageMiniStat } from "./UsageStatRow";
import { CLAY_CARD_SM, formatCompactTokens, formatCost } from "./usage-helpers";
import { cn } from "../../lib/utils";

/**
 * ROUND-52 (R52-b): model mix cards — the /usage screen's "Models" section
 * (the DASHBOARD usage page's model cards): model id in mono, calls, token
 * mix (in/out/cached) and cost, sorted by total tokens. A calls bar relative
 * to the busiest model keeps the visual ranking glanceable.
 *
 * ROUND-126 (R126-3b, the Clay Companion redesign): each card is the compact
 * clay tile (rim + `.ac-clay-sm`); the four stats render as ONE mini stat row
 * separated by 1px hairline dividers (the stat-row grammar at table density —
 * 10px labels, 12px/600 tabular values); the calls bar fills the DEEP accent
 * leg (`bg-accent-deep`) over the recessed well track.
 */


function ModelCard({ model, maxCalls, styles }: { model: DetailedUsageModel; maxCalls: number; styles: ThemeStyles }) {
  const { text, textSecondary } = styles;
  const share = maxCalls > 0 ? Math.max(4, Math.round((model.calls / maxCalls) * 100)) : 4;

  return (
    <motion.article
      variants={staggerItem}
      className={cn(CLAY_CARD_SM, "p-4")}
      aria-label={`Model ${model.model}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span
          className="truncate font-mono text-[12px] font-semibold"
          style={{ color: text }}
          title={model.model}
        >
          {model.model}
        </span>
        <span className="shrink-0 text-[11px] font-semibold tabular-nums" style={{ color: textSecondary }}>
          {model.calls.toLocaleString()} {model.calls === 1 ? "call" : "calls"}
        </span>
      </div>
      <div
        className="mt-2 h-[5px] overflow-hidden rounded-full bg-well"
        role="progressbar"
        aria-valuenow={model.calls}
        aria-valuemin={0}
        aria-valuemax={maxCalls}
        aria-label={`${model.model} calls relative to the busiest model`}
      >
        <div className="h-full rounded-full bg-accent-deep" style={{ width: `${share}%` }} />
      </div>
      {/* R126-3b: the mini stat row — ONE row, hairline dividers between the
          four cells (never four floating dl blocks). */}
      <div className="mt-3 grid grid-cols-2 gap-y-2 sm:grid-cols-4 sm:gap-y-0">
        <UsageMiniStat
          divider="none"
          label="Sent"
          value={formatCompactTokens(model.tokens.input)}
          title={`${model.tokens.input.toLocaleString()} tokens`}
          styles={styles}
        />
        <UsageMiniStat
          divider="always"
          label="Received"
          value={formatCompactTokens(model.tokens.output)}
          title={`${model.tokens.output.toLocaleString()} tokens`}
          styles={styles}
        />
        <UsageMiniStat
          divider="sm"
          label="Cached"
          value={formatCompactTokens(model.tokens.cached)}
          title={`${model.tokens.cached.toLocaleString()} tokens`}
          styles={styles}
        />
        <UsageMiniStat
          divider="always"
          label="Cost"
          value={
            model.costKnown === false ? `${formatCost(model.costUsd)} (unpriced)` : formatCost(model.costUsd)
          }
          title={
            model.costKnown === false
              ? "Unpriced model — no input/output prices configured for the provider×model rows that served it; $0.00 is a placeholder, not free"
              : undefined
          }
          styles={styles}
        />
      </div>
    </motion.article>
  );
}

export function ModelCards({
  models,
  styles,
}: {
  models: DetailedUsageModel[];
  styles: ThemeStyles;
}) {
  const { textSecondary } = styles;
  // Sorted by total tokens (input+output) — the heaviest context consumers
  // first; the API returns call-count order for the leaderboard instead.
  const sorted = [...models].sort(
    (a, b) =>
      b.tokens.input + b.tokens.output - (a.tokens.input + a.tokens.output) ||
      b.calls - a.calls ||
      a.model.localeCompare(b.model),
  );
  const maxCalls = Math.max(1, ...sorted.map((m) => m.calls));

  return (
    <section aria-label="Models" className="mb-4 md:mb-6">
      <div className="mb-3 flex items-center justify-between">
        <Kicker as="h2" icon={Cpu}>
          Models
        </Kicker>
        <span className="text-[11px] font-medium leading-none tabular-nums" style={{ color: textSecondary }}>
          {models.length} {models.length === 1 ? "model" : "models"}
        </span>
      </div>
      {sorted.length === 0 ? (
        <p className="py-4 text-[12px]" style={{ color: textSecondary }}>
          No model calls recorded yet.
        </p>
      ) : (
        <motion.div
          variants={staggerContainer}
          initial="initial"
          animate="animate"
          className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 md:gap-4"
        >
          {sorted.map((model) => (
            <ModelCard key={model.model} model={model} maxCalls={maxCalls} styles={styles} />
          ))}
        </motion.div>
      )}
    </section>
  );
}
