import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { LoaderCircle, Square } from "lucide-react";
import { ease } from "../lib/motion";
import { SEMANTIC_COLORS } from "../lib/semantics";
import { getSidecarInfo, type SidecarInfo } from "../lib/sidecar";
import { useThemeStyles } from "../lib/use-theme-styles";
import { fetchMiniSession, stopMiniSession, type MiniSessionState } from "./mini-client";
import { miniShell, type MiniShellShape } from "./shell";

/**
 * ROUND-64 (R64-b) — the floating computer-use mini monitor PAGE.
 *
 * The owner's directive, verbatim intent: "It needs to be very minimal. It
 * needs to be clean. It needs to be beautiful. It should be a floating one…
 * so that I can easily stop it from there." This is the 360×96 always-on-top
 * window's whole UI:
 *
 *   row 1 — pulsing status dot + "Agent is using your computer" + elapsed
 *            timer (tabular-nums), and it is the window's DRAG REGION
 *            (data-tauri-drag-region — Tauri's injected script owns dragging);
 *   row 2 — the latest activity, one truncated line, subtle;
 *   right  — the STOP kill switch, a danger-tinted pill spanning both rows.
 *
 * NO scroll, NO stats grid, NO event list — minimal is the feature.
 *
 * DATA (own poll, deliberately NOT the main app's stores): the page resolves
 * the sidecar endpoint once (getSidecarInfo → the Rust shell's sidecar_info
 * command) and then polls GET /computer-use/session every second with the
 * bearer token (mini-client.ts — a ~20-line local replica of the api.ts
 * call, so this standalone vite entry never imports the main app's bundle).
 *
 * SELF-CLOSE: when the control session has ended — kill switch engaged or a
 * session_stop event (≈6s grace so the owner sees the stopped state), or the
 * session inactive with no new events for ~8s — the page invokes the Rust
 * `close_computer_mini` command (the window closes; open_computer_mini will
 * rebuild it on the next activity burst). The main app's controller is the
 * backstop on the session_stop SSE frame.
 *
 * Web mode (no __TAURI__ — a plain dev visit of mini.html): the honest tiny
 * notice, the PopoutApp discipline.
 */

/** The STOP reason recorded server-side on the kill switch. */
const STOP_REASON = "stopped by the owner from the floating monitor";

/** Deliberately local (the standalone-bundle rule — see mini-client.ts):
 * hex → rgba() for the tints below; same 6 lines as withAlpha(). */
function alpha(color: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const int = Number.parseInt(m[1], 16);
  return `rgba(${(int >> 16) & 0xff}, ${(int >> 8) & 0xff}, ${int & 0xff}, ${a})`;
}

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
export interface MiniAppProps {
  /** Session poll interval (default 1s — live enough, gentle enough). */
  pollMs?: number;
  /** Grace after the kill switch / session_stop before self-close (6s). */
  stoppedCloseMs?: number;
  /** Inactivity window once the session reports inactive (8s). */
  idleCloseMs?: number;
}

export function MiniApp({
  pollMs = 1_000,
  stoppedCloseMs = 6_000,
  idleCloseMs = 8_000,
}: MiniAppProps) {
  const styles = useThemeStyles();
  // Captured once (lazy initializer): __TAURI__ is injected before the bundle
  // evaluates (the popout/TitleBar discipline) — a stable object keeps the
  // effect deps honest.
  const [shell] = useState<MiniShellShape | null>(() => miniShell());

  // ── sidecar endpoint resolution (retry until the shell answers) ─────────
  const [info, setInfo] = useState<SidecarInfo | null>(null);
  useEffect(() => {
    if (shell === null) return;
    let cancelled = false;
    const tryResolve = () => {
      void getSidecarInfo().then((resolved) => {
        if (cancelled || resolved === null) return;
        setInfo(resolved);
      });
    };
    tryResolve();
    const id = setInterval(tryResolve, 500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [shell]);

  // ── the session poll + the self-close rules ─────────────────────────────
  const [session, setSession] = useState<MiniSessionState | null>(null);
  /** True when polls are failing — the honest "monitor disconnected" line. */
  const [unreachable, setUnreachable] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  const sessionActive = session?.active ?? false;
  const killSwitch = session?.killSwitch ?? false;
  const nowMs = useNowMs(sessionActive);
  const startedAt = session?.startedAt ?? null;

  // The self-close invoke fires ONCE per window lifetime (idempotent on the
  // Rust side too — a second close is a harmless no-op, but one call is
  // honest in the logs).
  const closedRef = useRef(false);
  const closeSelf = useCallback(() => {
    if (shell === null || closedRef.current) return;
    closedRef.current = true;
    shell.core
      .invoke("close_computer_mini")
      .catch((err: unknown) => {
        // Un-close on failure so a later poll can try again.
        closedRef.current = false;
        console.warn("[mini] close_computer_mini failed", err);
      });
  }, [shell]);

  // Poll bookkeeping (refs — identity survives poll-effect re-runs):
  //  - lastSeq/lastEventAt: when the newest event's identity CHANGES we know
  //    activity is flowing (the idle-close clock restarts);
  //  - endedSince: when the session END was first observed (kill switch or
  //    session_stop) — the 6s grace starts there.
  const pollRef = useRef({
    lastSeq: null as number | null,
    lastEventAt: 0,
    endedSince: null as number | null,
  });

  useEffect(() => {
    if (shell === null || info === null) return;
    let cancelled = false;
    const poll = async () => {
      const state = await fetchMiniSession(info);
      if (cancelled) return;
      if (state === null) {
        // Keep the last good state; a monitor never crashes its window over
        // a lost packet. The main app's backstop still closes the window.
        setUnreachable(true);
        return;
      }
      setUnreachable(false);
      setSession(state);

      const book = pollRef.current;
      const newest = state.events[0] ?? null;
      const seq = newest?.seq ?? null;
      if (seq !== book.lastSeq) {
        book.lastSeq = seq;
        book.lastEventAt = Date.now();
      }
      if (state.active) {
        book.endedSince = null;
        return;
      }
      const now = Date.now();
      const ended = state.killSwitch || newest?.kind === "session_stop";
      if (ended) {
        // The owner just saw the stopped state — leave it up for the grace
        // period, then take the window away.
        if (book.endedSince === null) book.endedSince = now;
        if (now - book.endedSince >= stoppedCloseMs) closeSelf();
        return;
      }
      // Inactive without a stop event (a session that simply went idle):
      // close once nothing new has arrived for the idle window.
      if (now - book.lastEventAt >= idleCloseMs) closeSelf();
    };
    void poll();
    const id = setInterval(() => void poll(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [shell, info, pollMs, stoppedCloseMs, idleCloseMs, closeSelf]);

  // ── the STOP kill switch ──
  const doStop = useCallback(async () => {
    if (stopping || killSwitch || info === null) return;
    setStopping(true);
    setStopError(null);
    try {
      await stopMiniSession(info, STOP_REASON);
      // Pull the post-stop truth (kill switch engaged) straight in.
      const state = await fetchMiniSession(info);
      if (state !== null) setSession(state);
    } catch (err) {
      setStopError(err instanceof Error ? err.message : "Stop failed");
    } finally {
      setStopping(false);
    }
  }, [stopping, killSwitch, info]);

  // ── web mode: the honest notice ─────────────────────────────────────────
  if (shell === null) {
    return (
      <div
        className="grid h-screen w-screen place-items-center p-6"
        style={{ background: styles.bg }}
        data-testid="mini-web-notice-root"
      >
        <div
          className="max-w-xs rounded-2xl border p-4 text-center"
          style={{ background: styles.card, borderColor: styles.border }}
          data-testid="mini-web-notice"
          role="note"
        >
          <p className="text-[12px] font-semibold" style={{ color: styles.text }}>
            The floating monitor needs the desktop app
          </p>
          <p className="mt-1.5 text-[11px] leading-relaxed" style={{ color: styles.textSecondary }}>
            This page is the always-on-top STOP bar that floats over your screen
            while the agent uses the computer. In plain web mode there is no
            Tauri shell to float above other apps — it opens automatically in
            the desktop app.
          </p>
        </div>
      </div>
    );
  }

  // ── the minimal bar ─────────────────────────────────────────────────────
  const newest = session?.events[0] ?? null;
  const label = killSwitch
    ? "Stopped — kill switch active"
    : session !== null && !sessionActive
      ? "Computer control session ended"
      : "Agent is using your computer";
  const activity = stopError ?? (unreachable
    ? "Monitor disconnected — retrying…"
    : session === null
      ? "Connecting to the agent engine…"
      : newest !== null
        ? newest.label
        : "Waiting for the first action…");
  const activityColor = stopError !== null ? SEMANTIC_COLORS.danger : styles.textSecondary;

  return (
    <div
      className="flex h-screen w-screen select-none items-stretch overflow-hidden rounded-[14px] border"
      style={{
        background: styles.isDark ? alpha(styles.card, 0.92) : styles.card,
        backdropFilter: "blur(16px)",
        borderColor: styles.isDark ? "rgba(255,255,255,0.09)" : styles.border,
        boxShadow: "0 10px 28px rgba(0,0,0,0.30)",
      }}
      data-testid="mini-root"
      role="status"
      aria-label="Agent computer monitor"
    >
      {/* LEFT — the two rows (status + latest activity). */}
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-[5px] pl-3.5 pr-1.5">
        {/* Row 1 — status + elapsed; THE drag region (the attribute repeats
            on the non-interactive children because Tauri only starts a drag
            when the mousedown TARGET carries it). */}
        <div
          data-tauri-drag-region
          className="flex min-w-0 cursor-default items-center gap-2"
          data-testid="mini-status-row"
          title="Drag to move the floating monitor"
        >
          <PulsingDot live={sessionActive && !killSwitch} />
          <span
            data-tauri-drag-region
            className="min-w-0 truncate text-[12px] font-semibold"
            style={{ color: killSwitch ? styles.textSecondary : styles.text }}
            data-testid="mini-label"
          >
            {label}
          </span>
          {startedAt !== null ? (
            <span
              data-tauri-drag-region
              className="ml-auto shrink-0 text-[11px] tabular-nums"
              style={{ color: styles.textTertiary }}
              data-testid="mini-elapsed"
              title="Control session elapsed"
            >
              {fmtElapsed(Math.max(0, nowMs - startedAt))}
            </span>
          ) : null}
        </div>

        {/* Row 2 — the latest activity, one subtle truncated line. */}
        <div className="flex min-w-0 items-center pr-1">
          <span
            className="min-w-0 truncate text-[11px]"
            style={{ color: activityColor }}
            data-testid="mini-activity"
            title={activity}
          >
            {activity}
          </span>
        </div>
      </div>

      {/* STOP — the danger pill, spanning both rows (the one prominent
          control; everything else on the bar is passive). */}
      <div className="flex shrink-0 items-stretch p-2 pl-1">
        <button
          type="button"
          onClick={() => void doStop()}
          disabled={stopping || killSwitch}
          data-testid="mini-stop-button"
          title={
            killSwitch
              ? "The kill switch is active — the agent cannot control the desktop"
              : "Kill switch — stop the agent's computer control now"
          }
          className="flex w-[72px] flex-col items-center justify-center gap-1 rounded-[11px] border text-[10.5px] font-bold uppercase tracking-wider transition-colors disabled:cursor-default"
          style={
            killSwitch
              ? {
                  color: styles.textTertiary,
                  background: alpha("#788494", 0.10),
                  borderColor: styles.border,
                }
              : {
                  color: SEMANTIC_COLORS.danger,
                  background: alpha(SEMANTIC_COLORS.danger, 0.13),
                  borderColor: alpha(SEMANTIC_COLORS.danger, 0.45),
                }
          }
          onMouseEnter={(e) => {
            if (!killSwitch && !stopping) {
              e.currentTarget.style.background = alpha(SEMANTIC_COLORS.danger, 0.22);
            }
          }}
          onMouseLeave={(e) => {
            if (!killSwitch) {
              e.currentTarget.style.background = alpha(SEMANTIC_COLORS.danger, 0.13);
            }
          }}
        >
          {stopping ? (
            <LoaderCircle size={12} className="animate-spin" aria-hidden />
          ) : (
            <Square size={11} fill="currentColor" strokeWidth={0} aria-hidden />
          )}
          <span className="leading-none">{stopping ? "Stopping" : killSwitch ? "Stopped" : "Stop"}</span>
        </button>
      </div>
    </div>
  );
}

/** The status dot — a heartbeat while the agent is in control, a calm gray
 * point once stopped (framer-motion's repeat, the PulsingDot discipline). */
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
