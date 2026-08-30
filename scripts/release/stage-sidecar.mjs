#!/usr/bin/env node
/**
 * ROUND-51 (R51-a): stage the packaged sidecar for the Windows NSIS installer.
 *
 * Decision history (verified locally before writing a line): `pnpm deploy`
 * MISBEHAVES with this workspace, so the ADR-0009 bundle is staged manually:
 *
 *   1. `pnpm --filter=agent-core deploy --prod <dir>` refuses to run without
 *      `--legacy` (pnpm v10+ requires `inject-workspace-packages=true`, which
 *      would change how dev-mode links workspace packages — too risky).
 *   2. With `--legacy` it "works" but ships a 202 MB tree that includes the
 *      FRONTEND's node_modules (react, framer-motion, radix…) — the legacy
 *      implementation resolves the union of every workspace importer.
 *   3. Most damning: the deployed tree DOES NOT RUN. `shared` is copied with
 *      `main: "./src/index.ts"`, and Node refuses to type-strip TypeScript
 *      under node_modules (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) —
 *      the dev workspace only works because `agent-core/node_modules/shared`
 *      is a symlink OUT to the repo's `shared/` folder, outside node_modules.
 *
 * So this script assembles the bundle by hand (all steps verified by booting
 * the staged tree and curling /health on Linux — see the R51-a worklog):
 *
 *   staging/sidecar/app/
 *     dist/                    ← agent-core/dist (tsc output + SQL migrations)
 *     package.json             ← pruned manifest, EXACT versions resolved from
 *                                 the workspace lockfile install (no drift),
 *                                 no `shared` (vendored below)
 *     pnpm-workspace.yaml      ← standalone-project marker (also stops pnpm
 *                                 from walking up into the repo workspace) +
 *                                 allowBuilds so pnpm exits 0 (the flagged
 *                                 scripts are no-ops: better-sqlite3 13 ships
 *                                 all-platform prebuilds in its tarball and
 *                                 node-pty 1.1.0 loads its bundled
 *                                 prebuilds/<platform>-<arch>/ binaries
 *                                 directly, no build script needed)
 *     node_modules/            ← `pnpm install --prod` (registry deps only)
 *     node_modules/shared/     ← VENDORED: shared/dist + a patched
 *                                 package.json whose main/exports point at
 *                                 ./dist/index.js (the compiled JS — the
 *                                 workspace's src/index.ts pointer cannot
 *                                 survive inside node_modules, see (3))
 *
 * The CI workflow adds `node.exe` (pinned Node 24 LTS win-x64) and Node's
 * LICENSE/ThirdPartyNotices into `staging/sidecar/` beside `app/` before
 * `pnpm tauri build` picks the whole folder up as bundle resources
 * (`{"staging/sidecar/": "sidecar/"}` in tauri.conf.json — verified against
 * tauri-utils 2.11.5: a trailing-slash map entry copies the CONTENTS under
 * the target, so resources land at <resource_dir>/sidecar/app/dist/main.js).
 *
 * Usage: node scripts/release/stage-sidecar.mjs [outDir] [--platform <nodePlatform>]
 *   outDir defaults to src-tauri/staging/sidecar. Run AFTER `pnpm build`
 *   (needs agent-core/dist + shared/dist on disk). --platform (e.g.
 *   win32-x64) prunes the native addons' prebuilds for every OTHER platform
 *   (~60 MB off the installer); omit it to keep all platforms.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const argPlatform = (() => {
  const i = process.argv.indexOf("--platform");
  return i >= 0 ? process.argv[i + 1] : null;
})();
/** First positional arg (skipping flags and flag values). */
const argOutDir = (() => {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--platform") { i += 1; continue; }
    if (!args[i].startsWith("--")) return args[i];
  }
  return null;
})();
const outDir = resolve(argOutDir ?? resolve(repoRoot, "src-tauri", "staging", "sidecar"));
const appDir = resolve(outDir, "app");

function fail(message) {
  console.error(`stage-sidecar: ${message}`);
  process.exit(1);
}

/** Human-readable size for the summary line. */
function mb(path) {
  let total = 0;
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const entry of readdirSync(p)) walk(resolve(p, entry));
    } else {
      total += st.size;
    }
  };
  walk(path);
  return `${(total / 1024 / 1024).toFixed(1)} MB`;
}

// ── 1. prerequisites: the workspace builds must exist ───────────────────────
const agentDist = resolve(repoRoot, "agent-core", "dist", "main.js");
const sharedDist = resolve(repoRoot, "shared", "dist", "index.js");
if (!existsSync(agentDist)) {
  fail(`agent-core/dist/main.js is missing — run \`pnpm build\` first (staging runs AFTER the build).`);
}
if (!existsSync(sharedDist)) {
  fail(`shared/dist/index.js is missing — run \`pnpm build\` first (staging runs AFTER the build).`);
}
const agentPkg = JSON.parse(readFileSync(resolve(repoRoot, "agent-core", "package.json"), "utf8"));

// ── 2. resolve EXACT dependency versions from the installed workspace ───────
// `pnpm list` reports the versions the lockfile actually installed, so the
// staged bundle can never drift from what CI tested. (Parsing pnpm-lock.yaml
// by hand was rejected — YAML without a parser dependency is too fragile.)
const listing = spawnSync("pnpm", ["--filter", "agent-core", "list", "--json", "--depth", "0"], {
  cwd: repoRoot,
  encoding: "utf8",
  shell: process.platform === "win32",
});
if (listing.status !== 0) {
  fail(`pnpm list failed:\n${listing.stderr || listing.stdout}`);
}
const entries = JSON.parse(listing.stdout);
const entry = Array.isArray(entries) ? entries[0] : entries;
const installed = new Map(
  Object.entries(entry?.dependencies ?? {}).map(([name, info]) => [name, info?.version ?? null]),
);

const dependencies = {};
for (const name of Object.keys(agentPkg.dependencies ?? {})) {
  if (name === "shared") continue; // vendored below (never a registry dep)
  const version = installed.get(name);
  if (typeof version !== "string" || version.startsWith("link:")) {
    fail(`could not resolve an installed version for ${name} — run \`pnpm install\` first.`);
  }
  dependencies[name] = version;
}
// node-pty is an optionalDependency (the sidecar's terminal engine falls back
// to the persistent-pipe shell without it). `pnpm list` does not report
// optional deps, so resolve its version from the installed package itself.
const optionalDependencies = {};
if (agentPkg.optionalDependencies?.["node-pty"]) {
  const ptyPkgPath = resolve(repoRoot, "agent-core", "node_modules", "node-pty", "package.json");
  let ptyVersion = installed.get("node-pty");
  if (typeof ptyVersion !== "string" && existsSync(ptyPkgPath)) {
    ptyVersion = JSON.parse(readFileSync(ptyPkgPath, "utf8")).version;
  }
  if (typeof ptyVersion === "string" && !ptyVersion.startsWith("link:")) {
    optionalDependencies["node-pty"] = ptyVersion;
  }
}

// ── 3. assemble the app dir ─────────────────────────────────────────────────
rmSync(outDir, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });
// ROUND-51 (orchestrator): restore the build-time placeholder tauri-build
// requires (bundle.resources paths must EXIST for every `cargo check`, not
// just bundling — see the README itself). The wholesale rmSync above deletes
// the committed copy; recreating it keeps a fresh checkout + local staging +
// cargo check all green (on CI the release job stages AFTER its own cargo
// check, but developers run cargo locally too).
writeFileSync(
  resolve(outDir, "README.md"),
  "# The staged sidecar (a BUILD-TIME placeholder)\n\n" +
    "Populated by scripts/release/stage-sidecar.mjs before `pnpm tauri build` — " +
    "this placeholder keeps `tauri-build`'s resource-path existence check green " +
    "on fresh checkouts. See the repo's .gitignore for what is (never) committed.\n",
);
cpSync(resolve(repoRoot, "agent-core", "dist"), resolve(appDir, "dist"), { recursive: true });

const stagedPkg = {
  name: "agent-core-sidecar",
  version: agentPkg.version,
  private: true,
  license: agentPkg.license,
  type: "module",
  main: "dist/main.js",
  dependencies,
  ...(Object.keys(optionalDependencies).length > 0 ? { optionalDependencies } : {}),
};
writeFileSync(resolve(appDir, "package.json"), `${JSON.stringify(stagedPkg, null, 2)}\n`, "utf8");

// Standalone-project marker + build-script allowlist. Without this file pnpm
// would walk UP and find the repo's pnpm-workspace.yaml (making the staging
// dir a workspace member of the repo — a fresh root install would then try to
// adopt it). Without allowBuilds pnpm exits 1 on "ignored build scripts" even
// though the flagged scripts are no-ops for the prebuilt addons we ship.
writeFileSync(
  resolve(appDir, "pnpm-workspace.yaml"),
  [
    "# ROUND-51 (R51-a): standalone-project marker — keeps pnpm from walking up",
    "# into the repo workspace. allowBuilds mirrors the repo root policy so the",
    "# install exits 0; better-sqlite3 ships all-platform prebuilds and node-pty",
    "# loads its bundled prebuilds/<platform>-<arch>/ binaries without any build",
    "# script, so allowing them changes nothing on disk.",
    "allowBuilds:",
    "  better-sqlite3: true",
    "  node-pty: true",
    "",
  ].join("\n"),
  "utf8",
);

// ── 4. install the registry dependencies ────────────────────────────────────
const install = spawnSync("pnpm", ["install", "--prod"], {
  cwd: appDir,
  encoding: "utf8",
  shell: process.platform === "win32",
});
if (install.status !== 0) {
  fail(`pnpm install --prod failed in the staging dir:\n${(install.stderr || install.stdout || "").slice(-4000)}`);
}

// ── 5. vendor `shared` with a runnable package.json ─────────────────────────
// The workspace's shared/package.json points main/exports at ./src/index.ts
// (dev convenience — Node 24 type-strips TS outside node_modules). Inside the
// bundle it MUST point at the compiled dist or the sidecar cannot boot.
mkdirSync(resolve(appDir, "node_modules", "shared"), { recursive: true });
cpSync(resolve(repoRoot, "shared", "dist"), resolve(appDir, "node_modules", "shared", "dist"), { recursive: true });
const sharedPkg = JSON.parse(readFileSync(resolve(repoRoot, "shared", "package.json"), "utf8"));
writeFileSync(
  resolve(appDir, "node_modules", "shared", "package.json"),
  `${JSON.stringify(
    {
      name: sharedPkg.name,
      version: sharedPkg.version,
      private: true,
      license: sharedPkg.license,
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

// ── 6. prune other platforms' prebuilds (optional, --platform) ───────────────
// better-sqlite3 (17 MB) and node-pty (58 MB) both ship prebuilds for EVERY
// platform inside their tarballs; a Windows installer only ever loads the
// win32-x64 one. Two directory shapes exist (both verified in the staged
// tree): better-sqlite3 keeps FILES like `win32-x64.node`, node-pty keeps
// DIRECTORIES like `win32-x64/`. Verified loaders: better-sqlite3 13 has NO
// install script (its runtime resolves prebuilds/<platform>-<arch>[.node]
// itself) and node-pty's lib/utils.js checks build/Release → build/Debug →
// prebuilds/<platform>-<arch>/, so deleting the other platforms' entries is
// inert for the kept one.
if (argPlatform !== null && argPlatform !== "") {
  const isTarget = (entry) => entry === argPlatform || entry === `${argPlatform}.node`;
  let pruned = 0;
  for (const addon of ["better-sqlite3", "node-pty"]) {
    const prebuildsDir = resolve(appDir, "node_modules", addon, "prebuilds");
    if (!existsSync(prebuildsDir)) continue;
    for (const entry of readdirSync(prebuildsDir)) {
      if (!isTarget(entry)) {
        rmSync(resolve(prebuildsDir, entry), { recursive: true, force: true });
        pruned += 1;
      }
    }
  }
  console.log(`stage-sidecar: pruned ${pruned} foreign prebuild entries for platform ${argPlatform}`);
}

// ── 7. verify the layout (the CI's last line of defense before tauri build) ─
const required = [
  ["app entry", resolve(appDir, "dist", "main.js")],
  ["SQL migrations", resolve(appDir, "dist", "storage", "migrations", "0001_init.sql")],
  ["SQLite native addon", resolve(appDir, "node_modules", "better-sqlite3", "prebuilds")],
  ["vendored shared", resolve(appDir, "node_modules", "shared", "dist", "index.js")],
];
for (const [label, path] of required) {
  if (!existsSync(path)) fail(`verification failed: ${label} missing at ${path}`);
}
// With a target platform, the ONLY remaining prebuild entries must be its own.
if (argPlatform !== null && argPlatform !== "") {
  const sqlitePrebuilds = readdirSync(resolve(appDir, "node_modules", "better-sqlite3", "prebuilds"));
  if (sqlitePrebuilds.length !== 1 || ![argPlatform, `${argPlatform}.node`].includes(sqlitePrebuilds[0])) {
    fail(`verification failed: better-sqlite3 prebuilds = [${sqlitePrebuilds.join(", ")}], expected exactly [${argPlatform}]`);
  }
}

console.log(`stage-sidecar: staged ${mb(appDir)} → ${outDir}`);
console.log(
  `stage-sidecar: deps ${Object.keys(dependencies).length} (+${Object.keys(optionalDependencies).length} optional), versions pinned from the workspace install` +
    (argPlatform ? `, prebuilds pruned to ${argPlatform}` : ""),
);
