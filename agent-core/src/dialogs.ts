/**
 * Native OS folder picker (round-14/15: "select the folder itself, don't
 * paste paths"). The sidecar runs as a local process on the user's machine,
 * so IT can open the real OS dialog even while the UI runs in a plain browser
 * (the launcher/dev setup) — PowerShell dialogs on Windows, zenity/kdialog on
 * Linux. The Tauri shell keeps its own rfd-based pick_folder command; the UI
 * tries Tauri first, then this endpoint.
 *
 * Round-15 hardening (owner-reported: Browse did nothing on Windows):
 * • Windows uses TWO methods with a fallback — WinForms FolderBrowserDialog
 *   first, then the Shell.Application COM BrowseForFolder (works from
 *   background console processes where WinForms can refuse to pump).
 * • Protocol markers (ACUTE_PICK:<path> / ACUTE_CANCEL) distinguish a real
 *   cancel from a FAILED dialog run — previously a failure looked like a
 *   cancel and the UI silently did nothing.
 * • Failures are returned as an `error` string so the UI can SHOW the cause
 *   instead of no-op'ing; nothing is silent anymore.
 * • Always async — a sync spawn would freeze the whole sidecar while the
 *   dialog waits for a human.
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

function runCapture(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string; err: string }> {
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
  const line = res.out.split("\n").map((l) => l.trim()).find((l) => l.startsWith("ACUTE_PICK:") || l === "ACUTE_CANCEL");
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
  // Method 1: WinForms FolderBrowserDialog (needs -STA).
  const winforms = await runCapture(
    "powershell",
    [
      "-NoProfile",
      "-STA",
      "-Command",
      [
        "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
        `$d.Description = '${TITLE}'`,
        "$d.ShowNewFolderButton = $true",
        "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output ('ACUTE_PICK:' + $d.SelectedPath) }",
        "else { Write-Output 'ACUTE_CANCEL' }",
      ].join("; "),
    ],
    DIALOG_TIMEOUT_MS,
  );
  const r1 = interpret(winforms, "FolderBrowserDialog");
  if (r1.picked !== null || r1.cancelled) return { path: r1.picked };

  // Method 2 (fallback): Shell.Application COM BrowseForFolder — historically
  // more reliable from background/console processes.
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
  const r2 = interpret(com, "Shell.BrowseForFolder");
  if (r2.picked !== null || r2.cancelled) return { path: r2.picked };

  return { path: null, error: `${r1.error ?? ""}; ${r2.error ?? "no dialog method worked"}` };
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
