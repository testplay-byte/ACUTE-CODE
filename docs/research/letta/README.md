<!-- last-reviewed: 2026-09-07 round-75 -->
# Letta (formerly MemGPT) — Research Summary

**Target:** ACUTE-CODE reference-project analysis
**Date:** 2026-08-21
**Canonical repo:** https://github.com/letta-ai/letta (verified against the live repo, its `archive` branch, `letta-ai/letta-code`, and docs.letta.com)

## Repo status warning (read first)

`letta-ai/letta` `main` is **no longer the main codebase** — its README states "This repository now serves as a landing page for the Letta project." Current state:

- **Active development** lives in [`letta-ai/letta-code`](https://github.com/letta-ai/letta-code) — a TypeScript agent harness (npm `@letta-ai/letta-code`, Bun runtime) with terminal UI, channels (Slack/Telegram/Discord), desktop app, and git-backed memory ("MemFS" / context repositories).
- The **Letta V1 server** (Python/FastAPI, the system the memory-block architecture is famous for) is archived on the repo's `archive` branch (`letta` v0.16.8), explicitly unsupported — "should not be used in production" per the README.
- Per Letta's "Our Next Phase" blog, the V1 model itself is being sunset: memory moves "from specialized memory tools that edit memory in a database to generalized computer use tools like bash" operating on git-backed context repositories; `core_memory_replace` and other legacy server memory tools are being **removed**; sleep-time agents and multi-agent orchestration move from server-side to client-side skills/subagents. The V1 SDK docs now warn: "We do not recommend building on memory blocks anymore."

**Implication:** the V1 block architecture is the mature, well-documented expression of the ideas in our focus hints (stateful agents, memory blocks, agent-server REST API, self-editing memory, sleep-time compute, shared blocks). We study it as a *pattern source* — while noting that Letta, the pioneer of database memory blocks, is migrating to **file-based, git-versioned memory edited with general tools**, which converges on the Hermes-style markdown memory ACUTE-CODE already plans. That convergence is a validation signal, not a reason to abandon either idea (synthesis in `patterns-for-acute-code.md`).

## What it is

Letta is the company/product born from **MemGPT** (2023) — a platform for **stateful LLM agents with persistent, self-editing memory** ("AI with advanced memory that can learn and self-improve over time"). MemGPT's founding idea: treat the LLM context window like OS virtual memory — a small in-context "core memory" managed by the agent itself, backed by larger out-of-context stores paged in via tools. Verified core concepts:

1. **Agents are server-side stateful resources.** An agent is a row (not a process): system prompt + attached memory blocks + message history + attached tools, all persisted in a database. Runs (invocations), steps (single LLM inference passes), and messages are recorded; the same agent resumes across sessions and clients.
2. **Tiered memory**: *core memory* (labeled text **blocks** rendered into every prompt, always in-context), *archival memory* (unlimited vector store of passages, semantic search on demand), and *recall memory* (full persisted message history, searchable even after context-window eviction/compaction).
3. **Agents edit their own memory** via built-in tools — verified in source: `core_memory_append`, `core_memory_replace`, `archival_memory_insert`, `archival_memory_search`, `conversation_search`, and the newer file-like family `memory_create`, `memory_insert`, `memory_replace`, `memory_rethink`, `memory_apply_patch` (unified diffs), `memory_str_replace`, `memory_str_insert`, `memory_rename`, `memory_delete`, `memory_update_description`, `memory_finish_edits`.
4. **Sleep-time agents**: background agents sharing a primary agent's memory blocks, rewriting them during idle time (paper: "Sleep-time Compute: Beyond Inference Scaling at Test-time", arXiv 2504.13171); reborn in letta-code as "dreaming".
5. **Multi-agent memory sharing**: blocks are first-class resources attachable to many agents — "When one agent updates the block, all others see the change immediately."

## License

- `letta-ai/letta` LICENSE (main): **SPDX: `Apache-2.0`**, "Copyright 2023, Letta authors" — verified. `pyproject.toml` on `archive` declares `license = { text = "Apache License" }`.
- `letta-ai/letta-code` LICENSE: **SPDX: `Apache-2.0`**, with an appended **"Brand Assets Exclusion"** (Letta name, logo, wordmark, ASCII art remain Letta, Inc. property, not licensed for derivative works) — verified from the LICENSE tail.

**Compatibility: fully compatible** with ACUTE-CODE's allowed set (MIT, Apache-2.0, BSD, ISC, MPL-2.0). No GPL-family code found in anything inspected. The brand carve-out is trademark-only and irrelevant to pattern study (we copy no code, names, or logos regardless).

## Tech stack (verified from manifests and source)

Two codebases share the name:

| Layer | Letta V1 server (`archive` branch, `letta` 0.16.8) | Letta Code (`letta-ai/letta-code`, active) |
|---|---|---|
| Language | Python >=3.11,<3.14 (`pyproject.toml`) | TypeScript, Bun runtime (`bun.lock`, `bunfig.toml`) |
| API server | FastAPI (`server` extra, `fastapi>=0.115.6`), REST routers under `/v1/*` | Local harness; `letta server` exposes the machine as a remote environment |
| ORM / schemas | SQLAlchemy 2 (async) + sqlmodel + alembic migrations; pydantic v2 | n/a — git-tracked context repositories (MemFS) |
| Primary DB | PostgreSQL + pgvector (`postgres` extra) | Local filesystem + git; optional GitHub repo sync |
| Embedded DB | **SQLite** — default when no `letta_pg_uri` is set (`DatabaseChoice.SQLITE` in `settings.py`); dedicated sqlite baseline schema + `letta/orm/sqlite_functions.py` + CI workflow `core-unit-sqlite-test.yaml` | n/a |
| LLM clients | `openai[realtime]`, `anthropic`, `mistralai`, `google-genai`, bedrock extra; llama-index embeddings | model-agnostic ("You own the memory. You choose the model.") |
| Agent loop | `LettaAgent` v1–v3; `Summarizer` (message_buffer_min/max, partial-evict modes) for context compaction; `LettaCoreToolExecutor` for built-in tools | Harness with subagents, hooks, permissions, "heartbeats and crons", skills |
| Multi-agent | `ManagerType` groups: `round_robin`, `supervisor`, `dynamic`, `sleeptime`, `voice_sleeptime` (`schemas/group.py`) | Client-side skills + dynamic subagents |
| Observability | OpenTelemetry, sentry, temporalio, ddtrace extras | [UNVERIFIED — not inspected] |
| Distribution | `pip install letta[postgres]` (legacy, archived) | `npm install -g @letta-ai/letta-code`; desktop app macOS/Win/Linux; chat.letta.com; Letta Cloud |

## Top adoptable patterns (details in `patterns-for-acute-code.md`)

1. **Labeled memory blocks as first-class, attachable resources** — memory as typed rows (`label`, `description`, `value`, `limit`, `read_only`, `version` + `block_history`) with many-to-many agent attachment; blocks render into the prompt as `<memory_blocks>` XML and are editable by both agent tools and the host application through one API.
2. **Agent-owned memory-editing tools with structured verbs** — append/replace/patch primitives over the agent's own persistent memory, every edit versioned and auditable, instead of free-form edits only.
3. **Sleep-time memory curation** — a background pass over recent history that consolidates lessons into memory while primary agents are idle (after N steps or on compaction), with an optional "agent reviews before applying" mode.

## What to avoid (one line each)

- **Standing up the V1 server model wholesale** — archived/unsupported, and a Python monolith wired to cloud infra (Temporal, Sentry, ClickHouse, OTel) we don't want; Letta itself moved orchestration client-side.
- **Per-verb memory tools as the end-state** — Letta is *removing* `core_memory_replace`-style tools in favor of general file operations on git-backed memory; treat specialized memory verbs as an ergonomics layer over file memory, not the foundation.
- **Postgres+pgvector as the local-first default** — fleet-server thinking; ACUTE-CODE's single-user profile should stay on SQLite (Letta's own embedded fallback) with FTS first, vectors only if proven necessary.
- **Whole-value block writes under concurrency** — `blocks.update()` "replaces the entire block content - it does not append"; Letta's own docs flag simultaneous `memory_rethink` on one block as a lost-update anti-pattern.
- **Treating blocks as stable API surface** — official docs: "Memory blocks may be deprecated in the future … We do not recommend building on memory blocks anymore"; adopt the *pattern*, not the API.

## Relevance to ACUTE-CODE — verdict

**Highly relevant as a pattern source; not a dependency candidate.** Letta is the most fully articulated reference for exactly ACUTE-CODE's central problem: keeping multiple long-lived agents stateful on a local machine with human approval in the loop. Its verified architecture — stateful agent resources behind a localhost REST API, tiered memory (in-context blocks vs out-of-context searchable history), agent-self-edited versioned memory, background sleep-time curation, and shared blocks across agents — maps almost one-to-one onto our Tauri + Node sidecar + SQLite design, with SQLite literally being Letta's own embedded-mode default. Even its Message schema carries `approval_request_id` / `approve` / `denial_reason` fields — server-side tool approval is in the data model, mirroring our safety layer. Strategically, the most valuable signal is Letta's own migration from database memory blocks to **git-backed filesystem memory edited with general tools** — external validation that Hermes-style markdown memory is the right foundation, with Letta's block model supplying the missing structural layer (labeled, bounded, attachable, versioned projections of that markdown into every agent's context). Apache-2.0, license-clean; adopt patterns only.

## Sources

- https://github.com/letta-ai/letta (README, repo status, stats)
- https://raw.githubusercontent.com/letta-ai/letta/main/LICENSE (Apache-2.0, copyright line)
- https://github.com/letta-ai/letta-code (active repo README, TS/Bun stack, MemFS)
- https://raw.githubusercontent.com/letta-ai/letta-code/main/LICENSE (Apache-2.0 + Brand Assets Exclusion)
- https://raw.githubusercontent.com/letta-ai/letta/archive/pyproject.toml (deps, python version, license field)
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/settings.py (DatabaseChoice POSTGRES/SQLITE default)
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/orm/block.py (Block columns incl. version/read_only/history)
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/orm/message.py (approval fields, step/run/conversation ids)
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/services/tool_executor/core_tool_executor.py (verified memory tool names)
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/server/rest_api/routers/v1/agents.py (verified agent REST routes)
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/server/rest_api/routers/v1/blocks.py (verified block REST routes)
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/schemas/group.py (ManagerType.sleeptime, sleeptime_agent_frequency)
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/agents/letta_agent.py (Summarizer, in-context message prep)
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/constants.py (CORE_MEMORY_BLOCK_CHAR_LIMIT = 100000)
- https://docs.letta.com/guides/agents/memory (stateful agents, blocks, in/out-of-context messages, runs/steps/conversations)
- https://docs.letta.com/v1-sdk/memory/memory-blocks/ (block anatomy, XML rendering, read-only)
- https://docs.letta.com/v1-sdk/memory/archival-memory/ (passages, agent tools, tags)
- https://docs.letta.com/v1-sdk/memory/shared-memory/ (sharing semantics, concurrency guidance, deprecation warning)
- https://docs.letta.com/guides/agents/sleep-time-agents (newer "Dreaming" feature docs)
- https://www.letta.com/blog/our-next-phase/ (architecture shift: MemFS, tool removals, timeline)
- https://www.letta.com/blog/sleep-time-compute/ (sleep-time compute announcement)
- https://arxiv.org/html/2504.13171v1 (Sleep-time Compute paper)
