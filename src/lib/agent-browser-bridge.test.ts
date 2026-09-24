// @vitest-environment happy-dom
/**
 * ROUND-62 (D8) — the FRONTEND side of the agent-browser command bridge.
 *
 * Unit-tests the dispatch registry: a registered handler's reply is POSTed
 * back as the REST result; a missing handler answers an honest error
 * immediately (the tool fails fast instead of burning its 15s timeout); a
 * throwing handler never breaks the dispatch. The api module is mocked —
 * the REST contract itself is pinned agent-core-side (browser-tool.test.ts
 * boots the real server).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posted: Array<{ commandId: string; result: { ok: boolean; data?: unknown; error?: string } }> = [];

vi.mock("./api", () => ({
  postBrowserCommandResult: vi.fn(
    (commandId: string, result: { ok: boolean; data?: unknown; error?: string }) => {
      posted.push({ commandId, result });
      return Promise.resolve();
    },
  ),
}));

// ── ROUND-124 (R124): the module-level screenshot_capture fallback's fakes ─
// The bridge now answers screenshot_capture for tabs with NO mounted panel
// (the owner in Settings — the route swap unmounts every BrowserPanel) by
// delegating to the staged capture choreography. That choreography has its
// own deep suite (agent-browser-capture.test.ts); HERE we pin the DISPATCH
// contract: when it runs, with which options, and what happens to its reply.
const captureState = vi.hoisted(() => ({
  nativeAvailable: false,
  staged: null as { tabId: string; options: Record<string, unknown> } | null,
  reply: { pngBase64: "aW1n".repeat(40), width: 2560, height: 1440, logicalWidth: 1280, logicalHeight: 720, clamped: false },
  failWith: null as Error | null,
}));
vi.mock("./native-browser", () => ({
  isNativeBrowserAvailable: () => captureState.nativeAvailable,
}));
vi.mock("./agent-browser-capture", () => ({
  performStagedBrowserCapture: vi.fn(async (tabId: string, options: Record<string, unknown>) => {
    captureState.staged = { tabId, options };
    if (captureState.failWith !== null) throw captureState.failWith;
    return captureState.reply;
  }),
  parseCapturePayloadDims: (payload: Record<string, unknown>) =>
    typeof payload.width === "number" && typeof payload.height === "number"
      ? { width: payload.width, height: payload.height }
      : {},
}));

import {
  clearBrowserCommandHandlersForTest,
  dispatchBrowserCommand,
  hasBrowserCommandHandler,
  registerBrowserCommandHandler,
} from "./agent-browser-bridge";

beforeEach(() => {
  posted.length = 0;
  clearBrowserCommandHandlersForTest();
  captureState.nativeAvailable = false;
  captureState.staged = null;
  captureState.reply = { pngBase64: "aW1n".repeat(40), width: 2560, height: 1440, logicalWidth: 1280, logicalHeight: 720, clamped: false };
  captureState.failWith = null;
});

afterEach(() => {
  clearBrowserCommandHandlersForTest();
});

function frame(commandId: string, tabId: string, action: string, payload: Record<string, unknown> = {}) {
  return { type: "browser-command" as const, commandId, tabId, action, payload };
}

describe("agent-browser-bridge (R62 D8 dispatch registry)", () => {
  it("dispatches to the registered handler and POSTs its reply as the command result", async () => {
    registerBrowserCommandHandler("tab-1", async (action, payload) => {
      expect(action).toBe("eval");
      expect(payload).toEqual({ script: "return 1" });
      return { ok: true, data: { ok: true, value: 1 } };
    });
    dispatchBrowserCommand(frame("cmd-1", "tab-1", "eval", { script: "return 1" }));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      commandId: "cmd-1",
      result: { ok: true, data: { ok: true, value: 1 } },
    });
  });

  it("no handler registered → immediate honest error result (no 15s timeout burn)", async () => {
    dispatchBrowserCommand(frame("cmd-2", "tab-gone", "eval", { script: "return 1" }));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].result.ok).toBe(false);
    expect(posted[0].result.error).toContain("no embedded browser panel is mounted");
    expect(posted[0].commandId).toBe("cmd-2");
  });

  it("a THROWING handler answers with the exception's message (dispatch never rejects)", async () => {
    registerBrowserCommandHandler("tab-3", () => {
      throw new Error("webview exploded");
    });
    dispatchBrowserCommand(frame("cmd-3", "tab-3", "screenshot_meta"));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].result.ok).toBe(false);
    expect(posted[0].result.error).toContain("webview exploded");
  });

  it("unregister removes only OUR handler (a newer mount's registration survives)", async () => {
    const unregisterOld = registerBrowserCommandHandler("tab-4", () => ({ ok: true, data: "old" }));
    registerBrowserCommandHandler("tab-4", () => ({ ok: true, data: "new" }));
    unregisterOld();
    expect(hasBrowserCommandHandler("tab-4")).toBe(true);
    dispatchBrowserCommand(frame("cmd-4", "tab-4", "eval"));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].result.data).toBe("new");
  });

  it("a missing payload degrades to an empty object (the handler's shape checks stay simple)", async () => {
    let seen: Record<string, unknown> | null = null;
    registerBrowserCommandHandler("tab-5", (_action, payload) => {
      seen = payload;
      return { ok: true };
    });
    const noPayload = { type: "browser-command" as const, commandId: "cmd-5", tabId: "tab-5", action: "eval" };
    dispatchBrowserCommand(noPayload);
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(seen).toEqual({});
  });
});

// ── ROUND-124 (R124): the module-level screenshot_capture fallback ─────────
// The owner: "this should also happen if the user is in some other application,
// is in the settings of the program or something else, but the screenshot should
// still be successfully taken as needed." A route swap to Settings unmounts
// every BrowserPanel → no handler → the OLD bridge answered "no embedded
// browser panel is mounted" and the tool refused. Now screenshot_capture is
// PANEL-INDEPENDENT: the staged capture answers through the native bridge
// directly (the webview is still alive — R87 keep-alive).
describe("agent-browser-bridge (R124: the panel-independent screenshot_capture fallback)", () => {
  it("no handler + native available + screenshot_capture → the staged capture answers with the raster (the Settings case)", async () => {
    captureState.nativeAvailable = true;
    dispatchBrowserCommand(frame("cmd-r124-a", "tab-settings", "screenshot_capture", { width: 1280, height: 720 }));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    // The choreography ran for the RIGHT tab with the tool's threaded dims
    // and NO panel options (expectVisible stays false — the background-tab
    // contract: an unmounted panel's webview is hidden).
    expect(captureState.staged).toEqual({ tabId: "tab-settings", options: { width: 1280, height: 720 } });
    expect(posted[0]).toEqual({
      commandId: "cmd-r124-a",
      result: { ok: true, data: captureState.reply },
    });
  });

  it("the staged capture's honest refusal is posted verbatim (never swallowed)", async () => {
    captureState.nativeAvailable = true;
    captureState.failWith = new Error("screenshot_capture: the app window is minimized — restore it and retry");
    dispatchBrowserCommand(frame("cmd-r124-b", "tab-min", "screenshot_capture", { width: 1280, height: 720 }));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].result.ok).toBe(false);
    expect(posted[0].result.error).toContain("the app window is minimized");
  });

  it("web dev mode (native unavailable) keeps the honest no-panel refusal — no webview exists to stage", async () => {
    captureState.nativeAvailable = false;
    dispatchBrowserCommand(frame("cmd-r124-c", "tab-web", "screenshot_capture", { width: 1280, height: 720 }));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(captureState.staged).toBeNull();
    expect(posted[0].result.ok).toBe(false);
    expect(posted[0].result.error).toContain("no embedded browser panel is mounted");
    expect(posted[0].result.error).toContain("running outside the desktop app");
  });

  it("other actions without a handler keep the pre-R124 refusal (only screenshot_capture is panel-independent)", async () => {
    captureState.nativeAvailable = true;
    dispatchBrowserCommand(frame("cmd-r124-d", "tab-none", "eval", { script: "return 1" }));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(captureState.staged).toBeNull();
    expect(posted[0].result.ok).toBe(false);
    expect(posted[0].result.error).toContain("no embedded browser panel is mounted");
  });

  it("a MOUNTED panel's handler still owns screenshot_capture (the fallback never shadows it)", async () => {
    captureState.nativeAvailable = true;
    registerBrowserCommandHandler("tab-mounted", () => ({ ok: true, data: { from: "panel" } }));
    dispatchBrowserCommand(frame("cmd-r124-e", "tab-mounted", "screenshot_capture", { width: 1280, height: 720 }));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(captureState.staged).toBeNull();
    expect(posted[0].result.data).toEqual({ from: "panel" });
  });
});
