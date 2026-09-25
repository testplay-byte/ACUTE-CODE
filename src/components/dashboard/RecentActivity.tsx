import type { Agent, Session } from "../../lib/api";
import { formatWhen } from "../../lib/format";
import type { ThemeStyles } from "../../lib/themes";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { Kicker } from "../ui/Kicker";
import { SectionCard } from "../ui/SectionCard";
import { chipColor, initialOf, timelineDayLabel, utcDayKeyOf, withAlpha } from "./helpers";

/**
 * Recent activity — R126-3a (the Instrument archetype) → R127-W3 (SCREENS §3,
 * THE DASHBOARD BOLDNESS LAW): the section rides `ui/SectionCard` with the
 * CLAY material (1px warm rim + `.ac-clay` — TOKENS §5/§9), and the sessions
 * list INSIDE the card is now a vertical TIMELINE — the owner's "bubbles +
 * timelines" ask, minimal (NO new cards, NO new hues — the boldness is scale
 * + spacing + rhythm):
 *
 * · THE SPINE: a 2px `w-0.5` accent thread at 20% alpha
 *   (`withAlpha(styles.accent, 0.2)` — ONE spelling) running the list's full
 *   height on the left. It is the section's one structural gesture.
 * · THE NODES: each session row hangs off the spine with an 8px (`h-2 w-2`)
 *   circle glyph at the spine — clay-rim fill by default (`styles.clayRim`),
 *   accentDeep for TODAY's rows (the "now" end of the thread ratchets).
 * · DAY DIVIDERS: rows group by UTC day (`utcDayKeyOf`); a Kicker-tier
 *   11px-caps-tertiary label ("TODAY" / "YESTERDAY" / the short UTC date via
 *   `timelineDayLabel`) sits ON the spine with a card-surface patch behind
 *   it — the label itself is the break in the spine at each day boundary.
 * · ROWS: the R126 flat hairline-divided list rows (`divide-y divide-line`,
 *   `hover:bg-hover` wash — TOKENS §6; no lift, no bloom) restructured to sit
 *   on the spine (`pl-6` body, node absolutely positioned at `left-0`). The
 *   row content — letter tile, title/agent/meta, status badge — is the R126
 *   contract verbatim (same aria, same tones).
 *
 * · Letter tiles: the ProjectTile grammar (the sidebar's inline spelling,
 *   copied locally — never imported from shell/Sidebar): the rounded-square
 *   identity mark, FLAT deterministic hue (helpers' chipColor, keyed on the
 *   agent id — same agent, same color) + the clay small shadow for its edge,
 *   white initial.
 * · The metadata line rides `text-muted` (the 0.62 secondary step of the
 *   R126 ink ladder — the VLM flagged the old tertiary-tier metadata as
 *   low-contrast; TOKENS §1a) and clamps to ONE line (the copy-length law).
 * · Status: the BADGE TONE containers (TOKENS §11 — never flat-hue text,
 *   never white-on-saturated): running/queued/completed/failed/cancelled
 *   map to the running/warning/success/danger/neutral tinted pairs.
 */
const STATUS_TONE: Record<Session["status"], string> = {
  queued: "bg-badge-warning text-badge-warning-fg",
  running: "bg-badge-running text-badge-running-fg",
  completed: "bg-badge-success text-badge-success-fg",
  failed: "bg-badge-danger text-badge-danger-fg",
  cancelled: "bg-badge-neutral text-badge-neutral-fg",
};

function RecentSessionRow({
  session,
  agentName,
  isToday,
  styles,
  onOpen,
}: {
  session: Session;
  agentName: string;
  /** R127: TODAY's rows carry the accentDeep node on the spine. */
  isToday: boolean;
  styles: ThemeStyles;
  onOpen: () => void;
}) {
  const initial = initialOf(agentName || session.title || "?");
  // The tile's hue identity keys on the AGENT (same agent = same color on
  // every row; sessions without an agent fall back to their own id).
  const tileHue = chipColor(session.agentId ?? session.id);

  return (
    <div className="relative pl-6">
      {/* R127 (SCREENS §3): the node glyph on the spine — an 8px circle at
          left-0 (centered on the spine's x), clay-rim fill; TODAY's rows
          ratchet to accentDeep. */}
      <span
        aria-hidden
        data-timeline-node={isToday ? "today" : "day"}
        className="absolute left-0 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full"
        style={{ backgroundColor: isToday ? styles.accentDeep : styles.clayRim }}
      />
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open session ${session.title ?? agentName}`}
        className="flex w-full cursor-pointer items-center gap-3 py-3 text-left transition-colors duration-100 hover:bg-hover"
      >
        {/* The ProjectTile grammar, local copy — 24px + rounded-lg (8px, ≈33%
            radius: the PC identity-mark tier the sidebar's project tiles ride)
            + the flat hue + the clay small shadow for its edge. */}
        <span
          aria-hidden
          className="grid h-6 w-6 shrink-0 select-none place-items-center rounded-lg font-semibold text-white"
          style={{
            fontSize: 12,
            background: tileHue,
            boxShadow: "var(--ac-clay-shadow-sm)",
          }}
        >
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-ink">
            {session.title ?? "Untitled session"}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
            <span className="truncate font-medium">{agentName}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0 tabular-nums">{formatWhen(session.updatedAt)}</span>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide ${STATUS_TONE[session.status]}`}
            >
              {session.status}
            </span>
          </div>
        </div>
      </button>
    </div>
  );
}

/** One day's group on the timeline: the divider label + its hairline-divided
 *  rows (the sessions arrive newest-first, so groups walk backward in time). */
interface TimelineDayGroup {
  key: string;
  label: string;
  isToday: boolean;
  sessions: Session[];
}

export function RecentActivity({
  sessions,
  agentById,
  onOpenSession,
}: {
  sessions: Session[];
  agentById: Map<string, Agent>;
  onOpenSession: (id: string) => void;
}) {
  const styles = useThemeStyles();
  const recent = sessions.slice(0, 6);

  // R127: group the recent sessions by UTC day — the day boundary is where
  // the timeline's divider breaks the spine. `recent` is newest-first, so
  // same-day sessions merge into the trailing group.
  const todayKey = new Date().toISOString().slice(0, 10);
  const groups: TimelineDayGroup[] = [];
  for (const session of recent) {
    const dayKey = utcDayKeyOf(session.updatedAt);
    const trailing = groups[groups.length - 1];
    if (trailing !== undefined && trailing.key === dayKey) {
      trailing.sessions.push(session);
    } else {
      groups.push({
        key: dayKey,
        label: timelineDayLabel(dayKey),
        isToday: dayKey === todayKey,
        sessions: [session],
      });
    }
  }

  return (
    <SectionCard ariaLabel="Recent activity" className="border border-clay-rim ac-clay">
      <div className="mb-3 flex items-center justify-between">
        <Kicker as="h2">Recent Activity</Kicker>
        {/* The neutral badge tone (TOKENS §11) — surfaceWell container +
            secondary ink. */}
        <span className="rounded-full bg-badge-neutral px-2 py-0.5 text-[10px] font-medium text-badge-neutral-fg">
          Across all agents
        </span>
      </div>
      {recent.length === 0 ? (
        <p className="py-6 text-center text-[12px] text-muted">
          No sessions yet — start one from Quick Actions.
        </p>
      ) : (
        <div className="relative">
          {/* THE SPINE (R127): the 2px accent thread at 20% — the section's
              full height, rounded ends. One spelling: withAlpha on
              styles.accent (the sanctioned dynamic-tint path). */}
          <span
            aria-hidden
            data-timeline-spine="true"
            className="absolute bottom-2 left-[3px] top-1 w-0.5 rounded-full"
            style={{ backgroundColor: withAlpha(styles.accent, 0.2) }}
          />
          {groups.map((group) => (
            <div key={group.key}>
              {/* The day divider — the Kicker-tier label sits ON the spine
                  (a card-surface patch behind it), breaking the thread at
                  every day boundary. */}
              <div className="relative py-2 pl-6" data-timeline-day={group.key}>
                <Kicker className="absolute left-0 top-1/2 -translate-y-1/2 rounded bg-card px-1">
                  {group.label}
                </Kicker>
              </div>
              <div className="divide-y divide-line">
                {group.sessions.map((session) => (
                  <RecentSessionRow
                    key={session.id}
                    session={session}
                    agentName={agentById.get(session.agentId ?? "")?.name ?? session.agentId ?? "no agent"}
                    isToday={group.isToday}
                    styles={styles}
                    onOpen={() => onOpenSession(session.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
