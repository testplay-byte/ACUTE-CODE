<!-- last-reviewed: 2026-08-24 round-33 -->
# Letta — Architecture Notes

> All claims below verified against the `archive` branch of `letta-ai/letta` (legacy Letta V1 server, `letta` v0.16.8), `letta-ai/letta-code`, and docs.letta.com on 2026-08-21.

## Repo disposition (important)

| Location | Contents | Status |
|---|---|---|
| `letta-ai/letta` `main` | Landing-page README + LICENSE | Active (docs only) |
| `letta-ai/letta` `archive` | Legacy Letta V1 API server: Python package `letta/`, `alembic/` migrations, fern API tooling (fern-check/SDK-publish workflows verified) | Archived, unsupported ("should not be used in production") |
| `letta-ai/letta-code` | Current TypeScript harness (Bun), terminal UI, `letta server` remote-env mode, channels, desktop apps, MemFS memory | Active development |

The V1 server is where the memory architecture lives; letta-code is where the product is heading (git-backed MemFS memory, "dreaming"). Per the "Our Next Phase" blog, sleep-time agents, multi-agent orchestration, and MCP move from server-side to client-side in letta-code.

## 1. Server / client split

Legacy V1 (archive branch):

- **Single Python process** (`letta.main:app`) hosting:
  - `letta/server/rest_api/` — versioned REST API. Routers under `routers/v1/` (35 files, counted via GitHub tree API): `agents`, `blocks`, `messages`, `runs`, `steps`, `conversations`, `tools`, `sources`, `passages`, `groups`, `jobs`, `mcp_servers`, `providers`, `llms`, `embeddings`, `users`, `organizations`, `health`, `tags`, `folders`, `identities`, `sandbox_configs`, `voice`, plus `internal_*` routers and an OpenAI-compat layer (`routers/openai/chat_completions.py`).
  - `letta/server/ws_api/` — WebSocket channel.
- **Persistence layer**: `letta/orm/` — SQLAlchemy 2 (async) + Alembic migrations. **Both SQLite and PostgreSQL supported**; `settings.py` defines `DatabaseChoice.POSTGRES | SQLITE` and **SQLite is the default when no `letta_pg_uri` is set**. SQLite support is real, not vestigial: dedicated baseline alembic schema, `letta/orm/sqlite_functions.py`, and a `core-unit-sqlite-test.yaml` CI workflow.
- **Manager layer** between routers and ORM (`letta/services/`): `agent_manager`, `block_manager` (+ `block_manager_git.py`), `message_manager`, `passage_manager`, `group_manager`, `run_manager`, `step_manager`, `job_manager`, `tool_executor/` (`core_tool_executor.py`, `mcp_tool_executor.py`, `sandbox_tool_executor.py`, ...), `summarizer/`, `memory_repo/`.
- **Clients**: `letta-client` SDKs (Python/TS) talk pure REST; agent state never lives client-side — clients are thin.

Current letta-code: same *shape* — a local process owns state; the terminal UI / desktop apps / channels are clients. This validates ACUTE-CODE's sidecar-owns-SQLite-over-localhost-REST+WS split.

## 2. Memory tiers and data model

Three tiers, split by **in-context vs out-of-context**:

| Tier | In context? | What it is | Unit / table |
|---|---|---|---|
| **Core memory (blocks)** | Yes — pinned into the system prompt | Labeled, size-budgeted editable text sections | `Block` / `blocks`, joined to agents via `blocks_agents` |
| **Recall memory (message history)** | No (older messages evicted/compacted) | Full persisted conversation; searched via `conversation_search` | `Message` / `messages`, `step`, `run` |
| **Archival memory** | No — query-on-demand | Vector-searchable long-term store ("a general-purpose vector DB in the Letta API"); passages are agent-immutable, taggable, unlimited | `Passage` / `passages`, `passage_tag`, `sources_agents` |

**Block ORM** (`letta/orm/block.py`, verified columns): `label` (unique id inside the prompt, e.g. `human`, `persona`), `value` (text), `limit` (character budget; schema default `CORE_MEMORY_BLOCK_CHAR_LIMIT = 100000`, docs examples use 4000–5000), `description` ("the main information used by the agent to determine how to read and write to that block"), `read_only` (default False — "whether the agent has read-only access to the block"), `hidden`, `metadata_` (JSON), plus **`version`** and `current_history_entry_id` → `block_history` (every edit versioned and auditable).

**Rendering**: `Memory.compile()` renders blocks into an XML-like `<memory_blocks>` wrapper with per-block `<label>`, `<description>`, `<metadata>` (chars_current / chars_limit) and `<value>`, prepended to the system prompt. The agent therefore always sees core memory and its remaining budget.

**Agent memory attachment** (`schemas/agent.py`): `CreateAgent.memory_blocks` (create fresh blocks inline) or `block_ids` (attach existing blocks — this is how sharing works). Blocks can also be attached/detached at runtime via agent-scoped REST.

**Persistence of everything** (docs, verified): all state — memories, user messages, reasoning, tool calls — is persisted in a database; "even after a compaction / eviction, historical messages remain retrievable — by developers through the API and by agents through retrieval tools."

**Notable ORM tables** (from `letta/orm/` listing): `agent`, `block`, `block_history`, `blocks_agents`, `message`, `passage`, `source`, `tool`, `run`, `step`, `conversation`, `group`, `job`, `user`, `organization`, plus join tables `groups_agents`, `groups_blocks`, `tools_agents`, `sources_agents`, `conversation_messages`. Alembic history confirms feature evolution, e.g. `74e860718e0d_add_archival_memory_sharing.py`, `6fe79c0525f2_enable_sleeptime_agent_fields.py`.

**Approval fields in Message ORM** (`letta/orm/message.py`, verified — directly relevant to ACUTE-CODE): every message row can carry `approval_request_id`, `approve`, `denial_reason`, and an `approvals` list; the agents router exposes `PATCH /{agent_id}/tools/approval/{tool_name}`. Tool approval is a server-side, persisted concept, not just UI state. Messages also carry `step_id`, `run_id`, `conversation_id`, `group_id`, `sender_id`, `sequence_id` (context-window ordering) and `is_err`.

## 3. Agent state persistence

- **Agent = server-side stateful resource.** `AgentState` persists: `agent_type` (enum, verified: `memgpt_agent` "the OG set of memgpt tools", `letta_v1_agent` "simplification of the memgpt loop, no heartbeats or forced tool calls", `react_agent`, `workflow_agent`, `split_thread_agent`, `sleeptime_agent`, `voice_convo_agent`, `voice_sleeptime_agent`), `blocks`, `tools`, `tool_rules`, `model` (provider/model handle), `tags`, `message_buffer_autoclear`.
- **Runs / steps / conversations** (docs, verified): one user invocation = a *run*; a run spans many *steps*, each one LLM inference pass plus tool execution. Conversations are independent message threads letting one agent serve many users concurrently.
- **Context management**: when the window fills, the `Summarizer` (`services/summarizer/`) compacts/evicts older messages — with `message_buffer_min`/`message_buffer_limit` and a `partial_evict` mode — but evicted messages remain queryable (recall tier). Core memory blocks stay because they live in the system prompt, not the message list.
- **`block_history`**: every block edit is versioned — memory changes are auditable and reversible (and `block_manager_git.py` exists alongside, hinting at the git-based direction).

## 4. Sleep-time agents and multi-agent

- `CreateAgent.enable_sleeptime` (verified docstring): "If set to True, memory management will move to a background agent thread." A dedicated `sleeptime_agent` shares the primary agent's blocks and rewrites/reorganizes them between interactions. Group config carries `sleeptime_agent_frequency` (`schemas/group.py`); `ManagerType` enum = `round_robin`, `supervisor`, `dynamic`, `sleeptime`, `voice_sleeptime`; implementations in `letta/groups/sleeptime_multi_agent*.py` (V1–V4). Current letta-code calls this **"dreaming"**: background subagents "review recent conversations, consolidate useful lessons, and update memory" (MemFS), triggered "after a set number of completed agent steps or when the context window is compacted", with an optional "Agent reviews before applying" mode (a second background conversation reviews proposed memory updates — more tokens, no user approval asked).
- **Shared blocks**: one block attached to multiple agents — "When one agent updates the block, all others see the change immediately." `read_only: true` yields policy/config blocks "agents can read but memory tools will refuse to modify" (read-only applies to the whole block, not per-agent). Concurrency guidance from the docs: append-style writes are concurrent-safe; full-block rewrites are last-write-wins — "Multiple agents doing memory_rethink on the same block simultaneously leads to lost updates"; designate one owner (or the sleep-time agent) for heavy edits. Documented patterns: `task_queue` (supervisor/workers), `domain_knowledge` (shared learnings), `handoff_context` (agent A writes, agent B reads), read-only `system_config` synced by external systems.
- **Cross-agent tools** (`functions/function_sets/multi_agent.py`, verified names): `send_message_to_agent_and_wait_for_reply`, `send_message_to_agent_async`, `send_message_to_agents_matching_tags`.

## 5. Tool / message flow (one run)

1. Client `POST /v1/agents/{id}/messages` (or the OpenAI-compat endpoint).
2. Server loads `AgentState`, compiles system prompt = base prompt + rendered `<memory_blocks>` (always in context).
3. Loop of **steps**: LLM inference → either `send_message` to user (end run) or a tool call.
4. **Memory tools** mutate state server-side. Verified in `functions/function_sets/base.py` (tool schemas/impls) and `services/tool_executor/core_tool_executor.py` (executor):
   - `memory` (view blocks), `core_memory_append(label, content)`, `core_memory_replace(label, old_content, new_content)`
   - newer file-like set: `rethink_memory`, `memory_rethink` (full block rewrite), `memory_replace` / `memory_insert` (precise string/line edits), `memory_apply_patch` — a **simplified unified-diff patch with codex-style multi-block extensions** (`*** Add/Update/Delete Block: <label>`, `*** Move to:`; fully implemented in the archive executor, including hunk normalization), `memory_finish_edits`; the executor additionally implements `memory_create`, `memory_str_replace`, `memory_str_insert`, `memory_rename`, `memory_delete`, `memory_update_description`
   - recall tier: `conversation_search(query, ...)` (with role/date filters)
   - archival tier: `archival_memory_insert(content, tags)`, `archival_memory_search(query, tags, ...)`
5. Tool results and assistant reasoning are persisted as `Message` rows (with step/run ids); block edits write `block_history`; messages may carry approval request/response fields.
6. If `enable_sleeptime`: the background sleep-time agent periodically replays recent messages and rewrites the shared blocks out-of-band, at `sleeptime_agent_frequency` cadence.

## Verified REST surface (selected routes, agents + blocks routers)

- `GET/POST /v1/agents`, `GET/PATCH/DELETE /v1/agents/{id}`, `GET /v1/agents/{id}/export`, `POST /v1/agents/import`
- `PATCH /v1/agents/{id}/tools/attach/{tool_id}` / `.../detach/{tool_id}`, `PATCH /v1/agents/{id}/tools/approval/{tool_name}`, `POST /v1/agents/{id}/tools/{tool_name}/run`
- `GET /v1/agents/{id}/core-memory` (deprecated) and `/core-memory/blocks[/{block_label}]` (GET/PATCH), `PATCH /v1/agents/{id}/core-memory/blocks/attach/{block_id}`
- Blocks as standalone resources: `GET/POST /v1/blocks`, `GET/PATCH/DELETE /v1/blocks/{id}`, and — the sharing keystone — `GET /v1/blocks/{id}/agents` (reverse lookup: which agents use this block)

## ASCII diagram

```
            CLIENTS (thin)                    LETTA SERVER (owns all state)
 .---------------------------.     REST/WS  .-------------------------------------------.
 | SDK (Python/TS)           |------------>>| REST API  /v1: agents blocks messages    |
 | letta-code TUI / desktop  |              |            runs steps groups sources ... |
 | channels (Slack/TG/Disc)  |<-------------| WS API    (streams)                      |
 '---------------------------'              |                    |                      |
                                            |   manager layer (agent/block/message/    |
                                            |   passage/group/run/step managers,       |
                                            |   core tool executor, summarizer)        |
                                            |                    |                      |
                                            |   SQLAlchemy / Alembic                  |
                                            |                    v                      |
                                            |  SQLite (default) | PostgreSQL+pgvector  |
                                            |  agents, blocks, block_history,         |
                                            |  messages(+approval fields), steps,     |
                                            |  runs, passages, sources, tools, groups |
                                            '-------------------------------------------'

 CONTEXT WINDOW per agent (compiled each run)
 .------------------------------------------------------------------.
 | SYSTEM PROMPT  = base prompt + <memory_blocks>  <<-- CORE MEMORY  |
 |                  (label/description/value, chars_current/limit,   |
 |                   always in context, agent-editable via tools)    |
 |------------------------------------------------------------------|
 | MESSAGES (in-context window; old ones compacted/evicted           |
 |           -> still persisted & searchable via conversation_search)|
 '------------------------------------------------------------------'
              |  page-in / page-out via tools
              v
   OUT-OF-CONTEXT: archival memory (passages, vector search,
   archival_memory_insert/search)  +  sleep-time agent rewrites
   shared blocks in the background between runs
```

## Sources

- https://github.com/letta-ai/letta
- https://raw.githubusercontent.com/letta-ai/letta/main/README.md
- https://github.com/letta-ai/letta/tree/archive (tree via GitHub API)
- https://raw.githubusercontent.com/letta-ai/letta/archive/pyproject.toml
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/settings.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/orm/block.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/orm/message.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/schemas/agent.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/schemas/group.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/functions/function_sets/base.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/functions/function_sets/multi_agent.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/services/tool_executor/core_tool_executor.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/server/rest_api/routers/v1/agents.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/server/rest_api/routers/v1/blocks.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/agents/letta_agent.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/constants.py
- https://github.com/letta-ai/letta-code
- https://raw.githubusercontent.com/letta-ai/letta-code/main/LICENSE
- https://docs.letta.com/guides/agents/memory
- https://docs.letta.com/v1-sdk/memory/memory-blocks/
- https://docs.letta.com/v1-sdk/memory/shared-memory/
- https://docs.letta.com/v1-sdk/memory/archival-memory/
- https://docs.letta.com/guides/agents/sleep-time-agents
- https://www.letta.com/blog/our-next-phase/
- https://www.letta.com/blog/sleep-time-compute/
- https://arxiv.org/html/2504.13171v1
