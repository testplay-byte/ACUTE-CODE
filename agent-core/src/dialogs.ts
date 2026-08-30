/**
 * Native OS folder picker (round-14→19→48). The sidecar runs as a local process
 * on the user's machine, so IT can open the real OS dialog.
 *
 * Round-19 FIX (owner-reported: two dialogs opened, neither result reached
 * the form): the previous inline `-Command` strings were fragile on Windows
 * (quoting, output capture, STA threading). The fix writes a temporary .ps1
 * script file and executes it with `-ExecutionPolicy Bypass -STA -File` —
 * the canonical reliable pattern. The script writes the result to a
 * temporary FILE (not stdout), which the Node side reads — eliminating all
 * stdout-capture issues.
 *
 * ROUND-48 FIX (owner report: "Browse opens the inbuilt Windows folder
 * picker separate from the file manager, and it shows BELOW all opened
 * windows"). Two defects, two fixes, both inside the .ps1:
 *  1. STYLE — `System.Windows.Forms.FolderBrowserDialog` is the pre-Vista
 *     tree dialog. The PRIMARY picker is now the modern File-Explorer-style
 *     `IFileOpenDialog` COM interface with `FOS_PICKFOLDERS`, driven through
 *     an inline C# interop snippet (`Add-Type`). The classic dialog remains
 *     ONLY as the fallback when the modern one cannot compile/load.
 *  2. Z-ORDER — the sidecar spawns PowerShell from a hidden console process,
 *     so an unowned dialog sinks behind every window. Every dialog is now
 *     shown as OWNED by a topmost invisible form (`WS_EX_TOPMOST` is
 *     inherited by owned popups), so the picker lands ON TOP no matter how
 *     the process was launched.
 *
 * The desktop (Tauri) path uses rfd directly and is parented to the main
 * window in `src-tauri/src/dialogs.rs` — same z-order class of fix.
 *
 * NEVER call pickFolder() from tests: the dialog blocks waiting for a human.
 * Tests assert the generated script's structure (see dialogs-script.test.ts).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// ROUND-45 (audit P0-3): dialogs spawn with a scrubbed env too.
import { buildChildEnv } from "./lib/child-env.js";

export interface PickFolderResult {
  /** Chosen absolute path; null = user cancelled or no backend. */
  path: string | null;
  /** Set when the dialog ATTEMPTED but failed — shown to the user. */
  error?: string;
}

const DIALOG_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * The Windows picker script. Exported for structural tests (the dialog
 * itself blocks on a human and must never run in CI).
 *
 * Result-file contract (unchanged since round 19):
 *   "OK:<path>"  — a folder was chosen
 *   "CANCEL"     — the user dismissed the dialog
 *   "ERROR:<msg>"— both pickers attempted and failed (round-48 addition)
 */
export const PS_SCRIPT = `
param([string]$ResultFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null

function Write-Result([string]$text) {
  [System.IO.File]::WriteAllText($ResultFile, $text)
}

# Topmost invisible owner form. Every dialog below is shown as OWNED by this
# form; owned popups inherit the owner's WS_EX_TOPMOST, so the picker lands
# ABOVE all normal windows instead of behind them (round-48 owner report).
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = 'Minimized'
$owner.Opacity = 0
$null = $owner.Handle  # force handle creation so the topmost style applies

$picked = $null
$cancelled = $false
$failed = $null

try {
  # PRIMARY: the modern File-Explorer-style folder picker (Vista+
  # IFileOpenDialog with FOS_PICKFOLDERS) via inline C# COM interop.
  # C# 5-compatible on purpose: Windows PowerShell 5.1 compiles with the
  # legacy csc, so no inline out-params / interpolation / expression bodies.
  $null = Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace Acute
{
    public static class ModernFolderPicker
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct FILTERSPEC { public string pszName; public string pszSpec; }

        [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
        private class FileOpenDialogRCW { }

        [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IFileOpenDialog
        {
            [PreserveSig] int Show(IntPtr parent);
            [PreserveSig] int SetFileTypes(uint cFilters, FILTERSPEC[] rgFilterSpec);
            [PreserveSig] int SetFileTypeIndex(uint iFileType);
            [PreserveSig] int GetFileTypeIndex(out uint piFileType);
            [PreserveSig] int Advise(IntPtr pfde, out uint pdwCookie);
            [PreserveSig] int Unadvise(uint dwCookie);
            [PreserveSig] int SetOptions(uint fos);
            [PreserveSig] int GetOptions(out uint pfos);
            [PreserveSig] int SetDefaultFolder(IShellItem psi);
            [PreserveSig] int SetFolder(IShellItem psi);
            [PreserveSig] int GetFolder(out IShellItem ppsi);
            [PreserveSig] int GetCurrentSelection(out IShellItem ppsi);
            [PreserveSig] int SetFileName(string pszName);
            [PreserveSig] int GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
            [PreserveSig] int SetTitle(string pszTitle);
            [PreserveSig] int SetOkButtonLabel(string pszText);
            [PreserveSig] int SetFileNameLabel(string pszLabelText);
            [PreserveSig] int GetResult(out IShellItem ppsi);
            [PreserveSig] int AddPlace(IShellItem psi, uint fdap);
            [PreserveSig] int SetDefaultExtension(string pszDefaultExtension);
            [PreserveSig] int Close(int hr);
            [PreserveSig] int SetClientGuid(ref Guid guid);
            [PreserveSig] int ClearClientData();
            [PreserveSig] int SetFilter(IntPtr pFilter);
            [PreserveSig] int GetResults(out IntPtr ppenum);
            [PreserveSig] int GetSelectedItems(out IntPtr ppsai);
        }

        [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IShellItem
        {
            [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
            [PreserveSig] int GetParent(out IShellItem ppsi);
            [PreserveSig] int GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
            [PreserveSig] int GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
            [PreserveSig] int Compare(IShellItem psi, uint hint, out int piOrder);
        }

        private const uint FOS_PICKFOLDERS = 0x20;
        private const uint FOS_FORCEFILESYSTEM = 0x10000000;
        private const uint FOS_PATHMUSTEXIST = 0x800;
        private const uint SIGDN_FILESYSPATH = 0x80058000;
        private const int HRESULT_CANCELLED = unchecked((int)0x800704C7);

        // Returns the picked filesystem path, or null when the user cancelled.
        // Throws on COM failures so the PowerShell caller can fall back to the
        // classic dialog below.
        public static string Show(IntPtr owner, string title)
        {
            IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialogRCW();
            try
            {
                uint options;
                dialog.GetOptions(out options);
                dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
                dialog.SetTitle(title);
                int hr = dialog.Show(owner);
                if (hr == HRESULT_CANCELLED)
                {
                    return null;
                }
                if (hr != 0)
                {
                    Marshal.ThrowExceptionForHR(hr);
                }
                IShellItem item;
                hr = dialog.GetResult(out item);
                if (hr != 0)
                {
                    Marshal.ThrowExceptionForHR(hr);
                }
                string path;
                hr = item.GetDisplayName(SIGDN_FILESYSPATH, out path);
                if (hr != 0)
                {
                    Marshal.ThrowExceptionForHR(hr);
                }
                if (String.IsNullOrEmpty(path))
                {
                    throw new COMException("the picked item has no filesystem path");
                }
                return path;
            }
            finally
            {
                Marshal.ReleaseComObject(dialog);
            }
        }
    }
}
'@
  $picked = [Acute.ModernFolderPicker]::Show($owner.Handle, 'Select the ACUTE-CODE project folder')
  if ($null -eq $picked) { $cancelled = $true }
} catch {
  $failed = $_.Exception.Message
  # FALLBACK: the classic tree dialog — old style, but still owned by the
  # topmost form, so the z-order is right even when the modern picker cannot
  # compile or load on this machine.
  $classic = New-Object System.Windows.Forms.FolderBrowserDialog
  $classic.Description = 'Select the ACUTE-CODE project folder'
  $classic.ShowNewFolderButton = $true
  $classic.RootFolder = [System.Environment+SpecialFolder]::Desktop
  if ($classic.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    $picked = $classic.SelectedPath
  } else {
    $cancelled = $true
  }
} finally {
  $owner.Dispose()
}

if ($cancelled) {
  Write-Result 'CANCEL'
} elseif ($picked) {
  Write-Result ('OK:' + $picked)
} elseif ($failed) {
  Write-Result ('ERROR:' + $failed)
} else {
  Write-Result 'ERROR:modern picker returned an empty path'
}
`;

export async function pickFolder(): Promise<PickFolderResult> {
  if (process.platform === "win32") return pickWindows();
  if (process.platform === "linux" || process.platform === "darwin") return pickUnix();
  return { path: null, error: `folder dialogs are not supported on ${process.platform}` };
}

// ── ROUND-50 (R50-c1): the composer's FILE picker (multi-select) ─────────────

/**
 * The Windows multi-file picker script. Exported for structural tests (the
 * dialog blocks on a human — never run it in CI).
 *
 * ROUND-48's owner complaint was about the FOLDER picker's pre-Vista tree
 * dialog; the modern common OpenFileDialog is the right tool for FILES
 * (System.Windows.Forms.OpenFileDialog IS the Vista+ common dialog), so no
 * COM interop is needed here — just Multiselect = $true. The z-order fix
 * from R48 carries over verbatim: the dialog is shown as OWNED by a
 * topmost invisible form so it lands ON TOP no matter how the sidecar was
 * launched.
 *
 * Result-file contract (the pickFolder shape, multi-line):
 *   "OK:<path1>\n<path2>…" — one or more files chosen (newline-separated)
 *   "CANCEL"               — the user dismissed the dialog
 *   "ERROR:<msg>"          — the dialog failed
 */
export const PS_FILES_SCRIPT = `
param([string]$ResultFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null

function Write-Result([string]$text) {
  [System.IO.File]::WriteAllText($ResultFile, $text)
}

# Topmost invisible owner form (round-48 pattern): owned popups inherit the
# owner's WS_EX_TOPMOST, so the picker lands ABOVE all normal windows.
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = 'Minimized'
$owner.Opacity = 0
$null = $owner.Handle  # force handle creation so the topmost style applies

$picked = @()
$cancelled = $false
$failed = $null

try {
  $dialog = New-Object System.Windows.Forms.OpenFileDialog
  $dialog.Title = 'Select files to attach'
  $dialog.Multiselect = $true
  $dialog.CheckFileExists = $true
  $dialog.DereferenceLinks = $true
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    $picked = @($dialog.FileNames)
  } else {
    $cancelled = $true
  }
} catch {
  $failed = $_.Exception.Message
} finally {
  $owner.Dispose()
}

if ($cancelled) {
  Write-Result 'CANCEL'
} elseif ($failed) {
  Write-Result ('ERROR:' + $failed)
} elseif ($picked.Count -gt 0) {
  Write-Result ('OK:' + ($picked -join "\`n"))
} else {
  # OK with zero files cannot happen with Multiselect — treat as cancel.
  Write-Result 'CANCEL'
}
`;

/** pickFiles result: files is EMPTY when the user cancelled. */
export interface PickFilesResult {
  /** Chosen absolute paths (>=1 on success); [] = user cancelled. */
  files: string[];
  /** Set when the dialog ATTEMPTED but failed — shown to the user. */
  error?: string;
}

export async function pickFiles(): Promise<PickFilesResult> {
  if (process.platform === "win32") return pickFilesWindows();
  if (process.platform === "linux" || process.platform === "darwin") return pickFilesUnix();
  return { files: [], error: `file dialogs are not supported on ${process.platform}` };
}

async function pickFilesWindows(): Promise<PickFilesResult> {
  const tempDir = mkdtempSync(join(tmpdir(), "acute-dialog-"));
  const scriptPath = join(tempDir, "pick-files.ps1");
  const resultPath = join(tempDir, "result.txt");
  try {
    writeFileSync(scriptPath, PS_FILES_SCRIPT, "utf8");

    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-File", scriptPath, "-ResultFile", resultPath],
        { stdio: ["ignore", "ignore", "ignore"], windowsHide: true, timeout: DIALOG_TIMEOUT_MS, env: buildChildEnv() },
      );
      child.on("error", () => resolve(-1));
      child.on("close", (code) => resolve(code));
    });

    if (exitCode !== 0) {
      return {
        files: [],
        error: `file dialog exited with code ${exitCode} — PowerShell may be blocked or missing`,
      };
    }

    let result = "";
    try {
      result = readFileSync(resultPath, "utf8").trim();
    } catch {
      return { files: [], error: "file dialog completed but produced no result" };
    }

    if (result === "CANCEL") return { files: [] };
    if (result.startsWith("OK:")) {
      const files = result
        .slice(3)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (files.length > 0) return { files };
      return { files: [] };
    }
    if (result.startsWith("ERROR:")) {
      return { files: [], error: `file dialog failed: ${result.slice(6).trim()}` };
    }
    return { files: [], error: `unexpected dialog result: ${result.slice(0, 100)}` };
  } catch (error) {
    return { files: [], error: `file dialog failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

async function pickFilesUnix(): Promise<PickFilesResult> {
  const { spawn: spawnUnix } = await import("node:child_process");
  // zenity: --multiple + a real newline separator; kdialog: --multiple +
  // --separate-output (newline-separated). Both print the picks on stdout.
  const candidates: Array<readonly [string, readonly string[]]> = [
    ["zenity", ["--file-selection", "--multiple", "--separator=\n", "--title=Select files to attach"]],
    ["kdialog", ["--getopenfilename", ".", "--multiple", "--separate-output"]],
  ];
  const failures: string[] = [];
  for (const [cmd, args] of candidates) {
    const result = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawnUnix(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"], env: buildChildEnv() });
      let out = "";
      let err = "";
      child.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
      child.stderr?.on("data", (d: Buffer) => (err += d.toString("utf8")));
      child.on("error", () => resolve({ code: -1, out: "", err: String(cmd) }));
      child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    });
    if (result.code === 0 && result.out) {
      const files = result.out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (files.length > 0) return { files };
    }
    if (result.code === 1 && !result.err) return { files: [] }; // zenity cancel = exit 1, quiet
    failures.push(`${cmd}: exit ${result.code}`);
  }
  return { files: [], error: `no file dialog available (${failures.join("; ")})` };
}

async function pickWindows(): Promise<PickFolderResult> {
  const tempDir = mkdtempSync(join(tmpdir(), "acute-dialog-"));
  const scriptPath = join(tempDir, "pick.ps1");
  const resultPath = join(tempDir, "result.txt");
  try {
    writeFileSync(scriptPath, PS_SCRIPT, "utf8");

    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-File", scriptPath, "-ResultFile", resultPath],
        { stdio: ["ignore", "ignore", "ignore"], windowsHide: true, timeout: DIALOG_TIMEOUT_MS, env: buildChildEnv() },
      );
      child.on("error", () => resolve(-1));
      child.on("close", (code) => resolve(code));
    });

    if (exitCode !== 0) {
      return {
        path: null,
        error: `folder dialog exited with code ${exitCode} — PowerShell may be blocked or missing`,
      };
    }

    // Read the result file (the .ps1 always writes it).
    let result = "";
    try {
      result = readFileSync(resultPath, "utf8").trim();
    } catch {
      return { path: null, error: "folder dialog completed but produced no result" };
    }

    if (result === "CANCEL") return { path: null };
    if (result.startsWith("OK:")) {
      const path = result.slice(3).trim();
      if (path) return { path };
    }
    if (result.startsWith("ERROR:")) {
      return { path: null, error: `folder dialog failed: ${result.slice(6).trim()}` };
    }
    return { path: null, error: `unexpected dialog result: ${result.slice(0, 100)}` };
  } catch (error) {
    return { path: null, error: `folder dialog failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

async function pickUnix(): Promise<PickFolderResult> {
  const { spawn } = await import("node:child_process");
  const candidates: Array<readonly [string, readonly string[]]> = [
    ["zenity", ["--file-selection", "--directory", "--title=Select the ACUTE-CODE project folder"]],
    ["kdialog", ["--getexistingdirectory", "."]],
  ];
  const failures: string[] = [];
  for (const [cmd, args] of candidates) {
    const result = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"], env: buildChildEnv() });
      let out = "";
      let err = "";
      child.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
      child.stderr?.on("data", (d: Buffer) => (err += d.toString("utf8")));
      child.on("error", () => resolve({ code: -1, out: "", err: String(cmd) }));
      child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    });
    if (result.code === 0 && result.out) return { path: result.out.split("\n")[0].trim() };
    if (result.code === 1 && !result.err) return { path: null }; // zenity cancel = exit 1, quiet
    failures.push(`${cmd}: exit ${result.code}`);
  }
  return { path: null, error: `no folder dialog available (${failures.join("; ")})` };
}
