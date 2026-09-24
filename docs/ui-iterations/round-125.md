<!-- last-reviewed: 2026-09-24 round-125 -->
# ROUND 125 — the live-center truth pass: duplicate writes, occlusion-proof screenshots, per-session drafts, the visible ledger

**The owner's directive (the v0.117.0 device report — the focused round before the full PC redesign
session the owner scheduled next):**

1. *The duplicate live writes* — "it was writing a file, and while writing the file… it was showing me
   multiple writing at the same time, like they were the exact same ones. One was showing much earlier
   in the conversation, the other one was showing further in the conversation."
2. *The blue area* — "on the PC side… the UI is bad. It shows me in the blue colored area the tool call
   of writing and other stuff like that."
3. *The screenshots still capture the wrong thing* — "it takes the screenshot of the whole device rather
   than taking the the screenshot of the webpage appropriately… when I am in some other application,
   then it tries to take a screenshot of that application rather than the browser window itself."
4. *Per-session drafts* — "the message should be remembered for each one of the sessions separately,
   like if I write a message and then switch to another section, then it should remember which message
   was typed there."
5. *Mobile* — "on the mobile side, I do never see any tool call shown… and it has auto scroll
   functionality, which does not stop."
6. *The feedback ledger* — "it did not actually show me the processing of the feedback ledger. It did
   not show me the info of when it was being written… it should be able to write the self-feedback
   ledger and improve it midway too if it feels like."
7. *The reference projects* — "You never refer to the reference projects which I highlighted with you a
   lot of the times" — the ZCode adoption queue's first pick ships this round.

## §1 The duplicate live writes — the single-owner law (R125-2)

**The root cause** (found in a code-read, not a guess): `WorkingSection` read the stream store's
`liveTurn.streamingToolInputs` through an INTERNAL selector — so EVERY mounted live work section
subscribed to the SAME array and rendered the same `LiveWritePendingRow`. A long agentic turn
SEGMENTS its entries (tools → interim narration → more tools — `segmentWorkingEntries`, R64-c), so a
pending write mid-turn painted in each of the turn's work sections, plus the synthetic tail section:
the owner's "multiple writing at the same time… the exact same ones… one much earlier in the
conversation, the other one showing further."

**The fix — the panel owns the choice, the section obeys the prop:**
- `WorkingSection` takes `pendingWrites?: StreamingToolInput[]` — the ONLY source of pending rows
  (the internal selector is gone; the prop's absence renders none — folded reloads and non-owning
  live sections stay clean by construction).
- `AgentChatPanel`'s liveSection derives the inputs ONCE and threads them to EXACTLY ONE section:
  the LAST segment when it renders as a work section (tool/screenshot entries, or the still-streaming
  thought rides in it), else the synthetic tail — the pending write always lands at the LIVE TAIL,
  where the write is actually happening. `tailOwnsPendingWrites` and the owner rule are one law:
  this OR that, never both.
- The panel-level regression pin (AgentChatPanel.test.tsx) reproduces the owner's exact scenario —
  segments [write-tool, interim text] + a new pending write — and asserts ONE pending row + ONE
  live preview, at the tail.

**The belt-and-suspenders leg — the interlock's positional fallback:** the R119-C fold/live
interlock anchors on the live turn's opening user CONTENT (pendingEcho / mirror userText). When the
content anchor misses (a queued message DELIVERED mid-turn has no echo; a detach consumed it), a
mid-stream refetch's folded trailing turn rendered BESIDE the overlay. The fallback anchors on the
LAST folded user row, gated on FRESHNESS (its ts within 30s of the live turn's start clock — same
machine, so an in-flight opener is milliseconds fresh while the previous exchange is minutes stale;
a refetch racing the opener's persist suppresses nothing rather than hiding the previous turn).

## §2 The de-blue pass (R125-2)

The owner's "blue colored area" was `RUNNING_BLUE = #3b82f6` — a theme-INDEPENDENT raw blue that
painted the live write preview, the live terminal tail, the pending row's chip, and the in-flight
DIFF-tool chips in every theme. All of them now speak `styles.accent` (the active theme's accent —
warm in the clay themes, correct everywhere), with the border washes softened (0.35 → 0.28 alpha).
The constant stays exported for the surfaces the redesign session owns (SubAgentPanel still speaks
it — the full PC redesign round migrates those). The one test pinning the blue chip was re-pinned to
the accent with the R125 comment.

## §3 The occlusion-proof Windows capture (R125-A, the subagent leg)

The R124 staged capture still ended in a GDI `CopyFromScreen` of the screen REGION — a window
behind another app leaks the occluding app's pixels (the owner's exact report). The Windows
backend's `captureRegion` now tries `PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT)` FIRST:

1. One PowerShell capsule compiles a small C# class (EnumWindows/EnumChildWindows/GetWindowRect/
   PrintWindow/GetClassName/GetWindowThreadProcessId — delegates kept alive, static candidate
   storage).
2. The owner top-level window: EnumWindows filtered to the sidecar's parent pid
   (`process.ppid`, validated; the route threads it), containment-preferred then largest overlap.
3. Among its `Chrome_WidgetWin_1` descendants, the child with the SMALLEST symmetric difference to
   the requested region wins — load-bearing: the app's own full-client webview shares the class and
   maxes any overlap-only rule; tightest-fit is what makes the STAGED TAB (rect ≈ region) win.
4. `PrintWindow` renders the child's own DirectX/Chromium surface into a bitmap (valid while
   occluded/unfocused); the region translates into child coords, clamps, crops, PNGs.
5. ANY failure (no owner window, no child, PrintWindow false, degenerate crop) runs the legacy
   CopyFromScreen branch in the same capsule and emits `SRC:screen` — the JS trusts only
   `SRC:window`, everything else reads as the conservative fallback.

The honesty chain is end-to-end: route reply `source` → `captureBrowserRegion`'s return → the tool
result's note — "(window capture — works while covered)" vs "(screen-region fallback — the window
could not be captured directly; another window may occlude it)". macOS/Linux report `"screen"`
honestly (their region engines are unchanged this round). `agent-core/tests/r125-windows-capture.test.ts`
pins the script's shape (16 tests); the r124 route suite grew from 13 → 19 (ownerPid threading via a
`process.ppid` getter-spy, the source in the reply, the garbage-pid omission); the frontend capture
suite 21 → 25 (the note's two lines; old-sidecar tolerance).

## §4 Per-session composer drafts (R125-3)

**The desktop** — `src/lib/draft-store.ts`: one localStorage key, a JSON map `{sessionId → draft}`,
blank-deletes, a 20k-char cap, a 50-session recency eviction, and the never-throws degradation
(unavailable storage / corrupt blob / quota → the pre-R125 behavior, `""` loads). The panel wires
it: the session-switch effect FLUSHES the outgoing session's draft (the `input` state still holds
that conversation's text at the switch beat) and RESTORES the incoming one; a 400ms trailing
debounce persists typing; the send paths (normal + queued) CLEAR the entry — a sent message is not
a draft. Eleven unit pins + the panel's existing send-path suites stay green.

**The mobile** (R125-D) — `mobile/src/features/composer-draft.ts`, the outbox architecture's exact
pattern (injected AsyncStorage seam, one owned key, blank-clears, the same 20k cap): the Composer
hydrates on mount, debounced-saves on keystrokes, flushes on unmount/session-switch, clears on
send/queue. Sixteen pins. One deliberate semantic delta: a draft no longer carries across a live
session switch — each session restores its own (exactly the ask).

## §5 The visible ledger + the mid-turn checkpoints (R125-B, the subagent leg)

**Status, finally observable:** `agent-core/src/agents/feedback-status.ts` — a dependency-free
in-memory registry (`writing/phase/sessionId/startedAt/lastWriteTs/lastWriteOutcome/lastEntries/
lastError`, a run-token overlap guard so a late checkpoint can't flip `writing` false early). The
new `GET /api/v1/feedback/status` (phone-reachable — the viewing trust level) joins it with the
setting + the file's live entries/bytes; the Clear route resets the last-write fields.

**The writer reports + the phase:** `runFeedbackWriter` gained `phase: "turn-end" | "mid-turn"`
(default turn-end, byte-identical headers; mid-turn adds a `Phase: mid-turn checkpoint (turn still
in flight)` line) + the mid-turn prompt paragraph; the whole body (early returns included) is
wrapped so `writing` never strands true.

**The mid-turn trigger (sse.ts):** the route's own `send()` choke point counts per-turn trouble —
failed tool-results (ok===false), approval denials, meta.retry rungs (deduped by attempt). The arm
law (pure, pinned): `failedTools >= 3 || (approvalDenials >= 1 && failedTools >= 1) ||
retryEvents >= 2`, ONE checkpoint per turn, a 2s settle window (a turn finishing inside it stands
down), a writer-busy guard. The checkpoint runs the SAME gated reporter detached — the ledger can
now write MIDWAY, exactly the owner's ask.

**The frames (status only — the separation law stands):**
`{type:"meta.feedback", sessionId, stage:"writing"|"written"|"failed", phase, entries?, detail?}` —
mid-turn frames ride the own stream + the events bus; turn-end frames ride the events bus only
(after `res.end()`; `send()` publishes to the bus before the writableEnded check, so the initiator's
SSE body stays byte-identical to R122).

**The PC surfaces (the orchestrator's wiring leg):** the stream store keeps the last frame in a
SLICE-level `feedbackEvent` (deliberately above the liveTurn guard — the turn-end frames land after
the live turn's teardown would drop them). The panel renders the mid-turn line at the live block's
BOTTOM EDGE (the retry-card position — accent-tinted, one line, the failure excerpt title-attr'd)
and toasts the turn-end written/failed. Settings → Self-Feedback gained the live status strip
(3s poll, toggle-gated): spinner + "writing the ledger entry — {mid-turn checkpoint | turn
summary}…", the last-write line, the honest failure line.

## §6 The first ZCode adoptions (R125-C, the subagent leg)

The study's ranked first picks (§D1 + §D2 of `agent-ctx/research/zcode-context-compression.md`):

- **Provider-usage token anchoring (D1):** `providerUsageAnchor(events, messages)` (pure, pinned) —
  the last persisted assistant event's provider-reported `inputTokens` PLUS the local estimate of
  the model-facing messages after its seq (exactly "what the provider had not yet seen");
  `planCompaction`'s gate uses the anchor when present (the estimate stays the fallback and BOTH
  numbers are reported).
- **Typed decisions (D2):** `planCompaction` returns `{decision: "compact"|"skip", tokenCount,
  tokenSource: "provider-anchored"|"estimated", estimatedTokens, threshold, reason:
  "forced"|"above_threshold"|"below_threshold"|"empty_to_summarize"}`; the `context.compact`
  payload + the live `meta.compaction` frame carry the dual numbers + the reason additively.
- The runtime threads the anchor at both `assembleWithCompaction` call sites (a surgical +49-line
  diff into the 5399-line runtime.ts).
- Test counts: context-compaction 17 → 30 (the anchor's five pins incl. garbage-skip + last-wins;
  the anchor-FORCES and anchor-VETOES cases — the key honest one: the estimator over-counted, the
  provider number says it fits, compaction stands down); two r71 reliability pins updated with
  comments.

The honest caveats (from the subagent's report): anchoring TRUSTS the provider's number (finite-
positive is the only guard; the dual-number payload makes disagreement visible, and the R71-e2 force
path still catches real overflows reactively); the anchor excludes the anchor assistant's own output
tokens (a one-message blind spot absorbed by the margin); the stale-anchor over-trigger between a
compaction and the next successful reply is ZCode's D3 (invalidateRuntimeTokenUsage), still queued.

## §7 The mobile fixes (R125-D, the subagent leg)

- **The runaway auto-scroll:** the session FlatList gains
  `maintainVisibleContentPosition={{minIndexForVisible: 1, autoscrollToTopThreshold: 80}}` — on the
  inverted list the prop's "top" is the VISUAL bottom (the newest content): `minIndexForVisible: 1`
  pins the first row the user is actually reading when a live delta prepends at index 0 (the
  reading position finally HOLDS), and the 80pt threshold keeps stick-to-newest only while the user
  sits at the newest edge. The anchor lives in `mobile/src/components/transcript-scroll.ts` as a
  documented, jest-pinned constant (4 pins — the coordinate-space rationale is in its header).
- **The update row's caption:** `v{APP_VERSION} · {the R124 caption}` (the version source is the
  exact one update.tsx already uses — expo-constants' expoConfig.version; no new dependency), and
  the a11y label carries the version.
- **Per-session drafts** (see §4's mobile half).

**The honest mobile note — the tool-calls report:** this round re-verified the mobile tool-row path
end-to-end in the code (the fold's `tool.use` items, the live reducer's tool items, the TurnBlock
well's `wellDefaultOpen` law, the events bus mirroring every frame — R123-W-m's rows ARE in the
shipped v0.117.0 APK) and found NO static defect; the one runtime condition that hides every tool
row on a phone is Settings → Appearance → **Tool activity = hidden** (it syncs from the shared
appearance setting — worth checking on the device before anything else). The auto-scroll fix may
itself have been the perception driver (rows flashing past). The owner's next device pass is the
live verdict; if rows are still invisible with the pref on "detailed", the next round instruments
the fold (a count on the debug report).

## §8 Verification

- **root**: tsc CLEAN · vitest **274 files / 4805 passed** (was 267/4709 — the round's +96: the
  draft-store 11, the panel's two new pins + the R125-2/feedback fixtures, WorkingSection's prop
  re-pins, SelfFeedbackTab 12→18, the capture suites 21→25 + 13→19, the compaction +13, the
  feedback suites, the mobile-synced none) · eslint 0 on every touched file · design-audit clean
  (R2 re-pinned 1629→1635 — the six new `text-[11px]` sites all ride the chat vocabulary's own 11px
  mono/label step, the same scale WorkingSection speaks ~90×; the reason is documented in the
  baseline file's note) · build green (mermaid chunk ok) · e2e 12/12 · license clean
  (299 production dependencies) · version:check 7/7 at 0.118.0.
- **agent-core**: tsc CLEAN · vitest **157 files / 2903 passed** (was 2846: the r125-windows
  capture 16, the r124 suite +6, feedback-status 10, the checkpoint 3, the writer +5, the routes
  +4, the compaction +13).
- **mobile**: tsc CLEAN · jest **48 suites / 1049 passed** (was 46/1029: transcript-scroll 4,
  composer-draft 16).
- **Honest limits**: no Windows machine, no Android device in this sandbox — the PrintWindow
  capsule is mock-pinned by construction (the script-shape pins + the route/frontend threading; the
  symmetric-difference child selection is the load-bearing guess that one live run confirms), the
  mobile scroll anchor + draft round-trip are jest-pinned, and the R125-2 duplicate fix is
  component+panel-pinned (the owner's next device pass is the live verdict). PrintWindow on a
  MINIMIZED window can render stale content — the frontend's pre-existing minimized refusal guards
  the front door; there is no mid-grab re-check (documented in the backend).

  **THE CI STORY (the honest red-then-fixed, R124's pattern again):** main's first push (74c406c)
  went green on Mobile CI + Rust Checks immediately, and the TAG's Release + Mobile APK workflows
  both built — but the `CI` (verify) run caught ONE failing test: the r122 OK-turn feedback-phase
  pin read the reporter's usage row SYNCHRONOUSLY the instant waitForEntry saw the ledger entry.
  The detached phase records that row in the same continuation that appended the entry — a race the
  3-4× slower windows runner can lose (the repo's own documented R73 lesson class; green locally
  and in the agent-core suite, red once on CI). The fix (bda22fb) keeps the assertion's truth
  byte-identical and makes only the WAIT honest: `waitForFeedbackUsageRows` /
  `waitForFeedbackUsageCount` poll like waitForEntry itself, timing out to the honest emptiness so
  a REAL recording failure still fails. Stress-verified 5× locally; the stale draft + the tag at
  the red commit were deleted; v0.118.0 was re-tagged at bda22fb AFTER its CI run went green, and
  the re-tag's Release + Mobile APK workflows both succeeded before the publish.

## §9 The honest deferred list

- **THE FULL PC REDESIGN SESSION — the owner scheduled it next**: "we will do a session where we
  will completely redesign the whole PC application properly… the PC application does not look like
  a professional application which a person could rely on." Everything visual this round was
  targeted glue (the duplicate, the blue, the feedback line); the redesign owns the whole surface.
- SubAgentPanel still speaks RUNNING_BLUE (deliberately left — the redesign round migrates it with
  the whole right-sidebar language).
- The ZCode adoption queue after this round: D3 (round-aligned selection + the durable preserved
  segment + invalidateRuntimeTokenUsage), D5 (the rapid-refill circuit breaker), D4 (post-compact
  Read-state re-injection), D6 (tool-result budgets + artifact spill), D8 (cache_control
  breakpoints for Anthropic-format providers).
- The mobile tool-calls mystery: no static defect found (see §7's note); the device check of the
  Tool activity pref is the first diagnostic, instrumentation the fallback.
- Linux/macOS capture still ride their region engines (the owner's platform is Windows; the
  PrintWindow law is Windows-only this round).
