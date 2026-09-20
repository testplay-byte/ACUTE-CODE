/**
 * ROUND-98 (R98-G1) — the browser screenshot chain's honest gates.
 *
 * The owner: "it was currently unable to take screenshots of the web
 * browser." Four pins, one per dishonest gate the round removed:
 *   (a) the DECOUPLING — Computer Use DISABLED (and nothing armed the
 *       relay) yet the screenshot still reaches the standalone capture
 *       backend with exactly the region screenshot_meta answered;
 *   (b) the VISION-GATE SPLIT — a no-vision session still CAPTURES (the
 *       chat thumbnail frame included); only the describe leg is refused
 *       honestly (and a live vision path keeps the describe leg running);
 *   (c) the DEGENERATE-REGION refusal — a 1×1 (clamped-style) or sliver
 *       region NEVER reaches the backend; the honest not-visible error
 *       names the cause;
 *   (d) the HIDDEN-WEBVIEW refusals — the panel's explicit not-visible
 *       ERROR (keep-alive hidden / Home view / overlay) and the bridge's
 *       no-mounted-panel answer (web dev mode — the proxy cannot see
 *       pixels) surface VERBATIM; no capture.
 *
 * Harness idioms mirror browser-tool.test.ts (the REAL tool via
 * buildProjectTools, the REAL browser-command bridge resolved with
 * queueMicrotask, per-test fresh DBs). The capture engine is faked at the
 * FACTORY (getCaptureBackend) — the decoupled seam this round created.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProjectTools } from "../src/tools/index";
// The read/wall-probe fallback path calls webFetch — network-free tests mock
// the fetcher (browser-tool.test.ts's idiom; navigate's probe never needs it
// because the emit fake below answers the bridge probe).
import * as webModule from "../src/tools/web.js";
vi.mock("../src/tools/web.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/web.js")>();
  return { ...actual, webFetch: vi.fn() };
});
const webFetchMock = vi.mocked(webModule.webFetch);
import { resolveBrowserCommand } from "../src/browser-command.js";
import { getActiveComputerRelay, resetActiveComputerRelayForTest } from "../src/tools/plugins/computer-relay.js";
import { resetBrowserStoreForTest } from "../src/browser-proxy";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { getComputerUseSettings, setComputerUseSettings } from "../src/storage/computer-use.js";
import { setVisionSettings } from "../src/storage/vision.js";
import type { ToolSet } from "ai";

// ── ROUND-98 (R98-G1): the DECOUPLED capture-engine fake ────────────────────
// The tool calls getCaptureBackend() directly (no relay, no settings gate);
// the factory is the seam this round created, so that is what these tests
// fake: a healthy region capture echoing the region, a recording
// captureDisplay that must stay unreachable, and a switchable backend error.
const captureState = vi.hoisted(() => ({
  regions: [] as Array<{ x: number; y: number; w: number; h: number }>,
  displayCaptures: [] as number[],
  failWith: null as string | null,
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
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
    }),
  };
});

// The AI SDK tool contract — narrow to what the tests call.
type Tool = { execute: (input: Record<string, unknown>) => Promise<{ ok: boolean; output: string }> };
function tool(set: ToolSet, name: string): Tool {
  return (set as unknown as Record<string, Tool>)[name];
}

let tempDir = "";
let db: SqliteDatabase;

/**
 * The emit channel that answers the bridge: every browser-command resolves
 * on the microtask queue — `screenshot_meta` with the SCRIPTED reply (the
 * panel's region answer, or its explicit refusal), everything else (the
 * navigate wall-probe eval) with a clean page so navigate never pends.
 */
function makeScreenshotEmit(
  frames: unknown[],
  metaReply: { ok: boolean; data?: unknown; error?: string },
): (event: unknown) => void {
  return (event: unknown) => {
    frames.push(event);
    const frame = event as { type?: string; commandId?: string; action?: string };
    if (frame.type === "browser-command" && typeof frame.commandId === "string") {
      // R98-G1: capture the narrowed id before the closure (TS can't carry
      // the typeof narrowing into the async callback).
      const commandId = frame.commandId;
      queueMicrotask(() => {
        if (frame.action === "screenshot_meta") {
          resolveBrowserCommand(commandId, metaReply);
          return;
        }
        resolveBrowserCommand(commandId, {
          ok: true,
          data: { ok: true, value: { title: "Clean page", text: "", markers: [] } },
        });
      });
    }
  };
}

async function buildTools(root: string, deps?: { emit?: (event: unknown) => void }) {
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  return buildProjectTools(root, undefined, {
    db,
    sessionId: "sess_r98_shot",
    agentId: "agt_r98_shot",
    projectId: "proj_r98_shot",
    ...deps,
  });
}

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r98-shot-"));
  resetBrowserStoreForTest();
  resetActiveComputerRelayForTest();
  webFetchMock.mockReset();
  captureState.regions.length = 0;
  captureState.displayCaptures.length = 0;
  captureState.failWith = null;
});

afterEach(() => {
  resetActiveComputerRelayForTest();
  if (db !== undefined) db.close();
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* Windows handle lag — best effort */
  }
});

describe("R98-G1 (a): the decoupling — Computer Use OFF must not gate browser screenshots", () => {
  it("Computer Use DISABLED + no relay armed → the screenshot still reaches the standalone backend with the UI's region", async () => {
    // The old bug: the relay is armed only inside the computer-use plugin's
    // createTools (enabled gate, DEFAULT OFF) — the browser screenshot
    // borrowed it and died behind "needs Computer Use enabled". Now the
    // capture goes through getCaptureBackend() directly.
    const frames: unknown[] = [];
    const tools = await buildTools(tempDir, {
      emit: makeScreenshotEmit(frames, {
        ok: true,
        data: { supported: true, region: { x: 40, y: 80, w: 640, h: 480 }, scaleFactor: 1, mode: "native" },
      }),
    });
    // Computer Use EXPLICITLY disabled on this session's DB (buildTools
    // just created it) — the honest state of the world this test pins.
    setComputerUseSettings(db, { enabled: false });
    expect(getComputerUseSettings(db).enabled).toBe(false);
    // ...and NOTHING armed the relay (no computer-use turn ever ran).
    expect(getActiveComputerRelay()).toBeNull();
    // A live vision path so the success output carries the full capture +
    // describe shape (the describe leg's honest no-key failure — the
    // keyring has no entry for the vision provider).
    setVisionSettings(db, { mode: "separate", provider: "prov-r98", modelId: "vision-x" });

    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/r98-a", sessionId: "tool-tab-r98-a" });
    const result = await bc.execute({ action: "screenshot", sessionId: "tool-tab-r98-a" });

    // The capture HAPPENED — through the decoupled engine, with EXACTLY the
    // region screenshot_meta answered, never a full-display fallback.
    expect(result.ok).toBe(true);
    expect(result.output).toContain("panel region 640×480");
    expect(captureState.regions).toEqual([{ x: 40, y: 80, w: 640, h: 480 }]);
    expect(captureState.displayCaptures).toEqual([]);
    // The chat THUMBNAIL frame rides the capture (R67-D) — also decoupled.
    const shot = frames.find((f) => (f as { type?: string }).type === "screenshot") as
      | { tool?: string; note?: string }
      | undefined;
    expect(shot).toBeDefined();
    expect(shot?.tool).toBe("browser_control");
    expect(shot?.note).toBe("browser panel");
  });

  it("an ARMED relay changes nothing — the tool still captures through the standalone engine (the relay is not consulted)", async () => {
    // The mirror pin: even when a computer-use turn DID arm the relay, the
    // browser screenshot must not depend on it (the relay's backend and the
    // standalone engine are the SAME platform backend in production; here
    // the fake proves the tool never reads the registry).
    const { setActiveComputerRelay } = await import("../src/tools/plugins/computer-relay.js");
    const neverBackend = {
      captureRegion: async () => {
        throw new Error("the relay backend must never be consulted by browser screenshots");
      },
    };
    setActiveComputerRelay({ backend: neverBackend, run: vi.fn(), session: { record: vi.fn() } } as never);
    const frames: unknown[] = [];
    const tools = await buildTools(tempDir, {
      emit: makeScreenshotEmit(frames, {
        ok: true,
        data: { supported: true, region: { x: 0, y: 0, w: 300, h: 200 }, scaleFactor: 1, mode: "native" },
      }),
    });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/r98-a2", sessionId: "tool-tab-r98-a2" });
    const result = await bc.execute({ action: "screenshot", sessionId: "tool-tab-r98-a2" });
    expect(result.ok).toBe(true);
    expect(captureState.regions).toEqual([{ x: 0, y: 0, w: 300, h: 200 }]);
  });
});

describe("R98-G1 (b): the vision-gate SPLIT — capture ungated, describe gated", () => {
  it("a NO-VISION session still captures (+ the thumbnail frame) — only the describe leg is refused honestly", async () => {
    // Vision explicitly OFF (the fresh-db default, stated) — the pre-R98
    // gate refused the WHOLE action before any capture work; the split
    // keeps the capture (the owner sees it in the chat thumbnail) and
    // refuses only the description.
    const frames: unknown[] = [];
    const tools = await buildTools(tempDir, {
      emit: makeScreenshotEmit(frames, {
        ok: true,
        data: { supported: true, region: { x: 10, y: 20, w: 800, h: 600 }, scaleFactor: 1, mode: "native" },
      }),
    });
    // R114-b: "off" is retired from the type — the stored legacy value
    // coerces to "main" at READ time (an old client's PUT likewise
    // coerces at the write boundary), and this session's main model is
    // unmarked, so the no-vision gate still refuses the describe leg.
    setVisionSettings(db, { mode: "off" as never });

    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/r98-b", sessionId: "tool-tab-r98-b" });
    const result = await bc.execute({ action: "screenshot", sessionId: "tool-tab-r98-b" });

    // The CAPTURE happened and the tool SUCCEEDED with the honest note.
    expect(result.ok).toBe(true);
    expect(result.output).toContain("panel region 800×600");
    expect(captureState.regions).toEqual([{ x: 10, y: 20, w: 800, h: 600 }]);
    // The SSE `screenshot` frame is NOT vision-gated — the thumbnail rides.
    expect(frames.some((f) => (f as { type?: string }).type === "screenshot")).toBe(true);
    // The DESCRIBE leg's honest refusal: the canonical no-vision message,
    // phrased for the split world (captured, shown, NOT described) and
    // steering to the text actions that work everywhere.
    expect(result.output).toContain("NOT described");
    expect(result.output).toContain("no image understanding");
    expect(result.output).toContain("read");
  });

  it("a LIVE vision path keeps the describe leg running (its own honest failure — not the no-vision refusal)", async () => {
    // The contrast leg: the gate split must not have KILLED the describe
    // path. A configured separate vision model with NO keyring entry → the
    // relay runs and fails honestly at describe time — a different message
    // than the no-vision refusal.
    const frames: unknown[] = [];
    const tools = await buildTools(tempDir, {
      emit: makeScreenshotEmit(frames, {
        ok: true,
        data: { supported: true, region: { x: 0, y: 0, w: 500, h: 400 }, scaleFactor: 1, mode: "native" },
      }),
    });
    setVisionSettings(db, { mode: "separate", provider: "prov-r98-b2", modelId: "vision-x" });

    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/r98-b2", sessionId: "tool-tab-r98-b2" });
    const result = await bc.execute({ action: "screenshot", sessionId: "tool-tab-r98-b2" });

    expect(result.ok).toBe(true);
    expect(captureState.regions).toEqual([{ x: 0, y: 0, w: 500, h: 400 }]);
    // The describe leg RAN (and failed at the credential, not at the gate).
    expect(result.output).toContain("vision description is unavailable");
    expect(result.output).not.toContain("NOT described");
  });
});

describe("R98-G1 (c): the degenerate-region refusal — never a 1×1 capture", () => {
  it("a 1×1 region (the old Math.max clamp's output) → the honest not-visible error, captureRegion NEVER called", async () => {
    const frames: unknown[] = [];
    const tools = await buildTools(tempDir, {
      emit: makeScreenshotEmit(frames, {
        ok: true,
        data: { supported: true, region: { x: 100, y: 200, w: 1, h: 1 }, scaleFactor: 1, mode: "native" },
      }),
    });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/r98-c", sessionId: "tool-tab-r98-c" });
    const result = await bc.execute({ action: "screenshot", sessionId: "tool-tab-r98-c" });

    expect(result.ok).toBe(false);
    // The honest error names the cause and the measured rect...
    expect(result.output).toContain("not visible");
    expect(result.output).toContain("1×1");
    // ...keeps the R87 no-fallback promise...
    expect(result.output).toContain("NEVER falls back to a full-screen shot");
    // ...and steers to the text actions.
    expect(result.output).toContain("read");
    // NEVER captured — not one pixel, not the full display.
    expect(captureState.regions).toEqual([]);
    expect(captureState.displayCaptures).toEqual([]);
  });

  it("a sub-floor sliver (30×600 — one axis below the floor) → the same refusal, never captured", async () => {
    const frames: unknown[] = [];
    const tools = await buildTools(tempDir, {
      emit: makeScreenshotEmit(frames, {
        ok: true,
        data: { supported: true, region: { x: 0, y: 0, w: 30, h: 600 }, scaleFactor: 1, mode: "native" },
      }),
    });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/r98-c2", sessionId: "tool-tab-r98-c2" });
    const result = await bc.execute({ action: "screenshot", sessionId: "tool-tab-r98-c2" });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("not visible");
    expect(result.output).toContain("30×600");
    expect(captureState.regions).toEqual([]);
    expect(captureState.displayCaptures).toEqual([]);
  });
});

describe("R98-G1 (d): the hidden-webview refusals — the panel's error surfaces verbatim", () => {
  it("a keep-alive-hidden tab: the panel's explicit not-visible ERROR is surfaced verbatim; no capture", async () => {
    // The BrowserPanel's R98-G1 screenshot_meta handler answers an explicit
    // error naming the cause instead of the old clamped 1×1 region. The tool
    // must surface that message (the model can act on "switch the sidebar"),
    // not swallow it into a generic no-region guess.
    const frames: unknown[] = [];
    const tools = await buildTools(tempDir, {
      emit: makeScreenshotEmit(frames, {
        ok: false,
        error:
          "screenshot_meta: the browser tab is not visible — this tab is mounted in the background (keep-alive hidden). " +
          "Switch the right sidebar to the Browser panel first (and off the Home view), then retry the screenshot.",
      }),
    });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/r98-d", sessionId: "tool-tab-r98-d" });
    const result = await bc.execute({ action: "screenshot", sessionId: "tool-tab-r98-d" });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("keep-alive hidden");
    expect(result.output).toContain("Switch the right sidebar to the Browser panel");
    expect(result.output).toContain("no panel region to capture");
    expect(result.output).toContain("NEVER falls back to a full-screen shot");
    expect(captureState.regions).toEqual([]);
    expect(captureState.displayCaptures).toEqual([]);
  });

  it("web dev mode (the iframe proxy leg): the bridge's no-mounted-panel answer surfaces verbatim — the proxy cannot see pixels, so the tool refuses honestly", async () => {
    // In web dev mode no BrowserPanel command handler exists; the frontend
    // bridge answers immediately with its honest no-panel error (no 5s
    // timeout burn). The tool surfaces it and never captures — a GDI region
    // capture of the dev browser would be a lie, not the page.
    const frames: unknown[] = [];
    const tools = await buildTools(tempDir, {
      emit: makeScreenshotEmit(frames, {
        ok: false,
        error:
          "no embedded browser panel is mounted for tab 'tool-tab-r98-web' (the tab is closed, inactive, or running outside the desktop app)",
      }),
    });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/r98-web", sessionId: "tool-tab-r98-web" });
    const result = await bc.execute({ action: "screenshot", sessionId: "tool-tab-r98-web" });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("no embedded browser panel is mounted");
    expect(result.output).toContain("running outside the desktop app");
    expect(result.output).toContain("read");
    expect(captureState.regions).toEqual([]);
    expect(captureState.displayCaptures).toEqual([]);
  });
});
