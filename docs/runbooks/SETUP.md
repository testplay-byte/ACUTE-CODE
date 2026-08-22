# Development Environment Setup (ACUTE-CODE)

Status: Phase 0 snapshot — updated each phase by the Scribe.

## Machine state (verified 2026-08-21)

| Tool | Version | Status |
|---|---|---|
| Node.js | v24.18.0 | OK |
| npm | 11.16.0 | OK |
| pnpm | 11.22.0 | OK (installed during Phase 0) |
| Bun | 1.3.14 | Present (not used by the product) |
| git | 2.55.0.windows.3 | OK (user: CONFUSED83) |
| WebView2 Runtime | 151.0.4129.93 | OK (required by Tauri — present) |
| Rust (rustc/cargo) | — | **MISSING — install at Phase 1 kickoff** |
| VS Build Tools (MSVC) | — | **MISSING — install at Phase 1 kickoff** |

## Pending installs (Phase 1 kickoff, in this order)

1. **Visual Studio Build Tools 2022** with the "Desktop development with C++" workload (provides MSVC linker required by Rust on Windows). Multi-GB download — schedule when convenient.
2. **Rust via rustup** (`winget install Rustlang.Rustup` or https://rustup.rs), stable toolchain, `x86_64-pc-windows-msvc` host. Verify: `rustc --version && cargo --version`.

Rationale for deferral: nothing in Phases 0–1 research/design compiles Rust; the toolchain is only needed at the first native build, and rustup without MSVC produces a half-broken toolchain.

## Everyday commands (from Phase 1 onward)

```bash
pnpm install          # workspace deps
pnpm dev              # frontend + sidecar dev servers
pnpm test / pnpm lint / pnpm typecheck
pnpm tauri dev        # shell + UI + sidecar, hot reload
```

API keys: never in files or env scripts committed to the repo. At Phase 2 the owner's OpenAI-compatible keys are entered into Windows Credential Manager directly by the owner.
