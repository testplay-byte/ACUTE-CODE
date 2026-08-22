import { motion } from "framer-motion";
import type { Agent, Session } from "../../lib/api";
import type { ThemeStyles } from "../../lib/themes";
import { staggerContainer, staggerItem } from "../../lib/motion";
import { formatWhen } from "../../lib/format";
import { bdr, chipColor, initialOf, withAlpha } from "./helpers";

/**
 * Recent activity ported from the dashboard demo (RecentActivity.tsx): the
 * newest sessions across the workspace as compact letter-chip rows that jump
 * to the Sessions screen. The demo's scroll-to-reveal is dropped — this page
 * is short enough to show everything immediately.
 */
function RecentSessionRow({
  session,
  agentName,
  onOpen,
  styles,
}: {
  session: Session;
  agentName: string;
  onOpen: () => void;
  styles: ThemeStyles;
}) {
  const { text, textSecondary, border, isDark } = styles;
  const color = chipColor(session.agentId ?? session.id);
  return (
    <motion.button
      variants={staggerItem}
      onClick={onOpen}
      aria-label={`Open session ${session.title ?? agentName}`}
      className="w-full cursor-pointer rounded-lg p-3 text-left transition-all duration-200 hover:-translate-y-px"
      style={{ border: bdr("1.5px", border) }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = isDark
          ? "rgba(255,255,255,0.02)"
          : "rgba(0,0,0,0.01)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      <div className="flex items-start gap-2.5">
        <div
          className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[9px] font-bold text-white"
          style={{ backgroundColor: withAlpha(color, 0.73) }}
        >
          {initialOf(agentName || (session.title ?? "?"))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold" style={{ color: text }}>
            {session.title ?? "Untitled session"}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[9px]">
            <span className="font-semibold" style={{ color: withAlpha(color, 0.8) }}>
              {agentName}
            </span>
            <span style={{ color: border }}>·</span>
            <span style={{ color: textSecondary }}>{formatWhen(session.updatedAt)}</span>
            <span style={{ color: border }}>·</span>
            <span
              className="font-mono uppercase tracking-wide"
              style={{
                color: session.status === "failed" ? "#ef4444" : textSecondary,
              }}
            >
              {session.status}
            </span>
          </div>
        </div>
      </div>
    </motion.button>
  );
}

export function RecentActivity({
  sessions,
  agentById,
  onOpenSession,
  styles,
}: {
  sessions: Session[];
  agentById: Map<string, Agent>;
  onOpenSession: (id: string) => void;
  styles: ThemeStyles;
}) {
  const { text, textSecondary } = styles;
  const recent = sessions.slice(0, 6);

  return (
    <section aria-label="Recent activity" className="min-h-[120px]">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-bold" style={{ color: text }}>
          Recent Activity
        </h2>
        <span className="text-[10px] font-medium" style={{ color: textSecondary }}>
          Across all agents
        </span>
      </div>
      {recent.length === 0 ? (
        <p className="py-6 text-center text-[11px]" style={{ color: textSecondary }}>
          No sessions yet — start one from Quick Actions.
        </p>
      ) : (
        <motion.div
          variants={staggerContainer}
          initial="initial"
          animate="animate"
          className="grid gap-2"
        >
          {recent.map((session) => (
            <RecentSessionRow
              key={session.id}
              session={session}
              agentName={agentById.get(session.agentId ?? "")?.name ?? session.agentId ?? "no agent"}
              onOpen={() => onOpenSession(session.id)}
              styles={styles}
            />
          ))}
        </motion.div>
      )}
    </section>
  );
}
