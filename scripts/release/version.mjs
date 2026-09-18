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
  { rel: "cli/package.json", label: "cli/package.json (the acute CLI)", kind: "json" },
  { rel: "src-tauri/tauri.conf.json", label: "src-tauri/tauri.conf.json", kind: "tauri" },
  { rel: "mobile/package.json", label: "mobile/package.json (the Android companion)", kind: "json" },
  { rel: "mobile/app.json", label: "mobile/app.json (APK versionName)", kind: "expo" },
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
  if (file.kind === "expo") {
    // ROUND-106 (R106-S5): mobile/app.json carries the APK's versionName at
    // expo.version — the outer package also has a stray "version"-less
    // shape, so the nested read is explicit. The APK's versionCode is
    // checked alongside (checkCmd) so it can never drift from the semver.
    const app = JSON.parse(readFileSync(join(ROOT, file.rel), "utf8"));
    const version = app?.expo?.version;
    if (typeof version !== "string") {
      throw new Error(`${file.rel}: no expo.version field found`);
    }
    return version;
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, file.rel), "utf8"));
  if (typeof pkg.version !== "string") {
    throw new Error(`${file.rel}: no "version" field found`);
  }
  return pkg.version;
}

/** The APK versionCode the semver implies: major*10000 + minor*100 + patch
 * (prereleases ride the numeric triple — 0.102.0-rc.1 → 10200). */
function derivedVersionCode(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return null;
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}

/** ROUND-106 (R106-S5): the expo app.json ALSO carries android.versionCode —
 * the sidecar-form side of the APK's identity. A versionName match with a
 * stale versionCode would install as a DOWNGRADE next to the previous APK;
 * check treats that as drift (fail loudly, fix with version:set). */
function checkExpoVersionCode(file, expected) {
  const app = JSON.parse(readFileSync(join(ROOT, file.rel), "utf8"));
  const code = app?.expo?.android?.versionCode;
  const want = derivedVersionCode(expected);
  if (typeof code !== "number" || code !== want) {
    console.error(
      `DRIFT  ${file.rel}: android.versionCode ${code} != derived ${want} (from ${expected})`,
    );
    return false;
  }
  return true;
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

  // ROUND-106: the expo versionCode rides the versionName check (an APK
  // with a stale code installs as a downgrade — that is drift, loudly).
  let expoCodeOk = true;
  for (const file of VERSION_FILES) {
    if (file.kind === "expo") expoCodeOk = checkExpoVersionCode(file, expected) && expoCodeOk;
  }

  if (drifted.length === 0 && expoCodeOk) {
    console.log(`version:check — all ${VERSION_FILES.length} files agree on ${expected}`);
    return 0;
  }

  const codeNote = expoCodeOk ? "" : " (+ the expo versionCode is stale)";
  console.error(
    `\nVersion drift detected (${drifted.length} file(s) disagree with root package.json ${expected})${codeNote}.\n` +
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

    if (file.kind === "expo") {
      // ROUND-106 (R106-S5): line-wise like the tauri config — app.json is
      // hand-shaped (plugins, adaptive icons); a re-serialize would churn
      // unrelated keys. TWO lines change: expo.version (the APK's
      // versionName) and android.versionCode (the derived install code —
      // a stale one installs as a downgrade).
      const text = readFileSync(abs, "utf8");
      const code = derivedVersionCode(version);
      if (code === null) {
        throw new Error(`cannot derive a versionCode from "${version}"`);
      }
      const versionRe = /^(\s*"version"\s*:\s*")([^"]+)("\s*,?\s*)$/;
      const codeRe = /^(\s*"versionCode"\s*:\s*)(\d+)(\s*,?\s*)$/;
      let setVersion = 0;
      let setCode = 0;
      const next = text.split("\n").map((line) => {
        const vm = line.match(versionRe);
        if (vm) {
          setVersion += 1;
          return vm[1] + version + vm[3];
        }
        const cm = line.match(codeRe);
        if (cm) {
          setCode += 1;
          return cm[1] + code + cm[3];
        }
        return line;
      });
      if (setVersion !== 1) {
        throw new Error(
          `${file.rel}: expected exactly one "version" line to rewrite (found ${setVersion})`,
        );
      }
      if (setCode !== 1) {
        throw new Error(
          `${file.rel}: expected exactly one "versionCode" line to rewrite (found ${setCode})`,
        );
      }
      writeFileSync(abs, next.join("\n"));
      console.log(`set   ${file.label}: ${version} (versionCode ${code})`);
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
