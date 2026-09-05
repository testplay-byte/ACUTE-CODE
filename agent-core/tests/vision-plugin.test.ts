/**
 * ROUND-66 (R66-2-b): the core-vision plugin — the owner's B5 directive:
 * "without using the computer use skill, the agent can just generally use
 * [image analysis]". analyze_image takes a local path or an http(s) URL,
 * reads the bytes (≤8MB, image extensions for paths), and relays through
 * the GLOBAL vision settings (vision.mode/provider/modelId — Settings →
 * Image Analysis), exactly like the computer-use/browser screenshot relay.
 *
 * Honesty under test:
 *   · fail-closed without toolDeps/db (bare builds + the declaration
 *     catalog); registered with a db — REGARDLESS of computer-use's master
 *     switch and regardless of vision mode (the OFF refusal IS the switch).
 *   · vision OFF → the honest refusal pointing at Settings → Image Analysis.
 *   · separate configured → the relay's description rides the output
 *     (fetch stubbed: the image download AND the provider POST).
 *   · missing file / wrong extension / oversized file / bad URL / both
 *     path+url → honest ok:false outputs, NEVER a throw.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { ProviderKeyring } from "../src/providers/registry";
import { visionPlugin } from "../src/tools/plugins/vision";
import { setVisionSettings } from "../src/storage/vision";
import type { ToolDeps } from "../src/tools/index";

let db: SqliteDatabase;
let tempDir: string;

// A valid 1×1 transparent PNG (the same constant POST /vision/test uses).
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function makeDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    db,
    sessionId: "sess",
    agentId: "agt",
    keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER_VISION: "sk-vision" }),
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "acute-vision-plugin-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
});

afterEach(() => {
  vi.unstubAllGlobals();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

async function buildTools(deps?: Partial<ToolDeps>) {
  const tools = await visionPlugin.createTools({
    root: tempDir,
    toolDeps: makeDeps(deps ?? {}),
  });
  return tools.find((t) => t.name === "analyze_image")!;
}

describe("ROUND-66 (R66-2-b): the core-vision plugin registration", () => {
  it("R66 close-out: bare builds declare nothing, but the DECLARATION context (db:null) still declares — analyze_image is always-registered vocabulary; execute refuses honestly without a db", async () => {
    // No toolDeps at all → nothing (the bare-build convention).
    expect(await visionPlugin.createTools({ root: tempDir })).toHaveLength(0);
    // The catalog's declaration ctx carries db:null — the tool MUST declare
    // (TOOL_NAMES + migration 0026 made it general vocabulary like
    // web_fetch); the missing-db case is an EXECUTE-time honest refusal.
    const declared = await visionPlugin.createTools({
      root: tempDir,
      toolDeps: { ...makeDeps(), db: null as unknown as ToolDeps["db"] },
    });
    expect(declared).toHaveLength(1);
    expect(declared[0].name).toBe("analyze_image");
    const result = await declared[0].execute({ path: "img.png" }, { root: tempDir } as Parameters<typeof declared[0]["execute"]>[1]);
    const parsed = JSON.parse((result as { output: string }).output) as { error: string };
    expect(parsed.error).toContain("no database in this context");
  });

  it("registers analyze_image on a live db — with computer use OFF and vision OFF (no absence gates)", async () => {
    const analyze = await buildTools();
    expect(analyze).toBeDefined();
    expect(analyze.name).toBe("analyze_image");
    // The tool description teaches the honest failure mode.
    expect(analyze.description).toContain("Settings → Image Analysis");
  });

  it("R67-E: the description teaches the chat-attachment path contract (attachments/<name>, rendered path verbatim)", async () => {
    const analyze = await buildTools();
    // The owner's 0.66.0 report: the model guessed C:\... paths for chat
    // image attachments. R67-A made the rendered path real (the upload
    // pipeline); this pin holds the description's half of the teaching.
    expect(analyze.description).toContain("attachments/<name>");
    expect(analyze.description).toContain("EXACTLY as rendered in the user message");
    expect(analyze.description).toContain("saved in the project at <path>");
    expect(analyze.description).toContain("never a guessed one");
  });
});

describe("ROUND-66 (R66-2-b): analyze_image honesty (never throws)", () => {
  it("no path and no url → the honest usage refusal", async () => {
    const analyze = await buildTools();
    const result = await analyze.execute({}, { root: tempDir });
    expect(result.ok).toBe(false);
    const parsed = JSON.parse(result.output) as { error: string };
    expect(parsed.error).toContain("needs exactly one of 'path'");
  });

  it("both path and url → the honest mutual-exclusion refusal", async () => {
    const analyze = await buildTools();
    const result = await analyze.execute(
      { path: "a.png", url: "https://example.com/a.png" },
      { root: tempDir },
    );
    expect(result.ok).toBe(false);
    expect((JSON.parse(result.output) as { error: string }).error).toContain("one, not both");
  });

  it("missing file → the honest read-failure output (no throw)", async () => {
    const analyze = await buildTools();
    const result = await analyze.execute({ path: "ghost.png" }, { root: tempDir });
    expect(result.ok).toBe(false);
    const parsed = JSON.parse(result.output) as { error: string };
    expect(parsed.error).toContain("could not read");
    expect(parsed.error).toContain("ghost.png");
  });

  it("wrong extension → the honest extension refusal", async () => {
    writeFileSync(join(tempDir, "notes.txt"), "not an image");
    const analyze = await buildTools();
    const result = await analyze.execute({ path: "notes.txt" }, { root: tempDir });
    expect(result.ok).toBe(false);
    expect((JSON.parse(result.output) as { error: string }).error).toContain("unsupported extension");
  });

  it("oversized file (>8MB) → the honest size refusal", async () => {
    writeFileSync(join(tempDir, "huge.png"), Buffer.alloc(8 * 1024 * 1024 + 1, 1));
    const analyze = await buildTools();
    const result = await analyze.execute({ path: "huge.png" }, { root: tempDir });
    expect(result.ok).toBe(false);
    expect((JSON.parse(result.output) as { error: string }).error).toContain("over 8MB");
  });

  it("vision OFF (the default) → the honest Settings → Image Analysis refusal", async () => {
    writeFileSync(join(tempDir, "tiny.png"), PNG_BYTES);
    const analyze = await buildTools();
    const result = await analyze.execute({ path: "tiny.png" }, { root: tempDir });
    expect(result.ok).toBe(false);
    const parsed = JSON.parse(result.output) as { error: string };
    expect(parsed.error).toContain("vision is OFF");
    expect(parsed.error).toContain("Settings → Image Analysis");
  });

  it("separate mode but provider/model unconfigured → the honest unconfigured refusal", async () => {
    writeFileSync(join(tempDir, "tiny.png"), PNG_BYTES);
    setVisionSettings(db, { mode: "separate" });
    const analyze = await buildTools();
    const result = await analyze.execute({ path: "tiny.png" }, { root: tempDir });
    expect(result.ok).toBe(false);
    expect((JSON.parse(result.output) as { error: string }).error).toContain("not configured");
  });

  it("bad URL scheme → refused before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const analyze = await buildTools();
    const result = await analyze.execute({ url: "file:///etc/passwd" }, { root: tempDir });
    expect(result.ok).toBe(false);
    expect((JSON.parse(result.output) as { error: string }).error).toContain("http(s) only");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("HTTP failure on the image download → the honest status output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404, statusText: "Not Found" })),
    );
    const analyze = await buildTools();
    const result = await analyze.execute({ url: "https://example.com/ghost.png" }, { root: tempDir });
    expect(result.ok).toBe(false);
    expect((JSON.parse(result.output) as { error: string }).error).toContain("HTTP 404");
  });
});

describe("ROUND-66 (R66-2-b): analyze_image end-to-end through the global settings", () => {
  it("separate mode + local path: the relay's description rides the output", async () => {
    writeFileSync(join(tempDir, "tiny.png"), PNG_BYTES);
    setVisionSettings(db, {
      mode: "separate",
      provider: "openrouter",
      modelId: "google/gemini-2.5-flash",
    });
    // The relay's provider POST (fetch stubbed — no network).
    const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const target = String(url);
        calls.push({
          url: target,
          body: init?.body !== undefined ? JSON.parse(String(init.body)) : null,
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "A tiny transparent pixel." } }] }),
          { status: 200, statusText: "OK" },
        );
      }),
    );
    const analyze = await buildTools();
    const result = await analyze.execute(
      { path: "tiny.png", instruction: "what is this" },
      { root: tempDir },
    );
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output) as {
      source: string;
      description: string;
      model: string;
      mode: string;
    };
    expect(parsed.description).toContain("tiny transparent pixel");
    expect(parsed.model).toBe("google/gemini-2.5-flash");
    expect(parsed.mode).toBe("separate");
    expect(parsed.source).toContain("tiny.png");
    // Exactly one network call (the local file never hit fetch).
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer sk-vision");
    const body = calls[0]!.body as { model: string; messages: Array<{ role: string; content: unknown }> };
    expect(body.model).toBe("google/gemini-2.5-flash");
    const user = body.messages.find((m) => m.role === "user");
    const content = user?.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(content.some((c) => c.type === "text" && c.text === "what is this")).toBe(true);
    expect(
      content.some(
        (c) => c.type === "image_url" && c.image_url?.url === `data:image/png;base64,${PNG_BYTES.toString("base64")}`,
      ),
    ).toBe(true);
  });

  it("separate mode + URL: the image download rides the browser UA, then the relay", async () => {
    setVisionSettings(db, {
      mode: "separate",
      provider: "openrouter",
      modelId: "google/gemini-2.5-flash",
    });
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const target = String(url);
        calls.push({ url: target, headers: (init?.headers ?? {}) as Record<string, string> });
        if (target === "https://example.com/pic.png") {
          return new Response(PNG_BYTES, { status: 200, statusText: "OK" });
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "A downloaded pixel." } }] }),
          { status: 200, statusText: "OK" },
        );
      }),
    );
    const analyze = await buildTools();
    const result = await analyze.execute({ url: "https://example.com/pic.png" }, { root: tempDir });
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output) as { description: string; source: string };
    expect(parsed.description).toContain("downloaded pixel");
    expect(parsed.source).toContain("https://example.com/pic.png");
    // The image download carried the web.ts browser UA.
    expect(calls[0]!.headers["user-agent"]).toContain("Mozilla/5.0");
    // The default instruction rode the relay call.
    expect(calls).toHaveLength(2);
  });
});
