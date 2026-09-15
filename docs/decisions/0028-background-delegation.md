<!-- last-reviewed: 2026-09-12 round-98 -->
# ADR-0028: Background delegation & task addressing (delegate_task task_id / background / resume)

- **Status:** ACCEPTED
- **Date:** 2026-09-08 (round 79 — the R73 deliberate deferral, shipped)
- **Tags:** none (the standing R73 queue item)
- **Relates to:** ADR-0022 (sub-agent orchestration — this is its
  addressability tier), ADR-0010 (the append-only event log — the
  `delegation.collected` bookkeeping row), ADR-0027 (the retry ladder —
  a waiting child is alive by construction)

## Context

The R73 queue deferred `delegate_task` task_id/background/resume BY DESIGN:
"the orchestrator is the most delicate concurrency surface and deserved its
own round — the owner's 'don't rush' instruction applied. The last
unshipped piece of the R71 sub-agent discipline." The ask, verbatim from
the round-71/72/73 queue lines: **"addressable, resumable sub-agent
tasks."**

The pre-R79 delegation was BLOCKING-only: `delegate_task({task, role})`
waits for the child and returns its report. ADR-0022 §1 documented that as
a feature ("the parent model coordinates naturally — no polling tool
needed"). What it could not do: name a delegation, start work the parent
does not wait for, or collect a result later — the parent turn that
delegated owned the entire wait, so a long child held the parent's tool
call hostage, and once the turn ended the parent had no handle to anything
a still-running child would produce.

## Decision

### 1. Addressing: `task_id` (migration 0028)

`sessions.delegate_task_id` — the PARENT's own address for a delegation
(the model picks it at delegation time). Grammar
`/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` (an address the model must REPRODUCE
in a later call — no spaces, no JSON-hostile characters). Unique per parent
FOREVER (any status): an address is handed out once, so `resume` can never
resolve the wrong child. `background:true` REQUIRES it (the receipt and
the later resume both address the task by it). Resolution precedence:
task_id → child session id → 4-char code.

### 2. Two run modes, one machinery

`runChildTurn` is extracted so blocking and background share the ONE
implementation (creation → framing → slot → keyring view → turn registry →
watchdog → wrapped emit → run → terminal status + notification + release).
The background mode adds: the tool call returns IMMEDIATELY (the receipt);
the run is fire-and-forget with crash-honesty handlers (an exception in
the machinery flips the child failed + notifies — structurally no unhandled
rejection); the emit is BEST-EFFORT (a background child routinely outlives
the parent turn's SSE stream — a write on the dead stream must never kill
the run); the parent turn's abort still cascades (R48-e1 — the owner's
Stop on the parent stops the background spend; no zombie children).

### 3. `resume` — the collect path (one verb, every state)

`completed` → the final report (the shared last-non-empty-assistant
extraction — the tool result and the Sub-agents panel can never disagree)
+ the collected marker (idempotent). `queued|running` → **the wait**:
~300 ms session-status polls until terminal — the R71 "no sleep-polling"
discipline's collection half: the MODEL never polls, resume IS the wait;
bounded by the child's own lifecycle (stall watchdog, retry ladder, owner
Stop), never an artificial timeout. `failed` → the ADR-0022 §3 retryChild
continuation (the event log is the resume point; no progress → the honest
task re-send). The parent turn's abort during the wait → the honest
"STILL RUNNING" line (no report claimed).

### 4. The delivery channel: the per-turn reminder + the collected lifecycle

The model learns a background task finished WITHOUT polling because the
SYSTEM PROMPT says so, every turn: `prepareTurn` renders the
`## BACKGROUND TASKS` section listing the session's uncollected addressed
children with live status (the taskHints/modeHints ephemeral pattern —
never persisted, never a message mutation; byte-identical when absent).
Collection is ONE mechanism: the `delegation.collected` event on the
PARENT's log — a BLOCKING delegation with task_id writes it at completion
(the report was delivered inline; the reminder must never nag), a
BACKGROUND task writes it at resume. The event is model-invisible by
construction (assembleHistory matches message/tool types only).

### 5. The caps (runaway-fan-out guards)

≥10 queued|running addressed children per parent → further BACKGROUND
delegations refused with the list (the semaphore still caps real
parallelism; this caps the BACKLOG). Duplicate task_id → refusal naming
the existing task's status + the resume affordance.

## Consequences

- The parent can now farm out long work and keep working — the exact
  "addressable, resumable" contract the R71 discipline wanted, with the
  owner watching every child in the existing Sub-agents panel (the frames
  + rows carry `taskId`).
- The model NEVER sleep-polls (the R71 B9 rule): the reminder says what
  finished, resume waits for what hasn't.
- The stopping surface is unchanged and owner-only: POST
  /sessions/:id/stop (the R52-b registry) — the model gets no stop verb
  (a deliberate scope cut; the tool description says so).
- The boot sweep needed no change: a dead sidecar's background child lands
  queued/failed with the INTERRUPTED card and stays resumable.
- Must do: keep the shared `runChildTurn` the ONE path (a fork would drift
  the blocking semantics); keep the collected rule UNIFORM (a bespoke
  per-mode bookkeeping would nag or lose reports); `r79-delegation.test.ts`
  (27) + `scripts/battery-r79.mjs` (10, the request-body oracle) pin the
  whole contract.
- Reversal cost: LOW — the tool schema is additive (the blocking default
  is byte-identical), the column is NULL-defaulted (pre-0028 databases
  read as unaddressed), and the reminder composes nothing when no
  addressed children exist.
