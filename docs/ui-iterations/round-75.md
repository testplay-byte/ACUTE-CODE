<!-- last-reviewed: 2026-09-11 round-87 -->
# Round 75 — The Reliability & Enforcement Round

**Owner's report (verbatim asks):**

> "sometimes the agent would not work properly. It would stop halfway and not do anything, or it would not show me any error… There should be retries… it will retry automatically. If it fails again… 1.5 minutes… 5 minutes… 10 minutes… one final attempt… 30 minutes, and if it fails after 30 minutes too, it will stop, notify the user, and show the error message… due to timeout or due to some rate limit… If it is some other kind of issue… it will not do this auto retry logic."
>
> "the following do not work properly: plan, debug, build, review, explore, refactor… When I had it set to plan mode, it did not only plan, but it also tried to make edits to the files."
>
> "By default, the description of them should not be shown… only when the user hovers."
>
> "the following should be shown in one single row: attach file, access level, behavior, context window, model, reasoning, sending the message."
>
> "It gets cut off to only two lines at max and the user has to scroll… it would show at least five lines at max… if it goes beyond five lines, then it will switch to the scrolling functionality."

Four distinct systems, one round. Every one of them was verified **live in the browser** before shipping — including a real end-to-end plan-mode enforcement test against a live model and a real 429 provider driven through the full retry ladder.

---

## Part A — The transient-API retry ladder (`agent-core/src/lib/retry.ts`, NEW)

The owner's schedule, verbatim, in `RETRY_LADDER_MS`:

```
[0, 90_000, 300_000, 600_000, 1_800_000]   // immediate, 1.5 min, 5 min, 10 min, 30 min
```

Five retries after the initial attempt — **six attempts total**; the sixth failure is terminal (persisted `turn.error` + the `task_failed` notification + the honest error card, all reused from the R43/R71 paths).

**Which failures ladder** — the R71-e2 classifier (extracted to the new pure module `agents/error-classification.ts` for this) already had the split:
- `rate_limit` / `network` / `timeout` → **transient** → the ladder engages (the owner: "due to timeout or due to some rate limit").
- `auth` / `context_window_exceeded` / `unknown` → **fail fast** through the honest error path (the owner: "some other kind of issue… no auto retry"). Overflow keeps its own R71-e2 compaction recovery, deliberately checked BEFORE the ladder.

**Where it hooks** — the two provider catch blocks in `runtime.ts` (the streamed main-agent path + the sync sub-agent path), mirroring the overflow-recovery pattern: classify → transient → budget remains → emit the `meta.retry` frame → wait (abort-aware; ticks every `RETRY_TICK_MS` = 60 s) → re-run the SAME iteration (`outerIter` is compensated — the ladder never spends the outer-loop budget; bounded by the rung count, never infinite). History re-assembles from the event log each iteration, so a retry resumes from everything the model already said.

**The live 429 find (the deepest bug of the round):** driving a REAL 429 provider through the live stack showed the AI SDK delivering provider errors (after its internal `maxRetries: 4`) as **error PARTS on the fullStream — not iterator throws** (agentic steps with tools especially). `streamAiSdkChat` ignored `part.type === "error"`, so the only error the runtime ever saw was the SDK's generic `NoOutputGeneratedError` ("Check the stream for errors" — no status, no message patterns) → classified `unknown` → **the ladder could never engage on real rate limits**. The adapter now re-throws the original error (`chat.ts`), so the classifier sees the true shape (APICallError's statusCode / RetryError's embedded provider text). Live-verified: a mock 429 provider produced `meta.retry {attempt: 2, waitMs: 0}` then `{attempt: 3, waitMs: 90000}` with heartbeat ticks — the exact owner schedule on the wire.

**Error visibility — the other swallow points, all closed:**
1. **The sync-path `ok:true` lie** (the "sub-agent completed" fraud): a sub-agent turn that failed mid-work after partial replies persisted its `turn.error` but returned `{ok: true}` — the orchestrator marked the child completed, fired `subagent_complete`, and the parent model built on half-done work. Now mirrors the streamed twin: real usage of completed iterations recorded (the LOOP_GUARD precedent), error persisted, honest 502 returned.
2. **The boot sweep's silent death:** a sidecar crash mid-turn flipped the session to terminal `failed` with NOTHING in the timeline — the owner's "it just outright stops there." The sweep now writes an `INTERRUPTED` `turn.error` event (the R43 persistTurnError pattern) and resets to `queued` — the interruption is visible forever, and the session stays retryable instead of 409ing.
3. **`errorClass` never reached the frontend** — now rides the 502 details, the persisted `turn.error` payload, `TurnErrorInfo`, and `ErrorTurnItem` all the way to the card.
4. **`meta.overflow_recovery` was untyped fall-through** — now typed + rendered as a transient status note.
5. The terminal error path now flushes the partial streamed text (the R58-c abort-path rule, extended to errors) and records the completed iterations' usage — no silent loss on ANY exit path.

**Supervisor interplay:** the R52-b stall watchdog aborts children with no persisted events for 5 min — a child legitimately sitting in a 30-min retry wait would have been stall-killed at minute 5. The ladder's active-wait registry (`getActiveRetryWait`) is consulted by the watchdog: a registered wait is alive-by-construction; the heartbeat frame says "waiting to retry the provider (attempt 3/6, Ns remaining)" instead of "stalled."

**The UI (the ladder must be VISIBLE, not silent):**
- `meta.retry` frames → `LiveTurn.retry` → **RetryStatusCard** (amber `role="status"`, NOT a red alert — the turn is alive and handling itself): "Retrying — attempt 2 of 6", the class chip (`rate limit`), the class message, a live per-second countdown (locally ticked; the backend heartbeat re-anchors every 60 s), and "the agent keeps working automatically — no action needed". Any content frame (text/thinking/tool/finish) clears it — the retry succeeded. A slow-spinning icon (`ac-retry-spin`, 3 s, reduced-motion-safe).
- The terminal card gains the class chip + "after 6 attempts" (the header, the `attempts` payload, the Copy-details block) and the `task_failed` notification body says "auto-retried 6 times (immediate, 1.5, 5, 10, 30 min) before giving up."

## Part B — Task-mode hard enforcement (`agent-core/src/agents/mode-policy.ts`, NEW)

**Root cause of "plan mode edited files":** the six R73 task modes were PURE PROMPT SUGGESTION — the mode body said "NO EDITS" in prose while the turn's toolset still carried `write_file`/`edit_file`/`run_command`. Only the older permission-mode tier (full/ask/plan/editor, R50-c1) was hard-enforced.

**The policy (the permission-mode mechanism, extended):**

| mode | toolset |
|---|---|
| plan | `PLAN_MODE_TOOLS` verbatim (the R50-c1 owner spec — read/search/web/todos/memory/delegation/`read_skill`/`switch_mode`) |
| review, explore | plan's set + `git_status`/`git_diff`/`git_log` + `analyze_image` + `job_status` |
| debug | FULL toolset (a debugger must edit to fix) — but `run_command` demotes to the AUTO tier in approvals.ts: read-only/build/test commands run; ask-tier commands are DENIED with an honest `switch_mode` note, even under Full-Access permission (the task mode outranks the widening, the denylist-supreme ordering) |
| build, refactor | FULL (no narrowing — working postures) |

Wired at `prepareTurn` (after the R73 frontmatter narrowing — a custom shadow of a read-only builtin stays read-only; frontmatter ∩ policy), the allowlist governs builtin + external + MCP tools uniformly (the single chokepoint), and the system prompt's `toolNames` matches the narrowed set exactly (ADR-0019's dark-tools honesty — the model never sees a tool it cannot call).

**The mode bodies now say the fact, not just the wish:** each read-only mode's iron law reads "This is ENFORCED, not advisory (R75): write_file, edit_file, create_dir, delete_file, run_command, index_project, and job_stop are REMOVED from your toolset while this mode is active — you literally cannot call them." Debug's names its command tier.

**Delegation inheritance (the R50-c1 rule, one tier down):** children copy the parent's `activeMode` at creation (`createSession` gained the input; the INSERT only includes the column when set — pre-0027 migration-test schemas stay valid). A plan-mode parent spawns read-only children; a debug parent's children keep the diagnostics tier.

**Read-only modes are OWNER-PINNED (the live-e2e find):** the first live plan-mode test showed the model discovering it had no write tools — and then calling `switch_mode("build")` to escape and continue editing (the escape hatch the R73 design included). For an owner-set posture that is still "I set plan mode and it made changes." `switch_mode` now REFUSES to leave or clear plan/review/explore ("a read-only posture the OWNER set… ask the owner to switch"), while every non-read-only switch (including entering read-only modes) is unchanged. Live-verified end-to-end: a plan-mode session asked to write a file got the honest read-only toolset report and the file was never touched.

**The UI:** `GET /projects/:id/modes` rows gained `readOnly` (from the policy, so the frontend never duplicates the set) — the picker renders an accent "read-only" badge on plan/review/explore rows. Descriptions are **hover-only** (the owner's ask): every menu row is single-line (icon + name + badges); the full description rides the row's native `title` tooltip. Same treatment for ModeSwitcher (the access-level picker).

## Part C — The composer: one row + the 5-line textarea

**The single row (the owner's exact order):** `[attach] [access] [mode] [context] [model] [reasoning] [send]` — ONE flat cluster, no left/right split, no `justify-between`. The box is a CSS **@container**; below a 560px container the selector pills' text labels hide (icon-only — the row fits at the 480px chat floor; the pills' title tooltips carry the hidden labels). A `flex-1` spacer before Continue/Send pins the action right when there's room; `flex-wrap` survives as the R51-c never-overlap emergency fallback for absurd widths (the freeform mini windows). Measured live: 44px tall (one row) at every width from 386px up; the pre-R75 design wrapped to 76px/two rows below ~530px.

**The textarea autogrow (a never-worked bug, proven):** the JS set `height: 132px`, but the textarea's `flex-1` (flex-basis: 0%) made the flex algorithm IGNORE the height style — it rendered at its intrinsic ~34px and scrolled internally (proven live: `style.height=132px` while `clientHeight=34px`; the owner's "cut off to only two lines"). **The fix:** `flex-1` is gone (the height style now governs) and the growth lives in a `useLayoutEffect` keyed on `input` (fires on typing AND programmatic fills — the suggestion-chip case), capping at exactly **5 visible lines** derived from the live computed line-height + paddings (self-maintaining against font/theme changes; `maxHeight` set alongside so CSS and JS never disagree), after which the box scrolls internally. Live-verified: 3 lines → 73px, empty → 34px, 8 lines → 112px + internal scroll.

---

## Tests

- **NEW `agent-core/tests/r75-retry-ladder.test.ts`** (19): the schedule constants (the owner's exact numbers), the transient split, `waitForRetry` (deadline/abort/tick/zero — fake timers), the registry, the formatter; streamed integration — immediate-rung recovery (meta.retry shape, no error persisted), full ladder exhaustion (6 attempts, terminal 502 + persisted `attempts` + queued, fake-timer advance through all rungs), non-transient second failure stops at attempts=2, user STOP during a wait → ABORTED (never an error); sync integration — immediate-rung recovery, the swallow fix (502 + usage row + queued, never `ok:true`).
- **NEW `agent-core/tests/r75-mode-policy.test.ts`** (27): the policy sets (plan verbatim, review/explore superset, all names real registry vocabulary), the intersection semantics (ALL→policy, narrow, NO_TOOLS sentinel, custom shadowing), turn integration for all six modes + modeless byte-identity (toolset + prompt toolNames + the ENFORCED line), the debug command tier (4 approval cases incl. debug×Full-Access denial), delegation inheritance, and the switch_mode pinning (refusal, same-mode no-op, LIST, non-read-only freedom).
- **NEW chat-format tests** (2): the SDK error-PART re-throw (the live 429 find) + the RetryError message classification.
- **Updated pins:** r43 (the 429 test now exhausts the ladder with fake timers — attempts=6; the tool-work test 500→401 at attempts=2), r71 (network test same shape), r42/orchestrator (the sweep now writes the INTERRUPTED event + queued), r73 (D4 route +readOnly; D5's null-clear probe on build, not a pinned mode), ratings (the INSERT's conditional column), Composer (the R75 single-row contract — direct children, the owner's order, one spacer before Send; permission menu hover-only), TaskModePicker (hover-only + the badge), AgentChatPanel (the pill's direct-child position; +3 NEW card tests), stream-store (+3 NEW meta.retry/note/error-detail tests; fixtures gained `retry`/`note`).

**Totals: root vitest 2613 (2558 + 55), agent-core view 1685, launcher 10 — all green; lint + both typechecks + docs:check (172/0/0) clean.**

## Live verification receipts

- Plan-mode e2e (live model): the write-file request → the model reported its real read-only toolset, no file written, no escape (`/tmp` untouched).
- The retry ladder e2e (mock 429 provider): `meta.retry {attempt 2, waitMs 0}` → `{attempt 3, waitMs 90000}` + heartbeat ticks, `provider.retry_ladder` log lines, exact schedule math on the wire.
- Composer: measured at 386/421/426/641/1500px widths — one row everywhere, labels ≥560px, icons below; textarea 3→73px / empty→34px / 8→112px capped.

## Files

- **NEW:** `agent-core/src/agents/error-classification.ts`, `agent-core/src/agents/mode-policy.ts`, `agent-core/src/lib/retry.ts`, `agent-core/tests/r75-retry-ladder.test.ts`, `agent-core/tests/r75-mode-policy.test.ts`, `docs/ui-iterations/round-75.md`
- **Backend:** runtime.ts (ladder ×2 catch sites, the swallow fix, attempts, terminal flush+usage), chat.ts (the error-part re-throw), modes.ts (enforced-fact bodies), orchestrator.ts (inheritance, watchdog gate, sweep), approvals.ts (debug tier), server.ts (readOnly + the attempts notification), sessions.ts (createSession activeMode), tools/plugins/modes.ts (pinning)
- **Frontend:** api.ts, stream-store.ts, AgentChatPanel.tsx (RetryStatusCard + TurnErrorCard + the note), Composer.tsx (+ the four selectors' container-query labels), index.css (`ac-retry-spin`), nine test files
