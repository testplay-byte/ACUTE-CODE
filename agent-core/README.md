# agent-core

The Node/TypeScript sidecar process behind the ACUTE-CODE desktop shell. The
Tauri shell spawns it at startup (see `src-tauri/src/lib.rs`) and talks to it
over HTTP/WebSocket on `127.0.0.1:<ephemeral-port>`. Phase 2 Wave 1 is in
place: Fastify REST surface with bearer-token auth and the SQLite storage
layer. WebSocket and the remaining resources arrive in later waves.

## Module responsibilities

| Module | Responsibility | Status |
|---|---|---|
| `src/server.ts` | Fastify 5 app: `GET /health` (no auth), bearer-token wall on every other route (API.md §1), agents CRUD per API.md §4 (`/api/v1/agents`), uniform error envelope; `startServer()` binds loopback, prints the `ACUTE_READY {"port":…}` ready line | real (Wave 1) |
| `src/storage/db.ts` | `openDatabase(path)`: better-sqlite3 handle with WAL + `synchronous=NORMAL`, numbered SQL migrations applied transactionally and recorded in `schema_migrations`, one-time template seeding | real (Wave 1) |
| `src/storage/migrations/` | Versioned schema files (`0001_init.sql`, …) — schema v1: `agents`, `providers`, `sessions`, `session_events`, `usage_events`, `approvals`, `audit_log`, `settings` | real (Wave 1) |
| `src/storage/agents.ts` | Agent registry repository (list/get/create/update/duplicate/delete, JSON column mapping, version bumps); owns the canonical v1 tool-name list | real (Wave 1) |
| `src/storage/providers.ts` | Provider-existence lookups backing agent validation (full provider CRUD is a later wave) | real (Wave 1) |
| `src/approvals.ts` | Risk categorization (`auto`/`confirm`/`blocked`/`destructive`) | placeholder policy tables |
| providers/ | LLM provider adapters (Anthropic, OpenAI, local, ...) | later wave |
| agents/ | Per-agent runtime state, runner loop | later wave |
| orchestration/ | Run loop; single / auto-team / manual modes (ADR-0001) | later wave |
| tools/ | Tool implementations + permission wiring | later wave |

## Running

- `pnpm --filter agent-core test` — vitest (`tests/`, temp-dir databases, fastify `inject()`)
- `pnpm --filter agent-core typecheck` — tsc --noEmit (library sources)
- `pnpm --filter agent-core build` — emit `dist/` (and copy the SQL migrations next to it)

`agent-core` depends on the `shared` workspace package for domain types
(`workspace:*`) and on `better-sqlite3` (native addon; its build script is
allow-listed in `pnpm-workspace.yaml`).
