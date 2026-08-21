# OpenCode — Architecture

Verified against `github.com/anomalyco/opencode` (branch `dev`) and `opencode.ai/docs/` on 2026-08-21. Anything not directly observed is marked `[UNVERIFIED]`.

## Process model: one server, many thin clients

OpenCode's core is a single **TypeScript server process** ("opencode core", package `@opencode-ai/opencode`) that owns everything stateful: sessions, messages, agent definitions, tool execution, LLM provider calls, MCP/LSP connections, permissions, storage. Every user-facing surface is a **client** of its local HTTP API:

- `opencode` (no args) starts a server **and** attaches a TUI client to it; the TUI normally binds a random port but accepts `--hostname`/`--port`.
- `opencode serve` starts a **headless** server (flags: `--port` 4096 default, `--hostname` 127.0.0.1, `--cors <origin>` repeatable, `--mdns`, `--mdns-domain`). If a TUI is already running, `serve` spins up a *separate* server instance.
- The desktop app, web console, and IDE extensions connect the same way; IDE plugins additionally drive a live TUI through dedicated `/tui/*` endpoints.
- The published SDK (`@opencode-ai/sdk`) offers both modes: `createOpencode({hostname, port})` boots server+client together; `createOpencodeClient({baseUrl})` attaches to an existing instance.

The server binds loopback by default. Optional auth: HTTP basic auth enabled by setting `OPENCODE_SERVER_PASSWORD` (username defaults to `opencode`, override `OPENCODE_SERVER_USERNAME`). OpenAPI 3.1 spec is served at `GET /doc` and is the input for SDK generation.

```
                 ┌────────────────────────────────────────────────────────┐
                 │        opencode server  (TypeScript / Bun)             │
                 │  packages/opencode/src:                                 │
                 │  session/ agent/ tool/ permission/ provider/ mcp/ lsp/ │
                 │  bus/ (in-process event bus)  storage/  plugin/        │
                 │        │                    │                          │
                 │   Effect HTTP router   JSON-file store (legacy)        │
                 │   + OpenAPI 3.1        Drizzle/SQLite tables (new)     │
                 │        │                                                │
                 │   REST endpoints    SSE /event (+WS tracker on dev)    │
                 └───────┬──────────────┬──────────────┬──────────────────┘
                         │ HTTP + SSE   │              │
              ┌──────────┴───┐  ┌───────┴──────┐  ┌────┴─────────┐
              │ TUI client   │  │ Desktop app  │  │ IDE / Web /  │
              │ OpenTUI +    │  │ packages/    │  │ SDK clients  │
              │ SolidJS      │  │ desktop      │  │ @opencode-ai │
              │ packages/tui │  │              │  │ /sdk (gen)   │
              └──────────────┘  └──────────────┘  └──────────────┘
                         all clients are pure API consumers
```

## Monorepo module map (packages/, 32 dirs)

| Package | Role |
|---|---|
| `opencode` | Core server: 36 src modules — `account, acp (Agent Client Protocol), agent, auth, background, bus, cli, command, config, control-plane, effect, env, format, git, id, ide, image, installation, lsp, mcp, patch, permission, plugin, project, provider, question, server, session, share, skill, snapshot, storage, sync, tool, util, worktree` |
| `server` | HTTP server support layer (incl. CORS helper `@opencode-ai/server/cors` used by core) |
| `tui` | Terminal client, OpenTUI + SolidJS (`.tsx`), v1.18.x |
| `client` / `sdk` / `sdk-next` | Client libraries; `client` is **code-generated** from the API spec via `httpapi-codegen` |
| `protocol`, `schema` | Shared protocol/type definitions — the single source both server routes and clients derive from |
| `core` | New shared core incl. Drizzle SQL table definitions (`session/sql`, `project/sql`, `account/sql`, …) |
| `llm` | LLM abstraction layer |
| `plugin` | Plugin types (`@opencode-ai/plugin`) |
| `desktop`, `web`, `console`, `ui`, `session-ui` | GUI surfaces and shared UI |
| `effect-drizzle-sqlite`, `effect-sqlite-node` | SQLite via Drizzle, wrapped in Effect |
| `httpapi-codegen` | Generates server/client code from the protocol |
| `cli`, `app`, `function`, `slack`, `enterprise`, `identity`, `stats`, `codemode`, `containers`, `http-recorder`, `storybook`, `script`, `docs` | Supporting packages |

## Server implementation (from `src/server/server.ts`)

- Framework: **Effect v4-beta HTTP stack** — `NodeHttpServer` from `@effect/platform-node`, `HttpRouter`/`HttpServer` from `effect/unstable/http`, OpenAPI from `effect/unstable/httpapi`. No Hono.
- Routes are declared in `routes/instance/httpapi/` and mounted via `HttpApiApp.createRoutes(opts)`; only a `disposeMiddleware` is attached here; CORS options (`@opencode-ai/server/cors`) flow through `opts`.
- Port resolution: explicit `0` prefers 4096, then any free port; graceful shutdown with 1s timeout; `closeAllConnections()` on force-stop, plus tracked WebSocket connections (`WebSocketTracker`) closed together.
- mDNS publish when enabled and hostname is not loopback.
- An in-process `webHandler()` lets tests/clients call the API without a socket.
- The in-process event bus lives in `src/bus/`; `event-manifest.ts` and `event-v2-bridge.ts` at src root suggest an event-schema versioning/bridging effort `[partially UNVERIFIED — files observed, contents not read]`.

## API surface (documented endpoints, quoted exactly)

Serve default base `http://127.0.0.1:4096`; spec at `GET /doc`.

- **Global/system:** `GET /global/health` (health+version) · `GET /global/event` (SSE) · `GET /path` · `GET /vcs` · `POST /instance/dispose` · `POST /log` (`{service, level, message, extra?}`)
- **Events:** `GET /event` — main SSE bus stream; first event is `server.connected`, then bus events
- **Config:** `GET /config` · `PATCH /config` · `GET /config/providers`
- **Projects:** `GET /project` · `GET /project/current`
- **Providers/auth:** `GET /provider` · `GET /provider/auth` · `POST /provider/{id}/oauth/authorize` · `POST /provider/{id}/oauth/callback` · `PUT /auth/:id`
- **Sessions:** `GET /session` · `POST /session` (`{parentID?, title?}`) · `GET /session/status` · `GET/DELETE/PATCH /session/:id` · `GET /session/:id/children` · `GET /session/:id/todo` · `POST /session/:id/init` · `POST /session/:id/fork` · `POST /session/:id/abort` · `POST|DELETE /session/:id/share` · `GET /session/:id/diff` · `POST /session/:id/summarize` · `POST /session/:id/revert` · `POST /session/:id/unrevert` · **`POST /session/:id/permissions/:permissionID`** (respond to a permission request)
- **Messages:** `GET /session/:id/message` (`limit?`) · `POST /session/:id/message` (send-and-wait) · `GET /session/:id/message/:messageID` · `POST /session/:id/prompt_async` (fire-and-forget, 204) · `POST /session/:id/command` (slash command) · `POST /session/:id/shell`
- **Files/search:** `GET /find?pattern=` · `GET /find/file?query=` · `GET /find/symbol?query=` · `GET /file?path=` · `GET /file/content?path=` · `GET /file/status`
- **Introspection:** `GET /agent` · `GET /command` · `GET /lsp` · `GET /formatter` · `GET /mcp` · `POST /mcp` (`{name, config}` — add MCP server at runtime) · `GET /experimental/tool/ids` · `GET /experimental/tool?provider=&model=`
- **TUI remote control (used by IDE plugins):** `POST /tui/append-prompt` · `POST /tui/submit-prompt` · `POST /tui/clear-prompt` · `POST /tui/execute-command` · `POST /tui/show-toast` · `POST /tui/open-help|sessions|themes|models` · `GET /tui/control/next` · `POST /tui/control/response`

SDK surface mirrors this: sessions CRUD, `session.prompt()` (with `noReply` and `json_schema` structured output), `event.subscribe()` async iteration.

## Data flow (one turn of conversation)

1. Client `POST /session/:id/message` (or `prompt_async`) with text/parts.
2. `session/` module assembles the prompt (`prompt.ts`, `instruction.ts`, `system.ts`), applies agent config (`agent/`) — `build` grants tool access, `plan` denies edits and asks before bash.
3. Request routed through `provider/` to the chosen `provider/model-id` via the Vercel AI SDK (`llm.ts`, `session/llm/`); reasoning/retry handled in `retry.ts`, overflow in `overflow.ts`.
4. Model tool calls hit `tool/` + `permission/`: permission config evaluated (bash `command` filters → allow/ask/deny); if `ask`, a `permission.asked` event flows over `/event` and the client answers via `POST /session/:id/permissions/:permissionID` (`permission.replied`).
5. Tool executions emit lifecycle events; every mutation is published on the bus and streamed to all connected clients (message.updated, message.part.updated, session.idle, …).
6. Long sessions are compacted (`compaction.ts`, hooks `experimental.session.compacting`); snapshots/revert via `snapshot/`, `revert.ts`.

## Storage design

**Legacy (verified from `storage/storage.ts`):** a JSON-file store under `<global-data>/storage/`, one pretty-printed JSON per entity, keys are path segments:

- `session/<projectID>/<sessionID>.json` · `message/<sessionID>/<messageID>.json` · `part/<messageID>/<partID>.json` · `project/<projectID>.json` · `session_diff/<sessionID>.json`
- API: `read/write/remove/list/update(key: string[])`; `update` is read-modify-write under a **per-file reentrant lock** (`RcMap` + `TxReentrantLock`).
- Numbered `MIGRATIONS` array with a `<dir>/migration` marker file storing the completed index; migration 1 imports legacy `../project` data using the git root-commit hash as a stable project ID; migration 2 extracts `summary.diffs` into separate files.

**Current direction (verified from `storage/schema.ts` + package layout):** Drizzle SQLite tables re-exported from `@opencode-ai/core` — `SessionTable, MessageTable, PartTable, TodoTable, AccountTable, AccountStateTable, ControlAccountTable, ProjectTable, SessionShareTable, WorkspaceTable` — supported by dedicated `effect-drizzle-sqlite` / `effect-sqlite-node` packages. I.e., the entity model (session → message → part, plus todo/project/account) survives; the substrate moves to SQLite. Auth credentials live separately in `~/.local/share/opencode/auth.json`.

## Config model

`opencode.json` / `opencode.jsonc`; global at `~/.config/opencode/opencode.json`, project at repo root; `.opencode/` directory holds `agents/ commands/ modes/ plugins/ skills/ tools/ themes/`. Files are **merged, not replaced**, in precedence order: remote (`.well-known/opencode`) < global < `OPENCODE_CONFIG` < project < `.opencode` dirs < inline `OPENCODE_CONFIG_CONTENT` < managed config < MDM mobileconfig (not user-overridable). Schema: `https://opencode.ai/config.json`. Top-level keys include `model`, `small_model`, `provider`, `agent`, `default_agent`, `subagent_depth`, `permission`, `mcp`, `plugin`, `lsp`, `formatter`, `snapshot`, `compaction`, `share`, `instructions`, `experimental`. Values support `{env:VAR}` and `{file:path}` indirection.

## Sources

- https://github.com/anomalyco/opencode
- https://opencode.ai/docs/server/
- https://opencode.ai/docs/sdk/
- https://opencode.ai/docs/config/
- https://api.github.com/repos/anomalyco/opencode/contents/packages?ref=dev
- https://api.github.com/repos/anomalyco/opencode/contents/packages/opencode/src?ref=dev
- https://api.github.com/repos/anomalyco/opencode/contents/packages/opencode/src/storage?ref=dev
- https://api.github.com/repos/anomalyco/opencode/contents/packages/opencode/src/session?ref=dev
- https://api.github.com/repos/anomalyco/opencode/contents/packages/opencode/src/server?ref=dev
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/storage/storage.ts
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/storage/schema.ts
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/server/server.ts
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/client/package.json
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/tui/package.json
