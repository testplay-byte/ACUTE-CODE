#!/usr/bin/env node
/**
 * Dependency license audit (SPEC section 6, closed-source distribution).
 *
 * Runs `pnpm licenses ls --json --prod` in every workspace package (frontend
 * root, agent-core sidecar, shared types — a root-only run misses shipped
 * sidecar dependencies), merges the results into a deduplicated
 * package/version/license table at docs/compliance/dependency-licenses.md,
 * and exits 1 when any production dependency carries a copyleft
 * (GPL/AGPL/LGPL) license or a license that cannot be classified.
 *
 * Policy: allowed = MIT, Apache-2.0, BSD-2/3-Clause, 0BSD, ISC, MPL-2.0,
 * CC0-1.0. First-party workspace packages are marked proprietary, not third-party.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = resolve(repoRoot, "docs", "compliance", "dependency-licenses.md");

const ALLOWED = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "ISC",
  "MPL-2.0",
  "CC0-1.0",
]);
const FIRST_PARTY = new Set(["UNLICENSED", "LicenseRef-Proprietary"]);

// R98-D (ADR-0030): SPELLING-GAP overrides — an exact `package@version` whose
// true license is allowed/permissive but whose pnpm-reported SPDX string is
// missing or non-SPDX. Overrides are for spelling gaps ONLY, NEVER copyleft:
// the GPL/AGPL/LGPL exclusion in verdictFor runs on the ADR-classified value
// BEFORE the override can apply, so no entry here can ever whitelist a
// copyleft license. The ALLOWED set is not touched; every entry cites its ADR
// and the generated report prints the classified license plus the raw pnpm
// value so the override stays visible in docs/compliance/.
const PACKAGE_LICENSE_OVERRIDES = new Map([
  // package.json ships no license field; MIT in fact (fabiospampinato/khroma).
  ["khroma@2.1.0", { license: "MIT", adr: "ADR-0030" }],
  // Public-domain-equivalent — more permissive than MIT; the audit already
  // admits the class via 0BSD/CC0-1.0.
  ["robust-predicates@3.0.3", { license: "Unlicense", adr: "ADR-0030" }],
]);

const WORKSPACE_PACKAGES = [".", "agent-core", "shared"];

function run() {
  const rows = [];
  const seen = new Set();
  for (const pkg of WORKSPACE_PACKAGES) {
    const cwd = resolve(repoRoot, pkg);
    // Static command string (no interpolation) so running it through a shell is
    // safe; the shell is required because pnpm is a .cmd shim on Windows.
    const result = spawnSync("pnpm licenses ls --json --prod", {
      cwd,
      encoding: "utf8",
      shell: true,
    });
    if (result.error) {
      console.error(`license-audit: could not start pnpm in ${pkg}: ${result.error.message}`);
      return { code: 1, rows: [] };
    }
    if (result.status !== 0) {
      console.error(`license-audit: pnpm licenses ls failed in ${pkg}:\n${result.stderr}`);
      return { code: 1, rows: [] };
    }
    for (const row of collectRows(JSON.parse(result.stdout))) {
      const key = `${row.name}@${row.version}@${row.license}`;
      if (!seen.has(key)) {
        seen.add(key);
        rows.push(row);
      }
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return { code: 0, rows };
}

/** Flatten pnpm's "grouped by license" JSON into one row per package+version. */
function collectRows(grouped) {
  const rows = [];
  for (const [licenseGroup, packages] of Object.entries(grouped)) {
    // Current pnpm shape: { "MIT": [ { name, versions, ... } ] }. Older/alternative
    // shape keys each package separately: { "MIT": { "react@18": {...} } }.
    const entries = Array.isArray(packages)
      ? packages
      : Object.values(packages).map((entry) => entry);
    for (const entry of entries) {
      for (const version of entry.versions) {
        rows.push({ name: entry.name, version, license: entry.license ?? licenseGroup });
      }
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return rows;
}

/** The override row for an exact package@version, when one is pinned. */
function overrideFor(row) {
  return PACKAGE_LICENSE_OVERRIDES.get(`${row.name}@${row.version}`);
}

function verdictFor(license, override) {
  // Copyleft is the ABSOLUTE exclusion — it is checked on the ADR-classified
  // value too, so a PACKAGE_LICENSE_OVERRIDES entry can never whitelist it.
  if (/GPL/i.test(license)) return "FORBIDDEN (copyleft)";
  if (override !== undefined) return `OK (${override.adr})`;
  if (FIRST_PARTY.has(license)) return "FIRST-PARTY (proprietary)";
  if (ALLOWED.has(license)) return "OK";
  // SPDX choice expressions ("A OR B", e.g. json-schema's "AFL-2.1 OR
  // BSD-3-Clause") let the licensee pick a branch: OK when at least one branch
  // is allowed. Copyleft branches are still rejected by the GPL check above.
  const branches = license
    .split(/\s+or\s+/i)
    .map((branch) => branch.replace(/[()]/g, "").trim());
  if (branches.length > 1 && branches.some((branch) => ALLOWED.has(branch))) {
    return "OK (SPDX OR)";
  }
  return "FORBIDDEN (unknown license)";
}

function writeReport(rows, failed) {
  const generated = new Date().toISOString().slice(0, 10);
  const lines = [
    "# Dependency License Audit",
    "",
    `Generated by \`scripts/license-audit.mjs\` (\`pnpm license:audit\`) on ${generated}. Do not edit by hand.`,
    "",
    "Policy (SPEC section 6): allowed - MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD, ISC, MPL-2.0, CC0-1.0.",
    "Forbidden - GPL, AGPL, LGPL and any license that cannot be classified (closed-source distribution).",
    "Every license exception must be recorded as an ADR under `docs/decisions/`.",
    "",
    `Audited production dependencies: ${rows.length}. Verdict: ${failed ? "FAILED" : "CLEAN"}.`,
    "",
    "| Package | Version | License | Verdict |",
    "|---|---|---|---|",
  ];
  for (const row of rows) {
    const override = overrideFor(row);
    // Overridden rows show the ADR-classified license PLUS the raw pnpm
    // value (R98-D: the override stays visible in the generated report).
    const licenseCell =
      override !== undefined ? `${override.license} (raw: ${row.license}; ${override.adr})` : row.license;
    lines.push(
      `| ${row.name} | ${row.version} | ${licenseCell} | ${verdictFor(row.license, override)} |`,
    );
  }
  if (rows.length === 0) {
    lines.push("| _no production dependencies_ | | | |");
  }
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${lines.join("\n")}\n`, "utf8");
}

const { code, rows } = run();
if (code !== 0) {
  process.exit(code);
}

const failures = rows.filter((row) =>
  verdictFor(row.license, overrideFor(row)).startsWith("FORBIDDEN"),
);
writeReport(rows, failures.length > 0);

if (failures.length > 0) {
  console.error("license-audit: FAILED - forbidden or unknown licenses found:");
  for (const row of failures) {
    console.error(`  ${row.name}@${row.version} -> ${row.license}`);
  }
  process.exit(1);
}

console.log(`license-audit: clean (${rows.length} production dependencies) -> ${reportPath}`);
