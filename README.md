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
- `pnpm verify` — lint + typecheck + test + build + license audit (mirrors CI)
- `pnpm dev` — frontend dev server on port 5173 (matches the tauri devUrl)
