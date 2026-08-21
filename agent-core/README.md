# agent-core

The Node/TypeScript sidecar process behind the ACUTE-CODE desktop shell. The
Tauri shell spawns it at startup (see `src-tauri/src/lib.rs`) and talks to it
over HTTP/WebSocket. Phase 1 ships placeholders only — no runtime dependencies.

## Module responsibilities (target map)

| Module | Responsibility | Phase 1 status |
|---|---|---|
| `src/server.ts` | HTTP/WS API surface; `GET /health` liveness probe for the shell | placeholder |
| providers/ | LLM provider adapters (Anthropic, OpenAI, local, ...) | Phase 2+ |
| agents/ | Agent definitions, per-agent runtime state | Phase 2+ |
| orchestration/ | Run loop; single / auto-team / manual modes (ADR-0001) | Phase 2+ |
| tools/ | Tool implementations + permission wiring | Phase 2+ |
| `src/approvals.ts` | Risk categorization (`auto`/`confirm`/`blocked`/`destructive`) and the approval flow | placeholder policy tables |
| `src/storage/db.ts` | SQLite persistence entry point | placeholder (real driver lands Phase 2) |

## Scripts

- `pnpm --filter agent-core test` — vitest (`tests/`)
- `pnpm --filter agent-core typecheck` — tsc --noEmit (library sources)
- `pnpm --filter agent-core build` — emit `dist/`

`agent-core` depends on the `shared` workspace package for domain types
(`workspace:*` protocol).
