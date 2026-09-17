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
 *                                 allowBuilds so pnpm exits 0 AND so
 *                                 node-pty's install script may run —
 *                                 better-sqlite3 13 ships all-platform
 *                                 prebuilds in its tarball (no build
 *                                 script at all), but node-pty 1.1.0 ships
 *                                 prebuilds ONLY for darwin/win32
 *                                 (R101-E verified: its prebuilds/ has no
 *                                 linux-* entries) — on Linux there is
 *                                 nothing to load, so its install script
 *                                 compiles pty.node from source for the
 *                                 HOST arch) + nodeLinker: hoisted (see R57
 *                                 below)
 *     node_modules/            ← `pnpm install --prod` (registry deps only),
 *                                 HOISTED npm-style: real directories
 *     node_modules/shared/     ← VENDORED: shared/dist + a patched
 *                                 package.json whose main/exports point at
 *                                 ./dist/index.js (the compiled JS — the
 *                                 workspace's src/index.ts pointer cannot
 *                                 survive inside node_modules, see (3))
 *
 * ROUND-57 (the packaged engine's ERR_MODULE_NOT_FOUND): the R51–R56 staging
 * ran `pnpm install --prod` with pnpm's DEFAULT layout — 189 SYMLINKS on POSIX,
 * 189 JUNCTIONS/reparse-points on the windows-latest release runner. Linux
 * boots such a tree fine (links preserved), which is why the R51 "proven
 * bootable" check on Linux never caught it — but tauri-bundler's resource walk
 * → NSIS `File` pack → NSIS extract on the owner's disk does not preserve that
 * link farm, and the installed engine died with ERR_MODULE_NOT_FOUND before
 * its first log line (owner's 0.56.0 session, sidecar.log 2026-08-31). The fix
 * is structural: `nodeLinker: hoisted` produces a CLASSIC npm-style tree —
 * real directories, zero links — and a hard verification gate below fails the
 * staging if ANY symlink/junction remains anywhere in the staged tree. The
 * release workflow ALSO boots the staged engine on windows-latest (with the
 * pinned node.exe) before `pnpm tauri build`, so a dead engine can never ship
 * again regardless of cause.
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
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
// ROUND-57: this placeholder is byte-identical to the COMMITTED README
// (src-tauri/staging/sidecar/README.md) so a local staging run no longer
// leaves the working tree dirty with a shortened variant (the R51–R56 script
// wrote a 3-line summary; every local stage produced a spurious diff).
writeFileSync(
  resolve(outDir, "README.md"),
  [
    "# The staged sidecar (a BUILD-TIME placeholder)",
    "",
    "This directory is populated by `scripts/release/stage-sidecar.mjs` immediately",
    "before `pnpm tauri build` in the release workflow (`.github/workflows/",
    "release.yml` → the `desktop-installer` job): the pinned Node runtime",
    "(`node.exe`), the runnable agent-core tree (`app/dist` + pruned production",
    "`node_modules/` + the vendored `shared` package), and the Node `LICENSES/`",
    "folder. The bundle's `resources` map in `tauri.conf.json` copies its CONTENTS",
    "into the installed app's `sidecar/` resource directory, where the Rust shell's",
    "release-mode spawn finds them (`resolve_sidecar_command` in `src-tauri/src/",
    "sidecar.rs`).",
    "",
    "Why this placeholder exists: `tauri-build` (build.rs — which runs for EVERY",
    "`cargo check`, not just bundling) validates that every configured resource",
    "path EXISTS. On a fresh checkout the staged tree is absent (it is build",
    "artefact, never committed — see the `/src-tauri/staging/` entry in the root",
    "`.gitignore`, with this file explicitly un-ignored), so without a placeholder",
    "the repo would not compile-check. The release workflow overwrites this",
    "directory wholesale before building; the stray README rides along as a ~300",
    "byte resource and is harmless.",
  ].join("\n") + "\n",
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

// Standalone-project marker + build-script allowlist + the R57 hoisted linker.
// Without this file pnpm would walk UP and find the repo's pnpm-workspace.yaml
// (making the staging dir a workspace member of the repo — a fresh root install
// would then try to adopt it). Without allowBuilds pnpm exits 1 on "ignored
// build scripts" even though the flagged scripts are no-ops for the prebuilt
// addons we ship. And without nodeLinker: hoisted the install produces pnpm's
// default symlinked layout — 189 junctions on the Windows release runner that
// NSIS pack/extract does not survive (the owner's ERR_MODULE_NOT_FOUND, R57);
// hoisted gives a classic npm-style tree of REAL directories.
writeFileSync(
  resolve(appDir, "pnpm-workspace.yaml"),
  [
    "# ROUND-51 (R51-a): standalone-project marker — keeps pnpm from walking up",
    "# into the repo workspace. allowBuilds mirrors the repo root policy so the",
    "# install exits 0; better-sqlite3 ships all-platform prebuilds (its install",
    "# script is a no-op), while node-pty ships prebuilds ONLY for darwin/win32",
    "# — on Linux its install script compiles pty.node from source for the",
    "# HOST arch, so allowing it is load-bearing there (R101-E).",
    "# ROUND-57: hoisted (npm-style, real directories — zero symlinks/junctions).",
    "# The default pnpm layout is a link farm (junctions on Windows) that does",
    "# not survive tauri-bundler + NSIS pack/extract — the packaged engine died",
    "# with ERR_MODULE_NOT_FOUND on the owner's machine while Linux CI booted it",
    "# fine. pnpm 11.x IGNORES this yaml key (npmrc-style settings in",
    "# pnpm-workspace.yaml are not all honored), so the load-bearing flag is",
    "# --config.node-linker=hoisted on the install below; this line is kept for",
    "# future pnpm versions that honor workspace-yaml settings and documents",
    "# the intent.",
    "nodeLinker: hoisted",
    "allowBuilds:",
    "  better-sqlite3: true",
    "  node-pty: true",
    "",
  ].join("\n"),
  "utf8",
);

// ── 4. install the registry dependencies ────────────────────────────────────
const install = spawnSync("pnpm", ["install", "--prod", "--config.node-linker=hoisted"], {
  cwd: appDir,
  encoding: "utf8",
  shell: process.platform === "win32",
});
if (install.status !== 0) {
  fail(`pnpm install --prod failed in the staging dir:\n${(install.stderr || install.stdout || "").slice(-4000)}`);
}

// ROUND-57: `.bin` holds package executable shims — on POSIX those are
// SYMLINKS into the store, and even on Windows some shims are links. The
// staged tree is a RUNTIME tree (the sidecar never spawns package bins),
// so the whole dir is dead weight that would break the zero-links gate below.
rmSync(resolve(appDir, "node_modules", ".bin"), { recursive: true, force: true });

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
// better-sqlite3 (17 MB) ships prebuilds for EVERY platform in its tarball;
// node-pty (58 MB) ships prebuilds ONLY for darwin/win32 (R101-E verified:
// no linux-* entries — on Linux the staging install compiles pty.node from
// source via the allowBuilds entry above, so its binary always matches the
// HOST arch; this is exactly why the ARM64 release job runs on a NATIVE
// runner instead of cross-compiling). Two directory shapes exist (both
// verified in the staged tree): better-sqlite3 keeps FILES like
// `win32-x64.node`, node-pty keeps DIRECTORIES like `win32-x64/`.
// Verified loaders: better-sqlite3 13 has NO install script (its runtime
// resolves prebuilds/<platform>-<arch>[.node] itself) and node-pty's
// lib/utils.js checks build/Release → build/Debug →
// prebuilds/<platform>-<arch>/, so deleting the other platforms' entries
// is inert for the kept one (and on Linux, where node-pty keeps no
// prebuild at all, its source-built build/Release binary is untouched by
// this prune).
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

// ROUND-57 — THE ZERO-LINKS GATE: the staged tree must contain NO symlinks and
// NO junctions/reparse points anywhere. Node's lstatSync().isSymbolicLink()
// reports junctions as symlinks on Windows, so one walk covers both OSes. Any
// link that survives here is a link NSIS pack/extract may not preserve on the
// owner's disk — the exact mechanism behind the 0.56.0 ERR_MODULE_NOT_FOUND.
// The R51 layout shipped 189 of them; this gate exists so that number is never
// anything but 0. (The .pnpm store dir must be gone entirely under hoisted.)
{
  const offenders = [];
  const walk = (p) => {
    for (const entry of readdirSync(p)) {
      const full = resolve(p, entry);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        offenders.push(full.slice(appDir.length + 1));
        continue; // do not descend — the link target is irrelevant, it must not exist
      }
      if (st.isDirectory()) walk(full);
    }
  };
  walk(appDir);
  if (offenders.length > 0) {
    fail(
      `verification failed: staged tree contains ${offenders.length} symlink(s)/junction(s) ` +
        `— the installer cannot preserve links (R57, the packaged engine's ` +
        `ERR_MODULE_NOT_FOUND). First offenders:\n  ${offenders.slice(0, 10).join("\n  ")}`,
    );
  }
  if (existsSync(resolve(appDir, "node_modules", ".pnpm"))) {
    // Hoisted installs may leave a metadata-only .pnpm (lock.yaml); anything
    // more (package dirs) means the DEFAULT linker ran and the tree is a link
    // farm again.
    const leftovers = readdirSync(resolve(appDir, "node_modules", ".pnpm")).filter((e) => e !== "lock.yaml");
    if (leftovers.length > 0) {
      fail(
        `verification failed: node_modules/.pnpm contains package entries (${leftovers.slice(0, 5).join(", ")}) — ` +
          `the install did not use the hoisted linker (--config.node-linker=hoisted)`,
      );
    }
  }
  console.log("stage-sidecar: zero-links gate passed (no symlinks/junctions in the staged tree)");
}

console.log(`stage-sidecar: staged ${mb(appDir)} → ${outDir}`);
console.log(
  `stage-sidecar: deps ${Object.keys(dependencies).length} (+${Object.keys(optionalDependencies).length} optional), versions pinned from the workspace install` +
    (argPlatform ? `, prebuilds pruned to ${argPlatform}` : ""),
);
