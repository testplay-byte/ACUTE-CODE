<!-- last-reviewed: 2026-09-17 round-102 -->

# Round 36 — Sub-Agent Orchestration (Phase 3 core)

**Status:** DELIVERED — ADR-0022 implemented end-to-end, live-proven with a
real 2-sub-agent delegation (parallel researcher + coder), 227 tests green,
pushed.

**Owner directive (R36):** full sub-agent capability — 4–50 concurrent
sessions, status monitoring (tap to inspect), smart crash recovery, API-key
management with per-key limits and designated pool keys.

---

## What was built

### The delegate_task tool (backend)
- The model calls `delegate_task({task, role})`; the orchestrator creates a
  CHILD session (`parent_session_id` + `sub_role`, migration 0008) and runs
  it to completion via the existing runtime; the tool result returns the
  child's report (prefixed with a machine-readable `[subagent session: …]`
  line the UI parses).
- Multiple calls in ONE assistant message run in PARALLEL (AI SDK tool
  execution) — fan-out works naturally.
- Recursion guard: children never receive delegate_task (child allowlist
  strips it in prepareTurn).

### The orchestrator (agent-core/src/agents/orchestrator.ts)
- Atomic slot reservation: total semaphore (maxParallel, 1–50) + per-key
  semaphore (perKeyLimit, 1–20) in ONE synchronous step (a check-then-
  increment race was caught by tests and fixed).
- Key assignment prefers POOL slots (ACUTE_PROVIDER_<ID>_SLOT<N>) over the
  primary — "only those API keys will be utilized for running the
  sub-agents"; least-loaded first.
- Crash recovery: failed children are retryable — the retry continuation
  genuinely resumes (R34 history assembly feeds prior work back). Boot sweep
  flips stale `running` sessions to `failed`.
- Live `subagent-status` SSE events on every state transition.

### API surface
- `GET /sessions/:id/subagents` (computed status/progress/tokens/report),
  `POST /sessions/:id/subagents/:childId/retry`.
- `GET/PUT /settings/orchestration` (maxParallel, perKeyLimit — persisted in
  the settings table).
- Key pool CRUD: `GET /providers/:id/keys`, `PUT/DELETE
  /providers/:id/keys/:slot` (masked; the primary is protected).
- `GET /sessions` EXCLUDES children by default (`?includeChildren=1` opts
  in) — the sidebar stays clean.

### UI
- **SubAgentCard**: role + status pill + todos progress + token counts +
  report preview; tap expands the FULL child log (live-polling); failed
  children offer "Retry (resumes from where it stopped)".
- **Settings → Advanced**: the Sub-Agent Orchestration card (max parallel +
  per-key limit steppers).
- **Provider detail**: the API key pool section (masked slots, add/remove).
- The SUB-AGENTS prompt section teaches parallel delegation patterns.

## Live proof (real OpenRouter)
Task: "spawn TWO sub-agents in PARALLEL: researcher lists the project root;
coder creates agents-note.txt; then reply ORCHESTRATION COMPLETE."
- Parent log: user → delegate_task×2 (both sessions linked) → parent
  verified (list_dir + search_files + write_file fix) → "ORCHESTRATION
  COMPLETE."
- Sub-agents: researcher completed (report: file list), coder completed
  (file created on disk — verified).
- Sidebar shows ONLY the parent; `?includeChildren=1` → 3 total.
- Sub-agent cards render live (DOM-verified: "coder · completed · ↑2.0k
  ↓57"; VLM-verified after scroll).
- 0 console errors.

## Tests
227 total (was 219): +8 orchestrator suite (delegation/report, subagents
list, children-exclusion, ATOMIC concurrency gating incl. queued-then-run,
retry-from-log, boot sweep, settings round-trip + clamping, key-pool CRUD
with masking).

## Guardrails documented (ADR-0022)
One-level fan-out; children's usage attributed to themselves; abort leaves
children running (work persists, retryable); the workflows pillar reuses
this orchestrator later.
