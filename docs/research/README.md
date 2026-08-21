# Research Index — Reference Project Analyses

Phase 0 deliverable · 9 references · all memos verified against live sources on 2026-08-21/22 · Each folder contains `README.md` (executive summary), `architecture.md` (system design), `patterns-for-acute-code.md` (adoption mapping with WHAT/WHY/HOW).

| Reference | License (verified) | What it is | One-line takeaway for ACUTE-CODE |
|---|---|---|---|
| [cline](cline/) | Apache-2.0 | VS Code agent, hub-spoke SDK | Plan/Act split, layered SDK packages, shadow-git checkpoints; daemon topology nearly identical to ours |
| [opencode](opencode/) | MIT | TS agent server + TUI clients | The client/server split we're copying; permission round-trip API; Drizzle/SQLite storage |
| [hermes-agent](hermes-agent/) | MIT | Self-improving CLI agent | Bounded markdown memory + SQLite FTS mirror with frozen-snapshot injection; self-authored skills; non-bypassable approval floor |
| [metagpt](metagpt/) | MIT | Role-based SOP multi-agent framework | Typed pub/sub message pool; SOP-as-data topology; budget hard-stop; stage-gated artifacts |
| [openhands](openhands/) | MIT | Agent platform, now split UI + Agent Server | Event-sourced sessions (one-JSON-per-event); typed event schema with approval semantics; delegation-as-tool |
| [kilocode](kilocode/) | MIT | VS Code client over shared core | Markdown agent files with ordered glob permissions; task-tool subagents with summary-only return; Agent Skills standard |
| [aider](aider/) | Apache-2.0 | CLI pair-programmer | Repo map (PageRank, token-budgeted); edit-format ladder with structured error feedback + reflection retries; honest cost accounting |
| [goose](goose/) | Apache-2.0 | Desktop app + Rust daemon | Sidecar lifecycle with leases; layered permissions with remembered grants; SQLite usage ledger with cost provenance |
| [letta](letta/) | Apache-2.0 | Stateful agent server (MemGPT lineage) | Budgeted memory blocks with history audit; memory tools given to the agent; sleeptime background curation |

All nine are MIT or Apache-2.0 — fully compatible with our allowlist for pattern study; we copy no code from any of them.

## Cross-cutting synthesis

1. **Our core architecture is the field's convergence point.** Five independent projects arrived at "UI client ↔ local agent server over HTTP/WS with SQLite": Cline (hub-spoke daemon, lock-file discovery), OpenCode (TS server, code-generated client SDK), Kilo (`kilo serve`, every product a client), Goose (desktop spawns `goosed` on an ephemeral localhost port with env-borne secret), OpenHands (headless Agent Server with session API keys). The Tauri-shell + Node-sidecar decision in our stack table is validated five times over. Goose's lease/refcount lifecycle and OpenCode's codegen client are the two concrete mechanics to steal for Phase 1 design.

2. **Memory: markdown as source of truth, SQLite as index, bounded and injected per policy.** Hermes (MEMORY.md/USER.md + FTS5 mirror; per-session frozen snapshot to protect prompt cache and resist mid-session injection) and Letta (char-budgeted blocks, `block_history` audit table, memory tools the agent itself calls) independently validate the SPEC §F8 design. Adopt: budgets on every store, history/audit on every mutation, writes staged through approval.

3. **Skills: the SKILL.md folder standard is universal.** Hermes (self-authored, security-scanned on write) and Kilo (Agent Skills standard, progressive disclosure, project/global scope) both use it — matching the owner's v1 skills decision. Keep v1 minimal: folder + SKILL.md, per-agent enable, context injection; add scanning/guardrails later if we ever allow agents to write their own.

4. **Orchestration: delegation-as-tool with context isolation won.** MetaGPT's typed pub/sub pool with subscriptions remains the best message-busus model for shared context; but Kilo deprecated its dedicated "orchestrator mode" in favor of a plain `task` tool (child gets isolated context, returns a summary), and OpenHands implements the same shape (`TaskToolSet`, typed registry, resumable sub-conversations). For our auto-team mode (ADR-0001): orchestrator plans on the shared bus, delegates via a task tool, workers return structured summaries — topology stored as data (MetaGPT's SOP-as-data lesson).

5. **Approvals: layered, denylist-supreme, auditable — the consensus design.** Hermes hardline floor that no bypass crosses; Goose remembered grants keyed `tool:hash(args)`; Kilo ordered allow/ask/deny glob rules, last-match-wins; OpenCode ask/allow/deny + regex command filters with an approval round-trip endpoint; OpenHands typed rejection observations + security-risk fields on actions. SPEC §F6 (denylist wins, no always-allow for destructive, SQLite audit log) is exactly the intersection — add OpenHands' "every action carries a security-risk field" and Goose's arg-scoped remembered grants to the Phase 1 design backlog.

6. **Storage: SQLite WAL everywhere, with an event-sourced session log.** Goose (`sessions`/`messages`/`usage_ledger`, cost provenance per row), Hermes (single-writer queue + FTS5), OpenCode (migrating JSON→Drizzle/SQLite), OpenHands (Agent Server on SQLite; state = `base_state.json` + one-JSON-per-event), Letta (SQLAlchemy/Alembic). Adopt for Phase 1: SQLite WAL owned by the sidecar, per-request usage rows (goose/hermes pattern), and an append-only session event table (OpenHands pattern) rather than in-place transcript mutation.

7. **Editing reliability: an application ladder with structured errors beats hoping.** Aider's exact→indent-shift→elision ladder, `SearchReplaceNoExactMatch` errors fed back with did-you-mean context, and `max_reflections=3` retries are the proven recipe for our file-edit tool; its repo-map (PageRank-ranked, binary-search token fitting) is the future context-economy upgrade for Coder agents. Cline's Plan/Act with enforced per-mode toolsets maps to our single-agent default vs auto-team split.

8. **Recurring anti-patterns to avoid** (cited across memos): autonomous-by-default anything (goose), fail-open security gates (goose OSV), monolithic core files (hermes' 560 KB `run_agent.py`), secrets in config files (goose history), storage sprawl across formats (opencode pre-migration), tool-count bloat (hermes 70+), mirroring any vendor's API verbatim (letta blocks may deprecate), and Python-stack lock-in when porting concepts (hermes/metagpt/aider/letta).

## How this feeds Phase 1

`ARCHITECTURE.md` must cite these memos when fixing: sidecar lifecycle & API contracts (goose, opencode, cline), SQLite schema & event model (goose, openhands, hermes), permission/approval engine design (hermes, kilocode, opencode, openhands), orchestration run modes (metagpt, kilocode, openhands), memory & skills (hermes, letta, kilocode), and the edit-tool contract (aider).
