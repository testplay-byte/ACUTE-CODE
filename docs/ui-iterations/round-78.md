<!-- last-reviewed: 2026-09-08 round-78 -->
# Round 78 — The Honest-Errors + Queue Round (Retry Honesty, Composer Anchor, Retry Config, Message Queue)

**Owner's report (the four verbatim asks):**

> 1. **限流重试逻辑** "The 6-attempt retry mechanism is flawed — no matter
>    the real cause, the UI always shows 'rate-limited'. Only a REAL rate
>    limit may show as one; every other failure must show the API's ACTUAL
>    error text. Robustify the whole error chain."
> 2. **底部按钮排版** "The chat bottom buttons (Continue etc.) occasionally
>    render in wrong positions — fix layout stability."
> 3. **General Settings 重试配置** "Add a retry-config section in General
>    Settings — switches for auto-retry on timeout / rate limit."
> 4. **工作中发送消息（排队）** "While the agent is working, the user can
>    still send messages; they queue and auto-send right after the current
>    tool call; the agent reads them with full context and continues — never
>    interrupting the in-flight flow."

Every one is implemented, unit-tested, live-battery-verified (12/12 stages),
and browser-verified against the real dev stack. Version **0.77.0**.

---

## 1. Error-chain honesty: the class is a chip, the API's words are the message (ask 1)

The round opened with REAL provider-error probes (the production AI SDK
`ai@7.0.73` against the production classifier) — the root-cause table behind
"the UI always shows rate-limited":

| probe | shape | classified (R77) | truth |
|---|---|---|---|
| bad key | APICallError 401 "User not found." | auth ✓ | auth |
| bad model | APICallError 400 "…not a valid model ID" | unknown ✓ | model error |
| paid model on free key | APICallError 403 "This model is not available in your region." | **auth ✗** (the card said the key was rejected — a lie) | region block |
| free model, quota burnt | APICallError 404 "This model is unavailable for free…" | unknown, generic line | quota/availability |
| meta-router after SDK retries | **RetryError** "Failed after 5 attempts. Last error: AI_APICallError: Rate limit exceeded: free-models-per-day…" | rate_limit by message-pattern LUCK — `extractStatus` never walked `lastError`, so the RetryError carried NO extractable status | rate_limit ✓ |

Three defects, one fix each (`agent-core/src/agents/error-classification.ts`):

- **The SDK's RetryError was never unwrapped.** NEW `unwrapRetryError`:
  an `{name:"AI_RetryError"}` object returns its `lastError` (falling back to
  the LAST `errors[]` element); anything else passes through; never throws.
  `classifyProviderError` now classifies the UNWRAPPED error — status, error
  name (a wrapped `TimeoutError`'s real name, not the wrapper's), and message
  patterns all read the underlying failure. `extractStatus` walks
  `lastError` + `errors` (depth ≤ 4, cycle-guarded) so a wrapped 429 finally
  classifies by STATUS, not luck. `providerErrorDetail` unwraps first too —
  the real body, not "Failed after 5 attempts. Last error: …".
- **403 said "authentication failed" when the provider said no such thing.**
  A 403 whose real message matches the region/access patterns (not available
  in your region / region / moderation / permission / not available /
  unavailable / blocked) reclassifies to `unknown` — fail-fast, because no
  ladder can heal a region block — carrying the REAL text. Plain 403 stays
  auth; 401 stays status-only auth (the cline rule).
- **`userMessage` was always a generic one-liner.** It is now the REAL
  provider text (trimmed, 240-char cap + ellipsis); the generic lines demote
  to the empty-text fallback and stay exported as `CLASS_MESSAGES`. The
  runtime's `classMessage` is the key-scrubbed real text (scrub at the
  runtime boundary — the pure classifier stays key-less by design), and every
  `meta.retry` frame + both terminal error envelope details + the persisted
  `turn.error` payload carry `providerError` (the scrubbed real text).

**The UI side (B1):** the live `RetryStatusCard` renders the class chip as
the one-glance summary and the API's ACTUAL words beneath it — a mono,
break-words, 3-line-clamped line (`data-retry-provider-error`); payloads over
240 chars collapse to the excerpt with the R77 expand-toggle treatment
(`data-retry-provider-expand` → the complete text in a scrollable mono `pre`
`data-retry-provider-error-full`, max-h-44). No real text (a pre-R78
sidecar) → the class message stands alone exactly as before. Only a REAL
rate limit ever shows as one now: a 400 model error, a 404 quota error, and
a 403 region block all fail fast with the API's own words (pinned live by
S78-2/S78-3 below).

## 2. The composer action anchor (ask 2)

R77 locked the send button to its right-side CLUSTER — but the cluster itself
lived inside the wrapping toolbar row, so when space ran out the whole
cluster (Continue/Send included) could still wrap to the next line and land
"below the designated options" — the owner's intermittent wrong-position
report. R78 restructures the toolbar into a **wrapping area + a never-wrapping
action anchor**:

```
<div toolbar: flex items-end justify-between gap-1 px-2 pb-2 pt-1>
  <div wrap area: flex-1 min-w-0 flex-wrap items-center gap-1>
      [data-composer-left:  attach · access · task mode]
      [data-composer-right: donut · model · thinking]  ← ml-auto shrink-0, INSIDE the wrap area
  </div>
  <div data-composer-actions: shrink-0, NEVER wraps>   ← THE ANCHOR
      [Continue] · [Send | Stop | Queue-send]
  </div>
</div>
```

The actions are a DOM **sibling** of the wrap container, pinned right by the
toolbar's `justify-between` — they are not inside any wrapping context, so
they can never jump lines or drift. When the row gets tight the SELECTORS
wrap as a unit under the left cluster (right-aligned by their own `ml-auto`);
the Send/Stop/Continue/Queue button stays pinned bottom-right at every
width. The `@max-[560px]` label-hide and the R77 left/right membership are
preserved. Browser-verified at 386 / 480 / 560 / 641 / 900 px: the anchor
holds with Continue + Send visible (rightGap 8 px — exactly the toolbar
padding — at every width; at 386 px the selectors wrap INSIDE the wrap area
while the actions stay anchored). Without `onQueue`, the composer's behavior
is byte-identical to R77's.

## 3. The retry config: Settings → General (ask 3)

- **Backend (A2):** `storage/settings.ts` gains `RetrySettings
  {autoRetryRateLimit, autoRetryTimeout, autoRetryNetwork}` (all default
  TRUE — the R75 behavior out of the box), keys `retry.autoRetry*`, the
  DebugSettings read/patch pattern. `server.ts` serves `GET/PUT
  /settings/retry` (partial boolean patches, 400 VALIDATION with
  `details.field = "body.<field>"`, 200 returns the updated object — the
  `/settings/debug` route shape). The runtime reads the settings ONCE per
  turn and the ladder gate in BOTH catch blocks becomes
  `isTransientApiFailure(class) && retryClassEnabled(class)` — a disabled
  class fails fast through the honest terminal path: attempts 1, no
  `meta.retry` frames, the real text on the card (live-pinned by S78-5).
- **Frontend (B6):** the "advanced" tab's LABEL is now **"General"** (the
  URL id / deep-link `?tab=advanced` unchanged — documented so old links
  keep working). NEW **RetryConfigCard** above DebugModeCard
  (`data-testid="retry-settings-card"`): three switches — auto-retry rate
  limits (429) / timeouts / network errors — per-switch partial PUT, honest
  error line, and help text that tells the truth about the schedule ("6
  attempts: immediate, 1.5 min, 5 min, 10 min, 30 min"; when off, the failure
  shows immediately with the provider's real error text). MemoryPanel's copy
  follows the rename ("Settings → General").

## 4. The message queue: send while the agent works (ask 4)

**The storage lifecycle (A3):** a queued message is a `session_events` row
of NEW type `message.queued` with the exact `message.user` payload
(`{role:"user", content, attachments?}`). Nothing existing reads it —
`assembleHistory` and the fold skip unknown types by construction (pinned by
tests). **Delivery is a strict type FLIP** (`message.queued` → `message.user`)
on the SAME row: seq/ts/payload untouched, so the message lands exactly
where it was QUEUED — chronology is queue time; the model sees it at the
next model call, WITH the completed tool results in the same prompt. The
lifecycle: `appendQueuedMessage` / `listUndeliveredQueuedMessages` /
`deliverQueuedMessage` / `deleteQueuedMessage` (queued rows only — a
delivered row is transcript history and refuses) /
`deliverAllQueuedMessages`.

**Three delivery paths in the runtime, one contract — never interrupt the
in-flight flow:**

1. **Loop-top delivery (mid-turn):** at the TOP of every outer-loop
   iteration (before `assembleHistory`), undelivered queued events flip and
   each emits a `{type:"queued.delivered", seq, content, ts}` frame. Delivery
   never spends outer-loop budget. Because the R75 ladder's retry `continue`
   re-enters the loop top, a message queued during a ladder WAIT also
   delivers at the next rung boundary — the retry's prompt carries it.
2. **Turn-end continuation (the same SSE stream):** after a SUCCESSFUL turn,
   the streamed route checks the queue — non-empty (and under the
   25-continuation cap) → `meta.queue_continue {count}` frame, the FIRST
   queued event is CONSUMED (deleted; its content/attachments become the
   next `runStreamedAgentTurn`'s args), the REST flip directly (they ride
   the continuation turn's iteration-0 history as ordinary user events),
   and the stream loops. `task_complete` fires per successful turn
   (continuations included); the debug analyst + the terminal `done` frame
   run ONCE after the loop exits; ABORTED/error break the loop (queued
   messages STAY queued — Stop never purges the queue; the honest cap-break
   closes the stream normally and leaves the rest queued). ONE
   `registerTurn` + one abort controller span the whole loop — a Stop
   aborts the in-flight continuation.
3. **Pre-flip (crash/stop recovery):** BOTH turn functions call
   `deliverAllQueuedMessages` BEFORE their own `message.user` append — a
   queue left by an ABORTED turn or a sidecar kill always delivers, in
   order, ahead of the next message (no frames; the folded log owns the
   render).

**The routes:** `POST /sessions/:id/queue` `{content, attachments?}` —
validates like the send routes; requires a LIVE registered turn → else
**409 `{code:"NO_LIVE_TURN"}`** (the panel falls back to a normal send);
appends the queued event then bridges a `{type:"user.queued", seq, content,
ts}` frame onto the OPEN SSE stream via the turn registry's new `notify`
hook (`registerTurn(id, controller, notify?)` / `notifyTurn(id, event)` — a
throwing/dead notifier never bubbles into the 200). 200 `{ok:true, seq}`.
`DELETE /sessions/:id/queue/:seq` → 200/404/400 (bad seq).

**The frontend (B3/B4/B5):** the stream-store carries per-session
`queued: QueuedMessage[]` + `deliveredQueued`; the frame handlers push
(`user.queued`), move (`queued.delivered`, seq-deduped), and note
(`meta.queue_continue`); `startStream` resets both and the stream-end
`finally` clears both (the folded log owns the render after that — the
message.queued fold). `api.ts` adds `queueSessionMessage` (a catchable
`ApiError.code` — 409 NO_LIVE_TURN), `dequeueSessionMessage`, and the
retry-settings clients; `toProjectChatItems` folds `message.queued` into the
NEW item kind `"queued"` `{kind, seq, content, ts, attachments?}` — never a
turn boundary. The panel: while busy + live + streaming, a send queues (the
composer stays fully interactive — the accent **queue-send button** renders
beside Stop in the anchor: ArrowUp + ListPlus, `data-queue-send-button`,
aria-label "Queue message", disabled on empty; Enter while busy routes to
the queue; a NO_LIVE_TURN 409 waits ≤ 2 s for the local reader to settle
then falls through to the normal send). The chips render in the live area
under the Working section (amber, `Clock`, 2-line clamp, `data-testid
"queued-chip"`, X-remove `data-queued-remove` → DELETE, **Send now**
`data-queued-send-now` when idle → dequeue + a normal turn); delivered
messages render as live user bubbles (pendingEcho-style content dedup);
after the stream ends the folded chips take over. While the stream is open
the LIVE chip owns the render (a mid-stream refetch renders exactly one
chip, never zero — the mutual-dedup bug the completion pass fixed).

## 5. The live battery (the R58 self-supervising pattern)

`scripts/battery-r78.mjs` (NEW) — one self-contained invocation owning a
dedicated sidecar on :5199 (scratch DB, real OpenRouter key) + a LOCAL mock
OpenRouter-compatible SSE provider on :5198 that RECORDS REQUEST BODIES as
the model-facing-history oracle (the "did the model actually see it" proof
no mock-at-the-adapter can give). **12 PASS / 0 FAIL:**

| Stage | What it drives | Result |
|---|---|---|
| S78-1 | boot + seeding | **PASS** — sidecar + mock provider + 2 agents |
| S78-2 | honest bad-model error | **PASS** — immediate, class unknown, the REAL "not a valid model ID" text, 0 `meta.retry` frames |
| S78-3 | real 429 ladder honesty (the account's burnt free quota — a genuine rate limit) | **PASS** — `meta.retry` frames: class rate_limit + the REAL "Rate limit exceeded: free-models-per-day…" on `providerError` AND `classMessage` |
| S78-4a | stop mid-ladder | **PASS** — `stopped` frame, session back to `queued` (retryable) |
| S78-4a/b | queue during the ladder wait | **PASS** — queue POST 200 + `user.queued` frame on the OPEN stream; delivered at the rung boundary (`queued.delivered` + the log flip) — the retry's prompt will carry it |
| S78-5 | the retry gate | **PASS** — `PUT /settings/retry {autoRetryRateLimit:false}` → the same 429 fails FAST: 0 `meta.retry`, attempts 1, real text; settings restored |
| S78-6 | mid-turn delivery (mock) | **PASS** — queued during call 1's 4 s tool delay → call 3's request body carries the marker + the completed `<tool_results>` (log order: user → queued-user → tool) |
| S78-7 | turn-end continuation (mock) | **PASS** — `meta.queue_continue` + a second FULL turn on the SAME stream (2 user turns, 1 done frame, call-2 prompt carries the marker) |
| S78-8 | crash/stop recovery pre-flip (mock) | **PASS** — the lingering queued message delivered BEFORE the next send; the model saw queued→new in order |
| S78-9 | route honesty | **PASS** — 409 NO_LIVE_TURN without a live turn; queue+dequeue 200 (event gone); a bogus/delivered seq → 404 |

## 6. Browser verification (the real dev stack)

Verified end-to-end against vite :5173 + sidecar :5178 with the REAL
account-wide 429 quota storm as the failure source: the amber
RetryStatusCard renders the REAL text + class chip + attempt ladder
(attempt 2..5 observed live); the queue-send button coexists with Stop in
the action anchor while busy; the queue POST → the chip renders live
("Queued — sends after the current step"); the message delivered at the
rung boundary (chip → user bubble; the log flip); Stop mid-ladder → the
Stopped card + Continue, the retry card cleared, the session stays
retryable; Settings → General shows the Auto-retry card (3 switches) and a
toggle persists server-side (GET verified false→true round-trip); the
composer action anchor is STABLE at 386/480/560/641/900 px with
Continue+Send (rightGap 8 px = the toolbar padding at every width; at 386
the selectors wrap INSIDE the wrap area while the actions stay anchored);
SPA navigation preserves the stopped state; console + page errors clean.

## 7. Verification

- **Root suite: 2708/2708 green in 144 files** (+81 over R77's 2627/141:
  agent-core 1690 → 1742 — `r78-error-classification` 23 +
  `r78-retry-settings` 11 + `r78-queue` 18 + the r71 userMessage pin honestly
  adjusted to the real-text semantics; frontend +29 across
  Composer/stream-store/api fold/panel/SettingsPage/RetryStatusCard +
  SubAgentsTab's honest rename follow). e2e 12, launcher 10.
- **lint clean, typecheck clean, shared + agent-core built clean.**
- Live: the battery table above (12/12) + the browser pass (§6).
- `version:check` 0.77.0 ×4; `docs:check` green (the round-74 stamp cohort
  aged out at round 78 — the single stale stamp refreshed per DOC-STANDARDS
  §8, first-line-only diff).

## 8. Honest notes

- **The hard-reload caveat:** the Stopped card + Continue live in the LIVE
  stream store. A hard page reload renders from the folded log and the
  affordance ends (the transcript + the queued chips persist; the "stopped,
  send to continue" affordance does not — same as R58's honest-stop design;
  the session stays retryable either way). SPA navigation preserves it.
- **The tiny queue race windows** (documented in the code): a queue POST can
  land microseconds after the turn's outcome check read an empty queue → the
  message stays queued and delivers via the next send's pre-flip; the
  NO_LIVE_TURN → fall-through path waits ≤ 2 s for the local reader to
  settle before re-sending normally. Both are honest (nothing is lost), and
  both are pinned by tests.
- **Sub-agents / the sync path:** children have no owner composer — no
  interactive queueing. The sync path inherits ONLY the pre-flip (lingering
  queued messages deliver before the next send). The queue routes + frames
  are owner-session surfaces.
- The honest-cap note: a queue→turn→queue cycle can never run forever —
  25 continuations, then the stream closes normally with the rest still
  queued.

## 9. Files touched

Backend: `agents/error-classification.ts` (unwrap + 403 refinement +
real-text userMessage), `storage/settings.ts` (RetrySettings),
`storage/sessions.ts` (the message.queued lifecycle), `lib/turn-registry.ts`
(notify/notifyTurn), `agents/runtime.ts` (settings read + per-class ladder
gate + providerError on the frames/envelopes + pre-flip + loop-top delivery
in both turn paths), `server.ts` (GET/PUT /settings/retry, POST/DELETE
/sessions/:id/queue, the queue-continuation loop). Frontend:
`composer/Composer.tsx` (the action anchor + queue-send + onQueue),
`AgentChatPanel.tsx` (the real-text RetryStatusCard, the queue wiring, the
chips + Send now), `stream-store.ts` (queue state + frames), `api.ts`
(queue/retry clients + the queued fold item + meta.retry.providerError),
`SettingsPage.tsx` (General label + RetryConfigCard), `MemoryPanel.tsx`
(copy). Tests: `agent-core/tests/r78-error-classification.test.ts` (23),
`r78-retry-settings.test.ts` (11), `r78-queue.test.ts` (18) + the frontend
follows. Tooling: `scripts/battery-r78.mjs` (NEW). Docs: round-78.md (this
file), CHANGELOG 0.77.0, status.json (round 78, milestone 38), DESIGN-SYSTEM
(the anchor + chips + the real-text card), IMPLEMENTED-API (the ROUND-78
section), AGENT-MEMORY lessons #79–#80, the indexes, HANDOFF.
