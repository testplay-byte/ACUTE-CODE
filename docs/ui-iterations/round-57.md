<!-- last-reviewed: 2026-09-07 round-75 -->
# Round 57 — The engine-bundling round: the packaged engine finally carries its own dependencies (ERR_MODULE_NOT_FOUND + the 189-junction link farm)

**Date:** 2026-08-31 · **Branch:** `main` · **Version:** 0.57.0 · **Owner directives:** the tenth Windows test session (the fifth desktop run) — the first CONFIRMED SUCCESS on half the product: *"I ran the acut.bat file, and it ran successfully... I selected the web page, and when I clicked the web page, it properly launched the web page. Everything loaded properly, everything worked properly, and I was successfully able to go to the dashboard page."* — and the remaining failure, now with the engine's own stderr captured: *"I went on and tried to launch the desktop application... it did launch and open up the application but it failed to reach the agent core. The agent core was not running. We need to handle it properly... It needs to be bundled in properly."*

## The log finally said the name

Every previous "Can't reach agent-core" session died with the same
half-blind tail — `ready handshake: stdout closed before the ready line`
— because a GUI-subsystem process had no stderr handle (fixed R54) and
the real crash landed in a pipe nobody read. This session's log is
different: R54's stderr plumbing worked, and the engine's dying words
arrived:

```
at ModuleLoader.getOrCreateModuleJob (node:internal/modules/esm/loader:607:35)
at ModuleJob.syncLink (node:internal/modules/esm/module_job:276:33) {
  code: 'ERR_MODULE_NOT_FOUND'
}
Node.js v24.20.0
sidecar: startup attempt 3/3 failed: ready handshake: stdout closed before the ready line
```

`ERR_MODULE_NOT_FOUND` from the **ESM loader** on all three startup
attempts. EISDIR (R55) is gone — node.exe now starts, resolves the entry
script, and begins loading `dist/main.js`'s import graph. It dies the
moment the graph leaves the repo's own compiled files and reaches a bare
specifier (`fastify`, `ai`, `@ai-sdk/*`, `better-sqlite3`, …) that must
resolve from the installed `node_modules`.

## Root cause — the staged tree was a link farm

`scripts/release/stage-sidecar.mjs` (R51) assembles the installer's
engine tree by copying `agent-core/dist` + a pruned `package.json`, then
running **`pnpm install --prod`** inside the staging dir. pnpm's DEFAULT
layout is a symlink farm — on POSIX:

```
node_modules/ai            -> .pnpm/ai@7.0.73_zod@4.5.4/node_modules/ai
node_modules/better-sqlite3 -> .pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3
...
```

Measured on the R56 tip: **189 symlinks** in the staged tree (plus the
`.pnpm` virtual store of 89 peer-composite directories). On the
windows-latest release runner the same install produces **189
junctions/reparse points** (pnpm uses junctions on Windows).

Why nothing caught it:

| Layer | What happened |
|---|---|
| The R51 "proven bootable" check | Booted the tree **on Linux** — links resolve fine there, `/health` answered 200. The gate verified the wrong platform. |
| `tauri build` on the runner | Packs `staging/sidecar/` into NSIS resources — junctions are not portable files; the walk/extract chain does not preserve the link farm. |
| The owner's disk | The installed `node_modules` has broken/missing entries → the ESM loader fails on the first unresolvable specifier → `ERR_MODULE_NOT_FOUND` before the engine's first log line — for the fourth session in a row, with a different root cause each time (R53 stale port, R54 blind one-shot, R55 verbatim paths, R57 link farm). |

The kicker: the failure mode was INVISIBLE to every Linux check by
construction — Linux preserves symlinks end-to-end. Only the shipped
Windows install exposed it. (And R56's audit table even called the
staging "Sound" — it checked versions and layout, never links. The audit
question "can NSIS extract this?" was never asked.)

## Fix 1 — hoisted linker: real directories, zero links

`pnpm install --prod --config.node-linker=hoisted` in the staging dir
now produces a classic **npm-style tree**: every package a REAL
directory, peers hoisted to the top level (zod etc.), no `.pnpm` package
links (a metadata-only `.pnpm/lock.yaml` may remain — inert). Verified
empirically with BOTH pnpm 11.24 (local) and the exact CI pnpm 11.22.0:

- `node_modules/ai`, `node_modules/fastify`, … are real dirs —
  `lstatSync().isSymbolicLink()` is false for every entry.
- The staged tree **boots**: `ACUTE_READY {"port":…}`, `/health` →
  `{"status":"ok"}`, `/api/v1/agents` → 200 (auth + SQLite + migrations
  all working from the staged tree alone).
- Bonus: the tree shrank **301.5 MB → 124.6 MB** (the `.pnpm` store
  duplicated peer trees the hoisted layout dedupes).

Details that mattered:

- `nodeLinker: hoisted` written into the staging `pnpm-workspace.yaml`
  is IGNORED by pnpm 11.x (verified: `.pnpm` links still appear) — the
  load-bearing mechanism is the `--config.node-linker=hoisted` CLI flag.
  The yaml line stays as documentation + future-pnpm cover.
- `node_modules/.bin` is deleted after install: bin shims are symlinks
  on POSIX, the sidecar never spawns package bins at runtime, and the
  zero-links gate would (correctly) refuse them.

## Fix 2 — the zero-links gate (staging can never regress)

The staging script now walks the ENTIRE staged tree and **fails the
build** if a single symlink/junction remains (`lstatSync` reports
Windows junctions as symlinks, so one walk covers both OSes), and
additionally refuses a `.pnpm` dir containing package entries. The R51
tree carried 189 links; this gate makes that number permanently 0 —
and it already caught a real regression during development (the first
attempt used the yaml-only setting, the gate failed the stage, the flag
was added).

## Fix 3 — the Windows pre-pack boot gate (release can never ship a dead engine)

`release.yml` gained a step between "Bundle the pinned Node runtime"
and "Build the NSIS installer": **Boot the staged engine on Windows
(pre-pack gate)**. It runs the REAL staged `node.exe` against
`app/dist/main.js` with the same environment the Rust shell passes
(`ACUTE_TOKEN`, `ACUTE_DB_PATH`, cwd = the app dir), polls for the
`ACUTE_READY` handshake line (90 s budget — cold-boot honest), and on
failure prints the engine's stdout/stderr tails and **fails the release
before the installer is packed**. This is the check the R51 round
thought it had. It would have caught R53's stale port, R54's silent
one-shot, R55's EISDIR, and R57's link farm — every packaged-engine
failure to date — before any of them reached the owner.

## What did NOT change

- No Rust shell code changed (R55's `simplified_path` verdict was
  confirmed correct — the engine now starts and reaches module
  loading).
- No launcher changes (`acute.bat`/`acute.sh`/`credentials.txt`
  untouched; `acute_launcher.py` untouched — the R56 app-or-site flow
  is the owner-verified success of this session and stands as shipped).
- No agent-core code changed — the engine binary content is identical;
  only the TREE it ships in changed from links to real files.

## Verification

- Gates: lint clean, typecheck clean (root + agent-core), **1071/1071
  tests in 76 files**, version:check 0.57.0 ×4, `docs:check` 147/0
  (the sandbox's 3 unreachable-URL WARNs are raw.githubusercontent 429
  rate-limits on this sandbox's network, not dead links — CI's clean
  network is the authority).
- Staging: hoisted install verified with pnpm 11.22.0 (the exact CI
  version) AND 11.24; zero-links gate passes; boot test from the staged
  tree: `ACUTE_READY` + `/health` 200 + `/api/v1/agents` 200.
- Release workflow: the new Windows boot gate runs before
  `pnpm tauri build` on every release build (tag or dispatch).
- CI + Release runs for this round: recorded in the ORCHESTRATION-WORKLOG
  entry (API-verified to success before this report was finalized).

## Follow-up — the CI flake the round's own docs commit caught

The docs-only worklog commit's CI run (33411797885) failed with every
test passing: `ModelsProvidersTab`'s "Slot added." reset
(`setTimeout(() => setMsg(null), 1500)`) fired AFTER happy-dom
teardown — React-DOM's dispatchSetState hit `window is not defined` and
vitest failed the suite on the uncaught exception. The bare-timer idiom
lived at 11 call sites across 4 files. NEW
`src/hooks/use-timeout-clear.ts` (`useTimeoutClear`) schedules state
resets that cancel on unmount and replace-on-reschedule; all 11 sites
now ride it, pinned by 3 tests (including the exact CI failure mode).
**1074/1074 in 77 files.** Production was never affected — an unmounted
setState is a silent no-op in React 18; the crash only exists in
torn-down test environments. The shipped 0.57.0 installer stands.

## Known limitations (honest)

- The Windows boot gate runs on the build runner, not the owner's
  machine — Defender timing, AppData layout, and upgrade-in-place are
  still owner-side variables. But the module graph, the tree layout,
  and the handshake are now proven on Windows before shipping.
- The hoisted tree is ~125 MB uncompressed (installer compresses it);
  installer size should stay in the same ballpark as 0.56.0.
- The R50 queue (command watchdog polish, sub-agent supervision stats,
  terminal output visibility, usage screen section 2, model-selector
  hover, plugin tool system) remains deferred behind the owner's
  engine-boot verdict — this round is deliberately surgical.

## The owner's upgrade path

Double-click **ACUTE.bat** → self-update pulls 0.57.0 → the app-or-site
question (Enter = last choice) → **[1] the desktop app** → install
0.57.0 → the app window opens and this time the console should print
`✓ agent-core is up — port N` and the window should reach the dashboard
— the same flow the owner just watched work in the browser, now with a
bundled engine that actually boots.
