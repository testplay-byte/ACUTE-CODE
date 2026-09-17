import { motion } from "framer-motion";
import { Cpu } from "lucide-react";
import type { DetailedUsageModel } from "../../lib/api";
import type { ThemeStyles } from "../../lib/themes";
import { staggerContainer, staggerItem } from "../../lib/motion";
import { withAlpha } from "../dashboard/helpers";
import { formatCompactTokens, formatCost } from "./usage-helpers";

/**
 * ROUND-52 (R52-b): model mix cards — the /usage screen's "Models" section
 * (the DASHBOARD usage page's model cards): model id in mono, calls, token
 * mix (in/out/cached) and cost, sorted by total tokens. A calls bar relative
 * to the busiest model keeps the visual ranking glanceable.
 */
function ModelCard({ model, maxCalls, styles }: { model: DetailedUsageModel; maxCalls: number; styles: ThemeStyles }) {
  const { card, border, text, textSecondary, textTertiary, accent, softShadow } = styles;
  const share = maxCalls > 0 ? Math.max(4, Math.round((model.calls / maxCalls) * 100)) : 4;

  return (
    <motion.article
      variants={staggerItem}
      className="rounded-2xl border-[1.5px] p-4"
      style={{ backgroundColor: card, borderColor: border, boxShadow: softShadow }}
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
        <span className="shrink-0 text-[11px] font-semibold" style={{ color: textSecondary }}>
          {model.calls.toLocaleString()} {model.calls === 1 ? "call" : "calls"}
        </span>
      </div>
      <div
        className="mt-2 h-[5px] overflow-hidden rounded-full"
        style={{ backgroundColor: withAlpha(accent, 0.12) }}
        role="progressbar"
        aria-valuenow={model.calls}
        aria-valuemin={0}
        aria-valuemax={maxCalls}
        aria-label={`${model.model} calls relative to the busiest model`}
      >
        <div className="h-full rounded-full" style={{ width: `${share}%`, backgroundColor: accent }} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="min-w-0">
          <dt className="text-[10px] font-medium uppercase tracking-[0.08em]" style={{ color: textTertiary }}>
            Sent
          </dt>
          <dd
            className="mt-0.5 truncate text-[12px] font-semibold tabular-nums"
            style={{ color: text }}
            title={`${model.tokens.input.toLocaleString()} tokens`}
          >
            {formatCompactTokens(model.tokens.input)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[10px] font-medium uppercase tracking-[0.08em]" style={{ color: textTertiary }}>
            Received
          </dt>
          <dd
            className="mt-0.5 truncate text-[12px] font-semibold tabular-nums"
            style={{ color: text }}
            title={`${model.tokens.output.toLocaleString()} tokens`}
          >
            {formatCompactTokens(model.tokens.output)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[10px] font-medium uppercase tracking-[0.08em]" style={{ color: textTertiary }}>
            Cached
          </dt>
          <dd
            className="mt-0.5 truncate text-[12px] font-semibold tabular-nums"
            style={{ color: text }}
            title={`${model.tokens.cached.toLocaleString()} tokens`}
          >
            {formatCompactTokens(model.tokens.cached)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[10px] font-medium uppercase tracking-[0.08em]" style={{ color: textTertiary }}>
            Cost
          </dt>
          <dd
            className="mt-0.5 truncate text-[12px] font-semibold tabular-nums"
            style={{ color: text }}
            title={
              model.costKnown === false
                ? "Unpriced model — no input/output prices configured for the provider×model rows that served it; $0.00 is a placeholder, not free"
                : undefined
            }
          >
            {formatCost(model.costUsd)}
            {/* ROUND-83 (R83) §2.11: the honest marker — an unpriced model
                shows "(unpriced)", never a silent free lunch. */}
            {model.costKnown === false ? (
              <span className="font-normal text-[10px]" style={{ color: textTertiary }}>
                {" "}(unpriced)
              </span>
            ) : null}
          </dd>
        </div>
      </dl>
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
  const { textSecondary, textTertiary, accent } = styles;
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
        <div className="flex items-center gap-2">
          <Cpu size={13} style={{ color: accent, opacity: 0.7 }} />
          <h2 className="text-[11px] font-medium uppercase tracking-[0.08em]" style={{ color: textTertiary }}>
            Models
          </h2>
        </div>
        <span className="text-[11px] tabular-nums" style={{ color: textSecondary }}>
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
