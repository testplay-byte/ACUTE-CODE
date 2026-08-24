#!/usr/bin/env node
// scripts/docs/stamp-all.mjs
//
// Round-28 WS-J1 / J2 backfill: bulk-add the
// `<!-- last-reviewed: YYYY-MM-DD round-NN -->` stamp to every doc that is
// missing it. Referenced by DOC-STANDARDS §8. Idempotent: re-running it only
// stamps docs that lack the stamp on line 1; already-stamped docs are left
// untouched. Skip list mirrors check-stale.mjs (generated docs are not
// hand-stamped).
//
// Usage: node scripts/docs/stamp-all.mjs
//        node scripts/docs/stamp-all.mjs --dry-run    # print plan, write nothing
//
// The date is today (UTC) and the round is read from docs/status.json
// (`round` field), defaulting to 28.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")).replace(/scripts\/docs$/, ""), "");
const DOCS_DIR = join(ROOT, "docs");

const STAMP_RE = /<!--\s*last-reviewed:\s*\d{4}-\d{2}-\d{2}\s*(?:round-\d+)?\s*-->/;

// Read current round from status.json (mirrors check-stale.mjs).
let currentRound = 28;
try {
  const status = JSON.parse(readFileSync(join(DOCS_DIR, "status.json"), "utf8"));
  if (status.round) currentRound = status.round;
} catch { /* status.json may not exist on a fresh repo */ }

const today = new Date().toISOString().slice(0, 10);
const stampLine = `<!-- last-reviewed: ${today} round-${currentRound} -->`;

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

const dryRun = process.argv.includes("--dry-run");
let stamped = 0;
let already = 0;
let skipped = 0;

for (const doc of docs) {
  const rel = relative(ROOT, doc);
  // Skip generated docs (parity with check-stale.mjs).
  if (rel.includes("compliance/") || rel.endsWith("ORCHESTRATION-WORKLOG.md")) {
    skipped++;
    continue;
  }
  const content = readFileSync(doc, "utf8");
  // Idempotent: if the stamp appears anywhere in the doc, leave it alone
  // (an existing stamp on a non-first line is a check-stale concern, not a
  // stamp-all concern — we only add, never move).
  if (STAMP_RE.test(content)) {
    already++;
    continue;
  }
  const newContent = `${stampLine}\n${content.replace(/^\n+/, "")}`;
  if (dryRun) {
    console.log(`STAMP (dry)  ${rel}`);
  } else {
    writeFileSync(doc, newContent, "utf8");
    console.log(`STAMP        ${rel}`);
  }
  stamped++;
}

console.log(
  `\nstamp-all — ${docs.length} docs scanned, ${stamped} stamped (round-${currentRound}, ${today}), ${already} already-stamped, ${skipped} generated/skipped${dryRun ? " [DRY RUN]" : ""}`,
);
