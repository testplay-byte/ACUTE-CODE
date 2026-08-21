# Letta (formerly MemGPT) — Research Summary

> Target: <https://github.com/letta-ai/letta>
> Verified 2026-08-21 against the live repository, its `archive` branch, `letta-ai/letta-code`, and docs.letta.com.

## What it is

Letta is a platform for **stateful LLM agents with persistent, self-editing memory** ("AI with advanced memory that can learn and self-improve over time"). It originated as MemGPT (2023), which treated the LLM context window like OS virtual memory: a small in-context "core memory" managed by the agent itself, backed by larger out-of-context stores (conversation history + vector-searchable archival memory) paged in via tools.

**Critical repo-state finding (verified):** `letta-ai/letta` `main` is now only a **landing page**. Active development has moved to **`letta-ai/letta-code`** (TypeScript agent harness + terminal UI + local "App Server", npm `@letta-ai/letta-code`). The **legacy Letta V1 API server** — the Python/FastAPI implementation carrying all the memory architecture we studied — is preserved on the **`archive` branch** (`letta` v0.16.8), explicitly unsupported, no fixes or security patches. This memo analyzes that V1 architecture (where the patterns live) plus the current letta-code direction (MemFS, "dreaming").

## License

- `letta-ai/letta` LICENSE (main and archive branches): **SPDX: Apache-2.0**, "Copyright 2023, Letta authors". Standard, unmodified text.
- `letta-ai/letta-code` LICENSE: **SPDX: Apache-2.0**, "Copyright 2025, Letta authors", with an appended **"Brand Assets Exclusion"** (name/logo/ASCII art remain Letta, Inc. property; not usable in derivative works).

**Compatibility verdict:** Apache-2.0 is in ACUTE-CODE's allowed set. No GPL-family components found in either LICENSE. The letta-code brand carve-out only restricts trademarks — irrelevant since we study patterns and copy no code, name, or logo.

## Tech stack

| Layer | Technology (verified) |
|---|---|
| Legacy server (archive branch) | Python >=3.11,<3.14; Pydantic v2; SQLAlchemy 2 (async) + SQLModel + Alembic migrations; FastAPI/uvicorn (in `server` extra, not core dep); OpenTelemetry; Docker/compose deploy |
| Storage (legacy) | SQLite and PostgreSQL (both first-class extras; `sqlite_functions.py` in ORM); pgvector-style embeddings for archival; optional Redis, Pinecone |
| LLM providers | Cloud-only SDKs: openai, anthropic, google-genai, mistralai, bedrock — matches ACUTE-CODE's cloud-APIs-only stance (local-LLM code existed but is legacy) |
| Active code (letta-code) | TypeScript / npm package `@letta-ai/letta-code`; terminal UI, local App Server (`letta server`), desktop apps, Slack/Telegram/Discord channels |
| Memory model (legacy V1) | Pydantic schemas: `Block` (label/value/limit/description/read_only), `Memory` (in-context block list), `Passage` (archival), message/step/run tables; `block_history` for edit auditing |
| Memory model (current) | MemFS — git-backed memory filesystem; sleep-time agents rebranded as "dreaming"; `/init`, `/remember`, `/doctor`, `/sleeptime` commands |

## Top adoptable patterns

1. **Memory blocks as server-owned, budgeted, in-context state** — labeled text blocks (value + char limit + description + read_only) rendered into the system prompt and editable both by the agent via tools and by the developer via REST.
2. **Agent as a stateful REST resource** — `POST/GET/PATCH /v1/agents`, per-agent `/messages`, `/runs`, `/steps`, `/blocks` subresources; all state (messages, tool calls, memory edits) persisted server-side so nothing is lost on context eviction.
3. **Sleep-time (background) memory agents + shared blocks** — a secondary agent attached to the same blocks reorganizes memory in the background between runs; one block attached to N agents gives instant shared state.

## What to avoid

1. **The V1 server codebase itself** — archived/unsupported, and a Python/FastAPI monolith wired to cloud infra (Temporal, Sentry, ClickHouse, OTel) we do not want; study it, don't import it.
2. **Whole-value block writes ("last write wins")** — direct API updates replace the entire block; under concurrent agents this loses updates (Letta's own docs flag this).
3. **Heartbeat-forced tool-call loops and deprecated API churn** — `memory` vs `blocks`, `shared_block_ids` already deprecated; blocks themselves flagged "may be deprecated in the future" in favor of git-backed MemFS.

## Relevance to ACUTE-CODE

Letta is the reference implementation for exactly ACUTE-CODE's hardest problem: durable, self-editing agent memory behind a localhost server. Its verified architecture — a state-owning server (our Node/TS sidecar + SQLite plays this role) exposing agents, blocks, and messages as REST resources, with in-context budgeted blocks distinct from out-of-context searchable history — maps almost one-to-one onto our design. The block model **complements** (not replaces) our planned Hermes-style markdown memory: markdown files are the durable, git-friendly store (where Letta itself is heading with MemFS), while blocks are the compiled, size-budgeted, in-context projection of that store, with agent-facing edit tools and per-block read-only control. Sleep-time agents and shared blocks directly inform our ≤5-concurrent-agent workbench (background memory curation, shared project-state blocks), and the `block_history` table suggests how to make memory edits reviewable under our human-approval layer. License-clean (Apache-2.0), patterns-only adoption recommended.

## Sources

- https://github.com/letta-ai/letta
- https://raw.githubusercontent.com/letta-ai/letta/main/README.md
- https://raw.githubusercontent.com/letta-ai/letta/main/LICENSE
- https://github.com/letta-ai/letta/tree/archive
- https://raw.githubusercontent.com/letta-ai/letta/archive/pyproject.toml
- https://github.com/letta-ai/letta-code (read via web reader)
- https://raw.githubusercontent.com/letta-ai/letta-code/main/LICENSE
- https://docs.letta.com/guides/agents/memory
- https://docs.letta.com/v1-sdk/concepts/stateful-agents/
- https://docs.letta.com/v1-sdk/memory/memory-blocks
- https://docs.letta.com/v1-sdk/memory/shared-memory
- https://docs.letta.com/v1-sdk/memory/archival-memory
- https://docs.letta.com/configuration/memory/
- https://arxiv.org/abs/2504.13171
