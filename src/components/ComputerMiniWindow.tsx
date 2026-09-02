import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  Clock,
  Eye,
  GripHorizontal,
  LoaderCircle,
  Monitor,
  MousePointerClick,
  Play,
  ShieldAlert,
  Sparkles,
  Square,
  X,
  type LucideIcon,
} from "lucide-react";
import { fetchComputerUseSession, stopComputerUse } from "../lib/api";
import {
  useComputerMonitorStore,
  type ComputerMonitorEvent,
} from "../lib/computer-monitor-store";
import { formatWhen } from "../lib/format";
import { ease } from "../lib/motion";
import { SEMANTIC_COLORS } from "../lib/semantics";
import { useThemeStyles } from "../lib/use-theme-styles";
import { useScrollFade } from "../lib/useScrollFade";
import { withAlpha } from "./dashboard/helpers";
import { ClampedText } from "./shared/ClampedText";

/**
 * ROUND-61 (R61-2-b) the FLOATING COMPUTER MONITOR — the owner's centerpiece
 * ("while the agent is using the computer, in a mini window it will show
 * the details and their stats — what it's about to do, how it's thinking,
 * the progress").
 *
 * Mounted app-wide (no props): it renders only while
 * useComputerMonitorStore.miniWindowOpen, self-managing via the same merged
 * store the right-sidebar ComputerPanel reads — live SSE frames land
 * instantly (the stream-store intercept), the panel's polls keep the
 * session stats/kill-switch fresh, and a one-shot session fetch on open
 * covers the window opening with no panel behind it.
 *
 * A FIXED-position draggable card (w-[340px], z-[70]): the title bar is the
 * drag handle (pointer events, clamped to the viewport, position in local
 * component state initialized bottom-right — no persistence). The body
 * answers the owner's three questions in order — WHAT it's doing (the
 * newest event with the biggest weight + two older rows), HOW it's going
 * (stats strip + elapsed clock + the refusal/vision spotlights), and HOW
 * to stop it (the full-width STOP kill switch that locks into the honest
 * "Stopped — the kill switch is active" state).
 */

/** Kind icon + color — the same documented exception as the ComputerPanel's
 * KIND_META (kind meaning across every theme/mode); duplicated locally so
 * the always-mounted mini window stays independent of the panel module. */
const KIND_META: Record<string, { icon: LucideIcon; color: string }> = {
  observation: { icon: Eye, color: SEMANTIC_COLORS.success },
  action: { icon: MousePointerClick, color: "#f9a825" },
  refusal: { icon: ShieldAlert, color: SEMANTIC_COLORS.danger },
  vision: { icon: Sparkles, color: "#c792ea" },
  session_start: { icon: Play, color: "#82aaff" },
  session_stop: { icon: Square, color: "#788494" },
};

/** Muted slate (hex so withAlpha works) for neutral/zero stat cells. */
const NEUTRAL = "#788494";

/** The STOP reason recorded server-side on the kill switch. */
const STOP_REASON = "stopped by the owner from the mini window";

/** Card + margin geometry for the drag clamp. */
const CARD_WIDTH = 340;
const VIEWPORT_MARGIN = 8;

/** "2m 14s" style elapsed — same format as the panel's session clock. */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m < 60) return `${m}m ${String(sec).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** The ticking "now" for the elapsed clock — 1s while active, frozen else. */
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

/** The app-wide floating monitor. Renders nothing while closed. */
export function ComputerMiniWindow() {
  const open = useComputerMonitorStore((s) => s.miniWindowOpen);
  return (
    <AnimatePresence>
      {open ? <MiniWindowCard key="computer-mini-window" /> : null}
    </AnimatePresence>
  );
}

/** The card itself — mounted fresh on every open (bottom-right start, clean
 * scroll-fade wiring, honest "idle" body before any event arrives). */
function MiniWindowCard() {
  const styles = useThemeStyles();
  const setMiniWindowOpen = useComputerMonitorStore((s) => s.setMiniWindowOpen);
  const events = useComputerMonitorStore((s) => s.events);
  const session = useComputerMonitorStore((s) => s.session);
  const liveActivity = useComputerMonitorStore((s) => s.liveActivity);
  const storeError = useComputerMonitorStore((s) => s.error);

  const sessionActive = session?.active ?? false;
  const killSwitch = session?.killSwitch ?? false;
  const stats = session?.stats ?? null;
  const startedAt = session?.startedAt ?? null;
  const live = liveActivity || sessionActive;
  const nowMs = useNowMs(sessionActive);

  // One-shot seed: the window can open with no panel behind it (and no
  // session in the store yet) — pull the session truth once. Re-attempted
  // if live frames start arriving while the session is still unknown.
  const hasSession = session !== null;
  useEffect(() => {
    if (hasSession) return;
    let cancelled = false;
    fetchComputerUseSession()
      .then((state) => {
        if (!cancelled) useComputerMonitorStore.getState().refreshFromServer(state);
      })
      .catch((err) => {
        if (!cancelled) {
          useComputerMonitorStore
            .getState()
            .setError(err instanceof Error ? err.message : "The sidecar didn't answer.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hasSession, liveActivity]);

  // ── Drag: the title bar is the handle ──
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => ({
    x: Math.max(VIEWPORT_MARGIN, window.innerWidth - CARD_WIDTH - 20),
    y: Math.max(VIEWPORT_MARGIN, window.innerHeight - 320),
  }));
  const dragCleanupRef = useRef<(() => void) | null>(null);
  // A mid-drag unmount (window closed) must not leak the window listeners.
  useEffect(() => () => dragCleanupRef.current?.(), []);

  const onTitleBarPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const origin = { x: pos.x, y: pos.y, cx: e.clientX, cy: e.clientY };
    const onMove = (ev: PointerEvent) => {
      const cardHeight = Math.max(180, cardRef.current?.offsetHeight ?? 320);
      const maxX = Math.max(0, window.innerWidth - CARD_WIDTH - VIEWPORT_MARGIN);
      const maxY = Math.max(0, window.innerHeight - cardHeight - VIEWPORT_MARGIN);
      setPos({
        x: Math.min(Math.max(0, origin.x + (ev.clientX - origin.cx)), maxX),
        y: Math.min(Math.max(0, origin.y + (ev.clientY - origin.cy)), maxY),
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      dragCleanupRef.current = null;
    };
    dragCleanupRef.current?.();
    dragCleanupRef.current = onUp;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  // ── The STOP kill switch ──
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const doStop = async () => {
    if (stopping || killSwitch) return;
    setStopping(true);
    setStopError(null);
    try {
      await stopComputerUse(STOP_REASON);
      // Pull the post-stop truth (kill switch engaged + final stats) in.
      const state = await fetchComputerUseSession();
      useComputerMonitorStore.getState().refreshFromServer(state);
    } catch (err) {
      setStopError(err instanceof Error ? err.message : "Stop failed");
    } finally {
      setStopping(false);
    }
  };

  // ── What it's doing: newest first, top event with the biggest weight ──
  const newest = events.length > 0 ? events[0] : null;
  const older = events.slice(1, 3);
  const latestVision = events.find((e) => e.kind === "vision") ?? null;

  const bodyRef = useRef<HTMLDivElement>(null);
  useScrollFade(bodyRef);

  const topMeta = newest !== null ? KIND_META[newest.kind] : undefined;
  const TopIcon = topMeta?.icon ?? Activity;
  const topColor = topMeta?.color ?? styles.textTertiary;

  return (
    <motion.div
      ref={cardRef}
      initial={{ opacity: 0, scale: 0.94, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, y: 8 }}
      transition={{ duration: 0.18, ease }}
      className="fixed z-[70] w-[340px] rounded-xl border overflow-hidden flex flex-col"
      style={{
        left: pos.x,
        top: pos.y,
        background: styles.isDark ? withAlpha(styles.card, 0.94) : styles.card,
        backdropFilter: "blur(14px)",
        borderColor: styles.borderStrong,
        boxShadow: styles.softShadow,
      }}
      role="dialog"
      aria-label="Agent computer monitor mini window"
      data-testid="computer-mini-window"
    >
      {/* ── Title bar: the drag handle + LIVE badge + close ── */}
      <div
        className="shrink-0 flex items-center gap-1.5 px-2.5 h-9 border-b cursor-grab active:cursor-grabbing select-none"
        style={{
          borderColor: styles.border,
          background: styles.isDark ? "rgba(0,0,0,0.18)" : styles.subtle,
          touchAction: "none",
        }}
        onPointerDown={onTitleBarPointerDown}
        data-testid="computer-mini-titlebar"
      >
        <GripHorizontal size={12} style={{ color: styles.textTertiary }} className="shrink-0" />
        <Monitor size={12} style={{ color: styles.accent }} className="shrink-0" />
        <div className="flex-1 min-w-0 truncate text-[11px] font-semibold" style={{ color: styles.text }}>
          Agent · Computer
        </div>
        {live ? (
          <span
            className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[8.5px] font-bold uppercase tracking-wider"
            style={{ background: withAlpha(SEMANTIC_COLORS.success, 0.14), color: SEMANTIC_COLORS.success }}
            data-testid="mini-live-badge"
          >
            <PulsingDot color={SEMANTIC_COLORS.success} size={4} /> LIVE
          </span>
        ) : null}
        <button
          onClick={() => setMiniWindowOpen(false)}
          aria-label="Close the computer monitor mini window"
          title="Close"
          className="shrink-0 w-6 h-6 grid place-items-center rounded-md transition-colors"
          style={{ color: styles.textTertiary }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = styles.subtleHover;
            e.currentTarget.style.color = styles.text;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = styles.textTertiary;
          }}
        >
          <X size={13} />
        </button>
      </div>

      {/* ── Body: what it's doing + spotlights + stats ── */}
      <div ref={bodyRef} className="max-h-[260px] overflow-y-auto auto-scroll" data-testid="mini-body">
        {/* What it's doing — the newest event with the biggest visual weight. */}
        <div className="px-2.5 pt-2.5 pb-1">
          <div
            className="text-[8.5px] font-bold uppercase tracking-wider mb-1.5"
            style={{ color: styles.textTertiary }}
          >
            What it&apos;s doing
          </div>
          {newest !== null ? (
            <div
              className="rounded-[10px] px-2.5 py-2 flex flex-col gap-1"
              style={{
                background: styles.isDark ? "rgba(0,0,0,0.16)" : styles.card,
                border: `1px solid ${styles.border}`,
              }}
              data-testid="mini-top-event"
            >
              <div className="flex items-center gap-1.5">
                <TopIcon size={13} style={{ color: topColor }} className="shrink-0" />
                <span
                  className="text-[8.5px] font-bold uppercase tracking-wider truncate"
                  style={{ color: topColor }}
                >
                  {newest.kind}
                </span>
                <span className="flex-1" />
                <span
                  className="text-[9px] tabular-nums shrink-0"
                  style={{ color: styles.textTertiary }}
                  title={new Date(newest.ts).toISOString()}
                >
                  {formatWhen(new Date(newest.ts).toISOString())}
                </span>
              </div>
              <ClampedText
                text={newest.label}
                lines={2}
                className="text-[11px] leading-[1.5] break-words"
                style={{ color: styles.text }}
              />
              {newest.tool !== undefined ? (
                <span
                  className="self-start text-[9px] font-mono px-1.5 py-0.5 rounded-md"
                  style={{ color: styles.textSecondary, background: withAlpha(NEUTRAL, 0.12) }}
                >
                  {newest.tool}
                </span>
              ) : null}
            </div>
          ) : (
            <div
              className="rounded-[10px] px-2.5 py-3 text-[10.5px] text-center"
              style={{ color: styles.textTertiary, border: `1px dashed ${styles.border}` }}
            >
              Idle — the agent isn&apos;t using the desktop right now.
            </div>
          )}
          {older.map((event) => (
            <CompactEventRow key={event.id} event={event} />
          ))}
        </div>

        {/* Refusal spotlight: the newest event is a refusal — the wall the
            agent just hit and must recover from. */}
        {newest !== null && newest.kind === "refusal" ? (
          <div
            className="mx-2.5 mt-1 rounded-[10px] px-2.5 py-2"
            style={{
              background: withAlpha(SEMANTIC_COLORS.danger, 0.1),
              border: `1px solid ${withAlpha(SEMANTIC_COLORS.danger, 0.35)}`,
            }}
            data-testid="mini-refusal-spotlight"
          >
            <div className="flex items-center gap-1.5 text-[10px] font-bold" style={{ color: SEMANTIC_COLORS.danger }}>
              <ShieldAlert size={11} className="shrink-0" />
              <span className="truncate">
                Refused: {newest.tool ?? "policy"}
                {newest.code !== undefined ? ` · ${newest.code}` : ""}
              </span>
            </div>
            <div className="text-[9.5px] mt-0.5 leading-[1.45]" style={{ color: styles.textSecondary }}>
              The agent hit a wall — it must change approach before it can retry.
            </div>
          </div>
        ) : null}

        {/* Vision spotlight: the newest vision description (the label carries
            the "Vision (mode): …" text — what the vision model said). */}
        {latestVision !== null ? (
          <div
            className="mx-2.5 mt-1 rounded-[10px] px-2.5 py-2"
            style={{
              background: withAlpha("#c792ea", 0.1),
              border: `1px solid ${withAlpha("#c792ea", 0.35)}`,
            }}
            data-testid="mini-vision-spotlight"
          >
            <div className="flex items-center gap-1.5 text-[10px] font-bold" style={{ color: "#c792ea" }}>
              <Sparkles size={11} className="shrink-0" /> Vision
            </div>
            <ClampedText
              text={latestVision.label}
              lines={2}
              className="text-[9.5px] mt-0.5 leading-[1.45] break-words"
              style={{ color: styles.textSecondary }}
            />
          </div>
        ) : null}

        {/* Stats strip: sent / refused / observations / vision + the clock. */}
        <div className="px-2.5 pt-2 pb-2.5 flex flex-col gap-1">
          <div className="grid grid-cols-4 gap-1" data-testid="mini-stats">
            <MiniStat label="Sent" value={stats?.actionsSent ?? 0} color={SEMANTIC_COLORS.success} title="Actions sent" />
            <MiniStat
              label="Refused"
              value={stats?.actionsRefused ?? 0}
              color={(stats?.actionsRefused ?? 0) > 0 ? SEMANTIC_COLORS.danger : NEUTRAL}
              title="Actions refused"
            />
            <MiniStat label="Obs" value={stats?.observations ?? 0} color={styles.text} title="Observations" />
            <MiniStat label="Vision" value={stats?.visionCalls ?? 0} color="#c792ea" title="Vision calls" />
          </div>
          <div className="flex items-center gap-1.5 text-[9px]" style={{ color: styles.textTertiary }}>
            <Clock size={9} className="shrink-0" />
            <span className="font-mono tabular-nums" data-testid="mini-elapsed">
              {startedAt !== null ? `Elapsed ${fmtElapsed(Math.max(0, nowMs - startedAt))}` : "Not started"}
            </span>
            <span className="flex-1" />
            {live ? <span className="truncate">live</span> : null}
          </div>
          {storeError !== null && session === null ? (
            <div className="text-[9.5px]" style={{ color: SEMANTIC_COLORS.danger }} role="alert">
              {storeError}
            </div>
          ) : null}
          {stopError !== null ? (
            <div className="text-[9.5px]" style={{ color: SEMANTIC_COLORS.danger }} role="alert">
              {stopError}
            </div>
          ) : null}
        </div>
      </div>

      {/* ── Footer: the BIG STOP kill switch ── */}
      <div
        className="shrink-0 border-t px-2.5 py-2"
        style={{ borderColor: styles.border, background: styles.isDark ? "rgba(0,0,0,0.18)" : styles.subtle }}
      >
        <button
          onClick={() => void doStop()}
          disabled={stopping || killSwitch}
          data-testid="mini-stop-button"
          title={killSwitch ? "The kill switch is active — the agent cannot control the desktop" : "Kill switch — stop the agent's computer control now"}
          className="w-full h-9 rounded-[10px] inline-flex items-center justify-center gap-2 text-[10.5px] font-bold uppercase tracking-wider transition-colors disabled:cursor-default"
          style={
            killSwitch
              ? {
                  color: styles.textTertiary,
                  background: withAlpha(NEUTRAL, 0.1),
                  border: `1px solid ${styles.border}`,
                }
              : {
                  color: SEMANTIC_COLORS.danger,
                  background: withAlpha(SEMANTIC_COLORS.danger, 0.12),
                  border: `1px solid ${withAlpha(SEMANTIC_COLORS.danger, 0.45)}`,
                }
          }
        >
          {stopping ? <LoaderCircle size={12} className="animate-spin" /> : <Square size={12} fill="currentColor" strokeWidth={0} />}
          {stopping ? "Stopping…" : killSwitch ? "Stopped — the kill switch is active" : "STOP computer control"}
        </button>
      </div>
    </motion.div>
  );
}

/** A compact older-event row: icon + clamped label + relative ts. */
function CompactEventRow({ event }: { event: ComputerMonitorEvent }) {
  const styles = useThemeStyles();
  const meta = KIND_META[event.kind];
  const Icon = meta?.icon ?? Activity;
  const color = meta?.color ?? styles.textTertiary;
  return (
    <div className="flex items-center gap-1.5 px-1 py-0.5">
      <Icon size={10} style={{ color }} className="shrink-0" />
      <span className="flex-1 min-w-0 truncate text-[10px]" style={{ color: styles.textSecondary }}>
        {event.label}
      </span>
      <span
        className="text-[8.5px] shrink-0 tabular-nums"
        style={{ color: styles.textTertiary }}
        title={new Date(event.ts).toISOString()}
      >
        {formatWhen(new Date(event.ts).toISOString())}
      </span>
    </div>
  );
}

/** One mini stat cell: the count + the tiny label. */
function MiniStat({ label, value, color, title }: { label: string; value: number; color: string; title: string }) {
  const styles = useThemeStyles();
  return (
    <div
      className="flex flex-col items-center gap-0.5 min-w-0 py-1 rounded-lg"
      style={{ background: withAlpha(color, 0.08) }}
      title={title}
    >
      <span className="text-[12px] font-bold font-mono leading-none tabular-nums" style={{ color }}>
        {value}
      </span>
      <span className="text-[7.5px] font-bold uppercase tracking-wide" style={{ color: styles.textTertiary }}>
        {label}
      </span>
    </div>
  );
}

/** The LIVE badge's heartbeat dot. */
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
