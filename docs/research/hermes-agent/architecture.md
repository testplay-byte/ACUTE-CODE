<!-- last-reviewed: 2026-09-12 round-94 -->
# Hermes Agent — Architecture

**Repo:** https://github.com/NousResearch/hermes-agent (v0.20.x, MIT)
**Verification:** all claims below read from repo source (`pyproject.toml`, `run_agent.py` tree, `tools/`, `agent/`, `hermes_state_schema.py`) and official docs. Items not directly verified are marked [UNVERIFIED].

## 1. Runtime structure — three layers

Per the official architecture page, Hermes is organized as:

1. **Entry points** — `cli.py` (TUI), `gateway/run.py` (messaging, 25+ platform adapters), `acp_adapter/` (stdio/JSON-RPC for VS Code/Zed/JetBrains), `batch_runner.py`, API server, Python library.
2. **AIAgent core** (`run_agent.py`, one platform-agnostic class shared by every entry point) — three subsystems: Prompt Builder (`agent/prompt_builder.py`) feeding compression/caching; Provider Resolution (`runtime_provider.py`) mapping (provider, model) → (api_mode, key, base_url) across 3 API modes (chat_completions, codex_responses, anthropic); Tool Dispatch (`model_tools.py`) feeding the Tool Registry (`tools/registry.py`, 70+ tools / 28 toolsets).
3. **Persistence & backends** — session storage (SQLite + FTS5 via `hermes_state.py`) and tool backends (7 terminal backends: local, Docker, SSH, Singularity, Modal, Daytona, Vercel Sandbox; browser, web, MCP, file, vision).

Strict import-time dependency chain (bottom-up): `tools/registry.py` ← `tools/*.py` (each calls `registry.register()` at import) ← `model_tools.py` ← `run_agent.py` / `cli.py` / `batch_runner.py`. Tool files with a top-level `register` call are auto-discovered via **AST scanning** (disk-memoized by `mtime_ns` + `size`).

### ASCII diagram

```
                        ┌────────────────────────────────────────────────────────┐
                        │                     ENTRY POINTS                       │
                        │  cli.py (TUI)   gateway/run.py   acp_adapter/  batch   │
                        │                 (25+ platforms)  (IDE RPC)     _runner │
                        └───────────────┬────────────────────────────────────────┘
                                        v
        ┌───────────────────────────────────────────────────────────────────────────┐
        │                        AIAgent  (run_agent.py)                             │
        │                                                                             │
        │  user msg ──> build_system_prompt() ──> resolve_runtime_provider()          │
        │                    │                          │                            │
        │   ┌────────────────┼──────────┐               v                            │
        │   │  PROMPT TIERS  │          │        LLM API call (chat_completions /    │
        │   │  stable: identity, tool   │          codex_responses / anthropic)      │
        │   │   guidance, skills index  │               │                            │
        │   │  context: .hermes.md      │      ┌────────┴─────────┐                  │
        │   │  volatile: memory +       │      │  tool_calls?     │                  │
        │   │   USER.md + timestamp     │      no │            yes │                  │
        │   │  (frozen per session;     │      v                v                  │
        │   │  never mutated mid-chat)  │   final text   model_tools.handle_function_call()
        │   └────────────────┼──────────┘                     │                      │
        │                   │                          ┌──────v───────┐              │
        │   ┌───────────────┴───────────────┐          │ ToolRegistry │              │
        │   │  ContextEngine (ABC)          │          │ .dispatch()  │              │
        │   │  default: context_compressor  │          │ check_fn     │              │
        │   │  threshold 75% window;        │          │ gating       │              │
        │   │  protect first 3 / last 6     │          └──────┬───────┘              │
        │   │  messages on compaction       │                 │                      │
        │   └───────────────────────────────┘         ┌───────┴────────────┐         │
        │                                             │ tools/approval.py  │         │
        │                                             │ hardline / deny /  │         │
        │                                             │ dangerous → ASK    │         │
        │                                             └───────┬────────────┘         │
        │                                        results as role:"tool" messages    │
        │                                        (tool_call_id) ──> LOOP until the  │
        │                                        model stops / context_window /    │
        │                                        max_tool_loops                    │
        └──────────────┬───────────────────────┬────────────────┬───────────────────┘
                       v                       v                v
        ┌──────────────────────┐ ┌───────────────────┐ ┌──────────────────────────┐
        │ ~/.hermes/hermes.db  │ │ ~/.hermes/        │ │ ~/.hermes/skills/        │
        │ SQLite WAL, 1 writer │ │  memories/        │ │ SKILL.md + scripts/      │
        │ sessions, turns,     │ │  MEMORY.md        │ │ references/ (+ .hermes/  │
        │ tags, assets(+fts),  │ │  USER.md          │ │ skills/ per-project)     │
        │ memories(+fts),      │ │  (bounded chars,  │ │ agent-authored, guarded  │
        │ skills(+fts),        │ │  frozen snapshot  │ │ by skills_guard.py       │
        │ cron_jobs, plugin_kv │ │  → system prompt) │ │                          │
        │ session_summaries    │ └───────────────────┘ └──────────────────────────┘
        └──────────────────────┘
              FTS5 recall: session_search (cross-session, LLM-summarized),
              memory mirror sync, skills index cache
```

## 2. Agent loop and turn structure

- One turn = `AIAgent.run_conversation()`: build system prompt → resolve provider → API call → if tool calls, route through `model_tools.handle_function_call()` → results appended to the conversation as `role:"tool"` messages carrying `tool_call_id` → repeat **until the model stops requesting tools or a limit is hit (`context_window`, `max_tool_loops`)**.
- **Abort propagation** via an asyncio event (user interrupt cancels mid-loop); UI events throttled to ~30 rps; **checkpointing every 20 tool calls**; mid-turn user steering injected via trusted `STEER_MARKER_OPEN/CLOSE` markers with a one-shot freshness rule.
- **Registry dispatch contract** (`tools/registry.py`): unknown name → typed error; sync handlers called directly, async bridged; handler results must be strings or multimodal envelopes, anything else becomes a typed error; exceptions are never raised to the loop — they return `tool_error(...)` JSON with **bounded bodies** (2,048 chars to model context, 8,192 to logs). A `_generation` counter lets callers memoize tool definitions safely.
- **Availability gating**: per-tool `check_fn` (e.g. "is Docker up?") cached 30 s, with a ~60 s transient-failure grace window that serves last-good `True` so one flaky probe doesn't strip a whole toolset from the model.
- **Compaction** sits beside the loop as a pluggable `ContextEngine` ABC (default `context_compressor.py`): fires at 75% of the context window, always preserves the system prompt plus first 3 / last 6 non-system messages, folds provider memory context into the handoff prompt (memory-context text sanitized to 6,000 chars: 4,000 head + 1,500 tail). A `select_context()` hook may rewrite a single request's message list; its no-op default keeps requests byte-identical for cache stability. Session lineage (parent/child across compressions) is tracked in the DB.

## 3. Memory architecture (the focus area)

### 3.1 Two bounded markdown stores + SQLite mirror

- `~/.hermes/memories/MEMORY.md` — facts about the world and how the agent works in it (environment quirks, project conventions, tool gotchas, lessons learned). Default budget **2,200 chars** (config `memory.memory_char_limit`).
- `~/.hermes/memories/USER.md` — who the user is (preferences, communication style, expectations, workflow habits). Default budget **1,375 chars** (config `memory.user_char_limit`).
- Entries are separated by a `\n§\n` (section-sign) delimiter; budgets are enforced in **characters, not tokens**. A usage header (`MEMORY (your personal notes)`, `USER PROFILE (who the user is)`) shows `[pct% — current/limit chars]`.
- Every write is mirrored into SQLite (`memories` + `memories_fts` tables in `hermes.db`) for query/sync/backup — markdown is the source of truth the model reads and edits; SQLite is the queryable index.

### 3.2 Frozen-snapshot injection (how memory enters context)

- At **session start**, both files are read, scanned for injection threats (strict-scope `threat_patterns`; poisoned entries replaced with `[BLOCKED: ...]`), and embedded in the system prompt as an **immutable snapshot**.
- Mid-session `memory` writes update the files + SQLite immediately (durable) but **do not mutate the live system prompt** — the design rule is "system prompt doesn't change mid-conversation." This (a) preserves the provider prefix cache for the whole session, (b) guarantees a stable prompt tier, and (c) prevents a poisoned mid-session write from altering the system prompt the model is already operating under. The snapshot refreshes next session.
- The model reads/writes memory only through the `memory` tool (registered under toolset `memory`, emoji 🧠). Operations: `add`, `replace`, `remove` (substring-anchored, not ID-based), or a batch `operations` array applied atomically against the final budget; exact duplicates are no-op-deduped via order-preserving `dict.fromkeys`. When at capacity, the tool instructs the model to **consolidate in the same turn** — after 3 failed consolidation attempts the result is terminal (no silent data loss).
- File safety: atomic write (temp file + rename), file locking (fcntl on POSIX, msvcrt on Windows), external-drift detection with `.bak` snapshots, refuse-to-overwrite-unreadable files.

### 3.3 Provider abstraction and per-turn recall

- `agent/memory_manager.py` (`MemoryManager`) is the single integration point in `run_agent.py`; it orchestrates the builtin provider plus **at most one external provider** (Honcho, Hindsight, Mem0 live in `plugins/memory/`) — the one-external limit exists to prevent tool-schema bloat and conflicting backends.
- `agent/memory_provider.py` defines the `MemoryProvider` ABC: abstract `name`, `is_available()`, `initialize()`, `get_tool_schemas()`; lifecycle `prefetch(query)` (recall before each turn), `sync_turn(user, asst)` (async write after a turn), plus hooks `on_turn_start`, `on_session_end`, `on_session_switch`, `on_pre_compress`, `on_delegation`, `on_memory_write` (mirrors builtin memory-tool writes into the external backend).
- Recalled provider context is wrapped by `build_memory_context_block()` in `<memory-context>...</memory-context>` fencing explicitly labeled as "recalled memory context, NOT new user input"; a stateful `StreamingContextScrubber` strips such blocks from model output even across stream-chunk boundaries. Recall is skipped for trivial prompts (greetings, slash commands) via `is_trivial_prompt()`.
- All provider I/O runs on a single-worker daemon `ThreadPoolExecutor` ("mem-sync") so a wedged provider cannot stall a turn; timeouts 5 s (sync drain) / 8 s (external prefetch). A `RecallStatus` glyph (🧠 + count) surfaces recall in the UI.

### 3.4 Cross-session recall

`session_search` tool: FTS5 search over stored sessions/turns/assets with LLM summarization of hits — the "episodic" complement to the curated "semantic" MEMORY.md/USER.md. Schema also keeps `session_summaries` and `session_assets_fts`.

### 3.5 Human control

`/memory` TUI command: read-only view, list entries, and — when `tools/write_approval` is on — **approve pending staged writes**: mutating memory operations return a `pending_id`; approval replays them via `apply_memory_pending`. Provider mirroring fails closed (`_memory_tool_result_succeeded`) so external backends never record a write that didn't land.

## 4. Skills system (self-created skills)

- A skill = folder with `SKILL.md` (+ optional `scripts/`, `references/`, `assets/`), following the **agentskills.io open standard**. YAML frontmatter: `name`, `description`, `when_to_use`, `allow_probes`, `skip_generation`, `pattern`, `tags`; optional `pattern` is a regex the gateway matches against session transcripts to auto-suggest the skill in the background.
- Locations: `~/.hermes/skills/` (user), `.hermes/skills/` (project), bundled `skills/` and `optional-skills/` in the repo; SQLite `skills` + `skills_fts` tables index them.
- **Self-creation**: after complex tasks (triggers: aborted attempts, tool usage above threshold, time spent), the agent distills the trajectory into a new SKILL.md; skills also **self-improve during use** (edited in place when the agent finds a better procedure).
- **Guarding** (`tools/skills_guard.py`): every externally-sourced skill passes a scanner — trust tiers (`builtin` never scanned, `trusted` repos allowlist, `community` any-finding-blocks-unless-`--force`, `agent-created` dangerous → explicit user confirmation); 100+ `THREAT_PATTERNS` regexes (exfiltration, prompt injection, destructive ops, persistence, reverse shells, obfuscation, supply-chain, leaked credentials; invisible-unicode/bidi flags high); structural checks (symlink escapes, path traversal, ≤50 files, ≤1,024 KB total, ≤256 KB/file, binary extensions critical). `--force` never overrides a `dangerous` verdict.
- `agent/skill_commands.py` turns each skill into a TUI slash command (`/<skill-name>`, auto-refreshed); `agent/prompt_builder.py` builds a compact **skills index** into the system prompt with a two-layer cache (in-process LRU of 32 + disk snapshot `.skills_prompt_snapshot.json` validated by a manifest); `tools/skill_manager_tool.py` performs safe edits with backups and frontmatter validation.

## 5. Data flow and storage

- **Single SQLite file** `~/.hermes/hermes.db`, WAL mode, **single-writer via a single queue** (SQLite accessed only through `hermes_state.py`); tables (from `hermes_state_schema.py`): `sessions`, `session_turns`, `session_tags`, `session_assets` + `session_assets_fts`, `memories` + `memories_fts`, `skills` + `skills_fts`, `cron_jobs`, `plugin_kv`, `plugin_kv_ts`, `session_summaries`. Import/export for portability.
- **Profiles**: each `hermes -p <name>` profile gets an isolated HERMES_HOME (config, memory, sessions, gateway PID); tool-registry lookups merge global tools with a per-profile scoped overlay.
- **Checkpoints** (`tools/checkpoint_manager.py`) snapshot directories + DB before risky operations; trajectory export (`batch_runner.py`, `trajectory.py`) produces ShareGPT-format training data; the `tinker-atropos` submodule supports RL training [details UNVERIFIED — not needed for ACUTE-CODE].

## 6. Delegation (relevant to our 5-agent cap)

`tools/delegate_tool.py` spawns child AIAgent instances with fully isolated contexts — the parent sees only the delegation call and the summary result. Key mechanics: `MAX_DEPTH = 1` by default (grandchildren rejected unless raised); strict toolset intersection ("subagent must not gain tools the parent lacks") with hard-blocked tools for children (`delegate_task`, `clarify`, `memory`, `send_message`, `cronjob`); default cap **10 concurrent children** (at capacity, new async dispatches are **rejected, not queued**; one-time warning above 10 — cost "multiplies linearly"); per-child iteration budget 250; summary char budget = half the parent's remaining context headroom split across the batch (floor 2,000 / ceiling 24,000 chars, 75/25 head/tail trim, spill file with `read_file offset=` paging); optional per-child git worktree isolation; children run without memory/context files and with **auto-deny** approval callbacks by default; a steer/stop control plane scoped by ancestry ("a conversation can only control its own spawn tree").

## Sources

- https://github.com/nousresearch/hermes-agent
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/pyproject.toml
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/AGENTS.md
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/hermes_state_schema.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/agent/memory_provider.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/agent/memory_manager.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/agent/context_engine.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/agent/prompt_builder.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tools/memory_tool.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tools/skills_guard.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tools/registry.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tools/approval.py
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tools/delegate_tool.py
- https://api.github.com/repos/NousResearch/hermes-agent/git/trees/main (+ nested trees: `agent/`, `tools/`, `docs/`, `docs/specs/`)
- https://hermes-agent.nousresearch.com/docs/developer-guide/architecture
- https://hermes-agent.nousresearch.com/docs/user-guide/features/memory
- https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
