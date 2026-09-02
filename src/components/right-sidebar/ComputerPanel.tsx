import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  Clock,
  Eye,
  LoaderCircle,
  Monitor,
  MousePointerClick,
  PictureInPicture2,
  Play,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Square,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  fetchComputerUseConfig,
  fetchComputerUseSession,
  stopComputerUse,
} from "../../lib/api";
import {
  useComputerMonitorStore,
  type ComputerMonitorEvent,
} from "../../lib/computer-monitor-store";
import { formatWhen } from "../../lib/format";
import type { RightSidebarTab } from "../../lib/right-sidebar-store";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { ease } from "../../lib/motion";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { useScrollFade } from "../../lib/useScrollFade";
import { withAlpha } from "../dashboard/helpers";
import { ClampedText } from "../shared/ClampedText";

/**
 * ROUND-61 (R61-2-b) right-sidebar COMPUTER tab — the full monitor for the
 * computer-use system (owner directive: while the agent uses the computer,
 * "in a mini window it will show the details and their stats — what it's
 * about to do, how it's thinking, the progress"; THIS panel is the same
 * feed with room to breathe: the whole ring, the stats, the kill switch).
 *
 * DATA (both halves already merged in useComputerMonitorStore):
 *   - LIVE SSE frames — every computer-use tool execution pushes an event
 *     at dispatch time (the stream-store intercept), so the feed updates
 *     mid-turn with zero polling latency;
 *   - POLLED session truth — GET /computer-use/session (the sidecar's
 *     authoritative ring + stats + kill-switch state) every 2s while a
 *     control session is active or live frames are arriving, else a cheap
 *     10s idle poll. Each poll lands in the store via refreshFromServer.
 *
 * The panel is a VIEW over that store: header status chip (OFF / STOPPED /
 * LIVE / Idle), the 4 stat cells + the elapsed clock, the newest-first
 * event feed (kind icon, label, tool chip, refusal code), and the footer's
 * STOP kill switch (POST /computer-use/stop) + the pop-out button that
 * floats the draggable mini window (ComputerMiniWindow).
 */

/** Kind icon + color — documented exception like MemoryPanel's KIND_COLORS:
 * they carry kind meaning across every theme/mode (observation = green,
 * the agent looked; action = amber, it moved the mouse/keyboard; refusal =
 * red, host policy said no; vision = purple, the vision model spoke;
 * session start/stop = data blue / muted). */
const KIND_META: Record<string, { icon: LucideIcon; color: string }> = {
  observation: { icon: Eye, color: SEMANTIC_COLORS.success },
  action: { icon: MousePointerClick, color: "#f9a825" },
  refusal: { icon: ShieldAlert, color: SEMANTIC_COLORS.danger },
  vision: { icon: Sparkles, color: "#c792ea" },
  session_start: { icon: Play, color: "#82aaff" },
  session_stop: { icon: Square, color: "#788494" },
};

/** Muted slate for zero-valued / neutral stat cells (hex so withAlpha works). */
const NEUTRAL = "#788494";

/** The STOP reason recorded server-side on the kill switch (honest provenance). */
const STOP_REASON = "stopped by the owner from the monitor panel";

/** "2m 14s" style elapsed — the session clock under the stat cells. */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m < 60) return `${m}m ${String(sec).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** The ticking "now" for the elapsed clock — 1s while the session is active,
 * frozen otherwise (the R48-e2 lesson: a live clock only while there's
 * motion, never a dead one). */
function useNowMs(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [active]);
  return nowMs;
}

export function ComputerPanel({ projectId, tab }: { projectId: string; tab: RightSidebarTab }) {
  const styles = useThemeStyles();
  const queryClient = useQueryClient();

  // The merged monitor state (live SSE frames + the polled session truth).
  const events = useComputerMonitorStore((s) => s.events);
  const session = useComputerMonitorStore((s) => s.session);
  const liveActivity = useComputerMonitorStore((s) => s.liveActivity);
  const miniWindowOpen = useComputerMonitorStore((s) => s.miniWindowOpen);
  const setMiniWindowOpen = useComputerMonitorStore((s) => s.setMiniWindowOpen);

  const sessionActive = session?.active ?? false;
  const killSwitch = session?.killSwitch ?? false;
  const nowMs = useNowMs(sessionActive);

  // The polled session truth — 2s while active (or live frames are landing),
  // else a cheap 10s idle poll. Each success lands in the monitor store so
  // the mini window (and any future surface) sees the same truth.
  const pollMs = sessionActive || liveActivity ? 2_000 : 10_000;
  const sessionQuery = useQuery({
    queryKey: ["computer-use-session", projectId],
    queryFn: async () => {
      try {
        const state = await fetchComputerUseSession();
        useComputerMonitorStore.getState().refreshFromServer(state);
        return state;
      } catch (err) {
        useComputerMonitorStore
          .getState()
          .setError(err instanceof Error ? err.message : "The sidecar didn't answer.");
        throw err;
      }
    },
    staleTime: 1_500,
    refetchInterval: pollMs,
  });

  // Config (Settings → Computer Use): the master switch drives the OFF chip.
  const configQuery = useQuery({
    queryKey: ["computer-use-config", projectId],
    queryFn: fetchComputerUseConfig,
    staleTime: 30_000,
  });
  const computerOff = configQuery.data?.settings.enabled === false;

  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollFade(scrollRef);

  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const doStop = async () => {
    if (stopping) return;
    setStopping(true);
    setStopError(null);
    try {
      await stopComputerUse(STOP_REASON);
      // Pull the post-stop truth (kill switch engaged + final stats) in.
      await queryClient.invalidateQueries({ queryKey: ["computer-use-session"] });
    } catch (err) {
      setStopError(err instanceof Error ? err.message : "Stop failed");
    } finally {
      setStopping(false);
    }
  };

  // Status chip priority: the master switch wins (nothing can be live while
  // it's off), then the kill switch, then live activity, else Idle.
  const chipStatus: "off" | "stopped" | "live" | "idle" = computerOff
    ? "off"
    : killSwitch
      ? "stopped"
      : sessionActive || liveActivity
        ? "live"
        : "idle";

  const loading =
    sessionQuery.isPending && session === null && events.length === 0;

  return (
    <div className="h-full flex flex-col min-h-0" data-testid="computer-panel" data-tab-id={tab.id}>
      {/* ── Panel header: icon + title + status chip ── */}
      <div
        className="shrink-0 flex items-center gap-2 px-3 h-9 border-b"
        style={{ borderColor: styles.border, background: styles.isDark ? "rgba(0,0,0,0.18)" : styles.subtle }}
      >
        <Monitor size={13} style={{ color: styles.accent }} className="shrink-0" />
        <div className="flex-1 min-w-0 truncate text-[11.5px] font-semibold" style={{ color: styles.text }}>
          Computer use
        </div>
        <StatusChip status={chipStatus} styles={styles} />
      </div>

      {/* ── OFF notice: the master switch is off (Settings → Computer Use) ── */}
      {computerOff ? (
        <div
          className="shrink-0 px-3 py-2 border-b flex items-center gap-2"
          style={{ borderColor: styles.border, background: withAlpha("#f9a825", 0.08) }}
          data-testid="computer-off-notice"
        >
          <Zap size={12} style={{ color: "#f9a825" }} className="shrink-0" />
          <span className="text-[10.5px]" style={{ color: styles.textSecondary }}>
            Computer use is <strong>turned off</strong> — the agent cannot control the desktop
            and the computer-use tools are unavailable. Enable it in Settings → Computer Use.
          </span>
        </div>
      ) : null}

      {/* ── Honest error card (poll failure) — the feed below keeps whatever
          truth the store already holds, so live frames never vanish ── */}
      {sessionQuery.isError ? (
        <div className="shrink-0 px-2.5 pt-2.5" data-testid="computer-error-card">
          <div
            className="rounded-[12px] px-3 py-3 flex flex-col gap-2"
            style={{
              background: withAlpha(SEMANTIC_COLORS.danger, 0.08),
              border: `1px solid ${withAlpha(SEMANTIC_COLORS.danger, 0.3)}`,
            }}
          >
            <div className="flex items-center gap-1.5 text-[11px] font-bold" style={{ color: SEMANTIC_COLORS.danger }}>
              Couldn&apos;t load the computer session
            </div>
            <div className="text-[10.5px]" style={{ color: styles.textSecondary }}>
              {sessionQuery.error instanceof Error ? sessionQuery.error.message : "The sidecar didn't answer."}
            </div>
            <button
              onClick={() => void sessionQuery.refetch()}
              className="self-start h-6 px-2.5 rounded-full text-[10px] font-bold inline-flex items-center gap-1.5"
              style={{ background: styles.card, color: styles.text, border: `1px solid ${styles.border}` }}
            >
              <RefreshCw size={10} /> Try again
            </button>
          </div>
        </div>
      ) : null}

      {/* ── Stats row: 4 cells + the elapsed clock + backend ── */}
      {session !== null ? (
        <div className="shrink-0 px-2.5 pt-2.5" data-testid="computer-stats">
          <div
            className="rounded-[12px] px-2.5 py-2 flex flex-col gap-1.5"
            style={{
              background: styles.isDark ? "rgba(0,0,0,0.14)" : styles.card,
              border: `1px solid ${styles.border}`,
            }}
          >
            <div className="grid grid-cols-4 gap-1.5">
              <StatCell
                label="Actions sent"
                value={session.stats.actionsSent}
                color={SEMANTIC_COLORS.success}
                title="Actions sent to the host"
              />
              <StatCell
                label="Refused"
                value={session.stats.actionsRefused}
                color={session.stats.actionsRefused > 0 ? SEMANTIC_COLORS.danger : NEUTRAL}
                title="Actions refused by host policy"
              />
              <StatCell
                label="Observations"
                value={session.stats.observations}
                color={styles.text}
                title="Observations captured"
              />
              <StatCell
                label="Vision calls"
                value={session.stats.visionCalls}
                color="#c792ea"
                title="Vision-model calls"
              />
            </div>
            <div
              className="flex items-center gap-2 pt-1.5 text-[9.5px]"
              style={{ borderTop: `1px solid ${styles.border}`, color: styles.textTertiary }}
            >
              <Clock size={9} className="shrink-0" />
              <span className="font-mono tabular-nums shrink-0" data-testid="computer-elapsed">
                {session.startedAt !== null
                  ? `Elapsed ${fmtElapsed(Math.max(0, nowMs - session.startedAt))}`
                  : "Not started"}
              </span>
              <span className="flex-1" />
              <span className="font-mono truncate" title={`Backend: ${session.backendKind}`}>
                {session.backendKind}
              </span>
            </div>
            {session.stopReason !== null ? (
              <div className="text-[9.5px] truncate" style={{ color: styles.textTertiary }} title={session.stopReason}>
                Stopped: {session.stopReason}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* ── Event feed: the merged ring, newest first ── */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto auto-scroll">
        {loading ? (
          <div className="py-10 flex flex-col items-center gap-2" style={{ color: styles.textTertiary }}>
            <LoaderCircle size={16} className="animate-spin" style={{ color: styles.accent }} />
            <span className="text-[11px]">Loading computer session…</span>
          </div>
        ) : events.length === 0 ? (
          <div className="h-full grid place-items-center px-6 text-center">
            <div className="max-w-[240px]">
              <div
                className="w-11 h-11 mx-auto mb-3 grid place-items-center rounded-2xl border-2 border-dashed"
                style={{ borderColor: styles.border, color: styles.textTertiary }}
              >
                <Monitor size={18} />
              </div>
              <div className="text-[12px] font-medium" style={{ color: styles.textSecondary }}>
                No computer activity yet
              </div>
              <div className="text-[11px] mt-1.5 leading-[1.55]" style={{ color: styles.textTertiary }}>
                When the agent drives the desktop — screenshots, clicks, refusals, vision
                calls — every step streams in here live.
              </div>
            </div>
          </div>
        ) : (
          <div className="px-2.5 py-2.5 flex flex-col gap-1.5">
            <AnimatePresence initial={false}>
              {events.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* ── Footer: the STOP kill switch + pop-out + hint ── */}
      <div
        className="shrink-0 border-t flex flex-col"
        style={{ borderColor: styles.border, background: styles.isDark ? "rgba(0,0,0,0.18)" : styles.subtle }}
      >
        {stopError !== null ? (
          <div
            className="px-2.5 pt-2 text-[10.5px]"
            style={{ color: SEMANTIC_COLORS.danger }}
            role="alert"
          >
            {stopError}
          </div>
        ) : null}
        <div className="flex items-center gap-2 px-2.5 py-2">
          {killSwitch ? (
            <button
              disabled
              data-testid="computer-stopped-button"
              title={`Kill switch active${session !== null && session.stopReason !== null ? ` — ${session.stopReason}` : ""}`}
              className="flex-1 h-8 rounded-[10px] inline-flex items-center justify-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wider cursor-default"
              style={{
                color: styles.textTertiary,
                background: withAlpha(NEUTRAL, 0.1),
                border: `1px solid ${styles.border}`,
              }}
            >
              <Square size={11} /> Stopped
            </button>
          ) : sessionActive ? (
            <button
              onClick={() => void doStop()}
              disabled={stopping}
              data-testid="computer-stop-button"
              title="Kill switch — stop the agent's computer control now"
              className="flex-1 h-8 rounded-[10px] inline-flex items-center justify-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wider transition-colors disabled:opacity-70"
              style={{
                color: SEMANTIC_COLORS.danger,
                background: withAlpha(SEMANTIC_COLORS.danger, 0.1),
                border: `1px solid ${withAlpha(SEMANTIC_COLORS.danger, 0.4)}`,
              }}
            >
              {stopping ? <LoaderCircle size={11} className="animate-spin" /> : <Square size={11} fill="currentColor" strokeWidth={0} />}
              {stopping ? "Stopping…" : "STOP computer control"}
            </button>
          ) : null}
          <button
            onClick={() => setMiniWindowOpen(true)}
            data-testid="computer-popout-button"
            aria-label="Pop out the floating mini window"
            title={miniWindowOpen ? "The mini window is open" : "Pop out the floating mini window"}
            className="shrink-0 w-8 h-8 grid place-items-center rounded-[10px] transition-colors"
            style={{
              color: miniWindowOpen ? styles.accent : styles.textTertiary,
              background: miniWindowOpen ? withAlpha(styles.accent, 0.12) : "transparent",
              border: `1px solid ${miniWindowOpen ? withAlpha(styles.accent, 0.35) : styles.border}`,
            }}
          >
            <PictureInPicture2 size={13} />
          </button>
        </div>
        <div
          className="flex items-center gap-1.5 px-3 h-7 text-[9.5px]"
          style={{ color: styles.textTertiary }}
        >
          <Zap size={10} style={{ color: styles.accent }} className="shrink-0" />
          <span className="truncate">Live events stream in while the agent uses the desktop.</span>
        </div>
      </div>
    </div>
  );
}

/** The coherent header status chip — OFF (muted) / STOPPED (red) / LIVE
 * (green pulsing dot) / Idle (muted clock). */
function StatusChip({
  status,
  styles,
}: {
  status: "off" | "stopped" | "live" | "idle";
  styles: ReturnType<typeof useThemeStyles>;
}) {
  const tone =
    status === "stopped"
      ? SEMANTIC_COLORS.danger
      : status === "live"
        ? SEMANTIC_COLORS.success
        : styles.textTertiary;
  const label = status === "off" ? "OFF" : status === "stopped" ? "STOPPED" : status === "live" ? "LIVE" : "Idle";
  return (
    <span
      className="shrink-0 flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[9.5px] font-bold uppercase tracking-wider"
      style={{ background: withAlpha(tone, 0.14), color: tone }}
      data-testid="computer-status-chip"
    >
      {status === "live" ? (
        <PulsingDot color={tone} size={5} />
      ) : status === "stopped" ? (
        <Square size={9} />
      ) : (
        <Clock size={9} />
      )}
      {label}
    </span>
  );
}

/** One stat cell: the count (mono, kind-colored) + the tiny label. */
function StatCell({ label, value, color, title }: { label: string; value: number; color: string; title: string }) {
  const styles = useThemeStyles();
  return (
    <div
      className="flex flex-col items-center gap-0.5 min-w-0 px-1 py-1 rounded-lg"
      style={{ background: withAlpha(color, 0.08) }}
      title={title}
    >
      <span className="text-[13px] font-bold font-mono leading-none tabular-nums" style={{ color }}>
        {value}
      </span>
      <span
        className="text-[8px] font-bold uppercase tracking-wide text-center leading-[1.3]"
        style={{ color: styles.textTertiary }}
      >
        {label}
      </span>
    </div>
  );
}

/** One feed row: kind icon + label (clamped) + relative ts; the meta row
 * below carries the mono tool chip and, for refusals, the error-code chip. */
function EventRow({ event }: { event: ComputerMonitorEvent }) {
  const styles = useThemeStyles();
  const meta = KIND_META[event.kind];
  const Icon = meta?.icon ?? Activity;
  const color = meta?.color ?? styles.textTertiary;
  const iso = new Date(event.ts).toISOString();
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -3 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.14, ease }}
      className="rounded-[10px] px-2.5 py-1.5 flex flex-col gap-1"
      style={{
        background: styles.isDark ? "rgba(0,0,0,0.14)" : styles.card,
        border: `1px solid ${styles.border}`,
      }}
      data-testid="computer-event-row"
      data-kind={event.kind}
    >
      <div className="flex items-start gap-2">
        <Icon size={12} style={{ color }} className="shrink-0 mt-[3px]" />
        <ClampedText
          text={event.label}
          lines={1}
          className="flex-1 min-w-0 text-[11px] leading-[1.45] break-words"
          style={{ color: styles.text }}
        />
        <span
          className="shrink-0 text-[9px] mt-0.5 tabular-nums"
          style={{ color: styles.textTertiary }}
          title={iso}
        >
          {formatWhen(iso)}
        </span>
      </div>
      {event.tool !== undefined || event.code !== undefined ? (
        <div className="flex items-center gap-1.5 pl-[20px] flex-wrap">
          {event.tool !== undefined ? (
            <span
              className="text-[9px] font-mono px-1.5 py-0.5 rounded-md"
              style={{ color: styles.textSecondary, background: withAlpha(NEUTRAL, 0.12) }}
            >
              {event.tool}
            </span>
          ) : null}
          {event.code !== undefined ? (
            <span
              className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-md"
              data-testid="computer-refusal-code"
              style={{ color: SEMANTIC_COLORS.danger, background: withAlpha(SEMANTIC_COLORS.danger, 0.12) }}
            >
              {event.code}
            </span>
          ) : null}
        </div>
      ) : null}
    </motion.div>
  );
}

/** Shared pulsing status dot (the LIVE chip's heartbeat). */
function PulsingDot({ color, size = 6 }: { color: string; size?: number }) {
  return (
    <motion.span
      className="inline-block rounded-full shrink-0"
      style={{ width: size, height: size, background: color }}
      animate={{ scale: [1, 1.45, 1], opacity: [1, 0.5, 1] }}
      transition={{ repeat: Infinity, duration: 1.6, ease: "easeInOut" }}
      aria-hidden
    />
  );
}
