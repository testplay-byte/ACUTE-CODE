/**
 * ROUND-52 (R52-f): the BROWSER plugin — browser_control, moved VERBATIM from
 * tools/index.ts buildProjectTools (the embedded-browser panel driver with
 * host-gated navigation).
 *
 * ROUND-62 (D8, owner: "the ai agent can interact with the right sidebar
 * browser — navigate it, screenshot it, use it and such… change the view,
 * the dimensions, the scale… get the status"): the tool grew from a
 * navigation/viewport driver into a full agent-browser surface:
 *   · read       — the current page's text, fetched server-side (any mode);
 *   · eval       — run JavaScript INSIDE the live page (native WebView2 only,
 *                  via the SSE→UI→Rust browser-command bridge) — click links,
 *                  fill forms, read the DOM the user is watching;
 *   · screenshot — capture the browser panel's on-screen region through the
 *                  computer-use backends + describe it with the (separate or
 *                  main) vision model; needs Computer Use enabled;
 *   · get_state  — now with the session list (every open tab) + active tab.
 * The pre-R62 actions (navigate/back/forward/reload/set_viewport) are
 * byte-identical in behavior.
 */
import { jsonSchema } from "ai";
import {
  VIEWPORT_PRESETS,
  browserActiveTabSessionId,
  browserGetStateCommand,
  browserListSessionsCommand,
  browserNavigateCommand,
  browserViewportCommand,
} from "../../browser-proxy.js";
import { sendBrowserCommand } from "../../browser-command.js";
import { requestWebFetchApproval } from "../../approvals.js";
import { buildApprovalDeps } from "../approval-deps.js";
import { getActiveComputerRelay } from "./computer-relay.js";
import { relayVision } from "./computer-use.js";
import { webFetch } from "../web.js";
import type { PluginDefinition, ToolDefinition } from "../registry.js";

export const browserPlugin: PluginDefinition = {
  id: "core-browser",
  name: "Embedded Browser",
  version: "1.1.0",
  description:
    "Drives the user's embedded browser panel (navigate/history/viewport/read/eval/screenshot/state).",
  category: "browser",
  createTools: (ctx): ToolDefinition[] => {
    const toolDeps = ctx.toolDeps;
    return [
      {
        name: "browser_control",
        description:
          "Control the user's EMBEDDED BROWSER PANEL — a real in-app web browser the user watches live. Actions: navigate (open/change the page; absolute http(s) URL — documentation/source hosts like github.com navigate freely, other hosts ask the owner for permission first), back | forward | reload (walk that tab's history), set_viewport (change the display size the user sees — test responsive layouts; presets mobile-sm 375×667, mobile-md 390×844, tablet 768×1024, laptop 1280×800, desktop 1440×900, full-hd 1920×1080, or custom width 200-3840 × height 200-4320, zoom 0.25-3, rotate swaps w/h), read (the CURRENT page's text content, fetched fresh server-side — works in every mode; great for extracting what the panel shows), eval (run JavaScript INSIDE the live page and get the value back — click links with `return document.querySelector('a').click()`, fill inputs, read the DOM; the page's own state (logins, JS) is live; native desktop mode only), screenshot (capture what the panel shows + a vision-model description — requires Computer Use enabled in Settings), get_state (currentUrl, title, viewport, canBack/canForward + EVERY open tab). sessionId optional — defaults to the tab the user is currently viewing. Viewport/page changes appear LIVE in the user's panel; announce them in one line. The page the panel shows may differ from a fresh fetch (logins, JS) — read for text, eval for the live DOM, screenshot for what the user actually sees.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            action: {
              type: "string",
              description: "navigate | back | forward | reload | set_viewport | read | eval | screenshot | get_state",
              enum: [
                "navigate",
                "back",
                "forward",
                "reload",
                "set_viewport",
                "read",
                "eval",
                "screenshot",
                "get_state",
              ],
            },
            url: { type: "string", description: "Absolute http(s) URL to open (action=navigate)" },
            preset: {
              type: "string",
              description: "Display-size preset (action=set_viewport)",
              enum: [...Object.keys(VIEWPORT_PRESETS), "custom"],
            },
            width: { type: "number", description: "Viewport width 200-3840 (action=set_viewport, custom size)" },
            height: { type: "number", description: "Viewport height 200-4320 (action=set_viewport, custom size)" },
            zoom: { type: "number", description: "Panel render zoom 0.25-3 (action=set_viewport)" },
            rotate: { type: "boolean", description: "Swap width/height, e.g. landscape phone (action=set_viewport)" },
            script: {
              type: "string",
              description:
                "JavaScript to run inside the live page (action=eval). Runs as a function BODY — end with `return value` to get data back (JSON-serialized). Examples: `return document.title`, `return [...document.querySelectorAll('a')].slice(0,20).map(a=>a.href)`, `document.querySelector('#login').click(); return 'clicked'`. Max 20000 chars.",
            },
            instruction: {
              type: "string",
              description:
                "What to focus on in the vision description (action=screenshot, optional) — e.g. 'describe the checkout form's fields and any validation errors'",
            },
            maxChars: {
              type: "number",
              description: "Text cap for action=read (default 8000, max 16000)",
            },
            sessionId: {
              type: "string",
              description: "Browser tab session id — omit to target the tab the user is viewing",
            },
          },
          required: ["action"],
        }),
        execute: async (input) => {
          const action = typeof input.action === "string" ? input.action : "";
          // Mirror of the backend's SESSION_ID_RE (browser-proxy.ts) — the
          // command entry points trust their caller, so validate here.
          const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
          const explicit = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
          if (explicit !== "" && !SESSION_ID_RE.test(explicit)) {
            return { ok: false, output: "browser_control: sessionId must be alphanumeric/-/./_ (max 64 chars)" };
          }
          // Default target: the tab the user is looking at (LRU tail of the
          // sidecar's browser-session store); falls back to the shared
          // "agent" session when no browser tab has been opened yet.
          const activeTab = browserActiveTabSessionId();
          const sessionId = explicit !== "" ? explicit : (activeTab ?? "agent");
          const noTabHint =
            activeTab === null && explicit === ""
              ? " (note: no embedded browser tab is open — this state is not visible to the user yet)"
              : "";

          if (action === "navigate") {
            const url = typeof input.url === "string" ? input.url.trim() : "";
            if (url === "") return { ok: false, output: "browser_control: action navigate requires url" };
            // ROUND-45 (audit P0-5): agent-driven navigation is host-gated
            // exactly like web_fetch (the panel then renders through the
            // server-side proxy). Malformed/non-http URLs fall through to the
            // shape validation below (its error is the better one); no approval
            // channel at all = fail-closed for http(s) too.
            if (/^https?:\/\//i.test(url)) {
              if (toolDeps === undefined) {
                return { ok: false, output: "browser_control: navigate unavailable — no approval channel in this context" };
              }
              const approvalDeps = buildApprovalDeps(toolDeps);
              const gate = await requestWebFetchApproval(approvalDeps, url, "browser_control");
              if (!gate.allowed) {
                return { ok: false, output: `browser_control: navigate blocked — ${gate.note}` };
              }
            }
            const result = browserNavigateCommand(sessionId, { url });
            if (!result.ok) return { ok: false, output: `browser_control: ${result.error}` };
            return {
              ok: true,
              output: `navigated the embedded browser to ${result.entry?.url ?? url} (history index ${result.index}, canBack ${result.canBack}, canForward ${result.canForward}). The panel follows within a few seconds.${noTabHint}`,
            };
          }
          if (action === "back" || action === "forward" || action === "reload") {
            const result = browserNavigateCommand(sessionId, { direction: action });
            if (!result.ok) return { ok: false, output: `browser_control: ${result.error}` };
            if (result.action === "noop" || result.entry === null) {
              return { ok: true, output: `browser_control: ${action} did nothing (history boundary; index ${result.index})` };
            }
            return {
              ok: true,
              output: `${action} → ${result.entry.url} (history index ${result.index}, canBack ${result.canBack}, canForward ${result.canForward}). The panel follows within a few seconds.`,
            };
          }
          if (action === "set_viewport") {
            const patch: { preset?: unknown; width?: unknown; height?: unknown; zoom?: unknown; rotate?: unknown } = {};
            if (input.preset !== undefined) patch.preset = input.preset;
            if (input.width !== undefined) patch.width = input.width;
            if (input.height !== undefined) patch.height = input.height;
            if (input.zoom !== undefined) patch.zoom = input.zoom;
            if (input.rotate !== undefined) patch.rotate = input.rotate;
            if (Object.keys(patch).length === 0) {
              return {
                ok: false,
                output: "browser_control: set_viewport requires preset and/or width/height/zoom/rotate",
              };
            }
            const result = browserViewportCommand(sessionId, patch);
            if (!result.ok) return { ok: false, output: `browser_control: ${result.error}` };
            const v = result.viewport;
            return {
              ok: true,
              output: `viewport set to ${v.width}×${v.height} (${v.preset}, zoom ${v.zoom}${v.rotate ? ", rotated" : ""}). The user's browser panel resizes live.${noTabHint}`,
            };
          }

          // ── R62 (D8): read — the current page's text, server-side ──────
          if (action === "read") {
            const state = browserGetStateCommand(sessionId);
            if (state.currentUrl === null) {
              return {
                ok: false,
                output: `browser_control: read — no page is open in tab '${sessionId}' yet; navigate first`,
              };
            }
            const maxCharsRaw = input.maxChars;
            const maxChars =
              typeof maxCharsRaw === "number" && Number.isFinite(maxCharsRaw)
                ? Math.min(16000, Math.max(1000, Math.round(maxCharsRaw)))
                : 8000;
            const fetched = await webFetch(state.currentUrl);
            if (!fetched.ok) {
              return {
                ok: false,
                output: `browser_control: read — fetching the panel's page failed: ${fetched.output}`,
              };
            }
            // The read is bounded (the same 16KB web_fetch cap) — trim to
            // the requested window and note the truncation honestly.
            let text = fetched.output;
            let truncated = false;
            if (text.length > maxChars) {
              text = `${text.slice(0, maxChars)}\n…(truncated — ${text.length} chars total; raise maxChars up to 16000)`;
              truncated = true;
            }
            return {
              ok: true,
              output: `Embedded-browser page ${state.title ?? "(untitled)"} — ${state.currentUrl}${truncated ? "" : " (full text)"}:\n\n${text}${noTabHint}`,
            };
          }

          // ── R62 (D8): eval — JavaScript inside the live page ───────────
          if (action === "eval") {
            const script = typeof input.script === "string" ? input.script : "";
            if (script.trim() === "") {
              return { ok: false, output: "browser_control: eval requires a non-empty 'script' (end it with `return value`)" };
            }
            if (script.length > 20_000) {
              return { ok: false, output: "browser_control: eval script too large (max 20000 chars)" };
            }
            if (toolDeps === undefined || typeof toolDeps.emit !== "function") {
              return {
                ok: false,
                output:
                  "browser_control: eval unavailable — no live stream channel in this context (eval needs the app UI to run the script in the page)",
              };
            }
            let data: unknown;
            try {
              data = await sendBrowserCommand(toolDeps.emit, sessionId, "eval", { script }, 12_000);
            } catch (error) {
              return {
                ok: false,
                output: `browser_control: eval failed — ${error instanceof Error ? error.message : String(error)}`,
              };
            }
            // The bridge replies with the Rust command's {ok, value|error}.
            const result = (data ?? {}) as { ok?: unknown; value?: unknown; error?: unknown };
            if (result.ok !== true) {
              const message = typeof result.error === "string" ? result.error : "the page rejected the script";
              return { ok: false, output: `browser_control: eval — page error: ${message}` };
            }
            const serialized = JSON.stringify(result.value ?? null);
            const capped =
              serialized.length > 12_000
                ? `${serialized.slice(0, 12_000)}…(truncated, ${serialized.length} chars total)`
                : serialized;
            return {
              ok: true,
              output: `eval ok (tab '${sessionId}') → ${capped}`,
            };
          }

          // ── R62 (D8): screenshot — capture + describe the panel ─────────
          if (action === "screenshot") {
            const state = browserGetStateCommand(sessionId);
            if (state.currentUrl === null) {
              return {
                ok: false,
                output: `browser_control: screenshot — no page is open in tab '${sessionId}' yet; navigate first`,
              };
            }
            const relay = getActiveComputerRelay();
            if (relay === null) {
              return {
                ok: false,
                output:
                  "browser_control: screenshot needs Computer Use enabled (Settings → Computer Use — the screen-capture engine). It is currently OFF. Meanwhile action 'read' gets the page text and 'eval' the live DOM.",
              };
            }
            if (toolDeps === undefined || toolDeps.db === null || toolDeps.db === undefined) {
              return { ok: false, output: "browser_control: screenshot unavailable — no database in this context" };
            }
            // Ask the live UI for the panel's on-screen region (physical px).
            // No answer / web mode → capture the whole display instead.
            let region: { x: number; y: number; w: number; h: number } | null = null;
            let regionNote = "full display capture";
            if (typeof toolDeps.emit === "function") {
              try {
                const meta = (await sendBrowserCommand(toolDeps.emit, sessionId, "screenshot_meta", {}, 5000)) as {
                  supported?: unknown;
                  region?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | null;
                };
                if (
                  meta?.supported === true &&
                  meta.region !== null &&
                  meta.region !== undefined &&
                  typeof meta.region.x === "number" &&
                  typeof meta.region.y === "number" &&
                  typeof meta.region.w === "number" &&
                  typeof meta.region.h === "number" &&
                  meta.region.w > 0 &&
                  meta.region.h > 0
                ) {
                  region = {
                    x: Math.round(meta.region.x),
                    y: Math.round(meta.region.y),
                    w: Math.round(meta.region.w),
                    h: Math.round(meta.region.h),
                  };
                  regionNote = `panel region ${region.w}×${region.h}`;
                }
              } catch {
                // The UI didn't answer (no panel mounted / web dev mode) —
                // the full-display fallback below stays.
              }
            }
            const raster =
              region !== null
                ? await relay.backend.captureRegion(relay.run, region)
                : await relay.backend.captureDisplay(relay.run, 1);
            if ("error" in raster) {
              return {
                ok: false,
                output: `browser_control: screenshot — screen capture failed: ${raster.error}`,
              };
            }
            // Record into the computer session → the monitor ring (the
            // right-sidebar Computer panel + the mini window) shows it.
            const instruction =
              typeof input.instruction === "string" && input.instruction.trim() !== ""
                ? input.instruction.trim().slice(0, 500)
                : "Describe the embedded browser panel in this screenshot: which page/site is open, its visible headline content, main interactive elements, and anything actionable for the task.";
            const vision = await relayVision(toolDeps.db, toolDeps.keyring, toolDeps.mainModel, raster.pngBase64, instruction);
            try {
              relay.session.record("observe", `Browser panel screenshot (${regionNote})`, "browser_screenshot", {
                url: state.currentUrl,
                vision: vision.ok ? vision.model : undefined,
              });
            } catch {
              // Monitoring must never break the tool.
            }
            if (vision.ok) {
              return {
                ok: true,
                output: `Browser panel screenshot (${regionNote}, ${raster.width}×${raster.height}px, page ${state.currentUrl}) — vision (${vision.model}) says:\n${vision.text}`,
              };
            }
            return {
              ok: true,
              output: `Browser panel screenshot captured (${regionNote}, ${raster.width}×${raster.height}px, page ${state.currentUrl}), but the vision description is unavailable: ${vision.error}`,
            };
          }

          if (action === "get_state") {
            // R62: the state now includes every open tab + which one the
            // user is viewing (the owner: "get the status of the things").
            const state = browserGetStateCommand(sessionId);
            const payload = {
              ...state,
              activeTab: activeTab,
              tabs: browserListSessionsCommand().map((t) => ({
                sessionId: t.sessionId,
                currentUrl: t.currentUrl,
                title: t.title,
                viewport: `${t.viewport.width}×${t.viewport.height} @ ${t.viewport.zoom}×${t.viewport.rotate ? " (rotated)" : ""}`,
              })),
            };
            return { ok: true, output: JSON.stringify(payload) };
          }
          return {
            ok: false,
            output: `browser_control: unknown action '${action}' (navigate | back | forward | reload | set_viewport | read | eval | screenshot | get_state)`,
          };
        },
      },
    ];
  },
};
