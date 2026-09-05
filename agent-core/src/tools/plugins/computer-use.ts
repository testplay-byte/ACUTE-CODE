/**
 * ROUND-61 (R61): the COMPUTER-USE plugin — the 30 tools of the uploaded
 * spec (computer-use-docs 02-tool-reference.md) + find_elements (R66-2-d,
 * the Edge fix: search the a11y tree by name instead of ingesting it),
 * behind the settings master switch (computerUse.enabled — default OFF;
 * the owner's "option to turn on and off" directive), shaped by:
 *
 *   · the POSTURE (computerUse.permission): "observe" registers READ-ONLY
 *     tools (the dispatcher's mutation gate refuses the rest even if an
 *     allowlisted name is called); "act"/"auto" register everything, with
 *     the approval channel riding the ask-mode consent gate below.
 *   · the CONSENT GATE: in "act" posture + ask permission-mode, the
 *     REAL-INPUT risk classes (typing, keys, clipboard writes, drags,
 *     coordinate/raw clicks, activation) ride the SAME approval flow as
 *     run_command (approval row + waiter + toast); "auto" posture or full
 *     permission-mode auto-approve. Element presses (background-safe) and
 *     observations never prompt.
 *   · the VISION relay: screenshot/zoom accept {describe, instruction} —
 *     read from the GLOBAL vision settings (R66: Settings → Image
 *     Analysis); mode "separate" describes through the dedicated vision
 *     model (provider+model+key configured independently); "main" through
 *     the turn's model when its row has supports_vision; "off" returns the
 *     raster metadata with an honest vision-disabled note.
 *   · the MONITOR: every dispatch records into the session ring (the
 *     owner's mini-window reads GET /computer-use/session); intents also
 *     ride the turn SSE as {type:"computer-use"} envelopes.
 *
 * createTools returns [] when: no toolDeps (bare/test builds — fail-closed:
 * no db, no settings), the master switch is off, or the plugin context has
 * no root. One dispatcher per createTools call, riding the process-singleton
 * session.
 */
import { jsonSchema } from "ai";
import type { PluginDefinition, ToolDefinition } from "../registry.js";
import { getComputerUseSettings } from "../../storage/computer-use.js";
// R66-2-b (owner B3+B5): the vision settings moved OUT of computer use —
// the relay below reads the GLOBAL vision configuration (Settings → Image
// Analysis: vision.mode/provider/modelId) so computer-use screenshots, the
// embedded-browser screenshots and the general analyze_image tool all share
// ONE configuration and ONE honest failure story.
import { getVisionSettings, visionKeyringId } from "../../storage/vision.js";
// R62 (D8): the live-engine handshake — the browser plugin's screenshot
// action borrows this turn's backend + run + session for screen-region
// captures of the embedded browser panel.
import { setActiveComputerRelay } from "./computer-relay.js";
import { listModels } from "../../storage/models.js";
import { backendForPlatform, realRunner } from "../../computer/backends/index.js";
import { ComputerDispatcher } from "../../computer/dispatch.js";
import { getComputerSession } from "../../computer/session.js";
import { describeRaster } from "../../computer/vision.js";
// ROUND-67 (R67-D): the live chat THUMBNAILS — successful captures are
// copied into the route-served raster registry (in-memory, LRU, TTL) and
// announced over the SSE-only channel as {type:"screenshot"} frames.
import { registerRaster } from "../../computer/raster-cache.js";
import { buildApprovalDeps } from "../approval-deps.js";
import { requestCommandApproval } from "../../approvals.js";
import type { ToolResult } from "../registry.js";

/* ── result shaping ───────────────────────────────────────────────────────── */

function dataResult(data: Record<string, unknown>): ToolResult {
  return { ok: true, output: JSON.stringify(data) };
}

function refusalResult(refusal: { error: string; message: string; recovery?: string; payload?: Record<string, unknown> }): ToolResult {
  return { ok: false, output: JSON.stringify(refusal) };
}

function receiptResult(receipt: { actionSent: boolean; dispatchStatus: string; retryAction?: boolean; targetVerificationStatus?: string }, extra?: Record<string, unknown>): ToolResult {
  return dataResult({ action_receipt: receipt, ...extra });
}

/* ── the consent gate (ask-mode risk classes) ─────────────────────────────── */

/** Tool names that move the REAL pointer/keyboard or leave the app. */
const CONSENT_TOOLS = new Set([
  "type", "key", "hold_key", "write_clipboard",
  "left_click_drag", "left_mouse_down", "left_mouse_up",
]);

/** Coordinate-target clicks are raw — consent only when NOT an element press. */
function needsConsent(tool: string, args: Record<string, unknown>): boolean {
  if (CONSENT_TOOLS.has(tool)) return true;
  if (tool === "left_click" || tool === "right_click" || tool === "double_click" || tool === "triple_click" || tool === "middle_click" || tool === "scroll" || tool === "mouse_move") {
    const target = args["target"];
    return !(typeof target === "object" && target !== null && (target as Record<string, unknown>)["type"] === "element");
  }
  if (tool === "open_application") return args["activate"] === true;
  return false;
}

/* ── schema helpers (doc 02 shapes) ───────────────────────────────────────── */

const targetSchema = (description: string) => ({
  anyOf: [
    {
      type: "object",
      properties: {
        type: { type: "string", const: "element" },
        stateId: { type: "string", description: "state_id from get_app_state" },
        index: { type: "integer", description: "element index in that snapshot" },
      },
      required: ["type", "stateId", "index"],
    },
    {
      type: "object",
      properties: {
        type: { type: "string", const: "coordinate" },
        x: { type: "integer", description: "x in image pixels of the LATEST returned raster" },
        y: { type: "integer", description: "y in image pixels of the LATEST returned raster" },
      },
      required: ["type", "x", "y"],
    },
  ],
  description,
});

const appRefSchema = {
  type: "object",
  properties: {
    pid: { type: "integer" },
    name: { type: "string", description: "window title OR processName (e.g. 'Untitled - Notepad' or 'notepad'); unique substring also resolves" },
    bundleId: { type: "string", description: "bundle id (macOS) / AUMID (Windows packaged apps)" },
    windowId: { type: "integer", description: "scope to a specific window (from list_windows)" },
  },
  description: "App reference: pid preferred; name resolves by window title, processName, or unique substring",
};

const strategySchema = {
  type: "string",
  enum: ["auto", "a11y", "event"],
  description: "auto = a11y-first with the tool's raw fallback; a11y = fail closed unless semantic; event = force raw input",
};

const modifiersSchema = {
  type: "string",
  description: "chord like 'ctrl+shift' (macOS: cmd; Windows/Linux: ctrl)",
};

/* ── the plugin ───────────────────────────────────────────────────────────── */

export const computerUsePlugin: PluginDefinition = {
  id: "core-computer-use",
  name: "Computer Use",
  version: "1.1.0",
  description:
    "Observe and actuate the desktop GUI (Windows/Linux/macOS): accessibility-first element actions with screenshot-coordinate fallback, receipts, fail-closed refusals, kill switch, and a separate vision-model relay.",
  category: "computer",
  createTools: (ctx): ToolDefinition[] => {
    const toolDeps = ctx.toolDeps;
    // Fail-closed: no deps, or a DECLARATION context (the catalog passes
    // db:null — no settings readable) → the tool surface stays dark.
    if (toolDeps === undefined || toolDeps.db === null || toolDeps.db === undefined) {
      return [];
    }
    const settings = getComputerUseSettings(toolDeps.db);
    if (!settings.enabled) {
      return [];
    }
    const backend = backendForPlatform();
    const run = realRunner();
    const session = getComputerSession();
    // ROUND-61 close-out (the live smoke test's find): createTools runs ONCE
    // per agent turn — the marker that a new turn is starting. A session
    // stopped in a PREVIOUS turn (the owner's STOP, or the agent's own
    // end-of-task stop_computer_control) re-arms here; the MID-TURN kill
    // switch enforcement is untouched (the stopped turn's remaining calls
    // still refuse — dispatch's gate order puts killSwitch first).
    session.reopenForNewTurn();
    const dispatcher = new ComputerDispatcher({
      backend,
      run,
      root: ctx.root,
      session,
      allowMutations: settings.permission !== "observe",
    });
    // R62 (D8): publish the live engine for the browser plugin's screenshot
    // action (fail-closed there when this never runs — Computer Use OFF).
    setActiveComputerRelay({ backend, run, session });
    const emit = (event: Record<string, unknown>) => {
      try {
        toolDeps.emit?.({ type: "computer-use", ...event });
      } catch {
        // never let monitor emission break a turn
      }
    };

    // ── ROUND-67 (R67-D): the live screenshot THUMBNAIL frame ─────────────
    // The owner: "if the agent takes screenshots… the images should be
    // shown during its thinking in the agent's chat window itself, in a
    // small view." After a successful capture (screenshot / zoom /
    // get_app_state includeScreenshot) the raster bytes are pulled from the
    // dispatcher's cache via its PUBLIC rasterFor accessor (the bytes live
    // there only for the vision relay — a 3-frame LRU), copied into the
    // route-served raster registry, and announced as a `screenshot` frame.
    // The frame rides toolDeps.emit — the SSE-ONLY channel (never persisted,
    // never model-facing); the enhancement NEVER breaks the tool (try/catch,
    // missing raster → no frame — honest).
    const emitScreenshotFrame = (frameId: string, toolName: string, note?: string): void => {
      try {
        const png = dispatcher.rasterFor(frameId);
        if (png === undefined) return; // already evicted (3-frame LRU) — no frame, never an error
        registerRaster(frameId, png);
        toolDeps.emit?.({
          type: "screenshot",
          sessionId: toolDeps.sessionId,
          frameId,
          tool: toolName,
          ...(note !== undefined ? { note } : {}),
        });
      } catch {
        // The thumbnail strip is an enhancement — never break the tool call.
      }
    };

    /* The shared execute wrapper: consent gate → dispatch → shaping. */
    const execute = async (tool: string, input: Record<string, unknown>): Promise<ToolResult> => {
      // 1. The consent gate (ask-mode risk classes; posture act only —
      //    "auto" skips; permissionMode=full auto-approves inside the gate).
      if (settings.permission === "act" && needsConsent(tool, input) && toolDeps.permissionMode !== "full") {
        const approvalDeps = buildApprovalDeps(toolDeps);
        if (approvalDeps !== undefined) {
          const summary = consentSummary(tool, input);
          const gate = await requestCommandApproval(approvalDeps, `computer-use: ${summary}`);
          if (!gate.allowed) {
            session.record("refusal", `Owner declined: ${summary}`, tool);
            return refusalResult({
              error: "host_policy_denied",
              message: `The owner declined this computer-use action (${summary}).`,
              recovery: "Do not retry the same action; ask what to do differently or continue read-only.",
            });
          }
        }
      }
      // 2. Dispatch through the brain (gates, matrix, receipts, audit).
      const result = await dispatcher.dispatch(tool, input);
      emit({
        kind: result.kind,
        tool,
        ...(result.kind === "refusal" ? { code: result.refusal.error } : {}),
      });
      if (result.kind === "refusal") {
        return refusalResult(result.refusal);
      }
      if (result.kind === "receipt") {
        // return_state (doc 02 §0.4) is composed by the DISPATCHER itself —
        // the observation rides the receipt when requested.
        return receiptResult(result.receipt, result.observation !== undefined ? { observation: result.observation } : undefined);
      }
      // 2.5. ROUND-67 (R67-D): successful captures → the chat THUMBNAIL
      // frame. screenshot/zoom return {frame: meta}; get_app_state with
      // includeScreenshot returns {raster: meta} (only when the optional
      // window capture succeeded — a failed capture is not fatal, and then
      // there is honestly nothing to show).
      if (tool === "screenshot" || tool === "zoom") {
        const frame = (result.data["frame"] ?? {}) as { frameId?: string };
        if (typeof frame.frameId === "string") {
          emitScreenshotFrame(frame.frameId, tool, tool === "zoom" ? "zoomed region" : undefined);
        }
      } else if (tool === "get_app_state") {
        const raster = (result.data["raster"] ?? {}) as { frameId?: string };
        if (typeof raster.frameId === "string") {
          emitScreenshotFrame(raster.frameId, tool, "window raster");
        }
      }
      // 3. Data tools — vision relay for screenshot/zoom when describe=true.
      if ((tool === "screenshot" || tool === "zoom") && input["describe"] === true) {
        const frame = (result.data["frame"] ?? {}) as { frameId?: string };
        if (typeof frame.frameId === "string") {
          const png = dispatcher.rasterFor(frame.frameId);
          if (png !== undefined) {
            const vision = await relayVision(
              toolDeps.db,
              toolDeps.keyring,
              toolDeps.mainModel,
              png,
              typeof input["instruction"] === "string" ? (input["instruction"] as string) : "Describe this screenshot: visible windows, key UI elements with their names/positions, and anything actionable for the task.",
            );
            session.countVisionCall();
            if (vision.ok) {
              session.record("vision", `Vision (${vision.mode}): ${vision.text.slice(0, 120)}`, tool, {
                model: vision.model,
                ms: vision.ms,
              });
              return dataResult({ ...result.data, vision: { text: vision.text, model: vision.model, mode: vision.mode, ms: vision.ms } });
            }
            return dataResult({ ...result.data, vision: { error: vision.error } });
          }
        }
      }
      return dataResult(result.data);
    };

    const tool = (
      name: string,
      description: string,
      inputSchema: Record<string, unknown>,
      required: string[] = [],
    ): ToolDefinition => ({
      name,
      description,
      inputSchema: jsonSchema({ type: "object", properties: inputSchema, required } as never),
      execute: (input: Record<string, unknown>) => execute(name, input),
    });

    /* ── the 31 tools (30 doc-02 + find_elements) ─────────────────────── */

    const tools: ToolDefinition[] = [
      // ── Observe & resolve ──
      tool(
        "list_apps",
        "List RUNNING applications: name = the app's main WINDOW TITLE (e.g. 'Untitled - Notepad'), processName = the executable name (e.g. 'notepad'), plus pid and active. Resolve app refs by processName or pid; when a name misses, an app_not_found refusal lists the running apps in its payload. 'Not in this list' means 'not running' — not 'not installed'.",
        { app: appRefSchema },
      ),
      tool(
        "open_application",
        "Launch an app by its EXACT user-provided name (character-for-character: case, spaces, punctuation, suffixes like 'app' — never translate/normalize/shorten/retry spellings), or activate a running one with activate:true. activate:false (default) NEVER brings it to the foreground.",
        {
          app: appRefSchema,
          activate: { type: "boolean", description: "true = genuine foreground activation (postcondition-verified)" },
          url: { type: "string", description: "optional URL for browsers" },
        },
        ["app"],
      ),
      tool(
        "list_windows",
        "List an application's windows (windowId, title, bounds [x,y,w,h] in global screen points, main, focused).",
        { appRef: appRefSchema },
        ["appRef"],
      ),
      tool(
        "get_app_state",
        "THE core observation: the app window's accessibility tree (index + kind + name + flags per element). Start here — text-only, no screenshot. The app_ref resolves by window title, processName (e.g. 'notepad'), or unique substring; an app_not_found refusal lists the running apps (payload.runningApps) — pick the right pid and retry. detail:'full' adds bounds + advertised actions; includeScreenshot:true adds a window raster when you need pixel coordinates.",
        {
          appRef: appRefSchema,
          detail: { type: "string", enum: ["compact", "full"] },
          includeScreenshot: { type: "boolean" },
        },
        ["appRef"],
      ),
      // R66-2-d (owner directive B2, the live Edge failure): a server-side
      // tree SEARCH so one control can be located in a Chromium-sized window
      // without reading the whole snapshot or looping screenshots.
      tool(
        "find_elements",
        "SEARCH an app's accessibility tree by name substring (and optional kind) — returns the matching elements with their indexes + bounds. THE way to find one control in a big app (browsers, Edge, VS Code) without reading the whole tree or taking screenshots: find_elements {appRef, query:'Sign in', kind:'button'} → left_click {target:{type:'element', stateId, index}} using the returned stateId + index. BROWSER PAGES: the web accessibility tree IS searched — links, buttons, inputs by name (the tree is activated automatically). Cheaper than get_app_state detail:'full' on Chromium-sized windows (those return thousands of elements). kind filters by the snapshot's mapped kinds (button, textfield, checkbox, combobox, slider, tab, menuitem, row, text, image, pane, window, scrollbar).",
        {
          appRef: appRefSchema,
          query: { type: "string", description: "case-insensitive name substring" },
          kind: { type: "string", description: "optional element kind filter (the snapshot's mapped kinds, e.g. 'button')" },
          limit: { type: "integer", description: "max matches returned (default 20, hard max 40; 'total' in the result reports the uncapped match count)" },
        },
        ["appRef", "query"],
      ),
      tool(
        "screenshot",
        "Full-display capture (the display chosen by switch_display). The FALLBACK observation — prefer get_app_state, and prefer find_elements for browser content (the web tree is searchable by name). Returns frame metadata (frameId, width, height, scale); frames stay valid for 30s — act on the pixels immediately, don't re-screenshot. describe:true additionally runs the VISION model over the image and returns its textual description (when vision is configured in Settings → Image Analysis).",
        {
          describe: { type: "boolean", description: "also describe the image via the configured vision model" },
          instruction: { type: "string", description: "what to look for (forwarded to the vision model)" },
        },
      ),
      tool(
        "zoom",
        "Exceptional close-up of a region of the LATEST raster ([x0,y0,x1,y1] image pixels) — only when the target is too small/ambiguous. Result is a NEW raster: choose pixels from THIS image. Use a SMALL region covering just the one control you are verifying — cheaper and faster than a full screenshot.",
        {
          region: { type: "array", items: { type: "integer" }, description: "[x0, y0, x1, y1] in the latest raster's pixels" },
          describe: { type: "boolean" },
          instruction: { type: "string" },
        },
        ["region"],
      ),
      tool(
        "list_displays",
        "Displays: 1-based index, bounds [x,y,w,h] (secondaries may have negative origins), main.",
        {},
      ),
      tool(
        "switch_display",
        "Choose which display the next screenshot captures (1-based). Does not capture.",
        { index: { type: "integer", description: "1-based display index" } },
        ["index"],
      ),
      tool(
        "cursor_position",
        "Current pointer position (global points) + the display screenshot currently captures.",
        {},
      ),
      // ── Pointer ──
      tool(
        "left_click",
        "Left-click. Element target = accessibility press (background-safe, preferred). Coordinate = a11y hit-test then raw fallback; submit pixels from the LATEST raster unchanged.",
        { target: targetSchema("element (preferred) or coordinate"), strategy: strategySchema, modifiers: modifiersSchema },
        ["target"],
      ),
      tool(
        "double_click",
        "Double-click — NO accessibility equivalent: element targets fail closed; coordinates go raw (raster-bound, foreground on Windows/Linux).",
        { target: targetSchema("coordinate"), modifiers: modifiersSchema },
        ["target"],
      ),
      tool(
        "triple_click",
        "Triple-click — raw only (coordinate), same contract as double_click.",
        { target: targetSchema("coordinate"), modifiers: modifiersSchema },
        ["target"],
      ),
      tool(
        "right_click",
        "Right-click. Element with a menu → accessibility menu-open; element without a menu fails closed under auto. Coordinate → hit-test, else raw right-click.",
        { target: targetSchema("element with has_menu, or coordinate"), strategy: strategySchema, modifiers: modifiersSchema },
        ["target"],
      ),
      tool(
        "middle_click",
        "Middle-click — raw only (coordinate). On a browser link, middle-click opens it in a NEW TAB (keeps the current page — the safe way to follow a link mid-flow).",
        { target: targetSchema("coordinate"), modifiers: modifiersSchema },
        ["target"],
      ),
      tool(
        "scroll",
        "Scroll — NO accessibility actuation: element targets fail closed; ALWAYS coordinate (from the latest raster). direction up|down|left|right; amount 0-100.",
        {
          target: targetSchema("coordinate"),
          scrollDirection: { type: "string", enum: ["up", "down", "left", "right"] },
          scrollAmount: { type: "integer", description: "0-100" },
          strategy: strategySchema,
        },
        ["target", "scrollDirection"],
      ),
      tool(
        "left_click_drag",
        "Drag from → to (both may be elements for scoping; the gesture is raw). Endpoints must scope to the SAME app.",
        {
          fromTarget: targetSchema("drag source (element or coordinate)"),
          to: targetSchema("drag destination (element or coordinate)"),
          modifiers: modifiersSchema,
        },
        ["fromTarget", "to"],
      ),
      tool(
        "mouse_move",
        "Hover — raw, coordinate only (element refused; use left_click to actuate).",
        { target: targetSchema("coordinate") },
        ["target"],
      ),
      tool(
        "left_mouse_down",
        "Press-and-hold (pairs with left_mouse_up; down+up = a click). Verify the target before releasing.",
        { target: targetSchema("element or coordinate"), returnState: { type: "string", enum: ["none", "compact", "full"] } },
        ["target"],
      ),
      tool(
        "left_mouse_up",
        "Release the button held by THIS session's left_mouse_down (cleanup-release only; refuses when no down is held).",
        {},
      ),
      // ── Text & keyboard ──
      tool(
        "type",
        "Type text. Element target = accessibility value write (REPLACES the field's contents; select_text first to insert). appRef = app-scoped typing — the target app is brought frontmost automatically (verified activation; a frontmost_pid_mismatch refusal means that activation failed). Never targetless.",
        {
          text: { type: "string" },
          target: targetSchema("editable element (preferred)"),
          appRef: appRefSchema,
          strategy: strategySchema,
        },
        ["text"],
      ),
      tool(
        "set_value",
        "Set a settable element's value directly via accessibility (sliders, text fields) — semantic, background-safe. The PREFERRED text write.",
        { target: targetSchema("settable element"), value: { type: "string" }, strategy: strategySchema },
        ["target", "value"],
      ),
      tool(
        "select_text",
        "Select [start, length] in a text element, or place the caret (omit textRange).",
        { target: targetSchema("text element"), textRange: { type: "array", items: { type: "integer" }, description: "[start, length]" } },
        ["target"],
      ),
      tool(
        "key",
        "Non-text keys and chords ('return', 'escape', 'ctrl+a', 'tab'). NOT ordinary text — use type. repeat 1-100. Modifiers: macOS cmd; Windows/Linux ctrl.",
        {
          text: { type: "string", description: "key name or chord, e.g. 'ctrl+a'" },
          appRef: appRefSchema,
          repeat: { type: "integer", description: "1-100" },
        },
        ["text", "appRef"],
      ),
      tool(
        "hold_key",
        "Hold a key/chord for a duration (0-30s). Never targetless.",
        { text: { type: "string" }, duration: { type: "number", description: "seconds 0-30" }, appRef: appRefSchema },
        ["text", "appRef"],
      ),
      // ── Semantic ──
      tool(
        "perform_action",
        "Invoke a NAMED accessibility action on an element (must be in the element's advertised 'actions' from a detail:'full' observation).",
        { target: targetSchema("element"), action: { type: "string", description: "one of the element's advertised actions" } },
        ["target", "action"],
      ),
      // ── Runtime ──
      tool(
        "request_access",
        "Read-only readiness probe (permissions + backend capabilities). NEVER pops dialogs; missing grants ⇒ tell the user and END the turn.",
        {},
      ),
      tool(
        "stop_computer_control",
        "STOP the computer-control session (the kill switch): all further computer-use calls are refused; releases a button held by this session. Call when the task is done or when access is denied.",
        { reason: { type: "string" } },
      ),
      tool(
        "wait",
        "Pause 0-30s for animations/loads, then re-observe.",
        { duration: { type: "number", description: "seconds 0-30" } },
      ),
      tool(
        "read_clipboard",
        "Read the system clipboard text (observation — safe).",
        {},
      ),
      tool(
        "write_clipboard",
        "Write text to the system clipboard. Useful to PASTE into apps that fight synthetic typing (paste with key 'ctrl+v').",
        { text: { type: "string" } },
        ["text"],
      ),
    ];

    // Observe posture: register only the read-only subset (the dispatcher
    // would refuse mutations anyway — this keeps the MODEL-side surface
    // honest too: no mutating schemas offered).
    if (settings.permission === "observe") {
      const readOnly = new Set([
        "list_apps", "list_windows", "list_displays", "switch_display", "get_app_state",
        "find_elements",
        "screenshot", "zoom", "cursor_position", "request_access", "read_clipboard",
        "wait",
      ]);
      return tools.filter((t) => readOnly.has(t.name));
    }
    return tools;
  },
};

/* ── helpers ──────────────────────────────────────────────────────────────── */

function consentSummary(tool: string, input: Record<string, unknown>): string {
  const target = input["target"];
  const appRef = input["appRef"] ?? input["app_ref"];
  const text = typeof input["text"] === "string" ? (input["text"] as string).slice(0, 60) : undefined;
  const value = typeof input["value"] === "string" ? (input["value"] as string).slice(0, 60) : undefined;
  const parts = [tool];
  if (text !== undefined) parts.push(`"${text}"`);
  if (value !== undefined) parts.push(`"${value}"`);
  if (typeof appRef === "object" && appRef !== null) {
    const pid = (appRef as Record<string, unknown>)["pid"];
    if (pid !== undefined) parts.push(`(pid ${String(pid)})`);
  }
  if (typeof target === "object" && target !== null) {
    const t = target as Record<string, unknown>;
    if (t["type"] === "coordinate") parts.push(`at (${String(t["x"])},${String(t["y"])})`);
  }
  return parts.join(" ");
}

/* ── the vision relay wiring ──────────────────────────────────────────────── */

async function relayVision(
  db: Parameters<typeof getVisionSettings>[0],
  keyring: import("../../providers/registry.js").ProviderKeyring | undefined,
  mainModel: { providerId: string; modelId: string } | undefined,
  pngBase64: string,
  instruction: string,
): Promise<{ ok: true; text: string; model: string; mode: string; ms: number } | { ok: false; error: string }> {
  const settings = getVisionSettings(db);
  if (settings.mode === "off") {
    return {
      ok: false,
      error:
        "vision is OFF — enable it in Settings → Image Analysis (a separate vision model, or main-model vision when the row supports it); the raster metadata above is still usable with coordinates",
    };
  }
  if (keyring === undefined) {
    return { ok: false, error: "no keyring in this context — vision unavailable" };
  }
  if (settings.mode === "separate") {
    if (settings.provider === null || settings.modelId === null) {
      return {
        ok: false,
        error: "vision mode is 'separate' but the vision provider/model is not configured — set them in Settings → Image Analysis",
      };
    }
    const result = await describeRaster(
      { db, keyring, visionKeyringId: visionKeyringId(settings.provider) },
      { mode: "separate", providerId: settings.provider, modelId: settings.modelId },
      { imageBase64: pngBase64, instruction },
    );
    return "error" in result ? { ok: false, error: result.error } : { ok: true, ...result };
  }
  // mode === "main": allowed only when the turn's model row supports vision.
  if (mainModel === undefined) {
    return { ok: false, error: "main-model vision: no main model in this context" };
  }
  const providerId = mainModel.providerId;
  const model = findModelRow(db, providerId, mainModel.modelId);
  if (model === undefined || !model.supportsVision) {
    return {
      ok: false,
      error: `the turn's model '${mainModel.modelId}' does not support vision (or its row isn't marked supports_vision) — set a separate vision model in Settings → Image Analysis`,
    };
  }
  const result = await describeRaster(
    { db, keyring },
    { mode: "main", providerId, modelId: mainModel.modelId },
    { imageBase64: pngBase64, instruction },
  );
  return "error" in result ? { ok: false, error: result.error } : { ok: true, ...result };
}

function findModelRow(
  db: Parameters<typeof getVisionSettings>[0],
  providerId: string,
  modelId: string,
): { supportsVision: boolean } | undefined {
  try {
    return listModels(db, providerId).find((m) => m.modelId === modelId);
  } catch {
    return undefined;
  }
}

export { relayVision as relayVisionForTests };
// R62 (D8): the browser plugin's screenshot action relays the browser-panel
// capture through the SAME vision pipeline (separate vision model or
// main-model vision) — one vision configuration, one honest failure story.
export { relayVision };
