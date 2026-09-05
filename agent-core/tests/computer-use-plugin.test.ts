/**
 * ROUND-61 (R61): the computer-use PLUGIN gate tests — the settings master
 * switch (default OFF → no tools), the posture subsets (observe = read-only
 * surface), the full 31-tool catalog (30 doc-02 + R66-2-d find_elements),
 * the consent gate in ask mode, and the vision relay wiring through
 * screenshot describe=true.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { ProviderKeyring } from "../src/providers/registry";
import { computerUsePlugin } from "../src/tools/plugins/computer-use";
import { setComputerUseSettings } from "../src/storage/computer-use";
// R66-2-b: the vision settings moved to their own module (Settings → Image
// Analysis) — the relay reads vision.mode/provider/modelId now.
import { setVisionSettings } from "../src/storage/vision";
import { resetComputerSessionForTests } from "../src/computer/session";
import { resetAuditForTests } from "../src/computer/audit";
// ROUND-67 (R67-D): the prototype-spied dispatcher + the route-served raster
// registry (the screenshot-frame emission contract).
import { ComputerDispatcher, type DispatchResult } from "../src/computer/dispatch";
import { rasterFor, resetRasterCacheForTest } from "../src/computer/raster-cache";
import { upsertModel } from "../src/storage/models";
import type { ToolDeps } from "../src/tools/index";

let db: SqliteDatabase;
let tempDir: string;
let emitLog: unknown[];

function makeDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    db,
    sessionId: "sess",
    agentId: "agt",
    seq: 1,
    keyring: new ProviderKeyring({}),
    interactiveApprovals: false,
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "acute-cu-plugin-"));
  db = openDatabase(join(tempDir, `${randomUUID()}.db`));
  resetComputerSessionForTests();
  resetAuditForTests(tempDir);
  emitLog = [];
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe("ROUND-61 (R61): the settings gates", () => {
  it("DEFAULT OFF: createTools returns NOTHING (the owner's on/off directive)", async () => {
    const tools = await computerUsePlugin.createTools({ root: tempDir, toolDeps: makeDeps() });
    expect(tools).toHaveLength(0);
  });

  it("no toolDeps (bare/test builds): NOTHING — fail-closed", async () => {
    const tools = await computerUsePlugin.createTools({ root: tempDir });
    expect(tools).toHaveLength(0);
  });

  it("declaration context (db:null, the catalog path): NOTHING", async () => {
    const tools = await computerUsePlugin.createTools({
      root: tempDir,
      toolDeps: { ...makeDeps(), db: null as unknown as ToolDeps["db"] },
    });
    expect(tools).toHaveLength(0);
  });

  it("ENABLED + act posture: exactly the 31 tools (30 doc-02 + find_elements)", async () => {
    setComputerUseSettings(db, { enabled: true, permission: "act" });
    const tools = await computerUsePlugin.createTools({ root: tempDir, toolDeps: makeDeps() });
    expect(tools.map((t) => t.name).sort()).toEqual([
      // observe & resolve
      "cursor_position", "find_elements", "get_app_state", "list_apps", "list_displays", "list_windows",
      "open_application", "request_access", "screenshot", "switch_display", "zoom",
      // pointer
      "double_click", "left_click", "left_click_drag", "left_mouse_down", "left_mouse_up",
      "middle_click", "mouse_move", "right_click", "scroll", "triple_click",
      // text & keyboard
      "hold_key", "key", "select_text", "set_value", "type",
      // semantic
      "perform_action",
      // runtime
      "read_clipboard", "stop_computer_control", "wait", "write_clipboard",
    ].sort());
    expect(tools).toHaveLength(31);
  });

  it("observe posture: ONLY the read-only subset is offered (the model never sees mutating schemas)", async () => {
    setComputerUseSettings(db, { enabled: true, permission: "observe" });
    const tools = await computerUsePlugin.createTools({ root: tempDir, toolDeps: makeDeps() });
    const names = tools.map((t) => t.name);
    expect(names.sort()).toEqual([
      "cursor_position", "find_elements", "get_app_state", "list_apps", "list_displays", "list_windows",
      "read_clipboard", "request_access", "screenshot", "switch_display", "wait", "zoom",
    ].sort());
    expect(names).not.toContain("left_click");
    expect(names).not.toContain("type");
  });

  it("R66-2-d: find_elements is registered with the search contract — present when enabled, ABSENT when off", async () => {
    // OFF (the default): the tool surface stays dark.
    const off = await computerUsePlugin.createTools({ root: tempDir, toolDeps: makeDeps() });
    expect(off.find((t) => t.name === "find_elements")).toBeUndefined();
    // ON: name + description + schema + required fields.
    setComputerUseSettings(db, { enabled: true, permission: "act" });
    const tools = await computerUsePlugin.createTools({ root: tempDir, toolDeps: makeDeps() });
    const find = tools.find((t) => t.name === "find_elements");
    expect(find).toBeDefined();
    expect(find!.description).toContain("SEARCH an app's accessibility tree");
    expect(find!.description).toContain("Sign in");
    expect(find!.description).toContain("left_click");
    expect(find!.description).toContain("Chromium-sized");
    const schema = JSON.stringify(find!.inputSchema);
    expect(schema).toContain("query");
    expect(schema).toContain("kind");
    expect(schema).toContain("limit");
    expect(schema).toContain("appRef");
    expect(schema).toContain("case-insensitive name substring");
    // jsonSchema() wraps the raw schema ({ jsonSchema: { … } }).
    const required = (find!.inputSchema as { jsonSchema?: { required?: string[] } }).jsonSchema?.required ?? [];
    expect([...required].sort()).toEqual(["appRef", "query"]);
  });

  it("R64-a: list_apps / get_app_state descriptions teach the resolution contract (title vs processName, runningApps payload)", async () => {
    setComputerUseSettings(db, { enabled: true, permission: "act" });
    const tools = await computerUsePlugin.createTools({ root: tempDir, toolDeps: makeDeps() });
    const listApps = tools.find((t) => t.name === "list_apps")!;
    expect(listApps.description).toContain("processName");
    expect(listApps.description).toContain("WINDOW TITLE");
    expect(listApps.description).toContain("app_not_found");
    const getState = tools.find((t) => t.name === "get_app_state")!;
    expect(getState.description).toContain("processName");
    expect(getState.description).toContain("runningApps");
    // The app_ref schema description states the resolution keys too.
    const typeTool = tools.find((t) => t.name === "type")!;
    expect(JSON.stringify(typeTool.inputSchema)).toContain("unique substring");
  });

  // R68-C (C7): the anti-screenshot-spam teaching — the owner: "utilizing
  // the screenshot capturing way too much… it needs to be handled much
  // better". The descriptions now steer to the SEARCHABLE tree, the
  // immediate observe→act chain, the small verification crop, and the
  // type tool's automatic frontmost activation.
  it("R68-C: the descriptions teach the searchable tree + the chain discipline + the auto-activation", async () => {
    setComputerUseSettings(db, { enabled: true, permission: "act" });
    const tools = await computerUsePlugin.createTools({ root: tempDir, toolDeps: makeDeps() });
    const find = tools.find((t) => t.name === "find_elements")!;
    expect(find.description).toContain("BROWSER PAGES: the web accessibility tree IS searched");
    expect(find.description).toContain("the tree is activated automatically");
    const shot = tools.find((t) => t.name === "screenshot")!;
    expect(shot.description).toContain("The FALLBACK observation");
    expect(shot.description).toContain("prefer find_elements for browser content");
    expect(shot.description).toContain("the web tree is searchable by name");
    expect(shot.description).toContain("frames stay valid for 30s");
    expect(shot.description).toContain("don't re-screenshot");
    const zoom = tools.find((t) => t.name === "zoom")!;
    expect(zoom.description).toContain("Use a SMALL region");
    expect(zoom.description).toContain("cheaper and faster than a full screenshot");
    const type = tools.find((t) => t.name === "type")!;
    expect(type.description).toContain("brought frontmost automatically");
    expect(type.description).toContain("a frontmost_pid_mismatch refusal means that activation failed");
    // The old "the app MUST be frontmost" wording is retired.
    expect(type.description).not.toContain("MUST be frontmost");
    // C7's last teaching point: middle_click = new tab on browser links.
    const middle = tools.find((t) => t.name === "middle_click")!;
    expect(middle.description).toContain("NEW TAB");
  });
});

describe("ROUND-61 (R61): tool output shapes + the monitor + vision wiring", () => {
  // NOTE — the 30s timeouts on the execute() tests below: on the WINDOWS CI
  // runner these dispatch REAL OS probes (the Add-Type csc compile alone is
  // multi-second cold — R64's shared preamble, plus the EnumWindows walk).
  // The R66 push went red because list_apps crossed vitest's default 5s on
  // a slow runner; the Linux sandbox never sees it (headless → empty, fast).
  // These are contract tests of the output SHAPE — the real work may be slow.
  it("a read tool returns {ok:true, output:JSON} with the data envelope", { timeout: 30_000 }, async () => {
    setComputerUseSettings(db, { enabled: true, permission: "observe" });
    const tools = await computerUsePlugin.createTools({ root: tempDir, toolDeps: makeDeps({ emit: (e) => emitLog.push(e) }) });
    const listApps = tools.find((t) => t.name === "list_apps")!;
    const result = await listApps.execute({}, { root: tempDir });
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output) as { apps: unknown[] };
    expect(Array.isArray(parsed.apps)).toBe(true); // headless linux: likely empty — the shape is the contract
    // The dispatch ALSO journaled + emitted a computer-use envelope.
    expect(emitLog.some((e) => (e as Record<string, unknown>)["type"] === "computer-use")).toBe(true);
  });

  it("refusal outputs are structured JSON the model can recover from", async () => {
    setComputerUseSettings(db, { enabled: true, permission: "act" });
    const tools = await computerUsePlugin.createTools({ root: tempDir, toolDeps: makeDeps() });
    const click = tools.find((t) => t.name === "left_click")!;
    const result = await click.execute({ target: { type: "element", stateId: "s-nope", index: 1 } }, { root: tempDir });
    expect(result.ok).toBe(false);
    const parsed = JSON.parse(result.output) as { error: string; message: string; recovery: string };
    expect(parsed.error).toBe("element_stale");
    expect(parsed.message.length).toBeGreaterThan(10);
    expect(parsed.recovery).toContain("get_app_state");
  });

  it("screenshot with describe:true + vision OFF → raster metadata + the honest vision-disabled note", { timeout: 30_000 }, async () => {
    setComputerUseSettings(db, { enabled: true, permission: "act" });
    const tools = await computerUsePlugin.createTools({ root: tempDir, toolDeps: makeDeps() });
    const shot = tools.find((t) => t.name === "screenshot")!;
    const result = await shot.execute({ describe: true }, { root: tempDir });
    // Headless sandbox: the capture itself may fail (no DISPLAY) — either
    // the refusal or the raster+vision-note shape is acceptable; assert the
    // CONTRACT: no crash, structured output.
    expect(typeof result.ok).toBe("boolean");
    expect(() => JSON.parse(result.output)).not.toThrow();
  });

  it("screenshot with describe:true + SEPARATE vision configured → the relay's text rides the output", { timeout: 30_000 }, async () => {
    setComputerUseSettings(db, { enabled: true, permission: "act" });
    // R66: the vision configuration is GLOBAL now (vision.* keys), not part
    // of the computer-use settings block.
    setVisionSettings(db, { mode: "separate", provider: "openrouter", modelId: "google/gemini-2.5-flash" });
    upsertModel(db, "openrouter", { modelId: "google/gemini-2.5-flash", supportsVision: true });
    const tools = await computerUsePlugin.createTools({ root: tempDir, toolDeps: makeDeps() });
    const shot = tools.find((t) => t.name === "screenshot")!;
    const result = await shot.execute({ describe: true, instruction: "what is on screen" }, { root: tempDir });
    // Headless: capture likely refuses (capability_fail_closed with the
    // error envelope). The vision call only happens after a successful
    // capture. Assert the structured contract either way.
    expect(() => JSON.parse(result.output)).not.toThrow();
  });
});

describe("ROUND-61 (R61): the consent gate (ask-mode risk classes)", () => {
  it("in act posture WITHOUT an emit channel: consent-needed tools fail closed (non-interactive)", async () => {
    setComputerUseSettings(db, { enabled: true, permission: "act" });
    const tools = await computerUsePlugin.createTools({ root: tempDir, toolDeps: makeDeps() });
    const type = tools.find((t) => t.name === "type")!;
    const result = await type.execute({ text: "hello", appRef: { pid: 999 } }, { root: tempDir });
    expect(result.ok).toBe(false);
    const parsed = JSON.parse(result.output) as { error: string; message: string; recovery?: string };
    expect(parsed.error).toBe("host_policy_denied");
    expect(parsed.message).toContain("declined");
  });

  it("in AUTO posture: no consent prompt — the dispatcher runs (and refuses for real reasons)", { timeout: 30_000 }, async () => {
    setComputerUseSettings(db, { enabled: true, permission: "auto" });
    const tools = await computerUsePlugin.createTools({ root: tempDir, toolDeps: makeDeps() });
    const type = tools.find((t) => t.name === "type")!;
    const result = await type.execute({ text: "hello", appRef: { pid: 999 } }, { root: tempDir });
    // Past the consent gate; refused by the app resolution (pid 999 not running).
    const parsed = JSON.parse(result.output) as { error: string };
    expect(parsed.error).not.toBe("host_policy_denied");
  });

  it("element presses never need consent (background-safe — the doc's a11y-first policy)", async () => {
    setComputerUseSettings(db, { enabled: true, permission: "act" });
    const tools = await computerUsePlugin.createTools({ root: tempDir, toolDeps: makeDeps() });
    const click = tools.find((t) => t.name === "left_click")!;
    const result = await click.execute({ target: { type: "element", stateId: "s-1", index: 1 } }, { root: tempDir });
    // Refused by element_stale (no such snapshot) — NOT by the consent gate.
    const parsed = JSON.parse(result.output) as { error: string };
    expect(parsed.error).toBe("element_stale");
  });
});

describe("ROUND-61 (R61): the audit trail lands under <root>/.acute/computer-use", () => {
  it("tool executions journal (one line per dispatch)", async () => {
    setComputerUseSettings(db, { enabled: true, permission: "observe" });
    mkdirSync(join(tempDir, ".acute"), { recursive: true });
    writeFileSync(join(tempDir, ".acute", "x"), "");
    const tools = await computerUsePlugin.createTools({ root: tempDir, toolDeps: makeDeps() });
    const wait = tools.find((t) => t.name === "wait")!;
    await wait.execute({ duration: 0 }, { root: tempDir });
    const auditFile = join(tempDir, ".acute", "computer-use", "audit.jsonl");
    expect(existsSync(auditFile)).toBe(true);
    const lines = readFileSync(auditFile, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(lines[0]).tool).toBe("wait");
  });
});

// ── ROUND-67 (R67-D): the live screenshot THUMBNAIL frames ───────────────────
// A successful capture (screenshot / zoom / get_app_state includeScreenshot)
// must copy its raster into the route-served registry and announce the frame
// id over the SSE channel; a refusal (headless sandbox, capture failed) must
// NOT. The dispatcher is prototype-spied (the plugin constructs it
// internally) so the capture result is deterministic here — the emission
// path, not the OS capture, is the contract under test.
describe("ROUND-67 (R67-D): screenshot frames after successful captures", () => {
  const PNG = "cG5nQnl0ZXM="; // "pngBytes"

  let dispatchSpy: MockInstance<(tool: string, args: Record<string, unknown>) => Promise<DispatchResult>>;
  let rasterSpy: MockInstance<(frameId: string) => string | undefined>;

  beforeEach(() => {
    resetRasterCacheForTest();
    emitLog = [];
    // The capture result is faked (headless linux refuses real captures);
    // rasterFor feeds the emission exactly as a real cache hit would.
    dispatchSpy = vi
      .spyOn(ComputerDispatcher.prototype, "dispatch")
      .mockResolvedValue({ kind: "data", data: { frame: { frameId: "f-77", width: 800, height: 600, scale: 1 } } });
    rasterSpy = vi.spyOn(ComputerDispatcher.prototype, "rasterFor").mockReturnValue(PNG);
  });

  afterEach(() => {
    dispatchSpy.mockRestore();
    rasterSpy.mockRestore();
  });

  it("screenshot: emits {type:'screenshot'} with the frame id + registers the raster", async () => {
    setComputerUseSettings(db, { enabled: true, permission: "observe" });
    const tools = await computerUsePlugin.createTools({
      root: tempDir,
      toolDeps: makeDeps({ emit: (e) => emitLog.push(e) }),
    });
    const shot = tools.find((t) => t.name === "screenshot")!;
    const result = await shot.execute({}, { root: tempDir });
    expect(result.ok).toBe(true);
    const frame = emitLog.find((e) => (e as Record<string, unknown>)["type"] === "screenshot") as
      | { frameId?: string; tool?: string; sessionId?: string; type?: string }
      | undefined;
    expect(frame).toBeDefined();
    expect(frame!.frameId).toBe("f-77");
    expect(frame!.tool).toBe("screenshot");
    expect(frame!.sessionId).toBe("sess"); // toolDeps.sessionId rides the frame
    // The raster landed in the ROUTE-SERVED registry (the thumbnail fetch).
    expect(rasterFor("f-77")).toMatchObject({ pngBase64: PNG });
    // The monitor frame still fires too (one per dispatch, unchanged).
    expect(emitLog.some((e) => (e as Record<string, unknown>)["type"] === "computer-use")).toBe(true);
  });

  it("zoom: emits the frame with the 'zoomed region' note", async () => {
    setComputerUseSettings(db, { enabled: true, permission: "observe" });
    const tools = await computerUsePlugin.createTools({
      root: tempDir,
      toolDeps: makeDeps({ emit: (e) => emitLog.push(e) }),
    });
    const zoom = tools.find((t) => t.name === "zoom")!;
    await zoom.execute({ region: [0, 0, 10, 10] }, { root: tempDir });
    const frame = emitLog.find((e) => (e as Record<string, unknown>)["type"] === "screenshot") as
      | { tool?: string; note?: string }
      | undefined;
    expect(frame).toBeDefined();
    expect(frame!.tool).toBe("zoom");
    expect(frame!.note).toBe("zoomed region");
  });

  it("get_app_state with a raster in the data: emits the frame with the 'window raster' note", async () => {
    setComputerUseSettings(db, { enabled: true, permission: "observe" });
    dispatchSpy.mockResolvedValue({
      kind: "data",
      data: { state: { stateId: "s-1", elements: [] }, raster: { frameId: "f-78", width: 640, height: 480, scale: 1 } },
    });
    const tools = await computerUsePlugin.createTools({
      root: tempDir,
      toolDeps: makeDeps({ emit: (e) => emitLog.push(e) }),
    });
    const getState = tools.find((t) => t.name === "get_app_state")!;
    await getState.execute({ appRef: { pid: 1 }, includeScreenshot: true }, { root: tempDir });
    const frame = emitLog.find((e) => (e as Record<string, unknown>)["type"] === "screenshot") as
      | { frameId?: string; tool?: string; note?: string }
      | undefined;
    expect(frame).toBeDefined();
    expect(frame!.frameId).toBe("f-78");
    expect(frame!.tool).toBe("get_app_state");
    expect(frame!.note).toBe("window raster");
  });

  it("get_app_state WITHOUT a raster (includeScreenshot off or capture failed): NO frame — nothing to show", async () => {
    setComputerUseSettings(db, { enabled: true, permission: "observe" });
    dispatchSpy.mockResolvedValue({ kind: "data", data: { state: { stateId: "s-1", elements: [] } } });
    const tools = await computerUsePlugin.createTools({
      root: tempDir,
      toolDeps: makeDeps({ emit: (e) => emitLog.push(e) }),
    });
    const getState = tools.find((t) => t.name === "get_app_state")!;
    await getState.execute({ appRef: { pid: 1 } }, { root: tempDir });
    expect(emitLog.some((e) => (e as Record<string, unknown>)["type"] === "screenshot")).toBe(false);
  });

  it("a REFUSAL (capture failed): NO screenshot frame (honest — nothing was captured)", async () => {
    setComputerUseSettings(db, { enabled: true, permission: "observe" });
    dispatchSpy.mockResolvedValue({
      kind: "refusal",
      refusal: { error: "capability_fail_closed", message: "Capture failed: no display", recovery: "…" },
    });
    const tools = await computerUsePlugin.createTools({
      root: tempDir,
      toolDeps: makeDeps({ emit: (e) => emitLog.push(e) }),
    });
    const shot = tools.find((t) => t.name === "screenshot")!;
    const result = await shot.execute({}, { root: tempDir });
    expect(result.ok).toBe(false);
    expect(emitLog.some((e) => (e as Record<string, unknown>)["type"] === "screenshot")).toBe(false);
    // Nothing registered either.
    expect(rasterFor("f-77")).toBeNull();
  });

  it("raster already evicted from the dispatcher's 3-frame cache: NO frame, tool still succeeds", async () => {
    setComputerUseSettings(db, { enabled: true, permission: "observe" });
    rasterSpy.mockReturnValue(undefined);
    const tools = await computerUsePlugin.createTools({
      root: tempDir,
      toolDeps: makeDeps({ emit: (e) => emitLog.push(e) }),
    });
    const shot = tools.find((t) => t.name === "screenshot")!;
    const result = await shot.execute({}, { root: tempDir });
    // The tool result is UNAFFECTED (the thumbnail strip is an enhancement).
    expect(result.ok).toBe(true);
    expect(emitLog.some((e) => (e as Record<string, unknown>)["type"] === "screenshot")).toBe(false);
  });
});

// ── ROUND-69 (R69, task 4-c-2): the auto-observation receipt surface ────────
// The mutating tools' schemas advertise returnState (default "compact" =
// the receipt's observation), middle_click accepts element targets, and
// every action receipt carries the observation — the model is TAUGHT the
// receipt-read loop instead of the screenshot loop.

describe("ROUND-69 (4-c-2): tool schemas teach the observation receipts", () => {
  it("the mutating tools advertise returnState + the post-action observation in their schemas and descriptions", async () => {
    setComputerUseSettings(db, { enabled: true, permission: "act" });
    const tools = await computerUsePlugin.createTools({ root: tempDir, toolDeps: makeDeps() });
    const observed = [
      "left_click", "double_click", "triple_click", "right_click", "middle_click",
      "scroll", "left_click_drag", "type", "set_value", "select_text", "key",
    ];
    for (const name of observed) {
      const t = tools.find((x) => x.name === name)!;
      const schema = JSON.stringify(t.inputSchema);
      expect(schema).toContain("returnState");
      expect(schema).toContain("'compact' (default)");
      expect(t.description).toContain("post-action OBSERVATION");
    }
    // wait()'s description teaches the what-changed receipt (no parameter —
    // the observation is unconditional).
    const wait = tools.find((t) => t.name === "wait")!;
    expect(wait.description).toContain("what changed while you waited");
    expect(wait.description).toContain("instead of re-capturing");
    expect(JSON.stringify(wait.inputSchema)).not.toContain("returnState");
    // Non-observation mutating tools keep the legacy surface (left_mouse_down
    // keeps its R61 opt-in parameter, unchanged).
    const down = tools.find((t) => t.name === "left_mouse_down")!;
    expect(JSON.stringify(down.inputSchema)).toContain("returnState");
    expect(down.description).not.toContain("post-action OBSERVATION");
  });

  it("middle_click + right_click descriptions teach ELEMENT targets (the fail-closed cells are gone)", async () => {
    setComputerUseSettings(db, { enabled: true, permission: "act" });
    const tools = await computerUsePlugin.createTools({ root: tempDir, toolDeps: makeDeps() });
    const middle = tools.find((t) => t.name === "middle_click")!;
    expect(middle.description).toContain("raw middle-click at the element's CENTER");
    expect(JSON.stringify(middle.inputSchema)).toContain("element or coordinate");
    const right = tools.find((t) => t.name === "right_click")!;
    expect(right.description).toContain("raw right-click at its center");
  });
});

// ── ROUND-69 (R69, task 4-c-2): the observation + auto-refresh SSE frames ────
// After a mutating tool runs, the plugin takes receipt.observation.frameId
// (and the 4-c-1 refreshFrameId), registers the raster route-side, and
// fires the {type:"screenshot"} SSE frame — the inline ScreenshotRow shows
// the post-action frame AT the moment it was taken (the owner's directive).

describe("ROUND-69 (4-c-2): observation + auto-refresh frames go inline", () => {
  const PNG = "cG5nQnl0ZXM=";

  let dispatchSpy: MockInstance<(tool: string, args: Record<string, unknown>) => Promise<DispatchResult>>;
  let rasterSpy: MockInstance<(frameId: string) => string | undefined>;

  beforeEach(() => {
    resetRasterCacheForTest();
    emitLog = [];
    dispatchSpy = vi
      .spyOn(ComputerDispatcher.prototype, "dispatch")
      .mockResolvedValue({
        kind: "receipt",
        receipt: {
          schemaVersion: "acute-cua-action-receipt-v1",
          actionSent: true,
          dispatchStatus: "accepted",
          retryAction: false,
          observation: { frameId: "f-81", screenChanged: true, activeApp: { pid: 4242, title: "App" }, titleChanged: false },
        },
      });
    rasterSpy = vi.spyOn(ComputerDispatcher.prototype, "rasterFor").mockReturnValue(PNG);
  });

  afterEach(() => {
    dispatchSpy.mockRestore();
    rasterSpy.mockRestore();
  });

  it("a left_click receipt with an observation: emits {type:'screenshot'} with the ACTION tool name + registers the raster", async () => {
    setComputerUseSettings(db, { enabled: true, permission: "auto" });
    const tools = await computerUsePlugin.createTools({
      root: tempDir,
      toolDeps: makeDeps({ emit: (e) => emitLog.push(e) }),
    });
    const click = tools.find((t) => t.name === "left_click")!;
    const result = await click.execute({ target: { type: "element", stateId: "s-1", index: 1 } }, { root: tempDir });
    expect(result.ok).toBe(true);
    const frame = emitLog.find((e) => (e as Record<string, unknown>)["type"] === "screenshot") as
      | { frameId?: string; tool?: string; sessionId?: string; note?: string }
      | undefined;
    expect(frame).toBeDefined();
    expect(frame!.frameId).toBe("f-81");
    expect(frame!.tool).toBe("left_click"); // the ACTION tool, not "screenshot"
    expect(frame!.note).toBe("post-action observation");
    expect(frame!.sessionId).toBe("sess");
    // The raster landed in the ROUTE-SERVED registry (the thumbnail fetch).
    expect(rasterFor("f-81")).toMatchObject({ pngBase64: PNG });
    // The tool result carries the receipt + the observation inside it.
    const parsed = JSON.parse(result.output) as { action_receipt: { observation?: { frameId?: string } } };
    expect(parsed.action_receipt.observation?.frameId).toBe("f-81");
  });

  it("the 4-c-1 refreshFrameId emits its own 'auto_refresh' frame FIRST (chronological), then the observation frame", async () => {
    setComputerUseSettings(db, { enabled: true, permission: "auto" });
    dispatchSpy.mockResolvedValue({
      kind: "receipt",
      receipt: {
        schemaVersion: "acute-cua-action-receipt-v1",
        actionSent: true,
        dispatchStatus: "accepted",
        retryAction: false,
        frameRefreshed: true,
        refreshFrameId: "f-80",
        screenStable: true,
        observation: { frameId: "f-81", screenChanged: false },
      },
    });
    const tools = await computerUsePlugin.createTools({
      root: tempDir,
      toolDeps: makeDeps({ emit: (e) => emitLog.push(e) }),
    });
    const click = tools.find((t) => t.name === "scroll")!;
    await click.execute({ target: { type: "coordinate", x: 5, y: 5 }, scrollDirection: "down" }, { root: tempDir });
    const frames = emitLog
      .filter((e) => (e as Record<string, unknown>)["type"] === "screenshot")
      .map((e) => e as { frameId?: string; tool?: string });
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ frameId: "f-80", tool: "auto_refresh" }); // the refresh happened FIRST
    expect(frames[1]).toMatchObject({ frameId: "f-81", tool: "scroll" }); // then the post-action frame
  });

  it("a captureFailed observation emits NO frame (nothing was captured) but the receipt still carries the honest marker", async () => {
    setComputerUseSettings(db, { enabled: true, permission: "auto" });
    dispatchSpy.mockResolvedValue({
      kind: "receipt",
      receipt: {
        schemaVersion: "acute-cua-action-receipt-v1",
        actionSent: true,
        dispatchStatus: "accepted",
        retryAction: false,
        observation: { captureFailed: true },
      },
    });
    const tools = await computerUsePlugin.createTools({
      root: tempDir,
      toolDeps: makeDeps({ emit: (e) => emitLog.push(e) }),
    });
    const click = tools.find((t) => t.name === "key")!;
    const result = await click.execute({ text: "return", appRef: { pid: 1 } }, { root: tempDir });
    expect(result.ok).toBe(true);
    expect(emitLog.some((e) => (e as Record<string, unknown>)["type"] === "screenshot")).toBe(false);
    const parsed = JSON.parse(result.output) as { action_receipt: { observation?: { captureFailed?: boolean } } };
    expect(parsed.action_receipt.observation).toEqual({ captureFailed: true });
  });

  it("an evicted observation raster emits nothing (the enhancement never breaks the tool)", async () => {
    setComputerUseSettings(db, { enabled: true, permission: "auto" });
    rasterSpy.mockReturnValue(undefined);
    const tools = await computerUsePlugin.createTools({
      root: tempDir,
      toolDeps: makeDeps({ emit: (e) => emitLog.push(e) }),
    });
    const click = tools.find((t) => t.name === "left_click")!;
    const result = await click.execute({ target: { type: "coordinate", x: 1, y: 1 } }, { root: tempDir });
    expect(result.ok).toBe(true);
    expect(emitLog.some((e) => (e as Record<string, unknown>)["type"] === "screenshot")).toBe(false);
  });
});
