<!-- last-reviewed: 2026-09-12 round-98 -->
# ADR-0011: Agent execution — in-process runners with a global 5-slot semaphore

- **Status:** ACCEPTED (implementation-detail decision under the smaller-scope rule; surfaced per protocol)
- **Date:** 2026-08-21

## Context

SPEC §F3 caps concurrency at 5 running agents, queued beyond, with a shared message bus and live task board; the memory budget is <2.5 GB with 5 agents (SPEC §5). ADR-0001 fixed the run modes and delegation-first auto-team. The unanswered mechanical question: are agents OS processes or in-process async runners inside the single sidecar?

## Options considered

- **A. In-process runners (async tasks) + typed pub/sub bus + semaphore** — each agent is an async runner task in the one Node process; the bus is an in-memory typed event pool (metagpt); delegation is a tool call (`delegate_task`) where the child gets isolated context and returns a summary (kilocode `task` tool; openhands `TaskToolSet`); a global semaphore (5) queues overflow.
- **B. Child process per agent (goose-daemon-per-extension shape)** — hard isolation, one hung agent cannot stall the loop; but 5 Node processes burn ~80 MB each before any work (≈40 % of the entire 5-agent budget), IPC multiplies the bus surface, and SQLite single-ownership (SPEC §3) forces every child back through the parent anyway.

## Decision

**Option A.** One process; runners are lightweight async tasks; the semaphore lives in `orchestration/` and is enforced for every mode (single sessions included — the cap is global, per SPEC §F3). A wedged runner is handled by per-runner timeouts and the session `stop` control path, not by process fences.

## Consequences

The message bus is a plain in-process typed emitter — no IPC serialization, no port management; transcripts append straight into the event log (ADR-0010). Tool execution blocks the shared event loop only in synchronous better-sqlite3 calls (short) — shell/file tools are already async. Failure containment is weaker than process isolation: a native crash (e.g., inside a native addon) takes all agents down, mitigated by the append-only log making recovery cheap (ADR-0010) and by keeping native surface minimal (only better-sqlite3, ADR-0007). Reversal cost: moderate — runner spawn is one factory function; a future per-agent-process mode could reuse the same bus contracts over IPC if isolation ever outweighs the memory budget.
