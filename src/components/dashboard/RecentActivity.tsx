import { motion } from "framer-motion";
import { useState } from "react";
import type { Agent, Session } from "../../lib/api";
import type { ThemeStyles } from "../../lib/themes";
import { staggerContainer, staggerItem } from "../../lib/motion";
import { formatWhen } from "../../lib/format";
import { SEMANTIC_COLORS } from "../../lib/semantics";

/**
 * Recent activity (round-21 wizard DNA): 16px-radius row cards with
 * border, softShadow on the section container, uppercase tracked label,
 * w-7 h-7 letter tiles, 13px/11px text (never 9px).
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
  const { card, text, textSecondary, textTertiary, border, subtleHover, softShadow } = styles;
  const [hovered, setHovered] = useState(false);
  const initial = (agentName || session.title || "?").charAt(0).toUpperCase();

  return (
    <motion.button
      variants={staggerItem}
      onClick={onOpen}
      aria-label={`Open session ${session.title ?? agentName}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="w-full cursor-pointer rounded-[16px] border-[1.5px] p-3.5 text-left transition-all duration-200"
      style={{
        backgroundColor: hovered ? subtleHover : card,
        borderColor: border,
        boxShadow: hovered ? softShadow : "none",
        transform: hovered ? "translateY(-1px)" : "translateY(0)",
      }}
    >
      <div className="flex items-center gap-3">
        <span
          className="w-7 h-7 shrink-0 rounded-[8px] grid place-items-center font-black text-[11px]"
          style={{ background: styles.accent, color: styles.accentText }}
        >
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-bold" style={{ color: text }}>
            {session.title ?? "Untitled session"}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="font-semibold" style={{ color: textSecondary }}>
              {agentName}
            </span>
            <span style={{ color: textTertiary }}>·</span>
            <span style={{ color: textTertiary }}>{formatWhen(session.updatedAt)}</span>
            <span style={{ color: textTertiary }}>·</span>
            <span
              className="font-mono uppercase tracking-wide"
              style={{
                color: session.status === "failed" ? SEMANTIC_COLORS.danger : textTertiary,
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
  const { textSecondary, textTertiary } = styles;
  const recent = sessions.slice(0, 6);

  return (
    <section aria-label="Recent activity" className="min-h-[120px]">
      <div className="mb-3 flex items-center justify-between">
        <h2
          className="text-[11px] font-bold uppercase tracking-widest"
          style={{ color: textTertiary }}
        >
          Recent Activity
        </h2>
        <span
          className="px-2 py-0.5 rounded-full text-[10px] font-bold"
          style={{ background: styles.subtle, color: textTertiary }}
        >
          Across all agents
        </span>
      </div>
      {recent.length === 0 ? (
        <p className="py-6 text-center text-[12px] font-medium" style={{ color: textSecondary }}>
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
