import type { DetailedUsageToolCall } from "../../lib/api";
import type { ThemeStyles } from "../../lib/themes";
import { Kicker } from "../ui/Kicker";
import { CLAY_CARD } from "./usage-helpers";
import { cn } from "../../lib/utils";

/**
 * ROUND-52 (R52-b): tool leaderboard — the /usage screen's "Every tool
 * call, ranked" section. Top 8 tools; horizontal bars relative to the
 * most-used tool; failures render in the danger tier when > 0.
 *
 * ROUND-127 (R127-W1 — SCREENS §3 "THE USAGE PAGE ORDER", step 4): the
 * leaderboard is its OWN FULL-WIDTH section BELOW the activity grid — the
 * owner's placement complaint (verbatim intent): "the tool leaderboard
 * should not be shown just right of the token activity. On the right side
 * of the token activity, some other key details should be shown" (the
 * 1-col rail now carries the InsightsRail). The card, its data contract
 * (tools prop, top-8 slice, count-desc server order), testids and aria
 * labels are unchanged — the rows simply stretch to the full card width
 * now (wider rows, the R126 flat hairline row grammar intact).
 *
 * ROUND-126 (R126-3b, the Clay Companion redesign): the rows go FLAT — no
 * per-row cards; separation is the 1px inset hairline between rows (the
 * usage.html structural reference's suite-row grammar); the bar fill is the
 * two-tier accent's DEEP leg (`bg-accent-deep`), its track the recessed
 * WELL (`bg-well`); FAILED counts ride the status TEXT tier
 * (`text-danger-deep`, TOKENS §11) instead of the flat semantic red.
 */
export function ToolsLeaderboard({
  tools,
  styles,
}: {
  tools: DetailedUsageToolCall[];
  styles: ThemeStyles;
}) {
  const { text, textSecondary } = styles;
  const top = tools.slice(0, 8);
  const max = Math.max(1, ...top.map((t) => t.count));

  return (
    <div
      data-testid="tools-leaderboard"
      className={cn(CLAY_CARD, "flex w-full flex-col p-4 md:p-5")}
    >
      <div className="mb-3 flex shrink-0 items-center justify-between">
        <Kicker>Tool Leaderboard</Kicker>
        <span className="text-[11px] font-medium leading-none tabular-nums" style={{ color: textSecondary }}>
          {tools.length} {tools.length === 1 ? "tool" : "tools"}
        </span>
      </div>

      {top.length === 0 ? (
        <p
          className="flex flex-1 items-center justify-center py-8 text-center text-[12px]"
          style={{ color: textSecondary }}
        >
          No tool calls yet — they rank here as soon as agents start working.
        </p>
      ) : (
        <ol className="flex flex-col">
          {top.map((tool, i) => (
            <li
              key={tool.tool}
              className={cn("min-w-0 py-2", i > 0 && "border-t border-clay-rim")}
              aria-label={`${tool.tool}: ${tool.count} calls${tool.failures > 0 ? `, ${tool.failures} failed` : ""}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className="truncate font-mono text-[12px] font-medium"
                  style={{ color: text }}
                  title={tool.tool}
                >
                  {tool.tool}
                </span>
                <span className="shrink-0 text-[11px] font-medium tabular-nums" style={{ color: textSecondary }}>
                  {tool.count.toLocaleString()}
                  {tool.failures > 0 ? (
                    <span
                      className="ml-1.5 font-semibold tabular-nums text-danger-deep"
                      title={`${tool.failures} failed ${tool.failures === 1 ? "call" : "calls"}`}
                    >
                      {tool.failures.toLocaleString()} ✕
                    </span>
                  ) : null}
                </span>
              </div>
              <div
                className="mt-1 h-[6px] overflow-hidden rounded-full bg-well"
                role="progressbar"
                aria-valuenow={tool.count}
                aria-valuemin={0}
                aria-valuemax={max}
                aria-label={`${tool.tool} calls relative to the most-used tool`}
              >
                <div
                  className="h-full rounded-full bg-accent-deep"
                  style={{ width: `${Math.max(4, Math.round((tool.count / max) * 100))}%` }}
                />
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
