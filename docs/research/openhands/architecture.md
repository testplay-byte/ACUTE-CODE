<!-- last-reviewed: 2026-08-24 round-28 -->
# OpenHands — Architecture

Verified 2026-08-21 against `OpenHands/OpenHands`, `OpenHands/software-agent-sdk`, `OpenHands/legacy`, and docs.openhands.dev. All class/file/endpoint names below are quoted from those sources; inferred items are marked.

## System components

The ecosystem separates **UI (Agent Canvas)** from **agent runtime (Software Agent SDK + Agent Server)**. Four Python packages make up the runtime: `openhands-sdk` (core), `openhands-tools` (BashTool, FileEditor, GrepTool, …), `openhands-workspace` (DockerWorkspace, RemoteAPIWorkspace), and `openhands-agent-server` (FastAPI HTTP/WebSocket server).

### 1. UI — Agent Canvas (`OpenHands/OpenHands`)

- Browser client (plus an Electron desktop build) that "connects to one or more backends that run the agent and its tools".
- Each conversation belongs to exactly one backend and has its own history, agent config, state, and workspace; conversations can be **branched** to explore alternatives while preserving the original.
- Backends "own execution and persistent state"; the client handles interaction only and can run standalone against remote servers. Transport evidence: `socket.io-client` and axios in package.json (docs defer transport detail to a separate page).
- ACP support lets Canvas drive non-OpenHands agents (Claude Code, Codex, Gemini CLI).

### 2. Server — `openhands-agent-server` (FastAPI)

Runs the SDK behind HTTP + WebSocket: `python -m openhands.agent_server --host --port`. Launched either directly or auto-spawned by `DockerWorkspace`/`RemoteAPIWorkspace`, which handle startup/teardown and hand the URL back to the client. Source layout (`openhands/agent_server/`): per-capability `*_router.py` modules — `conversation_router`, `event_router`, `bash_router`, `file_router`, `git_router`, `desktop_router`, `vscode_router`, `llm_router`, `mcp_router`, `skills_router`, `settings_router`, `sub_agents_router`, `tool_router`, `workspace_router(s)`, `auth_router`, `hooks_router`, `init_router`, `plugins_router`, `profiles_router`, `provider_connections_router`, `server_details_router` — plus services (`conversation_service.py`, `event_service.py`, `bash_service.py`, …), `pub_sub.py`, `sockets.py`, `conversation_lease.py`, `credential_binding.py`, and a `persistence/` package. **Persistence is flat JSON files, not a database** (verified from `persistence/store.py` imports — no sqlalchemy/sqlite3/aiosqlite anywhere): `settings.json`, `secrets.json`, `workspaces.json` written atomically (temp file + rename) with `fcntl` (Unix) / `msvcrt` (Windows) file locking, Pydantic validation, and optional `Cipher` encryption for secret fields; subdirectories `provider-connections/`, `profiles/`, `agent-profiles/`. Conversation runtime data also lives under a `workspace/` directory (`bash_events/`, `conversations/`, `project/`).

### 3. Agent layer — Conversation + Agent (`openhands-sdk`)

| Class | File | Role |
|---|---|---|
| `Conversation` | `conversation/conversation.py` | Factory entrypoint; "returns correct implementation based on workspace type" |
| `LocalConversation` | `conversation/impl/local_conversation.py` | Runs the agent directly in-process |
| `RemoteConversation` | `conversation/impl/remote_conversation.py` | Delegates to agent-server via HTTP/WebSocket |
| `ConversationState` | `conversation/state.py` | Pydantic model; the only mutable state in the system |
| `EventLog` | `conversation/event_store.py` | "Immutable append-only store with efficient queries" |

- `Conversation` = the controller: agent lifecycle ("initialize, run, pause, terminate"), state orchestration, workspace coordination. `Agent` = the reasoning-action loop only (LLM ↔ tools). Relationship is deliberately one-way: "Conversation → Agent: one-way orchestration, agent reports back via state events"; "Agent → Conversation: indirect via state events".
- Reasoning loop (docs sequence diagram): message → `Conversation` → `Agent` → LLM decision → tool call (`ActionEvent`) → tool executes in the workspace-configured environment → `ObservationEvent` → LLM → done → agent updates state → user reply.
- Auxiliary services (persistence, **stuck detection** via sliding-window pattern matching, visualization, secret registry) all attach as **read-only observers** of the event log: "read from the event log but never mutate state directly".
- Writes follow a two-path pattern under a FIFO lock: state-only updates (stats/status/metadata) vs event appends; "read operations never block writes"; persistence is debounced/incremental.
- Design principles (V1): optional isolation ("sandboxing should be opt-in, not universal"), stateless by default with exactly one mutable state, clear boundaries (apps talk to agents via APIs, never embedding), composability (agents are graphs of typed interchangeable components).

### 4. Runtime / Workspace abstraction

Current SDK: `Workspace` base class → `LocalWorkspace` (direct in-process execution) | `RemoteWorkspace`; concrete impls `DockerWorkspace` (spawns container running agent-server) and `RemoteAPIWorkspace` (connects via HTTP). Key boundary rule: **tools are not workspace calls** — tools "run alongside the agent in whatever environment the workspace configures"; the workspace only configures/provisions that environment. Same Agent + Tools + LLM code runs in all modes.

Legacy (archived) design — instructive contrast: `Runtime` abstract class (`connect()`, `send_action_for_execution()`) ← `ActionExecutionClient` (`_send_action_server_request()`) ← `DockerRuntime` / `LocalRuntime` / `RemoteRuntime`, all speaking REST to an `ActionExecutionServer` inside the sandbox (endpoints `/execute_action`, `/alive`) that orchestrates `BashSession`, `JupyterPlugin`, `BrowserEnv`. In the legacy model, `Agent`, `EventStream` (`Action`/`Observation` types), and `Runtime` were decoupled peers interacting only through the stream. The exact legacy `AgentController` finite-state-machine states are [UNVERIFIED] — that code was removed from the archive.

## Event model (event-sourced design)

The event system is an "immutable, type-safe event framework" forming an **append-only log** that is simultaneously the agent's memory, the LLM input source, the persistence unit, and the integration bus.

- Base: `Event` — immutable Pydantic model with `id`, `timestamp`, `source` (`user` | `agent` | `environment`).
- **LLM-convertible events** (implement `LLMConvertibleEvent.to_llm_message()`): `MessageEvent` (user/agent text), `ActionEvent` (tool call with `thought`, `reasoning_content`, **security-risk fields**), `ObservationEvent` (tool result, `role=tool`), `UserRejectObservation` (user rejected an action in confirmation mode), `AgentErrorEvent` (recoverable tool error; conversation continues), `SystemPromptEvent` (includes tool schemas), `CondensationSummaryEvent`.
- **Internal events** (never sent to the LLM): `ConversationStateUpdateEvent` (key/value state changes), `CondensationRequest` / `Condensation` (context compression with `forgotten_event_ids`, `summary`), `PauseEvent`.
- Error taxonomy: recoverable `AgentErrorEvent` (LLM-visible, tied to `tool_call_id`) vs fatal `ConversationErrorEvent` (run loop enters ERROR, `run()` raises `ConversationRunError`).

**Security gating on the event path** (from `sdk/arch/security.md`): every `ActionEvent` carries a `SecurityRisk` of LOW (read-only) / MEDIUM (modifies user data) / HIGH (dangerous) / UNKNOWN; the default `LLMSecurityAnalyzer` gets the risk *inline* — the LLM itself fills a `security_risk` parameter added to each non-read-only tool's schema (no separate analysis pass). A confirmation policy (`AlwaysConfirm` | `NeverConfirm` | `ConfirmRisky{threshold=HIGH, confirm_unknown=True}`, the default) maps risk → Require/Allow via `should_require_confirmation()`; when required the Conversation pauses, the human answers through `POST /conversations/{id}/events/respond_to_confirmation` (verified in `event_router.py`), and a rejection is recorded as the LLM-visible `UserRejectObservation` — the audit trail is the event log itself.
- Event→LLM pipeline: filter LLM-convertible → group `ActionEvent`s by `llm_response_id` (parallel tool calls merge into one assistant message with multiple `tool_calls`) → convert → `llm.format_messages_for_llm()` / `format_messages_for_responses()`.
- `Event.source` (attribution) and LLM `role` (formatting) are intentionally independent — docs warn "do not infer event origin from LLM role".

## REST API surface (verified endpoints)

Verified from the router sources (`conversation_router.py`, `event_router.py`, `sockets.py`):

**Operational (unauthenticated):** `GET /health`, `GET /ready`, `GET /server_info`, `GET /docs` (OpenAPI).

**`/conversations` router (25 routes):**

| Method + path | Purpose |
|---|---|
| `POST /conversations` | Create conversation (with initial user message) |
| `GET /conversations` (batch via `ids` query) / `GET /conversations/search` / `GET /conversations/count` | List / search / count |
| `GET /conversations/{id}` / `PATCH` / `DELETE` | Fetch / update / delete |
| `POST /conversations/{id}/run` / `/pause` / `/interrupt` | Execution control |
| `POST /conversations/{id}/events/respond_to_confirmation` | **Deliver the human approve/deny decision** |
| `POST /conversations/{id}/confirmation_policy` / `/security_analyzer` | Swap safety policy at runtime |
| `POST /conversations/{id}/secrets` / `/switch_profile` / `/switch_llm` / `/switch_acp_model` / `/load_plugin` | Config changes |
| `POST /conversations/{id}/goal` / `/goal/stop` / `/goal/resume` / `/ask_agent` / `/condense` / `/fork` / `/navigate` | Goals, Q&A, context compaction, branching |
| `GET /conversations/{id}/agent_final_response` | Final answer |

**`/conversations/{id}/events` router:** `GET` (list) / `POST` (inject event) / `GET /{event_id}` / `GET /search` / `GET /count`.

**WebSockets (`sockets.py`, prefix `/sockets`):**

- `WS /sockets/events/{conversation_id}` — live event stream. Query params: `session_api_key`, `resend_mode=all|since`, `after_timestamp` (cursor-based replay on reconnect), deprecated `resend_all`. Client can also send JSON `Message` frames upstream through the same socket.
- `WS /sockets/bash-events` — terminal event stream; accepts `ExecuteBashRequest` frames.
- Backed by `pub_sub.py`; a `MaxSubscribersError` closes the socket with code 1013.

Auth/config: `X-Session-API-Key` header validated against indexed keys `OH_SESSION_API_KEYS_0…N` (rotation; `SESSION_API_KEY` legacy alias); CORS via `OH_ALLOW_CORS_ORIGINS_0…`; `OH_SECRET_KEY` encrypts secrets stored with conversations (LLM API keys etc.) and must survive restarts. `conversation_lease.py` / `credential_binding.py` exist in source; purposes inferred (lease-based exclusive conversation access; binding credentials to sessions) — [UNVERIFIED]. An OpenAI-compatible gateway exists (docs guide `agent-server/openai-gateway`, `openai/` dir in source); exact mount path `/v1/chat/completions` [UNVERIFIED].

## State persistence

```
<persistence_dir>/<conversation_id>/
├── base_state.json                 # rewritten wholesale on every change
└── events/
    ├── event-00000-<event-id>.json # one JSON file per event, zero-padded seq
    ├── event-00001-<event-id>.json
    └── ...
```

- `base_state.json` holds agent configuration, execution status (idle/running/paused — `paused` survives restarts), iteration/max_iterations counters, statistics (tokens, calls, accumulated cost), workspace context, activated skills, secrets, `agent_state`.
- Auto-save with zero manual calls: a custom `__setattr__` on `ConversationState` detects public-field mutations, serializes immediately, fires callbacks. Events append incrementally; restore lazy-loads event files.
- **Resume** = construct a new `Conversation` with the same `conversation_id` + `persistence_dir`; the next `run()` continues from saved state; cost metrics carry over via `llm.metrics.accumulated_cost`.
- Trajectory reuse: glob `event-*.json` → `Event.model_validate_json()` → filter `LLMConvertibleEvent` → `events_to_messages()` → LLM formatters.

## ASCII diagram

```
                 +------------------------------------------+
                 |        Agent Canvas  (OpenHands/OpenHands)|
                 |  React 19 UI  |  Electron desktop  |  CLI  |
                 +-------------------+----------------------+
                                     |  REST (control)  +  WS/Socket.IO (events)
                                     v
+---------------------------------------------------------------------------+
|                    Agent Server (openhands-agent-server, FastAPI)          |
|  REST: /conversations...  /conversations/{id}/events...  /api/* (auth)     |
|  WS:   /sockets/events/{id} (resend_mode=since&after_timestamp)           |
|  /v1/chat/completions (OpenAI-compatible gateway)                          |
|  JSON stores (settings/secrets/workspaces) | pub_sub | leases | redaction |
+-------------------+-------------------------------------------------------+
                    | SDK calls (RemoteConversation)  or in-process (Local)
                    v
+---------------------------------------------------------------------------+
|  Conversation  (controller: lifecycle, state, persistence)                |
|  ├── ConversationState   (the ONLY mutable state -> base_state.json)      |
|  ├── EventLog            (append-only immutable events -> events/*.json)  |
|  └── read-only observer services: persistence, stuck-detection,          |
|       visualization, secret registry                                      |
|        |                                                                  |
|        v one-way orchestration (agent reports back via state events)      |
|  Agent (reasoning-action loop)  <->  LLM (provider-agnostic, retry)       |
|    | ActionEvent (tool call + thought + security risk)                     |
|    v                    ObservationEvent (tool result) -> back to loop     |
|  Tools (BashTool, FileEditor, Grep, MCP...)                               |
|    | run alongside the agent in the environment the workspace configures   |
+----+----------------------------------------------------------------------+
     v
  Workspace abstraction:   LocalWorkspace   |   DockerWorkspace (spawns
  (agent code unchanged)   in-process       |   container w/ agent-server)
                                          |   RemoteAPIWorkspace (HTTP)
```

Delegation sits on top as a tool: `TaskToolSet` (see patterns doc) lets a parent agent spawn/resume sub-agent conversations synchronously.

## Sources

- https://docs.openhands.dev/sdk/arch/overview.md
- https://docs.openhands.dev/sdk/arch/conversation.md
- https://docs.openhands.dev/sdk/arch/events.md
- https://docs.openhands.dev/sdk/arch/agent-server.md
- https://docs.openhands.dev/sdk/arch/design.md
- https://docs.openhands.dev/sdk/arch/workspace.md
- https://docs.openhands.dev/sdk/arch/security.md
- https://docs.openhands.dev/sdk/guides/convo-persistence.md
- https://docs.openhands.dev/sdk/guides/agent-server/overview.md
- https://docs.openhands.dev/sdk/guides/agent-server/local-server.md
- https://docs.openhands.dev/openhands/usage/agent-canvas/overview.md
- https://docs.openhands.dev/openhands/usage/architecture/backend
- https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-agent-server/openhands/agent_server/conversation_router.py
- https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-agent-server/openhands/agent_server/event_router.py
- https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-agent-server/openhands/agent_server/sockets.py
- https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-agent-server/openhands/agent_server/persistence/store.py
- https://api.github.com/repos/OpenHands/software-agent-sdk/contents/openhands-agent-server/openhands/agent_server
- https://github.com/OpenHands/software-agent-sdk/tree/main/openhands-agent-server/openhands/agent_server
- https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-agent-server/pyproject.toml
- https://github.com/OpenHands/software-agent-sdk
- https://github.com/All-Hands-AI/OpenHands
- https://github.com/OpenHands/legacy
- https://docs.openhands.dev/
- https://docs.openhands.dev/llms.txt
- https://www.openhands.dev/blog/the-path-to-openhands-v1
