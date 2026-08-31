<!-- last-reviewed: 2026-08-31 round-55 -->
# Development Environment Setup (ACUTE-CODE)

Status: Phase 0 snapshot — updated each phase by the Scribe.
(The toolchain rows below are stale as of Phase 2: Rust stable-msvc and VS Build Tools are installed — see the repo `HANDOFF.md` §8 for the current environment.)

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

## Everyday commands

```bash
pnpm install          # workspace deps
pnpm verify           # lint + typecheck + test + build + license audit (local gate = CI)
pnpm dev              # Vite UI dev server on 5173 (UI only — NO sidecar)
pnpm dev:full         # sidecar (127.0.0.1:5178, OpenRouter key from Credential
                      #   Manager, stable .dev/acute.db) + vite — REQUIRED for
                      #   the model catalog, connection test, and any live data
                      #   in a browser; one Ctrl+C stops both
pnpm build            # shared + agent-core dist + frontend dist (the desktop app serves ../dist)
cd src-tauri && cargo run   # launch the desktop app; the shell spawns the sidecar itself
cargo check --manifest-path src-tauri/Cargo.toml   # Rust-only check (heavy Rust builds belong on CI, ADR-0012)
```

There is no `pnpm tauri` CLI script yet; the app is launched with `cargo run` from `src-tauri/`.

API keys: never in files or env scripts committed to the repo. At Phase 2 the owner's OpenAI-compatible keys are entered into Windows Credential Manager directly by the owner.

## credentials.txt v2 (ROUND-44 — sub-agent pool keys)

The owner's local `launcher/credentials.txt` (never uploaded; see
`launcher/credentials.example.txt` for the template) grew three OPTIONAL
lines in R44:

```
OPENROUTER_SUB1_KEY=…   # → credential pool slot 2
OPENROUTER_SUB2_KEY=…   # → credential pool slot 3
OPENROUTER_SUB3_KEY=…   # → credential pool slot 4
```

Behavior (owner directive: "save them inside credentials.txt so I don't have
to manually enter them"):

- The launcher parses the three lines and distributes them to the credential
  pool as slots **2/3/4** — Windows Credential Manager
  (`ACUTE-CODE/provider/openrouter-slotN`) on the owner's PC, with a
  `~/.acute/openrouter-slotN.key` file fallback — and exports
  `ACUTE_PROVIDER_OPENROUTER_SLOT{2,3,4}` env into the sidecar at spawn, so
  sub-agent traffic prefers these keys and never competes with the main key
  (slot 0/1).
- **If the lines are missing, the launcher AUTO-APPENDS them** with the
  baked-in defaults from the example file — a pre-R44 credentials.txt
  upgrades itself on the next launch; a malformed MAIN key still fails loudly.
- The launcher self-updates from the repo, so the new
  `acute_launcher.py` reaches the owner automatically; `ACUTE.bat` /
  `acute.sh` are unchanged. Editing or removing the sub lines later is safe —
  children then fall back to the main key.
- Dev parity: `scripts/dev.mjs` reads each slot via the same
  env → key-file → Credential-Manager chain (`readSlotKey`) before starting
  `pnpm dev:full`, so Settings → Sub-agents shows slots 2/3/4 with zero
  manual entry in dev too.
