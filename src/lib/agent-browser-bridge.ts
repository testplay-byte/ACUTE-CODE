/**
 * ROUND-62 (D8, owner: "the ai agent can interact with the right sidebar
 * browser — navigate it, screenshot it, use it and such") — the FRONTEND side
 * of the live browser-command bridge.
 *
 * The browser_control tool (agent-core) emits a `browser-command` frame on
 * the turn's SSE stream (stream-store intercepts it and calls
 * dispatchBrowserCommand). The ONLY place that can actually act on the live
 * page is THIS app: the native WebView2 child webviews belong to the Tauri
 * shell, not the sidecar. This module:
 *
 *   · keeps a HANDLER REGISTRY: the mounted BrowserPanel (native mode)
 *     registers itself per tab — it owns the webview id + the placeholder
 *     rect + the window metrics needed for a screenshot region;
 *   · dispatches incoming frames to the right handler (or answers
 *     immediately with an honest error when no panel is mounted — the tool
 *     then fails fast instead of burning its 15s timeout);
 *   · POSTs the result back to agent-core (api.postBrowserCommandResult →
 *     POST /browser-commands/:commandId/result), resolving the pending tool
 *     promise.
 *
 * Web dev mode / proxy-rendered tabs: no native webview → the handler answers
 * {ok:false} with the honest reason (eval is native-only). Everything here is
 * transient module state — nothing persists.
 */
import { postBrowserCommandResult } from "./api";

/** The SSE frame shape (api.ts StreamTurnEvent "browser-command" variant). */
export interface BrowserCommandFrame {
  type: "browser-command";
  commandId: string;
  tabId: string;
  action: string;
  payload?: Record<string, unknown>;
}

/** A handler's answer — posted verbatim as the REST result body. */
export interface BrowserCommandReply {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** What the BrowserPanel registers: (action, payload) → reply. */
export type BrowserCommandHandler = (
  action: string,
  payload: Record<string, unknown>,
) => Promise<BrowserCommandReply> | BrowserCommandReply;

const handlers = new Map<string, BrowserCommandHandler>();

/**
 * Register the mounted panel's handler for its tab (native mode). Returns
 * the unregister fn — the panel's unmount must always call it so a stale
 * handler can never answer for a gone webview.
 */
export function registerBrowserCommandHandler(tabId: string, handler: BrowserCommandHandler): () => void {
  handlers.set(tabId, handler);
  return () => {
    // Only delete OUR handler — a newer mount may have replaced it already.
    if (handlers.get(tabId) === handler) handlers.delete(tabId);
  };
}

/** Test/inspection hook: is a handler registered for this tab? */
export function hasBrowserCommandHandler(tabId: string): boolean {
  return handlers.has(tabId);
}

/** Test hook: drop every handler. */
export function clearBrowserCommandHandlersForTest(): void {
  handlers.clear();
}

/** Test hook: the registered handler for a tab (undefined when none). */
export function getBrowserCommandHandlerForTest(tabId: string): BrowserCommandHandler | undefined {
  return handlers.get(tabId);
}

function warn(reason: string): void {
  console.warn("[agent-browser-bridge]", reason);
}

/**
 * Dispatch one SSE browser-command frame: run the tab's handler and POST the
 * reply. Never throws (a failed POST leaves the tool to its timeout — the
 * command is already lost, the UI can't do better).
 */
export function dispatchBrowserCommand(frame: BrowserCommandFrame): void {
  const { commandId, tabId, action } = frame;
  const handler = handlers.get(tabId);
  if (handler === undefined) {
    void postBrowserCommandResult(commandId, {
      ok: false,
      error: `no embedded browser panel is mounted for tab '${tabId}' (the tab is closed, inactive, or running outside the desktop app)`,
    }).catch((err: unknown) => warn(`result post failed: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }
  const payload =
    frame.payload !== null && typeof frame.payload === "object" ? frame.payload : {};
  void (async () => {
    let reply: BrowserCommandReply;
    try {
      reply = await handler(action, payload);
    } catch (err) {
      reply = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    try {
      await postBrowserCommandResult(commandId, reply);
    } catch (err) {
      warn(`result post failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
}
