import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { useTimeoutClear } from "../../../hooks/use-timeout-clear";
import { useScrollFade } from "../../../lib/useScrollFade";
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

/**
 * ROUND-58 (R58-cf, owner: the popover "opens instantly on hover" and startles
 * on the way to the Send button): the HOVER-INTENT delay — the pointer must
 * REST on the donut this long before the popover opens. Focus and click stay
 * instant (keyboard/touch never pay the toll).
 */
export const POPOVER_OPEN_INTENT_MS = 600;

/** useTimeoutClear schedules a one-shot; CANCELLING one means replacing it
 * with a never-firing no-op (the hook clears the previous timer whenever a
 * new one is scheduled, and clears its handle on unmount). 2^31-1 ms ≈ 24.8
 * days — far past any session, and the callback is a no-op anyway. */
const NEVER_MS = 2 ** 31 - 1;

// ── ROUND-64 (R64-c): the popover's viewport-clipped fixed layer ───────────

/** The popover's width (Tailwind w-72). */
const POPOVER_WIDTH_PX = 288;
/** Gap between the popover's bottom edge and the donut button's top. */
const POPOVER_GAP_PX = 10;
/** Minimum breathing room from every viewport edge. */
const VIEWPORT_MARGIN_PX = 12;
/** Floor for the scroll cap — a short viewport still shows a scrollable
 * slice (the donut header) instead of an unusable sliver. */
const POPOVER_MIN_HEIGHT_PX = 120;
/** The context report's live-refresh cadence while a turn streams. */
export const CONTEXT_LIVE_REFETCH_MS = 2_500;

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
 * conversation changes; 30s staleTime between. ROUND-64 (R64-c): while a
 * turn STREAMS the panel passes `liveTick` (the live working-entry count —
 * bumps on every tool call) + `streaming`, so the key changes as work lands
 * and the query also polls every CONTEXT_LIVE_REFETCH_MS with zero
 * staleTime (owner: the window must update live, not at turn end).
 *
 * ROUND-64 (R64-c) popover geometry (owner: "when I click on the context
 * window… it is not shown at the very top. It gets cut off"): the popover
 * renders in a document.body PORTAL as a `position: fixed` layer measured
 * from the donut button's getBoundingClientRect — bottom-anchored above the
 * button, left-clamped to the viewport, and capped at the space that
 * actually exists above with an internal scroll + fades. The hover-bridge /
 * pin / outside-dismiss behaviors are the R51/R58 logic unchanged (the
 * trigger wrapper counts as "inside" for the dismiss check).
 */
export function ContextDonut({
  sessionId,
  model,
  transcriptLength,
  liveTick = 0,
  streaming = false,
  liveMode,
}: {
  sessionId: string | null;
  /** Effective model (override ?? agent.model) — the report's ?model= param. */
  model: string | null;
  transcriptLength: number;
  /** ROUND-64 (R64-c): the active live turn's working-entry count — rides
   * the query key so the report refreshes as tool calls land (owner: "The
   * context window should regularly be getting updated as the agent makes
   * a tool call… It should not wait for the whole chat session to end"). */
  liveTick?: number;
  /** ROUND-64 (R64-c): a live turn is streaming — poll + zero staleTime. */
  streaming?: boolean;
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

  // ROUND-58 (R58-cf): the hover-intent open timer (useTimeoutClear — the
  // R57-a no-bare-setTimeout rule; the existing close bridge keeps its own
  // ref + unmount cleanup). openAfter(…, POPOVER_OPEN_INTENT_MS) opens the
  // popover only after the pointer RESTS on the trigger; cancelOpenIntent()
  // replaces the pending timer with a never-firing no-op (mouseLeave, click,
  // blur, outside-dismiss) so a stale intent can never re-open the popover
  // after the user left/unpinned.
  const openAfter = useTimeoutClear();
  const cancelOpenIntent = (): void => {
    openAfter(() => undefined, NEVER_MS);
  };

  // ROUND-64 (R64-c): the trigger wrapper (inside the composer tree) — the
  // popover itself now lives in a document.body PORTAL, so outside-dismiss
  // needs to know the trigger is NOT "outside" (click-to-pin keeps working).
  const triggerWrapRef = useRef<HTMLDivElement>(null);
  const popoverRef = useDismiss(open, () => {
    clearCloseTimer();
    cancelOpenIntent();
    setOpen(false);
    pinnedRef.current = false;
    setPinned(false);
  }, triggerWrapRef);

  // ── ROUND-64 (R64-c): the viewport-clipped fixed layer ──────────────────
  // Owner: "when I click on the context window… it is not shown at the very
  // top. It gets cut off and it does not show properly" — the old popover
  // was `absolute bottom-9 right-0` INSIDE the composer's clipped/overflow
  // ancestors, so a tall report's TOP vanished. Now it portals to
  // document.body as a `position: fixed` layer MEASURED from the trigger's
  // getBoundingClientRect: left-aligned (clamped to the viewport), bottom-
  // anchored POPOVER_GAP_PX above the button, and capped at the space that
  // actually exists above (minus the margin) with an internal scroll +
  // fades. Re-measured on resize/scroll while open (the empty-state
  // composer moves with the page).
  const [pos, setPos] = useState<{ left: number; bottom: number; maxHeight: number } | null>(null);
  const measurePos = useCallback((): void => {
    const el = triggerWrapRef.current;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN_PX, rect.left),
      Math.max(VIEWPORT_MARGIN_PX, vw - POPOVER_WIDTH_PX - VIEWPORT_MARGIN_PX),
    );
    // CSS `bottom` (distance from the viewport's bottom edge to the
    // popover's bottom edge): POPOVER_GAP_PX above the button's top.
    const bottom = Math.max(VIEWPORT_MARGIN_PX, vh - rect.top + POPOVER_GAP_PX);
    // Height cap: the popover's top must stay ≥ VIEWPORT_MARGIN_PX
    // (buttonTop − gap − maxHeight ≥ margin).
    const maxHeight = Math.max(
      POPOVER_MIN_HEIGHT_PX,
      rect.top - POPOVER_GAP_PX - VIEWPORT_MARGIN_PX,
    );
    setPos({ left, bottom, maxHeight });
  }, []);
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    measurePos();
    window.addEventListener("resize", measurePos);
    // capture: the page can scroll in nested containers, not just window.
    window.addEventListener("scroll", measurePos, true);
    return () => {
      window.removeEventListener("resize", measurePos);
      window.removeEventListener("scroll", measurePos, true);
    };
  }, [open, measurePos]);

  const report = useQuery<SessionContextReport>({
    queryKey: ["session-context", sessionId, model, transcriptLength, liveTick],
    queryFn: () => fetchSessionContext(sessionId as string, model ?? undefined),
    enabled: sessionId !== null && liveMode,
    // ROUND-64 (R64-c): live while a turn streams — zero staleTime + a
    // 2.5s poll floor; idle keeps the 30s staleness gate.
    staleTime: streaming ? 0 : 30_000,
    refetchInterval: streaming ? CONTEXT_LIVE_REFETCH_MS : false,
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

  // ROUND-64 (R64-c): the scroll treatment — the auto-scroll/useScrollFade
  // pair every long panel uses (scrollbar appears only while scrolling),
  // plus top/bottom card-gradient fades that render ONLY when the content
  // actually overflows the capped height.
  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollFade(scrollRef);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    setOverflowing(el !== null && el.scrollHeight > el.clientHeight + 2);
  }, [open, data]);

  return (
    <div className="relative shrink-0" ref={triggerWrapRef}>
      <button
        type="button"
        onClick={() => {
          // Click toggles the PIN (touch path) — INSTANT, never behind the
          // hover-intent delay; any pending intent is cancelled so it cannot
          // re-open an unpinned popover later (R58-cf).
          clearCloseTimer();
          cancelOpenIntent();
          const next = !pinned;
          pinnedRef.current = next;
          setPinned(next);
          setOpen(next);
        }}
        onFocus={() => {
          // ROUND-51 (R51-c): keyboard parity — focus opens (blur gets the
          // same grace period as the pointer via scheduleClose). Instant.
          clearCloseTimer();
          setOpen(true);
        }}
        onBlur={() => {
          cancelOpenIntent();
          scheduleClose();
        }}
        aria-label={summaryText}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={summaryText}
        data-context-donut
        className="flex items-center gap-1 h-7 px-1.5 rounded-[10px] transition-colors"
        style={{ color: styles.textSecondary }}
        onMouseEnter={(e) => {
          clearCloseTimer();
          // ROUND-58 (R58-cf): hover INTENT — the popover opens only after
          // the pointer RESTS here for the intent window (a pass-through on
          // the way to Send no longer startles the owner).
          openAfter(() => setOpen(true), POPOVER_OPEN_INTENT_MS);
          e.currentTarget.style.background = styles.subtleHover;
        }}
        onMouseLeave={(e) => {
          // ROUND-58 (R58-cf): leaving before the intent fires cancels it;
          // ROUND-51 (R51-c): the 220ms grace timer lets the pointer cross
          // the gap into an OPEN popover without snapping it shut.
          cancelOpenIntent();
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
      {/* ROUND-64 (R64-c): the popover in a document.body PORTAL — a fixed
          layer positioned from the trigger's rect, so tall content opens
          upward from the composer WITHOUT its top being clipped by the
          chat's overflow ancestors. Border/l&f rework (owner: "its border is
          not good… improve its borders' look and feel"): borderStrong edge,
          rounded-2xl, bentoShadow + a 1px inner top highlight, and a slim
          3px accent strip along the top. */}
      {open && pos !== null
        ? createPortal(
            <div
              ref={popoverRef}
              role="dialog"
              aria-label="Context window details"
              data-context-popover
              className="fixed z-[120] flex flex-col rounded-2xl border overflow-hidden"
              style={{
                left: `${pos.left}px`,
                bottom: `${pos.bottom}px`,
                width: `${POPOVER_WIDTH_PX}px`,
                maxHeight: `${pos.maxHeight}px`,
                background: styles.card,
                borderColor: styles.borderStrong,
                boxShadow: `${styles.bentoShadow}, inset 0 1px 0 ${
                  styles.isDark ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.55)"
                }`,
              }}
              onMouseEnter={clearCloseTimer}
              onMouseLeave={scheduleClose}
            >
              {/* The 3px accent strip — the popover's head, a quiet brand
                  mark instead of the old flat border. */}
              <div
                className="h-[3px] shrink-0"
                style={{
                  background: `linear-gradient(90deg, ${styles.accent}, ${withAlpha(
                    styles.accent,
                    0.15,
                  )})`,
                }}
                aria-hidden
              />
              <div
                ref={scrollRef}
                className="flex-1 min-h-0 overflow-y-auto auto-scroll p-3"
                data-context-popover-scroll
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
                    <div
                      className="flex items-center gap-3 px-1 pb-2 mb-2 border-b"
                      style={{ borderColor: styles.borderSubtle }}
                    >
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
                      <div
                        className="font-mono text-[9px] font-bold uppercase tracking-widest pb-0.5"
                        style={{ color: styles.textTertiary }}
                      >
                        Session
                      </div>
                      <UsageGroup label="Main agent" totals={mainTotals} group="main" />
                      <UsageGroup label="Sub-agents" totals={subagentTotals} group="subagents" />
                      <UsageGroup label="Combined" totals={combinedTotals} group="combined" />
                    </div>
                  </>
                )}
              </div>
              {/* Top/bottom fades — only while the content overflows the
                  capped height (they blend into the card surface). */}
              {overflowing ? (
                <div
                  className="pointer-events-none absolute left-0 right-0 top-[3px] h-3"
                  style={{ background: `linear-gradient(to bottom, ${styles.card}, transparent)` }}
                  aria-hidden
                />
              ) : null}
              {overflowing ? (
                <div
                  className="pointer-events-none absolute left-0 right-0 bottom-0 h-3"
                  style={{ background: `linear-gradient(to top, ${styles.card}, transparent)` }}
                  aria-hidden
                />
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
