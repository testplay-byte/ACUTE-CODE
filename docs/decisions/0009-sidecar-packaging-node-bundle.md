<!-- last-reviewed: 2026-09-17 round-102 -->
# ADR-0009: [ASSUMPTION] Sidecar packaging — bundled Node runtime + esbuild single-file bundle

- **Status:** ACCEPTED (assumption — smaller option chosen without owner input; surfaced for ratification)
- **Date:** 2026-08-21
- **Tags:** [ASSUMPTION]

## Context

ADR-0003 fixed portable-first distribution: a folder with `acute-code.exe` that starts everything, no admin rights. The stack fixes the agent core as Node/TS (SPEC §3), so a Node runtime must reach the user's machine somehow — Windows users won't have Node installed. Tauri's `externalBin` mechanism ships arbitrary binaries next to the exe. The packaging choice interacts with ADR-0007: better-sqlite3 is a native addon that cannot be embedded inside a Node Single Executable Application (SEA).

## Options considered

- **A. Ship `node.exe` + esbuild single-file JS + native addon files** — `scripts/build-sidecar.mjs` bundles `agent-core` with esbuild (MIT) into one `.mjs`, copies `better_sqlite3.node`, and `package-portable.mjs` places the pinned Node runtime (MIT-licensed) beside the Tauri exe. ~40–60 MB folder cost. Everything works: native addons, `child_process` for MCP stdio servers, source maps for diagnostics.
- **B. Node SEA (single executable)** — one `acute-core.exe`, nicer distribution; but SEA cannot load native addons (requires everything bundled into the snapshot) — incompatible with better-sqlite3 (ADR-0007) unless we switch to experimental `node:sqlite`.
- **C. `pkg` / `nexe` packagers** — would produce a single exe with addon support via snapshots, but both projects are effectively unmaintained for current Node lines; risk to a closed-source long-lived product.
- **D. Rewrite agent-core in Rust (no runtime to ship)** — contradicts the fixed stack table (SPEC §3: changes require owner ADR) and forfeits the Vercel AI SDK ecosystem, a stated rationale of the stack.

## Decision

**Option A**: portable folder ships `acute-code.exe` + `sidecar/` (pinned `node.exe`, `main.mjs`, `better_sqlite3.node`, `node_modules_metadata.json` for the license audit). Version pinning: one specific Node 24.x win-x64 build, recorded in the build script and audited in `docs/compliance/dependency-licenses.md`. Marked [ASSUMPTION] because the owner may care about the ~50 MB folder size vs the SEA route (which would force revisiting ADR-0007 toward `node:sqlite` once stable).

## Consequences

`pnpm verify` covers the bundle step so drift between dev `ts-node` execution and the packaged bundle is impossible. The license audit must include the Node runtime's license text (MIT, with third-party notices) in the portable folder's `LICENSES/` directory to keep distribution compliant (SPEC §6). Reversal cost: low — the same esbuild bundle feeds either packaging route; switching to SEA later is a build-script change plus the ADR-0007 driver question, not a code rewrite.
