<!-- last-reviewed: 2026-09-19 round-108 -->
# ADR-0027: Transient-API retry ladder — three-layer composition

- **Status:** ACCEPTED
- **Date:** 2026-09-07 (round 75; ADR written round 76)
- **Tags:** none (owner-directed)

## Context

The owner's 0.74.0 field report: "sometimes the agent would not work
properly. It would stop halfway and not do anything, or it would not show
me any error… If it fails, it will retry automatically. If it fails again
immediately afterwards… 1.5 minutes… 5 minutes… 10 minutes… one final
attempt… 30 minutes, and if it fails after 30 minutes too, it will stop,
notify the user, and show the error message… due to timeout or due to some
rate limit. If it is some other kind of issue… it will not do this auto
retry logic."

Pre-existing layers: the AI SDK's internal `maxRetries: 4` (seconds-scale,
invisible), the R71-e2 six-class provider-error classifier (backend-only —
the frontend never received the class), and the R71-e2 context-overflow
recovery (one forced compaction + retry). No patient, minutes-scale ladder
existed; mid-turn provider failures surfaced as honest but terminal 502s.

A live 429 repro during the round exposed a precondition bug: the AI SDK
delivers post-retry provider errors as **fullStream error PARTS**, not
iterator throws — the adapter ignored them, so the runtime only ever saw
the generic `NoOutputGeneratedError` ("Check the stream for errors") →
classified `unknown` → NO ladder could ever engage on real rate limits,
and no honest class reached the cards. The adapter now re-throws the
original error (`chat.ts`), letting the classifier see the true shape.

## Options considered

- **Option A — raise the SDK's `maxRetries` / rely on provider fallback.**
  Pros: one line. Cons: still seconds-scale; the owner explicitly asked
  for a patient schedule (up to 30 min); SDK-internal retries are invisible
  to the user.
- **Option B — wrap the adapter (`chat.ts`) with a retry loop.** Pros: one
  call site. Cons: a re-yielded stream re-emits every delta from scratch —
  the live UI would duplicate already-rendered text; the ladder must
  resume the TURN, not the call.
- **Option C — the two runtime catch blocks, mirroring the
  overflow-recovery pattern.** Pros: history re-assembles from the event
  log (free resume — the R43 event-sourcing dividend); the ladder re-runs
  the SAME outer-loop iteration and stays visible on the SSE stream;
  abort-awareness composes with the existing Stop plumbing.

## Decision

**Option C: a pure timing+registry module (`lib/retry.ts`) —
`RETRY_LADDER_MS = [0, 90_000, 300_000, 600_000, 1_800_000]` (the owner's
schedule verbatim; five retries after the initial attempt, SIX attempts
total), driven from the two provider catch blocks in `runtime.ts`.** The
transient split lives in `agents/error-classification.ts`
(`isTransientApiFailure` = rate_limit / network / timeout; auth /
context_window_exceeded / unknown NEVER ladder — the owner's "other kind
of issue" rule; overflow keeps its own recovery, checked BEFORE the
ladder). The wait is abort-aware (a user Stop cuts a 30-minute wait → the
honest ABORTED path) and ticks every 60 s (an SSE `meta.retry` heartbeat:
keep-alive + live countdown). The retry re-runs the same iteration with
`outerIter` compensated — the ladder never spends loop budget and is
bounded by the rung count. The R52-b stall watchdog consults the
active-wait registry: a child waiting out a 30-min rung is
alive-by-construction, never stall-killed.

Layer composition, innermost first: AI SDK `maxRetries: 4` (unchanged) →
OpenRouter free-model provider fallback (unchanged) → overflow recovery
(one compaction retry, unchanged) → **this ladder** (minutes-scale,
transient-only). Total worst case = 5 SDK attempts × 6 ladder attempts.

## Consequences

- Easier: surviving long provider brownouts without user action; the UI
  can show "Retrying — attempt 2 of 6" (amber status card) instead of a
  red error; the terminal card and `task_failed` notification carry the
  attempt count.
- Harder: a turn can legitimately stay open for ~47 minutes (the sum of
  the waits) — SSE keep-alive and the watchdog registry are now load-
  bearing; a genuinely wedged provider takes that long to give up (the
  owner's explicit choice).
- Must do: keep `chat.ts`'s error-PART re-throw intact (without it real
  429s classify `unknown` and never ladder); `r75-retry-ladder.test.ts`
  (19) pins the schedule, the abort path, and the exhaustion contract.
- Reversal cost: LOW — remove the two catch-block hooks; failures return
  to immediate-honest-502 behavior with no schema change.
