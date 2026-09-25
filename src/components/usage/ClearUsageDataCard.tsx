import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { clearUsageData } from "../../lib/api";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";
import { ConfirmDialog } from "../settings/ConfirmDialog";

/**
 * ROUND-127 (R127-W1 — the usage page layout wave): the clear-all-data
 * DANGER ZONE, extracted byte-wholesale from DataStatsPanel into its own
 * card. The owner's directive (verbatim intent): "the danger zone is
 * supposed to be shown at the very bottom, but it most definitely was not
 * handled appropriately" — it sat INSIDE the shared stats panel, so on the
 * /usage page it landed mid-page (between the donut's agent health and the
 * per-model list). The constitution's PAGE-scope law (SCREENS §3 "THE USAGE
 * PAGE ORDER", step 8 + COMPONENTS §6's danger-zone rule): THE DANGER ZONE
 * LAST — the page's final section, never interleaved mid-page; the law
 * applies at PAGE scope, not panel scope. Both mount sites now render this
 * card as their final section: the /usage page (after the projects
 * drill-down) and the settings ?tab=data pane (after DataStatsPanel).
 *
 * The section markup, testids (clear-usage-card / clear-usage-button /
 * clear-usage-success), the ConfirmDialog flow, and the mutation +
 * invalidations are BYTE-MOVED from DataStatsPanel (R99-E's quiet
 * red-OUTLINED box — 1.5px withAlpha(danger, 0.4) border, no fill, no
 * shadow, description-left / red-action-button-right); the ONLY addition is
 * the standalone-section margin (`mt-4 md:mt-6`) — it closes a page or tab
 * now, not a `gap-4` panel flow.
 */
export function ClearUsageDataCard() {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearedCount, setClearedCount] = useState<number | null>(null);

  const clear = useMutation({
    mutationFn: () => clearUsageData(),
    onSuccess: (result) => {
      setClearedCount(result.deleted);
      // Refetch EVERY usage surface that reads the now-empty ledger (the
      // stats panel itself + the usage screen's detailed rollups + the
      // dashboard summary) — the prefix matches all months/day windows.
      void queryClient.invalidateQueries({ queryKey: ["usage-stats"] });
      void queryClient.invalidateQueries({ queryKey: ["usage-detailed"] });
      void queryClient.invalidateQueries({ queryKey: ["usage-summary"] });
    },
  });

  const { textSecondary } = styles;

  return (
    <>
      {/* THE DANGER ZONE — always LAST at page scope (the GitHub settings
          pattern): a quiet red-OUTLINED box — no filled background, no
          shadow — with the description-left / red-action-button-right row.
          The exact enumeration of what stays untouched lives in the
          ConfirmDialog. R126-3b: this grammar is the DOCUMENTED EXCEPTION
          (COMPONENTS §6) — it rides unchanged, byte-identical, in both
          modes. R127-W1: moved here from DataStatsPanel's tail. */}
      <section
        data-testid="clear-usage-card"
        aria-label="Danger zone"
        className="mt-4 md:mt-6 min-h-[96px] rounded-2xl border-[1.5px] p-4"
        style={{ borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.4) }}
      >
        <div className="mb-2.5 flex items-center gap-2">
          <span
            className="text-[11px] font-medium uppercase leading-none tracking-[0.08em]"
            style={{ color: SEMANTIC_COLORS.danger }}
          >
            Danger zone
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-[520px] text-[11px] leading-relaxed" style={{ color: textSecondary }}>
            Clear usage data — deletes every usage event in the ledger. Turns, sessions, and project
            data are untouched.
          </p>
          <button
            type="button"
            disabled={clear.isPending}
            data-testid="clear-usage-button"
            onClick={() => setConfirmOpen(true)}
            className="h-8 shrink-0 cursor-pointer rounded-lg border px-3.5 text-[12px] font-semibold transition-opacity hover:opacity-85 disabled:cursor-wait disabled:opacity-60"
            style={{
              borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.45),
              color: SEMANTIC_COLORS.danger,
              background: withAlpha(SEMANTIC_COLORS.danger, 0.08),
            }}
          >
            {clear.isPending ? "Clearing…" : "Clear data…"}
          </button>
        </div>
        {clear.isError ? (
          <div className="mt-2 text-[11px]" style={{ color: SEMANTIC_COLORS.danger }} role="alert">
            Could not clear the usage ledger — {clear.error instanceof Error ? clear.error.message : String(clear.error)}.
            Nothing was deleted.
          </div>
        ) : null}
        {clearedCount !== null && !clear.isError ? (
          <div
            className="mt-2 text-[11px] font-semibold tabular-nums"
            style={{ color: styles.successDeep }}
            role="status"
            data-testid="clear-usage-success"
          >
            Cleared {clearedCount.toLocaleString()} usage event{clearedCount === 1 ? "" : "s"}
          </div>
        ) : null}
      </section>

      {confirmOpen ? (
        <ConfirmDialog
          title="Clear all usage data?"
          message="This deletes every usage event — token counts, costs, and model history. Sessions, conversations, agents, providers, and settings are NOT touched."
          confirmLabel="Clear data"
          danger
          onConfirm={() => {
            setConfirmOpen(false);
            setClearedCount(null);
            clear.mutate();
          }}
          onClose={() => setConfirmOpen(false)}
        />
      ) : null}
    </>
  );
}
