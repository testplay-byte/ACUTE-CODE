# webview2-runtime — the Fixed Version WebView2 runtime (CI-staged)

This directory is where the **WebView2 Fixed Version Runtime** lands before
`pnpm tauri build` bundles it into the NSIS installer (ROUND-99, R99-A — the
owner's directive: the browser engine ships WITH the app; the installed app
never depends on the device's Edge/WebView2 runtime).

**It is staged by CI, never committed** (the same discipline as
`staging/sidecar/`): the `desktop-installer` job in
`.github/workflows/release.yml` downloads the pinned Microsoft cab
(~308 MB), extracts it, and moves the runtime files here so that
`msedgewebview2.exe` is a DIRECT child of this directory — exactly the
layout `bundle.windows.webviewInstallMode.path` requires.

**Why this README exists** (the `staging/sidecar/README.md` precedent):
`tauri-build` validates at COMPILE time that every `bundle.resources` path
exists — a plain `cargo check` / `pnpm verify` run on a checkout without
the staged runtime would fail with
`resource path 'webview2-runtime' doesn't exist`. This committed README
keeps the path alive for non-bundling builds. The release workflow's fetch
step wipes this directory before staging the real runtime, so the README
never rides into an installer.

Local Windows development note: `pnpm tauri dev` with fixedRuntime set
resolves the browser folder relative to the debug exe — place the
extracted runtime beside `target/debug/webview2-runtime` (or temporarily
revert `webviewInstallMode`) if you need the embedded browser in a local
dev shell. The canonical bundling path is the release workflow.
