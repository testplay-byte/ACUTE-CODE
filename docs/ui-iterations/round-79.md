<!-- last-reviewed: 2026-09-10 round-83 -->
# Round 79 — The Orchestrator Round (delegate_task task_id / background / resume)

**Provenance:** the standing **R73 deferral** — "delegate_task
task_id/background/resume — addressable, resumable sub-agent tasks with the
depth guard (B9's runtime half; the last unshipped piece of the R71
sub-agent discipline)" — deliberately held back round after round because
"the orchestrator is the most delicate concurrency surface and deserved its
own round" (the owner's "don't rush" instruction, recorded in round-73.md).
No new owner field report this round; the session's instruction was
*continue, with planning documentation and backup* — `backup/pre-r79`
branches were pushed to BOTH repos before any edit (the recorded
WORKFLOW §3 deviation: the recent practice runs uncommitted on `main` with
the release agent's single commit; the pushed backup branch is this round's
WIP-safety replacement). The plan is `agent-ctx/R79-plan.md`; the design
contract below is its verbatim semantics.

**Everything is implemented, unit-tested (+27), live-battery-verified
(10/10 stages with the request-body oracle), and version 0.78.0.**

---

## 1. The tool: one verb, three addresses, two run modes

`delegate_task`'s input schema grew from `{task, role}` to
`{task, role, task_id, background, resume}` (all optional; validated at
dispatch — the tool NEVER throws, every refusal is `{ok:false, output}`):

| call | semantics |
|---|---|
| `{task, role}` | **BLOCKING** — the pre-R79 behavior verbatim: the call waits for the child and returns its final report inline (the existing suite green-unmodified is the regression gate). |
| `{task, task_id, background:true}` | **BACKGROUND** — the call returns IMMEDIATELY with the receipt (`[background task: <task_id> \| subagent session: <id> \| code: … \| role: … \| model: …]` + "resume to collect; do NOT poll"), the child runs DETACHED and outlives the parent turn. |
| `{resume: <address>}` | **COLLECT** — wait for / re-read / retry the task; `task`/`role` ignored. |
| neither | the honest **addressable list** (every child: task_id / session id / code / role / status). |

- **task_id grammar** `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` — an address
  the model has to REPRODUCE in a later `{"resume":"…"}` call, so no spaces
  or JSON-hostile characters. Unique per parent FOREVER (any status — an
  address is handed out once; a duplicate refusal names the existing task
  and teaches the resume).
- **The ≥10 outstanding cap** (queued\|running children with a task_id):
  further BACKGROUND delegations are refused with the list. The guard is
  background-only — a BLOCKING delegation's parallelism is already
  semaphore-bounded.
- **resume resolution order:** `delegate_task_id` → session id → 4-char
  code (case-insensitive). Then: `completed` → the final report + the
  collected marker; `queued|running` → **the wait** (~300 ms status polls
  until terminal — the R71 "no sleep-polling" discipline's collection half:
  resume IS the wait); `failed` → the retryChild continuation (ADR-0022 §3
  — the event log is the resume point; a no-progress failure honestly
  re-sends the task instead); the parent turn's abort → the honest
  "STILL RUNNING — resume it in a later turn" line.
- **A misbehaving background task is stopped by the owner** from the
  Sub-agents panel (the R52-b turn registry) — the tool description says
  so; the model gets no stop verb (out of scope, recorded).

## 2. The detached run: one shared machinery, best-effort emit

The child-run machinery `delegateTask` carried inline (creation → framing →
slot → keyring view → registry → watchdog → wrapped emit → run → terminal +
notify + release) is **extracted into `runChildTurn`** — blocking and
background share ONE path (the observable blocking behavior is unchanged:
the existing orchestrator suite passed unmodified).

The background differences, each documented at the code:

- **Fire-and-forget with crash honesty:** the detached promise carries its
  own fulfill/reject handlers — an exception in the MACHINERY itself flips
  the child `failed`, emits the failed frame (best-effort), notifies the
  owner, and logs `delegation.background.crashed`; structurally no
  unhandled rejection.
- **Best-effort emit:** every frame and forwarded event through a
  background child is try/caught and swallowed — a background child
  routinely OUTLIVES the parent turn's SSE stream, and a write on the dead
  stream must never kill the run (a throwing emit is pinned by a unit
  test; harmless for the blocking path).
- **The parent-turn abort still cascades** (R48-e1 semantics preserved):
  the owner's Stop on the parent stops the background spend — no zombie
  children after a stop. A normally ENDED turn never aborts its
  controller, so a healthy child outlives it (the battery's S79-3 is
  exactly that proof).
- The slot acquisition lives INSIDE the detached run — a full semaphore
  leaves the child honestly `queued` while the tool call already returned.

## 3. The delivery channel: the per-turn BACKGROUND TASKS reminder

How does the model learn a background task finished without polling?
**The system prompt tells it, every turn** — the taskHints/modeHints
pattern (R72-a/R73-b), one tier over: `prepareTurn` computes
`buildBackgroundTasksReminder(db, session.id)` — the session's children
with a `delegate_task_id` whose reports have NOT been collected — and
`buildProjectSystemPrompt` renders the `## BACKGROUND TASKS` section (only
when non-empty; absent → byte-identical composition — the golden fixture's
proof; the prompt-registry gained section id `background-tasks`, count
23 → 24):

```
## BACKGROUND TASKS
Delegated tasks in flight or awaiting collection — call delegate_task {"resume":"<task_id>"} to WAIT for a task and collect its final report; do not poll (resume waits):
- auth-research (role: researcher, code: K7F2): COMPLETED — resume to read its final report
- lint-sweep (role: coder, code: M3XN): running — 3m in, 1/4 todos
- dep-scan (role: reviewer, code: P8LT): FAILED (provider error…) — resume to retry it from where it stopped
```

EPHEMERAL: rebuilt from live rows every turn, never persisted, never a
message mutation. The CHEAP GUARD (one indexed `LIMIT 1` probe on
`idx_sessions_parent_task`) means every session without addressed children
— every pre-R79 session, every ordinary turn — composes byte-identically
at negligible cost. The section caps at 10 rows + "…and N more".

**The collected lifecycle (one mechanism, uniform):** a
`delegation.collected` event on the PARENT's log. A **BLOCKING** delegation
with task_id writes it at completion (the report was delivered inline —
the reminder must never nag; EXCEPT when the parent turn aborted mid-call:
the tool result was abandoned, the reminder keeps listing the task). A
**BACKGROUND** task writes it when resume returns the report — idempotent.
The event is invisible to the model by construction (assembleHistory's
fold matches message/tool types only — the R78 message.queued pattern, one
tier over: a queued row is a pending MESSAGE; a collected row is durable
BOOKKEEPING). The boot sweep needs no change: a dead sidecar's background
child lands queued/failed with the INTERRUPTED card and stays resumable
(pinned by a unit test).

## 4. Persistence + the wire

- **Migration 0028:** `sessions.delegate_task_id TEXT` (NULL default =
  unaddressed, the pre-R79 behavior) + `idx_sessions_parent_task
  (parent_session_id, delegate_task_id)` + the audit_log row. The INSERT's
  column-tail pairs grow conditionally (pre-0028 schemas never see the
  column — the R73 rule).
- **GET /sessions/:id/subagents rows** gained `taskId: string | null`
  (additive; old consumers unaffected). The **subagent-status SSE frames**
  gained optional `taskId` from the FIRST (queued) frame onward — the
  panel's chip renders before the first poll.
- **Frontend (R79-b):** the Sub-agent panel header's task chip
  (`subagent-taskid-chip`, mono, beside the code chip, the tooltip teaches
  the resume affordance) and the chat SubAgentCard's meta-line chip
  (`subagent-card-taskid`) — both render only when taskId is non-null;
  resolved live-first (the SSE map) with the polled row fallback
  (stream-store's carry semantics = the model field's). The event fold
  needed NO change (the allowlist chain skips `delegation.collected`
  silently by construction).

## 5. The live battery (the battery-r78 harness, one round later)

`scripts/battery-r79.mjs` — a dedicated sidecar (5197, scratch DB) + the
mock OpenRouter-compatible provider on 5196 that **records every request
body (the model-facing oracle)** and dispatches child vs parent calls by
the raw body (a child's history ALWAYS carries the ROLE_FRAMING marker; a
parent's NEVER — checking the raw body, not the last message, is the
lesson: a tool-looping child's requests END with tool results).

| stage | proof |
|---|---|
| S79-1 | boot: sidecar + mock + the project/agent seeded |
| S79-2 | **blocking regression**: the parent's second request body carries the child's report inline (the model SAW it), child completed, `taskId` null — pre-R79 verbatim |
| S79-3 | **background**: the turn done in ~400 ms while the child's chat sleeps 4 s; the receipt inline in the next request body; the child COMPLETED after the turn ended (the detached run outlived it) |
| S79-4 | the NEXT turn's request body carries `## BACKGROUND TASKS` + `bg-research` + `COMPLETED` (the model is TOLD, without polling) |
| S79-5 | resume collects: the report inline; the SUBSEQUENT turn's body has NO section (the collected marker) |
| S79-6 | resume WAITS: the tool-call → done frame gap ≈ 2.7 s for a 3 s child, then the report |
| S79-7 | duplicate task_id refused honestly ("already used" inline) |
| S79-8 | `/subagents` rows carry `taskId` |
| S79-9 | unknown-address resume → the honest addressable list (real ids) |
| S79-10 | the failed child: resume retried it — the child's request body carries the "You were interrupted" continuation (the oracle), the retry report returned, the child completed |

**Result: 10 PASS / 0 FAIL.**

## 6. Verification

- **Root suite: 2741/2741 green in 145 files** (+33 over R78's 2708/144:
  agent-core 1742 → 1769 — NEW `r79-delegation.test.ts` (27: the dispatch
  matrix, immediate-return + detached completion + frames + notification +
  slot release + best-effort emit + refusals, resume
  wait/collect/retry/abort/idempotence, the reminder builder + prompt
  composition + the runtime wiring (the section appears in the live system
  prompt and disappears after collection), storage semantics, the sweep
  interplay) + the 3 honest adjustments (registry count 23→24, the
  composition ctx gate, the migration list); frontend 954 → 960 (+6: the chips ×3 +
  the card chip + the stream-store frames ×2).
- **lint clean, root + agent-core typechecks clean, shared + agent-core
  built clean (dist ships 0028).**
- `version:check` 0.78.0 ×4; `docs:check` green (the stamp cohort aged
  out at round 79 per DOC-STANDARDS §8 — first-line-only bumps,
  diff-verified; see the worklog's R79-c entry for the exact count).

## 7. Honest notes

- **The interrupted sub-agent:** the R79-a dispatch died mid-flight (the
  harness's context deadline) AFTER writing the implementation. The
  orchestrator verified it line-by-line (the never-trust rule —
  AGENT-MEMORY #76's "complete but uncommitted is a claim"), found the
  implementation real, and wrote the entire test + battery half itself.
  The worklog's R79-a entry records exactly which half is whose.
- **The battery's three mock lessons** (each cost a failing run): (1) a
  request-body oracle must search by the TURN'S USER MESSAGE — the reply
  text is what the model GENERATES, never what it receives; (2) a mock 500
  is NETWORK-transient → the R75 ladder auto-retried the "doomed" child
  (S79-10 must use 400 = fail-fast unknown — the ladder doing exactly its
  job, in the wrong test); (3) dispatch on the raw body, not the last
  message, and the failure-streak length is the RUNTIME's decision
  (maxOuterLoops retries) — the mock's `{failForever}` latch makes "the
  child is down" deterministic, cleared right before the resume.
- **Residuals (recorded, honest):** the sync-path child `turn.error` text
  stays the generic provider line (pre-existing, out of R79 scope — the
  reminder excerpt carries whatever the log holds); the resume wait's
  300 ms poll interval is internal and model-invisible; the model has no
  stop verb for background tasks (the owner's panel Stop is the surface —
  a deliberate scope cut).
- **The WORKFLOW §3 deviation** (recorded in the plan): the round ran
  uncommitted on `main` per the recent 12-round practice, with the pushed
  `backup/pre-r79` branch (ff65a5f / 555d682) as the pre-round safety net
  the session instruction asked for.

## 8. Files touched

Backend: `storage/migrations/0028_delegation_task_id.sql` (NEW),
`storage/sessions.ts` (taskId everywhere + the shared extractions +
the collected event + the reminder builder),
`agents/orchestrator.ts` (runChildTurn extracted; delegateBackground;
resumeTask; the refusals; best-effort emit),
`tools/plugins/delegation.ts` (the schema + description + dispatch),
`agents/runtime.ts` + `agents/prompts.ts` + `agents/prompt-registry.ts`
(the reminder wiring + the section + the registry entry). Frontend:
`lib/api.ts` (SubAgentStatus.taskId + the frame's taskId),
`lib/stream-store.ts` (the live entry's taskId), `right-sidebar/
SubAgentPanel.tsx` (the header chip), `project-chat/SubAgentCard.tsx`
(the meta-line chip). Tests: `agent-core/tests/r79-delegation.test.ts`
(NEW, 27) + the 3 honest adjustments + the frontend +6 and the three
fixture `taskId: null`s. Tooling: `scripts/battery-r79.mjs` (NEW).
Docs: round-79.md (this file), ADR-0028 (NEW), CHANGELOG 0.78.0,
status.json (round 79), HANDOFF, ARCHITECTURE (the schema line),
IMPLEMENTED-API (the ROUND-79 section), DESIGN-SYSTEM (the chips),
AGENT-MEMORY #81–#82, the indexes.
