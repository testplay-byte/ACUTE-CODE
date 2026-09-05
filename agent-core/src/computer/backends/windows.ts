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
 *     verification (R68-C — the SendKeys dependency is dead)
 *   · activation: the AttachThreadInput sequence (doc 04 §3.3) with the
 *     ≤1.5 s postcondition check — honest {active} reporting
 *   · capture: System.Drawing CopyFromScreen → PNG → base64
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
  foreach(IntPtr h in render){SendMessage(h,0x3D,IntPtr.Zero,new IntPtr(unchecked((int)0xFFFFFFFC)));}
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
}
if ($script:U32_OK) { [void][U32]::SetProcessDPIAware() }
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
 * `stdin` stays undefined (the runner then just closes the pipe). Sizing
 * honesty, RE-MEASURED at R68-C completion (node over the REAL composed
 * capsules — every fixed script builder measured; buildSnapshot is the
 * biggest): the preamble grew 3,527 → 6,682 chars for the SendInput
 * machinery + the Chromium poke, and the biggest FIXED capsule (preamble
 * + buildSnapshot) measures 11,587 script chars (detail full) / 11,588
 * (compact) → 30,900 / 30,904 base64 chars — UNDER the 32,767-char
 * CreateProcess command-line ceiling (program + the 5 fixed flags add
 * ~81 more → ~30,985 total) but with only ~1.8K of headroom left: THE
 * PREAMBLE HAS GROWN PAST COMFORT — any further C# growth must re-measure
 * here, and the honest next step is moving the walk to a temp .ps1 file
 * (trimming the C# only buys a little). The three capsules that carry
 * MODEL-SUPPLIED payloads (typeText / setValue / writeClipboard) cannot
 * be pinned by a constant — their length is the model's to choose — so
 * they are guarded AT RUNTIME by ARGV_B64_CEILING below and refuse
 * BEFORE spawning. (An earlier draft of this comment claimed the typing
 * path "stays far below" because its timeout math caps text at ~1,400
 * chars — that was WRONG: Math.min clamps the TIMEOUT at 30s, it does
 * NOT cap the text; a long type would have crossed the ceiling and died
 * at CreateProcess with a cryptic spawn error. The runtime guard is the
 * fix; typeText at the 1,400-char timeout knee measures 22,556 base64.)
 */
const psCapsule = (script: string, timeoutMs = 20000): CommandCapsule => ({
  program: WINDOWS_PS_PROGRAM,
  args: [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(`${PS_PREAMBLE}\n${script}`, "utf16le").toString("base64"),
  ],
  timeoutMs,
});

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
    // U32-gated (the walk itself needs no U32); 400ms settle for the tree to
    // start building, and a sparse-retry below re-walks ONCE when the poke
    // fired but the walk still produced only the root window.
    const script = `
Add-Type -AssemblyName UIAutomationClient
$pokeCount = 0
if ($script:U32_OK) { try { $pokeCount = [U32]::PokeChromium([IntPtr]${window.windowId}) } catch { $pokeCount = 0 } }
if ($pokeCount -gt 0) { Start-Sleep -Milliseconds 400 }
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${window.windowId})
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$out = New-Object System.Collections.ArrayList
$maxDepth = 25; $maxEl = 2400
# R66-2-d: ControlTypes that MIGHT carry interactive patterns. Everything
# else (Window, Pane, Text, Image, Group, Table, TitleBar, MenuBar, StatusBar,
# ToolBar, ToolTip, Separator, Header, HeaderItem, SemanticZoom, ...) is
# recorded as kind + name + bounds with NO pattern query — those 4+ cross-
# process COM probes per node were the cost that made Chromium-sized trees
# (Edge) crawl. Non-probed kinds simply never carry pressable/editable/
# has_menu flags, a value, or advertised actions: the tools layer fails
# closed on them instead of guessing.
$probe = @('Button','Hyperlink','Edit','ComboBox','CheckBox','RadioButton','Slider','TabItem','MenuItem','ListItem','DataItem','TreeItem','Spinner','Thumb','ScrollBar','Document','Custom')
function MapKind($ct) {
  switch ($ct) {
    'Window' { return 'window' }
    'MenuItem' { return 'menuitem' }
    'Button' { return 'button' }
    'Hyperlink' { return 'button' }
    'Edit' { return 'textfield' }
    'Document' { return 'textfield' }
    'ComboBox' { return 'combobox' }
    'CheckBox' { return 'checkbox' }
    'RadioButton' { return 'checkbox' }
    'Slider' { return 'slider' }
    'Tab' { return 'pane' }
    'TabItem' { return 'tab' }
    'DataItem' { return 'row' }
    'ListItem' { return 'row' }
    'TreeItem' { return 'row' }
    'Text' { return 'text' }
    'Image' { return 'image' }
    default { return 'pane' }
  }
}
function Walk($el, $depth) {
  if ($out.Count -ge $maxEl -or $depth -gt $maxDepth) { return }
  try {
    if ($null -eq $el) { return }
    $ct = $el.Current.ControlType.ProgrammaticName -replace '^ControlType.', ''
    $name = $el.Current.Name; if ($null -ne $name -and $name.Length -gt 120) { $name = $name.Substring(0,120) }
    $interactive = $probe -contains $ct
    $flags = @()
    # ONE pattern pass, interactive kinds only: each handle is reused for
    # flags + value + action advertisement below (the old script re-probed
    # Value once more for the value and Invoke/Toggle/ExpandCollapse three
    # more times for actions — 8 probes per full-detail node).
    $ip = $null; $tp = $null; $ec = $null; $vp = $null
    if ($interactive) {
      try { $ip = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern) } catch {}
      try { $tp = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern) } catch {}
      try { $ec = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern) } catch {}
      try { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch {}
      if ($null -ne $ip -or $null -ne $tp) { $flags += 'pressable' }
      if ($null -ne $ec) { $flags += 'has_menu' }
      if ($null -ne $vp) { $flags += 'editable' }
    }
    try { if ($el.Current.IsKeyboardFocused) { $flags += 'focused' } } catch {}
    $entry = [pscustomobject]@{ index = $out.Count; kind = (MapKind $ct); name = [string]$name; flags = $flags }
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
    [void]$out.Add($entry)
    $child = $walker.GetFirstChildElement($el)
    while ($null -ne $child) { Walk $child ($depth + 1); $child = $walker.GetNextSiblingElement($child) }
  } catch { return }
}
Walk $root 0
# R68-C (C4) sparse-retry: the poke fired but the walk yielded only the root
# window — the web tree is likely STILL BUILDING. Sleep 600ms and re-walk
# ONCE (the first walk's ≤1-element $out is discarded; no consumer exists
# yet — this IS the snapshot being built).
if ($pokeCount -gt 0 -and $out.Count -le 1) {
  Start-Sleep -Milliseconds 600
  $out = New-Object System.Collections.ArrayList
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
    // Vertical wheel = WHEEL delta; horizontal = arrow-key taps (the
    // classic approximation, R68-C now via SendInput TapKey — the SendKeys
    // path died TypeNotFound on the owner's host); amount 0..100 → ticks.
    const ticks = Math.max(1, Math.min(33, Math.round(amount / 3) || 1));
    const lines = ticks * WHEEL_DELTA;
    const script = `
${U32_GUARD}
[void][U32]::SetCursorPos(${pt.x}, ${pt.y})
Start-Sleep -Milliseconds 30
${direction === "down" || direction === "up"
      ? `${Array.from({ length: Math.min(ticks, 33) }, () => `[U32]::mouse_event(0x0800,0,0,${direction === "up" ? lines : -lines},[UIntPtr]::Zero)`).join("\nStart-Sleep -Milliseconds 15\n")}`
      : `${Array.from({ length: Math.min(ticks, 33) }, () => `[void][U32]::TapKey(${direction === "left" ? "0x25" : "0x27"})`).join("\nStart-Sleep -Milliseconds 15\n")}`}
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
    // instead of a cryptic spawn failure.
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
    const script = `
try {
  if ('${spec.bundleId ?? ""}' -ne '') {
    Start-Process "shell:AppsFolder\\${spec.bundleId}" -ErrorAction Stop
  } else {
    Start-Process -FilePath "${escapePsString(name)}" -ErrorAction Stop
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

  async frontmostPid(run) {
    // R67-C: guarded — with U32 unavailable the frontmost pid is honestly
    // 0 → null ("unknown"), the dispatcher's foreground gate then skips on
    // a null front (its existing semantics), never a fabricated pid.
    const script = `
if (-not $script:U32_OK) { Write-Output '0'; exit 0 }
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
    const script = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${region.w}, ${region.h})
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${region.x}, ${region.y}, 0, 0, $bmp.Size)
$g.Dispose()
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ([Convert]::ToBase64String($ms.ToArray()))
Write-Output ("GEO:" + ${region.x} + "," + ${region.y})
`;
    const result = await run(psCapsule(script, 20000));
    if (result.code !== 0) return { error: `region capture failed: ${result.stderr.trim().slice(0, 200)}` };
    const lines = result.stdout.trim().split("\n");
    const b64 = lines.filter((l) => !l.startsWith("GEO:")).join("").trim();
    if (b64.length < 64) return { error: "region capture produced no image" };
    const dims = pngDimensions(b64);
    return {
      pngBase64: b64,
      width: dims?.width ?? region.w,
      height: dims?.height ?? region.h,
      scale: 1.0,
      origin: { x: region.x, y: region.y },
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
 */
export function windowsListAppsScript(): string {
  return `
$fg = [IntPtr]::Zero
$fgpid = 0
if ($script:U32_OK) { try { $fg = [U32]::GetForegroundWindow() } catch { $fg = [IntPtr]::Zero } }
if ($fg -ne [IntPtr]::Zero) { [void][U32]::GetWindowThreadProcessId($fg, [ref]$fgpid) }
$diag = @{ processCount = 0; foregroundPid = $fgpid; enumWindowsCount = -1 }
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
} else {
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
 * with windowId (HWND), title, bounds, focused (GetForegroundWindow), and
 * main = largest-area window; the MainWindowHandle fallback only when the
 * walk yields nothing for a LIVE process.
 *
 * R67-C: U32 guard first — when the Add-Type compile failed there is no
 * honest window geometry to report (the fallback's GetWindowRect needs U32
 * and invented bounds are FORBIDDEN, R64-a's fake-1920×1080 lesson), so
 * the script emits its existing empty-with-diagnostics shape and names the
 * cause.
 */
export function windowsListWindowsScript(pid: number): string {
  return `
$targetPid = ${pid}
if (-not $script:U32_OK) {
  $liveProc = $false
  try { $null = Get-Process -Id $targetPid -ErrorAction Stop; $liveProc = $true } catch {}
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
          const compact: Snapshot["elements"][number] = {
            index: el.index,
            kind: el.kind,
            name: el.name,
            flags: el.flags ?? [],
          };
          if (el.value !== undefined) compact.value = el.value;
          return compact;
        })
      : elements.map((el) => ({ ...el, flags: el.flags ?? [] })),
    createdAt: 0,
  };
}

export const WINDOWS_BACKEND_ID = "windows";
export { windowsBackend };
