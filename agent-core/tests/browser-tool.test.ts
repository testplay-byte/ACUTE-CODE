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
import {
  resetActiveComputerRelayForTest,
  setActiveComputerRelay,
} from "../src/tools/plugins/computer-relay.js";
import { buildServer } from "../src/server";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { ProviderKeyring } from "../src/providers/registry";
import { resetBrowserStoreForTest } from "../src/browser-proxy";
import type { ToolSet } from "ai";

// The AI SDK tool contract — narrow to what the tests call.
type Tool = { execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }> };
function tool(set: ToolSet, name: string): Tool {
  return (set as unknown as Record<string, Tool>)[name];
}

let tempDir = "";

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
  it("defaults to the shared 'agent' session when no browser tab exists (with hint)", async () => {
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");

    const nav = await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/agent-default" });
    expect(nav.ok).toBe(true);
    expect(nav.output).toContain("no embedded browser tab is open");

    const state = JSON.parse((await bc.execute({ action: "get_state" })).output) as { sessionId: string; currentUrl: string };
    expect(state.sessionId).toBe("agent");
    expect(state.currentUrl).toBe("https://en.wikipedia.org/agent-default");
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
  it("the tool's DEFAULT target is the tab session the server minted; tool pushes are visible over HTTP", async () => {
    // ROUND-45: buildTools opens a fresh db AND assigns it to the module-level
    // `db` — do it FIRST so the server and the afterEach cleanup share it.
    await buildTools(tempDir);
    app = buildServer({
      token: TOKEN,
      db,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: "sk-or-vtest" }),
    });

    // The panel flow: mint a session over HTTP (the route store registers as
    // the active tool store) — this tab becomes the most recently used one.
    const mint = await app.inject({
      method: "POST",
      url: "/api/v1/browser/session",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { sessionId: "tab-live-1" },
    });
    expect(mint.statusCode).toBe(200);

    const tools = await buildProjectTools(tempDir, undefined, {
      db,
      sessionId: "sess_browser_tool",
      agentId: "agt_browser_tool",
      projectId: "proj_browser_tool",
    });
    const bc = tool(tools, "browser_control");

    // No explicit sessionId → targets tab-live-1 (the tab the user views).
    const nav = await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/shared" });
    expect(nav.ok).toBe(true);
    expect(nav.output).not.toContain("no embedded browser tab is open");

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
    expect(relay.session.record).toHaveBeenCalled();
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
  it("get_state lists every open tab and which one the user views", async () => {
    const tools = await buildTools(tempDir);
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/a", sessionId: "tab-alpha" });
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/b", sessionId: "tab-beta" });
    const state = JSON.parse((await bc.execute({ action: "get_state", sessionId: "tab-alpha" })).output) as {
      activeTab: string | null;
      tabs: Array<{ sessionId: string; currentUrl: string | null }>;
    };
    expect(state.tabs.map((t) => t.sessionId).sort()).toEqual(["tab-alpha", "tab-beta"]);
    // LRU: beta navigated LAST → it is the tab the user is viewing.
    expect(state.activeTab).toBe("tab-beta");
    expect(state.tabs.find((t) => t.sessionId === "tab-alpha")?.currentUrl).toBe("https://en.wikipedia.org/a");
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
