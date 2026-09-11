<!-- last-reviewed: 2026-09-11 round-90 -->
# DEBUG MODE — the post-turn context-free analyst (owner's guide)

**Status:** normative · **Established:** round-65 (the debug switch; reworked
round-66 per the owner's C1 directive; round-67 added the card's copy +
auto-collapse and the debug-gated full-turn copy; round-68 added the inline
screenshot capture rows + their export marker; round-69: the post-action
observation frames ride the same pipeline) · **Audience:** the owner
flipping the switch and reading the reports, and any agent maintaining the
pipeline

Debug mode answers one question — *"what actually happened in that turn?"* —
with an answer the working agent cannot polish: when ON, a turn completes
normally, and then a **completely fresh, context-free analyst model** (it never
saw the conversation, has no tools, no stake in the outcome) receives the
session's WHOLE transcript — the user request, every tool call with its FULL
result, every error — and streams its report LIVE into a dedicated section at
the very bottom of the turn's answer. The report is persisted but **never fed
back to the agent**: follow-up messages never include it. The main agent's own
answers stay completely clean (the R65 self-report prompt section is REMOVED).

## The contract (why an analyst, not a self-report)

The owner's directive (R66): the R65 design made the agent grade its own
homework — the same model that just claimed success was asked to confess what
it really did. A self-report inherits every incentive to polish. The R66
contract:

1. **The turn is never touched.** Debug ON changes NOTHING about the prompt,
   the tools, or the answer. The `debugMode` context field composes zero
   prompt text (the R65 `## DEBUG MODE` section + its registry entry are
   gone; the golden fixture was regenerated to match).
2. **A fresh analyst, after the fact.** Once the turn finishes on its own
   (success, or a REAL failure — never a deliberate STOP), the stream route
   launches a NEW model call: system prompt + the transcript as ONE user
   message. No conversation history of its own, no tools, `maxTurns` 1,
   temperature 0.2 (the repo default posture — a report needs consistency).
3. **The whole truth in.** The transcript renderer walks the session's
   append-only event log in order: `USER:` lines (with attachment names),
   `ASSISTANT:` text, `TOOL name(args) → ok|FAILED: <full result>` — the
   COMPLETE persisted output summary per call (the runtime already scrubbed
   secrets and capped each summary at 4 000 chars head+tail at persist time;
   nothing is stubbed further here), `ERROR code: message — providerError`
   for failed turns, `APPROVAL tool: pending|approved|denied|expired`.
   An earlier turn's `debug.report` is SKIPPED (an analysis must never leak
   into a later analysis).
4. **The report is display-only.** Persisted as a `debug.report` session
   event that `assembleHistory` (the model-facing history builder) has no
   branch for — a follow-up user message NEVER includes it. The chat
   transcript's folding layer (`toProjectChatItems` in `src/lib/api.ts`)
   is the only consumer.
5. **Failure never breaks the turn.** The analyst phase is double-wrapped;
   if the analyst's own provider dies, the turn's terminal frame still
   lands and the frontend shows an honest amber line instead of a report.

## The flow

```
 turn runs (normal — prompt identical, tools identical)
      │ outcome.ok  ────────────── or ── outcome.status >= 500
      ▼                                        (ABORTED 499 / 404 / 409:
 [task_complete/task_failed notification]       never analyzed — a stop
      │                                          is not a completed turn)
      ▼
 debug-start (SSE)  ── the frontend opens the live section
      │                 (spinner: "Analyzing the last execution…")
      ▼
 runDebugAnalyst — fresh model call over the transcript
      │  text-delta → debug-delta frames (live markdown streams in)
      ▼
 persist  session event `debug.report` {content, model, ts}   (always —
      │                a closed window still gets the folded card on reload)
      ▼
 debug-done (SSE) {content, model}  ── then the turn's own terminal
                                       done | error frame, then SSE end
```

- The analyst runs **after** the completion notification fires and **before**
  the terminal `done`/`error` frame, so the live turn's SSE is still open
  while the report streams — you watch it appear under the finished answer.
- If the client is already gone (window closed), the frames are skipped but
  the `debug.report` event still lands — a reload folds the card back onto
  the analyzed turn.

## What the analyst is told to produce

The system prompt is deliberately short (the transcript is the payload):

> `## What the task was` · `## Tool-by-tool trace` (one line per call: tool →
> outcome → was the result sane?) · `## Failures & anomalies` · `## Did the
> outcome satisfy the request` (honest verdict) · `## Recommended fixes`
> (concrete, numbered). "Raw facts, no politeness, never invent events that
> are not in the transcript."

The transcript is capped at **60 000 chars** with an honest head+tail split:
the head keeps up to 24 k (the original request + early plan), the tail keeps
the most recent tool work + final answer (recent results are where "was the
outcome sane" is decided), and whole event blocks are dropped from the middle
behind an honest `…[N events omitted]…` marker. A degenerate single-giant-
block session is sliced head+tail the same way. Keyring-held secrets are
scrubbed from the transcript before it leaves the process boundary.

## The frontend surfaces

- **Live** (while the turn streams): `DebugReportCard` renders under the
  streamed answer — header (Bug icon, "Debug report", the model chip, the
  "context-free analyst" subtitle, a status span), body streaming the partial
  markdown LIVE (spinner row while no text has arrived yet).
- **Reloaded**: the same card, state done, folded onto the analyzed turn's
  item (`AssistantTurnItem.debugReport`). The folding rules keep a report
  attached to exactly the turn it analyzed — a report that arrives with no
  analyzable turn in its gap is dropped honestly, and a turn whose only
  content is a report still renders (the empty-reply rescue).
- **Failure**: an amber one-liner (`role="alert"`) — the turn itself
  succeeded; the ANALYST failed. The amber tone is a warning, not the red
  of a failed turn.

## The card collapses itself (R67)

The owner's directive: expanded while the analyst types, collapsed by
itself when done, folded cards minimized — and the copy always reachable.
The R67 card:

- The header row is the collapse toggle (click anywhere on it; the
  chevron rotates; `aria-expanded` is kept honest). OPEN defaults to
  `state === "streaming"`, so a live analysis streams expanded and a
  folded (reloaded) card mounts COLLAPSED.
- A `useEffect` collapses the card on the streaming→done flip UNLESS you
  touched it (the ThoughtRow contract — one tap pins the card open or
  closed across later flips; the effect re-checks the ref, not the DOM).
- The **"Copy report"** footer sits OUTSIDE the collapsible body — it is
  rendered whenever the report is done and non-empty, so the MINIMIZED
  card still offers the copy. The payload (`buildDebugReportCopyText`) is
  `Debug report — model: <model|unknown>` + a blank line + the full report
  text — the "which model was being used" question is answered in the
  clipboard itself. Streaming/error/empty reports copy nothing (the button
  is simply absent).

## Copy full conversation (debug) — the second copy (R67)

The owner's second directive: a copy option on agent replies exporting the
  WHOLE turn, visible ONLY when debug mode is on. It is the second button
  in the reply's hover cluster ("Copy full conversation (debug)", the
  braces glyph, next to the plain message copy) — rendered only when the
  shared `debug-settings` query reports the switch ON (the same cache the
  Settings page uses — one source of truth, no extra fetch pattern).

The export (`buildFullTurnText` in `src/lib/turn-copy.ts`) is plain text:
the `=== ACUTE-CODE turn export (debug) ===` header with the `Model:` +
`Duration:` line, the user narration/thinking banner, `[THINKING]` and
`[TEXT]` lines in order, one `--- TOOL n: name ---` block per tool call
(running index, the args, the outcome: `ok — <output>`, `FAILED — …`, or
`pending (call in flight)` for a live row), the approval blocks, and the
`--- FINAL ANSWER ---` tail. Empty entries are skipped honestly. A
~100 KB cap keeps the TAIL (the verdict lives at the end) behind an
explicit truncation marker.

**The honesty limit**: tool outputs ride the PERSISTED `outputSummary` —
each summary was already capped at 4 000 chars when the event was
  written (the raw output never crossed the wire to the frontend). The
export is the transcript the app itself kept, not a full-stdout dump;
  the truncation markers say so. On the LIVE footer the model is the
  panel's effective model and the duration is wall-clock (the live turn
carries neither); the reloaded turn's export is authoritative.

## The inline screenshot capture rows (R68)

R68-A moved the agent's live captures INTO the working stream (the
owner: "When the screenshots were taken they should be shown at that
specific time.") — a `screenshot` WorkingEntry lands at the capture
moment, right after the tool row that took it, and WorkingSection renders
the inline row between the tool rows. The debug surfaces see exactly
this:

- **The live view** (what you watch while the turn streams): the compact
  inline row per capture — the ~300px tile lazy-fetching the ephemeral
  raster (`GET /computer-use/frames/:frameId/raster`), the honest
  "expired" placeholder once the server's 10-minute raster lifetime
  passes, and the click-to-enlarge dialog (full image + the capturing
  tool + the timestamp).
- **The full-turn export** (the debug-gated "Copy full conversation"):
  each live capture renders as the honest ONE-LINE FACT
  `[screenshot captured by <tool>]` — at its position in the stream,
  between the tool blocks it interleaved with live. The PNG bytes are
  EPHEMERAL server-side (never persisted), so they are always gone by
  copy time: the export carries the fact, not an image. The marker does
  NOT bump the `--- TOOL n: ---` numbering (a capture is not a tool
  call — the export's tool index stays comparable with the event log).
  R69: the post-action OBSERVATION frames and the stale-frame
  auto-refresh frames ride the same pipeline (`tool:` the action's
  name / `"auto_refresh"`), so a mutating tool's receipt and its
  verification frame both appear in the live view + the export — the
  tool RESULT text itself now carries the observation (frame id,
  screenChanged, focused element) too.
- **The reloaded/folded turn owns NO screenshot history by design** (the
  R67-D rule, unchanged): the persisted event log never stored rasters,
  so a reloaded turn's export carries no capture markers — the markers
  exist only on the live footer's copy (the live turn's working array
  is the only carrier). The debug ANALYST's transcript renderer
  (context-free, reading the event log) likewise never sees captures.

## How to flip it

**Settings → Advanced → "Debug mode" → "Post-turn debug analyst"** (the
switch; default **OFF**). The engine reads the setting per turn — a flip
applies to the very next message you send, no restart. The report streams
for BOTH successful turns and real failures (provider 5xx, loop guard); a
deliberate STOP is never analyzed (there is no completed turn to dissect).

## Honest limitations

- **The analyst is only as good as the model it runs on** — it uses the
  session's agent provider/model (the per-send model override when one was
  sent, else the agent default). A weak model produces a weak report; the
  event log remains the ground truth.
- **The analyst's own provider failure shows an amber line**, not a report
  (with the API key scrubbed from the message). The turn is unaffected.
- **No hard output cap** — the analyst is bounded by prompt discipline +
  `maxTurns: 1`, not a `maxOutputTokens` ceiling (the chat-adapter contract
  exposes no such parameter; a plumbing follow-up is noted in the R66
  worklog). A pathological model can write a long report.
- **The 60 k transcript cap drops middle events** — a very long session
  analyzes head+tail only; the omission marker says so.
- **Cost** — debug ON adds one full model call per completed turn (input ≈
  the transcript, one completion). Default OFF keeps the idle cost at zero.

## Troubleshooting

- **No debug section after a turn** — the switch is OFF (default), or the
  turn was stopped/aborted (never analyzed), or the analyst failed (check
  the amber line; the engine log carries the honest error).
- **The report is empty/garbled** — the analyst returned an empty reply
  (honest error shown) or the model ignored the structure; try a stronger
  model on the session's agent.
- **The card vanished after a reload** — the `debug.report` event is folded
  onto its OWN turn only; if the turn's user gap closed before the report
  landed (an edge case around a `turn.error` flush), the folding guard may
  drop a stray report rather than attach it to the wrong turn.

## See also

- [TESTING](TESTING.md) — the debug-analyst (10) + stream-route (r58 suite,
  +4) + DebugReportCard (17 since R67) + turn-copy (10 since R68) +
  ScreenshotRow (5, R68) + api-folding suites and what each pins
- [EMBEDDED-BROWSER](EMBEDDED-BROWSER.md) — the sibling R66 runbook (the
  browser page actions + the bot-wall checkpoint card)
- [COMPUTER-USE](COMPUTER-USE.md) — the computer-use surface whose turns
  the analyst most often dissects
- Code map: `agent-core/src/agents/debug-analyst.ts` (transcript renderer +
  the analyst), the stream route's `runDebugAnalystPhase` in
  `agent-core/src/server.ts`, the switch routes
  `GET/PUT /api/v1/settings/debug`, the card
  `src/components/project-chat/DebugReportCard.tsx` (+
  `buildDebugReportCopyText`), the full-turn export
  `src/lib/turn-copy.ts` (`buildFullTurnText` — R68: the screenshot marker
  line), the inline capture rows
  `src/components/project-chat/ScreenshotRow.tsx` (R68 — the working-stream
  `screenshot` entries in `src/lib/api.ts` + the stream-store push), the
  folding in
  `src/lib/api.ts` (`toProjectChatItems`), the live frames in
  `src/lib/stream-store.ts`, the switch UI in
  `src/pages/SettingsPage.tsx` (DebugModeCard).
