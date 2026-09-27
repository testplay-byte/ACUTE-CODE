// The supervisor unit tests (R128-W1). Vitest's default include sweeps the
// whole tree (vite.config.ts -- mobile/** is the only project exclude), so
// this file rides the root `pnpm test` run even though it lives in tests/.
// The environment is the config default (node) -- the supervisor is a plain
// Node process, and importing it must NEVER start its CLI loop (the
// import.meta guard is pinned by the fact that this suite completes).
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_EXIT_POLL_MS,
  buildGuardCommand,
  buildInstallerCommand,
  buildNotificationCommand,
  buildRelaunchPlan,
  exeIsReady,
  GUARD_SPAWN_OPTIONS,
  isProcessAlive,
  NO_PID_SETTLE_MS,
  parseGuardOutput,
  parseSupervisorArgs,
  PRIMARY_RELINQUISH_MS,
  relaunchBackoffMs,
  RELAUNCH_BACKOFF_MS,
  RELAUNCH_MAX_ATTEMPTS,
  RELAUNCH_VERIFY_MS,
  runSupervisor,
  shouldRelaunch,
} from "../../scripts/release/update-supervisor.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("../../scripts/release/update-supervisor.mjs", import.meta.url));

// == parseSupervisorArgs =====================================================

describe("parseSupervisorArgs", () => {
  it("parses the full argv contract exactly as update.rs spells it", () => {
    const parsed = parseSupervisorArgs([
      "--app-exe", "C:\\Apps\\ACUTE-CODE\\ACUTE-CODE.exe",
      "--installer", "C:\\Users\\o\\AppData\\Local\\Temp\\ACUTE-CODE_0.121.0_x64-setup.exe",
      "--version", "0.121.0",
      "--app-pid", "4242",
      "--mode", "watch",
      "--max-wait-secs", "600",
      "--log", "C:\\Users\\o\\AppData\\Roaming\\acute-code\\update-supervisor.log",
    ]);
    expect(parsed).toEqual({
      args: {
        appExe: "C:\\Apps\\ACUTE-CODE\\ACUTE-CODE.exe",
        installer: "C:\\Users\\o\\AppData\\Local\\Temp\\ACUTE-CODE_0.121.0_x64-setup.exe",
        version: "0.121.0",
        appPid: 4242,
        mode: "watch",
        maxWaitSecs: 600,
        log: "C:\\Users\\o\\AppData\\Roaming\\acute-code\\update-supervisor.log",
      },
    });
  });

  it("defaults: watch mode, 600s budget, no pid, no log", () => {
    const parsed = parseSupervisorArgs(["--app-exe", "/opt/ACUTE-CODE/ACUTE-CODE", "--installer", "none", "--version", "1.0.0"]);
    expect(parsed.args.mode).toBe("watch");
    expect(parsed.args.maxWaitSecs).toBe(600);
    expect(parsed.args.appPid).toBeNull();
    expect(parsed.args.log).toBeNull();
    // "none" normalizes to the NULL installer (watch mode's informational shape).
    expect(parsed.args.installer).toBeNull();
  });

  it("requires --app-exe, --installer, and --version (honest one-line errors)", () => {
    expect(parseSupervisorArgs(["--installer", "none", "--version", "1"])).toEqual({ error: "--app-exe is required" });
    expect(parseSupervisorArgs(["--app-exe", "/a", "--version", "1"])).toEqual({
      error: "--installer is required (a path, or none)",
    });
    expect(parseSupervisorArgs(["--app-exe", "/a", "--installer", "none"])).toEqual({ error: "--version is required" });
  });

  it("run mode refuses the null installer -- the supervisor would own an install it cannot run", () => {
    const parsed = parseSupervisorArgs(["--app-exe", "/a", "--installer", "none", "--version", "1", "--mode", "run"]);
    expect(parsed).toEqual({
      error: "--mode run requires a real --installer path (the supervisor owns the install)",
    });
  });

  it("validates the flag values (pid, mode, max-wait) and rejects unknown flags / missing values", () => {
    expect(parseSupervisorArgs(["--app-exe", "/a", "--installer", "i", "--version", "1", "--app-pid", "abc"])).toEqual({
      error: '--app-pid must be a positive integer (got "abc")',
    });
    expect(parseSupervisorArgs(["--app-exe", "/a", "--installer", "i", "--version", "1", "--mode", "restart"])).toEqual({
      error: '--mode must be watch or run (got "restart")',
    });
    expect(parseSupervisorArgs(["--app-exe", "/a", "--installer", "i", "--version", "1", "--max-wait-secs", "soon"])).toEqual({
      error: '--max-wait-secs must be a positive integer (got "soon")',
    });
    expect(parseSupervisorArgs(["--app-exe", "/a", "--installer", "i", "--version", "1", "--wait", "1"])).toEqual({
      error: 'unknown argument "--wait"',
    });
    expect(parseSupervisorArgs(["--app-exe"])).toEqual({ error: "--app-exe requires a value" });
  });
});

// == liveness, the plan, and the guard =======================================

describe("isProcessAlive (the default strategy)", () => {
  it("answers alive for a live pid and dead for a reaped child", async () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", ""]);
    const code = await new Promise((resolve) => {
      child.on("close", resolve);
    });
    expect(code).toBe(0);
    // A reaped pid is gone (pid reuse within a test run is not a thing).
    expect(isProcessAlive(child.pid)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBe(false);
  });
});

describe("buildRelaunchPlan / shouldRelaunch / relaunchBackoffMs", () => {
  it("the letter's plan: 3 attempts, 2s backoff base, ~10s verify", () => {
    expect(buildRelaunchPlan()).toEqual({
      maxAttempts: RELAUNCH_MAX_ATTEMPTS,
      backoffMs: RELAUNCH_BACKOFF_MS,
      verifyMs: RELAUNCH_VERIFY_MS,
    });
    expect(RELAUNCH_MAX_ATTEMPTS).toBe(3);
    expect(RELAUNCH_BACKOFF_MS).toBe(2000);
    expect(RELAUNCH_VERIFY_MS).toBe(10000);
    // The cadences the letter pinned for the two wait legs.
    expect(APP_EXIT_POLL_MS).toBe(250);
    expect(NO_PID_SETTLE_MS).toBe(1500);
    // R131-U: the watch-mode grace for the app's own relauncher to land
    // (the ownership handshake -- see the exclusivity tests below).
    expect(PRIMARY_RELINQUISH_MS).toBe(3000);
  });

  it("R131-U: the backoff ladder is exponential (2s -> 4s -> 8s) -- a failing belt gets strictly calmer, never a flicker storm", () => {
    expect(relaunchBackoffMs(1)).toBe(2000);
    expect(relaunchBackoffMs(2)).toBe(4000);
    expect(relaunchBackoffMs(3)).toBe(8000);
    // hostile/absent inputs clamp to the first rung, never NaN.
    expect(relaunchBackoffMs(0)).toBe(2000);
    expect(relaunchBackoffMs(Number.NaN)).toBe(2000);
  });

  it("the guard vetoes (never double-launch) and the attempt budget stops the loop", () => {
    expect(shouldRelaunch({ appRunning: true, attempts: 0 })).toBe(false);
    expect(shouldRelaunch({ appRunning: false, attempts: 0 })).toBe(true);
    expect(shouldRelaunch({ appRunning: false, attempts: 2 })).toBe(true);
    expect(shouldRelaunch({ appRunning: false, attempts: RELAUNCH_MAX_ATTEMPTS })).toBe(false);
    expect(shouldRelaunch({ appRunning: false })).toBe(true);
  });

  it("R131-U: the guard's spawn options are frozen windowsHide -- the console flash dies at EVERY probe site", () => {
    expect(GUARD_SPAWN_OPTIONS).toEqual({ windowsHide: true });
    expect(Object.isFrozen(GUARD_SPAWN_OPTIONS)).toBe(true);
  });
});

describe("buildGuardCommand / parseGuardOutput", () => {
  it("windows: tasklist filtered to the exe's image name, CSV output", () => {
    expect(buildGuardCommand("win32", "C:\\Apps\\ACUTE-CODE\\ACUTE-CODE.exe")).toEqual({
      command: "tasklist",
      args: ["/FI", "IMAGENAME eq ACUTE-CODE.exe", "/FO", "CSV"],
    });
  });

  it("windows: a matching CSV row (case-insensitive) means running; the INFO no-match line and other images do not", () => {
    const exe = "C:\\Apps\\ACUTE-CODE\\ACUTE-CODE.exe";
    const csv = [
      '"Image Name","PID","Session Name","Session#","Mem Usage"',
      '"ACUTE-CODE.exe","4242","Console","1","123,456 K"',
      '"node.exe","999","Console","1","55,000 K"',
    ].join("\r\n");
    expect(parseGuardOutput("win32", exe, csv, 0, 1)).toBe(true);
    expect(parseGuardOutput("win32", exe, csv.toUpperCase(), 0, 1)).toBe(true);
    expect(parseGuardOutput("win32", exe, '"node.exe","999","Console","1","55 K"', 0, 1)).toBe(false);
    expect(parseGuardOutput("win32", exe, "INFO: No tasks are running which match the specified criteria.", 0, 1)).toBe(false);
    expect(parseGuardOutput("win32", exe, "", 0, 1)).toBe(false);
  });

  it("linux: pgrep -f <exe path>; exit 0 with pids means running, exit 1 does not, and the supervisor's OWN pid never counts", () => {
    expect(buildGuardCommand("linux", "/opt/ACUTE-CODE.AppImage")).toEqual({
      command: "pgrep",
      args: ["-f", "/opt/ACUTE-CODE.AppImage"],
    });
    // The supervisor's own command line carries --app-exe -- pgrep -f would
    // self-match; the parser must filter the self pid out.
    expect(parseGuardOutput("linux", "/opt/ACUTE-CODE.AppImage", "4242\n", 0, 4242)).toBe(false);
    expect(parseGuardOutput("linux", "/opt/ACUTE-CODE.AppImage", "4242\n1234\n", 0, 4242)).toBe(true);
    expect(parseGuardOutput("linux", "/opt/ACUTE-CODE.AppImage", "", 1, 4242)).toBe(false);
    expect(parseGuardOutput("linux", "/opt/ACUTE-CODE.AppImage", "", 2, 4242)).toBe(false);
  });
});

// == the run-mode installer + the notification ===============================

describe("buildInstallerCommand", () => {
  it("windows: the setup.exe with NSIS /S -- and NO /R (the relaunch is the supervisor's own)", () => {
    expect(buildInstallerCommand("win32", "C:\\Temp\\ACUTE-CODE_0.121.0_x64-setup.exe")).toEqual({
      command: "C:\\Temp\\ACUTE-CODE_0.121.0_x64-setup.exe",
      args: ["/S"],
    });
  });

  it("linux: the AppImage is chmod'd + executed directly; the .deb rides pkexec dpkg -i", () => {
    expect(buildInstallerCommand("linux", "/tmp/ACUTE-CODE_0.121.0_amd64.AppImage")).toEqual({
      command: "/tmp/ACUTE-CODE_0.121.0_amd64.AppImage",
      args: [],
      needsChmod: true,
    });
    expect(buildInstallerCommand("linux", "/tmp/acute_0.121.0_amd64.deb")).toEqual({
      command: "pkexec",
      args: ["dpkg", "-i", "/tmp/acute_0.121.0_amd64.deb"],
    });
  });

  it("anything else is honestly unsupported (never a guessed launch)", () => {
    expect(buildInstallerCommand("win32", "/tmp/x.AppImage").unsupported).toBe(true);
    expect(buildInstallerCommand("linux", "/tmp/x.rpm").unsupported).toBe(true);
  });
});

describe("buildNotificationCommand", () => {
  it("windows: powershell.exe -NoProfile -Command with the WinRT toast template and the pinned text pair", () => {
    const note = buildNotificationCommand("win32", "0.121.0");
    expect(note.command).toBe("powershell.exe");
    expect(note.args[0]).toBe("-NoProfile");
    expect(note.args[1]).toBe("-Command");
    const script = note.args[2];
    expect(script).toContain(
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
    );
    expect(script).toContain("ToastText02");
    expect(script).toContain("CreateToastNotifier('ACUTE-CODE')");
    expect(script).toContain("CreateTextNode('ACUTE-CODE')");
    expect(script).toContain("CreateTextNode('Updated to v0.121.0 -- restarting')");
    expect(note.text).toEqual({ title: "ACUTE-CODE", body: "Updated to v0.121.0 -- restarting" });
  });

  it("linux: notify-send with the app name + the same body", () => {
    const note = buildNotificationCommand("linux", "0.121.0");
    expect(note).toEqual({
      command: "notify-send",
      args: ["ACUTE-CODE", "Updated to v0.121.0 -- restarting"],
      text: { title: "ACUTE-CODE", body: "Updated to v0.121.0 -- restarting" },
    });
  });

  it("single quotes inside a version cannot break the PowerShell string", () => {
    const note = buildNotificationCommand("win32", "0.1'2");
    expect(note.args[2]).toContain("'Updated to v0.1''2 -- restarting'");
  });
});

// == watch mode's readiness test =============================================

describe("exeIsReady", () => {
  it("the exe exists => ready; absent => not; the renamed .old path is never the new app", () => {
    expect(exeIsReady("C:\\Apps\\ACUTE-CODE.exe", { size: 1 })).toBe(true);
    expect(exeIsReady("C:\\Apps\\ACUTE-CODE.exe", null)).toBe(false);
    expect(exeIsReady("C:\\Apps\\ACUTE-CODE.exe.old", { size: 1 })).toBe(false);
  });
});

// == the loop itself (every external edge injected) ==========================

/** A fake deps bundle + a state recorder. guardAnswer() is consulted per
 * probe; the default says "not running" until the app spawn is recorded,
 * then "running" -- exactly the real verify-window shape. R131-U: the deps
 * seam also records a UNIFIED event stream ("guard" / "spawn" / "install"
 * / "notify") so the ownership-exclusivity law can be pinned by ORDER:
 * which actor moved first, and whether the supervisor ever competed. */
function fakeDeps(overrides = {}) {
  const state = {
    t: 0,
    appSpawns: [],
    waited: [],
    guards: [],
    logLines: [],
    chmods: [],
    timers: [],
    exited: undefined,
    events: [],
  };
  const guardAnswer =
    overrides.guardAnswer ??
    (() => {
      const running = state.appSpawns.length > 0;
      // Platform-appropriate shapes: the win32 leg parses tasklist's CSV, the
      // linux leg parses pgrep's pid lines + exit code.
      if ((overrides.platform ?? "linux") === "win32") {
        return running
          ? { stdout: '"ACUTE-CODE.exe","1234","Console","1","1,000 K"', code: 0 }
          : { stdout: "INFO: No tasks are running which match the specified criteria.", code: 0 };
      }
      return running ? { stdout: "1234\n", code: 0 } : { stdout: "", code: 1 };
    });
  const deps = {
    spawn: (cmd, args, opts) => {
      state.appSpawns.push({ cmd, args, opts });
      state.events.push(["spawn", cmd]);
      return { unref() {} };
    },
    spawnAndWait: async (cmd, args, opts, timeout) => {
      state.waited.push({ cmd, args, opts, timeout });
      state.events.push(["install-or-notify", cmd]);
      return overrides.spawnAndWaitCode ?? 0;
    },
    captureOutput: async (cmd, args, opts) => {
      const out = guardAnswer();
      state.guards.push({ cmd, args, opts, out });
      state.events.push(["guard", cmd]);
      return out;
    },
    sleep: async (ms) => {
      state.t += ms;
    },
    now: () => state.t,
    platform: () => overrides.platform ?? "linux",
    selfPid: () => 4242,
    stat: () => ("stat" in overrides ? overrides.stat : { size: 100, mtimeMs: 1 }),
    canOpenForRead: () => true,
    chmod: (path, mode) => {
      state.chmods.push({ path, mode });
    },
    isProcessAlive: () => overrides.appAlive ?? false,
    appendFile: (path, data) => {
      state.logLines.push(String(data).trim());
    },
    mkdir: () => {},
    setTimeout: (fn, ms) => {
      state.timers.push({ fn, ms });
      return { fn, ms };
    },
    clearTimeout: () => {},
    exit: (code) => {
      state.exited = code;
    },
  };
  return { state, deps };
}

function supervisorArgs(overrides = {}) {
  return {
    appExe: overrides.appExe ?? "/opt/ACUTE-CODE.AppImage",
    installer: overrides.installer ?? null,
    version: overrides.version ?? "0.121.0",
    appPid: overrides.appPid ?? 111,
    mode: overrides.mode ?? "watch",
    maxWaitSecs: overrides.maxWaitSecs ?? 600,
    log: overrides.log ?? "/tmp/update-supervisor.log",
  };
}

describe("runSupervisor (mode behavior, all edges injected)", () => {
  it("watch mode: app exits -> exe in place -> guard clear -> DETACHED relaunch -> verify -> the completion toast", async () => {
    const { state, deps } = fakeDeps();
    const code = await runSupervisor(supervisorArgs({ mode: "watch" }), deps);
    expect(code).toBe(0);
    // The relaunch: detached, stdio ignored, HIDDEN (R131-U: every spawn
    // site carries windowsHide), cwd = the exe's dir, unref'd.
    expect(state.appSpawns).toEqual([
      {
        cmd: "/opt/ACUTE-CODE.AppImage",
        args: [],
        opts: { detached: true, stdio: "ignore", windowsHide: true, cwd: "/opt" },
      },
    ]);
    // The notification: notify-send (linux), waited on, HIDDEN.
    expect(state.waited).toEqual([
      { cmd: "notify-send", args: ["ACUTE-CODE", "Updated to v0.121.0 -- restarting"], opts: { stdio: "ignore", windowsHide: true }, timeout: 15000 },
    ]);
    // The hard-lifetime timer was armed at max-wait + 120s.
    expect(state.timers.map((t) => t.ms)).toEqual([720_000]);
    // The story is on the log, one line per step.
    const story = state.logLines.join("\n");
    expect(story).toContain("started -- mode=watch");
    expect(story).toContain("the app process has exited");
    expect(story).toContain("the app executable is in place");
    expect(story).toContain("relaunch attempt 1/3");
    expect(story).toContain("relaunch verified on attempt 1");
    expect(story).toContain("the notification finished with code 0");
  });

  it("R131-U (the calm law): EVERY guard probe carries windowsHide -- the tasklist/pgrep flash storm is dead", async () => {
    const { state, deps } = fakeDeps({ platform: "win32" });
    await runSupervisor(
      supervisorArgs({
        mode: "run",
        appExe: "C:\\Apps\\ACUTE-CODE\\ACUTE-CODE.exe",
        installer: "C:\\Temp\\ACUTE-CODE_0.121.0_x64-setup.exe",
      }),
      deps,
    );
    expect(state.guards.length).toBeGreaterThan(0);
    for (const probe of state.guards) {
      expect(probe.cmd).toBe("tasklist");
      expect(probe.opts).toEqual(GUARD_SPAWN_OPTIONS);
    }
  });

  it("the GUARD: an instance already running exits the supervisor BEFORE any relaunch or toast", async () => {
    const { state, deps } = fakeDeps({ guardAnswer: () => ({ stdout: "1234\n", code: 0 }) });
    const code = await runSupervisor(supervisorArgs({ mode: "watch" }), deps);
    expect(code).toBe(0);
    expect(state.appSpawns).toEqual([]);
    expect(state.waited).toEqual([]);
    expect(state.logLines.join("\n")).toContain("already running -- supervisor exits");
  });

  it("run mode: app exits -> the installer /S is OWNED (spawned + waited) -> relaunch -> toast", async () => {
    const { state, deps } = fakeDeps({ platform: "win32" });
    const code = await runSupervisor(
      supervisorArgs({
        mode: "run",
        appExe: "C:\\Apps\\ACUTE-CODE\\ACUTE-CODE.exe",
        installer: "C:\\Temp\\ACUTE-CODE_0.121.0_x64-setup.exe",
      }),
      deps,
    );
    expect(code).toBe(0);
    expect(state.waited[0]).toEqual({
      cmd: "C:\\Temp\\ACUTE-CODE_0.121.0_x64-setup.exe",
      args: ["/S"],
      // R131-U: the installer spawn stays detached + ignored AND gains
      // windowsHide (the NSIS installer is console-capable).
      opts: { detached: true, stdio: "ignore", windowsHide: true },
      timeout: 600_000,
    });
    expect(state.appSpawns).toEqual([
      {
        cmd: "C:\\Apps\\ACUTE-CODE\\ACUTE-CODE.exe",
        args: [],
        // cwd = the exe's own directory (node:path's dirname -- the
        // platform-flavored module the supervisor itself uses).
        opts: { detached: true, stdio: "ignore", windowsHide: true, cwd: dirname("C:\\Apps\\ACUTE-CODE\\ACUTE-CODE.exe") },
      },
    ]);
    // The toast (windows leg) follows the relaunch -- HIDDEN (powershell.exe
    // is a console exe; without windowsHide it allocates its own window).
    expect(state.waited[1]?.cmd).toBe("powershell.exe");
    expect(state.waited[1]?.args[0]).toBe("-NoProfile");
    expect(state.waited[1]?.opts).toEqual({ stdio: "ignore", windowsHide: true });
    const story = state.logLines.join("\n");
    expect(story).toContain("the installer exited with code 0");
    expect(story).toContain("mode=run");
    // R131-U (one owner): run mode asks NO grace -- the supervisor IS the
    // primary, so its first relaunch follows exactly ONE guard probe (the
    // pre-flight check), never the watch-mode grace poll.
    const firstSpawn = state.events.findIndex(([kind]) => kind === "spawn");
    const guardProbesBeforeSpawn = state.events
      .slice(0, firstSpawn)
      .filter(([kind]) => kind === "guard").length;
    expect(guardProbesBeforeSpawn).toBe(1);
  });

  it("run mode, AppImage leg: chmod +x lands before the direct exec", async () => {
    const { state, deps } = fakeDeps();
    const code = await runSupervisor(
      supervisorArgs({ mode: "run", installer: "/tmp/ACUTE-CODE_0.121.0_amd64.AppImage" }),
      deps,
    );
    expect(code).toBe(0);
    expect(state.chmods).toEqual([{ path: "/tmp/ACUTE-CODE_0.121.0_amd64.AppImage", mode: 0o755 }]);
    expect(state.waited[0]).toEqual({
      cmd: "/tmp/ACUTE-CODE_0.121.0_amd64.AppImage",
      args: [],
      opts: { detached: true, stdio: "ignore", windowsHide: true },
      timeout: 600_000,
    });
  });

  it("a FAILED installer is logged honestly: the restart still happens, but NO completion toast (it would be a lie)", async () => {
    const { state, deps } = fakeDeps({ spawnAndWaitCode: 1 });
    const code = await runSupervisor(
      supervisorArgs({ mode: "run", installer: "/tmp/ACUTE-CODE_0.121.0_amd64.AppImage" }),
      deps,
    );
    expect(code).toBe(0);
    const story = state.logLines.join("\n");
    expect(story).toContain("the installer exited with code 1");
    expect(story).toContain("no completion toast (honest)");
    // Only the installer was waited on -- no notify-send.
    expect(state.waited.filter((w) => w.cmd === "notify-send")).toEqual([]);
    // The app still came back (the restart guarantee outranks the install).
    expect(state.appSpawns.length).toBe(1);
  });

  it("watch mode when the exe never appears: the honest give-up (exit 1), no relaunch", async () => {
    const { state, deps } = fakeDeps({ stat: null });
    const code = await runSupervisor(supervisorArgs({ mode: "watch", maxWaitSecs: 1 }), deps);
    expect(code).toBe(1);
    expect(state.appSpawns).toEqual([]);
    expect(state.logLines.join("\n")).toContain("did not become available within the wait budget");
  });

  it("the app that never exits: the supervisor stands down (the primary flow owns the screen)", async () => {
    const { state, deps } = fakeDeps({ appAlive: true });
    const code = await runSupervisor(supervisorArgs({ mode: "watch", maxWaitSecs: 1 }), deps);
    expect(code).toBe(0);
    expect(state.appSpawns).toEqual([]);
    expect(state.logLines.join("\n")).toContain("the app never exited within the wait budget");
  });

  // ── R131-U (U3): ONE OWNER FOR THE RESTART ─────────────────────────────
  // The modes were already split by design (watch = the app's own flow is
  // primary, run = the supervisor owns it); the gap was TIMING: the AppImage
  // leg's primary relauncher fires ~1.25s AFTER the old pid dies, so a
  // zero-grace guard could beat it to the spawn and double-launch. The
  // PRIMARY_RELINQUISH_MS grace closes the window -- pinned here by ORDER.
  it("watch mode: the app's OWN relauncher landing mid-grace stands the supervisor down -- NO competing relaunch", async () => {
    // The primary's instance appears 1500ms after the app exits (the
    // AppImage sh -c leg's real shape: pid-death -> 1s settle -> exec).
    const { state, deps } = fakeDeps();
    let appExitAt = null;
    const depsWithLatePrimary = {
      ...deps,
      isProcessAlive: (_pid) => {
        if (appExitAt === null) {
          appExitAt = state.t;
          return false; // the app exits at the first poll
        }
        return false;
      },
      captureOutput: async (cmd, args, opts) => {
        const primaryLanded = appExitAt !== null && state.t - appExitAt >= 1500;
        const out = primaryLanded ? { stdout: "1234\n", code: 0 } : { stdout: "", code: 1 };
        state.guards.push({ cmd, args, opts, out });
        state.events.push(["guard", cmd]);
        return out;
      },
    };
    const code = await runSupervisor(supervisorArgs({ mode: "watch" }), depsWithLatePrimary);
    expect(code).toBe(0);
    // THE ownership law: the primary won, the supervisor NEVER spawned.
    expect(state.appSpawns).toEqual([]);
    expect(state.waited).toEqual([]);
    expect(state.logLines.join("\n")).toContain("already running -- supervisor exits");
    // And it stood down within the grace budget (t advanced past the landing).
    expect(state.t).toBeGreaterThanOrEqual(1500);
  });

  it("watch mode with a DEAD primary (the R128 incident): the grace expires honestly and the belt takes over", async () => {
    const { state, deps } = fakeDeps();
    const code = await runSupervisor(supervisorArgs({ mode: "watch" }), deps);
    expect(code).toBe(0);
    // The belt's rescue waited out the full grace before its first spawn:
    // the pre-spawn guard probes are the grace ladder (6 polls of 500ms)
    // plus the final one -- the belt yielded, THEN moved.
    const firstSpawn = state.events.findIndex(([kind]) => kind === "spawn");
    expect(firstSpawn).toBeGreaterThanOrEqual(0);
    const guardsBeforeSpawn = state.events
      .slice(0, firstSpawn)
      .filter(([kind]) => kind === "guard").length;
    expect(guardsBeforeSpawn).toBe(PRIMARY_RELINQUISH_MS / 500 + 1);
    expect(state.appSpawns.length).toBe(1);
  });
});

// == the CLI guard (importing never starts the loop; bad argv exits 2) =======

describe("the CLI entry", () => {
  it("invalid argv exits 2 with the usage line (a REAL child process -- the import.meta guard fires)", async () => {
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      execFile(process.execPath, [SCRIPT_PATH, "--app-exe", "/a"], { timeout: 15_000 }, (err, out, errOut) => {
        if (err && err.code !== 2) reject(err);
        else resolve({ stdout: out, stderr: errOut });
      });
    });
    expect(stderr).toContain("update-supervisor: --installer is required");
    expect(stderr).toContain("usage: node update-supervisor.mjs");
    expect(stdout).toBe("");
  });
});
