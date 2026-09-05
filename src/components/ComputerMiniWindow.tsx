import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { LoaderCircle, Square } from "lucide-react";
import { fetchComputerUseSession, stopComputerUse } from "../lib/api";
import { useComputerMonitorStore } from "../lib/computer-monitor-store";
import { nativeInvoke } from "../lib/native-browser";
import { ease } from "../lib/motion";
import { SEMANTIC_COLORS } from "../lib/semantics";
import { isTauri } from "../lib/sidecar";
import type { ThemeStyles } from "../lib/themes";
import { useThemeStyles } from "../lib/use-theme-styles";
import { withAlpha } from "./dashboard/helpers";

/**
 * ROUND-64 (R64-b) — the FLOATING COMPUTER MONITOR, re-architected per the
 * owner's directive: "It needs to be very minimal. It needs to be clean. It
 * needs to be beautiful. It should be a floating one. It will be shown at the
 * top of each and every single one of the screens… so that I can easily stop
 * it from there… The floating one will automatically show up as soon as the
 * agent starts to use the computer skill and starts to interact with the
 * device."
 *
 * This component is mounted app-wide (AppShell) and is now a CONTROLLER, not
 * a card:
 *
 *   DESKTOP (Tauri) — the surface is a dedicated ALWAYS-ON-TOP OS window
 *   (src-tauri/src/mini.rs, hosting the mini.html page): live SSE
 *   computer-use frames flip the monitor store's `liveActivity` →
 *   `open_computer_mini` is invoked (once per burst); the session ending
 *   (the `session_stop` frame) schedules `close_computer_mini` as a
 *   backstop — the mini page closes itself via its own poll first. NOTHING
 *   renders in-app (no double surfaces: the OS window IS the surface, and
 *   it floats above every screen so STOP is reachable while the agent
 *   drives other apps).
 *
 *   WEB (no Tauri) — the same minimal bar language as an in-app pill:
 *   `fixed top-3 left-1/2 z-[90]` compact card (status dot + label +
 *   elapsed timer + latest activity + the STOP kill switch), auto-SHOWN on
 *   live activity and auto-HIDDEN ~8s after the session ends. The old
 *   bottom-right draggable card (drag handle + stats grid + event list) is
 *   deliberately GONE — minimal is the feature.
 *
 * FEED SOURCES (the monitor store, unchanged): live SSE frames land via the
 * stream-store intercept at dispatch time (zero latency), a one-shot session
 * fetch seeds the boot state, and — while the pill is visible — a light 2s
 * poll keeps the kill-switch state + stats honest (the surface owns its
 * poll now that the right-sidebar ComputerPanel tab is gone).
 */

/** The STOP reason recorded server-side on the kill switch (shared with the
 * floating monitor page — src/mini/MiniApp.tsx uses the same string). */
const STOP_REASON = "stopped by the owner from the floating monitor";

/** "2m 14s" style elapsed — the session clock (startedAt is epoch ms). */
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

/** Timings as props so the tests drive real timers with tiny values. */
export interface ComputerMiniWindowProps {
  /** Web pill: how long after the session ends before it auto-hides (8s). */
  hideDelayMs?: number;
  /** Tauri: the close_computer_mini backstop delay after the session ends
   * (6s — the mini page's own poll normally closes it first). */
  closeDelayMs?: number;
  /** Web pill: the keep-honest session poll while visible (2s). */
  pollMs?: number;
}

export function ComputerMiniWindow({
  hideDelayMs = 8_000,
  closeDelayMs = 6_000,
  pollMs = 2_000,
}: ComputerMiniWindowProps = {}) {
  const styles = useThemeStyles();
  const session = useComputerMonitorStore((s) => s.session);
  const events = useComputerMonitorStore((s) => s.events);
  const storeError = useComputerMonitorStore((s) => s.error);

  const sessionActive = session?.active ?? false;
  const killSwitch = session?.killSwitch ?? false;
  const startedAt = session?.startedAt ?? null;
  const nowMs = useNowMs(sessionActive);
  // R67-C: `live` is the decayed real-control signal OR an OPEN TURN HOLD:
  // the stream-store hook holds the turn when computer-use frames flow and
  // releases at turn end, so the surface persists through the agent's
  // THINKING GAPS between computer tool calls (the owner's report: the mini
  // window disappeared mid-turn because the 6s per-EVENT decay fired while
  // the model was thinking). The hold is only ever set for turns that ran
  // computer tools — browser-only turns NEVER hold, so the R66 guarantee
  // (live = real control events, not session aliveness) is unchanged.
  // ROUND-66 (R66, A1/B1) history: the old `|| sessionActive` clause was the
  // opposite bug — the singleton session stays ACTIVE while Computer Use is
  // merely ENABLED, so live pinned true forever and browser-only turns kept
  // the stale window up; live stayed REAL-CONTROL-ONLY through R66.
  const liveActivity = useComputerMonitorStore((s) => s.liveActivity);
  const turnHeld = useComputerMonitorStore((s) => Object.values(s.turnHolds).some(Boolean));
  const live = (liveActivity || turnHeld) && !killSwitch;
  const inTauri = isTauri();

  // ── one-shot seed: the component mounts before any activity (app-wide),
  // so a session that is ALREADY active at boot (app reload mid-control)
  // still surfaces. Re-attempted while live frames arrive with the session
  // still unknown (the ComputerPanel's old contract, now owned here).
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
  }, [hasSession, liveActivity, turnHeld]);

  // ── the auto show/hide + open/close controller (EDGE-triggered) ─────────
  // live false→true: show the surface (open the OS window in Tauri / the
  // pill in web) — once per burst, because it is an edge.
  // live true→false: the session ended (session_stop frame / kill switch /
  // inactive session) — schedule the surface's dismissal, CANCELED if
  // activity resumes (a new burst within the grace period re-shows instead).
  const [visible, setVisible] = useState(false);
  const prevLiveRef = useRef(false);
  useEffect(() => {
    const prev = prevLiveRef.current;
    prevLiveRef.current = live;
    if (live) {
      if (inTauri) {
        const invoke = nativeInvoke();
        invoke?.("open_computer_mini").catch((err: unknown) => {
          console.warn("[computer-mini] open_computer_mini failed", err);
        });
      } else {
        setVisible(true);
      }
      return;
    }
    if (!prev) return; // false→false (mount, or long after a dismissal)
    const delay = inTauri ? closeDelayMs : hideDelayMs;
    const t = setTimeout(() => {
      if (inTauri) {
        const invoke = nativeInvoke();
        invoke?.("close_computer_mini").catch((err: unknown) => {
          console.warn("[computer-mini] close_computer_mini failed", err);
        });
      } else {
        setVisible(false);
      }
    }, delay);
    return () => clearTimeout(t);
  }, [live, inTauri, closeDelayMs, hideDelayMs]);

  // ── web pill: the keep-honest poll while visible ────────────────────────
  // (In Tauri the OS window's page polls the engine itself — mini-client —
  // so the main app does NOT double-poll there.)
  useEffect(() => {
    if (inTauri || !visible) return;
    const id = setInterval(() => {
      void fetchComputerUseSession()
        .then((state) => useComputerMonitorStore.getState().refreshFromServer(state))
        .catch(() => {
          // Keep the last good truth — the tiny error line only flips when
          // the one-shot seed or a STOP fails (honest, not noisy).
        });
    }, pollMs);
    return () => clearInterval(id);
  }, [inTauri, visible, pollMs]);

  // ── the STOP kill switch (the web pill's one prominent action) ──────────
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

  // DESKTOP: the OS window is the surface — nothing in-app, ever.
  if (inTauri) return null;

  const label = killSwitch
    ? "Agent computer control stopped"
    : "Agent is using your computer";
  const newest = events[0] ?? null;
  const activity = newest !== null ? newest.label : "Waiting for the first action…";

  return (
    // The plain-CSS anchor keeps framer-motion's transform (it animates the
    // inner card) from fighting Tailwind's -translate-x-1/2.
    <div className="pointer-events-none fixed top-3 left-1/2 z-[90] -translate-x-1/2">
      <AnimatePresence>
        {visible ? (
          <MiniPill
            key="computer-mini-pill"
            styles={styles}
            live={live}
            killSwitch={killSwitch}
            label={label}
            activity={activity}
            error={stopError ?? (session === null ? storeError : null)}
            elapsed={
              startedAt !== null ? fmtElapsed(Math.max(0, nowMs - startedAt)) : null
            }
            stopping={stopping}
            onStop={() => void doStop()}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** The web-mode minimal bar — the same language as the OS window's page
 * (src/mini/MiniApp.tsx): dot + label + elapsed, one activity line, the
 * STOP pill. NO stats grid, NO event list, NO drag. */
function MiniPill({
  styles,
  live,
  killSwitch,
  label,
  activity,
  error,
  elapsed,
  stopping,
  onStop,
}: {
  styles: ThemeStyles;
  live: boolean;
  killSwitch: boolean;
  label: string;
  activity: string;
  error: string | null;
  elapsed: string | null;
  stopping: boolean;
  onStop: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -12, scale: 0.97 }}
      transition={{ duration: 0.18, ease }}
      className="pointer-events-auto flex max-w-[560px] items-center gap-3 rounded-full border px-3.5 py-1.5"
      style={{
        background: styles.isDark ? withAlpha(styles.card, 0.94) : styles.card,
        backdropFilter: "blur(14px)",
        borderColor: styles.borderStrong,
        boxShadow: styles.softShadow,
      }}
      role="status"
      aria-label="Agent computer monitor"
      data-testid="computer-mini-pill"
    >
      {/* LEFT — ROUND-66: ONE compact row (the owner's "way too tall" report;
          the R64 two-row pill collapsed): dot + label + "·" + the latest
          activity inline (truncated, subtle) + the elapsed timer. */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <PulsingDot live={live} />
        <span
          className="shrink-0 truncate text-[12px] font-semibold"
          style={{ color: killSwitch ? styles.textSecondary : styles.text }}
          data-testid="mini-label"
        >
          {label}
        </span>
        <span className="shrink-0 text-[11px]" style={{ color: styles.textTertiary }}>
          ·
        </span>
        <span
          className="min-w-0 flex-1 truncate text-[11px]"
          style={{ color: error !== null ? SEMANTIC_COLORS.danger : styles.textSecondary }}
          data-testid="mini-activity"
          title={activity}
        >
          {error !== null ? error : activity}
        </span>
        {elapsed !== null ? (
          <span
            className="shrink-0 text-[11px] tabular-nums"
            style={{ color: styles.textTertiary }}
            data-testid="mini-elapsed"
            title="Control session elapsed"
          >
            {elapsed}
          </span>
        ) : null}
      </div>

      {/* STOP — the danger pill (the one prominent control). */}
      <button
        type="button"
        onClick={onStop}
        disabled={stopping || killSwitch}
        data-testid="mini-stop-button"
        title={
          killSwitch
            ? "The kill switch is active — the agent cannot control the desktop"
            : "Kill switch — stop the agent's computer control now"
        }
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[10.5px] font-bold uppercase tracking-wider transition-colors disabled:cursor-default"
        style={
          killSwitch
            ? {
                color: styles.textTertiary,
                background: withAlpha("#788494", 0.10),
                borderColor: styles.border,
              }
            : {
                color: SEMANTIC_COLORS.danger,
                background: withAlpha(SEMANTIC_COLORS.danger, 0.13),
                borderColor: withAlpha(SEMANTIC_COLORS.danger, 0.45),
              }
        }
      >
        {stopping ? (
          <LoaderCircle size={11} className="animate-spin" aria-hidden />
        ) : (
          <Square size={10} fill="currentColor" strokeWidth={0} aria-hidden />
        )}
        <span className="leading-none">{stopping ? "Stopping" : killSwitch ? "Stopped" : "Stop"}</span>
      </button>
    </motion.div>
  );
}

/** The status dot — a heartbeat while the agent is in control, a calm gray
 * point once stopped (the MiniApp PulsingDot discipline). */
function PulsingDot({ live }: { live: boolean }) {
  const color = live ? SEMANTIC_COLORS.success : "#788494";
  return (
    <motion.span
      className="inline-block shrink-0 rounded-full"
      style={{ width: 6, height: 6, background: color }}
      initial={false}
      animate={live ? { scale: [1, 1.5, 1], opacity: [1, 0.45, 1] } : { scale: 1, opacity: 0.7 }}
      transition={live ? { repeat: Infinity, duration: 1.6, ease: "easeInOut" } : { duration: 0.18, ease }}
      aria-hidden
    />
  );
}
