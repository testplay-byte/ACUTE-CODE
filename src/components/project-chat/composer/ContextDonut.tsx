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
// ROUND-96 (R96-G): the popover's OVERLAY-WINDOW ladder — a DOM popover can
// never paint above the OS-level browser webview, so inside the Tauri shell
// the usage card rides the owned transparent menu-overlay window instead
// (the R90-C2/R92-A vehicle) and hovering the token usage never pauses the
// browser behind the "menu is open" caption.
import { isNativeBrowserAvailable } from "../../../lib/native-browser";
import {
  estimateUsageCardHeight,
  hideMenuOverlay,
  onMenuOverlayClose,
  onMenuOverlayHover,
  showMenuOverlay,
  type UsageCardPayload,
  type UsageLinePayload,
  type UsageSectionPayload,
} from "../../../lib/menu-overlay";

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

/** R96-G: the menu-overlay window's page paints a 6px padding around the
 * card — the OS window must reserve it on both axes (the R92-A menus' same
 * OVERLAY_CARD_PADDING arithmetic). */
const OVERLAY_WINDOW_PADDING_PX = 6;

// ── ROUND-96 (R96-G): the usage card payload (pure — exported for tests) ─────

/** One usage line (the exported type is the payload's). */
function line(label: string, value: string, opts: { note?: string; strong?: boolean } = {}): UsageLinePayload {
  return { label, value, ...opts };
}

/** One session group compressed to a single read-out line (the DOM popover
 * carries the full Turns/calls/tokens/cost rows; the overlay card is a
 * hover READ — the group's headline numbers, the DOM one a click away). */
function sessionLine(label: string, totals: SessionUsageTotals): UsageLinePayload {
  const activity =
    totals.providerCalls !== undefined
      ? `${totals.requests} turns · ${totals.providerCalls} calls`
      : `${totals.requests} turns`;
  return line(label, `${fmtTokens(totals.inputTokens)} ↑ · ${fmtTokens(totals.outputTokens)} ↓`, {
    note: totals.costUsd > 0 ? `${activity} · $${totals.costUsd.toFixed(4)}` : activity,
  });
}

/**
 * ROUND-96 (R96-G): the ContextDonut popover's content as the structured
 * usage-card payload the overlay window renders — the measured/estimated
 * rows, the model line, the breakdown, the cache line, the session split,
 * and the compaction/provenance note (the owner's named rows), all
 * JSON-safe strings. `null` when there is nothing to say yet (the same
 * empty/loading states the DOM popover shows). Pure; exported for tests.
 */
export function buildUsageCardSections(
  data: SessionContextReport | null,
  opts: { isError: boolean; sessionId: string | null },
): { title: string; sections: UsageSectionPayload[]; note?: string } | null {
  if (data === null) {
    const why = opts.isError
      ? "context report unavailable"
      : opts.sessionId === null
        ? "starts with the first message"
        : "loading context report…";
    return { title: "Context window usage", sections: [{ title: "Report", lines: [line("Status", why)] }] };
  }
  const window_ = data.contextWindow;
  const pct = window_ > 0 ? Math.min(100, (data.usedTokens / window_) * 100) : 0;
  const windowLines: UsageLinePayload[] = [
    line("Projected", `~${Math.round(pct)}%`, { strong: true }),
    line("Estimated", `${fmtTokens(data.usedTokens)} / ${fmtTokens(window_)}`, { note: "of window" }),
  ];
  if (data.actual != null) {
    windowLines.push(line("Measured", fmtTokens(data.actual.inputTokens), { strong: true, note: "at last request" }));
  } else {
    windowLines.push(line("Measured", "not yet", { note: "the first reply reports it" }));
  }
  windowLines.push(
    line(
      "Model",
      data.actual != null && data.actual.model !== data.model
        ? `next ${data.model} · measured ${data.actual.model}`
        : data.model,
    ),
  );
  const sections: UsageSectionPayload[] = [{ title: "Window", lines: windowLines }];
  sections.push({
    title: "Breakdown",
    lines: [
      line("Messages", fmtTokens(data.breakdown.messages)),
      line("System prompt", fmtTokens(data.breakdown.systemPrompt)),
      line("System tools", fmtTokens(data.breakdown.systemTools)),
      line("MCP tools", fmtTokens(data.breakdown.mcpTools)),
      line("Memory & skills", fmtTokens(data.breakdown.memory)),
      line("Meta & project", fmtTokens(data.breakdown.meta)),
    ],
  });
  const hitRate = data.cache.hitRate !== null ? `${Math.round(data.cache.hitRate * 100)}%` : "—";
  sections.push({
    title: "Cache",
    lines: [
      line("Hit rate", hitRate, {
        note: data.cache.hitRate === null && data.cache.inputTokens > 0 ? "not reported by this provider" : undefined,
      }),
      ...(data.cache.inputTokens > 0
        ? [line("Cached input", `${fmtTokens(data.cache.cachedInputTokens)} / ${fmtTokens(data.cache.inputTokens)}`)]
        : []),
    ],
  });
  const split = data.usage ?? null;
  const mainTotals = split?.main ?? data.sessionTotals;
  const subagentTotals = split?.subagents ?? { inputTokens: 0, outputTokens: 0, requests: 0, costUsd: 0 };
  const combinedTotals = split?.combined ?? mainTotals;
  sections.push({
    title: "Session",
    lines: [
      sessionLine("Main agent", mainTotals),
      sessionLine("Sub-agents", subagentTotals),
      sessionLine("Combined", combinedTotals),
    ],
  });
  const noteParts: string[] = [];
  if (data.compaction !== undefined) {
    noteParts.push(
      `compacted · ${data.compaction.droppedMessages} messages summarized · ~${fmtTokens(data.compaction.tokensSaved)} saved`,
    );
  }
  if (data.contextWindowSource === "override") noteParts.push(`${fmtTokens(window_)} window · your override`);
  else if (data.contextWindowSource === "catalog") noteParts.push(`${fmtTokens(window_)} window · catalog default`);
  else if (data.contextWindowSource === "default")
    noteParts.push(`${fmtTokens(window_)} window assumed — set it in Settings → Models`);
  return { title: "Context window usage", sections, note: noteParts.length > 0 ? noteParts.join(" · ") : undefined };
}

/** SVG donut ring — the toolbar icon and the popover's big donut share the math.
 * ROUND-83 (R83): optional `markerFrac` draws a thin radial TICK at a given
 * fraction of the ring (the budget line — available/window, the same line
 * compaction triggers on; the estimate fills live, the tick says where the
 * behavior changes). */
function DonutRing({
  size,
  stroke,
  used,
  limit,
  color,
  track,
  markerFrac,
}: {
  size: number;
  stroke: number;
  used: number;
  limit: number;
  color: string;
  track: string;
  markerFrac?: number;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = limit > 0 ? Math.min(1, used / limit) : 0;
  // The budget tick: a short radial line from inner to outer edge at the
  // marker fraction (−90° rotation matches the fill's origin).
  const marker =
    markerFrac !== undefined && markerFrac > 0 && markerFrac < 1
      ? (() => {
          const angle = -Math.PI / 2 + markerFrac * 2 * Math.PI;
          const cx = size / 2;
          const cy = size / 2;
          const x1 = cx + Math.cos(angle) * (r - stroke / 2 - 2);
          const y1 = cy + Math.sin(angle) * (r - stroke / 2 - 2);
          const x2 = cx + Math.cos(angle) * (r + stroke / 2 + 2);
          const y2 = cy + Math.sin(angle) * (r + stroke / 2 + 2);
          return (
            <line
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={SEMANTIC_COLORS.danger}
              strokeWidth={1.5}
              strokeLinecap="round"
            />
          );
        })()
      : null;
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
      {marker}
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
function StatRow({ label, value, title }: { label: string; value: string; title?: string }) {
  const styles = useThemeStyles();
  return (
    <div className="flex items-center justify-between gap-2" title={title}>
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
      {/* ROUND-83 (R83): "requests" counted TURNS since R24 (one usage row
          per turn) — relabeled honestly, with the REAL provider-call count
          beside it (a 5-iteration turn is 1 turn · 5 calls). */}
      <StatRow label="Turns" value={String(totals.requests)} />
      {totals.providerCalls !== undefined ? (
        <StatRow label="Provider calls" value={String(totals.providerCalls)} />
      ) : null}
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
  providerId,
  transcriptLength,
  liveTick = 0,
  streaming = false,
  liveMode,
}: {
  sessionId: string | null;
  /** Effective model (override ?? agent.model) — the report's ?model= param. */
  model: string | null;
  /** ROUND-82 (R82, the owner's custom-provider routing fix): the override's
   * provider (override ?? agent.providerId) — the report's ?providerId= param,
   * so the meter reads the window/pricing rows of the provider that will
   * actually serve the next send. */
  providerId: string | null;
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

  // ── ROUND-96 (R96-G): the popover's OVERLAY-WINDOW ladder ────────────────
  // Owner: "when I try to hover over the total number of token usage that has
  // been done, it apparently hides the browser and says, 'Browser paused
  // while the menu is open.' This is not a great experience." A DOM popover
  // can never paint above the OS-level browser webview, so inside the Tauri
  // shell the usage card rides the R90-C2/R92-A MENU OVERLAY WINDOW (an
  // owned transparent OS window that DOES ride above the webview) and the
  // browser never pauses. `overlayLeg`:
  //  · "pending" — the overlay attempt is not resolved yet (web mode never
  //                resolves it — the isNativeBrowserAvailable() check below
  //                short-circuits the gate); the DOM portal stays DOWN so
  //                it can never flash for a frame (a one-frame portal over
  //                the panel would re-fire the very webview guard this
  //                ladder retires).
  //  · "overlay" — the overlay window IS the popover; the DOM portal must
  //                not render (a hidden duplicate would fire the guard).
  //  · "dom"     — the overlay command failed → the plain DOM popover, the
  //                pre-R96 behavior, for the REST of this open (a live data
  //                refresh never re-attempts mid-hover and flashes it).
  // The render-time gate (domLeg below) short-circuits on
  // isNativeBrowserAvailable() so WEB mode renders the portal on the very
  // first paint, exactly as before — every web-mode test lives on that leg.
  const [overlayLeg, setOverlayLeg] = useState<"pending" | "overlay" | "dom">("pending");
  /** Whether THIS popover's overlay window is the one currently up (the
   * shared window is a singleton; the subscriptions below only act on it). */
  const overlayUpRef = useRef(false);
  /** R92-A's open-request token: a close (or unmount) landing between the
   * show invoke and its resolution must not flip the leg back on. */
  const overlayReqRef = useRef(0);
  /** True while the show invoke is unresolved (the unmount cleanup must take
   * the window down in that window of time too). */
  const overlayInFlightRef = useRef(false);
  /** True once THIS open's overlay attempt failed — data refreshes while the
   * DOM fallback shows must not re-attempt (the flash). Reset on close. */
  const overlayFailedRef = useRef(false);

  const closeOverlayLeg = useCallback((): void => {
    overlayReqRef.current += 1;
    if (overlayUpRef.current || overlayInFlightRef.current) hideMenuOverlay();
    overlayUpRef.current = false;
    overlayInFlightRef.current = false;
    overlayFailedRef.current = false;
    setOverlayLeg("pending");
  }, []);

  /** The full close (both legs) — the dismissal paths' one call. The pinned
   * mirror (pinnedRef) resets so a later hover can re-open either leg. */
  const closePopover = useCallback((): void => {
    clearCloseTimer();
    cancelOpenIntent();
    pinnedRef.current = false;
    setPinned(false);
    setOpen(false);
  }, []);

  // The overlay page's hover bridge (pointer enter/leave over the CARD, which
  // lives in ITS window now): mapped onto the SAME close-grace timer the DOM
  // popover uses — parking the pointer on the card keeps it open, leaving
  // closes it (the R51 hover-bridge problem, restated across the boundary).
  useEffect(
    () =>
      onMenuOverlayHover((hovering) => {
        if (!overlayUpRef.current) return;
        if (hovering) clearCloseTimer();
        else if (!pinnedRef.current) scheduleClose();
      }),
    [],
  );

  // The overlay page's own close request (Escape while it somehow holds
  // focus — it is built focusable(false); the main window's Escape rides
  // useDismiss below, the belt to these braces).
  useEffect(
    () =>
      onMenuOverlayClose(() => {
        if (!overlayUpRef.current) return;
        closePopover();
      }),
    [closePopover],
  );

  // While the OVERLAY window is the popover, the main window owns the
  // dismissal gestures useDismiss provides for the DOM leg: any mousedown
  // here is by definition outside the card's own OS window. Escape already
  // rides useDismiss (its key handler is not ref-gated). A mousedown on the
  // trigger wrapper (the donut button) is exempt — that is the pin toggle,
  // not a dismiss (useDismiss semantics).
  useEffect(() => {
    if (overlayLeg !== "overlay") return;
    const onDown = (e: MouseEvent): void => {
      const el = triggerWrapRef.current;
      if (el !== null && el.contains(e.target as Node)) return;
      closePopover();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [overlayLeg, closePopover]);

  // Unmount while the overlay is up (chat/session switch) or while its show
  // is still in flight: take the window down and invalidate the request.
  useEffect(() => {
    return () => {
      overlayReqRef.current += 1;
      if (overlayUpRef.current || overlayInFlightRef.current) hideMenuOverlay();
    };
  }, []);

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
    // ROUND-82: providerId joins the key — a provider switch with the same
    // model string (custom gateways share ids) re-fetches the meter.
    queryKey: ["session-context", sessionId, model, providerId, transcriptLength, liveTick],
    queryFn: () =>
      fetchSessionContext(sessionId as string, model ?? undefined, providerId ?? undefined),
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

  // ROUND-83 (R83): the budget line — available/window (the same line the
  // compaction trigger and the context guard use; ONE truth). Rendered as
  // the tick on the big ring + the "compaction line" note under it.
  const available = data?.available ?? null;
  const markerFrac =
    available !== null && window_ > 0 && available > 0 && available < window_
      ? available / window_
      : undefined;

  // ROUND-83 (R83): the honest window provenance (§2.7 — a silent 200K
  // guess can never masquerade as a measured window).
  const windowSourceNote =
    data?.contextWindowSource === "override"
      ? `${fmtTokens(window_)} window · your override`
      : data?.contextWindowSource === "catalog"
        ? `${fmtTokens(window_)} window · catalog default`
        : data?.contextWindowSource === "default"
          ? `${fmtTokens(window_)} window assumed — set it in Settings → Models`
          : null;

  // ROUND-51 (R51-c): the graded ring color (accent → amber → danger).
  const ringColor = contextDonutColor(used, window_, styles.accent);

  // ROUND-83 (R83) §3.1: the honest summary — the estimate is LABELED as a
  // projection; the provider's own number (when one exists) rides along.
  // The old text presented the estimate as fact (the owner: "highly
  // misleading").
  const summaryText =
    data !== null
      ? `~${pct !== null ? Math.round(pct) : 0}% of context window projected` +
        (data.actual !== null && data.actual !== undefined
          ? ` · ${fmtTokens(data.actual.inputTokens)} measured at last request (of ${fmtTokens(window_)} window)`
          : ` (${fmtTokens(used)} of ${fmtTokens(window_)} tokens, estimated)`)
      : report.isError
        ? "Context window usage unavailable"
        : "Context window usage";

  const hitRate =
    data !== null && data.cache.hitRate !== null
      ? `${Math.round(data.cache.hitRate * 100)}%`
      : "—";
  // ROUND-83 (R83) §3.5: the null hit rate is HONEST — "not reported by
  // this provider" when usage exists but no call reported a cache tier
  // (distinct from zero usage, where "—" needs no note).
  const hitRateNote =
    data !== null && data.cache.hitRate === null && data.cache.inputTokens > 0
      ? "not reported by this provider"
      : undefined;

  // ROUND-51 (R51-c): the main / sub-agents / combined usage split. A
  // pre-R51 sidecar (or an error fallback) has no `usage` object — main
  // falls back to the flat sessionTotals, sub-agents honestly read zero.
  const split = data?.usage ?? null;
  const mainTotals = split?.main ?? data?.sessionTotals ?? ZERO_TOTALS;
  const subagentTotals = split?.subagents ?? ZERO_TOTALS;
  const combinedTotals = split?.combined ?? mainTotals;

  // ── R96-G: the overlay ladder's SHOW/REFRESH effect ─────────────────────
  // Opens with the overlay attempt (the payload mirrors the DOM popover's
  // content from the SAME report above), re-delivers the payload when the
  // live report refreshes while the overlay is up (the window is already up
  // — showMenuOverlay repositions + re-emits, no hide/show flash), and takes
  // the window down the moment `open` drops. Lives here (after the report
  // + data derivations) because it reads `data`/`report.isError`.
  useEffect(() => {
    if (!open) {
      closeOverlayLeg();
      return;
    }
    if (!isNativeBrowserAvailable()) return; // web/test mode → the DOM popover
    if (overlayFailedRef.current) return; // this open already fell back to the DOM leg
    const rect = triggerWrapRef.current?.getBoundingClientRect() ?? null;
    if (rect === null) return;
    const built = buildUsageCardSections(data, { isError: report.isError, sessionId });
    if (built === null) return;
    const payload: UsageCardPayload = {
      kind: "usage",
      title: built.title,
      width: POPOVER_WIDTH_PX,
      sections: built.sections,
      ...(built.note !== undefined ? { note: built.note } : {}),
      theme: {
        card: styles.card,
        border: styles.border,
        softShadow: styles.softShadow,
        text: styles.text,
        textSecondary: styles.textSecondary,
        textTertiary: styles.textTertiary,
        accent: styles.accent,
        subtleHover: styles.subtleHover,
        isDark: styles.isDark,
      },
    };
    // The DOM popover's geometry, mirrored: left-clamped, POPOVER_GAP_PX above
    // the button, capped at the space that exists above (the estimate never
    // pushes the window off the top of the screen — the card scrolls).
    const vw = window.innerWidth;
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN_PX, rect.left),
      Math.max(VIEWPORT_MARGIN_PX, vw - POPOVER_WIDTH_PX - VIEWPORT_MARGIN_PX),
    );
    const maxHeight = Math.max(POPOVER_MIN_HEIGHT_PX, rect.top - POPOVER_GAP_PX - VIEWPORT_MARGIN_PX);
    const cardHeight = Math.min(estimateUsageCardHeight(payload), maxHeight);
    const windowWidth = POPOVER_WIDTH_PX + 2 * OVERLAY_WINDOW_PADDING_PX;
    const anchor = {
      left,
      top: Math.max(0, rect.top - POPOVER_GAP_PX - cardHeight - 2 * OVERLAY_WINDOW_PADDING_PX),
      width: windowWidth,
      height: cardHeight + 2 * OVERLAY_WINDOW_PADDING_PX,
    };
    if (overlayUpRef.current) {
      // Already up — a live data refresh re-delivers in place.
      void showMenuOverlay(anchor, payload).catch(() => {});
      return;
    }
    overlayReqRef.current += 1;
    const seq = overlayReqRef.current;
    overlayInFlightRef.current = true;
    setOverlayLeg("pending");
    void showMenuOverlay(anchor, payload).then((ok) => {
      overlayInFlightRef.current = false;
      if (seq !== overlayReqRef.current) {
        if (ok) hideMenuOverlay(); // closed while the show was in flight
        return;
      }
      if (ok) {
        overlayUpRef.current = true;
        setOverlayLeg("overlay");
      } else {
        // The command failed (the R91 deadlock class): the DOM popover is
        // the honest fallback for the rest of this open, exactly as pre-R96.
        overlayFailedRef.current = true;
        setOverlayLeg("dom");
      }
    });
  }, [open, data, report.isError, sessionId, styles, closeOverlayLeg]);

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
            show the actual percentage used") — the % lives in the popover.
            ROUND-95 (R95-F) rode the MEASURED readout beside the ring;
            ROUND-96 (R96-H) REVERSED that per the owner's seventh report:
            "The context window was showing me how many tokens have been
            used and such, but it is not how we wanted it to be. It should
            not show that value alongside it." The ring renders ALONE at
            rest; every number — the measured count included — lives in the
            hover popover (+ the button's title tooltip), the R51 contract
            the R95-F inline readout broke. */}
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
          3px accent strip along the top.
          ROUND-96 (R96-G): the portal renders ONLY on the DOM leg — web
          mode short-circuits the gate (first paint, byte-identical to the
          pre-R96 behavior); in the Tauri shell the overlay window holds the
          popover, and a duplicate DOM portal (even for the one frame before
          the show resolves) would fire the webview guard and pause the
          browser: the exact report this round retires. */}
      {open && pos !== null && (!isNativeBrowserAvailable() || overlayLeg === "dom")
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
                    {/* Big donut + % projected + used / window + the
                        ROUND-83 measured line + budget marker + provenance */}
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
                          markerFrac={markerFrac}
                        />
                        <span className="absolute font-mono text-[10px] font-bold" style={{ color: styles.text }}>
                          {pct !== null ? Math.round(pct) : 0}%
                        </span>
                      </div>
                      <div className="min-w-0">
                        <div className="text-[12px] font-bold" style={{ color: styles.text }}>
                          {/* ROUND-83: the tilde says PROJECTED — the estimate
                              fills the ring live; the measured line below is
                              the provider's own number. */}
                          {pct !== null ? `~${Math.round(pct)}% projected` : "0% projected"}
                        </div>
                        <div className="font-mono text-[10px]" style={{ color: styles.textTertiary }}>
                          {fmtTokens(used)} / {fmtTokens(window_)} tokens · estimated
                        </div>
                        {/* ROUND-83 (R83) §3.1 + ROUND-95 (R95-F): the MEASURED
                            line — the provider's own prompt size for the
                            last request, PROMOTED to a first-class row (it
                            was a 9.5px tertiary line; the owner: "does not
                            properly show the actual context which is
                            currently being used"). `at` rides on the title;
                            null before the first reply → the honest
                            "not yet measured", never 0. */}
                        {data.actual != null ? (
                          <div
                            className="flex min-w-0 items-baseline gap-1.5"
                            data-context-measured
                            title={`${fmtTokens(data.actual.inputTokens)} tokens · ${new Date(data.actual.at).toLocaleString()}`}
                          >
                            <span className="font-mono text-[11px] font-bold" style={{ color: styles.text }}>
                              {fmtTokens(data.actual.inputTokens)}
                            </span>
                            <span className="shrink-0 text-[9.5px]" style={{ color: styles.textSecondary }}>
                              measured at last request
                            </span>
                          </div>
                        ) : (
                          <div
                            className="font-mono text-[9.5px]"
                            data-context-measured
                            style={{ color: styles.textSecondary }}
                          >
                            not yet measured — the first reply reports the provider's own count
                          </div>
                        )}
                        {/* The model line. ROUND-95 (R95-F): a per-send model
                            switch can never silently mix numbers — when the
                            measured number came from a DIFFERENT model than
                            the meter's current one, BOTH are named (the R83
                            "at + model must ride" rule, made visible). */}
                        <div className="font-mono text-[9.5px] truncate" title={data.model} style={{ color: styles.textTertiary }}>
                          {data.actual != null && data.actual.model !== data.model
                            ? `next send ${data.model} · measured ${data.actual.model}`
                            : data.model}
                        </div>
                      </div>
                    </div>
                    {/* ROUND-83 (R83): the budget line + window provenance —
                        one row under the header. The tick on the ring + this
                        note make the BEHAVIORAL line visible (the pre-R83
                        donut's 85% danger color and the compaction trigger
                        disagreed — different numerators AND denominators). */}
                    {(markerFrac !== undefined && available !== null) || windowSourceNote !== null ? (
                      <div
                        className="flex flex-col gap-0.5 px-1 pb-2 mb-1"
                        data-context-budget
                        style={{ color: styles.textTertiary }}
                      >
                        {markerFrac !== undefined && available !== null ? (
                          <div className="font-mono text-[9.5px]">
                            compaction line {fmtTokens(available)} · reserve {fmtTokens(data?.maxOutputTokens ?? 0)} output
                          </div>
                        ) : null}
                        {windowSourceNote !== null ? (
                          <div className="font-mono text-[9.5px] truncate" data-context-window-source>
                            {windowSourceNote}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {/* ROUND-83 (R83) §2.4: the compaction badge — the visible
                        truth that older context was summarized (the ring DROPS
                        after a compaction instead of lying high; tokensSaved
                        is an estimate delta, hence the ~). */}
                    {data.compaction !== undefined ? (
                      <div
                        className="flex items-center gap-1.5 px-1 py-1.5 mb-1 border-y"
                        style={{ borderColor: styles.borderSubtle }}
                        data-context-compaction
                      >
                        <span className="text-[10.5px] font-bold" style={{ color: styles.accent }}>
                          Context compacted
                        </span>
                        <span className="font-mono text-[10px]" style={{ color: styles.textTertiary }}>
                          {data.compaction.droppedMessages} messages summarized · ~{fmtTokens(data.compaction.tokensSaved)} saved
                        </span>
                      </div>
                    ) : null}
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
                      title={hitRateNote}
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
                        {/* ROUND-83 (R83) §2.10: a null rate on a live session
                            is the honest "not reported" — never a fabricated
                            0%. */}
                        {hitRateNote !== undefined ? (
                          <span className="font-normal" style={{ color: styles.textTertiary }}>
                            {" "}· {hitRateNote}
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
