import type { Agent, Session } from "../../lib/api";
import { formatWhen } from "../../lib/format";
import { Kicker } from "../ui/Kicker";
import { SectionCard } from "../ui/SectionCard";
import { chipColor, initialOf } from "./helpers";

/**
 * Recent activity — R126-3a (the Instrument archetype): the section rides
 * `ui/SectionCard` with the CLAY material (1px warm rim + `.ac-clay` —
 * TOKENS §5/§9), and the sessions list INSIDE the card is flat rows split
 * by 1px inset hairlines (`divide-y divide-line`) — the well-recess grammar
 * per row was overkill inside an already-elevated card (SCREENS §3: plain
 * rows with dividers). Row hover = the `hover:bg-hover` wash (a CSS class —
 * TOKENS §6; no lift, no bloom).
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
  onOpen,
}: {
  session: Session;
  agentName: string;
  onOpen: () => void;
}) {
  const initial = initialOf(agentName || session.title || "?");
  // The tile's hue identity keys on the AGENT (same agent = same color on
  // every row; sessions without an agent fall back to their own id).
  const tileHue = chipColor(session.agentId ?? session.id);

  return (
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
  );
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
  const recent = sessions.slice(0, 6);

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
        <div className="divide-y divide-line">
          {recent.map((session) => (
            <RecentSessionRow
              key={session.id}
              session={session}
              agentName={agentById.get(session.agentId ?? "")?.name ?? session.agentId ?? "no agent"}
              onOpen={() => onOpenSession(session.id)}
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}
