#!/usr/bin/env node
// scripts/release/version.mjs
//
// ROUND-45 (packaging v1): version single-sourcing. The version lives in FOUR
// places (root package.json, agent-core/package.json, shared/package.json,
// src-tauri/tauri.conf.json) and nothing kept them in lockstep — a drifted
// tauri.conf.json silently shipped a mislabeled desktop shell. This script is
// the one command that reads/writes them together (stdlib only).
//
// Usage:
//   node scripts/release/version.mjs get            # print the current version
//   node scripts/release/version.mjs check          # exit 0 if all four agree, else 1 + fix hint
//   node scripts/release/version.mjs set <semver>   # write <semver> to all four files
//
// Wire-up (root package.json): `pnpm version:get` / `version:check` /
// `version:set`. CI runs `pnpm version:check` right after install; the release
// workflow runs it before assembling the launcher kit.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The four files that must agree. tauri.conf.json is JSON too, but it is
 *  edited LINE-WISE so the diff only ever touches the version value (Tauri
 *  configs are hand-shaped; a full re-serialize would churn unrelated keys). */
const VERSION_FILES = [
  { rel: "package.json", label: "root package.json", kind: "json" },
  { rel: "agent-core/package.json", label: "agent-core/package.json", kind: "json" },
  { rel: "shared/package.json", label: "shared/package.json", kind: "json" },
  { rel: "src-tauri/tauri.conf.json", label: "src-tauri/tauri.conf.json", kind: "tauri" },
];

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function readVersion(file) {
  if (file.kind === "tauri") {
    const text = readFileSync(join(ROOT, file.rel), "utf8");
    const match = text.match(/"version"\s*:\s*"([^"]+)"/);
    if (!match) {
      throw new Error(`${file.rel}: no "version" field found`);
    }
    return match[1];
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, file.rel), "utf8"));
  if (typeof pkg.version !== "string") {
    throw new Error(`${file.rel}: no "version" field found`);
  }
  return pkg.version;
}

/** Root package.json is the source of truth ("get" reads it, "check" compares
 *  everything against it, "set" fixes the stragglers to match it). */
function currentVersion() {
  return readVersion(VERSION_FILES[0]);
}

function getCmd() {
  console.log(currentVersion());
}

function checkCmd() {
  const expected = currentVersion();
  const rows = VERSION_FILES.map((file) => ({ file, version: readVersion(file) }));
  const drifted = rows.filter((row) => row.version !== expected);

  for (const { file, version } of rows) {
    const mark = version === expected ? "ok  " : "DRIFT";
    console.log(`${mark}  ${file.label}: ${version}`);
  }

  if (drifted.length === 0) {
    console.log(`version:check — all ${VERSION_FILES.length} files agree on ${expected}`);
    return 0;
  }

  console.error(
    `\nVersion drift detected (${drifted.length} file(s) disagree with root package.json ${expected}).\n` +
      `Fix: pnpm version:set ${expected}\n` +
      `(or bump everywhere at once: pnpm version:set <new-semver>)`,
  );
  return 1;
}

function setCmd(rawVersion) {
  const version = (rawVersion ?? "").trim();
  if (!SEMVER_RE.test(version)) {
    console.error(
      `Invalid version "${rawVersion ?? ""}" — expected semver (e.g. 0.45.0, 1.0.0-rc.1).`,
    );
    return 1;
  }

  for (const file of VERSION_FILES) {
    const abs = join(ROOT, file.rel);

    if (file.kind === "tauri") {
      // Line-wise edit: only the "version" line changes, so formatting,
      // key order and the trailing newline are preserved byte-for-byte.
      const text = readFileSync(abs, "utf8");
      const lineRe = /^(\s*"version"\s*:\s*")([^"]+)("\s*,?\s*)$/;
      const lines = text.split("\n");
      let replaced = 0;
      const next = lines.map((line) => {
        const match = line.match(lineRe);
        if (!match || match[2] === version) return line;
        replaced += 1;
        return match[1] + version + match[3];
      });
      if (replaced === 0) {
        // Either already correct or the field is missing/malformed — verify.
        const current = text.match(/"version"\s*:\s*"([^"]+)"/);
        if (current && current[1] === version) {
          console.log(`ok    ${file.label}: already ${version}`);
          continue;
        }
        throw new Error(`${file.rel}: expected a "version": "..." line to rewrite`);
      }
      if (replaced > 1) {
        throw new Error(`${file.rel}: multiple "version" lines matched — refusing to edit`);
      }
      writeFileSync(abs, next.join("\n"));
      console.log(`set   ${file.label}: ${version}`);
      continue;
    }

    // package.json files: parse + re-serialize at 2-space indent (the repo's
    // existing formatting), preserving key order; keep the trailing newline
    // the files already carry.
    const pkg = JSON.parse(readFileSync(abs, "utf8"));
    if (pkg.version === version) {
      console.log(`ok    ${file.label}: already ${version}`);
      continue;
    }
    pkg.version = version;
    writeFileSync(abs, JSON.stringify(pkg, null, 2) + "\n");
    console.log(`set   ${file.label}: ${version}`);
  }

  console.log(`\nAll ${VERSION_FILES.length} files now at ${version}. Next:`);
  console.log(`  1. Add an entry to CHANGELOG.md for ${version}.`);
  console.log(`  2. Commit, then tag: git tag v${version} && git push origin v${version}`);
  console.log(`  (the release workflow builds the launcher kit + draft GitHub release)`);
  return 0;
}

// ── entry point ─────────────────────────────────────────────────────────────
const [command, ...args] = process.argv.slice(2);
try {
  switch (command) {
    case "get":
      process.exit(getCmd());
    case "check":
      process.exit(checkCmd());
    case "set": {
      if (args.length !== 1) {
        console.error("Usage: node scripts/release/version.mjs set <semver>  (e.g. set 0.45.0)");
        process.exit(1);
      }
      process.exit(setCmd(args[0]));
    }
    default:
      console.error(
        "Usage:\n" +
          "  node scripts/release/version.mjs get\n" +
          "  node scripts/release/version.mjs check\n" +
          "  node scripts/release/version.mjs set <semver>",
      );
      process.exit(1);
  }
} catch (err) {
  console.error(`version.mjs: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
