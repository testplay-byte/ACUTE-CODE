# SETUP — Development Environment

Last verified: 2026-08-22 (Phase 2 kickoff). Re-verify at each phase kickoff.

## Machine state (verified 2026-08-22)

| Requirement | State |
|---|---|
| Node.js | ✅ v24.18.0 |
| pnpm | ✅ 11.22.0 |
| git | ✅ 2.55.0.windows.3 |
| WebView2 runtime | ✅ 151.0.4129.93 |
| Rust (stable-msvc) | ✅ rustc 1.98.0 (winget rustup install glitched mid-toolchain; repaired via `rustup toolchain install stable-msvc --profile minimal`) |
| VS Build Tools 2022 (VCTools) | ✅ 17.14.39 |
| GitHub remote | ✅ `testplay-byte/ACUTE-CODE` — PRIVATE (flipped via API before first push, ADR-0012); CI on Actions |

## Secrets (never in files/logs)

| Secret | Location |
|---|---|
| GitHub PAT (repo admin) | Windows Credential Manager via wincred: `git:https://testplay-byte@github.com` |
| OpenRouter API key (dev; single model "ox Alpha") | Windows Credential Manager: `ACUTE-CODE/provider/openrouter` |

Git auth gotchas learned here: GCM (the default helper) special-cases github.com toward OAuth and silently discards Basic PATs — the repo uses `credential.https://github.com.helper = wincred` and a username-embedded remote URL (`https://testplay-byte@github.com/testplay-byte/ACUTE-CODE.git`).

## Everyday commands (repo root = acute-code/)

```bash
pnpm install        # workspace deps
pnpm verify         # lint + typecheck + test + build + license audit (fast local gate)
cargo check --manifest-path src-tauri/Cargo.toml   # only for debugging CI failures — heavy builds live on GitHub Actions (ADR-0012)
git push            # triggers CI; the Actions run is authoritative
```

## pnpm 11 notes

- Build-script approvals live in `pnpm-workspace.yaml` under `allowBuilds:` (currently esbuild; better-sqlite3 may be added in Phase 2). `pnpm approve-builds` is interactive — avoid in automation.
- A broken install state fails every `pnpm <script>` (pre-run deps check): fix by deleting `pnpm-lock.yaml` + `node_modules` and reinstalling after changing `allowBuilds`.

