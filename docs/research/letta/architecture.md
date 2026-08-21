# Letta — Architecture Notes

> All claims below verified against the `archive` branch of `letta-ai/letta` (legacy Letta V1 server, `letta` v0.16.8), `letta-ai/letta-code`, and docs.letta.com on 2026-08-21.

## Repo disposition (important)

| Location | Contents | Status |
|---|---|---|
| `letta-ai/letta` `main` | Landing-page README + LICENSE | Active (docs only) |
| `letta-ai/letta` `archive` | Legacy Letta V1 API server: Python package `letta/`, `alembic/` migrations, `fern/` API definition, Docker/compose | Archived, unsupported |
| `letta-ai/letta-code` | Current TypeScript harness, terminal UI, App Server (`letta server`), channels, MemFS memory | Active development |

The V1 server is where the memory architecture lives; letta-code is where the product is heading (MemFS git-backed memory, "dreaming").

## 1. Server / client split

Legacy V1 (archive branch):

- **Single Python process** (`letta.main:app`) hosting:
  - `letta/server/rest_api/` — versioned REST API. Routers under `routers/v1/` (35 files, verified): `agents`, `blocks`, `messages`, `runs`, `steps`, `conversations`, `tools`, `sources`, `passages`, `groups`, `jobs`, `mcp_servers`, `providers`, `llms`, `embeddings`, `users`, `organizations`, `health`, `tags`, `folders`, `identities`, `sandbox_configs`, `voice`, plus `internal_*` routers and an OpenAI-compat layer (`routers/openai/chat_completions`, `chat_completions.py`).
  - `letta/server/ws_api/` — WebSocket channel.
- **Persistence layer**: `letta/orm/` — SQLAlchemy 2 (async) + Alembic migrations; SQLite and PostgreSQL both supported (`sqlite` / `postgres` extras). A manager layer (`letta/services/`: `agent_manager`, `block_manager`, `message_manager`, `passage_manager`, `group_manager`, `run_manager`, `step_manager`, `job_manager`, `tool_executor/`, `summarizer/`, `memory_repo/`) sits between routers and ORM.
- **Clients**: `letta-client` SDKs (Python/TS) talk pure REST; agent state never lives client-side — clients are thin.

Current letta-code: same *shape* — a local "App Server" owns state; the terminal UI / desktop apps / channels are clients. This validates ACUTE-CODE's sidecar-owns-SQLite-over-localhost-REST+WS split.

## 2. Memory tiers and data model

Three tiers, split by **in-context vs out-of-context**:

| Tier | In context? | What it is | Unit / table |
|---|---|---|---|
| **Core memory (blocks)** | Yes — pinned into the system prompt | Labeled, size-budgeted editable text sections | `Block` / `blocks`, joined to agents via `blocks_agents` |
| **Recall memory (message history)** | No (older messages evicted/compacted) | Full persisted conversation; searched via `conversation_search` (hybrid text + semantic, with date/role filters) | `Message` / `messages`, `step`, `run` |
| **Archival memory** | No — query-on-demand | Vector-searchable long-term store for facts/knowledge the agent inserts deliberately | `Passage` / `passages`, `passage_tag`, `sources_agents` |

**Block schema** (`letta/schemas/block.py`, verified fields): `label` (unique id inside the prompt, e.g. `human`, `persona`), `value` (text), `limit` (character budget, default `CORE_MEMORY_BLOCK_CHAR_LIMIT`), `description` (the main signal the agent uses to decide how to read/write the block), `read_only` (blocks agent-side memory tools from editing), `tags`, `hidden`. Variants: `CreateBlock`, `BlockUpdate` (partial), `FileBlock` (in-context attached file), template variants.

**Rendering**: `Memory.compile()` renders blocks into an XML-like `<memory_blocks>` wrapper with per-block description, `chars_current`/`chars_limit` metadata, prepended to the system prompt. The agent therefore always sees core memory and its remaining budget.

**Agent memory attachment** (`schemas/agent.py`): `CreateAgent.memory_blocks` (create fresh blocks inline) or `block_ids` (attach existing blocks — this is how sharing works). The older `memory` field is deprecated in favor of `blocks`.

**Persistence of everything** (docs, verified): "all state — memories, user messages, reasoning, tool calls — are all persisted in a database... even after a compaction/eviction, an agent's old messages are still retrievable via the API and retrieval tools."

**Notable ORM tables** (from `letta/orm/` listing): `agent`, `block`, `block_history` (audit trail of block edits), `message`, `passage`, `source`, `tool`, `run`, `step`, `conversation`, `group`, `job`, `user`, `organization`, plus join tables `blocks_agents`, `groups_agents`, `groups_blocks`, `tools_agents`, `sources_agents`, `conversation_messages`.

## 3. Agent state persistence

- **Agent = server-side stateful resource.** `AgentState` persists: `agent_type` (enum, verified: `memgpt_agent`, `memgpt_v2_agent`, `letta_v1_agent` — "no heartbeats or forced tool calls", `react_agent`, `workflow_agent`, `split_thread_agent`, `sleeptime_agent`, `voice_convo_agent`, `voice_sleeptime_agent`), `blocks`, `tools`, `tool_rules`, `model` (provider/model-name handle), `tags`, `message_buffer_autoclear`.
- **Runs / steps / conversations**: one user invocation = a *run*; a run spans many *steps*, each one LLM inference pass plus tool execution. Conversations are independent message threads sharing one underlying agent.
- **Context management**: when the window fills, older messages are compacted/evicted — but remain queryable (recall tier). Core memory blocks stay because they live in the system prompt, not the message list.
- **`block_history`**: every block edit is versioned — memory changes are auditable and reversible.

## 4. Sleep-time agents and multi-agent

- `CreateAgent.enable_sleeptime` (verified field docstring): "If set to True, memory management will move to a background agent thread." A dedicated `sleeptime_agent` type shares the primary agent's blocks and rewrites/reorganizes them between interactions; `SleeptimeManager(sleeptime_agent_frequency)` controls cadence. Current letta-code calls this **"dreaming"**: background subagents "review recent conversations, consolidate useful lessons, and update memory" (MemFS), triggered "after a set number of completed agent steps or when the context window is compacted."
- **Shared blocks**: one block attached to multiple agents (`block_ids`) — "when one agent updates the block, all others see the change immediately." `read_only: true` yields policy/config blocks agents can read but not mutate.
- **Groups** (`schemas/group.py`): `ManagerType` = `round_robin`, `supervisor`, `dynamic`, `sleeptime`, `voice_sleeptime` (swarm stubbed). Cross-agent tools (verified names): `send_message_to_agent_and_wait_for_reply`, `send_message_to_agent_async`, `send_message_to_agents_matching_tags`.

## 5. Tool / message flow (one run)

1. Client `POST /v1/agents/{id}/messages` (or chat-completions-compat endpoint).
2. Server loads `AgentState`, compiles system prompt = base prompt + rendered `<memory_blocks>` (always in context).
3. Loop of **steps**: LLM inference → either `send_message` to user (end run) or a tool call.
4. **Memory tools** (`letta/functions/function_sets/base.py`, verified names) mutate state server-side:
   - `core_memory_append(label, content)`, `core_memory_replace(label, old_content, new_content)` (fails if old text not found)
   - newer set: `memory_rethink` (full block rewrite), `memory_replace`/`memory_insert` (precise string/line edits; validated against line-number prefixes and duplicate matches), `rethink_memory`, `memory_apply_patch` (unified-diff, unimplemented in archive)
   - recall tier: `conversation_search(query, roles, limit, start/end_date)` — hybrid text + semantic
   - archival tier: `archival_memory_insert(content, tags)`, `archival_memory_search(query, tags, top_k, ...)`
5. Tool results and assistant reasoning are persisted as `Message` rows; block edits write `block_history`.
6. If `enable_sleeptime`: background agent periodically replays recent messages and rewrites shared blocks out-of-band.

## ASCII diagram

```
            CLIENTS (thin)                    LETTA SERVER (owns all state)
 .---------------------------.     REST/WS  .-------------------------------------------.
 | SDK (Python/TS)           |------------>>| REST API  /v1: agents blocks messages    |
 | letta-code TUI / desktop  |              |            runs steps groups sources ... |
 | channels (Slack/TG/Disc)  |<-------------| WS API    (streams)                      |
 '---------------------------'              |                    |                      |
                                            |   manager layer (agent/block/message/    |
                                            |   passage/group/run/step managers)       |
                                            |                    |                      |
                                            |   SQLAlchemy / Alembic                  |
                                            |                    v                      |
                                            |  SQLite | PostgreSQL                    |
                                            |  agents, blocks, block_history,         |
                                            |  messages, steps, runs, passages,       |
                                            |  sources, tools, groups                 |
                                            '-------------------------------------------'

 CONTEXT WINDOW per agent (compiled each run)
 .------------------------------------------------------------------.
 | SYSTEM PROMPT  = base prompt + <memory_blocks>  <<-- CORE MEMORY  |
 |                  (label/description/value, chars_current/limit,   |
 |                   always in context, agent-editable via tools)    |
 |------------------------------------------------------------------|
 | MESSAGES (in-context window; old ones evicted -> recall tier,     |
 |           still persisted & searchable via conversation_search)   |
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
- https://github.com/letta-ai/letta/tree/archive
- https://raw.githubusercontent.com/letta-ai/letta/archive/pyproject.toml
- https://github.com/letta-ai/letta/tree/archive/letta
- https://github.com/letta-ai/letta/tree/archive/letta/schemas
- https://github.com/letta-ai/letta/tree/archive/letta/server
- https://github.com/letta-ai/letta/tree/archive/letta/server/rest_api/routers
- https://github.com/letta-ai/letta/tree/archive/letta/server/rest_api/routers/v1
- https://github.com/letta-ai/letta/tree/archive/letta/services
- https://github.com/letta-ai/letta/tree/archive/letta/orm
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/schemas/block.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/schemas/memory.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/schemas/agent.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/schemas/group.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/functions/function_sets/base.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/functions/function_sets/multi_agent.py
- https://github.com/letta-ai/letta-code
- https://raw.githubusercontent.com/letta-ai/letta-code/main/LICENSE
- https://docs.letta.com/guides/agents/memory
- https://docs.letta.com/v1-sdk/concepts/stateful-agents/
- https://docs.letta.com/v1-sdk/memory/memory-blocks
- https://docs.letta.com/v1-sdk/memory/shared-memory
- https://docs.letta.com/v1-sdk/memory/archival-memory
- https://docs.letta.com/configuration/memory/
- https://arxiv.org/abs/2504.13171
