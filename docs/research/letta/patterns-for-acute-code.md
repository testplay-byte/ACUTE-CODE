<!-- last-reviewed: 2026-09-12 round-94 -->
# Letta — Patterns for ACUTE-CODE

> Pattern study only — no code copying. License verified Apache-2.0 (both repos), compatible with our allowed dependency set (MIT, Apache-2.0, BSD, ISC, MPL-2.0); ideas are free to reimplement. letta-code adds a trademark/brand-assets carve-out (name/logo/ASCII art), irrelevant to us.

Our stack for mapping: Tauri 2 shell (Rust), React 18/TS UI, Node/TS sidecar owning SQLite via localhost REST+WS, cloud LLM APIs only, human-approval safety layer, max 5 concurrent agents, Hermes-style markdown memory already planned.

---

## Pattern 1 — Memory blocks as budgeted, in-context state

**WHAT (in Letta).** Core memory is a list of `Block`s — verified ORM fields: `label`, `value`, `limit`, `description`, `read_only`, `hidden`, `metadata_`, `version` — compiled into the system prompt inside an XML-like `<memory_blocks>` wrapper that shows each block's `chars_current`/`chars_limit`. Blocks are always in context (no retrieval needed), size-capped per block (schema default `CORE_MEMORY_BLOCK_CHAR_LIMIT = 100000`; docs examples use 4k–5k), and editable from two sides: agent memory tools and the developer REST API. The `description` is documented as "the main information used by the agent to determine how to read and write to that block."

**WHY it fits ACUTE-CODE.** Our agents have small effective budgets and must not silently blow the context window. Explicit per-block char budgets + a visible budget in the prompt give the model self-regulation, and give us a hard enforcement point (sidecar rejects over-limit writes) that fits the human-approval layer: "agent wants to grow block X from 2k to 9k chars" is a reviewable event.

**HOW it maps.** SQLite table `blocks(id, label, description, value, limit, read_only, updated_at)`. Sidecar compiles the agent's system prompt = base prompt + rendered blocks (copy the *concept* of the budgeted render, not Letta's XML format verbatim — format is ours to design). Node sidecar enforces `limit` on every write and reports `chars_current/limit` in tool results so the model sees its own budget after each edit.

**Relation to Hermes-style markdown memory.** Complements, does not replace. Markdown files stay the durable source of truth (human-readable, git-diffable, portable — the direction Letta itself took with MemFS: "All context (including memory blocks) is tracked via git"). Blocks become the **compiled, per-agent projection**: sidecar derives blocks from designated markdown sections (e.g. `memory/project-state.md` → `project_state` block), records the source section + content hash, and re-derives when the file changes. Agent edits via tools write back through the sidecar to the markdown file (so humans see diffs), while the block view enforces the budget. One memory, two faces: file for humans/git, block for the context window.

## Pattern 2 — Agent as a stateful REST resource

**WHAT (in Letta).** Agents are server-side resources. Verified routes: `POST/GET /v1/agents`, `GET/PATCH/DELETE /v1/agents/{id}`, `/{id}/export` + `/import`, `/{id}/tools/attach|detach/{tool_id}`, `PATCH /{id}/tools/approval/{tool_name}`, `/{id}/core-memory/blocks[...]` subresources, plus standalone `/v1/blocks` with `GET /v1/blocks/{id}/agents` reverse lookup. `CreateAgent` accepts `memory_blocks` (inline creation) or `block_ids` (attach existing — this is how sharing works). Docs: all state — memories, user messages, reasoning, tool calls — is persisted in a database; even after compaction, old messages remain retrievable. Runs are units of invocation; steps are single LLM+tool passes; conversations are parallel threads on one agent.

**WHY it fits ACUTE-CODE.** This is exactly our sidecar model: thin UI, stateful local server. Making agents/blocks/messages first-class resources means the React UI, the approval layer, and agents all manipulate the same objects through one API — and a crashed UI loses nothing. Notably, Letta's Message ORM carries `approval_request_id` / `approve` / `denial_reason` / `approvals` columns — server-side tool approval persisted in the data model, the same shape as our safety layer.

**HOW it maps.** Node sidecar endpoints: `/agents` (CRUD, ≤5 concurrent enforced here), `/agents/:id/messages`, `/agents/:id/runs`, `/blocks` (CRUD + attach/detach + `GET /blocks/:id/agents`), `/agents/:id/blocks`. SQLite tables mirroring Letta's verified set: `agents`, `blocks`, `blocks_agents`, `messages` (with approval columns), `steps`, `runs`. Stream step events over the existing WS channel (Letta ships REST+WS side by side — same shape).

## Pattern 3 — Agent-writable memory tools with edit auditing

**WHAT (in Letta).** The agent edits its own memory through named tools (verified in `functions/function_sets/base.py` and the executor): `core_memory_append(label, content)`, `core_memory_replace(label, old_content, new_content)` — executor-verified behavior: raises on read-only blocks and raises `Old content not found` if the old text is absent, a built-in optimistic-concurrency check — plus the newer precise set: `memory_insert` (line-addressed, append-only), `memory_replace` (string-precise, fails on ambiguous targets), `memory_rethink` (full rewrite), `memory_apply_patch` (simplified unified diffs with codex-style multi-block headers `*** Add/Update/Delete Block`, fully implemented in the archive executor), `memory_finish_edits`. `read_only` blocks refuse agent edits entirely. Every edit lands in `block_history` (ORM table verified) and bumps a `version` column.

**WHY it fits ACUTE-CODE.** Self-editing memory is the core value of stateful agents, but our safety layer needs memory changes to be inspectable and reversible. Letta's granularity ladder (append < replace < rethink) is a ready-made risk taxonomy for approval routing: append/replace can auto-apply; rethink/patch of read-only or shared blocks requires human sign-off.

**HOW it maps.** Implement 3–4 sidecar-executed tools: `memory_append(block)`, `memory_replace(block, old, new)` (keep Letta's old-content-must-match check), `memory_rethink(block, new)` (approval-gated), `memory_search(query)`. Execute server-side in the sidecar (never as LLM-privileged code), enforce `read_only` and per-agent permissions there, and write every edit to a `block_history(block_id, before, after, agent_id, run_id, approved_by, created_at)` table — this is also our undo log. Diff previews in React come free from the before/after columns.

## Pattern 4 — Three-tier memory: in-context blocks, persisted recall, vector archival

**WHAT (in Letta).** (1) Blocks in-context; (2) recall memory = full message history persisted forever, searched via `conversation_search` after eviction/compaction (Summarizer with `message_buffer_min`/`message_buffer_limit` and partial-evict modes does the eviction); (3) archival memory = vector-searchable `Passage` store ("a general-purpose vector DB in the Letta API") with tags, agent-immutable entries, written/read via `archival_memory_insert` / `archival_memory_search`. Docs are explicit about what goes where: state that must stay visible → blocks; intentional long-term storage → archival; past messages → recall.

**WHY it fits ACUTE-CODE.** Coding agents drown in transcript history. Separating "always visible" (blocks) from "searchable when relevant" (recall/archival) keeps prompts small while nothing is ever lost — and all of it is local-first in SQLite.

**HOW it maps.** Recall tier: `messages` table + SQLite **FTS5** full-text index (semantic ranking can come later; BM25 via FTS5 is a strong local baseline and needs no embeddings service). Archival tier: `passages(id, agent_id, text, tags, embedding?)` — start FTS5-only; add sqlite-vec or API-computed embeddings later if proven necessary (Letta itself only needs vectors because it ships pgvector for fleet deployments). Give agents `conversation_search` and `archival_search` tools. Compaction/eviction of old messages from the prompt is then safe because recall is queryable.

## Pattern 5 — Sleep-time ("dreaming") background memory agent

**WHAT (in Letta).** `CreateAgent.enable_sleeptime` (verified docstring): "If set to True, memory management will move to a background agent thread." A sleep-time agent shares the primary agent's blocks and rewrites them between interactions; cadence comes from `sleeptime_agent_frequency` on the group config (`schemas/group.py`, verified); implementations live in `letta/groups/sleeptime_multi_agent*.py`. In current letta-code ("dreaming"), background subagents "review recent conversations, consolidate useful lessons, and update memory," triggered "after a set number of completed agent steps or when the context window is compacted," optionally with a second review pass before committing (which "does not ask you for approval" — noted in their docs). Research basis, verified from the paper abstract: sleep-time compute lets models "think offline about contexts before queries are presented" and "can reduce the amount of test-time compute needed to achieve the same accuracy by ~5x" (arXiv:2504.13171).

**WHY it fits ACUTE-CODE.** Refactoring memory during a user-facing run is slow and distracts the agent. Doing it between runs (or on compaction) with a separate, cheaper model call amortizes cost — and gives our approval layer a natural batch point: "3 proposed memory edits from the night shift — review."

**HOW it maps.** Sidecar scheduler: after N completed steps or on context compaction for any agent, spawn a memory-curation run (one of our ≤5 slots, lowest priority) that reads recent `messages` + current blocks/markdown and proposes edits via the same memory tools, but flagged `proposed` pending human approval. Start with the trigger "on compaction" only — cheapest, most obviously useful. Our markdown memory makes curation output especially review-friendly: proposed edits are file diffs.

## Pattern 6 — Shared blocks for multi-agent coordination

**WHAT (in Letta).** One block attached to many agents via `block_ids`: "When one agent updates the block, all others see the change immediately." `read_only` yields shared policy/config blocks ("Agents can read the block but memory tools will refuse to modify it" — but read-only is per-block, not per-agent). Documented concurrency ladder: `memory_insert` append-only = concurrent-safe; `memory_rethink` full rewrites = last-write-wins — "Multiple agents doing memory_rethink on the same block simultaneously leads to lost updates"; guidance: "Designate one agent (or sleep-time memory) as the 'owner' for heavy edits." Documented patterns: `task_queue` (supervisor writes, workers update status), `domain_knowledge` (any agent appends learnings), `handoff_context` (agent A writes before handoff, B reads on pickup), read-only `system_config` synced by external systems. Cross-agent tools exist (`send_message_to_agent_and_wait_for_reply`, `send_message_to_agent_async`, `send_message_to_agents_matching_tags` — verified).

**WHY it fits ACUTE-CODE.** With max 5 concurrent agents on one codebase, shared state (current task board, project conventions, "who is editing which file") is the coordination problem. Shared blocks are the simplest mechanism Letta validated: no message passing needed for common knowledge.

**HOW it maps.** `blocks_agents(block_id, agent_id, read_only)` join table — note ours is **per-attachment** read_only, fixing Letta's limitation (their `read_only` is per-block). A `project_state` block (read-write for an orchestrator agent, read-only for workers) plus a read-only `conventions` block compiled from markdown. Enforce single-writer per block in the sidecar; serialize block writes through the sidecar's event loop (single-writer SQLite is a natural fit). Agent-to-agent messaging can wait — shared blocks + our existing orchestration cover the ≤5-agent case.

---

## What to avoid (with reasons)

1. **Importing the V1 server or its architecture wholesale.** The `archive` branch is explicitly unsupported (README: "should not be used in production") and is a Python/FastAPI monolith with cloud-infra deps (Temporal, Sentry, ClickHouse, OTel, ddtrace per pyproject) that violate our local-first, dependency-minimal stance. Patterns only.
2. **Whole-value writes with last-write-wins semantics for shared memory.** Verified docs: API `blocks.update` "completely replaces the entire block content - it is not an append operation"; their own docs flag simultaneous `memory_rethink` as causing lost updates. Prefer append/patch tools, per-block single-writer, and optimistic checks (`old_content` matching — which Letta's own `core_memory_replace` enforces) on replace.
3. **Heartbeat/forced-tool-call agent loops.** The `memgpt_agent` "OG set of memgpt tools" loop (heartbeats, forced tool calls) was deliberately dropped in `letta_v1_agent` — "simplification of the memgpt loop, no heartbeats or forced tool calls" (verified enum comments). Adopt the modern shape: run ends when the model sends a message; no artificial keep-alive beats burning tokens.
4. **Chasing Letta's exact API surface.** Their API churned within one major version — verified deprecated fields in `schemas/agent.py`: `memory` → use `blocks`, `llm_config` → `model`, `embedding_config` → `embedding`, `sources` → `folders`, `identities` deprecated; V1 SDK docs now warn "Memory blocks may be deprecated in the future … We do not recommend building on memory blocks anymore" in favor of git-backed MemFS. Learn the *concepts*; design one stable schema for us (markdown-backed blocks) instead of mirroring endpoints destined to change.
5. **Per-block-only permissions.** Letta's `read_only` lives on the block, so the same shared block cannot be read-only for one agent and writable for another — a documented limitation ("Read-only applies to the entire block, not per-agent"). Our join-table permission model (Pattern 6) avoids this from day one.
6. **Auto-committing background memory edits without approval.** Letta's dreaming review pass "does not ask you for approval" — fine for their product, wrong for ours: every memory mutation from a sleep-time agent must flow through the same human-approval gate as interactive edits.
7. **Standing up a vector DB before FTS proves insufficient.** Letta's pgvector-backed archival is a fleet-scale answer; for a single-user local workbench, SQLite FTS5 covers recall/archival search with zero embedding cost and no network dependency (we are cloud-LLM-only by choice, and embeddings for *memory search* can stay local).

## Sources

- https://github.com/letta-ai/letta
- https://raw.githubusercontent.com/letta-ai/letta/main/README.md
- https://raw.githubusercontent.com/letta-ai/letta/main/LICENSE
- https://github.com/letta-ai/letta/tree/archive (tree via GitHub API)
- https://raw.githubusercontent.com/letta-ai/letta/archive/pyproject.toml
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/orm/block.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/orm/message.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/schemas/agent.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/schemas/group.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/functions/function_sets/base.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/functions/function_sets/multi_agent.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/services/tool_executor/core_tool_executor.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/server/rest_api/routers/v1/agents.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/server/rest_api/routers/v1/blocks.py
- https://raw.githubusercontent.com/letta-ai/letta/archive/letta/constants.py
- https://github.com/letta-ai/letta-code
- https://raw.githubusercontent.com/letta-ai/letta-code/main/LICENSE
- https://docs.letta.com/guides/agents/memory
- https://docs.letta.com/v1-sdk/memory/memory-blocks/
- https://docs.letta.com/v1-sdk/memory/shared-memory/
- https://docs.letta.com/v1-sdk/memory/archival-memory/
- https://docs.letta.com/guides/agents/sleep-time-agents
- https://www.letta.com/blog/our-next-phase/
- https://arxiv.org/abs/2504.13171 (abstract: ~5x test-time compute reduction, verified)
