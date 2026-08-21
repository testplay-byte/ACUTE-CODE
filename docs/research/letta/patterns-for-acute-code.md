# Letta — Patterns for ACUTE-CODE

> Pattern study only — no code copying. License verified Apache-2.0 (both repos), compatible with our allowed dependency set; patterns and ideas are free to reimplement. letta-code adds a trademark/brand-assets carve-out (name/logo), irrelevant to us.

Our stack for mapping: Tauri 2 shell (Rust), React 18/TS UI, Node/TS sidecar owning SQLite via localhost REST+WS, cloud LLM APIs only, human-approval safety layer, max 5 concurrent agents, Hermes-style markdown memory already planned.

---

## Pattern 1 — Memory blocks as budgeted, in-context state

**WHAT (in Letta).** Core memory is a list of `Block`s — `{label, value, limit, description, read_only}` — compiled into the system prompt inside an XML-like `<memory_blocks>` wrapper that shows each block's `chars_current`/`chars_limit`. Blocks are always in context (no retrieval needed), size-capped per block, and editable from two sides: agent memory tools and the developer REST API. The `description` is documented as "the main information the agent uses to determine how to read and write to that block."

**WHY it fits ACUTE-CODE.** Our agents have small effective budgets and must not silently blow the context window. Explicit per-block char budgets + visible budget in the prompt gives the model self-regulation, and gives us a hard enforcement point (sidecar rejects over-limit writes) that fits the human-approval layer: "agent wants to grow block X from 2k to 9k chars" is a reviewable event.

**HOW it maps.** SQLite table `blocks(id, label, description, value, limit, read_only, updated_at)`. Sidecar compiles the agent's system prompt = base prompt + rendered blocks (copy the *concept* of the budgeted render, not Letta's XML format verbatim — format is ours to design). Node sidecar enforces `limit` on every write and reports `chars_current/limit` in tool results.

**Relation to Hermes-style markdown memory.** Complements, does not replace. Markdown files stay the durable source of truth (human-readable, git-diffable, portable — the direction Letta itself took with MemFS). Blocks become the **compiled, per-agent projection**: sidecar derives blocks from designated markdown sections (e.g. `memory/project-state.md` → `project_state` block), records the source section + content hash, and re-derives when the file changes. Agent edits via tools write back through the sidecar to the markdown file (so humans see diffs), while the block view enforces the budget. One memory, two faces: file for humans/git, block for the context window.

## Pattern 2 — Agent as a stateful REST resource

**WHAT (in Letta).** Agents are server-side resources: `POST/GET/PATCH /v1/agents`, `memory_blocks`/`block_ids` at creation, attach/detach blocks, subresources for messages, runs, steps, passages, tools. "All state — memories, user messages, reasoning, tool calls — are persisted in a database... even after compaction, old messages remain retrievable." Runs are units of invocation; steps are single LLM+tool passes; conversations are parallel threads on one agent.

**WHY it fits ACUTE-CODE.** This is exactly our sidecar model: thin UI, stateful local server. Making agents/blocks/messages first-class resources means the React UI, the approval layer, and agents all manipulate the same objects through one API — and a crashed UI loses nothing.

**HOW it maps.** Node sidecar endpoints: `/agents` (CRUD, ≤5 concurrent enforced here), `/agents/:id/messages`, `/agents/:id/runs`, `/blocks` (CRUD + attach/detach), `/agents/:id/blocks`. SQLite tables mirroring Letta's verified set: `agents`, `blocks`, `blocks_agents`, `messages`, `steps`, `runs`, `passages` (see Pattern 4). Stream step events over the existing WS channel (Letta ships REST+WS side by side — same shape).

## Pattern 3 — Agent-writable memory tools with edit auditing

**WHAT (in Letta).** The agent edits its own memory through named tools in `function_sets/base.py` (verified): `core_memory_append(label, content)`, `core_memory_replace(label, old_content, new_content)` (errors if old text absent — a built-in optimistic check), plus a newer precise set: `memory_insert` (line-addressed, append-only, concurrency-safe), `memory_replace` (fails on duplicate/changed target), `memory_rethink` (full rewrite, last-write-wins). `read_only` blocks refuse agent edits entirely. Every edit lands in `block_history` (ORM table verified).

**WHY it fits ACUTE-CODE.** Self-editing memory is the core value of stateful agents, but our safety layer needs memory changes to be inspectable and reversible. Letta's granularity ladder (append < replace < rethink) is a ready-made risk taxonomy for approval routing: append/replace can auto-apply; rethink/patch of read-only or shared blocks requires human sign-off.

**HOW it maps.** Implement 3–4 sidecar-executed tools: `memory_append(block)`, `memory_replace(block, old, new)`, `memory_rethink(block, new)` (approval-gated), `memory_search(query)`. Execute server-side in the sidecar (never as LLM-privileged code), enforce `read_only` and per-agent permissions there, and write every edit to a `block_history(block_id, before, after, agent_id, run_id, approved_by, created_at)` table — this is also our undo log. Diff previews in React come free from the before/after columns.

## Pattern 4 — Three-tier memory: in-context blocks, persisted recall, vector archival

**WHAT (in Letta).** (1) Blocks in-context; (2) recall memory = full message history persisted forever, searched via `conversation_search` (hybrid text+semantic, role/date filters) after eviction/compaction; (3) archival memory = vector-searchable `Passage` store with tags, written/read via `archival_memory_insert`/`archival_memory_search`, agent-curated long-term knowledge. Docs are explicit about what goes where: state that must stay visible → blocks; intentional long-term storage → archival; past messages → recall.

**WHY it fits ACUTE-CODE.** Coding agents drown in transcript history. Separating "always visible" (blocks) from "searchable when relevant" (recall/archival) keeps prompts small while nothing is ever lost — and all of it is local-first in SQLite.

**HOW it maps.** Recall tier: `messages` table + SQLite **FTS5** full-text index (hybrid/semantic ranking can come later; BM25 via FTS5 is a strong local baseline and needs no embeddings service). Archival tier: `passages(id, agent_id, text, tags, embedding?)` — start with FTS5-only search; add sqlite-vec or API-computed embeddings later if needed. Give agents `conversation_search` and `archival_search` tools. Compaction/eviction of old messages from the prompt is then safe because recall is queryable.

## Pattern 5 — Sleep-time ("dreaming") background memory agent

**WHAT (in Letta).** `enable_sleeptime` moves memory management to "a background agent thread" sharing the primary agent's blocks; `SleeptimeManager(sleeptime_agent_frequency)` sets cadence. In current letta-code ("dreaming"), background subagents "review recent conversations, consolidate useful lessons, and update memory," triggered "after a set number of completed agent steps or when the context window is compacted," optionally with a second review pass before committing (which "does not ask you for approval" — noted in their docs). Research basis: sleep-time compute (arXiv:2504.13171) — offline reprocessing cut test-time compute ~5x for equal accuracy.

**WHY it fits ACUTE-CODE.** Refactoring memory during a user-facing run is slow and distracts the agent. Doing it between runs (or on compaction) with a *separate, cheaper* model call amortizes cost — and gives our approval layer a natural batch point: "3 proposed memory edits from the night shift — review."

**HOW it maps.** Sidecar scheduler: after N completed steps or on context compaction for any agent, spawn a memory-curation run (one of our ≤5 slots, lowest priority) that reads recent `messages` + current blocks/markdown and proposes edits via the same memory tools, but flagged `proposed` pending human approval. Start with the trigger "on compaction" only — cheapest, most obviously useful. Our markdown memory makes curation output especially review-friendly: proposed edits are file diffs.

## Pattern 6 — Shared blocks for multi-agent coordination

**WHAT (in Letta).** One block attached to many agents via `block_ids`: "when one agent updates the block, all others see the change immediately." `read_only` yields shared policy/config blocks. Documented concurrency ladder: `memory_insert` append-only = concurrent-safe; `memory_replace` = mostly safe; `memory_rethink` = last-write-wins, flagged as the anti-pattern for simultaneous writers. Ownership guidance: designate one writer agent (or the sleep-time agent) per block; others append. Group managers (`round_robin`, `supervisor`, `dynamic`) orchestrate turns; cross-agent tools like `send_message_to_agent_and_wait_for_reply` exist.

**WHY it fits ACUTE-CODE.** With max 5 concurrent agents on one codebase, shared state (current task board, project conventions, "who is editing which file") is the coordination problem. Shared blocks are the simplest mechanism Letta validated: no message passing needed for common knowledge.

**HOW it maps.** `blocks_agents(block_id, agent_id, read_only)` join table — note ours is **per-attachment** read_only, fixing Letta's limitation (their `read_only` is per-block, not per-agent). A `project_state` block (read-write for an orchestrator agent, read-only for workers) plus a read-only `conventions` block compiled from markdown. Enforce single-writer per block in the sidecar; serialize block writes through the sidecar's event loop (single-writer SQLite is a natural fit). Agent-to-agent messaging can wait — shared blocks + our existing orchestration cover the ≤5-agent case.

---

## What to avoid (with reasons)

1. **Importing the V1 server or its architecture wholesale.** The `archive` branch is explicitly unsupported (no security patches) and is a Python/FastAPI monolith with cloud-infra deps (Temporal, Sentry, ClickHouse, OTel per pyproject) that violate our local-first, dependency-minimal stance. Patterns only.
2. **Whole-value writes with last-write-wins semantics for shared memory.** Verified docs: API `blocks.update` "completely replaces the entire block content — it is not an append operation" and concurrent writes mean "last write wins"; their own docs flag simultaneous `memory_rethink` as causing lost updates. We should prefer append/patch tools, per-block single-writer, and optimistic checks (`old_content` matching) on replace.
3. **Heartbeat/forced-tool-call agent loops.** The `memgpt_agent` "OG" loop (heartbeats, forced tool calls) was deliberately dropped in `letta_v1_agent` ("no heartbeats or forced tool calls"). Adopt the modern shape: run ends when the model sends a message, no artificial keep-alive beats burning tokens.
4. **Chasing Letta's exact API surface.** Their own API churned within one major version (`memory` → `blocks` deprecated; `shared_block_ids` deprecated; V1 SDK docs now warn "memory blocks may be deprecated in the future" in favor of MemFS/git-backed memory). Learn the *concepts*; design one stable schema for us (markdown-backed blocks) instead of mirroring endpoints destined to change.
5. **Per-block-only permissions.** Letta's `read_only` lives on the block, so the same shared block cannot be read-only for one agent and writable for another — a documented limitation. Our join-table permission model (Pattern 6) avoids this from day one.
6. **Auto-committing background memory edits without approval.** Letta's dreaming review pass "does not ask you for approval" — fine for their product, wrong for ours: every memory mutation from a sleep-time agent must flow through the same human-approval gate as interactive edits.

## Sources

- https://github.com/letta-ai/letta
- https://raw.githubusercontent.com/letta-ai/letta/main/README.md
- https://raw.githubusercontent.com/letta-ai/letta/main/LICENSE
- https://github.com/letta-ai/letta/tree/archive
- https://raw.githubusercontent.com/letta-ai/letta/archive/pyproject.toml
- https://github.com/letta-ai/letta/tree/archive/letta/schemas
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
