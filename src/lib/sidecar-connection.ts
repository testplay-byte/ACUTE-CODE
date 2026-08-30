/**
 * ROUND-53 (R53): the sidecar connect loop.
 *
 * The owner's first run of the packaged app never reached agent-core:
 * `sidecar_info` was invoked exactly ONCE at webview boot, racing the Rust
 * handshake (which used to block `setup` for up to 25s) — and losing that
 * race left the UI pointed at a previous session's persisted dead port for
 * the entire session. This module replaces the one-shot with a poll loop and
 * the connection state machine the UI gates rendering on:
 *
 *   connecting → sidecar_info every 400ms (deadline 90s — cold first boot
 *                runs SQLite migrations); sidecar_status "failed" fails fast
 *                with the shell-reported error.
 *   connected  → adopt {port, token}, invalidate EVERY query (stale-endpoint
 *                errors must not linger), start the mid-session watchdog.
 *   offline    → banner + Retry; retryConnection() restarts the backend via
 *                the restart_sidecar shell command when it crashed.
 *
 * Browser dev never enters the loop (no __TAURI__): connection is
 * "connected" from the start, exactly the pre-R53 behavior.
 */

import { useConfigStore } from "./config-store";
import { getQueryClient } from "./query-client";
import {
  getSidecarInfo,
  getSidecarStatus,
  isTauri,
  pingSidecar,
  restartSidecar,
} from "./sidecar";

/** Poll cadence while the shell handshake is in flight. */
const POLL_INTERVAL_MS = 400;
/** Generous deadline: a cold first boot runs SQLite migrations inside node. */
const CONNECT_TIMEOUT_MS = 90_000;
/** Mid-session liveness cadence once connected. */
const WATCHDOG_INTERVAL_MS = 20_000;

let generation = 0;

/** Invalidate every query so pre-adoption failures (stale endpoint) refetch. */
function invalidateAllQueries(): void {
  getQueryClient()?.invalidateQueries();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The connect loop proper. `gen` cancels superseded runs (retry, watchdog
 * re-entry, StrictMode double-mount). Resolves when the phase is decided.
 */
async function connectLoop(gen: number): Promise<void> {
  const { setConnection, adoptEndpoint } = useConfigStore.getState();
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  setConnection("connecting");

  while (gen === generation) {
    const info = await getSidecarInfo();
    if (gen !== generation) return;

    if (info) {
      adoptEndpoint(info);
      setConnection("connected");
      invalidateAllQueries();
      startWatchdog(gen);
      return;
    }

    // sidecar_info refused — ask the shell WHY before burning the deadline.
    const status = await getSidecarStatus();
    if (gen !== generation) return;
    if (status && (status.phase === "failed" || status.phase === "stopped")) {
      const error =
        status.phase === "failed"
          ? status.error
          : "agent-core stopped — restart it from the app";
      setConnection("offline", error);
      return;
    }
    // "starting" (or an unanswered status) → keep polling.

    if (Date.now() >= deadline) {
      setConnection(
        "offline",
        `agent-core did not become ready within ${Math.round(CONNECT_TIMEOUT_MS / 1000)}s — ` +
          "check sidecar.log in the app's data folder and retry",
      );
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Mid-session watchdog: ping every 20s; a dead backend flips the app to
 * connecting → the loop either reconnects (transient blip) or lands on
 * offline with the shell's exit reason + the Restart button.
 */
function startWatchdog(gen: number): void {
  const timer = setInterval(async () => {
    if (gen !== generation) {
      clearInterval(timer);
      return;
    }
    const alive = await pingSidecar();
    if (gen !== generation) {
      clearInterval(timer);
      return;
    }
    if (!alive) {
      clearInterval(timer);
      // Re-enter the loop: bump generation so any stale loop/watchdog dies.
      generation += 1;
      void connectLoop(generation);
    }
  }, WATCHDOG_INTERVAL_MS);
}

/** App boot entry: connects inside Tauri, no-ops in a plain browser. */
export function beginSidecarConnect(): void {
  if (!isTauri()) return;
  generation += 1;
  void connectLoop(generation);
}

/**
 * The offline banner's Retry: restart the backend through the shell (teardown
 * + fresh handshake — covers crashed AND stopped sidecars) and poll again.
 * Falls back to a plain re-poll when the restart command is unavailable.
 */
export async function retryConnection(): Promise<void> {
  if (!isTauri()) return;
  // Immediate feedback — the shell command itself can take ~3s of teardown.
  useConfigStore.getState().setConnection("connecting", null);
  await restartSidecar();
  generation += 1;
  await connectLoop(generation);
}

/** Test seam: forget superseded loops. */
export function __resetConnectionLoopForTests(): void {
  generation += 1;
}
