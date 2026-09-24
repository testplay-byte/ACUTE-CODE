/**
 * ROUND-124 (R124) — the browser screenshot's FIXED-RESOLUTION + CAPTURE-
 * WHILE-HIDDEN laws, pinned from the SIDECAR side.
 *
 * THE OWNER'S VERDICT (the feedback ledger's browser-screenshot round):
 *   1. "if I have the application closed, then it cannot take screenshots
 *      of the inbuilt browser" → the capture must work with the browser VIEW
 *      not visible/attached;
 *   2. "if the browser window is way too small, then the resolution of the
 *      screenshot is way too less… should be taken in a higher resolution…
 *      not based on the actual device's resolution, but… on some other
 *      factors" → a FIXED logical capture resolution (1280×720), threaded
 *      from HERE through the screenshot_capture command payload;
 *   3. "this should also happen if the user is in some other application,
 *      is in the settings of the program or something else" → the frontend's
 *      module-level fallback answers with no panel mounted (pinned on the
 *      app side; this suite pins the SIDE of the contract the sidecar owns).
 *
 * TWO surfaces under test (the frontend twins live in
 * src/lib/agent-browser-capture.test.ts + BrowserPanel.test.tsx):
 *   · the TOOL (browser_control screenshot): the STAGED capture is tried
 *     FIRST — the `screenshot_capture` browser command carrying
 *     BROWSER_CAPTURE_WIDTH/HEIGHT — and a capture-contract reply wins
 *     WITHOUT the standalone screen engine ever being consulted (the bytes
 *     came from the app's own staged grab through POST /browser-capture);
 *     honest refusals surface verbatim; BOTH version-skew shapes (an older
 *     app's "unknown browser command" error AND its generic non-contract
 *     reply) fall back to the LEGACY screenshot_meta path verbatim — never
 *     a fabricated raster;
 *   · the ROUTE (POST /api/v1/browser-capture): the app's staged-grab
 *     engine door — region validation (the 50px floor / the 8K ceiling /
 *     finite numbers), the backend passthrough (rounded physical px), and
 *     the honest 500 CAPTURE_FAILED — bearer-authed like every /browser
 *     route.
 *
 * Harness idioms mirror r98-browser-screenshot.test.ts (the REAL tool via
 * buildProjectTools, the REAL browser-command bridge resolved on
 * queueMicrotask, per-test fresh DBs) and browser-proxy.test.ts (buildServer
 * + app.inject). The capture engine is faked at the FACTORY
 * (getCaptureBackend) — the same seam R98-G1 created.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProjectTools } from "../src/tools/index";
import { BROWSER_CAPTURE_HEIGHT, BROWSER_CAPTURE_WIDTH } from "../src/tools/plugins/browser";
// The read/wall-probe fallback path calls webFetch — network-free tests mock
// the fetcher (r98-browser-screenshot.test.ts's idiom).
import * as webModule from "../src/tools/web.js";
vi.mock("../src/tools/web.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/web.js")>();
  return { ...actual, webFetch: vi.fn() };
});
const webFetchMock = vi.mocked(webModule.webFetch);
import { resolveBrowserCommand } from "../src/browser-command.js";
import { resetActiveComputerRelayForTest } from "../src/tools/plugins/computer-relay.js";
import { resetBrowserStoreForTest } from "../src/browser-proxy";
import { ProviderKeyring } from "../src/providers/registry";
import { buildServer } from "../src/server";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { ToolSet } from "ai";

// ── the DECOUPLED capture-engine fake (R98-G1's seam, reused) ───────────────
// captureRegion records every region the STANDALONE engine is asked to grab
// (the legacy path's only source of bytes); the staged path must leave it
// EMPTY — the app's own POST /browser-capture produced the bytes instead.
const captureState = vi.hoisted(() => ({
  regions: [] as Array<{ x: number; y: number; w: number; h: number }>,
  failWith: null as string | null,
  malformed: false,
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
          if (captureState.malformed) return { width: 10, height: 10 };
          return {
            pngBase64: "aW1n".repeat(40),
            width: region.w,
            height: region.h,
            scale: 1,
            origin: { x: region.x, y: region.y },
          };
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
let db: SqliteDatabase | undefined;

/**
 * The emit channel that answers the bridge on the microtask queue —
 * `screenshot_capture` with the SCRIPTED reply (the new app's staged capture
 * answer), `screenshot_meta` with the SCRIPTED reply (the legacy region
 * answer), everything else (the navigate wall-probe eval) with a clean page
 * so navigate never pends.
 */
function makeR124Emit(
  frames: unknown[],
  script: {
    screenshot_capture?: { ok: boolean; data?: unknown; error?: string };
    screenshot_meta?: { ok: boolean; data?: unknown; error?: string };
  },
): (event: unknown) => void {
  return (event: unknown) => {
    frames.push(event);
    const frame = event as { type?: string; commandId?: string; action?: string };
    if (frame.type === "browser-command" && typeof frame.commandId === "string") {
      // R98-G1: capture the narrowed id before the closure (TS can't carry
      // the typeof narrowing into the async callback).
      const commandId = frame.commandId;
      queueMicrotask(() => {
        if (frame.action === "screenshot_capture" && script.screenshot_capture !== undefined) {
          resolveBrowserCommand(commandId, script.screenshot_capture);
          return;
        }
        if (frame.action === "screenshot_meta" && script.screenshot_meta !== undefined) {
          resolveBrowserCommand(commandId, script.screenshot_meta);
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
    sessionId: "sess_r124_shot",
    agentId: "agt_r124_shot",
    projectId: "proj_r124_shot",
    ...deps,
  });
}

beforeEach(() => {
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "acute-r124-shot-"));
  resetBrowserStoreForTest();
  resetActiveComputerRelayForTest();
  webFetchMock.mockReset();
  captureState.regions.length = 0;
  captureState.failWith = null;
  captureState.malformed = false;
});

afterEach(() => {
  resetActiveComputerRelayForTest();
  if (db !== undefined) {
    db.close();
    db = undefined;
  }
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* Windows handle lag — best effort */
  }
});

// ── the TOOL: the staged screenshot_capture command ────────────────────────

describe("R124: browser_control screenshot — the staged capture (the tool side)", () => {
  it("the fixed capture resolution is ONE documented pair: BROWSER_CAPTURE_WIDTH/HEIGHT = 1280×720 logical px", () => {
    // The LOCKSTEP pin's sidecar half: the frontend twin
    // (src/lib/agent-browser-capture.ts) carries the SAME numbers as its
    // fallback defaults, and its suite pins them independently — together
    // the two pins guard the cross-side contract the payload threads.
    expect(BROWSER_CAPTURE_WIDTH).toBe(1280);
    expect(BROWSER_CAPTURE_HEIGHT).toBe(720);
  });

  it("the staged capture is tried FIRST with the fixed resolution threaded through — a capture-contract reply wins, the standalone engine is never consulted", async () => {
    const frames: unknown[] = [];
    const tools = await buildTools(tempDir, {
      emit: makeR124Emit(frames, {
        screenshot_capture: {
          ok: true,
          data: {
            pngBase64: "aW1n".repeat(40),
            width: 2560,
            height: 1440,
            logicalWidth: 1280,
            logicalHeight: 720,
            clamped: false,
          },
        },
      }),
    });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/r124-a", sessionId: "tool-tab-r124-a" });
    const result = await bc.execute({ action: "screenshot", sessionId: "tool-tab-r124-a" });

    // THE SUCCESS: the honest geometry note names the STAGED logical size
    // and the raster size — never the old "panel region" phrasing.
    expect(result.ok).toBe(true);
    expect(result.output).toContain("staged 1280×720 logical px, 2560×1440px raster");
    expect(result.output).not.toContain("panel region");
    // No vision path is configured → the R98-G1 split rides the staged path
    // too: the capture is real (and thumbnailed), only the describe refuses.
    expect(result.output).toContain("NOT described");

    // THE COMMAND: exactly ONE screenshot_capture frame carrying the fixed
    // resolution constants — and NO legacy screenshot_meta frame (the staged
    // path answered; the legacy leg never ran).
    const captureFrames = frames.filter(
      (f) => (f as { type?: string; action?: string }).type === "browser-command" &&
        (f as { action?: string }).action === "screenshot_capture",
    );
    expect(captureFrames).toHaveLength(1);
    expect((captureFrames[0] as { payload?: unknown }).payload).toEqual({
      width: BROWSER_CAPTURE_WIDTH,
      height: BROWSER_CAPTURE_HEIGHT,
    });
    expect(
      frames.some(
        (f) => (f as { type?: string; action?: string }).type === "browser-command" &&
          (f as { action?: string }).action === "screenshot_meta",
      ),
    ).toBe(false);

    // THE ENGINE SPLIT: the standalone screen engine (the legacy path's only
    // source of bytes) was NEVER asked for a region — the bytes came from
    // the app's own staged grab (its POST /browser-capture round trip).
    expect(captureState.regions).toEqual([]);

    // The chat THUMBNAIL frame still rides (R67-D) — staged bytes, same law.
    const shot = frames.find((f) => (f as { type?: string }).type === "screenshot") as
      | { tool?: string; note?: string }
      | undefined;
    expect(shot).toBeDefined();
    expect(shot?.tool).toBe("browser_control");
  });

  it("a CLAMPED staged reply reports the clamp honestly (never padded, never fabricated)", async () => {
    const frames: unknown[] = [];
    const tools = await buildTools(tempDir, {
      emit: makeR124Emit(frames, {
        screenshot_capture: {
          ok: true,
          data: {
            pngBase64: "aW1n".repeat(40),
            width: 1800,
            height: 1000,
            // A small app window: the staged geometry was clamped to the
            // client area (the frontend's clamp-to-window law).
            logicalWidth: 900,
            logicalHeight: 500,
            clamped: true,
          },
        },
      }),
    });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/r124-clamp", sessionId: "tool-tab-r124-clamp" });
    const result = await bc.execute({ action: "screenshot", sessionId: "tool-tab-r124-clamp" });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("staged 900×500 logical px, 1800×1000px raster (clamped to the app window)");
    expect(captureState.regions).toEqual([]);
  });

  it("the NEW app's honest refusal surfaces verbatim — no legacy fallback, no capture", async () => {
    // The owner may have minimized the window (or closed the tab, or shrunk
    // the client area below the floor): the frontend's staged capture
    // refuses honestly and the refusal arrives as a command ERROR. The tool
    // must surface the named cause — never silently retry the legacy path
    // (that would answer the OLD "switch the sidebar" refusal for a defect
    // the staged path already names better).
    const frames: unknown[] = [];
    const tools = await buildTools(tempDir, {
      emit: makeR124Emit(frames, {
        screenshot_capture: {
          ok: false,
          error:
            "screenshot_capture: the app window is minimized — restore it (keep it in the background un-minimized) and retry; " +
            "a minimized window paints nothing on screen to capture",
        },
      }),
    });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/r124-min", sessionId: "tool-tab-r124-min" });
    const result = await bc.execute({ action: "screenshot", sessionId: "tool-tab-r124-min" });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("browser_control: screenshot — screenshot_capture: the app window is minimized");
    expect(result.output).toContain("NEVER falls back to a full-screen shot");
    expect(result.output).toContain("read");
    // The legacy leg never ran; the standalone engine never captured.
    expect(
      frames.some(
        (f) => (f as { type?: string; action?: string }).type === "browser-command" &&
          (f as { action?: string }).action === "screenshot_meta",
      ),
    ).toBe(false);
    expect(captureState.regions).toEqual([]);
  });

  it("version skew, leg 1 — an OLDER app's \"unknown browser command\" error falls back to the LEGACY path verbatim", async () => {
    // An app predating R124 has never heard of screenshot_capture and its
    // bridge answers with the unknown-command error. The tool must fall
    // back to the R62/R98-G1 screenshot_meta path — the R98 pins still
    // guard it — and the STAGED command must still have been tried FIRST.
    const frames: unknown[] = [];
    const tools = await buildTools(tempDir, {
      emit: makeR124Emit(frames, {
        screenshot_capture: { ok: false, error: "unknown browser command 'screenshot_capture'" },
        screenshot_meta: {
          ok: true,
          data: { supported: true, region: { x: 40, y: 80, w: 640, h: 480 }, scaleFactor: 1, mode: "native" },
        },
      }),
    });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/r124-old", sessionId: "tool-tab-r124-old" });
    const result = await bc.execute({ action: "screenshot", sessionId: "tool-tab-r124-old" });

    // The legacy capture happened — exactly the region screenshot_meta
    // answered, phrased as the panel region (the old world, verbatim).
    expect(result.ok).toBe(true);
    expect(result.output).toContain("panel region 640×480");
    expect(captureState.regions).toEqual([{ x: 40, y: 80, w: 640, h: 480 }]);
    // The staged command was tried FIRST (order pin: capture before meta).
    const order = frames
      .filter(
        (f) =>
          (f as { type?: string }).type === "browser-command" &&
          ["screenshot_capture", "screenshot_meta"].includes((f as { action?: string }).action ?? ""),
      )
      .map((f) => (f as { action?: string }).action);
    expect(order).toEqual(["screenshot_capture", "screenshot_meta"]);
  });

  it("version skew, leg 2 — a generic non-contract reply is never mistaken for a raster (the legacy path answers)", async () => {
    // The skew's silent shape: an older app resolves the command with SOME
    // ok:true data (its generic envelope) that is not the capture contract.
    // The tool must not fabricate a raster from it — raster stays null and
    // the legacy screenshot_meta path takes over.
    const frames: unknown[] = [];
    const tools = await buildTools(tempDir, {
      emit: makeR124Emit(frames, {
        screenshot_capture: { ok: true, data: { ok: true, value: { title: "Clean page" } } },
        screenshot_meta: {
          ok: true,
          data: { supported: true, region: { x: 0, y: 0, w: 300, h: 200 }, scaleFactor: 1, mode: "native" },
        },
      }),
    });
    const bc = tool(tools, "browser_control");
    await bc.execute({ action: "navigate", url: "https://en.wikipedia.org/r124-skew2", sessionId: "tool-tab-r124-skew2" });
    const result = await bc.execute({ action: "screenshot", sessionId: "tool-tab-r124-skew2" });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("panel region 300×200");
    expect(captureState.regions).toEqual([{ x: 0, y: 0, w: 300, h: 200 }]);
  });
});

// ── the ROUTE: POST /api/v1/browser-capture ────────────────────────────────

describe("R124: POST /browser-capture — the staged grab's engine door", () => {
  const TOKEN = "test-token-r124-capture";
  let app: FastifyInstance;

  beforeEach(() => {
    db = openDatabase(join(tempDir, `${randomUUID()}.db`));
    app = buildServer({
      token: TOKEN,
      db,
      keyring: new ProviderKeyring({ ACUTE_PROVIDER_OPENROUTER: "sk-or-vtest" }),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  async function inject(
    payload: unknown,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> {
    return (await app.inject({
      method: "POST",
      url: "/api/v1/browser-capture",
      ...(payload === undefined ? {} : { payload: payload as object }),
      headers: { authorization: `Bearer ${TOKEN}`, ...headers },
    })) as LightMyRequestResponse;
  }

  it("a valid region → 200 with the backend's PNG + geometry, the region ROUNDED to whole physical px", async () => {
    const res = await inject({ x: 10.4, y: 20.6, w: 1280, h: 720 });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { pngBase64: string; width: number; height: number };
    expect(body.pngBase64).toBe("aW1n".repeat(40));
    expect(body.width).toBe(1280);
    expect(body.height).toBe(720);
    // The engine saw the ROUNDED region (Math.round on every axis — a
    // fractional window origin / scale-factor product must never hand the
    // GDI/scrot backend a sub-pixel rect).
    expect(captureState.regions).toEqual([{ x: 10, y: 21, w: 1280, h: 720 }]);
  });

  it("a degenerate region (below the 50px floor — REGION_MIN_PX's twin) → 400 VALIDATION, the backend never called", async () => {
    const res = await inject({ x: 0, y: 0, w: 49, h: 720 });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.message).toContain("50px floor");
    expect(captureState.regions).toEqual([]);
  });

  it("an over-ceiling region (past the 7680×4320 band) → 400 VALIDATION — a stray number must never allocate a gigabyte bitmap", async () => {
    const res = await inject({ x: 0, y: 0, w: 8000, h: 720 });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION");
    expect(captureState.regions).toEqual([]);
  });

  it("non-numeric / missing fields → 400 VALIDATION (a malformed body is refused, never guessed)", async () => {
    const bad = await inject({ x: null, y: 0, w: 100, h: 100 });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { error: { code: string } }).error.code).toBe("VALIDATION");
    const missing = await inject({ y: 0, w: 100, h: 100 });
    expect(missing.statusCode).toBe(400);
    expect(captureState.regions).toEqual([]);
  });

  it("a backend error → 500 CAPTURE_FAILED with the engine's cause verbatim", async () => {
    captureState.failWith = "no scrot, no import";
    const res = await inject({ x: 0, y: 0, w: 1280, h: 720 });
    expect(res.statusCode).toBe(500);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("CAPTURE_FAILED");
    expect(body.error.message).toContain("no scrot, no import");
  });

  it("a malformed raster (the backend produced no PNG) → 500 CAPTURE_FAILED — never an empty success", async () => {
    captureState.malformed = true;
    const res = await inject({ x: 0, y: 0, w: 1280, h: 720 });
    expect(res.statusCode).toBe(500);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("CAPTURE_FAILED");
    expect(body.error.message).toContain("produced no image");
  });

  it("bearer-authed like every /browser route — no token → 401", async () => {
    const res = (await app.inject({
      method: "POST",
      url: "/api/v1/browser-capture",
      payload: { x: 0, y: 0, w: 1280, h: 720 },
    })) as LightMyRequestResponse;
    expect(res.statusCode).toBe(401);
    expect(captureState.regions).toEqual([]);
  });
});
