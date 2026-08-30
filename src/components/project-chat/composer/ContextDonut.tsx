import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchSessionContext, type SessionContextReport } from "../../../lib/api";
import { fmtTokens } from "../../../lib/format";
import { SEMANTIC_COLORS } from "../../../lib/semantics";
import { useThemeStyles } from "../../../lib/use-theme-styles";
import { withAlpha } from "../../dashboard/helpers";
import { useDismiss } from "./composer-utils";

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

/** A label · value row for the session-totals section. */
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

/**
 * ROUND-50 (R50-c2): the context donut (owner: "It will show me the context
 * window of the model… a donut-shaped circle, which would show the total
 * context limit… the detailed overview… how much context was used on
 * messages, MCP tools, system tools, system prompt, skills, meta content…
 * the average cache hit rate… at the very bottom, in a dedicated section, the
 * actual costs, the total token consumption, and all other stats for the
 * specific session").
 *
 * Small ~22px donut + compact % label in the toolbar; HOVER (pointer) or
 * CLICK (touch) opens the detail popover: big donut + "% used", the six
 * breakdown slices with mini-bars, the cache line, and the session totals.
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
  const popoverRef = useDismiss(open, () => {
    setOpen(false);
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

  return (
    <div className="relative shrink-0" ref={popoverRef}>
      <button
        type="button"
        onClick={() => {
          // Click toggles the PIN (touch path); hover alone also opens.
          setPinned((v) => {
            const next = !v;
            setOpen(next ? true : false);
            return next;
          });
        }}
        aria-label={summaryText}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={summaryText}
        data-context-donut
        className="flex items-center gap-1 h-7 px-1.5 rounded-[10px] transition-colors"
        style={{ color: styles.textSecondary }}
        onMouseEnter={(e) => {
          setOpen(true);
          e.currentTarget.style.background = styles.subtleHover;
        }}
        onMouseLeave={(e) => {
          if (!pinned) setOpen(false);
          e.currentTarget.style.background = "transparent";
        }}
      >
        <DonutRing
          size={22}
          stroke={3}
          used={used}
          limit={window_}
          color={styles.accent}
          track={report.isError ? withAlpha(SEMANTIC_COLORS.danger, 0.4) : styles.subtle}
        />
        <span className="font-mono text-[10px] font-bold shrink-0" data-donut-label>
          {report.isError ? "—" : pct !== null ? `${Math.round(pct)}%` : "…"}
        </span>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Context window details"
          data-context-popover
          className="absolute bottom-9 right-0 w-72 rounded-2xl border p-2.5 z-50"
          style={{ background: styles.card, borderColor: styles.border, boxShadow: styles.bentoShadow }}
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
                    color={styles.accent}
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
              {/* Session totals (owner: "at the very bottom, in a dedicated section") */}
              <div className="flex flex-col gap-1 px-1 pt-1" data-session-totals>
                <div className="font-mono text-[9px] font-bold uppercase tracking-widest pb-0.5" style={{ color: styles.textTertiary }}>
                  Session
                </div>
                <StatRow label="Requests" value={String(data.sessionTotals.requests)} />
                <StatRow label="Tokens sent ↑" value={fmtTokens(data.sessionTotals.inputTokens)} />
                <StatRow label="Tokens received ↓" value={fmtTokens(data.sessionTotals.outputTokens)} />
                <StatRow
                  label="Cost"
                  value={data.sessionTotals.costUsd > 0 ? `$${data.sessionTotals.costUsd.toFixed(4)}` : "—"}
                />
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
