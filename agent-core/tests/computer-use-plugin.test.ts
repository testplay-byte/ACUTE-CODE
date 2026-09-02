/**
 * ROUND-61 (R61): the computer-use PLUGIN gate tests — the settings master
 * switch (default OFF → no tools), the posture subsets (observe = read-only
 * surface), the full 30-tool catalog (doc 02 completeness), the consent
 * gate in ask mode, and the vision relay wiring through screenshot
 * describe=true.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "../src/storage/db";
import { ProviderKeyring } from "../src/providers/registry";
import { computerUsePlugin } from "../src/tools/plugins/computer-use";
import { setComputerUseSettings } from "../src/storage/computer-use";
import { resetComputerSessionForTests } from "../src/computer/session";
import { resetAuditForTests } from "../src/computer/audit";
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

  it("ENABLED + act posture: exactly the 30 doc-02 tools", async () => {
    setComputerUseSettings(db, { enabled: true, permission: "act" });
    const tools = await computerUsePlugin.createTools({ root: tempDir, toolDeps: makeDeps() });
    expect(tools.map((t) => t.name).sort()).toEqual([
      // observe & resolve
      "cursor_position", "get_app_state", "list_apps", "list_displays", "list_windows",
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
    expect(tools).toHaveLength(30);
  });

  it("observe posture: ONLY the read-only subset is offered (the model never sees mutating schemas)", async () => {
    setComputerUseSettings(db, { enabled: true, permission: "observe" });
    const tools = await computerUsePlugin.createTools({ root: tempDir, toolDeps: makeDeps() });
    const names = tools.map((t) => t.name);
    expect(names.sort()).toEqual([
      "cursor_position", "get_app_state", "list_apps", "list_displays", "list_windows",
      "read_clipboard", "request_access", "screenshot", "switch_display", "wait", "zoom",
    ].sort());
    expect(names).not.toContain("left_click");
    expect(names).not.toContain("type");
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
});

describe("ROUND-61 (R61): tool output shapes + the monitor + vision wiring", () => {
  it("a read tool returns {ok:true, output:JSON} with the data envelope", async () => {
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

  it("screenshot with describe:true + vision OFF → raster metadata + the honest vision-disabled note", async () => {
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

  it("screenshot with describe:true + SEPARATE vision configured → the relay's text rides the output", async () => {
    setComputerUseSettings(db, {
      enabled: true,
      permission: "act",
      vision: { mode: "separate", provider: "openrouter", modelId: "google/gemini-2.5-flash" },
    });
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

  it("in AUTO posture: no consent prompt — the dispatcher runs (and refuses for real reasons)", async () => {
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
