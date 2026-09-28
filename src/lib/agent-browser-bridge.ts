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
// ROUND-124 (R124): the panel-INDEPENDENT staged capture — the module-level
// fallback for tabs with NO mounted panel (the owner in Settings: the route
// swap unmounts every BrowserPanel while the webview stays alive).
import {
  isNativeBrowserAvailable,
  nativeOpenDesk,
  nativeTabEval,
  POPOUT_TAB_ID,
} from "./native-browser";
// R132-CU2: the SHARED R94-F evalJob protocol (the same runner the panel's
// handler uses — the desk's content webview is driven through the identical
// job contract).
import { runEvalJobProtocol } from "./agent-browser-job";
import {
  parseCapturePayloadDims,
  performStagedBrowserCapture,
} from "./agent-browser-capture";

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
 *
 * ROUND-124 (R124): `screenshot_capture` is PANEL-INDEPENDENT — when no
 * handler is registered for the tab (the user is in Settings — the route
 * swap unmounts every BrowserPanel — or on another sidebar tab type), the
 * module-level staged capture answers directly through the native bridge:
 * the webview is still ALIVE (R87 keep-alive + the tab-close reaper only
 * destroy on tab close), so the stage → grab → restore choreography needs
 * nothing from the unmounted panel. This is the owner's ruling #3: "this
 * should also happen if the user is in some other application, is in the
 * settings of the program or something else, but the screenshot should
 * still be successfully taken as needed." Every OTHER action keeps the
 * honest no-panel refusal (eval needs the panel's webview-id scoping at best
 * and has no off-panel choreography — the pre-R124 behavior).
 */
export function dispatchBrowserCommand(frame: BrowserCommandFrame): void {
  const { commandId, tabId, action } = frame;
  const payload =
    frame.payload !== null && typeof frame.payload === "object" ? frame.payload : {};

  // ── R132-CU2: THE AGENT DESK ────────────────────────────────────────
  // open_desk is PANEL-INDEPENDENT (the desk is its own always-on-top
  // window — it needs nothing from any mounted panel), so it answers
  // BEFORE the handler lookup, exactly like the panel-independent capture
  // below. The URL + the project's download dir ride the payload from the
  // agent-core tool (the sidecar knows the bound project; the panel-less
  // intercept does not).
  if (action === "open_desk") {
    void (async () => {
      let reply: BrowserCommandReply;
      const url = typeof payload.url === "string" ? payload.url : "";
      if (url === "") {
        reply = { ok: false, error: "open_desk: the payload carried no url" };
      } else if (!isNativeBrowserAvailable()) {
        reply = {
          ok: false,
          error: "open_desk unavailable — the agent desk needs the desktop shell (not the web dev server)",
        };
      } else {
        const downloadDir = typeof payload.downloadDir === "string" && payload.downloadDir !== "" ? payload.downloadDir : null;
        try {
          await nativeOpenDesk(url, downloadDir);
          reply = { ok: true, data: { url } };
        } catch (err) {
          reply = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      try {
        await postBrowserCommandResult(commandId, reply);
      } catch (err) {
        warn(`result post failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return;
  }

  const handler = handlers.get(tabId);
  if (handler === undefined) {
    if (action === "screenshot_capture" && isNativeBrowserAvailable()) {
      void (async () => {
        let reply: BrowserCommandReply;
        try {
          // No mounted panel → the background-tab contract holds (the unmount
          // cleanup hides the webview), so expectVisible stays false: the
          // stage SHOWS the webview for the grab and the restore re-hides it.
          const result = await performStagedBrowserCapture(tabId, parseCapturePayloadDims(payload));
          reply = { ok: true, data: result };
        } catch (err) {
          reply = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        try {
          await postBrowserCommandResult(commandId, reply);
        } catch (err) {
          warn(`result post failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      return;
    }
    // ── R132-CU2: the DESK's content tab ──────────────────────────────
    // The 'popout' tab has NO panel ever (its webview is a child of the
    // pop-out/desk window, not the main window) — its page actions answer
    // through the NATIVE tab surface directly: the Rust side resolves the
    // webview by its globally-unique label, so nativeTabEval reaches the
    // desk's page from here. eval + evalJob (the shared R94-F runner) cover
    // every live-page action the tool sends (read_dom/source/click/type/
    // press_key/mouse ride eval or evalJob); the capture above already
    // covers screenshots; navigate rides the browser-navigate frame's own
    // popout leg in stream-store. A closed desk answers the native eval's
    // honest "no native webview for tab" error.
    if (tabId === POPOUT_TAB_ID && isNativeBrowserAvailable() && (action === "eval" || action === "evalJob")) {
      void (async () => {
        let reply: BrowserCommandReply;
        if (action === "eval") {
          const script = typeof payload.script === "string" ? payload.script : "";
          if (script === "") {
            reply = { ok: false, error: "eval: empty script" };
          } else {
            const result = await nativeTabEval(POPOUT_TAB_ID, script);
            reply =
              result === null
                ? { ok: false, error: "eval unavailable — the native browser bridge is not present" }
                : { ok: true, data: result };
          }
        } else {
          const script = typeof payload.script === "string" ? payload.script : "";
          const installScript = typeof payload.installScript === "string" ? payload.installScript : "";
          reply =
            script === ""
              ? { ok: false, error: "evalJob: empty script" }
              : await runEvalJobProtocol(POPOUT_TAB_ID, script, installScript);
        }
        try {
          await postBrowserCommandResult(commandId, reply);
        } catch (err) {
          warn(`result post failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      return;
    }
    void postBrowserCommandResult(commandId, {
      ok: false,
      error: `no embedded browser panel is mounted for tab '${tabId}' (the tab is closed, inactive, or running outside the desktop app)`,
    }).catch((err: unknown) => warn(`result post failed: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }
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
