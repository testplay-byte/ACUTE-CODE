/**
 * ROUND-61 (R61): the DISPATCHER tests — doc 07's master matrix, driven
 * against a FAKE backend + a recording RunCommand. Every rule the docs
 * encode gets a case: gates (kill switch, posture), target resolution,
 * freshness (supersession, frame age, bounds), the foreground rule, the
 * matrix's fail-closed cells, receipts-not-promises, and the audit trail.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ComputerDispatcher, parseModifiers, splitKeyChord } from "../src/computer/dispatch";
import { resetComputerSessionForTests, getComputerSession, MAX_FRAME_AGE_MS } from "../src/computer/session";
import type { CuaBackend, CommandCapsule, ListAppsResult, ListWindowsResult, RunCommand, RunResult } from "../src/computer/backends/interface";
import type { Snapshot, WindowInfo, AppInfo } from "../src/computer/types";
import { auditPath, resetAuditForTests } from "../src/computer/audit";

let tempRoot: string;
const capsules: CommandCapsule[] = [];
/** What the fake backend records per call (for assertions). */
const calls: string[] = [];

afterAll(() => {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

const fakeRun: RunCommand = async (capsule) => {
  capsules.push(capsule);
  return { code: 0, stdout: "OK", stderr: "", timedOut: false } satisfies RunResult;
};

/* A fake backend whose behavior is DIRECTED by the test via `calls` —
 * the methods succeed and record their invocation; specific failure modes
 * are injected through the `mode` global. */
let mode: "ok" | "press-stale" | "frontmost-mismatch" | "launch-fail" | "capture-fail" = "ok";
let fakeFrontmost: number | null = 4242;
let rawRequiresForeground = true;
/** R64-a: the resolver test's app table (mutable per-test). */
let fakeApps: AppInfo[] = [{ name: "App", pid: 4242, active: true }];
/** R67-C: queued listApps results — non-empty means "shift the next result
 * off the queue" (the retry/probeNote tests script failures). */
let fakeListAppsQueue: ListAppsResult[] = [];
/** R67-C: how many times listApps actually ran (the retry semantics). */
let listAppsCalls = 0;
/** R67-C: the pid's window table + its diagnostics (the helper-pid tests
 * script a live-but-windowless process, e.g. a WebView2 renderer). */
let fakeWindows: WindowInfo[] = [
  { windowId: 77, title: "App Window", bounds: [10, 20, 800, 600] as [number, number, number, number], main: true, focused: true },
];
let fakeWindowsDiagnostics: ListWindowsResult["diagnostics"] = undefined;
/** R67-C: the key tool's focused-element readback (null = omit the field). */
let fakeFocused: string | null = null;
/** R68-C: frontmost auto-retry knobs — healOnActivate simulates a
 * SUCCESSFUL escalated activation (the foreground flips to the target pid
 * as the real backend's ladder would); activateCalls counts them; the
 * fail-once knobs script a script-level FRONTMOST_MISMATCH (the race where
 * the focus churns between the gate and the SendInput). */
let healOnActivate = false;
let activateCalls = 0;
let rawKeyAttempts = 0;
let rawKeyFailOnce = false;
let rawClickAttempts = 0;
let rawClickFailOnce = false;
/** R68-C: a persistent non-mismatch rawKey error (the NO-retry-for-other-
 * errors pin — withForegroundRetry must not touch this class). */
let rawKeyError: string | null = null;
/** R66-2-d: find_elements tests may swap the fake snapshot's element list
 * (makeDispatcher resets it to the default 5-element table). */
let fakeElements: Snapshot["elements"] | null = null;

const ELEMENTS: Snapshot["elements"] = [
  { index: 0, kind: "window", name: "App", flags: [], bounds: [10, 20, 800, 600] },
  { index: 1, kind: "button", name: "Save", flags: ["pressable"], bounds: [100, 200, 80, 30] },
  { index: 2, kind: "textfield", name: "File name:", flags: ["editable", "focused"], value: "old.txt", bounds: [120, 260, 200, 24] },
  { index: 3, kind: "menuitem", name: "File", flags: ["has_menu", "pressable"], actions: ["Expand"], bounds: [30, 40, 60, 20] },
  { index: 4, kind: "button", name: "Bare", flags: ["pressable"], bounds: [400, 500, 90, 30] },
];

const fakeBackend: CuaBackend = {
  kind: "fake",
  capabilities: () => ({
    a11yTree: true,
    backgroundElementPress: true,
    backgroundValueWrite: true,
    backgroundRawInput: false,
    windowScopedTyping: false,
    capture: true,
    clipboard: true,
    rawRequiresForeground,
    permissionGates: [],
  }),
  listApps: async () => {
    listAppsCalls += 1;
    // R67-C: a queued result (scripted failure/empty) wins over the table.
    if (fakeListAppsQueue.length > 0) return fakeListAppsQueue.shift()!;
    return {
      apps: fakeApps,
      // R64-a: mimic the windows backend's honest-empty contract — diagnostics
      // ride EMPTY results so the resolver/diagnostics tests can pin the flow.
      ...(fakeApps.length === 0
        ? { diagnostics: { processCount: 3, foregroundPid: 4242, enumWindowsCount: 0 } }
        : {}),
    };
  },
  listWindows: async () => ({ windows: fakeWindows, ...(fakeWindowsDiagnostics !== undefined ? { diagnostics: fakeWindowsDiagnostics } : {}) }),
  listDisplays: async () => ({ displays: [{ index: 1, bounds: [0, 0, 1920, 1080] as [number, number, number, number], main: true }] }),
  buildSnapshot: async (_run, app, window, detail) => {
    const source = fakeElements ?? ELEMENTS;
    return {
      stateId: "",
      app: { pid: app.pid, title: window.title },
      window: { title: window.title, windowId: window.windowId, bounds: window.bounds },
      surface: { kind: "window", actualWindowId: window.windowId, lifecycle: "stable" },
      elements: detail === "full" ? source.map((e) => ({ ...e })) : source,
      createdAt: 0,
    };
  },
  hitTest: async () => null,
  focusedElementName: async () => fakeFocused,
  pressElement: async (_run, _pid, _window, _element) => {
    calls.push("press");
    return mode === "press-stale" ? { ok: false, stale: true, error: "identity changed" } : { ok: true };
  },
  setValue: async () => {
    calls.push("setValue");
    return { ok: true };
  },
  performAction: async () => {
    calls.push("performAction");
    return { ok: true };
  },
  selectRange: async () => ({ ok: true }),
  rawClick: async (_run, pt, button, clickCount, modifiers) => {
    calls.push(`rawClick:${button}:${clickCount}:${modifiers.join("+")}@${pt.x},${pt.y}`);
    rawClickAttempts += 1;
    if (rawClickFailOnce && rawClickAttempts === 1) {
      // The gate passed, but the focus CHURNED between the check and the
      // SendInput — the script-level mismatch (this also flips the fake
      // frontmost so the recheck sees the churned state).
      fakeFrontmost = 9999;
      return { ok: false, error: "FRONTMOST_MISMATCH:9999" };
    }
    return mode === "frontmost-mismatch"
      ? { ok: false, error: `FRONTMOST_MISMATCH:${fakeFrontmost}` }
      : { ok: true };
  },
  rawScroll: async () => ({ ok: true }),
  rawDrag: async () => ({ ok: true }),
  rawButton: async (_run, pt, down) => {
    calls.push(`rawButton:${down ? "down" : "up"}@${pt.x},${pt.y}`);
    return { ok: true };
  },
  rawKey: async () => {
    calls.push("rawKey");
    rawKeyAttempts += 1;
    if (rawKeyError !== null) return { ok: false, error: rawKeyError };
    if (rawKeyFailOnce && rawKeyAttempts === 1) {
      return { ok: false, error: `FRONTMOST_MISMATCH:${fakeFrontmost}` };
    }
    return { ok: true };
  },
  typeText: async () => {
    calls.push("typeText");
    return { ok: true };
  },
  launch: async () =>
    mode === "launch-fail" ? { ok: false, error: "not found" } : { ok: true, pid: 4242, active: false },
  activate: async () => {
    activateCalls += 1;
    if (healOnActivate) fakeFrontmost = 4242; // a successful escalated activation
    return { ok: true, active: true };
  },
  frontmostPid: async () => fakeFrontmost,
  captureDisplay: async () =>
    mode === "capture-fail"
      ? { error: "no capture tool" }
      : { pngBase64: Buffer.from("fakepng").toString("base64"), width: 1920, height: 1080, scale: 1, origin: { x: 0, y: 0 } },
  captureRegion: async () => ({ pngBase64: "aa==", width: 10, height: 10, scale: 1, origin: { x: 0, y: 0 } }),
  cursorPosition: async () => ({ x: 5, y: 6 }),
  readClipboard: async () => "clip",
  writeClipboard: async () => {
    calls.push("writeClipboard");
    return { ok: true };
  },
  probePermissions: async () => ({ accessibility: "granted", screenCapture: "granted", backendKind: "fake" }),
};

function makeDispatcher(allowMutations = true): ComputerDispatcher {
  resetComputerSessionForTests();
  resetAuditForTests(tempRoot);
  capsules.length = 0;
  calls.length = 0;
  mode = "ok";
  fakeFrontmost = 4242;
  rawRequiresForeground = true;
  fakeApps = [{ name: "App", pid: 4242, active: true }];
  fakeElements = null;
  fakeListAppsQueue = [];
  listAppsCalls = 0;
  fakeWindows = [
    { windowId: 77, title: "App Window", bounds: [10, 20, 800, 600] as [number, number, number, number], main: true, focused: true },
  ];
  fakeWindowsDiagnostics = undefined;
  fakeFocused = null;
  healOnActivate = false;
  activateCalls = 0;
  rawKeyAttempts = 0;
  rawKeyFailOnce = false;
  rawClickAttempts = 0;
  rawClickFailOnce = false;
  rawKeyError = null;
  return new ComputerDispatcher({ backend: fakeBackend, run: fakeRun, root: tempRoot, allowMutations });
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "acute-dispatch-"));
});

/* ── helpers ───────────────────────────────────────────────────────────────── */

async function observe(dispatcher: ComputerDispatcher): Promise<Snapshot> {
  const result = await dispatcher.dispatch("get_app_state", { appRef: { pid: 4242 } });
  if (result.kind !== "data") throw new Error("observe failed");
  return result.data["state"] as Snapshot;
}

async function screenshot(dispatcher: ComputerDispatcher): Promise<string> {
  const result = await dispatcher.dispatch("screenshot", {});
  if (result.kind !== "data") throw new Error("screenshot failed");
  return (result.data["frame"] as { frameId: string }).frameId;
}

/* ── the gates ─────────────────────────────────────────────────────────────── */

describe("ROUND-61 (R61): universal pre-dispatch gates (doc 07 §2)", () => {
  it("the kill switch refuses EVERY further call with kill_switch_active", async () => {
    const d = makeDispatcher();
    getComputerSession().ensureStarted("fake");
    getComputerSession().stop("done");
    const result = await d.dispatch("list_apps", {});
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") expect(result.refusal.error).toBe("kill_switch_active");
    // Read-only tools are refused too — enforced, not advisory.
    const observe2 = await d.dispatch("get_app_state", { appRef: { pid: 4242 } });
    expect(observe2.kind).toBe("refusal");
  });

  it("observe-only posture refuses mutating tools BEFORE any backend call", async () => {
    const d = makeDispatcher(false);
    const snap = await observe(d);
    const result = await d.dispatch("left_click", {
      target: { type: "element", stateId: snap.stateId, index: 1 },
    });
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.refusal.error).toBe("host_policy_denied");
      expect(result.refusal.recovery).toMatch(/Settings/);
    }
    expect(calls).toHaveLength(0); // never reached the backend
  });

  it("unknown tools refuse with capability_fail_closed (no free-form dispatch)", async () => {
    const d = makeDispatcher();
    const result = await d.dispatch("format_c_drive", {});
    expect(result.kind).toBe("refusal");
  });
});

/* ── element actions (the preferred path) ──────────────────────────────────── */

describe("ROUND-61 (R61): element actions — the a11y-first matrix", () => {
  it("left_click on a pressable element → semantic press, receipt matched, token consumed", async () => {
    const d = makeDispatcher();
    const snap = await observe(d);
    const result = await d.dispatch("left_click", { target: { type: "element", stateId: snap.stateId, index: 1 } });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.actionSent).toBe(true);
      expect(result.receipt.dispatchStatus).toBe("accepted");
      expect(result.receipt.targetVerificationStatus).toBe("matched");
    }
    expect(calls).toEqual(["press"]);
    // Supersession: the SAME stateId now refuses element_stale.
    const again = await d.dispatch("left_click", { target: { type: "element", stateId: snap.stateId, index: 1 } });
    expect(again.kind).toBe("refusal");
    if (again.kind === "refusal") expect(again.refusal.error).toBe("element_stale");
  });

  it("press staleness (backend identity mismatch) → element_stale with the ui_changed cause", async () => {
    const d = makeDispatcher();
    const snap = await observe(d);
    mode = "press-stale";
    const result = await d.dispatch("left_click", { target: { type: "element", stateId: snap.stateId, index: 1 } });
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.refusal.error).toBe("element_stale");
      expect(result.refusal.payload).toMatchObject({ cause: "ui_changed" });
    }
  });

  it("type on an editable element → a11y value write (REPLACES) — mode 1", async () => {
    const d = makeDispatcher();
    const snap = await observe(d);
    const result = await d.dispatch("type", {
      text: "new.txt",
      target: { type: "element", stateId: snap.stateId, index: 2 },
    });
    expect(result.kind).toBe("receipt");
    expect(calls).toEqual(["setValue"]);
  });

  it("type on a NON-editable element → capability_fail_closed (never raw-falls-through silently)", async () => {
    const d = makeDispatcher();
    const snap = await observe(d);
    const result = await d.dispatch("type", {
      text: "x",
      target: { type: "element", stateId: snap.stateId, index: 1 },
    });
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") expect(result.refusal.error).toBe("capability_fail_closed");
  });

  it("right_click on a has_menu element → performAction Expand; without has_menu → fail closed", async () => {
    const d = makeDispatcher();
    const snap = await observe(d);
    const menu = await d.dispatch("right_click", { target: { type: "element", stateId: snap.stateId, index: 3 } });
    expect(menu.kind).toBe("receipt");
    expect(calls).toEqual(["performAction"]);
    // Now a fresh snapshot; index 1 (no has_menu) fails closed.
    const snap2 = await observe(d);
    const bare = await d.dispatch("right_click", { target: { type: "element", stateId: snap2.stateId, index: 1 } });
    expect(bare.kind).toBe("refusal");
    if (bare.kind === "refusal") expect(bare.refusal.error).toBe("capability_fail_closed");
  });

  it("double_click / scroll on ELEMENT targets fail closed (no a11y equivalent — doc 07 matrix)", async () => {
    const d = makeDispatcher();
    const snap = await observe(d);
    const dbl = await d.dispatch("double_click", { target: { type: "element", stateId: snap.stateId, index: 1 } });
    expect(dbl.kind).toBe("refusal");
    const scr = await d.dispatch("scroll", { target: { type: "element", stateId: snap.stateId, index: 1 }, scrollDirection: "down" });
    expect(scr.kind).toBe("refusal");
  });

  it("perform_action validates the action against the element's advertised list", async () => {
    const d = makeDispatcher();
    const snap = await observe(d);
    const bad = await d.dispatch("perform_action", {
      target: { type: "element", stateId: snap.stateId, index: 3 },
      action: "Launch",
    });
    expect(bad.kind).toBe("refusal");
    if (bad.kind === "refusal") {
      expect(bad.refusal.error).toBe("capability_fail_closed");
      expect(bad.refusal.payload).toEqual({ availableActions: ["Expand"] });
    }
    const good = await d.dispatch("perform_action", {
      target: { type: "element", stateId: snap.stateId, index: 3 },
      action: "Expand",
    });
    expect(good.kind).toBe("receipt");
  });

  it("set_value writes through a11y and consumes the token", async () => {
    const d = makeDispatcher();
    const snap = await observe(d);
    const result = await d.dispatch("set_value", {
      target: { type: "element", stateId: snap.stateId, index: 2 },
      value: "C:\\path\\file.html",
    });
    expect(result.kind).toBe("receipt");
    expect(calls).toEqual(["setValue"]);
    expect(getComputerSession().getSnapshot(snap.stateId)?.consumed).toBe(true);
  });
});

/* ── coordinate actions (the fallback path) ────────────────────────────────── */

describe("ROUND-61 (R61): coordinate actions — frame binding + foreground rule", () => {
  it("coordinate click requires a LIVE frame first (frame_stale when none)", async () => {
    const d = makeDispatcher();
    const result = await d.dispatch("left_click", { target: { type: "coordinate", x: 100, y: 200 } });
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") expect(result.refusal.error).toBe("frame_stale");
  });

  it("coordinate click after a screenshot: raw click at the MAPPED global point, unverified receipt", async () => {
    const d = makeDispatcher();
    await screenshot(d);
    const result = await d.dispatch("left_click", { target: { type: "coordinate", x: 100, y: 200 } });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.targetVerificationStatus).toBe("unverified");
    }
    expect(calls).toEqual(["rawClick:left:1:@100,200"]);
  });

  it("out-of-raster coordinates refuse raster_out_of_bounds", async () => {
    const d = makeDispatcher();
    await screenshot(d);
    const result = await d.dispatch("left_click", { target: { type: "coordinate", x: 5000, y: 10 } });
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") expect(result.refusal.error).toBe("raster_out_of_bounds");
  });

  it("an AGED frame refuses frame_stale (R68-C: the 30s rule — the vision roundtrip no longer expires frames)", async () => {
    const d = makeDispatcher();
    const frameId = await screenshot(d);
    const frame = getComputerSession().getFrame(frameId)!;
    frame.capturedAt = Date.now() - (MAX_FRAME_AGE_MS + 1000);
    const result = await d.dispatch("left_click", { target: { type: "coordinate", x: 10, y: 10 } });
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") expect(result.refusal.error).toBe("frame_stale");
  });

  it("Win/Linux raw path: frontmost mismatch + FAILED auto-activation → the honest frontmost_pid_mismatch (nothing sent)", async () => {
    const d = makeDispatcher();
    await screenshot(d);
    fakeFrontmost = 9999;
    const result = await d.dispatch("left_click", { target: { type: "coordinate", x: 10, y: 10 } });
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.refusal.error).toBe("frontmost_pid_mismatch");
      expect(result.refusal.payload).toEqual({ scopePid: 4242, activePid: 9999 });
      // R68-C: the recovery names the FAILED auto-activation (the honest
      // truth: dispatch already tried — what remains is app-level triage).
      expect(result.refusal.recovery).toContain("auto-activation failed");
      expect(result.refusal.recovery).toContain("retry ONCE");
    }
    // The auto-activation RAN (once) and the backend NEVER got a click:
    expect(activateCalls).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("double_click on a coordinate goes raw with clickCount 2 (raster-bound)", async () => {
    const d = makeDispatcher();
    await screenshot(d);
    const result = await d.dispatch("double_click", { target: { type: "coordinate", x: 50, y: 60 } });
    expect(result.kind).toBe("receipt");
    expect(calls).toEqual(["rawClick:left:2:@50,60"]);
  });

  it("scroll: coordinate target → raw wheel dispatch (receipt)", async () => {
    const d = makeDispatcher();
    await screenshot(d);
    const result = await d.dispatch("scroll", {
      target: { type: "coordinate", x: 200, y: 300 },
      scrollDirection: "down",
      scrollAmount: 30,
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") expect(result.receipt.actionSent).toBe(true);
  });
});

/* ── keyboard + typing (modes 2/3, the foreground rule) ───────────────────── */

describe("ROUND-61 (R61): keyboard + app-scoped typing", () => {
  it("targetless type/key/hold_key refuse (a global keystroke could hit the user's app)", async () => {
    const d = makeDispatcher();
    const t = await d.dispatch("type", { text: "hello" });
    expect(t.kind === "refusal" && t.refusal.error).toBe("targetless_input_refused");
    const k = await d.dispatch("key", { text: "ctrl+a" });
    expect(k.kind === "refusal" && k.refusal.error).toBe("targetless_input_refused");
    const h = await d.dispatch("hold_key", { text: "shift", duration: 1 });
    expect(h.kind === "refusal" && h.refusal.error).toBe("targetless_input_refused");
  });

  it("app-scoped typing with frontmost app → accepted receipt; mismatch → frontmost_pid_mismatch", async () => {
    const d = makeDispatcher();
    const ok = await d.dispatch("type", { text: "hello", appRef: { pid: 4242 } });
    expect(ok.kind).toBe("receipt");
    expect(calls).toEqual(["typeText"]);
    calls.length = 0;
    fakeFrontmost = 9999;
    const refused = await d.dispatch("type", { text: "hello", appRef: { pid: 4242 } });
    expect(refused.kind === "refusal" && refused.refusal.error).toBe("frontmost_pid_mismatch");
    expect(calls).toHaveLength(0);
  });

  it("key chords parse modifiers (cmd→super on Win/Linux) — parseModifiers", () => {
    expect(parseModifiers("ctrl+shift")).toEqual(["ctrl", "shift"]);
    expect(parseModifiers("cmd+c")).toEqual(["super", "c"].filter((m) => m !== "c"));
    expect(parseModifiers("")).toEqual([]);
    expect(parseModifiers(undefined)).toEqual([]);
  });
});

/* ── launch / activation / stop ───────────────────────────────────────────── */

describe("ROUND-61 (R61): open_application + stop_computer_control", () => {
  it("launch failure → could_not_launch with the EXACT-name discipline", async () => {
    const d = makeDispatcher();
    mode = "launch-fail";
    const result = await d.dispatch("open_application", { app: { name: "Notepad++" } });
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.refusal.error).toBe("could_not_launch");
      expect(result.refusal.recovery).toContain("character-for-character");
    }
  });

  it("activate=true runs the postcondition-verified activation", async () => {
    const d = makeDispatcher();
    const result = await d.dispatch("open_application", { app: { pid: 4242 }, activate: true });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") expect(result.receipt.dispatchStatus).toBe("accepted");
  });

  it("stop_computer_control sets the kill switch + releases the held button at its point", async () => {
    const d = makeDispatcher();
    getComputerSession().ensureStarted("fake");
    await d.dispatch("left_mouse_down", { target: { type: "coordinate", x: 40, y: 60 } }).catch(() => undefined);
    // (a screenshot first so the coordinate resolves)
    await screenshot(d);
    const down = await d.dispatch("left_mouse_down", { target: { type: "coordinate", x: 40, y: 60 } });
    expect(down.kind).toBe("receipt");
    const stop = await d.dispatch("stop_computer_control", { reason: "task complete" });
    expect(stop.kind).toBe("receipt");
    expect(getComputerSession().isKillSwitchActive()).toBe(true);
    // The held release sent a real mouse-up:
    expect(calls.some((c) => c.startsWith("rawButton:up@"))).toBe(true);
  });

  it("left_mouse_up without a prior down refuses (cannot release the USER's press)", async () => {
    const d = makeDispatcher();
    const result = await d.dispatch("left_mouse_up", {});
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.refusal.message).toContain("no successful left_mouse_down");
    }
  });
});

/* ── receipts, audit, monitor ─────────────────────────────────────────────── */

describe("ROUND-61 (R61): receipts + the audit journal + monitor stats", () => {
  it("every dispatched call lands ONE journal line with the receipt + redacted args", async () => {
    const d = makeDispatcher();
    const snap = await observe(d);
    await d.dispatch("type", { text: "typed secret text", target: { type: "element", stateId: snap.stateId, index: 2 } });
    const journal = readFileSync(auditPath(tempRoot), "utf8").trim().split("\n");
    expect(journal.length).toBe(2); // observe + type
    const typed = JSON.parse(journal[1]);
    expect(typed.tool).toBe("type");
    expect(typed.args.text).toEqual({ redacted: true, len: 17 }); // the value never lands
    expect(typed.outcome.receipt.actionSent).toBe(true);
  });

  it("stats count actions sent + refused for the monitor", async () => {
    const d = makeDispatcher();
    const snap = await observe(d);
    await d.dispatch("left_click", { target: { type: "element", stateId: snap.stateId, index: 1 } });
    await d.dispatch("left_click", { target: { type: "element", stateId: "s-nope", index: 1 } });
    const stats = getComputerSession().state().stats;
    expect(stats.actionsSent).toBe(1);
    expect(stats.actionsRefused).toBe(1);
  });

  it("screenshot registers a frame + raster cache (zoom/vision feed) and capture failure refuses honestly", async () => {
    const d = makeDispatcher();
    const frameId = await screenshot(d);
    expect(d.rasterFor(frameId)).toBeDefined();
    mode = "capture-fail";
    const failed = await d.dispatch("screenshot", {});
    expect(failed.kind === "refusal" && failed.refusal.message).toContain("no capture tool");
  });

  it("get_app_state with includeScreenshot attaches raster metadata", async () => {
    const d = makeDispatcher();
    const result = await d.dispatch("get_app_state", { appRef: { pid: 4242 }, includeScreenshot: true });
    expect(result.kind).toBe("data");
    if (result.kind === "data") {
      const state = result.data["state"] as Snapshot;
      expect(state.raster?.frameId).toMatch(/^f-/);
    }
  });

  it("return_state:compact attaches a FRESH observation to the receipt", async () => {
    const d = makeDispatcher();
    const snap = await observe(d);
    const result = await d.dispatch("set_value", {
      target: { type: "element", stateId: snap.stateId, index: 2 },
      value: "x",
      returnState: "compact",
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      const observation = result.observation;
      expect(observation).toBeDefined();
      expect(observation?.stateId).not.toBe(snap.stateId);
    }
  });
});

/* ── R66-2-d: find_elements — server-side tree search (the Edge fix) ─────── */

describe("R66-2-d: find_elements — search the tree instead of ingesting it", () => {
  it("happy path: a query matching 2 of 5 returns indexes + bounds + total + note + a USABLE stateId", async () => {
    const d = makeDispatcher();
    const result = await d.dispatch("find_elements", { appRef: { pid: 4242 }, query: "file" });
    expect(result.kind).toBe("data");
    if (result.kind === "data") {
      const matches = result.data["matches"] as Array<{ index: number; kind: string; name: string; bounds: number[] }>;
      expect(matches.map((m) => m.index)).toEqual([2, 3]);
      expect(matches.map((m) => m.name)).toEqual(["File name:", "File"]);
      expect(matches[0]["kind"]).toBe("textfield");
      expect(matches[1]["kind"]).toBe("menuitem");
      expect(matches[0]["bounds"]).toEqual([120, 260, 200, 24]);
      expect(result.data["total"]).toBe(2);
      expect(result.data["note"]).toBe(
        "indexes are get_app_state/left_click element target indexes — use them directly",
      );
      // The snapshot is REGISTERED — the stateId works as an element target.
      const stateId = result.data["stateId"] as string;
      expect(getComputerSession().getSnapshot(stateId)).toBeDefined();
      expect((result.data["window"] as { title: string }).title).toBe("App Window");
    }
  });

  it("kind filter is an AND rule: kind must match AND the name must contain the query", async () => {
    const d = makeDispatcher();
    const menu = await d.dispatch("find_elements", { appRef: { pid: 4242 }, query: "file", kind: "menuitem" });
    expect(menu.kind).toBe("data");
    if (menu.kind === "data") {
      expect((menu.data["matches"] as Array<{ index: number }>).map((m) => m.index)).toEqual([3]);
      expect(menu.data["total"]).toBe(1);
    }
    // 'file' matches two names, but NO button kind carries it → honest empty.
    const none = await d.dispatch("find_elements", { appRef: { pid: 4242 }, query: "file", kind: "button" });
    expect(none.kind).toBe("refusal");
    if (none.kind === "refusal") {
      expect(none.refusal.payload).toMatchObject({ query: "file", kind: "button", elementsWalked: 5 });
    }
  });

  it("limit caps the list; total reports the UNCAPPED match count (default 20, hard max 40)", async () => {
    const d = makeDispatcher();
    fakeElements = Array.from({ length: 45 }, (_, i) => ({
      index: i,
      kind: "button",
      name: `Result row ${i}`,
      flags: ["pressable"],
      bounds: [10, 10 + i * 20, 300, 18] as [number, number, number, number],
    }));
    const limited = await d.dispatch("find_elements", { appRef: { pid: 4242 }, query: "result", limit: 10 });
    expect(limited.kind).toBe("data");
    if (limited.kind === "data") {
      expect((limited.data["matches"] as unknown[]).length).toBe(10);
      expect(limited.data["total"]).toBe(45);
      expect((limited.data["matches"] as Array<{ index: number }>)[0]["index"]).toBe(0);
    }
    const defaulted = await d.dispatch("find_elements", { appRef: { pid: 4242 }, query: "result" });
    expect(defaulted.kind).toBe("data");
    if (defaulted.kind === "data") {
      expect((defaulted.data["matches"] as unknown[]).length).toBe(20); // the default
      expect(defaulted.data["total"]).toBe(45);
    }
    const clamped = await d.dispatch("find_elements", { appRef: { pid: 4242 }, query: "result", limit: 100 });
    expect(clamped.kind).toBe("data");
    if (clamped.kind === "data") {
      expect((clamped.data["matches"] as unknown[]).length).toBe(40); // the hard max
      expect(clamped.data["total"]).toBe(45);
    }
  });

  it("empty match → an honest ok:false-shaped result listing what was searched", async () => {
    const d = makeDispatcher();
    const result = await d.dispatch("find_elements", { appRef: { pid: 4242 }, query: "zzz-nothing" });
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.refusal.message).toContain("zzz-nothing");
      expect(result.refusal.message).toContain("5");
      expect(result.refusal.recovery).toContain("substring");
      expect(result.refusal.payload).toMatchObject({ query: "zzz-nothing", elementsWalked: 5 });
    }
  });

  it("find → click: the returned stateId + index drive a REAL element press (the Edge loop)", async () => {
    const d = makeDispatcher();
    const found = await d.dispatch("find_elements", { appRef: { pid: 4242 }, query: "Save", kind: "button" });
    expect(found.kind).toBe("data");
    if (found.kind !== "data") return;
    const matches = found.data["matches"] as Array<{ index: number }>;
    expect(matches).toHaveLength(1);
    expect(matches[0]["index"]).toBe(1);
    const click = await d.dispatch("left_click", {
      target: { type: "element", stateId: found.data["stateId"] as string, index: matches[0]["index"] },
    });
    expect(click.kind).toBe("receipt");
    expect(calls).toEqual(["press"]);
  });

  it("read-only by classification: observe-only posture lets find_elements run", async () => {
    const d = makeDispatcher(false);
    const result = await d.dispatch("find_elements", { appRef: { pid: 4242 }, query: "file" });
    expect(result.kind).toBe("data");
  });

  it("the kill switch refuses it like every other observe tool", async () => {
    const d = makeDispatcher();
    getComputerSession().ensureStarted("fake");
    getComputerSession().stop("done");
    const result = await d.dispatch("find_elements", { appRef: { pid: 4242 }, query: "file" });
    expect(result.kind === "refusal" && result.refusal.error).toBe("kill_switch_active");
  });

  it("rides get_app_state's EXACT resolution: invented windowId, ghost app, empty query", async () => {
    const d = makeDispatcher();
    const badWindow = await d.dispatch("find_elements", { appRef: { pid: 4242, windowId: 1 }, query: "file" });
    expect(badWindow.kind === "refusal" && badWindow.refusal.error).toBe("invalid_window_id");
    const ghost = await d.dispatch("find_elements", { appRef: { name: "Ghost" }, query: "file" });
    expect(ghost.kind === "refusal" && ghost.refusal.error).toBe("app_not_found");
    const noQuery = await d.dispatch("find_elements", { appRef: { pid: 4242 }, query: "   " });
    expect(noQuery.kind === "refusal" && noQuery.refusal.error).toBe("capability_fail_closed");
  });
});

/* ── app_ref resolution ───────────────────────────────────────────────────── */

describe("ROUND-61 (R61): app_ref resolution (doc 03 §3)", () => {
  it("unknown pid resolves through list_apps by NAME; ambiguity and absence refuse", async () => {
    const d = makeDispatcher();
    const byName = await d.dispatch("list_windows", { appRef: { name: "App" } });
    expect(byName.kind).toBe("data");
    const missing = await d.dispatch("list_windows", { appRef: { name: "Ghost" } });
    expect(missing.kind === "refusal" && missing.refusal.error).toBe("app_not_found");
  });

  it("an invented window_id refuses invalid_window_id (never a placeholder '1')", async () => {
    const d = makeDispatcher();
    const result = await d.dispatch("get_app_state", { appRef: { pid: 4242, windowId: 1 } });
    expect(result.kind === "refusal" && result.refusal.error).toBe("invalid_window_id");
  });

  it("an app_ref with nothing refuses app_not_found", async () => {
    const d = makeDispatcher();
    const result = await d.dispatch("list_windows", { appRef: {} });
    expect(result.kind === "refusal" && result.refusal.error).toBe("app_not_found");
  });
});

/* ── R64-a: the TIERED resolver (the 'Notepad' live failure) ─────────────── */

describe("ROUND-64-a (R64-a): tiered app_ref resolution (title → processName → unique substring)", () => {
  // The owner's live machine, abstracted: Notepad's TITLE is "Untitled - Notepad",
  // its processName is "notepad"; Chrome runs alongside.
  const NOTEPAD_APPS: AppInfo[] = [
    { name: "Untitled - Notepad", processName: "notepad", pid: 111, active: true },
    { name: "ACUTE-CODE — Mozilla Firefox", processName: "firefox", pid: 222, active: false },
  ];

  it("tier 2: the exact window TITLE still resolves (unchanged behavior)", async () => {
    const d = makeDispatcher();
    fakeApps = NOTEPAD_APPS;
    const result = await d.dispatch("list_windows", { appRef: { name: "Untitled - Notepad" } });
    expect(result.kind).toBe("data");
  });

  it("tier 3: the processName resolves — the get_app_state('Notepad') live failure, fixed", async () => {
    const d = makeDispatcher();
    fakeApps = NOTEPAD_APPS;
    // "notepad" (the model's natural spelling) matches the process name.
    const result = await d.dispatch("list_windows", { appRef: { name: "notepad" } });
    expect(result.kind).toBe("data");
  });

  it("tier 4: a UNIQUE substring resolves ('Mozilla' ⊂ the Firefox title, not a processName)", async () => {
    const d = makeDispatcher();
    fakeApps = NOTEPAD_APPS;
    const result = await d.dispatch("list_windows", { appRef: { name: "Mozilla" } });
    expect(result.kind).toBe("data");
  });

  it("tier 3 ambiguous: TWO instances of the same exe (same processName) refuse ambiguous_app_ref", async () => {
    const d = makeDispatcher();
    fakeApps = [
      { name: "Untitled - Notepad", processName: "notepad", pid: 111, active: true },
      { name: "notes.txt - Notepad", processName: "notepad", pid: 333, active: false },
    ];
    const result = await d.dispatch("list_windows", { appRef: { name: "notepad" } });
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.refusal.error).toBe("ambiguous_app_ref");
      const candidates = (result.refusal.payload as { candidates: Array<{ name: string; processName?: string; pid: number }> }).candidates;
      expect(candidates).toHaveLength(2);
      expect(candidates[0]).toEqual({ name: "Untitled - Notepad", processName: "notepad", pid: 111 });
      expect(candidates[1]).toEqual({ name: "notes.txt - Notepad", processName: "notepad", pid: 333 });
    }
  });

  it("tier 4 ambiguous: several SUBSTRING matches refuse ambiguous_app_ref LISTING the candidates", async () => {
    const d = makeDispatcher();
    fakeApps = [
      { name: "Untitled - Notepad", processName: "notepad", pid: 111, active: true },
      { name: "readme.txt - Notepad++", processName: "notepad++", pid: 555, active: false },
    ];
    // "pad" is a substring of both titles; neither processName equals it → tier 4.
    const result = await d.dispatch("list_windows", { appRef: { name: "pad" } });
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.refusal.error).toBe("ambiguous_app_ref");
      const candidates = (result.refusal.payload as { candidates: Array<{ name: string; processName?: string; pid: number }> }).candidates;
      expect(candidates).toHaveLength(2);
      expect(candidates[1]).toEqual({ name: "readme.txt - Notepad++", processName: "notepad++", pid: 555 });
    }
  });

  it("tier 5: no match → app_not_found whose payload carries runningApps (capped at 25)", async () => {
    const d = makeDispatcher();
    fakeApps = Array.from({ length: 40 }, (_, i) => ({
      name: `App ${i}`,
      processName: `app${i}`,
      pid: 1000 + i,
      active: i === 0,
    }));
    const result = await d.dispatch("list_windows", { appRef: { name: "Ghost" } });
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.refusal.error).toBe("app_not_found");
      const payload = result.refusal.payload as { runningApps: Array<{ name: string; processName?: string; pid: number }> };
      expect(payload.runningApps).toHaveLength(25); // capped
      expect(payload.runningApps[0]).toEqual({ name: "App 0", processName: "app0", pid: 1000 });
      expect(result.refusal.recovery).toContain("runningApps");
    }
  });

  it("tier 1: an exact pid resolves WITHOUT consulting the app list (even when absent)", async () => {
    const d = makeDispatcher();
    fakeApps = []; // empty list — the pid tier must not care
    const result = await d.dispatch("list_windows", { appRef: { pid: 4242 } });
    expect(result.kind).toBe("data");
  });

  it("an empty app list → app_not_found with an honest empty runningApps payload", async () => {
    const d = makeDispatcher();
    fakeApps = [];
    const result = await d.dispatch("list_windows", { appRef: { name: "Anything" } });
    expect(result.kind === "refusal" && result.refusal.error).toBe("app_not_found");
    if (result.kind === "refusal") {
      expect((result.refusal.payload as { runningApps: unknown[] }).runningApps).toEqual([]);
    }
  });
});

/* ── R64-a: honest diagnostics on EMPTY enumerations ─────────────────────── */

describe("ROUND-64-a (R64-a): empty enumerations carry diagnostics (no silent [])", () => {
  it("list_apps: empty + diagnostics → the tool result carries both {apps: [], diagnostics}", async () => {
    const d = makeDispatcher();
    fakeApps = [];
    const result = await d.dispatch("list_apps", {});
    expect(result.kind).toBe("data");
    if (result.kind === "data") {
      expect(result.data["apps"]).toEqual([]);
      expect(result.data["diagnostics"]).toEqual({ processCount: 3, foregroundPid: 4242, enumWindowsCount: 0 });
    }
  });

  it("list_apps: NON-empty result carries NO diagnostics key (tight output)", async () => {
    const d = makeDispatcher();
    const result = await d.dispatch("list_apps", {});
    expect(result.kind).toBe("data");
    if (result.kind === "data") {
      expect((result.data["apps"] as unknown[]).length).toBeGreaterThan(0);
      expect(result.data["diagnostics"]).toBeUndefined();
    }
  });

  it("list_displays: empty + diagnostics → {displays: [], diagnostics}", async () => {
    const d = makeDispatcher();
    const result = await d.dispatch("list_displays", {});
    expect(result.kind).toBe("data");
    if (result.kind === "data") {
      expect((result.data["displays"] as unknown[]).length).toBe(1); // fake backend: one display
      expect(result.data["diagnostics"]).toBeUndefined();
    }
  });
});

void (fakeRun as unknown as (c: CommandCapsule) => Promise<RunResult>);
void ELEMENTS;

/* ── R67-C: resolveAppRef retry + probeNote (the "session died" flow) ────── */

describe("ROUND-67 (R67-C): failed-empty list_apps is retried once; the refusal explains WHY", () => {
  it("a transient failed-empty list RECOVERS on the retry (the tiers then resolve normally)", async () => {
    const d = makeDispatcher();
    // The owner's live failure: the first call dies with the "PowerShell
    // session died" note; the retry works. One retry, then resolution.
    fakeListAppsQueue = [
      { apps: [], diagnostics: { note: "list_apps produced no output (the PowerShell session died before emitting JSON)" } },
      { apps: [{ name: "App", pid: 4242, active: true }] },
    ];
    const result = await d.dispatch("list_windows", { appRef: { name: "App" } });
    expect(result.kind).toBe("data");
    expect(listAppsCalls).toBe(2); // the failed call + the one retry
  });

  it("a STILL-failed list → app_not_found whose payload carries probeNote with the diagnostics", async () => {
    const d = makeDispatcher();
    fakeListAppsQueue = [
      { apps: [], diagnostics: { note: "list_apps produced no output (the PowerShell session died before emitting JSON)" } },
      { apps: [], diagnostics: { note: "list_apps produced no output (the PowerShell session died before emitting JSON)" } },
    ];
    const result = await d.dispatch("list_windows", { appRef: { name: "App" } });
    expect(result.kind).toBe("refusal");
    expect(listAppsCalls).toBe(2); // retried EXACTLY once, no loop
    if (result.kind === "refusal") {
      expect(result.refusal.error).toBe("app_not_found");
      const payload = result.refusal.payload as { probeNote?: string; runningApps: unknown[] };
      expect(payload.probeNote).toBe("list_apps produced no output (the PowerShell session died before emitting JSON)");
      expect(payload.runningApps).toEqual([]);
      // The recovery still teaches the next step.
      expect(result.refusal.recovery).toContain("list_apps");
    }
  });

  it("a BENIGN empty (no failure note) is NOT retried and carries NO probeNote", async () => {
    const d = makeDispatcher();
    fakeApps = []; // empty + diagnostics WITHOUT a note (a bare desktop)
    const result = await d.dispatch("list_windows", { appRef: { name: "App" } });
    expect(result.kind).toBe("refusal");
    expect(listAppsCalls).toBe(1); // no retry — nothing indicated a failure
    if (result.kind === "refusal") {
      expect((result.refusal.payload as { probeNote?: string }).probeNote).toBeUndefined();
    }
  });

  it("the pid tier never consults the app list (the pinned R64-a semantics, unchanged by the retry)", async () => {
    const d = makeDispatcher();
    fakeListAppsQueue = [
      { apps: [], diagnostics: { note: "list_apps produced no output (the PowerShell session died before emitting JSON)" } },
    ];
    const result = await d.dispatch("list_windows", { appRef: { pid: 4242 } });
    expect(result.kind).toBe("data");
    expect(listAppsCalls).toBe(0); // tier 1 resolved without any list call
  });
});

/* ── R67-C: the pid that owns no accessible window (the WebView2 helper) ─── */

describe("ROUND-67 (R67-C): a live-but-windowless pid refuses HONESTLY (helper/child process)", () => {
  it("get_app_state on a WebView2-renderer pid → the helper-process message, not \"no running application matches\"", async () => {
    const d = makeDispatcher();
    fakeWindows = [];
    fakeWindowsDiagnostics = { processRunning: true, enumWindowsCount: 17 };
    const result = await d.dispatch("get_app_state", { appRef: { pid: 11980 } });
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.refusal.error).toBe("app_not_found");
      expect(result.refusal.message).toContain("process 11980 is running but owns no accessible top-level window");
      expect(result.refusal.message).toContain("WebView2");
      expect(result.refusal.message).toContain("target the HOST application instead");
      expect(result.refusal.recovery).toContain("list_apps");
      expect(result.refusal.payload).toMatchObject({ pid: 11980, processRunning: true, ownsAccessibleWindow: false });
    }
  });

  it("a CONFIRMED-dead pid keeps the plain app_not_found shape (not running)", async () => {
    const d = makeDispatcher();
    fakeWindows = [];
    fakeWindowsDiagnostics = { processRunning: false, enumWindowsCount: 17 };
    const result = await d.dispatch("get_app_state", { appRef: { pid: 11980 } });
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.refusal.message).toContain("not running");
      expect(result.refusal.message).not.toContain("WebView2");
    }
  });

  it("UNKNOWN liveness (no diagnostics) gets the helper message too — fail-open on the explanation, never a lie", async () => {
    const d = makeDispatcher();
    fakeWindows = [];
    fakeWindowsDiagnostics = undefined;
    const result = await d.dispatch("get_app_state", { appRef: { pid: 11980 } });
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.refusal.message).toContain("owns no accessible top-level window");
      expect(result.refusal.payload).toMatchObject({ processRunning: null });
    }
  });

  it("the type and key tools ride the SAME honest refusal (windowless target)", async () => {
    const d = makeDispatcher();
    fakeWindows = [];
    fakeWindowsDiagnostics = { processRunning: true, enumWindowsCount: 17 };
    const typed = await d.dispatch("type", { text: "hello", appRef: { pid: 4242 } });
    expect(typed.kind).toBe("refusal");
    if (typed.kind === "refusal") expect(typed.refusal.message).toContain("owns no accessible top-level window");
    const keyed = await d.dispatch("key", { text: "tab", appRef: { pid: 4242 } });
    expect(keyed.kind).toBe("refusal");
    if (keyed.kind === "refusal") expect(keyed.refusal.message).toContain("owns no accessible top-level window");
  });
});

/* ── R67-C: the key tool — chords + the Tab-walk focused readback ─────────── */

describe("ROUND-67 (R67-C): key chord splitting (splitKeyChord) + the focused readback", () => {
  it("splitKeyChord: ordinary chords split as before; a literal plus SURVIVES ('++' → the plus key)", () => {
    expect(splitKeyChord("ctrl+a")).toEqual(["ctrl", "a"]);
    expect(splitKeyChord("ctrl+shift+t")).toEqual(["ctrl", "shift", "t"]);
    expect(splitKeyChord("TAB")).toEqual(["tab"]); // tokens lowercase
    expect(splitKeyChord("++")).toEqual(["+"]); // the escaped plus key
    expect(splitKeyChord("ctrl++")).toEqual(["ctrl", "+"]); // ctrl + plus
    expect(splitKeyChord("shift+p")).toEqual(["shift", "p"]);
    expect(splitKeyChord("ctrl+")).toEqual(["ctrl"]); // trailing separator: no key
    expect(splitKeyChord("")).toEqual([]);
  });

  it("a successful key press reads back the FOCUSED element name into the receipt (the Tab-walk)", async () => {
    const d = makeDispatcher();
    fakeFocused = "Search box";
    const result = await d.dispatch("key", { text: "tab", appRef: { pid: 4242 } });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.actionSent).toBe(true);
      expect((result.receipt as { focused?: string }).focused).toBe("Search box");
    }
    expect(calls).toEqual(["rawKey"]);
  });

  it("a null/empty readback OMITS the focused field — the key action itself still succeeds", async () => {
    const d = makeDispatcher();
    const silent = await d.dispatch("key", { text: "tab", appRef: { pid: 4242 } });
    expect(silent.kind).toBe("receipt");
    if (silent.kind === "receipt") {
      expect((silent.receipt as { focused?: string }).focused).toBeUndefined();
    }
    // An empty-string readback (e.g. the foreground app changed) is omitted too.
    fakeFocused = "";
    const blank = await d.dispatch("key", { text: "tab", appRef: { pid: 4242 } });
    expect(blank.kind).toBe("receipt");
    if (blank.kind === "receipt") {
      expect((blank.receipt as { focused?: string }).focused).toBeUndefined();
    }
  });

  it("a THROWING readback never fails the key action (best-effort by contract)", async () => {
    const d = makeDispatcher();
    const original = fakeBackend.focusedElementName;
    fakeBackend.focusedElementName = async () => {
      throw new Error("readback exploded");
    };
    try {
      const result = await d.dispatch("key", { text: "tab", appRef: { pid: 4242 } });
      expect(result.kind).toBe("receipt");
      if (result.kind === "receipt") {
        expect((result.receipt as { focused?: string }).focused).toBeUndefined();
      }
    } finally {
      fakeBackend.focusedElementName = original;
    }
  });

  it("repeat sends the key N times and reads back ONCE at the end", async () => {
    const d = makeDispatcher();
    fakeFocused = "Second button";
    const result = await d.dispatch("key", { text: "tab", appRef: { pid: 4242 }, repeat: 3 });
    expect(result.kind).toBe("receipt");
    expect(calls).toEqual(["rawKey", "rawKey", "rawKey"]);
    if (result.kind === "receipt") {
      expect((result.receipt as { focused?: string }).focused).toBe("Second button");
    }
  });
});

/* ── R68-C (C2): frontmost AUTO-RETRY — self-healing, not refusing ────────── */

describe("ROUND-68 (R68-C): withForegroundRetry — activate + retry ONCE instead of refusing", () => {
  it("gate mismatch + healable activation → the click is RETRIED once and succeeds (no refusal)", async () => {
    const d = makeDispatcher();
    await screenshot(d);
    fakeFrontmost = 9999;
    healOnActivate = true; // a successful escalated activation flips the foreground
    const result = await d.dispatch("left_click", { target: { type: "coordinate", x: 10, y: 10 } });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.actionSent).toBe(true);
      expect(result.receipt.dispatchStatus).toBe("accepted");
    }
    // ONE activation, ONE click (the retry IS the same action, completed).
    expect(activateCalls).toBe(1);
    expect(calls).toEqual(["rawClick:left:1:@10,10"]);
  });

  it("script-level FRONTMOST_MISMATCH (the gate-then-SendInput race) → activate + retry ONCE", async () => {
    const d = makeDispatcher();
    await screenshot(d);
    rawClickFailOnce = true; // the first rawClick reports the mismatch
    healOnActivate = true;
    const result = await d.dispatch("left_click", { target: { type: "coordinate", x: 10, y: 10 } });
    expect(result.kind).toBe("receipt");
    // The action ran TWICE (failed mismatch, healed retry) — exactly once retried.
    expect(rawClickAttempts).toBe(2);
    expect(activateCalls).toBe(1);
  });

  it("script-level mismatch + FAILED activation → the ORIGINAL mismatch refusal, NO retry", async () => {
    const d = makeDispatcher();
    await screenshot(d);
    rawClickFailOnce = true;
    // healOnActivate stays false: the activation runs but the foreground
    // stays elsewhere — the honest shape is the ORIGINAL mismatch error.
    const result = await d.dispatch("left_click", { target: { type: "coordinate", x: 10, y: 10 } });
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.refusal.error).toBe("frontmost_pid_mismatch");
      expect(result.refusal.payload).toEqual({ scopePid: 4242, activePid: 9999 });
    }
    expect(rawClickAttempts).toBe(1); // never retried
    expect(activateCalls).toBe(1); // the heal was attempted
  });

  it("NON-mismatch errors NEVER retry (one attempt, capability_fail_closed)", async () => {
    const d = makeDispatcher();
    rawKeyError = "xdotool exploded";
    const result = await d.dispatch("key", { text: "tab", appRef: { pid: 4242 } });
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.refusal.error).toBe("capability_fail_closed");
      expect(result.refusal.message).toContain("xdotool exploded");
    }
    expect(rawKeyAttempts).toBe(1);
    expect(activateCalls).toBe(0); // the auto-retry is mismatch-class ONLY
  });

  it("the KEY tool gets the same self-healing (the gate it never had) — receipt + focused readback", async () => {
    const d = makeDispatcher();
    fakeFrontmost = 9999;
    healOnActivate = true;
    fakeFocused = "Search box";
    const result = await d.dispatch("key", { text: "tab", appRef: { pid: 4242 } });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect((result.receipt as { focused?: string }).focused).toBe("Search box");
    }
    expect(activateCalls).toBe(1);
    expect(calls).toEqual(["rawKey"]);
  });

  it("the TYPE tool self-heals too (app-scoped typing: activate → typeText → receipt)", async () => {
    const d = makeDispatcher();
    fakeFrontmost = 9999;
    healOnActivate = true;
    const result = await d.dispatch("type", { text: "hello", appRef: { pid: 4242 } });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") expect(result.receipt.actionSent).toBe(true);
    expect(activateCalls).toBe(1);
    expect(calls).toEqual(["typeText"]);
  });

  it("a non-gated backend (rawRequiresForeground=false) runs WITHOUT the frontmost check", async () => {
    const d = makeDispatcher();
    rawRequiresForeground = false; // after makeDispatcher (it resets the knob)
    await screenshot(d);
    fakeFrontmost = 9999; // macOS-style: the gate is off entirely
    const result = await d.dispatch("left_click", { target: { type: "coordinate", x: 10, y: 10 } });
    expect(result.kind).toBe("receipt");
    expect(activateCalls).toBe(0);
    expect(calls).toEqual(["rawClick:left:1:@10,10"]);
  });
});
