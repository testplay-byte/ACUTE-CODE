# agent-core

The Node/TypeScript sidecar process behind the ACUTE-CODE desktop shell. The
Tauri shell spawns it at startup (see `src-tauri/src/lib.rs`) and talks to it
over HTTP/WebSocket on `127.0.0.1:<ephemeral-port>`. Phase 2 Wave 2 is in
place: Fastify REST surface with bearer-token auth, the SQLite storage layer,
the env-keyed provider registry, and single-agent sessions/chat. WebSocket and
the remaining resources arrive in later waves.

## Module responsibilities

| Module | Responsibility | Status |
|---|---|---|
| `src/server.ts` | Fastify 5 app: `GET /health` (no auth), bearer-token wall on every other route (API.md §1), agents CRUD per API.md §4, providers per API.md §8 (`GET/POST /providers`, `GET /providers/:id/models`), single-agent sessions per API.md §5 (`POST/GET /sessions`, `GET /sessions/:id`, `POST /sessions/:id/messages`); uniform error envelope; `startServer()` binds loopback, prints the `ACUTE_READY {"port":…}` ready line | real (Waves 1–2) |
| `src/storage/db.ts` | `openDatabase(path)`: better-sqlite3 handle with WAL + `synchronous=NORMAL`, numbered SQL migrations applied transactionally and recorded in `schema_migrations`, one-time template seeding | real (Wave 1) |
| `src/storage/migrations/` | Versioned schema files — 0001: full v1 table set; 0002: `sessions.agent_id` column binding a session to its agent | real (Waves 1–2) |
| `src/storage/agents.ts` | Agent registry repository (list/get/create/update/duplicate/delete, JSON column mapping, version bumps); owns the canonical v1 tool-name list | real (Wave 1) |
| `src/storage/providers.ts` | Provider registry rows (list/get/create, reserved built-in ids, id slugification) — rows never contain keys | real (Wave 2) |
| `src/storage/sessions.ts` | Sessions, the append-only `session_events` log (per-session monotonic seq minted transactionally, ADR-0010), and `usage_events` billing lines | real (Wave 2) |
| `src/storage/usage.ts` | Daily usage aggregation over `usage_events` for `GET /api/v1/usage/summary` (dashboard chart): zero-filled ascending day buckets + totals | real (Wave 2) |
| `src/providers/registry.ts` | `ProviderKeyring` (in-memory snapshot of `ACUTE_PROVIDER_<ID_UPPER>` env vars — keys NEVER touch SQLite or any response), lazy built-in `openrouter` row, model-catalog fetch (`{baseUrl}/models`, 5-minute in-memory cache, sanitized `ProviderFetchError`) | real (Wave 2) |
| `src/agents/chat.ts` | `ChatFn` seam + `aiSdkChat`: the only module that touches the Vercel AI SDK (`generateText` via `@ai-sdk/openai-compatible`; agent `maxTurns` maps to `stopWhen(stepCountIs(n))` in SDK v7) | real (Wave 2) |
| `src/agents/runtime.ts` | Single-agent turn (ADR-0001 "single" mode): append user event → one provider call → append assistant event + usage row; 404/409/502 outcome mapping | real (Wave 2) |
| `src/approvals.ts` | Risk categorization (`auto`/`confirm`/`blocked`/`destructive`) | placeholder policy tables |
| orchestration/ | Run loop; auto-team / manual modes (ADR-0001) | later wave |
| tools/ | Tool implementations + permission wiring | later wave |

## Sessions & chat semantics (Wave 2)

- `POST /api/v1/sessions` `{agentId, mode:"single"}` → `202` session object,
  status `queued`; the first message flips it to `running`.
- `POST /api/v1/sessions/:id/messages` `{content}` runs the turn synchronously
  (the WS streaming shape from API.md §5.4 arrives with the WebSocket wave) and
  returns `{assistantMessage, usage}`. Event payloads are
  `{role, content, agentId, ts}`; the log is append-only and per-session `seq`
  is never reused, even across failed turns.
- Provider failures return `502 PROVIDER_ERROR` (details sanitized of key
  material); an agent without providerId/model, or a provider without a key,
  returns `409 CONFLICT`.

## Provider keys

Keys live only in the spawn environment as `ACUTE_PROVIDER_<ID_UPPER>`
(e.g. `ACUTE_PROVIDER_OPENROUTER`, injected by the shell per ARCHITECTURE §7);
the sidecar snapshots them into an in-memory keyring. Non-alphanumeric id
characters fold to `_` (`my-proxy` → `ACUTE_PROVIDER_MY_PROXY`). No route ever
returns a key — only `hasKey` booleans — and error strings are scrubbed.

## Running

- `pnpm --filter agent-core test` — vitest (`tests/`, temp-dir databases, fastify `inject()`, AI SDK module-mocked — no network, no real keys)
- `pnpm --filter agent-core typecheck` — tsc --noEmit (library sources)
- `pnpm --filter agent-core build` — emit `dist/` (and copy the SQL migrations next to it)

`agent-core` depends on the `shared` workspace package for domain types
(`workspace:*`), on `better-sqlite3` (native addon; its build script is
allow-listed in `pnpm-workspace.yaml`), and on `ai` + `@ai-sdk/openai-compatible`
(Apache-2.0; covered by the root `pnpm license:audit` allowlist).
