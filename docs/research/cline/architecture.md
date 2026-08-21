# Cline — Architecture (verified against `main`, 2026-08-21)

## Process / Component Model

Cline is not a single process. Today it is a family of **host applications** on top of a shared
agent core, with three distinct runtime topologies:

### 1. VS Code extension (classic topology: extension host + webview)

- **Extension host process** — Node-side code in `apps/vscode/src`. Entry `extension.ts`, DI via
  `registry.ts`/`config.ts`. Contains `core/` (controller, task state, storage, prompts, webview
  messaging, workspace/ignore handling), `services/` (MCP, auth, telemetry, browser, feature
  flags), `integrations/` (terminal, editor, diagnostics, misc, openai-codex), `hosts/`
  (host-provider abstraction with `vscode` and `external` implementations so the same core can
  run under non-VS Code hosts).
- **Webview process** — `apps/vscode/webview-ui`, a standalone React 18 + Vite + Tailwind v4 +
  Radix/shadcn app (react-virtuoso, react-markdown, mermaid, Storybook). Talks to the host only
  via `postMessage` envelopes (`WebviewMessage.ts` / `ExtensionMessage.ts` in `src/shared`).
- **Protobus RPC** — the host↔webview channel is wrapped in a gRPC-style layer
  (`core/controller/grpc-handler.ts`): unary + streaming calls, `request_id` correlation,
  `grpc_response { message, request_id, is_streaming, sequence_number }` envelopes, cancellation
  through a `GrpcRequestRegistry`, and a `GrpcRecorderBuilder` middleware that records every
  request/response for debugging/replay. Service handler maps are **codegen** (`@generated/hosts/
  vscode/protobus-services`), implying one generated set per host.
- **No language server.** Cline does not run an LSP server as its backbone [verified: no
  `vscode-language-client` in the manifests consulted; `integrations/diagnostics` *consumes* the
  host editor's diagnostics rather than providing its own]. Editor-specific intelligence comes
  from the host IDE; Cline adds its own file search/read tooling.

### 2. SDK hub-spoke topology (the strategic direction)

Documented in `docs/sdk/architecture/hub-spoke.mdx` and `sdk/ARCHITECTURE.md`:

- **Hub** — "Singleton daemon per machine. Coordinates sessions, routes events and approvals."
  Never runs the agent loop. Listens on `127.0.0.1:25463`, logs to `~/.cline/logs/hub-daemon.log`,
  discovered via lock files in `~/.cline/locks/hub/owners/`, auto-started by `ClineCore` if
  absent.
- **Spokes** — "Worker process running `@cline/core`" executing the agent loop and tools;
  "owned by the daemon, not by any client," so they survive client exit.
- **Clients** — any UI (CLI, webview, IDE plugin) connecting to the hub over **WebSocket**;
  "clients participate, spokes execute, the hub coordinates"; spokes never talk to clients
  directly.
- **Backend modes:** `auto` (prefer hub, fall back to in-process), `hub` (require), `remote`
  (server-hosted hub for teams), `local` (pure in-process, no daemon).
- A gRPC-based RPC sidecar also exists for scheduled agents and cross-process sessions
  [sdk/README.md]; the hub is the coordination plane, spokes the execution plane.

### 3. Alternate hosts

JetBrains plugin (closed source; client to the shared core), ACP mode for Cursor/Windsurf/Zed/
Neovim [docs/cline-overview.mdx], headless CLI with JSON output for CI/CD.

## Module Map

```
cline/cline (Bun workspace)
├── apps/
│   ├── vscode/                     # VS Code extension
│   │   ├── src/
│   │   │   ├── extension.ts        # activation entry
│   │   │   ├── registry.ts, config.ts, common.ts   # DI wiring
│   │   │   ├── core/
│   │   │   │   ├── controller/     # gRPC-style command handlers
│   │   │   │   │   ├── task/       # newTask, showTaskWithId, askResponse, exportTaskWithId,
│   │   │   │   │   │               #   editMessageAndRegenerate, deleteAllTaskHistory, ...
│   │   │   │   │   ├── checkpoints/# checkpointRestore, checkpointViewLatestChanges, ...
│   │   │   │   │   ├── mcp/, file/, browser/, models/, state/, ui/, web/, worktree/, slash/
│   │   │   │   │   └── grpc-handler.ts + grpc-request-registry.ts + grpc-recorder/
│   │   │   │   ├── task/           # task execution internals (focus-chain, tools)
│   │   │   │   ├── storage/        # StateManager.ts, disk.ts, state-migrations.ts
│   │   │   │   ├── api/            # provider facade (index.ts; providers live in @cline/llms)
│   │   │   │   ├── prompts/, context/, mentions/, ignore/, locks/, hooks/, webview/, workspace/
│   │   │   ├── hosts/              # host-provider abstraction (vscode | external)
│   │   │   ├── services/           # mcp/McpHub.ts, auth, telemetry, browser, feature-flags...
│   │   │   ├── integrations/       # terminal, editor, diagnostics, openai-codex
│   │   │   ├── shared/             # ExtensionMessage/WebviewMessage types, AutoApprovalSettings,
│   │   │   │                       #   model-catalog, providers, combineApiRequests...
│   │   │   ├── standalone/, sdk/, exports/, packages/, utils/, types/
│   │   └── webview-ui/             # React 18 app (own package.json, Vite, Storybook)
│   ├── cli/                        # headless/interactive CLI (own CHANGELOG)
│   ├── cline-hub/, vscode-rollout/, examples/
├── sdk/
│   ├── ARCHITECTURE.md             # source of truth for SDK design
│   └── packages/
│       ├── shared/                 # @cline/shared: types, zod schemas, hooks engine, registry
│       ├── llms/                   # @cline/llms: providers, model catalogs, gateway contracts
│       ├── agents/                 # @cline/agents: stateless loop, tool exec, streaming events
│       ├── core/                   # @cline/core: ClineCore, sessions, storage, hub, cron,
│       │                           #   plugins/extensions, compaction (session/ dir with
│       │                           #   checkpoint-diff, checkpoint-restore, session-snapshot,
│       │                           #   session-versioning-service, stores/ JSON+manifest)
│       ├── sdk/                    # @cline/sdk umbrella (re-exports core)
│       └── ui/                     # shared UI components
└── docs/                           # mdx docs (provider-config, features, sdk, mcp, ...)
```

Layering rule (sdk/ARCHITECTURE.md): `shared → llms → agents → core → hosts`, packages may only
import packages below them; hosts are thin. The stateless `Agent` (constructor: `providerId`,
`modelId`, `tools`, `onEvent`) has no persistence; `ClineCore.create()` adds sessions, built-in
tools (bash, editor, read_files, apply_patch, search, fetch_web), SQLite persistence, `.cline/`
config discovery, and the RPC sidecar.

## Data Flow (one user turn, extension topology)

1. User types in webview → `WebviewMessage` via postMessage → protobus dispatch (unary or
   streaming, `request_id` assigned).
2. `core/controller/task/newTask.ts` creates the task; `StateManager` provides merged settings
   (precedence: **remote config > session override > task settings > global settings**).
3. `@cline/agents` loop: system prompt (mode-dependent) + tool schemas → provider call via
   `@cline/llms` → streamed `content_update` / `content_start` (tool) / `usage` events.
4. Tool call → policy check (auto-approve category? MCP tool auto-approve? `requires_approval`
   model flag for commands) → if gated: `askResponse.ts` handler parks the run until the human
   answers in the webview.
5. Tool executes (file edit via editor integration, terminal command, MCP tool via McpHub, ...).
6. **After every tool use** a checkpoint commits workspace state into the shadow git repo.
7. Results feed back into the conversation; UI events stream back through protobus
   (`sequence_number`-ordered, streams held open); `combineApiRequests` / `combineCommandSequences`
   group raw messages for display.
8. On completion: task persisted (own directory), telemetry (`task.completed`), webview updated.

## Storage

| Data | Mechanism (verified) |
|---|---|
| Settings/secrets | `StateManager`: in-memory cache, 500 ms debounced **batched** writes to file-backed stores behind a `StorageContext` abstraction — explicitly *not* VS Code globalStorage/SecretStorage ("Do NOT access VSCode's ExtensionContext for storage"); secrets kept in a separate encrypted-at-rest-by-OS secrets store; multi-window staleness accepted by design (instances read disk only at init) |
| Settings precedence | remote config > session override (never persisted) > task settings > global |
| Task history | Split into "its own file" (StateManager); per-task "unique identifier and dedicated storage directory" with token/cost/time metadata; fuzzy search index in webview (fuse.js/fzf); favorites protected from deletion; export via `exportTaskWithId`. Classic per-task files `api_conversation_history.json` / `ui_messages.json` **[UNVERIFIED in current tree — pre-migration format; the data has since moved toward SDK session storage]** |
| SDK sessions | SQLite index + JSON snapshots under `~/.cline/data/sessions/`; manifest is authoritative for resolved workspace paths; `session-versioning-service` for upgrades; root-session DB row created lazily on first user turn |
| Compaction | Canonical transcript kept full-fidelity; compaction is a separate `{sessionId}.compaction.json` artifact with hash validation (recompaction produces identical output — deterministic) |
| Checkpoints | Shadow git repo per workspace, separate from project git; commit after **every tool use**; includes files not tracked by git; persists across editor sessions; restore = files and/or conversation rewind |
| Agenda/automation | SQLite as operational source of truth + Markdown spec files (YAML frontmatter) as user-editable intent, reconciled by watcher/reconciler/materializer; agenda rows track `approvedRevision` so edits revoke prior approval |

## Extension Points

1. **Custom tools** — `createTool({ name, description, inputSchema (zod|JSON Schema), execute })`;
   passed as `tools` (Agent) or `extraTools` (ClineCore session config).
2. **Plugins** — `AgentPlugin` manifests declaring capabilities (`["tools","hooks"]`); `setup()`
   receives an API with `registerTool`; lifecycle hooks `beforeRun`, `beforeTool`, `afterRun`
   (tool name, iteration count, token usage).
3. **MCP servers** — JSON config file `{ mcpServers: { ... } }`, zod-validated, `${env:VAR}`
   expansion; stdio / SSE / streamable-HTTP transports; OAuth via `McpOAuthManager`;
   auto-approve list per tool name; `tools/list_changed` triggers debounced, generation-guarded
   refresh and an SDK session restart with updated tools.
4. **Tool policies** — `toolPolicies: { [tool]: { autoApprove: boolean } | { enabled: false } }`
   (unlisted tools default enabled + auto-approved).
5. **Host provider** — `hosts/host-provider.ts` abstraction (`vscode` | `external`) so the same
   controller code serves VS Code, JetBrains, and standalone runtimes.
6. **Rules & skills** — `.clinerules` files and skill directories discovered from the workspace,
   consistent across CLI/VS Code/JetBrains.
7. **Remote/enterprise config** — remote-config service can override settings and enforce MCP
   server policy (allowlists, re-adding deleted managed servers).

## ASCII Diagram

```
        ┌────────────────────────────── SDK / daemon topology ─────────────────────────────┐
        │                                                                                   │
  ┌───────────┐  WS    ┌──────────────────────────┐        ┌──────────────────────────┐    │
  │ CLI client│◄──────►│                          │        │        Hub daemon        │    │
  └───────────┘        │                          │        │ 127.0.0.1:25463          │    │
  ┌───────────┐  WS    │   Clients participate    │        │  coord only, no loop     │    │
  │ Webview/UI│◄──────►│   Spokes execute         │        └─────┬──────────────┬─────┘    │
  └───────────┘        │   Hub coordinates        │              │              │          │
  ┌───────────┐  WS    │                          │        ┌─────▼─────┐  ┌─────▼─────┐    │
  │IDE plugin │◄──────►│                          │        │  Spoke 1  │  │  Spoke 2  │    │
  └───────────┘        └──────────────────────────┘        │@cline/core│  │@cline/core│    │
        ▲                                                 │ agent loop│  │ agent loop│    │
        │                                                 └─────┬─────┘  └─────┬─────┘    │
        │ postMessage (protobus: request_id,                     │              │          │
        │ streaming+seq, cancel registry)                        ▼              ▼          │
  ┌─────┴────────────┐                                   ┌────────────────────────────┐      │
  │ VS Code webview  │                                   │      cloud LLM APIs        │      │
  │ React 18 (Vite)  │                                   │ Anthropic/OpenAI/Google/   │      │
  └──────────────────┘                                   │ Bedrock/OpenRouter/...     │      │
  ┌────────────────────┐   McpHub: stdio/SSE/HTTP        └────────────────────────────┘      │
  │  Extension host    │◄─────────────────────┐          ┌────────────────────────────┐      │
  │  controller/task/  │                      │          │ ~/.cline/data/sessions/    │      │
  │  services/ (MCP)   │              ┌───────┴────────┐ │ SQLite index + JSON snaps  │      │
  │  storage/ StateMgr │              │  MCP servers   │ │ + {id}.compaction.json     │      │
  └─────────┬──────────┘              └────────────────┘ └────────────────────────────┘      │
            │ shadow git: commit after EVERY tool use                                       │
            ▼                                                                             │
   workspace files ── checkpoints (compare / restore files / restore task / restore both)   │
        └───────────────────────────────────────────────────────────────────────────────┘
```

## Sources

- https://github.com/cline/cline/blob/main/sdk/ARCHITECTURE.md (via raw.githubusercontent.com)
- https://github.com/cline/cline/blob/main/docs/sdk/architecture/hub-spoke.mdx
- https://github.com/cline/cline/blob/main/sdk/README.md
- https://github.com/cline/cline/blob/main/docs/cline-overview.mdx
- https://github.com/cline/cline/blob/main/apps/vscode/src/core/controller/grpc-handler.ts
- https://github.com/cline/cline/blob/main/apps/vscode/src/core/storage/StateManager.ts
- https://github.com/cline/cline/blob/main/apps/vscode/src/services/mcp/McpHub.ts
- https://github.com/cline/cline/blob/main/apps/vscode/webview-ui/package.json
- https://github.com/cline/cline/blob/main/docs/core-workflows/checkpoints.mdx
- https://github.com/cline/cline/blob/main/docs/core-workflows/task-management.mdx
- https://github.com/cline/cline/blob/main/docs/sdk/tools.mdx
- https://api.github.com/repos/cline/cline/contents/apps/vscode/src (+ core, core/controller,
  core/controller/task, core/controller/checkpoints, core/storage, hosts, services,
  services/mcp, integrations, shared; sdk, sdk/packages, sdk/packages/core,
  sdk/packages/core/src, sdk/packages/core/src/session, sdk/packages/core/src/session/stores,
  sdk/examples; apps; docs subfolders)
- https://github.com/cline/cline (README: monorepo status, JetBrains closed source)
