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
