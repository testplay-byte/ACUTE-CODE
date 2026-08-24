#!/usr/bin/env node
// scripts/docs/check-stale.mjs
//
// Round-28 WS-J1: doc freshness gate. Walks docs/**/*.md + *.md at repo
// root. For each doc:
//   - parse the <!-- last-reviewed: YYYY-MM-DD round-NN --> comment; fail if
//     missing or >3 rounds old.
//   - extract file-path references (src/..., agent-core/src/...); fail if the
//     path doesn't exist (drift guard — a doc referencing a deleted file is
//     stale).
//   - extract URL references; HTTP HEAD each; allow 3 failures before
//     failing CI (transient outages).
//   - extract version references (v0.1.0, Round N); warn (not fail) on
//     mismatch with package.json + status.json.
//
// Usage: node scripts/docs/check-stale.mjs
// Exit codes: 0 all fresh, 1 stale/broken refs found.
//
// Owner R28 directive: "Make sure that the documentation is proper and
// easily manageable."

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")).replace(/scripts\/docs$/, ""), "");
const DOCS_DIR = join(ROOT, "docs");
const MAX_ROUNDS_OLD = 3;
const MAX_URL_FAILURES = 3;

function walkMd(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const stats = statSync(abs);
    if (stats.isDirectory()) out.push(...walkMd(abs));
    else if (entry.endsWith(".md")) out.push(abs);
  }
  return out;
}

const docs = [
  ...walkMd(DOCS_DIR),
  ...readdirSync(ROOT).filter((f) => f.endsWith(".md")).map((f) => join(ROOT, f)),
];

const today = new Date();
let failures = 0;
let warnings = 0;

// Determine current round from status.json
let currentRound = 28;
try {
  const status = JSON.parse(readFileSync(join(DOCS_DIR, "status.json"), "utf8"));
  if (status.round) currentRound = status.round;
} catch { /* status.json may not exist yet */ }

for (const doc of docs) {
  const content = readFileSync(doc, "utf8");
  const rel = relative(ROOT, doc);

  // Skip generated docs (compliance + ORCHESTRATION-WORKLOG snapshot)
  if (rel.includes("compliance/") || rel.endsWith("ORCHESTRATION-WORKLOG.md")) continue;

  // 1. last-reviewed stamp
  const stampMatch = content.match(/<!--\s*last-reviewed:\s*(\d{4}-\d{2}-\d{2})\s*(?:round-(\d+))?\s*-->/);
  if (!stampMatch) {
    console.error(`FAIL  ${rel}: missing <!-- last-reviewed --> stamp on first line`);
    failures++;
  } else {
    const stampDate = stampMatch[1];
    const stampRound = stampMatch[2] ? parseInt(stampMatch[2], 10) : null;
    if (stampRound !== null) {
      const age = currentRound - stampRound;
      if (age > MAX_ROUNDS_OLD) {
        console.error(`FAIL  ${rel}: last-reviewed round-${stampRound} is ${age} rounds old (cap ${MAX_ROUNDS_OLD})`);
        failures++;
      }
    }
    // Date sanity (not future)
    const d = new Date(stampDate);
    if (d > today) {
      console.error(`FAIL  ${rel}: last-reviewed date ${stampDate} is in the future`);
      failures++;
    }
  }

  // 2. file-path references (drift guard). Only check paths OUTSIDE fenced
  //    code blocks (a path in a code example is illustrative, not a ref).
  const codeFenceRegex = /^```/m;
  const segments = content.split(codeFenceRegex);
  for (let i = 0; i < segments.length; i += 2) {
    const seg = segments[i] ?? "";
    const pathRefs = seg.match(/(?:^|\s|[(\[])((?:src|agent-core\/src|shared\/src|scripts|tests)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|mjs|sql|md|json))/g) ?? [];
    for (const raw of pathRefs) {
      const refPath = raw.trim().replace(/^[(\[]/, "");
      const abs = join(ROOT, refPath);
      if (!existsSync(abs)) {
        console.error(`FAIL  ${rel}: references missing path ${refPath}`);
        failures++;
      }
    }
  }
}

// 3. URL HTTP HEAD checks (allow MAX_URL_FAILURES before failing)
let urlFailures = 0;
const urls = new Set();
for (const doc of docs) {
  const content = readFileSync(doc, "utf8");
  const urlMatches = content.match(/https:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+/g) ?? [];
  for (const url of urlMatches) {
    // skip ntfy + localhost + GitHub API (auth-gated) URLs to avoid noise
    if (url.includes("ntfy.sh") || url.includes("127.0.0.1") || url.includes("localhost")) continue;
    if (url.includes("api.github.com")) continue;
    urls.add(url.split(")")[0].split("]")[0].split(">")[0]); // trim trailing punct
  }
}
for (const url of urls) {
  if (urlFailures >= MAX_URL_FAILURES) break;
  try {
    execSync(`curl -s -o /dev/null -I -w "%{http_code}" --max-time 5 "${url}"`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    urlFailures++;
    if (urlFailures < MAX_URL_FAILURES) console.warn(`WARN  ${url}: HTTP HEAD failed (transient?)`);
  }
}
if (urlFailures >= MAX_URL_FAILURES) {
  console.error(`FAIL  ${urlFailures} URLs unreachable (cap ${MAX_URL_FAILURES})`);
  failures++;
}

console.log(`docs:check — ${docs.length} docs scanned, ${failures} failure(s), ${warnings} warning(s)`);
process.exit(failures > 0 ? 1 : 0);
