# The staged sidecar (a BUILD-TIME placeholder)

This directory is populated by `scripts/release/stage-sidecar.mjs` immediately
before `pnpm tauri build` in the release workflow (`.github/workflows/
release.yml` → the `desktop-installer` job): the pinned Node runtime
(`node.exe`), the runnable agent-core tree (`app/dist` + pruned production
`node_modules/` + the vendored `shared` package), and the Node `LICENSES/`
folder. The bundle's `resources` map in `tauri.conf.json` copies its CONTENTS
into the installed app's `sidecar/` resource directory, where the Rust shell's
release-mode spawn finds them (`resolve_sidecar_command` in `src-tauri/src/
sidecar.rs`).

Why this placeholder exists: `tauri-build` (build.rs — which runs for EVERY
`cargo check`, not just bundling) validates that every configured resource
path EXISTS. On a fresh checkout the staged tree is absent (it is build
artefact, never committed — see the `/src-tauri/staging/` entry in the root
`.gitignore`, with this file explicitly un-ignored), so without a placeholder
the repo would not compile-check. The release workflow overwrites this
directory wholesale before building; the stray README rides along as a ~300
byte resource and is harmless.
