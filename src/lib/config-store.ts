import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isTauri } from "./sidecar";

/**
 * Runtime connection config for the agent-core sidecar REST API.
 *
 * In production the Tauri shell hands {port, token} to the webview in memory
 * (sidecar_info command); the token is deliberately NOT persisted — it is
 * an ephemeral bearer minted per sidecar spawn, and nothing secret belongs in
 * localStorage. Dev fallbacks come from VITE_ACUTE_TOKEN / VITE_ACUTE_BASE_URL.
 *
 * ROUND-53 (R53) — THE STALE-PORT FIX. The sidecar binds an EPHEMERAL port
 * every launch, so persisting `baseUrl` wrote a previous session's port into
 * localStorage; the next boot rehydrated it (with demoData already false) and
 * every request died with "Could not reach agent-core at http://127.0.0.1:PORT
 * (TypeError: Failed to fetch)" — the owner's first-run report. Inside Tauri
 * NOTHING is persisted anymore: each boot starts from the safe defaults and
 * the connect loop (./sidecar-connection.ts) adopts the live endpoint. Only
 * browser dev keeps persisting (its baseUrl is a stable dev port, not an
 * ephemeral one), and even there a stale persisted value can never outrank
 * explicit VITE_ACUTE_* env wiring.
 *
 * R53 also adds the connection state machine the UI gates rendering on:
 * "connecting" (splash — no queries fire against a stale endpoint),
 * "connected" (live), "offline" (banner + Retry; carries the shell-reported
 * sidecar error when there is one).
 */

export type ConnectionPhase = "connecting" | "connected" | "offline";

/**
 * ROUND-101 (R101-B): the update-restart contract.
 *
 * The owner's v0.98.0 report: clicking Install on an update killed the
 * sidecar (the R96-I pre-install contract), the 20s watchdog noticed the
 * deliberately-dead backend, and the whole UI was replaced by the offline
 * error screen ("Can't reach agent-core … didn't come up") for the seconds
 * before the app exited — reading exactly like "the environment crashed".
 *
 * `updateInFlight` says: an update install has begun, the sidecar's death
 * is DELIBERATE, and this process is about to exit. Consumers:
 *   · sidecar-connection.ts — the watchdog and connect loop suppress the
 *     offline flip (no error screen, no reconnect storm against a backend
 *     that was killed on purpose);
 *   · ConnectionGate — renders the calm Restarting splash instead of the
 *     app tree, so no query/banner can surface an error mid-update;
 *   · AboutTab — sets it before invoking run_update_installer and CLEARS
 *     it (plus auto-restarts the engine) if the launch is rejected, so a
 *     failed install never strands the owner on a dead engine.
 *
 * `version` rides along so the splash can say "Restarting into v0.99.0";
 * null keeps the generic line. Deliberately NOT persisted anywhere — it
 * describes THIS process's final seconds, never a future session.
 */
export interface UpdateInFlight {
  version: string | null;
  /** ROUND-123 (R123): true once the shell's `update-overlay` event says a
   * WATCHED install leg is live (the Windows overlay / the Linux .deb
   * watcher) — the Restarting splash's subline switches from "the window
   * will close for a moment" (the /S /R fallback's truth) to "this window
   * stays open while it installs" (the overlay's truth). Absent/false on
   * the fallback path. */
  overlay?: boolean;
}

interface ConfigState {
  /** Sidecar REST base URL, no trailing slash; loopback only. */
  baseUrl: string;
  /** Bearer token; null until the shell provides one (or dev env sets it). */
  token: string | null;
  /** Use the in-memory fixture adapter instead of HTTP (sidecar not running). */
  demoData: boolean;
  /** R53: connection gate for the Tauri webview ("connected" in browser dev). */
  connection: ConnectionPhase;
  /** R53: the shell-reported failure when connection === "offline". */
  connectionError: string | null;
  /** R101-B: non-null while an update install is in flight (see UpdateInFlight). */
  updateInFlight: UpdateInFlight | null;
  setUpdateInFlight: (update: UpdateInFlight | null) => void;
  /** ROUND-123 (R123): non-null when a WATCHED install leg (the Windows
   * overlay / the Linux .deb watcher) reports the install DONE — the
   * Restarting splash swaps its line to "installed — restarting now" for
   * the last visible moment before the Rust side relaunches + exits. The
   * flag is set by ConnectionGate's event listener and read by the splash;
   * it is deliberately process-local (like updateInFlight — it describes
   * this process's final seconds). */
  updateInstalled: boolean;
  setUpdateInstalled: (installed: boolean) => void;
  /** ROUND-123 (R123): non-null when a WATCHED install leg reports FAILURE
   * — the watcher emitted `update-install-failed` (payload: the honest
   * message), the flag + message are set by ConnectionGate's listener, and
   * AboutTab reads them to flip its install card to the honest error state
   * while the recovery restarts the engine. Cleared when a new install
   * attempt starts (AboutTab) or on the flag's own read (one-shot surface). */
  updateInstallError: string | null;
  setUpdateInstallError: (message: string | null) => void;
  setBaseUrl: (url: string) => void;
  setToken: (token: string | null) => void;
  setDemoData: (on: boolean) => void;
  /** Shell handoff: adopt a freshly spawned sidecar endpoint wholesale. */
  adoptEndpoint: (endpoint: { port: number; token: string }) => void;
  setConnection: (phase: ConnectionPhase, error?: string | null) => void;
}

const env = import.meta.env as Record<string, string | undefined>;

export const useConfigStore = create<ConfigState>()(
  persist(
    (set) => ({
      // `||` (not `??`): an empty-string env var is a misconfiguration, not
      // a valid endpoint — fall through to the safe default.
      baseUrl: env.VITE_ACUTE_BASE_URL || "http://127.0.0.1:5178",
      token: env.VITE_ACUTE_TOKEN ?? null,
      // Defaults on: the sidecar lands in a parallel workstream, so the UI must
      // be usable before it exists. Flipped off from Settings once it does.
      demoData: true,
      // Browser dev is "connected" immediately (env vars or the demo fallback
      // decide liveness); inside Tauri the connect loop drives this.
      connection: isTauri() ? "connecting" : "connected",
      connectionError: null,
      updateInFlight: null,
      setUpdateInFlight: (updateInFlight) => set({ updateInFlight }),
      // R123: the watched-install legs' flags (see the interface comments).
      updateInstalled: false,
      setUpdateInstalled: (updateInstalled) => set({ updateInstalled }),
      updateInstallError: null,
      setUpdateInstallError: (updateInstallError) => set({ updateInstallError }),
      setBaseUrl: (baseUrl) => set({ baseUrl: baseUrl.replace(/\/+$/, "") }),
      setToken: (token) => set({ token }),
      setDemoData: (demoData) => set({ demoData }),
      adoptEndpoint: ({ port, token }) =>
        set({ baseUrl: `http://127.0.0.1:${port}`, token, demoData: false }),
      setConnection: (connection, connectionError = null) => set({ connection, connectionError }),
    }),
    {
      name: "acute-code.config",
      version: 2,
      // R53: inside Tauri NOTHING is persisted — the ephemeral port + demoData
      // pair from a previous session is exactly the stale-endpoint bug. The
      // browser keeps the old behavior (stable dev baseUrl).
      partialize: (s) =>
        isTauri()
          ? {}
          : { baseUrl: s.baseUrl, demoData: s.demoData },
      // Explicit dev wiring (VITE_ACUTE_BASE_URL / VITE_ACUTE_TOKEN on the
      // vite process) outranks stale persisted values from earlier sessions —
      // otherwise a leftover localStorage baseUrl points the UI at a dead
      // port no matter how the dev server was started. And in Tauri mode the
      // persisted blob is dropped entirely (v2 stores may still hold a v1
      // baseUrl from pre-R53 installs — the merge guard retires it).
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<ConfigState>;
        if (isTauri()) {
          return { ...current };
        }
        const envOverride: Partial<ConfigState> = {};
        if (env.VITE_ACUTE_BASE_URL) {
          envOverride.baseUrl = env.VITE_ACUTE_BASE_URL;
          envOverride.demoData = false;
        }
        if (env.VITE_ACUTE_TOKEN) envOverride.token = env.VITE_ACUTE_TOKEN;
        return { ...current, ...p, ...envOverride };
      },
    },
  ),
);
