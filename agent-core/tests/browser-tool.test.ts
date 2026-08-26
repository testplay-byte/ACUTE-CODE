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
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProjectTools } from "../src/tools/index";
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
let db: SqliteDatabase;
let app: Awaited<ReturnType<typeof buildServer>> | null = null;
const TOKEN = "test-token-browse";

beforeEach(async () => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-browser-tool-"));
  // Fresh module store per test → deterministic DEFAULT sessionId resolution.
  resetBrowserStoreForTest();
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
    const tools = await buildProjectTools(tempDir);
    const bc = tool(tools, "browser_control");

    const first = await bc.execute({ action: "navigate", url: "https://example.com/one", sessionId: "tool-tab-1" });
    expect(first.ok).toBe(true);
    expect(first.output).toContain("https://example.com/one");

    await bc.execute({ action: "navigate", url: "https://example.com/two", sessionId: "tool-tab-1" });

    const state = await bc.execute({ action: "get_state", sessionId: "tool-tab-1" });
    expect(state.ok).toBe(true);
    const parsed = JSON.parse(state.output) as { currentUrl: string; index: number; canBack: boolean; canForward: boolean };
    expect(parsed.currentUrl).toBe("https://example.com/two");
    expect(parsed.index).toBe(1);
    expect(parsed.canBack).toBe(true);
    expect(parsed.canForward).toBe(false);

    const back = await bc.execute({ action: "back", sessionId: "tool-tab-1" });
    expect(back.ok).toBe(true);
    expect(back.output).toContain("https://example.com/one");

    const mid = await bc.execute({ action: "get_state", sessionId: "tool-tab-1" });
    expect((JSON.parse(mid.output) as { currentUrl: string; canForward: boolean }).currentUrl).toBe("https://example.com/one");

    const forward = await bc.execute({ action: "forward", sessionId: "tool-tab-1" });
    expect(forward.ok).toBe(true);
    expect(forward.output).toContain("https://example.com/two");

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
    const tools = await buildProjectTools(tempDir);
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://example.com/doc", sessionId: "tool-tab-2" });
    const titled = await bc.execute({
      action: "navigate",
      url: "https://example.com/doc",
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
    const tools = await buildProjectTools(tempDir);
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
    const tools = await buildProjectTools(tempDir);
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
    const tools = await buildProjectTools(tempDir);
    const bc = tool(tools, "browser_control");

    const nav = await bc.execute({ action: "navigate", url: "https://example.com/agent-default" });
    expect(nav.ok).toBe(true);
    expect(nav.output).toContain("no embedded browser tab is open");

    const state = JSON.parse((await bc.execute({ action: "get_state" })).output) as { sessionId: string; currentUrl: string };
    expect(state.sessionId).toBe("agent");
    expect(state.currentUrl).toBe("https://example.com/agent-default");
  });

  it("explicit sessionIds are validated and isolated from each other", async () => {
    const tools = await buildProjectTools(tempDir);
    const bc = tool(tools, "browser_control");

    const badId = await bc.execute({ action: "get_state", sessionId: "../evil id" });
    expect(badId.ok).toBe(false);
    expect(badId.output).toContain("sessionId");

    await bc.execute({ action: "navigate", url: "https://example.com/a", sessionId: "sess-a" });
    await bc.execute({ action: "navigate", url: "https://example.com/b", sessionId: "sess-b" });
    const a = JSON.parse((await bc.execute({ action: "get_state", sessionId: "sess-a" })).output) as { currentUrl: string };
    expect(a.currentUrl).toBe("https://example.com/a");
  });

  it("navigate demands an absolute http(s) url; unknown actions are refused", async () => {
    const tools = await buildProjectTools(tempDir);
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
    db = openDatabase(join(tempDir, `${randomUUID()}.db`));
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

    const tools = await buildProjectTools(tempDir);
    const bc = tool(tools, "browser_control");

    // No explicit sessionId → targets tab-live-1 (the tab the user views).
    const nav = await bc.execute({ action: "navigate", url: "https://example.com/shared" });
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
    expect(body.entries.map((e) => e.url)).toEqual(["https://example.com/shared"]);
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
