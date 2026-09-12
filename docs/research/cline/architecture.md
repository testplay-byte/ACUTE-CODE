<!-- last-reviewed: 2026-09-12 round-94 -->
# Cline — Architecture (verified against `main`, 2026-08-21)

## Process / Component Model

Cline is a family of **host applications** over one shared engine, with three runtime topologies plus an embedded-library mode.

### 1. VS Code extension (classic: extension host + webview)

- **Extension host process** — Node code in `apps/vscode/src`: `core/` (controller, task state, storage, prompts, webview messaging), `services/` (MCP hub, auth, telemetry, browser), `integrations/` (terminal, editor, diagnostics), `hosts/` (see below), `sdk/` (bridge onto the engine).
- **Webview process** — `apps/vscode/webview-ui`: standalone React 18 + Vite app (components/context/hooks/services). Talks to the host **only** via `postMessage`.
- **HostProvider DI** (`src/hosts/host-provider.ts`) — singleton injecting platform-specific factories (webview provider, edit preview, comment review, host bridge, OAuth callback URL, binary lookup, storage paths). Two implementations: `hosts/vscode` and `hosts/external` (non-VS Code hosts), so the same core runs under VS Code or standalone ("cline-core").
- **Protobus RPC** — host↔webview channel is a gRPC-style layer (`core/controller/grpc-handler.ts`): unary + streaming calls, `request_id` correlation, `grpc_response { message, request_id, is_streaming, sequence_number }` envelopes, cancellation via `GrpcRequestRegistry`, record/replay middleware (`GrpcRecorderBuilder`). Services are protobuf-defined (`proto/cline/*.proto` — e.g. `TaskService` with `newTask`, `askResponse`, `getTaskHistory`, `deleteAllTaskHistory`) with codegen'd handler maps per host.
- **No language server of its own.** Cline ships no LSP server; `proto/cline/common.proto` carries `FileDiagnostics`/`Diagnostic` types and `integrations/diagnostics` *consume* the host editor's language-service diagnostics, which are fed back into agent context.

### 2. CLI (`apps/cli`)

OpenTUI terminal app + headless JSON mode. Runs a local in-process runtime (`@cline/core`), optionally backed by a shared detached hub; TUI startup rule: render the first frame before any daemon/discovery/resume work.

### 3. SDK hub topology (strategic direction)

- `RuntimeHost` boundary (`sdk/packages/core/src/runtime/host.ts`) with three implementations: `LocalRuntimeHost` (in-process), `HubRuntimeHost` (shared local daemon), `RemoteRuntimeHost` (explicit endpoint). `ClineCore` delegates uniformly and never branches on local vs hub.
- **Hub daemon** — detached WebSocket server under `core/src/hub/` (`client/`, `server/`, `daemon/`, `discovery/`). Per-process cryptographically random auth token in an owner-only discovery record; constant-time comparison; token via `Sec-WebSocket-Protocol` (WS) or `Authorization: Bearer` (shutdown). Sessions owned by the hub survive client detach; multiple clients can attach to one session. Daemon identity = build fingerprint of runtime sources/manifests/lockfile; managed daemons converge on the newest compatible build.
- **Reference desktop deployment** (`apps/examples/desktop-app`): Tauri 2 shell + **Bun sidecar** (`Bun.serve` HTTP + WebSocket upgrade at `/transport`), per-launch `approvalToken` (checked with `timingSafeEqual`), origin allowlist, command dispatch (`handleCommand`) and server-pushed events (e.g. `tool_approval_state`). Also resolves the login shell's `PATH` at startup so agent-spawned children see user tools when launched from a GUI.

### 4. Embedded library (`@cline/sdk`)

`import { Agent } from "@cline/sdk"` — same engine as a library: `new Agent({ providerId, modelId, apiKey, tools })`, `agent.run(prompt)`, streaming via `agent.subscribe()`. `@cline/sdk` re-exports `@cline/core`.

## ASCII Diagram

```
 Host applications (process boundaries)
┌─────────────────────────────────────────────────────────────────────────┐
│  VS Code (apps/vscode)      CLI (apps/cli)      Desktop example         │
│  ┌────────────┐ postMessage ┌──────────┐        ┌────────────────────┐  │
│  │ React 18   │◄─GrpcRequest             OpenTUI │ Tauri shell        │  │
│  │ webview    │─►grpc_resp  │ Local    │        │  web UI            │  │
│  │ (Vite)     │  (proto/    │ runtime  │        │    │ HTTP + WS     │  │
│  └─────▲──────┘   cline/*)  └────┬─────┘        │    ▼ /transport   │  │
│        │                         │              │  Bun sidecar      │  │
│  ┌─────┴─────────────────────────┴──────────────┴───────────────────┐  │
│  │ Extension host / Node process(es):                               │  │
│  │  grpc-handler → Controller / SdkController bridge                │  │
│  │  HostProvider DI (vscode | external) → proto/host capabilities   │  │
│  │  (window · workspace · env · diff · testing)                     │  │
│  └───────────────────────────────┬──────────────────────────────────┘  │
└──────────────────────────────────┼──────────────────────────────────────┘
                                   ▼   (optional: hub daemon, WS, per-process token)
        ┌──────────────────── @cline/core (stateful) ────────────────────┐
        │ ClineCore · RuntimeHost (local|hub|remote) · sessions          │
        │ tools + tool-approval · settings · plugins(sandboxed) · cron   │
        │ storage: SQLite (tasks.db, cron.db) + ~/.cline task JSON files │
        │ MCP hub · git checkpoints · context compaction                 │
        └──────────┬──────────────────────────────────────┬──────────────┘
                   ▼                                      ▼
     ┌───────────────────────────┐          ┌───────────────────────────┐
     │ @cline/agents             │  uses    │ @cline/llms               │
     │ stateless agent loop      │────────► │ provider gateway ·        │──► cloud LLM APIs
     │ (agent-runtime.ts)        │          │ model catalogs            │    (Anthropic, OpenRouter,
     └───────────┬───────────────┘          └─────────────┬─────────────┘     OpenAI, Gemini, …)
                 ▼                                        ▼
     ┌───────────────────────────────────────────────────────────────────┐
     │ @cline/shared — types · schemas · hooks engine · path/storage      │
     │ helpers · prompt/parsing utilities (no upward deps)                │
     └───────────────────────────────────────────────────────────────────┘
```

## Module Map (verified paths)

| Path | Responsibility |
|---|---|
| `sdk/packages/shared` | Types/schemas, hook contracts/engine, path resolution, storage path helpers, remote-config primitives; depends on nothing above it |
| `sdk/packages/llms` | `catalog/`, `providers/`, `services/`; provider settings resolution, model manifests, gateway-style provider contracts (AI SDK-backed) |
| `sdk/packages/agents` | `agent-runtime.ts` — stateless loop: iteration, tool orchestration, event emission, turn preparation |
| `sdk/packages/core` | `ClineCore.ts`; `runtime/` (`host.ts`, `tools/tool-approval.ts`), `session/` (checkpoint-diff/restore, stores), `hub/` (client/server/daemon/discovery), `cron/`, `tasks/`, `settings/`, `extensions/` (`config/` watchers, `plugin/` sandboxing, `context/` compaction), `hooks/checkpoint-hooks.ts` |
| `sdk/packages/sdk` | Umbrella package re-exporting core (public npm surface) |
| `sdk/packages/ui` | Framework-neutral web components (`@cline/ui`) |
| `apps/vscode/src/core` | `controller/` — per-domain handlers (`mcp/`, `checkpoints/`, `models/`, `state/`, `marketplace/`, `slash/`, …) + `grpc-handler.ts`; `task/`, `storage/` (`StateManager.ts`, `disk.ts`), `webview/`, `prompts/`, `context/`, `mentions/`, `ignore/`, `locks/` |
| `apps/vscode/src/hosts` | `host-provider.ts` DI + `vscode/` and `external/` implementations |
| `apps/vscode/src/services` | `mcp/McpHub.ts` (+ OAuth manager, reconnect handler, schemas, settings lock), `auth/`, `telemetry/`, `browser/`, `feature-flags/` |
| `apps/vscode/src/sdk` | `SdkController.ts` bridge onto the engine: `message-translator`, `provider-migration`, `legacy-state-reader`, `sdk-tool-policies`, `sdk-checkpoints`, `sdk-compaction`, `cline-session-factory` |
| `apps/vscode/src/integrations` | terminal, editor (edit preview/comment review), diagnostics, openai-codex |
| `apps/vscode/proto` | `cline/` (17 webview services: task, mcp, state, checkpoints, models, marketplace, ui, web, slash, hooks, file, browser, account, …), `host/` (window, workspace, env, diff, testing) |
| `apps/vscode/webview-ui/src` | React UI: `components/`, `context/`, `hooks/`, `services/`, `lib/` |
| `apps/cli/src` | `commands/`, `runtime/` (`interactive/mode.ts`, `interactive/approvals.ts`, `tool-policies.ts`), `tui/`, `connectors/` |
| `apps/examples/desktop-app` | Tauri + Bun sidecar reference (see above) |

## Data Flow (one interactive turn)

1. User types in webview → `GrpcRequest` (proto `TaskService.newTask` / queued prompt) over `postMessage` → `grpc-handler.ts` resolves the codegen'd handler → `Controller` / `SdkController`.
2. Bridge translates app-level config into `StartSessionInput`; `@cline/core` `RuntimeHost.start(...)` builds the runtime (`DefaultRuntimeBuilder`: tools + hooks + extensions + watchers + telemetry).
3. `@cline/agents` runs the loop; provider calls go through `@cline/llms` handlers (streaming deltas, reasoning, tool calls).
4. Tool execution: built-in executors or host-contributed ones; approval-gated tools emit `ToolApprovalRequest` → policy check (per-tool autoApprove / master switch) → if not approved, an "ask" surfaces to the UI (`ClineAskResponse = "yesButtonClicked" | "noButtonClicked" | "messageResponse"` back via `TaskService.askResponse`).
5. Events stream back: tool start/update/finish with sequence numbers; `submit_and_exit` completion anchors `task.completed` telemetry.
6. Persistence: UI messages → `~/.cline/tasks/<id>/ui_messages.json`; provider transcript → `api_conversation_history.json`; task metadata/settings per task dir; SDK sessions persist lazily (no DB row until the first accepted user turn).

## Storage (verified)

- **Home dir `~/.cline`** (`getGlobalStorageDir`, `disk.ts`): `tasks/<id>/{ui_messages.json, api_conversation_history.json, task_metadata.json, settings.json}`; `cline_mcp_settings.json`; skills (`~/.cline/skills`, `~/.agents/skills`); user-facing fallbacks under `Documents/Cline/{Rules,Workflows,MCP,Hooks}`.
- **StateManager** — in-memory cache; reads disk only at init; writes debounced (500 ms) and batched per key group; documented multi-instance isolation caveat (each VS Code window keeps its own cache).
- **SQLite in SDK core** — `tasks.db` (agenda tasks; Markdown+frontmatter specs in `~/.cline/tasks/*.task.md` are editable intent, SQLite is operational truth), `cron.db` (schedules; separate DB by design), connector store; sessions use their own stores with a JSON messages artifact per session plus `${sessionId}.compaction.json` (hash-validated against the canonical transcript on resume).
- **Checkpoints** — git-native, in the user's repository: snapshot commits built with `git commit-tree` (including untracked-only commits), stored under a **private ref namespace** (not the user's visible stash/branches); restore runs as a transaction (`beginWorktreeRestoreTransaction`): capture current worktree via `stash push --include-untracked` behind a private ref → commit or rollback → `git clean -fd` + restore. Restore types: `task` | `workspace` | `taskAndWorkspace` (`ClineCheckpointRestore`, `checkpointRestore.ts`).

## Extension Points

- **Tools** — built-in registry (`core/extensions/tools`); plugins register tools programmatically; MCP servers contribute tools via `McpHub`.
- **Plugins** — sandboxed subprocesses, session-local, lazily recreatable; idle reclaim after 30 min without in-flight RPC (`CLINE_PLUGIN_IDLE_TIMEOUT_MS`); pending requests bound to the owning child generation.
- **Hooks** — lifecycle interception contracts in `@cline/shared/src/hooks`; engine shared by hosts.
- **File-watched config** — rules (`.clinerules`), workflows, skills, agents, hooks, plugins discovered via watchers; new instruction sources should "materialize into files" and reuse the watcher loader (design seam #1).
- **Providers** — isolated in `@cline/llms` gateway registry + model catalogs; hosts never hardcode provider behavior.
- **Host capabilities** — `proto/host/*` (window, workspace, env, diff, testing): what a host must provide for the core to run (VS Code, standalone, JetBrains-closed-source, CLI).
- **RuntimeHost / hub** — swap local ↔ hub ↔ remote execution without changing orchestration; client-contributed tool executors proxied through hub capability requests.

## Sources

- https://github.com/cline/cline/blob/main/sdk/ARCHITECTURE.md (layering, RuntimeHost, hub flows, design seams, agenda/cron, constraints — primary source)
- https://github.com/cline/cline/tree/main + recursive git tree via `api.github.com/repos/cline/cline/git/trees/main?recursive=1` (module map)
- `apps/vscode/src/hosts/host-provider.ts`, `src/core/controller/grpc-handler.ts`, `src/core/webview/WebviewProvider.ts`, `src/core/controller/checkpoints/checkpointRestore.ts`, `src/core/storage/StateManager.ts`, `src/core/storage/disk.ts`, `src/shared/WebviewMessage.ts` (raw fetches)
- `apps/vscode/proto/cline/task.proto`, `proto/cline/common.proto` (services, diagnostics types)
- `apps/cli/src/runtime/interactive/mode.ts`, `approvals.ts` (Plan/Act switch tool, approval controller)
- `sdk/packages/core/src/runtime/tools/tool-approval.ts`, `src/session/checkpoint-restore.ts`, `src/hooks/checkpoint-hooks.ts`
- `apps/examples/desktop-app/README.md`, `sidecar/server.ts`, `sidecar/commands.ts` (Tauri + Bun sidecar topology)
- https://github.com/cline/cline/blob/main/sdk/README.md, https://docs.cline.bot/cline-sdk/overview (embedded-library mode)
