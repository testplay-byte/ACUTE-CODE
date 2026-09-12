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
 * R68-C REWRITES the input contract: SendKeys is DEAD (the owner's live
 * v0.67.0 trace: [System.Windows.Forms.SendKeys] TypeNotFound — the
 * preamble's LoadWithPartialName silently failed while Add-Type worked).
 * The pins now hold the SendInput contract:
 *   · the preamble declares the input structs + SendText/Chord/TapKey/
 *     ModsDown/ModsUp + ShowWindow + the Chromium poke, and NO LONGER
 *     loads Windows.Forms at all
 *   · composeVkChord — the key-name → VK table + leading modifiers +
 *     honest refusals (the Windows/Meta key is a REAL VK now: LWIN 0x5B)
 *   · rawKey composes ONE [U32]::Chord call (PowerShell ushort[] array
 *     via $m=@([uint16]…)) and typeText rides [U32]::SendText with the
 *     RAW here-string (no SendKeys escaping anywhere)
 *   · activate escalates (SW_MINIMIZE → SW_RESTORE) and the select
 *     action rides TapKey/ModsDown instead of SendKeys
 * R69-a adds four input-engine pin groups (scroll math, long-type
 * clipboard paste, UIA poke hardening, browser a11y flag):
 *   · rawScroll: ONE wheel event carrying ticks×WHEEL_DELTA (the old
 *     construction sent `ticks` events × ±(ticks×120) = ticks²×120
 *     total — a QUADRATIC over-scroll, now dead); horizontal rides
 *     MOUSEEVENTF_HWHEEL 0x1000 (positive = right), never arrow taps
 *   · typeText > 300 chars: Set-Clipboard → 200ms settle → Ctrl+V
 *     Chord, payload over STDIN as base64(UTF-8) (psStdinCapsule — the
 *     script still rides -EncodedCommand ARGV; only the PAYLOAD moved,
 *     so the CreateProcess ceiling no longer caps typed text and the
 *     Unicode survives exactly — the pins decode stdin back to the
 *     source text). Threshold boundary pinned at 299/300/301.
 *   · PokeChromium: the second WM_GETOBJECT (lParam 0xFFFFFFFD,
 *     UiaRootObjectId) + the sparse POLL (re-walk at the cumulative
 *     checkpoints 400/800/1400/2000ms, 4 attempts max, break once
 *     non-sparse) replace the fixed 400ms + one 600ms retry
 *   · launch: Chromium browser executables (msedge/chrome, matched
 *     flexibly on the basename) get --force-renderer-accessibility
 * The parse paths run against a fake RunCommand returning exactly what the
 * fixed PowerShell emits on Windows.
 */
import { describe, expect, it } from "vitest";
import {
  WINDOWS_PS_PROGRAM,
  WINDOWS_PS_PREAMBLE,
  LONG_TYPE_THRESHOLD,
  chromiumBrowserExecutable,
  composeVkChord,
  windowsListAppsScript,
  windowsListWindowsScript,
  windowsListDisplaysScript,
  windowsElementActionScript,
  windowsBackend,
} from "../src/computer/backends/windows";
import type { CommandCapsule, RunCommand, RunResult } from "../src/computer/backends/interface";
import { readFileSync } from "node:fs";

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

/** R67-C: decode a capsule's script back to text. R93-C: BOTH transports —
 * the -EncodedCommand path (base64 of UTF-16LE, PowerShell's contract,
 * inverted for content assertions) and the TEMP-.ps1 -File path the
 * oversized walk switched to (the v2 walk outgrew the 32,767-char
 * CreateProcess ceiling; the script text is read straight from the file). */
function decodeCapsuleScript(capsule: CommandCapsule): string {
  const i = capsule.args.indexOf("-EncodedCommand");
  if (i !== -1) {
    expect(capsule.args[i + 1]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    return Buffer.from(capsule.args[i + 1]!, "base64").toString("utf16le");
  }
  const f = capsule.args.indexOf("-File");
  expect(f).toBeGreaterThan(-1);
  const path = capsule.args[f + 1]!;
  expect(path).toMatch(/acute-ps-[^\\/]+[\\/]s\.ps1$/);
  return readFileSync(path, "utf8");
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

  it("R68-C: declares the SendInput machinery (the input path — structs, one P/Invoke, the static helpers)", () => {
    // The owner's live trace: every type/key/scroll call failed
    // capability_fail_closed because [System.Windows.Forms.SendKeys] was
    // TypeNotFound. The U32 class now owns keyboard input end-to-end.
    for (const needle of [
      "public struct KEYBDINPUT{public ushort wVk;public ushort wScan;public uint dwFlags;public uint time;public IntPtr dwExtraInfo;}",
      "public struct MOUSEINPUT{public int dx;public int dy;public uint mouseData;public uint dwFlags;public uint time;public IntPtr dwExtraInfo;}",
      "[FieldOffset(0)]public MOUSEINPUT mi;[FieldOffset(0)]public KEYBDINPUT ki;",
      "public struct INPUT{public uint type;public INPUTUNION u;}",
      "[DllImport(\"user32.dll\",SetLastError=true)]public static extern uint SendInput(uint n,INPUT[] p,int cb);",
      "public static uint SendText(string s)",
      "public static uint TapKey(ushort vk)",
      "public static uint ModsDown(ushort[] mods)",
      "public static uint ModsUp(ushort[] mods)",
      "public static uint Chord(ushort[] mods,ushort key)",
      "public static extern bool ShowWindow(IntPtr h,int cmd);",
    ]) {
      expect(WINDOWS_PS_PREAMBLE).toContain(needle);
    }
    // The platform-correct INPUT layout: Sequential INPUT + Explicit union
    // overlay (the union's IntPtr member forces offset 8 on x64 / 4 on x86);
    // sizeof rides Marshal.SizeOf inside SendMany.
    expect(WINDOWS_PS_PREAMBLE).toContain("[StructLayout(LayoutKind.Explicit)]");
    expect(WINDOWS_PS_PREAMBLE).toContain("[StructLayout(LayoutKind.Sequential)]\npublic struct INPUT{");
    expect(WINDOWS_PS_PREAMBLE).toContain("Marshal.SizeOf(typeof(INPUT))");
    // SendText maps \n to real VK_RETURN presses ('\r' skipped so \r\n is ONE Enter)
    // and every other char to KEYEVENTF_UNICODE (0x0004 down, 0x0006 up).
    expect(WINDOWS_PS_PREAMBLE).toContain("if(ch=='\\n'){");
    expect(WINDOWS_PS_PREAMBLE).toContain("KeyInput(0,(ushort)ch,0x0004)");
    expect(WINDOWS_PS_PREAMBLE).toContain("KeyInput(0,(ushort)ch,0x0006)");
  });

  it("R68-C: NO Windows.Forms for input — LoadWithPartialName is GONE (the dead dependency the live trace exposed)", () => {
    // The owner's host: LoadWithPartialName('System.Windows.Forms')
    // silently failed (every SendKeys call → TypeNotFound) while
    // captureDisplay's own Add-Type -AssemblyName System.Windows.Forms
    // WORKED live (screenshots succeeded all round). Input is SendInput
    // P/Invoke now — the assembly is dead weight and REMOVED.
    expect(WINDOWS_PS_PREAMBLE).not.toContain("LoadWithPartialName");
    expect(WINDOWS_PS_PREAMBLE).not.toContain("System.Windows.Forms");
    expect(WINDOWS_PS_PREAMBLE).not.toContain("SendKeys");
    // captureDisplay/captureRegion keep their OWN proven Add-Type lines
    // (pinned in their describes below).
  });

  it("R68-C (C4) + R69-a: the Chromium poke sends WM_GETOBJECT TWICE per render child — OBJID_CLIENT (0xFFFFFFFC) AND UiaRootObjectId (0xFFFFFFFD)", () => {
    // Chromium builds its web a11y tree ONLY after an AT pokes the render
    // widget — the poke is what a screen reader does on connect. R69-a
    // adds the SECOND lParam: UiaRootObjectId activates the UIA provider
    // path directly (System.Windows.Automation IS UIA — the poke now asks
    // in the dialect the walk below speaks).
    for (const needle of [
      "public static int PokeChromium(IntPtr hwnd)",
      "public delegate bool ChildProc(IntPtr h,IntPtr lp);",
      "[DllImport(\"user32.dll\")]public static extern bool EnumChildWindows(IntPtr p,ChildProc cb,IntPtr lp);",
      "[DllImport(\"user32.dll\")]public static extern IntPtr SendMessage(IntPtr h,uint msg,IntPtr w,IntPtr l);",
      "Chrome_RenderWidgetHostHWND",
      "SendMessage(h,0x3D,IntPtr.Zero,new IntPtr(unchecked((int)0xFFFFFFFC)));",
      "SendMessage(h,0x3D,IntPtr.Zero,new IntPtr(unchecked((int)0xFFFFFFFD)));",
    ]) {
      expect(WINDOWS_PS_PREAMBLE).toContain(needle);
    }
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
    // The gated branch sits INSIDE the per-node Walk (depth-capped
    // recursion). R93-C: the walk signature grew the hierarchy params
    // ($parentKey + $pathSegs — the breadcrumb stack).
    expect(script).toContain("function Walk($el, $depth, $parentKey, $pathSegs)");
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

  it("R68-C (C4) + R69-a: POKEs the render widget BEFORE the UIA walk, then POLLS while sparse — 4 checkpoints, immediate return once non-sparse", async () => {
    // The owner's Edge trees were SPARSE (only the window element): Chromium
    // builds its web a11y tree ONLY after an AT pokes the render widget.
    // The poke is U32-gated (the walk itself needs no U32) and runs BEFORE
    // any walk. R69-a replaced the fixed 400ms settle + one 600ms
    // sparse-retry with a POLL: while the poked tree stays sparse (≤1
    // element), re-walk after each wait; the waits are the increments to
    // the cumulative checkpoints 400/800/1400/2000ms (4 attempts max), and
    // the loop BREAKS the moment a walk yields >1 elements.
    const script = await snapshotScript("full");
    expect(script.indexOf("[U32]::PokeChromium([IntPtr]197266)")).toBeGreaterThan(-1);
    expect(script.indexOf("[U32]::PokeChromium")).toBeLessThan(script.indexOf("Walk $root 0"));
    expect(script).toContain("if ($script:U32_OK) { try { $pokeCount = [U32]::PokeChromium");
    // The sparse POLL construction.
    expect(script).toContain("if ($pokeCount -gt 0) {");
    expect(script).toContain("$waits = @(400, 400, 600, 600)");
    expect(script).toContain("foreach ($w in $waits) {");
    expect(script).toContain("Start-Sleep -Milliseconds $w");
    expect(script).toContain("if ($out.Count -gt 1) { break }");
    // Every re-walk resets $out first (the sparse pass is discarded — no
    // consumer exists yet, this IS the snapshot being built).
    expect(script).toContain("$out = New-Object System.Collections.ArrayList\n    Walk $root 0");
    // The no-poke path (no Chromium render children found) walks exactly
    // ONCE — no settle loop at all.
    expect(script).toContain("} else {\n  Walk $root 0\n}");
    // The old fixed-settle / single-retry pins are GONE (intentional
    // behavior change: `if ($pokeCount -gt 0) { Start-Sleep -Milliseconds
    // 400 }` and the single 600ms re-walk no longer exist).
    expect(script).not.toContain("Start-Sleep -Milliseconds 400 }");
    expect(script).not.toContain("Start-Sleep -Milliseconds 600");
    // Exactly TWO `Walk $root 0` call sites: the poll loop's + the no-poke
    // else branch's (the Walk function's recursion is $child-driven).
    expect(script.split("Walk $root 0").length - 1).toBe(2);
  });
});

/* ── R68-C (C1): rawScroll / rawClick / rawDrag — the SendInput input paths ── */

describe("R68-C: rawScroll / rawClick / rawDrag ride SendInput (no SendKeys)", () => {
  it("R69-a: vertical = ONE mouse_event(0x0800) carrying ticks×WHEEL_DELTA; horizontal = MOUSEEVENTF_HWHEEL (0x1000) — the quadratic + arrow-tap constructions are dead", async () => {
    // amount 30 → ticks = round(30/3) = 10 → delta = 10×WHEEL_DELTA = 1200.
    // The R68-C bug was QUADRATIC: `ticks` events × ±(ticks×120) each →
    // ticks²×120 total (a 10-tick scroll delivered 100× the intent; 33
    // ticks delivered 1089×). Now: ONE event, delta = ticks×120.
    const down = fakeRun("OK");
    const result = await windowsBackend.rawScroll(down, { x: 10, y: 20 }, "down", 30);
    expect(result.ok).toBe(true);
    const downScript = decodeCapsuleScript(down.capsules[0]!);
    expect(downScript).toContain("[U32]::mouse_event(0x0800,0,0,-1200,[UIntPtr]::Zero)");
    expect(downScript.split("[U32]::mouse_event(0x0800").length - 1).toBe(1); // ONE event
    // The cursor is positioned at the target FIRST (wheel events affect
    // the window under the cursor) — and no inter-event sleeps remain.
    expect(downScript.indexOf("[void][U32]::SetCursorPos(10, 20)")).toBeLessThan(
      downScript.indexOf("[U32]::mouse_event(0x0800"),
    );
    expect(downScript).not.toContain("Start-Sleep -Milliseconds 15");

    const up = fakeRun("OK");
    await windowsBackend.rawScroll(up, { x: 10, y: 20 }, "up", 30);
    expect(decodeCapsuleScript(up.capsules[0]!)).toContain("[U32]::mouse_event(0x0800,0,0,1200,[UIntPtr]::Zero)"); // positive = up

    // Horizontal rides MOUSEEVENTF_HWHEEL: positive = RIGHT, negative = LEFT
    // (the old arrow-key TapKey taps moved the CARET, never the page).
    const right = fakeRun("OK");
    await windowsBackend.rawScroll(right, { x: 10, y: 20 }, "right", 30);
    const rightScript = decodeCapsuleScript(right.capsules[0]!);
    expect(rightScript).toContain("[U32]::mouse_event(0x1000,0,0,1200,[UIntPtr]::Zero)");
    expect(rightScript).not.toContain("mouse_event(0x0800");

    const left = fakeRun("OK");
    await windowsBackend.rawScroll(left, { x: 10, y: 20 }, "left", 30);
    expect(decodeCapsuleScript(left.capsules[0]!)).toContain("[U32]::mouse_event(0x1000,0,0,-1200,[UIntPtr]::Zero)");

    // NO arrow taps in ANY scroll script (the call form — the preamble of
    // course still declares TapKey for the other paths), no SendKeys.
    for (const r of [down, up, right, left]) {
      expect(decodeCapsuleScript(r.capsules[0]!)).not.toContain("[U32]::TapKey(");
      expect(decodeCapsuleScript(r.capsules[0]!)).not.toContain("SendKeys");
    }
  });

  it("R69-a: the clamps hold — ticks ≤ 40, wheel data ≤ ±32767 (amount 100 → 33 ticks = 3960; an insane amount clamps to 40×120 = 4800)", async () => {
    const run = fakeRun("OK");
    await windowsBackend.rawScroll(run, { x: 0, y: 0 }, "down", 100);
    expect(decodeCapsuleScript(run.capsules[0]!)).toContain("[U32]::mouse_event(0x0800,0,0,-3960,[UIntPtr]::Zero)");
    // A direct backend call bypassing the dispatcher's 0..100 clamp still
    // composes a sane single event (40 ticks × 120), never ±ticks²×120.
    const insane = fakeRun("OK");
    await windowsBackend.rawScroll(insane, { x: 0, y: 0 }, "down", 1e9);
    expect(decodeCapsuleScript(insane.capsules[0]!)).toContain("[U32]::mouse_event(0x0800,0,0,-4800,[UIntPtr]::Zero)");
  });

  it("modifier clicks hold via [U32]::ModsDown/ModsUp (VK arrays) — the '{CTRLDOWN}' SendKeys path is gone", async () => {
    const run = fakeRun("OK");
    const result = await windowsBackend.rawClick(run, { x: 10, y: 20 }, "left", 1, ["ctrl", "shift"]);
    expect(result.ok).toBe(true);
    const script = decodeCapsuleScript(run.capsules[0]!);
    expect(script).toContain("$m=@([uint16]17, [uint16]16)");
    expect(script).toContain("[void][U32]::ModsDown($m)");
    expect(script).toContain("[void][U32]::ModsUp($m)");
    expect(script).not.toContain("SendKeys");
    // The order: hold BEFORE SetCursorPos, release AFTER the clicks.
    expect(script.indexOf("[void][U32]::ModsDown($m)")).toBeLessThan(script.indexOf("[void][U32]::SetCursorPos"));
    expect(script.indexOf("[U32]::mouse_event(2,")).toBeLessThan(script.indexOf("[void][U32]::ModsUp($m)"));

    // No modifiers: NO mods machinery in the body (the call form — the
    // preamble's declaration is of course present).
    const run2 = fakeRun("OK");
    await windowsBackend.rawClick(run2, { x: 10, y: 20 }, "left", 1, []);
    expect(decodeCapsuleScript(run2.capsules[0]!)).not.toContain("[U32]::ModsDown(");
    expect(decodeCapsuleScript(run2.capsules[0]!)).not.toContain("$m=@(");
    // 'super' is a REAL VK now (LWIN 91) — usable as a click modifier.
    const run3 = fakeRun("OK");
    await windowsBackend.rawClick(run3, { x: 10, y: 20 }, "left", 1, ["super"]);
    expect(decodeCapsuleScript(run3.capsules[0]!)).toContain("$m=@([uint16]91)");
  });

  it("modifier drags hold the same way (ModsDown before the gesture, ModsUp after mouse-up)", async () => {
    const run = fakeRun("OK");
    const result = await windowsBackend.rawDrag(run, { x: 10, y: 20 }, { x: 110, y: 120 }, ["ctrl"]);
    expect(result.ok).toBe(true);
    const script = decodeCapsuleScript(run.capsules[0]!);
    expect(script).toContain("$m=@([uint16]17)");
    expect(script.indexOf("[void][U32]::ModsDown($m)")).toBeLessThan(script.indexOf("[U32]::mouse_event(2,"));
    expect(script.indexOf("[U32]::mouse_event(4,")).toBeLessThan(script.indexOf("[void][U32]::ModsUp($m)"));
    expect(script).not.toContain("SendKeys");
  });
});

/* ── R68-C (C3): the activate escalation ladder ──────────────────────────── */

describe("R68-C: activate escalates to the minimize/restore trick after the polite sequence fails", () => {
  it("keeps the AttachThreadInput sequence + 1.5s verify, then SW_MINIMIZE(6) → 150ms → SW_RESTORE(9) + re-verify", async () => {
    const run = fakeRun("ACTIVE");
    const result = await windowsBackend.activate(run, 4012, 197266);
    expect(result).toEqual({ ok: true, active: true });
    const script = decodeCapsuleScript(run.capsules[0]!);
    // The polite sequence survives untouched.
    expect(script).toContain("[void][U32]::AttachThreadInput($curTid, $targetTid, $true)");
    expect(script).toContain("[void][U32]::BringWindowToTop($h)");
    expect(script).toContain("[void][U32]::SetForegroundWindow($h)");
    expect(script).toContain("$deadline = (Get-Date).AddMilliseconds(1500)");
    // The escalation ladder — only entered when the first verify FAILED.
    expect(script).toContain("if ([U32]::GetForegroundWindow() -ne $h) {");
    expect(script).toContain("[void][U32]::ShowWindow($h, 6)");
    expect(script).toContain("Start-Sleep -Milliseconds 150");
    expect(script).toContain("[void][U32]::ShowWindow($h, 9)");
    expect(script).toContain("$deadline2 = (Get-Date).AddMilliseconds(1500)");
    // The honest postcondition stays: only a verified foreground is ACTIVE.
    expect(script).toContain("if ([U32]::GetForegroundWindow() -eq $h) { Write-Output 'ACTIVE' } else { Write-Output 'INACTIVE' }");
  });

  it("INACTIVE is reported honestly when even the escalation fails; ERR: shapes fail closed", async () => {
    const inactive = await windowsBackend.activate(fakeRun("INACTIVE"), 4012, 197266);
    expect(inactive).toEqual({ ok: true, active: false });
    const notRunning = await windowsBackend.activate(fakeRun("ERR:not-running"), 4012, 197266);
    expect(notRunning).toEqual({ ok: false, active: false });
  });
});

/* ── R68-C: the element-action select body rides SendInput ───────────────── */

describe("R68-C: the select_text action taps HOME (+ optional shift+END) via SendInput", () => {
  it("caret placement = [U32]::TapKey(HOME); with a length = shift held for END — the SendKeys {HOME}/+{END} path is dead", () => {
    const caret = windowsElementActionScript(
      4012,
      { windowId: 197266, title: "notes.txt - Notepad" },
      { index: 2, kind: "textfield", name: "File name:" },
      "select",
    );
    expect(caret).toContain("[void][U32]::TapKey([uint16]0x24)");
    expect(caret).not.toContain("[System.Windows.Forms.SendKeys]");
    expect(caret).not.toContain("[U32]::ModsDown(");
    expect(caret).not.toContain("$sel=@(");

    const all = windowsElementActionScript(
      4012,
      { windowId: 197266, title: "notes.txt - Notepad" },
      { index: 2, kind: "textfield", name: "File name:" },
      "select",
      undefined,
      undefined,
      0,
      10,
    );
    expect(all).toContain("$sel=@([uint16]0x10)");
    expect(all).toContain("[void][U32]::ModsDown($sel)");
    expect(all).toContain("[void][U32]::TapKey([uint16]0x23)");
    expect(all).toContain("[void][U32]::ModsUp($sel)");
    expect(all).not.toContain("[System.Windows.Forms.SendKeys]");
    // The select body carries the U32 guard (press/setValue/action do not).
    expect(all).toContain("if (-not $script:U32_OK) { Write-Output 'ERR:U32-unavailable");
  });

  it("the OTHER element actions stay pure UIA (no U32 guard, no input machinery)", () => {
    const press = windowsElementActionScript(
      4012,
      { windowId: 197266, title: "notes.txt - Notepad" },
      { index: 1, kind: "button", name: "Save" },
      "press",
    );
    expect(press).not.toContain("U32-unavailable");
    expect(press).not.toContain("TapKey");
    expect(press).toContain("$ip.Invoke()");
  });
});

/* ── R68-C: the key-name → VK table (the SendInput chord composer) ──────── */

describe("R68-C: capsule sizing honesty (the re-measured -EncodedCommand ceiling math)", () => {
  it("the biggest FIXED capsule (preamble + buildSnapshot) stays under the 32,767-char CreateProcess ceiling", async () => {
    // MEASURED at R69-a (node over the real composed capsules): the
    // preamble grew 6,682 → 6,766 chars (the second WM_GETOBJECT poke
    // SendMessage); buildSnapshot composes 11,592/11,593 script chars
    // (full/compact) → 30,912/30,916 base64 (the compact variant loses by
    // the one char of "$false"). Bound-pinned here so future preamble
    // growth cannot silently cross the line.
    const run = fakeRun('{"elements":[{"index":0,"kind":"window","name":"Edge","flags":[]}]}');
    await windowsBackend.buildSnapshot(run, { pid: 4012 }, {
      windowId: 197266,
      title: "Bing — Microsoft Edge",
      bounds: [0, 0, 1280, 1024] as [number, number, number, number],
      main: true,
      focused: true,
    }, "full");
    // R93-C: the v2 walk (hierarchy + the clickability layers) pushed the
    // capsule PAST the CreateProcess ceiling — the transport switched to
    // the TEMP-.ps1 -File path. The sizing honesty pins BOTH sides now:
    const b64Index = run.capsules[0]!.args.indexOf("-EncodedCommand");
    if (b64Index !== -1) {
      const b64 = run.capsules[0]!.args[b64Index + 1]!;
      expect(b64.length).toBeGreaterThan(20_000);
      expect(b64.length).toBeLessThan(30_000); // under the ARGV→file switch point
    } else {
      // The file transport: -File with a temp .ps1 whose CONTENT is the
      // full walk script (the decode helper asserts the shape) — the
      // command line itself stays TINY (no ceiling at all).
      expect(run.capsules[0]!.args).toContain("-File");
      const script = decodeCapsuleScript(run.capsules[0]!);
      expect(script.length).toBeGreaterThan(10_000); // it IS the grown walk
      expect(Buffer.byteLength(script, "utf16le") / 3 * 4).toBeGreaterThan(30_000); // would NOT have fit ARGV
    }
  });
});

describe("R68-C: the ARGV ceiling guard — model-supplied payloads refuse BEFORE the spawn", () => {
  // The psCapsule docblock's honest history: an earlier draft claimed the
  // typeText timeout math caps text at ~1,400 chars — WRONG (Math.min
  // clamps the TIMEOUT, not the text). A long type/set_value/clipboard
  // payload would have crossed CreateProcess's 32,767-char command-line
  // ceiling and died at the spawn with a cryptic error. R69-a moved
  // typeText's LONG payloads off the ARGV channel entirely (stdin), so
  // the guard now guards the paths that still embed payloads in the
  // -EncodedCommand blob: setValue, writeClipboard, and typeText's SHORT
  // (≤300-char) per-char path (defense-in-depth — 300 chars can never
  // cross the ceiling, but the R68-C construction stays).
  const SCOPE = { pid: 4242, windowId: 77 };
  const WIN = { windowId: 197266, title: "notes.txt - Notepad" };
  const EL = { index: 2, kind: "textfield", name: "File name:" };

  it("R69-a: typeText's LONG payloads no longer touch ARGV — a 7,000-char type rides the clipboard+stdin path (the pre-spawn refusal is retired for type)", async () => {
    // Under R68-C this composed a ~37k-base64 blob and refused; the
    // payload now rides stdin (no command-line ceiling), the SCRIPT stays
    // a fixed ~20.7k-base64 -EncodedCommand.
    const run = fakeRun("OK");
    const result = await windowsBackend.typeText(run, "x".repeat(7000), SCOPE);
    expect(result.ok).toBe(true);
    expect(run.capsules).toHaveLength(1);
    expect(run.capsules[0]!.stdin).toBeDefined();
    const b64 = run.capsules[0]!.args[run.capsules[0]!.args.indexOf("-EncodedCommand") + 1]!;
    expect(b64.length).toBeGreaterThan(20_000); // preamble + fixed clipboard script
    expect(b64.length).toBeLessThan(25_000); // ...and it does NOT grow with the 7,000 chars
  });

  it("typeText: a 300-char text (the per-char path's max) still sends via the per-char capsule, no stdin", async () => {
    const run = fakeRun("OK");
    const result = await windowsBackend.typeText(run, "x".repeat(300), SCOPE);
    expect(result.ok).toBe(true);
    expect(run.capsules[0]!.stdin).toBeUndefined();
    expect(decodeCapsuleScript(run.capsules[0]!)).toContain("[void][U32]::SendText(");
  });

  it("setValue (the element-target type path) gets the SAME guard — no capsule spawned", async () => {
    const run = fakeRun("OK");
    const result = await windowsBackend.setValue(run, 4012, WIN, EL, "x".repeat(7000));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("set_value text too long");
    expect(run.capsules).toHaveLength(0);
  });

  it("writeClipboard gets the SAME guard — no capsule spawned", async () => {
    const run = fakeRun("OK");
    const result = await windowsBackend.writeClipboard(run, "x".repeat(7000));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("clipboard text too long");
    expect(run.capsules).toHaveLength(0);
  });
});

describe("R68-C: composeVkChord — key names + chords (the SendInput rewrite)", () => {
  it("maps every key NAME to its Virtual-Key code (never literal text)", () => {
    expect(composeVkChord(["tab"])).toEqual({ ok: true, mods: [], key: 0x09 });
    expect(composeVkChord(["enter"])).toEqual({ ok: true, mods: [], key: 0x0d });
    expect(composeVkChord(["return"])).toEqual({ ok: true, mods: [], key: 0x0d });
    expect(composeVkChord(["esc"])).toEqual({ ok: true, mods: [], key: 0x1b });
    expect(composeVkChord(["escape"])).toEqual({ ok: true, mods: [], key: 0x1b });
    expect(composeVkChord(["backspace"])).toEqual({ ok: true, mods: [], key: 0x08 });
    expect(composeVkChord(["delete"])).toEqual({ ok: true, mods: [], key: 0x2e });
    expect(composeVkChord(["del"])).toEqual({ ok: true, mods: [], key: 0x2e });
    expect(composeVkChord(["insert"])).toEqual({ ok: true, mods: [], key: 0x2d });
    expect(composeVkChord(["help"])).toEqual({ ok: true, mods: [], key: 0x2f });
    expect(composeVkChord(["space"])).toEqual({ ok: true, mods: [], key: 0x20 });
    expect(composeVkChord(["up"])).toEqual({ ok: true, mods: [], key: 0x26 });
    expect(composeVkChord(["arrowdown"])).toEqual({ ok: true, mods: [], key: 0x28 });
    expect(composeVkChord(["arrowleft"])).toEqual({ ok: true, mods: [], key: 0x25 });
    expect(composeVkChord(["arrowright"])).toEqual({ ok: true, mods: [], key: 0x27 });
    expect(composeVkChord(["home"])).toEqual({ ok: true, mods: [], key: 0x24 });
    expect(composeVkChord(["end"])).toEqual({ ok: true, mods: [], key: 0x23 });
    expect(composeVkChord(["pageup"])).toEqual({ ok: true, mods: [], key: 0x21 });
    expect(composeVkChord(["pgup"])).toEqual({ ok: true, mods: [], key: 0x21 });
    expect(composeVkChord(["pagedown"])).toEqual({ ok: true, mods: [], key: 0x22 });
    expect(composeVkChord(["pgdn"])).toEqual({ ok: true, mods: [], key: 0x22 });
    for (let f = 1; f <= 12; f++) {
      expect(composeVkChord([`f${f}`])).toEqual({ ok: true, mods: [], key: 0x70 + (f - 1) });
    }
  });

  it("composes LEADING modifier chords — ctrl 0x11, shift 0x10, alt 0x12 (linux xdotool parity for 'ctrl+a')", () => {
    expect(composeVkChord(["ctrl", "a"])).toEqual({ ok: true, mods: [0x11], key: 0x41 });
    expect(composeVkChord(["control", "a"])).toEqual({ ok: true, mods: [0x11], key: 0x41 });
    expect(composeVkChord(["shift", "tab"])).toEqual({ ok: true, mods: [0x10], key: 0x09 });
    expect(composeVkChord(["alt", "f4"])).toEqual({ ok: true, mods: [0x12], key: 0x73 });
    expect(composeVkChord(["option", "f4"])).toEqual({ ok: true, mods: [0x12], key: 0x73 });
    // 't' → VK 0x54 (VK codes are the UPPERCASE letter codes: 0x41 + ord).
    expect(composeVkChord(["ctrl", "shift", "t"])).toEqual({ ok: true, mods: [0x11, 0x10], key: 0x54 });
  });

  it("R68-C: the Windows/Meta key is a REAL VK now (LWIN 0x5B) — 'win+l' composes where SendKeys refused", () => {
    // SendInput synthesizes the Windows key; the R67-C honest refusal for
    // meta chords is retired (the capability gap is gone).
    expect(composeVkChord(["win", "l"])).toEqual({ ok: true, mods: [0x5b], key: 0x4c });
    expect(composeVkChord(["meta", "l"])).toEqual({ ok: true, mods: [0x5b], key: 0x4c });
    expect(composeVkChord(["super", "d"])).toEqual({ ok: true, mods: [0x5b], key: 0x44 });
    expect(composeVkChord(["cmd", "d"])).toEqual({ ok: true, mods: [0x5b], key: 0x44 });
  });

  it("single characters map to VK codes: letters, digits, and the OEM punctuation ('++' → the plus key)", () => {
    expect(composeVkChord(["a"])).toEqual({ ok: true, mods: [], key: 0x41 });
    expect(composeVkChord(["z"])).toEqual({ ok: true, mods: [], key: 0x5a });
    expect(composeVkChord(["5"])).toEqual({ ok: true, mods: [], key: 0x35 });
    expect(composeVkChord(["0"])).toEqual({ ok: true, mods: [], key: 0x30 });
    // The OEM set (splitKeyChord preserves a literal '+' so '++' is the key):
    expect(composeVkChord(["+"])).toEqual({ ok: true, mods: [], key: 0xbb });
    expect(composeVkChord(["ctrl", "+"])).toEqual({ ok: true, mods: [0x11], key: 0xbb });
    expect(composeVkChord(["-"])).toEqual({ ok: true, mods: [], key: 0xbd });
    expect(composeVkChord([","])).toEqual({ ok: true, mods: [], key: 0xbc });
    expect(composeVkChord(["."])).toEqual({ ok: true, mods: [], key: 0xbe });
    expect(composeVkChord(["/"])).toEqual({ ok: true, mods: [], key: 0xbf });
    expect(composeVkChord([";"])).toEqual({ ok: true, mods: [], key: 0xba });
    expect(composeVkChord(["'"])).toEqual({ ok: true, mods: [], key: 0xde });
  });

  it("refuses unknown names and unsupported single chars honestly (self-teaching errors, nothing typed)", () => {
    const unknown = composeVkChord(["tabs"]);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error).toContain("unknown key name 'tabs'");
      expect(unknown.error).toContain("ctrl+a / shift+tab / alt+f4 / win+l");
    }
    // A printable char with NO VK in the table (SendKeys-specials like '~'
    // used to pass through brace-escaped; the honest path now points at type).
    const tilde = composeVkChord(["~"]);
    expect(tilde.ok).toBe(false);
    if (!tilde.ok) expect(tilde.error).toContain("type it with the type tool");
    const noKey = composeVkChord(["ctrl"]);
    expect(noKey.ok).toBe(false);
    if (!noKey.ok) expect(noKey.error).toContain("exactly ONE key");
    const twoKeys = composeVkChord(["a", "b"]);
    expect(twoKeys.ok).toBe(false);
    if (!twoKeys.ok) expect(twoKeys.error).toContain("exactly ONE key");
    const trailingMod = composeVkChord(["a", "ctrl"]);
    expect(trailingMod.ok).toBe(false);
    if (!trailingMod.ok) expect(trailingMod.error).toContain("exactly ONE key");
    const empty = composeVkChord([]);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain("no key tokens given");
  });
});

describe("R68-C: rawKey sends ONE composed SendInput chord (never tokens as text)", () => {
  it("key \"tab\" → Chord with VK 9 — the letters t-a-b are NEVER typed, no SendKeys anywhere", async () => {
    const run = fakeRun("OK");
    const result = await windowsBackend.rawKey(run, ["tab"], { pid: 4242, windowId: 77 });
    expect(result.ok).toBe(true);
    expect(run.capsules).toHaveLength(1);
    const script = decodeCapsuleScript(run.capsules[0]!);
    expect(script).toContain("[void][U32]::Chord($m, [uint16]9)");
    // No modifiers: the array literal is the EMPTY form.
    expect(script).toContain("$m=@()");
    // The dead dependency is gone from the input path entirely.
    expect(script).not.toContain("SendKeys");
    // Scope verification survives (Win raw keys land in the frontmost window).
    expect(script).toContain('if ($fgpid -ne 4242) { Write-Output "FRONTMOST_MISMATCH:$fgpid"; exit 0 }');
    // R67-C: the U32 guard — a dead Add-Type must refuse, not abort.
    expect(script).toContain("if (-not $script:U32_OK) { Write-Output 'ERR:U32-unavailable");
  });

  it("chords arrive as VK arrays: ctrl+a → $m=@([uint16]17) + key 65; ctrl+shift+t adds both mods (one Chord call)", async () => {
    const run = fakeRun("OK");
    await windowsBackend.rawKey(run, ["ctrl", "a"], { pid: 4242, windowId: 77 });
    const script = decodeCapsuleScript(run.capsules[0]!);
    expect(script).toContain("$m=@([uint16]17)");
    expect(script).toContain("[void][U32]::Chord($m, [uint16]65)");
    expect(script.split("[U32]::Chord").length - 1).toBe(1); // ONE chord, one call
    expect(script).not.toContain("SendKeys");

    const run2 = fakeRun("OK");
    await windowsBackend.rawKey(run2, ["ctrl", "shift", "t"], { pid: 4242, windowId: 77 });
    expect(decodeCapsuleScript(run2.capsules[0]!)).toContain("$m=@([uint16]17, [uint16]16)");
    // R68-C: the Windows key composes now (LWIN) — the old honest refusal
    // for meta chords is retired.
    const run3 = fakeRun("OK");
    await windowsBackend.rawKey(run3, ["win", "l"], { pid: 4242, windowId: 77 });
    expect(decodeCapsuleScript(run3.capsules[0]!)).toContain("$m=@([uint16]91)");
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
    const result = await windowsBackend.rawKey(run, ["tabs"], { pid: 4242, windowId: 77 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("unknown key name 'tabs'");
    expect(run.capsules).toHaveLength(0);
  });
});

describe("R68-C: typeText rides [U32]::SendText (KEYEVENTF_UNICODE — the escaping class of bugs is dead)", () => {
  it("the RAW text rides a here-string literal into SendText — no SendKeys, no splitTextToKeys, no brace-escaping", async () => {
    const run = fakeRun("OK");
    const result = await windowsBackend.typeText(run, "hello world", { pid: 4242, windowId: 77 });
    expect(result.ok).toBe(true);
    const script = decodeCapsuleScript(run.capsules[0]!);
    expect(script).toContain("[void][U32]::SendText(@'hello world'@)");
    expect(script).not.toContain("SendKeys");
    // Scope verification + the guard ride along.
    expect(script).toContain('if ($fgpid -ne 4242) { Write-Output "FRONTMOST_MISMATCH:$fgpid"; exit 0 }');
    expect(script).toContain("if (-not $script:U32_OK) { Write-Output 'ERR:U32-unavailable");
  });

  it("SendKeys-SPECIAL characters ride RAW (KEYEVENTF_UNICODE needs no +%^~(){} escaping — the whole class is gone)", async () => {
    const run = fakeRun("OK");
    await windowsBackend.typeText(run, "a+b%c~(d){e}", { pid: 4242, windowId: 77 });
    const script = decodeCapsuleScript(run.capsules[0]!);
    // The literal rides UNESCAPED (the C# side maps each char to its
    // Unicode code point — brace syntax never existed).
    expect(script).toContain("[void][U32]::SendText(@'a+b%c~(d){e}'@)");
    expect(script).not.toContain("{+}");
    expect(script).not.toContain("{%}");
    // Newlines ride the RAW text too — the \n → VK_RETURN mapping lives in
    // the C# SendText (pinned in the preamble describe), not the JS side.
    const run2 = fakeRun("OK");
    await windowsBackend.typeText(run2, "line1\nline2", { pid: 4242, windowId: 77 });
    const script2 = decodeCapsuleScript(run2.capsules[0]!);
    expect(script2).toContain("[void][U32]::SendText(@'line1\nline2'@)");
    expect(script2).not.toContain("{ENTER}");
  });

  it("the FRONTMOST_MISMATCH channel refuses (nothing typed); a failed capsule is an honest failure", async () => {
    const mismatch = await windowsBackend.typeText(fakeRun("FRONTMOST_MISMATCH:9999"), "hi", { pid: 4242, windowId: 77 });
    expect(mismatch).toEqual({ ok: false, error: "FRONTMOST_MISMATCH:9999" });
    const failed = await windowsBackend.typeText(fakeRun("", 1), "hi", { pid: 4242, windowId: 77 });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toContain("type failed");
  });
});

/* ── R69-a: typeText LONG text — the clipboard paste path (stdin payload) ── */

describe("R69-a: typeText LONG text rides the clipboard paste (Set-Clipboard → settle → Ctrl+V)", () => {
  const SCOPE = { pid: 4242, windowId: 77 };

  it("threshold boundary: 299 and 300 chars stay on the per-char SendText path; 301 switches to the clipboard path", async () => {
    expect(LONG_TYPE_THRESHOLD).toBe(300);
    for (const len of [299, 300]) {
      const run = fakeRun("OK");
      const result = await windowsBackend.typeText(run, "x".repeat(len), SCOPE);
      expect(result.ok).toBe(true);
      const script = decodeCapsuleScript(run.capsules[0]!);
      expect(script).toContain(`[void][U32]::SendText(@'${"x".repeat(len)}'@)`);
      expect(run.capsules[0]!.stdin).toBeUndefined(); // the per-char path never rides stdin
      expect(script).not.toContain("Set-Clipboard");
    }
    const run = fakeRun("OK");
    const result = await windowsBackend.typeText(run, "x".repeat(301), SCOPE);
    expect(result.ok).toBe(true);
    const script = decodeCapsuleScript(run.capsules[0]!);
    expect(script).not.toContain("[U32]::SendText("); // no per-char events at all
    expect(script).toContain("Set-Clipboard -Value $paste -ErrorAction Stop");
    expect(run.capsules[0]!.stdin).toBeDefined(); // the payload channel
  });

  it("the paste choreography: frontmost gate → payload → clipboard → 200ms settle → Ctrl+V Chord — in ORDER, before anything is touched", async () => {
    const run = fakeRun("OK");
    const result = await windowsBackend.typeText(run, "x".repeat(301), SCOPE);
    expect(result.ok).toBe(true);
    const script = decodeCapsuleScript(run.capsules[0]!);
    // The U32 guard + the frontmost scope check ride along (the mismatch
    // must refuse BEFORE the user's clipboard is clobbered).
    expect(script).toContain("if (-not $script:U32_OK) { Write-Output 'ERR:U32-unavailable");
    expect(script).toContain('if ($fgpid -ne 4242) { Write-Output "FRONTMOST_MISMATCH:$fgpid"; exit 0 }');
    // The paste choreography, pinned in order.
    expect(script.indexOf('if ($fgpid -ne 4242)')).toBeLessThan(script.indexOf("Set-Clipboard"));
    expect(script).toContain("Start-Sleep -Milliseconds 200");
    expect(script.indexOf("Set-Clipboard")).toBeLessThan(script.indexOf("Start-Sleep -Milliseconds 200"));
    // Ctrl+V through the EXISTING Chord primitive: VK_CONTROL (0x11) + 'V' (0x56).
    expect(script).toContain("$cv=@([uint16]17)");
    expect(script).toContain("[void][U32]::Chord($cv, [uint16]86)");
    expect(script.indexOf("Start-Sleep -Milliseconds 200")).toBeLessThan(script.indexOf("[void][U32]::Chord($cv, [uint16]86)"));
    expect(script).not.toContain("SendKeys");
  });

  it("the payload channel: stdin carries base64(UTF-8) that decodes back to the EXACT text (Unicode survives by construction)", async () => {
    // Non-ASCII, emoji (surrogate pair), both quote kinds, a newline, and
    // the here-string edge sequence '@ — the pipe must carry it all intact.
    const text = "héllo 世界 😀 line1\nline2 'single' \"double\" @' '@ edge — " + "αβγ".repeat(100);
    const run = fakeRun("OK");
    await windowsBackend.typeText(run, text, SCOPE);
    const stdin = run.capsules[0]!.stdin!;
    // Pure-ASCII base64 + a trailing newline (Trim()med inside the script —
    // no console-encoding ambiguity ever crosses the pipe).
    expect(stdin).toMatch(/^[A-Za-z0-9+/]+={0,2}\n$/);
    expect(Buffer.from(stdin.trim(), "base64").toString("utf8")).toBe(text);
    // The decode side is pinned in the script: UTF8.GetString(FromBase64String).
    const script = decodeCapsuleScript(run.capsules[0]!);
    expect(script).toContain("$payload = [Console]::In.ReadToEnd()");
    expect(script).toContain("try { $paste = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) }");
    // The SCRIPT itself still rides -EncodedCommand ARGV (R67-C: the
    // script cannot be lost) — only the PAYLOAD moved to stdin.
    expect(script).toContain(WINDOWS_PS_PREAMBLE);
  });

  it("a HUGE payload composes the SAME fixed script — only stdin grows (the ARGV ceiling no longer caps typed text)", async () => {
    const run = fakeRun("OK");
    const result = await windowsBackend.typeText(run, "x".repeat(100_000), SCOPE);
    expect(result.ok).toBe(true);
    const b64 = run.capsules[0]!.args[run.capsules[0]!.args.indexOf("-EncodedCommand") + 1]!;
    expect(b64.length).toBeLessThan(25_000); // the fixed clipboard script (~20.7k measured)
    expect(run.capsules[0]!.stdin!.length).toBeGreaterThan(100_000); // the payload rides stdin
    expect(Buffer.from(run.capsules[0]!.stdin!.trim(), "base64").toString("utf8")).toBe("x".repeat(100_000));
  });

  it("an EMPTY stdin payload refuses honestly (the EPIPE class — nothing is typed, no paste happens)", async () => {
    const run = fakeRun(
      "ERR:stdin-payload-lost (the clipboard paste received no text on stdin - the long text was not delivered; retry the type call)",
    );
    const result = await windowsBackend.typeText(run, "x".repeat(301), SCOPE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("stdin-payload-lost");
    // The refusal is PINNED in the script: an empty payload is detected
    // and reported — never an empty paste.
    expect(decodeCapsuleScript(run.capsules[0]!)).toContain("'ERR:stdin-payload-lost");
  });

  it("the FRONTMOST_MISMATCH channel refuses (nothing typed); a failed capsule is an honest failure", async () => {
    const mismatch = await windowsBackend.typeText(fakeRun("FRONTMOST_MISMATCH:9999"), "x".repeat(301), SCOPE);
    expect(mismatch).toEqual({ ok: false, error: "FRONTMOST_MISMATCH:9999" });
    const failed = await windowsBackend.typeText(fakeRun("", 1), "x".repeat(301), SCOPE);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toContain("type failed");
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

/* ── R69-a: launch — the Chromium browser accessibility flag ─────────── */

describe("R69-a: launch gives Chromium browsers --force-renderer-accessibility", () => {
  it("msedge / chrome — with or without .exe, with a full path, any case — launch with the flag", async () => {
    const names = [
      "msedge",
      "msedge.exe",
      "chrome",
      "chrome.exe",
      String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
      "MSEDGE.EXE",
    ];
    for (const name of names) {
      const run = fakeRun("OK");
      const result = await windowsBackend.launch(run, { name, activate: false });
      expect(result.ok).toBe(true);
      const script = decodeCapsuleScript(run.capsules[0]!);
      expect(script).toContain("-ArgumentList '--force-renderer-accessibility'");
      // The flag rides Start-Process's ArgumentList; the FilePath keeps
      // the (single-quote-escaped) name the model gave.
      expect(script).toContain(`Start-Process -FilePath "${name.replace(/'/g, "''")}" -ArgumentList '--force-renderer-accessibility' -ErrorAction Stop`);
    }
  });

  it("NON-browser targets launch UNCHANGED — no flag, same Start-Process line as R68-C", async () => {
    for (const name of ["notepad", "msedgewebview2", "chrome_proxy", "explorer"]) {
      const run = fakeRun("OK");
      const result = await windowsBackend.launch(run, { name, activate: false });
      expect(result.ok).toBe(true);
      const script = decodeCapsuleScript(run.capsules[0]!);
      expect(script).not.toContain("--force-renderer-accessibility");
      expect(script).toContain(`Start-Process -FilePath "${name}" -ErrorAction Stop`);
    }
  });

  it("chromiumBrowserExecutable: the flexible matcher (basename · case · .exe · both separators · trimmed)", () => {
    expect(chromiumBrowserExecutable("msedge")).toBe(true);
    expect(chromiumBrowserExecutable("MSEDGE.EXE")).toBe(true);
    expect(chromiumBrowserExecutable("chrome")).toBe(true);
    expect(chromiumBrowserExecutable("Chrome.EXE")).toBe(true);
    expect(chromiumBrowserExecutable(String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`)).toBe(true);
    expect(chromiumBrowserExecutable("C:/Program Files/Google/Chrome/Application/chrome.exe")).toBe(true); // forward slashes too
    expect(chromiumBrowserExecutable(" msedge ")).toBe(true); // surrounding whitespace tolerated
    expect(chromiumBrowserExecutable("notepad")).toBe(false);
    expect(chromiumBrowserExecutable("msedgewebview2")).toBe(false); // the WebView2 helper is NOT a browser
    expect(chromiumBrowserExecutable("chrome_proxy")).toBe(false); // prefix-only match refused
    expect(chromiumBrowserExecutable("chromium")).toBe(false); // not in the R69-a browser list
    expect(chromiumBrowserExecutable("")).toBe(false);
  });

  it("a pid-only launch spec never spawns a capsule (unchanged identity resolution)", async () => {
    const run = fakeRun("OK");
    const result = await windowsBackend.launch(run, { pid: 1234, activate: false });
    expect(result).toEqual({ ok: true, pid: 1234, active: false });
    expect(run.capsules).toHaveLength(0);
  });

  it("a launch failure is reported honestly (the ERR channel — unchanged)", async () => {
    const failed = await windowsBackend.launch(fakeRun("ERR:This command cannot be found"), { name: "msedge", activate: false });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toContain("could not launch 'msedge'");
  });
});

/* ── R68-C: the captures keep their OWN proven Add-Type lines ────────────── */

describe("R68-C: the capture scripts load Windows.Forms via Add-Type (the PROVEN-live path)", () => {
  it("captureDisplay / captureRegion / list_displays keep their own Add-Type -AssemblyName lines", async () => {
    // The live trace's asymmetry: the preamble's LoadWithPartialName FAILED
    // while Add-Type -AssemblyName WORKED (screenshots succeeded all round).
    // The captures therefore keep their own loads — only INPUT lost the
    // dependency.
    const run = fakeRun("GEO:0,0,10,10");
    await windowsBackend.captureDisplay(run, 1);
    const script = decodeCapsuleScript(run.capsules[0]!);
    expect(script).toContain("Add-Type -AssemblyName System.Drawing");
    expect(script).toContain("Add-Type -AssemblyName System.Windows.Forms");
    expect(script).toContain("[System.Windows.Forms.Screen]::AllScreens");

    const run2 = fakeRun("GEO:0,0");
    await windowsBackend.captureRegion(run2, { x: 0, y: 0, w: 10, h: 10 });
    const regionScript = decodeCapsuleScript(run2.capsules[0]!);
    expect(regionScript).toContain("Add-Type -AssemblyName System.Drawing");
    expect(windowsListDisplaysScript()).toContain("Add-Type -AssemblyName System.Windows.Forms");
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
