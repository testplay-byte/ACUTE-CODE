/**
 * Native OS folder picker (round-14: "select the folder itself, don't paste
 * paths"). The sidecar runs as a local process on the user's machine, so IT
 * can open the real OS dialog even while the UI runs in a plain browser
 * (the launcher/dev setup) — PowerShell's FolderBrowserDialog on Windows,
 * zenity/kdialog on Linux. The Tauri shell keeps its own rfd-based
 * pick_folder command; the UI tries Tauri first, then this endpoint.
 *
 * Async on purpose: the dialog can stay open for a long time, and a sync
 * spawn would freeze the WHOLE sidecar (health checks included) meanwhile.
 *
 * Returns:
 *   string  → a folder was chosen
 *   null    → the user cancelled / closed the dialog
 *   undefined → no dialog backend exists on this machine (caller falls back
 *               to manual path entry)
 *
 * NEVER call this from tests: the dialog blocks waiting for a human.
 */
import { spawn } from "node:child_process";

function runCapture(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out: out.trim() });
    };
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      finish(-1);
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code));
  });
}

const firstLine = (s: string): string => s.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
const DIALOG_TIMEOUT_MS = 15 * 60 * 1000;

export async function pickFolder(): Promise<string | null | undefined> {
  if (process.platform === "win32") return pickWindows();
  if (process.platform === "linux" || process.platform === "darwin") return pickUnix();
  return undefined;
}

async function pickWindows(): Promise<string | null | undefined> {
  // -STA: FolderBrowserDialog needs a single-threaded apartment.
  const { code, out } = await runCapture(
    "powershell",
    [
      "-NoProfile",
      "-STA",
      "-Command",
      [
        "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
        "$d.Description = 'Select the ACUTE-CODE project folder'",
        "$d.ShowNewFolderButton = $true",
        "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }",
      ].join("; "),
    ],
    DIALOG_TIMEOUT_MS,
  );
  if (code === -1) return undefined; // powershell missing/broken → manual fallback
  const picked = firstLine(out);
  return picked === "" ? null : picked;
}

async function pickUnix(): Promise<string | null | undefined> {
  // zenity (GNOME/most distros) → kdialog (KDE); exit 1 = cancel.
  const candidates: Array<readonly [string, readonly string[]]> = [
    ["zenity", ["--file-selection", "--directory", "--title=Select the ACUTE-CODE project folder"]],
    ["kdialog", ["--getexistingdirectory", "."]],
  ];
  for (const [cmd, args] of candidates) {
    const { code, out } = await runCapture(cmd, [...args], DIALOG_TIMEOUT_MS);
    if (code === 0) {
      const picked = firstLine(out);
      return picked === "" ? null : picked;
    }
    if (code === 1) return null; // dialog ran, user cancelled
    // -1/127 = not installed or failed to launch → try the next candidate
  }
  return undefined;
}
