# SETUP — Development Environment

Last verified: 2026-08-22 (Phase 1). Re-verify at each phase kickoff.

## Machine state (verified 2026-08-22)

| Requirement | State |
|---|---|
| Node.js | ✅ v24.18.0 |
| npm | ✅ 11.16.0 |
| pnpm | ✅ 11.22.0 (`npm i -g pnpm`) |
| git | ✅ 2.55.0.windows.3 |
| WebView2 runtime | ✅ 151.0.4129.93 |
| Rust (rustup, stable-msvc) | ⏳ installing 2026-08-22 via winget (background) |
| VS Build Tools 2022 (VCTools) | ⏳ installing 2026-08-22 via winget (background) |

Toolchain install commands (if ever needed again):
```bash
winget install --id Microsoft.VisualStudio.2022.BuildTools --silent --accept-source-agreements --accept-package-agreements --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install --id Rustlang.Rustup --silent --accept-source-agreements --accept-package-agreements
rustup default stable-msvc   # new shell afterwards
```

## Everyday commands (repo root = acute-code/)

```bash
pnpm install        # install workspace deps
pnpm verify         # lint + typecheck + test + build + license audit (mirrors CI exactly)
pnpm test           # vitest, watch mode: pnpm test:watch (if configured)
pnpm dev            # vite dev server for the frontend
cargo check --manifest-path src-tauri/Cargo.toml   # Rust shell (needs Rust toolchain)
```

## pnpm 11 notes (learned the hard way in Phase 1)

- pnpm 11 blocks dependency build scripts by default. Approval lives in `pnpm-workspace.yaml` under `allowBuilds:` (e.g. `esbuild: true`). `pnpm approve-builds` is interactive — avoid in automation.
- pnpm 11 runs a deps-status check before every script; a broken install state fails every `pnpm <script>`. If installs churn oddly, delete `pnpm-lock.yaml` + `node_modules` and reinstall after changing `allowBuilds`.

## Secrets

API keys are entered into Windows Credential Manager by the owner at Phase 2 — never in files, env-var dumps, logs, or the repo. Per ARCHITECTURE.md, the Rust shell reads Credential Manager (DPAPI) and hands keys to the sidecar at spawn. Dev testing uses the owner's OpenAI-compatible endpoint.
