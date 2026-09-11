<!-- last-reviewed: 2026-09-11 round-90 -->
# ACUTE-CODE

Local-first, closed-source multi-agent engineering workbench for Windows.
**Proprietary — do not publish, do not add an open-source license.**

- Master requirements: `docs/specs/SPEC.md`
- Architecture: `docs/architecture/` (Phase 1)
- Decisions: `docs/decisions/`
- Research: `docs/research/`
- Dev setup: `docs/runbooks/SETUP.md`

Stack: Tauri 2 (Rust) · React 18 + TypeScript · Node/TS agent-core sidecar · SQLite · pnpm workspaces.

## Development

pnpm workspace — the root package is the React frontend; `agent-core/` is the
Node sidecar; `shared/` holds domain types; `src-tauri/` is the Rust shell.

- `pnpm install` — install
- `pnpm verify` — lint + typecheck + test + build + e2e + license audit (mirrors CI, which also runs `pnpm docs:check` first; the local pre-push gate)
- `pnpm dev` — Vite dev server on port 5173 (UI only)
- **Desktop app:** `pnpm build`, then from `src-tauri/`: `cargo run` — debug builds load the embedded `../dist`; at launch the shell spawns `agent-core/dist/main.js`, does the stdout ready-line handshake, and injects provider keys from Windows Credential Manager. A `pnpm tauri` script exists (`package.json`), but the documented path remains build-then-cargo.
