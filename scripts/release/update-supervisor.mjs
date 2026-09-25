#!/usr/bin/env node
/**
 * ROUND-128 (R128-W1): THE EXTERNAL UPDATE SUPERVISOR.
 *
 * The owner's v0.120.0 incident, verbatim: "it updated successfully,
 * downloaded, it updated, and then it closed properly without any problem.
 * But then it did not auto-start at all. It did not show me any system or
 * anything like that… maybe we should have a separate system for updating
 * the application, which would be separate from the app, so that it does not
 * get affected by the application. Like if the application closes, it still
 * functions and works…"
 *
 * This file IS that separate system: a plain-Node, ZERO-dependency process
 * the Rust shell (src-tauri/src/update.rs) spawns DETACHED before every
 * install leg. It owns nothing about the app — no window, no webview, no
 * sidecar — so the app closing (the intended exit, a crash, a power blip)
 * cannot take it down. Its one job is the guarantee the in-app flow could
 * never make on its own:
 *
 *   the app closed for an update ⇒ something OUTSIDE the app brings it back.
 *
 * Argv contract (spawned by update.rs, runnable by hand for debugging):
 *
 *   node update-supervisor.mjs \
 *     --app-exe <path>        the app executable to guard + relaunch
 *     --installer <path|none> the staged update installer ("none" when the
 *                             app's own flow already owns the install)
 *     --version <v>           the version being installed (log + toast)
 *     [--app-pid <pid>]       the app's pid (waited on before acting)
 *     [--mode watch|run]      watch (default): the app's own watcher runs the
 *                             install, this process is only the restart
 *                             guarantee. run: THIS process owns the whole
 *                             flow — wait exit → installer /S → guard →
 *                             relaunch → notify.
 *     [--max-wait-secs 600]   the budget for every bounded wait
 *     [--log <path>]          the append-only log file (ISO-stamped lines)
 *
 * Mode by leg (update.rs's decision):
 *   · Windows OVERLAY     → watch (the overlay watcher stays primary)
 *   · Windows FALLBACK    → run (the supervisor owns it — the NSIS /R hook
 *                           becomes irrelevant)
 *   · Linux AppImage      → watch (the sh -c pid-wait relauncher stays primary)
 *   · Linux .deb          → watch (the dpkg watcher stays primary)
 *
 * THE GUARD (never double-launch): before relaunching, check whether an app
 * instance is already running — Windows: `tasklist /FI "IMAGENAME eq <name>"
 * /FO CSV` parsed for the exe name; Linux: `pgrep -f <exe path>` (the
 * supervisor's own pid filtered out — its own command line contains the
 * --app-exe path and would otherwise self-match). If running → log
 * "already running — supervisor exits" and exit 0: the primary flow won.
 *
 * THE NOTIFICATION (the "it did not show me any system" half): when THIS
 * process performed the relaunch, a best-effort OS notification fires —
 * Windows: a PowerShell WinRT toast; Linux: notify-send. Belt by design:
 * when the app's own flow won, the guard exits before the toast and the
 * relaunched app's own "Setting up v…" splash is the UX (never both).
 *
 * Honesty laws:
 *   · EVERY external action is best-effort try/catch — the supervisor never
 *     hangs forever and never leaves a zombie: a hard-lifetime timer exits
 *     at max-wait + 120s no matter what, and every wait is deadline-bounded.
 *   · Every step is logged with an ISO timestamp, ONE line each, appended
 *     to the log file (default: the app's state dir, passed by update.rs).
 *   · A failed guard probe is treated as NOT running (the owner's incident
 *     was a dead app, not a doubled app — bringing it back wins the tie).
 *   · The toast fires only when the update genuinely landed (run mode: the
 *     installer exited 0; watch mode: the new exe appeared); a failed
 *     install relaunches the OLD app honestly with no "updated" toast.
 *
 * Testability: the pure decision functions are exported and the CLI main()
 * is guarded behind an import.meta.url === pathToFileURL(argv[1]) check, so
 * importing this module from vitest never starts the loop. runSupervisor()
 * takes an injectable deps object (spawn/clock/fs probes) — every external
 * edge is mockable. See tests/scripts/update-supervisor.test.mjs.
 */
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// ── the tunables (one spelling each, exported for the tests) ────────────────

/** The app-exit poll cadence (ms) — the letter's 250ms. */
export const APP_EXIT_POLL_MS = 250;
/** The settle when no --app-pid was supplied (ms) — the letter's one 1500ms sleep. */
export const NO_PID_SETTLE_MS = 1500;
/** The exe-ready poll cadence (ms) — the letter's 500ms. */
export const EXE_READY_POLL_MS = 500;
/** The guard's answer is also the relaunch VERIFICATION poll cadence (ms). */
export const GUARD_POLL_MS = 500;
/** Relaunch attempts before the honest give-up log. */
export const RELAUNCH_MAX_ATTEMPTS = 3;
/** Backoff between failed relaunch attempts (ms). */
export const RELAUNCH_BACKOFF_MS = 2000;
/** How long each relaunch attempt waits for the guard to see the new instance. */
export const RELAUNCH_VERIFY_MS = 10_000;
/** The hard lifetime bound's overshoot past max-wait (seconds). */
export const HARD_LIFETIME_GRACE_SECS = 120;
/** Bounded wait for guard probes (tasklist/pgrep) and the toast (ms). */
export const PROBE_TIMEOUT_MS = 15_000;

// ── pure decision functions (exported for tests) ───────────────────────────

/**
 * Parse the supervisor's argv (process.argv.slice(2) shape). Returns
 * `{ args }` on success or `{ error }` with the honest one-line reason.
 * Defaults: mode "watch", maxWaitSecs 600, no pid, no log file.
 */
export function parseSupervisorArgs(argv) {
  const args = {
    appExe: null,
    installer: undefined, // undefined = never supplied; "none" normalizes to null
    version: null,
    appPid: null,
    mode: "watch",
    maxWaitSecs: 600,
    log: null,
  };
  const readValue = (flag, at) => {
    if (at + 1 >= argv.length || argv[at + 1] === undefined) {
      return { error: `${flag} requires a value` };
    }
    return { value: String(argv[at + 1]) };
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = readValue(flag, i);
    switch (flag) {
      case "--app-exe": {
        if ("error" in next) return { error: next.error };
        args.appExe = next.value;
        i += 1;
        break;
      }
      case "--installer": {
        if ("error" in next) return { error: next.error };
        args.installer = next.value === "none" ? null : next.value;
        i += 1;
        break;
      }
      case "--version": {
        if ("error" in next) return { error: next.error };
        const value = next.value.trim();
        if (value === "") return { error: "--version requires a non-empty value" };
        args.version = value;
        i += 1;
        break;
      }
      case "--app-pid": {
        if ("error" in next) return { error: next.error };
        if (!/^\d+$/.test(next.value)) return { error: `--app-pid must be a positive integer (got "${next.value}")` };
        args.appPid = Number.parseInt(next.value, 10);
        i += 1;
        break;
      }
      case "--mode": {
        if ("error" in next) return { error: next.error };
        if (next.value !== "watch" && next.value !== "run") {
          return { error: `--mode must be watch or run (got "${next.value}")` };
        }
        args.mode = next.value;
        i += 1;
        break;
      }
      case "--max-wait-secs": {
        if ("error" in next) return { error: next.error };
        const value = Number.parseInt(next.value, 10);
        if (!Number.isFinite(value) || value <= 0 || String(value) !== next.value.trim()) {
          return { error: `--max-wait-secs must be a positive integer (got "${next.value}")` };
        }
        args.maxWaitSecs = value;
        i += 1;
        break;
      }
      case "--log": {
        if ("error" in next) return { error: next.error };
        if (next.value.trim() === "") return { error: "--log requires a non-empty path" };
        args.log = next.value;
        i += 1;
        break;
      }
      default:
        return { error: `unknown argument "${flag}"` };
    }
  }
  if (args.appExe === null) return { error: "--app-exe is required" };
  if (args.installer === undefined) return { error: "--installer is required (a path, or none)" };
  if (args.version === null) return { error: "--version is required" };
  if (args.mode === "run" && args.installer === null) {
    return { error: "--mode run requires a real --installer path (the supervisor owns the install)" };
  }
  return { args };
}

/**
 * The default liveness probe (injectable via deps.isProcessAlive):
 * `process.kill(pid, 0)` — signal 0 is the POSIX "does it exist" check.
 * EPERM means the process exists but belongs to another user → ALIVE;
 * ESRCH (or a bad pid) means gone.
 */
export function isProcessAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return typeof err === "object" && err !== null && err.code === "EPERM";
  }
}

/** The relaunch loop's shape (one spelling, pinned by tests). */
export function buildRelaunchPlan() {
  return {
    maxAttempts: RELAUNCH_MAX_ATTEMPTS,
    backoffMs: RELAUNCH_BACKOFF_MS,
    verifyMs: RELAUNCH_VERIFY_MS,
  };
}

/**
 * THE GUARD's pure decision: relaunch only when no instance is already
 * running (never double-launch) and the attempt budget is not spent.
 */
export function shouldRelaunch(state) {
  if (state.appRunning) return false;
  if (typeof state.attempts === "number" && state.attempts >= RELAUNCH_MAX_ATTEMPTS) return false;
  return true;
}

/**
 * The guard's command per platform (pure; run + parsed by the caller):
 *   · win32  → `tasklist /FI "IMAGENAME eq <basename>" /FO CSV`
 *   · linux  → `pgrep -f <exe path>` (the supervisor's own pid is filtered
 *              out when parsing — pgrep matches ARGV CONTENT, and this
 *              process's own command line carries --app-exe)
 */
export function buildGuardCommand(platform, appExe) {
  if (platform === "win32") {
    const basename = String(appExe).split(/[\\/]/).pop() ?? "";
    return { command: "tasklist", args: ["/FI", `IMAGENAME eq ${basename}`, "/FO", "CSV"] };
  }
  return { command: "pgrep", args: ["-f", String(appExe)] };
}

/**
 * Parse the guard's answer (pure). Windows: tasklist's CSV rows — a row
 * matches when its quoted "Image Name" field equals the exe's basename
 * (case-insensitive; the no-match answer is a plain `INFO: …` line with no
 * quotes, which naturally parses to no match). Linux: pgrep's exit code —
 * 0 with pid lines (selfPid removed) means running, 1 means no match.
 */
export function parseGuardOutput(platform, appExe, stdout, exitCode, selfPid) {
  if (platform === "win32") {
    const basename = (String(appExe).split(/[\\/]/).pop() ?? "").toLowerCase();
    if (basename === "") return false;
    for (const line of String(stdout ?? "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('"')) continue; // the INFO: line, blanks
      const fields = trimmed.slice(1).split(/","/); // CSV: "a","b","c"
      const image = (fields[0] ?? "").toLowerCase();
      if (image === basename) return true;
    }
    return false;
  }
  if (exitCode !== 0) return false; // pgrep: 1 = no match (anything else is not "running")
  const pids = String(stdout ?? "")
    .split(/\s+/)
    .map((token) => Number.parseInt(token, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== selfPid);
  return pids.length > 0;
}

/**
 * The run-mode installer command (pure): Windows → the setup.exe with NSIS's
 * own `/S` (NO `/R` — the relaunch is OURS here); Linux → direct exec for an
 * AppImage (after chmod +x) / `pkexec dpkg -i` for a .deb. Anything else is
 * honestly unsupported ({ unsupported: true }) — the caller logs and still
 * guarantees the restart.
 */
export function buildInstallerCommand(platform, installerPath) {
  const path = String(installerPath ?? "");
  const lower = path.toLowerCase();
  if (platform === "win32") {
    if (!lower.endsWith(".exe")) return { unsupported: true };
    return { command: path, args: ["/S"] };
  }
  if (lower.endsWith(".appimage")) {
    return { command: path, args: [], needsChmod: true };
  }
  if (lower.endsWith(".deb")) {
    return { command: "pkexec", args: ["dpkg", "-i", path] };
  }
  return { unsupported: true };
}

/**
 * The completion toast's command (pure, belt-only — fires when THIS process
 * brought the app back): Windows → a PowerShell WinRT toast via the
 * ToastNotificationManager template (the AUMID "ACUTE-CODE" is unregistered
 * — some Win11 builds decline to render it; the outcome is logged and the
 * app's own "Setting up v…" splash remains the primary UX); Linux →
 * notify-send. Text: "ACUTE-CODE" / "Updated to v{version} — restarting".
 */
export function buildNotificationCommand(platform, version) {
  const body = `Updated to v${String(version)} — restarting`;
  if (platform === "win32") {
    const psVersion = String(version).replace(/'/g, "''");
    const psBody = body.replace(/'/g, "''");
    const script = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
      "$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
      "$texts = $template.GetElementsByTagName('text')",
      "$texts.Item(0).AppendChild($template.CreateTextNode('ACUTE-CODE')) | Out-Null",
      `$texts.Item(1).AppendChild($template.CreateTextNode('${psBody}')) | Out-Null`,
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('ACUTE-CODE').Show([Windows.UI.Notifications.ToastNotification]::new($template))",
    ].join("; ");
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-Command", script],
      // The interpolated version, surfaced for tests/logging (the letter's
      // exact toast text pair).
      text: { title: "ACUTE-CODE", body: `Updated to v${psVersion} — restarting` },
    };
  }
  return {
    command: "notify-send",
    args: ["ACUTE-CODE", body],
    text: { title: "ACUTE-CODE", body },
  };
}

/**
 * Watch mode's readiness test (pure half): the exe at the ORIGINAL path is
 * ready when it EXISTS and the path is not the overlay flow's renamed
 * `<exe>.old` (the rename leaves the original path absent until the
 * installer writes the new exe — "exists" IS the replaced signal there).
 */
export function exeIsReady(appExe, statResult) {
  if (typeof appExe === "string" && appExe.toLowerCase().endsWith(".old")) return false;
  return statResult !== null;
}

// ── the loop (injectable deps — every external edge mockable) ──────────────

/** The default deps: real node builtin behavior. Tests inject fakes. */
function defaultDeps() {
  return {
    spawn: (command, args, options) => spawn(command, args, options),
    spawnAndWait,
    captureOutput,
    sleep: (ms) => new Promise((r) => {
      setTimeout(r, ms);
    }),
    now: () => Date.now(),
    platform: () => process.platform,
    selfPid: () => process.pid,
    stat: (path) => {
      try {
        return statSync(path);
      } catch {
        return null;
      }
    },
    canOpenForRead: (path) => {
      try {
        closeSync(openSync(path, "r"));
        return true;
      } catch {
        return false;
      }
    },
    chmod: (path, mode) => chmodSync(path, mode),
    isProcessAlive,
    appendFile: (path, data) => appendFileSync(path, data),
    mkdir: (path) => mkdirSync(path, { recursive: true }),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    exit: (code) => process.exit(code),
  };
}

/** Spawn + wait for exit (bounded): resolves the exit code, or null when the
 * spawn failed or the wait timed out. The child is NOT unref'd — its exit
 * event needs a live loop to fire; the caller owns the flow until it lands. */
function spawnAndWait(command, args, options, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      child = spawn(command, args, options);
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* best-effort */
      }
      resolve(null);
    }, timeoutMs);
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** Spawn + collect stdout + exit code (bounded): { stdout, code } | null. */
function captureOutput(command, args) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    let stdout = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* best-effort */
      }
      resolve(null);
    }, PROBE_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 65_536) stdout += String(chunk);
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, code });
    });
  });
}

/** One-line-per-step logger: ISO timestamp + message, appended best-effort. */
function makeLogger(logPath, deps) {
  const write = (message) => {
    const line = `${new Date(deps.now()).toISOString()} update-supervisor: ${String(message).replace(/\s+/g, " ").trim()}`;
    if (typeof logPath === "string" && logPath !== "") {
      try {
        try {
          deps.mkdir(dirname(logPath));
        } catch {
          /* the Rust caller passes an existing dir; best-effort */
        }
        deps.appendFile(logPath, `${line}\n`);
      } catch {
        /* a refusing log never kills the supervisor */
      }
    }
    try {
      console.error(line);
    } catch {
      /* detached-with-no-console writes are dropped, never fatal */
    }
  };
  return write;
}

/**
 * Run the supervisor loop. `parsed` is the validated args object from
 * parseSupervisorArgs; `deps` overrides any external edge. Returns the
 * process exit code (0 = done, 1 = the honest give-up). NEVER throws past
 * the hard-lifetime bound: the timer in the prologue exits the process at
 * max-wait + 120s no matter what this loop is doing.
 */
export async function runSupervisor(parsed, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const log = makeLogger(parsed.log, d);
  const maxWaitMs = parsed.maxWaitSecs * 1000;

  // The HARD LIFETIME BOUND — the one unbounded-loop killer. Ref'd (not
  // unref'd) so a stuck-but-busy loop still dies at the bound.
  const bound = d.setTimeout(() => {
    log("hard lifetime bound reached — exiting");
    d.exit(0);
  }, maxWaitMs + HARD_LIFETIME_GRACE_SECS * 1000);

  try {
    log(
      `started — mode=${parsed.mode} app-exe=${parsed.appExe} installer=${parsed.installer ?? "none"} version=${parsed.version} pid=${parsed.appPid ?? "none"}`,
    );

    // STEP 1/2 — wait for the app to close (both modes; the supervisor
    // never acts under a live instance of the app it is guarding).
    const appExited = await waitForAppExit(parsed, d, log);
    if (!appExited) {
      log("the app never exited within the wait budget — the primary flow owns the screen; supervisor exits");
      return 0;
    }
    log("the app process has exited");

    let installerSucceeded = true;
    if (parsed.mode === "run") {
      installerSucceeded = await runInstallerAndWait(parsed, d, log);
    } else {
      const ready = await waitForExeReady(parsed, d, log);
      if (!ready) {
        log("the app executable did not become available within the wait budget — giving up (the install likely failed)");
        return 1;
      }
      log("the app executable is in place — proceeding to the guard");
    }

    // STEP 3 — THE GUARD.
    if (await isAppRunning(parsed, d, log)) {
      log("already running — supervisor exits");
      return 0;
    }

    // STEP 4 — the detached relaunch with verification + retries.
    const plan = buildRelaunchPlan();
    let relaunched = false;
    for (let attempt = 1; attempt <= plan.maxAttempts; attempt += 1) {
      if (!shouldRelaunch({ appRunning: false, attempts: attempt - 1 })) break;
      log(`relaunch attempt ${attempt}/${plan.maxAttempts}: ${parsed.appExe}`);
      try {
        const child = d.spawn(parsed.appExe, [], {
          detached: true,
          stdio: "ignore",
          cwd: dirname(parsed.appExe),
        });
        child?.unref?.();
      } catch (err) {
        log(`relaunch attempt ${attempt} failed to spawn: ${err?.message ?? err}`);
      }
      // Verify it started — poll the guard again (the honest "is it really
      // up" check, not just a spawn that didn't throw).
      const verifyDeadline = d.now() + plan.verifyMs;
      while (d.now() < verifyDeadline) {
        await d.sleep(GUARD_POLL_MS);
        if (await isAppRunning(parsed, d, log)) {
          relaunched = true;
          break;
        }
      }
      if (relaunched) {
        log(`relaunch verified on attempt ${attempt} — the app is running`);
        break;
      }
      log(`relaunch attempt ${attempt} not verified within ${plan.verifyMs}ms`);
      if (attempt < plan.maxAttempts) await d.sleep(plan.backoffMs);
    }

    // STEP 5 — THE NOTIFICATION (belt leg; only when THIS process brought
    // the app back AND the update genuinely landed — a "restarting" toast
    // over a failed install would be a lie).
    if (relaunched && installerSucceeded) {
      const note = buildNotificationCommand(d.platform(), parsed.version);
      log(`notifying: ${note.command} — "${note.text.title}" / "${note.text.body}"`);
      const code = await d.spawnAndWait(note.command, note.args, { stdio: "ignore" }, PROBE_TIMEOUT_MS);
      if (code === null) {
        log("the notification did not finish (or failed to spawn) — the app's own setup splash remains the primary UX");
      } else {
        log(`the notification finished with code ${code}`);
      }
      return 0;
    }
    if (!relaunched) {
      log(`the app did not come back within ${plan.maxAttempts} relaunch attempts — reopen it by hand`);
      return 1;
    }
    log("the app is back but the install did not confirm success — no completion toast (honest)");
    return 0;
  } catch (err) {
    log(`unexpected failure: ${err?.message ?? err}`);
    return 1;
  } finally {
    d.clearTimeout(bound);
  }
}

/** Wait for the app pid to exit (250ms poll, bounded); no pid → one 1500ms settle. */
async function waitForAppExit(parsed, d, log) {
  const pid = parsed.appPid;
  if (pid === null) {
    await d.sleep(NO_PID_SETTLE_MS);
    log(`no app pid supplied — settled ${NO_PID_SETTLE_MS}ms instead`);
    return true;
  }
  const deadline = d.now() + parsed.maxWaitSecs * 1000;
  while (d.now() < deadline) {
    if (!d.isProcessAlive(pid)) return true;
    await d.sleep(APP_EXIT_POLL_MS);
  }
  return false;
}

/** Watch mode's install-completion wait: the exe at the original path exists
 * (and, on Windows, opens lock-free) — every 500ms, bounded by max-wait. */
async function waitForExeReady(parsed, d, log) {
  const deadline = d.now() + parsed.maxWaitSecs * 1000;
  let lockFreeChecks = 0;
  while (d.now() < deadline) {
    const stat = d.stat(parsed.appExe);
    if (exeIsReady(parsed.appExe, stat)) {
      if (d.platform() !== "win32") return true;
      // Windows: the installer's last flush can still hold the freshly
      // written exe — an open-for-read that succeeds means lock-free.
      if (d.canOpenForRead(parsed.appExe)) return true;
      lockFreeChecks += 1;
    }
    await d.sleep(EXE_READY_POLL_MS);
  }
  if (lockFreeChecks > 0) log(`the exe existed but stayed locked for the whole budget (${lockFreeChecks} lock checks)`);
  return false;
}

/** Run mode's install leg: the installer /S (or the platform leg), waited on. */
async function runInstallerAndWait(parsed, d, log) {
  const cmd = buildInstallerCommand(d.platform(), parsed.installer);
  if (cmd.unsupported === true) {
    log(`the installer kind is unsupported by the supervisor run mode (${parsed.installer}) — skipping the install, still guaranteeing the restart`);
    return false;
  }
  if (cmd.needsChmod === true) {
    try {
      d.chmod(parsed.installer, 0o755);
      log("chmod +x applied to the staged installer");
    } catch (err) {
      log(`chmod +x failed (${err?.message ?? err}) — launching anyway`);
    }
  }
  log(`launching the installer: ${cmd.command} ${cmd.args.join(" ")}`);
  const code = await d.spawnAndWait(cmd.command, cmd.args, { detached: true, stdio: "ignore" }, parsed.maxWaitSecs * 1000);
  if (code === null) {
    log("the installer did not exit within the wait budget — treating the install as failed (the restart is still guaranteed)");
    return false;
  }
  log(`the installer exited with code ${code}`);
  return code === 0;
}

/** The guard, live: run the platform probe and parse it. A probe that cannot
 * run at all answers NOT running (the owner's incident was a dead app, not a
 * doubled one — the restart wins the tie; logged honestly). */
async function isAppRunning(parsed, d, log) {
  const cmd = buildGuardCommand(d.platform(), parsed.appExe);
  const result = await d.captureOutput(cmd.command, cmd.args);
  if (result === null) {
    log(`the guard probe could not run (${cmd.command} ${cmd.args.join(" ")}) — treating as not running`);
    return false;
  }
  return parseGuardOutput(d.platform(), parsed.appExe, result.stdout, result.code, d.selfPid());
}

// ── the CLI (guarded so importing the module never starts the loop) ────────

/** True only when this module is the entry script (process.argv[1] resolved
 * against the cwd, compared to this module's URL). */
function isCliInvocation() {
  try {
    const argv1 = process.argv[1];
    if (typeof argv1 !== "string" || argv1 === "") return false;
    return import.meta.url === pathToFileURL(resolve(argv1)).href;
  } catch {
    return false;
  }
}

async function main() {
  // NEVER a zombie, part two: an unexpected top-level failure logs + exits.
  process.on("uncaughtException", (err) => {
    try {
      console.error(`update-supervisor: uncaught ${err?.message ?? err}`);
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    try {
      console.error(`update-supervisor: unhandled rejection ${reason ?? reason}`);
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
  const parsed = parseSupervisorArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`update-supervisor: ${parsed.error}`);
    console.error(
      "usage: node update-supervisor.mjs --app-exe <path> --installer <path|none> --version <v> [--app-pid <pid>] [--mode watch|run] [--max-wait-secs 600] [--log <path>]",
    );
    process.exit(2);
  }
  const code = await runSupervisor(parsed.args, {});
  process.exit(code);
}

if (isCliInvocation()) {
  void main();
}
