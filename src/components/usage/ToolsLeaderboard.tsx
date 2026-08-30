import { motion } from "framer-motion";
import { Wrench } from "lucide-react";
import type { DetailedUsageToolCall } from "../../lib/api";
import type { ThemeStyles } from "../../lib/themes";
import { scaleIn } from "../../lib/motion";
import { withAlpha } from "../dashboard/helpers";
import { SEMANTIC_COLORS } from "../../lib/semantics";

/**
 * ROUND-52 (R52-b): tool leaderboard — the /usage screen's companion card to
 * the activity chart (the owner-approved DASHBOARD usage page's "Every tool
 * call, ranked" section). Top 8 tools; horizontal bars relative to the
 * most-used tool; failures render in the semantic danger color when > 0.
 */
export function ToolsLeaderboard({
  tools,
  styles,
}: {
  tools: DetailedUsageToolCall[];
  styles: ThemeStyles;
}) {
  const { card, border, text, textSecondary, textTertiary, accent, softShadow } = styles;
  const top = tools.slice(0, 8);
  const max = Math.max(1, ...top.map((t) => t.count));

  return (
    <motion.div
      variants={scaleIn}
      className="rounded-[24px] border-[1.5px] p-4 md:p-5 flex flex-col"
      style={{ backgroundColor: card, borderColor: border, boxShadow: softShadow }}
    >
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Wrench size={13} style={{ color: accent, opacity: 0.7 }} />
          <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: textTertiary }}>
            Tool Leaderboard
          </span>
        </div>
        <span className="text-[11px] font-medium" style={{ color: textSecondary }}>
          {tools.length} {tools.length === 1 ? "tool" : "tools"}
        </span>
      </div>

      {top.length === 0 ? (
        <p
          className="flex flex-1 items-center justify-center py-8 text-center text-[12px] font-medium"
          style={{ color: textSecondary }}
        >
          No tool calls yet — they rank here as soon as agents start working.
        </p>
      ) : (
        <ol className="flex flex-col gap-2.5">
          {top.map((tool, i) => (
            <li key={tool.tool} className="min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className="truncate font-mono text-[11.5px] font-semibold"
                  style={{ color: text }}
                  title={tool.tool}
                >
                  {tool.tool}
                </span>
                <span className="shrink-0 text-[11px] font-semibold" style={{ color: textSecondary }}>
                  {tool.count.toLocaleString()}
                  {tool.failures > 0 ? (
                    <span
                      className="ml-1.5 font-bold"
                      style={{ color: SEMANTIC_COLORS.danger }}
                      title={`${tool.failures} failed ${tool.failures === 1 ? "call" : "calls"}`}
                    >
                      {tool.failures.toLocaleString()} ✕
                    </span>
                  ) : null}
                </span>
              </div>
              <div
                className="mt-1 h-[6px] overflow-hidden rounded-full"
                style={{ backgroundColor: withAlpha(accent, 0.12) }}
                role="progressbar"
                aria-valuenow={tool.count}
                aria-valuemin={0}
                aria-valuemax={max}
                aria-label={`${tool.tool} calls relative to the most-used tool`}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(4, Math.round((tool.count / max) * 100))}%`,
                    backgroundColor: accent,
                    opacity: i === 0 ? 1 : 0.75,
                  }}
                />
              </div>
            </li>
          ))}
        </ol>
      )}
    </motion.div>
  );
}
