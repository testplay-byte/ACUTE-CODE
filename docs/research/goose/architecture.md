<!-- last-reviewed: 2026-09-07 round-75 -->
# Goose — Architecture

Verified against `block/goose` `main` branch, 2026-08-21. Sources listed at end.

## Process model: UI process vs agent runtime

Goose separates **interface** from **agent** from **extensions** ("the interface, the agent, and the connected extensions" — `goose-architecture.md`). Concretely there are two OS processes in the desktop scenario:

1. **Desktop app (UI process)** — Electron 43 + React 19. Owns windows, settings UI, session list, extension toggles, permission prompts. Contains no agent logic.
2. **Agent runtime (`goose serve`, "goosed")** — headless Rust HTTP server spawned *by* the desktop as a child process. Owns the agent loop, MCP extension client connections, session database, provider credentials, scheduler.

The same `goose serve` binary can instead run on a remote machine and the desktop points at it (Settings → goose Server), which is why the protocol is network-grade (auth + TLS) even in the local case.

### Spawn and handshake (verified in `ui/desktop/src/gooseServe.ts`)

- Desktop locates the binary: `GOOSE_BINARY` env var (dev only) or `resourcesPath/bin/goose` (packaged).
- Spawns: `goose serve --platform desktop --enable-scheduler --host 127.0.0.1 --port <ephemeral>` (port picked by the UI via `listen(0)` then released). Optional `--tls`.
- Auth: UI generates a secret and passes it as `GOOSE_SERVER__SECRET_KEY` env; the runtime exposes `/acp` (Agent Client Protocol endpoint; desktop connects a websocket with the token as query param; an SSE stream is also available for probing), `/status`, `/health`. Remote clients send the secret via `X-Secret-Key` header.
- TLS mode: goosed prints `GOOSED_CERT_FINGERPRINT=<sha256>` on stdout within 5s; the UI pins it (trust-on-first-use if absent).
- Readiness: poll `/status` every 100ms, 30s deadline, 1s per-fetch abort; abort early on child exit or fatal stderr patterns (`panicked at`, `RUST_BACKTRACE`, `fatal error`).
- Teardown: SIGTERM → wait 5s → SIGKILL; on Windows `taskkill /pid <pid> /f /t`.
- Diagnostics: every startup phase emits events (`spawn_start`, `healthcheck_success`, `child_exit`, …) written to a diagnostics file surfaced in error messages.

### Lease registry (verified in `ui/desktop/src/gooseServeLeaseRegistry.ts`)

Each backend process is wrapped in a **lease** holding `acpUrl`, `secretKey`, `cleanup` handle, and the set of `windowIds` sharing it.

- `attachWindow(windowId, lease)` binds a window; `releaseWindow(windowId)` unbinds; **when the last window detaches, the backend is torn down** (idempotent cleanup guarded by a flag).
- A `process.once('exit')` listener marks the lease dead; any later `getAcpUrl` throws a user-facing "backend stopped, open a new chat" error instead of returning a stale URL.
- `createExternal(...)` wraps an externally-managed (remote) backend with no-op cleanup.

### Agent loop (verified in `goose-architecture.md`)

1. Human request → 2. provider chat (request + available-tools list) → 3. model emits tool call; **goose executes it** (the model "is capable of creating a tool call request but not able to execute it") → 4. tool result fed back to model → 5. context revision (prune/summarize stale content; find-replace file edits instead of rewrites; ripgrep to skip system files; condensed command output) → 6. final response. Errors (invalid JSON, missing tools) are returned to the model as tool responses for self-correction rather than crashing the loop.

## MCP tool integration (extension system)

Extensions are MCP servers. Verified from `crates/goose/src/agents/extension.rs` — `ExtensionConfig` is a serde-tagged enum (`tag = "type"`) with seven variants:

| Variant | Meaning |
|---|---|
| `Stdio` | Local subprocess MCP server (`cmd`, `args`, `envs`, `env_keys`, `timeout`, `cwd`) |
| `StreamableHttp` | Remote MCP over streamable HTTP; OAuth fields (`client_id`, `client_secret_key` — a keychain key, not the raw secret — `scopes`); optional HTTP-over-UDS `socket` |
| `Builtin` | Part of the bundled goose MCP server (e.g. Developer tools) |
| `Platform` | Runs **in the agent process** with direct agent access |
| `Frontend` | Tools implemented **by the UI**, called through the frontend |
| `InlinePython` | Ad-hoc Python `code` executed via `uvx`, with optional `dependencies` |
| `Sse` | **Deprecated** — "kept only for config file compatibility"; tools always unavailable |

Each extension contributes: tools (name, description, parameters, optional permission level), **prompt instructions** (`ExtensionInfo { name, instructions, has_resources }` feeds the system prompt builder), and `status()`. Extension activation is declarative (YAML in `~/.config/goose/config.yaml`):

```yaml
extensions:
  github:
    name: GitHub
    cmd: npx
    args: [-y @modelcontextprotocol/server-github]
    enabled: true
    envs: { "GITHUB_PERSONAL_ACCESS_TOKEN": "<TOKEN>" }
    type: stdio
    timeout: 300        # seconds goose waits for a tool call to complete
```

Lifecycle controls verified in docs (`using-extensions.md`): enable via `goose configure`, desktop toggles, session-start flags (`--with-builtin`, `--with-extension`, `--with-streamable-http-extension`), mid-session slash commands (`/extension ...`), and `goose://extension?...` deeplinks. Mid-session additions apply only to that session and prompt "goose would like to enable the following extension, do you approve?" — dynamic enable requires user approval.

Built-in MCP servers live in `crates/goose-mcp/src` (autovisualiser, computercontroller, memory, peekaboo, tutorial) plus platform extensions under `crates/goose/src/agents/platform_extensions`.

### Security gate

Before running package-execution commands, `extension_malware_check.rs` queries the OSV database (`api.osv.dev/v1/query`, 10s timeout) for `MAL-*` malicious-package advisories; it parses package names out of `npx`/`uvx` argv (npm scoped/versioned forms; PyPI PEP-503 normalization, extras, markers, `--from`). A confirmed match blocks execution with `ExtensionError::ConfigError`. Infrastructure failures **fail open** (see patterns doc — we will diverge here).

## Session storage and resume (verified in `session_manager.rs` + docs)

- SQLite via **sqlx**, WAL mode, 30s busy timeout, at `<data_dir>/sessions/sessions.db` (`~/.local/share/goose` on Linux). Since v1.10.0; replaced per-session `.jsonl` files (legacy files left on disk, unmigrated).
- Tables: `sessions` (metadata, token counts, recipe/model config JSON, `goose_mode`, `parent_session_id`), `messages` (`role`, `content_json`, `created_timestamp`, `message_id`, `metadata_json`), `usage_ledger` (per-request tokens, `cost`, `cost_source` ∈ {provider_reported, estimated, carried_forward}, `is_compaction`), `threads` / `thread_messages`, provider inventory, `schema_version` (currently 16, migration-based).
- **Write ordering is monotonic by construction**: insert clamps each message's timestamp forward so it never precedes the latest stored one; reads `ORDER BY created_timestamp, id`.
- Session IDs `YYYYMMDD_<count>`; CLI accepts `--name` or `--session-id`.
- Resume: `goose session -r [--name ...]` replays full history; `--resume --fork` copies history into a new session. Fork/duplicate = create new session, copy config/extension data, `DELETE FROM messages` + re-insert with fresh message UUIDs. Export to JSON (full fidelity) or Markdown; desktop-only import creates a new session. CLI and desktop share the same database — sessions are interoperable.

## Permission / prompting model for tool use

Three layers (verified from docs + `permission/` module):

1. **Global modes** (default is autonomous): `auto` ("Completely Autonomous" — no approvals; applied by default), `approve` (confirm every tool use), `smart_approve` (risk-based auto-approve of low-risk actions), `chat` (no extensions, talk only). Switchable mid-session via `/mode` or desktop UI.
2. **Per-tool tri-state overrides** grouped by extension: Always Allow / Ask Before / Never Allow. "The mode sets the default behavior, while tool permissions let you override the behavior of specific tools."
3. **Remembered decisions** (`permission_store.rs`): JSON at `<config_dir>/permissions/tool_permissions.json`, written atomically (temp file + rename). Records are keyed `tool_name:blake3(json(args))` with `allowed`, `readable_context`, `timestamp`, optional `expiry`; lookup takes the most recent non-expired record; expired records are pruned on load.

Prompting flow: the agent needs a verdict → `tool_confirmation_router.rs` `register(request_id)` creates a tokio oneshot and parks the awaiting task → the UI shows Allow/Deny → `deliver(request_id, PermissionConfirmation{principal_type, permission: AllowOnce|DenyOnce})` resolves it. No router-level timeout (callers wrap their own). The docs recommend keeping **fewer than 25 enabled tools** total (context cost + decision quality).

## Provider config

40+ providers. Config via desktop Models tab or `goose configure`; model override per session (`goose run --model ...`). API keys live in the OS keychain (fallback `secrets.yaml`); keys in `config.yaml` are ignored. Custom providers as JSON in `~/.config/goose/custom_providers/` (must be OpenAI-, Anthropic-, or Ollama-compatible; Windows path `%APPDATA%\Block\goose\config\custom_providers\`). Anthropic prompt caching auto-enabled. Also notable: external agents as **ACP providers** (Claude ACP, Codex ACP) and CLI providers (Cursor Agent) — goose hands its extensions over as MCP servers to them.

## Diagram

```
                       UI PROCESS (Electron + React 19)                AGENT RUNTIME PROCESS (Rust: `goose serve` = "goosed")
 ┌───────────────────────────────────────────────────────┐   ┌────────────────────────────────────────────────────────────┐
 │  windows / chat UI / settings / session history       │   │  /status /health  ── readiness probes from UI              │
 │  permission prompts (Allow / Deny)                    │   │  /acp  ── ACP endpoint (WS w/ token query / SSE)           │
 │  extension toggles, mode switcher                     │   │                                                            │
 │  gooseServe.ts         │  spawn child, random port,    │   │  ┌──────────────── agent loop ────────────────┐              │
 │   + LeaseRegistry ─────┼─ GOOSE_SERVER__SECRET_KEY ───▶│   │  │  user msg → provider → tool call → result   │              │
 │   (windows refcount;   │  goose serve --platform       │   │  │  → context revision → final answer          │              │
 │    last window kills   │  desktop --host 127.0.0.1     │   │  └───────┬──────────────────────────┬─────────┘              │
 │    backend)            │  --port <ephemeral> [--tls]    │   │          │                          │                        │
 │                       │                                │   │   MCP client connections     session ledger            │
 │                       │                                │   │          │                          │                        │
 │  ACP websocket ◀──────┼──────── http(s)://127.0.0.1:port/acp?token=… ──▶│                          │                        │
 │                       │                                │   │  ┌───────┴────────┐   ┌───────────┴─────────┐          │
 │  SIGTERM→SIGKILL      │                                │   │  │ extensions     │   │ SQLite sessions.db  │          │
│  (taskkill /f /t on   │                                │   │  │ (MCP servers)  │   │ sessions/messages/  │          │
│   Windows) on teardown│                                │   │  │ • stdio (npx…) │   │ usage_ledger (WAL)  │          │
└───────────────────────┴────────────────────────────────┘   │  │ • streamable   │   │ resume / fork-by-   │          │
                                                               │  │   http + OAuth │   │ copy                │          │
   Remote option: same UI can point at goosed on another       │  │ • builtin      │   └─────────────────────┘          │
   machine (X-Secret-Key + TLS cert-fingerprint pinning)       │  │ • platform     │                                    │
                                                               │  │ • frontend     │   permissions store (JSON):        │
                                                               │  │ • inline-python│   tool:blake3(args) → allow/deny    │
                                                               │  │ • sse (dead)   │   + OSV malicious-package gate     │
                                                               │  └────────────────┘                                    │
                                                               └────────────────────────────────────────────────────────────┘
```

## Sources

- https://raw.githubusercontent.com/block/goose/main/documentation/docs/goose-architecture/goose-architecture.md
- https://raw.githubusercontent.com/block/goose/main/documentation/docs/goose-architecture/extensions-design.md
- https://raw.githubusercontent.com/block/goose/main/ui/desktop/src/gooseServe.ts
- https://raw.githubusercontent.com/block/goose/main/ui/desktop/src/gooseServeLeaseRegistry.ts
- https://raw.githubusercontent.com/block/goose/main/documentation/docs/guides/remote-goose-server.md
- https://raw.githubusercontent.com/block/goose/main/crates/goose/src/agents/extension.rs
- https://raw.githubusercontent.com/block/goose/main/crates/goose/src/agents/extension_malware_check.rs
- https://raw.githubusercontent.com/block/goose/main/crates/goose/src/agents/tool_confirmation_router.rs
- https://raw.githubusercontent.com/block/goose/main/crates/goose/src/agents/subagent_handler.rs
- https://raw.githubusercontent.com/block/goose/main/crates/goose/src/session/session_manager.rs
- https://raw.githubusercontent.com/block/goose/main/crates/goose/src/permission/mod.rs
- https://raw.githubusercontent.com/block/goose/main/crates/goose/src/permission/permission_store.rs
- https://raw.githubusercontent.com/block/goose/main/documentation/docs/getting-started/using-extensions.md
- https://raw.githubusercontent.com/block/goose/main/documentation/docs/guides/sessions/session-management.md
- https://raw.githubusercontent.com/block/goose/main/documentation/docs/guides/managing-tools/goose-permissions.md
- https://raw.githubusercontent.com/block/goose/main/documentation/docs/guides/managing-tools/tool-permissions.md
- https://raw.githubusercontent.com/block/goose/main/documentation/docs/getting-started/providers.md
- https://raw.githubusercontent.com/block/goose/main/ui/desktop/package.json
- https://api.github.com/repos/block/goose/contents/ (and subpaths listed in README.md sources)
