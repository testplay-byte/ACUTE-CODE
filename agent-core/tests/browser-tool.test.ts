/**
 * ROUND-43 (R43-10) — the `browser_control` agent tool.
 *
 * Round-trips the REAL tool (buildProjectTools → execute) against the real
 * browser-proxy module state — no HTTP for the tool itself (the tool calls the
 * shared cores directly). The final test proves tool ↔ route state sharing by
 * booting a real server: a session minted over HTTP is what the tool's DEFAULT
 * sessionId resolution targets, and a tool navigation is visible over the
 * /browser/history route.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProjectTools } from "../src/tools/index";
// R62 (D8): the read action calls webFetch — network-free tests mock the
// fetcher (the real extractor has its own coverage in web-tool tests).
import * as webModule from "../src/tools/web.js";
vi.mock("../src/tools/web.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/web.js")>();
  return { ...actual, webFetch: vi.fn() };
});
const webFetchMock = vi.mocked(webModule.webFetch);
// R62 (D8): the browser command bridge + computer relay fakes.
import {
  resolveBrowserCommand,
  sendBrowserCommand,
} from "../src/browser-command.js";
// R66 (A4): the checkpoint registry — wait_for_verification tests resolve the
// owner's answer through the real module (the REST route's core).
import {
  pendingBrowserCheckpointCount,
  resetBrowserCheckpointsForTest,
  resolveBrowserCheckpoint,
} from "../src/browser-checkpoint.js";
import {
  resetActiveComputerRelayForTest,
  setActiveComputerRelay,
} from "../src/tools/plugins/computer-relay.js";
import { buildServer } from "../src/server";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { ProviderKeyring } from "../src/providers/registry";
import { resetBrowserStoreForTest, browserSessionForChatSession } from "../src/browser-proxy";
import type { ToolSet } from "ai";

// The AI SDK tool contract — narrow to what the tests call.
type Tool = { execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }> };
function tool(set: ToolSet, name: string): Tool {
  return (set as unknown as Record<string, Tool>)[name];
}

let tempDir = "";

/**
 * R67: an emit channel that ALSO answers the wall-probe browser-commands
 * (the navigate action probes the live page through the bridge; a test emit
 * that never resolves would pend the tool's 5s probe timeout — the same
 * pattern the eval tests use with queueMicrotask + resolveBrowserCommand).
 */
function makeRecordingEmit(frames: unknown[]): (event: unknown) => void {
  return (event: unknown) => {
    frames.push(event);
    const frame = event as { type?: string; commandId?: string };
    if (frame.type === "browser-command" && typeof frame.commandId === "string") {
      queueMicrotask(() => {
        resolveBrowserCommand(frame.commandId as string, {
          ok: true,
          data: { ok: true, value: { title: "Clean page", text: "", markers: [] } },
        });
      });
    }
  };
}

/**
 * ROUND-45 (P0-5): browser_control navigate (and web_fetch) are host-gated —
 * the tool needs a ToolDeps with an approval channel. This helper builds one
 * against a fresh per-test DB (migrations run → web_host_rules exists).
 */
async function buildTools(root: string, deps?: { emit?: (event: unknown) => void }) {
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  return buildProjectTools(root, undefined, {
    db,
    sessionId: "sess_browser_tool",
    agentId: "agt_browser_tool",
    projectId: "proj_browser_tool",
    ...deps,
  });
}

let db: SqliteDatabase;
let app: Awaited<ReturnType<typeof buildServer>> | null = null;
const TOKEN = "test-token-browse";

beforeEach(async () => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-browser-tool-"));
  // Fresh module store per test → deterministic DEFAULT sessionId resolution.
  resetBrowserStoreForTest();
  resetActiveComputerRelayForTest();
  resetBrowserCheckpointsForTest();
  webFetchMock.mockReset();
});

afterEach(() => {
  resetActiveComputerRelayForTest();
});

afterEach(async () => {
  if (app !== null) {
    await app.close();
    app = null;
  }
  if (db !== undefined) db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* Windows handle lag — best effort */
  }
});

describe("browser_control — navigate / history round-trip", () => {
  it("navigate pushes history, get_state reads it back, back/forward walk it", async () => {
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");

    const first = await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/one", sessionId: "tool-tab-1" });
    expect(first.ok).toBe(true);
    expect(first.output).toContain("https://en.wikipedia.org/one");

    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/two", sessionId: "tool-tab-1" });

    const state = await bc.execute({ action: "get_state", sessionId: "tool-tab-1" });
    expect(state.ok).toBe(true);
    const parsed = JSON.parse(state.output) as { currentUrl: string; index: number; canBack: boolean; canForward: boolean };
    expect(parsed.currentUrl).toBe("https://en.wikipedia.org/two");
    expect(parsed.index).toBe(1);
    expect(parsed.canBack).toBe(true);
    expect(parsed.canForward).toBe(false);

    const back = await bc.execute({ action: "back", sessionId: "tool-tab-1" });
    expect(back.ok).toBe(true);
    expect(back.output).toContain("https://en.wikipedia.org/one");

    const mid = await bc.execute({ action: "get_state", sessionId: "tool-tab-1" });
    expect((JSON.parse(mid.output) as { currentUrl: string; canForward: boolean }).currentUrl).toBe("https://en.wikipedia.org/one");

    const forward = await bc.execute({ action: "forward", sessionId: "tool-tab-1" });
    expect(forward.ok).toBe(true);
    expect(forward.output).toContain("https://en.wikipedia.org/two");

    // Boundary: back beyond the first entry is an honest noop.
    await bc.execute({ action: "back", sessionId: "tool-tab-1" });
    const boundary = await bc.execute({ action: "back", sessionId: "tool-tab-1" });
    expect(boundary.ok).toBe(true);
    expect(boundary.output).toContain("did nothing");

    // reload reports the current entry.
    const reload = await bc.execute({ action: "reload", sessionId: "tool-tab-1" });
    expect(reload.ok).toBe(true);
    expect(reload.output).toContain("reload");
  });

  it("records titles via navigate (same URL = title-update, not a new entry)", async () => {
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/doc", sessionId: "tool-tab-2" });
    const titled = await bc.execute({
      action: "navigate",
      url: "https://en.wikipedia.org/doc",
      sessionId: "tool-tab-2",
    });
    // No title provided → same-URL navigate is still not a second entry.
    const state = JSON.parse((await bc.execute({ action: "get_state", sessionId: "tool-tab-2" })).output) as {
      historyLength: number;
    };
    expect(state.historyLength).toBe(1);
    expect(titled.ok).toBe(true);
  });
});

describe("browser_control — set_viewport", () => {
  it("applies presets, custom sizes, zoom and rotate; get_state returns them", async () => {
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");

    const preset = await bc.execute({ action: "set_viewport", preset: "mobile-sm", sessionId: "tool-tab-vp" });
    expect(preset.ok).toBe(true);
    expect(preset.output).toContain("375×667");

    const custom = await bc.execute({
      action: "set_viewport",
      width: 480,
      height: 320,
      zoom: 1.5,
      rotate: true,
      sessionId: "tool-tab-vp",
    });
    expect(custom.ok).toBe(true);
    expect(custom.output).toContain("rotated");

    const state = JSON.parse((await bc.execute({ action: "get_state", sessionId: "tool-tab-vp" })).output) as {
      viewport: { width: number; height: number; preset: string; zoom: number; rotate: boolean };
    };
    expect(state.viewport).toMatchObject({ width: 480, height: 320, preset: "custom", zoom: 1.5, rotate: true });
  });

  it("rejects out-of-bounds sizes, unknown presets, and empty patches", async () => {
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");

    const narrow = await bc.execute({ action: "set_viewport", width: 100, sessionId: "tool-tab-vp2" });
    expect(narrow.ok).toBe(false);
    expect(narrow.output).toContain("browser_control:");

    const huge = await bc.execute({ action: "set_viewport", height: 9999, sessionId: "tool-tab-vp2" });
    expect(huge.ok).toBe(false);

    const badPreset = await bc.execute({ action: "set_viewport", preset: "cinema", sessionId: "tool-tab-vp2" });
    expect(badPreset.ok).toBe(false);
    expect(badPreset.output).toContain("preset");

    const badZoom = await bc.execute({ action: "set_viewport", zoom: 5, sessionId: "tool-tab-vp2" });
    expect(badZoom.ok).toBe(false);

    const empty = await bc.execute({ action: "set_viewport", sessionId: "tool-tab-vp2" });
    expect(empty.ok).toBe(false);
    expect(empty.output).toContain("requires preset");
  });
});

describe("browser_control — input validation + default sessionId", () => {
  it("R67/E3: an UNBOUND chat session mints its own ag-<chatSession> tab (never another session's tab)", async () => {
    const frames: unknown[] = [];
    const tools = await buildTools(tempDir, { emit: makeRecordingEmit(frames) });
    const bc = tool(tools, "browser_control");

    const nav = await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/agent-default" });
    expect(nav.ok).toBe(true);
    // The minted deterministic agent tab id for chat session sess_browser_tool.
    expect(nav.output).not.toContain("no chat-session context");

    const state = JSON.parse((await bc.execute({ action: "get_state" })).output) as { sessionId: string; currentUrl: string };
    expect(state.sessionId).toBe("ag-sess_browser_tool");
    expect(state.currentUrl).toBe("https://en.wikipedia.org/agent-default");

    // The mint announced itself with a browser-open frame (the sidebar opens
    // the real tab — the owner's leak fix: the frame carries the minted id).
    const opened = frames.find((f) => (f as { type?: string }).type === "browser-open") as
      | { tabId: string; chatSessionId: string; url: string | null }
      | undefined;
    expect(opened).toBeDefined();
    expect(opened?.tabId).toBe("ag-sess_browser_tool");
    expect(opened?.chatSessionId).toBe("sess_browser_tool");

    // A SECOND chat session is isolated: it mints its OWN tab, never drives
    // the first session's (the owner's cross-session leak report).
    const toolsB = await buildProjectTools(tempDir, undefined, {
      db,
      sessionId: "sess_browser_tool_b",
      agentId: "agt_browser_tool",
      projectId: "proj_browser_tool",
    });
    const bcB = tool(toolsB, "browser_control");
    const navB = await bcB.execute({ action: "navigate", url: "https://en.wikipedia.org/session-b" });
    expect(navB.ok).toBe(true);
    const stateB = JSON.parse((await bcB.execute({ action: "get_state" })).output) as { sessionId: string; currentUrl: string };
    expect(stateB.sessionId).toBe("ag-sess_browser_tool_b");
    expect(stateB.currentUrl).toBe("https://en.wikipedia.org/session-b");
    // Session A's tab is untouched by B's navigation.
    const stateA = JSON.parse((await bc.execute({ action: "get_state" })).output) as { currentUrl: string };
    expect(stateA.currentUrl).toBe("https://en.wikipedia.org/agent-default");
  });

  it("R67/E3: a session WITHOUT a chat-session id (catalog context) keeps the shared 'agent' fallback", async () => {
    // Fresh db — afterEach closes the module-level one after each test.
    db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    const tools = await buildProjectTools(tempDir, undefined, {
      db,
      // The catalog-style context: NO chat session — the legacy fallback.
      sessionId: "",
      agentId: "agt_browser_tool",
    });
    const bc = tool(tools, "browser_control");
    const nav = await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/agent-fallback" });
    expect(nav.ok).toBe(true);
    expect(nav.output).toContain("no chat-session context");
    const state = JSON.parse((await bc.execute({ action: "get_state" })).output) as { sessionId: string };
    expect(state.sessionId).toBe("agent");
  });

  it("explicit sessionIds are validated and isolated from each other", async () => {
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");

    const badId = await bc.execute({ action: "get_state", sessionId: "../evil id" });
    expect(badId.ok).toBe(false);
    expect(badId.output).toContain("sessionId");

    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/a", sessionId: "sess-a" });
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/b", sessionId: "sess-b" });
    const a = JSON.parse((await bc.execute({ action: "get_state", sessionId: "sess-a" })).output) as { currentUrl: string };
    expect(a.currentUrl).toBe("https://en.wikipedia.org/a");
  });

  it("navigate demands an absolute http(s) url; unknown actions are refused", async () => {
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");

    expect((await bc.execute({ action: "navigate", sessionId: "sess-v" })).ok).toBe(false);
    const fileUrl = await bc.execute({ action: "navigate", url: "file:///etc/passwd", sessionId: "sess-v" });
    expect(fileUrl.ok).toBe(false);
    expect(fileUrl.output).toContain("http(s)");

    expect((await bc.execute({ action: "sideways", sessionId: "sess-v" })).ok).toBe(false);
  });
});

describe("browser_control ↔ route state sharing (one server, no self-fetch)", () => {
  it("R67/E3: a BOUND chat session defaults to its declared tab; tool pushes are visible over HTTP", async () => {
    // ROUND-45: buildTools opens a fresh db AND assigns it to the module-level
    // `db` — do it FIRST so the server and the afterEach cleanup share it.
    await buildTools(tempDir);
    app = buildServer({
      token: TOKEN,
      db,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: "sk-or-vtest" }),
    });

    // The panel flow: mint a session over HTTP (the route store registers as
    // the active tool store) — the tab the user is viewing.
    const mint = await app.inject({
      method: "POST",
      url: "/api/v1/browser/session",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { sessionId: "tab-live-1" },
    });
    expect(mint.statusCode).toBe(200);

    // R67/E3: the frontend declares the chat session's tab binding over
    // HTTP (what AgentChatPanel posts before a turn starts).
    const bind = await app.inject({
      method: "POST",
      url: "/api/v1/browser/bind",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { chatSessionId: "sess_browser_tool", sessionId: "tab-live-1" },
    });
    expect(bind.statusCode).toBe(200);
    expect((bind.json() as { ok: boolean }).ok).toBe(true);

    const tools = await buildProjectTools(tempDir, undefined, {
      db,
      sessionId: "sess_browser_tool",
      agentId: "agt_browser_tool",
      projectId: "proj_browser_tool",
    });
    const bc = tool(tools, "browser_control");

    // No explicit sessionId → targets the BOUND tab (tab-live-1).
    const nav = await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/shared" });
    expect(nav.ok).toBe(true);

    // The ROUTE sees the tool's push (same store, no HTTP self-fetch).
    const history = await app.inject({
      method: "GET",
      url: "/api/v1/browser/history?sessionId=tab-live-1",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(history.statusCode).toBe(200);
    const body = history.json() as { entries: Array<{ url: string }>; index: number; canBack: boolean };
    expect(body.entries.map((e) => e.url)).toEqual(["https://en.wikipedia.org/shared"]);
    expect(body.index).toBe(0);

    // And the agent's viewport write is what the panel would GET.
    await bc.execute({ action: "set_viewport", preset: "mobile-md" });
    const viewport = await app.inject({
      method: "GET",
      url: "/api/v1/browser/viewport?sessionId=tab-live-1",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect((viewport.json() as { viewport: { width: number; preset: string } }).viewport).toMatchObject({
      width: 390,
      preset: "mobile-md",
    });
  });

  it("R67/E3: POST /browser/bind validates honestly (bad ids 400; null clears a binding)", async () => {
    await buildTools(tempDir);
    app = buildServer({
      token: TOKEN,
      db,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: "sk-or-vtest" }),
    });
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/browser/bind",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { chatSessionId: "sess-x", sessionId: "../evil id" },
    });
    expect(bad.statusCode).toBe(400);
    const noChat = await app.inject({
      method: "POST",
      url: "/api/v1/browser/bind",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { sessionId: "tab-1" },
    });
    expect(noChat.statusCode).toBe(400);

    // null clears: after clearing, an unbound session mints its own tab.
    await app.inject({
      method: "POST",
      url: "/api/v1/browser/bind",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { chatSessionId: "sess-y", sessionId: "tab-keep" },
    });
    const cleared = await app.inject({
      method: "POST",
      url: "/api/v1/browser/bind",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { chatSessionId: "sess-y", sessionId: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(browserSessionForChatSession("sess-y")).toBeNull();
  });
});


// ── ROUND-62 (D8): read / eval / screenshot / enriched get_state ──────────

describe("browser_control — read (R62: the current page's text, server-side)", () => {
  it("read returns the panel's current page text (title + url header)", async () => {
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/page", sessionId: "tool-tab-read" });
    webFetchMock.mockResolvedValue({ ok: true, output: "Example Domain. This domain is for use in examples." });

    const read = await bc.execute({ action: "read", sessionId: "tool-tab-read" });
    expect(read.ok).toBe(true);
    expect(read.output).toContain("https://en.wikipedia.org/page");
    expect(read.output).toContain("Example Domain");
    expect(webFetchMock).toHaveBeenCalledWith("https://en.wikipedia.org/page");
  });

  it("read truncates honestly at maxChars and refuses without a page", async () => {
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/long", sessionId: "tool-tab-read2" });
    webFetchMock.mockResolvedValue({ ok: true, output: "x".repeat(5000) });

    const short = await bc.execute({ action: "read", maxChars: 1000, sessionId: "tool-tab-read2" });
    expect(short.ok).toBe(true);
    expect(short.output).toContain("truncated");

    const noPage = await bc.execute({ action: "read", sessionId: "never-opened" });
    expect(noPage.ok).toBe(false);
    expect(noPage.output).toContain("no page is open");
  });

  it("read surfaces a fetch failure instead of pretending success", async () => {
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/dead", sessionId: "tool-tab-read3" });
    webFetchMock.mockResolvedValue({ ok: false, output: "web_fetch: request failed: ECONNREFUSED" });
    const failed = await bc.execute({ action: "read", sessionId: "tool-tab-read3" });
    expect(failed.ok).toBe(false);
    expect(failed.output).toContain("ECONNREFUSED");
  });
});

describe("browser_control — eval (R62: JavaScript in the live page, via the SSE bridge)", () => {
  it("eval sends the command frame on the turn stream and returns the page's value", async () => {
    let captured: unknown = null;
    const emit = (event: unknown) => {
      captured = event;
      // The frontend's bridge answers asynchronously — resolve the pending
      // tool promise through the real module (the REST route's core).
      const frame = event as { type: string; commandId: string; tabId: string; action: string };
      expect(frame.type).toBe("browser-command");
      expect(frame.tabId).toBe("tool-tab-eval");
      expect(frame.action).toBe("eval");
      queueMicrotask(() => {
        resolveBrowserCommand(frame.commandId, { ok: true, data: { ok: true, value: { title: "Live DOM title" } } });
      });
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/app", sessionId: "tool-tab-eval" });

    const result = await bc.execute({ action: "eval", script: "return document.title", sessionId: "tool-tab-eval" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Live DOM title");
    expect(captured).not.toBeNull();
  });

  it("eval fails closed without a live emit channel, and surfaces page errors", async () => {
    const tools = await buildTools(tempDir); // no emit in deps
    const bc = tool(tools, "browser_control");
    const noChannel = await bc.execute({ action: "eval", script: "return 1", sessionId: "tool-tab-eval2" });
    expect(noChannel.ok).toBe(false);
    expect(noChannel.output).toContain("no live stream channel");

    // With a channel but a page-level error: the {ok:false} envelope.
    const emit = (event: unknown) => {
      const frame = event as { commandId: string };
      queueMicrotask(() => resolveBrowserCommand(frame.commandId, { ok: true, data: { ok: false, error: "TypeError: null is not an object" } }));
    };
    const tools2 = await buildTools(tempDir, { emit });
    const bc2 = tool(tools2, "browser_control");
    const pageError = await bc2.execute({ action: "eval", script: "return bad(", sessionId: "tool-tab-eval2" });
    expect(pageError.ok).toBe(false);
    expect(pageError.output).toContain("TypeError");
  });

  it("eval validates the script (empty / oversized) before sending anything", async () => {
    const emit = vi.fn();
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");
    const empty = await bc.execute({ action: "eval", script: "  ", sessionId: "tool-tab-eval3" });
    expect(empty.ok).toBe(false);
    const huge = await bc.execute({ action: "eval", script: "x".repeat(20001), sessionId: "tool-tab-eval3" });
    expect(huge.ok).toBe(false);
    expect(huge.output).toContain("20000");
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("browser_control — screenshot (R62: computer-use capture + vision relay)", () => {
  it("fails closed with the enable-Computer-Use pointer when the relay is not armed", async () => {
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/shot", sessionId: "tool-tab-shot" });
    const result = await bc.execute({ action: "screenshot", sessionId: "tool-tab-shot" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Computer Use");
    expect(result.output).toContain("read");
  });

  it("captures the panel REGION the UI reports and relays vision (honest off-mode note when vision is off)", async () => {
    const captured: Array<{ x: number; y: number; w: number; h: number }> = [];
    const relay = {
      backend: {
        captureRegion: async (_run: unknown, region: { x: number; y: number; w: number; h: number }) => {
          captured.push(region);
          return {
            pngBase64: "aW1n",
            width: region.w,
            height: region.h,
            scale: 1,
            origin: { x: region.x, y: region.y },
          };
        },
      },
      run: vi.fn(),
      session: { record: vi.fn() },
    };
    setActiveComputerRelay(relay as never);
    const emit = (event: unknown) => {
      const frame = event as { commandId: string };
      queueMicrotask(() =>
        resolveBrowserCommand(frame.commandId, {
          ok: true,
          data: { supported: true, region: { x: 100, y: 200, w: 800, h: 600 }, scaleFactor: 2, mode: "native" },
        }),
      );
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/shot2", sessionId: "tool-tab-shot2" });

    const result = await bc.execute({ action: "screenshot", sessionId: "tool-tab-shot2" });
    // Vision defaults OFF (fresh DB) → the tool is still ok:true with the
    // honest unavailable note; the CAPTURE happened with the UI's region.
    expect(result.ok).toBe(true);
    expect(result.output).toContain("panel region 800×600");
    expect(result.output).toContain("vision description is unavailable");
    expect(captured).toEqual([{ x: 100, y: 200, w: 800, h: 600 }]);
    // R66 (A1): browser screenshots NO LONGER record into the computer-use
    // monitor ring — the owner must never see "agent is using your computer"
    // during browser turns. The capture + vision note stand alone.
    expect(relay.session.record).not.toHaveBeenCalled();
  });

  it("no region answer → falls back to a full-display capture", async () => {
    const displayCaptures: number[] = [];
    const relay = {
      backend: {
        captureDisplay: async (_run: unknown, displayIndex: number) => {
          displayCaptures.push(displayIndex);
          return { pngBase64: "aW1n", width: 1920, height: 1080, scale: 1, origin: { x: 0, y: 0 } };
        },
      },
      run: vi.fn(),
      session: { record: vi.fn() },
    };
    setActiveComputerRelay(relay as never);
    const tools = await buildTools(tempDir); // no emit → no screenshot_meta ask at all
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/shot3", sessionId: "tool-tab-shot3" });
    const result = await bc.execute({ action: "screenshot", sessionId: "tool-tab-shot3" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("full display capture");
    expect(displayCaptures).toEqual([1]);
  });

  it("a failed capture surfaces the backend's error", async () => {
    const relay = {
      backend: {
        captureDisplay: async () => ({ error: "no scrot, no import" }),
      },
      run: vi.fn(),
      session: { record: vi.fn() },
    };
    setActiveComputerRelay(relay as never);
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/shot4", sessionId: "tool-tab-shot4" });
    const result = await bc.execute({ action: "screenshot", sessionId: "tool-tab-shot4" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("no scrot, no import");
  });
});

describe("browser_control — get_state enrichment (R62: tabs + active tab)", () => {
  it("R67/E3: get_state is SCOPED to the addressed tab — another session's tabs are never listed (the leak fix)", async () => {
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/a", sessionId: "tab-alpha" });
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/b", sessionId: "tab-beta" });
    const state = JSON.parse((await bc.execute({ action: "get_state", sessionId: "tab-alpha" })).output) as {
      activeTab: string | null;
      tabs: Array<{ sessionId: string; currentUrl: string | null }>;
    };
    // Only the ADDRESSED tab is listed — the old behavior (every session's
    // tab globally) invited the model to drive another session's tab.
    expect(state.tabs.map((t) => t.sessionId)).toEqual(["tab-alpha"]);
    expect(state.activeTab).toBe("tab-alpha");
    expect(state.tabs.find((t) => t.sessionId === "tab-alpha")?.currentUrl).toBe("https://en.wikipedia.org/a");
  });
});

describe("browser_control — the R67 instant frames (E1: navigate; E3: open)", () => {
  it("navigate emits {type:'browser-navigate', tabId, url} on the turn stream after the command succeeds", async () => {
    const frames: unknown[] = [];
    const tools = await buildTools(tempDir, { emit: makeRecordingEmit(frames) });
    const bc = tool(tools, "browser_control");
    const nav = await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/frame-nav" });
    expect(nav.ok).toBe(true);
    const frame = frames.find((f) => (f as { type?: string }).type === "browser-navigate") as
      | { tabId: string; url: string }
      | undefined;
    expect(frame).toBeDefined();
    expect(frame?.tabId).toBe("ag-sess_browser_tool");
    expect(frame?.url).toBe("https://en.wikipedia.org/frame-nav");
  });

  it("back/forward announce the landed URL too; a noop boundary emits nothing", async () => {
    const frames: unknown[] = [];
    const tools = await buildTools(tempDir, { emit: makeRecordingEmit(frames) });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/f1" });
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/f2" });
    frames.length = 0;
    const back = await bc.execute({ action: "back" });
    expect(back.ok).toBe(true);
    const frame = frames.find((f) => (f as { type?: string }).type === "browser-navigate") as
      | { url: string }
      | undefined;
    expect(frame?.url).toBe("https://en.wikipedia.org/f1");
  });

  it("an emit that throws never breaks the action (the 4s poll is the backfill)", async () => {
    const tools = await buildTools(tempDir, {
      emit: () => {
        throw new Error("stream channel gone");
      },
    });
    const bc = tool(tools, "browser_control");
    const nav = await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/emit-throws" });
    expect(nav.ok).toBe(true);
  });
});

describe("browser command bridge (R62 D8) — the REST result route", () => {
  it("POST /browser-commands/:id/result resolves a live command; unknown ids 404", async () => {
    await buildTools(tempDir);
    app = buildServer({
      token: TOKEN,
      db,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: "sk-or-vtest" }),
    });
    const frames: Array<{ commandId: string }> = [];
    const pending = sendBrowserCommand(
      (event) => {
        frames.push(event as { commandId: string });
      },
      "tab-route",
      "eval",
      { script: "return 1" },
    );
    // Not yet answered → the command is pending.
    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/browser-commands/bogus/result",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      payload: { ok: true, data: {} },
    });
    expect(unknown.statusCode).toBe(404);

    const answered = await app.inject({
      method: "POST",
      url: `/api/v1/browser-commands/${frames[0].commandId}/result`,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      payload: { ok: true, data: { ok: true, value: 41 } },
    });
    expect(answered.statusCode).toBe(204);
    await expect(pending).resolves.toEqual({ ok: true, value: 41 });
  });

  it("sendBrowserCommand times out honestly when the UI never answers", async () => {
    await expect(
      sendBrowserCommand(() => {}, "tab-timeout", "eval", { script: "return 1" }, 30),
    ).rejects.toThrow(/timed out/);
  });
});

// ── ROUND-66 (R66, A3/A6): click / type / press_key / source / read_dom ────
// All five ride the eval bridge as ONE compiled script each; user input is
// embedded via JSON.stringify ONLY (injection safety), and they fail closed
// without a live emit channel exactly like the raw eval action.

describe("browser_control — click (R66: element interaction via the eval bridge)", () => {
  it("click by selector sends ONE eval command with the escaped selector and returns the clicked element", async () => {
    const commands: Array<{ action: string; script: string }> = [];
    const emit = (event: unknown) => {
      const frame = event as { type: string; commandId: string; action: string; payload: { script?: string } };
      expect(frame.type).toBe("browser-command");
      commands.push({ action: frame.action, script: String(frame.payload.script ?? "") });
      queueMicrotask(() =>
        resolveBrowserCommand(frame.commandId, {
          ok: true,
          data: { ok: true, value: { clicked: { tag: "button", text: "Search", id: "search-btn" } } },
        }),
      );
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({ action: "click", selector: 'button[type="submit"]', sessionId: "tab-click" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("button");
    expect(result.output).toContain("Search");
    expect(commands).toHaveLength(1);
    expect(commands[0].action).toBe("eval");
    // Injection safety: the selector rides as a JSON string literal, never
    // concatenated raw into the script.
    expect(commands[0].script).toContain(JSON.stringify('button[type="submit"]'));
    expect(commands[0].script).toContain("scrollIntoView");
  });

  it("click by text embeds the text + nth and scans the clickable set", async () => {
    const scripts: string[] = [];
    const emit = (event: unknown) => {
      const frame = event as { commandId: string; payload: { script?: string } };
      scripts.push(String(frame.payload.script ?? ""));
      queueMicrotask(() =>
        resolveBrowserCommand(frame.commandId, {
          ok: true,
          data: { ok: true, value: { clicked: { tag: "a", text: "Sign in", href: "/login" } } },
        }),
      );
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({ action: "click", text: "Sign in", nth: 2, sessionId: "tab-click-text" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Sign in");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain(JSON.stringify("Sign in"));
    expect(scripts[0]).toContain(JSON.stringify(2));
    // The clickable scan set + label sources from the contract.
    expect(scripts[0]).toContain("input[type=submit]");
    expect(scripts[0]).toContain('[role="button"]');
    expect(scripts[0]).toContain("aria-label");
  });

  it("click with neither selector nor text is an honest error; a page-level miss surfaces the script's error", async () => {
    const emit = (event: unknown) => {
      const frame = event as { commandId: string };
      queueMicrotask(() =>
        resolveBrowserCommand(frame.commandId, { ok: true, data: { ok: true, value: { error: "no element matches the CSS selector" } } }),
      );
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const noTarget = await bc.execute({ action: "click", sessionId: "tab-click3" });
    expect(noTarget.ok).toBe(false);
    expect(noTarget.output).toContain("selector");

    const miss = await bc.execute({ action: "click", selector: ".not-there", sessionId: "tab-click3" });
    expect(miss.ok).toBe(false);
    expect(miss.output).toContain("no element matches the CSS selector");
  });
});

describe("browser_control — type (R66: the framework-visible value setter)", () => {
  it("type embeds selector+text, uses the native value setter path, and requestSubmit when submit:true", async () => {
    const scripts: string[] = [];
    const emit = (event: unknown) => {
      const frame = event as { commandId: string; payload: { script?: string } };
      scripts.push(String(frame.payload.script ?? ""));
      queueMicrotask(() =>
        resolveBrowserCommand(frame.commandId, {
          ok: true,
          data: { ok: true, value: { typed: 'input[name="q"]', submitted: true, submitHow: "form.requestSubmit()" } },
        }),
      );
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({
      action: "type",
      selector: 'input[name="q"]',
      text: "acute code editor",
      submit: true,
      sessionId: "tab-type",
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("submitted");
    expect(result.output).toContain("requestSubmit");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain(JSON.stringify('input[name="q"]'));
    expect(scripts[0]).toContain(JSON.stringify("acute code editor"));
    // The Google-search fix: native prototype value setter + input/change
    // events (React/Vue) + requestSubmit (native form submission).
    expect(scripts[0]).toContain("getOwnPropertyDescriptor");
    expect(scripts[0]).toContain("requestSubmit");
    expect(scripts[0]).toContain('new Event("input"');
    expect(scripts[0]).toContain('new Event("change"');
  });

  it("type without submit dispatches no requestSubmit; missing selector/text is refused", async () => {
    const scripts: string[] = [];
    const emit = (event: unknown) => {
      const frame = event as { commandId: string; payload: { script?: string } };
      scripts.push(String(frame.payload.script ?? ""));
      queueMicrotask(() =>
        resolveBrowserCommand(frame.commandId, {
          ok: true,
          data: { ok: true, value: { typed: "#search", submitted: false, submitHow: "" } },
        }),
      );
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({ action: "type", selector: "#search", text: "hello", sessionId: "tab-type2" });
    expect(result.ok).toBe(true);
    expect(result.output).not.toContain("The form was submitted");
    // The submit branch is compiled in but gated on the submit flag.
    expect(scripts[0]).toContain(JSON.stringify(false));

    const missing = await bc.execute({ action: "type", text: "hello", sessionId: "tab-type2" });
    expect(missing.ok).toBe(false);
    expect(missing.output).toContain("selector");
  });
});

describe("browser_control — press_key (R66: the Enter→requestSubmit fix)", () => {
  it("press_key Enter dispatches the key trio AND calls form.requestSubmit (the A3 Google fix)", async () => {
    const scripts: string[] = [];
    const emit = (event: unknown) => {
      const frame = event as { commandId: string; payload: { script?: string } };
      scripts.push(String(frame.payload.script ?? ""));
      queueMicrotask(() =>
        resolveBrowserCommand(frame.commandId, { ok: true, data: { ok: true, value: { pressed: "Enter", submitted: true } } }),
      );
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({ action: "press_key", key: "Enter", selector: 'input[name="q"]', sessionId: "tab-key" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Enter");
    expect(result.output).toContain("submitted natively");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain(JSON.stringify("Enter"));
    expect(scripts[0]).toContain(JSON.stringify('input[name="q"]'));
    expect(scripts[0]).toContain("requestSubmit");
    expect(scripts[0]).toContain("keydown");
    expect(scripts[0]).toContain("keypress");
    expect(scripts[0]).toContain("keyup");
    expect(scripts[0]).toContain("keyCode");
  });

  it("press_key requires a key and refuses absurd ones", async () => {
    const tools = await buildTools(tempDir, { emit: () => {} });
    const bc = tool(tools, "browser_control");
    const noKey = await bc.execute({ action: "press_key", sessionId: "tab-key2" });
    expect(noKey.ok).toBe(false);
    expect(noKey.output).toContain("key");
    const longKey = await bc.execute({ action: "press_key", key: "a".repeat(40), sessionId: "tab-key2" });
    expect(longKey.ok).toBe(false);
    expect(longKey.output).toContain("single key name");
  });
});

describe("browser_control — source / read_dom (R66: page content without screenshots)", () => {
  it("source html compiles ONE eval script (outerHTML + in-script maxChars cap) and returns the payload", async () => {
    const scripts: string[] = [];
    const emit = (event: unknown) => {
      const frame = event as { commandId: string; payload: { script?: string } };
      scripts.push(String(frame.payload.script ?? ""));
      queueMicrotask(() =>
        resolveBrowserCommand(frame.commandId, {
          ok: true,
          data: { ok: true, value: { part: "html", selector: "", chars: 210, content: "<html><body>hi</body></html>" } },
        }),
      );
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({ action: "source", part: "html", maxChars: 8000, sessionId: "tab-source" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("source html ok");
    expect(result.output).toContain("<html><body>hi</body></html>");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("outerHTML");
    expect(scripts[0]).toContain(JSON.stringify(8000));
    expect(scripts[0]).toContain("truncated");

    const badPart = await bc.execute({ action: "source", sessionId: "tab-source" });
    expect(badPart.ok).toBe(false);
    expect(badPart.output).toContain("part html | css | scripts");
  });

  it("read_dom returns the structured outline JSON (short selectors, visible-only interactives)", async () => {
    const scripts: string[] = [];
    const outline = {
      title: "Example Domain",
      url: "https://example.com/",
      headings: [{ tag: "h1", text: "Example Domain" }],
      interactive: [{ tag: "a", text: "More information", selector: "body > a:nth-of-type(1)", rect: { w: 120, h: 20 } }],
      forms: [],
      paragraphs: undefined,
    };
    const emit = (event: unknown) => {
      const frame = event as { commandId: string; payload: { script?: string } };
      scripts.push(String(frame.payload.script ?? ""));
      queueMicrotask(() => resolveBrowserCommand(frame.commandId, { ok: true, data: { ok: true, value: outline } }));
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({ action: "read_dom", sessionId: "tab-dom" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("read_dom ok");
    expect(result.output).toContain("Example Domain");
    expect(result.output).toContain("nth-of-type");
    expect(scripts).toHaveLength(1);
    // The outline builder: short selector chain + page-visibility filter.
    expect(scripts[0]).toContain("nth-of-type");
    expect(scripts[0]).toContain("getBoundingClientRect");
    expect(scripts[0]).toContain("document.forms");
  });

  it("the new bridge actions all fail closed without a live emit channel", async () => {
    const tools = await buildTools(tempDir); // no emit in deps
    const bc = tool(tools, "browser_control");
    for (const input of [
      { action: "click", text: "Sign in" },
      { action: "type", selector: "#q", text: "hi" },
      { action: "press_key", key: "Enter" },
      { action: "source", part: "html" },
      { action: "read_dom" },
    ]) {
      const refused = await bc.execute({ ...input, sessionId: "tab-noc" });
      expect(refused.ok).toBe(false);
      expect(refused.output).toContain("no live stream channel");
    }
  });

  it("every compiled page script (incl. the wall probe) is syntactically valid JavaScript", async () => {
    // The bridge is mocked everywhere else, so the scripts never RUN here —
    // this compiles each generated script as a function body (exactly what
    // the Rust browser_tab_eval wrapper does) to prove the builders emit
    // parseable JS before the owner's first live Windows run.
    const scripts: string[] = [];
    const emit = (event: unknown) => {
      const frame = event as { type?: string; action?: string; commandId: string; payload?: { script?: string } };
      if (frame.type === "browser-command" && typeof frame.payload?.script === "string") {
        scripts.push(frame.payload.script);
      }
      queueMicrotask(() =>
        resolveBrowserCommand(frame.commandId, {
          ok: true,
          data: { ok: true, value: { clicked: {}, typed: "x", submitted: false, part: "html", content: "x", title: "t", text: "", markers: [] } },
        }),
      );
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/compile", sessionId: "tab-compile" }); // the wall probe script
    await bc.execute({ action: "click", selector: "#a", sessionId: "tab-compile" });
    await bc.execute({ action: "click", text: "Sign in", nth: 2, sessionId: "tab-compile" });
    await bc.execute({ action: "type", selector: "#q", text: "it's \"quoted\"", submit: true, sessionId: "tab-compile" });
    await bc.execute({ action: "press_key", key: "Enter", selector: "#q", sessionId: "tab-compile" });
    await bc.execute({ action: "source", part: "html", sessionId: "tab-compile" });
    await bc.execute({ action: "source", part: "css", selector: "#q", sessionId: "tab-compile" });
    await bc.execute({ action: "source", part: "scripts", sessionId: "tab-compile" });
    await bc.execute({ action: "read_dom", sessionId: "tab-compile" });
    await bc.execute({ action: "read_dom", include: "all", sessionId: "tab-compile" });
    expect(scripts.length).toBeGreaterThanOrEqual(10);
    for (const script of scripts) {
      expect(() => new Function(script)).not.toThrow();
    }
  });
});

// ── ROUND-66 (R66, A4): wait_for_verification — the owner-solvable wait ────

describe("browser_control — wait_for_verification (R66: the checkpoint)", () => {
  /** An emit mock that answers bridge probes from a scripted answer list. */
  const bridgeEmit = (
    answers: Array<{ title: string; text: string; markers: string[] }>,
    onCheckpoint?: (checkpointId: string) => void,
  ) => {
    let commandCount = 0;
    const events: Array<Record<string, unknown>> = [];
    const emit = (event: unknown) => {
      const frame = event as Record<string, unknown>;
      events.push(frame);
      if (frame.type === "browser-command") {
        const answer = answers[Math.min(commandCount, answers.length - 1)];
        commandCount += 1;
        queueMicrotask(() =>
          resolveBrowserCommand((frame as { commandId: string }).commandId, { ok: true, data: { ok: true, value: answer } }),
        );
      } else if (frame.type === "browser-checkpoint") {
        onCheckpoint?.((frame as { checkpointId: string }).checkpointId);
      }
    };
    return { emit, events };
  };

  it("clean page → honest ok, NO checkpoint frame", async () => {
    const { emit, events } = bridgeEmit([{ title: "Google", text: "Search the web", markers: [] }]);
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/wait", sessionId: "tab-wait" });

    const result = await bc.execute({ action: "wait_for_verification", sessionId: "tab-wait" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("no verification wall detected");
    expect(result.output).toContain("https://en.wikipedia.org/wait");
    expect(events.filter((e) => e.type === "browser-checkpoint")).toHaveLength(0);
  });

  it("a detected wall opens the checkpoint; resolve done + clean re-probe → cleared message", async () => {
    // Probe order: navigate (clean) → wait probe (cloudflare wall) → re-probe (clean).
    const { emit, events } = bridgeEmit(
      [
        { title: "Google", text: "Search the web", markers: [] },
        { title: "Just a moment...", text: "Checking your browser before accessing the site.", markers: ["challenge-platform"] },
        { title: "Example Domain", text: "Example Domain. This domain is for use in examples.", markers: [] },
      ],
      (checkpointId) => {
        queueMicrotask(() => resolveBrowserCheckpoint(checkpointId, "done"));
      },
    );
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/walled", sessionId: "tab-wall" });

    const result = await bc.execute({ action: "wait_for_verification", sessionId: "tab-wall", waitMs: 3000 });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("verification cleared");
    expect(result.output).toContain("Example Domain");
    // The chat-card frame: the exact {type, sessionId:"", tabId, kind, url, waitMs} contract.
    const opened = events.find((e) => e.type === "browser-checkpoint");
    expect(opened).toMatchObject({
      type: "browser-checkpoint",
      sessionId: "",
      tabId: "tab-wall",
      kind: "cloudflare",
      url: "https://en.wikipedia.org/walled",
      waitMs: 3000,
    });
    // The settle frame collapsed the card.
    expect(events.find((e) => e.type === "browser-checkpoint.resolved")).toMatchObject({ resolution: "done" });
  });

  it("resolve stop → the honest stopped message (no automatic retry guidance)", async () => {
    const { emit } = bridgeEmit(
      [
        { title: "Just a moment...", text: "Checking your browser", markers: ["challenge-platform"] },
      ],
      (checkpointId) => {
        queueMicrotask(() => resolveBrowserCheckpoint(checkpointId, "stop"));
      },
    );
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/stopped", sessionId: "tab-stop" });

    const result = await bc.execute({ action: "wait_for_verification", sessionId: "tab-stop" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("the owner stopped the wait");
    expect(result.output).toContain("do not retry this page automatically");
  });

  it("timeout → the honest timed-out message with the wall still up (fake clock)", async () => {
    vi.useFakeTimers();
    try {
      // Probe 1 (wait): wall. Probe 2 (re-probe): wall still there.
      const { emit } = bridgeEmit([{ title: "Just a moment...", text: "Checking your browser", markers: ["challenge-platform"] }]);
      const tools = await buildTools(tempDir, { emit });
      const bc = tool(tools, "browser_control");
      await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/slowwall", sessionId: "tab-slow" });

      const pending = bc.execute({ action: "wait_for_verification", sessionId: "tab-slow" });
      // Default wait 15s; the owner never answers.
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await pending;
      expect(result.ok).toBe(true);
      expect(result.output).toContain("timed out with the wall still up");
    } finally {
      vi.useRealTimers();
    }
  });

  it("web mode (no bridge): the wall is detected via the server-side fetch — no blind wait without a chat channel", async () => {
    const tools = await buildTools(tempDir); // no emit → fetch probe path
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/webwall", sessionId: "tab-webwall" });
    webFetchMock.mockResolvedValue({ ok: true, output: "Just a moment... Checking your browser before accessing the site." });

    const result = await bc.execute({ action: "wait_for_verification", sessionId: "tab-webwall" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("cloudflare");
    expect(result.output).toContain("no live chat channel");
    // The checkpoint registry was never touched (no blind wait).
    expect(pendingBrowserCheckpointCount()).toBe(0);
  });

  it("refuses honestly when no page is open", async () => {
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");
    const result = await bc.execute({ action: "wait_for_verification", sessionId: "never-opened-wait" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("no page is open");
  });
});

// ── ROUND-66 (R66, A5): set_viewport's instant-apply frame ─────────────────

describe("browser_control — set_viewport emits the instant-apply browser-viewport frame", () => {
  it("emits {type:'browser-viewport', tabId, viewport} on the turn stream after the command succeeds", async () => {
    const frames: Array<Record<string, unknown>> = [];
    const emit = (event: unknown) => {
      frames.push(event as Record<string, unknown>);
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({ action: "set_viewport", preset: "mobile-sm", sessionId: "tab-vpframe" });
    expect(result.ok).toBe(true);
    const frame = frames.find((f) => f.type === "browser-viewport");
    expect(frame).toBeDefined();
    expect(frame).toMatchObject({
      type: "browser-viewport",
      sessionId: "",
      tabId: "tab-vpframe",
      viewport: { width: 375, height: 667, preset: "mobile-sm", zoom: 1, rotate: false },
    });
  });

  it("an emit that throws never breaks set_viewport (the 4s poll is the backfill)", async () => {
    const emit = (event: unknown) => {
      if ((event as { type: string }).type === "browser-viewport") {
        throw new Error("stream already closed");
      }
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");
    const result = await bc.execute({ action: "set_viewport", preset: "tablet", sessionId: "tab-vpframe2" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("768×1024");
  });
});

// ── ROUND-66 (R66, A4/A1): the navigate/read wall notes + the record removal ─

describe("browser_control — the R66 wall probe on navigate / read", () => {
  it("navigate appends the ⚠ verification-wall note when the probe sees one (and never fails the navigate)", async () => {
    const emit = (event: unknown) => {
      const frame = event as { type: string; commandId: string };
      if (frame.type === "browser-command") {
        queueMicrotask(() =>
          resolveBrowserCommand(frame.commandId, {
            ok: true,
            data: { ok: true, value: { title: "Just a moment...", text: "", markers: ["challenge-platform"] } },
          }),
        );
      }
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/wallprobe", sessionId: "tab-navwall" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("navigated the embedded browser");
    expect(result.output).toContain("⚠ A verification wall (cloudflare)");
    expect(result.output).toContain("wait_for_verification");
  });

  it("navigate swallows probe errors — a failing probe never fails the navigation", async () => {
    const emit = (event: unknown) => {
      const frame = event as { type: string; commandId: string };
      if (frame.type === "browser-command") {
        queueMicrotask(() => resolveBrowserCommand(frame.commandId, { ok: false, error: "the panel is not mounted" }));
      }
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/quietprobe", sessionId: "tab-navquiet" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("navigated the embedded browser");
    expect(result.output).not.toContain("⚠");
  });

  it("read appends the ⚠ note when the fetched text carries wall markers", async () => {
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/gated", sessionId: "tab-readwall" });
    webFetchMock.mockResolvedValue({ ok: true, output: "Just a moment... Checking your browser before accessing example.com." });

    const result = await bc.execute({ action: "read", sessionId: "tab-readwall" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("⚠ A verification wall (cloudflare)");
    expect(result.output).toContain("wait_for_verification");
  });
});

// ── ROUND-67 (R67-E): the model-facing DESCRIPTION contract ────────────────
// The owner's 0.66.0 field report: the model flailed because the description
// still taught the pre-R67 truth. The bridge is fixed and the default target
// is the chat session's own tab — the description must say so (and stay
// honest about the web-dev-mode bridge limit).

describe("browser_control — the R67-E description contract (read_dom-first, per-session tabs, native-bridge honesty)", () => {
  it("teaches the read_dom-first workflow, the per-session default target, and the honest web-dev-mode limit", async () => {
    const tools = await buildTools(tempDir);
    const bc = (tools as unknown as Record<string, { description?: string }>)["browser_control"];
    expect(bc?.description).toBeDefined();
    const description = bc?.description ?? "";
    // read_dom FIRST, then act on the returned selector paths.
    expect(description).toContain("call it FIRST");
    expect(description).toContain("selector paths it returns");
    // Per-session tabs: omit sessionId → THIS chat session's own tab.
    expect(description).toContain("THIS chat session's own tab");
    expect(description).not.toContain("defaults to the tab the user is currently viewing");
    // get_state is scoped to this session's tab.
    expect(description).not.toContain("EVERY open tab");
    expect(description).toContain("this chat session's tab");
    // The honest native-bridge note (web dev mode fails fast).
    expect(description).toContain("native bridge");
    expect(description).toContain("fail fast");
    // The R66 form-submission teaching stays (submit:true / Enter).
    expect(description).toContain("type with submit:true");
    expect(description).toContain("native form submission");
  });
});
