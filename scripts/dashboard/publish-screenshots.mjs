#!/usr/bin/env node
// scripts/dashboard/publish-screenshots.mjs
//
// Workstream K1 (Round 28 master plan): publish a round's screenshot zip to the
// PUBLIC DASHBOARD repo (testplay-byte/DASHBOARD on GitHub Pages), not the
// private ACUTE-CODE repo.
//
// Usage:
//   node scripts/dashboard/publish-screenshots.mjs <round> [zip-path]
//
//   <round>      round number (e.g. 27, 28)
//   [zip-path]   optional path to the zip; defaults to
//                <ACUTE-CODE-root>/round-<NN>-testing-screenshots.zip
//
// What it does (in order):
//   1. resolve + validate the source zip (exists, is a zip via `unzip -t`)
//   2. ensure DASHBOARD/screenshots/ exists
//   3. copy zip → DASHBOARD/screenshots/round-<NN>.zip (overwrite if present)
//   4. update DASHBOARD/screenshots/index.json (upsert the round entry)
//   5. update DASHBOARD/data.json `screenshots` section (upsert)
//   6. git add + commit + push to DASHBOARD main, using the dashboard PAT
//      via token-in-URL (lesson #24), remote sanitized to tokenless after push
//
// Secrets: the dashboard PAT is read from /home/z/.secrets/github-dashboard.pat
// (0600, outside any repo). It NEVER appears in the commit, the index.json,
// logs, or stdout. Only its length is printed (lesson #14).
//
// Exit codes: 0 success, 1 any step failed.

import { execSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ACUTE_ROOT = resolve(dirname(__filename), "..", "..");
const DASHBOARD_ROOT = "/home/z/PROJECT/DASHBOARD";
const DASHBOARD_REMOTE = "https://github.com/testplay-byte/DASHBOARD";
const PAT_FILE = "/home/z/.secrets/github-dashboard.pat";
const SCREENSHOTS_DIR = join(DASHBOARD_ROOT, "screenshots");
const INDEX_JSON = join(SCREENSHOTS_DIR, "index.json");
const DATA_JSON = join(DASHBOARD_ROOT, "data.json");

function fail(msg) {
  console.error(`publish-screenshots: ${msg}`);
  process.exit(1);
}

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts });
}

function zipEntryCount(zipPath) {
  // `unzip -l` lists entries; count non-header/non-footer lines.
  const out = run(`unzip -l ${JSON.stringify(zipPath)}`);
  const lines = out.split("\n");
  // The summary line looks like: "  19 files  ..." — pull the file count from it.
  const summary = lines.find((l) => /\d+\s+files?/i.test(l));
  if (summary) {
    const m = summary.match(/(\d+)\s+files?/i);
    if (m) return parseInt(m[1], 10);
  }
  // Fallback: count entries between the header (---- lines) and footer.
  const start = lines.findIndex((l) => /^----/.test(l));
  const end = lines.slice(start + 1).findIndex((l) => /^----/.test(l));
  return end > 0 ? end : 0;
}

// ── arg parse ────────────────────────────────────────────────────────────
const roundArg = process.argv[2];
const zipArg = process.argv[3];
if (!roundArg || !/^\d+$/.test(roundArg)) {
  fail("usage: publish-screenshots.mjs <round> [zip-path]");
}
const round = parseInt(roundArg, 10);
const zipPath = resolve(zipArg || join(ACUTE_ROOT, `round-${round}-testing-screenshots.zip`));

if (!existsSync(zipPath)) fail(`source zip not found: ${zipPath}`);
const zipSize = statSync(zipPath).size;
if (zipSize > 50 * 1024 * 1024) fail(`zip too large (${(zipSize / 1024 / 1024).toFixed(1)} MB); cap is 50 MB (R-K2)`);
// validate integrity
const testOut = spawnSync("unzip", ["-t", zipPath], { encoding: "utf8" });
if (testOut.status !== 0) fail(`zip integrity check failed (unzip -t): ${testOut.stderr || testOut.stdout}`);
const screenshotCount = zipEntryCount(zipPath);
console.log(`publish-screenshots: round ${round} zip ${(zipSize / 1024).toFixed(0)} KB, ${screenshotCount} entries`);

// ── ensure target dir ────────────────────────────────────────────────────
mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// ── copy zip ──────────────────────────────────────────────────────────────
const destZip = join(SCREENSHOTS_DIR, `round-${round}.zip`);
cpSync(zipPath, destZip);
console.log(`  copied → ${destZip}`);

// ── upsert screenshots/index.json ─────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10);
let indexData = { rounds: [] };
if (existsSync(INDEX_JSON)) {
  try { indexData = JSON.parse(readFileSync(INDEX_JSON, "utf8")); } catch { /* reset on corrupt */ }
}
if (!Array.isArray(indexData.rounds)) indexData.rounds = [];
const existing = indexData.rounds.find((r) => r.round === round);
const entry = {
  round,
  date: today,
  zip: `round-${round}.zip`,
  size_bytes: zipSize,
  screenshots: screenshotCount,
  ...(existing?.description ? { description: existing.description } : {}),
};
indexData.rounds = [...indexData.rounds.filter((r) => r.round !== round), entry].sort((a, b) => a.round - b.round);
writeFileSync(INDEX_JSON, JSON.stringify(indexData, null, 2) + "\n", "utf8");
console.log(`  updated  ${INDEX_JSON.replace(DASHBOARD_ROOT + "/", "")} (${indexData.rounds.length} rounds)`);

// ── upsert data.json screenshots section ──────────────────────────────────
const dataRaw = readFileSync(DATA_JSON, "utf8");
const data = JSON.parse(dataRaw);
if (!data.screenshots) data.screenshots = { rounds: [] };
if (!Array.isArray(data.screenshots.rounds)) data.screenshots.rounds = [];
data.screenshots.rounds = [
  ...data.screenshots.rounds.filter((r) => r.round !== round),
  { round, date: today, url: `screenshots/round-${round}.zip`, count: screenshotCount, size_kb: Math.round(zipSize / 1024) },
].sort((a, b) => a.round - b.round);
// total screenshot count across all rounds (for the dashboard hero stat)
data.screenshots.total = data.screenshots.rounds.reduce((s, r) => s + (r.count || 0), 0);
writeFileSync(DATA_JSON, JSON.stringify(data, null, 2) + "\n", "utf8");
console.log(`  updated  data.json screenshots section (total ${data.screenshots.total} screenshots)`);

// ── git commit + push to DASHBOARD (token-in-URL, sanitized after) ───────
const pat = readFileSync(PAT_FILE, "utf8").trim();
if (!pat) fail("dashboard PAT is empty (check /home/z/.secrets/github-dashboard.pat)");
console.log(`  pat      length ${pat.length} (value never printed)`);

const tokenRemote = `https://testplay-byte:${pat}@github.com/testplay-byte/DASHBOARD`;
run(`git -C ${DASHBOARD_ROOT} add screenshots/ data.json`);
const status = run(`git -C ${DASHBOARD_ROOT} status --porcelain`).trim();
if (!status) {
  console.log(`  no changes to commit (round ${round} already current)`);
} else {
  run(`git -C ${DASHBOARD_ROOT} commit -m "Round ${round} screenshots: publish zip (${screenshotCount} files, ${(zipSize / 1024).toFixed(0)} KB)"`, {
    env: { ...process.env, GIT_AUTHOR_NAME: "acute-orchestrator", GIT_AUTHOR_EMAIL: "bot@acute.local", GIT_COMMITTER_NAME: "acute-orchestrator", GIT_COMMITTER_EMAIL: "bot@acute.local" },
  });
}
// push with token-in-URL (lesson #24), then sanitize remote to tokenless
run(`git -C ${DASHBOARD_ROOT} remote set-url origin ${tokenRemote}`);
try {
  const pushOut = run(`git -C ${DASHBOARD_ROOT} push origin main 2>&1`);
  console.log(`  pushed   ${pushOut.split("\n").filter(Boolean).pop() || "ok"}`);
} catch (e) {
  // always sanitize remote, even on failure
  run(`git -C ${DASHBOARD_ROOT} remote set-url origin ${DASHBOARD_REMOTE}`);
  fail(`git push failed: ${e.message}`);
}
run(`git -C ${DASHBOARD_ROOT} remote set-url origin ${DASHBOARD_REMOTE}`);
console.log(`  remote   sanitized to tokenless`);
console.log(`publish-screenshots: round ${round} DONE`);
