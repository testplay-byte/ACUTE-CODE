import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import {
  fetchSessionContext,
  type SessionContextReport,
} from "../../../lib/api";
import { fmtTokens } from "../../../lib/format";
import { SEMANTIC_COLORS } from "../../../lib/semantics";
import { getContrastText } from "../../../lib/themes";
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
  USAGE_BAR_LABEL_MIN_FRAC,
  estimateUsageCardHeight,
  hideMenuOverlay,
  onMenuOverlayClose,
  onMenuOverlayHover,
  onMenuOverlayPick,
  showMenuOverlay,
  usageSegmentHex,
  type UsageBarSegmentPayload,
  type UsageCardPayload,
  type UsageContextBarPayload,
  type UsageLinePayload,
  type UsageMetaPair,
  type UsageOverviewPayload,
  type UsageSegmentColor,
  type UsageSectionPayload,
  type UsageTableRowPayload,
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

/** The popover's width. R98-C3 (owner: "you can use a wider aspect ratio
 * for this too as needed… proper separation between the elements") — the
 * cramped 288px single column became a 420px stack of sectioned panes. */
const POPOVER_WIDTH_PX = 420;
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

// ── ROUND-96 (R96-G) + ROUND-97 (R97-C): the usage card payload (pure — exported for tests) ─────

/** One usage line (the exported type is the payload's). */
function line(
  label: string,
  value: string,
  opts: { note?: string; strong?: boolean; barFrac?: number; barColor?: UsageSegmentColor } = {},
): UsageLinePayload {
  return { label, value, ...opts };
}

/** R97-C → R99-D: the six context categories, their display order, their
 * PALETTE KEYS, and — new in R99-D — their MANAGEMENT SURFACES (the Claude
 * Code /context pattern: every number paired with an action, but ONLY where
 * a real surface exists — messages / system tools / meta honestly carry no
 * link, never a dead one). The single mapping both views (the overlay card +
 * the DOM popover) paint the bar segments and the legend rows from. Messages
 * rides the theme accent (the dominant segment reads as the app's own
 * color); the rest are fixed distinguishable hues (see usageSegmentHex). */
const BREAKDOWN_CATEGORIES: ReadonlyArray<{
  label: string;
  key: "messages" | "systemPrompt" | "systemTools" | "mcpTools" | "memory" | "meta";
  color: UsageSegmentColor;
  /** R99-D: the settings deep-link where this category can be managed
   * (system prompt / Memory & skills → the Prompts tab — the R98-E prompt
   * manager; MCP tools → the MCP servers tab). */
  manage?: { target: string; title: string };
}> = [
  { label: "Messages", key: "messages", color: "accent" },
  {
    label: "System prompt",
    key: "systemPrompt",
    color: "blue",
    manage: {
      target: "/settings?tab=prompts",
      title: "Manage the prompt sections — Settings → Prompts",
    },
  },
  { label: "System tools", key: "systemTools", color: "teal" },
  {
    label: "MCP tools",
    key: "mcpTools",
    color: "violet",
    manage: {
      target: "/settings?tab=mcp",
      title: "Manage MCP servers — Settings → MCP Servers",
    },
  },
  {
    label: "Memory & skills",
    key: "memory",
    color: "amber",
    manage: {
      target: "/settings?tab=prompts",
      title: "Manage skills & prompt sections — Settings → Prompts",
    },
  },
  { label: "Meta & project", key: "meta", color: "rose" },
];

/** R97-C: the ring color key for a used/window fraction — the SAME grading
 * the donut ring uses (contextDonutColor), expressed as the payload's
 * JSON-safe key so the overlay renderer can paint it. Pure. */
export function usageRingColorKey(usedTokens: number, windowTokens: number): "accent" | "warn" | "danger" {
  if (windowTokens <= 0) return "accent";
  const frac = Math.min(1, usedTokens / windowTokens);
  if (frac > CONTEXT_DONUT_DANGER) return "danger";
  if (frac >= CONTEXT_DONUT_WARN) return "warn";
  return "accent";
}

/** The shape buildUsageCardSections returns (R99-D: the overview hero +
 * the bar-with-legend + the Cache/Session sections; the R97-C bottom note
 * is retired — its content lives in the badge + the meta pairs now, killing
 * the duplicate encodings). */
export interface UsageCardBuild {
  title: string;
  contextBar?: UsageContextBarPayload;
  overview?: UsageOverviewPayload;
  sections: UsageSectionPayload[];
}

/**
 * ROUND-96 (R96-G) → R97-C → R99-D: the ContextDonut popover's content as
 * the structured usage-card payload the overlay window renders — THE single
 * build both legs paint from (the DOM popover renders its body from this
 * build too, so the two legs cannot drift). R99-D restructures it after the
 * Claude Code /context reference (the owner: "the context window
 * composition does not look proper… the overview is not proper"):
 *  · the OVERVIEW HERO — the big token line ("40k of 200k", the primary
 *    read) + ONE % meta line ("~20% projected", percentage first) + the
 *    honesty pairs (measured / model / window provenance — never more than
 *    three rows) + the compaction/reserve line + the compacted badge riding
 *    the header row;
 *  · the CONTEXT BAR — full card width, one colored segment per category
 *    with its inline % label when the segment is ≥12% of the window, the
 *    reserved-for-output hatched block, free space as the track (the
 *    flanking used/window counts retired — the hero's big line carries
 *    them: one source of truth per number);
 *  · the LEGEND under the bar (REPLACES the old Breakdown section — the
 *    mini-bars retired with it): palette dot + label + tokens + % of used
 *    per category, the management link-chips where surfaces exist;
 *  · the CACHE one-row section + the session TABLE (Turns / Calls / Sent /
 *    Received / Cost per Main / Sub-agents / Combined).
 * `null` never happens for a live report; the empty/loading states carry
 * their own honest lines. Pure; exported for tests.
 */
export function buildUsageCardSections(
  data: SessionContextReport | null,
  opts: { isError: boolean; sessionId: string | null },
): UsageCardBuild {
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
  // R97-C: the session split (main / sub-agents / combined) — the TABLE rows
  // read from these (a pre-R51 sidecar falls back to the flat sessionTotals
  // with honest zero sub-agents).
  const split = data.usage ?? null;
  const mainTotals = split?.main ?? data.sessionTotals;
  const subagentTotals = split?.subagents ?? { inputTokens: 0, outputTokens: 0, requests: 0, costUsd: 0 };
  const combinedTotals = split?.combined ?? mainTotals;

  // ── R99-D: the OVERVIEW HERO's honesty block — ≤3 label:value pairs. The
  // measured pair keeps the R83 basis IN the label ("measured at last
  // request" → the provider's own count; "not yet measured" before the
  // first reply — never a fake 0); the model pair names BOTH models on a
  // per-send switch (never silently mixing numbers); the window pair
  // carries the provenance (override / catalog / the honest "assumed").
  const meta: UsageMetaPair[] = [
    data.actual != null
      ? {
          id: "measured",
          label: "measured at last request",
          value: fmtTokens(data.actual.inputTokens),
          title: `${fmtTokens(data.actual.inputTokens)} tokens · ${new Date(data.actual.at).toLocaleString()}`,
        }
      : {
          id: "measured",
          label: "measured at last request",
          value: "not yet measured",
          title: "the first reply reports the provider's own count",
        },
    {
      id: "model",
      label: "model",
      value:
        data.actual != null && data.actual.model !== data.model
          ? `next send ${data.model} · measured ${data.actual.model}`
          : data.model,
    },
  ];
  const windowSource =
    data.contextWindowSource === "override"
      ? `${fmtTokens(window_)} · your override`
      : data.contextWindowSource === "catalog"
        ? `${fmtTokens(window_)} · catalog default`
        : data.contextWindowSource === "default"
          ? `${fmtTokens(window_)} assumed — set it in Settings → Models`
          : null;
  if (windowSource !== null) meta.push({ id: "window", label: "window", value: windowSource });

  const available = data.available ?? null;
  const markerFrac =
    available !== null && window_ > 0 && available > 0 && available < window_ ? available / window_ : 0;
  const overview: UsageOverviewPayload = {
    used: data.usedTokens,
    limit: window_,
    markerFrac,
    ringColor: usageRingColorKey(data.usedTokens, window_),
    bigUsed: fmtTokens(data.usedTokens),
    bigLimit: fmtTokens(window_),
    // The ONE % line — percentage first; the R83 tilde says PROJECTED.
    pctLine: `~${Math.round(pct)}% projected`,
    meta,
    ...(available !== null
      ? {
          budgetLine: `compaction line ${fmtTokens(available)} · reserve ${fmtTokens(
            data.maxOutputTokens ?? 0,
          )} output`,
        }
      : {}),
    ...(data.compaction !== undefined
      ? {
          compactedBadge: {
            label: "Context compacted",
            detail: `${data.compaction.droppedMessages} messages summarized · ~${fmtTokens(
              data.compaction.tokensSaved,
            )} saved`,
          },
        }
      : {}),
  };

  // ── the CONTEXT BAR + its LEGEND (the old Breakdown section merged under
  // the bar): each segment carries its own legend row — the pre-formatted
  // tokens + the % of used ride the payload so both legs paint ONE spelling.
  // MCP tools honestly reads "none configured" at zero.
  const contextBar: UsageContextBarPayload = {
    usedTokens: data.usedTokens,
    windowTokens: window_,
    reservedTokens: data.maxOutputTokens ?? 0,
    usedPct: pct,
    segments: BREAKDOWN_CATEGORIES.map((cat) => {
      const value = data.breakdown[cat.key];
      return {
        label: cat.label,
        tokens: value,
        color: cat.color,
        tokensLabel: cat.key === "mcpTools" && value === 0 ? "none configured" : fmtTokens(value),
        pctOfUsed: data.usedTokens > 0 ? `${Math.round((value / data.usedTokens) * 100)}%` : "—",
        ...(cat.manage !== undefined ? { manage: cat.manage } : {}),
      };
    }),
    // R98-C3: the pane's label — both legs paint it as the pane header.
    label: "Window composition",
  };

  // ── the sections: Cache (ONE row — hit-rate bar + cached/total right-
  // aligned; the R83 §2.10 null-rate honesty rides the value itself) /
  // Session totals (the table).
  const cacheValue =
    data.cache.hitRate !== null
      ? data.cache.inputTokens > 0
        ? `${Math.round(data.cache.hitRate * 100)}% · ${fmtTokens(data.cache.cachedInputTokens)} / ${fmtTokens(
            data.cache.inputTokens,
          )} cached`
        : `${Math.round(data.cache.hitRate * 100)}%`
      : data.cache.inputTokens > 0
        ? "— · not reported by this provider"
        : "—";
  const sections: UsageSectionPayload[] = [
    {
      title: "Cache",
      lines: [
        line("Hit rate", cacheValue, {
          ...(data.cache.hitRate !== null ? { barFrac: Math.max(0.02, data.cache.hitRate) } : {}),
          barColor: "teal",
        }),
      ],
    },
  ];
  // R97-C → R99-D: the session split as the compact TABLE (Turns / Calls /
  // Sent ↑ / Received ↓ / Cost per Main / Sub-agents / Combined — the
  // R97-C session-cost headline now lives HERE, in the table's Cost column,
  // instead of the retired donut-header line). Both legs render this table
  // (one spelling, twins by construction); rows carry stable ids for the
  // DOM test pins.
  const tableRow = (
    id: string,
    label: string,
    totals: SessionContextReport["sessionTotals"],
    strong: boolean,
  ): UsageTableRowPayload => ({
    id,
    label,
    strong,
    cells: [
      String(totals.requests),
      totals.providerCalls !== undefined ? String(totals.providerCalls) : "—",
      `${fmtTokens(totals.inputTokens)} ↑`,
      `${fmtTokens(totals.outputTokens)} ↓`,
      totals.costUsd > 0 ? `$${totals.costUsd.toFixed(4)}` : "—",
    ],
  });
  sections.push({
    title: "Session totals",
    lines: [],
    table: {
      columns: ["Group", "Turns", "Calls", "Sent ↑", "Received ↓", "Cost"],
      rows: [
        tableRow("main", "Main agent", mainTotals, false),
        tableRow("subagents", "Sub-agents", subagentTotals, false),
        tableRow("combined", "Combined", combinedTotals, true),
      ],
    },
  });
  return { title: "Context window usage", contextBar, overview, sections };
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

/** R99-D: one LEGEND row — the old Breakdown section merged UNDER the bar
 * (palette dot + label + tokens right-aligned + the % of used; the mini-bars
 * RETIRED — the stacked bar already encodes the proportion, the duplicate
 * encoding was the "not proper" smell). The mutual hover-highlight stays
 * (hovering the row lights its bar segment and vice versa). Where a
 * management surface exists (the segment's `manage`), the label becomes a
 * subtle link-chip (↗ affordance, underline + the icon brightening on hover
 * — the CSS-var leg, no hand-rolled handlers) that closes the popover +
 * router-navigates; rows without a surface stay plain text (honest: no
 * dead links). */
function LegendRow({
  seg,
  lit,
  dimmed,
  onHover,
  onNavigate,
}: {
  seg: UsageBarSegmentPayload;
  lit: boolean;
  dimmed: boolean;
  onHover: (label: string | null) => void;
  onNavigate: (target: string) => void;
}) {
  const styles = useThemeStyles();
  const manage = seg.manage;
  const hex = usageSegmentHex(seg.color, styles.isDark, styles.accent);
  return (
    <div
      className="flex items-center gap-2 rounded-md px-1 -mx-1 transition-colors"
      data-breakdown-row={seg.label}
      onMouseEnter={() => onHover(seg.label)}
      onMouseLeave={() => onHover(null)}
      style={{ background: lit ? withAlpha(styles.text, 0.05) : "transparent" }}
    >
      <span
        aria-hidden
        className="shrink-0 rounded-full transition-opacity"
        style={{
          width: 6,
          height: 6,
          background: hex,
          opacity: dimmed ? 0.4 : 1,
        }}
      />
      {manage !== undefined ? (
        <button
          type="button"
          onClick={() => onNavigate(manage.target)}
          className="group flex min-w-0 flex-1 origin-left items-center gap-0.5 text-left transition-transform active:scale-95"
          title={manage.title}
          aria-label={`${seg.label} — manage in Settings`}
        >
          <span
            className="min-w-0 truncate text-[11px] group-hover:underline"
            style={{ color: lit ? styles.text : styles.textSecondary, fontWeight: lit ? 500 : 400 }}
          >
            {seg.label}
          </span>
          <ArrowUpRight
            aria-hidden
            size={9}
            className="shrink-0 opacity-50 transition-opacity group-hover:opacity-100"
            style={{ color: styles.accent }}
          />
        </button>
      ) : (
        <span
          className="min-w-0 flex-1 truncate text-[11px]"
          style={{ color: lit ? styles.text : styles.textSecondary, fontWeight: lit ? 500 : 400 }}
        >
          {seg.label}
        </span>
      )}
      <span
        className="font-mono text-[10px] tabular-nums shrink-0"
        style={{ color: styles.textTertiary }}
      >
        {seg.tokensLabel}
      </span>
      <span
        className="font-mono text-[10px] tabular-nums shrink-0 w-9 text-right"
        style={{ color: lit ? styles.text : styles.textSecondary }}
      >
        {seg.pctOfUsed}
      </span>
    </div>
  );
}

/** R97-C → R99-D: the DOM popover's CONTEXT BAR — the STAR of the card, the
 * visual bridge between "how full" (the hero's big numbers directly above)
 * and "what's inside" (the legend directly below). Full pane width (the
 * pre-R99 flanking used/window counts are retired — the hero's big line
 * carries them, one source of truth per number), 14px tall so every segment
 * ≥12% of the window carries its % label INSIDE (narrower segments stay
 * honest-quiet — the legend carries their numbers), the reserved hatched
 * block after the used segments, free space as the track, and the mutual
 * hover-highlight against the legend rows (kept). */
function ContextBar({
  bar,
  hoverSeg,
  onHover,
}: {
  bar: UsageContextBarPayload;
  hoverSeg: string | null;
  onHover: (label: string | null) => void;
}) {
  const styles = useThemeStyles();
  const reservedHex = usageSegmentHex("reserved", styles.isDark, styles.accent);
  // R99-D a11y: the inline labels are visual-only above the threshold — the
  // bar's aria-label summarizes EVERY category's share, so the composition
  // never depends on the hover affordance.
  const aria =
    `Context composition (share of window): ` +
    bar.segments
      .map((seg) => {
        const frac = bar.windowTokens > 0 ? Math.min(1, seg.tokens / bar.windowTokens) : 0;
        return `${seg.label} ${Math.round(frac * 100)}%`;
      })
      .join(", ");
  return (
    <div
      role="img"
      aria-label={aria}
      data-context-bar
      className="flex w-full h-[14px] rounded-full overflow-hidden"
      style={{ background: withAlpha(styles.text, 0.1) }}
    >
      {bar.segments.map((seg) => {
        const frac = bar.windowTokens > 0 ? Math.min(1, seg.tokens / bar.windowTokens) : 0;
        const lit = hoverSeg === seg.label;
        const hex = usageSegmentHex(seg.color, styles.isDark, styles.accent);
        // R99-D: the inline % label — ONLY for segments wide enough to hold
        // it honestly (≥12% of the window ≈ its share of the bar's width).
        const showLabel = frac >= USAGE_BAR_LABEL_MIN_FRAC;
        return (
          <div
            key={seg.label}
            data-context-seg={seg.label}
            className="transition-opacity duration-100 flex items-center justify-center overflow-hidden"
            title={`${seg.label} · ${fmtTokens(seg.tokens)} tokens · ${Math.round(frac * 100)}% of window`}
            onMouseEnter={() => onHover(seg.label)}
            onMouseLeave={() => onHover(null)}
            style={{
              width: `${frac * 100}%`,
              background: hex,
              opacity: hoverSeg === null || lit ? 1 : 0.35,
              ...(lit ? { boxShadow: `0 0 0 1px ${withAlpha(styles.accent, 0.35)}` } : {}),
            }}
          >
            {showLabel ? (
              <span
                className="font-mono text-[10px] font-medium tabular-nums leading-none whitespace-nowrap"
                style={{ color: getContrastText(hex) }}
              >
                {`${Math.round(frac * 100)}%`}
              </span>
            ) : null}
          </div>
        );
      })}
      {/* The reserved-for-output block — dimmed + hatched, so "free"
          never reads as fully usable (Kilo's three-segment insight). */}
      {bar.windowTokens > 0 && bar.reservedTokens > 0 ? (
        <div
          title={`Reserved for output · ${fmtTokens(bar.reservedTokens)} tokens`}
          style={{
            width: `${Math.min(100 - bar.usedPct, (bar.reservedTokens / bar.windowTokens) * 100)}%`,
            background: `repeating-linear-gradient(45deg, ${withAlpha(reservedHex, 0.55)}, ${withAlpha(
              reservedHex,
              0.55,
            )} 2px, ${withAlpha(reservedHex, 0.25)} 2px, ${withAlpha(reservedHex, 0.25)} 4px)`,
          }}
        />
      ) : null}
    </div>
  );
}

/** R98-C3 (owner: "proper separation between the elements… the whole
 * layout of it needs to be adjusted properly") — THE PANE: the sectioned
 * card the popover's sections are built from on the DOM leg (the overlay
 * card's twin paints the same recipe from the payload's label fields). A
 * rounded inset group — the theme's subtle wash + a hairline border + the
 * micro-header — so each region (Window composition / Cache / Session
 * totals) reads as its own visual block, separated by real space. R99-D:
 * the overview rides UNBOXED above these (it IS the top) and every header
 * speaks the ONE grammar — 10px uppercase tracked label-caps, textTertiary,
 * the 8px margin below. */
function Pane({ label, children }: { label: string; children: ReactNode }) {
  const styles = useThemeStyles();
  return (
    <section
      data-pane={label}
      className="rounded-lg border p-2 mb-2"
      style={{ borderColor: styles.borderSubtle, background: styles.subtle }}
    >
      <div
        className="text-[10px] font-medium uppercase tracking-[0.08em] mb-2"
        style={{ color: styles.textTertiary }}
      >
        {label}
      </div>
      {children}
    </section>
  );
}

/** R98-C3 → R99-D: the session TABLE on the DOM leg — the SAME spelling as
 * the overlay card's (one component; the pre-R98 stacked UsageGroup rows are
 * dead). The 6-column grid (Group / Turns / Calls / Sent ↑ / Received ↓ /
 * Cost) reads scannably at the 420px width: the subtle uppercase header row,
 * right-aligned mono cells, and tabular-nums on every numeric (the
 * anti-jitter rule — digits hold their width while live values grow). */
function UsageTable({ table }: { table: NonNullable<UsageSectionPayload["table"]> }) {
  const styles = useThemeStyles();
  return (
    <div data-usage-table className="flex flex-col">
      <div
        className="grid gap-x-1 pb-1 mb-1 border-b"
        style={{
          gridTemplateColumns: "minmax(0, 1.2fr) repeat(5, minmax(0, 1fr))",
          borderColor: styles.borderSubtle,
        }}
      >
        {table.columns.map((col, ci) => (
          <span
            key={ci}
            className="text-[10px] font-medium uppercase tracking-[0.08em] truncate"
            style={{ color: styles.textTertiary, textAlign: ci === 0 ? "left" : "right" }}
          >
            {col}
          </span>
        ))}
      </div>
      {table.rows.map((row, ri) => (
        <div
          key={`${ri}-${row.label}`}
          data-usage-row={row.id ?? row.label}
          className="grid gap-x-1 items-baseline py-[1px]"
          style={{ gridTemplateColumns: "minmax(0, 1.2fr) repeat(5, minmax(0, 1fr))" }}
        >
          <span
            className="text-[10px] truncate"
            style={{
              color: row.strong === true ? styles.text : styles.textSecondary,
              fontWeight: row.strong === true ? 700 : 500,
            }}
          >
            {row.label}
          </span>
          {row.cells.map((cell, ci) => (
            <span
              key={ci}
              className="font-mono text-[10px] truncate text-right tabular-nums"
              style={{
                color: row.strong === true ? styles.text : styles.textSecondary,
                fontWeight: row.strong === true ? 700 : 500,
              }}
            >
              {cell}
            </span>
          ))}
        </div>
      ))}
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
  // R99-D: the legend's management link-chips navigate the router (the
  // ModelSelector goManageModels precedent: close the popover FIRST, then
  // navigate — the popover lives above the composer).
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  // R97-C: the mutual hover-highlight's state — the currently hovered category
  // label, shared by the context bar's segments and the legend rows (the
  // Cursor-style cross-highlight, on both the DOM leg and the overlay twin).
  const [hoverSeg, setHoverSeg] = useState<string | null>(null);
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

  // R99-D: the legend link-chip navigation — close the popover (both legs:
  // setOpen(false) makes the overlay effect below take the window down),
  // then router-navigate to the management surface.
  const goManage = useCallback(
    (target: string): void => {
      closePopover();
      navigate(target);
    },
    [closePopover, navigate],
  );

  // R99-D: the OVERLAY leg's link-chips — the usage card rides the
  // menu-overlay OS window, so its clicks land THERE; the legend's "manage in
  // Settings" chips report back through the shared pick channel as the
  // "usage-link" kind (every other subscriber filters by its own kind, so
  // this stays private to the popover). Close + navigate, exactly like the
  // DOM chip.
  useEffect(
    () =>
      onMenuOverlayPick((pick) => {
        if (!overlayUpRef.current) return;
        if (pick.kind !== "usage-link") return;
        closePopover();
        navigate(pick.target);
      }),
    [closePopover, navigate],
  );

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

  // ROUND-51 (R51-c): the graded ring color (accent → amber → danger).
  const ringColor = contextDonutColor(used, window_, styles.accent);

  // ── R99-D: THE payload build — the single source BOTH legs paint from (the
  // overlay window gets it through showMenuOverlay below; the DOM popover
  // renders its body from the same build right in this component, so the
  // two legs cannot drift). Pure + cheap; rebuilt on every report refresh.
  const built = data !== null ? buildUsageCardSections(data, { isError: report.isError, sessionId }) : null;
  const cacheLine = built?.sections.find((s) => s.title === "Cache")?.lines[0] ?? null;
  const sessionTable = built?.sections.find((s) => s.title === "Session totals")?.table ?? null;

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
    const payload: UsageCardPayload = {
      kind: "usage",
      title: built.title,
      width: POPOVER_WIDTH_PX,
      // R99-D: the full visual card — the context bar (+ its legend rows)
      // and the overview hero cross the payload boundary with the sections
      // now; the note is retired (badge + meta pairs carry its content).
      ...(built.contextBar !== undefined ? { contextBar: built.contextBar } : {}),
      ...(built.overview !== undefined ? { overview: built.overview } : {}),
      sections: built.sections,
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
        className="flex items-center gap-1 h-7 px-1.5 rounded-lg transition-colors hover:bg-hover"
        style={{ color: styles.textSecondary }}
        onMouseEnter={() => {
          clearCloseTimer();
          // ROUND-58 (R58-cf): hover INTENT — the popover opens only after
          // the pointer RESTS here for the intent window (a pass-through on
          // the way to Send no longer startles the owner).
          openAfter(() => setOpen(true), POPOVER_OPEN_INTENT_MS);
        }}
        onMouseLeave={() => {
          // ROUND-58 (R58-cf): leaving before the intent fires cancels it;
          // ROUND-51 (R51-c): the 220ms grace timer lets the pointer cross
          // the gap into an OPEN popover without snapping it shut.
          // R100-D: the hover WASH is the CSS class above; these handlers
          // carry ONLY the open/close intent (the behavior-freeze exception
          // — they drive component state, not styles).
          cancelOpenIntent();
          scheduleClose();
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
                ) : built !== null && built.overview !== undefined && built.contextBar !== undefined ? (
                  <>
                    {/* ── R99-D: THE OVERVIEW HERO — the card's head, NO section
                        header (it IS the top). The BIG TOKEN LINE is the
                        primary read ("40k of 200k", 19px semibold
                        tabular-nums); ONE % meta line under it, percentage
                        first ("~20% projected" — ONE source of truth per
                        number: the ring lost its center %); the honesty
                        lines collapse into ≤3 label:value pairs; the
                        compaction/reserve stays ONE line; the compacted
                        badge rides the header row's right side. The ring
                        stays the left visual anchor (46px, the graded color,
                        the budget tick). */}
                    <section data-context-overview className="pb-2.5">
                      <div className="flex items-start gap-3">
                        <DonutRing
                          size={46}
                          stroke={5}
                          used={built.overview.used}
                          limit={built.overview.limit}
                          color={ringColor}
                          track={styles.subtle}
                          markerFrac={built.overview.markerFrac}
                        />
                        <div className="min-w-0 flex-1">
                          {/* The big number line + the compacted badge. */}
                          <div className="flex min-w-0 items-baseline gap-1.5">
                            <span
                              data-context-bigused
                              // R100-D: 19px → the ladder's `value` tier (22px/600
                              // tabular — display sizes are wizard-only).
                              className="font-mono text-[22px] font-semibold leading-none tabular-nums"
                              style={{ color: styles.text }}
                            >
                              {built.overview.bigUsed}
                            </span>
                            <span
                              className="shrink-0 text-[11px] tabular-nums"
                              style={{ color: styles.textTertiary }}
                            >
                              {" "}
                              of {built.overview.bigLimit}
                            </span>
                            {built.overview.compactedBadge !== undefined ? (
                              <span
                                data-context-compaction
                                className="ml-auto flex min-w-0 items-baseline gap-1.5"
                                title={`${built.overview.compactedBadge.label} · ${built.overview.compactedBadge.detail}`}
                              >
                                <span className="shrink-0 text-[10px] font-medium" style={{ color: styles.accent }}>
                                  {built.overview.compactedBadge.label}
                                </span>
                                <span
                                  className="truncate font-mono text-[10px] tabular-nums"
                                  style={{ color: styles.textTertiary }}
                                >
                                  {built.overview.compactedBadge.detail}
                                </span>
                              </span>
                            ) : null}
                          </div>
                          {/* The ONE % meta line — percentage FIRST (users
                              think in %); the R83 tilde says PROJECTED. */}
                          <div
                            data-context-pctline
                            className="mt-1 font-mono text-[12px] font-semibold tabular-nums"
                            style={{ color: styles.text }}
                          >
                            {built.overview.pctLine}
                          </div>
                          {/* The honesty block — ≤3 label:value pairs at
                              10px (measured at last request / model / the
                              window's provenance). */}
                          <div className="mt-1.5 flex flex-col gap-[3px]">
                            {built.overview.meta.map((pair) => (
                              <div
                                key={pair.id ?? pair.label}
                                {...(pair.id === "measured" ? { "data-context-measured": true } : {})}
                                {...(pair.id === "window" ? { "data-context-window-source": true } : {})}
                                className="flex min-w-0 items-baseline gap-1.5"
                                title={pair.title}
                              >
                                <span className="shrink-0 text-[10px]" style={{ color: styles.textTertiary }}>
                                  {pair.label}
                                </span>
                                <span
                                  className="truncate font-mono text-[10px] tabular-nums"
                                  style={{ color: styles.textSecondary }}
                                >
                                  {pair.value}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                      {/* The compaction/reserve line — ONE line (the tick on
                          the ring + this line agree). */}
                      {built.overview.budgetLine !== undefined ? (
                        <div
                          data-context-budget
                          className="mt-1.5 font-mono text-[10px] tabular-nums"
                          style={{ color: styles.textTertiary }}
                        >
                          {built.overview.budgetLine}
                        </div>
                      ) : null}
                    </section>
                    {/* ── the WINDOW COMPOSITION pane — the stacked bar moved UP
                        to sit directly under the overview's big numbers (the
                        visual bridge between "how full" and "what's inside"),
                        full width with per-segment % labels, and the LEGEND
                        under it REPLACES the old Breakdown section (the
                        mini-bars retired — the bar already encodes the
                        proportion). */}
                    <Pane label="Window composition">
                      <ContextBar bar={built.contextBar} hoverSeg={hoverSeg} onHover={setHoverSeg} />
                      <div
                        className="mt-1.5 flex justify-end font-mono text-[10px] uppercase tracking-[0.08em]"
                        style={{ color: styles.textTertiary }}
                      >
                        tokens · % of used
                      </div>
                      <div className="mt-0.5 flex flex-col gap-[3px]">
                        {built.contextBar.segments.map((seg) => (
                          <LegendRow
                            key={seg.label}
                            seg={seg}
                            lit={hoverSeg === seg.label}
                            dimmed={hoverSeg !== null && hoverSeg !== seg.label}
                            onHover={setHoverSeg}
                            onNavigate={goManage}
                          />
                        ))}
                      </div>
                    </Pane>
                    {/* ── the CACHE pane — ONE quiet row (hit-rate bar + the
                        cached/total right-aligned, tabular-nums). */}
                    {cacheLine !== null ? (
                      <Pane label="Cache">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="shrink-0 text-[11px]" style={{ color: styles.textSecondary }}>
                            {cacheLine.label}
                          </span>
                          {cacheLine.barFrac !== undefined && cacheLine.barColor !== undefined ? (
                            <div
                              className="h-[3px] w-12 shrink-0 overflow-hidden rounded-full"
                              style={{ background: styles.subtle }}
                            >
                              <div
                                className="h-full rounded-full"
                                style={{
                                  width: `${Math.max(2, Math.min(100, cacheLine.barFrac * 100))}%`,
                                  background: usageSegmentHex(cacheLine.barColor, styles.isDark, styles.accent),
                                }}
                              />
                            </div>
                          ) : null}
                          <span
                            className="ml-auto truncate font-mono text-[10px] tabular-nums"
                            style={{ color: styles.text }}
                          >
                            {cacheLine.value}
                          </span>
                        </div>
                      </Pane>
                    ) : null}
                    {/* ── the SESSION pane — the TABLE on BOTH legs (one
                        spelling; the pre-R98 stacked UsageGroup rows are
                        dead). Owner R51: separate BUT also combined. */}
                    {sessionTable !== null ? (
                      <div data-session-totals>
                        <Pane label="Session totals">
                          <UsageTable table={sessionTable} />
                        </Pane>
                      </div>
                    ) : null}
                  </>
                ) : null}
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
