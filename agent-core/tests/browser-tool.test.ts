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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { resetActiveComputerRelayForTest } from "../src/tools/plugins/computer-relay.js";
// ── ROUND-128 (R128-W7a): the hands script builders (pure string functions) ──
// — the evalJob return-style law's pins run their exact output through the
// simulated Rust wrap; also the read_dom visibility predicate.
import {
  buildHandsClickScript,
  buildHandsInstallScript,
  buildHandsMouseScript,
  buildHandsPressKeyScript,
  buildHandsTypeScript,
} from "../src/tools/plugins/browser-hands.js";
import {
  BROWSER_CONTROL_ACTIONS,
  domRectIntersectsViewport,
  downloadSuffixName,
  looksLikeTextPayload,
  nearestBrowserAction,
  sanitizeDownloadFilename,
  sniffMagicBytes,
} from "../src/tools/plugins/browser.js";
// R128-W7a: the vision relay fake — the screenshot describe/advisory pins
// need a CONTROLLED relay (a SUCCESSFUL vision pass is otherwise unreachable
// without a real model call). The default reply is the honest no-key failure
// shape the existing pins expect; tests flip visionState.reply for success.
import * as computerUseModule from "../src/tools/plugins/computer-use.js";
const visionState = vi.hoisted(() => ({
  reply: null as { ok: boolean; text?: string; model?: string; mode?: string; ms?: number; error?: string } | null,
}));
vi.mock("../src/tools/plugins/computer-use.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/plugins/computer-use.js")>();
  return {
    ...actual,
    relayVision: vi.fn(async () =>
      visionState.reply ?? { ok: false, error: "no keyring entry for the vision provider" },
    ),
  };
});
const relayVisionMock = vi.mocked(computerUseModule.relayVision);
// ── ROUND-98 (R98-G1): the browser screenshot's DECOUPLED capture engine ──
// The tool no longer borrows the computer-use relay; it calls
// getCaptureBackend() directly. These tests fake the FACTORY (the same
// fail-closed shapes the relay fakes used to carry: a healthy region
// capture echoing the region, a recording captureDisplay that must stay
// unreachable, and a switchable backend error). vi.hoisted state — the mock
// factory closes over it.
const captureState = vi.hoisted(() => ({
  regions: [] as Array<{ x: number; y: number; w: number; h: number }>,
  displayCaptures: [] as number[],
  failWith: null as string | null,
  runCalls: 0,
}));
vi.mock("../src/computer/backends/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/computer/backends/index.js")>();
  return {
    ...actual,
    getCaptureBackend: () => ({
      backend: {
        captureRegion: async (
          _run: unknown,
          region: { x: number; y: number; w: number; h: number },
        ) => {
          captureState.regions.push(region);
          if (captureState.failWith !== null) return { error: captureState.failWith };
          return {
            pngBase64: "aW1n",
            width: region.w,
            height: region.h,
            scale: 1,
            origin: { x: region.x, y: region.y },
          };
        },
        captureDisplay: async (_run: unknown, displayIndex: number) => {
          captureState.displayCaptures.push(displayIndex);
          return { pngBase64: "aW1n", width: 1920, height: 1080, scale: 1, origin: { x: 0, y: 0 } };
        },
      },
      run: async () => {
        captureState.runCalls += 1;
        return { code: 0, stdout: "", stderr: "" };
      },
    }),
  };
});
import { buildServer } from "../src/server";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { setVisionSettings } from "../src/storage/vision.js";
import { ProviderKeyring } from "../src/providers/registry";
import {
  resetBrowserStoreForTest,
  browserSessionForChatSession,
  extendPrivateNetAllowlistForTest,
  resetPrivateNetAllowlistForTest,
} from "../src/browser-proxy";
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
  // R128-W7a: the vision relay fake resets to the honest no-key failure.
  visionState.reply = null;
  relayVisionMock.mockClear();
  // R98-G1: fresh capture-engine fake per test (regions/display/errors).
  captureState.regions.length = 0;
  captureState.displayCaptures.length = 0;
  captureState.failWith = null;
  captureState.runCalls = 0;
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

  it("navigate demands an absolute http(s) or file:// url; unknown actions are refused", async () => {
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");

    expect((await bc.execute({ action: "navigate", sessionId: "sess-v" })).ok).toBe(false);
    const junk = await bc.execute({ action: "navigate", url: "not a url at all", sessionId: "sess-v" });
    expect(junk.ok).toBe(false);
    expect(junk.output).toContain("http(s)");

    expect((await bc.execute({ action: "sideways", sessionId: "sess-v" })).ok).toBe(false);
  });

  // ── ROUND-95 (R95-C): local files open natively — navigate + read ──────
  it("R95-C: navigate accepts a file:// URL and a bare local path (normalized into history)", async () => {
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");

    // The model sends a ready file:// URL…
    const byUrl = await bc.execute({
      action: "navigate",
      url: `file://${join(tempDir, "demo.html")}`,
      sessionId: "sess-file",
    });
    expect(byUrl.ok).toBe(true);
    // …and the natural Windows drive form (backslashes, drive letter)…
    const windowsStyle = await bc.execute({
      action: "navigate",
      url: "C:\\Users\\me\\page.html",
      sessionId: "sess-file",
    });
    expect(windowsStyle.ok).toBe(true);
    const state = JSON.parse((await bc.execute({ action: "get_state", sessionId: "sess-file" })).output) as {
      currentUrl: string;
    };
    expect(state.currentUrl).toBe("file:///C:/Users/me/page.html");

    // A RELATIVE local path is refused honestly (no base to resolve against).
    const relative = await bc.execute({ action: "navigate", url: "demo.html", sessionId: "sess-file" });
    expect(relative.ok).toBe(false);
    expect(relative.output).toContain("relative local path");
  });

  it("R95-C: read on a file:// page reads the file from DISK (and reports the honest miss)", async () => {
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");

    const fixture = join(tempDir, "local-page.html");
    writeFileSync(fixture, "<!doctype html><html><body><h1>Local demo page</h1></body></html>");
    await bc.execute({ action: "navigate", url: `file://${fixture}`, sessionId: "sess-read-file" });

    const read = await bc.execute({ action: "read", sessionId: "sess-read-file" });
    expect(read.ok).toBe(true);
    expect(read.output).toContain("read from disk");
    expect(read.output).toContain("Local demo page");
    // webFetch is NEVER consulted for a file:// page (it refuses the scheme).
    expect(webFetchMock).not.toHaveBeenCalled();

    // A missing file surfaces the reader's honest error.
    await bc.execute({ action: "navigate", url: `file://${join(tempDir, "does-not-exist.html")}`, sessionId: "sess-read-file" });
    const miss = await bc.execute({ action: "read", sessionId: "sess-read-file" });
    expect(miss.ok).toBe(false);
    expect(miss.output).toContain("reading the local file failed");
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

describe("browser_control — screenshot (R62 → R98-G1: decoupled capture + vision relay)", () => {
  it("R98-G1: Computer Use OFF no longer blocks the screenshot — no relay, no emit → the honest not-mounted refusal (no capture attempted)", async () => {
    // Re-pin of the pre-R98 test ("fails closed with the enable-Computer-Use
    // pointer"): the relay/master-switch gate is GONE (the owner: "it was
    // currently unable to take screenshots of the web browser"). With no live
    // emit channel there is no panel to ask for a region → the honest
    // not-mounted error, and the message must NOT point at Computer Use
    // anymore (that pointer WAS the bug — an unrelated OFF-by-default
    // feature). No capture may be attempted.
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/shot", sessionId: "tool-tab-shot" });
    const result = await bc.execute({ action: "screenshot", sessionId: "tool-tab-shot" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("no panel region to capture");
    expect(result.output).toContain("read");
    // The old dishonest pointer is gone — Computer Use is NOT the gate.
    expect(result.output).not.toContain("Computer Use");
    expect(captureState.regions).toEqual([]);
    expect(captureState.displayCaptures).toEqual([]);
  });

  it("captures the panel REGION the UI reports and relays vision (honest off-mode note when vision is off)", async () => {
    // R98-G1: no relay is armed — the tool reaches the STANDALONE capture
    // backend (getCaptureBackend) directly; Computer Use stays OFF.
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
    // R94-E → R98-G1: the vision gate now sits AFTER the capture; seeding a
    // path (a separate vision model with no keyring entry) lets the relay
    // below still fail honestly → the off-mode note.
    setVisionSettings(db, { mode: "separate", provider: "prov-shot", modelId: "vision-x" });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/shot2", sessionId: "tool-tab-shot2" });

    const result = await bc.execute({ action: "screenshot", sessionId: "tool-tab-shot2" });
    // Vision fails honestly at describe time (no keyring) → the tool is still
    // ok:true with the honest unavailable note; the CAPTURE happened with
    // the UI's region through the decoupled engine.
    expect(result.ok).toBe(true);
    expect(result.output).toContain("panel region 800×600");
    expect(result.output).toContain("vision description is unavailable");
    expect(captureState.regions).toEqual([{ x: 100, y: 200, w: 800, h: 600 }]);
    // R66 (A1): browser screenshots NEVER record into the computer-use
    // monitor ring — the owner must never see "agent is using your computer"
    // during browser turns. (With the relay gone there IS no session object
    // to record into; captureState is the proof the capture still happened.)
    expect(captureState.displayCaptures).toEqual([]);
  });

  it("R87: no region answer → the HONEST ERROR (never a full-display capture — the owner's screen must not leak)", async () => {
    const tools = await buildTools(tempDir); // no emit → no screenshot_meta ask at all
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/shot3", sessionId: "tool-tab-shot3" });
    const result = await bc.execute({ action: "screenshot", sessionId: "tool-tab-shot3" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("no panel region to capture");
    expect(result.output).toContain("NEVER falls back to a full-screen shot");
    // R87: the full-display capture is GONE — the fallback was the leak.
    expect(captureState.displayCaptures).toEqual([]);
    expect(captureState.regions).toEqual([]);
  });

  it("a failed REGION capture surfaces the backend's error", async () => {
    captureState.failWith = "no scrot, no import";
    const emit = (event: unknown) => {
      const frame = event as { commandId: string };
      queueMicrotask(() =>
        resolveBrowserCommand(frame.commandId, {
          ok: true,
          data: { supported: true, region: { x: 0, y: 0, w: 800, h: 600 }, scaleFactor: 1, mode: "native" },
        }),
      );
    };
    const tools = await buildTools(tempDir, { emit });
    setVisionSettings(db, { mode: "separate", provider: "prov-shot4", modelId: "vision-x" });
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
    const commands: Array<{ action: string; script: string; installScript: string }> = [];
    const emit = (event: unknown) => {
      const frame = event as { type: string; commandId: string; action: string; payload: { script?: string; installScript?: string } };
      expect(frame.type).toBe("browser-command");
      commands.push({
        action: frame.action,
        script: String(frame.payload.script ?? ""),
        installScript: String(frame.payload.installScript ?? ""),
      });
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
    // R89-E: click rides the evalJob bridge (the visible-cursor engine —
    // the job protocol), not the raw eval.
    expect(commands[0].action).toBe("evalJob");
    // Injection safety: the selector rides as a JSON string literal, never
    // concatenated raw into the script.
    expect(commands[0].script).toContain(JSON.stringify('button[type="submit"]'));
    expect(commands[0].script).toContain("scrollIntoView");
    // R94-F split: the ACTION script is tiny — the driver + the element
    // finder, with the hands entrypoint and the real-click call; the cursor
    // ENGINE (the SVG install) rides the payload's one-time installScript.
    expect(commands[0].script).toContain("__acuteHands");
    expect(commands[0].script).toContain("realClick");
    expect(commands[0].script).not.toContain("__acute-agent-cursor");
    expect(commands[0].installScript).toContain("__acute-agent-cursor");
    expect(commands[0].installScript).toContain("{ installed: true");
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
    const scripts: Array<{ script: string; installScript: string }> = [];
    const emit = (event: unknown) => {
      const frame = event as { commandId: string; payload: { script?: string; installScript?: string } };
      scripts.push({ script: String(frame.payload.script ?? ""), installScript: String(frame.payload.installScript ?? "") });
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
    expect(scripts[0].script).toContain(JSON.stringify('input[name="q"]'));
    expect(scripts[0].script).toContain(JSON.stringify("acute code editor"));
    // The Google-search fix: native prototype value setter + input/change
    // events (React/Vue) + requestSubmit (native form submission). R94-F:
    // the value-setter machinery is RUNTIME (setNativeValue in the one-time
    // installScript); the requestSubmit beat + the submit flag are the
    // DRIVER's (the tiny action script).
    expect(scripts[0].installScript).toContain("getOwnPropertyDescriptor");
    expect(scripts[0].installScript).toContain('new Event("input"');
    expect(scripts[0].installScript).toContain('new Event("change"');
    expect(scripts[0].script).toContain("requestSubmit");
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

  it("every compiled page script (incl. the wall probe and the R94-F installer) is syntactically valid JavaScript", async () => {
    // The bridge is mocked everywhere else, so the scripts never RUN here —
    // this compiles each generated script as a function body (exactly what
    // the Rust browser_tab_eval wrapper does) to prove the builders emit
    // parseable JS before the owner's first live Windows run. R94-F: the
    // evalJob payload's installScript is compiled too (the panel evals it
    // in the page when the tiny action script reports needInstall).
    const scripts: string[] = [];
    const emit = (event: unknown) => {
      const frame = event as { type?: string; action?: string; commandId: string; payload?: { script?: string; installScript?: string } };
      if (frame.type === "browser-command" && typeof frame.payload?.script === "string") {
        scripts.push(frame.payload.script);
        if (typeof frame.payload.installScript === "string" && frame.payload.installScript !== "") {
          scripts.push(frame.payload.installScript);
        }
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
    // R131-B (defect 3b): the PAGED read_dom script (offset/range) compiles too.
    await bc.execute({ action: "read_dom", offset: 3, range: 25, sessionId: "tab-compile" });
    expect(scripts.length).toBeGreaterThanOrEqual(15); // 11+ scripts + the 4 evalJob installers
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
    const bc = (tools as unknown as Record<string, { description?: string; inputSchema?: unknown }>)["browser_control"];
    expect(bc?.description).toBeDefined();
    const description = bc?.description ?? "";
    // R117-c (C1): the ~7.7K one-paragraph description became a ~1.3K policy
    // head; the per-action parameter detail (x/y/w/h, pacing, form
    // submission, per-action mode limits) rides the inputSchema now — the
    // schema's serialized text is pinned alongside the head.
    const schemaText = JSON.stringify(bc?.inputSchema ?? {});
    // read_dom first, then act on the returned selectors + positions.
    expect(description).toContain("read_dom first on every new page");
    expect(description).toContain("selectors, positions, pageState");
    expect(schemaText).toContain("x/y/w/h");
    // R89-E: the visible human-like input contract.
    expect(description).toContain("search first");
    expect(description).toContain("word-by-word");
    expect(schemaText).toContain("a ~1s beat after the focusing click"); // the pacing detail's surviving form
    // Per-session tabs: omit sessionId → this chat session's own tab.
    expect(description).toContain("this chat session's own tab");
    expect(description).not.toContain("defaults to the tab the user is currently viewing");
    // get_state is scoped to this session's tab.
    expect(description).not.toContain("EVERY open tab");
    expect(schemaText).toContain("this chat session's tab");
    // The honest web-dev-mode limit (R117-c: the bridge-dependent actions
    // carry "native desktop mode only" — the old fail-fast note's successor).
    expect(schemaText).toContain("native desktop mode only");
    // The R66 form-submission teaching stays (submit:true / Enter).
    expect(description).toContain("type with submit:true");
    expect(schemaText).toContain("native form submission");
  });
});

// ── ROUND-89 (R89-E): the AGENT HANDS — the mouse action + the job bridge ──

describe("browser_control — mouse (R89-E: the full-fledged pointer control)", () => {
  it("mouse click sends the evalJob command carrying the driver + the exact coordinates (R94-F: the engine rides the installer)", async () => {
    const commands: Array<{ action: string; script: string }> = [];
    const emit = (event: unknown) => {
      const frame = event as { type: string; commandId: string; action: string; payload: { script?: string } };
      commands.push({ action: frame.action, script: String(frame.payload.script ?? "") });
      queueMicrotask(() =>
        resolveBrowserCommand(frame.commandId, { ok: true, data: { ok: true, value: { clicked: { tag: "a", text: "Next" } } } }),
      );
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({ action: "mouse", op: "click", x: 341, y: 262, sessionId: "tab-mouse" });
    expect(result.ok).toBe(true);
    expect(commands).toHaveLength(1);
    expect(commands[0].action).toBe("evalJob");
    // The coordinates ride as literals; the driver + the click kind are in
    // (R94-F: the cursor ENGINE itself is no longer embedded — the payload
    // carries it as the one-time installScript).
    expect(commands[0].script).toContain("341");
    expect(commands[0].script).toContain("262");
    expect(commands[0].script).toContain('"click"');
    expect(commands[0].script).toContain("moveCursor");
    expect(commands[0].script).toContain("realClick");
    // The job protocol: the driver pends on window.__acuteJob.
    expect(commands[0].script).toContain("startJob");
    expect(() => new Function(commands[0].script)).not.toThrow();
  });

  it("validates the op + the required coordinates per op", async () => {
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");
    const badOp = await bc.execute({ action: "mouse", op: "wiggle", sessionId: "tab-mouse" });
    expect(badOp.ok).toBe(false);
    expect(badOp.output).toContain("requires 'op'");
    const noXY = await bc.execute({ action: "mouse", op: "click", sessionId: "tab-mouse" });
    expect(noXY.ok).toBe(false);
    expect(noXY.output).toContain("requires x and y");
    const noDxDy = await bc.execute({ action: "mouse", op: "scroll", sessionId: "tab-mouse" });
    expect(noDxDy.ok).toBe(false);
    expect(noDxDy.output).toContain("dx and/or dy");
    const dragMissing = await bc.execute({ action: "mouse", op: "drag", x: 1, y: 2, sessionId: "tab-mouse" });
    expect(dragMissing.ok).toBe(false);
    expect(dragMissing.output).toContain("toX, toY");
  });

  it("type rides the evalJob engine and caps the human-paced text at 600 chars", async () => {
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");
    const tooLong = await bc.execute({ action: "type", selector: "#q", text: "x".repeat(601), sessionId: "tab-mouse" });
    expect(tooLong.ok).toBe(false);
    expect(tooLong.output).toContain("capped at 600");
  });
});

// ── ROUND-93 (R93-B3): typing fidelity, click trust, section state ─────────
// The owner's fifth-walkthrough reports: "it sometimes typed out gibberish"
// (UTF-16 code-unit iteration split astral chars + mid-stream execCommand
// failures silently dropped letters + no key events for contenteditable
// frameworks), "the mouse use functionality does not register it as a proper
// mouse" (synthetic clicks with a thin event sequence), and "it was in the
// images section, but it then reverted back to the all section" (read_dom
// could not tell the model WHICH SPA section was active).

describe("browser_control — R93-B3 typing fidelity (code points, mid-stream fallback, keydowns)", () => {
  it("the type script iterates by CODE POINTS (Array.from) — never the old word[i] code-unit loop that typed astral chars as gibberish", async () => {
    const scripts: Array<{ script: string; installScript: string }> = [];
    const emit = (event: unknown) => {
      const frame = event as { commandId: string; payload: { script?: string; installScript?: string } };
      scripts.push({ script: String(frame.payload.script ?? ""), installScript: String(frame.payload.installScript ?? "") });
      queueMicrotask(() =>
        resolveBrowserCommand(frame.commandId, {
          ok: true,
          data: { ok: true, value: { typed: 13, fallback: false, wpm: 150, keydownsCanceled: 0 } },
        }),
      );
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({ action: "type", selector: "#q", text: "héllo 🎉 world", sessionId: "tab-cp" });
    expect(result.ok).toBe(true);
    expect(scripts).toHaveLength(1);
    // R94-F: the RUNTIME (typeInto — where the per-char loop lives) rides
    // the one-time installScript; the driver only references it.
    const script = scripts[0].script;
    const runtime = scripts[0].installScript;
    // The fix: code-point iteration — astral-plane chars stay whole.
    expect(runtime).toContain("Array.from(word)");
    expect(runtime).toContain("chars[i]");
    // The old UTF-16 code-unit indexing and the first-char-only fallback
    // arming (a mid-stream execCommand failure used to DROP the letter) are gone.
    expect(runtime).not.toContain("word[i]");
    expect(runtime).not.toContain("inserted === 0");
    // ANY failed char now arms the native-setter fallback.
    expect(runtime).toContain("if (!ok) fellBack = true;");
    // The semantics the loop now performs, proven on an astral string:
    // code-point-joined strings survive the DOM/JSON boundary, while the
    // old code-unit loop's lone surrogates become U+FFFD (the mojibake).
    const word = "héllo🎉";
    expect(word.length).toBe(7); // UTF-16 code units — the emoji is TWO
    expect(Array.from(word)).toHaveLength(6); // code POINTS — the emoji is one
    const byCodePoint = new TextDecoder().decode(new TextEncoder().encode(Array.from(word).join("")));
    expect(byCodePoint).toBe(word);
    // Each char crosses the DOM/execCommand boundary SEPARATELY — encode the
    // code-unit halves individually, exactly what the old loop inserted.
    const byCodeUnit = word
      .split("")
      .map((c) => new TextDecoder().decode(new TextEncoder().encode(c)))
      .join("");
    expect(byCodeUnit).not.toBe(word); // the old loop's output = gibberish
    // R94-F: BOTH generated scripts stay within the 20KB Rust eval budget —
    // the Rust check is UTF-8 BYTES (browser.rs: script.len() > 20_000), so
    // the assertions measure bytes, not chars. The ACTION script is the
    // small one now (the runtime rides installScript — also under budget).
    expect(Buffer.byteLength(script, "utf8")).toBeLessThan(20000);
    expect(Buffer.byteLength(runtime, "utf8")).toBeLessThan(20000);
    expect(() => new Function(script)).not.toThrow();
    expect(() => new Function(runtime)).not.toThrow();
  });

  it("every typed char is preceded by a synthetic keydown on the focused element — a canceled keydown is reported, never obeyed (and per-char typing never dispatches keypress/keyup)", async () => {
    const scripts: Array<{ script: string; installScript: string }> = [];
    const emit = (event: unknown) => {
      const frame = event as { commandId: string; payload: { script?: string; installScript?: string } };
      scripts.push({ script: String(frame.payload.script ?? ""), installScript: String(frame.payload.installScript ?? "") });
      queueMicrotask(() =>
        resolveBrowserCommand(frame.commandId, {
          ok: true,
          data: { ok: true, value: { typed: 5, fallback: false, wpm: 150, keydownsCanceled: 2 } },
        }),
      );
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({ action: "type", selector: "#editor", text: "quill", sessionId: "tab-kd" });
    expect(result.ok).toBe(true);
    expect(scripts).toHaveLength(1);
    // Isolate typeInto's body (R94-F: it lives in the RUNTIME/installScript
    // now) — the driver's ENTER sequence and the press_key driver legitimately
    // use keypress/keyup; per-char typing must not.
    const script = scripts[0].installScript;
    const start = script.indexOf("function typeInto");
    const end = script.indexOf("function findScroller");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const body = script.slice(start, end);
    // The keydown fires BEFORE the insert, on the focused element.
    expect(body).toContain('new KeyboardEvent("keydown"');
    expect(body.indexOf("KeyboardEvent")).toBeLessThan(body.indexOf("execCommand"));
    expect(body).toContain("document.activeElement");
    // A preventDefault on the keydown is counted, never obeyed.
    expect(body).toContain("keydownsCanceled");
    expect(body).toContain("keydownsCanceled: keydownsCanceled");
    // Minimal by design: no keypress, no keyup during typing.
    expect(body).not.toContain("keypress");
    expect(body).not.toContain("keyup");
  });
});

describe("browser_control — R93-B3 click trust (the full spec-order pointer flow)", () => {
  it("realClick fires pointerover → pointerenter → mouseover → mouseenter → pointermove → pointerdown → mousedown → focus → pointerup → mouseup → click, hover-first at the element center", async () => {
    const commands: Array<{ action: string; script: string; installScript: string }> = [];
    const emit = (event: unknown) => {
      const frame = event as { type: string; commandId: string; action: string; payload: { script?: string; installScript?: string } };
      commands.push({
        action: frame.action,
        script: String(frame.payload.script ?? ""),
        installScript: String(frame.payload.installScript ?? ""),
      });
      queueMicrotask(() =>
        resolveBrowserCommand(frame.commandId, {
          ok: true,
          data: { ok: true, value: { clicked: { tag: "button", text: "Images" } } },
        }),
      );
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({ action: "click", selector: '[role="tab"]', sessionId: "tab-seq" });
    expect(result.ok).toBe(true);
    expect(commands).toHaveLength(1);
    expect(commands[0].action).toBe("evalJob");
    // R94-F: realClick is RUNTIME — its body lives in the one-time
    // installScript the payload carries (the action script is the tiny
    // driver that CALLS it).
    const script = commands[0].installScript;
    // Isolate realClick's body — the movement TRAIL helper mentions pointer
    // events earlier in the runtime; the CLICK itself is what must be in order.
    const start = script.indexOf("function realClick");
    const end = script.indexOf("function setNativeValue");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const body = script.slice(start, end);
    // The FULL spec-order sequence, strictly in order (present + ordered).
    const order = [
      "pointerover",
      "pointerenter",
      "mouseover",
      "mouseenter",
      "pointermove",
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      '"click"',
    ];
    let prev = -1;
    for (const marker of order) {
      const at = body.indexOf(marker);
      expect(at).toBeGreaterThan(prev);
      prev = at;
    }
    // Hover-first: the pointermove lands at the TARGET CENTER before the
    // press, with a hover beat between arrival and the press.
    expect(body.indexOf("pointermove")).toBeLessThan(body.indexOf("pointerdown"));
    expect(body).toContain("TARGET CENTER");
    // Focus sits between the down and the up (spec order).
    expect(body.indexOf("el.focus")).toBeGreaterThan(body.indexOf('"pointerdown"'));
    expect(body.indexOf('"pointerup"')).toBeGreaterThan(body.indexOf("el.focus"));
    // The pointer identity on the PointerEvents.
    expect(body).toContain('pointerType: "mouse"');
    expect(body).toContain("pointerId: 1");
    expect(body).toContain("isPrimary: true");
    // The light post-action focus hint rides in the job result.
    expect(body).toContain("focusBefore");
    expect(body).toContain("activeElement");
    // R94-F: BOTH generated scripts stay within the 20KB Rust eval budget
    // (bytes) — the tiny action script AND the installer it carries.
    expect(Buffer.byteLength(commands[0].script, "utf8")).toBeLessThan(20000);
    expect(Buffer.byteLength(script, "utf8")).toBeLessThan(20000);
    expect(() => new Function(commands[0].script)).not.toThrow();
    expect(() => new Function(script)).not.toThrow();
  });

  it("the click result surfaces the focus hint when the job reports focus moved (and stays silent when it does not)", async () => {
    let answer: Record<string, unknown> = { clicked: { tag: "input", id: "search" } };
    const emit = (event: unknown) => {
      const frame = event as { commandId: string };
      queueMicrotask(() => resolveBrowserCommand(frame.commandId, { ok: true, data: { ok: true, value: answer } }));
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    answer = { clicked: { tag: "input", id: "search" }, focus: { tag: "input", name: "q" } };
    const focused = await bc.execute({ action: "click", selector: "#search", sessionId: "tab-fx" });
    expect(focused.ok).toBe(true);
    expect(focused.output).toContain("Focus moved to");
    expect(focused.output).toContain('"name":"q"');

    answer = { clicked: { tag: "button", text: "Next" } };
    const plain = await bc.execute({ action: "click", selector: "button", sessionId: "tab-fx" });
    expect(plain.ok).toBe(true);
    expect(plain.output).not.toContain("Focus moved to");
  });
});

describe("browser_control — R93-B3 read_dom pageState (the SPA section tracker)", () => {
  it("read_dom compiles the pageState sweep (hash/query + aria-selected/aria-current + lang) and passes it through to the model", async () => {
    const scripts: string[] = [];
    const outline = {
      title: "Gallery",
      url: "https://example.com/gallery?tab=images#/images",
      headings: [],
      interactive: [],
      forms: [],
      paragraphs: undefined,
      pageState: {
        lang: "en",
        hash: "#/images",
        query: { tab: "images" },
        selected: [{ tag: "button", role: "tab", text: "Images", href: undefined, ariaCurrent: undefined }],
      },
    };
    const emit = (event: unknown) => {
      const frame = event as { commandId: string; payload: { script?: string } };
      scripts.push(String(frame.payload.script ?? ""));
      queueMicrotask(() => resolveBrowserCommand(frame.commandId, { ok: true, data: { ok: true, value: outline } }));
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({ action: "read_dom", sessionId: "tab-ps" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("read_dom ok");
    expect(result.output).toContain("pageState");
    expect(result.output).toContain("#/images");
    expect(result.output).toContain("Images");
    expect(scripts).toHaveLength(1);
    // The in-script sweep: the aria signals + the URL signals + <html lang>,
    // capped at 12 matches, every read individually guarded.
    expect(scripts[0]).toContain("pageState");
    expect(scripts[0]).toContain('[aria-selected="true"], [aria-current]');
    expect(scripts[0]).toContain("location.hash");
    expect(scripts[0]).toContain("URLSearchParams");
    expect(scripts[0]).toContain('documentElement.getAttribute("lang")');
    expect(scripts[0]).toContain("slice(0, 12)");
    expect(() => new Function(scripts[0])).not.toThrow();
  });

  it("the read_dom description teaches the check-pageState-after-clicking-a-section workflow", async () => {
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");
    // R117-c (C1): the per-action read_dom/click detail rides the
    // inputSchema's action description now (the tool description is the
    // policy head).
    const schemaText = JSON.stringify((bc as unknown as { inputSchema?: unknown }).inputSchema ?? {});
    expect(schemaText).toContain("pageState: the URL hash/query + the aria-selected/aria-current tab");
    expect(schemaText).toContain("after clicking a section or tab you can re-read and confirm it stuck");
    // The click action teaches the focus hint + the hover-first sequence.
    expect(schemaText).toContain("hovers");
    expect(schemaText).toContain("where focus moved");
  });
});

// ── ROUND-94 (R94-F): the evalJob SPLIT — tiny action scripts + the ──────────
// one-time installer payload. The owner's v0.91.0 Windows report: every hands
// action failed with "unexpected start payload" while ~2KB evals on the SAME
// pages worked — the old 17-19KB monoliths (runtime embedded in every action)
// were the only difference. The split is the fix; these tests pin it.

describe("browser_control — R94-F: the evalJob split (tiny action scripts + the one-time installer)", () => {
  it("every hands action script is TINY (< 4000 chars — no embedded runtime) and the installer rides the payload", async () => {
    const commands: Array<{ action: string; script: string; installScript: string }> = [];
    const emit = (event: unknown) => {
      const frame = event as { type: string; commandId: string; action: string; payload: { script?: string; installScript?: string } };
      commands.push({
        action: frame.action,
        script: String(frame.payload.script ?? ""),
        installScript: String(frame.payload.installScript ?? ""),
      });
      queueMicrotask(() =>
        resolveBrowserCommand(frame.commandId, {
          ok: true,
          data: { ok: true, value: { clicked: { tag: "a" }, typed: 3, pressed: "Enter", moved: { x: 1, y: 2 } } },
        }),
      );
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    await bc.execute({ action: "click", selector: "#a", sessionId: "tab-split" });
    await bc.execute({ action: "type", selector: "#q", text: "hi", sessionId: "tab-split" });
    await bc.execute({ action: "press_key", key: "Enter", sessionId: "tab-split" });
    await bc.execute({ action: "mouse", op: "click", x: 10, y: 20, sessionId: "tab-split" });
    expect(commands).toHaveLength(4);
    for (const command of commands) {
      expect(command.action).toBe("evalJob");
      // THE fix, pinned by size: the action script no longer embeds the
      // ~15KB runtime (the old monoliths were 17-19KB; the drivers +
      // element finders alone are what remain).
      expect(command.script.length).toBeLessThan(4000);
      expect(command.script).toContain("needInstall"); // the missing-runtime answer
      expect(command.script).not.toContain("__acute-agent-cursor"); // no cursor install
      expect(command.script).not.toContain("function realClick"); // no runtime body
      expect(command.script).not.toContain("function typeInto");
      // The one-time installer rides the SAME command payload, and it is
      // the full runtime (idempotent, reports {installed:true}).
      expect(command.installScript).toContain("__acute-agent-cursor");
      expect(command.installScript).toContain("function realClick");
      expect(command.installScript).toContain("function typeInto");
      expect(command.installScript).toContain("{ installed: true");
      expect(() => new Function(command.script)).not.toThrow();
      expect(() => new Function(command.installScript)).not.toThrow();
    }
  });
});

// ── ROUND-94 (R94-F): the wait action — the proper waiting the owner asked ──
// for (his report: the model literally called a nonexistent action 'wait'
// after navigate, then fired clicks into still-loading pages).

describe("browser_control — wait (R94-F: settle until the page is ready)", () => {
  it("probes the page until readyState is complete, then reports the elapsed time and what matched", async () => {
    // Probe order: the navigate wall probe + the wait's first probe see
    // 'loading' (not ready) → the wait's second probe sees 'complete'.
    const probes: Array<{ ready: string; has: unknown; url: string }> = [
      { ready: "loading", has: null, url: "https://en.wikipedia.org/wait" },
      { ready: "loading", has: null, url: "https://en.wikipedia.org/wait" },
      { ready: "complete", has: null, url: "https://en.wikipedia.org/wait" },
    ];
    let call = 0;
    const emit = (event: unknown) => {
      const frame = event as { type?: string; commandId: string; payload?: { script?: string } };
      if (frame.type === "browser-command") {
        // Capture the answer BEFORE the microtask (it must not see the bump).
        const answer = probes[Math.min(call, probes.length - 1)];
        call += 1;
        queueMicrotask(() => resolveBrowserCommand(frame.commandId, { ok: true, data: { ok: true, value: answer } }));
      }
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/wait", sessionId: "tab-wait-ready" }); // probe 1

    const result = await bc.execute({ action: "wait", sessionId: "tab-wait-ready" }); // default: readyState complete, 900ms
    expect(result.ok).toBe(true);
    expect(result.output).toContain("wait ok");
    expect(result.output).toContain("\"waited\":true");
    expect(result.output).toContain("\"readyState\":\"complete\"");
    expect(result.output).toContain("\"readyState\":true"); // the matched condition
    // The wait itself probed twice (loading → complete) — the 250ms cadence
    // did the waiting (the navigate's wall probe was the first call).
    expect(call).toBeGreaterThanOrEqual(3);
  });

  it("a selector that never appears fails honestly after the cap, naming what did not match", async () => {
    const emit = (event: unknown) => {
      const frame = event as { type?: string; commandId: string; payload?: { script?: string } };
      if (frame.type === "browser-command") {
        queueMicrotask(() =>
          resolveBrowserCommand(frame.commandId, {
            ok: true,
            data: { ok: true, value: { ready: "complete", has: false, url: "https://example.com/" } },
          }),
        );
      }
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({ action: "wait", selector: ".never-appears", ms: 250, sessionId: "tab-wait-miss" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("timed out after 250ms");
    expect(result.output).toContain("'.never-appears' did not appear");
    expect(result.output).not.toContain("readyState"); // the page WAS complete — only the selector failed
  });
});

// ── ROUND-94 (R94-F): the sequence action — multi-stage steps in ONE call ───
// (the owner's multi-stage-steps request: type → wait → click atomically,
// with the built-in settle between steps).

describe("browser_control — sequence (R94-F: multi-stage steps in one tool call)", () => {
  it("runs a 3-step chain (type → wait → read_dom) in order on one tab and reports per-step one-liners", async () => {
    // The bridge commands in order: evalJob(type) → eval(wait probe) → eval(read_dom).
    const replies: Array<{ action: string; data: unknown }> = [
      { action: "evalJob", data: { ok: true, value: { typed: 5, fallback: false, wpm: 150, keydownsCanceled: 0, submitted: true, submitHow: "synthetic Enter + form.requestSubmit()" } } },
      { action: "eval", data: { ok: true, value: { ready: "complete", has: null, url: "https://example.com/search" } } },
      { action: "eval", data: { ok: true, value: { title: "Results", url: "https://example.com/search", headings: [], interactive: [], forms: [], paragraphs: undefined, pageState: { lang: "en" } } } },
    ];
    let call = 0;
    const emit = (event: unknown) => {
      const frame = event as { type?: string; commandId: string; payload?: { script?: string } };
      if (frame.type === "browser-command") {
        // Capture the reply BEFORE the microtask (it must not see the bump).
        const reply = replies[Math.min(call, replies.length - 1)];
        call += 1;
        queueMicrotask(() => resolveBrowserCommand(frame.commandId, { ok: true, data: reply.data }));
      }
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({
      action: "sequence",
      sessionId: "tab-seq3",
      steps: [
        { action: "type", selector: "#q", text: "acute code", submit: true },
        { action: "wait", ms: 250 },
        { action: "read_dom" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("sequence ok (tab 'tab-seq3', 3 steps");
    expect(result.output).toContain("all steps succeeded");
    // The per-step one-liners, in order.
    expect(result.output).toContain("1. ok type —");
    expect(result.output).toContain("2. ok wait —");
    expect(result.output).toContain("3. ok read_dom —");
    // The steps really ran: three bridge commands in order.
    expect(call).toBe(3);
  });

  it("a failing middle step stops the chain, reports the step index, and never runs the later steps", async () => {
    let call = 0;
    const emit = (event: unknown) => {
      const frame = event as { type?: string; commandId: string; payload?: { script?: string } };
      if (frame.type === "browser-command") {
        call += 1;
        // Step 1 (type) succeeds; step 2 (click) misses honestly.
        const value =
          call === 1
            ? { typed: 5, fallback: false, wpm: 150, keydownsCanceled: 0 }
            : { error: "no element matches the CSS selector" };
        queueMicrotask(() => resolveBrowserCommand(frame.commandId, { ok: true, data: { ok: true, value } }));
      }
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({
      action: "sequence",
      sessionId: "tab-seqfail",
      steps: [
        { action: "type", selector: "#q", text: "hello" },
        { action: "click", selector: ".not-there" },
        { action: "read_dom" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("sequence FAILED at step 2 (click)");
    expect(result.output).toContain("steps after it were NOT run");
    expect(result.output).toContain("no element matches the CSS selector");
    // Step 1's line is present; step 3 never ran (only the two commands).
    expect(result.output).toContain("1. ok type —");
    expect(result.output).toContain("2. FAILED click —");
    expect(result.output).not.toContain("3.");
    expect(call).toBe(2);
  });

  it("refuses nested sequence steps, over-cap chains, and malformed steps", async () => {
    const tools = await buildTools(tempDir, { emit: () => {} });
    const bc = tool(tools, "browser_control");

    const nested = await bc.execute({
      action: "sequence",
      sessionId: "tab-seqval",
      steps: [{ action: "wait", ms: 250 }, { action: "sequence", steps: [] }],
    });
    expect(nested.ok).toBe(false);
    expect(nested.output).toContain("cannot include 'sequence'");
    expect(nested.output).toContain("no nesting");

    const overCap = await bc.execute({
      action: "sequence",
      sessionId: "tab-seqval",
      steps: Array.from({ length: 9 }, () => ({ action: "wait", ms: 250 })),
    });
    expect(overCap.ok).toBe(false);
    expect(overCap.output).toContain("over the cap of 8");

    const badAction = await bc.execute({
      action: "sequence",
      sessionId: "tab-seqval",
      steps: [{ action: "levitate" }],
    });
    expect(badAction.ok).toBe(false);
    expect(badAction.output).toContain("'levitate' is not allowed");

    const notObjects = await bc.execute({ action: "sequence", sessionId: "tab-seqval", steps: ["wait"] });
    expect(notObjects.ok).toBe(false);
    expect(notObjects.output).toContain("every step must be an object");

    const empty = await bc.execute({ action: "sequence", sessionId: "tab-seqval", steps: [] });
    expect(empty.ok).toBe(false);
    expect(empty.output).toContain("requires 'steps'");
  });

  it("a plain pause (readyState:false, no selector) works with NO bridge at all — it is just a timed pause", async () => {
    const tools = await buildTools(tempDir); // no emit channel
    const bc = tool(tools, "browser_control");
    const result = await bc.execute({ action: "wait", readyState: false, ms: 250, sessionId: "tab-seq-plain" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("paused 250ms");
  });
});

// ── ROUND-128 (R128-W7a): the browser tools wave's pins ───────────────────
// The owner's 18-entry ledger carried FIVE entries on one failure: every
// hands action (click/type/press_key/mouse) died with "evalJob: unexpected
// start payload (no job started) — got: {}" while eval/read_dom/navigate
// worked fine. Root cause: the hands script builders emitted IIFE
// EXPRESSION statements, but the Rust browser_tab_eval wrapper turns the
// script into a FUNCTION BODY and captures only the inner function's RETURN
// value — an expression statement's value is discarded, the envelope
// answered value:null, and the panel's `start.value ?? {}` collapsed it to
// {} before the error. The pins below make the return-style law
// un-regressable, and pin the wave's other fixes: the raw screenshot mode,
// the get_state live reconcile, read_dom's viewport-aware visibility, and
// the advisory vision line.

describe("browser_control — R128-W7a: the return-style script law (the evalJob fix)", () => {
  it("every hands script builder emits a RETURN-styled script — /^return\\s*\\(function/ (the Rust wrap discards expression-statement values)", () => {
    expect(buildHandsInstallScript()).toMatch(/^return\s*\(function/);
    expect(buildHandsClickScript("#a", "", 1)).toMatch(/^return\s*\(function/);
    expect(buildHandsTypeScript("#q", "hi", false)).toMatch(/^return\s*\(function/);
    expect(buildHandsPressKeyScript("Enter", "")).toMatch(/^return\s*\(function/);
    expect(buildHandsMouseScript("click", 10, 20, null, null, null, null)).toMatch(/^return\s*\(function/);
    // Each still parses as a function BODY (the Rust wrap's contract — the
    // leading return is only legal in exactly that shape).
    for (const script of [
      buildHandsInstallScript(),
      buildHandsClickScript("#a", "", 1),
      buildHandsTypeScript("#q", "hi", false),
      buildHandsPressKeyScript("Enter", ""),
      buildHandsMouseScript("click", 10, 20, null, null, null, null),
    ]) {
      expect(() => new Function(script)).not.toThrow();
    }
  });

  it("THE ROUND-TRIP PIN: the click action script, wrapped exactly the way browser.rs wraps it, answers {needInstall:true} on a bare page — NEVER value:null", () => {
    const script = buildHandsClickScript("#a", "", 1);
    // The wrap, verbatim from src-tauri/src/browser.rs browser_tab_eval:
    // function-body semantics, __acute_r capture, JSON envelope.
    const wrapped = `(function(){try{var __acute_r=(function(){${script}})();return JSON.stringify({ok:true,value:(__acute_r===undefined?null:__acute_r)});}catch(e){return JSON.stringify({ok:false,error:String((e&&(e.message||e))||e)});}})()`;
    // Node has no DOM — the fake `window` parameter is the minimal global
    // stub (a page without the hands runtime).
    const bare: { __acuteHands?: unknown } = {};
    const envelope = JSON.parse(new Function("window", `return ${wrapped}`)(bare) as string) as { ok: boolean; value?: unknown };
    expect(envelope).toEqual({ ok: true, value: { needInstall: true } });
  });

  it("THE ROUND-TRIP PIN (installed page): with a stub runtime the same wrap answers {started:true} — the handshake the pre-R128 shape could never deliver", () => {
    const script = buildHandsClickScript("#a", "", 1);
    const wrapped = `(function(){try{var __acute_r=(function(){${script}})();return JSON.stringify({ok:true,value:(__acute_r===undefined?null:__acute_r)});}catch(e){return JSON.stringify({ok:false,error:String((e&&(e.message||e))||e)});}})()`;
    const handsInstalled: { __acuteHands?: unknown } = {
      __acuteHands: { startJob: () => {} },
    };
    const envelope = JSON.parse(new Function("window", `return ${wrapped}`)(handsInstalled) as string) as { ok: boolean; value?: unknown };
    expect(envelope).toEqual({ ok: true, value: { started: true } });
  });

  it("the INSTALLER's round-trip: the install script through the same wrap answers {installed:true} on a page that already has the runtime (the idempotent branch)", () => {
    const script = buildHandsInstallScript();
    const wrapped = `(function(){try{var __acute_r=(function(){${script}})();return JSON.stringify({ok:true,value:(__acute_r===undefined?null:__acute_r)});}catch(e){return JSON.stringify({ok:false,error:String((e&&(e.message||e))||e)});}})()`;
    // The runtime's first line short-circuits on an existing __acuteHands —
    // the idempotent branch needs no DOM, so the fake window suffices.
    const already: { __acuteHands?: unknown } = { __acuteHands: { startJob: () => {} } };
    const envelope = JSON.parse(new Function("window", `return ${wrapped}`)(already) as string) as { ok: boolean; value?: unknown };
    expect(envelope).toEqual({ ok: true, value: { installed: true, adopted: true } });
  });

  it("THE ANTI-PIN: the OLD IIFE shape through the same wrap answers value:null — the exact discarded-value mechanism behind the ledger's five failures", () => {
    // The pre-R128 shape (an expression statement, no leading return) —
    // kept as the negative control that explains the bug: the inner
    // function's return value never becomes the wrapper's __acute_r.
    const oldScript = `(function () {\n  try {\n    if (!window.__acuteHands) return { needInstall: true };\n    return { started: true };\n  } catch (e) { return { error: String((e && e.message) || e) }; }\n})();`;
    const wrapped = `(function(){try{var __acute_r=(function(){${oldScript}})();return JSON.stringify({ok:true,value:(__acute_r===undefined?null:__acute_r)});}catch(e){return JSON.stringify({ok:false,error:String((e&&(e.message||e))||e)});}})()`;
    const bare: { __acuteHands?: unknown } = {};
    const envelope = JSON.parse(new Function("window", `return ${wrapped}`)(bare) as string) as { ok: boolean; value?: unknown };
    expect(envelope).toEqual({ ok: true, value: null });
  });
});

describe("browser_control — R128-W7a: the screenshot's RAW-CAPTURE mode (describe:false) + the advisory line", () => {
  /** The legacy-path emit: every browser-command resolves with the panel's
   * screenshot_meta region reply (non-capture-contract replies fall through
   * to the legacy path — the r98 suite's idiom). */
  const makeRegionEmit = (region: { x: number; y: number; w: number; h: number }): ((event: unknown) => void) => {
    return (event: unknown) => {
      const frame = event as { commandId?: string };
      if (typeof frame.commandId === "string") {
        queueMicrotask(() =>
          resolveBrowserCommand(frame.commandId!, {
            ok: true,
            data: { supported: true, region, scaleFactor: 1, mode: "native" },
          }),
        );
      }
    };
  };

  it("describe:false captures WITHOUT the vision pass — relayVision is NEVER called; the honest note says NOT described", async () => {
    // A live vision path is configured (the gate would pass) — the pin is
    // that describe:false returns BEFORE the relay regardless.
    const tools = await buildTools(tempDir, { emit: makeRegionEmit({ x: 0, y: 0, w: 640, h: 480 }) });
    setVisionSettings(db, { mode: "separate", provider: "prov-w7a-raw", modelId: "vision-x" });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/w7a-raw", sessionId: "tool-tab-w7a-raw" });
    const result = await bc.execute({ action: "screenshot", describe: false, sessionId: "tool-tab-w7a-raw" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("panel region 640×480");
    expect(result.output).toContain("NOT described");
    expect(result.output).toContain("describe:false");
    expect(result.output).toContain("read / read_dom");
    expect(relayVisionMock).not.toHaveBeenCalled();
    expect(captureState.regions).toEqual([{ x: 0, y: 0, w: 640, h: 480 }]);
    expect(captureState.displayCaptures).toEqual([]);
  });

  it("describe omitted (the default) keeps the vision path as today — the relay runs and the ADVISORY line rides a successful description", async () => {
    visionState.reply = {
      ok: true,
      text: "A checkout form with two filled fields and a disabled Continue button.",
      model: "vision-x",
      mode: "separate",
      ms: 12,
    };
    const tools = await buildTools(tempDir, { emit: makeRegionEmit({ x: 0, y: 0, w: 640, h: 480 }) });
    setVisionSettings(db, { mode: "separate", provider: "prov-w7a-adv", modelId: "vision-x" });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/w7a-adv", sessionId: "tool-tab-w7a-adv" });
    const result = await bc.execute({ action: "screenshot", sessionId: "tool-tab-w7a-adv" });
    expect(result.ok).toBe(true);
    expect(relayVisionMock).toHaveBeenCalledTimes(1);
    // ITEM 5: the advisory line rides every successful vision description.
    expect(result.output).toContain("(advisory vision description — verify against read_dom evidence when it matters)");
    expect(result.output).toContain("vision (vision-x) says:");
    expect(result.output).toContain("checkout form");
  });
});

describe("browser_control — R128-W7a: get_state reconciles the store against the LIVE page", () => {
  it("emit present + a live page answer → ONE bounded eval overrides the store's stale currentUrl and null title", async () => {
    const emit = (event: unknown) => {
      const frame = event as { type?: string; commandId?: string };
      if (frame.type === "browser-command" && typeof frame.commandId === "string") {
        queueMicrotask(() =>
          resolveBrowserCommand(frame.commandId!, {
            ok: true,
            data: { ok: true, value: { url: "https://en.wikipedia.org/wiki/Checkout#step-2", title: "Checkout — Step 2" } },
          }),
        );
      }
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");
    // navigate pushes the store entry with title:null — the stale state.
    // (en.wikipedia.org is on the default documentation allowlist — no
    // approval channel rides these tests.)
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/wiki/Checkout", sessionId: "tool-tab-w7a-gs" });
    const state = JSON.parse((await bc.execute({ action: "get_state", sessionId: "tool-tab-w7a-gs" })).output) as {
      currentUrl: string;
      title: string | null;
      tabs: Array<{ currentUrl: string; title: string | null }>;
    };
    // The LIVE page's truth won: the hash navigation the store never saw,
    // plus the real title (navigate's entries carry title:null).
    expect(state.currentUrl).toBe("https://en.wikipedia.org/wiki/Checkout#step-2");
    expect(state.title).toBe("Checkout — Step 2");
    expect(state.tabs[0]?.currentUrl).toBe("https://en.wikipedia.org/wiki/Checkout#step-2");
    expect(state.tabs[0]?.title).toBe("Checkout — Step 2");
  });

  it("emit ABSENT (no panel mounted) → the store's answer stands verbatim — today's behavior, never a hang", async () => {
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/wiki/Plain", sessionId: "tool-tab-w7a-gs2" });
    const state = JSON.parse((await bc.execute({ action: "get_state", sessionId: "tool-tab-w7a-gs2" })).output) as {
      currentUrl: string;
      title: string | null;
    };
    expect(state.currentUrl).toBe("https://en.wikipedia.org/wiki/Plain");
    expect(state.title).toBeNull();
  });

  it("a probe that answers a NON-string url keeps the store's answer (the honest fallback, never a guessed override)", async () => {
    const emit = (event: unknown) => {
      const frame = event as { type?: string; commandId?: string };
      if (frame.type === "browser-command" && typeof frame.commandId === "string") {
        queueMicrotask(() =>
          resolveBrowserCommand(frame.commandId!, { ok: true, data: { ok: true, value: { markers: [] } } }),
        );
      }
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/wiki/Fallback", sessionId: "tool-tab-w7a-gs3" });
    const state = JSON.parse((await bc.execute({ action: "get_state", sessionId: "tool-tab-w7a-gs3" })).output) as {
      currentUrl: string;
      title: string | null;
    };
    expect(state.currentUrl).toBe("https://en.wikipedia.org/wiki/Fallback");
    expect(state.title).toBeNull();
  });
});

describe("browser_control — R128-W7a: read_dom's viewport-aware visibility", () => {
  it("domRectIntersectsViewport (the pure predicate): a transform-hidden off-screen rect (x:-270 sidebar) is EXCLUDED; on-screen and edge-straddling rects pass", () => {
    const viewport = { width: 1280, height: 720 };
    // The ledger's exact shape: a sidebar at translateX(-100%) keeps its
    // layout box fully left of the viewport (right edge still ≤ 0).
    expect(
      domRectIntersectsViewport({ width: 200, height: 600, left: -270, top: 60, right: -70, bottom: 660 }, viewport),
    ).toBe(false);
    // A plain on-screen rect.
    expect(
      domRectIntersectsViewport({ width: 200, height: 40, left: 100, top: 100, right: 300, bottom: 140 }, viewport),
    ).toBe(true);
    // Straddling the right edge — still partially visible → interactive.
    expect(
      domRectIntersectsViewport({ width: 200, height: 40, left: 1200, top: 10, right: 1400, bottom: 50 }, viewport),
    ).toBe(true);
    // Fully below the fold → excluded (the driver scrolls first; read_dom
    // reports it after the scroll re-runs).
    expect(
      domRectIntersectsViewport({ width: 200, height: 40, left: 100, top: 800, right: 300, bottom: 840 }, viewport),
    ).toBe(false);
    // Degenerate boxes stay excluded (the old law).
    expect(
      domRectIntersectsViewport({ width: 0, height: 40, left: 10, top: 10, right: 10, bottom: 50 }, viewport),
    ).toBe(false);
  });

  it("the read_dom page script inlines the SAME viewport-intersection terms (the lockstep pin)", async () => {
    const scripts: string[] = [];
    const emit = (event: unknown) => {
      const frame = event as { commandId: string; payload: { script?: string } };
      scripts.push(String(frame.payload.script ?? ""));
      queueMicrotask(() =>
        resolveBrowserCommand(frame.commandId, {
          ok: true,
          data: { ok: true, value: { title: "T", url: "https://example.com/", headings: [], interactive: [], forms: [] } },
        }),
      );
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "read_dom", sessionId: "tab-w7a-vis" });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("r.right > 0");
    expect(scripts[0]).toContain("r.bottom > 0");
    expect(scripts[0]).toContain("r.left < window.innerWidth");
    expect(scripts[0]).toContain("r.top < window.innerHeight");
    // The script still parses as a function body (the Rust wrap's contract).
    expect(() => new Function(scripts[0])).not.toThrow();
  });
});

// ── ROUND-131 (R131-B): the browser tool truths + the download action ──────
// The field ledger's 8 CONFIRMED defects (UPLOADED/Feedback-2.txt — every
// claim re-verified against the code before this wave earned it): the click
// "job vanished" ambiguity, the non-navigation-aware wait, read_dom's
// style/script pollution + mid-payload truncation, the eval null-payload
// dead end, the type auto-submit ambiguity, the bare-list unknown-action
// refusal, get_state's title:null + the dual-writer history drift, and the
// missing download capability. The redirect-collapse history pins live in
// browser-proxy.test.ts (the mutation core's home); everything the TOOL
// answers lives here.

describe("R131-B (defect 6): nearestBrowserAction + the honest refusal", () => {
  it("the pure matcher: a prefix or ≤2-edit typo gets the hint; far-off garbage gets null (never a forced guess)", () => {
    // The ledger's exact shapes — "three of this turn's seven failures were
    // one stray character away from valid actions".
    expect(nearestBrowserAction("get_state>")).toBe("get_state"); // stray trailing char
    expect(nearestBrowserAction("navigte")).toBe("navigate"); // edit distance 1
    expect(nearestBrowserAction("clik")).toBe("click");
    expect(nearestBrowserAction("downloa")).toBe("download");
    expect(nearestBrowserAction("READ")).toBe("read"); // case-insensitive
    expect(nearestBrowserAction("  wait  ")).toBe("wait"); // whitespace tolerated
    // Garbage — the plain list, never a forced hint.
    expect(nearestBrowserAction("flurbewizzle")).toBeNull();
    expect(nearestBrowserAction("zzzzzzzz")).toBeNull();
    expect(nearestBrowserAction("")).toBeNull();
    expect(nearestBrowserAction("   ")).toBeNull();
  });

  it("the unknown-action refusal: a close typo gets the did-you-mean hint; garbage gets the FULL list (mouse + download included)", async () => {
    expect(BROWSER_CONTROL_ACTIONS).toContain("mouse"); // the old bare list omitted it
    expect(BROWSER_CONTROL_ACTIONS).toContain("download");
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");

    const typo = await bc.execute({ action: "get_state>", sessionId: "tab-r131-act" });
    expect(typo.ok).toBe(false);
    expect(typo.output).toContain("unknown action 'get_state>'");
    expect(typo.output).toContain("did you mean 'get_state'?");
    // The list is the vocabulary, one source of truth.
    expect(typo.output).toContain(`(${BROWSER_CONTROL_ACTIONS.join(" | ")})`);

    const garbage = await bc.execute({ action: "flurbewizzle", sessionId: "tab-r131-act" });
    expect(garbage.ok).toBe(false);
    expect(garbage.output).not.toContain("did you mean");
    expect(garbage.output).toContain("mouse");
    expect(garbage.output).toContain("download");
  });

  it("the sequence step refusal carries the same nearest-match hint", async () => {
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");
    const seq = await bc.execute({
      action: "sequence",
      sessionId: "tab-r131-act",
      steps: [{ action: "get_state>" }],
    });
    expect(seq.ok).toBe(false);
    expect(seq.output).toContain("step action 'get_state>' is not allowed");
    expect(seq.output).toContain("did you mean 'get_state'?");
    expect(seq.output).toContain("allowed step actions");
  });

  it("THE LOCKSTEP PIN: the schema's action enum IS BROWSER_CONTROL_ACTIONS, and SEQUENCE_STEP_ACTIONS is the same vocabulary minus {sequence, download}", async () => {
    // The BROWSER_CONTROL_ACTIONS comment promises "kept in lockstep with the
    // inputSchema's action enum + SEQUENCE_STEP_ACTIONS (the browser-tool
    // pins assert all three carry the same vocabulary)" — this is that pin.
    // One source of truth: the refusal message can never again omit an
    // action (the defect-6 story: `mouse` was missing) nor the schema drift
    // from the list.
    const tools = await buildTools(tempDir);
    // The AI SDK's jsonSchema() wrapper: the raw JSON Schema object rides the
    // `.jsonSchema` field (_type/validate are the SDK's own plumbing).
    const bc = (tools as unknown as Record<string, { inputSchema?: { jsonSchema?: unknown } }>)["browser_control"];
    const schema = JSON.parse(JSON.stringify(bc?.inputSchema?.jsonSchema ?? {})) as {
      properties?: { action?: { enum?: unknown } };
    };
    const enumActions = schema.properties?.action?.enum;
    expect(Array.isArray(enumActions)).toBe(true);
    // Exact order — the enum and the list are ONE source of truth.
    expect(enumActions).toEqual([...BROWSER_CONTROL_ACTIONS]);
    // The step vocabulary: everything except `sequence` (no nesting) and
    // `download` (a terminal side effect, deliberately not a step action —
    // pinned through the refusal's own list, the same string the model
    // sees). Set insertion order differs, so the comparison is sorted.
    const seq = await tool(tools, "browser_control").execute({
      action: "sequence",
      sessionId: "tab-r131-act",
      steps: [{ action: "zzz-not-an-action" }],
    });
    expect(seq.ok).toBe(false);
    const listMatch = /allowed step actions: (.+)\)/.exec(seq.output);
    expect(listMatch).not.toBeNull();
    const stepActions = (listMatch![1] ?? "").split(" | ").map((s) => s.trim()).sort();
    expect(stepActions).toEqual(BROWSER_CONTROL_ACTIONS.filter((a) => a !== "sequence" && a !== "download").sort());
  });
});

describe("R131-B (defect 1): click's vanished-job re-probe — the navigation truth", () => {
  /** An emit that answers the bridge from a scripted reply per command. */
  const makeClickEmit = (
    replies: Array<{ match: (action: string, script: string) => boolean; data: unknown; reject?: boolean }>,
    commands: Array<{ action: string; script: string }>,
  ) => {
    return (event: unknown) => {
      const frame = event as { type?: string; action?: string; commandId?: string; payload?: { script?: string } };
      if (frame.type !== "browser-command" || typeof frame.commandId !== "string") return;
      const action = String(frame.action ?? "");
      const script = String(frame.payload?.script ?? "");
      commands.push({ action, script });
      const reply = replies.find((r) => r.match(action, script));
      queueMicrotask(() => {
        if (reply === undefined) {
          resolveBrowserCommand(frame.commandId!, { ok: true, data: { ok: true, value: { title: "Clean page", text: "", markers: [] } } });
          return;
        }
        if (reply.reject === true) {
          resolveBrowserCommand(frame.commandId!, { ok: false, error: "the bridge is dead" });
          return;
        }
        resolveBrowserCommand(frame.commandId!, { ok: true, data: reply.data });
      });
    };
  };

  it("vanished + the URL CHANGED ⇒ ok:true with the landing URL (the click triggered the navigation itself)", async () => {
    const commands: Array<{ action: string; script: string }> = [];
    const emit = makeClickEmit(
      [
        {
          // The panel's job-poll verdict, verbatim from the ledger.
          match: (action) => action === "evalJob",
          data: { ok: false, error: "the job vanished (the page navigated away)" },
        },
        {
          // The ONE bounded re-probe: location.href after the vanished job.
          match: (_action, script) => script === "return location.href;",
          data: { ok: true, value: "https://en.wikipedia.org/wiki/Landing_page" },
        },
      ],
      commands,
    );
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/wiki/Start_page", sessionId: "tab-r131-click" });

    const result = await bc.execute({ action: "click", selector: "#page5link", sessionId: "tab-r131-click" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("the click triggered a navigation");
    expect(result.output).toContain("https://en.wikipedia.org/wiki/Landing_page");
    expect(result.output).toContain("the navigation IS the click's effect");
    // The re-probe really was ONE location.href eval (the get_state reconcile
    // pattern), not a full state read.
    const probes = commands.filter((c) => c.action === "eval" && c.script === "return location.href;");
    expect(probes).toHaveLength(1);
  });

  it("vanished + the URL UNCHANGED ⇒ the truthful selector-not-found failure (still fails, but honestly)", async () => {
    const commands: Array<{ action: string; script: string }> = [];
    const emit = makeClickEmit(
      [
        { match: (action) => action === "evalJob", data: { ok: false, error: "the job vanished (the page navigated away)" } },
        { match: (_action, script) => script === "return location.href;", data: { ok: true, value: "https://en.wikipedia.org/wiki/Start_page" } },
      ],
      commands,
    );
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/wiki/Start_page", sessionId: "tab-r131-click2" });

    const result = await bc.execute({ action: "click", selector: ".not-there", sessionId: "tab-r131-click2" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("the job vanished (the page navigated away)");
    expect(result.output).toContain("the page did not navigate (still at https://en.wikipedia.org/wiki/Start_page)");
    expect(result.output).toContain("the selector may not exist");
  });

  it("a NON-vanished failure passes through verbatim (no re-probe); a dead re-probe keeps the original failure", async () => {
    // (a) A plain page error — no location probe at all.
    let commands: Array<{ action: string; script: string }> = [];
    let emit = makeClickEmit([{ match: (action) => action === "evalJob", data: { ok: false, error: "the page rejected the script" } }], commands);
    let tools = await buildTools(tempDir, { emit });
    let bc = tool(tools, "browser_control");
    const plain = await bc.execute({ action: "click", selector: "#a", sessionId: "tab-r131-click3" });
    expect(plain.ok).toBe(false);
    expect(plain.output).toContain("the page rejected the script");
    expect(commands.some((c) => c.script === "return location.href;")).toBe(false);

    // (b) The vanished error + a re-probe that itself fails — the original
    // failure stands verbatim (never a fabricated landing).
    commands = [];
    emit = makeClickEmit(
      [
        { match: (action) => action === "evalJob", data: { ok: false, error: "the job vanished (the page navigated away)" } },
        { match: (_action, script) => script === "return location.href;", data: { ok: true, value: "https://en.wikipedia.org/wiki/Landing_page" }, reject: true },
      ],
      commands,
    );
    tools = await buildTools(tempDir, { emit });
    bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/wiki/Start_page", sessionId: "tab-r131-click3" });
    const deadProbe = await bc.execute({ action: "click", selector: "#a", sessionId: "tab-r131-click3" });
    expect(deadProbe.ok).toBe(false);
    expect(deadProbe.output).toContain("browser_control: click — page error: the job vanished (the page navigated away)");
  });
});

describe("R131-B (defect 2): wait is navigation-aware", () => {
  it("urlContains matched while readyState 'loading' ⇒ SUCCESS with the note (the ledger's Google-SPA shape)", async () => {
    const emit = (event: unknown) => {
      const frame = event as { type?: string; commandId?: string; payload?: { script?: string } };
      if (frame.type === "browser-command" && typeof frame.commandId === "string") {
        queueMicrotask(() =>
          resolveBrowserCommand(frame.commandId!, {
            ok: true,
            data: { ok: true, value: { ready: "loading", has: null, url: "https://www.google.com/search?q=acute+code" } },
          }),
        );
      }
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({ action: "wait", urlContains: "/search?q=acute", ms: 900, sessionId: "tab-r131-wait" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("wait ok");
    expect(result.output).toContain("\"urlContains\":true");
    // The note — in the JSON payload AND the trailing line.
    expect(result.output).toContain("\"note\":\"readyState 'loading' at match time\"");
    expect(result.output).toContain("note: readyState 'loading' at match time");
  });

  it("the timeout report carries the CURRENT URL + WHICH conditions failed", async () => {
    const emit = (event: unknown) => {
      const frame = event as { type?: string; commandId?: string };
      if (frame.type === "browser-command" && typeof frame.commandId === "string") {
        queueMicrotask(() =>
          resolveBrowserCommand(frame.commandId!, {
            ok: true,
            data: { ok: true, value: { ready: "loading", has: false, url: "https://www.google.com/" } },
          }),
        );
      }
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({ action: "wait", selector: "#results", urlContains: "/search", ms: 250, sessionId: "tab-r131-wait2" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("timed out after 250ms (currentUrl: https://www.google.com/)");
    expect(result.output).toContain("document.readyState is 'loading' (needs 'complete')");
    expect(result.output).toContain("the selector '#results' did not appear");
    expect(result.output).toContain("the URL still doesn't contain '/search' (last seen: https://www.google.com/)");
  });

  it("an unanswering page reports the NO-QUOTES unknown form (the ledger's unclosed-quote malformation is dead)", async () => {
    // The bridge never answers — the wait probe times out, lastReady stays
    // null, and the unknown line carries no quote-wrapped compound.
    const emit = vi.fn();
    const tools = await buildTools(tempDir, { emit: emit as unknown as (event: unknown) => void });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({ action: "wait", urlContains: "/search", ms: 250, sessionId: "tab-r131-wait3" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("timed out after 250ms (currentUrl: unknown)");
    expect(result.output).toContain(
      "document.readyState is unknown — the page never answered a probe (it may be navigating); needs 'complete'",
    );
    // The old shape embedded the fallback INSIDE the quotes.
    expect(result.output).not.toContain("is 'unknown");
  });
});

describe("R131-B (defect 3): read_dom — rendered text + the offset/range cursor", () => {
  it("the compiled script extracts RENDERED text (innerText) and skips style/script/noscript/template ancestors", async () => {
    const scripts: string[] = [];
    const emit = (event: unknown) => {
      const frame = event as { commandId: string; payload: { script?: string } };
      scripts.push(String(frame.payload.script ?? ""));
      queueMicrotask(() =>
        resolveBrowserCommand(frame.commandId, {
          ok: true,
          data: { ok: true, value: { title: "T", url: "https://example.com/", headings: [], interactive: [], forms: [] } },
        }),
      );
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    await bc.execute({ action: "read_dom", include: "all", sessionId: "tab-r131-dom" });
    expect(scripts).toHaveLength(1);
    // The WALL_PROBE's own discipline, mirrored: innerText is what the page
    // PAINTS (a <button> whose textContent was a CSS blob renders no CSS).
    expect(scripts[0]).toContain("el.innerText");
    // The paragraphs walker skips the code-bearing ancestors outright.
    expect(scripts[0]).toContain('closest("style, script, noscript, template")');
    // The unpaged loop keeps the 120-element cap (byte-identical shape).
    expect(scripts[0]).toContain("interactive.length >= 120");
    expect(() => new Function(scripts[0])).not.toThrow();
  });

  it("offset pages the interactive elements: 'showing elements N..M of T' (an element-count cursor, never a byte slice)", async () => {
    const scripts: string[] = [];
    const outline = {
      title: "Big page",
      url: "https://example.com/",
      headings: [],
      interactiveCount: 7,
      interactive: [{ tag: "a", text: "link-3" }, { tag: "a", text: "link-4" }, { tag: "a", text: "link-5" }],
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

    const result = await bc.execute({ action: "read_dom", offset: 2, range: 3, sessionId: "tab-r131-dom2" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("showing elements 3..5 of 7");
    // The paged script counts EVERY visible interactive and windows the
    // collection in the PAGE (the cursor is element-count, not bytes).
    expect(scripts[0]).toContain("let interactiveCount = 0;");
    expect(scripts[0]).toContain("interactiveCount >= 2");
    expect(scripts[0]).toContain("interactive.length < 3");
    expect(scripts[0]).not.toContain("interactive.length >= 120");
  });

  it("offset beyond the end answers the honest empty + the count", async () => {
    const outline = {
      title: "Big page",
      url: "https://example.com/",
      headings: [],
      interactiveCount: 5,
      interactive: [],
      forms: [],
      paragraphs: undefined,
    };
    const emit = (event: unknown) => {
      const frame = event as { commandId: string };
      queueMicrotask(() => resolveBrowserCommand(frame.commandId, { ok: true, data: { ok: true, value: outline } }));
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({ action: "read_dom", offset: 9, sessionId: "tab-r131-dom3" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("offset 9 is beyond the end — the page has 5 interactive elements; pass a smaller offset");
  });

  it("the outer truncation marker now suggests the offset/range escape hatch", async () => {
    const big = "x".repeat(14_000);
    const emit = (event: unknown) => {
      const frame = event as { commandId: string };
      queueMicrotask(() =>
        resolveBrowserCommand(frame.commandId, { ok: true, data: { ok: true, value: { title: big, url: "https://example.com/", headings: [], interactive: [], forms: [] } } }),
      );
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({ action: "read_dom", sessionId: "tab-r131-dom4" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("truncated");
    expect(result.output).toContain("page the elements with offset/range");
  });
});

describe("R131-B (defect 4): eval's null payload carries the diagnosis", () => {
  it("a null value answers ok:true with the last-known URL + the re-probe hint (never a bare dead end)", async () => {
    const emit = (event: unknown) => {
      const frame = event as { commandId: string; payload?: { script?: string } };
      const script = String(frame.payload?.script ?? "");
      queueMicrotask(() => {
        if (script.includes("return location.href") || script.startsWith("const title")) {
          // the navigate wall probe + the get_state reconcile shape
          resolveBrowserCommand(frame.commandId, { ok: true, data: { ok: true, value: { title: "Clean page", text: "", markers: [], url: "https://en.wikipedia.org/wiki/Eval" } } });
          return;
        }
        resolveBrowserCommand(frame.commandId, { ok: true, data: { ok: true, value: null } });
      });
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/wiki/Eval", sessionId: "tab-r131-eval" });

    const result = await bc.execute({ action: "eval", script: "return undefined_thing", sessionId: "tab-r131-eval" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("null — the page may have navigated while the script ran, or the script returned undefined");
    expect(result.output).toContain("Last known URL: https://en.wikipedia.org/wiki/Eval");
    expect(result.output).toContain("Re-probe with get_state");
  });

  it("with no page open the last-known URL says so honestly", async () => {
    const emit = (event: unknown) => {
      const frame = event as { commandId: string };
      queueMicrotask(() => resolveBrowserCommand(frame.commandId, { ok: true, data: { ok: true, value: null } }));
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");
    // No navigation — the tab has no URL yet (the download action's tab
    // state is the same store; only the addressed session matters).
    const result = await bc.execute({ action: "eval", script: "return null", sessionId: "tab-r131-eval2" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("(no page open in this tab yet)");
  });
});

describe("R131-B (defect 7a): the get_state reconcile's loading-page robustness", () => {
  it("a REJECTED probe (bridge error / page navigating) keeps the store's answer — never a hang, never a guess", async () => {
    const emit = (event: unknown) => {
      const frame = event as { type?: string; commandId?: string };
      if (frame.type === "browser-command" && typeof frame.commandId === "string") {
        queueMicrotask(() => resolveBrowserCommand(frame.commandId!, { ok: false, error: "the page is navigating" }));
      }
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/wiki/Loading", sessionId: "tab-r131-gs" });
    const state = JSON.parse((await bc.execute({ action: "get_state", sessionId: "tab-r131-gs" })).output) as {
      currentUrl: string;
      title: string | null;
    };
    expect(state.currentUrl).toBe("https://en.wikipedia.org/wiki/Loading");
    expect(state.title).toBeNull();
  });
});

describe("R131-B (defect 5): type echoes the REQUESTED submit flag vs the OBSERVED outcome", () => {
  it("requested:false + observed submitted (the page submitted on its own) — both sides named, the ambiguity dead", async () => {
    const emit = (event: unknown) => {
      const frame = event as { commandId: string };
      queueMicrotask(() =>
        resolveBrowserCommand(frame.commandId, {
          ok: true,
          data: { ok: true, value: { typed: "#ti6dpd", submitted: true, submitHow: "synthetic Enter + form.requestSubmit()" } },
        }),
      );
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({ action: "type", selector: "#ti6dpd", text: "cute anime cat girls", sessionId: "tab-r131-type" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("submit requested: false · observed: submitted (synthetic Enter + form.requestSubmit())");
    expect(result.output).toContain("The page submitted the form on its own");
  });

  it("requested:true + submitted (the commanded path) and requested:false + not submitted (the plain path)", async () => {
    const replies = [
      { typed: "#q", submitted: true, submitHow: "form.requestSubmit()" },
      { typed: "#search", submitted: false, submitHow: "" },
    ];
    let call = 0;
    const emit = (event: unknown) => {
      const frame = event as { commandId: string };
      const reply = replies[Math.min(call, replies.length - 1)];
      call += 1;
      queueMicrotask(() => resolveBrowserCommand(frame.commandId, { ok: true, data: { ok: true, value: reply } }));
    };
    const tools = await buildTools(tempDir, { emit });
    const bc = tool(tools, "browser_control");

    const commanded = await bc.execute({ action: "type", selector: "#q", text: "acute", submit: true, sessionId: "tab-r131-type2" });
    expect(commanded.ok).toBe(true);
    expect(commanded.output).toContain("submit requested: true · observed: submitted (form.requestSubmit())");
    expect(commanded.output).toContain("The form was submitted (native requestSubmit)");

    const plain = await bc.execute({ action: "type", selector: "#search", text: "hello", sessionId: "tab-r131-type2" });
    expect(plain.ok).toBe(true);
    expect(plain.output).toContain("submit requested: false · observed: not submitted (no form found)");
    expect(plain.output).not.toContain("The page submitted the form on its own");
    expect(plain.output).not.toContain("The form was submitted");
  });
});

// ── ROUND-131 (R131-B, defect 8): the download action ──────────────────────
// The owner's headline verdict: "it is not able to right-click and then click
// save as and save to the download folder as it needs to be… a full-fledged
// browser." The tool-side half is pinned here against a REAL local upstream
// (the fetch itself is the REAL fetchUpstreamGuarded walk — cookie jar, UA,
// referer, redirects, caps — only the network is hermetic).

describe("R131-B (defect 8): download — the pure helpers", () => {
  it("sniffMagicBytes: PNG / JPEG / GIF / WEBP markers; text and short buffers answer null", () => {
    expect(sniffMagicBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]))).toBe("png");
    expect(sniffMagicBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]))).toBe("jpeg");
    expect(sniffMagicBytes(Buffer.from("GIF89a"))).toBe("gif");
    expect(sniffMagicBytes(Buffer.from("RIFF____WEBPVP8 "))).toBe("webp");
    expect(sniffMagicBytes(Buffer.from("<html>not an image</html>"))).toBeNull();
    expect(sniffMagicBytes(Buffer.from([0x89, 0x50]))).toBeNull(); // truncated — no verdict
  });

  it("sanitizeDownloadFilename: the basename only (no traversal), control glyphs stripped, leading dots dropped, honest nulls", () => {
    expect(sanitizeDownloadFilename("../evil.png")).toBe("evil.png");
    expect(sanitizeDownloadFilename("a/b\\c.txt")).toBe("c.txt");
    expect(sanitizeDownloadFilename("re\u0007port.png")).toBe("report.png");
    expect(sanitizeDownloadFilename(".hidden")).toBe("hidden");
    expect(sanitizeDownloadFilename("x".repeat(200))).toHaveLength(120);
    expect(sanitizeDownloadFilename("")).toBeNull();
    expect(sanitizeDownloadFilename("...")).toBeNull();
    expect(sanitizeDownloadFilename(".")).toBeNull();
    expect(sanitizeDownloadFilename("..")).toBeNull();
  });

  it("downloadSuffixName keeps the extension; looksLikeTextPayload smells the 200-that-lied shape", () => {
    expect(downloadSuffixName("photo.png", 2)).toBe("photo-2.png");
    expect(downloadSuffixName("photo.png", 3)).toBe("photo-3.png");
    expect(downloadSuffixName("noext", 2)).toBe("noext-2");
    expect(looksLikeTextPayload(Buffer.from("<html>error page</html>"))).toBe(true);
    // A NUL (or any low control byte) in the head is binary, full stop —
    // high-bit bytes alone are NOT (UTF-8 text carries them).
    expect(looksLikeTextPayload(Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d]))).toBe(false);
    expect(looksLikeTextPayload(Buffer.from("caf\u00e9 menu"))).toBe(true);
  });
});

describe("R131-B (defect 8): download — the action (real fetch, hermetic upstream)", () => {
  // A REAL local upstream: PNG bytes, a text liar, a 404, a redirect hop,
  // a cookie-setting page, and a header echo (referer + UA + cookie).
  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const ALT_PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
  let upstream: http.Server;
  let upstreamBase = "";

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      switch (req.url) {
        case "/pic.png":
          res.writeHead(200, { "content-type": "image/png" }).end(PNG_BYTES);
          return;
        case "/alt.png":
          res.writeHead(200, { "content-type": "image/png" }).end(ALT_PNG_BYTES);
          return;
        case "/liar.png":
          res.writeHead(200, { "content-type": "image/png" }).end("<html>error page served as an image</html>");
          return;
        case "/hop.png":
          res.writeHead(302, { location: "/pic.png" }).end();
          return;
        case "/set-cookie":
          res.writeHead(200, { "content-type": "text/plain", "set-cookie": "dl=sess321; Path=/" }).end("ok");
          return;
        case "/echo":
          res.writeHead(200, { "content-type": "text/plain" }).end(
            `referer=${req.headers.referer ?? "(none)"} ua=${req.headers["user-agent"] ?? "(none)"} cookie=${req.headers.cookie ?? "(none)"}`,
          );
          return;
        case "/missing.png":
          res.writeHead(404, { "content-type": "text/plain" }).end("not found");
          return;
        default:
          res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    extendPrivateNetAllowlistForTest(`127.0.0.1:${(upstream.address() as AddressInfo).port}`);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    resetPrivateNetAllowlistForTest();
  });

  /** buildTools + the project row the download resolves (rootPath = tempDir). */
  async function buildToolsWithProject(deps?: { emit?: (event: unknown) => void }) {
    const tools = await buildTools(tempDir, deps);
    db.prepare(
      "INSERT INTO projects (id, name, root_path, color, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("proj_browser_tool", "Browser Tool", tempDir, "#F59E0B", new Date().toISOString());
    return tools;
  }

  it("saves a PNG to <root>/.acute/downloads/ (the R131-X hidden-folder location) with the magic verdict, the project-relative path, and the browser-download frame", async () => {
    const frames: unknown[] = [];
    const tools = await buildToolsWithProject({ emit: makeRecordingEmit(frames) });
    const bc = tool(tools, "browser_control");

    const result = await bc.execute({ action: "download", url: `${upstreamBase}/pic.png`, filename: "photo.png", sessionId: "tab-r131-dl" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("saved .acute/downloads/photo.png"); // R131-X: the hidden folder
    expect(result.output).toContain("12 bytes");
    expect(result.output).toContain("image/png");
    expect(result.output).toContain("magic PNG ✓");
    expect(result.output).toContain("project-relative");
    // The file on disk, exact bytes, in the pinned ROUND-115 location.
    expect(existsSync(join(tempDir, ".acute", "downloads", "photo.png"))).toBe(true);
    expect(readFileSync(join(tempDir, ".acute", "downloads", "photo.png"))).toEqual(PNG_BYTES);
    // The announcement frame — beside the browser-navigate emit pattern.
    const frame = frames.find((f) => (f as { type?: string }).type === "browser-download") as
      | { tabId: string; sessionId: string; path: string; bytes: number }
      | undefined;
    expect(frame).toBeDefined();
    expect(frame).toMatchObject({ tabId: "tab-r131-dl", path: ".acute/downloads/photo.png", bytes: 12 });
  });

  it("no filename given ⇒ the URL's last path segment; a redirect hop lands the FINAL segment", async () => {
    const tools = await buildToolsWithProject();
    const bc = tool(tools, "browser_control");

    const named = await bc.execute({ action: "download", url: `${upstreamBase}/pic.png`, sessionId: "tab-r131-dl2" });
    expect(named.ok).toBe(true);
    expect(named.output).toContain("saved .acute/downloads/pic.png");

    const hopped = await bc.execute({ action: "download", url: `${upstreamBase}/hop.png`, sessionId: "tab-r131-dl2" });
    expect(hopped.ok).toBe(true);
    // The redirect chain was followed (fetchUpstreamGuarded's manual walk —
    // the FINAL url names the source and its segment named the file) and the
    // same bytes arrived, so the incumbent was REUSED (never re-written).
    expect(hopped.output).toContain("already saved as .acute/downloads/pic.png");
    expect(hopped.output).toContain("from " + `${upstreamBase}/pic.png`);
  });

  it("nothing is ever silently overwritten: different bytes mint -2/-3, identical bytes are REUSED", async () => {
    const tools = await buildToolsWithProject();
    const bc = tool(tools, "browser_control");

    const second = await bc.execute({ action: "download", url: `${upstreamBase}/alt.png`, filename: "photo.png", sessionId: "tab-r131-dl3" });
    expect(second.ok).toBe(true);
    expect(second.output).toContain("saved .acute/downloads/photo-2.png");
    expect(readFileSync(join(tempDir, ".acute", "downloads", "photo-2.png"))).toEqual(ALT_PNG_BYTES);
    // The incumbent kept its bytes — no overwrite.
    expect(readFileSync(join(tempDir, ".acute", "downloads", "photo.png"))).toEqual(PNG_BYTES);

    const third = await bc.execute({ action: "download", url: `${upstreamBase}/pic.png`, filename: "photo.png", sessionId: "tab-r131-dl3" });
    expect(third.ok).toBe(true);
    expect(third.output).toContain("already saved as .acute/downloads/photo.png");
    expect(third.output).toContain("byte-identical");
    expect(existsSync(join(tempDir, ".acute", "downloads", "photo-3.png"))).toBe(false);
  });

  it("a filename with path separators is sanitized — no traversal out of .acute/downloads/", async () => {
    const tools = await buildToolsWithProject();
    const bc = tool(tools, "browser_control");
    const result = await bc.execute({ action: "download", url: `${upstreamBase}/pic.png`, filename: "../../evil.png", sessionId: "tab-r131-dl4" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("saved .acute/downloads/evil.png");
    expect(existsSync(join(tempDir, ".acute", "downloads", "evil.png"))).toBe(true);
    expect(existsSync(join(tempDir, "evil.png"))).toBe(false); // never escaped
  });

  it("the liar shape: content-type image/png over TEXT bytes — saved, mismatch REPORTED, requested name kept", async () => {
    const tools = await buildToolsWithProject();
    const bc = tool(tools, "browser_control");
    const result = await bc.execute({ action: "download", url: `${upstreamBase}/liar.png`, filename: "liar.png", sessionId: "tab-r131-dl5" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("HONESTY NOTE: the content-type says image/png but the bytes carry no known image signature");
    expect(result.output).toContain("look like TEXT");
    expect(result.output).toContain("saved .acute/downloads/liar.png");
  });

  it("the referer + the panel's user agent + the tab's cookies ride the fetch (the page-context contract)", async () => {
    const frames: unknown[] = [];
    const tools = await buildToolsWithProject({ emit: makeRecordingEmit(frames) });
    const bc = tool(tools, "browser_control");
    // The tab is ON a page (the honest referer), and its project jar holds a
    // cookie set by an earlier same-project fetch.
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/wiki/Downloads", sessionId: "tab-r131-dl6" });
    await bc.execute({ action: "download", url: `${upstreamBase}/set-cookie`, filename: "cookie-set.txt", sessionId: "tab-r131-dl6" });
    const result = await bc.execute({ action: "download", url: `${upstreamBase}/echo`, filename: "echo.txt", sessionId: "tab-r131-dl6" });
    expect(result.ok).toBe(true);
    // The echoed headers, verbatim in the saved body: the page as referer,
    // the PANEL's UA (Chrome-lineage, AcuteBrowser-free server-side fetch
    // UA is the proxy's own — pinned by its own string), and the cookie.
    const body = readFileSync(join(tempDir, ".acute", "downloads", "echo.txt"), "utf8");
    expect(body).toContain("referer=https://en.wikipedia.org/wiki/Downloads");
    expect(body).toContain("ua=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
    expect(body).toContain("cookie=dl=sess321");
    // The output names the referer too.
    expect(result.output).toContain("referer: https://en.wikipedia.org/wiki/Downloads");
  });

  it("failures are honest: HTTP status named, non-http(s) refused, unknown project refused", async () => {
    const tools = await buildToolsWithProject();
    const bc = tool(tools, "browser_control");

    const missing = await bc.execute({ action: "download", url: `${upstreamBase}/missing.png`, sessionId: "tab-r131-dl7" });
    expect(missing.ok).toBe(false);
    expect(missing.output).toContain("HTTP 404");
    expect(missing.output).toContain(`${upstreamBase}/missing.png`);

    const ftp = await bc.execute({ action: "download", url: "ftp://example.com/file.png", sessionId: "tab-r131-dl7" });
    expect(ftp.ok).toBe(false);
    expect(ftp.output).toContain("only http(s) URLs can be downloaded");

    const noUrl = await bc.execute({ action: "download", sessionId: "tab-r131-dl7" });
    expect(noUrl.ok).toBe(false);
    expect(noUrl.output).toContain("requires 'url'");

    // No project row ⇒ the honest refusal (a project-bound chat session is
    // where downloads live).
    const bare = await buildTools(tempDir);
    const bcBare = tool(bare, "browser_control");
    const noProject = await bcBare.execute({ action: "download", url: `${upstreamBase}/pic.png`, sessionId: "tab-r131-dl8" });
    expect(noProject.ok).toBe(false);
    expect(noProject.output).toContain("project 'proj_browser_tool' was not found");
  });
});
