<!-- last-reviewed: 2026-09-12 round-98 -->
# Hermes Agent — Patterns for ACUTE-CODE

**License note:** Hermes Agent is MIT (verified) — pattern study is unambiguously fine; we still copy zero code (different language anyway: Python vs our Tauri/TS/Node stack).

Each pattern: **WHAT** it is in Hermes Agent (verified from source), **WHY** it fits ACUTE-CODE, **HOW** it maps onto Tauri 2 + React 18 UI + Node/TS sidecar (SQLite owner over localhost REST+WS) + cloud LLM APIs + human-approval safety layer + max 5 concurrent agents.

---

## Pattern 1 — Two bounded markdown memory stores + SQLite index

**WHAT.** Memory is two hand-size markdown files in `~/.hermes/memories/`: `MEMORY.md` (world/agent facts; default 2,200 chars) and `USER.md` (user profile; 1,375 chars), entries separated by a `\n§\n` delimiter, edited only via the `memory` tool (`add`/`replace`/`remove`/batch `operations`, atomic against the char budget, exact-duplicate no-ops, consolidation-in-same-turn when full — terminal after 3 failures). Every write is mirrored into SQLite tables `memories` + `memories_fts` for query/sync/backup. Markdown is the truth the model reads; SQLite is the index.

**WHY.** Bounded char budgets keep memory injection cheap and predictable; markdown is human-auditable and diffable (fits our human-approval ethos — the user can open the file); the SQLite FTS5 index gives recall query power without abandoning the readable source of truth. This is exactly the "MEMORY.md/USER.md + SQLite indexing" tier we planned.

**HOW.** Sidecar owns `%APPDATA%/AcuteCode/memory/MEMORY.md` + `USER.md` plus an `memories` + `memories_fts` table pair in our existing SQLite DB. Expose one `memory` tool to agents (scoped per user/profile); enforce char budgets in the sidecar; mirror writes in the same transaction. React shows a Memory panel (file view + FTS search + pending-approval queue). Delimiter, budgets, atomic batch ops, and the consolidation rule port 1:1.

## Pattern 2 — Frozen-snapshot injection (prompt stability + injection safety)

**WHAT.** Both memory files are injected into the **system prompt once at session start** as an immutable snapshot (after scanning entries for injection threats; poisoned entries become `[BLOCKED: ...]`). Mid-session writes update disk+DB but **never mutate the live system prompt** — "system prompt doesn't change mid-conversation." Refresh lands next session. Benefits: provider prefix-cache preserved all session; stable prompt tiers; a poisoned mid-session memory write can't alter the prompt the model already runs under.

**WHY.** We pay for cloud LLM tokens — prefix-cache hits are real money; and our multi-agent setup makes prompt drift a correctness bug (two agents in one session seeing different "memory"). The security side-effect (snapshot = injection containment) matches our safety layer.

**HOW.** Sidecar builds the system prompt at conversation start from tiers: stable (identity, tool guidance, skills index) → context (project context file, e.g. an `ACUTE.md`) → volatile (memory snapshot + timestamp). Never rebuild mid-session; new memory is visible to the agent only through tool results (the `memory` tool's write confirmation) and to the user via the React Memory panel. On session start, scan snapshot entries with a small strict pattern set and neutralize hits.

## Pattern 3 — Staged, approvable memory writes (pending_id + replay)

**WHAT.** With `tools/write_approval` enabled, mutating memory operations don't apply immediately: the tool returns a `pending_id`, the write is staged, and only the `/memory approve` flow replays it (`apply_memory_pending`). Provider mirroring fails closed — external backends are never told about a write that didn't land.

**WHY.** This is our human-approval safety layer applied to the memory tier — cheap to adopt because the tool boundary already funnels every write.

**HOW.** Sidecar `memory` tool: mutating ops create a `pending_memory_writes` row (operations JSON + target store + budget check preview) and return `{"pending_id": ...}` to the agent; React approval queue shows a diff-style preview; approve → apply transactionally + update SQLite index; reject → return a "write rejected; do not retry verbatim" result to the agent. Start with approval ON for USER.md (personal data) and allow auto-apply for MEMORY.md if the user opts in.

## Pattern 4 — Memory provider ABC with one-external-backend limit and background sync

**WHAT.** `MemoryProvider` is a small ABC (`name`, `is_available()`, `initialize()`, `get_tool_schemas()`, `prefetch()`, `sync_turn()`, hooks `on_session_switch`/`on_pre_compress`/`on_memory_write`...). `MemoryManager` orchestrates builtin + **at most one external provider** (Honcho/Hindsight/Mem0 plugins) to avoid tool-schema bloat and conflicting backends; all provider I/O runs on a single-worker daemon executor with 5–8 s timeouts; recalled context is fenced as `<memory-context>` and explicitly labeled "recalled memory context, NOT new user input," then scrubbed from model output (streaming-safe); recall is skipped for trivial prompts (greetings/slash commands).

**WHY.** We will eventually want pluggable memory backends (vector DBs, cloud memory APIs) behind the same local-first contract; the fence-and-label trick is a direct prompt-injection mitigation for retrieved content; the one-provider limit is a good simplicity guardrail.

**HOW.** Define a TS `MemoryProvider` interface in the sidecar (prefetch/syncTurn/hooks), ship `BuiltinMarkdownProvider` first; enforce single external provider in config. Fenced `<memory-context>` block with the same "not new user input" labeling for anything retrieved via FTS; strip the fence from outgoing text in the sidecar's stream transformer. Trivial-prompt skip before recall.

## Pattern 5 — Agent-authored skills (procedural memory)

**WHAT.** Skills are folders with `SKILL.md` (+ optional `scripts/`, `references/`), agentskills.io standard frontmatter (`name`, `description`, `when_to_use`, `pattern`, `tags`), stored in `~/.hermes/skills/` (user) and `.hermes/skills/` (project), indexed in SQLite (`skills` + `skills_fts`). The agent **creates them autonomously after complex tasks** (triggers: aborted attempts, tool-call thresholds, time spent), **improves them in place during use**, and each skill becomes a slash command. A compact skills index is injected into the system prompt behind a two-layer cache (in-process LRU + validated disk snapshot).

**WHY.** ACUTE-CODE agents will repeat workflows (project scaffolds, review checklists, release procedures). Skills-as-files give us durable, inspectable, human-editable automation without a plugin marketplace — and they compose with our approval layer (writes are gated).

**HOW.** Sidecar manages `%APPDATA%/AcuteCode/skills/<name>/SKILL.md` + per-workspace `.acute/skills/`; SQLite `skills` + `skills_fts` tables; expose a `skill_create`/`skill_edit` tool that stages a full SKILL.md for human approval before landing (React diff view); render skills as slash commands in the React command palette; build the system-prompt skills index from a cached manifest (rebuild only on change — a content-hash keyed snapshot like Hermes' is ideal for our sidecar).

## Pattern 6 — Skill/install guard: trust tiers + fail-closed scanning

**WHAT.** `skills_guard.py` scans every externally sourced skill pre-install: trust tiers (builtin = never scanned; trusted allowlist repos; community = any finding blocks unless `--force`; agent-created = dangerous verdict requires explicit user confirmation); 100+ threat regexes (exfiltration, prompt-injection, destructive ops, persistence, reverse shells, obfuscation, supply-chain, leaked credentials, invisible unicode/bidi); structural limits (≤50 files, ≤1,024 KB total, ≤256 KB/file, symlink-escape and traversal checks, binary extensions = critical). `--force` **never** overrides a `dangerous` verdict.

**HOW (fits our approval layer).** Port the tiering and structural limits; replace sheer regex volume with: (a) the same categories but curated, (b) mandatory human approval for any agent-created or imported skill (our default matches their `agent-created` policy), (c) an absolute blocklist tier that no override crosses.

## Pattern 7 — Tool registry: dispatch contract, bounded errors, availability grace

**WHAT.** A singleton registry where each tool module self-registers (`register(name, toolset, schema, handler, check_fn, ...)`); dispatch returns **typed JSON errors, never throws**; error bodies are hard-capped (2,048 chars to the model, 8,192 to logs); per-tool `check_fn` availability is cached 30 s with a ~60 s **grace window** that serves last-good `True` after a flaky probe (so one timed-out check doesn't strip a toolset mid-session); a `_generation` counter invalidates definition caches on any change.

**WHY.** Our sidecar is the single tool gateway for up to 5 concurrent agents — a deterministic dispatch contract and bounded outputs keep one agent's pathological tool result from blowing another's context; the grace window is exactly right for our flaky Windows environment probes (git, shell, ports).

**HOW.** TS `ToolRegistry` in the sidecar: `{name, toolset, schema, handler, check}`; handlers return `{ok, result|error}`; enforce char caps in the dispatcher; 30 s probe cache + 60 s grace; generation counter for memoized tool-definition payloads sent to LLM APIs. Explicit registration list (no AST magic needed in TS — a static manifest is clearer and safer for a closed-source app).

## Pattern 8 — Tiered command approval with a non-bypassable floor

**WHAT.** `tools/approval.py` tiers: (1) **hardline patterns** (root/recursive deletion, `mkfs`, `dd` to block devices, shutdown, fork bombs) never bypassable — "a floor below yolo"; (2) user deny rules (fnmatch globs) that fire **before** any bypass switch; (3) sudo-stdin guard; (4) fail-closed parser limits (>128 k chars / >25 k segments) with recovery — the blocked payload is saved to a file so the agent can `bash <file>` instead of retrying inline; (5) a broad dangerous-pattern tier that triggers approval. "YOLO" bypass is **frozen at process start** so skills can't flip the env var mid-run; approval routing is context-aware (interactive panel vs async pending vs cron auto-deny); an auxiliary LLM can auto-approve low-risk commands with pre/post audit hooks.

**WHY.** ACUTE-CODE is human-approval-first; Hermes' floor/deny/bypass ordering and the frozen-bypass trick are the battle-tested version of that design. The save-payload-to-file recovery is a genuinely good de-escalation move we should steal conceptually.

**HOW.** Sidecar `ApprovalService`: tier 1 absolute blocklist (disk/OS-destructive ops) — not overridable by any setting; tier 2 user deny globs evaluated before everything overridable; tier 3 risky-pattern → React approval card (wait WS reply, timeout = deny); approval mode read once at sidecar start and immutable per session; oversized inline commands rejected with a "written to file" recovery hint. We already have the human in the loop; what we adopt is the **ordering discipline and the non-bypassable floor**.

## Pattern 9 — Delegation: depth 1, toolset intersection, reject-not-queue, budgeted summaries

**WHAT.** `delegate_tool.py` spawns child AIAgents with isolated contexts (parent sees only the summary). Default `MAX_DEPTH=1` (no grandkids); children get the **intersection** of parent toolsets ("must not gain tools the parent lacks") minus hard-blocked tools (`delegate_task`, `clarify`, `memory`, `send_message`, `cronjob`); concurrency cap default 10 — at capacity new dispatches are **rejected, not queued**; per-child iteration budget (250); summary char budget = half the parent's remaining headroom split across the batch (floor 2,000 / ceiling 24,000) with head/tail trim + spill-file paging; optional per-child git worktree isolation; children run without memory and with **auto-deny** approvals by default; steer/stop control is scoped by ancestry.

**WHY.** ACUTE-CODE's cap is 5 concurrent agents — Hermes' mechanics (isolation, no-memory children, blocked-tool list, reject-not-queue, summary budgets) prevent the classic failure modes: runaway spawn trees, context explosion from child transcripts, and children doing things the parent couldn't.

**HOW.** Sidecar `spawn_agent` tool: max depth 1 (coordinator → workers only); worker toolsets ⊆ coordinator's minus `{spawn_agent, memory, ask_user, message_user}`; global semaphore of 5 — a 6th spawn returns a typed "at capacity, retry later" error to the agent (visible, not silently queued); worker result = summary string sized against the coordinator's remaining context; workers inherit "deny on timeout" approval defaults; parent UI (React) shows the spawn tree and allows stop per worker.

## Pattern 10 — SQLite discipline: WAL, single-writer queue, FTS5 everywhere

**WHAT.** All state in one file `~/.hermes/hermes.db` (WAL mode) accessed exclusively through a unified state manager with a **single-writer queue**; every searchable corpus gets an FTS5 shadow table (`memories_fts`, `skills_fts`, `session_assets_fts`); sessions keep parent/child lineage across compressions; per-profile isolation gives each profile its own home, DB, memory, and sessions.

**WHY.** Our sidecar already owns SQLite for up to 5 agents — Hermes proves the single-writer-queue model scales to gateway concurrency and shows which FTS5 shadow tables earn their keep (episodic session search with LLM-summarized hits is their killer recall feature).

**HOW.** Keep SQLite inside the sidecar only (never Tauri/React direct access — REST+WS already enforces this); enable WAL; serialize writes through one queue per DB; add FTS5 tables for sessions/turns, memories, skills; store session lineage (parent/child across compaction) so history survives context compression; a `session_search` tool (FTS5 + summarize hits with a cheap model call) gives agents cross-session episodic recall.

## Pattern 11 — Compaction contract (ContextEngine ABC) and memory-context sanitize caps

**WHAT.** Compaction is a pluggable engine (default compressor): fires at 75% of the context window, always preserves the system prompt + first 3 / last 6 non-system messages, and receives provider memory-context text to fold into the handoff (sanitized: secrets redacted, capped at 6,000 chars = 4,000 head + 1,500 tail). A `select_context` hook may rewrite one request but defaults to a byte-identical no-op for cache stability.

**WHY.** Long agent sessions in ACUTE-CODE will hit context limits; the threshold + protect-head/tail contract is a proven minimal design, and "default no-op preserves cache" is the right default for any request-mutating hook.

**HOW.** Sidecar `ContextEngine` interface (`shouldCompress(usage)`, `compress(messages, {focusTopic})`, `onTurnComplete`); default implementation summarizes the middle turns into a `session_summaries` row, keeps system prompt + first/last N messages; reuse the 75%/3/6 constants as starting points; sanitize+cap any retrieved memory folded into the handoff.

---

## What to avoid (with reasons)

1. **Monolithic core files** (`run_agent.py` ~560 KB, `cli.py` ~447 KB). Reason: unmaintainable single files mixing loop, prompting, dispatch, persistence; our sidecar must keep loop/prompting/tools/storage as separate modules from day one.
2. **Porting the Python idioms instead of the patterns** (contextvars, AST tool discovery, import-time registration side effects, fcntl/msvcrt branches). Reason: TS/Tauri equivalents are simpler and static analysis/explicit registration is safer for a closed-source product; import-time side effects are a footgun in bundlers.
3. **Regex-volume security as the primary gate.** Reason: 100+ patterns is a maintenance treadmill with false positives; ACUTE-CODE's contract should be "human approves; heuristics only triage" — Hermes itself compensates with trust tiers and fail-closed parsing, which is the part worth keeping.
4. **YOLO/auto-approve modes as first-class UX.** Reason: our product promise is human-approval-first; Hermes needs YOLO because it runs headless on VPSes. We can adopt the *hardline floor* concept without shipping a global bypass switch (if we ever add one, freeze it at process start like Hermes does).
5. **10-subagent concurrency and unbounded nesting.** Reason: their own code warns cost "multiplies linearly"; our 5-agent cap with depth 1 and reject-not-queue is the right shape — don't scale it up just because Hermes does.
6. **Messaging-gateway breadth (25+ platform adapters) and 7 execution backends.** Reason: enormous surface area irrelevant to a local Windows workbench; Tauri is our only "gateway," local shell our only backend (Docker optional later).
7. **Mutable mid-session system prompts.** Reason: Hermes deliberately freezes the snapshot for cache + injection reasons; any "live memory" feature we build should flow through tool results or a dedicated volatile block, never by rewriting the system prompt mid-conversation.
8. **RL trajectory tooling (`tinker-atropos`, batch runner).** Reason: out of scope; closed-source product, no model training planned. [Submodule license UNVERIFIED — moot since we exclude it.]

## Sources

- https://github.com/nousresearch/hermes-agent
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/LICENSE
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/pyproject.toml
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/AGENTS.md
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tools/memory_tool.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tools/skills_guard.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tools/registry.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tools/approval.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tools/delegate_tool.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/agent/memory_provider.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/agent/memory_manager.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/agent/context_engine.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/agent/prompt_builder.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/hermes_state_schema.py
- https://hermes-agent.nousresearch.com/docs/developer-guide/architecture
- https://hermes-agent.nousresearch.com/docs/user-guide/features/memory
- https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
