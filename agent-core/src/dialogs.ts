/**
 * Native OS folder picker (round-14→19). The sidecar runs as a local process
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
 * NEVER call this from tests: the dialog blocks waiting for a human.
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
 * Write the picker script to a temp .ps1, run it, read the result file.
 * The script uses a classic FolderBrowserDialog (the most reliable from
 * console-spawned PowerShell) and writes its output to a sibling .txt file.
 */
const PS_SCRIPT = `
param([string]$ResultFile)
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select the ACUTE-CODE project folder'
$dialog.ShowNewFolderButton = $true
$dialog.RootFolder = [System.Environment+SpecialFolder]::Desktop
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [System.IO.File]::WriteAllText($ResultFile, 'OK:' + $dialog.SelectedPath)
} else {
  [System.IO.File]::WriteAllText($ResultFile, 'CANCEL')
}
`;

export async function pickFolder(): Promise<PickFolderResult> {
  if (process.platform === "win32") return pickWindows();
  if (process.platform === "linux" || process.platform === "darwin") return pickUnix();
  return { path: null, error: `folder dialogs are not supported on ${process.platform}` };
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
