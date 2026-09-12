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
import { PNG } from "pngjs";
import { ComputerDispatcher, OBSERVATION_SETTLE_MS, parseModifiers, splitKeyChord } from "../src/computer/dispatch";
import { resetComputerSessionForTests, getComputerSession, MAX_FRAME_AGE_MS } from "../src/computer/session";
import { resetFramehashCacheForTests } from "../src/computer/framehash";
import type { CuaBackend, CommandCapsule, HitElement, ListAppsResult, ListWindowsResult, RunCommand, RunResult } from "../src/computer/backends/interface";
import type { Receipt, Snapshot, WindowInfo, AppInfo } from "../src/computer/types";
import { auditPath, resetAuditForTests } from "../src/computer/audit";
// R93: the REAL migration-0034 schema for the element-map seam tests.
import { openDatabase, type SqliteDatabase } from "../src/storage/db";

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
/** R69 (task 4-c-2): the scriptable hit-test result (null = miss) — the
 * hitElementName receipt pins drive it. */
let fakeHit: HitElement | null = null;
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
/** R69 (task 4-c-2): flip the fake app's window title when the next element
 * press runs — scripts a mid-action title change (titleChanged:true). */
let fakeTitleFlipOnClick = false;
/** R66-2-d: find_elements tests may swap the fake snapshot's element list
 * (makeDispatcher resets it to the default 5-element table). */
let fakeElements: Snapshot["elements"] | null = null;
/** R93: the fake element map's DATABASE (null = the db-less dispatcher —
 * every pre-R93 test's default: no scan registration, no mapDelta). */
let fakeMapDb: SqliteDatabase | null = null;

/* ── R69 (task 4-c-1): REAL synthetic PNGs for the frame-intelligence paths
 * ── ──────────────────────────────────────────────────────────────────────────
 * The legacy fixtures ("fakepng"/"aa==") are deliberately NOT valid PNGs:
 * every hash-based path degrades honestly on them (the fallback pins).
 * The tests below queue REAL 128×128 PNGs — one per capture call, shifted
 * off the queue — so the auto-refresh comparisons and the spam guard see
 * actual pixels. */
let fakeCaptureQueue: string[] = [];
let fakeDisplaySize = { width: 1920, height: 1080 };

/** A grayscale PNG from a per-pixel value function (pngjs). */
function makePng(w: number, h: number, fn: (x: number, y: number) => number): string {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = fn(x, y);
      const i = (y * w + x) * 4;
      png.data[i] = v;
      png.data[i + 1] = v;
      png.data[i + 2] = v;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png).toString("base64");
}

/** 128×128 horizontal gradient — the R69 test "screen". */
const PNG_BASE = makePng(128, 128, (x) => Math.round((x / 127) * 255));
/** The screen with a big change in the top-left quadrant (far from (96,96)). */
const PNG_FAR = makePng(128, 128, (x, y) => (x < 64 && y < 64 ? 255 : Math.round((x / 127) * 255)));
/** The far change PLUS the whole target region [48,128)² overwritten. */
const PNG_NEAR = makePng(128, 128, (x, y) => (x < 64 && y < 64) || (x >= 48 && y >= 48) ? 255 : Math.round((x / 127) * 255));

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
  hitTest: async () => fakeHit,
  focusedElementName: async () => fakeFocused,
  pressElement: async (_run, _pid, _window, _element) => {
    calls.push("press");
    if (fakeTitleFlipOnClick) fakeApps = [{ name: "New Page — App", pid: 4242, active: true }];
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
      : {
          pngBase64: fakeCaptureQueue.length > 0 ? fakeCaptureQueue.shift()! : Buffer.from("fakepng").toString("base64"),
          width: fakeDisplaySize.width,
          height: fakeDisplaySize.height,
          scale: 1,
          origin: { x: 0, y: 0 },
        },
  captureRegion: async (_run, region) =>
    mode === "capture-fail"
      ? { error: "no capture tool" }
      : {
          pngBase64: fakeCaptureQueue.length > 0 ? fakeCaptureQueue.shift()! : "aa==",
          width: region.w,
          height: region.h,
          scale: 1,
          origin: { x: region.x, y: region.y },
        },
  cursorPosition: async () => ({ x: 5, y: 6 }),
  readClipboard: async () => "clip",
  writeClipboard: async () => {
    calls.push("writeClipboard");
    return { ok: true };
  },
  probePermissions: async () => ({ accessibility: "granted", screenCapture: "granted", backendKind: "fake" }),
  // R93 (§2.5): the window-placement contract (backends/interface.ts) —
  // recorded like every other backend call for the placement-tool pins.
  moveWindow: async (_run, windowId, x, y) => {
    calls.push(`moveWindow:${windowId}@${x},${y}`);
    return { ok: true };
  },
  setWindowState: async (_run, windowId, state) => {
    calls.push(`setWindowState:${windowId}:${state}`);
    return { ok: true };
  },
  focusWindow: async (_run, windowId) => {
    calls.push(`focusWindow:${windowId}`);
    return { ok: true };
  },
};

function makeDispatcher(allowMutations = true, mapDb?: SqliteDatabase): ComputerDispatcher {
  resetComputerSessionForTests();
  resetAuditForTests(tempRoot);
  capsules.length = 0;
  calls.length = 0;
  mode = "ok";
  fakeFrontmost = 4242;
  rawRequiresForeground = true;
  fakeApps = [{ name: "App", pid: 4242, active: true }];
  fakeElements = null;
  fakeMapDb = mapDb ?? null;
  fakeListAppsQueue = [];
  listAppsCalls = 0;
  fakeWindows = [
    { windowId: 77, title: "App Window", bounds: [10, 20, 800, 600] as [number, number, number, number], main: true, focused: true },
  ];
  fakeWindowsDiagnostics = undefined;
  fakeFocused = null;
  fakeHit = null;
  healOnActivate = false;
  activateCalls = 0;
  rawKeyAttempts = 0;
  rawKeyFailOnce = false;
  rawClickAttempts = 0;
  rawClickFailOnce = false;
  rawKeyError = null;
  fakeTitleFlipOnClick = false;
  fakeCaptureQueue = [];
  fakeDisplaySize = { width: 1920, height: 1080 };
  resetFramehashCacheForTests();
  const d = new ComputerDispatcher({
    backend: fakeBackend,
    run: fakeRun,
    root: tempRoot,
    allowMutations,
    // R93: the element-map db rides the dispatcher when the test passes one
    // (scan registration + mapDelta + relocation-DB + app_profile).
    ...(fakeMapDb !== null ? { db: fakeMapDb, sessionId: "test-session" } : {}),
  });
  // R69 (4-c-2): zero the post-action settle so hundreds of dispatches
  // don't each pay the real 600ms — the OBSERVATION_SETTLE_MS pin below
  // asserts the production default separately.
  d.observationSettleMs = 0;
  return d;
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

  it("right_click on a has_menu element → performAction Expand; without has_menu → R69: raw right-click at the element CENTER (the fail-closed cell is gone)", async () => {
    const d = makeDispatcher();
    const snap = await observe(d);
    const menu = await d.dispatch("right_click", { target: { type: "element", stateId: snap.stateId, index: 3 } });
    expect(menu.kind).toBe("receipt");
    expect(calls).toEqual(["performAction"]);
    // A fresh snapshot; index 1 (Save — no has_menu) now routes like
    // left_click's event path: bounds → center → RAW right-click.
    const snap2 = await observe(d);
    fakeCaptureQueue = [PNG_BASE];
    const bare = await d.dispatch("right_click", { target: { type: "element", stateId: snap2.stateId, index: 1 } });
    expect(bare.kind).toBe("receipt");
    expect(calls).toEqual(["performAction", "rawClick:right:1:@140,215"]);
    if (bare.kind === "receipt") {
      // The element's name rides the receipt (the model learns what it clicked).
      expect(bare.receipt.hitElementName).toBe("Save");
      expect(bare.receipt.actionSent).toBe(true);
    }
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

  it("an AGED frame with an UNHASHABLE legacy fixture falls back to frame_stale (R69: the refresh ran but could not verify — the failure signal is never lost)", async () => {
    const d = makeDispatcher();
    // The legacy fake capture ("fakepng") is not a real PNG: the R69
    // auto-refresh path runs, the hashes come back null, and the honest
    // fallback is the OLD frame_stale shape (see the R69 describe below for
    // the REAL-PNG refresh paths: proceed / frame_changed).
    const frameId = await screenshot(d);
    const frame = getComputerSession().getFrame(frameId)!;
    frame.capturedAt = Date.now() - (MAX_FRAME_AGE_MS + 1000);
    const result = await d.dispatch("left_click", { target: { type: "coordinate", x: 10, y: 10 } });
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.refusal.error).toBe("frame_stale");
      expect(result.refusal.message).toContain("could not be perceptually verified");
    }
    expect(calls).toHaveLength(0); // nothing was sent
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

  it("return_state 'full' attaches a FRESH UIA observation; 'compact' (R69) is the raster observation; 'none' skips both", async () => {
    const d = makeDispatcher();
    const snap = await observe(d);
    // FULL keeps the R61 UIA compose (get_app_state snapshot in-reply).
    const full = await d.dispatch("set_value", {
      target: { type: "element", stateId: snap.stateId, index: 2 },
      value: "x",
      returnState: "full",
    });
    expect(full.kind).toBe("receipt");
    if (full.kind === "receipt") {
      const observation = full.observation;
      expect(observation).toBeDefined();
      expect(observation?.stateId).not.toBe(snap.stateId);
      // 'full' skips the raster auto-observation (one observation per call).
      expect(full.receipt.observation).toBeUndefined();
    }
    // COMPACT (the new default semantics for the mutating tools) is the
    // post-action raster observation — no UIA compose runs.
    const snap2 = await observe(d);
    fakeCaptureQueue = [PNG_BASE];
    const compact = await d.dispatch("set_value", {
      target: { type: "element", stateId: snap2.stateId, index: 2 },
      value: "y",
      returnState: "compact",
    });
    expect(compact.kind).toBe("receipt");
    if (compact.kind === "receipt") {
      expect(compact.observation).toBeUndefined(); // no Snapshot ride-along
      expect(compact.receipt.observation).toBeDefined();
      expect((compact.receipt.observation as { frameId?: string }).frameId).toBe("f-1");
    }
    // NONE skips everything — no capture, no compose, no observation.
    const snap3 = await observe(d);
    const none = await d.dispatch("set_value", {
      target: { type: "element", stateId: snap3.stateId, index: 2 },
      value: "z",
      returnState: "none",
    });
    expect(none.kind).toBe("receipt");
    if (none.kind === "receipt") {
      expect(none.observation).toBeUndefined();
      expect(none.receipt.observation).toBeUndefined();
    }
    expect(fakeCaptureQueue).toEqual([]); // the compact call consumed THE one capture
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

/* ── R69 (task 4-c-1): STALE-FRAME AUTO-REFRESH ──────────────────────────────
 * The owner's #1 reported UX failure: screenshot → zoom (slow vision
 * roundtrip) → click → frame_stale → screenshot → … loop. Aged frames no
 * longer hard-fail for the coordinate-anchored pointer tools: dispatch
 * re-captures the frame's coverage, registers the fresh frame (provenance
 * "auto_refresh" — zoomable immediately), and compares perceptual hashes:
 * full-frame Hamming ≤ 8 → proceed (screenStable); else the target region
 * (±48px box around the point) ≤ 6 → proceed (targetRegionStable); else the
 * NEW frame_changed refusal carrying refreshFrameId. A failed refresh
 * capture falls back to frame_stale. Driven with REAL synthetic PNGs (the
 * queue), aged by rewinding capturedAt. */
describe("R69 (4-c-1): stale-frame AUTO-REFRESH — the screenshot→zoom→click loop fix", () => {
  /** Screenshot a REAL 128×128 PNG from the queue, then age its frame. */
  async function agedFrame(d: ComputerDispatcher, png: string): Promise<string> {
    fakeCaptureQueue = [png];
    fakeDisplaySize = { width: 128, height: 128 };
    const frameId = await screenshot(d);
    const frame = getComputerSession().getFrame(frameId)!;
    frame.capturedAt = Date.now() - (MAX_FRAME_AGE_MS + 1000);
    return frameId;
  }

  it("(i) identical screen → the action PROCEEDS on the model's coordinates; receipt carries frameRefreshed/refreshFrameId/screenStable; the fresh frame is auto_refresh + zoomable — and the R69 observation rides too", async () => {
    const d = makeDispatcher();
    await agedFrame(d, PNG_BASE);
    // The refresh capture AND the post-action observation both return the
    // SAME screen (R69 4-c-2: the click now auto-observes).
    fakeCaptureQueue = [PNG_BASE, PNG_BASE];
    const result = await d.dispatch("left_click", { target: { type: "coordinate", x: 96, y: 96 } });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.actionSent).toBe(true);
      expect(result.receipt.frameRefreshed).toBe(true);
      expect(result.receipt.refreshFrameId).toBe("f-2");
      expect(result.receipt.screenStable).toBe(true);
      expect(result.receipt.targetRegionStable).toBeUndefined();
      // R69 (4-c-2): the post-action observation — the refresh frame IS the
      // pre-state, so the identical observation reports screenChanged:false
      // (and the coordinate click's status upgrades unverified → unchanged).
      expect(result.receipt.observation).toMatchObject({ frameId: "f-3", screenChanged: false });
      expect(result.receipt.targetVerificationStatus).toBe("unchanged");
    }
    expect(calls).toEqual(["rawClick:left:1:@96,96"]); // the model's point, mapped
    // The fresh frames are registered + cached: the model can zoom them NOW.
    const fresh = getComputerSession().getFrame("f-2")!;
    expect(fresh.provenance).toBe("auto_refresh");
    expect(getComputerSession().getFrame("f-3")?.provenance).toBe("observation");
    expect(getComputerSession().latestFrame()?.frameId).toBe("f-3");
    expect(d.rasterFor("f-2")).toBe(PNG_BASE);
    expect(d.rasterFor("f-3")).toBe(PNG_BASE);
    expect(fresh.aHash).toBeDefined();
  });

  it("(ii) screen changed FAR AWAY but the target region stable → PROCEEDS with screenStable:false + targetRegionStable:true", async () => {
    const d = makeDispatcher();
    await agedFrame(d, PNG_BASE);
    fakeCaptureQueue = [PNG_FAR]; // the top-left quadrant changed; (96,96)±48 did not
    const result = await d.dispatch("left_click", { target: { type: "coordinate", x: 96, y: 96 } });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.actionSent).toBe(true);
      expect(result.receipt.frameRefreshed).toBe(true);
      expect(result.receipt.refreshFrameId).toBe("f-2");
      expect(result.receipt.screenStable).toBe(false);
      expect(result.receipt.targetRegionStable).toBe(true);
    }
    expect(calls).toEqual(["rawClick:left:1:@96,96"]);
  });

  it("(iii) the TARGET REGION itself changed → the NEW frame_changed refusal carrying refreshFrameId (the fresh frame is registered → zoomable, one round-trip)", async () => {
    const d = makeDispatcher();
    await agedFrame(d, PNG_BASE);
    fakeCaptureQueue = [PNG_NEAR]; // far change + the whole [48,128)² region overwritten
    const result = await d.dispatch("left_click", { target: { type: "coordinate", x: 96, y: 96 } });
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.refusal.error).toBe("frame_changed");
      expect(result.refusal.payload).toMatchObject({ refreshFrameId: "f-2" });
      // The prescribed recovery: zoom the fresh frame, retry with ITS pixels.
      expect(result.refusal.recovery).toContain("fresh frame (id f-2)");
      expect(result.refusal.recovery).toContain("zoom");
    }
    expect(calls).toHaveLength(0); // nothing was sent
    // The fresh frame IS registered + cached — the model zooms it immediately.
    expect(getComputerSession().getFrame("f-2")?.provenance).toBe("auto_refresh");
    expect(getComputerSession().latestFrame()?.frameId).toBe("f-2");
    expect(d.rasterFor("f-2")).toBe(PNG_NEAR);
  });

  it("(iv) the auto-capture itself FAILS → the old frame_stale fallback (the failure signal is never lost)", async () => {
    const d = makeDispatcher();
    await agedFrame(d, PNG_BASE);
    mode = "capture-fail"; // the refresh captureRegion fails
    const result = await d.dispatch("left_click", { target: { type: "coordinate", x: 96, y: 96 } });
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.refusal.error).toBe("frame_stale");
      expect(result.refusal.message).toContain("automatic refresh capture failed");
      expect(result.refusal.payload).toEqual({ frameId: "f-1" });
    }
    expect(calls).toHaveLength(0);
  });

  it("(v) non-click coordinate tools refresh too: SCROLL on an aged stable frame proceeds with the refresh receipt", async () => {
    const d = makeDispatcher();
    await agedFrame(d, PNG_BASE);
    fakeCaptureQueue = [PNG_BASE];
    const result = await d.dispatch("scroll", {
      target: { type: "coordinate", x: 96, y: 96 },
      scrollDirection: "down",
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.frameRefreshed).toBe(true);
      expect(result.receipt.screenStable).toBe(true);
      expect(result.receipt.refreshFrameId).toBe("f-2");
    }
  });

  it("(vi) mouse_move on an aged stable frame: the refresh receipt rides the non-gated (macOS-style) path too", async () => {
    const d = makeDispatcher();
    rawRequiresForeground = false; // set after makeDispatcher (it resets the knob)
    await agedFrame(d, PNG_BASE);
    fakeCaptureQueue = [PNG_BASE];
    const result = await d.dispatch("mouse_move", { target: { type: "coordinate", x: 96, y: 96 } });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.frameRefreshed).toBe(true);
      expect(result.receipt.screenStable).toBe(true);
    }
  });

  it("(vii) drag: the FROM endpoint's stale frame refreshes; the action proceeds with the receipt fields", async () => {
    const d = makeDispatcher();
    await agedFrame(d, PNG_BASE);
    fakeCaptureQueue = [PNG_BASE];
    const result = await d.dispatch("left_click_drag", {
      fromTarget: { type: "coordinate", x: 96, y: 96 },
      to: { type: "coordinate", x: 60, y: 60 },
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.frameRefreshed).toBe(true);
      expect(result.receipt.refreshFrameId).toBe("f-2");
      expect(result.receipt.screenStable).toBe(true);
    }
  });

  it("(viii) set_value (focus-gated, spec-excluded) KEEPS the hard frame_stale fail — no auto-refresh, no capture", async () => {
    const d = makeDispatcher();
    await agedFrame(d, PNG_BASE);
    fakeCaptureQueue = [PNG_BASE];
    const result = await d.dispatch("set_value", {
      target: { type: "coordinate", x: 96, y: 96 },
      value: "x",
    });
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") expect(result.refusal.error).toBe("frame_stale");
    // No refresh capture was consumed (the queue is untouched, no new frame).
    expect(fakeCaptureQueue).toEqual([PNG_BASE]);
    expect(getComputerSession().latestFrame()?.frameId).toBe("f-1");
    expect(calls).toHaveLength(0);
  });

  it("(ix) FRESH frames never refresh — an in-age click sends no refresh capture, but the R69 observation still fires", async () => {
    const d = makeDispatcher();
    fakeCaptureQueue = [PNG_BASE, PNG_BASE];
    fakeDisplaySize = { width: 128, height: 128 };
    await screenshot(d);
    const result = await d.dispatch("left_click", { target: { type: "coordinate", x: 96, y: 96 } });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.frameRefreshed).toBeUndefined();
      expect(result.receipt.refreshFrameId).toBeUndefined();
      // No refresh — but the post-action observation captured f-2.
      expect(result.receipt.observation).toMatchObject({ frameId: "f-2", screenChanged: false });
      expect(result.receipt.targetVerificationStatus).toBe("unchanged");
    }
    expect(getComputerSession().getFrame("f-2")?.provenance).toBe("observation");
    expect(getComputerSession().latestFrame()?.frameId).toBe("f-2");
  });
});

/* ── R69 (task 4-c-1): the SCREENSHOT-SPAM GUARD ─────────────────────────────
 * The #2 reported failure: the model re-capturing an identical screen in a
 * loop. The 3rd consecutive model-initiated capture whose full-frame aHash
 * is ≤ 4 bits from the previous registered raster (no intervening mutating
 * action) is refused screen_unchanged BEFORE registration. Resets: any
 * mutating dispatch, a changed capture, a foreground-app change. */
describe("R69 (4-c-1): the SCREENSHOT-SPAM GUARD (screen_unchanged)", () => {
  it("2 identical captures OK; the 3rd is refused with the code + the teaching guidance; the raster is NOT registered", async () => {
    const d = makeDispatcher();
    fakeDisplaySize = { width: 128, height: 128 };
    fakeCaptureQueue = [PNG_BASE, PNG_BASE, PNG_BASE, PNG_BASE];
    const first = await d.dispatch("screenshot", {});
    expect(first.kind).toBe("data"); // baseline (no previous raster to compare)
    const second = await d.dispatch("screenshot", {});
    expect(second.kind).toBe("data"); // 1st consecutive identical — allowed
    const third = await d.dispatch("screenshot", {});
    expect(third.kind).toBe("refusal");
    if (third.kind === "refusal") {
      expect(third.refusal.error).toBe("screen_unchanged");
      expect(third.refusal.message).toContain("3 identical frames");
      // The three prescribed alternatives, verbatim shape.
      expect(third.refusal.recovery).toContain("act (click/type/scroll");
      expect(third.refusal.recovery).toContain("wait()");
      expect(third.refusal.recovery).toContain("find_elements");
    }
    // NOT registered / NOT cached: f-3 is never created (the refused capture
    // registered nothing — the raster is identical anyway).
    expect(getComputerSession().latestFrame()?.frameId).toBe("f-2");
    expect(d.rasterFor("f-3")).toBeUndefined();
  });

  it("the guard STAYS saturated: a 4th identical capture also refuses (heeding a reset condition is required)", async () => {
    const d = makeDispatcher();
    fakeDisplaySize = { width: 128, height: 128 };
    fakeCaptureQueue = [PNG_BASE, PNG_BASE, PNG_BASE, PNG_BASE, PNG_BASE];
    await d.dispatch("screenshot", {});
    await d.dispatch("screenshot", {});
    expect((await d.dispatch("screenshot", {})).kind).toBe("refusal");
    const fourth = await d.dispatch("screenshot", {});
    expect(fourth.kind).toBe("refusal");
    if (fourth.kind === "refusal") expect(fourth.refusal.error).toBe("screen_unchanged");
  });

  it("RESET after a mutating action: the counter starts over (act → observe is legitimate)", async () => {
    const d = makeDispatcher();
    fakeDisplaySize = { width: 128, height: 128 };
    fakeCaptureQueue = [PNG_BASE, PNG_BASE, PNG_BASE, PNG_BASE, PNG_BASE];
    await d.dispatch("screenshot", {});
    await d.dispatch("screenshot", {}); // counter = 1
    // A mutating dispatch (write_clipboard — no frame needed) resets.
    const mutated = await d.dispatch("write_clipboard", { text: "x" });
    expect(mutated.kind).toBe("receipt");
    const third = await d.dispatch("screenshot", {});
    expect(third.kind).toBe("data"); // the run restarts at length 1 — allowed
    expect(getComputerSession().getFrame("f-3")).toBeDefined(); // it registered
  });

  it("RESET after a CHANGED capture (Hamming > 4 — the screen moved)", async () => {
    const d = makeDispatcher();
    fakeDisplaySize = { width: 128, height: 128 };
    fakeCaptureQueue = [PNG_BASE, PNG_BASE, PNG_BASE, PNG_FAR, PNG_BASE];
    await d.dispatch("screenshot", {}); // baseline
    await d.dispatch("screenshot", {}); // counter = 1
    expect((await d.dispatch("screenshot", {})).kind).toBe("refusal"); // counter = 3 → refused
    // The screen now changes (the far quadrant flips): allowed + reset.
    const changed = await d.dispatch("screenshot", {});
    expect(changed.kind).toBe("data");
    // Identical again after the change → counter restarts at 1 — allowed.
    const after = await d.dispatch("screenshot", {});
    expect(after.kind).toBe("data");
  });

  it("RESET after a foreground-app change (pid proxy for the title change)", async () => {
    const d = makeDispatcher();
    fakeDisplaySize = { width: 128, height: 128 };
    fakeCaptureQueue = [PNG_BASE, PNG_BASE, PNG_BASE, PNG_BASE];
    await d.dispatch("screenshot", {}); // baseline, frontmost 4242
    await d.dispatch("screenshot", {}); // counter = 1
    fakeFrontmost = 5555; // the foreground app switched between captures
    const third = await d.dispatch("screenshot", {});
    expect(third.kind).toBe("data"); // reset by the app switch — allowed
    expect(getComputerSession().getFrame("f-3")?.ownerAtCapture.pid).toBe(5555);
  });

  it("AUTO-REFRESH + OBSERVATION captures never count toward the guard (internal, not model spam)", async () => {
    const d = makeDispatcher();
    fakeDisplaySize = { width: 128, height: 128 };
    // screenshot(BASE) → age → click (auto-refresh BASE + observation BASE)
    // → 2 model captures of the same screen.
    fakeCaptureQueue = [PNG_BASE, PNG_BASE, PNG_BASE, PNG_BASE, PNG_BASE];
    const frameId = await screenshot(d);
    const frame = getComputerSession().getFrame(frameId)!;
    frame.capturedAt = Date.now() - (MAX_FRAME_AGE_MS + 1000);
    const clicked = await d.dispatch("left_click", { target: { type: "coordinate", x: 96, y: 96 } });
    expect(clicked.kind).toBe("receipt"); // the auto-refresh (f-2) + observation (f-3) fired, both identical
    expect(getComputerSession().getFrame("f-2")?.provenance).toBe("auto_refresh");
    expect(getComputerSession().getFrame("f-3")?.provenance).toBe("observation");
    // Two MORE model captures of the same screen: allowed (neither internal
    // capture counted — if they had, the second one here would be refused).
    expect((await d.dispatch("screenshot", {})).kind).toBe("data");
    expect((await d.dispatch("screenshot", {})).kind).toBe("data");
    // And the NEXT identical one is the 3rd consecutive model capture → refused.
    fakeCaptureQueue = [PNG_BASE];
    const refused = await d.dispatch("screenshot", {});
    expect(refused.kind).toBe("refusal");
    if (refused.kind === "refusal") expect(refused.refusal.error).toBe("screen_unchanged");
  });

  it("unhashable legacy captures never refuse (no comparison → no false refusal)", async () => {
    const d = makeDispatcher();
    // Default queue → "fakepng" every time: 5 identical unhashable captures.
    for (let i = 0; i < 5; i++) {
      const result = await d.dispatch("screenshot", {});
      expect(result.kind).toBe("data");
    }
  });
});

/* ── R69: the guard covers ALL THREE model-capture sites ───────────────────── */
describe("R69 (4-c-1): the spam guard on ZOOM and get_app_state{includeScreenshot}", () => {
  it("zoom spam: repeated identical region captures — the 3rd consecutive identical is refused", async () => {
    const d = makeDispatcher();
    fakeDisplaySize = { width: 128, height: 128 };
    // NOTE: the fake backend's captureRegion returns the queued FULL png
    // (not a real crop), so every raster here hashes identically — the
    // counting is what's under test: screenshot (run 1), zoom (run 2),
    // zoom (run 3 → refused).
    fakeCaptureQueue = [PNG_BASE, PNG_BASE, PNG_BASE];
    await screenshot(d);
    const zoom1 = await d.dispatch("zoom", { region: [0, 0, 32, 32] });
    expect(zoom1.kind).toBe("data"); // identical to the previous raster — run 2
    const zoom2 = await d.dispatch("zoom", { region: [0, 0, 32, 32] });
    expect(zoom2.kind).toBe("refusal");
    if (zoom2.kind === "refusal") {
      expect(zoom2.refusal.error).toBe("screen_unchanged");
      // Not registered: the last frame is still the first zoom's f-2.
      expect(getComputerSession().latestFrame()?.frameId).toBe("f-2");
    }
  });

  it("get_app_state{includeScreenshot} spam: the 3rd identical window capture is refused", async () => {
    const d = makeDispatcher();
    fakeCaptureQueue = [PNG_BASE, PNG_BASE, PNG_BASE];
    const first = await d.dispatch("get_app_state", { appRef: { pid: 4242 }, includeScreenshot: true });
    expect(first.kind).toBe("data");
    const second = await d.dispatch("get_app_state", { appRef: { pid: 4242 }, includeScreenshot: true });
    expect(second.kind).toBe("data");
    const third = await d.dispatch("get_app_state", { appRef: { pid: 4242 }, includeScreenshot: true });
    expect(third.kind).toBe("refusal");
    if (third.kind === "refusal") expect(third.refusal.error).toBe("screen_unchanged");
    // Only the two allowed captures registered frames.
    expect(getComputerSession().latestFrame()?.frameId).toBe("f-2");
  });
});

/* ── R69 (task 4-c-2): AUTO-OBSERVATION RECEIPTS ─────────────────────────────
 * The #1 field failure: the model re-captured a screenshot after EVERY
 * action to see what happened (5-25s per vision round-trip). Every mutating
 * action receipt now carries the post-action observation — a fresh frame
 * (provenance "observation"), screenChanged (aHash vs the pre-action frame),
 * focusedElementName (the key tool's readback), and the frontmost app's
 * title + titleChanged. Capture failure = {captureFailed:true}, never an
 * action failure. returnState: default/"compact" IS this observation,
 * "none" skips it, "full" keeps the UIA compose. Coordinate clicks upgrade
 * targetVerificationStatus unverified → changed/unchanged; the hit-test's
 * element name rides the receipt as hitElementName. */
describe("R69 (4-c-2): AUTO-OBSERVATION RECEIPTS", () => {
  it("OBSERVATION_SETTLE_MS is 600 and the dispatcher defaults to it (the pin)", () => {
    expect(OBSERVATION_SETTLE_MS).toBe(600);
    // A raw dispatcher (not the makeDispatcher-wrapped one) carries the
    // production default; the suite's makeDispatcher zeroes it for speed.
    const raw = new ComputerDispatcher({ backend: fakeBackend, run: fakeRun, root: tempRoot });
    expect(raw.observationSettleMs).toBe(OBSERVATION_SETTLE_MS);
  });

  it("a sent action receipt carries the full observation: frame (provenance 'observation'), screenChanged, focusedElementName, activeApp, titleChanged", async () => {
    const d = makeDispatcher();
    fakeCaptureQueue = [PNG_BASE]; // the observation capture
    fakeFocused = "File name:"; // the focused readback
    const snap = await observe(d);
    const result = await d.dispatch("left_click", { target: { type: "element", stateId: snap.stateId, index: 1 } });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.actionSent).toBe(true);
      expect(result.receipt.targetVerificationStatus).toBe("matched"); // element path keeps matched
      const observation = result.receipt.observation;
      expect(observation).toBeDefined();
      expect(observation).toMatchObject({
        frameId: "f-1",
        focusedElementName: "File name:",
        activeApp: { pid: 4242, title: "App" },
        titleChanged: false,
      });
      // No pre-action frame existed → screenChanged honestly omitted.
      expect((observation as { screenChanged?: boolean }).screenChanged).toBeUndefined();
    }
    // The frame is registered as an observation + raster-cached (zoomable).
    expect(getComputerSession().getFrame("f-1")?.provenance).toBe("observation");
    expect(d.rasterFor("f-1")).toBe(PNG_BASE);
    expect(getComputerSession().latestFrame()?.frameId).toBe("f-1");
  });

  it("screenChanged TRUE (a real change) upgrades the coordinate click's status to 'changed'", async () => {
    const d = makeDispatcher();
    fakeDisplaySize = { width: 128, height: 128 };
    fakeCaptureQueue = [PNG_BASE];
    await screenshot(d); // the pre-action frame (f-1)
    fakeCaptureQueue = [PNG_FAR]; // the screen changed after the action
    const result = await d.dispatch("left_click", { target: { type: "coordinate", x: 96, y: 96 } });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.observation).toMatchObject({ frameId: "f-2", screenChanged: true });
      expect(result.receipt.targetVerificationStatus).toBe("changed");
    }
    expect(calls).toEqual(["rawClick:left:1:@96,96"]);
  });

  it("screenChanged FALSE (identical screen) upgrades the coordinate click's status to 'unchanged'", async () => {
    const d = makeDispatcher();
    fakeDisplaySize = { width: 128, height: 128 };
    fakeCaptureQueue = [PNG_BASE, PNG_BASE];
    await screenshot(d);
    const result = await d.dispatch("left_click", { target: { type: "coordinate", x: 96, y: 96 } });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.observation).toMatchObject({ frameId: "f-2", screenChanged: false });
      expect(result.receipt.targetVerificationStatus).toBe("unchanged");
    }
  });

  it("an unhashable observation (no comparable pre-state) leaves the coordinate status at 'unverified'", async () => {
    const d = makeDispatcher();
    await screenshot(d); // "fakepng" — unhashable
    const result = await d.dispatch("left_click", { target: { type: "coordinate", x: 100, y: 200 } });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      // The observation still rides (frameId + activeApp) but screenChanged
      // is honestly omitted, and no status upgrade happens on a guess.
      expect(result.receipt.observation).toMatchObject({ frameId: "f-2" });
      expect((result.receipt.observation as { screenChanged?: boolean }).screenChanged).toBeUndefined();
      expect(result.receipt.targetVerificationStatus).toBe("unverified");
    }
  });

  it("titleChanged TRUE: the frontmost title moved across the action", async () => {
    const d = makeDispatcher();
    fakeCaptureQueue = [PNG_BASE];
    const snap = await observe(d);
    // The element press flips the app's window title MID-ACTION (the
    // pre-read saw "App", the post-observation sees "New Page — App").
    fakeTitleFlipOnClick = true;
    const result = await d.dispatch("left_click", { target: { type: "element", stateId: snap.stateId, index: 1 } });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.observation).toMatchObject({
        activeApp: { pid: 4242, title: "New Page — App" },
        titleChanged: true,
      });
    }
  });

  it("capture failure → observation {captureFailed:true}; the ACTION receipt still succeeds", async () => {
    const d = makeDispatcher();
    const snap = await observe(d);
    mode = "capture-fail"; // the observation's captureDisplay fails
    const result = await d.dispatch("left_click", { target: { type: "element", stateId: snap.stateId, index: 1 } });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.actionSent).toBe(true);
      expect(result.receipt.observation).toEqual({ captureFailed: true });
    }
    expect(calls).toEqual(["press"]); // the click itself ran
  });

  it("returnState 'none' opts out entirely: no pre-title read, no capture, no observation field", async () => {
    const d = makeDispatcher();
    const snap = await observe(d);
    const listCallsBefore = listAppsCalls;
    fakeCaptureQueue = [PNG_BASE];
    const result = await d.dispatch("left_click", {
      target: { type: "element", stateId: snap.stateId, index: 1 },
      returnState: "none",
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.actionSent).toBe(true);
      expect(result.receipt.observation).toBeUndefined();
    }
    // No pre-title read happened (the listApps count is unchanged — the
    // element click path never calls listApps) and no capture was consumed.
    expect(listAppsCalls).toBe(listCallsBefore);
    expect(fakeCaptureQueue).toEqual([PNG_BASE]);
    expect(getComputerSession().latestFrame()).toBeUndefined();
  });

  it("wait() receipts report what changed while waiting (the same observation, no extra settle)", async () => {
    const d = makeDispatcher();
    fakeDisplaySize = { width: 128, height: 128 };
    fakeCaptureQueue = [PNG_BASE];
    await screenshot(d); // the pre-wait frame
    fakeCaptureQueue = [PNG_FAR]; // the screen changed during the wait
    fakeFocused = "Search";
    const result = await d.dispatch("wait", { duration: 0 });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.actionSent).toBe(false); // waiting sends nothing
      expect(result.receipt.observation).toMatchObject({
        frameId: "f-2",
        screenChanged: true,
        focusedElementName: "Search",
        activeApp: { pid: 4242, title: "App" },
        titleChanged: false,
      });
    }
    expect(getComputerSession().getFrame("f-2")?.provenance).toBe("observation");
  });

  it("the key tool's receipt keeps its own focused readback AND gains the observation", async () => {
    const d = makeDispatcher();
    fakeFocused = "File name:";
    fakeCaptureQueue = [PNG_BASE];
    const result = await d.dispatch("key", { text: "tab", appRef: { pid: 4242 } });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect((result.receipt as Receipt & { focused?: string }).focused).toBe("File name:");
      expect(result.receipt.observation).toMatchObject({ frameId: "f-1", focusedElementName: "File name:" });
    }
    expect(calls).toEqual(["rawKey"]);
  });

  it("REFUSED actions carry no observation (nothing happened)", async () => {
    const d = makeDispatcher();
    const result = await d.dispatch("left_click", { target: { type: "element", stateId: "s-nope", index: 1 } });
    expect(result.kind).toBe("refusal");
    // The pre-title read happened (the dispatch tried) but no observation
    // attached and no frame was registered.
    expect(getComputerSession().latestFrame()).toBeUndefined();
    expect(fakeCaptureQueue).toEqual([]);
  });

  it("the observation is journaled with the receipt (the audit line matches what the model got)", async () => {
    const d = makeDispatcher();
    fakeCaptureQueue = [PNG_BASE];
    const snap = await observe(d);
    await d.dispatch("left_click", { target: { type: "element", stateId: snap.stateId, index: 1 } });
    const journal = readFileSync(auditPath(tempRoot), "utf8").trim().split("\n");
    const clicked = JSON.parse(journal[journal.length - 1]);
    expect(clicked.tool).toBe("left_click");
    expect(clicked.outcome.receipt.observation.frameId).toBe("f-1");
    expect(clicked.outcome.receipt.observation.activeApp).toEqual({ pid: 4242, title: "App" });
  });
});

/* ── R69 (task 4-c-2, D5): ELEMENT middle/right click routing ──────────────── */
describe("R69 (4-c-2): element middle_click + menu-less right_click route raw at the element center", () => {
  it("middle_click on an ELEMENT target → raw middle click at the element CENTER (the old fail-closed is gone)", async () => {
    const d = makeDispatcher();
    fakeCaptureQueue = [PNG_BASE];
    const snap = await observe(d);
    const result = await d.dispatch("middle_click", { target: { type: "element", stateId: snap.stateId, index: 1 } });
    expect(result.kind).toBe("receipt");
    // Element 1 (Save): bounds [100,200,80,30] → center (140,215).
    expect(calls).toEqual(["rawClick:middle:1:@140,215"]);
    if (result.kind === "receipt") {
      expect(result.receipt.actionSent).toBe(true);
      expect(result.receipt.hitElementName).toBe("Save");
      expect(result.receipt.observation).toBeDefined();
    }
  });

  it("double_click / triple_click on ELEMENT targets STILL fail closed (no center-click semantics to map)", async () => {
    const d = makeDispatcher();
    const snap = await observe(d);
    const dbl = await d.dispatch("double_click", { target: { type: "element", stateId: snap.stateId, index: 1 } });
    expect(dbl.kind).toBe("refusal");
    if (dbl.kind === "refusal") {
      expect(dbl.refusal.error).toBe("capability_fail_closed");
      expect(dbl.refusal.message).toContain("no accessibility equivalent");
    }
    const tri = await d.dispatch("triple_click", { target: { type: "element", stateId: snap.stateId, index: 1 } });
    expect(tri.kind).toBe("refusal");
  });

  it("middle_click on an element WITHOUT bounds still fails closed honestly", async () => {
    const d = makeDispatcher();
    // A private element table with bounds stripped (never mutate the shared
    // ELEMENTS fixture — the compact buildSnapshot hands the array itself
    // to the session, so a session-side mutation would leak across tests).
    fakeElements = ELEMENTS.map((e) => ({ ...e }));
    delete fakeElements[1]!.bounds;
    const snap = await observe(d);
    const result = await d.dispatch("middle_click", { target: { type: "element", stateId: snap.stateId, index: 1 } });
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.refusal.error).toBe("capability_fail_closed");
      expect(result.refusal.message).toContain("no bounds");
    }
  });

  it("right_click element WITHOUT has_menu + strategy 'event' also routes raw (the old event-Expand oddity is gone)", async () => {
    const d = makeDispatcher();
    const snap = await observe(d);
    const result = await d.dispatch("right_click", {
      target: { type: "element", stateId: snap.stateId, index: 1 },
      strategy: "event",
    });
    expect(result.kind).toBe("receipt");
    expect(calls).toEqual(["rawClick:right:1:@140,215"]); // NOT performAction
  });
});

/* ── R69 (task 4-c-2, D3): hitElementName from the coordinate-click hit-test ── */
describe("R69 (4-c-2): the discarded hit-test now rides the receipt as hitElementName", () => {
  it("left_click coordinate: the hit element's name lands on the receipt", async () => {
    const d = makeDispatcher();
    fakeDisplaySize = { width: 128, height: 128 };
    fakeCaptureQueue = [PNG_BASE, PNG_BASE];
    await screenshot(d);
    fakeHit = { kind: "button", name: "Sign in", actionable: true };
    const result = await d.dispatch("left_click", { target: { type: "coordinate", x: 96, y: 96 } });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.hitElementName).toBe("Sign in");
    }
    expect(calls).toEqual(["rawClick:left:1:@96,96"]);
  });

  it("right_click coordinate: the hit-test result (miss or hit) is never wasted; a hit name lands on the receipt", async () => {
    const d = makeDispatcher();
    fakeDisplaySize = { width: 128, height: 128 };
    fakeCaptureQueue = [PNG_BASE, PNG_BASE];
    await screenshot(d);
    fakeHit = { kind: "edit", name: "Search", actionable: true };
    const result = await d.dispatch("right_click", { target: { type: "coordinate", x: 96, y: 96 } });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.hitElementName).toBe("Search");
    }
    expect(calls).toEqual(["rawClick:right:1:@96,96"]);
  });

  it("a hit-test MISS leaves the receipt without hitElementName (never fabricated)", async () => {
    const d = makeDispatcher();
    fakeDisplaySize = { width: 128, height: 128 };
    fakeCaptureQueue = [PNG_BASE, PNG_BASE];
    await screenshot(d);
    fakeHit = null;
    const result = await d.dispatch("left_click", { target: { type: "coordinate", x: 96, y: 96 } });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.hitElementName).toBeUndefined();
    }
  });
});

/* ── R93 (computer-use v2): the element-map seam — registration, delta, ghosts ── */

describe("R93: the element-map seam — get_app_state registers the scan; mapDelta rides the result", () => {
  it("a db-backed dispatcher: the FIRST observation counts everything new; the SECOND diffs (+new/−lost); the computer_scan history rows land with the session id", async () => {
    const db = openDatabase(join(tempRoot, "map-basic.db"));
    const d = makeDispatcher(true, db);
    const first = await observe(d);
    expect(first.mapDelta).toMatchObject({ newCount: 5, lostCount: 0, knownTotal: 5 });
    expect(first.mapDelta?.newNames).toContain("Save");
    // The scan history row (the queryable observation log).
    const scans = db.prepare(`SELECT session_id, app_name, total, new_count, lost_count FROM computer_scan ORDER BY rowid`).all() as Array<Record<string, unknown>>;
    expect(scans).toHaveLength(1);
    expect(scans[0]).toMatchObject({ session_id: "test-session", app_name: "App Window", total: 5, new_count: 5, lost_count: 0 });

    // The UI changed: "Bare" gone, "Cancel" appeared, the rest stable.
    fakeElements = [
      ...ELEMENTS.filter((e) => e.name !== "Bare"),
      { index: 5, kind: "button", name: "Cancel", flags: ["pressable"], bounds: [500, 500, 90, 30] },
    ];
    const second = await observe(d);
    expect(second.mapDelta).toMatchObject({ newCount: 1, lostCount: 1, knownTotal: 6 });
    expect(second.mapDelta?.newNames).toEqual(["Cancel"]);

    const rows = db.prepare(`SELECT app_name, window_title, COUNT(*) AS n FROM computer_element GROUP BY app_name, window_title`).all() as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ app_name: "App Window", window_title: "App Window", n: 6 });
    // The LOST row is kept (history + click stats survive a disappearance).
    const bare = db.prepare(`SELECT seen_count FROM computer_element WHERE name = 'Bare'`).get() as { seen_count: number };
    expect(bare.seen_count).toBe(1);
    db.close(); // Lesson #88: Windows EPERM if the handle outlives the test
  });

  it("a db-LESS dispatcher degrades honestly: the observation succeeds with NO mapDelta (pre-R93 shape)", async () => {
    const d = makeDispatcher();
    const snap = await observe(d);
    expect(snap.mapDelta).toBeUndefined();
    expect(snap.elements).toHaveLength(5);
  });

  it("GHOST FILTERING: a full-detail walk against a fresh raster DROPS demonstrably-empty boxes before the registry; survivors keep their walk indexes (gap-safe addressing)", async () => {
    const db = openDatabase(join(tempRoot, "map-ghost.db"));
    const d = makeDispatcher(true, db);
    fakeDisplaySize = { width: 128, height: 128 };
    fakeCaptureQueue = [PNG_BASE];
    await screenshot(d); // the live raster the rects are judged against
    // A ghost in the MIDDLE of the walk (its 2px-wide rect is FLAT on the
    // horizontal gradient) + the normal table around it.
    fakeElements = [
      ELEMENTS[0]!,
      ELEMENTS[1]!, // Save — bounds [100,200,80,30] fall OUTSIDE the 128px raster → fail-open, kept
      { index: 2, kind: "button", name: "Ghost", flags: ["pressable"], bounds: [12, 30, 2, 20] },
      ELEMENTS[3]!,
      ELEMENTS[4]!,
    ];
    const result = await d.dispatch("get_app_state", { appRef: { pid: 4242 }, detail: "full" });
    expect(result.kind).toBe("data");
    if (result.kind === "data") {
      const state = result.data["state"] as Snapshot;
      expect(state.elements.map((e) => e.name)).toEqual(["App", "Save", "File", "Bare"]);
      expect(state.mapDelta).toMatchObject({ droppedGhostCount: 1, newCount: 4 });
      // The ghost never entered the registry.
      const ghosts = db.prepare(`SELECT COUNT(*) AS n FROM computer_element WHERE name = 'Ghost'`).get() as { n: number };
      expect(ghosts.n).toBe(0);
      // The INDEX GAP is addressable: index 3 is still "File" (menuitem).
      const file = await d.dispatch("left_click", { target: { type: "element", stateId: state.stateId, index: 3 } });
      expect(file.kind).toBe("receipt");
      expect(calls).toEqual(["press"]); // the semantic press ran (File has has_menu)
    }
    db.close(); // Lesson #88: Windows EPERM if the handle outlives the test
  });

  it("the reliability fold: a SENT element press advances click_count + verify_success_count (the receipt's targetVerificationStatus is the oracle)", async () => {
    const db = openDatabase(join(tempRoot, "map-reliability.db"));
    const d = makeDispatcher(true, db);
    const snap = await observe(d);
    const click = await d.dispatch("left_click", { target: { type: "element", stateId: snap.stateId, index: 1 } });
    expect(click.kind).toBe("receipt");
    const row = db.prepare(`SELECT click_count, verify_success_count FROM computer_element WHERE app_name = 'App Window' AND name = 'Save'`).get() as Record<string, number>;
    expect(row).toEqual({ click_count: 1, verify_success_count: 1 });
    db.close(); // Lesson #88: Windows EPERM if the handle outlives the test
  });
});

/* ── R93 (§2.3): the STALE_ELEMENT relocation payload ─────────────────────── */

describe("R93: element_stale refuses WITH a relocation candidate (the one-call recovery)", () => {
  it("a MOVED element: the refusal carries relocatedIndex/relocatedName/relocatedStateId + the moved-candidate recovery text; the retry with the payload's target SUCCEEDS", async () => {
    const d = makeDispatcher();
    const snap = await observe(d);
    // The UI shifted: Save moved 30px and the walk renumbered it (index 1 →
    // 3) — exactly the case a positional retry would get wrong.
    fakeElements = [
      { ...ELEMENTS[0]!, index: 0 },
      { ...ELEMENTS[2]!, index: 1 },
      { ...ELEMENTS[3]!, index: 2 },
      { ...ELEMENTS[1]!, index: 3, bounds: [130, 230, 80, 30] },
      { ...ELEMENTS[4]!, index: 4 },
    ];
    mode = "press-stale";
    const result = await d.dispatch("left_click", { target: { type: "element", stateId: snap.stateId, index: 1 } });
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.refusal.error).toBe("element_stale");
      expect(result.refusal.payload).toMatchObject({ cause: "ui_changed", relocatedIndex: 3, relocatedName: "Save" });
      expect(result.refusal.recovery).toContain("The element may have moved");
      expect(result.refusal.recovery).toContain("Save");
      const stateId = result.refusal.payload?.["relocatedStateId"] as string;
      expect(typeof stateId).toBe("string");
      expect(result.refusal.payload?.["relocatedBecause"]).toEqual(expect.arrayContaining(["exact name", "same kind", "same category"]));
      // The one-call recovery: retry ONCE with the payload's target — no re-observe.
      mode = "ok";
      const retry = await d.dispatch("left_click", { target: { type: "element", stateId, index: 3 } });
      expect(retry.kind).toBe("receipt");
      if (retry.kind === "receipt") expect(retry.receipt.targetVerificationStatus).toBe("matched");
      // Two presses total: the stale attempt + the successful relocated retry.
      expect(calls).toEqual(["press", "press"]);
    }
  });

  it("a db-less dispatcher relocates all the same (the scoring needs no registry); no candidate above the threshold keeps the plain refusal shape", async () => {
    const d = makeDispatcher();
    const snap = await observe(d);
    // A completely different UI: nothing scores ≥ 3.0 against "Save".
    fakeElements = [
      ELEMENTS[0]!,
      { index: 1, kind: "textfield", name: "Query", flags: ["editable"], bounds: [500, 500, 200, 24] },
    ];
    mode = "press-stale";
    const result = await d.dispatch("left_click", { target: { type: "element", stateId: snap.stateId, index: 1 } });
    expect(result.kind).toBe("refusal");
    if (result.kind === "refusal") {
      expect(result.refusal.error).toBe("element_stale");
      expect(result.refusal.payload).toMatchObject({ cause: "ui_changed" });
      expect(result.refusal.payload?.["relocatedIndex"]).toBeUndefined();
      expect(result.refusal.recovery).toContain("get_app_state");
    }
  });
});

/* ── R93 (§2.5): the tree / navigation / placement surface ─────────────────── */

/** A v2 (key-carrying) element table: window → Main group → buttons. */
const KEYED_ELEMENTS: Snapshot["elements"] = [
  { index: 0, kind: "window", name: "App", flags: [], key: "w1", parentKey: null, treeDepth: 0, category: "custom" },
  { index: 1, kind: "pane", name: "Main", flags: [], key: "w1-1", parentKey: "w1", treeDepth: 1, category: "custom", interactive: false, path: "App › Main" },
  { index: 2, kind: "button", name: "Save", flags: ["pressable"], key: "w1-2", parentKey: "w1-1", treeDepth: 2, category: "button", path: "App › Main › Save", bounds: [100, 200, 80, 30] },
  { index: 3, kind: "button", name: "Cancel", flags: ["pressable"], key: "w1-3", parentKey: "w1-1", treeDepth: 2, category: "button", path: "App › Main › Cancel", bounds: [200, 200, 80, 30] },
  { index: 4, kind: "textfield", name: "Search", flags: ["editable"], key: "w1-4", parentKey: "w1", treeDepth: 1, category: "input", path: "App › Search" },
];

describe("R93: get_tree + the tree navigation tools", () => {
  it("get_tree renders the window→group→element tree (paths + categories + keys) and registers the observation (mapDelta)", async () => {
    const db = openDatabase(join(tempRoot, "map-tree.db"));
    const d = makeDispatcher(true, db);
    fakeElements = KEYED_ELEMENTS;
    const result = await d.dispatch("get_tree", { appRef: { pid: 4242 } });
    expect(result.kind).toBe("data");
    if (result.kind === "data") {
      const tree = result.data["tree"] as string;
      expect(result.data["truncated"]).toBe(false);
      expect(result.data["total"]).toBe(5);
      expect(tree).toContain('0 window/custom "App" #w1');
      expect(tree).toContain('  1 pane/custom "Main" #w1-1 (container) — App › Main');
      expect(tree).toContain('    2 button/button "Save" #w1-2 — App › Main › Save');
      expect(tree).toContain('  4 textfield/input "Search" #w1-4 — App › Search');
      expect(result.data["mapDelta"]).toMatchObject({ newCount: 5, knownTotal: 5 });
    }
    db.close(); // Lesson #88: Windows EPERM if the handle outlives the test
  });

  it("get_children / get_parent / get_subtree navigate a REGISTERED snapshot; unknown stateId and unknown key refuse honestly", async () => {
    const d = makeDispatcher();
    fakeElements = KEYED_ELEMENTS;
    const tree = await d.dispatch("get_tree", { appRef: { pid: 4242 } });
    expect(tree.kind).toBe("data");
    const stateId = (tree.kind === "data" ? tree.data["stateId"] : "") as string;

    // Children of the Main group.
    const children = await d.dispatch("get_children", { stateId, key: "w1-1" });
    expect(children.kind).toBe("data");
    if (children.kind === "data") {
      const kids = children.data["children"] as Array<{ index: number; name: string; key: string }>;
      expect(kids.map((k) => k.name)).toEqual(["Save", "Cancel"]);
      expect(children.data["count"]).toBe(2);
    }
    // The root's children.
    const rootKids = await d.dispatch("get_children", { stateId, key: "w1" });
    expect(rootKids.kind === "data" && (rootKids.data["children"] as Array<{ name: string }>).map((c) => c.name)).toEqual(["Main", "Search"]);
    // A leaf honestly reports zero children.
    const leaf = await d.dispatch("get_children", { stateId, key: "w1-2" });
    expect(leaf.kind === "data" && leaf.data["count"]).toBe(0);

    // The parent walk.
    const parent = await d.dispatch("get_parent", { stateId, key: "w1-2" });
    expect(parent.kind === "data" && (parent.data["parent"] as { name: string }).name).toBe("Main");
    const rootParent = await d.dispatch("get_parent", { stateId, key: "w1" });
    expect(rootParent.kind === "data" && rootParent.data["parent"]).toBeNull();

    // The subtree walk (relative depths, walk order).
    const subtree = await d.dispatch("get_subtree", { stateId, key: "w1-1", maxDepth: 2 });
    expect(subtree.kind === "data");
    if (subtree.kind === "data") {
      const nodes = subtree.data["subtree"] as Array<{ name: string; depth: number }>;
      expect(nodes.map((n) => [n.name, n.depth])).toEqual([["Main", 0], ["Save", 1], ["Cancel", 1]]);
      expect(subtree.data["truncated"]).toBe(false);
    }

    // The honest 404s.
    const unknownKey = await d.dispatch("get_children", { stateId, key: "w9-9" });
    expect(unknownKey.kind === "refusal" && unknownKey.refusal.error).toBe("capability_fail_closed");
    if (unknownKey.kind === "refusal") expect(unknownKey.refusal.message).toContain("w9-9");
    const unknownState = await d.dispatch("get_children", { stateId: "s-nope", key: "w1" });
    expect(unknownState.kind === "refusal" && unknownState.refusal.error).toBe("element_stale");
  });

  it("a PRE-v2 snapshot (no keys) renders an honest flat listing, never a fabricated tree; get_children then names the cause", async () => {
    const d = makeDispatcher();
    const result = await d.dispatch("get_tree", { appRef: { pid: 4242 } });
    expect(result.kind === "data");
    if (result.kind === "data") {
      const tree = result.data["tree"] as string;
      expect(tree).toContain("no hierarchy keys");
      expect(tree).toContain('0 window "App"');
      expect(tree).toContain('1 button "Save"');
    }
    const snap = await observe(d);
    const noKey = await d.dispatch("get_children", { stateId: snap.stateId, key: "w1" });
    expect(noKey.kind === "refusal" && noKey.refusal.message).toContain("no hierarchy keys");
  });

  it("get_tree without appRef defaults to the FRONTMOST app's window", async () => {
    const d = makeDispatcher();
    fakeElements = KEYED_ELEMENTS;
    const result = await d.dispatch("get_tree", {});
    expect(result.kind === "data" && result.data["window"]).toMatchObject({ title: "App Window", windowId: 77 });
  });
});

describe("R93: windows_overview + element_at + app_profile", () => {
  it("windows_overview lists every window with the frontmost-pid focused flag", async () => {
    const d = makeDispatcher();
    const result = await d.dispatch("windows_overview", {});
    expect(result.kind === "data");
    if (result.kind === "data") {
      const windows = result.data["windows"] as Array<Record<string, unknown>>;
      expect(windows).toHaveLength(1);
      expect(windows[0]).toMatchObject({ app: "App", pid: 4242, title: "App Window", windowId: 77, focused: true });
      expect(result.data["frontmostPid"]).toBe(4242);
    }
  });

  it("element_at resolves image→global through the frame registry and hit-tests (hit + honest miss + no-frame refusal)", async () => {
    const d = makeDispatcher();
    // No frame yet → the coordinate gate refuses.
    const noFrame = await d.dispatch("element_at", { x: 5, y: 5 });
    expect(noFrame.kind === "refusal" && noFrame.refusal.error).toBe("frame_stale");
    fakeDisplaySize = { width: 128, height: 128 };
    fakeCaptureQueue = [PNG_BASE];
    await screenshot(d);
    fakeHit = { kind: "button", name: "Save", actionable: true, bounds: [100, 200, 80, 30] };
    const hit = await d.dispatch("element_at", { x: 96, y: 96 });
    expect(hit.kind === "data");
    if (hit.kind === "data") {
      expect(hit.data["element"]).toMatchObject({ kind: "button", name: "Save" });
      expect(hit.data["point"]).toEqual({ x: 96, y: 96 });
    }
    fakeHit = null;
    const miss = await d.dispatch("element_at", { x: 96, y: 96 });
    expect(miss.kind === "data" && miss.data["element"]).toBeNull();
    expect(miss.kind === "data" && typeof miss.data["note"]).toBe("string");
  });

  it("app_profile: the honest empty state when the app was never observed; the learned state after observations + verified actions", async () => {
    const db = openDatabase(join(tempRoot, "map-profile.db"));
    const d = makeDispatcher(true, db);
    const empty = await d.dispatch("app_profile", { appName: "Never Seen" });
    expect(empty.kind === "data");
    if (empty.kind === "data") {
      expect(empty.data).toMatchObject({ appName: "Never Seen", observed: false, scanCount: 0, elementCount: 0, mostReliable: [] });
      expect(String(empty.data["note"])).toContain("no observation");
    }
    // Observe + act: the profile then carries the learned structure + the leader.
    const snap = await observe(d);
    await d.dispatch("left_click", { target: { type: "element", stateId: snap.stateId, index: 1 } });
    const learned = await d.dispatch("app_profile", { appName: "App Window" });
    expect(learned.kind === "data");
    if (learned.kind === "data") {
      expect(learned.data).toMatchObject({ observed: true, scanCount: 1, elementCount: 5, stableElementCount: 0 });
      expect(learned.data["windowTitles"]).toEqual(["App Window"]);
      const leaders = learned.data["mostReliable"] as Array<{ name: string; reliability: number }>;
      expect(leaders[0]).toMatchObject({ name: "Save", reliability: 1 });
    }
    db.close(); // Lesson #88: Windows EPERM if the handle outlives the test
  });

  it("app_profile without a db: the honest capability refusal (the learning layer is unavailable, observation unaffected)", async () => {
    const d = makeDispatcher();
    const result = await d.dispatch("app_profile", { appName: "App" });
    expect(result.kind === "refusal");
    if (result.kind === "refusal") {
      expect(result.refusal.error).toBe("capability_fail_closed");
      expect(result.refusal.message).toContain("no element-map database");
    }
  });
});

describe("R93: window placement (move_window / window_state / focus_window)", () => {
  it("act posture: the three tools dispatch to the backend with receipts; validation refuses honestly", async () => {
    const d = makeDispatcher();
    const move = await d.dispatch("move_window", { windowId: 77, x: 10, y: 20 });
    expect(move.kind === "receipt" && move.receipt.actionSent).toBe(true);
    const state = await d.dispatch("window_state", { windowId: 77, state: "maximize" });
    expect(state.kind === "receipt" && state.receipt.dispatchStatus).toBe("accepted");
    const focus = await d.dispatch("focus_window", { windowId: 77 });
    expect(focus.kind === "receipt" && focus.receipt.actionSent).toBe(true);
    expect(calls).toEqual(["moveWindow:77@10,20", "setWindowState:77:maximize", "focusWindow:77"]);
    const badState = await d.dispatch("window_state", { windowId: 77, state: "tile" });
    expect(badState.kind === "refusal" && badState.refusal.error).toBe("capability_fail_closed");
  });

  it("OBSERVE posture: the placement tools refuse host_policy_denied BEFORE any backend call (they are mutations)", async () => {
    const d = makeDispatcher(false);
    for (const tool of ["move_window", "window_state", "focus_window"]) {
      const result = await d.dispatch(tool, tool === "window_state" ? { windowId: 77, state: "minimize" } : { windowId: 77, x: 0, y: 0 });
      expect(result.kind === "refusal" && result.refusal.error).toBe("host_policy_denied");
    }
    expect(calls).toHaveLength(0);
  });
});
