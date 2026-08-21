# SETUP — Development Environment

Last verified: 2026-08-21 (Phase 0). Re-verify at each phase kickoff.

## Current machine state (verified 2026-08-21)

| Requirement | State |
|---|---|
| Node.js | ✅ v24.18.0 |
| npm | ✅ 11.16.0 |
| pnpm | ✅ 11.22.0 (installed 2026-08-21) |
| Bun | ℹ️ 1.3.14 present (not used by this project) |
| git | ✅ 2.55.0.windows.3 (user: CONFUSED83) |
| WebView2 runtime | ✅ 151.0.4129.93 |
| Rust toolchain (rustc/cargo) | ❌ MISSING — install at Phase 1 kickoff |
| VS Build Tools (MSVC) | ❌ MISSING — install at Phase 1 kickoff (required by Rust linking) |

## Phase 1 kickoff installs (Rust shell toolchain)

1. Install VS Build Tools 2022 with the "Desktop development with C++" workload (or `winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`). Multi-GB download; needed only for the first native build.
2. Install rustup: `winget install --id Rustlang.Rustup` then `rustup default stable-msvc`.
3. Verify: `cargo --version && rustc --version`.

## Everyday commands (from Phase 1)

```bash
pnpm install          # install all workspace deps
pnpm -r dev           # run dev servers (exact scripts defined in Phase 1)
```

## Secrets

API keys are entered into Windows Credential Manager by the owner at Phase 2 — never in files, env-var dumps, logs, or the repo. Dev testing uses the owner's OpenAI-compatible endpoint.
