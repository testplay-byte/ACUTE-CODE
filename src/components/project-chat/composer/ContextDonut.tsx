import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchSessionContext,
  type SessionContextReport,
  type SessionUsageTotals,
} from "../../../lib/api";
import { fmtTokens } from "../../../lib/format";
import { SEMANTIC_COLORS } from "../../../lib/semantics";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import { withAlpha } from "../../dashboard/helpers";
import { useDismiss } from "./composer-utils";

// ── ROUND-51 (R51-c): donut color grading ────────────────────────────────────

/** Ring stays the theme accent below this fraction of the window used. */
export const CONTEXT_DONUT_WARN = 0.6;
/** Ring turns danger ABOVE this fraction (amber in between). */
export const CONTEXT_DONUT_DANGER = 0.85;
/**
 * The amber the codebase already uses for mid-tier warnings (ApprovalLine,
 * SubAgentPanel) — an intentional, documented raw-hex exception like
 * SEMANTIC_COLORS.
 */
export const DONUT_WARN_COLOR = "#f59e0b";

/**
 * ROUND-51 (R51-c): the ring color by context-window pressure — accent while
 * comfortable, amber when filling, danger past the point where one large tool
 * output could overflow the window. Pure; exported for tests.
 */
export function contextDonutColor(usedTokens: number, contextWindow: number, accent: string): string {
  if (contextWindow <= 0) return accent;
  const frac = Math.min(1, usedTokens / contextWindow);
  if (frac > CONTEXT_DONUT_DANGER) return SEMANTIC_COLORS.danger;
  if (frac >= CONTEXT_DONUT_WARN) return DONUT_WARN_COLOR;
  return accent;
}

/**
 * ROUND-51 (R51-c): the hover-bridge grace period — leaving the trigger (or
 * the popover) starts this timer; entering the other side cancels it. The fix
 * for the owner's "When I move my mouse up on the actual window… it does not
 * keep the window open."
 */
const POPOVER_CLOSE_DELAY_MS = 220;

/** SVG donut ring — the toolbar icon and the popover's big donut share the math. */
function DonutRing({
  size,
  stroke,
  used,
  limit,
  color,
  track,
}: {
  size: number;
  stroke: number;
  used: number;
  limit: number;
  color: string;
  track: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = limit > 0 ? Math.min(1, used / limit) : 0;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden
      focusable="false"
      className="shrink-0"
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
      {used > 0 && limit > 0 ? (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={`${c * frac} ${c}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      ) : null}
    </svg>
  );
}

/** One breakdown row: label · tokens · a mini-bar relative to usedTokens. */
function BreakdownRow({
  label,
  value,
  usedTokens,
  note,
}: {
  label: string;
  value: number;
  usedTokens: number;
  note?: string;
}) {
  const styles = useThemeStyles();
  const pct = usedTokens > 0 ? Math.max(2, (value / usedTokens) * 100) : 0;
  return (
    <div className="flex items-center gap-2" data-breakdown-row={label}>
      <span className="text-[10.5px] min-w-0 flex-1 truncate" style={{ color: styles.textSecondary }}>
        {label}
      </span>
      <span className="font-mono text-[10px] shrink-0" style={{ color: styles.textTertiary }}>
        {note ?? fmtTokens(value)}
      </span>
      <div className="w-16 h-[3px] rounded-full overflow-hidden shrink-0" style={{ background: styles.subtle }}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: styles.accent }} />
      </div>
    </div>
  );
}

/** A label · value row for the session-totals groups. */
function StatRow({ label, value }: { label: string; value: string }) {
  const styles = useThemeStyles();
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10.5px]" style={{ color: styles.textSecondary }}>
        {label}
      </span>
      <span className="font-mono text-[10.5px] font-bold" style={{ color: styles.text }}>
        {value}
      </span>
    </div>
  );
}

const ZERO_TOTALS: SessionUsageTotals = { inputTokens: 0, outputTokens: 0, requests: 0, costUsd: 0 };

/**
 * ROUND-51 (R51-c): one usage group of the Session section (owner: "The
 * actual main sessions stats and the sub-agent sessions stats will be kept
 * separate. They will not be kept separate completely. They will be shown as
 * combined all together too.") — requests, tokens sent ↑ / received ↓, cost.
 * A group with no activity shows zeros (cost "—").
 */
function UsageGroup({
  label,
  totals,
  group,
}: {
  label: string;
  totals: SessionUsageTotals;
  group: "main" | "subagents" | "combined";
}) {
  const styles = useThemeStyles();
  return (
    <div
      className={`flex flex-col gap-1 pt-1.5 ${group === "main" ? "" : "mt-1 border-t"}`}
      style={group === "main" ? undefined : { borderColor: styles.borderSubtle }}
      data-usage-group={group}
    >
      <div className="text-[9.5px] font-bold uppercase tracking-wider pb-0.5" style={{ color: styles.textTertiary }}>
        {label}
      </div>
      <StatRow label="Requests" value={String(totals.requests)} />
      <StatRow label="Tokens sent ↑" value={fmtTokens(totals.inputTokens)} />
      <StatRow label="Tokens received ↓" value={fmtTokens(totals.outputTokens)} />
      <StatRow label="Cost" value={totals.costUsd > 0 ? `$${totals.costUsd.toFixed(4)}` : "—"} />
    </div>
  );
}

/**
 * ROUND-50 (R50-c2): the context donut (owner: "It will show me the context
 * window of the model… a donut-shaped circle, which would show the total
 * context limit… the detailed overview… how much context was used on
 * messages, MCP tools, system tools, system prompt, skills, meta content…
 * the average cache hit rate… at the very bottom, in a dedicated section, the
 * actual costs, the total token consumption, and all other stats for the
 * specific session").
 *
 * ROUND-51 (R51-c) per the owner's fourth test round:
 *  - the toolbar shows ONLY the ~22px ring (owner: "no need to show the
 *    actual percentage used… when the user hovers then the other details will
 *    show") — the % lives in the popover's big donut + the button title;
 *  - HOVER BRIDGE: leaving the trigger starts a ~220ms close timer and
 *    entering the popover cancels it (and vice versa) — the popover no longer
 *    snaps shut in the gap between the button and itself. Click still
 *    pins/unpins (touch path); focus opens, blur gets the same grace period;
 *  - the ring color grades by pressure (accent → amber → danger —
 *    contextDonutColor), both the small and the big donut;
 *  - the Session section splits into Main agent / Sub-agents / Combined
 *    (the report's usage split; a pre-R51 sidecar falls back to the flat
 *    totals with zero sub-agents).
 *
 * Data: fetchSessionContext(sessionId, effectiveModel) via react-query — the
 * transcript length rides the query key so the numbers refresh whenever the
 * conversation changes; 30s staleTime between.
 */
export function ContextDonut({
  sessionId,
  model,
  transcriptLength,
  liveMode,
}: {
  sessionId: string | null;
  /** Effective model (override ?? agent.model) — the report's ?model= param. */
  model: string | null;
  transcriptLength: number;
  liveMode: boolean;
}) {
  const styles = useThemeStyles();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  // ROUND-51 (R51-c): the shared close timer + a pinned mirror the timeout
  // callback can read at fire time (state would be stale in the closure).
  const pinnedRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  const clearCloseTimer = (): void => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };
  const scheduleClose = (): void => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      if (!pinnedRef.current) setOpen(false);
    }, POPOVER_CLOSE_DELAY_MS);
  };
  useEffect(() => clearCloseTimer, []);

  const popoverRef = useDismiss(open, () => {
    clearCloseTimer();
    setOpen(false);
    pinnedRef.current = false;
    setPinned(false);
  });

  const report = useQuery<SessionContextReport>({
    queryKey: ["session-context", sessionId, model, transcriptLength],
    queryFn: () => fetchSessionContext(sessionId as string, model ?? undefined),
    enabled: sessionId !== null && liveMode,
    staleTime: 30_000,
    retry: false,
  });

  const data = report.data ?? null;
  const used = data?.usedTokens ?? 0;
  const window_ = data?.contextWindow ?? 0;
  const pct = data !== null && window_ > 0 ? Math.min(100, (used / window_) * 100) : null;

  // ROUND-51 (R51-c): the graded ring color (accent → amber → danger).
  const ringColor = contextDonutColor(used, window_, styles.accent);

  const summaryText =
    data !== null
      ? `Context window: ${pct !== null ? Math.round(pct) : 0}% used (${fmtTokens(used)} of ${fmtTokens(window_)} tokens)`
      : report.isError
        ? "Context window usage unavailable"
        : "Context window usage";

  const hitRate =
    data !== null && data.cache.hitRate !== null
      ? `${Math.round(data.cache.hitRate * 100)}%`
      : "—";

  // ROUND-51 (R51-c): the main / sub-agents / combined usage split. A
  // pre-R51 sidecar (or an error fallback) has no `usage` object — main
  // falls back to the flat sessionTotals, sub-agents honestly read zero.
  const split = data?.usage ?? null;
  const mainTotals = split?.main ?? data?.sessionTotals ?? ZERO_TOTALS;
  const subagentTotals = split?.subagents ?? ZERO_TOTALS;
  const combinedTotals = split?.combined ?? mainTotals;

  return (
    <div className="relative shrink-0" ref={popoverRef}>
      <button
        type="button"
        onClick={() => {
          // Click toggles the PIN (touch path); hover alone also opens.
          clearCloseTimer();
          const next = !pinned;
          pinnedRef.current = next;
          setPinned(next);
          setOpen(next);
        }}
        onFocus={() => {
          // ROUND-51 (R51-c): keyboard parity — focus opens (blur gets the
          // same grace period as the pointer via scheduleClose).
          clearCloseTimer();
          setOpen(true);
        }}
        onBlur={scheduleClose}
        aria-label={summaryText}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={summaryText}
        data-context-donut
        className="flex items-center gap-1 h-7 px-1.5 rounded-[10px] transition-colors"
        style={{ color: styles.textSecondary }}
        onMouseEnter={(e) => {
          clearCloseTimer();
          setOpen(true);
          e.currentTarget.style.background = styles.subtleHover;
        }}
        onMouseLeave={(e) => {
          // ROUND-51 (R51-c): don't close instantly — start the grace timer
          // so the pointer can cross the gap into the popover.
          scheduleClose();
          e.currentTarget.style.background = "transparent";
        }}
      >
        {/* ROUND-51 (R51-c): icon-only in the toolbar (owner: "no need to
            show the actual percentage used") — the % lives in the popover. */}
        <DonutRing
          size={22}
          stroke={3}
          used={used}
          limit={window_}
          color={ringColor}
          track={report.isError ? withAlpha(SEMANTIC_COLORS.danger, 0.4) : styles.subtle}
        />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Context window details"
          data-context-popover
          className="absolute bottom-9 right-0 w-72 rounded-2xl border p-2.5 z-50"
          style={{ background: styles.card, borderColor: styles.border, boxShadow: styles.bentoShadow }}
          onMouseEnter={clearCloseTimer}
          onMouseLeave={scheduleClose}
        >
          {data === null ? (
            <div className="text-[11px] px-1 py-2" style={{ color: styles.textTertiary }}>
              {report.isError
                ? "context report unavailable"
                : sessionId === null
                  ? "starts with the first message"
                  : "loading context report…"}
            </div>
          ) : (
            <>
              {/* Big donut + % used + used / window */}
              <div className="flex items-center gap-3 px-1 pb-2 mb-2 border-b" style={{ borderColor: styles.borderSubtle }}>
                <div className="relative grid place-items-center shrink-0">
                  <DonutRing
                    size={46}
                    stroke={5}
                    used={used}
                    limit={window_}
                    color={ringColor}
                    track={styles.subtle}
                  />
                  <span className="absolute font-mono text-[10px] font-bold" style={{ color: styles.text }}>
                    {pct !== null ? Math.round(pct) : 0}%
                  </span>
                </div>
                <div className="min-w-0">
                  <div className="text-[12px] font-bold" style={{ color: styles.text }}>
                    {pct !== null ? `${Math.round(pct)}% used` : "0% used"}
                  </div>
                  <div className="font-mono text-[10px]" style={{ color: styles.textTertiary }}>
                    {fmtTokens(used)} / {fmtTokens(window_)} tokens
                  </div>
                  <div className="font-mono text-[9.5px] truncate" title={data.model} style={{ color: styles.textTertiary }}>
                    {data.model}
                  </div>
                </div>
              </div>
              {/* Breakdown slices */}
              <div className="flex flex-col gap-1.5 px-1 pb-2">
                <BreakdownRow label="Messages" value={data.breakdown.messages} usedTokens={used} />
                <BreakdownRow label="System prompt" value={data.breakdown.systemPrompt} usedTokens={used} />
                <BreakdownRow label="System tools" value={data.breakdown.systemTools} usedTokens={used} />
                <BreakdownRow
                  label="MCP tools"
                  value={data.breakdown.mcpTools}
                  usedTokens={used}
                  note={data.breakdown.mcpTools === 0 ? "none configured" : fmtTokens(data.breakdown.mcpTools)}
                />
                <BreakdownRow label="Memory & skills" value={data.breakdown.memory} usedTokens={used} />
                <BreakdownRow label="Meta & project" value={data.breakdown.meta} usedTokens={used} />
              </div>
              {/* Cache line */}
              <div
                className="flex items-center justify-between gap-2 px-1 py-1.5 mb-1 border-y"
                style={{ borderColor: styles.borderSubtle }}
              >
                <span className="text-[10.5px]" style={{ color: styles.textSecondary }}>
                  Cache hit rate
                </span>
                <span className="font-mono text-[10.5px] font-bold" style={{ color: styles.text }}>
                  {hitRate}
                  {data.cache.inputTokens > 0 ? (
                    <span className="font-normal" style={{ color: styles.textTertiary }}>
                      {" "}
                      · {fmtTokens(data.cache.cachedInputTokens)} / {fmtTokens(data.cache.inputTokens)} cached
                    </span>
                  ) : null}
                </span>
              </div>
              {/* Session totals — Main agent / Sub-agents / Combined
                  (owner, R51: separate BUT also combined). */}
              <div className="flex flex-col gap-1 px-1 pt-1" data-session-totals>
                <div className="font-mono text-[9px] font-bold uppercase tracking-widest pb-0.5" style={{ color: styles.textTertiary }}>
                  Session
                </div>
                <UsageGroup label="Main agent" totals={mainTotals} group="main" />
                <UsageGroup label="Sub-agents" totals={subagentTotals} group="subagents" />
                <UsageGroup label="Combined" totals={combinedTotals} group="combined" />
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
