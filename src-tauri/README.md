# src-tauri

The Tauri 2 Rust desktop shell: window, IPC bridge to the frontend, and (from
Phase 2) the lifecycle owner for the agent-core Node sidecar — it will spawn
the sidecar, pass it a port + auth token, probe `/health`, and terminate it on
exit (see the comment in `src/lib.rs`).

## Status (Phase 1)

Static scaffold only — no `cargo` toolchain was available when this was
written, so compilation is deferred. `cargo check` runs in CI
(`.github/workflows/ci.yml`) and locally once Rust is installed:

```
cargo check --manifest-path src-tauri/Cargo.toml
```

## Files

- `Cargo.toml` — tauri 2 + tauri-plugin-shell, edition 2021
- `build.rs` — standard tauri build script
- `tauri.conf.json` — v2 config; `frontendDist: ../dist` (vite output),
  `devUrl: http://localhost:5173` (matches `vite.config.ts`), bundling off
  (icons deferred to the packaging phase)
- `capabilities/default.json` — minimal capability (`core:default` only)
- `src/main.rs` / `src/lib.rs` — standard v2 entry points + placeholder command
