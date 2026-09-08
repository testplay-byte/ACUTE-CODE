<!-- last-reviewed: 2026-09-07 round-77 -->
# Round 77 — The Field-Report Round (Composer Layout, Error Honesty, Revert-as-Edit, Live E2E)

**Owner's report (the 0.75.0 field report, seven verbatim asks):**

> 1. "The mode selection, the access level selection, and the upload file
>    buttons should be shown on the left side, and besides that, all the
>    other options should be aligned to the right side."
> 2. "For the model selection, there was no proper icon, so you might need
>    to add a proper icon for the module selection."
> 3. "I saw some issues where the send message or stop message button was
>    showing below the designated options which we had discussed."
> 4. "The retrying rate limit attempt was apparently not looking good. Its
>    UI was bad, and everything was looking kind of ugly."
> 5. "We need to have our error handling made much more robust and proper.
>    … show the actual error messages too, which were returned from the
>    API."
> 6. "With the revert option … it should revert to that session, and that
>    message which was on that should be pasted in the message area. That
>    message should be deleted from the chat itself with the agent."
> 7. "I tried sending a message, but it was not that successful. … do some
>    thorough, proper testing, like trying to build some project using
>    this system … Try to build multiple kinds of projects with varying
>    difficulty levels … Give me the stats on how things went: Was it able
>    to perform longer conversations properly or not?"

Every one is implemented, unit-tested, and (where the provider quota
allowed) live-verified. Version **0.76.0**.

---

## 1. The composer toolbar: left/right split + the never-alone send (asks 1, 2, 3)

The R75 toolbar was ONE flat cluster in a single order. The owner's field
report refined it into **two clusters**:

```
[Attach] [Access] [Task mode]      ·  ·  ·      [Context donut] [Model] [Reasoning] [Send/Stop]
└────────── data-composer-left ─────────┘         └──────────── data-composer-right ────────────┘
```

- **LEFT** (`data-composer-left`): the attach button, the access-level
  switcher, the task-mode picker — the owner's left-side trio, order
  preserved.
- **RIGHT** (`data-composer-right`): the context donut, the model selector,
  the thinking-level button, Continue, and Send/Stop — **one `nowrap` group
  with `ml-auto shrink-0`**. This is the ask-3 fix: previously each control
  was a direct toolbar child, so when space ran out `flex-wrap` broke the
  row at arbitrary points and the send button wrapped below **alone**,
  separated from its options. Now the action button can never separate from
  its right-side siblings — either the whole cluster fits on the row
  (pinned right by `ml-auto`), or the WHOLE cluster wraps as one unit to the
  next line (still right-aligned by `ml-auto`). The R75 spacer `div` is gone
  (`ml-auto` subsumes it).
- The row keeps `flex-wrap` as the R51-c never-overlap emergency fallback,
  and the box stays a CSS `@container`: below 560px the selector pills' text
  labels hide (icon-only, tooltips carry them), so the row still fits at
  the 480px chat floor.

**The model icon (ask 2):** the model pill was the only toolbar control
without a leading icon (Paperclip / Shield / Compass / Brain on the
others). It now leads with a **`Cpu` glyph** in the accent color — and
critically, the icon does NOT carry the `@max-[560px]:hidden` rule the
label has, so the pill stays identifiable icon-only below the container
floor.

Tests: `Composer.test.tsx` — the R75 flat-row test replaced by the R77
cluster test (left/right membership, right-cluster `ml-auto` + no
`flex-wrap` + `shrink-0`, the spacer gone, DOM order, in-cluster order)
and a new model-icon test (the icon exists, survives the label hide);
`AgentChatPanel.test.tsx` — the task-mode sibling-order check re-anchored
to the left cluster.

## 2. The RetryStatusCard redesign (ask 4)

The R75 card was a bare floating spinner + stacked text lines. The R77 card:

- **A circular spinner chip** — the slow 3 s rotation (kept — a patient
  wait deserves a patient icon) now sits inside a soft amber circle instead
  of a bare glyph.
- **The attempt dot-ladder** (`data-retry-dots`): one dot per attempt (6
  for the ladder). Failed-and-done attempts sit dim; the UPCOMING attempt
  **breathes** (the new `ac-retry-pulse` keyframes — 1.8 s scale/opacity
  cycle, prefers-reduced-motion safe via the global retrofit block); future
  attempts stay hollow. Progress at a glance, no math required.
- **The countdown fill-bar**: a thin amber bar next to the countdown label
  fills from 0 → 100% as the rung elapses (the fraction derives from
  `waitMs` + the live `retryAt` anchor — progress IS the reassurance).
  A `Timer` icon leads the row.
- **Rounded-full class chip**, an `Info`-icon reassurance line, a soft
  amber gradient background, and the exact remaining-time format (the old
  one rounded seconds to tens: "1m 30s" → now exact).

Everything the R75 test pinned (role=status, the "Retrying — attempt N of
M" header, the class chip, "next attempt in", "the agent keeps working
automatically") is preserved; the test gained the dot-ladder + bar
assertions.

## 3. Error handling: the vanish fix + envelope honesty + full text (ask 5)

The deepest find of the round — the root cause behind the owner's
**"I tried sending a message, but it was not that successful"**:

**A turn that failed WITHOUT a persisted `turn.error` used to vanish
entirely.** Pre-hijack rejections (400 validation, 401 auth, 409 conflict,
`PROVIDER_DISABLED`, unknown agent) and dropped streams return errors that
are never persisted to the event log (nothing happened server-side to
persist). The old flow: the SSE error frame set the live error card →
`runTurn`'s post-stream cleanup called `clearStream(sid)` (because the live
turn was not marked stopped) → **the whole session slice including
`liveError` AND `pendingEcho` was deleted** → the error card flashed and
disappeared, the user's message bubble disappeared, and the transcript
looked like the send never happened. No error, no message, no retry —
exactly "not sending the message properly".

**The fix, three layers:**

1. **`freezeFailedTurn` (NEW stream-store action)**: when the failure was
   never persisted (no `errorTs`), the panel now calls this instead of
   `clearStream`. It keeps `liveError` + `pendingEcho` (the error card and
   the user's message survive — the owner sees exactly what failed and
   what they typed), freezes the live turn if it has partials (the R58
   thrown-error shape: partial work stays visible) or drops it if empty
   (no frozen "Thinking…" row lingers), and stops the sidebar animation.
   The survivors clear on the next send (`startStream` resets both).
2. **`runTurn`'s catch stopped discarding**: the `hasResponse` branch that
   nulled `setSendError` was VESTIGIAL — live-mode stream errors stopped
   propagating into that catch in R39 (the store owns them), so its only
   arrivals are create-session/demo-send failures where the turn never
   landed. The real `ApiError` message is now always surfaced.
3. **The api.ts envelope preservation**: `streamSessionMessage`'s non-2xx
   branch hardcoded `code: "PROVIDER_ERROR"` and dropped the body's
   `details` — a 409 `PROVIDER_DISABLED` / 401 / 400 masqueraded as a
   provider error with no context. The envelope's real code + message +
   details (providerError, errorClass, attempts) now ride the error frame
   (401 keeps an `UNAUTHORIZED` fallback when the envelope lacks a code).

**The full error text:** `TurnErrorCard` no longer chops the reason at 220
chars. Long provider payloads (the raw OpenRouter body runs hundreds of
chars) collapse to a 240-char excerpt with a **"Show full error" toggle**
that expands the COMPLETE raw text in a scrollable monospace block
(`data-error-full-text`, max-h-44). Copy details always carried the full
text; now the card can too.

## 4. Revert-to-message is now edit-and-resend (ask 6)

The R44 semantics kept the target message dangling at the transcript's end
(no reply after it). The owner's spec is the classic edit-flow:

- **Backend** (`revertSession`): the DELETE changed from `seq >
  keepThroughSeq` to **`seq >= keepThroughSeq`** — the target user message
  is removed WITH its reply and later turns. The marker append + queued
  status reset are unchanged; the wire field keeps its historical name
  (`keepThroughSeq` — its meaning is now "the seq of the message being
  reverted").
- **Panel** (`onRevertConfirm`): after the revert resolves, the message's
  text is **pasted back into the composer** (`setInput(target.content)` +
  focus) BEFORE the invalidations, so the text is in place the moment the
  truncated transcript re-renders (the `target` snapshot survives the
  refetch that removes the item). The send-clear and the session-switch
  reset are the only things that wipe it — exactly like a hand-typed draft.
- **Copy**: the confirm dialog says "Rewinds to before '…' — removes that
  message and its reply from the chat, and puts the message text back in
  the composer for editing."; the toast says "Removed N events — the
  message is back in the composer for editing."
- **Demo fixtures** (`session-fixtures.ts`): the twin filter flipped to
  `seq < keepThroughSeq` in lockstep.
- Model-facing: `assembleHistory` ignores the `session.reverted` marker,
  so the post-revert context ends BEFORE the removed message (no dangling
  user message the next send would append after).

Tests: `sessions-manage.test.ts` (storage: inclusive truncation, the
later-message case, the no-op edge unchanged; route: removedCount 4, only
the marker remains, lastSeq 1) + `AgentChatPanel.test.tsx` (the revert
flow: the message GONE from the transcript, the composer carries its
text, the new dialog + toast copy).

## 5. The live E2E battery (ask 7)

A dedicated sidecar (scratch DB, fresh token, real OpenRouter key) driven
through the real SSE stream path — the CLI-HARNESS pattern. The matrix
matches the owner's ask: **multiple projects of varying difficulty +
longer conversations + stats**.

| Stage | What it drives | Result |
|---|---|---|
| T1 smoke | a plain Q&A round-trip ("Reply with exactly the word: pinecone") | **PASS** — done frame, reply text, usage, persisted log |
| T2 easy | a 3-file static site (index.html + styles.css + app.js, theme toggle) | **PASS** — 7 tool calls, all files created, html links css+js, the toggle wired (classList + listener) |
| T3 medium | a Python todo CLI + unittest, agent must RUN the tests itself | **PASS** — files built, agent ran the suite itself, the independent verifier run: 6/6 tests OK, all three subcommands present |
| T4 hard | 3-turn build → extend → refactor on ONE session (calculator + history + `operate()` extraction, tests must stay green) | **PASS 3/3** — 12 tool calls building (5 tests green), 5 extending (8 tests green, history landed), the refactor preserved behavior with `operate()` extracted (independently re-run green at every stage) |
| T5 long | a 10-turn conversation with context-retention probes | **PASS 10/10 turns** — the codename recalled verbatim after 7 intervening turns (PROJECT-FALCON), the SQLite→PostgreSQL edit answered correctly, all 10 turns persisted; ONE quality flake: turn 10's reply was whitespace-only (see the guard below) |
| T6 revert | the R77 semantics over the wire | **PASS** — revert → removedCount 4 → only the `session.reverted` marker remains → status queued → a NEW turn works on the truncated log → the log rebuilds [marker, user, assistant] |
| T7 errors | a real provider failure must carry the ACTUAL API message | **PASS** — the bad-model agent fails visibly: the error frame carries the honest code + details, the persisted turn.error carries the real provider text; PLUS the genuine 429-storm exhaustion below |

**The unplanned guest star — a REAL rate-limit storm:** mid-battery the
account's free-tier daily quota exhausted (`free-models-per-day`,
X-RateLimit-Remaining 0, reset at 00:00 UTC — **the cap is account-wide,
not per-key**: swapping to the other three keys changed nothing). This
turned into the strongest live verification of the round:

- **The R75 ladder engaged live, exactly to spec**: `meta.retry` frames at
  attempts 2–6 with the correct rungs (immediate → 90 s → 5 m → 10 m →
  30 min; the full ~47-minute worst case ADR-0027 documents), the amber
  card visible on the wire, the heartbeat ticks.
- **The boot sweep live-verified**: killing the sidecar mid-ladder-wait
  (a crash simulation) → on restart the session carries the `INTERRUPTED`
  `turn.error` event ("the app restarted while this response was being
  generated … the work above is preserved — send a message to continue")
  and the status is `queued` — the R75 honest-interruption path, not the
  old silent terminal-failed.
- **This is very likely what the owner experienced as "not sending"**: a
  quota-blocked provider call + (pre-R77) the vanish bug = a send that
  showed nothing at all. Post-R77 the failure is VISIBLE: the amber
  ladder card while waiting, then the honest error card with the real
  `Rate limit exceeded: free-models-per-day…` text and the retry
  affordance.

**The battery's stats (the owner asked):** 20 turns driven, 19 completed
with done frames + 1 honest blank-output flake (see the guard below —
pre-R77 it would have counted as a fake success); 46+ real tool calls
(file writes, edits, command runs); turn latency 2.3 s – 58.7 s (avg ~18 s
on the free tier); ~1.09M input + ~43K output tokens, $0.00 (free tier);
0 app-level failures; 2 account-wide quota storms handled by the ladder
exactly as designed. **Long conversations: YES** — the 10-turn session held
context (the codename + the edited tech stack both recalled correctly 6-7
turns later), and the 3-turn refactor session preserved its own test
suite's green status across the whole build→extend→refactor arc.

**The guard born from the battery (the ask-7 improvement):** T5 turn 10
exposed the whitespace-reply flake — glm-5.2:free "answered" with a run of
newlines, no tool calls, and the turn COMPLETED ok with an empty reply
while the requested file edit silently never happened. **The blank-output
guard** (runtime.ts, streamed path): a turn whose entire output is blank
AND ran zero tool calls now ends honestly — `NO_OUTPUT` 502, a persisted
turn.error with the actionable message ("resend the message"), the real
token spend recorded, the session left retryable. Tool-using turns with no
final text stay legitimate (the tools did the work — the R35 empty-marker
path); a user STOP can never reach the guard (aborts exit through the
ABORTED return). Pinned by 4 new tests (r77-blank-output.test.ts).

## 6. Verification

- **Root suite: 2627/2627 green in 141 files** (925 src + 1690 agent-core
  + 12 e2e: +9 src — 4 freezeFailedTurn, 3 envelope-preservation, the
  TurnErrorCard full-text toggle, the cluster test + the model-icon test —
  and +5 agent-core: the revert inclusive-truncation flips, the
  later-message case, and the 4 blank-output-guard tests).
- **lint clean, both typechecks clean, version:check 0.76.0 ×4,
  docs:check 177/0/0.**
- Live: the full battery table above, the 429-storm receipts (ladder rungs
  + exhaustion + the amber card + the boot-sweep INTERRUPTED event), and
  the browser verification of every UI change (the cluster DOM, the Cpu
  icon, the revert flow end-to-end, the Stop button, the retry card's dot
  ladder + fill bar mid-wait, the error card after exhaustion) — 4
  screenshots in the orchestrator's session artifacts.

## 7. Files touched

Frontend: `Composer.tsx` (two clusters), `ModelSelector.tsx` (Cpu icon),
`AgentChatPanel.tsx` (RetryStatusCard redesign, TurnErrorCard full-text
toggle, runTurn failure-survival logic, revert refill + copy),
`stream-store.ts` (freezeFailedTurn), `api.ts` (envelope preservation),
`session-fixtures.ts` (revert twin), `index.css` (ac-retry-pulse).
Backend: `storage/sessions.ts` (inclusive truncation), `server.ts` (route
comment), `agents/runtime.ts` (the blank-output guard + the NO_OUTPUT
outcome code). Tests: `agent-core/tests/r77-blank-output.test.ts` (NEW).
Docs: round-77.md (this file), CHANGELOG 0.76.0, status.json
(round 77, milestone 37), DESIGN-SYSTEM (composer + cards + revert flow),
IMPLEMENTED-API (the revert row), the board + index, HANDOFF, AGENT-MEMORY
lessons #77–#78.
