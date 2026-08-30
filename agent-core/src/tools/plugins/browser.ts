/**
 * ROUND-52 (R52-f): the BROWSER plugin — browser_control, moved VERBATIM from
 * tools/index.ts buildProjectTools (the embedded-browser panel driver with
 * host-gated navigation).
 */
import { jsonSchema } from "ai";
import {
  VIEWPORT_PRESETS,
  browserActiveTabSessionId,
  browserGetStateCommand,
  browserNavigateCommand,
  browserViewportCommand,
} from "../../browser-proxy.js";
import { requestWebFetchApproval } from "../../approvals.js";
import { buildApprovalDeps } from "../approval-deps.js";
import type { PluginDefinition, ToolDefinition } from "../registry.js";

export const browserPlugin: PluginDefinition = {
  id: "core-browser",
  name: "Embedded Browser",
  version: "1.0.0",
  description: "Drives the user's embedded browser panel (navigate/history/viewport/state).",
  category: "browser",
  createTools: (ctx): ToolDefinition[] => {
    const toolDeps = ctx.toolDeps;
    return [
      {
        name: "browser_control",
        description:
          "Control the user's EMBEDDED BROWSER PANEL — a real in-app web browser the user watches live. Actions: navigate (open/change the page; absolute http(s) URL — documentation/source hosts like github.com navigate freely, other hosts ask the owner for permission first), back | forward | reload (walk that tab's history), set_viewport (change the display size the user sees — test responsive layouts at phone/tablet/desktop sizes), get_state (read currentUrl, title, viewport, canBack, canForward). Presets: mobile-sm 375×667, mobile-md 390×844, tablet 768×1024, laptop 1280×800, desktop 1440×900, full-hd 1920×1080; or custom width 200-3840 × height 200-4320, zoom 0.25-3, rotate swaps width/height. sessionId optional — defaults to the browser tab the user is currently viewing. Viewport/page changes appear LIVE in the user's panel; announce them in one line. To read page text into your own context, web_fetch is usually more reliable than the panel (it renders through a proxy).",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            action: {
              type: "string",
              description: "navigate | back | forward | reload | set_viewport | get_state",
              enum: ["navigate", "back", "forward", "reload", "set_viewport", "get_state"],
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
          if (action === "get_state") {
            return { ok: true, output: JSON.stringify(browserGetStateCommand(sessionId)) };
          }
          return {
            ok: false,
            output: `browser_control: unknown action '${action}' (navigate | back | forward | reload | set_viewport | get_state)`,
          };
        },
      },
    ];
  },
};
