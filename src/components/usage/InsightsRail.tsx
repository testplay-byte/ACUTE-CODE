import { Sparkles } from "lucide-react";
import type { DetailedUsageModel, DetailedUsageToolCall, UsageDayBucket } from "../../lib/api";
import type { ThemeStyles } from "../../lib/themes";
import { utcDateLabel } from "../dashboard/helpers";
import { Kicker } from "../ui/Kicker";
import { CLAY_CARD, formatCompactTokens, shortModelName } from "./usage-helpers";
import { cn } from "../../lib/utils";

/**
 * ROUND-127 (R127-W1 — SCREENS §3 "THE USAGE PAGE ORDER", step 3): the
 * INSIGHTS RAIL — the 1-col companion of the activity grid's 2-col Token
 * Activity card. The owner's placement complaint (verbatim intent): "the tool
 * leaderboard should not be shown just right of the token activity. On the
 * right side of the token activity, some other key details should be shown" —
 * so the rail carries the window's KEY DETAILS as quiet stat rows (NEVER the
 * tools leaderboard; the leaderboard is its own full-width section below the
 * grid).
 *
 * Everything here is PURE-DERIVED from the data UsageScreen already holds
 * (usage.data) — no new queries. The models/tools/projects rollups of
 * GET /usage/detailed are WHOLE-HISTORY (the API contract), so the top-model
 * share is the all-time share (title-annotated for honesty); the peak-day row
 * reads the windowed `days` series. `days` may carry HOUR buckets
 * ("YYYY-MM-DDThh", the R127 granularity=hour series) — they group to their
 * DAY via the 10-char key slice, so the row stays a day row in both
 * granularities.
 *
 * The row grammar (COMPONENTS §6 stat discipline): 11px label tier + 13px/600
 * tabular value, ONE line per key detail, 1px `border-clay-rim` hairlines
 * between rows, tabular-nums everywhere, and AT MOST ONE icon (the Kicker's
 * glyph — no icon rainbow). `h-full` + `min-h-[248px]` (the activity card's
 * reserved skeleton height) so the rail fills the grid cell and matches the
 * chart card's height rhythm; empty facts render the honest "—".
 */

/** One quiet key-detail row — label tier left, 13px/600 tabular value right. */
interface InsightRow {
  label: string;
  value: string;
  /** The hover tooltip (full precision + provenance). */
  title?: string;
}

/** input+output — the "total tokens" of every rollup on this screen. */
function modelTokens(model: DetailedUsageModel): number {
  return model.tokens.input + model.tokens.output;
}

export function InsightsRail({
  models,
  days,
  tools,
  projectCount,
  styles,
}: {
  models: DetailedUsageModel[];
  /** The windowed activity series (day keys, or hour keys once W2 threads
   *  granularity=hour — grouped to days either way). */
  days: UsageDayBucket[];
  /** Count-desc server order (the leaderboard contract) — tools[0] is the busiest. */
  tools: DetailedUsageToolCall[];
  projectCount: number;
  styles: ThemeStyles;
}) {
  const { text, textTertiary } = styles;

  /* Top model + share — computed honestly, not models[0]: DetailedUsage's
   * models rollup arrives CALL-count-desc (storage/usage.ts sortedModels),
   * so the rail derives the TOKEN-heaviest itself (name asc breaks ties,
   * the server's tiebreak style). The share is the model's fraction of the
   * all-time model-token total (the rollup is whole-history). */
  const totalModelTokens = models.reduce((sum, m) => sum + modelTokens(m), 0);
  const topModel = models.reduce<DetailedUsageModel | null>((best, m) => {
    if (best === null) return m;
    const a = modelTokens(m);
    const b = modelTokens(best);
    if (a > b || (a === b && m.model.localeCompare(best.model) < 0)) return m;
    return best;
  }, null);
  const topSharePct =
    topModel !== null && totalModelTokens > 0
      ? Math.round((modelTokens(topModel) / totalModelTokens) * 100)
      : null;

  /* Peak day — the max input+output DAY among the windowed series. Hour
   * buckets group to their day key first (slice(0,10) is a no-op for day
   * keys); strict > keeps the EARLIEST day on ties (the stats endpoint's
   * `ORDER BY tokens DESC, date ASC` semantics). */
  const tokensByDay = new Map<string, number>();
  for (const day of days) {
    const key = day.date.slice(0, 10);
    tokensByDay.set(key, (tokensByDay.get(key) ?? 0) + day.inputTokens + day.outputTokens);
  }
  let peakDay: { date: string; tokens: number } | null = null;
  for (const [date, tokens] of tokensByDay) {
    if (tokens <= 0) continue;
    if (peakDay === null || tokens > peakDay.tokens) peakDay = { date, tokens };
  }

  /* Busiest tool — tools[0] (the server's count-desc leaderboard order). */
  const busiestTool = tools.length > 0 ? tools[0] : null;

  const rows: InsightRow[] = [
    {
      label: "Top model",
      value:
        topModel !== null && topSharePct !== null
          ? `${shortModelName(topModel.model)} · ${topSharePct}%`
          : "—",
      title:
        topModel !== null && topSharePct !== null
          ? `${topModel.model} — ${modelTokens(topModel).toLocaleString()} of ${totalModelTokens.toLocaleString()} all-time tokens (${topSharePct}%). The models rollup is whole-history; the Data & Statistics donut reads the months window.`
          : "No model usage recorded yet",
    },
    {
      label: "Peak day",
      value: peakDay !== null ? `${utcDateLabel(peakDay.date)} · ${formatCompactTokens(peakDay.tokens)}` : "—",
      title:
        peakDay !== null
          ? `Highest input+output day in the selected window — ${peakDay.date} (${peakDay.tokens.toLocaleString()} tokens)`
          : "No traffic in the selected window yet",
    },
    {
      label: "Busiest tool",
      value: busiestTool !== null ? `${busiestTool.tool} · ${busiestTool.count.toLocaleString()}` : "—",
      title:
        busiestTool !== null
          ? `${busiestTool.tool} — ${busiestTool.count.toLocaleString()} calls${busiestTool.failures > 0 ? ` · ${busiestTool.failures.toLocaleString()} failed` : ""} (whole-history)`
          : "No tool calls recorded yet",
    },
    {
      label: "Active projects",
      value: projectCount > 0 ? String(projectCount) : "—",
      title: `${projectCount.toLocaleString()} ${projectCount === 1 ? "project has" : "projects have"} recorded usage (whole-history)`,
    },
  ];

  return (
    <section
      data-testid="usage-insights-rail"
      aria-label="Insights"
      className={cn(CLAY_CARD, "flex h-full min-h-[248px] flex-col p-4 md:p-5")}
    >
      <div className="mb-2 flex shrink-0 items-center">
        <Kicker icon={Sparkles}>Insights</Kicker>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {rows.map((row, i) => (
          <div
            key={row.label}
            title={row.title}
            className={cn(
              "flex min-w-0 flex-1 items-center justify-between gap-3 py-2.5",
              // R126-3b row grammar: the 1px inset clay-rim hairline between
              // rows — never per-row cards.
              i > 0 && "border-t border-clay-rim",
            )}
          >
            <span
              className="shrink-0 text-[11px] font-medium uppercase leading-none tracking-[0.08em]"
              style={{ color: textTertiary }}
            >
              {row.label}
            </span>
            <span
              className="min-w-0 truncate text-right text-[13px] font-semibold leading-none tabular-nums"
              style={{ color: text }}
            >
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
