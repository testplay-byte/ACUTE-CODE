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
// R132-CU2: the desk fakes' state.
const deskState = vi.hoisted(() => ({
  opened: [] as Array<{ url: string; downloadDir: string | null }>,
  failWith: null as Error | null,
  evals: [] as Array<{ tabId: string; script: string }>,
  evalFailWith: null as { ok: false; error: string } | null,
  evalValue: null as unknown,
  navigated: [] as string[],
}));
vi.mock("./native-browser", () => ({
  isNativeBrowserAvailable: () => captureState.nativeAvailable,
  // R132-CU2: the desk's native surface — the bridge's open_desk intercept
  // + the 'popout' eval answers ride these (faked; the REAL commands are
  // compile-gated Rust surface, pinned browser-tool-side for the tool half).
  POPOUT_TAB_ID: "popout",
  BROWSER_WINDOW_LABEL: "acute-browser",
  nativeOpenDesk: vi.fn(async (url: string, downloadDir: string | null) => {
    deskState.opened.push({ url, downloadDir });
    if (deskState.failWith !== null) throw deskState.failWith;
  }),
  nativeTabEval: vi.fn(async (tabId: string, script: string) => {
    deskState.evals.push({ tabId, script });
    if (deskState.evalFailWith !== null) return deskState.evalFailWith;
    return { ok: true, value: deskState.evalValue };
  }),
  nativeDeskNavigate: vi.fn(async (url: string) => {
    deskState.navigated.push(url);
  }),
}));
// R132-CU2: the shared evalJob protocol is faked at the seam — its deep
// behavior suite lives in the panel tests; HERE we pin the DISPATCH
// contract (which tab, which scripts, what reply).
const jobState = vi.hoisted(() => ({
  ran: [] as Array<{ tabId: string; script: string; installScript: string }>,
  reply: { ok: true, data: { ok: true, value: { started: true } } } as {
    ok: boolean;
    data?: unknown;
    error?: string;
  },
}));
vi.mock("./agent-browser-job", () => ({
  runEvalJobProtocol: vi.fn(async (tabId: string, script: string, installScript: string) => {
    jobState.ran.push({ tabId, script, installScript });
    return jobState.reply;
  }),
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
  deskState.opened.length = 0;
  deskState.failWith = null;
  deskState.evals.length = 0;
  deskState.evalFailWith = null;
  deskState.evalValue = null;
  deskState.navigated.length = 0;
  jobState.ran.length = 0;
  jobState.reply = { ok: true, data: { ok: true, value: { started: true } } };
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

// ── ROUND-132 (R132-CU2): the agent desk — the open_desk intercept + the
// 'popout' tab answers ──────────────────────────────────────────────────────
// The desk is the agent's own always-on-top browser screen: open_desk answers
// BEFORE any handler lookup (the desk needs no panel), and the desk's content
// tab ('popout' — a webview in the pop-out window, never panel-mounted)
// answers eval/evalJob through the native tab surface directly.
describe("agent-browser-bridge (R132-CU2: the agent desk)", () => {
  it("open_desk without native availability → the honest desktop-shell refusal (never a silent no-op)", async () => {
    dispatchBrowserCommand(frame("cmd-desk-1", "tab-any", "open_desk", { url: "https://en.wikipedia.org/" }));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].result.ok).toBe(false);
    expect(posted[0].result.error).toContain("the agent desk needs the desktop shell");
    expect(deskState.opened).toHaveLength(0);
  });

  it("open_desk with native availability → nativeOpenDesk(url, downloadDir) runs and the ok reply posts (PANEL-INDEPENDENT: no handler registered)", async () => {
    captureState.nativeAvailable = true;
    dispatchBrowserCommand(
      frame("cmd-desk-2", "tab-any", "open_desk", {
        url: "https://en.wikipedia.org/",
        downloadDir: "C:\\proj\\.acute\\downloads",
      }),
    );
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(deskState.opened).toEqual([{ url: "https://en.wikipedia.org/", downloadDir: "C:\\proj\\.acute\\downloads" }]);
    expect(posted[0].result.ok).toBe(true);
    expect(posted[0].result.data).toEqual({ url: "https://en.wikipedia.org/" });
  });

  it("open_desk with a null/absent downloadDir passes null through (no project bound)", async () => {
    captureState.nativeAvailable = true;
    dispatchBrowserCommand(frame("cmd-desk-3", "tab-any", "open_desk", { url: "file:///tmp/x.html" }));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(deskState.opened).toEqual([{ url: "file:///tmp/x.html", downloadDir: null }]);
  });

  it("open_desk with no url → the honest no-url refusal; a FAILED open surfaces the command's own error", async () => {
    captureState.nativeAvailable = true;
    dispatchBrowserCommand(frame("cmd-desk-4", "tab-any", "open_desk", {}));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].result.ok).toBe(false);
    expect(posted[0].result.error).toContain("no url");

    deskState.failWith = new Error("desk always-on-top failed: unsupported");
    dispatchBrowserCommand(frame("cmd-desk-5", "tab-any", "open_desk", { url: "https://en.wikipedia.org/" }));
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1].result.ok).toBe(false);
    expect(posted[1].result.error).toContain("desk always-on-top failed");
  });

  it("the desk's content tab: an eval for 'popout' with NO handler answers through nativeTabEval directly", async () => {
    captureState.nativeAvailable = true;
    deskState.evalValue = { title: "Desk page", text: "", markers: [] };
    dispatchBrowserCommand(frame("cmd-desk-6", "popout", "eval", { script: "return document.title" }));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(deskState.evals).toEqual([{ tabId: "popout", script: "return document.title" }]);
    // The Rust envelope rides as data — the same shape the panel's eval
    // handler answers (the tool reads data.ok/data.value directly).
    expect(posted[0].result).toEqual({ ok: true, data: { ok: true, value: { title: "Desk page", text: "", markers: [] } } });
  });

  it("the desk's evalJob rides the SHARED protocol (tabId 'popout' + the scripts verbatim)", async () => {
    captureState.nativeAvailable = true;
    jobState.reply = { ok: true, data: { ok: true, value: { done: true, result: "typed" } } };
    dispatchBrowserCommand(
      frame("cmd-desk-7", "popout", "evalJob", { script: "start", installScript: "install" }),
    );
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(jobState.ran).toEqual([{ tabId: "popout", script: "start", installScript: "install" }]);
    expect(posted[0].result).toEqual(jobState.reply);
  });

  it("a CLOSED desk answers the envelope's honest error (no webview for the tab — the tool surfaces it as the eval's page error)", async () => {
    captureState.nativeAvailable = true;
    deskState.evalFailWith = { ok: false, error: 'no native webview for tab "popout"' };
    dispatchBrowserCommand(frame("cmd-desk-8", "popout", "eval", { script: "return 1" }));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    // The command dispatched (ok:true) and the Rust envelope rides as data —
    // byte-identical to the PANEL's eval handler contract (the tool's
    // runPageScript reads data.ok === false → "page error: no native
    // webview for tab 'popout'" — the model learns the desk is closed).
    expect(posted[0].result.ok).toBe(true);
    expect(posted[0].result.data).toEqual({ ok: false, error: 'no native webview for tab "popout"' });
  });

  it("the desk legs never shadow a REGISTERED handler's tab (only the 'popout' id answers native-direct)", async () => {
    captureState.nativeAvailable = true;
    registerBrowserCommandHandler("tab-owned", () => ({ ok: true, data: { from: "panel" } }));
    dispatchBrowserCommand(frame("cmd-desk-9", "tab-owned", "eval", { script: "return 1" }));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].result.data).toEqual({ from: "panel" });
    expect(deskState.evals).toHaveLength(0);
  });
});
