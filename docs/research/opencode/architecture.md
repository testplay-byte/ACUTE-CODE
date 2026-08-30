<!-- last-reviewed: 2026-08-30 round-53 -->
# OpenCode — Architecture

Verified against `github.com/anomalyco/opencode` (branch `dev`) and `opencode.ai/docs/` on 2026-08-21. Anything not directly observed is marked [UNVERIFIED].

## Process model: one stateful server, many thin clients

- `opencode` (no args) starts a **server and attaches a TUI client** to it in one process; the TUI normally binds a random port but accepts `--hostname`/`--port`.
- `opencode serve` runs a **headless server**: `--port` (default 4096), `--hostname` (default `127.0.0.1`), `--cors <origin>` (repeatable, for browser clients), `--mdns`/`--mdns-domain`. If a TUI is already running, `serve` spawns an *additional* server instance.
- Server binds loopback by default. Optional **HTTP Basic auth**: set `OPENCODE_SERVER_PASSWORD` (username via `OPENCODE_SERVER_USERNAME`, defaults to `opencode`).
- **OpenAPI 3.1 spec served at `GET /doc`** (routes built with `HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" })`); docs state the SDK clients are generated from this spec.
- Other clients — desktop (Electron beta), web (`opencode web`), IDE plugins, SDK programs — are pure API consumers. IDE plugins additionally drive a live TUI through dedicated `/tui/*` endpoints (prefill/submit prompt, open dialogs, toasts, `tui/control/next` + `tui/control/response` request-response pair).

## ASCII diagram

```
                 ┌───────────────────────────────────────────────────────────┐
                 │            opencode server (TypeScript / Bun)            │
                 │                                                           │
                 │  packages/core (@opencode-ai/core, Effect services)       │
                 │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
                 │  │ session/ │ │ tool/    │ │permission│ │ provider/    │  │
                 │  │ runner,  │ │ bash,edit│ │ allow/   │ │ AI SDK pkgs  │  │
                 │  │ compaction│ │ read,grep│ │ ask/deny │ │ + models.dev │  │
                 │  │ revert   │ │ webfetch │ │ engine   │ │ catalog      │  │
                 │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬───────┘  │
                 │       └────────────┴─────┬──────┴───────────────┘         │
                 │                     event bus                             │
                 │       ┌─────────────────┴──────────────────┐              │
                 │  packages/server: Effect Http router      │              │
                 │  REST (OpenAPI 3.1 @ /doc)   SSE /event   │              │
                 │       │                          │        │              │
                 │  SQLite opencode.db (Drizzle,   │        │── LLM APIs ──► cloud
                 │  WAL, migrations)               │        │
                 └───────┼──────────────────────────┼────────┴──────────────┘
                         │ REST + SSE               │
        ┌────────────────┼──────────┐───────────────┼───────────────┐
        │                │          │               │               │
  ┌─────┴─────┐   ┌──────┴────┐ ┌───┴─────┐ ┌───────┴────┐ ┌────────┴────┐
  │ TUI       │   │ Web app   │ │ Electron│ │ IDE plugins│ │ SDK programs│
  │ OpenTUI + │   │ opencode  │ │ desktop │ │ (also call │ │ @opencode-ai│
  │ SolidJS   │   │ web       │ │ (beta)  │ │ /tui/* to  │ │ /sdk (gen   │
  │ packages/ │   │ packages/ │ │ packages│ │ drive TUI) │ │ from spec)  │
  │ tui       │   │ app, web  │ │ /desktop│ └────────────┘ └─────────────┘
  └───────────┘   └───────────┘ └─────────┘
        every client is a pure consumer of http://127.0.0.1:4096 + SSE /event
```

## Monorepo module map (`packages/`, 32 dirs, verified listing)

| Package | Role (verified / inferred) |
|---|---|
| `opencode` | CLI binary (`bin/opencode`): boots server + TUI; deps include MCP SDK, ACP SDK, `web-tree-sitter` (bash/powershell), `ws`, `yargs` |
| `core` (`@opencode-ai/core`) | Domain core: session/ (runner, compaction, revert, store, sql), permission/, tool/, database/, event/, plugin/, project/, pty/, skill/, share/, oauth/, credential/, observability/, plus root modules (`agent.ts`, `provider.ts`, `models-dev.ts`, `snapshot.ts`, `git.ts`, …) |
| `server` (`@opencode-ai/server`) | HTTP API: `api.ts` (contract), `handlers/`, `middleware/`, `auth.ts`, `cors.ts`, `routes.ts` |
| `protocol` | Shared API schema/types consumed by server + SDK codegen (role inferred from name + docs) |
| `tui` (`@opencode-ai/tui`) | Terminal client: OpenTUI + SolidJS |
| `app`, `web` | Web client(s) |
| `desktop` (`@opencode-ai/desktop`) | Electron 42 + SolidJS shell |
| `sdk`, `sdk-next` | Published SDK; generated from the OpenAPI spec (per docs/server) |
| `plugin` (`@opencode-ai/plugin`) | Plugin TypeScript types |
| `llm` | LLM abstraction over the AI SDK (pulls in the `ai` package) |
| `schema` | Shared schema package |
| `ui`, `session-ui` | Shared SolidJS UI components |
| `effect-drizzle-sqlite`, `effect-sqlite-node` | Effect wrappers for Drizzle/SQLite on Bun and Node |
| `cli`, `client` | [UNVERIFIED] auxiliary CLI/client packages |
| `codemode`, `console`, `containers`, `enterprise`, `function`, `github-copilot` (in core/src), `http-recorder`, `httpapi-codegen`, `identity`, `slack`, `stats`, `storybook`, `script` | Ancillary: console/stats apps, enterprise features, OpenAPI codegen tooling, HTTP recording for tests |

## API surface (from docs/server — the live OpenAPI spec is at `/doc`)

**Global / infrastructure**
- `GET /global/health` — health/version
- `GET /global/event` — SSE stream of global events
- `GET /event` — SSE stream of bus events; **first event `server.connected`**, then all events
- `GET /project` (list projects), `GET /project/current`, `GET /path`, `GET /vcs`
- `POST /instance/dispose`, `GET /doc` (OpenAPI 3.1), `POST /log` `{service, level, message, extra}`

**Config & providers**
- `GET /config`, `PATCH /config`, `GET /config/providers`
- `GET /provider` → `{all, default, connected}`; `GET /provider/auth`
- `POST /provider/{id}/oauth/authorize`, `POST /provider/{id}/oauth/callback`; `PUT /auth/:id` (set credentials matching provider schema)

**Sessions** (`/session`, per-session `/session/:id/...`)
- CRUD: `GET /session`, `POST /session` `{parentID?, title?}`, `GET/PATCH/DELETE /session/:id`
- `GET /session/status`, `/children`, `/todo`, `/diff?messageID=` → `FileDiff[]`
- Actions: `POST /init` (analyze app, generate AGENTS.md), `/fork` `{messageID?}`, `/abort`, `/share` + `DELETE /share`, `/summarize` `{providerID, modelID}`, `/revert` `{messageID, partID?}` + `/unrevert`
- **Approvals: `POST /session/:id/permissions/:permissionID`** body `{response, remember?}` — the programmatic human-in-the-loop reply

**Messages**
- `GET /session/:id/message?limit=`, `POST /session/:id/message` `{messageID?, model?, agent?, noReply?, system?, tools?, parts}`; response shape `{info: Message, parts: Part[]}`
- `GET /session/:id/message/:messageID`, `POST /prompt_async` (202-style, returns 204), `/command` `{command, arguments...}`, `/shell` `{agent, command}`

**Tools, search, integrations**
- `GET /experimental/tool/ids`, `GET /experimental/tool?provider=&model=` (tools + JSON schemas)
- `GET /find?pattern=`, `/find/file?query=`, `/find/symbol?query=`, `GET /file?path=`, `/file/content`, `/file/status`
- `GET /lsp`, `GET /formatter`, `GET /mcp` (status map), `POST /mcp` `{name, config}` (dynamic MCP add)
- `GET /agent`, `GET /command`

**TUI remote control** (used by IDE plugins)
- `POST /tui/append-prompt`, `/submit-prompt`, `/clear-prompt`, `/open-help`, `/open-sessions`, `/open-themes`, `/open-models`, `/execute-command` `{command}`, `/show-toast` `{title?, message, variant}`
- `GET /tui/control/next` (long-poll for control request) + `POST /tui/control/response` `{body}`

**Event names** (from docs/plugins): `server.connected`, `session.created/updated/deleted/error/idle/status/compacted/diff`, `message.updated/removed`, `message.part.updated/removed`, `permission.asked`, `permission.replied`, `file.edited`, `file.watcher.updated`, `lsp.updated`, `lsp.client.diagnostics`, `command.executed`, `installation.updated`, `todo.updated`, `shell.env`, `tool.execute.before/after`, `tui.prompt.append`, `tui.command.execute`, `tui.toast.show`.

## Data flow (one user turn)

1. Client POSTs a message to `/session/:id/message` (or `/prompt_async`), selecting `agent` + `model`.
2. Core resolves the agent (markdown/JSON definition merged with defaults), its permission set, and the provider (`providerID/modelID` → AI SDK package instance + models.dev limits).
3. The session runner loops: LLM call → tool calls intercepted by (a) plugin `tool.execute.before` hooks (may mutate args or throw to block), then (b) the permission engine (allow = run, deny = block, ask = pause).
4. An "ask" persists a permission request; `permission.asked` is emitted on the event bus → SSE → all clients. The TUI shows once/always/reject (with a suggested safe pattern); programmatic clients reply via `POST /session/:id/permissions/:id` `{response, remember?}`; `permission.replied` unblocks the runner.
5. Approved tools execute in the server process (bash via PTY/spawn, edits with snapshot/diff support — `snapshot.ts`, `revert.ts`); outputs stream back as `message.part.updated` events.
6. Everything (sessions, messages, parts, todos) persists to SQLite; compaction/summarize/title hidden agents run server-side when needed.
7. Clients re-render purely from REST reads + SSE events; no client owns state.

## Storage design (verified from source)

- Single SQLite DB: `~/.local/share/opencode/opencode.db` (XDG data dir; `Global.Path.data`), or `opencode-<channel>.db` when running a non-prod release channel (`OPENCODE_DISABLE_CHANNEL_DB=1` opts out); `OPENCODE_DB` env or `:memory:` override.
- Connection pragmas set at init: `journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 5000`, `cache_size = -64000`, `foreign_keys = ON`. Failures are fatal (`Effect.orDie`).
- Schema via generated migrations (`migration.gen.ts`, `schema.sql.ts`, `schema.gen.ts`) through `@opencode-ai/effect-drizzle-sqlite`; runtime-adaptive driver (`sqlite.bun.ts` = `@effect/sql-sqlite-bun` on Bun; `sqlite.node.ts` for Node). A root `data-migration.sql.ts` handles legacy-data migration [details UNVERIFIED — pre-SQLite JSON-file layout inferred from migration naming].
- Credentials: `~/.local/share/opencode/auth.json`. Config: `opencode.json` / `~/.config/opencode/opencode.jsonc` (JSONC, merged global→project).
- Session domain modules in `packages/core/src/session/`: `runner/`, `execution/`, `store.ts`, `sql.ts`, `schema.ts`, `compaction.ts`, `revert.ts`, `history.ts`, `projector.ts`, `run-coordinator.ts`, `todo.ts`, `prompt.ts`, `message*.ts` — an event-sourced-flavored design [exact internals UNVERIFIED beyond file names].

## Sources

- https://opencode.ai/docs/server/
- https://opencode.ai/docs/plugins/
- https://opencode.ai/docs/providers/
- https://opencode.ai/docs/permissions/
- https://opencode.ai/docs/agents/
- https://opencode.ai/docs/windows-wsl
- https://opencode.ai/docs/ (index)
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/server/src/routes.ts
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/server/package.json
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/package.json
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/database/database.ts
- https://api.github.com/repos/anomalyco/opencode/contents/packages?ref=dev
- https://api.github.com/repos/anomalyco/opencode/contents/packages/core/src?ref=dev
- https://api.github.com/repos/anomalyco/opencode/contents/packages/core/src/session?ref=dev
- https://api.github.com/repos/anomalyco/opencode/contents/packages/core/src/database?ref=dev
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/tui/package.json
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/desktop/package.json
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/package.json
- https://raw.githubusercontent.com/anomalyco/opencode/dev/package.json
- https://raw.githubusercontent.com/anomalyco/opencode/dev/LICENSE
- https://api.github.com/repos/anomalyco/opencode
- https://api.github.com/repos/sst/opencode
- https://api.github.com/repos/opencode-ai/opencode
- https://registry.npmjs.org/opencode-ai/latest
