/**
 * Sidecar endpoint resolution (ARCHITECTURE.md §2.1 step 6): inside Tauri the
 * Rust shell owns the sidecar lifecycle and reports `{port, token}` via the
 * `sidecar_info` command; in a plain browser (Vite dev server) the endpoint
 * falls back to VITE_ACUTE_PORT / VITE_ACUTE_TOKEN. Resolves to null when
 * neither is available (browser dev without env vars).
 */

export interface SidecarInfo {
  port: number;
  token: string;
}

type TauriGlobal = {
  core: { invoke: (command: string) => Promise<SidecarInfo> };
};

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

export async function getSidecarInfo(): Promise<SidecarInfo | null> {
  if (isTauri()) {
    try {
      // window.__TAURI__ comes from `withGlobalTauri` in tauri.conf.json —
      // saves an @tauri-apps/api dependency for this single call.
      const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__;
      return tauri ? await tauri.core.invoke("sidecar_info") : null;
    } catch {
      // Sidecar never became ready; the UI keeps its demo-data fallback.
      return null;
    }
  }
  const env = import.meta.env as Record<string, string | undefined>;
  if (env.VITE_ACUTE_PORT && env.VITE_ACUTE_TOKEN) {
    return { port: Number(env.VITE_ACUTE_PORT), token: env.VITE_ACUTE_TOKEN };
  }
  return null;
}
