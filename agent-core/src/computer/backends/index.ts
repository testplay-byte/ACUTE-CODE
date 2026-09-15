/**
 * ROUND-61 (R61): platform detection + backend selection + the REAL command
 * runner. One place decides which backend lives on this host; the runner
 * turns CommandCapsules into child processes (with timeouts, stdout capture,
 * base64 for binary-safe channels).
 */
import { spawn } from "node:child_process";
import { platform } from "node:os";
import type { CuaBackend, RunCommand } from "./interface.js";
import { linuxBackend } from "./linux.js";
import { windowsBackend } from "./windows.js";
import { macosBackend } from "./macos.js";

export type PlatformId = "linux" | "win32" | "darwin" | "other";

export function detectPlatform(): PlatformId {
  const p = platform();
  if (p === "linux") return "linux";
  if (p === "win32") return "win32";
  if (p === "darwin") return "darwin";
  return "other";
}

/**
 * The backend for THIS host. win32/darwin pick their native backend even
 * when the probing tools are missing (methods fail closed per-call — the
 * Windows backend IS the right backend on Windows regardless of PowerShell
 * health). On Linux the linuxBackend applies. "other" platforms get the
 * Linux backend with an honest unsupported matrix (every probe fails).
 */
export function backendForPlatform(id: PlatformId = detectPlatform()): CuaBackend {
  switch (id) {
    case "win32":
      return windowsBackend;
    case "darwin":
      return macosBackend;
    default:
      return linuxBackend;
  }
}

/**
 * ROUND-98 (R98-G1): the STANDALONE capture engine for pixels that do not
 * belong to Computer Use. `backendForPlatform()` + `realRunner()` are pure
 * host facts — the SAME singletons the computer-use plugin wires into its
 * dispatcher/relay — but until now the ONLY way a tool could reach them was
 * the computer-use relay registry, which the plugin arms inside createTools
 * ONLY when Settings → Computer Use is enabled (DEFAULT OFF). The browser
 * plugin's screenshot action therefore silently inherited an unrelated
 * OFF-by-default master switch (the owner: "it was currently unable to take
 * screenshots of the web browser").
 *
 * This is the decoupled door: the active platform backend + its command
 * runner, with NO computer-use session, NO relay registry, NO settings gate.
 * Fail-closed stays honest per-call: a backend whose capture tools are
 * missing (e.g. Linux without scrot/import) returns its own error from
 * captureRegion, and the caller surfaces it. Computer Use keeps its own
 * dispatcher + relay path untouched (zero regression there) — when the
 * plugin is enabled both paths resolve to the exact same backend object,
 * so nothing about capture behavior changes for it.
 */
export function getCaptureBackend(): { backend: CuaBackend; run: RunCommand } {
  return { backend: backendForPlatform(), run: realRunner() };
}

/**
 * The REAL RunCommand: spawn the capsule, capture stdout (utf8 unless the
 * caller asked for binary — capsules flag binary by convention: the Linux
 * capture path pipes through base64 itself, so utf8 is always right),
 * enforce the timeout, NEVER throws (a failed spawn is code 127-style
 * result with stderr set). This is the only place child processes are born
 * for computer use.
 */
export function realRunner(): (
  capsule: import("./interface.js").CommandCapsule,
) => Promise<import("./interface.js").RunResult> {
  return (capsule) =>
    new Promise((resolve) => {
      const child = spawn(capsule.program, capsule.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, capsule.timeoutMs ?? 15000);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.length > 64 * 1024 * 1024) child.kill("SIGKILL");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > 1024 * 1024) child.kill("SIGKILL");
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: 127, stdout: "", stderr: String(err), timedOut });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? (timedOut ? 124 : 0), stdout, stderr, timedOut });
      });

      if (capsule.stdin !== undefined) {
        child.stdin.on("error", () => {
          // EPIPE when the child exits early — swallow, close handles the rest.
        });
        child.stdin.end(capsule.stdin, "utf8");
      } else {
        child.stdin.end();
      }
    });
}
