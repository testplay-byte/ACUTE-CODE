import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isTauri, getSidecarInfo } from "./sidecar";

/**
 * Runtime connection config for the agent-core sidecar REST API.
 *
 * In production the Tauri shell hands {port, token} to the webview in memory
 * (sidecar_endpoint command); the token is deliberately NOT persisted — it is
 * an ephemeral bearer minted per sidecar spawn, and nothing secret belongs in
 * localStorage. Dev fallbacks come from VITE_ACUTE_TOKEN / VITE_ACUTE_BASE_URL.
 */
interface ConfigState {
  /** Sidecar REST base URL, no trailing slash; loopback only. */
  baseUrl: string;
  /** Bearer token; null until the shell provides one (or dev env sets it). */
  token: string | null;
  /** Use the in-memory fixture adapter instead of HTTP (sidecar not running). */
  demoData: boolean;
  setBaseUrl: (url: string) => void;
  setToken: (token: string | null) => void;
  setDemoData: (on: boolean) => void;
  /** Shell handoff: adopt a freshly spawned sidecar endpoint wholesale. */
  adoptEndpoint: (endpoint: { port: number; token: string }) => void;
}

const env = import.meta.env as Record<string, string | undefined>;

export const useConfigStore = create<ConfigState>()(
  persist(
    (set) => ({
      baseUrl: env.VITE_ACUTE_BASE_URL ?? "http://127.0.0.1:5178",
      token: env.VITE_ACUTE_TOKEN ?? null,
      // Defaults on: the sidecar lands in a parallel workstream, so the UI must
      // be usable before it exists. Flipped off from Settings once it does.
      demoData: true,
      setBaseUrl: (baseUrl) => set({ baseUrl: baseUrl.replace(/\/+$/, "") }),
      setToken: (token) => set({ token }),
      setDemoData: (demoData) => set({ demoData }),
      adoptEndpoint: ({ port, token }) =>
        set({ baseUrl: `http://127.0.0.1:${port}`, token, demoData: false }),
    }),
    {
      name: "acute-code.config",
      version: 1,
      partialize: (s) => ({ baseUrl: s.baseUrl, demoData: s.demoData }),
      // Explicit dev wiring (VITE_ACUTE_BASE_URL / VITE_ACUTE_TOKEN on the
      // vite process) outranks stale persisted values from earlier sessions —
      // otherwise a leftover localStorage baseUrl points the UI at a dead
      // port no matter how the dev server was started.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<ConfigState>;
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

// Shell handoff (§2.3): adopt the shell-spawned sidecar endpoint as soon as
// the command answers — adoptEndpoint flips demoData off. Browser dev without
// env vars resolves to null and keeps the defaults above.
if (isTauri()) {
  void getSidecarInfo().then((info) => {
    if (info) useConfigStore.getState().adoptEndpoint(info);
  });
}
