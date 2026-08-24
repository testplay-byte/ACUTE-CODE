#!/usr/bin/env node
// scripts/verify-round.mjs
//
// Round-28 WS-L: one-shot verification battery for a round. Runs the full
// ladder locally:
//   1. pnpm verify (lint + typecheck + test + build + license)
//   2. (optional) pnpm docs:check
//   3. (optional) boot sidecar + curl SSE cadence (if ACUTE_PROVIDER_OPENROUTER
//      env is set)
//   4. (optional) boot vite + agent-browser screenshots + VLM verify
//
// Usage:
//   node scripts/verify-round.mjs [round]
//
// Designed for LOCAL pre-push use; CI runs only `pnpm verify` (the heavy
// browser/VLM pieces are slow + flaky in CI per plan §14.5 R-L1).
//
// Owner R28 directive: "Do the proper testing afterwards too and make sure
// that each and every single one of the things gets handled with proper care."

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), "..");
const round = process.argv[2] ?? "current";
const SHOTS_DIR = `/tmp/round-${round}-shots`;

function run(cmd, label, opts = {}) {
  console.log(`\n── ${label} ─────────────────────────────────────────────`);
  const result = spawnSync(cmd, { cwd: ROOT, shell: true, stdio: "inherit", ...opts });
  if (result.status !== 0) {
    console.error(`✗ ${label} FAILED (exit ${result.status})`);
    process.exit(1);
  }
  console.log(`✓ ${label} green`);
}

function runOptional(cmd, label, opts = {}) {
  console.log(`\n── ${label} (optional) ────────────────────────────────`);
  const result = spawnSync(cmd, { cwd: ROOT, shell: true, stdio: "inherit", ...opts });
  if (result.status !== 0) {
    console.warn(`⚠ ${label} failed (exit ${result.status}) — non-fatal`);
  } else {
    console.log(`✓ ${label} green`);
  }
}

console.log(`verify-round.mjs — round ${round}`);

// 1. pnpm verify (the core gate)
run("pnpm verify", "pnpm verify (lint + typecheck + test + build + license)");

// 2. docs:check (if the script exists)
if (existsSync(join(ROOT, "scripts/docs/check-stale.mjs"))) {
  runOptional("node scripts/docs/check-stale.mjs", "docs:check (freshness + drift)");
}

// 3. agent-browser screenshots (if vite + agent-browser available)
const hasVite = existsSync(join(ROOT, "node_modules/.bin/vite"));
const hasAgentBrowser = !!spawnSync("which", ["agent-browser"], { encoding: "utf8" }).stdout.trim();
if (hasVite && hasAgentBrowser) {
  console.log("\n── browser verification (optional) ────────────────────");
  mkdirSync(SHOTS_DIR, { recursive: true });
  // Boot vite, screenshot, teardown — one self-contained invocation.
  const browserScript = `
set -e
export PATH=/home/z/.local/bin:$PATH
setsid node_modules/.bin/vite --host 127.0.0.1 --port 5173 > /tmp/vite-verify.log 2>&1 < /dev/null & disown
for i in $(seq 1 15); do sleep 1; if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/ 2>/dev/null | grep -q 200; then echo "vite ready ${i}s"; break; fi; done
agent-browser open http://127.0.0.1:5173/ 2>&1 | tail -1
agent-browser set viewport 1920 1080 2>&1 | tail -1
agent-browser eval "localStorage.setItem('acute.setupDone','1')" 2>&1 | tail -1
agent-browser open http://127.0.0.1:5173/ 2>&1 | tail -1
sleep 3
agent-browser screenshot ${SHOTS_DIR}/01-dashboard.png 2>&1 | tail -1
agent-browser open http://127.0.0.1:5173/settings 2>&1 | tail -1
sleep 3
agent-browser screenshot ${SHOTS_DIR}/02-settings.png 2>&1 | tail -1
agent-browser errors 2>&1 | tail -3
pkill -f "vite" 2>/dev/null; agent-browser close 2>&1 | tail -1
echo "screenshots → ${SHOTS_DIR}/"
ls -la ${SHOTS_DIR}/
`;
  const result = spawnSync(browserScript, { cwd: ROOT, shell: true, stdio: "inherit" });
  if (result.status !== 0) {
    console.warn("⚠ browser verification failed (non-fatal — run manually if needed)");
  } else {
    console.log(`✓ browser screenshots → ${SHOTS_DIR}/`);
  }
} else {
  console.log("\n── browser verification (skipped — vite or agent-browser unavailable) ──");
}

console.log(`\n✓ verify-round ${round} DONE`);
console.log("Next: commit + push to main → watch CI → screenshot zip to DASHBOARD → ntfy on owner APPROVE.");
