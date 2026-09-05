/**
 * ROUND-64-a (R64-a): the WINDOWS backend command-construction tests.
 *
 * PowerShell is NEVER executed in this sandbox (headless Linux) — the
 * backend's scripts are verified BY CONSTRUCTION: the emitted capsule text
 * is pinned for the contracts that fixed the owner's live 0.63.0 failure
 * (list_apps → [], get_app_state("Notepad") → app_not_found,
 * list_displays → [] while screenshots worked):
 *   · the ONE-Add-Type preamble carrying the EnumWindows surface
 *   · the shape-aware OutJson (ConvertTo-Json -InputObject @($arr) — the
 *     PS 5.1 pipeline-unwraps-arrays root cause, never `| ConvertTo-Json`)
 *   · the deterministic wrapper shapes {"apps":[…]|"windows":[…]|
 *     "displays":[…],"diagnostics":{…}} and the STRICT JS-side parsers
 *   · the REAL single-display bounds (no fake 1920×1080 fallback)
 *   · `$pid` (a read-only automatic variable) never assigned
 * R66-2-d adds the buildSnapshot pins: the 2400-element cap + the
 * interactive-kind probe list that gates every GetCurrentPattern call (the
 * Edge walk-speed fix) + the unchanged parse path.
 * R67-C adds the capsule-transport pins (-EncodedCommand — the script rides
 * ARGV as base64 of UTF-16LE, no stdin: the "PowerShell session died before
 * emitting JSON" failure mode), the U32 guard pins ($script:U32_OK + the
 * reachable Get-Process fallback), and the SendKeys key-table pins (the
 * key "tab" typed t-a-b fix: composeSendKeysChord + rawKey's composed
 * chord + the honest meta-chord refusal).
 * The parse paths run against a fake RunCommand returning exactly what the
 * fixed PowerShell emits on Windows.
 */
import { describe, expect, it } from "vitest";
import {
  WINDOWS_PS_PROGRAM,
  WINDOWS_PS_PREAMBLE,
  composeSendKeysChord,
  windowsListAppsScript,
  windowsListWindowsScript,
  windowsListDisplaysScript,
  windowsElementActionScript,
  windowsBackend,
} from "../src/computer/backends/windows";
import type { CommandCapsule, RunCommand, RunResult } from "../src/computer/backends/interface";

type RecordingRun = RunCommand & { capsules: CommandCapsule[] };

/** A fake runner that captures every capsule and returns the given stdout. */
function fakeRun(stdout: string, code = 0): RecordingRun {
  const capsules: CommandCapsule[] = [];
  const run: RunCommand = async (capsule) => {
    capsules.push(capsule);
    return { code, stdout, stderr: "", timedOut: false } satisfies RunResult;
  };
  return Object.assign(run, { capsules }) as RecordingRun;
}

/** R67-C: decode a -EncodedCommand capsule's script back to text (base64 of
 * UTF-16LE — PowerShell's contract, inverted for content assertions). */
function decodeCapsuleScript(capsule: CommandCapsule): string {
  const i = capsule.args.indexOf("-EncodedCommand");
  expect(i).toBeGreaterThan(-1);
  expect(capsule.args[i + 1]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  return Buffer.from(capsule.args[i + 1]!, "base64").toString("utf16le");
}

/* ── the preamble: one compile, the EnumWindows surface, honest OutJson ──── */

describe("ROUND-64-a (R64-a): the shared PowerShell preamble", () => {
  it("carries EXACTLY ONE Add-Type -TypeDefinition (one csc compile per capsule)", () => {
    expect(WINDOWS_PS_PREAMBLE.split("Add-Type -TypeDefinition").length - 1).toBe(1);
  });

  it("declares the EnumWindows enumeration surface (EnumWindows, visibility, titles, class, rects)", () => {
    for (const needle of [
      "EnumWindows(EnumProc cb,IntPtr lp)",
      "IsWindowVisible(IntPtr h)",
      "GetWindowTextLength(IntPtr h)",
      "GetWindowText(IntPtr h,StringBuilder sb,int max)",
      "GetClassName(IntPtr h,StringBuilder sb,int max)",
      "GetWindowRect(IntPtr h,out RECT r)",
      "GetWindowThreadProcessId(IntPtr h,out uint pid)",
      "GetForegroundWindow()",
      "GetWindowLong(IntPtr h,int i)",
    ]) {
      expect(WINDOWS_PS_PREAMBLE).toContain(needle);
    }
  });

  it("exposes the static ListTopWindows() collector with toolwindow + zero-size + empty-title filtering", () => {
    expect(WINDOWS_PS_PREAMBLE).toContain("public static List<WINFO> ListTopWindows()");
    // WS_EX_TOOLWINDOW (GWL_EXSTYLE -20, bit 0x80) and degenerate-rect skips.
    expect(WINDOWS_PS_PREAMBLE).toContain("(GetWindowLong(h,-20)&0x00000080)!=0");
    expect(WINDOWS_PS_PREAMBLE).toContain("if(r.Right-r.Left<=0||r.Bottom-r.Top<=0)return true;");
    expect(WINDOWS_PS_PREAMBLE).toContain("if(t==null||t.Trim().Length==0)return true;");
    // Every WINFO carries hwnd + pid + title + rect — the PS side formats.
    expect(WINDOWS_PS_PREAMBLE).toContain("public struct WINFO{public long Hwnd;public uint Pid;public string Title;public int L;public int T;public int R;public int B;}");
  });

  it("is C#-5-safe for the PowerShell 5.1 CodeDom compiler (no interpolation, no null-conditional)", () => {
    expect(WINDOWS_PS_PREAMBLE).not.toContain("$\"");
    expect(WINDOWS_PS_PREAMBLE).not.toContain("?.");
    expect(WINDOWS_PS_PREAMBLE).not.toContain("nameof(");
  });

  it("OutJson is SHAPE-AWARE: lists keep the array wrapper, objects pass through, empty lists emit []", () => {
    // The root-cause fix: -InputObject @($arr) (the PIPELINE form
    // `$o | ConvertTo-Json` is what collapsed 0/1-element arrays in PS 5.1).
    expect(WINDOWS_PS_PREAMBLE).toContain("ConvertTo-Json -InputObject @($arr) -Compress -Depth 8");
    expect(WINDOWS_PS_PREAMBLE).toContain("if ($arr.Count -eq 0) { Write-Output '[]'; return }");
    // The object path (buildSnapshot's {elements} / hitTest) rides -InputObject too.
    expect(WINDOWS_PS_PREAMBLE).toContain("ConvertTo-Json -InputObject $o -Compress -Depth 8");
    // The collapsed form must be GONE.
    expect(WINDOWS_PS_PREAMBLE).not.toContain("$o | ConvertTo-Json");
  });

  it("capsule shape: -EncodedCommand carries the script as base64 UTF-16LE in ARGV — NO stdin (R67-C)", async () => {
    const run = fakeRun('{"apps":[],"diagnostics":{}}');
    await windowsBackend.listApps(run);
    expect(run.capsules).toHaveLength(1);
    const capsule = run.capsules[0];
    expect(capsule.program).toBe(WINDOWS_PS_PROGRAM);
    expect(capsule.args.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    expect(capsule.args).not.toContain("-Command");
    // The old transport died twice on the owner's machine: PS 5.1 under
    // `-Command -` reports exit 0 on aborting scripts, and the stdin write
    // is EPIPE-swallowed when the child exits early (an EMPTY script ran →
    // no stdout). The script cannot be lost in ARGV.
    expect(capsule.stdin).toBeUndefined();
    const script = decodeCapsuleScript(capsule);
    expect(script).toContain(WINDOWS_PS_PREAMBLE);
    expect(script).toContain("[U32]::ListTopWindows()");
  });

  it("R67-C: the U32 Add-Type is GUARDED — a failed compile sets $script:U32_OK instead of aborting the script", () => {
    // The owner's "the PowerShell session died before emitting JSON": under
    // $ErrorActionPreference='Stop' an unguarded Add-Type failure killed the
    // WHOLE script before the first Write-Output. The try/catch + flag is
    // the fix; SetProcessDPIAware only runs when the helper exists.
    expect(WINDOWS_PS_PREAMBLE).toContain("$script:U32_OK = $false");
    expect(WINDOWS_PS_PREAMBLE).toContain("try {");
    expect(WINDOWS_PS_PREAMBLE).toContain("  $script:U32_OK = $true");
    expect(WINDOWS_PS_PREAMBLE).toContain("} catch {");
    expect(WINDOWS_PS_PREAMBLE).toContain("  $script:U32_OK = $false");
    expect(WINDOWS_PS_PREAMBLE).toContain("if ($script:U32_OK) { [void][U32]::SetProcessDPIAware() }");
    // GetCursorPos was folded into the SAME TypeDefinition (cursorPosition
    // used to be a second Add-Type in its capsule).
    expect(WINDOWS_PS_PREAMBLE).toContain("public static extern bool GetCursorPos(out PT p);");
    expect(WINDOWS_PS_PREAMBLE).toContain("public struct PT{public int X;public int Y;}");
  });
});

/* ── the enumeration scripts ───────────────────────────────────────────────── */

describe("ROUND-64-a (R64-a): the list_apps script (EnumWindows, one app per pid)", () => {
  const script = windowsListAppsScript();

  it("groups EnumWindows output per pid with the largest titled window as name + the exe as processName", () => {
    expect(script).toContain("[U32]::ListTopWindows()");
    expect(script).toContain("processName");
    expect(script).toContain("$area = ([int]$w.R - [int]$w.L) * ([int]$w.B - [int]$w.T)");
    expect(script).toContain("if ($null -eq $cur -or $area -gt $cur.area)");
    expect(script).toContain("active = ($procId -eq $fgpid)");
  });

  it("marks active via GetForegroundWindow and resolves process names from Get-Process", () => {
    expect(script).toContain("[U32]::GetForegroundWindow()");
    expect(script).toContain("[void][U32]::GetWindowThreadProcessId($fg, [ref]$fgpid)");
    expect(script).toContain("$procs = @(Get-Process)");
    expect(script).toContain("(Get-Process -Id $procId -ErrorAction Stop).ProcessName");
  });

  it("keeps the honest Get-Process MainWindowTitle fallback when the walk throws", () => {
    expect(script).toContain("catch { $enum = $null }");
    expect(script).toContain("EnumWindows walk failed; using the Get-Process MainWindowTitle fallback");
    expect(script).toContain("if ($p.MainWindowHandle -ne 0 -and $p.MainWindowTitle)");
  });

  it("R67-C: the walk is GATED on $script:U32_OK — the fallback branch is REACHABLE when the Add-Type compile failed", () => {
    // Before R67-C the gate didn't exist because the script never GOT here:
    // the preamble's unguarded compile aborted everything. Now both the
    // foreground read and the EnumWindows walk are guarded, and the fallback
    // entries carry an honest source field.
    expect(script).toContain("if ($script:U32_OK) { try { $fg = [U32]::GetForegroundWindow() } catch { $fg = [IntPtr]::Zero } }");
    expect(script).toContain("if ($script:U32_OK) { try { $enum = [U32]::ListTopWindows() } catch { $enum = $null } }");
    expect(script).toContain("source = 'get-process-fallback'");
  });

  it("emits the deterministic wrapper + diagnostics and never assigns the read-only $PID", () => {
    expect(script).toContain("OutJson @{ apps = $apps; diagnostics = $diag }");
    expect(script).toContain("$diag = @{ processCount = 0; foregroundPid = $fgpid; enumWindowsCount = -1 }");
    expect(script).not.toMatch(/\$pid\s*=/);
  });

  it("parses the fixed PowerShell output: 1-element app list survives as an ARRAY with processName", async () => {
    // Exactly what the fixed OutJson emits for a single app on Windows.
    const run = fakeRun(
      JSON.stringify({
        apps: [{ name: "Untitled - Notepad", pid: 4012, processName: "notepad", active: true }],
        diagnostics: { processCount: 214, foregroundPid: 4012, enumWindowsCount: 17 },
      }),
    );
    const result = await windowsBackend.listApps(run);
    expect(result.apps).toEqual([{ name: "Untitled - Notepad", pid: 4012, processName: "notepad", active: true }]);
    expect(result.diagnostics).toEqual({ processCount: 214, foregroundPid: 4012, enumWindowsCount: 17 });
  });

  it("parses an EMPTY app list (the old silent-[] bug shape) with diagnostics", async () => {
    const run = fakeRun(JSON.stringify({ apps: [], diagnostics: { processCount: 214, foregroundPid: 0, enumWindowsCount: 0 } }));
    const result = await windowsBackend.listApps(run);
    expect(result.apps).toEqual([]);
    expect(result.diagnostics?.processCount).toBe(214);
  });

  it("R67-C: the strict parser TOLERATES and strips unknown app fields (the fallback's source marker)", async () => {
    // What the reachable fallback branch emits on Windows: the same app
    // shape plus `source: "get-process-fallback"`. The parser must keep the
    // entry and drop the marker — unknown fields never poison a parse.
    const run = fakeRun(
      JSON.stringify({
        apps: [{ name: "Untitled - Notepad", pid: 4012, processName: "notepad", active: true, source: "get-process-fallback" }],
        diagnostics: { processCount: 214, foregroundPid: 4012, enumWindowsCount: -1, note: "EnumWindows walk failed; using the Get-Process MainWindowTitle fallback" },
      }),
    );
    const result = await windowsBackend.listApps(run);
    expect(result.apps).toEqual([{ name: "Untitled - Notepad", pid: 4012, processName: "notepad", active: true }]);
    expect(result.diagnostics?.note).toContain("Get-Process MainWindowTitle fallback");
  });

  it("garbage / empty / failed capsules return {apps: []} + an honest note (never a throw)", async () => {
    const garbage = await windowsBackend.listApps(fakeRun("<S>PowerShell error noise"));
    expect(garbage.apps).toEqual([]);
    expect(garbage.diagnostics?.note).toContain("not valid JSON");

    const noOutput = await windowsBackend.listApps(fakeRun(""));
    expect(noOutput.apps).toEqual([]);
    expect(noOutput.diagnostics?.note).toContain("no output");

    const failed = await windowsBackend.listApps(fakeRun("", 1));
    expect(failed.apps).toEqual([]);
    expect(failed.diagnostics?.note).toContain("exit 1");
  });
});

describe("ROUND-64-a (R64-a): the list_windows script (ALL top-level windows of a pid)", () => {
  it("scopes by the pid, reports every titled window, and marks main = largest / focused = foreground", () => {
    const script = windowsListWindowsScript(4012);
    expect(script).toContain("$targetPid = 4012");
    expect(script).toContain("if ([int]$w.Pid -ne $targetPid) { continue }");
    expect(script).toContain("windowId = [int64]$w.Hwnd");
    expect(script).toContain("focused = ($fgl -eq [int64]$w.Hwnd)");
    expect(script).toContain("if ($bestIdx -ge 0) { $wins[$bestIdx].main = $true }");
    expect(script).toContain("OutJson @{ windows = $wins; diagnostics = $diag }");
    expect(script).not.toMatch(/\$pid\s*=/);
  });

  it("falls back to MainWindowHandle ONLY for a live process whose walk yielded nothing", () => {
    const script = windowsListWindowsScript(4012);
    expect(script).toContain("if ($wins.Count -eq 0 -and $diag.processRunning) {");
    expect(script).toContain("$p.MainWindowHandle");
  });

  it("R67-C: refuses honestly when the U32 helper did not compile (empty + diagnostic note, invented bounds FORBIDDEN)", () => {
    const script = windowsListWindowsScript(4012);
    expect(script).toContain("if (-not $script:U32_OK) {");
    expect(script).toContain("OutJson @{ windows = @(); diagnostics = @{ processRunning = $liveProc; note =");
    // The refusal names the CAUSE and the probe that reveals it.
    expect(script).toContain("the U32 helper (Add-Type -TypeDefinition) did not compile");
    expect(script).toContain("request_access and read addTypeOk");
  });

  it("parses the fixed output: multiple windows keep their array shape + bounds", async () => {
    const run = fakeRun(
      JSON.stringify({
        windows: [
          { windowId: 197266, title: "notes.txt - Notepad", bounds: [40, 60, 700, 500], main: true, focused: true },
          { windowId: 262382, title: "Go to Line", bounds: [200, 200, 300, 160], main: false, focused: false },
        ],
        diagnostics: { processRunning: true, enumWindowsCount: 17 },
      }),
    );
    const result = await windowsBackend.listWindows(run, { pid: 4012 });
    expect(result.windows).toHaveLength(2);
    expect(result.windows[0]).toEqual({
      windowId: 197266,
      title: "notes.txt - Notepad",
      bounds: [40, 60, 700, 500],
      main: true,
      focused: true,
    });
    expect(result.windows[1].main).toBe(false);
    expect(result.diagnostics?.processRunning).toBe(true);
  });

  it("refuses a malformed pid input honestly (no capsule is even spawned)", async () => {
    const run = fakeRun("{}");
    await windowsBackend.listWindows(run, { pid: -5 });
    await windowsBackend.listWindows(run, { pid: Number.NaN });
    await windowsBackend.listWindows(run, {});
    expect(run.capsules).toHaveLength(0);
  });
});

describe("ROUND-64-a (R64-a): the list_displays script (REAL bounds, no fake fallback)", () => {
  const script = windowsListDisplaysScript();

  it("reads AllScreens and emits the wrapper + screenCount diagnostics", () => {
    expect(script).toContain("[System.Windows.Forms.Screen]::AllScreens");
    expect(script).toContain("OutJson @{ displays = $displays; diagnostics = @{ screenCount = $screens.Length } }");
  });

  it("contains NO invented 1920x1080 fallback (the owner's 1280x1024 screen was reported as the fake)", () => {
    expect(script).not.toContain("1920");
    expect(script).not.toContain("1080");
  });

  it("parses a SINGLE display with its REAL bounds (the old single-display array-collapse)", async () => {
    const run = fakeRun(
      JSON.stringify({ displays: [{ index: 1, bounds: [0, 0, 1280, 1024], main: true }], diagnostics: { screenCount: 1 } }),
    );
    const result = await windowsBackend.listDisplays(run);
    expect(result.displays).toEqual([{ index: 1, bounds: [0, 0, 1280, 1024], main: true }]);
    expect(result.diagnostics?.screenCount).toBe(1);
  });

  it("parses a multi-display desktop with negative secondary origins", async () => {
    const run = fakeRun(
      JSON.stringify({
        displays: [
          { index: 1, bounds: [0, 0, 2560, 1440], main: true },
          { index: 2, bounds: [-1920, 0, 1920, 1080], main: false },
        ],
        diagnostics: { screenCount: 2 },
      }),
    );
    const result = await windowsBackend.listDisplays(run);
    expect(result.displays).toHaveLength(2);
    expect(result.displays[1].bounds).toEqual([-1920, 0, 1920, 1080]);
  });

  it("a failed capsule returns an honest [] + note — NOT the fake 1920x1080 geometry", async () => {
    const failed = await windowsBackend.listDisplays(fakeRun("", 1));
    expect(failed.displays).toEqual([]);
    expect(failed.diagnostics?.note).toContain("exit 1");

    const garbage = await windowsBackend.listDisplays(fakeRun("not json at all"));
    expect(garbage.displays).toEqual([]);
    expect(garbage.diagnostics?.note).toContain("not valid JSON");
  });

  it("drops malformed display entries instead of mapping NaN bounds", async () => {
    const run = fakeRun(JSON.stringify({ displays: [{ index: 1, bounds: [0, 0, 1280], main: true }, { index: 2, bounds: [0, 0, 800, 600], main: false }] }));
    const result = await windowsBackend.listDisplays(run);
    expect(result.displays).toEqual([{ index: 2, bounds: [0, 0, 800, 600], main: false }]);
  });
});

/* ── the element action script (unchanged walk contract, pinned) ───────── */

describe("ROUND-64-a (R64-a): the element action script keeps its walk caps + identity check", () => {
  it("re-walks the UIA tree with the 2400-element/25-depth caps (R66-2-d: aligned with buildSnapshot so the index contract holds) and verifies index + name", () => {
    const script = windowsElementActionScript(4012, { windowId: 197266, title: "notes.txt - Notepad" }, { index: 2, kind: "button", name: "Save" }, "press");
    expect(script).toContain("$maxDepth = 25; $maxEl = 2400");
    expect(script).toContain("if (2 -ge $els.Count) { Write-Output 'NO_SUCH_ELEMENT'; exit 0 }");
    expect(script).toContain("if ($liveName -ne $wantName) { Write-Output 'STALE_ELEMENT'; exit 0 }");
    expect(script).toContain("$h = [IntPtr]197266");
  });
});

/* ── R66-2-d: buildSnapshot — probe gating + the 2400 cap (the Edge fix) ─── */

describe("R66-2-d: buildSnapshot walks 2400 elements and probes ONLY interactive kinds", () => {
  const APP = { pid: 4012 };
  const WINDOW = {
    windowId: 197266,
    title: "Bing — Microsoft Edge",
    bounds: [0, 0, 1280, 1024] as [number, number, number, number],
    main: true,
    focused: true,
  };

  /** Runs buildSnapshot once with a valid 1-element payload; returns the emitted script text. */
  async function snapshotScript(detail: "compact" | "full"): Promise<string> {
    const run = fakeRun('{"elements":[{"index":0,"kind":"window","name":"Edge","flags":[]}]}');
    await windowsBackend.buildSnapshot(run, APP, WINDOW, detail);
    expect(run.capsules).toHaveLength(1);
    return decodeCapsuleScript(run.capsules[0]!);
  }

  it("caps at $maxEl = 2400 with maxDepth 25 (the 800 cap truncated before Edge page content)", async () => {
    const script = await snapshotScript("full");
    expect(script).toContain("$maxDepth = 25; $maxEl = 2400");
    expect(script).not.toContain("$maxEl = 800");
  });

  it("declares the interactive-kind probe list (UIA ControlType names, pre-Mapping)", async () => {
    const script = await snapshotScript("full");
    expect(script).toContain(
      "$probe = @('Button','Hyperlink','Edit','ComboBox','CheckBox','RadioButton','Slider','TabItem','MenuItem','ListItem','DataItem','TreeItem','Spinner','Thumb','ScrollBar','Document','Custom')",
    );
    // Non-interactive kinds are NOT probed (they record kind + name + bounds only).
    for (const kind of ["'Window'", "'Text'", "'Pane'", "'Group'", "'Image'"]) {
      expect(script).not.toContain(`,${kind}`);
    }
  });

  it("gates EVERY GetCurrentPattern probe behind the interactive branch — 4 probes, one pass", async () => {
    const script = await snapshotScript("full");
    expect(script).toContain("$interactive = $probe -contains $ct");
    expect(script).toContain("if ($interactive) {");
    // EXACTLY FOUR probes — Invoke, Toggle, ExpandCollapse, Value — all inside
    // the gated branch; value capture + action advertisement REUSE the cached
    // handles instead of re-probing (the old script probed 8× per full node).
    expect(script.split("GetCurrentPattern").length - 1).toBe(4);
    expect(script).toContain("if ($null -ne $vp) {");
    expect(script).toContain("if ($null -ne $ip) {");
    // The gated branch sits INSIDE the per-node Walk (depth-capped recursion).
    expect(script).toContain("function Walk($el, $depth)");
  });

  it("bounds stay conditional on detail:full (compact keeps the cheap walk)", async () => {
    const full = await snapshotScript("full");
    const compact = await snapshotScript("compact");
    expect(full).toContain("if ($true) {");
    expect(compact).toContain("if ($false) {");
  });

  it("parses the fixed output shape (full elements with value + bounds + actions) unchanged", async () => {
    const elements = [
      { index: 0, kind: "window", name: "Bing — Microsoft Edge", flags: [], bounds: [0, 0, 1280, 1024] },
      { index: 1, kind: "textfield", name: "Search the web", flags: ["editable"], value: "acute code", bounds: [100, 60, 600, 40], actions: ["Invoke"] },
      { index: 2, kind: "button", name: "Sign in", flags: ["pressable"], bounds: [1100, 20, 90, 30], actions: ["Invoke"] },
    ];
    const run = fakeRun(JSON.stringify({ elements }));
    const result = await windowsBackend.buildSnapshot(run, APP, WINDOW, "full");
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.elements).toHaveLength(3);
      expect(result.elements[1].value).toBe("acute code");
      expect(result.elements[2].bounds).toEqual([1100, 20, 90, 30]);
      expect(result.elements[2].actions).toEqual(["Invoke"]);
      expect(result.window.windowId).toBe(197266);
      expect(result.window.title).toBe("Bing — Microsoft Edge");
    }
  });

  it("a failed capsule / EMPTY_TREE / garbage JSON refuse honestly (unchanged)", async () => {
    const failed = await windowsBackend.buildSnapshot(fakeRun("", 1), APP, WINDOW, "full");
    expect("error" in failed && failed.error).toContain("UIA walk failed");
    const empty = await windowsBackend.buildSnapshot(fakeRun('{"error":"EMPTY_TREE"}'), APP, WINDOW, "full");
    expect("error" in empty && empty.emptyTree).toBe(true);
    const garbage = await windowsBackend.buildSnapshot(fakeRun("not json"), APP, WINDOW, "full");
    expect("error" in garbage && garbage.error).toContain("not valid JSON");
  });
});

/* ── R67-C: the SendKeys key table (THE key fix — "tab" typed t-a-b) ─────── */

describe("R67-C: composeSendKeysChord — key names + chords (the key tool fix)", () => {
  it("maps every key NAME to its SendKeys literal (never literal text)", () => {
    expect(composeSendKeysChord(["tab"])).toEqual({ ok: true, sendKeys: "{TAB}" });
    expect(composeSendKeysChord(["enter"])).toEqual({ ok: true, sendKeys: "{ENTER}" });
    expect(composeSendKeysChord(["return"])).toEqual({ ok: true, sendKeys: "{ENTER}" });
    expect(composeSendKeysChord(["esc"])).toEqual({ ok: true, sendKeys: "{ESC}" });
    expect(composeSendKeysChord(["escape"])).toEqual({ ok: true, sendKeys: "{ESC}" });
    expect(composeSendKeysChord(["backspace"])).toEqual({ ok: true, sendKeys: "{BACKSPACE}" });
    expect(composeSendKeysChord(["delete"])).toEqual({ ok: true, sendKeys: "{DELETE}" });
    expect(composeSendKeysChord(["del"])).toEqual({ ok: true, sendKeys: "{DELETE}" });
    expect(composeSendKeysChord(["space"])).toEqual({ ok: true, sendKeys: " " });
    expect(composeSendKeysChord(["up"])).toEqual({ ok: true, sendKeys: "{UP}" });
    expect(composeSendKeysChord(["arrowdown"])).toEqual({ ok: true, sendKeys: "{DOWN}" });
    expect(composeSendKeysChord(["arrowleft"])).toEqual({ ok: true, sendKeys: "{LEFT}" });
    expect(composeSendKeysChord(["arrowright"])).toEqual({ ok: true, sendKeys: "{RIGHT}" });
    expect(composeSendKeysChord(["home"])).toEqual({ ok: true, sendKeys: "{HOME}" });
    expect(composeSendKeysChord(["end"])).toEqual({ ok: true, sendKeys: "{END}" });
    expect(composeSendKeysChord(["pageup"])).toEqual({ ok: true, sendKeys: "{PGUP}" });
    expect(composeSendKeysChord(["pgup"])).toEqual({ ok: true, sendKeys: "{PGUP}" });
    expect(composeSendKeysChord(["pagedown"])).toEqual({ ok: true, sendKeys: "{PGDN}" });
    expect(composeSendKeysChord(["pgdn"])).toEqual({ ok: true, sendKeys: "{PGDN}" });
    expect(composeSendKeysChord(["insert"])).toEqual({ ok: true, sendKeys: "{INSERT}" });
    expect(composeSendKeysChord(["help"])).toEqual({ ok: true, sendKeys: "{HELP}" });
    for (let f = 1; f <= 12; f++) {
      expect(composeSendKeysChord([`f${f}`])).toEqual({ ok: true, sendKeys: `{F${f}}` });
    }
  });

  it("composes LEADING modifier chords — ctrl ^, shift +, alt % (linux xdotool parity for 'ctrl+a')", () => {
    expect(composeSendKeysChord(["ctrl", "a"])).toEqual({ ok: true, sendKeys: "^a" });
    expect(composeSendKeysChord(["control", "a"])).toEqual({ ok: true, sendKeys: "^a" });
    expect(composeSendKeysChord(["shift", "tab"])).toEqual({ ok: true, sendKeys: "+{TAB}" });
    expect(composeSendKeysChord(["alt", "f4"])).toEqual({ ok: true, sendKeys: "%{F4}" });
    expect(composeSendKeysChord(["option", "f4"])).toEqual({ ok: true, sendKeys: "%{F4}" });
    expect(composeSendKeysChord(["ctrl", "shift", "t"])).toEqual({ ok: true, sendKeys: "^+t" });
  });

  it("single printable characters pass through, SendKeys-SPECIALS brace-escaped; a lone '+' token is the plus key", () => {
    expect(composeSendKeysChord(["a"])).toEqual({ ok: true, sendKeys: "a" });
    expect(composeSendKeysChord(["5"])).toEqual({ ok: true, sendKeys: "5" });
    // The escape set (the same regex the TEXT path escapes with):
    // + ^ % ~ ( ) [ ] { } must be braced or SendKeys reads them as syntax.
    expect(composeSendKeysChord(["+"])).toEqual({ ok: true, sendKeys: "{+}" });
    expect(composeSendKeysChord(["%"])).toEqual({ ok: true, sendKeys: "{%}" });
    expect(composeSendKeysChord(["^"])).toEqual({ ok: true, sendKeys: "{^}" });
    expect(composeSendKeysChord(["~"])).toEqual({ ok: true, sendKeys: "{~}" });
    expect(composeSendKeysChord(["("])).toEqual({ ok: true, sendKeys: "{(}" });
    expect(composeSendKeysChord(["{"])).toEqual({ ok: true, sendKeys: "{{}" });
    expect(composeSendKeysChord(["ctrl", "+"])).toEqual({ ok: true, sendKeys: "^{+}" });
  });

  it("refuses the Windows/Meta key HONESTLY (SendKeys has no win-key modifier — nothing is typed)", () => {
    for (const bad of [["meta", "l"], ["win", "l"], ["cmd", "l"], ["super", "l"], ["meta"]]) {
      const result = composeSendKeysChord(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("the Windows SendKeys backend cannot synthesize the Windows/Meta key");
        expect(result.error).not.toContain("unknown key name");
      }
    }
  });

  it("refuses unknown names and malformed chords with the full supported list (self-teaching errors)", () => {
    const unknown = composeSendKeysChord(["tabs"]);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error).toContain("unknown key name 'tabs'");
      expect(unknown.error).toContain("ctrl+a / shift+tab / alt+f4");
    }
    const noKey = composeSendKeysChord(["ctrl"]);
    expect(noKey.ok).toBe(false);
    if (!noKey.ok) expect(noKey.error).toContain("exactly ONE key");
    const twoKeys = composeSendKeysChord(["a", "b"]);
    expect(twoKeys.ok).toBe(false);
    if (!twoKeys.ok) expect(twoKeys.error).toContain("exactly ONE key");
    const trailingMod = composeSendKeysChord(["a", "ctrl"]);
    expect(trailingMod.ok).toBe(false);
    if (!trailingMod.ok) expect(trailingMod.error).toContain("exactly ONE key");
    const empty = composeSendKeysChord([]);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain("no key tokens given");
  });
});

describe("R67-C: rawKey sends ONE composed SendKeys chord (never tokens as text)", () => {
  it("key \"tab\" → SendWait('{TAB}') — the letters t-a-b are NEVER typed", async () => {
    const run = fakeRun("OK");
    const result = await windowsBackend.rawKey(run, ["tab"], { pid: 4242, windowId: 77 });
    expect(result.ok).toBe(true);
    expect(run.capsules).toHaveLength(1);
    const script = decodeCapsuleScript(run.capsules[0]!);
    expect(script).toContain("[System.Windows.Forms.SendKeys]::SendWait(@'{TAB}'@)");
    expect(script).not.toContain("SendWait(@'tab'@)");
    // Scope verification survives (Win raw keys land in the frontmost window).
    expect(script).toContain('if ($fgpid -ne 4242) { Write-Output "FRONTMOST_MISMATCH:$fgpid"; exit 0 }');
    // R67-C: the U32 guard — a dead Add-Type must refuse, not abort.
    expect(script).toContain("if (-not $script:U32_OK) { Write-Output 'ERR:U32-unavailable");
  });

  it("chords arrive composed: ctrl+a → '^a', ctrl+shift+t → '^+t' (one SendWait, not text)", async () => {
    const run = fakeRun("OK");
    await windowsBackend.rawKey(run, ["ctrl", "a"], { pid: 4242, windowId: 77 });
    const script = decodeCapsuleScript(run.capsules[0]!);
    expect(script).toContain("[System.Windows.Forms.SendKeys]::SendWait(@'^a'@)");
    expect(script.split("SendWait").length - 1).toBe(1); // ONE chord, one call

    const run2 = fakeRun("OK");
    await windowsBackend.rawKey(run2, ["ctrl", "shift", "t"], { pid: 4242, windowId: 77 });
    expect(decodeCapsuleScript(run2.capsules[0]!)).toContain("SendWait(@'^+t'@)");
  });

  it("the FRONTMOST_MISMATCH channel still refuses (nothing typed); the U32 guard ERR is parsed as a failure", async () => {
    const mismatch = await windowsBackend.rawKey(fakeRun("FRONTMOST_MISMATCH:9999"), ["tab"], { pid: 4242, windowId: 77 });
    expect(mismatch).toEqual({ ok: false, error: "FRONTMOST_MISMATCH:9999" });
    // The guard's ERR: output line is the raw-input scripts' honest failure
    // channel — okResult parses it into {ok:false, error: "..."}.
    const guarded = await windowsBackend.rawKey(fakeRun("ERR:U32-unavailable (the Add-Type helper did not compile on this host - this action is unavailable)"), ["tab"], { pid: 4242, windowId: 77 });
    expect(guarded.ok).toBe(false);
    if (!guarded.ok) expect(guarded.error).toContain("U32-unavailable");
  });

  it("an uncomposable chord refuses WITHOUT spawning a capsule (nothing is typed)", async () => {
    const run = fakeRun("OK");
    const result = await windowsBackend.rawKey(run, ["meta", "l"], { pid: 4242, windowId: 77 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cannot synthesize the Windows/Meta key");
    expect(run.capsules).toHaveLength(0);
  });
});

describe("R67-C: focusedElementName — the Tab-walk readback script", () => {
  it("reads AutomationElement.FocusedElement AFTER the foreground-pid scope check, guarded on U32", async () => {
    const run = fakeRun("Search box");
    const name = await windowsBackend.focusedElementName(run, 4242);
    expect(name).toBe("Search box");
    const script = decodeCapsuleScript(run.capsules[0]!);
    expect(script).toContain("Add-Type -AssemblyName UIAutomationClient");
    expect(script).toContain("if (-not $script:U32_OK) { Write-Output ''; exit 0 }");
    expect(script).toContain("if ($fgpid -ne 4242) { Write-Output ''; exit 0 }");
    expect(script).toContain("[System.Windows.Automation.AutomationElement]::FocusedElement");
  });

  it("an empty (non-foreground / no focused element) result is null — never a fabricated name", async () => {
    const empty = await windowsBackend.focusedElementName(fakeRun(""), 4242);
    expect(empty).toBeNull();
    const failed = await windowsBackend.focusedElementName(fakeRun("", 1), 4242);
    expect(failed).toBeNull();
  });
});

describe("R67-C: probePermissions — the THIRD probe (Add-Type -TypeDefinition, the csc compile)", () => {
  /** A fake runner that answers each capsule in order (probe 1/2/3). */
  function seqRun(outs: string[], codes: number[] = []): RecordingRun {
    const capsules: CommandCapsule[] = [];
    const run: RunCommand = async (capsule) => {
      const i = capsules.length;
      capsules.push(capsule);
      return { code: codes[i] ?? 0, stdout: outs[i] ?? "", stderr: "", timedOut: false } satisfies RunResult;
    };
    return Object.assign(run, { capsules }) as RecordingRun;
  }

  it("probes the tiny compile in a BARE -EncodedCommand capsule (no U32 preamble) and reports addTypeOk", async () => {
    const run = seqRun(["PS_OK", "UIA_OK", "ADDTYPE_OK"]);
    const report = await windowsBackend.probePermissions(run);
    expect(run.capsules).toHaveLength(3);
    expect(report.accessibility).toBe("granted");
    expect(report.addTypeOk).toBe(true);
    // The third capsule is the tiny compile probe: base64 UTF-16LE, no preamble.
    const probe = run.capsules[2]!;
    expect(probe.args.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    expect(probe.stdin).toBeUndefined();
    const script = decodeCapsuleScript(probe);
    expect(script).toContain("Add-Type -TypeDefinition 'public class AcuteProbe {}'");
    expect(script).toContain("Write-Output 'ADDTYPE_OK'");
    expect(script).not.toContain("ListTopWindows");
    // The first two probes still carry the preamble (unchanged shape).
    expect(decodeCapsuleScript(run.capsules[0]!)).toContain("public static List<WINFO> ListTopWindows()");
  });

  it("a FAILED compile is reported honestly: addTypeOk false + the explanatory note", async () => {
    // PS_OK + UIA_OK + ADDTYPE_FAIL — the owner's "the PowerShell session
    // died before emitting JSON" class, now VISIBLE in the probe result
    // instead of a green PS_OK.
    const run = seqRun(["PS_OK", "UIA_OK", "ADDTYPE_FAIL"]);
    const report = await windowsBackend.probePermissions(run);
    expect(run.capsules).toHaveLength(3);
    expect(report.addTypeOk).toBe(false);
    expect(report.notes?.some((n) => n.includes("Add-Type -TypeDefinition (the csc compile behind list_apps/list_windows) failed"))).toBe(true);
  });

  it("a NONZERO exit on the compile probe is a failure too (not just ADDTYPE_FAIL)", async () => {
    const run = seqRun(["PS_OK", "UIA_OK", ""], [0, 0, 1]);
    const report = await windowsBackend.probePermissions(run);
    expect(report.addTypeOk).toBe(false);
  });
});
