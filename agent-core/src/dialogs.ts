/**
 * Native OS folder picker (round-14/15/16: "select the folder itself, don't
 * paste paths"). The sidecar runs as a local process on the user's machine,
 * so IT can open the real OS dialog even while the UI runs in a plain browser
 * (the launcher/dev setup). The Tauri shell keeps its own rfd-based
 * pick_folder command; the UI tries Tauri first, then this endpoint.
 *
 * Round-15: marker protocol (ACUTE_PICK/ACUTE_CANCEL) so a real cancel is
 * distinguishable from a FAILED dialog run; failures surface as `error`.
 * Round-16: Windows method 1 is now the MODERN Vista-style picker (an
 * OpenFileDialog with validation disabled — the standard trick), and every
 * WinForms dialog gets a hidden TOPMOST owner form so it can never appear
 * behind other windows (owner report: "Browse Folder" appeared without
 * proper focus). Three methods total, first success wins, always async
 * (a sync spawn would freeze the whole sidecar while a human decides).
 *
 * NEVER call this from tests: the dialog blocks waiting for a human.
 */
import { spawn } from "node:child_process";

export interface PickFolderResult {
  /** Chosen absolute path; null = user cancelled (clean) or no backend. */
  path: string | null;
  /** Set when the dialog ATTEMPTED but failed — shown verbatim to the user. */
  error?: string;
}

function runCapture(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out: out.trim(), err: err.trim() });
    };
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      finish(-1);
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", (e) => {
      err += String(e);
      finish(-1);
    });
    child.on("close", (code) => finish(code));
  });
}

/** Interpret marker-protocol output: ACUTE_PICK:<path> | ACUTE_CANCEL | failure. */
function interpret(
  res: { code: number | null; out: string; err: string },
  method: string,
): { picked: string | null; cancelled: boolean; error?: string } {
  const line = res.out
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("ACUTE_PICK:") || l === "ACUTE_CANCEL");
  if (res.code === 0 && line === "ACUTE_CANCEL") return { picked: null, cancelled: true };
  if (res.code === 0 && line?.startsWith("ACUTE_PICK:")) {
    const picked = line.slice("ACUTE_PICK:".length).trim();
    if (picked) return { picked, cancelled: false };
  }
  const detail = res.err.split("\n").filter(Boolean).slice(0, 3).join(" | ") || `exit code ${res.code}`;
  return { picked: null, cancelled: false, error: `${method} failed: ${detail}` };
}

const DIALOG_TIMEOUT_MS = 15 * 60 * 1000;
const TITLE = "Select the ACUTE-CODE project folder";

export async function pickFolder(): Promise<PickFolderResult> {
  if (process.platform === "win32") return pickWindows();
  if (process.platform === "linux" || process.platform === "darwin") return pickUnix();
  return { path: null, error: `folder dialogs are not supported on ${process.platform}` };
}

async function pickWindows(): Promise<PickFolderResult> {
  // Method 1: MODERN Vista-style picker (OpenFileDialog, validation off).
  const modern = await runCapture(
    "powershell",
    [
      "-NoProfile",
      "-STA",
      "-Command",
      [
        "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
        "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }",
        "$d = New-Object System.Windows.Forms.OpenFileDialog",
        "$d.Title = 'Select the ACUTE-CODE project folder'",
        "$d.ValidateNames = $false",
        "$d.CheckFileExists = $false",
        "$d.CheckPathExists = $true",
        "$d.FileName = 'Select this folder'",
        "if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output ('ACUTE_PICK:' + (Split-Path -Parent $d.FileName)) }",
        "else { Write-Output 'ACUTE_CANCEL' }",
      ].join("; "),
    ],
    DIALOG_TIMEOUT_MS,
  );
  const r1 = interpret(modern, "modern folder picker");
  if (r1.picked !== null || r1.cancelled) return { path: r1.picked };

  // Method 2: classic FolderBrowserDialog with a topmost owner.
  const classic = await runCapture(
    "powershell",
    [
      "-NoProfile",
      "-STA",
      "-Command",
      [
        "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
        "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }",
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
        "$d.Description = 'Select the ACUTE-CODE project folder'",
        "$d.ShowNewFolderButton = $true",
        "if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output ('ACUTE_PICK:' + $d.SelectedPath) }",
        "else { Write-Output 'ACUTE_CANCEL' }",
      ].join("; "),
    ],
    DIALOG_TIMEOUT_MS,
  );
  const r2 = interpret(classic, "FolderBrowserDialog");
  if (r2.picked !== null || r2.cancelled) return { path: r2.picked };

  // Method 3: Shell.Application COM BrowseForFolder (no WinForms at all).
  const com = await runCapture(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      [
        "$shell = New-Object -ComObject Shell.Application",
        `$f = $shell.BrowseForFolder(0, '${TITLE}', 0x40)`,
        "if ($f) { Write-Output ('ACUTE_PICK:' + $f.Self.Path) }",
        "else { Write-Output 'ACUTE_CANCEL' }",
      ].join("; "),
    ],
    DIALOG_TIMEOUT_MS,
  );
  const r3 = interpret(com, "Shell.BrowseForFolder");
  if (r3.picked !== null || r3.cancelled) return { path: r3.picked };

  return {
    path: null,
    error: `${r1.error ?? ""}; ${r2.error ?? ""}; ${r3.error ?? "no dialog method worked"}`,
  };
}

async function pickUnix(): Promise<PickFolderResult> {
  const candidates: Array<readonly [string, readonly string[]]> = [
    ["zenity", ["--file-selection", "--directory", `--title=${TITLE}`]],
    ["kdialog", ["--getexistingdirectory", "."]],
  ];
  const failures: string[] = [];
  for (const [cmd, args] of candidates) {
    const res = await runCapture(cmd, [...args], DIALOG_TIMEOUT_MS);
    if (res.code === 0) {
      const picked = res.out.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
      if (picked) return { path: picked };
      return { path: null }; // ran, user cancelled
    }
    if (res.code === 1 && !res.err) return { path: null }; // zenity cancel = exit 1, quiet
    failures.push(`${cmd}: exit ${res.code}${res.err ? ` (${res.err.split("\n")[0]})` : ""}`);
  }
  return { path: null, error: `no folder dialog available (${failures.join("; ")})` };
}
