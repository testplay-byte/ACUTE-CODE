import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { BadgeCheck, CircleCheck, Clock, Hourglass, ShieldAlert, Square } from "lucide-react";
import { resolveBrowserCheckpoint } from "../../lib/api";
import type { LiveBrowserCheckpoint } from "../../lib/stream-store";
import { ease } from "../../lib/motion";
import { SEMANTIC_COLORS } from "../../lib/semantics";
import { useThemeStyles } from "../../lib/use-theme-styles";
import { withAlpha } from "../dashboard/helpers";

/**
 * ROUND-66 (R66, A4 — the owner's directive, verbatim intent): "If it detects
 * that there is some bot blocking going on, like captcha or Cloudflare
 * verification, then it will wait for it. It will wait for about 15 seconds
 * and allow the user to bypass it by himself… While it is waiting for it, it
 * will show in the chat window itself in a beautiful format that captcha
 * verification is needed, Cloudflare verification is needed, or age captcha
 * verification is needed… It will show me the timer below that it is waiting
 * for me… I will be given other options there too, like manually marking it
 * as done… and being given the option to stop the automatic one, stop it
 * manually, and mark it as done."
 *
 * THIS is that card. The browser_control wait_for_verification tool opened a
 * checkpoint (a bot wall on the embedded browser's page); the tool pends on
 * the sidecar's checkpoint registry while this card counts down and hands
 * the owner two controls:
 *   · "Mark as done" — POST /browser-checkpoints/:id/resolve {action:"done"}
 *     → the tool re-probes the page and continues;
 *   · "Stop waiting" — {action:"stop"} → the tool returns the honest stopped
 *     result and asks how to proceed.
 * The 15s countdown timing out resolves server-side with "timeout" — the
 * card mirrors that state the moment the clock hits zero (the frame confirms).
 *
 * Props-driven (the DebugReportCard discipline — no store imports): the
 * panel feeds this the stream-store's liveTurn.browserCheckpoint. The resolve
 * call lives HERE (the card is the interactive surface, like the approval
 * cards' decision POSTs).
 */

/** The amber verification tone — the documented cross-theme token (a wall is
 * a warning-to-act, not the red of a failed turn). */
const AMBER = "#d97706";

/** The kind → human title (the owner's exact naming ask). */
function kindTitle(kind: LiveBrowserCheckpoint["kind"]): string {
  switch (kind) {
    case "captcha":
      return "CAPTCHA verification needed";
    case "cloudflare":
      return "Cloudflare verification needed";
    case "age":
      return "Age verification needed";
    default:
      return "Human verification needed";
  }
}

/** The kind → what the owner should do (one honest, calm instruction). */
function kindHint(kind: LiveBrowserCheckpoint["kind"]): string {
  switch (kind) {
    case "captcha":
      return "Solve the CAPTCHA in the browser panel — I'm waiting for you.";
    case "cloudflare":
      return "Complete the Cloudflare check in the browser panel — I'm waiting for you.";
    case "age":
      return "Confirm your age in the browser panel — I'm waiting for you.";
    default:
      return "Finish the verification in the browser panel — I'm waiting for you.";
  }
}

/** "0:12" style countdown (mm:ss under a minute reads as seconds). */
function fmtRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 60) {
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  }
  return `0:${String(s).padStart(2, "0")}`;
}

/** The ticking "now" while waiting (100ms — the countdown bar stays smooth). */
function useNowMs(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 100);
    return () => clearInterval(t);
  }, [active]);
  return nowMs;
}

export interface BrowserCheckpointCardProps {
  checkpoint: LiveBrowserCheckpoint;
  /** Test seam: the resolve call (defaults to the real api fn). */
  onResolve?: typeof resolveBrowserCheckpoint;
}

export function BrowserCheckpointCard({ checkpoint, onResolve = resolveBrowserCheckpoint }: BrowserCheckpointCardProps) {
  const styles = useThemeStyles();
  const resolve = onResolve;
  const [busy, setBusy] = useState<"done" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The LOCAL view of the resolution — the frame's browser-checkpoint.resolved
  // updates the store (the panel re-renders with the final state); this local
  // state only bridges the click → frame latency and mirrors the timeout the
  // moment the clock hits zero (the server resolves it a beat later).
  const [localState, setLocalState] = useState<LiveBrowserCheckpoint["state"] | null>(null);

  const state: LiveBrowserCheckpoint["state"] = localState ?? checkpoint.state;
  const waiting = state === "waiting";
  const nowMs = useNowMs(waiting);
  const deadline = checkpoint.startedAtMs + checkpoint.waitMs;
  const remaining = waiting ? Math.max(0, deadline - nowMs) : 0;
  // The clock hitting zero: mirror the timeout locally (the server's own
  // timer resolves the tool + emits the frame; the card stays honest).
  const zeroedRef = useRef(false);
  useEffect(() => {
    if (!waiting || zeroedRef.current) return;
    if (deadline - nowMs <= 0) {
      zeroedRef.current = true;
      setLocalState("timeout");
    }
  }, [waiting, deadline, nowMs]);

  const act = async (action: "done" | "stop") => {
    if (busy !== null || !waiting) return;
    setBusy(action);
    setError(null);
    try {
      const res = await resolve(checkpoint.checkpointId, action);
      if (res.ok) {
        setLocalState(action === "done" ? "done" : "stop");
      } else {
        // Unknown/expired (e.g. the server already timed it out) — the frame
        // will land the authoritative state; show the honest line meanwhile.
        setError("This checkpoint already settled — following the server's resolution.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach the agent engine");
    } finally {
      setBusy(null);
    }
  };

  const title =
    state === "done"
      ? "Verification solved"
      : state === "stop"
        ? "Stopped waiting"
        : state === "timeout"
          ? "Wait timed out"
          : kindTitle(checkpoint.kind);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.2, ease }}
      data-testid="browser-checkpoint-card"
      className="rounded-[14px] border overflow-hidden"
      style={{
        borderColor: waiting ? withAlpha(AMBER, 0.45) : styles.borderSubtle,
        background: styles.subtle,
      }}
      role="status"
      aria-label={title}
    >
      {/* ── the header row: the wall mark + title + the page URL ────────── */}
      <div className="px-3.5 pt-3 pb-2.5 flex items-start gap-2.5 min-w-0">
        <span
          className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-[9px]"
          style={{ background: withAlpha(waiting ? AMBER : styles.accent, 0.14) }}
        >
          {waiting ? (
            <ShieldAlert size={15} style={{ color: AMBER }} aria-hidden />
          ) : state === "stop" ? (
            <Square size={12} fill="currentColor" strokeWidth={0} style={{ color: styles.textTertiary }} aria-hidden />
          ) : (
            <CircleCheck size={15} style={{ color: SEMANTIC_COLORS.success }} aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-bold leading-tight" style={{ color: waiting ? AMBER : styles.text }}>
            {title}
          </p>
          <p
            className="mt-0.5 truncate font-mono text-[10.5px]"
            style={{ color: styles.textTertiary }}
            title={checkpoint.url}
          >
            {checkpoint.url}
          </p>
        </div>
        {waiting ? (
          <span
            className="flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
            style={{ background: withAlpha(AMBER, 0.12), color: AMBER }}
            title="The agent paused this browser action for you"
          >
            <Hourglass size={10} aria-hidden />
            Waiting for you
          </span>
        ) : null}
      </div>

      {waiting ? (
        <>
          {/* ── the countdown block (the owner: "It will show me the timer
                below that it is waiting for me") ─────────────────────────── */}
          <div className="px-3.5 pb-2.5">
            <div className="flex items-end gap-2.5">
              <span
                data-testid="browser-checkpoint-countdown"
                className="font-mono text-[30px] font-bold leading-none tabular-nums"
                style={{ color: AMBER }}
                aria-live="polite"
              >
                {fmtRemaining(remaining)}
              </span>
              <span className="pb-0.5 text-[11px]" style={{ color: styles.textSecondary }}>
                {kindHint(checkpoint.kind)}
              </span>
            </div>
            {/* The draining progress bar — the whole wait at a glance. */}
            <div
              className="mt-2.5 h-[5px] w-full overflow-hidden rounded-full"
              style={{ background: withAlpha(AMBER, 0.14) }}
              role="progressbar"
              aria-label="Time remaining to solve the verification"
              aria-valuenow={Math.round((remaining / checkpoint.waitMs) * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <motion.div
                className="h-full rounded-full"
                style={{ background: withAlpha(AMBER, 0.75) }}
                initial={false}
                animate={{ width: `${Math.max(0, Math.min(100, (remaining / checkpoint.waitMs) * 100))}%` }}
                transition={{ duration: 0.12, ease: "linear" }}
              />
            </div>
          </div>

          {/* ── the controls (the owner's exact two options) ─────────────── */}
          <div className="flex items-center gap-2 border-t px-3.5 py-2.5" style={{ borderColor: styles.borderSubtle }}>
            <button
              type="button"
              onClick={() => void act("done")}
              disabled={busy !== null}
              data-testid="browser-checkpoint-done"
              title="I solved it in the browser panel — the agent re-checks the page and continues"
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[11px] font-bold transition-colors disabled:opacity-60"
              style={{
                color: SEMANTIC_COLORS.success,
                background: withAlpha(SEMANTIC_COLORS.success, 0.12),
                borderColor: withAlpha(SEMANTIC_COLORS.success, 0.45),
              }}
            >
              <BadgeCheck size={12} aria-hidden />
              {busy === "done" ? "Marking…" : "Mark as done"}
            </button>
            <button
              type="button"
              onClick={() => void act("stop")}
              disabled={busy !== null}
              data-testid="browser-checkpoint-stop"
              title="Stop waiting — the agent will report back and ask how to proceed"
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[11px] font-bold transition-colors disabled:opacity-60"
              style={{
                color: styles.textSecondary,
                background: "transparent",
                borderColor: styles.border,
              }}
            >
              <Square size={10} fill="currentColor" strokeWidth={0} aria-hidden />
              {busy === "stop" ? "Stopping…" : "Stop waiting"}
            </button>
            {error !== null ? (
              <span className="min-w-0 flex-1 truncate text-[10.5px]" style={{ color: AMBER }} title={error}>
                {error}
              </span>
            ) : null}
          </div>
        </>
      ) : (
        /* ── resolved: one honest closing line (no controls — the tool is
              already unblocked/returning) ────────────────────────────────── */
        <div className="px-3.5 pb-3 pt-0.5 flex items-center gap-2 min-w-0">
          <Clock size={12} className="shrink-0" style={{ color: styles.textTertiary }} aria-hidden />
          <p data-testid="browser-checkpoint-resolution" className="min-w-0 text-[11.5px] leading-snug" style={{ color: styles.textSecondary }}>
            {state === "done"
              ? "You marked it solved — the agent is re-checking the page and will continue."
              : state === "stop"
                ? "You stopped the wait — the agent will not retry the page and will ask how to proceed."
                : "The wait ran out while the wall was still up — the agent will tell you what is needed."}
          </p>
        </div>
      )}
    </motion.div>
  );
}
