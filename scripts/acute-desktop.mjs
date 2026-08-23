#!/usr/bin/env node
/**
 * ACUTE-CODE desktop runner (owner round-10 request): ONE double-clickable file
 * that keeps a local PC copy of ACUTE-CODE set up, up to date, and running.
 *
 *   ACUTE.bat / acute.sh   (repo root, copied into any folder) — bootstrap:
 *                          checks git+node, clones this private repo once
 *                          (credentials stored in the OS credential store),
 *                          then hands off to THIS script.
 *   scripts/acute-desktop.mjs — everything else:
 *     • toolchain check (node ≥ 20, git, pnpm via corepack — auto-installed
 *       at the exact version pinned in package.json "packageManager")
 *     • update check: fetch origin/main; if behind → stop live servers
 *       (ports 5173/5178) → pull (ff-only) → pnpm install → rebuild
 *     • first-run setup: install deps, build shared + agent-core,
 *       write .env.development (gitignored, persists), capture the
 *       OpenRouter key into Windows Credential Manager (prompted once,
 *       length-only confirmation) or read it from env/file on Linux
 *     • launch `pnpm dev:full` (sidecar 127.0.0.1:5178 + UI :5173) with the
 *       key injected; one Ctrl+C stops everything
 *     • ALWAYS shows clear progress; on failure prints a boxed error with the
 *       full captured output + log-file path and WAITS so the window stays
 *       open for copying (set ACUTE_RUNNER_NO_PAUSE=1 to skip the wait).
 *
 * Usage:  node scripts/acute-desktop.mjs [command] [flags]
 *   (default)  ensure up to date, then run        --no-update   skip update check
 *   start      run without the update pass        --verbose     stream all output
 *   update     ensure + update, then exit         --help
 *   status     versions, commit, ports, key, DB   (no side effects)
 *
 * Zero npm dependencies; Node ≥ 20; Windows / Linux / macOS.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";
const UI_PORT = 5173;
const SIDECAR_PORT = 5178;
const LOG_PATH = resolve(repoRoot, "acute-runner.log");
const ENV_PATH = resolve(repoRoot, ".env.development");
const KEY_FILE_LINUX = resolve(process.env.HOME ?? "~", ".acute", "openrouter.key");
const NO_PAUSE = process.env.ACUTE_RUNNER_NO_PAUSE === "1";
const VERBOSE = process.argv.includes("--verbose");

const startedAt = Date.now();
let stepNo = 0;

/* ── output helpers ─────────────────────────────────────────────────────── */

const line = (s = "") => process.stdout.write(`${s}\n`);
function banner() {
  line("");
  line("==========================================================");
  line("  ACUTE-CODE — local runner");
  line(`  ${new Date().toLocaleString()}  ·  ${IS_WIN ? "Windows" : process.platform}`);
  line("==========================================================");
}
function ok(s) { line(`  [OK]   ${s}`); }
function info(s) { line(`         ${s}`); }
function warn(s) { line(`  [WARN] ${s}`); }

/** Quote one token for a shell command string (paths with spaces stay safe). */
function q(s) {
  return IS_WIN ? `"${String(s).replaceAll('"', "")}"` : `'${String(s).replaceAll("'", `'\\''`)}'`;
}

function run(cmd, { allowFail = false } = {}) {
  const res = spawnSync(cmd, { shell: true, encoding: "utf8", cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (out.trim()) log(`$ ${cmd}\n${out.trim()}\n`);
  if (VERBOSE && out.trim()) line(out.replace(/\n/g, "\n         ").trimEnd());
  if (res.error) {
    if (allowFail) return { code: -1, out: String(res.error), failed: true };
    fail(`could not execute: ${cmd}`, String(res.error));
  }
  if (res.status !== 0 && !allowFail) fail(`command exited ${res.status}: ${cmd}`, out);
  return { code: res.status, out, failed: res.status !== 0 };
}

function log(s) {
  try {
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > 2 * 1024 * 1024) {
      renameSync(LOG_PATH, `${LOG_PATH}.old`);
    }
    appendFileSync(LOG_PATH, s.endsWith("\n") ? s : `${s}\n`);
  } catch { /* logging must never crash the runner */ }
}

/** A visible, copyable failure that keeps the window open. NEVER throws. */
function fail(step, detail) {
  line("");
  line("  ┌────────────────────────────────────────────────────────");
  line("  │  FAILED — " + step);
  line("  ├────────────────────────────────────────────────────────");
  for (const l of String(detail ?? "(no output)").trim().split("\n").slice(0, 80)) {
    line("  │  " + l.slice(0, 200));
  }
  line("  ├────────────────────────────────────────────────────────");
  line("  │  Full log: " + LOG_PATH);
  line("  │  Fix the issue above, then double-click the launcher again.");
  line("  └────────────────────────────────────────────────────────");
  log(`\n!!! FAILED — ${step}\n${detail ?? ""}\n`);
  waitForEnter().finally(() => process.exit(1));
}

/** Keep the window open so the error/summary can be copied (double-click UX). */
function waitForEnter(message = "  Press Enter to close this window…") {
  if (NO_PAUSE || !process.stdin.isTTY) return Promise.resolve();
  return new Promise((resolvePromise) => {
    process.stdout.write(message);
    const rl = createInterface({ input: process.stdin });
    rl.once("line", () => { rl.close(); resolvePromise(); });
  });
}

function step(name) {
  stepNo += 1;
  line("");
  line(`  ── [${stepNo}] ${name} ${"─".repeat(Math.max(2, 48 - name.length))}`);
}

/* ── port / process helpers ─────────────────────────────────────────────── */

/** PIDs listening on `port` (best effort, platform-specific). */
function pidsOnPort(port) {
  const pids = new Set();
  if (IS_WIN) {
    const res = spawnSync("netstat -ano -p tcp", { shell: true, encoding: "utf8" });
    for (const l of String(res.stdout ?? "").split("\n")) {
      const m = l.match(/\S*:(\d+)\s+\S+\s+\S*\s+LISTENING\s+(\d+)/i);
      if (m && Number(m[1]) === port) pids.add(m[2]);
    }
  } else {
    for (const probe of [`lsof -t -i :${port} 2>/dev/null`, `ss -ltnp 2>/dev/null | grep ':${port} '`]) {
      const res = spawnSync(probe, { shell: true, encoding: "utf8" });
      const text = String(res.stdout ?? "");
      if (text.trim()) {
        if (probe.startsWith("lsof")) text.trim().split("\n").forEach((p) => p.trim() && pids.add(p.trim()));
        else for (const m of text.matchAll(/pid=(\d+)/g)) pids.add(m[1]);
        break;
      }
    }
  }
  pids.delete(String(process.pid));
  return [...pids];
}

function stopLiveServers(reason) {
  const found = [];
  for (const port of [UI_PORT, SIDECAR_PORT]) {
    for (const pid of pidsOnPort(port)) found.push({ port, pid });
  }
  if (found.length === 0) return;
  info(`stopping live servers (${reason}): ${found.map((f) => `:${f.port} pid ${f.pid}`).join(", ")}`);
  for (const { pid } of found) {
    run(IS_WIN ? `taskkill /F /PID ${pid}` : `kill -9 ${pid} 2>/dev/null`, { allowFail: true });
  }
  // Give the OS a beat to release the ports.
  spawnSync(IS_WIN ? "ping -n 3 127.0.0.1 >nul" : "sleep 2", { shell: true });
  const left = [UI_PORT, SIDECAR_PORT].flatMap((p) => pidsOnPort(p));
  if (left.length) warn(`ports still busy after stop attempt: ${left.join(", ")} — continuing anyway`);
}

/* ── steps ──────────────────────────────────────────────────────────────── */

function checkToolchain() {
  step("Toolchain check");
  const node = run("node --version", { allowFail: true });
  if (node.failed) {
    fail("Node.js is not installed (or not on PATH)",
      "Install Node.js 20 or newer (24 recommended): https://nodejs.org\n" +
      (IS_WIN ? "Or from a terminal:  winget install OpenJS.NodeJS.LTS\n" : "e.g. Ubuntu/Debian:  sudo apt install nodejs\n") +
      "Then run the launcher again.");
  }
  const nodeMajor = Number((node.out.match(/v(\d+)/) ?? [])[1] ?? 0);
  ok(`node ${node.out.trim()}`);
  if (nodeMajor < 20) {
    fail("Node.js is too old",
      `Found ${node.out.trim()} — ACUTE-CODE needs Node 20+ (24 recommended).\nUpgrade from https://nodejs.org, then run the launcher again.`);
  }

  if (run("git --version", { allowFail: true }).failed) {
    fail("git is not installed (or not on PATH)",
      "Install git: https://git-scm.com/downloads" + (IS_WIN ? "\nOr:  winget install Git.Git" : ""));
  }
  ok("git present");

  // pnpm via corepack (bundled with node ≥ 16.10): exact version is pinned by
  // package.json "packageManager" — no global npm install, no admin rights.
  const corepack = run("corepack --version", { allowFail: true });
  if (corepack.failed) {
    fail("corepack is missing",
      "corepack ships with Node.js 20+ — your Node installation looks incomplete.\nReinstall Node.js from https://nodejs.org.");
  }
  run("corepack enable", { allowFail: true }); // best effort: puts `pnpm` on PATH for this machine
  const pnpmEnv = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
  const probe = spawnSync("pnpm --version", { shell: true, encoding: "utf8", env: pnpmEnv });
  if (probe.status !== 0) {
    // corepack enable can fail on locked-down machines; a per-user shim dir still works.
    const binDir = resolve(repoRoot, ".runner-bin");
    mkdirSync(binDir, { recursive: true });
    run(`corepack enable --install-directory ${q(binDir)}`, { allowFail: true });
    process.env.PATH = `${binDir}${IS_WIN ? ";" : ":"}${process.env.PATH ?? ""}`;
    const retry = spawnSync("pnpm --version", { shell: true, encoding: "utf8", env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" } });
    if (retry.status !== 0) {
      fail("pnpm could not be activated via corepack",
        `corepack: ${corepack.out.trim()}\npnpm probe output: ${retry.stdout ?? ""}${retry.stderr ?? ""}`);
    }
  }
  ok(`pnpm ${String(spawnSync("pnpm --version", { shell: true, encoding: "utf8", env: pnpmEnv }).stdout ?? "").trim()} (via corepack)`);
}

function gitState() {
  const head = run("git rev-parse --short HEAD", { allowFail: true });
  if (head.failed) return { head: null, behind: 0, dirty: true };
  const dirty = run("git status --porcelain", { allowFail: true }).out.trim().length > 0;
  const fetch = run("git fetch origin main", { allowFail: true });
  if (fetch.failed) return { head: head.out.trim(), behind: -1, dirty }; // -1 = offline/unreachable
  const behind = Number(run("git rev-list --count HEAD..origin/main", { allowFail: true }).out.trim() || "0");
  return { head: head.out.trim(), behind, dirty };
}

function updatePass(didUpdateRef) {
  step("Update check (github.com/testplay-byte/ACUTE-CODE)");
  const state = gitState();
  if (state.head === null) fail("not a git repository — re-clone with ACUTE.bat / acute.sh", "");
  if (state.behind === -1) {
    warn("could not reach GitHub (offline?) — continuing with the local version");
    return;
  }
  if (state.dirty) {
    warn("local changes detected in the repo folder — update skipped to avoid overwriting them");
    info(`commit or revert them, or re-clone; currently on ${state.head}`);
    return;
  }
  if (state.behind === 0) {
    ok(`already up to date (${state.head})`);
    return;
  }
  info(`${state.behind} new commit(s) on GitHub — updating…`);
  stopLiveServers("update");
  run(`git pull --ff-only origin main`);
  ok(`updated to ${run("git rev-parse --short HEAD").out.trim()}`);
  installDeps();
  buildWorkspace();
  didUpdateRef.did = true;
}

function installDeps() {
  step("Install dependencies (pnpm)");
  info("first run can take a few minutes — later runs are quick");
  run("pnpm install");
  ok("dependencies ready");
}

function buildWorkspace() {
  step("Build agent-core + shared");
  run("pnpm --filter shared run build");
  run("pnpm --filter agent-core run build");
  ok("backend build ready");
}

function ensureEnvFile() {
  step("Browser wiring (.env.development)");
  if (existsSync(ENV_PATH)) {
    ok(`${ENV_PATH} exists (kept as-is)`);
    return;
  }
  writeFileSync(ENV_PATH, [
    "# Written by scripts/acute-desktop.mjs — gitignored, persists across updates.",
    "VITE_ACUTE_BASE_URL=http://127.0.0.1:5178",
    "VITE_ACUTE_TOKEN=acute-dev-local",
    "",
  ].join("\n"));
  ok(`wrote ${dirname(ENV_PATH)}${IS_WIN ? "\\" : "/"}.env.development`);
}

/** Readline prompt (visible input — warned) used for first-run secrets. */
function prompt(question) {
  return new Promise((resolvePrompt) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolvePrompt(answer); });
  });
}

function readKeyFromCredentialManager() {
  const res = spawnSync(
    "powershell -NoProfile -File " + q(resolve(repoRoot, "scripts", "credential.ps1")) + " Read ACUTE-CODE/provider/openrouter",
    { shell: true, encoding: "utf8" },
  );
  const out = String(res.stdout ?? "").trim();
  return res.status === 0 && out && !out.startsWith("credential not found") ? out : "";
}

function storeKeyInCredentialManager(value) {
  const cmd = "powershell -NoProfile -File " +
    q(resolve(repoRoot, "scripts", "credential.ps1")) +
    ' Write ACUTE-CODE/provider/openrouter api-key "' + value.replaceAll('"', "") + '"';
  return run(cmd, { allowFail: true }).failed === false;
}

async function ensureProviderKey() {
  step("OpenRouter API key");
  if (IS_WIN) {
    let key = readKeyFromCredentialManager();
    if (key) { ok(`key present in Windows Credential Manager (length ${key.length})`); return {}; }
    warn("no key stored yet — needed for live model calls (catalog, chats)");
    if (process.stdin.isTTY) {
      const answer = await prompt("  Store your OpenRouter key now? [y/N] ");
      if (answer.trim().toLowerCase() === "y") {
        const value = await prompt("  Paste OpenRouter key (sk-or-…, input visible here): ");
        if (value.trim() && storeKeyInCredentialManager(value.trim())) {
          ok(`key stored in Windows Credential Manager (length ${value.trim().length})`);
          return {};
        }
        warn("storing failed — see " + LOG_PATH + " ; dev.mjs will warn at startup until a key is stored");
      } else {
        info("skipped — you can store it later: powershell -File scripts\\credential.ps1 Write \"ACUTE-CODE/provider/openrouter\" \"api-key\" \"<key>\"");
      }
    }
    return {};
  }
  // Linux/macOS: env passthrough wins, then the 0600 key file.
  if (process.env.ACUTE_PROVIDER_OPENROUTER) {
    ok(`key from ACUTE_PROVIDER_OPENROUTER env (length ${process.env.ACUTE_PROVIDER_OPENROUTER.length})`);
    return {};
  }
  if (existsSync(KEY_FILE_LINUX)) {
    const key = readFileSync(KEY_FILE_LINUX, "utf8").trim();
    if (key) {
      ok(`key from ${KEY_FILE_LINUX} (length ${key.length})`);
      return { ACUTE_PROVIDER_OPENROUTER: key };
    }
  }
  warn(`no key found — set ACUTE_PROVIDER_OPENROUTER or create ${KEY_FILE_LINUX} (chmod 600)`);
  info("without a key the app still runs; model catalog and live chats will fail");
  return {};
}

function preflightPorts() {
  step("Port pre-flight (:5173 UI, :5178 sidecar)");
  const busy = [UI_PORT, SIDECAR_PORT].flatMap((p) => pidsOnPort(p));
  if (busy.length === 0) { ok("ports free"); return; }
  warn(`ports busy from a previous run — restarting them (${busy.join(", ")})`);
  stopLiveServers("pre-flight");
  ok("ports cleared");
}

function launch(extraEnv) {
  step("Launch ACUTE-CODE (sidecar :5178 + UI :5173)");
  const env = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", ...extraEnv };
  line("");
  line("  ────────────────────────────────────────────────────────");
  line("  Everything is up. The app is starting now.");
  line("  ➜ Open http://localhost:5173  (the browser does NOT open");
  line("    by itself — nothing auto-launches without your click)");
  line("  ➜ Keep this window open while using the app.");
  line("  ➜ Press Ctrl+C here to stop both servers cleanly.");
  line("  ────────────────────────────────────────────────────────");
  line("");
  log(`\n=== launch ${new Date().toISOString()} ===\n`);
  const child = spawn("pnpm dev:full", { shell: true, stdio: "inherit", cwd: repoRoot, env });
  const forward = (sig) => () => { try { child.kill(sig); } catch { /* already gone */ } };
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  child.on("error", (err) => fail("could not start pnpm dev:full", String(err)));
  child.on("close", (code) => {
    if (code === 0 || code === null) {
      line("");
      ok(`stopped cleanly (total session ${Math.round((Date.now() - startedAt) / 1000)}s)`);
      waitForEnter().finally(() => process.exit(0));
    } else {
      fail(`dev:full exited with code ${code}`,
        "Common causes: port already in use, missing OpenRouter key, or a build step failed.\nFull server output is above; the runner log has everything: " + LOG_PATH);
    }
  });
}

/* ── modes ──────────────────────────────────────────────────────────────── */

function modeStatus() {
  const nodeV = run("node --version", { allowFail: true }).out.trim() || "missing";
  const gitV = run("git --version", { allowFail: true }).out.trim() || "missing";
  const pnpmV = run("pnpm --version", { allowFail: true }).out.trim() || "missing";
  const state = gitState();
  line("");
  line("  node    : " + nodeV);
  line("  git     : " + gitV);
  line("  pnpm    : " + pnpmV);
  line("  commit  : " + (state.head ?? "?") + (state.behind === 0 ? " (up to date)" : state.behind > 0 ? ` (${state.behind} behind origin/main)` : " (GitHub unreachable)"));
  line("  worktree: " + (state.dirty ? "dirty" : "clean"));
  line("  UI :5173      : " + (pidsOnPort(UI_PORT).length ? "BUSY (running)" : "free"));
  line("  sidecar :5178 : " + (pidsOnPort(SIDECAR_PORT).length ? "BUSY (running)" : "free"));
  line("  dev DB  : " + (existsSync(resolve(repoRoot, ".dev", "acute.db")) ? "present (.dev/acute.db — agents/sessions/projects persist here)" : "not created yet"));
  line("  key     : " + (IS_WIN
    ? (readKeyFromCredentialManager() ? "stored in Windows Credential Manager" : "NOT stored")
    : (process.env.ACUTE_PROVIDER_OPENROUTER || existsSync(KEY_FILE_LINUX) ? "available (env or key file)" : "NOT set")));
  line("  log     : " + LOG_PATH);
  line("");
}

async function main() {
  banner();
  log(`\n===== runner start ${new Date().toISOString()} (argv: ${process.argv.slice(2).join(" ")}) =====`);

  const cmd = process.argv.slice(2).find((a) => !a.startsWith("-")) ?? "run";

  if (cmd === "status") { modeStatus(); return; }

  const wantUpdate = cmd !== "start" && !process.argv.includes("--no-update");

  checkToolchain();

  let updated = { did: false };
  if (wantUpdate) {
    const freshClone = !existsSync(resolve(repoRoot, "node_modules"));
    if (freshClone) {
      step("First-run setup detected (no node_modules)");
      info("cloning is done by the launcher; installing everything now");
    }
    updatePass(updated);
  } else {
    step("Update check skipped (--no-update / start)");
  }

  if (!existsSync(resolve(repoRoot, "node_modules"))) installDeps();

  if (updated.did || !existsSync(resolve(repoRoot, "agent-core", "dist", "main.js"))) {
    buildWorkspace();
  } else {
    step("Build agent-core + shared");
    ok("backend build present (no update since last build)");
  }

  ensureEnvFile();
  const keyEnv = await ensureProviderKey();

  if (cmd !== "update") {
    preflightPorts();
    launch(keyEnv);
  } else {
    line("");
    ok(`update pass complete (${Math.round((Date.now() - startedAt) / 1000)}s) — everything ready`);
    info(`run ACUTE.bat / acute.sh again (or: node scripts/acute-desktop.mjs start) to launch`);
    await waitForEnter("  Press Enter to close…");
  }
}

process.on("uncaughtException", (err) => fail("unexpected runner error", err?.stack ?? String(err)));
main().catch((err) => fail("unexpected runner error", err?.stack ?? String(err)));
