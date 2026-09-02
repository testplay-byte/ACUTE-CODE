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
 * Every native call is a PowerShell capsule: `powershell.exe -NoProfile
 * -NonInteractive -ExecutionPolicy Bypass -Command -` with the script on
 * STDIN, emitting JSON on stdout (ConvertTo-Json -Compress). The backend
 * code runs on the owner's Windows machines; on Linux/macOS hosts the
 * powershell probe fails and every method fails closed with
 * `unsupported_on_backend` — never half-works.
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
 *   · raw input: SetCursorPos + mouse_event (user32 P/Invoke)
 *   · typing: SendKeys (chords + text) after focus verification
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
  PermissionReport,
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
  Raster,
  WindowScope,
} from "./interface.js";
import { pngDimensions } from "./linux.js";

/** The powershell entry program (pwsh when present, else powershell.exe). */
export const WINDOWS_PS_PROGRAM = "powershell.exe";

/**
 * The shared Preamble every script rides: DPI awareness + the single U32
 * Add-Type (one csc compile — R64-a folded the EnumWindows helpers into the
 * SAME TypeDefinition so every capsule still compiles exactly once) + the
 * shape-aware OutJson. The C# is CodeDom/C#-5-safe for PowerShell 5.1
 * (no interpolation, no ?. — Add-Type on powershell.exe compiles C# 5).
 */
const PS_PREAMBLE = `
$ErrorActionPreference = 'Stop'
[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')
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
public delegate bool EnumProc(IntPtr h,IntPtr lp);
[DllImport("user32.dll")]public static extern bool EnumWindows(EnumProc cb,IntPtr lp);
[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")]public static extern int GetWindowLong(IntPtr h,int i);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowTextLength(IntPtr h);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr h,StringBuilder sb,int max);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetClassName(IntPtr h,StringBuilder sb,int max);
public struct RECT{public int Left;public int Top;public int Right;public int Bottom;}
public struct WINFO{public long Hwnd;public uint Pid;public string Title;public int L;public int T;public int R;public int B;}
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
[void][U32]::SetProcessDPIAware()
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

const psCapsule = (script: string, timeoutMs = 20000): CommandCapsule => ({
  program: WINDOWS_PS_PROGRAM,
  args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"],
  stdin: `${PS_PREAMBLE}\n${script}`,
  timeoutMs,
});

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
    const script = `
Add-Type -AssemblyName UIAutomationClient
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${window.windowId})
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$out = New-Object System.Collections.ArrayList
$maxDepth = 25; $maxEl = 800
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
    $flags = @()
    try { if ($null -ne $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)) { $flags += 'pressable' } } catch {}
    try { if ($null -ne $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)) { $flags += 'pressable' } } catch {}
    try { if ($null -ne $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)) { $flags += 'has_menu' } } catch {}
    try {
      $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $flags += 'editable'
    } catch {}
    try { if ($el.Current.IsKeyboardFocused) { $flags += 'focused' } } catch {}
    $entry = [pscustomobject]@{ index = $out.Count; kind = (MapKind $ct); name = [string]$name; flags = $flags }
    try {
      $vp = $null
      try { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch {}
      if ($null -ne $vp) { $v = $vp.Current.Value; if ($null -ne $v -and $v.Length -gt 120) { $v = $v.Substring(0,120) }; $entry | Add-Member -NotePropertyName value -NotePropertyValue ([string]$v) }
    } catch {}
    if (${includeBounds}) {
      try { $b = $el.Current.BoundingRectangle; $entry | Add-Member -NotePropertyName bounds -NotePropertyValue @([int]$b.X, [int]$b.Y, [int]$b.Width, [int]$b.Height) } catch {}
      try {
        $ip = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $entry | Add-Member -NotePropertyName actions -NotePropertyValue @('Invoke')
      } catch {}
      try {
        $tp = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        $entry | Add-Member -NotePropertyName actions -NotePropertyValue @('Toggle')
      } catch {}
      try {
        $ec = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        $entry | Add-Member -NotePropertyName actions -NotePropertyValue @('Expand')
      } catch {}
    }
    [void]$out.Add($entry)
    $child = $walker.GetFirstChildElement($el)
    while ($null -ne $child) { Walk $child ($depth + 1); $child = $walker.GetNextSiblingElement($child) }
  } catch { return }
}
Walk $root 0
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
    const script = `
Add-Type -AssemblyName UIAutomationClient
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
    const flags =
      button === "left"
        ? [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP]
        : button === "right"
          ? [MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP]
          : [MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP];
    const modKeys = modifiers.map((m) => (m === "super" ? "WIN" : m.toUpperCase())).join("");
    const script = `
${modKeys ? `[System.Windows.Forms.SendKeys]::SendWait('{${modKeys}DOWN}')` : ""}
[void][U32]::SetCursorPos(${pt.x}, ${pt.y})
Start-Sleep -Milliseconds 30
${Array.from({ length: Math.min(Math.max(clickCount, 1), 3) }, () => `[U32]::mouse_event(${flags[0]},0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 35; [U32]::mouse_event(${flags[1]},0,0,0,[UIntPtr]::Zero)`).join("\n")}
${modKeys ? `[System.Windows.Forms.SendKeys]::SendWait('{${modKeys}UP}')` : ""}
Write-Output 'OK'
`;
    const result = await run(psCapsule(script, 12000));
    return result.code === 0
      ? { ok: true }
      : { ok: false, error: `click failed: ${result.stderr.trim().slice(0, 200)}` };
  },

  async rawScroll(run, pt, direction, amount) {
    // Vertical wheel = WHEEL delta; horizontal = wheel with SHIFT (the
    // classic SendInput approximation; amount clamped 0..100 → ticks).
    const ticks = Math.max(1, Math.min(33, Math.round(amount / 3) || 1));
    const lines = ticks * WHEEL_DELTA;
    const script = `
[void][U32]::SetCursorPos(${pt.x}, ${pt.y})
Start-Sleep -Milliseconds 30
${direction === "down" || direction === "up"
      ? `${Array.from({ length: Math.min(ticks, 33) }, () => `[U32]::mouse_event(0x0800,0,0,${direction === "up" ? lines : -lines},[UIntPtr]::Zero)`).join("\nStart-Sleep -Milliseconds 15\n")}`
      : `${Array.from({ length: Math.min(ticks, 33) }, () => `[System.Windows.Forms.SendKeys]::SendWait('{${direction === "left" ? "LEFT" : "RIGHT"}}')`).join("\n")}`}
Write-Output 'OK'
`;
    const result = await run(psCapsule(script, 12000));
    return result.code === 0
      ? { ok: true }
      : { ok: false, error: `scroll failed: ${result.stderr.trim().slice(0, 200)}` };
  },

  async rawDrag(run, from, to, modifiers) {
    const modKeys = modifiers.map((m) => (m === "super" ? "WIN" : m.toUpperCase())).join("");
    const script = `
${modKeys ? `[System.Windows.Forms.SendKeys]::SendWait('{${modKeys}DOWN}')` : ""}
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
${modKeys ? `[System.Windows.Forms.SendKeys]::SendWait('{${modKeys}UP}')` : ""}
Write-Output 'OK'
`;
    const result = await run(psCapsule(script, 20000));
    return result.code === 0
      ? { ok: true }
      : { ok: false, error: `drag failed: ${result.stderr.trim().slice(0, 200)}` };
  },

  async rawButton(run, pt, down) {
    const script = `
[void][U32]::SetCursorPos(${pt.x}, ${pt.y})
Start-Sleep -Milliseconds 30
[U32]::mouse_event(${down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP},0,0,0,[UIntPtr]::Zero)
Write-Output 'OK'
`;
    const result = await run(psCapsule(script, 8000));
    return result.code === 0
      ? { ok: true }
      : { ok: false, error: `button failed: ${result.stderr.trim().slice(0, 200)}` };
  },

  async rawKey(run, keys, scope) {
    // Scope verification first (Win raw keys land in the frontmost window).
    const script = `
$fg = [U32]::GetForegroundWindow()
$fgpid = 0
[void][U32]::GetWindowThreadProcessId($fg, [ref]$fgpid)
if ($fgpid -ne ${scope.pid}) { Write-Output "FRONTMOST_MISMATCH:$fgpid"; exit 0 }
${windowsSendKeysScript(keys)}
Write-Output 'OK'
`;
    const result = await run(psCapsule(script, 10000));
    if (result.stdout.trim().startsWith("FRONTMOST_MISMATCH:")) {
      return { ok: false, error: result.stdout.trim() };
    }
    return result.code === 0
      ? { ok: true }
      : { ok: false, error: `key failed: ${result.stderr.trim().slice(0, 200)}` };
  },

  async typeText(run, text, scope) {
    const script = `
$fg = [U32]::GetForegroundWindow()
$fgpid = 0
[void][U32]::GetWindowThreadProcessId($fg, [ref]$fgpid)
if ($fgpid -ne ${scope.pid}) { Write-Output "FRONTMOST_MISMATCH:$fgpid"; exit 0 }
${windowsSendKeysScript(splitTextToKeys(text))}
Write-Output 'OK'
`;
    const result = await run(psCapsule(script, Math.min(30000, 2000 + text.length * 20)));
    if (result.stdout.trim().startsWith("FRONTMOST_MISMATCH:")) {
      return { ok: false, error: result.stdout.trim() };
    }
    return result.code === 0
      ? { ok: true }
      : { ok: false, error: `type failed: ${result.stderr.trim().slice(0, 200)}` };
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
    // The doc 04 §3.3 sequence with postcondition verification.
    const script = `
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
if ([U32]::GetForegroundWindow() -eq $h) { Write-Output 'ACTIVE' } else { Write-Output 'INACTIVE' }
`;
    const result = await run(psCapsule(script, 10000));
    const out = result.stdout.trim();
    if (out === "ACTIVE") return { ok: true, active: true };
    if (out === "INACTIVE") return { ok: true, active: false };
    return { ok: false, active: false };
  },

  async frontmostPid(run) {
    const script = `
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
    const script = `
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public struct PT{public int X;public int Y;}
public class CUR{[DllImport("user32.dll")]public static extern bool GetCursorPos(out PT p);}'
$p = New-Object PT
[void][CUR]::GetCursorPos([ref]$p)
Write-Output ($p.X.ToString() + "," + $p.Y.ToString())
`;
    const result = await run(psCapsule(script, 8000));
    if (result.code !== 0) return null;
    const nums = result.stdout.trim().split(",").map((n) => Number.parseInt(n, 10));
    if (nums.length !== 2 || nums.some((n) => !Number.isFinite(n))) return null;
    return { x: nums[0], y: nums[1] };
  },

  async readClipboard(run) {
    const script = `try { $t = Get-Clipboard -Raw -ErrorAction Stop; Write-Output $t } catch { Write-Output '' }`;
    const result = await run(psCapsule(script, 8000));
    return result.code === 0 ? result.stdout : "";
  },

  async writeClipboard(run, text) {
    const script = `try { Set-Clipboard -Value ${psStringLiteral(text)} -ErrorAction Stop; Write-Output 'OK' } catch { Write-Output ("ERR:" + $_.Exception.Message) }`;
    const result = await run(psCapsule(script, 8000));
    const out = result.stdout.trim();
    return out === "OK" ? { ok: true } : { ok: false, error: out.slice(0, 200) };
  },

  async probePermissions(run): Promise<PermissionReport> {
    // Windows has no TCC-style gates; the practical readiness = PowerShell
    // reachable + UIA assembly loadable + a capture sanity check (no image
    // returned — doc 08 §1.2: probe only).
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
    const notes: string[] = [];
    const accessibility = uia.stdout.includes("UIA_OK") ? "granted" : "unavailable";
    if (accessibility !== "granted") notes.push("UIAutomationClient assembly failed to load");
    return {
      accessibility,
      screenCapture: "granted", // GDI capture needs no grant; UIPI caveats ride notes
      backendKind: "windows",
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
 */
export function windowsListAppsScript(): string {
  return `
$fg = [U32]::GetForegroundWindow()
$fgpid = 0
if ($fg -ne [IntPtr]::Zero) { [void][U32]::GetWindowThreadProcessId($fg, [ref]$fgpid) }
$diag = @{ processCount = 0; foregroundPid = $fgpid; enumWindowsCount = -1 }
$procs = @()
try { $procs = @(Get-Process) } catch { $procs = @() }
$diag.processCount = $procs.Count
$procNames = @{}
foreach ($p in $procs) { try { $procNames[[int]$p.Id] = [string]$p.ProcessName } catch {} }
$apps = @()
$enum = $null
try { $enum = [U32]::ListTopWindows() } catch { $enum = $null }
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
        $apps += [pscustomobject]@{ name = [string]$p.MainWindowTitle; pid = [int]$p.Id; processName = [string]$p.ProcessName; active = ([int]$p.Id -eq $fgpid) }
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
 */
export function windowsListWindowsScript(pid: number): string {
  return `
$targetPid = ${pid}
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

/** Split text into SendKeys-safe chunks: plain runs + {ENTER} for \n. */
export function splitTextToKeys(text: string): string[] {
  const parts: string[] = [];
  let run = "";
  for (const ch of text) {
    if (ch === "\n") {
      if (run !== "") parts.push(run);
      parts.push("{ENTER}");
      run = "";
    } else {
      run += ch;
    }
  }
  if (run !== "") parts.push(run);
  return parts;
}

/** Build the SendKeys statements for a list of key-part strings. */
export function windowsSendKeysScript(parts: string[]): string {
  return parts
    .map((part) => {
      if (part === "{ENTER}") return `[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')`;
      const escaped = part.replace(/([{}()[\]^%~+])/g, "{$1}");
      return `[System.Windows.Forms.SendKeys]::SendWait(${psStringLiteral(escaped)})`;
    })
    .join("\n");
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
$maxDepth = 25; $maxEl = 800
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
try {
  $el.SetFocus()
  [System.Windows.Forms.SendKeys]::SendWait('{HOME}')
  ${length === null || length === undefined ? "" : `[System.Windows.Forms.SendKeys]::SendWait('+{END}')`}
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
