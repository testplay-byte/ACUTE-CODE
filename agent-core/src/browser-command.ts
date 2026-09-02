/**
 * ROUND-62 (D8, owner: "the ai agent can interact with the right sidebar
 * browser — navigate it, screenshot it, use it") — the LIVE BROWSER COMMAND
 * BRIDGE.
 *
 * The embedded browser's native renderer (WebView2 child webviews) lives in
 * the FRONTEND (the Tauri shell); the agent's tools run in this sidecar.
 * Actions that need the REAL page — running JavaScript inside it (click,
 * type, read the DOM), or capturing its on-screen rectangle for a
 * screenshot — therefore need a round trip:
 *
 *   tool (agent-core)                         frontend (Tauri shell)
 *   ─────────────────────────────             ─────────────────────────────
 *   sendBrowserCommand(emit, tabId,  ──SSE──▶ stream-store intercept
 *   "eval", {script})                         → agent-browser-bridge dispatch
 *                                             → nativeTabEval (Rust command)
 *   promise pends on this map     ◀──REST──── POST /browser-commands/:id/result
 *                                             (api.postBrowserCommandResult)
 *
 * The SSE frame rides the CURRENT turn's stream (`ToolDeps.emit` — the same
 * channel the computer-use monitor frames use), so it exists exactly when a
 * streamed agent turn is running — which is the only time a tool can be
 * executing anyway. The REST result route is bearer-authed like every other
 * sidecar route (see browser-proxy.ts registerBrowserRoutes).
 *
 * TIMEOUTS are the failure story: a frontend that never answers (web dev
 * mode, no panel mounted, page wedged) rejects the tool promise honestly
 * instead of hanging the turn. No polling — one pending map, one resolve.
 */

/** One live bridge command. */
export interface PendingBrowserCommand {
  commandId: string;
  tabId: string;
  action: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
}

/** Default wait before a command is declared lost (the panel's eval itself
 * has a shorter internal timeout; this covers the whole round trip). */
export const BROWSER_COMMAND_TIMEOUT_MS = 15_000;

const pending = new Map<string, PendingBrowserCommand>();

let commandCounter = 0;
function nextCommandId(): string {
  commandCounter += 1;
  return `bcmd_${Date.now().toString(36)}_${commandCounter.toString(36)}`;
}

/** The SSE frame the frontend intercepts (StreamTurnEvent "browser-command"). */
export interface BrowserCommandFrame {
  type: "browser-command";
  commandId: string;
  tabId: string;
  action: string;
  payload: Record<string, unknown>;
}

/**
 * Send a command to the live frontend and await its result. `emit` is the
 * turn's SSE emitter (ToolDeps.emit) — without it there is no live UI to
 * talk to and the caller should fail closed BEFORE calling this.
 */
export function sendBrowserCommand(
  emit: (event: unknown) => void,
  tabId: string,
  action: string,
  payload: Record<string, unknown> = {},
  timeoutMs: number = BROWSER_COMMAND_TIMEOUT_MS,
): Promise<unknown> {
  const commandId = nextCommandId();
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      const entry = pending.get(commandId);
      if (entry === undefined) return;
      pending.delete(commandId);
      entry.reject(
        new Error(
          `browser command '${action}' timed out after ${Math.round(timeoutMs / 1000)}s — the app UI did not answer (no embedded browser panel mounted, or the page is unresponsive)`,
        ),
      );
    }, timeoutMs);
    pending.set(commandId, { commandId, tabId, action, startedAt: Date.now(), timer, resolve, reject });
    const frame: BrowserCommandFrame = { type: "browser-command", commandId, tabId, action, payload };
    try {
      emit(frame);
    } catch (error) {
      clearTimeout(timer);
      pending.delete(commandId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** The REST result body shape the frontend POSTs back. */
export interface BrowserCommandResultBody {
  ok?: unknown;
  data?: unknown;
  error?: unknown;
}

/**
 * Resolve a pending command (POST /browser-commands/:commandId/result).
 * Returns false when the command is unknown/expired (route answers 404 —
 * the frontend treats that as fire-and-forget).
 */
export function resolveBrowserCommand(commandId: string, body: BrowserCommandResultBody): boolean {
  const entry = pending.get(commandId);
  if (entry === undefined) return false;
  pending.delete(commandId);
  clearTimeout(entry.timer);
  if (body.ok === true) {
    entry.resolve(body.data);
  } else {
    const message =
      typeof body.error === "string" && body.error !== ""
        ? body.error
        : "the app UI reported a failure for this browser command";
    entry.reject(new Error(message));
  }
  return true;
}

/** Test/inspection hook: how many commands are in flight. */
export function pendingBrowserCommandCount(): number {
  return pending.size;
}

/** Test hook: drop everything in flight (rejects each pending promise). */
export function resetBrowserCommandsForTest(): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error("browser commands reset for test"));
  }
  pending.clear();
}
