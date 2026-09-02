/**
 * ROUND-64 (R64-b) — the mini monitor's OWN tiny REST client.
 *
 * Deliberately NOT lib/api.ts: the mini page is a standalone vite entry
 * (mini.html → src/mini/main.tsx) whose bundle must stay small and
 * independent of the main app's api module (which drags the config store,
 * the error bus and every endpoint in). This replicates ONLY the ~20 lines
 * the monitor needs, pinned by MiniApp.test.tsx:
 *
 *   - GET  http://127.0.0.1:{port}/api/v1/computer-use/session  (poll)
 *   - POST http://127.0.0.1:{port}/api/v1/computer-use/stop      (kill switch)
 *
 * …both with `Authorization: Bearer {token}` — the same URL/headers
 * fetchComputerUseSession/stopComputerUse build in lib/api.ts (read-only
 * reference; do not import it here). The {port, token} pair comes from
 * getSidecarInfo() (lib/sidecar — the Rust shell's sidecar_info command).
 */

import type { SidecarInfo } from "../lib/sidecar";

/** One monitor-ring event from the control session (computer/session.ts —
 * the same wire shape as api.ts's ComputerUseEventRow). */
export interface MiniSessionEvent {
  seq: number;
  ts: number;
  kind: string;
  label: string;
  tool?: string;
}

/** GET /computer-use/session — the authoritative monitor truth. */
export interface MiniSessionState {
  active: boolean;
  killSwitch: boolean;
  backendKind: string;
  startedAt: number | null;
  stopReason: string | null;
  stats: {
    startedAt: number;
    actionsSent: number;
    actionsRefused: number;
    observations: number;
    visionCalls: number;
  };
  /** Newest-first ring (the same order the panel/mini window rendered). */
  events: MiniSessionEvent[];
}

/** The one error type this client raises (kept local + tiny). */
export class MiniClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MiniClientError";
  }
}

/** The base URL every mini call composes — `{scheme}://127.0.0.1:{port}`. */
export function miniBaseUrl(info: SidecarInfo): string {
  return `http://127.0.0.1:${info.port}`;
}

/**
 * One GET /computer-use/session poll. Null on ANY failure (network down,
 * non-2xx, bad JSON): a monitor must never crash its window over a lost
 * packet — the caller keeps the last good state and keeps polling.
 */
export async function fetchMiniSession(info: SidecarInfo): Promise<MiniSessionState | null> {
  try {
    const res = await fetch(
      `${miniBaseUrl(info)}/api/v1/computer-use/session`,
      { headers: { Authorization: `Bearer ${info.token}` } },
    );
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as { active?: unknown }).active !== "boolean"
    ) {
      return null;
    }
    return body as MiniSessionState;
  } catch {
    return null;
  }
}

/**
 * POST /computer-use/stop — the STOP kill switch, with the reason the
 * engine records on the session (honest provenance for the audit trail).
 * Throws MiniClientError on failure so the UI can keep the button armed
 * and surface the honest message.
 */
export async function stopMiniSession(info: SidecarInfo, reason: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${miniBaseUrl(info)}/api/v1/computer-use/stop`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${info.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason }),
    });
  } catch (cause) {
    throw new MiniClientError(
      `Could not reach agent-core at ${miniBaseUrl(info)} (${String(cause)})`,
    );
  }
  if (!res.ok) {
    throw new MiniClientError(`Stop failed with HTTP ${res.status}`);
  }
}
