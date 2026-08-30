/**
 * Sidecar endpoint resolution (ARCHITECTURE.md §2.1 step 6): inside Tauri the
 * Rust shell owns the sidecar lifecycle and reports `{port, token}` via the
 * `sidecar_info` command; in a plain browser (Vite dev server) the endpoint
 * falls back to VITE_ACUTE_PORT / VITE_ACUTE_TOKEN. Resolves to null when
 * neither is available (browser dev without env vars).
 *
 * ROUND-53 (R53): `sidecar_info` is now answered only once the sidecar is
 * actually Running (the Rust handshake runs on a background thread) — callers
 * must RETRY, not one-shot. The connect loop lives in ./sidecar-connection.ts;
 * this module stays the thin typed wrapper over the four shell commands:
 * sidecar_info, sidecar_status, restart_sidecar, ping_sidecar.
 */

export interface SidecarInfo {
  port: number;
  token: string;
}

/** R53: `sidecar_status` wire shape — `tag = "phase"` on the Rust enum. */
export type SidecarStatus =
  | { phase: "starting" }
  | { phase: "running"; port: number }
  | { phase: "failed"; error: string }
  | { phase: "stopped" };

/** R54: `sidecar_log_tail` wire shape — the offline screen's in-app view of
 * sidecar.log (last lines, oldest first) + the file's absolute path. */
export interface SidecarLogTail {
  path: string;
  lines: string[];
}

type TauriGlobal = {
  core: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
};

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

function tauri(): TauriGlobal | null {
  if (typeof window === "undefined") return null;
  return (window as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const shell = tauri();
  if (!shell) throw new Error("Tauri shell unavailable");
  return shell.core.invoke(command, args) as Promise<T>;
}

export async function getSidecarInfo(): Promise<SidecarInfo | null> {
  if (isTauri()) {
    try {
      // window.__TAURI__ comes from `withGlobalTauri` in tauri.conf.json —
      // saves an @tauri-apps/api dependency for this single call.
      return await invoke<SidecarInfo>("sidecar_info");
    } catch {
      // Not Running yet (Starting/Failed/Stopped) — the connect loop in
      // sidecar-connection.ts retries and reads sidecar_status for the why.
      return null;
    }
  }
  const env = import.meta.env as Record<string, string | undefined>;
  if (env.VITE_ACUTE_PORT && env.VITE_ACUTE_TOKEN) {
    return { port: Number(env.VITE_ACUTE_PORT), token: env.VITE_ACUTE_TOKEN };
  }
  return null;
}

/** R53: lifecycle phase + the REAL startup error (packaged-app diagnostics). */
export async function getSidecarStatus(): Promise<SidecarStatus | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<SidecarStatus>("sidecar_status");
  } catch {
    return null;
  }
}

/** R53: full backend restart (teardown → handshake). Resolves when asked. */
export async function restartSidecar(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await invoke<string>("restart_sidecar");
    return true;
  } catch {
    return false;
  }
}

/** One `/health` round-trip through the shell (never CORS-visible to pages). */
export async function pingSidecar(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await invoke<string>("ping_sidecar");
    return true;
  } catch {
    return false;
  }
}

/**
 * R54: the last lines of sidecar.log, served by the shell — the offline
 * screen renders them in-app so the owner never has to find %APPDATA% by
 * hand. Null outside Tauri / on shell refusal (the caller falls back to the
 * plain "check sidecar.log" note).
 */
export async function getSidecarLogTail(lines = 60): Promise<SidecarLogTail | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<SidecarLogTail>("sidecar_log_tail", { lines });
  } catch {
    return null;
  }
}
