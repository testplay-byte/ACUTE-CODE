import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { LoaderCircle, Square } from "lucide-react";
import { ease } from "../lib/motion";
import { SEMANTIC_COLORS } from "../lib/semantics";
import { getSidecarInfo, type SidecarInfo } from "../lib/sidecar";
import { useThemeStyles } from "../lib/use-theme-styles";
import { cn } from "../lib/utils";
import { fetchMiniSession, stopMiniSession, type MiniSessionState } from "./mini-client";
import { miniShell, type MiniShellShape } from "./shell";

/**
 * ROUND-64 (R64-b) — the floating computer-use mini monitor PAGE.
 *
 * The owner's directive, verbatim intent: "It needs to be very minimal. It
 * needs to be clean. It needs to be beautiful. It should be a floating one…
 * so that I can easily stop it from there." This is the 460×56 always-on-top
 * window's whole UI (ROUND-66: the R64 360×96 two-row layout collapsed into
 * ONE compact row per the owner's "make it less tall" report):
 *
 *   one row — pulsing status dot + "Agent is using your computer" + "·" +
 *             the latest activity (inline, truncated, subtle) + the elapsed
 *             timer; the WHOLE row is the window's DRAG REGION
 *             (data-tauri-drag-region — Tauri's injected script owns dragging);
 *   right   — the STOP kill switch, a danger-tinted compact pill.
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
 *
 * R126-3h (the secondary-OS-windows chrome pass): the bar's chrome is the
 * CLAY card spelling — the clay-rim hairline + the clay SHEET shadow (the
 * window floats, so it RISES) replace the border/rgba/0-10-28 legs, and the
 * off-ladder rounded-[14px] dies for rounded-xl (the 460×56 window's Rust
 * frame stays square-cornered; the page paints its own rounding). The STOP
 * pill rides the OUTLINED-danger species (border-danger-deep + danger-deep
 * on transparent — the danger wash dies); the kill-switch state rides the
 * MUTED tier (the hardcoded #788494 dies); the error activity ink rides
 * danger-deep; the stopped dot rides the muted tier.
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

  // ── the minimal bar (ROUND-66: ONE compact row — the owner's "less tall…
  // minimal… centered at the top" directive; the R64 two-row layout is
  // gone: the label carries the state, the activity rides inline after a
  // separator dot) ─────────────────────────────────────────────────────
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
  // R126-3h: the error ink rides the danger-deep tier (the flat SEMANTIC
  // hex dies); the quiet activity ink stays the tertiary inline leg.
  const activityClassName = stopError !== null ? "text-danger-deep" : "";

  return (
    <div
      // R126-3h (TOKENS §5/§9): the clay card — rounded-xl (the off-ladder
      // rounded-[14px] dies) + the 1px clay-rim hairline + the UPWARD clay
      // sheet shadow (the bar floats above the screen). The frosted fill
      // (dark-mode translucent card + the backdrop blur) stays.
      className="ac-clay-sheet flex h-screen w-screen select-none items-center overflow-hidden rounded-xl border border-clay-rim"
      style={{
        background: styles.isDark ? alpha(styles.card, 0.92) : styles.card,
        backdropFilter: "blur(16px)",
      }}
      data-testid="mini-root"
      role="status"
      aria-label="Agent computer monitor"
    >
      {/* LEFT — the ONE row (status + inline activity); THE drag region (the
          attribute repeats on the non-interactive children because Tauri only
          starts a drag when the mousedown TARGET carries it). ROUND-66: the
          R64 two-row layout collapsed into a single compact row. */}
      <div
        data-tauri-drag-region
        className="flex min-w-0 flex-1 cursor-default items-center gap-2 pl-3.5 pr-1.5"
        data-testid="mini-status-row"
        title="Drag to move the floating monitor"
      >
        <PulsingDot live={sessionActive && !killSwitch} />
        <span
          data-tauri-drag-region
          className="shrink-0 truncate text-[12px] font-semibold"
          style={{ color: killSwitch ? styles.textSecondary : styles.text }}
          data-testid="mini-label"
        >
          {label}
        </span>
        {/* The inline activity — one subtle truncated line after the label
            (the separator keeps the two visually distinct in one row). */}
        <span data-tauri-drag-region className="shrink-0 text-[11px]" style={{ color: styles.textTertiary }}>
          ·
        </span>
        <span
          data-tauri-drag-region
          className={cn("min-w-0 flex-1 truncate text-[11px]", activityClassName)}
          style={activityClassName === "" ? { color: styles.textTertiary } : undefined}
          data-testid="mini-activity"
          title={activity}
        >
          {activity}
        </span>
        {startedAt !== null ? (
          <span
            data-tauri-drag-region
            className="shrink-0 text-[11px] tabular-nums"
            style={{ color: styles.textTertiary }}
            data-testid="mini-elapsed"
            title="Control session elapsed"
          >
            {fmtElapsed(Math.max(0, nowMs - startedAt))}
          </span>
        ) : null}
      </div>

      {/* STOP — the danger pill (the one prominent control; everything else
          on the bar is passive). R66: horizontal compact pill, one row tall.
          R126-3h: the OUTLINED-danger species (1px border-danger-deep +
          danger-deep ink on transparent — the danger wash fill + the JS
          hover pair die; the CSS hover wash takes over); the kill-switch
          state rides the MUTED tier (the hardcoded #788494 dies). */}
      <div className="flex shrink-0 items-center p-2 pl-1">
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
          className={cn(
            "flex h-8 items-center justify-center gap-1.5 rounded-full border px-3.5 text-[10.5px] font-bold uppercase tracking-wider transition-colors duration-100 disabled:cursor-default",
            killSwitch
              ? "border-line-strong text-muted"
              : "border-danger-deep text-danger-deep hover:bg-badge-danger",
          )}
        >
          {stopping ? (
            <LoaderCircle size={11} className="animate-spin" aria-hidden />
          ) : (
            <Square size={10} fill="currentColor" strokeWidth={0} aria-hidden />
          )}
          <span className="leading-none">{stopping ? "Stopping" : killSwitch ? "Stopped" : "Stop"}</span>
        </button>
      </div>
    </div>
  );
}

/** The status dot — a heartbeat while the agent is in control, a calm
 * MUTED-tier point once stopped (R126-3h: the hardcoded #788494 gray dies —
 * the muted ink class owns the stopped hue; the live hue is a DOT, the §11
 * dots-only flat-hue exception, and keeps the semantic success green). */
function PulsingDot({ live }: { live: boolean }) {
  return (
    <motion.span
      className={cn("inline-block shrink-0 rounded-full", live ? "" : "bg-muted")}
      style={live ? { width: 6, height: 6, background: SEMANTIC_COLORS.success } : { width: 6, height: 6 }}
      initial={false}
      animate={live ? { scale: [1, 1.5, 1], opacity: [1, 0.45, 1] } : { scale: 1, opacity: 0.7 }}
      transition={live ? { repeat: Infinity, duration: 1.6, ease: "easeInOut" } : { duration: 0.18, ease }}
      aria-hidden
    />
  );
}
