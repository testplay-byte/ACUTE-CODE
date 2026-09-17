<!-- last-reviewed: 2026-09-17 round-102 -->
# Phase 3 Plan — Orchestration Engine (DRAFT — starts after Phase 2 approval)

Owner: Orchestrator · Planner artifact · 2026-08-22

**Exit criterion (SPEC §8):** live demo — (a) 3 agents (Planner → Coder → Reviewer) complete a small coding task, and (b) a 2-agent run completes a research-and-summarize task; the owner watches both in the UI.

## Waves (max 2 sub-agents concurrent; every wave: pnpm verify green + push, CI authoritative)

| # | Task | Owner | Status |
|---|---|---|---|
| 1 | **Approval engine (F6)** — the security boundary: policy evaluation per ARCHITECTURE §7 (denylist-supreme 6-step order), pending-approval store + WS `approval.*` events, modal round-trip UI, audit_log rows, remembered grants (non-destructive only), 15-min deny-on-expiry, Settings denylist | Developer | PENDING |
| 2 | **WS layer (API.md §6)** — `@fastify/websocket`, first-message auth frame, seq-based subscribe + reconnect backfill; replace refetch-after-turn in the UI | Developer | PENDING |
| 3 | **Run loop + message bus (F3)** — session runner state machine, typed pub/sub bus (MetaGPT pattern: watch-by-type, address filtering), task store + `task.*` events, 5-agent global semaphore with queueing (`agent.queued`), delegation-as-task-tool (Kilo/OpenHands pattern: isolated child context, summary-only return) | Developer | PENDING |
| 4 | **Run modes** — single (exists), auto-team (orchestrator composes team from task → delegates via task tool; cheap-orchestrator model routing), manual (agent picker, minimal UI) | Developer | PENDING |
| 5 | **Task board UI (F9 screen 4)** — Kanban per session (queued/running/done per agent), live agent transcripts, approval prompts surface in-session | Developer | PENDING |
| 6 | Integration tests (full multi-agent run, SPEC §7), Tester pass, Reviewer pass, DEMO.md update, phase report | Tester/Reviewer/Orchestrator | PENDING |

## Design inputs (cite in ADRs)

- `docs/research/README.md` §4 (delegation-as-task-tool won; typed pub/sub for shared context), §5 (approvals consensus design: security-risk fields on actions, arg-scoped remembered grants)
- ADR-0001 (topology as data), ADR-0010 (append-only events), ADR-0011 (in-process runners, 5-slot semaphore)
- Open questions to resolve during design: approval expiry default ratification (15-min deny — from Phase 2 report); whether auto-team orchestrator gets its own model config field on AgentRecord (recommend: `orchestratorModel` override, default = agent's model)

## Constraints

- Approval engine is security-critical: complete, unbypassable, denylist-supreme, fail-closed, NO "always allow" for destructive categories (SPEC F6). Unit tests for every evaluation-order branch are mandatory.
- No new dependencies without license check + ADR.
- Every wave ends with `pnpm verify` green, push, CI green.
