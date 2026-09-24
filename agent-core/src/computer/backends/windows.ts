/**
 * ROUND-61 (R61): the WINDOWS backend — doc 04-platform-backends.md §3 (the
 * reference platform of the spec).
 *
 * ROUND-64-a (R64-a): the owner's live 0.63.0 Windows test reported
 * list_apps → [], get_app_state("Notepad") → app_not_found, list_displays →
 * [] while screenshots worked — every list-shaped probe silently emptied.
 * Root cause (verified by construction, not by live run): piping an ARRAY to
 * ConvertTo-Json in PowerShell 5.1 — 0 elements emit NOTHING, 1 element
 * emits a bare OBJECT (the pipeline unwraps the array), only 2+ emit an
 * array; the JS side then swallowed the parse failure into []. Fixes:
 *   · OutJson is now SHAPE-AWARE: lists ride `ConvertTo-Json -InputObject
 *     @($arr)` (the -InputObject parameter binding preserves the array
 *     wrapper for 0/1/N elements; 0 short-circuits to a literal '[]');
 *     hashtables ride -InputObject directly (object shape unchanged).
 *   · list_apps/list_windows are now REAL EnumWindows enumerations (one
 *     Add-Type / one csc compile in the shared preamble: EnumWindows +
 *     IsWindowVisible + GetWindowText/GetClassName + WS_EX_TOOLWINDOW and
 *     zero-size filtering, grouped one-app-per-pid with the LARGEST titled
 *     window as `name` and the exe's ProcessName as `processName`), with an
 *     honest Get-Process MainWindowTitle fallback if the walk throws.
 *   · list_displays returns the REAL AllScreens bounds (the single-display
 *     collapse used to fall through to a FAKE 1920×1080 — removed: a failed
 *     enumeration is now an honest [] + diagnostics, never invented bounds).
 *   · every enumeration result carries diagnostics (processCount,
 *     foregroundPid, enumWindowsCount…) so an empty is debuggable from the
 *     transcript.
 * PowerShell is never executed in this sandbox — the scripts are pinned by
 * command-construction tests (tests/computer-windows-backend.test.ts).
 *
 * ROUND-94 (R94-E — the owner's v0.91.0 Windows 11 / PowerShell 5.1 field
 * report: the window layer was BROKEN — windows_overview → {"windows":[]}
 * with enumWindowsCount -1, list_apps → 11 apps ALL active:false,
 * get_app_state → "process N is running but owns no accessible top-level
 * window" for EVERY app). Root cause: $script:U32_OK is FALSE on the
 * owner's machine — the Add-Type (csc) compile of the U32 P/Invoke helper
 * fails there, and EVERYTHING cascaded from that (no EnumWindows, no
 * GetForegroundWindow, no ShowWindow). The accessibility tree itself was
 * NEVER affected (System.Windows.Automation rides .NET assemblies — no
 * csc needed). Fixes, all verified by construction (no Windows here):
 *   · U32_ERR CAPTURED: the preamble's catch block now records the compile
 *     error into $script:U32_ERR, and EVERY diagnostics object that reports
 *     enumWindowsCount -1 carries it as addTypeError (truncated ~300 chars)
 *     — the next field report says WHY csc failed on that machine instead
 *     of just "EnumWindows walk failed".
 *   · THE CSC-FREE UIA FALLBACK LAYER: when U32_OK is false, UIAutomationClient
 *     + UIAutomationTypes load via [System.Reflection.Assembly]::
 *     LoadWithPartialName (try/catch-guarded — no Add-Type, no csc), and the
 *     window layer degrades to UIA instead of to emptiness:
 *     RootElement.FindAll(Children, TrueCondition) = the top-level windows
 *     (pid/title/bounds/NativeWindowHandle), FocusedElement = the foreground
 *     (pid + hwnd — more reliable than nothing when GetForegroundWindow is
 *     gone). Every fallback entry carries source:'uia-fallback' and the
 *     diagnostics gain uiaFallback:true — results stay debuggable, never
 *     presented as the real EnumWindows walk. list_apps keeps its honest
 *     Get-Process fallback ONLY when even UIA fails to walk.
 *   · THE window_action ACTOR: minimize|maximize|restore|focus|close by HWND
 *     or the resolved foreground window (ShowWindowAsync 6/3/9,
 *     BringWindowToTop+SetForegroundWindow for focus, PostMessage WM_CLOSE
 *     for the GENTLE close that lets apps prompt; the UIA fallback acts via
 *     WindowPattern.SetWindowVisualState / Close / AutomationElement.SetFocus
 *     — the owner's "minimize the current window" task had NO actor before:
 *     the agent could only observe, then a loop guard stopped it).
 *
 * ROUND-69-a (R69-a — four Windows input-engine fixes, all verified by
 * construction against this file, none by live run):
 *   · SCROLL MATH: rawScroll was QUADRATIC (it sent `ticks` events, each
 *     carrying ±(ticks×WHEEL_DELTA) → ticks²×120 total) and horizontal
 *     scrolled with arrow-key taps that never move browser CONTENT
 *     (arrows move focus/caret, not the page). Now ONE wheel event
 *     carries delta = ticks×WHEEL_DELTA (clamped: ticks ≤ 40, delta ≤
 *     ±32767); horizontal rides MOUSEEVENTF_HWHEEL (0x1000, positive =
 *     right); the cursor is positioned at the target point FIRST.
 *   · LONG TYPE: text > LONG_TYPE_THRESHOLD (300) chars types via the
 *     CLIPBOARD (Set-Clipboard → 200ms settle → Ctrl+V through the
 *     existing Chord primitive). The payload channel moves to STDIN as
 *     base64(UTF-8) — psStdinCapsule — so the 32,767-char CreateProcess
 *     ARGV ceiling no longer caps typed text and the Unicode survives
 *     EXACTLY (UTF8.GetString on the decoded base64; only pure-ASCII
 *     base64 crosses the pipe). Short text keeps the per-char SendText
 *     path unchanged.
 *   · A11Y POKE HARDENING: PokeChromium now sends WM_GETOBJECT TWICE per
 *     Chrome_RenderWidgetHostHWND child (lParam 0xFFFFFFFC OBJID_CLIENT +
 *     lParam 0xFFFFFFFD UiaRootObjectId — the UIA provider path the
 *     System.Windows.Automation walk actually speaks), and the fixed
 *     400ms + one 600ms sparse-retry became a POLL: while the walk stays
 *     sparse (≤1 element), re-walk at the cumulative checkpoints
 *     400/800/1400/2000ms (4 attempts max), returning IMMEDIATELY once
 *     the tree is non-sparse.
 *   · BROWSER A11Y FLAG: launching a Chromium browser (msedge / chrome —
 *     flexibly matched on the basename, case/.exe/path-insensitive)
 *     appends --force-renderer-accessibility so the web a11y tree exists
 *     at STARTUP instead of after a poke; non-browser targets unchanged.
 *
 * ROUND-68 (R68-C — the owner's v0.67.0 live Windows field report: the
 * 7-step Edge flow degraded into a screenshot loop and half-failed, all
 * root-caused by construction against this file):
 *   · EVERY type/key/scroll call failed capability_fail_closed —
 *     "[System.Windows.Forms.SendKeys]" was TypeNotFound on the owner's
 *     host: the preamble loaded Windows.Forms via the DEPRECATED
 *     [System.Reflection.Assembly]::LoadWithPartialName (silently failing
 *     on modern .NET), while captureDisplay's own `Add-Type -AssemblyName
 *     System.Windows.Forms` WORKED live (screenshots succeeded all round).
 *     Windows.Forms is a DEAD dependency for input now: the preamble's
 *     LoadWithPartialName line is REMOVED (LoadWithPartialName can fail
 *     where Add-Type works — the live trace proved it), and every input
 *     path rides raw SendInput P/Invoke in the SAME U32 TypeDefinition:
 *     SendText (KEYEVENTF_UNICODE per char — no SendKeys escaping class of
 *     bugs at all), Chord/TapKey/ModsDown/ModsUp (real VK codes), with the
 *     platform-correct INPUT layout (Sequential INPUT + Explicit-union
 *     overlay — the IntPtr member forces union offset 8 on x64 / 4 on x86,
 *     matching the real INPUT; sizeof rides Marshal.SizeOf).
 *   · Repeated frontmost_pid_mismatch: Edge loses frontmost (our activate
 *     verified INACTIVE), and the raw-input tools then REFUSED instead of
 *     self-healing. activate() now escalates (AttachThreadInput sequence →
 *     the SW_MINIMIZE/SW_RESTORE trick → re-verify), and dispatch.ts
 *     auto-retries (activate + retry ONCE) — see dispatch.ts R68-C.
 *   · Edge accessibility trees SPARSE (only the window element): Chromium
 *     builds its web accessibility tree ONLY after an assistive technology
 *     pokes the render widget. PokeChromium (WM_GETOBJECT to every
 *     Chrome_RenderWidgetHostHWND child) runs BEFORE the UIA walk in
 *     buildSnapshot, with a 400ms settle and a sparse-retry — the tree
 *     EXISTS, we just never asked for it.
 *
 * ROUND-67 (R67-C — the owner's v0.66.0 live Windows field report, three
 * backend robustness failures, all verified by construction, none by live
 * run):
 *   · "list_apps returned EMPTY twice — the PowerShell session died before
 *     emitting JSON" while run_command(tasklist) worked: the capsule rode
 *     STDIN under `-Command -` (PS 5.1 reports unreliable, often 0, exit
 *     codes when the piped script aborts; the runner's EPIPE-swallowed
 *     stdin write meant a child that exited early ran an EMPTY script →
 *     exit 0, no stdout). Capsules now ride ARGV via -EncodedCommand
 *     (base64 of UTF-16LE) — the script cannot be lost, and a failed
 *     Add-Type no longer aborts before the first Write-Output: the ONE U32
 *     compile is guarded by $script:U32_OK, list_apps degrades to the
 *     Get-Process MainWindowTitle fallback (honest
 *     source:"get-process-fallback" entries), and every script that NEEDS
 *     U32 refuses with its existing error shape.
 *   · get_app_state(pid of msedgewebview2) → "no running application
 *     matches": a LIVE WebView2 helper owns no accessible top-level window;
 *     the honest helper-process refusal now lands in dispatch.ts (the
 *     resolver no longer claims the app is absent).
 *   · key "tab" literally typed t-a-b (chords like ctrl+a were typed as
 *     text): windowsSendKeysScript had no key-name table. The fix:
 *     composeSendKeysChord — the key-name → SendKeys table + modifier
 *     prefixes, exported and pinned by construction; rawKey composes ONE
 *     SendKeys chord instead of typing tokens as literal text.
 *
 * ROUND-93 (R93-C — the computer-use v2 rework, docs/architecture/
 * COMPUTER-USE-V2.md §2): the walker gains the ELEMENT MAP surface while
 * the flat-list actuation contract stays BYTE-IDENTICAL:
 *   · HIERARCHY: every element carries key ("w{hwnd}-{n}", a per-walk
 *     counter assigned at emission — walk order, so index↔key stay
 *     aligned), windowKey (the root's key), parentKey ($null on the
 *     root), path (the " › " breadcrumb of ancestor names + self, capped
 *     at 5 segments + "…", 120 chars total) and treeDepth.
 *   · LAYERED CLICKABILITY (§2.2, the ClickScope port, the C5 rework):
 *     TYPE (the $probe ControlTypes — unchanged) → PATTERN (the same 4
 *     GetCurrentPattern probes — Invoke/Toggle/ExpandCollapse/Value —
 *     widened from TYPE-only kinds to NAMED elements at depth>0, catching
 *     interactive controls hiding in generic panes) → FOCUSABLE
 *     ($el.Current.IsKeyboardFocusable read DIRECTLY off the typed Current
 *     view + named + non-container). via records the FIRST layer that
 *     fired. The reference's ACTION/MSAA legacy layers are HONESTLY ABSENT:
 *     they read LegacyIAccessible.DefaultAction / AccessibleRole, which
 *     live on the COM IUIAutomation face System.Windows.Automation never
 *     exposes — the first draft's by-id GetPropertyValue reader could not
 *     bind an int to AutomationProperty, so those two layers were inert
 *     scaffolding (caught in the C5 pre-release review, deleted rather
 *     than shipped dead).
 *   · PLACEMENT: moveWindow (SetWindowPos — the one new U32 P/Invoke, one
 *     line, still ONE csc compile per capsule), setWindowState (ShowWindow
 *     3/6/9 — the activate() primitive, by handle), focusWindow
 *     (BringWindowToTop + SetForegroundWindow, the light by-id raise).
 * The capsule ceiling math was RE-MEASURED for the v2 walk (see the
 * psCapsule docblock): the fixed buildSnapshot capsule measured 33,140
 * base64 chars — PAST the hard 32,767 CreateProcess ceiling — so the
 * temp-.ps1 -File transport is not a future option, it is the ACTIVE
 * path for the walk (every detail:full snapshot rides it; see the C5
 * BOM note in psCapsule — the .ps1 is written UTF-8 WITH BOM because
 * powershell.exe 5.1 decodes BOM-less scripts as ANSI).
 *
 * ROUND-125 (R125-A — the owner's v0.117.0 occlusion verdict: "it takes
 * the screenshot of the whole device rather than the webpage. When I am
 * in some other application, it takes a screenshot of that application
 * rather than the browser window itself"): captureRegion is
 * PRINTWINDOW-FIRST. The screen-region grab (GDI CopyFromScreen) leaks
 * whatever sits ON TOP of the requested coordinates — an app window
 * behind another application photographed the OCCLUDER. When the caller
 * threads ownerPid (the browser-capture route passes process.ppid — the
 * Tauri app), the capsule instead finds the owner's top-level window
 * (EnumWindows by pid, containment-first), finds the CHILD webview whose
 * rect tightest-matches the region (Chrome_WidgetWin_1; symmetric-
 * difference scoring because the app's OWN full-client-area UI webview
 * shares the class and MAXES any overlap-only rule), and calls
 * PrintWindow(child, hdc, PW_RENDERFULLCONTENT=2) — the window's own
 * rendered surface, valid while OCCLUDED/unfocused — then crops the
 * region translated into child coords (clamped honestly). ANY window-path
 * failure runs the legacy CopyFromScreen branch VERBATIM; the raster is
 * tagged source:"window"|"screen" (the SRC: marker) so the reply can say
 * WHICH pixels it got. See captureRegion's own comment for the capsule
 * transport + selection-math details.
 *
 * ROUND-66-2-d (R66-2-d): the owner's live Windows test hit a Chromium-sized
 * tree (Edge) — every node paid 4+ cross-process COM pattern probes
 * (Invoke/Toggle/ExpandCollapse/Value, twice more at detail:full), the
 * 800-element cap truncated BEFORE page content, and the model had no way
 * to SEARCH the tree (get_app_state = ingest everything). Fixes in
 * buildSnapshot: (1) pattern probes run ONLY for potentially-interactive
 * ControlTypes ($probe); Text/Pane/Window/Group/… nodes record kind + name
 * + bounds with ZERO GetCurrentPattern calls (their editable/pressable/
 * has_menu flags, value, and advertised actions are therefore absent —
 * fail-closed downstream, never fabricated); (2) maxEl 800 → 2400 (maxDepth
 * stays 25) so Document subtrees survive; (3) the pattern handles are
 * probed ONCE per node and reused for flags + value + action advertisement
 * (the old script re-probed 3 more times for actions). The element action
 * re-walk (windowsElementActionScript) keeps its walk ORDER and index
 * semantics byte-identical — only its $maxEl cap moved 800 → 2400 with the
 * snapshot's, so index N still maps to the SAME element (a 2400-element
 * snapshot with an 800-element re-walk would make indexes 800+ permanently
 * NO_SUCH_ELEMENT — the index contract this file is built on).
 *
 * Every native call is a PowerShell capsule: `powershell.exe -NoProfile
 * -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <base64>` — the
 * script encoded as the base64 of its UTF-16LE text (PowerShell's
 * -EncodedCommand contract) and carried in ARGV, emitting JSON on stdout
 * (ConvertTo-Json -Compress). The backend code runs on the owner's Windows
 * machines; on Linux/macOS hosts the powershell probe fails and every method
 * fails closed with `unsupported_on_backend` — never half-works.
 *
 * Windows specifics encoded (doc 04 §3):
 *   · list_apps: EnumWindows (visible, titled, non-toolwindow top-level
 *     windows) grouped per pid; active = GetForegroundWindow pid
 *   · windows: ALL of the pid's top-level windows (not just
 *     MainWindowHandle); main = largest, focused = GetForegroundWindow
 *   · a11y: System.Windows.Automation (UIA) — FromHandle + ControlViewWalker,
 *     patterns: Invoke → Toggle → ExpandCollapse → SelectionItem (doc 07 §4
 *     priority), LegacyIAccessible default-action via InvokePattern fallback
 *   · DPI: each script calls SetProcessDpiAwarenessContext(
 *     DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) first (doc 03 §5 — without
 *     it Windows lies with virtualized coordinates)
 *   · raw input: SetCursorPos + mouse_event + SendInput (user32 P/Invoke —
 *     R68-C: keyboard input is SendInput ONLY, never Windows.Forms)
 *   · typing: SendText via SendInput KEYEVENTF_UNICODE after focus
 *     verification (R68-C — the SendKeys dependency is dead); > 300 chars
 *     paste from the CLIPBOARD instead (R69-a — Set-Clipboard + Ctrl+V,
 *     payload over stdin base64)
 *   · activation: the AttachThreadInput sequence (doc 04 §3.3) with the
 *     ≤1.5 s postcondition check — honest {active} reporting
 *   · capture: R125-A PrintWindow(PW_RENDERFULLCONTENT) on the owner's
 *     child webview first (occlusion-proof), System.Drawing
 *     CopyFromScreen → PNG → base64 as the honest fallback (SRC: tagged)
 *   · clipboard: Get-Clipboard / Set-Clipboard
 *
 * Commands are NEVER model-generated: the tool layer passes validated
 * numbers/strings into these fixed scripts.
 */
import type {
  AppInfo,
  DisplayInfo,
  Snapshot,
  WindowInfo,
} from "../types.js";
import { categoryOfKind } from "../types.js";
import type {
  BackendCapabilities,
  CuaBackend,
  CommandCapsule,
  ElementDescriptor,
  EnumerationDiagnostics,
  ListAppsResult,
  ListDisplaysResult,
  ListWindowsResult,
  ProbedPermissionReport,
  Raster,
  WindowScope,
} from "./interface.js";
import { pngDimensions } from "./linux.js";
// R93-C: the temp-.ps1 transport (psCapsule's oversized branch) — node fs.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The powershell entry program (pwsh when present, else powershell.exe). */
export const WINDOWS_PS_PROGRAM = "powershell.exe";

/**
 * The shared Preamble every script rides: DPI awareness + the single U32
 * Add-Type (one csc compile — R64-a folded the EnumWindows helpers into the
 * SAME TypeDefinition so every capsule still compiles exactly once; R67-C
 * folded cursorPosition's GetCursorPos/PT into it too — still exactly ONE
 * compile per capsule; R68-C folded the SendInput machinery (input structs
 * + SendText/Chord/TapKey/ModsDown/ModsUp) and the Chromium accessibility
 * poke (EnumChildWindows + SendMessage WM_GETOBJECT) into it — STILL one
 * compile) + the shape-aware OutJson. The C# is CodeDom/C#-5-safe for
 * PowerShell 5.1 (no interpolation, no ?. — Add-Type on powershell.exe
 * compiles C# 5).
 *
 * R68-C: the preamble NO LONGER loads System.Windows.Forms — the old
 * `[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')`
 * line is DEAD WEIGHT REMOVED. The owner's live trace proved
 * LoadWithPartialName silently fails on modern .NET (every SendKeys call
 * died TypeNotFound) while `Add-Type -AssemblyName System.Windows.Forms`
 * in captureDisplay/captureRegion WORKED (screenshots succeeded all
 * round). Input needs no assembly at all now (raw SendInput P/Invoke in
 * U32); the captures keep their OWN proven Add-Type lines.
 *
 * R67-C: the Add-Type is GUARDED — under $ErrorActionPreference='Stop' a
 * failed compile used to abort the WHOLE script before any output (the
 * owner's "the PowerShell session died before emitting JSON"). The flag
 * $script:U32_OK records the outcome, SetProcessDPIAware only runs when the
 * helper exists, and each script degrades honestly: list_apps falls back to
 * the Get-Process MainWindowTitle walk; the scripts that NEED U32 (raw
 * input, activation, window enumeration, frontmost checks) refuse with
 * their existing error shapes instead of aborting silently.
 */
const PS_PREAMBLE = `
$ErrorActionPreference = 'Stop'
$script:U32_OK = $false
$script:U32_ERR = ''
try {
Add-Type -TypeDefinition 'using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public class U32{
[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);
[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint dx,uint dy,uint data,UIntPtr extra);
[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")]public static extern bool AttachThreadInput(uint a,uint b,bool f);
[DllImport("user32.dll")]public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);
[DllImport("user32.dll")]public static extern IntPtr WindowFromPoint(int x,int y);
[DllImport("user32.dll")]public static extern bool GetCursorPos(out PT p);
[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int cmd);
[DllImport("user32.dll")]public static extern bool ShowWindowAsync(IntPtr h,int cmd);
[DllImport("user32.dll")]public static extern bool PostMessage(IntPtr h,uint msg,IntPtr w,IntPtr l);
[DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int cx,int cy,uint f);
public delegate bool EnumProc(IntPtr h,IntPtr lp);
[DllImport("user32.dll")]public static extern bool EnumWindows(EnumProc cb,IntPtr lp);
public delegate bool ChildProc(IntPtr h,IntPtr lp);
[DllImport("user32.dll")]public static extern bool EnumChildWindows(IntPtr p,ChildProc cb,IntPtr lp);
[DllImport("user32.dll")]public static extern IntPtr SendMessage(IntPtr h,uint msg,IntPtr w,IntPtr l);
[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")]public static extern int GetWindowLong(IntPtr h,int i);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowTextLength(IntPtr h);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr h,StringBuilder sb,int max);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetClassName(IntPtr h,StringBuilder sb,int max);
public struct RECT{public int Left;public int Top;public int Right;public int Bottom;}
public struct PT{public int X;public int Y;}
public struct WINFO{public long Hwnd;public uint Pid;public string Title;public int L;public int T;public int R;public int B;}
[StructLayout(LayoutKind.Sequential)]
public struct KEYBDINPUT{public ushort wVk;public ushort wScan;public uint dwFlags;public uint time;public IntPtr dwExtraInfo;}
[StructLayout(LayoutKind.Sequential)]
public struct MOUSEINPUT{public int dx;public int dy;public uint mouseData;public uint dwFlags;public uint time;public IntPtr dwExtraInfo;}
[StructLayout(LayoutKind.Explicit)]
public struct INPUTUNION{[FieldOffset(0)]public MOUSEINPUT mi;[FieldOffset(0)]public KEYBDINPUT ki;}
[StructLayout(LayoutKind.Sequential)]
public struct INPUT{public uint type;public INPUTUNION u;}
[DllImport("user32.dll",SetLastError=true)]public static extern uint SendInput(uint n,INPUT[] p,int cb);
private static INPUT KeyInput(ushort vk,ushort scan,uint flags){
  INPUT i=new INPUT();
  i.type=1;
  i.u.ki.wVk=vk;i.u.ki.wScan=scan;i.u.ki.dwFlags=flags;i.u.ki.time=0;i.u.ki.dwExtraInfo=IntPtr.Zero;
  return i;
}
private static uint SendMany(INPUT[] arr){
  if(arr==null||arr.Length==0)return 0;
  return SendInput((uint)arr.Length,arr,Marshal.SizeOf(typeof(INPUT)));
}
public static uint SendText(string s){
  if(s==null||s.Length==0)return 0;
  List<INPUT> list=new List<INPUT>();
  foreach(char ch in s){
    if(ch=='\\r')continue;
    if(ch=='\\n'){
      list.Add(KeyInput(0x0D,0,0));
      list.Add(KeyInput(0x0D,0,0x0002));
    }else{
      list.Add(KeyInput(0,(ushort)ch,0x0004));
      list.Add(KeyInput(0,(ushort)ch,0x0006));
    }
  }
  return SendMany(list.ToArray());
}
public static uint TapKey(ushort vk){
  INPUT[] arr=new INPUT[2];
  arr[0]=KeyInput(vk,0,0);
  arr[1]=KeyInput(vk,0,0x0002);
  return SendMany(arr);
}
public static uint ModsDown(ushort[] mods){
  if(mods==null||mods.Length==0)return 0;
  INPUT[] arr=new INPUT[mods.Length];
  for(int i=0;i<mods.Length;i++){arr[i]=KeyInput(mods[i],0,0);}
  return SendMany(arr);
}
public static uint ModsUp(ushort[] mods){
  if(mods==null||mods.Length==0)return 0;
  INPUT[] arr=new INPUT[mods.Length];
  for(int i=0;i<mods.Length;i++){arr[i]=KeyInput(mods[i],0,0x0002);}
  return SendMany(arr);
}
public static uint Chord(ushort[] mods,ushort key){
  List<INPUT> list=new List<INPUT>();
  if(mods!=null){for(int i=0;i<mods.Length;i++){list.Add(KeyInput(mods[i],0,0));}}
  list.Add(KeyInput(key,0,0));
  list.Add(KeyInput(key,0,0x0002));
  if(mods!=null){for(int i=mods.Length-1;i>=0;i--){list.Add(KeyInput(mods[i],0,0x0002));}}
  return SendMany(list.ToArray());
}
public static int PokeChromium(IntPtr hwnd){
  List<IntPtr> render=new List<IntPtr>();
  EnumChildWindows(hwnd,delegate(IntPtr h,IntPtr lp){
    try{
      StringBuilder sb=new StringBuilder(64);
      GetClassName(h,sb,64);
      if(sb.ToString()=="Chrome_RenderWidgetHostHWND")render.Add(h);
    }catch(Exception){}
    return true;
  },IntPtr.Zero);
  foreach(IntPtr h in render){
    SendMessage(h,0x3D,IntPtr.Zero,new IntPtr(unchecked((int)0xFFFFFFFC)));
    SendMessage(h,0x3D,IntPtr.Zero,new IntPtr(unchecked((int)0xFFFFFFFD)));
  }
  return render.Count;
}
public static List<WINFO> ListTopWindows(){
  List<WINFO> list=new List<WINFO>();
  EnumWindows(delegate(IntPtr h,IntPtr lp){
    try{
      if(!IsWindowVisible(h))return true;
      if((GetWindowLong(h,-20)&0x00000080)!=0)return true;
      int len=GetWindowTextLength(h);
      if(len<=0)return true;
      StringBuilder sb=new StringBuilder(len+1);
      GetWindowText(h,sb,sb.Capacity);
      string t=sb.ToString();
      if(t==null||t.Trim().Length==0)return true;
      RECT r;GetWindowRect(h,out r);
      if(r.Right-r.Left<=0||r.Bottom-r.Top<=0)return true;
      uint pid;GetWindowThreadProcessId(h,out pid);
      WINFO w;w.Hwnd=h.ToInt64();w.Pid=pid;w.Title=t;w.L=r.Left;w.T=r.Top;w.R=r.Right;w.B=r.Bottom;
      list.Add(w);
    }catch(Exception){}
    return true;
  },IntPtr.Zero);
  return list;
}
}'
  $script:U32_OK = $true
} catch {
  $script:U32_OK = $false
  try { $script:U32_ERR = [string]$_.Exception.Message } catch { $script:U32_ERR = '' }
}
if ($script:U32_OK) { [void][U32]::SetProcessDPIAware() }
# R94-E: the csc-FREE UIA fallback layer. The owner's v0.91.0 Windows 11
# host compiles NEITHER the U32 helper NOR anything else via Add-Type -
# but UIAutomation itself rides .NET assemblies (no csc). When (and ONLY
# when) the U32 compile failed, load UIAutomationClient + UIAutomationTypes
# via LoadWithPartialName (try/catch-guarded; deprecated but PS 5.1-solid)
# and prove the surface with RootElement - $script:UIA_OK is the honest
# flag the enumeration scripts branch on. On a healthy host this block
# never runs (byte-identical cost to pre-R94 capsules).
$script:UIA_OK = $false
if (-not $script:U32_OK) {
  try {
    $null = [System.Reflection.Assembly]::LoadWithPartialName('UIAutomationClient')
    $null = [System.Reflection.Assembly]::LoadWithPartialName('UIAutomationTypes')
    if ($null -ne [System.Windows.Automation.AutomationElement]::RootElement) { $script:UIA_OK = $true }
  } catch { $script:UIA_OK = $false }
}
# R94-E: the Add-Type failure reason, capped at ~300 chars for the JSON
# diagnostics channel - the field report's "enumWindowsCount":-1 said THAT
# csc failed but never WHY ("csc.exe not found" / a locked temp dir / a
# policy). addTypeError rides every diagnostics object the failed compile
# touches, so the next report self-diagnoses.
function AddTypeErr() {
  if ($script:U32_OK) { return '' }
  if ($null -eq $script:U32_ERR) { return '(the Add-Type compile failed with no error message captured)' }
  $m = [string]$script:U32_ERR
  if ($m.Length -gt 300) { $m = $m.Substring(0,300) }
  if ($m.Trim().Length -eq 0) { $m = '(the Add-Type compile failed with no error message captured)' }
  return $m
}
function OutJson($o){
  [Console]::OutputEncoding=[System.Text.Encoding]::UTF8
  if ($null -eq $o) { Write-Output 'null'; return }
  $isList = ($o -is [System.Array]) -or ($o -is [System.Collections.IList])
  if ($isList) {
    $arr = @($o)
    if ($arr.Count -eq 0) { Write-Output '[]'; return }
    Write-Output (ConvertTo-Json -InputObject @($arr) -Compress -Depth 8)
    return
  }
  Write-Output (ConvertTo-Json -InputObject $o -Compress -Depth 8)
}
`;

/** Mouse event flags (winuser.h). */
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const WHEEL_DELTA = 120;

/**
 * ROUND-67 (R67-C): the capsule now rides ARGV via -EncodedCommand (the
 * base64 of the UTF-16LE script text — PowerShell's -EncodedCommand
 * contract) instead of `-Command -` + STDIN. Two live-Windows failure modes
 * die here:
 *   · Windows PowerShell 5.1 under `-Command -` reports unreliable (often 0)
 *     exit codes when a piped script aborts — an aborting script could look
 *     SUCCESSFUL while emitting nothing.
 *   · the runner writes stdin right after spawn with EPIPE swallowed: a
 *     child that exits before reading ran an EMPTY script → exit 0, no
 *     stdout → "died before emitting JSON". The script cannot be lost when
 *     it rides ARGV.
 * `stdin` stays undefined for every psCapsule (the runner then just closes
 * the pipe); R69-a's psStdinCapsule is the ONE deliberate exception (the
 * LONG-TYPE payload — see its docblock). Sizing honesty, RE-MEASURED at
 * R69-a (node over the REAL composed capsules — every fixed script
 * builder measured; buildSnapshot is the biggest): the preamble grew
 * 6,682 → 6,766 chars (the second WM_GETOBJECT poke SendMessage), and the
 * biggest FIXED capsule (preamble + buildSnapshot) measures 11,592 script
 * chars (detail full) / 11,593 (compact) → 30,912 / 30,916 base64 chars —
 * UNDER the 32,767-char CreateProcess command-line ceiling (program + the
 * 5 fixed flags add ~81 more → ~30,997 total) but with only ~1.77K of
 * headroom left: THE PREAMBLE HAS GROWN PAST COMFORT — any further C#
 * growth must re-measure here, and the honest next step is moving the
 * walk to a temp .ps1 file (trimming the C# only buys a little). The
 * capsules that carry MODEL-SUPPLIED payloads IN ARGV (setValue /
 * writeClipboard, and typeText's SHORT per-char path) cannot be pinned by
 * a constant — their length is the model's to choose — so they are
 * guarded AT RUNTIME by ARGV_B64_CEILING below and refuse BEFORE
 * spawning. (R69-a moved typeText's long payloads OFF the ARGV channel
 * entirely: > 300 chars ride psStdinCapsule's STDIN, which has no
 * command-line ceiling. An earlier R68-C draft of this comment claimed
 * the typing path "stays far below" because its timeout math caps text at
 * ~1,400 chars — that was WRONG: Math.min clamps the TIMEOUT at 30s, it
 * does NOT cap the text; a long type would have crossed the ceiling and
 * died at CreateProcess with a cryptic spawn error. The runtime guard
 * was the R68-C fix; the stdin channel is the R69-a fix.)
 * ROUND-125 (R125-A) RE-MEASURED (the law above honored): captureRegion
 * grew to carry the PrintWindow path (the Cap helper + the owner/child
 * selection) — preamble 8,827 + script 7,654 = 16,482 script chars →
 * 43,952 base64, PAST the 30,000 switch → the capture capsule now rides
 * the temp-.ps1 -File transport (buildSnapshot's precedent; no command-
 * line ceiling, exit codes at least as reliable). The preamble itself is
 * UNTOUCHED by R125-A — the Cap class lives inside the capture script so
 * every OTHER capsule's ARGV budget is re-priced by exactly nothing.
 */
const psCapsule = (script: string, timeoutMs = 20000): CommandCapsule => {
  const full = `${PS_PREAMBLE}\n${script}`;
  const b64 = Buffer.from(full, "utf16le").toString("base64");
  if (b64.length <= PS_ARGV_SWITCH_B64) {
    return {
      program: WINDOWS_PS_PROGRAM,
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", b64],
      timeoutMs,
    };
  }
  // R93-C: the TEMP-.ps1 TRANSPORT — the docblock's honest next step,
  // arrived: the v2 walk (hierarchy + the three clickability probe layers)
  // pushed the biggest FIXED capsule past the CreateProcess command-line
  // ceiling (measured 33,140 base64 chars > 32,767 − 81) — the spawn would
  // have DIED on real Windows. Every script too big for ARGV now rides a
  // temp .ps1 file + -File: no command-line ceiling at all, and -File
  // reports exit codes at least as reliably as -EncodedCommand (R67-C's
  // original win). The temp dir is removed on a delayed timer (past ANY
  // capsule timeout — the runner may still be reading the file when this
  // factory returns) — best-effort cleanup, never blocking the caller.
  const dir = mkdtempSync(join(tmpdir(), "acute-ps-"));
  const file = join(dir, "s.ps1");
  // C5: UTF-8 WITH BOM. powershell.exe is Windows PowerShell 5.1, which
  // decodes a BOM-LESS .ps1 as ANSI — the walk's "›" path separator and
  // "…" truncation ellipsis would mojibake ("Foo â€º Bar") on every
  // full-detail snapshot. The BOM makes 5.1 decode UTF-8 correctly (and
  // is a no-op for pwsh 7+, which sniffs it natively).
  writeFileSync(file, "\uFEFF" + full, "utf8");
  const delay = Math.max(120_000, timeoutMs + 30_000);
  setTimeout(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort — the OS temp cleaner owns the rest */
    }
  }, delay).unref?.();
  return {
    program: WINDOWS_PS_PROGRAM,
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
    timeoutMs,
  };
};

/**
 * R93-C: the ARGV→file switch point (base64 chars). Comfortably under the
 * 31,875 runtime guard and the 32,767 ceiling — every script below it rides
 * -EncodedCommand exactly as before R93-C; above it, the temp-file
 * transport. 30,000 leaves ~1.8K of margin for the fixed flags.
 */
const PS_ARGV_SWITCH_B64 = 30_000;

/** R68-C: the CreateProcess command-line ceiling, in base64 chars. The
 * full argv is `powershell.exe -NoProfile -NonInteractive
 * -ExecutionPolicy Bypass -EncodedCommand <blob>` — the fixed part
 * measures 81 chars (program + flags + separators; the blob itself is
 * pure base64, never quoted), so the hard max for the blob is 32,767 − 81
 * = 32,686. The guard fires at 31,875, leaving ~810 chars of defensive
 * slack. Applied ONLY to the capsules that embed MODEL-SUPPLIED payloads
 * (typeText text / setValue value / writeClipboard text — see the
 * psCapsule docblock for the measured fixed capsules). */
const ARGV_B64_CEILING = 31_875;

/** R68-C: the projected -EncodedCommand blob length of a (preamble +
 * script) capsule — the exact composition psCapsule performs, measured
 * without spawning, for the ARGV ceiling guard. */
function capsuleB64Length(script: string): number {
  return Buffer.from(`${PS_PREAMBLE}\n${script}`, "utf16le").toString("base64").length;
}

/**
 * R69-a: the payload-channel capsule for LONG TEXT. The SCRIPT rides
 * -EncodedCommand ARGV exactly like every other capsule (R67-C's contract:
 * the script cannot be lost — the R67-C stdin failure was the whole SCRIPT
 * riding `-Command -`, not a payload), while the MODEL'S TEXT rides STDIN
 * as base64(UTF-8):
 *   · no CreateProcess 32,767-char command-line ceiling (stdin is a pipe —
 *     a 100k-char type composes the same small fixed script);
 *   · the bytes crossing the pipe are PURE ASCII base64 — no console-input
 *     encoding ambiguity on PS 5.1, and the decode side is pinned exact:
 *     [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(…)),
 *     so the clipboard write preserves EXACT Unicode by construction;
 *   · the runner writes stdin and CLOSES it (backends/index.ts), so
 *     [Console]::In.ReadToEnd() terminates; an EMPTY payload (the EPIPE
 *     class) is detected inside the script and refuses honestly — nothing
 *     is typed.
 */
const psStdinCapsule = (script: string, stdin: string, timeoutMs = 12000): CommandCapsule => ({
  program: WINDOWS_PS_PROGRAM,
  args: [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(`${PS_PREAMBLE}\n${script}`, "utf16le").toString("base64"),
  ],
  stdin,
  timeoutMs,
});

/**
 * R69-a: the LONG-TYPE threshold — text longer than this many characters
 * types via the CLIPBOARD PASTE path (Set-Clipboard + Ctrl+V Chord) instead
 * of per-char KEYEVENTF_UNICODE. Exported for the threshold-boundary pins
 * (299/300/301). 300 chars ≈ where per-char typing stops being reasonable
 * (2 SendInput events per char, ~20ms/char of timeout budget) and where
 * model payloads start realistically colliding with the ARGV ceiling's
 * ~4.8k-char capacity.
 */
export const LONG_TYPE_THRESHOLD = 300;

/** R67-C: a bare probe capsule (NO preamble) — the tiny Add-Type compile
 * probe rides this; probe scripts must not drag the U32 preamble in. */
const rawPsCapsule = (script: string, timeoutMs = 20000): CommandCapsule => ({
  program: WINDOWS_PS_PROGRAM,
  args: [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ],
  timeoutMs,
});

/** The guard every U32-dependent script begins with: refuse honestly when
 * the Add-Type compile failed (the script still runs — the R67-C point — it
 * just never touches [U32]). */
const U32_GUARD = "if (-not $script:U32_OK) { Write-Output 'ERR:U32-unavailable (the Add-Type helper did not compile on this host - this action is unavailable)'; exit 0 }";

function okResult(stdout: string): { ok: boolean; error?: string; stale?: boolean } {
  const text = stdout.trim();
  if (text === "" ) return { ok: true };
  if (text === "STALE_ELEMENT") return { ok: false, stale: true, error: "element identity changed since the snapshot" };
  if (text === "NO_SUCH_ELEMENT") return { ok: false, stale: true, error: "element index out of range in the live tree" };
  if (text.startsWith("ERR:")) return { ok: false, error: text.slice(4, 304) };
  return { ok: true };
}

/* ── R64-a: strict JS-side parsers for the deterministic JSON shapes ────────
 * Every enumeration script emits a wrapper object via the shape-aware
 * OutJson ({"apps":[…] | "windows":[…] | "displays":[…], "diagnostics":{…}}),
 * so the parse side can be strict: an unknown/garbage field is DROPPED, a
 * malformed entry is skipped (never silently mapped into NaN). */

function toBounds(raw: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(raw) || raw.length !== 4) return undefined;
  const nums = raw.map((n) => Number(n));
  if (nums.some((n) => !Number.isFinite(n))) return undefined;
  return [nums[0], nums[1], nums[2], nums[3]];
}

function toAppInfoList(raw: unknown): AppInfo[] {
  if (!Array.isArray(raw)) return [];
  const apps: AppInfo[] = [];
  for (const a of raw) {
    if (typeof a !== "object" || a === null) continue;
    const rec = a as Record<string, unknown>;
    const pid = Number(rec["pid"]);
    const name = typeof rec["name"] === "string" ? rec["name"] : "";
    if (!Number.isInteger(pid) || pid <= 0 || name.trim() === "") continue;
    const app: AppInfo = { name, pid, active: rec["active"] === true };
    const processName = typeof rec["processName"] === "string" ? rec["processName"] : "";
    if (processName.trim() !== "") app.processName = processName;
    apps.push(app);
  }
  return apps;
}

function toWindowInfoList(raw: unknown): WindowInfo[] {
  if (!Array.isArray(raw)) return [];
  const windows: WindowInfo[] = [];
  for (const w of raw) {
    if (typeof w !== "object" || w === null) continue;
    const rec = w as Record<string, unknown>;
    const windowId = Number(rec["windowId"]);
    const title = typeof rec["title"] === "string" ? rec["title"] : "";
    const bounds = toBounds(rec["bounds"]);
    if (!Number.isInteger(windowId) || windowId === 0 || bounds === undefined) continue;
    windows.push({
      windowId,
      title,
      bounds,
      main: rec["main"] === true,
      focused: rec["focused"] === true,
    });
  }
  return windows;
}

function toDiagnostics(raw: unknown): EnumerationDiagnostics | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const diag: EnumerationDiagnostics = {
    ...(num(r["processCount"]) !== undefined ? { processCount: num(r["processCount"]) } : {}),
    ...(r["foregroundPid"] !== undefined ? { foregroundPid: num(r["foregroundPid"]) ?? null } : {}),
    ...(num(r["enumWindowsCount"]) !== undefined ? { enumWindowsCount: num(r["enumWindowsCount"]) } : {}),
    ...(r["processRunning"] !== undefined ? { processRunning: r["processRunning"] === true } : {}),
    ...(num(r["screenCount"]) !== undefined ? { screenCount: num(r["screenCount"]) } : {}),
    ...(r["uiaFallback"] !== undefined ? { uiaFallback: r["uiaFallback"] === true } : {}),
    ...(typeof r["addTypeError"] === "string" && r["addTypeError"].trim() !== "" ? { addTypeError: r["addTypeError"] } : {}),
    ...(typeof r["note"] === "string" && r["note"].trim() !== "" ? { note: r["note"] } : {}),
  };
  return Object.keys(diag).length > 0 ? diag : undefined;
}

function capsuleFailureDiagnostics(what: string, result: { code: number; stdout: string; stderr: string }): EnumerationDiagnostics {
  const first = (result.stderr || result.stdout).trim().split("\n")[0] ?? "";
  return { note: `${what} capsule failed (exit ${result.code}): ${first.slice(0, 200)}` };
}

const windowsBackend: CuaBackend = {
  kind: "windows",

  capabilities(): BackendCapabilities {
    return {
      a11yTree: true, // UIA — excellent for native/WinForms/WPF/Qt/Chromium
      backgroundElementPress: true, // UIA Invoke is background-safe
      backgroundValueWrite: true, // ValuePattern
      backgroundRawInput: false, // needs foreground (UIPI also applies)
      windowScopedTyping: false,
      capture: true, // GDI CopyFromScreen
      clipboard: true,
      rawRequiresForeground: true,
      permissionGates: ["UIPI limits elevated targets"],
    };
  },

  async listApps(run): Promise<ListAppsResult> {
    const result = await run(psCapsule(windowsListAppsScript(), 20000));
    if (result.code !== 0) {
      return { apps: [], diagnostics: capsuleFailureDiagnostics("list_apps", result) };
    }
    const text = result.stdout.trim();
    if (text === "") {
      return { apps: [], diagnostics: { note: "list_apps produced no output (the PowerShell session died before emitting JSON)" } };
    }
    try {
      const parsed = JSON.parse(text) as { apps?: unknown; diagnostics?: unknown };
      return { apps: toAppInfoList(parsed.apps), diagnostics: toDiagnostics(parsed.diagnostics) };
    } catch (err) {
      return { apps: [], diagnostics: { note: `list_apps output was not valid JSON: ${String(err).slice(0, 200)}` } };
    }
  },

  async listWindows(run, app): Promise<ListWindowsResult> {
    if (app.pid === undefined || !Number.isInteger(app.pid) || app.pid <= 0) {
      return { windows: [], diagnostics: { note: "list_windows needs a positive integer pid" } };
    }
    const result = await run(psCapsule(windowsListWindowsScript(app.pid), 12000));
    if (result.code !== 0) {
      return { windows: [], diagnostics: capsuleFailureDiagnostics("list_windows", result) };
    }
    const text = result.stdout.trim();
    if (text === "") {
      return { windows: [], diagnostics: { note: "list_windows produced no output (the PowerShell session died before emitting JSON)" } };
    }
    try {
      const parsed = JSON.parse(text) as { windows?: unknown; diagnostics?: unknown };
      return { windows: toWindowInfoList(parsed.windows), diagnostics: toDiagnostics(parsed.diagnostics) };
    } catch (err) {
      return { windows: [], diagnostics: { note: `list_windows output was not valid JSON: ${String(err).slice(0, 200)}` } };
    }
  },

  async listDisplays(run): Promise<ListDisplaysResult> {
    const result = await run(psCapsule(windowsListDisplaysScript(), 10000));
    if (result.code !== 0) {
      // R64-a: NO fake 1920×1080 — a failed enumeration is an honest []
      // + diagnostics (the owner's 1280×1024 screen was reported as the
      // fake fallback for a whole live session).
      return { displays: [], diagnostics: capsuleFailureDiagnostics("list_displays", result) };
    }
    const text = result.stdout.trim();
    if (text === "") {
      return { displays: [], diagnostics: { note: "list_displays produced no output (the PowerShell session died before emitting JSON)" } };
    }
    try {
      const parsed = JSON.parse(text) as { displays?: unknown; diagnostics?: unknown };
      const displays: DisplayInfo[] = [];
      if (Array.isArray(parsed.displays)) {
        for (const d of parsed.displays) {
          const rec = d as Record<string, unknown>;
          const index = Number(rec["index"]);
          const bounds = toBounds(rec["bounds"]);
          if (!Number.isInteger(index) || index < 1 || bounds === undefined) continue;
          displays.push({ index, bounds, main: rec["main"] === true });
        }
      }
      return { displays, diagnostics: toDiagnostics(parsed.diagnostics) };
    } catch (err) {
      return { displays: [], diagnostics: { note: `list_displays output was not valid JSON: ${String(err).slice(0, 200)}` } };
    }
  },

  async buildSnapshot(run, app, window, detail) {
    const includeBounds = detail === "full" ? "$true" : "$false";
    // R68-C (C4) — the Chromium accessibility POKE: Chromium (Edge/Chrome)
    // builds its web accessibility tree ONLY after an assistive technology
    // pokes the render widget (WM_GETOBJECT to the Chrome_RenderWidgetHostHWND
    // child — exactly what a screen reader does on connect; the owner's own
    // Tab-highlight intuition). This is why the owner's Edge trees came back
    // SPARSE (only the window element): the tree EXISTS, we just never asked
    // for it. One poke site here covers BOTH get_app_state AND find_elements
    // (the dispatcher routes both through THIS method — verified by read).
    // U32-gated (the walk itself needs no U32).
    //
    // R69-a (C4 hardening): the poke now sends WM_GETOBJECT TWICE per render
    // child — lParam 0xFFFFFFFC (OBJID_CLIENT, the MSAA path, unchanged)
    // AND lParam 0xFFFFFFFD (UiaRootObjectId, which activates the UIA
    // provider path directly — System.Windows.Automation IS UIA, so the
    // second poke asks Chromium for the tree in the dialect the walk below
    // actually speaks). The settle is now a POLL (see the loop after the
    // Walk function): while the walk stays SPARSE (≤1 element = only the
    // root window), re-walk at cumulative checkpoints 400/800/1400/2000ms
    // (4 attempts max), returning IMMEDIATELY once the tree is non-sparse —
    // the old fixed 400ms + one 600ms sparse-retry gave a cold Chromium
    // render tree at most 1s to build.
    // R93-C NOTE (capsule budget): the v2 walk genuinely grows the fixed
    // buildSnapshot capsule — the hierarchy emission + the three §2.2 probe
    // layers add ~900 script chars over the R69-a walk. The in-script
    // comments were TRIMMED to one-liners (the full rationale lives in THIS
    // docblock + the R66-2-d/R69-a history above) so the capsule stays under
    // the CreateProcess ceiling — the psCapsule docblock's numbers below
    // are re-measured for the v2 walk.
    const script = `
Add-Type -AssemblyName UIAutomationClient
$pokeCount = 0
if ($script:U32_OK) { try { $pokeCount = [U32]::PokeChromium([IntPtr]${window.windowId}) } catch { $pokeCount = 0 } }
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${window.windowId})
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$out = New-Object System.Collections.ArrayList
$maxDepth = 25; $maxEl = 2400
# R66-2-d: ControlTypes that MIGHT carry interactive patterns — they alone
# get the 4 COM pattern probes (the Edge-crawl fix).
$probe = @('Button','Hyperlink','Edit','ComboBox','CheckBox','RadioButton','Slider','TabItem','MenuItem','ListItem','DataItem','TreeItem','Spinner','Thumb','ScrollBar','Document','Custom')
$kindMap = @{Window='window';MenuItem='menuitem';Button='button';Hyperlink='button';Edit='textfield';Document='textfield';ComboBox='combobox';CheckBox='checkbox';RadioButton='checkbox';Slider='slider';Tab='pane';TabItem='tab';DataItem='row';ListItem='row';TreeItem='row';Text='text';Image='image'}
function MapKind($ct) { if ($kindMap.ContainsKey($ct)) { return $kindMap[$ct] }; return 'pane' }
$winKey = 'w${window.windowId}-0'
function Walk($el, $depth, $parentKey, $pathSegs) {
  if ($out.Count -ge $maxEl -or $depth -gt $maxDepth) { return }
  try {
    if ($null -eq $el) { return }
    $ct = $el.Current.ControlType.ProgrammaticName -replace '^ControlType.', ''
    $name = $el.Current.Name; if ($null -ne $name -and $name.Length -gt 120) { $name = $name.Substring(0,120) }
    $interactive = $probe -contains $ct
    $via = ''
    if ($interactive) { $via = 'type' }
    # ONE pattern pass — TYPE kinds always probe; NAMED non-type elements
    # probe too (the pattern layer: interactive controls hiding in generic
    # panes). Unnamed nodes skip the probes (cost without signal).
    $ip = $null; $tp = $null; $ec = $null; $vp = $null
    if ($interactive -or ($name -and $depth -gt 0)) {
      try { $ip = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern) } catch {}
      try { $tp = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern) } catch {}
      try { $ec = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern) } catch {}
      try { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch {}
    }
    # The layered net (managed bridge only — ACTION/MSAA legacy need the
    # COM IUIAutomation face System.Windows.Automation never exposes).
    if ($depth -gt 0 -and -not $interactive) {
      if ($null -ne $ip -or $null -ne $tp -or $null -ne $ec -or $null -ne $vp) { $interactive = $true; $via = 'pattern' }
      if (-not $interactive) {
        try { $kb = $el.Current.IsKeyboardFocusable } catch { $kb = $false }
        $k = MapKind $ct
        if ("$kb" -eq 'True' -and $name -and $k -ne 'window' -and $k -ne 'pane') { $interactive = $true; $via = 'focusable' }
      }
    }
    $flags = @()
    if ($null -ne $ip -or $null -ne $tp) { $flags += 'pressable' }
    if ($null -ne $ec) { $flags += 'has_menu' }
    if ($null -ne $vp) { $flags += 'editable' }
    try { if ($el.Current.IsKeyboardFocused) { $flags += 'focused' } } catch {}
    $key = "$winKey-$($out.Count)"
    $segs = @(); if ($null -ne $pathSegs) { $segs = @($pathSegs) }
    if ($name) { $segs = @($segs + $name) }
    $shown = $segs; if ($shown.Count -gt 5) { $shown = @('…') + @($shown[-5..-1]) }
    $path = ''
    if ($shown.Count -gt 0) { $path = $shown -join ' › '; if ($path.Length -gt 120) { $path = $path.Substring(0,120) } }
    $entry = [pscustomobject]@{ index = $out.Count; kind = (MapKind $ct); name = [string]$name; flags = $flags; key = $key; windowKey = $winKey; parentKey = $parentKey; path = $path; treeDepth = $depth; interactive = $interactive }
    if ($null -ne $vp) {
      try {
        $v = $vp.Current.Value; if ($null -ne $v -and $v.Length -gt 120) { $v = $v.Substring(0,120) }
        $entry | Add-Member -NotePropertyName value -NotePropertyValue ([string]$v)
      } catch {}
    }
    if (${includeBounds}) {
      try { $b = $el.Current.BoundingRectangle; $entry | Add-Member -NotePropertyName bounds -NotePropertyValue @([int]$b.X, [int]$b.Y, [int]$b.Width, [int]$b.Height) } catch {}
      if ($null -ne $ip) { $entry | Add-Member -NotePropertyName actions -NotePropertyValue @('Invoke') }
      if ($null -ne $tp) { $entry | Add-Member -NotePropertyName actions -NotePropertyValue @('Toggle') }
      if ($null -ne $ec) { $entry | Add-Member -NotePropertyName actions -NotePropertyValue @('Expand') }
    }
    if ($via) { $entry | Add-Member -NotePropertyName via -NotePropertyValue $via }
    [void]$out.Add($entry)
    $child = $walker.GetFirstChildElement($el)
    while ($null -ne $child) { Walk $child ($depth + 1) $key $segs; $child = $walker.GetNextSiblingElement($child) }
  } catch { return }
}
# R69-a: poll while SPARSE — 4 checkpoints, break once non-sparse.
if ($pokeCount -gt 0) {
  $waits = @(400, 400, 600, 600)
  foreach ($w in $waits) {
    Start-Sleep -Milliseconds $w
    $out = New-Object System.Collections.ArrayList
    Walk $root 0
    if ($out.Count -gt 1) { break }
  }
} else {
  Walk $root 0
}
if ($out.Count -eq 0) { Write-Output (ConvertTo-Json -Compress @{ error = 'EMPTY_TREE' }); exit 0 }
OutJson @{ elements = $out }
`;
    const result = await run(psCapsule(script, 25000));
    if (result.code !== 0) {
      return { error: `UIA walk failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`, emptyTree: false };
    }
    const text = result.stdout.trim();
    if (text.includes('"error":"EMPTY_TREE"') || text.includes("EMPTY_TREE")) {
      return { error: "The window exposes no accessibility elements", emptyTree: true };
    }
    try {
      const parsed = JSON.parse(text) as { elements: Snapshot["elements"] };
      const elements = Array.isArray(parsed.elements) ? parsed.elements : [];
      if (elements.length === 0) {
        return { error: "The window exposes no accessibility elements", emptyTree: true };
      }
      return buildSnapshotRecord(app, window, elements, detail);
    } catch (err) {
      return { error: `UIA walk output was not valid JSON: ${String(err).slice(0, 200)}`, emptyTree: true };
    }
  },

  async hitTest(run, globalPt) {
    const script = `
Add-Type -AssemblyName UIAutomationClient
$pt = New-Object System.Windows.Point(${globalPt.x}, ${globalPt.y})
$el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
if ($null -eq $el) { Write-Output 'null'; exit 0 }
$ct = $el.Current.ControlType.ProgrammaticName -replace '^ControlType.', ''
$name = [string]$el.Current.Name; if ($name.Length -gt 120) { $name = $name.Substring(0,120) }
$actionable = $false
try { $null = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $actionable = $true } catch {}
try { $null = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); $actionable = $true } catch {}
try { $null = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $actionable = $true } catch {}
OutJson @{ kind = $ct; name = $name; actionable = $actionable }
`;
    const result = await run(psCapsule(script, 10000));
    if (result.code !== 0 || result.stdout.trim() === "" || result.stdout.trim() === "null") return null;
    try {
      const hit = JSON.parse(result.stdout.trim()) as { kind: string; name: string; actionable: boolean };
      return { kind: hit.kind, name: hit.name, actionable: !!hit.actionable };
    } catch {
      return null;
    }
  },

  async focusedElementName(run, pid) {
    // R67-C: the Tab-walk readback — the dispatcher's key tool calls this
    // after a successful key press so the agent SEES the focused element
    // (the owner's element-discovery technique). Guarded on U32 (the
    // foreground check needs it); a non-foreground target honestly yields
    // '' → null (the field is then omitted upstream, never fabricated).
    const script = `
Add-Type -AssemblyName UIAutomationClient
if (-not $script:U32_OK) { Write-Output ''; exit 0 }
$fg = [U32]::GetForegroundWindow()
$fgpid = 0
[void][U32]::GetWindowThreadProcessId($fg, [ref]$fgpid)
if ($fgpid -ne ${pid}) { Write-Output ''; exit 0 }
$el = [System.Windows.Automation.AutomationElement]::FocusedElement
if ($null -eq $el) { Write-Output ''; exit 0 }
$n = [string]$el.Current.Name
if ($n.Length -gt 200) { $n = $n.Substring(0,200) }
Write-Output $n
`;
    const result = await run(psCapsule(script, 10000));
    if (result.code !== 0) return null;
    return result.stdout.trim().slice(0, 200) || null;
  },

  async pressElement(run, pid, window, element) {
    const script = windowsElementActionScript(pid, window, element, "press");
    const result = await run(psCapsule(script, 15000));
    return okResult(result.stdout);
  },

  async setValue(run, pid, window, element, value) {
    const script = windowsElementActionScript(pid, window, element, "setValue", value);
    // R68-C: the ARGV ceiling guard — the element write embeds the model's
    // value (type's element-target mode rides this path); refuse BEFORE
    // the spawn when the composed capsule would cross CreateProcess's
    // command-line ceiling (self-teaching: split the write or type).
    const b64Len = capsuleB64Length(script);
    if (b64Len > ARGV_B64_CEILING) {
      return { ok: false, error: `set_value text too long: ${value.length} characters compose a ${b64Len}-char -EncodedCommand (the Windows CreateProcess ceiling is 32,767 command-line chars) — split it across multiple calls (type the rest in chunks)` };
    }
    const result = await run(psCapsule(script, 15000));
    return okResult(result.stdout);
  },

  async performAction(run, pid, window, element, action) {
    const script = windowsElementActionScript(pid, window, element, "action", undefined, action);
    const result = await run(psCapsule(script, 15000));
    return okResult(result.stdout);
  },

  async selectRange(run, pid, window, element, start, length) {
    const script = windowsElementActionScript(pid, window, element, "select", undefined, undefined, start, length);
    const result = await run(psCapsule(script, 15000));
    return okResult(result.stdout);
  },

  async rawClick(run, pt, button, clickCount, modifiers) {
    // R68-C: modifier holds ride SendInput (ModsDown/ModsUp) — the old
    // SendKeys '{CTRLDOWN}' path died TypeNotFound on the owner's host.
    // The array declaration is conditional: a plain click carries no mods
    // machinery at all.
    const modVks = modifierVks(modifiers);
    const modsDecl = modVks.length > 0 ? psVkArray("m", modVks) : "";
    const modsDown = modVks.length > 0 ? "[void][U32]::ModsDown($m)" : "";
    const modsUp = modVks.length > 0 ? "[void][U32]::ModsUp($m)" : "";
    const flags =
      button === "left"
        ? [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP]
        : button === "right"
          ? [MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP]
          : [MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP];
    const script = `
${U32_GUARD}
${modsDecl}
${modsDown}
[void][U32]::SetCursorPos(${pt.x}, ${pt.y})
Start-Sleep -Milliseconds 30
${Array.from({ length: Math.min(Math.max(clickCount, 1), 3) }, () => `[U32]::mouse_event(${flags[0]},0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 35; [U32]::mouse_event(${flags[1]},0,0,0,[UIntPtr]::Zero)`).join("\n")}
${modsUp}
Write-Output 'OK'
`;
    const result = await run(psCapsule(script, 12000));
    if (result.code !== 0) {
      return { ok: false, error: `click failed: ${result.stderr.trim().slice(0, 200)}` };
    }
    return okResult(result.stdout);
  },

  async rawScroll(run, pt, direction, amount) {
    // R69-a: ONE wheel event carrying delta = ticks × WHEEL_DELTA. The
    // R68-C construction was QUADRATIC — it sent `ticks` events, each
    // carrying ±(ticks×WHEEL_DELTA), so the delivered scroll was
    // ticks²×120 (a 10-tick scroll moved 100× the intent; 33 ticks moved
    // 1089×). Horizontal now rides MOUSEEVENTF_HWHEEL (0x1000, positive =
    // right) with the same single-event math — the old arrow-key TapKey
    // approximation never scrolled browser CONTENT at all (arrows move
    // focus/caret, not the page). The cursor is positioned at (pt) FIRST
    // (SetCursorPos + 30ms settle — wheel events affect the window under
    // the cursor; the dispatcher always resolves a global (x,y) target).
    const ticks = Math.max(1, Math.min(40, Math.round(amount / 3) || 1));
    // Clamp the wheel data to the signed-int range mouse_event accepts.
    const delta = Math.min(32767, ticks * WHEEL_DELTA);
    const isVertical = direction === "up" || direction === "down";
    const wheelFlag = isVertical ? "0x0800" : "0x1000"; // MOUSEEVENTF_WHEEL / MOUSEEVENTF_HWHEEL
    // Vertical: positive = away from the user (up). Horizontal: positive = right.
    const negative = direction === "down" || direction === "left";
    const signed = negative ? -delta : delta;
    const script = `
${U32_GUARD}
[void][U32]::SetCursorPos(${pt.x}, ${pt.y})
Start-Sleep -Milliseconds 30
[U32]::mouse_event(${wheelFlag},0,0,${signed},[UIntPtr]::Zero)
Write-Output 'OK'
`;
    const result = await run(psCapsule(script, 12000));
    if (result.code !== 0) {
      return { ok: false, error: `scroll failed: ${result.stderr.trim().slice(0, 200)}` };
    }
    return okResult(result.stdout);
  },

  async rawDrag(run, from, to, modifiers) {
    // R68-C: modifier holds ride SendInput (ModsDown/ModsUp) — the old
    // SendKeys '{CTRLDOWN}' path died TypeNotFound on the owner's host.
    // The array declaration is conditional like rawClick's.
    const modVks = modifierVks(modifiers);
    const modsDecl = modVks.length > 0 ? psVkArray("m", modVks) : "";
    const modsDown = modVks.length > 0 ? "[void][U32]::ModsDown($m)" : "";
    const modsUp = modVks.length > 0 ? "[void][U32]::ModsUp($m)" : "";
    const script = `
${U32_GUARD}
${modsDecl}
${modsDown}
[void][U32]::SetCursorPos(${from.x}, ${from.y})
Start-Sleep -Milliseconds 60
[U32]::mouse_event(${MOUSEEVENTF_LEFTDOWN},0,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
$steps = 12
for ($i = 1; $i -le $steps; $i++) {
  $nx = ${from.x} + [int]((${to.x} - ${from.x}) * $i / $steps)
  $ny = ${from.y} + [int]((${to.y} - ${from.y}) * $i / $steps)
  [void][U32]::SetCursorPos($nx, $ny)
  Start-Sleep -Milliseconds 25
}
Start-Sleep -Milliseconds 60
[U32]::mouse_event(${MOUSEEVENTF_LEFTUP},0,0,0,[UIntPtr]::Zero)
${modsUp}
Write-Output 'OK'
`;
    const result = await run(psCapsule(script, 20000));
    if (result.code !== 0) {
      return { ok: false, error: `drag failed: ${result.stderr.trim().slice(0, 200)}` };
    }
    return okResult(result.stdout);
  },

  async rawButton(run, pt, down) {
    const script = `
${U32_GUARD}
[void][U32]::SetCursorPos(${pt.x}, ${pt.y})
Start-Sleep -Milliseconds 30
[U32]::mouse_event(${down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP},0,0,0,[UIntPtr]::Zero)
Write-Output 'OK'
`;
    const result = await run(psCapsule(script, 8000));
    if (result.code !== 0) {
      return { ok: false, error: `button failed: ${result.stderr.trim().slice(0, 200)}` };
    }
    return okResult(result.stdout);
  },

  async rawKey(run, keys, scope) {
    // R68-C: the tokens compose ONE SendInput chord via composeVkChord —
    // "tab" is VK 0x09, "ctrl+a" is mods [VK_CONTROL] + key 'A', never
    // literal text (the old path typed t-a-b before R67-C; R68-C kills the
    // SendKeys engine itself). An uncomposable chord (an unknown name)
    // refuses honestly WITHOUT spawning a capsule: nothing is typed.
    // NOTE: the Windows/Meta key is a REAL VK here (LWIN 0x5B) — SendInput
    // synthesizes it where SendKeys could not.
    const chord = composeVkChord(keys);
    if (!chord.ok) return { ok: false, error: chord.error };
    // Scope verification first (Win raw keys land in the frontmost window).
    // The modifier array rides a PowerShell variable (the defensive form:
    // `[uint16]` casts in the array literal guarantee the object[]→ushort[]
    // marshaling on PS 5.1; an empty `@()` marshals as a zero-length array
    // — construction-pinned, PowerShell never runs in this sandbox).
    const modsDecl = psVkArray("m", chord.mods);
    const script = `
${U32_GUARD}
$fg = [U32]::GetForegroundWindow()
$fgpid = 0
[void][U32]::GetWindowThreadProcessId($fg, [ref]$fgpid)
if ($fgpid -ne ${scope.pid}) { Write-Output "FRONTMOST_MISMATCH:$fgpid"; exit 0 }
${modsDecl}
[void][U32]::Chord($m, [uint16]${chord.key})
Write-Output 'OK'
`;
    const result = await run(psCapsule(script, 10000));
    if (result.stdout.trim().startsWith("FRONTMOST_MISMATCH:")) {
      return { ok: false, error: result.stdout.trim() };
    }
    if (result.code !== 0) {
      return { ok: false, error: `key failed: ${result.stderr.trim().slice(0, 200)}` };
    }
    return okResult(result.stdout);
  },

  async typeText(run, text, scope) {
    // R68-C: SendInput KEYEVENTF_UNICODE per char — [U32]::SendText takes
    // the RAW string in a PowerShell here-string literal (the
    // psStringLiteral escape for '@ sequences aside, SendInput needs NO
    // SendKeys-style escaping at all: '+', '%', '~', braces are just
    // characters — the whole escaping class of bugs is dead; the live trace
    // PROVED the single-line @'…'@ literal parses on PS 5.1: the type
    // resolution failed AFTER the parse). Newlines map to real VK_RETURN
    // presses inside SendText ('\r' is skipped so \r\n pairs type ONE
    // Enter). The frontmost scope check stays (Win raw input lands in the
    // frontmost window); the dispatcher auto-activates + retries on
    // mismatch (R68-C).
    //
    // R69-a: LONG TEXT (> LONG_TYPE_THRESHOLD chars) types via the
    // CLIPBOARD instead: (a) Set-Clipboard the text, (b) 200ms settle,
    // (c) Ctrl+V through the existing [U32]::Chord primitive (VK_CONTROL
    // + 'V'). The payload rides psStdinCapsule's STDIN base64(UTF-8)
    // channel — see its docblock — so the ARGV ceiling no longer caps
    // typed text and the Unicode survives EXACTLY (UTF8.GetString on the
    // decoded base64). Short text (≤ threshold) keeps the per-char path
    // below UNCHANGED.
    if (text.length > LONG_TYPE_THRESHOLD) {
      const script = `
${U32_GUARD}
$fg = [U32]::GetForegroundWindow()
$fgpid = 0
[void][U32]::GetWindowThreadProcessId($fg, [ref]$fgpid)
if ($fgpid -ne ${scope.pid}) { Write-Output "FRONTMOST_MISMATCH:$fgpid"; exit 0 }
$payload = [Console]::In.ReadToEnd()
$payload = $payload.Trim()
if ($payload.Length -eq 0) { Write-Output 'ERR:stdin-payload-lost (the clipboard paste received no text on stdin - the long text was not delivered; retry the type call)'; exit 0 }
try { $paste = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) } catch { Write-Output 'ERR:stdin-payload-corrupt (the base64 stdin payload could not be decoded)'; exit 0 }
try { Set-Clipboard -Value $paste -ErrorAction Stop } catch { Write-Output ("ERR:" + $_.Exception.Message); exit 0 }
Start-Sleep -Milliseconds 200
$cv=@([uint16]17)
[void][U32]::Chord($cv, [uint16]86)
Write-Output 'OK'
`;
      const result = await run(psStdinCapsule(script, `${Buffer.from(text, "utf8").toString("base64")}\n`));
      if (result.stdout.trim().startsWith("FRONTMOST_MISMATCH:")) {
        return { ok: false, error: result.stdout.trim() };
      }
      if (result.code !== 0) {
        return { ok: false, error: `type failed: ${result.stderr.trim().slice(0, 200)}` };
      }
      return okResult(result.stdout);
    }
    const script = `
${U32_GUARD}
$fg = [U32]::GetForegroundWindow()
$fgpid = 0
[void][U32]::GetWindowThreadProcessId($fg, [ref]$fgpid)
if ($fgpid -ne ${scope.pid}) { Write-Output "FRONTMOST_MISMATCH:$fgpid"; exit 0 }
[void][U32]::SendText(${psStringLiteral(text)})
Write-Output 'OK'
`;
    // R68-C: the ARGV ceiling guard — the capsule embeds the model's text,
    // so its size is measured, not assumed: a payload that would cross
    // the CreateProcess command-line ceiling refuses BEFORE the spawn
    // with a self-teaching error (split the text across multiple calls)
    // instead of a cryptic spawn failure. R69-a note: the per-char path
    // now only ever carries ≤ LONG_TYPE_THRESHOLD chars (longer text took
    // the clipboard branch above), so this guard is defense-in-depth for
    // direct backend calls — the R68-C construction stays.
    const b64Len = capsuleB64Length(script);
    if (b64Len > ARGV_B64_CEILING) {
      return { ok: false, error: `type text too long: ${text.length} characters compose a ${b64Len}-char -EncodedCommand (the Windows CreateProcess ceiling is 32,767 command-line chars) — split it across multiple type calls` };
    }
    const result = await run(psCapsule(script, Math.min(30000, 2000 + text.length * 20)));
    if (result.stdout.trim().startsWith("FRONTMOST_MISMATCH:")) {
      return { ok: false, error: result.stdout.trim() };
    }
    if (result.code !== 0) {
      return { ok: false, error: `type failed: ${result.stderr.trim().slice(0, 200)}` };
    }
    return okResult(result.stdout);
  },

  async launch(run, spec) {
    if (spec.pid !== undefined) return { ok: true, pid: spec.pid, active: false };
    const name = spec.name;
    if (name === undefined || name.trim() === "") return { ok: false, error: "no app name given" };
    // R69-a: a Chromium browser launch carries --force-renderer-accessibility
    // (Chromium builds its web a11y tree at STARTUP instead of after a
    // screen-reader poke — the PokeChromium WM_GETOBJECT nudge then finds an
    // ALREADY-BUILT tree, and the model's get_app_state/find_elements stop
    // depending on poke timing). Non-browser targets are launched UNCHANGED.
    const a11yArgs = chromiumBrowserExecutable(name) ? " -ArgumentList '--force-renderer-accessibility'" : "";
    const script = `
try {
  if ('${spec.bundleId ?? ""}' -ne '') {
    Start-Process "shell:AppsFolder\\${spec.bundleId}" -ErrorAction Stop
  } else {
    Start-Process -FilePath "${escapePsString(name)}"${a11yArgs} -ErrorAction Stop
  }
  Write-Output 'OK'
} catch {
  Write-Output ("ERR:" + $_.Exception.Message)
}
`;
    const result = await run(psCapsule(script, 15000));
    const out = result.stdout.trim();
    if (out === "OK") return { ok: true, active: spec.activate };
    return { ok: false, error: `could not launch '${name}': ${out.slice(0, 200)}` };
  },

  async activate(run, pid, windowId) {
    // The doc 04 §3.3 sequence with postcondition verification. R67-C: the
    // AttachThreadInput sequence NEEDS U32 — guarded, the failure rides the
    // same ERR channel (activate then reports honestly {ok:false}).
    //
    // R68-C (C3): ESCALATION LADDER — the owner's live trace had
    // open_application(activate=true) verify INACTIVE repeatedly (Edge
    // steals/holds the foreground through its own focus churn), and every
    // raw-input tool then refused frontmost_pid_mismatch. When the
    // AttachThreadInput sequence fails the 1.5s verify, escalate to the
    // classic bulletproof foreground steal: SW_MINIMIZE (6) → 150ms →
    // SW_RESTORE (9) — the restore path re-enters through the foreground
    // grant the shell gives a restoring window, which SetForegroundWindow
    // alone cannot take from a process the OS considers "not foreground
    // eligible". TRADEOFF (accepted, documented): the target window
    // VISIBLY FLICKERS (minimize + restore) — a one-frame flicker is the
    // honest price of a verified activation when the polite sequence
    // failed; only then, and only once, does the window flash.
    const script = `
${U32_GUARD}
$wins = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($null -eq $wins) { Write-Output 'ERR:not-running'; exit 0 }
$h = [IntPtr]${windowId ?? 0}
if ($h -eq [IntPtr]::Zero) { $h = $wins.MainWindowHandle }
if ($h -eq [IntPtr]::Zero) { Write-Output 'ERR:no-window'; exit 0 }
if ([U32]::GetForegroundWindow() -eq $h) { Write-Output 'ACTIVE'; exit 0 }
$targetTid = [U32]::GetWindowThreadProcessId($h, [ref]([uint32]0))
$curTid = [System.AppDomain]::GetCurrentThreadId()
[void][U32]::AttachThreadInput($curTid, $targetTid, $true)
[void][U32]::BringWindowToTop($h)
[void][U32]::SetForegroundWindow($h)
[void][U32]::AttachThreadInput($curTid, $targetTid, $false)
$deadline = (Get-Date).AddMilliseconds(1500)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 100
  if ([U32]::GetForegroundWindow() -eq $h) { break }
}
if ([U32]::GetForegroundWindow() -ne $h) {
  # R68-C: the minimize/restore trick — the classic bulletproof steal.
  [void][U32]::ShowWindow($h, 6)
  Start-Sleep -Milliseconds 150
  [void][U32]::ShowWindow($h, 9)
  $deadline2 = (Get-Date).AddMilliseconds(1500)
  while ((Get-Date) -lt $deadline2) {
    Start-Sleep -Milliseconds 100
    if ([U32]::GetForegroundWindow() -eq $h) { break }
  }
}
if ([U32]::GetForegroundWindow() -eq $h) { Write-Output 'ACTIVE' } else { Write-Output 'INACTIVE' }
`;
    const result = await run(psCapsule(script, 12000));
    const out = result.stdout.trim();
    if (out === "ACTIVE") return { ok: true, active: true };
    if (out === "INACTIVE") return { ok: true, active: false };
    return { ok: false, active: false };
  },

  // ── R93-C (the v2 surface — ClickScope parity): window placement. The
  // three methods share the windowId = HWND contract listWindows/activate
  // already use. SetWindowPos is the ONE new U32 P/Invoke (line ~270, one
  // line, still ONE csc compile per capsule); ShowWindow reuses the
  // activate() primitive by handle; focusWindow is the light by-id raise
  // (BringWindowToTop + SetForegroundWindow without the full R68-C ladder —
  // placement focus is advisory, the raw-input foreground auto-activation
  // owns the verified path when it matters).
  async moveWindow(run, windowId, x, y) {
    const script = `
${U32_GUARD}
if (-not $script:U32_OK) { Write-Output 'ERR:u32-unavailable'; exit 0 }
$h = [IntPtr]${windowId}
if ($h -eq [IntPtr]::Zero) { Write-Output 'ERR:no-window'; exit 0 }
# SWP_NOZORDER(0x4)|SWP_NOSIZE(0x1) — move only, keep size + z-order.
if ([U32]::SetWindowPos($h, [IntPtr]::Zero, ${Math.round(x)}, ${Math.round(y)}, 0, 0, 0x5)) { Write-Output 'OK' } else { Write-Output 'ERR:move-failed' }
`;
    const result = await run(psCapsule(script, 8000));
    const out = result.stdout.trim();
    if (out === "OK") return { ok: true };
    return { ok: false, error: out.startsWith("ERR:") ? out.slice(4) : "move failed" };
  },

  async setWindowState(run, windowId, state) {
    // 3 = SW_MAXIMIZE, 6 = SW_MINIMIZE, 9 = SW_RESTORE (the R68-C codes).
    const cmd = state === "maximize" ? 3 : state === "minimize" ? 6 : 9;
    const script = `
${U32_GUARD}
if (-not $script:U32_OK) { Write-Output 'ERR:u32-unavailable'; exit 0 }
$h = [IntPtr]${windowId}
if ($h -eq [IntPtr]::Zero) { Write-Output 'ERR:no-window'; exit 0 }
if ([U32]::ShowWindow($h, ${cmd})) { Write-Output 'OK' } else { Write-Output 'ERR:state-failed' }
`;
    const result = await run(psCapsule(script, 8000));
    const out = result.stdout.trim();
    if (out === "OK") return { ok: true };
    return { ok: false, error: out.startsWith("ERR:") ? out.slice(4) : "state change failed" };
  },

  async focusWindow(run, windowId) {
    const script = `
${U32_GUARD}
if (-not $script:U32_OK) { Write-Output 'ERR:u32-unavailable'; exit 0 }
$h = [IntPtr]${windowId}
if ($h -eq [IntPtr]::Zero) { Write-Output 'ERR:no-window'; exit 0 }
[void][U32]::BringWindowToTop($h)
if ([U32]::SetForegroundWindow($h)) { Write-Output 'OK' } else { Write-Output 'ERR:focus-failed' }
`;
    const result = await run(psCapsule(script, 8000));
    const out = result.stdout.trim();
    if (out === "OK") return { ok: true };
    return { ok: false, error: out.startsWith("ERR:") ? out.slice(4) : "focus failed" };
  },

  // R94-E (PART 2): the WINDOW ACTOR. One capsule resolves the target (an
  // HWND, or "foreground" via GetForegroundWindow with the UIA
  // FocusedElement fallback), acts, reads the title back, and reports
  // {ok, action, windowId, title} as JSON — the dispatch layer records the
  // action in the session ring and wraps failures in the standard refusal.
  async windowAction(run, target, action) {
    const script = windowsWindowActionScript(target, action);
    const result = await run(psCapsule(script, 12000));
    if (result.code !== 0) {
      return { ok: false, error: `window_action failed: ${result.stderr.trim().slice(0, 200)}` };
    }
    const text = result.stdout.trim();
    if (text.startsWith("ERR:")) {
      return { ok: false, error: text.slice(4, 304) };
    }
    try {
      const parsed = JSON.parse(text) as { ok?: unknown; windowId?: unknown; title?: unknown };
      if (parsed.ok === true) {
        const windowId = Number(parsed.windowId);
        return {
          ok: true,
          ...(Number.isInteger(windowId) && windowId !== 0 ? { windowId } : {}),
          ...(typeof parsed.title === "string" && parsed.title.trim() !== "" ? { title: parsed.title } : {}),
        };
      }
    } catch {
      // fall through to the honest refusal
    }
    return { ok: false, error: `window_action produced no usable output: ${text.slice(0, 200)}` };
  },

  async frontmostPid(run) {
    // R67-C: guarded — with U32 unavailable the frontmost pid is honestly
    // 0 → null ("unknown"), the dispatcher's foreground gate then skips on
    // a null front (its existing semantics), never a fabricated pid.
    // R94-E: the UIA FALLBACK — AutomationElement.FocusedElement reads the
    // focused element through the same .NET assemblies the a11y walk uses
    // (no csc), so a dead U32 compile no longer zeroes the foreground gate
    // (the owner's report: foregroundPid 0 → every app active:false, every
    // raw-input path degraded). Still honest: UIA unavailable → 0 → null.
    const script = `
if (-not $script:U32_OK) {
  if ($script:UIA_OK) {
    try {
      $fel = [System.Windows.Automation.AutomationElement]::FocusedElement
      if ($null -ne $fel) {
        $fpid = [int]$fel.Current.ProcessId
        if ($fpid -gt 0) { Write-Output $fpid; exit 0 }
      }
    } catch {}
  }
  Write-Output '0'; exit 0
}
$fg = [U32]::GetForegroundWindow()
if ($fg -eq [IntPtr]::Zero) { Write-Output '0'; exit 0 }
$fgpid = 0
[void][U32]::GetWindowThreadProcessId($fg, [ref]$fgpid)
Write-Output $fgpid
`;
    const result = await run(psCapsule(script, 8000));
    const pid = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  },

  async captureDisplay(run, displayIndex) {
    const script = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens
$idx = ${Math.max(0, displayIndex - 1)}
if ($idx -ge $screens.Length) { $idx = 0 }
$b = $screens[$idx].Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$g.Dispose()
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$bytes = $ms.ToArray()
Write-Output ([Convert]::ToBase64String($bytes))
Write-Output ("GEO:" + $b.X + "," + $b.Y + "," + $b.Width + "," + $b.Height)
`;
    const result = await run(psCapsule(script, 25000));
    if (result.code !== 0) return { error: `capture failed: ${result.stderr.trim().slice(0, 200)}` };
    const lines = result.stdout.trim().split("\n");
    const geoLine = lines.find((l) => l.startsWith("GEO:"));
    const b64 = lines.filter((l) => !l.startsWith("GEO:")).join("").trim();
    if (b64.length < 64) return { error: "capture produced no image" };
    const geo = geoLine ? geoLine.slice(4).split(",").map(Number) : [0, 0, 0, 0];
    const dims = pngDimensions(b64);
    return {
      pngBase64: b64,
      width: dims?.width ?? geo[2],
      height: dims?.height ?? geo[3],
      scale: 1.0, // DPI-aware process → physical px (doc 03 §5)
      origin: { x: geo[0] ?? 0, y: geo[1] ?? 0 },
    } satisfies Raster;
  },

  async captureRegion(run, region) {
    // ── ROUND-125 (R125-A): PRINTWINDOW-FIRST — the occlusion-proof path ──
    // The owner's v0.117.0 device verdict: "it takes the screenshot of the
    // whole device rather than the webpage. When I am in some other
    // application, it takes a screenshot of that application rather than the
    // browser window itself." Root cause: this method's only engine was GDI
    // CopyFromScreen on the requested SCREEN REGION — a screen-scrape that
    // photographs whatever else is ON TOP at those coordinates, so an app
    // window sitting BEHIND another application leaks the OCCLUDER's pixels
    // (the R124 header documented this as the screen-scrape limit; the owner
    // has now hit it).
    //
    // THE FIX (only when the caller threads `ownerPid` — the browser-capture
    // route passes process.ppid, i.e. the Tauri app): find the OWNER app's
    // top-level window, find the CHILD webview whose rect best matches the
    // region (a browser tab is an OS-level CHILD webview of the main window
    // — src-tauri/src/browser.rs; on Windows a WebView2 child of class
    // Chrome_WidgetWin_1), and PrintWindow(child, hdc, 2) —
    // PW_RENDERFULLCONTENT captures the window's OWN rendered surface
    // (DirectX/Chromium included) while it is OCCLUDED or unfocused. Then
    // crop the region translated into child coordinates (clamped to the
    // bitmap — a region slightly larger than the child crops honestly).
    //
    // HONEST FALLBACK (the R124 law kept): ANY failure in the window path —
    // no ownerPid, the Cap compile failed, no owner window found, no child
    // matched, PrintWindow returned false, a degenerate crop — runs the
    // LEGACY CopyFromScreen grab VERBATIM and the raster is tagged
    // source:'screen' (the JS parse below + the SRC: marker line) so the
    // caller can say WHICH pixels it got. Never fabricated, never silent.
    //
    // WHY a SECOND Add-Type -TypeDefinition in THIS capsule (the one-csc-
    // compile law is the preamble's): the Cap class is capture-only surface
    // (EnumWindows/EnumChildWindows/GetWindowThreadProcessId/
    // IsWindowVisible/GetWindowRect/PrintWindow/GetClassName — the U32
    // pattern, self-contained). Folding it into the shared U32 would grow
    // EVERY capsule's ARGV budget (the R69-a docblock's explicit warning);
    // instead the preamble stays byte-identical and this capsule pays ONE
    // extra ~1s compile against its 25s budget (captureDisplay's precedent
    // for captures owning their own loads). A failed compile degrades
    // honestly to the screen path — the R67-C guard pattern.
    //
    // SELECTION MATH (the load-bearing detail): candidates are scored by
    // SYMMETRIC DIFFERENCE (childArea + regionArea − 2×overlap), NOT by
    // raw overlap. The app's OWN UI webview is ALSO a Chrome_WidgetWin_1
    // child whose rect spans the whole client area — its overlap with the
    // region is maximal (it contains the region), so a largest-overlap rule
    // would tie-or-beat the staged tab webview and we would capture the
    // app's React UI instead of the page. The tightest-fit rule is what
    // makes "the staged tab webview's rect ≈ the region" actually WIN
    // (diff ≈ 0 for the staged webview vs. area(client)−area(region) for
    // the app UI webview). Equal diffs prefer the VISIBLE child (a hidden
    // background tab can park at the same rect; PrintWindow on a hidden
    // webview renders stale content).
    const ownerPid =
      typeof region.ownerPid === "number" && Number.isInteger(region.ownerPid) && region.ownerPid > 0
        ? region.ownerPid
        : 0;
    const script = `
Add-Type -AssemblyName System.Drawing
# R125-A: the Cap helper (the U32 pattern — guarded compile, honest degrade).
$script:CAP_OK = $false
try {
Add-Type -TypeDefinition 'using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public class Cap{
public struct RECT{public int Left;public int Top;public int Right;public int Bottom;}
public delegate bool EnumProc(IntPtr h,IntPtr lp);
public delegate bool ChildProc(IntPtr h,IntPtr lp);
[DllImport("user32.dll")]public static extern bool EnumWindows(EnumProc cb,IntPtr lp);
[DllImport("user32.dll")]public static extern bool EnumChildWindows(IntPtr p,ChildProc cb,IntPtr lp);
[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);
[DllImport("user32.dll")]public static extern bool PrintWindow(IntPtr h,IntPtr hdc,uint flags);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetClassName(IntPtr h,StringBuilder sb,int max);
private static List<IntPtr> capTops=new List<IntPtr>();
private static List<IntPtr> capKids=new List<IntPtr>();
public static void CollectTopWindows(){
  capTops.Clear();
  EnumProc cb=delegate(IntPtr h,IntPtr lp){capTops.Add(h);return true;};
  EnumWindows(cb,IntPtr.Zero);
}
public static void CollectChildWindows(IntPtr parent){
  capKids.Clear();
  ChildProc cb=delegate(IntPtr h,IntPtr lp){capKids.Add(h);return true;};
  EnumChildWindows(parent,cb,IntPtr.Zero);
}
public static int TopCount(){return capTops.Count;}
public static int ChildCount(){return capKids.Count;}
public static long TopAt(int i){return capTops[i].ToInt64();}
public static long ChildAt(int i){return capKids[i].ToInt64();}
}'
  $script:CAP_OK = $true
} catch {
  $script:CAP_OK = $false
}
$rx = ${region.x}
$ry = ${region.y}
$rw = ${region.w}
$rh = ${region.h}
$ownerPid = ${ownerPid}
$src = 'screen'
$geoX = $rx
$geoY = $ry
$b64out = $null
if ($ownerPid -gt 0 -and $script:CAP_OK) {
  try {
    # 1. the OWNER top-level window of that pid: containment first, then
    # overlap (a containing window beats a merely-overlapping one; among
    # equals the largest overlap wins — the main window vs. the pop-out).
    [void][Cap]::CollectTopWindows()
    $owner = [IntPtr]::Zero
    $ownerContain = $false
    $ownerScore = -1
    for ($i = 0; $i -lt [Cap]::TopCount(); $i++) {
      $oh = [IntPtr]([Cap]::TopAt($i))
      if (-not [Cap]::IsWindowVisible($oh)) { continue }
      $opid = 0
      [void][Cap]::GetWindowThreadProcessId($oh, [ref]$opid)
      if ($opid -ne $ownerPid) { continue }
      $orect = New-Object Cap+RECT
      if (-not [Cap]::GetWindowRect($oh, [ref]$orect)) { continue }
      $oox = [Math]::Max(0, [Math]::Min($orect.Right, $rx + $rw) - [Math]::Max($orect.Left, $rx))
      $ooy = [Math]::Max(0, [Math]::Min($orect.Bottom, $ry + $rh) - [Math]::Max($orect.Top, $ry))
      if ($oox -le 0 -or $ooy -le 0) { continue }
      $oov = $oox * $ooy
      $ocont = ($orect.Left -le $rx -and $orect.Top -le $ry -and $orect.Right -ge ($rx + $rw) -and $orect.Bottom -ge ($ry + $rh))
      if (($ocont -and -not $ownerContain) -or ($ocont -eq $ownerContain -and $oov -gt $ownerScore)) {
        $owner = $oh
        $ownerContain = $ocont
        $ownerScore = $oov
      }
    }
    if ($owner -ne [IntPtr]::Zero) {
      # 2. the CHILD webview: Chrome_WidgetWin_1 first (the WebView2
      # widget), any overlapping child as the fallback; scored by
      # SYMMETRIC DIFFERENCE (the tightest fit — see the comment above:
      # the app's own full-client-area UI webview also matches the class).
      [void][Cap]::CollectChildWindows($owner)
      $wHwnd = [IntPtr]::Zero; $wDiff = 9223372036854775807; $wL = 0; $wT = 0; $wW = 0; $wHh = 0; $wVis = $false
      $aHwnd = [IntPtr]::Zero; $aDiff = 9223372036854775807; $aL = 0; $aT = 0; $aW = 0; $aHh = 0; $aVis = $false
      for ($i = 0; $i -lt [Cap]::ChildCount(); $i++) {
        $kh = [IntPtr]([Cap]::ChildAt($i))
        $krect = New-Object Cap+RECT
        if (-not [Cap]::GetWindowRect($kh, [ref]$krect)) { continue }
        $kl = [int]$krect.Left; $kt = [int]$krect.Top
        $kw = [int]$krect.Right - $kl; $khgt = [int]$krect.Bottom - $kt
        if ($kw -le 0 -or $khgt -le 0) { continue }
        $kox = [Math]::Max(0, [Math]::Min($krect.Right, $rx + $rw) - [Math]::Max($krect.Left, $rx))
        $koy = [Math]::Max(0, [Math]::Min($krect.Bottom, $ry + $rh) - [Math]::Max($krect.Top, $ry))
        if ($kox -le 0 -or $koy -le 0) { continue }
        $kdiff = ($kw * $khgt) + ($rw * $rh) - (2 * $kox * $koy)
        $kvis = [Cap]::IsWindowVisible($kh)
        $ksb = New-Object System.Text.StringBuilder(64)
        [void][Cap]::GetClassName($kh, $ksb, 64)
        if ($kdiff -lt $aDiff -or ($kdiff -eq $aDiff -and $kvis -and -not $aVis)) {
          $aHwnd = $kh; $aDiff = $kdiff; $aL = $kl; $aT = $kt; $aW = $kw; $aHh = $khgt; $aVis = $kvis
        }
        if ($ksb.ToString() -eq 'Chrome_WidgetWin_1') {
          if ($kdiff -lt $wDiff -or ($kdiff -eq $wDiff -and $kvis -and -not $wVis)) {
            $wHwnd = $kh; $wDiff = $kdiff; $wL = $kl; $wT = $kt; $wW = $kw; $wHh = $khgt; $wVis = $kvis
          }
        }
      }
      $child = $wHwnd; $childL = $wL; $childT = $wT; $childW = $wW; $childH = $wHh
      if ($child -eq [IntPtr]::Zero) { $child = $aHwnd; $childL = $aL; $childT = $aT; $childW = $aW; $childH = $aHh }
      # 3. PrintWindow(PW_RENDERFULLCONTENT) into a child-sized bitmap.
      if ($child -ne [IntPtr]::Zero -and $childW -gt 0 -and $childH -gt 0) {
        $bmp = New-Object System.Drawing.Bitmap($childW, $childH)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $hdc = $g.GetHdc()
        $pwok = [Cap]::PrintWindow($child, $hdc, 2)
        $g.ReleaseHdc($hdc)
        $g.Dispose()
        if ($pwok) {
          # 4. crop the region translated into child coords, CLAMPED to the
          # bitmap (never negative, never past the edge — a region slightly
          # larger than the child crops honestly, never pads).
          $ix0 = [int][Math]::Max(0, $rx - $childL)
          $iy0 = [int][Math]::Max(0, $ry - $childT)
          $ix1 = [int][Math]::Min($rx + $rw - $childL, $bmp.Width)
          $iy1 = [int][Math]::Min($ry + $rh - $childT, $bmp.Height)
          if ($ix1 - $ix0 -ge 1 -and $iy1 - $iy0 -ge 1) {
            $crop = New-Object System.Drawing.Rectangle($ix0, $iy0, ($ix1 - $ix0), ($iy1 - $iy0))
            $part = $bmp.Clone($crop, [System.Drawing.Imaging.PixelFormat]::DontCare)
            $ms = New-Object System.IO.MemoryStream
            $part.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
            $part.Dispose()
            $b64out = [Convert]::ToBase64String($ms.ToArray())
            $src = 'window'
            $geoX = $childL + $ix0
            $geoY = $childT + $iy0
          }
        }
        $bmp.Dispose()
      }
    }
  } catch { }
}
if ($null -eq $b64out -or $b64out.Length -lt 64) {
  # 5. the LEGACY screen-region grab — the honest fallback (SRC:screen).
  $src = 'screen'
  $geoX = $rx
  $geoY = $ry
  $bmp = New-Object System.Drawing.Bitmap($rw, $rh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($rx, $ry, 0, 0, $bmp.Size)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $b64out = [Convert]::ToBase64String($ms.ToArray())
}
Write-Output $b64out
Write-Output ("GEO:" + $geoX + "," + $geoY)
Write-Output ("SRC:" + $src)
`;
    // R125-A: 25s (captureDisplay's precedent) — the capsule now pays one
    // extra csc compile (Cap) + the enum walks + PrintWindow before the grab.
    const result = await run(psCapsule(script, 25000));
    if (result.code !== 0) return { error: `region capture failed: ${result.stderr.trim().slice(0, 200)}` };
    const lines = result.stdout.trim().split("\n");
    const geoLine = lines.find((l) => l.startsWith("GEO:"));
    const srcLine = lines.find((l) => l.startsWith("SRC:"));
    const b64 = lines.filter((l) => !l.startsWith("GEO:") && !l.startsWith("SRC:")).join("").trim();
    if (b64.length < 64) return { error: "region capture produced no image" };
    const dims = pngDimensions(b64);
    // R125-A: GEO now carries the raster's TRUE origin (the clamped crop's
    // top-left for the window path; the region origin for the screen path —
    // identical to the pre-R125 value there, so legacy callers see no change).
    const geoNums = geoLine ? geoLine.slice(4).split(",").map(Number) : [];
    const origin = {
      x: Number.isFinite(geoNums[0]) ? geoNums[0] : region.x,
      y: Number.isFinite(geoNums[1]) ? geoNums[1] : region.y,
    };
    return {
      pngBase64: b64,
      width: dims?.width ?? region.w,
      height: dims?.height ?? region.h,
      scale: 1.0,
      origin,
      // R125-A: only SRC:window is trusted; anything else (SRC:screen, a
      // missing marker from an older script) reads as the conservative
      // "screen" — the pixels may contain an occluder.
      source: srcLine === "SRC:window" ? "window" : "screen",
    } satisfies Raster;
  },

  async cursorPosition(run) {
    // R67-C: GetCursorPos/PT was folded into the U32 TypeDefinition (it used
    // to be a SECOND Add-Type compile in this capsule) — still exactly one
    // compile, and the guard gives an honest null when it failed.
    const script = `
if (-not $script:U32_OK) { Write-Output ''; exit 0 }
$p = New-Object U32+PT
[void][U32]::GetCursorPos([ref]$p)
Write-Output ($p.X.ToString() + "," + $p.Y.ToString())
`;
    const result = await run(psCapsule(script, 8000));
    if (result.code !== 0) return null;
    const nums = result.stdout.trim().split(",").map((n) => Number.parseInt(n, 10));
    if (nums.length !== 2 || nums.some((n) => !Number.isFinite(n))) return null;
    return { x: nums[0] ?? 0, y: nums[1] ?? 0 };
  },

  async readClipboard(run) {
    const script = `try { $t = Get-Clipboard -Raw -ErrorAction Stop; Write-Output $t } catch { Write-Output '' }`;
    const result = await run(psCapsule(script, 8000));
    return result.code === 0 ? result.stdout : "";
  },

  async writeClipboard(run, text) {
    const script = `try { Set-Clipboard -Value ${psStringLiteral(text)} -ErrorAction Stop; Write-Output 'OK' } catch { Write-Output ("ERR:" + $_.Exception.Message) }`;
    // R68-C: the ARGV ceiling guard (the clipboard write embeds the
    // model's text — measured, not assumed; see ARGV_B64_CEILING).
    const b64Len = capsuleB64Length(script);
    if (b64Len > ARGV_B64_CEILING) {
      return { ok: false, error: `clipboard text too long: ${text.length} characters compose a ${b64Len}-char -EncodedCommand (the Windows CreateProcess ceiling is 32,767 command-line chars) — write it in smaller pieces` };
    }
    const result = await run(psCapsule(script, 8000));
    const out = result.stdout.trim();
    return out === "OK" ? { ok: true } : { ok: false, error: out.slice(0, 200) };
  },

  async probePermissions(run): Promise<ProbedPermissionReport> {
    // Windows has no TCC-style gates; the practical readiness = PowerShell
    // reachable + UIA assembly loadable + a capture sanity check (no image
    // returned — doc 08 §1.2: probe only).
    // R67-C: a THIRD probe — Add-Type -TypeDefinition, the csc compile
    // every enumeration capsule rides. The owner's live failure ("the
    // PowerShell session died before emitting JSON") was a dead compile
    // the probe could not see; addTypeOk now reports it honestly (the
    // PS_OK probe above would also fail for a fully dead PowerShell, but
    // a compile-only failure leaves PS_OK green). The probe rides a BARE
    // capsule (no preamble — it must not drag the U32 compile in).
    const probe = await run(psCapsule(`Write-Output 'PS_OK'`, 8000));
    if (probe.code !== 0 || !probe.stdout.includes("PS_OK")) {
      return {
        accessibility: "unavailable",
        screenCapture: "unavailable",
        backendKind: "windows",
        notes: ["powershell.exe is not reachable from this host"],
      };
    }
    const uia = await run(
      psCapsule(`try { Add-Type -AssemblyName UIAutomationClient; Write-Output 'UIA_OK' } catch { Write-Output 'UIA_FAIL' }`, 10000),
    );
    const addType = await run(
      rawPsCapsule(
        `try { Add-Type -TypeDefinition 'public class AcuteProbe {}'; Write-Output 'ADDTYPE_OK' } catch { Write-Output 'ADDTYPE_FAIL' }`,
        15000,
      ),
    );
    const notes: string[] = [];
    const accessibility = uia.stdout.includes("UIA_OK") ? "granted" : "unavailable";
    if (accessibility !== "granted") notes.push("UIAutomationClient assembly failed to load");
    const addTypeOk = addType.code === 0 && addType.stdout.includes("ADDTYPE_OK");
    if (!addTypeOk) {
      notes.push(
        "Add-Type -TypeDefinition (the csc compile behind list_apps/list_windows) failed — enumeration falls back to Get-Process or refuses honestly; the U32 walk is unavailable",
      );
    }
    return {
      accessibility,
      screenCapture: "granted", // GDI capture needs no grant; UIPI caveats ride notes
      backendKind: "windows",
      addTypeOk,
      notes: notes.length > 0 ? notes : ["UIPI: elevated targets are refused before dispatch (fail-closed, not silent)"],
    };
  },
};

/* ── script builders (exported for command-construction tests) ─────────────── */

/** The shared preamble (exported so tests pin the one-Add-Type contract,
 * the EnumWindows surface, and the shape-aware OutJson). */
export const WINDOWS_PS_PREAMBLE = PS_PREAMBLE;

/**
 * R64-a list_apps: EnumWindows over visible, titled, non-toolwindow
 * top-level windows → one app entry per pid (`name` = the LARGEST titled
 * window's title, `processName` = the exe name), active via
 * GetForegroundWindow; honest Get-Process fallback when the walk throws;
 * diagnostics (processCount / foregroundPid / enumWindowsCount) ride the
 * wrapper. NOTE: `$pid` is a read-only automatic variable in PowerShell —
 * every loop variable below deliberately avoids that name.
 *
 * R67-C: the walk (and the foreground read) is GATED on $script:U32_OK —
 * when the Add-Type compile failed the fallback branch is REACHABLE (it
 * used to be dead: the preamble's unguarded compile aborted the script
 * before any output — the owner's empty list_apps) and its entries carry
 * an honest `source: "get-process-fallback"` field (the strict JS parser
 * tolerates and strips unknown fields).
 *
 * R94-E: the U32-false branch now tries the csc-FREE UIA FALLBACK first
 * (the owner's v0.91.0 report: U32_OK false → 11 apps ALL active:false —
 * foregroundPid was 0 because GetForegroundWindow was gone too). The
 * fallback walk mirrors the EnumWindows shape exactly: the UIA ROOT's
 * children ARE the top-level windows (pid = Current.ProcessId, title =
 * Current.Name, bounds = Current.BoundingRectangle — empty rects filtered,
 * windowId = Current.NativeWindowHandle); the FOREGROUND pid rides
 * AutomationElement.FocusedElement (more reliable than the 0 the owner's
 * report showed), the dedupe keeps the LARGEST-area window title per pid
 * (mirroring $best below), and every entry carries source:'uia-fallback' +
 * diagnostics.uiaFallback so the result is debuggable, never dressed up as
 * the real walk. The Get-Process fallback survives ONLY when even UIA
 * fails (both layers' honest last resort, note included).
 */
export function windowsListAppsScript(): string {
  return `
$fg = [IntPtr]::Zero
$fgpid = 0
if ($script:U32_OK) { try { $fg = [U32]::GetForegroundWindow() } catch { $fg = [IntPtr]::Zero } } elseif ($script:UIA_OK) { try { $fel = [System.Windows.Automation.AutomationElement]::FocusedElement; if ($null -ne $fel) { $fgpid = [int]$fel.Current.ProcessId } } catch { $fgpid = 0 } }
if ($fg -ne [IntPtr]::Zero) { [void][U32]::GetWindowThreadProcessId($fg, [ref]$fgpid) }
$diag = @{ processCount = 0; foregroundPid = $fgpid; enumWindowsCount = -1 }
# R94-E: the compile-failure reason rides every -1 diagnostics (the
# field report said csc failed but never why).
if (-not $script:U32_OK) { $u32err = AddTypeErr; if ($u32err -ne '') { $diag.addTypeError = $u32err } }
$procs = @()
try { $procs = @(Get-Process) } catch { $procs = @() }
$diag.processCount = $procs.Count
$procNames = @{}
foreach ($p in $procs) { try { $procNames[[int]$p.Id] = [string]$p.ProcessName } catch {} }
$apps = @()
$enum = $null
if ($script:U32_OK) { try { $enum = [U32]::ListTopWindows() } catch { $enum = $null } }
if ($null -ne $enum) {
  $diag.enumWindowsCount = $enum.Count
  $best = @{}
  foreach ($w in $enum) {
    $procId = [int]$w.Pid
    $pname = ''
    if ($procNames.ContainsKey($procId)) { $pname = $procNames[$procId] }
    else { try { $pname = [string](Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { $pname = '' } }
    $area = ([int]$w.R - [int]$w.L) * ([int]$w.B - [int]$w.T)
    $cur = $best[$procId]
    if ($null -eq $cur -or $area -gt $cur.area) {
      $best[$procId] = @{ pid = $procId; name = [string]$w.Title; processName = $pname; area = $area; active = ($procId -eq $fgpid) }
    }
  }
  foreach ($k in @($best.Keys)) {
    $apps += [pscustomobject]@{ name = [string]$best[$k].name; pid = [int]$best[$k].pid; processName = [string]$best[$k].processName; active = [bool]$best[$k].active }
  }
  $apps = @($apps | Sort-Object -Property name)
} elseif ($script:UIA_OK) {
  # R94-E: the csc-FREE UIA walk - RootElement children ARE the top-level
  # windows. Titled + non-empty rects only (the EnumWindows filters, UIA
  # equivalents); one app per pid keeping the LARGEST window title; active
  # via FocusedElement's pid. Entries are tagged source:'uia-fallback'.
  $diag.uiaFallback = $true
  $diag.note = 'Add-Type (csc) failed on this host - EnumWindows is unavailable; listing top-level windows via the UIAutomation fallback (no csc needed)'
  try {
    $kids = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    $best = @{}
    for ($i = 0; $i -lt $kids.Count; $i++) {
      $el = $kids.Item($i)
      if ($null -eq $el) { continue }
      try {
        $procId = [int]$el.Current.ProcessId
        $title = [string]$el.Current.Name
        $r = $el.Current.BoundingRectangle
        if ($title.Trim().Length -eq 0) { continue }
        if ($r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0) { continue }
        $area = [int]$r.Width * [int]$r.Height
        $cur = $best[$procId]
        if ($null -eq $cur -or $area -gt $cur.area) {
          $pname = ''
          if ($procNames.ContainsKey($procId)) { $pname = $procNames[$procId] }
          else { try { $pname = [string](Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { $pname = '' } }
          $best[$procId] = @{ pid = $procId; name = $title; processName = $pname; area = $area; active = ($procId -eq $fgpid) }
        }
      } catch {}
    }
    foreach ($k in @($best.Keys)) {
      $apps += [pscustomobject]@{ name = [string]$best[$k].name; pid = [int]$best[$k].pid; processName = [string]$best[$k].processName; active = [bool]$best[$k].active; source = 'uia-fallback' }
    }
    $apps = @($apps | Sort-Object -Property name)
  } catch {
    $apps = @()
    $diag.note = 'both the EnumWindows walk and the UIAutomation fallback failed; using the Get-Process MainWindowTitle fallback'
  }
}
if ($apps.Count -eq 0 -and $null -eq $enum) {
  $diag.note = 'EnumWindows walk failed; using the Get-Process MainWindowTitle fallback'
  foreach ($p in $procs) {
    try {
      if ($p.MainWindowHandle -ne 0 -and $p.MainWindowTitle) {
        $apps += [pscustomobject]@{ name = [string]$p.MainWindowTitle; pid = [int]$p.Id; processName = [string]$p.ProcessName; active = ([int]$p.Id -eq $fgpid); source = 'get-process-fallback' }
      }
    } catch {}
  }
}
OutJson @{ apps = $apps; diagnostics = $diag }
`;
}

/**
 * R64-a list_windows: ALL of the pid's top-level EnumWindows windows (NOT
 * just MainWindowHandle — secondary windows, tool palettes, dialogs), each
 * with windowId (HWND), title, bounds [x,y,w,h], focused (GetForegroundWindow), and
 * main = largest-area window; the MainWindowHandle fallback only when the
 * walk yields nothing for a LIVE process.
 *
 * R67-C: U32 guard first — when the Add-Type compile failed there is no
 * honest window geometry to report (the fallback's GetWindowRect needs U32
 * and invented bounds are FORBIDDEN, R64-a's fake-1920×1080 lesson), so
 * the script emits its existing empty-with-diagnostics shape and names the
 * cause.
 *
 * R94-E: the guard branch now tries the csc-FREE UIA FALLBACK FIRST — the
 * owner's report had get_app_state failing for EVERY app with "owns no
 * accessible top-level window" purely because this script returned empty
 * when U32_OK was false. The UIA walk (RootElement children filtered to
 * the pid — the SAME top-level-window set, NativeWindowHandle as windowId,
 * BoundingRectangle as bounds, FocusedElement's hwnd as focused, largest
 * area as main) restores real windows without csc; entries carry
 * source:'uia-fallback' and diagnostics gain uiaFallback:true + addTypeError.
 * BOTH layers failing still emits the honest empty + note (the geometry
 * ban holds — no invented bounds ever).
 */
export function windowsListWindowsScript(pid: number): string {
  return `
$targetPid = ${pid}
if (-not $script:U32_OK) {
  $liveProc = $false
  try { $null = Get-Process -Id $targetPid -ErrorAction Stop; $liveProc = $true } catch {}
  $u32err = AddTypeErr
  if ($script:UIA_OK) {
    # R94-E: the UIA fallback walk - same shape as the EnumWindows branch
    # below, sourced from RootElement children instead. BoundingRectangle
    # may be EMPTY (UIA's honest "no geometry") - those are filtered, never
    # invented. FocusedElement's NativeWindowHandle is the focused flag.
    $diag = @{ processRunning = $liveProc; enumWindowsCount = -1; uiaFallback = $true }
    if ($u32err -ne '') { $diag.addTypeError = $u32err }
    $wins = @()
    try {
      $fgl = 0
      try { $fel = [System.Windows.Automation.AutomationElement]::FocusedElement; if ($null -ne $fel) { $fgl = [int64]$fel.Current.NativeWindowHandle } } catch { $fgl = 0 }
      $kids = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
      for ($i = 0; $i -lt $kids.Count; $i++) {
        $el = $kids.Item($i)
        if ($null -eq $el) { continue }
        try {
          if ([int]$el.Current.ProcessId -ne $targetPid) { continue }
          $title = [string]$el.Current.Name
          $r = $el.Current.BoundingRectangle
          if ($title.Trim().Length -eq 0) { continue }
          if ($r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0) { continue }
          $hwnd = [int64]$el.Current.NativeWindowHandle
          $wins += [pscustomobject]@{
            windowId = $hwnd
            title = $title
            bounds = @([int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
            main = $false
            focused = ($fgl -eq $hwnd)
            source = 'uia-fallback'
          }
        } catch {}
      }
      $bestIdx = -1; $bestArea = -1
      for ($i = 0; $i -lt $wins.Count; $i++) {
        $a = [int]$wins[$i].bounds[2] * [int]$wins[$i].bounds[3]
        if ($a -gt $bestArea) { $bestArea = $a; $bestIdx = $i }
      }
      if ($bestIdx -ge 0) { $wins[$bestIdx].main = $true }
    } catch {}
    if ($wins.Count -gt 0) { OutJson @{ windows = $wins; diagnostics = $diag }; exit 0 }
    # Both layers produced nothing for this pid - the honest empty, with
    # the compile failure reason riding along (the get_app_state gate up in
    # dispatch.ts surfaces it as addTypeError on the refusal).
    $failDiag = @{ processRunning = $liveProc; enumWindowsCount = -1; note = 'the U32 helper (Add-Type -TypeDefinition) did not compile on this host AND the UIAutomation fallback found no titled top-level window for this pid - run request_access and read addTypeOk' }
    if ($u32err -ne '') { $failDiag.addTypeError = $u32err } else { $failDiag.addTypeError = '(the Add-Type compile failed with no error message captured)' }
    OutJson @{ windows = @(); diagnostics = $failDiag }
    exit 0
  }
  OutJson @{ windows = @(); diagnostics = @{ processRunning = $liveProc; note = 'the U32 helper (Add-Type -TypeDefinition) did not compile on this host - the EnumWindows window enumeration is unavailable; run request_access and read addTypeOk' } }
  exit 0
}
$fg = [U32]::GetForegroundWindow()
$fgl = 0
if ($fg -ne [IntPtr]::Zero) { $fgl = [int64]$fg }
$wins = @()
$diag = @{ processRunning = $false; enumWindowsCount = -1 }
try { $null = Get-Process -Id $targetPid -ErrorAction Stop; $diag.processRunning = $true } catch {}
$enum = $null
try { $enum = [U32]::ListTopWindows() } catch { $enum = $null }
if ($null -ne $enum) {
  $diag.enumWindowsCount = $enum.Count
  foreach ($w in $enum) {
    if ([int]$w.Pid -ne $targetPid) { continue }
    $wins += [pscustomobject]@{
      windowId = [int64]$w.Hwnd
      title = [string]$w.Title
      bounds = @([int]$w.L, [int]$w.T, ([int]$w.R - [int]$w.L), ([int]$w.B - [int]$w.T))
      main = $false
      focused = ($fgl -eq [int64]$w.Hwnd)
    }
  }
  $bestIdx = -1; $bestArea = -1
  for ($i = 0; $i -lt $wins.Count; $i++) {
    $a = [int]$wins[$i].bounds[2] * [int]$wins[$i].bounds[3]
    if ($a -gt $bestArea) { $bestArea = $a; $bestIdx = $i }
  }
  if ($bestIdx -ge 0) { $wins[$bestIdx].main = $true }
}
if ($wins.Count -eq 0 -and $diag.processRunning) {
  $diag.note = 'EnumWindows found no titled visible window for this pid; using the MainWindowHandle fallback'
  try {
    $p = Get-Process -Id $targetPid -ErrorAction Stop
    $h = $p.MainWindowHandle
    if ($h -ne [IntPtr]::Zero) {
      $r = New-Object U32+RECT
      [void][U32]::GetWindowRect($h, [ref]$r)
      $wins += [pscustomobject]@{ windowId = [int64]$h; title = [string]$p.MainWindowTitle; bounds = @([int]$r.Left, [int]$r.Top, ([int]$r.Right - [int]$r.Left), ([int]$r.Bottom - [int]$r.Top)); main = $true; focused = ($fgl -eq [int64]$h) }
    }
  } catch {}
}
OutJson @{ windows = $wins; diagnostics = $diag }
`;
}

/**
 * R94-E (PART 2a): the window_action script — ONE capsule resolves the
 * target (a concrete HWND, or "foreground" via GetForegroundWindow with the
 * UIA FocusedElement fallback), performs the action, reads the window title
 * back, and reports {ok, action, windowId, title} via OutJson. The owner's
 * v0.91.0 task "minimize the current window" had NO actor: the agent could
 * only observe (windows_overview), then a loop guard stopped it.
 *
 * Two actuation paths, same script:
 *   · U32 (the healthy host): ShowWindowAsync SW_MINIMIZE(6)/SW_MAXIMIZE(3)/
 *     SW_RESTORE(9) — ASYNC because the target may be a cross-process window
 *     whose message pump we must not block on; focus = BringWindowToTop +
 *     SetForegroundWindow (the focusWindow primitive, postcondition-honest
 *     return); close = PostMessage WM_CLOSE (0x0010) — the GENTLE close that
 *     lets the app prompt "save changes?" instead of hard-killing it.
 *     The title is read BEFORE acting (a close may destroy the window).
 *   · UIA fallback (U32_OK false — the owner's machine): AutomationElement.
 *     FromHandle(hwnd) resolves the element from the bare HWND (no Add-Type,
 *     no csc), then WindowPattern.SetWindowVisualState(Minimized=0 |
 *     Maximized=1 | Normal=2) / WindowPattern.Close(); focus rides the
 *     element's own SetFocus() (WindowPattern has no focus verb).
 * Both failing → the honest ERR (never a fabricated success).
 */
export function windowsWindowActionScript(
  target: { windowId?: number; foreground?: boolean },
  action: "minimize" | "maximize" | "restore" | "focus" | "close",
): string {
  const windowId = Math.trunc(target.windowId ?? 0);
  // The foreground target resolves the frontmost window INSIDE the capsule
  // (GetForegroundWindow, or the UIA FocusedElement when U32 is dead) — the
  // JS side passes no windowId and the resolved HWND rides the JSON report.
  const foregroundResolution = target.foreground === true
    ? `
# R94-E: target 'foreground' - resolve the frontmost window first
# (GetForegroundWindow, or the UIA FocusedElement when U32 is dead).
if ($script:U32_OK) { try { $h = [U32]::GetForegroundWindow() } catch { $h = [IntPtr]::Zero } }
if ($h -eq [IntPtr]::Zero -and $script:UIA_OK) {
  try { $fel = [System.Windows.Automation.AutomationElement]::FocusedElement; if ($null -ne $fel) { $h = [IntPtr]$fel.Current.NativeWindowHandle } } catch { $h = [IntPtr]::Zero }
}
if ($h -eq [IntPtr]::Zero) { Write-Output 'ERR:no-foreground (no foreground window could be resolved - neither GetForegroundWindow nor the UIA FocusedElement is available)'; exit 0 }
`
    : "";
  return `
$action = '${action}'
$title = ''
$h = [IntPtr]${windowId}
${foregroundResolution}
if ($h -eq [IntPtr]::Zero) { Write-Output 'ERR:no-window (no window to act on - pass a real windowId from windows_overview/list_windows, or target the foreground)'; exit 0 }
if ($script:U32_OK) {
  # The U32 path - title FIRST (a close may destroy the window), then act.
  try {
    $len = [U32]::GetWindowTextLength($h)
    if ($len -gt 0) { $sb = New-Object System.Text.StringBuilder($len + 1); [void][U32]::GetWindowText($h, $sb, $sb.Capacity); $title = $sb.ToString() }
  } catch {}
  $sent = $false
  if ($action -eq 'minimize') { $sent = [U32]::ShowWindowAsync($h, 6) } elseif ($action -eq 'maximize') { $sent = [U32]::ShowWindowAsync($h, 3) } elseif ($action -eq 'restore') { $sent = [U32]::ShowWindowAsync($h, 9) } elseif ($action -eq 'focus') { [void][U32]::BringWindowToTop($h); $sent = [U32]::SetForegroundWindow($h) } elseif ($action -eq 'close') { $sent = [U32]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
  if (-not $sent) { Write-Output 'ERR:action-failed (the win32 call returned false - the window may have closed, or belongs to an elevated process this session cannot touch)'; exit 0 }
  OutJson @{ ok = $true; action = $action; windowId = [int64]$h; title = $title }
  exit 0
}
if ($script:UIA_OK) {
  # R94-E: the csc-free path - FromHandle resolves the element from the
  # bare HWND (no Add-Type); WindowPattern carries the visual-state verbs.
  $el = $null
  try { $el = [System.Windows.Automation.AutomationElement]::FromHandle($h) } catch { $el = $null }
  if ($null -eq $el) { Write-Output 'ERR:no-window (the UIA FromHandle lookup found no window for this id)'; exit 0 }
  try { $title = [string]$el.Current.Name } catch {}
  if ($action -eq 'focus') {
    try { $el.SetFocus(); OutJson @{ ok = $true; action = $action; windowId = [int64]$h; title = $title }; exit 0 } catch { Write-Output ('ERR:focus-failed (' + $_.Exception.Message + ')'); exit 0 }
  }
  $wp = $null
  try { $wp = $el.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern) } catch {}
  if ($null -eq $wp) { Write-Output 'ERR:window-pattern-unavailable (the window does not expose the UIA WindowPattern - minimize/maximize/restore/close need it when the U32 helper is unavailable)'; exit 0 }
  if ($action -eq 'close') {
    try { $wp.Close(); OutJson @{ ok = $true; action = $action; windowId = [int64]$h; title = $title }; exit 0 } catch { Write-Output ('ERR:close-failed (' + $_.Exception.Message + ')'); exit 0 }
  }
  $vis = 2
  if ($action -eq 'minimize') { $vis = 0 }
  if ($action -eq 'maximize') { $vis = 1 }
  try { $wp.SetWindowVisualState($vis); OutJson @{ ok = $true; action = $action; windowId = [int64]$h; title = $title }; exit 0 } catch { Write-Output ('ERR:state-failed (' + $_.Exception.Message + ')'); exit 0 }
}
Write-Output 'ERR:U32-unavailable (the Add-Type helper did not compile on this host and the UIAutomation fallback is unavailable - this action cannot run)'
exit 0
`;
}

/**
 * R64-a list_displays: the REAL System.Windows.Forms.Screen AllScreens
 * bounds (the owner's 1280×1024 single display previously collapsed to an
 * object → parse fail → the FAKE 1920×1080 fallback). Wrapper + diagnostics.
 */
export function windowsListDisplaysScript(): string {
  return `
Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens
$displays = @()
$i = 1
foreach ($s in $screens) {
  $displays += [pscustomobject]@{ index = $i; bounds = @([int]$s.Bounds.X, [int]$s.Bounds.Y, [int]$s.Bounds.Width, [int]$s.Bounds.Height); main = [bool]$s.Primary }
  $i++
}
OutJson @{ displays = $displays; diagnostics = @{ screenCount = $screens.Length } }
`;
}

function escapePsString(value: string): string {
  return value.replace(/'/g, "''");
}

function psStringLiteral(value: string): string {
  return `@'${value.replace(/'@/g, "''@")}'@`;
}

/* ── R68-C: the key-name → VK table (the SendInput chord composer) ─────────
 * R67-C fixed "key tab typed t-a-b" with a SendKeys chord table; R68-C kills
 * the SendKeys ENGINE (the owner's host: [System.Windows.Forms.SendKeys]
 * TypeNotFound — the preamble's LoadWithPartialName silently failed, R68-C
 * removed it). composeVkChord maps the dispatcher's lowercased '+'-split
 * tokens to real Virtual-Key codes for [U32]::Chord (mods down → key → key
 * up → mods up REVERSED, one SendInput batch), matching the LINUX backend's
 * xdotool semantics for the same input. The Windows/Meta key is a REAL VK
 * now (LWIN 0x5B) — SendInput synthesizes it where SendKeys could not.
 * Dispatch's splitKeyChord preserves a literal plus ('++' → the plus key)
 * so single printable characters stay expressible. Unknown names refuse
 * HONESTLY — nothing is typed (the R67-C contract, unchanged). */

/** Modifier names → Virtual-Key codes (LWIN covers win/meta/super/cmd). */
const VK_MODIFIERS: Record<string, number> = {
  ctrl: 0x11,
  control: 0x11,
  shift: 0x10,
  alt: 0x12,
  option: 0x12,
  win: 0x5b,
  meta: 0x5b,
  super: 0x5b,
  cmd: 0x5b,
  command: 0x5b,
  windows: 0x5b,
};

/** Key names → Virtual-Key codes (winuser.h; the aliases mirror doc 02's
 * key tool vocabulary — the R67-C table's names, VK-ified). */
const VK_KEY_NAMES: Record<string, number> = {
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  esc: 0x1b,
  escape: 0x1b,
  backspace: 0x08,
  delete: 0x2e,
  del: 0x2e,
  insert: 0x2d,
  help: 0x2f,
  space: 0x20,
  up: 0x26,
  arrowup: 0x26,
  down: 0x28,
  arrowdown: 0x28,
  left: 0x25,
  arrowleft: 0x25,
  right: 0x27,
  arrowright: 0x27,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pgup: 0x21,
  pagedown: 0x22,
  pgdn: 0x22,
  f1: 0x70,
  f2: 0x71,
  f3: 0x72,
  f4: 0x73,
  f5: 0x74,
  f6: 0x75,
  f7: 0x76,
  f8: 0x77,
  f9: 0x78,
  f10: 0x79,
  f11: 0x7a,
  f12: 0x7b,
};

/** Single printable characters → VK codes (the OEM punctuation the spec's
 * key vocabulary uses; '++' from splitKeyChord lands here as '+'). */
const VK_SINGLE_CHARS: Record<string, number> = {
  "+": 0xbb,
  "-": 0xbd,
  ",": 0xbc,
  ".": 0xbe,
  "/": 0xbf,
  ";": 0xba,
  "'": 0xde,
};

/** The supported-key list every honest compose error names. */
const VK_SUPPORTED_NAMES =
  "enter/return, tab, esc/escape, backspace, delete/del, insert, help, space, up, down, left, right (arrowup/arrowdown/arrowleft/arrowright), home, end, pageup/pgup, pagedown/pgdn, f1..f12, single letters a-z, digits 0-9, plus ('++'), minus, comma, period, slash, semicolon, quote, and chords like ctrl+a / shift+tab / alt+f4 / win+l";

/**
 * R68-C: compose the dispatcher's key tokens into ONE SendInput chord —
 * LEADING modifier VKs + exactly ONE key VK. Anything else refuses honestly
 * (the error names what was wrong and the full supported list, so the model
 * can self-correct in one step).
 */
export function composeVkChord(keys: string[]): { ok: true; mods: number[]; key: number } | { ok: false; error: string } {
  const tokens = keys.map((k) => k.trim().toLowerCase()).filter((k) => k !== "");
  if (tokens.length === 0) {
    return { ok: false, error: "no key tokens given — the key tool needs a key or chord, e.g. 'tab' or 'ctrl+a'" };
  }
  const mods: number[] = [];
  let i = 0;
  while (i < tokens.length) {
    const mod = VK_MODIFIERS[tokens[i]!];
    if (mod === undefined) break;
    mods.push(mod);
    i++;
  }
  const rest = tokens.slice(i);
  if (rest.length !== 1) {
    return {
      ok: false,
      error: `a key chord is LEADING modifiers plus exactly ONE key — '${keys.join("+")}' has ${rest.length === 0 ? "no key after the modifier(s)" : `${rest.length} keys after the modifier(s)`}; supported: ${VK_SUPPORTED_NAMES}`,
    };
  }
  const key = rest[0]!;
  const named = VK_KEY_NAMES[key];
  if (named !== undefined) return { ok: true, mods, key: named };
  if (key.length === 1) {
    if (key >= "a" && key <= "z") return { ok: true, mods, key: 0x41 + (key.charCodeAt(0) - 0x61) };
    if (key >= "0" && key <= "9") return { ok: true, mods, key: 0x30 + (key.charCodeAt(0) - 0x30) };
    const oem = VK_SINGLE_CHARS[key];
    if (oem !== undefined) return { ok: true, mods, key: oem };
    return {
      ok: false,
      error: `the key '${key}' has no Windows Virtual-Key code in the supported table — type it with the type tool instead; supported: ${VK_SUPPORTED_NAMES}`,
    };
  }
  return {
    ok: false,
    error: `unknown key name '${key}' — supported: ${VK_SUPPORTED_NAMES}`,
  };
}

/**
 * R68-C: the dispatcher's modifier NAMES ("ctrl", "shift", "super"…) → VK
 * codes for the click/drag modifier holds ([U32]::ModsDown/ModsUp). Unknown
 * names are DROPPED (parseModifiers upstream already normalizes the
 * vocabulary; fail-open here matches the old path's behavior of holding the
 * modifiers it could express).
 */
function modifierVks(modifiers: string[]): number[] {
  const vks: number[] = [];
  for (const m of modifiers) {
    const vk = VK_MODIFIERS[m.toLowerCase()];
    if (vk !== undefined) vks.push(vk);
  }
  return vks;
}

/**
 * R68-C: emit a PowerShell ushort[] array-literal statement —
 * `$<name>=@([uint16]17, [uint16]16)` (the explicit [uint16] casts make the
 * object[]→ushort[] parameter marshaling defensive on PS 5.1; an empty set
 * emits `$<name>=@()` which marshals as a zero-length array — SendMany
 * short-circuits on length 0). PowerShell never executes in this sandbox:
 * construction-pinned only.
 */
function psVkArray(name: string, vks: number[]): string {
  const elems = vks.map((v) => `[uint16]${v}`).join(", ");
  return `$${name}=@(${elems})`;
}

/**
 * R69-a: does a launch target name a CHROMIUM BROWSER executable (the ones
 * whose launch gets --force-renderer-accessibility)? Matching is FLEXIBLE on
 * the name: path prefixes (both \ and /) are stripped, the .exe suffix and
 * case are normalized — "msedge", "msedge.exe", "chrome", "chrome.exe", and
 * "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" all match;
 * "notepad", "msedgewebview2" (the WebView2 helper — not a browser) do not.
 * Exported for the launch construction pins.
 */
export function chromiumBrowserExecutable(name: string): boolean {
  const base = (name.trim().replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase();
  return base === "msedge" || base === "msedge.exe" || base === "chrome" || base === "chrome.exe";
}

export function windowsElementActionScript(
  pid: number,
  window: WindowScope,
  element: ElementDescriptor,
  action: "press" | "setValue" | "action" | "select",
  value?: string,
  actionName?: string,
  _start?: number,
  length?: number | null,
): string {
  const findAndVerify = `
Add-Type -AssemblyName UIAutomationClient
$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($null -eq $p) { Write-Output 'ERR:app-not-running'; exit 0 }
$h = [IntPtr]${window.windowId}
if ($h -eq [IntPtr]::Zero) { $h = $p.MainWindowHandle }
if ($h -eq [IntPtr]::Zero) { Write-Output 'ERR:no-window'; exit 0 }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$els = New-Object System.Collections.ArrayList
# R66-2-d: the cap follows buildSnapshot's 800 → 2400 bump so the index
# contract holds for the whole snapshot (walk ORDER/depth/identity checks
# are untouched — index N is the same element in both walks).
$maxDepth = 25; $maxEl = 2400
function Walk($el, $depth) {
  if ($els.Count -ge $maxEl -or $depth -gt $maxDepth) { return }
  try {
    if ($null -eq $el) { return }
    [void]$els.Add($el)
    $child = $walker.GetFirstChildElement($el)
    while ($null -ne $child) { Walk $child ($depth + 1); $child = $walker.GetNextSiblingElement($child) }
  } catch { return }
}
Walk $root 0
if (${element.index} -ge $els.Count) { Write-Output 'NO_SUCH_ELEMENT'; exit 0 }
$el = $els[${element.index}]
$ct = $el.Current.ControlType.ProgrammaticName -replace '^ControlType.', ''
$liveName = [string]$el.Current.Name
$wantName = ${psStringLiteral(element.name.slice(0, 120))}
if ($liveName -ne $wantName) { Write-Output 'STALE_ELEMENT'; exit 0 }
`;
  const body =
    action === "press"
      ? `
try {
  $null = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $ip = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $ip.Invoke()
  Write-Output 'OK'; exit 0
} catch {}
try {
  $tp = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
  $tp.Toggle()
  Write-Output 'OK'; exit 0
} catch {}
try {
  $ec = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  $ec.Expand()
  Write-Output 'OK'; exit 0
} catch {}
try {
  $si = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
  $si.Select()
  Write-Output 'OK'; exit 0
} catch {}
Write-Output 'ERR:capability-fail-closed (no Invoke/Toggle/ExpandCollapse/SelectionItem pattern)'
`
      : action === "setValue"
        ? `
try {
  $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  if ($vp.Current.IsReadOnly) { Write-Output 'ERR:not-settable (read-only)'; exit 0 }
  $vp.SetValue(${psStringLiteral(value ?? "")})
  Write-Output 'OK'; exit 0
} catch {
  Write-Output ("ERR:" + $_.Exception.Message); exit 0
}
`
        : action === "action"
          ? `
$want = ${psStringLiteral(actionName ?? "")}
try {
  if ($want -eq 'Invoke') { ($el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke(); Write-Output 'OK'; exit 0 }
} catch {}
try {
  if ($want -eq 'Toggle') { ($el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)).Toggle(); Write-Output 'OK'; exit 0 }
} catch {}
try {
  if ($want -eq 'Expand') { ($el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)).Expand(); Write-Output 'OK'; exit 0 }
} catch {}
Write-Output "ERR:no-such-action:$want"
`
          : `
# R68-C: the select gestures ride SendInput (HOME caret placement, then
# optional shift+END for the whole-text selection) — the old SendKeys
# {HOME}/+{END} path died TypeNotFound on the owner's host. The other three
# element actions (press/setValue/action) are pure UIA and need NO U32 —
# the guard lives HERE, after the identity verification, so a dead compile
# still reports the element truthfully before refusing.
${U32_GUARD}
try {
  $el.SetFocus()
  [void][U32]::TapKey([uint16]0x24)
${length === null || length === undefined ? "" : `  $sel=@([uint16]0x10)
  [void][U32]::ModsDown($sel)
  [void][U32]::TapKey([uint16]0x23)
  [void][U32]::ModsUp($sel)
`}
  Write-Output 'OK'; exit 0
} catch {
  Write-Output ("ERR:" + $_.Exception.Message); exit 0
}
`;
  return `${findAndVerify}${body}`;
}

function buildSnapshotRecord(
  app: { pid: number; name?: string; bundleId?: string },
  window: WindowInfo,
  elements: Snapshot["elements"],
  detail: "compact" | "full",
): Snapshot {
  return {
    stateId: "", // the session stamps it
    app: { pid: app.pid, name: app.name, bundleId: app.bundleId, title: window.title },
    window: { title: window.title, windowId: window.windowId, bounds: window.bounds },
    surface: { kind: "window", actualWindowId: window.windowId, lifecycle: "stable" },
    elements: detail === "compact"
      ? elements.map((el) => {
          // R93-C: the compact walk keeps the HIERARCHY keys (get_tree and
          // get_children/get_subtree work on compact snapshots too) + the
          // category; only the pixel-scale fields (bounds) and the pattern
          // actions are dropped as before.
          const compact: Snapshot["elements"][number] = {
            index: el.index,
            kind: el.kind,
            name: el.name,
            flags: el.flags ?? [],
            category: el.category ?? categoryOfKind(el.kind),
          };
          if (el.value !== undefined) compact.value = el.value;
          if (el.key !== undefined) compact.key = el.key;
          if (el.windowKey !== undefined) compact.windowKey = el.windowKey;
          if (el.parentKey !== undefined) compact.parentKey = el.parentKey;
          if (el.treeDepth !== undefined) compact.treeDepth = el.treeDepth;
          if (el.path !== undefined) compact.path = el.path;
          if (el.interactive !== undefined) compact.interactive = el.interactive;
          if (el.via !== undefined) compact.via = el.via;
          return compact;
        })
      : elements.map((el) => ({
          ...el,
          flags: el.flags ?? [],
          // R93-C: the category derivation (shared mapping — the walker's
          // script does NOT re-derive it).
          category: el.category ?? categoryOfKind(el.kind),
        })),
    createdAt: 0,
  };
}

export const WINDOWS_BACKEND_ID = "windows";
export { windowsBackend };
