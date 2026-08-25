<!-- last-reviewed: 2026-08-25 round-36 -->

# ADR-0022: Sub-Agent Orchestration (delegate_task + key pools + recovery)

**Status:** Accepted (round 36, 2026-08-25) · **Supersedes:** none · **Relates to:** ADR-0010 (event log), ADR-0011 (concurrency), PILLARS.md §1–§5

## Context

The owner directed (R36): give the agent full sub-agent capability — spawn
4–50 concurrent sub-agent sessions, monitor their status/progress, recover
crashed sub-agents from where they stopped, and manage API keys so sub-agents
don't burden a single key (per-key concurrency limits, designated pool keys).

## Decision

### 1. Delegation as a project tool: `delegate_task`

A single tool, available in project sessions, matching PILLARS §1
("specialized agents = tools within a turn"):

```
delegate_task({ task: string, role?: "planner"|"researcher"|"coder"|"reviewer"|"tester" })
```

- **Blocks until the child completes** and returns the child's final report
  as the tool result — the parent model coordinates naturally (no polling
  tool needed). Multiple `delegate_task` calls in one assistant message
  execute CONCURRENTLY (AI SDK v7 parallel tool execution), giving fan-out.
- The child is a REAL session: `parent_session_id` + `sub_role` columns
  (migration 0008), same project, parent's provider/model/temperature +
  the role's framing prepended to the task message (role templates carry no
  provider, so the parent's config is the executor — PILLARS "agent node =
  the existing turn runtime, verbatim": children run `runSingleAgentTurn`).
- The child's `argsSummary` carries `session: <id>, role, task` — the UI
  parses it to mount live SubAgentCards without schema changes.

### 2. Orchestrator: semaphores + key assignment (agent-core/src/agents/orchestrator.ts)

Module-level singleton (one sidecar process = one orchestrator):

- **Total semaphore**: `orchestration.maxParallel` concurrent children
  (settings table; default 5, configurable 1–50 — the owner's range).
- **Per-key semaphore**: `orchestration.perKeyLimit` concurrent children per
  API key (default 3) — "not burden the API keys".
- **Key pool**: `ACUTE_PROVIDER_<ID>` stays the primary; pool slots are
  `ACUTE_PROVIDER_<ID>_SLOT<N>` (N ≥ 2). Children are assigned the
  LEAST-LOADED slot, preferring pool slots over the primary (the owner:
  "only those API keys will be utilized for running the sub-agents"); with
  no pool, children share the primary under the per-key limit.
- Excess children stay `queued` until a slot frees.

### 3. Crash recovery = the event log (ADR-0010 pays off)

- A failed child turn marks the session `failed` and records the error.
- **Retry** (`POST /sessions/:parent/subagents/:child/retry`) sends a
  CONTINUATION message ("continue from where you stopped…") — history
  reassembly (R34 `assembleHistory` incl. tool results) means the child
  genuinely resumes with all prior progress. If it produced nothing, the
  original task re-sends.
- **Boot sweep**: sessions left `running` by a dead sidecar flip to `failed`
  (retryable) at server start.

### 4. Live status + monitoring

- Orchestrator emits `subagent-status` SSE events on state transitions via
  the parent's stream (queued/running/completed/failed + todos progress +
  tokens), so the chat UI updates live.
- `GET /sessions/:id/subagents` lists children with computed status
  (progress from todo.update events, tokens from usage_events, report from
  the last assistant message) — the UI's tap-to-inspect dialog renders the
  child's full log.
- Children are EXCLUDED from `GET /sessions` by default (sidebar stays
  clean); `?includeChildren=1` opts in.

### 5. Settings

- `GET/PUT /settings/orchestration` (maxParallel, perKeyLimit) → the
  settings table; the Advanced page exposes steppers.
- Key-pool CRUD: `GET /providers/:id/keys` (slots, masked),
  `PUT/DELETE /providers/:id/keys/:slot`; `POST /internal/providers/keys`
  gains `slot` for the shell path. The provider detail pane manages the pool.

## Consequences

- Fan-out depth is capped at ONE level (children don't get delegate_task —
  their tool list excludes it) — recursion/avalanche guard.
- Children write their own usage_events (real attribution); the usage
  dashboard counts them.
- Abort semantics: children run to completion even if the parent stream
  aborts — their work persists in their own sessions (retryable/inspectable).
- The workflows pillar (PILLARS §3) later reuses this orchestrator for
  workflow agent-nodes.

## Guard test

No `workflow_executions` rows in `sessions` (PILLARS §3) — children ARE
sessions by design (they're conversations with a parent), which the
`parent_session_id IS NOT NULL` marker distinguishes.
