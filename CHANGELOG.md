<!-- last-reviewed: 2026-09-08 round-79 -->
# Changelog

All notable changes to ACUTE-CODE are documented here. Entries are written for
the user of the workbench (features, fixes, behavior changes), not for the
agents that build it. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versioning
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); the
version number is single-sourced from the root `package.json`
(`pnpm version:get` / `version:check` / `version:set`).

## [Unreleased]

Planned next: the R80 queue — external plugin ctx enrichment (cline's
appendContext seam), the lessons-ledger affordance as the reminder
injector's third consumer, ratings-driven prompt tuning, the optional
v0.68.0 backfill tag, and the standing items (edit-linting — SWE-agent's
ACI #1 finding, installer code-signing, the Files-tab polish, agent
web-app-testing tools).

## [0.78.0] - 2026-09-08

### Added
- **Addressable, background, resumable sub-agent tasks** (the standing
  R73 deferral — the orchestrator round): `delegate_task` gained
  `task_id` (the parent model's own address for a delegation: 1–64 chars,
  unique per session, required for background) and two new call shapes.
  `background:true` fires-and-forgets — the call returns IMMEDIATELY with
  a receipt (task_id, session id, code, role, model + the instruction to
  resume later) while the child runs detached: it routinely outlives the
  parent's turn, its progress streams to the Sub-agents panel exactly
  like a blocking child's, and its status rides the NEXT turn's system
  prompt as a per-turn "## BACKGROUND TASKS" section (running "3m in,
  4/7 todos" / COMPLETED — resume to read its report / FAILED — resume to
  retry it from where it stopped; the section disappears once the report
  is collected, and the model is told never to poll — resume IS the
  wait). `resume` collects by task_id, child session id, or 4-char code:
  it waits while the task runs, returns the final report on completion
  (idempotently), and retries a failed child from where it stopped.
  Dishonest calls are refused honestly: a bad task_id grammar, a
  duplicate id (naming the existing task's status), background without a
  task_id, more than 10 outstanding background tasks (the runaway fan-out
  cap, listing them), or a resume with no task and no address (the
  addressable list of what there IS to resume). The owner sees the
  address everywhere a sub-agent appears: a mono task-id chip beside the
  code chip in the Sub-agents panel and on the live sub-agent card in the
  chat (tooltip: `delegate_task {"resume":"<id>"} collects it`), and the
  `/subagents` rows + live status frames carry `taskId`. A Stop of the
  parent turn still cascades to the detached child; the owner's panel
  Stop remains the stop surface for a misbehaving background task.
  Database migration 0028 adds `sessions.delegate_task_id` (+ the
  parent/task index) — every pre-R79 child and every task_id-less call
  is byte-identical to the old behavior.

### Verified
- 2741/2741 root tests in 145 files (agent-core 1769 incl. 27 new
  delegation tests; frontend +6), lint + typechecks clean, and the
  live battery `scripts/battery-r79.mjs` 10/10 against a dedicated
  sidecar with a mock provider that records REQUEST BODIES as the
  model-facing oracle: the blocking regression, the background task
  outliving the parent's turn (~400 ms turn vs a 4 s child) with the
  receipt inline, the next turn's request body carrying the BACKGROUND
  TASKS section and the section GONE after collection, resume waiting
  ~2.7 s for a 3 s child, the duplicate refusal, the taskId on the
  /subagents rows, the unknown-address list, and the failed-child retry
  (the "You were interrupted" continuation seen in the child's own
  request body).

## [0.77.0] - 2026-09-08

### Added
- **Send messages while the agent is working — they queue** (owner spec,
  verbatim): while the agent is responding or running tools the composer
  stays interactive; a send (button or Enter) POSTs to the session's queue
  and renders as an amber chip ("Queued — sends after the current step") in
  the live area. The message is auto-delivered right after the current tool
  call — the agent reads it with the full context of the work it just did
  and continues, never interrupting the in-flight flow. When the turn ends
  with messages still waiting, the SAME stream continues with the next
  queued message (a full new turn, capped at 25 continuations). Each chip
  can be removed (X) or sent immediately ("Send now" when idle); a Stop
  leaves queued messages queued. A crash or restart never loses them: they
  deliver, in order, before the next send.
- **A retry-config section in Settings → General** (owner spec, verbatim):
  three switches — auto-retry rate limits (429), auto-retry timeouts,
  auto-retry network errors. A switched-off failure class fails fast with
  the provider's real error text instead of waiting out the ladder (the
  schedule is unchanged for the classes left on: 6 attempts — immediate,
  1.5 min, 5 min, 10 min, 30 min; all on by default).
- **The retry status card now shows the API's actual error text**: under the
  class chip, the provider's real words (monospace, up to 3 lines; a
  "Show full error" toggle expands the complete text for long payloads) —
  the same honesty the terminal error card gained in 0.76.0, now live
  during the wait.

### Fixed
- **The retry ladder no longer misreports the failure** (owner spec,
  verbatim — "no matter the real cause, the UI always shows
  'rate-limited'"): the SDK's retry wrapper hid the real status code, so
  classification rode message-pattern luck, and several non-rate-limit
  failures were labeled with generic or wrong lines. The chain now unwraps
  the real error first — only a REAL rate limit ladders and shows as one;
  a bad model, a quota-blocked free model, and a region block all fail
  fast with the API's actual returned text.
- **A 403 region block no longer claims "authentication failed"**: a 403
  whose body says region / moderation / permission / unavailable is a
  fail-fast error carrying the provider's own words, not a key rejection
  (plain 403 and 401 still report auth).
- **The composer's bottom buttons never render in the wrong position**
  (owner spec, verbatim): the Continue / Send / Stop / queue-send group is
  now a never-wrapping anchor pinned to the bottom-right of the toolbar —
  a DOM sibling of the wrapping area, not inside it — so the action button
  cannot jump lines or drift when space runs out; the selector pills wrap
  as a unit instead.

### Changed
- The Settings tab labeled "Advanced" is now labeled **"General"** (the URL
  and deep-links keep the `advanced` id — old links still work). The
  Auto-retry, Debug mode, and agent-memory settings live there.

### Verified
- Live battery (12/12 stages) against a dedicated sidecar + a local
  OpenRouter-compatible mock provider that records request bodies as the
  model-facing oracle: the honest bad-model error, a REAL account-wide 429
  ladder carrying the real "Rate limit exceeded: free-models-per-day" text,
  queue-during-the-ladder-wait delivered at the rung boundary, the
  retry-gate fail-fast, mid-turn delivery (the queued text + the completed
  tool result in the next prompt), the same-stream continuation, the
  crash-recovery pre-flip, and the route honesty (409 NO_LIVE_TURN,
  dequeue, 404s). Browser-verified end-to-end against the real dev stack:
  the real 429 storm renders the honest card (attempts 2–5 observed), the
  queue chips deliver live, Stop mid-ladder stays retryable, the settings
  toggle persists server-side, and the composer anchor is stable at
  386/480/560/641/900 px.

## [0.76.0] - 2026-09-07

### Changed
- **Composer toolbar is now split left/right** (owner spec, verbatim): the
  attach-file button, the access-level selector, and the task-mode selector
  sit on the LEFT side of the row; the context window, model, reasoning,
  Continue and Send/Stop sit on the RIGHT — pinned with `ml-auto` in a
  single no-wrap group, so the send/stop action can never wrap below the
  other options alone (when space runs out the whole right cluster moves
  together, send included).
- **The model selector finally has an icon**: a `Cpu` glyph leads the pill,
  matching the toolbar's other icon-led controls (Paperclip / Shield /
  Compass / Brain). Below the 560px container floor the text label hides
  and the icon stays, so the pill is still identifiable icon-only.
- **Revert-to-message now behaves like edit-and-resend** (owner spec,
  verbatim): reverting a message rewinds the session to BEFORE it, deletes
  that message (and its reply) from the chat, and pastes the message's text
  back into the composer, focused and ready to edit. The confirm dialog and
  toast describe exactly that. (Previously the reverted message stayed
  dangling at the transcript's end with no reply.)
- **The retry-ladder status card was redesigned**: the spinning refresh icon
  now sits in a soft circular amber chip; a dot-ladder shows all six
  attempts at a glance (failed attempts dim, the upcoming one breathing,
  the rest hollow); the countdown gained a thin progress bar that fills as
  the wait elapses; the class chip is a rounded pill; the exact
  remaining-time format no longer rounds seconds to tens.

### Fixed
- **Failed sends no longer vanish** (the owner's "tried sending a message,
  but it was not that successful"): a turn that failed without a persisted
  error — a rejected request (validation / auth / 409 conflict / disabled
  provider) or a dropped stream — used to wipe BOTH the error card and the
  user's message bubble, leaving the transcript looking like the send never
  happened. The error card and the user's message now stay visible (with
  the retry affordance) until the next send.
- **API error envelopes arrive intact**: pre-stream rejections (HTTP 4xx/5xx
  JSON) no longer masquerade as `PROVIDER_ERROR` — the envelope's real code
  (e.g. `PROVIDER_DISABLED`, `CONFLICT`, `UNAUTHORIZED`) and its details
  (the actual provider error text, class, attempts) ride the error frame
  into the card.
- **Long provider errors show in full**: error reasons over 240 characters
  collapse to an excerpt with a "Show full error" toggle that expands the
  complete raw message in a scrollable monospace block ("show the actual
  error messages too, which were returned from the API"). Copy details
  always carried the full text; now the card can too.
- **The error banner no longer discards the real message** when a session
  cache exists — create-session and demo-send failures always surface the
  actual `ApiError` text (the discard branch predated the stream store).
- **A blank model reply is now an honest failure, not a fake success**: a
  free-model flake observed live during the battery — the model "answered"
  with only whitespace, no tool calls, and the turn completed ok with an
  empty reply while the requested work silently never happened — now ends
  the turn with a visible `NO_OUTPUT` error (persisted, retryable via the
  error card's Retry). Tool-using turns with no final text remain
  legitimate (the tools did the work).

### Verified
- Live end-to-end battery against the real provider: a smoke round-trip, a
  three-file static-site build, a Python CLI with self-written + self-run
  green tests, a 3-turn build→extend→refactor session, a 10-turn
  conversation with context-retention probes, the new revert semantics over
  the wire, and the error-surfacing path (honest failure frames carrying
  the real provider text). A real free-tier rate-limit storm during the
  battery exercised the R75 retry ladder live: retry frames at the exact
  90 s / 5 m / 10 m / 30 m rungs, the visible amber card, and the honest
  exhaustion error after six attempts.

## [0.75.0] - 2026-09-07

### Added
- **Transient-API auto-retry ladder** (owner spec, verbatim): rate-limit /
  network / timeout failures now retry immediately, then wait 1.5 min →
  5 min → 10 min → 30 min (one final attempt) — six attempts total before
  stopping, notifying, and showing the error. Auth / overflow / unknown
  failures never auto-retry (fail fast with the honest card). A live amber
  "Retrying — attempt 2 of 6" status card with a countdown shows during
  waits; any content frame means the retry succeeded.
- **Task modes are now HARD-ENFORCED** (plan / debug / build / review /
  explore / refactor): plan/review/explore intersect the turn's toolset
  down to a read-only set — write_file, edit_file, run_command, index_project
  and friends are REMOVED (the model cannot call them, and the prompt never
  lists them). Debug keeps the full toolset but run_command demotes to
  read-only/build/test commands. Delegated sub-agents inherit the parent's
  mode. Read-only modes are owner-pinned: switch_mode cannot leave them.
- Mode-picker rows are single-line with the description on hover (title
  tooltip) and an accent "read-only" badge on plan/review/explore.
- The composer toolbar is ONE row in the owner's exact order (attach,
  access, mode, context, model, reasoning, send); below a 560px box the
  selector pills collapse to icons (labels ride their tooltips).
- Terminal error cards show the failure class + "after N attempts"; the
  task-failed notification body says "auto-retried N times".

### Fixed
- **The composer textarea never auto-grew** (the "cut off to two lines"
  report): `flex-1` (flex-basis 0%) made the flex algorithm ignore the
  height style — the box stayed at its intrinsic ~1-line height and
  scrolled internally. The height style now governs; the box grows to
  exactly 5 visible lines (derived from the live line-height), then
  scrolls. Programmatic fills (suggestion chips) resize too.
- **Sub-agent turns that failed mid-work reported success** — the
  orchestrator marked them completed and the parent model built on
  half-done work. Now: the real usage is recorded, the error persisted,
  and an honest 502 returned.
- **A sidecar crash mid-turn left no trace** — the session flipped to
  terminal `failed` with nothing in the timeline and 409'd the next send.
  The boot sweep now writes an INTERRUPTED error event and keeps the
  session retryable (queued).
- **Real provider 429s/5xx were unclassifiable** (the deepest find): the
  AI SDK delivers post-retry provider errors as fullStream error PARTS,
  which the stream adapter ignored — the runtime only ever saw the generic
  "No output generated" rejection, classified unknown, so no retry ladder
  and no honest class on the card. The adapter re-throws the original
  error; classification and the ladder now see the real shape.
- Partial streamed text now survives EVERY exit path (terminal errors
  flush it, matching the abort path) and the error class reaches the UI.

## [0.74.0] - 2026-09-07

Round 74 — the updater-freeze round (the owner's report: "the installed
desktop app version was 0.67.0 — the application apparently did not
update"). **Root cause:** GitHub's release list sorts never-published
DRAFTS above every published release, and the round-63–67 close-outs
left five drafts (v0.63.0–v0.67.0) sitting at list positions 1–5 — the
launcher's release check walked that list in raw order, took the first
installer it saw (draft 0.67.0), and concluded the installed 0.67.0 was
current while 0.73.0 was live. No error, nothing to see: the update
simply never triggered. **The fix:** the launcher now picks the newest
release by **MAX VERSION over the whole list** — never by list order —
immune to draft placement, re-sorting and page truncation alike (the
check also widens to 100 entries per page and retries once on a
transient network error). Drafts remain first-class on purpose: the
owner's token can see them, so a freshly built release is installable
on the very next double-click, published or not; a same-version tie
prefers the published entry. **The freeze is now visible, not silent:**
the version-truth panel names the tag it picked (and says when it is
still a draft), and `ACUTE.bat status` annotates published/draft.
**Ten regression tests** pin the picker's contract — including the
exact owner-freeze list shape (five drafts above the published
releases) — and run in both the push and the release CI gates, so every
tag is protected. **One-time remediation:** the five stale drafts were
published (the step those rounds' close-outs never got), which also
un-freezes any install still running the pre-fix launcher — the
never-downgrade guard was verified to hold against every list state
the old code could see. Nothing else changed: the decision ladder, the
sha256-verified download, the silent install, the post-install
registry+exe+engine verification, the self-update mechanism, and
ACUTE.bat itself are byte-identical; the fix reaches an existing
launcher through its own self-update (git pull → copy → re-exec) on
the owner's next double-click. Anomaly flagged per the standing rule:
**v0.68.0 never existed** (R68 shipped the version bump but skipped the
tag push — the exact R61/R62 failure class); left as a documented gap,
superseded by 0.69.0+.

## [0.73.0] - 2026-09-07

Round 73 — the task modes round, the posture layer that completes the
owner's directive ("proper detailed system prompts which the agent
accesses when required and on the basis of the task"). Skills carry
methodology; **task modes carry POSTURE** — how the agent holds itself
for a class of work: what it refuses to do first (edit, theorize,
widen, praise), what it must produce before anything else (a spec, a
reproduction, a safety net, a map), what "done" means in that stance.
**Six built-in modes** (plan / debug / build / review / explore /
refactor, deep 2.0-2.5KB posture bodies with iron laws, ordered
methods, honesty rules, and a PAIRS WITH line steering to the skills
that carry the method — e.g. plan's NO EDITS + the 7-question
interrogation + present-and-wait; debug's NEVER a fix without a
one-sentence root cause + the unreproduced-bug-is-a-rumor honesty rule
+ 3-strike escalation; review's NO EDITS + the evidence-quoted findings
format + the mandatory WHAT-I-DID-NOT-CHECK; refactor's no-behavior-
change iron law + one mechanical move per step). **Three access
paths, nothing auto-activates**: the agent-side switch_mode tool
(activates/clears/lists — returns the full guide ONCE on activation,
then the prompt carries it every following turn; "none"/"off"/"auto"
or JSON null deactivate), the user-side composer mode picker + /mode
slash command (set/clear/list, id or name, case-insensitive,
word-boundary so /moderation falls through), and the advisory Task
signal line — the R72 deterministic matcher, extended: mode
descriptions are scored exactly like skill descriptions
(computeModeHints, the same shared scorer, computeTaskHints unchanged)
and the new TASK MODES prompt section renders "Task signal: this
request looks like the **debug** posture — consider switch_mode FIRST"
(advice only; per-turn ephemeral; the golden prompt fixture stayed
byte-identical). **Custom modes**: .acute/agents/*.md in the project
root (the kilocode/claude pattern) — frontmatter name/description/
tools + a body that becomes the active mode's prompt module; ≤8 files
× 16KB, honest caps and 8 diagnostic kinds, a custom mode SHADOWS the
builtin of the same id, and an optional tools list NARROWS the
session's tool allowlist while active (never widens; unknown tool
names drop; project-root trust — same level as .acute/prompts
overrides, no allowlist bypass). **The mode surface is first-class**:
sessions carry active_mode (migration 0027; existing sessions stay
exactly today's behavior), PATCH /sessions/:id accepts
{activeMode: id|null} (unknown id → 400 with the available ids),
GET /projects/:id/modes serves the metadata-only index, switch_mode
joined the always-registered vocabulary + plan permission mode's
tools, and a vanished custom mode is swept clear with a one-turn
honest note. **Also this round**: the generalized system-reminder
renderer (ONE mechanism — the per-directory conventions reminder
migrated onto it byte-identically, switch_mode's activation notice is
its second consumer, plus a per-turn ReminderBudget of 3) and the
skills library 18 → **20** (spec-planning: the spec-as-decision-
document methodology, interfaces first, ≤5 batched questions with
defaults; performance: NO OPTIMIZATION WITHOUT A BEFORE-NUMBER AND A
NAMED BOTTLENECK, the 3-rung profiling ladder, complexity before
micro-tuning). 2558 root tests in 138 files, all green (agent-core
1637/1637 in 74 files — +135: four new suites r73-modes-core 28 +
r73-system-reminders 16 + r73-skills-round 17 + r73-modes-backend 45
+ skills re-pins; frontend 909 in 62 files — the picker 10 + panel
23→32), lint/typecheck clean, license audit CLEAN (134 deps, no
dependency changes), plus a live HTTP smoke of the mode routes against
a real sidecar spin (GET /modes with a custom, PATCH set/bogus-400/
null-clear). Full evidence in docs/ui-iterations/round-73.md.

## [0.72.0] - 2026-09-07

Round 72 — the adaptive capability round (the owner's directive:
"proper detailed system prompts which the agent accesses when required
and on the basis of the task, various in-built skills"). **The agent
now gets skill guidance on the basis of the task**: every turn's
incoming message is scored — by a deterministic, zero-cost, zero-
latency matcher (no extra model call) — against the advertised skills'
trigger-rich descriptions (quoted phrasings weigh ×5, stopword-
filtered tokens +1; top-2 above threshold), and the SKILLS prompt
section gains one honest advisory line — "Task signal: this request
looks like it matches **debugging** — consider calling read_skill with
that name FIRST". It is advice, never an auto-load (progressive
disclosure stays the contract), it flows through the same skill
resolver (computer-use gate + per-agent allowlist respected), it works
on both the streamed and sync paths, it is per-turn ephemeral, and the
golden prompt fixture stayed byte-identical. **Eighteen built-in
skills** (was 12): six new engineering crafts — tdd (the RED→GREEN→
REFACTOR loop: "a test you have not watched fail proves nothing"),
api-design (the contract is written before the handler; fail-closed
validation; additive-only evolution), frontend-craft (state lives as
close to its consumers as possible; stable keys; the a11y floor),
typescript-craft (if a state is illegal its type must make it
unrepresentable; never `any`; "a cast is a confession"),
security-review (the big five — injection, path traversal, secrets,
authz, fail-closed — each with the exact test), and refactoring (no
move without a green characterization test first; one mechanical move
per step). **File skills gained a reference tier**: a `references/`
subdirectory (the Agent-Skills standard, one level deep, ≤8 .md files
≤64KB each) whose files load through read_skill's new optional
`reference` parameter — the skill body's output lists what's available
with the copy-pasteable call syntax; the GET /skills listing carries
the metadata additively. **read_file now honors the conventions of the
directory you're about to edit** (the kilocode pattern): when a deeper
AGENTS.md/CLAUDE.md governs the file's path (the root one is already
in the system prompt — never double-billed), the first read under that
directory appends a clearly-fenced, ≤2,000-char excerpt of it — "[conventions
from a/b/AGENTS.md apply to this file]" — once per session and
directory, never on failure paths, and the raw REST file view never
sees it. 2423 root tests in 133 files, all green (agent-core 1521/1521
in 70 files — +136: four new suites r72-task-hints 27 +
r72-skills-expansion 32 + r72-references 27 + r72-dir-conventions 20
+ re-pins; frontend 890 unchanged — zero frontend files touched),
lint/typecheck clean, license audit CLEAN (134 deps, no dependency
changes). Full evidence in docs/ui-iterations/round-72.md.

## [0.71.0] - 2026-09-07

Round 71 — the discipline & reliability round (research-driven from the
four reference repos the owner supplied; no new field report). **The
prompt now teaches engineering discipline**: a new ENGINEERING
DISCIPLINE section carries the four karpathy principles each with a
binary self-test the model runs on its own diff (don't assume — surface
tradeoffs; minimum code, nothing speculative; touch only what you must
— clean up only your own orphans, never pre-existing dead code; define
success criteria, loop until verified), [KNOWN]/[ASSUMED]/[UNKNOWN]
tagging with the rule "NEVER write code that depends on an [UNKNOWN]
API fact — read the source first", a three-strike escalation rule
(three failed fixes to the same problem = STOP, re-diagnose, escalate —
no 4th fix of the same shape), and a red-flags table that quotes the
model's own rationalizations back at it ("I remember the file looking
like this" → re-read it). Planning turns vague tasks into verifiable
goals ("fix the bug" → "write a test that reproduces it, then make it
pass"), and final replies now carry VERIFICATION RECEIPTS (the exact
command + exit status, never a bare assertion — "an assertion without
a receipt is not verification"), a 🟢/🟡/🔴 confidence tag, and one
line of devil's advocate on non-trivial changes, without ending on
padding questions. **Twelve built-in skills** (was 8): all descriptions
rewritten trigger-rich in the "Use when [phrasings]. NOT for [adjacent
case]" convention so the model can actually choose them, plus four new
discipline skills — focused-fix (the Iron Law: NO FIXES WITHOUT
COMPLETING SCOPE → TRACE → DIAGNOSE FIRST), zero-hallucination,
self-eval, and ship-gate (intercepts "commit and push"/"deploy"/"ship
it" with a DO NOT SHIP / SHIP WITH NOTES / CLEAR verdict). **Failed
edits now escalate instead of letting the model flail**: a consecutive
anchor-failure counter per session appends recovery strategy to the
error (2nd miss → re-read the file and copy the anchor exactly; 3rd →
change your approach or rewrite with write_file; 5th → refuse the
pattern) and resets on the first success. **Long read_file / run_command
outputs carry the exact next call** — truncation markers state the
file's total line count and the precise "use offset=N to continue"
(the omitted middle is reachable without guessing), and oversized
command output teaches the spill-to-file recovery path. **Your
denials are no longer read as tool failures**: a rejected approval now
says "denied by the owner — this is NOT a tool or system failure; ask
why, or propose an alternative", and approval TIMEOUTS are
distinguished from denials ("the user may be away; do not assume
rejection"). **Provider errors are classified before they surface** —
six honest classes (context-window overflow / auth / rate-limit /
network / timeout / unknown) on the failure message and the error
event, so a dead key no longer reads like a network blip. **Context
overflow recovers instead of killing the turn**: when the provider
rejects an oversized request, the conversation is auto-compacted and
the turn retried once (a visible "[context overflow → auto-compacted
conversation → retrying]" line), with an honest terminal message if it
overflows again. 2287 root tests in 129 files, all green (agent-core
1385/1385 in 66 files — +110: three new suites r71-prompt-discipline 24
+ r71-tool-reliability 31 + r71-skills-round 51 + re-pins; frontend 890
unchanged — zero frontend files touched), lint/typecheck clean, license
audit CLEAN (134 deps, no dependency changes). Full evidence in
docs/ui-iterations/round-71.md.

## [0.70.0] - 2026-09-06

Round 70 — the agent brain round (research-driven: the round's own
prompt audit + an OSS agent study — no new owner field report; the
model now knows its world, follows conventions, and verifies before
claiming done). **The model knows its machine**: the system prompt
states the actual OS + release, the real shell run_command uses
(cmd.exe on Windows, /bin/sh on POSIX — the TERMINAL section teaches
only the REAL platform's syntax now, not both), the current date,
and the git branch + dirty state (a 1.5 s guarded probe with honest
fallbacks) — and a dirty tree is named as YOUR work the agent must
never revert. **Project conventions are honored**: AGENTS.md,
CLAUDE.md, AGENTS.override.md and CLAUDE.local.md at the project root
auto-load into every turn (the cross-agent standard — Codex, Claude
Code, Cursor and OpenHands converged on it; 60k+ projects carry the
file), alongside ACUTE's own `.acute/rules/*.md` and `.acuterules`,
in a documented order (later = more specific), each part with a
source marker; AGENTS.md/CLAUDE.md expand `@file` imports (relative
paths, .md/.txt, max 4, cycle-guarded; 16 K per file, 32 K total).
A new built-in **project-init** skill writes that AGENTS.md for you
from codebase analysis. **The prompt got smaller while gaining all
of this (22,460 → 20,156 chars)**: the four overlapping planning
sections (agentic-loop + efficiency + task-planning + todo-tracking
— 4,762 chars of the same advice four different ways) merged into
ONE five-phase loop — PLAN (todos for 3+ steps, skip trivial) →
EXPLORE (batched discovery) → ACT (fewest steps) → VERIFY (run the
touched tests/typecheck/lint before claiming done, commands
discovered from AGENTS.md/package.json; a delegate_task adversarial
review for 3+ file edits) → FINISH — and the browser/computer-use
sections keep only their essentials, pointing at the matching
skills for the deep craft. **Skill bodies stopped evaporating**:
read_skill and memory_recall results persist with a 60 K budget and
skip the 200-char replay stub — a loaded instruction set now
survives the whole task (the last-resort context cap degrades to 8 K
with an honest reload marker). **Seven new built-in skills**
(code-review, debugging, testing, git-workflow, web-research,
project-init, browser-use — with computer-use, 8 total), and skills
can now be FILES: `.acute/skills/<name>/SKILL.md` per project and
`~/.agents/skills/` user-global (the Agent-Skills standard format —
the same folder works in other agents), with DB rows taking
precedence, merged listings with provenance in Settings → Skills,
and honest 409 "edit the SKILL.md" refusals for file-skill edits.
The per-agent skill allowlist (agent.skills) is finally wired — it
was stored and patched since R61 and never read. **Tool feedback got
honest (the ACI round)**: run_command's 64 K output cap now keeps
head 32 K AND tail 32 K with an explicit middle-omission marker
(build/test errors live at the END of the log — the tail was
previously thrown away); read_file returns cat -n line numbers plus
offset/limit pagination with honest empty-file and end-of-file
messages (files >256 K keep both ends with the exact paging path);
todo_write's description carries the planning discipline (no
single-item plans, update after each sub-task); silent successes now
say "(no output — the command ran successfully and printed nothing)"
and job_status's empty-log case explains itself. 2177 root tests in
126 files, all green (the 12 sidecar-e2e ran in-suite against the fresh
build; agent-core 1275 in 63 files, frontend 890 unchanged — zero
frontend files touched),
lint/typecheck clean, build green, license audit CLEAN (134
dependencies, no dependency changes this round). Full evidence in
docs/ui-iterations/round-70.md.

## [0.69.0] - 2026-09-06

Round 69 — the computer-use enforcement layer (no new owner field
report: this round closes the residuals R68's own close-out named).
R68 built the mechanisms; R69 makes them AUTOMATIC so the agent stops
re-capturing and starts knowing. **Every mutating action now returns an
observation receipt** — after a 600 ms settle, the 11 action tools
(left/right/double/triple/middle click, scroll, type, key, set_value,
select_text, left_click_drag) attach `{frameId, screenChanged,
focusedElementName, activeApp, titleChanged}` to the receipt (a fresh
registered frame, what changed vs the pre-action frame, what's focused
now, the frontmost app's title) — the verification read the model used
to buy with a 5–25 s screenshot+vision round now rides the action
itself, and the post-action frame renders INLINE in the chat at the
moment it was captured (the same capture-moment pipeline as the
model's own screenshots). `returnState` selects the depth:
"compact" (the default, the raster observation), "none" (skip),
"full" (the complete accessibility compose). **Coordinate clicks
verify what they hit**: the receipt's verification status upgrades
from a blind "unverified" to "changed"/"unchanged" (a perceptual
frame hash), and the hit-test the engine already ran now names the
element the point landed on (`hitElementName`). **Stale frames
auto-refresh instead of dead-ending**: a coordinate action on a frame
older than 30 s re-captures and compares perceptually first — a static
screen proceeds (with a refresh receipt), a stable-enough target
region proceeds, and only a genuinely changed screen refuses the new
`frame_changed` carrying the ALREADY-REGISTERED fresh frame (one zoom
round-trip, not a screenshot+replan cycle); the old `frame_stale`
loop is dead for pointer tools. **The screenshot loop is refused
outright**: a third consecutive near-identical capture (no intervening
action) refuses `screen_unchanged` with the three productive
alternatives (act / wait() / find_elements) — nothing registers, so
the loop cannot feed itself. **`wait()` reports what changed** while
waiting (its receipt carries the same observation; no action is
sent). **Element targeting widens**: `middle_click` and `right_click`
take element targets now (middle = raw click at the element's center
— open-in-new-tab flows without coordinate guessing; right = a raw
center click when the element has no menu), double/triple keep their
honest raw-only contract. **Windows fixes**: the scroll tool was
QUADRATIC (it sent N wheel events each carrying N×120 — a 10-tick
scroll moved 100× the intent; now one event, ticks×120, horizontal
rides real MOUSEEVENTF_HWHEEL instead of arrow-taps that never
scrolled page content); long typing (>300 chars) rides a stdin
base64 clipboard paste (Set-Clipboard + Ctrl+V — the 32,767-char
command-line ceiling no longer caps what you can type into an
editor); the Chromium accessibility poke is dual-object and
polls (up to 2 s for a cold tree) and freshly-launched Edge/Chrome
carry `--force-renderer-accessibility`. **The floating monitor no
longer steals focus** — its re-open no longer calls set_focus (tao's
implementation synthesizes an ALT-key keystroke pair to grab the
foreground — stray synthetic input mid-action) and the window carries
`WS_EX_NOACTIVATE`; STOP and dragging stay fully interactive. The
prompts, the built-in skill and the tool descriptions re-teach the
loop (read the receipt, element-first, wait after navigation).
2082 root tests in 123 files (was 2003; agent-core 1180/60, frontend
890/61 unchanged, e2e 12), lint/typecheck clean, build green, cargo
check (Windows target) clean, license audit CLEAN with pngjs@7 (MIT)
— the Windows-native paths remain construction-pinned and gate on
the owner's next live run. Full evidence in
docs/ui-iterations/round-69.md.

## [0.68.0] - 2026-09-06

Round 68 — the computer-use overhaul, driven by the owner's v0.67.0 live
Windows field report (web browse CONFIRMED 100% working — untouched this
round). **Screenshots now appear INLINE at the moment they were taken**
(the owner: "The screenshots were supposed to be shown properly when they
were actually taken, not at the bottom in a dedicated section. When the
screenshots were taken they should be shown at that specific time."):
every capture becomes a `screenshot` working entry pushed onto the live
turn's working stream at frame arrival — landing right after the in-flight
tool row that took it — rendered inline between the tool rows as a compact
click-to-enlarge tile (lazy raster fetch, an honest "expired" placeholder
after the server's 10-minute raster lifetime); the R67 bottom strip, its
cap-8 sidecar array, and ScreenshotStrip.tsx are gone, and the debug
full-turn export carries the `[screenshot captured by <tool>]` marker.
**The floating "Agent is using your computer" monitor is invisible to
captures now** (the owner: "It will be an overlay kind of thing. It will
not be detected by our agent and it will also not be shown in the
screenshots which it takes and such"): `SetWindowDisplayAffinity(
WDA_EXCLUDEFROMCAPTURE)` on the mini window — fully rendered on your
physical display, dropped from every screen-capture API (the agent's own
GDI captures, Windows.Graphics.Capture, OBS, screen share), so agent
screenshots show what is BEHIND the bar and the vision model never reads
the indicator text it used to "detect" (also: your own recordings of a
session won't show the bar — the exclusion is global, documented as
intended; pre-Windows-10-2004 hosts fall back to the old visible-in-
captures behavior, non-fatally). **Windows keyboard input is raw SendInput
now** — every type/key/scroll/click-modifier path failed
capability_fail_closed on the owner's host because SendKeys was loaded
via the deprecated `LoadWithPartialName` (dead on modern .NET, while the
captures' own Add-Type worked — the live trace proved it): Windows.Forms
is a dead dependency for input; text types via KEYEVENTF_UNICODE per
character (no escaping class of bugs at all), keys/chords via real
Virtual-Key codes — the win/meta key works for the first time, and a
runtime ARGV guard (31,875-char measured ceiling) refuses an over-long
type/setValue/clipboard payload BEFORE the spawn with a self-teaching
error instead of a cryptic CreateProcess death. **The foreground gate
self-heals**: a frontmost mismatch (Edge churns the foreground) no longer
refuses — the raw-input tools ACTIVATE their target first (an escalated
ladder: AttachThreadInput, then the minimize/restore trick, then an
honest verify) and retry ONCE; a `frontmost_pid_mismatch` refusal now
means the automatic activation itself failed. **Edge/Chromium web pages
become searchable** — Chromium only builds its web accessibility tree
after an assistive technology pokes it, which is why the trees came back
sparse: every snapshot now pokes the render widget (WM_GETOBJECT) before
the UIA walk, so find_elements returns real links/buttons/inputs BY NAME
and element targets replace the screenshot loop (the owner: "a
coordinate-based system is not proper"). **Frames stay valid 30 seconds**
(was 10 — shorter than the vision roundtrip itself, so every
zoom-then-click pair died frame_stale between observing and acting), and
**the vision relay retries 429/5xx** (two retries, 1.5 s + 3 s backoff —
one rate-limit no longer kills an observation mid-flow). The prompts, the
built-in computer-use skill and the tool descriptions teach the new truth
(search the browser tree first, chain observe→act immediately, verify
with a small zoom crop, middle_click = new tab, the auto-activation).
2003 root tests in 122 files (was 1961; agent-core 1101/1101 in 59,
frontend 890/890 in 61), lint/typecheck clean, version 0.68.0 — the
Windows-native paths remain construction-pinned (PowerShell and cargo
never run in this sandbox) and gate on the owner's next live run.

## [0.67.0] - 2026-09-05

Round 67 — the bridge round, driven by the owner's 0.66.0 live Windows
field report. **The embedded browser actually works on Windows now**:
agent `navigate` (and back/forward/reload) emits an instant
`browser-navigate` SSE frame and the panel navigates — or CREATES — the
WebView2 the moment it lands, with the 4 s poll's adopt path fixed to
create the webview too (the "panel stayed blank until I pressed Enter in
the address bar" / "no native webview for tab" bug). **Every page action
was failing with "the page rejected the script"** — root cause found:
WebView2's `ExecuteScriptAsync` returns eval results JSON-ENCODED, our
scripts return `JSON.stringify(...)`, so the callback string was
double-encoded; the new tolerant double-parse in `native-browser.ts`
handles both transports (WebKit one parse, WebView2 two) for eval AND the
pop-out gutter scrollbar probe. **Chat sessions own their browser tab
now** (the cross-session leak): every chat session binds to exactly one
tab — the panel POSTs `/browser/bind` with the session's active sidebar
tab before each turn, and an unbound session gets a deterministic
`ag-<chatSession>` tab minted and announced with a `browser-open` frame
(the sidebar opens it in THAT session's slice; a background turn never
yanks your visible sidebar); `get_state` lists only this session's tab,
and the cookie profile is per-PROJECT (the mint carries the project id —
two projects no longer share the `_default` jar). **Chat images are real
files now** ("it does not actually upload the image, it just shows the
path" fixed): a new `POST /attachments/upload` (base64 bytes or an
absolute path to copy; ≤8 MB; sanitized names; identical content reuses,
different content mints -2/-3… — never an overwrite) lands the file at
`<project>/attachments/<name>`, the composer's drag-drop, paste and
picker-binary paths all upload/ingest through it, and the model-facing
history renders the exact `analyze_image with path "<path>"` call — the
"image doesn't exist" loop is closed. **The debug report card got its Copy
button and auto-minimizes**: expanded while the analyst streams, collapses
on completion unless you touched it, folded cards start minimized, and
the always-reachable "Copy report" footer copies the model + full report;
assistant replies gained a debug-gated **"Copy full conversation (debug)"**
exporting the whole turn (thinking, tool calls with outputs, approvals,
final answer, model, duration — honest 4 000-char output summaries, ~100 KB
cap, tail kept). **Computer use on Windows got robust**: PowerShell
capsules ride `-EncodedCommand` argv (no stdin — the "session died before
emitting JSON" failure mode), the Add-Type compile is guarded with a
reachable Get-Process fallback, a failed-empty app list is retried once
and the refusal carries the probe note, a WebView2-helper pid gets the
honest "target the HOST application" refusal instead of "no running
application matches", and **the `key` tool finally presses keys**: the
SendKeys table maps tab/enter/esc/arrows/F1-F12 + ctrl/shift/alt chords
(`key "tab"` sends `{TAB}`, not t-a-b), every key receipt names the
FOCUSED element (the Tab-walk technique), and the floating monitor holds
for the whole turn while the agent thinks (browser-only turns still never
show it). **Screenshots show live in chat now**: every successful capture
(computer-use screenshot/zoom/get_app_state and the browser screenshot)
announces a `screenshot` SSE frame and serves the PNG from an ephemeral
in-memory registry (`GET /computer-use/frames/:id/raster`, LRU 12,
10-minute TTL) — a thumbnail strip under the live working section,
click-to-enlarge, an honest "expired" tile after the TTL. The system
prompt, the built-in computer-use skill and the browser/vision tool
descriptions were all taught the new truth (browser_control ONLY on the
panel — never computer-use tools; read_dom first, then the selector paths;
analyze_image with the rendered path; the Tab-walk loop), and the golden
prompt fixture regenerated. 1961 root tests in 122 files (was 1807/118;
agent-core 1064/1064 in 59, frontend 885/885 in 61), lint/typecheck/
docs:check clean, version 0.67.0; the live battery verified the bind
route, the raster route's honest 404/401 and the attachment upload +
dedupe on disk — the Windows-native paths (bridge decode, SendKeys,
capsules) are pinned by construction tests and gate on the owner's next
live run.

## [0.66.0] - 2026-09-04

Round 66 — the live-fire patch, driven by the owner's 0.65.0 field report.
**The agent can now USE the embedded browser like a user**: six new
`browser_control` page actions — `click`, `type` (with `submit:true` →
native form submission), `press_key` (Enter in a form submits it — the
"typed a Google query but never submitted it" fix), `read_dom` (a
structured page outline), `source` (html | css | scripts), and
`wait_for_verification` — 15 actions total, all riding the existing eval
bridge with no new bridge routes. **Bot walls are now owner-solvable**:
navigate/read detect captcha/Cloudflare/age gates and warn (⚠);
`wait_for_verification` opens a live countdown card in CHAT — "CAPTCHA
verification needed", the countdown timer, **Mark as done** / **Stop
waiting** — and the agent waits (default 15 s, max 60 s), re-probes, and
reports honestly. **Agent viewport changes apply INSTANTLY** to the panel
(a new SSE frame + a store seq that exits natural mode — previously a
preset change sat unapplied until you nudged a number). **Image analysis
has its own settings section** (Settings → Image Analysis): the vision
model moved OUT of Computer Use into a global configuration (off /
separate provider+model+its own key slot / main model) that now serves the
computer-use screenshots, the browser screenshots, AND the new general
**`analyze_image`** tool (describe any local file or URL — works without
computer use; migration 0025 moves existing settings losslessly, 0026
appends the tool to allowlists). **Debug mode is a post-turn analyst now**:
the agent no longer self-reports — after a turn completes, a completely
fresh, context-free model receives the whole transcript (every tool call's
FULL result) and streams its report live under the answer; the report is
persisted for reloads but NEVER fed back into the conversation. **Windows
goes element-first in big apps**: the UIA walk probes only 17 interactive
control types (one 4-probe pass, was up to 8 per node) and reaches 2400
elements (was 800) — deep enough for Edge — plus a new `find_elements`
tool that SEARCHES the tree by name so the agent stops screenshot-looping.
**The floating monitor is now top-center 460×56** (less tall, centered —
not top-right), and its live signal is real control activity only, with a
6-second decay — a browser turn never shows "agent is using your computer"
(browser screenshots no longer record into that ring). **The minimized
settings sidebar shows the settings rail** (section icons + back), not the
projects nav. 1807 root tests in 118 files (was 1686/110), agent-core
980/980 in 58 files, lint/typecheck/docs:check clean; version 0.66.0.
A same-day follow-up commit (the CI-stability patch) made two
Windows-runner test flakes deterministic — the checkpoint-card countdown
tick (now fake-timer driven) and the computer-use plugin's real-OS-probe
tests (explicit 30 s timeouts; the cold Add-Type compile is multi-second
on CI) — and hardened the overlay watcher against a late-debounce
crash (a pending 80 ms check firing after a test file's environment
tore down hit `document is not defined` as an unhandled error; the
callback now guards for a gone environment — inert in the real app).
No app behavior changed; counts unchanged; CI green and the
v0.66.0 release (launcher kit + NSIS installer) verified green from the
Actions API.

## [0.65.0] - 2026-09-02

Round 65 — the honesty patch. **The embedded browser and your real desktop
are now explicitly separated in the agent's instructions**: both the
computer-use and the embedded-browser prompt sections carry a SURFACE
BOUNDARY line naming the other surface — the agent can no longer
legitimately conflate "navigate in the embedded panel" with "I opened Edge
on your computer" (the exact hallucination from the first live Windows run).
**The browser tab now AUTO-OPENS when the agent browses** — every
browser_control call (or live browser-command) opens or surfaces the
embedded browser in the right sidebar, scoped to that project, once per
browsing burst; it was previously invisible. **Simple browsing asks
nothing**: google.com and bing.com joined the default auto-allowlist (exact
host matching). **Debug mode** (Settings → Advanced): when ON, every agent
answer ends with a raw execution report — each tool call, its outcome, what
was verified — read live per turn. The **agent-core connection / bearer
token card is REMOVED from Advanced** (the desktop app manages the engine
itself); Advanced is now Debug mode + agent memory. A sub-agent review
before ship caught and fixed three real bugs (duplicate blank browser tabs,
cross-project tab popping, a persisted burst gate). 1686 root tests (110
files) + 894 agent-core (53 files), lint/typecheck clean.

## [0.64.0] - 2026-09-02

Round 64 — the capability round, driven by the owner's first live Windows
run of computer use. **The Windows computer-use backend actually sees your
desktop now**: the PowerShell JSON layer silently collapsed every 0/1-element
list (why `list_apps` returned `[]`), app enumeration now walks the REAL
window list (EnumWindows — every visible top-level window with its process
name, not just cached process titles), and `get_app_state("Notepad")` works —
app references resolve by window title OR executable name, with substring
matching, and an `app_not_found` refusal now LISTS the running apps so the
agent self-corrects in one step. The built-in skill's instructions were
rewritten around the visionless UIA-first workflow. **The floating monitor
is a true always-on-top OS window** — a minimal, clean bar at the top of
every screen (status dot, what the agent is doing, elapsed, and the STOP
kill switch) that appears automatically the moment the agent starts using
the computer and disappears when it stops; the right-sidebar Computer tab is
removed (one surface, always on top of everything so you can stop it while
the agent drives other apps). **Agent responses are properly formatted**
(full markdown: bold, italics, headings, lists, tables, quotes, links —
during streaming too), and text between tool calls no longer hides behind
the collapsed "Worked for Ns" section. **The context-window popover** no
longer clips at the top of the screen (measured fixed-layer placement,
capped height with scroll, refined border) and updates LIVE as the agent
works. **Internal notifications dismiss after 1.5s.** **Expanding a
"Delegated task" row shows only ITS sub-agent** (each row claims the child
it spawned; live token stats in the sidebar stay fresh). **The model picker
lists exactly the models you added in Models & Providers** (the live catalog
no longer leaks in). **Permission changes apply to the very next command**
(the mode is re-read live, not frozen per turn), and a wide set of provably
read-only commands — including the Windows/PowerShell reads (`Get-Content`,
`Get-ChildItem`, `Select-String`, `tasklist`, …) and the usual search tools
(`rg`, `fd`, `git grep`, …) — never ask. **The Usage screen gained an "API
keys" section**: one card per key (primary or pool slot) with its requests,
tokens, cost, last-used and share bar — configured-but-unused keys and
removed keys render honestly. **The token estimator** is now a GPT-style
BPE approximation (CJK, digit and punctuation aware — the old chars/4
undercounted Chinese text 4-8×). 1664 root tests in 109 files (was
1542/104), agent-core 885/885 in 52 files (was 801/50).

## [0.63.0] - 2026-09-02

Round 63 — the desktop-update round. **The launcher now PROVES the desktop
app is the newest version instead of assuming it.** Rounds 61–62 shipped
features but never pushed their release tags, so no installer existed
beyond 0.60.0 — the site served the new code while the packaged app stayed
frozen (the root cause of "updated properly" reports). 0.63.0 is tagged and
released: the next `ACUTE.bat` run updates the desktop app 0.60.0 → 0.63.0
and verifies it. On every app launch the launcher now checks THREE
versions against the newest GitHub release — the uninstall registry's, the
installed exe's real FileVersion **on disk**, and (after launch) the
running engine's `/health` version — and a *hybrid* install (registry
bumped, exe stale — the leftover of a silent install racing a closing app)
is **deleted completely and reinstalled** from a sha256-verified download,
then verified again; a stuck engine version is flagged and self-heals on
the next run. New commands: `ACUTE.bat reinstall` (delete + fresh install
+ verify + launch) and `ACUTE.bat uninstall` (clean removal; your data in
`%APPDATA%\acute-code` is always kept), and `status` shows the full
version truth including the update-pending flag. The engine's `/health`
now reports the real app version (it had been a hardcoded 0.3.0 for 60+
rounds). The site flow's plan now says plainly that the embedded browser
and computer use are desktop-app features.

## [0.62.0] - 2026-09-02

Round 62 — the owner-feedback round. **The sidebar can now be MINIMIZED**
(a 64px icon rail with the restore button at its very top — persisted,
orthogonal to the full hide). **The session screen's gradient background
is gone** (flat theme background; the side padding + rounded corners
stay). **The embedded browser now RESPECTS the dimensions you set** —
larger presets render as a scaled-down view of the true size (the page
sees the full CSS pixels; the readout says "fits N%"), and the Chromium
footnote strip is removed. **Any open menu/dialog/popover now renders
ABOVE the browser webview** (a DOM overlay watcher hides native webviews
while overlays are open — the "menu opened under the browser" bug). **The
agent can now USE the right-sidebar browser**: `browser_control` grew
`read` (the page's text), `eval` (JavaScript in the live page — click
links, fill forms, read the DOM, native desktop mode), `screenshot`
(capture the panel + a vision-model description via Computer Use), and
`get_state` now lists every open tab; the system prompt teaches the
capability triad. **Settings → Appearance is simplified** (three
sections; the Sidebar Tint setting is removed). **Models & Providers
changes reflect on the agent session page immediately** (cross-cache
invalidation), the per-1M input/output token prices are clearly labeled
and support decimals, the model dialog gained a Supports-vision toggle,
and partially-priced models now cost what their known sides cost (the
silent $0 bug). 1542 root tests in 104 files (was 1492/103), agent-core
801/801, live-verified end-to-end including a real model turn driving
the browser tools.

## [0.61.0] - 2026-09-02

Round 61 — the computer-use + extensibility round. The agent can now
observe and actuate the real desktop GUI (30 gated tools, receipts,
fail-closed refusals, an enforced kill switch, an audit journal), with a
SEPARATELY-configurable vision model; plus the owner's extensibility asks:
user skills, MCP servers, and the settings tabs that manage them all.

### Added

- **Computer use — the agent drives your real desktop** ("give the user
  the option to turn on and off the computer use"): OFF by default; when
  you flip the master switch the agent gains 30 tools that read the
  accessibility tree (a11y-first, background-safe element actions) and
  fall back to screenshot coordinates. Three postures: **observe**
  (read-only tools only — the model never even sees a mutating schema),
  **act** (recommended — real-input actions like typing, drags, and
  coordinate clicks ask your approval first, through the same approval
  dialogs as run_command), and **auto** (no per-action prompts). Actions
  return receipts, never promises; everything the host refuses comes back
  as a NAMED refusal with the exact recovery step (22 codes, from
  `element_stale` to `frontmost_pid_mismatch` to `kill_switch_active`).
  Works on Windows (PowerShell + UI Automation, no extra deps), macOS
  (osascript + Accessibility/Screen Recording permissions), and Linux X11
  (xdotool/wmctrl/scrot/xclip + AT-SPI). Honest caveat, stated in the
  runbook: the logic is fully unit-tested but NO backend has been
  live-verified on a real display yet — follow the LIVE-VERIFICATION
  CHECKLIST in `docs/runbooks/COMPUTER-USE.md` before relying on it.
- **The separate vision model** (the owner: "for the vision we are
  utilizing a separate model… the provider completely separately"): a new
  Vision card in Settings → Computer Use with three modes — **off**
  (default), **separate** (pick any provider + model and paste that
  model's OWN API key into the dedicated key slot — masked, never shown
  in full), and **main** (use the turn's model, only when its row is
  marked supports-vision — the new eye toggle flips that flag per model
  row). The agent uses vision when you ask it to describe a screenshot
  (`describe:true`); it is never called silently.
- **The computer monitor** ("in a mini window it will show the details and
  their stats while the agent is using computers"): a new **Computer tab**
  in the right sidebar (status chip, live event feed with refusal codes,
  action/observation/vision stats, elapsed clock) plus a **floating
  draggable mini window** you can pop out anywhere — both fed live by
  per-execution stream events, and both carrying the **STOP kill switch**:
  one press and every further computer-use call is refused, with any held
  mouse button physically released.
- **The audit journal**: every computer-use call is appended to
  `<project>/.acute/computer-use/audit.jsonl` with credentials scrubbed,
  clipboard/typed text redacted to length markers, and screenshots never
  journaled (frame ids only).
- **Skills — the ability to add multiple**: Settings → Skills manages
  SKILL.md-style capability modules with progressive disclosure — each
  enabled skill's name + one-line description rides the system prompt,
  and the full body loads on demand via the new `read_skill` tool (the
  built-in `computer-use` skill ships seeded; built-ins can be edited or
  disabled but not deleted; user skills are full CRUD).
- **MCP servers — the ability to add MCP servers too**: Settings → MCP
  configures stdio Model Context Protocol servers (name/command/args/env,
  probe button, expandable live tools list). Enabled servers' tools join
  the agent's toolset as `mcp__<server>__<tool>`; child processes run with
  a sanitized environment — no ACUTE credential can ever reach an MCP
  server. One broken server never breaks a turn.
- **A new SYSTEM-PROMPT discipline** ("improve its tool calling skill
  using"): three tool-discipline rules (read tool errors fully before
  reacting; pick the most specific tool; never fabricate results), a
  faithfulness rule (report outcomes honestly — a truthful failure beats
  a confident fiction), a closing contract (state what you did, what you
  verified and how, and any follow-up), plus SKILLS / COMPUTER USE / MCP
  SERVER TOOLS sections that appear exactly when those surfaces are live.

### Changed

- **`read_skill` joins the tool vocabulary** (24 allowlisted names, was
  23): template and default agents' allowlists gain it via migration
  0023; explicitly-curated agent allowlists are untouched (their authors
  can add it in the agent form).
- The plugin registry grows to **12 built-in plugins** (computer-use,
  skills, MCP added); `GET /plugins` lists them all with the live tool
  catalog and the external `.mjs` file report.
- Test reality: **1491 tests in 102 files** (was 1348/91); agent-core
  alone 786/786 in 48 files. Migration `0023_computer_use.sql`
  (`models.supports_vision` + `skills` + `mcp_servers` tables +
  `read_skill` allowlist append) is applied on upgrade — no existing
  agent's behavior changes until you turn the new switches on.

## [0.60.0] - 2026-09-01

Round 60 — the second owner-feedback round on the design language. The
thirteenth Windows test session confirmed the rounded window PERFECT ("keep
it as a part of our design language") and the pop-out browser satisfying;
its polish list became this release.

### Added

- **The pop-out view is rounded** ("the thing which was not rounded off was
  the actual view"): the page content now sits in a rounded, bordered card
  matching the title bar and URL bar — the same design language, applied to
  the browser view itself.
- **The pop-out gutter scrollbar** ("The scroll bar should be custom themed
  on every single page. It should not show inside the section but on the
  right side outside it"): the pop-out window now paints its OWN scrollbar
  in the frame's right gutter, OUTSIDE the content card — a floating pill
  you can drag, click-to-jump, and drive from the keyboard, tracking every
  page in the window. Pages get a themed minimal scrollbar everywhere
  (injected at document start, before first paint); on strict-CSP sites
  that block the styling, the page keeps its own scrollbar and ours stays
  away — never two bars at once.
- **Real zoom in the embedded browser panel**: the zoom select now performs
  an actual DPI-level page zoom (the same engine zoom as a browser's
  Ctrl+/−) — media queries and responsive layouts re-evaluate, which is
  what display-size testing needs. Previously zoom silently did nothing
  in native mode.
- **The Add-models picker's "Free only ↔ All models" toggle** for
  OpenRouter: pick from the free catalog or the full one (persisted — the
  chat model picker honors the same choice).
- **Rating-note visibility**: a saved "what went wrong" note now shows a
  small "noted" chip on the reply; clicking it reopens the editor with the
  note pre-filled, and re-rating a saved bad reply pre-fills the editor
  too (editing context instead of losing it).

### Changed

- **Models list starts EMPTY** ("By default none of the models should be
  added there"): the Models & Providers list shows only models YOU added
  via "Add models" — no catalog listing, no pre-populated rows. Every
  added model (including free ones) is fully configurable (pricing,
  context window, output limits, thinking, visibility).
- **The API-key field is one consistent row**: the Show/Hide eye button
  sits in the exact same place in every state; Copy appears with a smooth
  fade only when the key is revealed; the "Rotate key" flow is GONE —
  click into the field, paste a new key, Save (Escape cancels back to the
  stored display).
- **The title bar's logo + app name is now the sidebar toggle**: clicking
  it hides the left sidebar entirely (the content takes the full width);
  clicking again brings it back. The sidebar's own logo and its collapse
  button are gone — the sidebar is either fully visible or fully absent,
  and it now stays visible on chat screens too until you hide it.
- **Settings lost their side padding**: the content area fills the width
  (the Models & Providers master-detail edge-to-edge) and the horizontal
  padding is minimized throughout.
- **The browser panel's viewport toolbar** was restructured: a clean
  rounded card with two labeled groups (size: preset/width×height/zoom;
  view: rotate/fit), wrapping gracefully at narrow panel widths, with the
  live size readout. "Fit" is honestly disabled in native mode (sizes are
  already clamped to the panel there) instead of silently doing nothing.

### Fixed

- **The new-tab menu no longer hides behind the browser preview**: opening
  the right-sidebar "+" menu while a browser tab is active now yields the
  page to the menu (the native webview steps aside and comes back when the
  menu closes — the browsing session is never lost).
- **Scrolling no longer shifts the providers list's width**: the scrollbar
  gutter is permanently reserved (stable), so the list (and every
  auto-scrolling panel) keeps its exact width whether or not a scrollbar
  is visible.

## [0.59.0] - 2026-09-01

Round 59 — the owner-feedback round. The twelfth Windows test session
confirmed every 0.58.0 flow working (title bar, pop-out browser, live
file-write preview, key pool, streaming stops); the session's polish list
became this release.

### Added

- **The rounded window** (the owner: "make that top navigation bar rounded
  and give it padding on all four sides"). In the desktop app the window is
  now a soft inset frame: 8px of breathing room on every side, the title
  bar and the content area as separate rounded cards, and window controls
  as inset rounded buttons. Browser mode is unchanged.
- **Minimal floating-pill scrollbars** app-wide ("go with a better scroll
  bar… minimal and good-looking"): a transparent track with a rounded thumb
  that floats inset from the edges, visible in every theme, both axes,
  with a subtle hover state.
- **Custom chrome on the pop-out browser window** ("It should be a custom
  one"): the pop-out is now a frameless window hosting a small dedicated
  app page — our own drag-region title bar with minimize/maximize/close,
  a themed editable URL bar (back/forward/reload, open-in-system-browser),
  and the page content in the same shared-profile embedded webview the
  in-app panel uses. Sizing is monitor-aware (never opens larger than 70%
  of your work area).
- **Response ratings with full context** (the owner: "add the options to
  mark the responses as good or bad… The full context will be properly
  shared"). Every assistant reply carries thumbs up/down; bad ratings
  prompt an optional note; and the rating snapshots the complete evidence
  at the moment you rate it (your message, the reply with token usage,
  every tool event, any error). `node scripts/acute.mjs ratings --full`
  dumps the evidence for analysis so the system prompts can be tuned on
  real failures.
- **The Console tab** (right sidebar) — console-like error monitoring: a
  live, newest-first view of frontend and engine errors with counts,
  expandable details, copy, and clear. Render crashes now show an honest
  recovery card instead of a blank screen.
- **Modular system prompts** (the owner: "built in multiple parts, modules,
  and such… used when necessary"): every section of the agent's system
  prompt is now a registry entry that a project can override with a file —
  `.acute/prompts/<section>.md` replaces that section wholesale, an empty
  file removes it, and `_order.txt` reorders. `node scripts/acute.mjs
  prompt:sections` lists every section and which files would override.
  Without override files the prompt is byte-identical to before.

### Changed

- **Models & Providers — honest provider list**: preset providers you
  have not configured (Anthropic / OpenAI / Google) no longer appear in
  the list at all; the Add-provider picker remains the way to set one up.
- **API key display**: a stored key now shows masked in the key field with
  one clear **Show** button (reveals the real value, with Copy and Hide),
  and a separate **Rotate key** action for entering a new one.
- **Provider disable is immediate**: no more "One agent uses this
  provider" confirmation — the switch disables outright.
- **Opening Models & Providers pre-selects the first provider** and shows
  its details; deleting a provider falls to the next one.



## [0.58.0] - 2026-08-31

Round 58 — the desktop-app-polish round. The owner's eleventh Windows test
session was the first fully-working desktop run in the product's history
(the R57 engine-bundling fix held): the app opened clean, projects created,
tasks ran, files were written. The session's report was a list of UX and
behavioral bugs, every one of which is fixed here.

### Added

- **Frameless window with an integrated title bar** (the owner: "the top
  window kind of thing, I don't want you to show that… I want it to look
  like a full-fledged application"). The native OS title bar (close /
  restore / minimize + app-name strip) is gone — replaced by a slim in-app
  bar: full-width drag region (double-click to maximize), app identity at
  left, minimize / maximize-restore / close controls at right, translucent
  backdrop-blur over the shell's ambient background. In web mode the bar is
  absent and the layout is unchanged.
- **Live file-write preview while the agent writes** (the owner: "while it
  was writing the files it did not show me anything at all. After it had
  written the whole file then it showed me"). The model's streamed tool
  arguments now arrive as live SSE frames (`tool-input-start` /
  `tool-input-delta`); the working section renders a live `writing
  <file> — N chars` box with the partial file content (tolerantly decoded
  from the growing JSON), replaced by the final diff when the write
  completes. Live-verified: the owner's exact 3-file task streams 40+ arg
  deltas during generation.
- **"Continue" after a stop.** The stop button no longer discards the
  in-flight text: the partial reply is flushed to the transcript, and the
  composer offers a Continue button that resumes from where the response
  stopped.
- **A terminal chat harness** (`docs/runbooks/CLI-HARNESS.md`): `scripts/
  acute.mjs` grew `chat:new / chat / chat:stream / chat:stop / chat:events /
  chat:ctx / approvals / approve / deny` — live-streamed agent turns with
  thinking/tool/approval rendering, Ctrl-C-to-stop, and JSONL `--raw` for
  scripting. Long-session testing no longer needs the UI.
- **Visible API keys** (the owner: "It should not be hidden. I should be
  able to… see the API key there, every single one of the API keys"). A new
  authenticated reveal route returns the stored key values; the provider
  page's primary-key field and every key-pool row gained reveal eyes with
  copy buttons. (Deliberately reverses the old R47 no-keys-in-responses
  rule — the owner's own local app, the owner's own keys.)
- **Key-reveal route**: `POST /api/v1/providers/:id/keys/reveal`.

### Fixed

- **Stop no longer reports "Generation failed / body stream buffer was
  aborted."** A deliberate stop renders a quiet "Stopped by user" card (no
  red, no error code), the server returns a `stopped` terminal frame, and
  the client no longer misclassifies its own abort as a network error.
- **The sidebar no longer spins forever after a stop** — the engine resets
  the session to its resting state on abort (previously it stayed
  "running" until the next app restart).
- **"Open the current page in your system browser" works** (was silently
  swallowed by the embedded webview): a Rust-side opener hands the URL to
  the OS default browser; the web build keeps `window.open`.
- **The pop-out browser window is no longer a white box.** The pop-out
  command was a synchronous Tauri command that deadlocked webview creation
  on Windows — it is now async (the same fix pattern the embedded tabs
  already used), and the injected nav overlay rides an initialization
  script that actually survives page loads. The pop-out shares the ONE
  browser profile with the embedded browser (the old tooltip claimed
  "isolated" — it never was).
- **The URL bar no longer resets mid-typing** (navigation polls no longer
  stomp the draft while the field is focused), and the viewport readout is
  honest when a preset is clamped to the panel size ("843×590 (clamped
  from 1920×1080 — panel too small)").
- **The end-of-task session regurgitation is capped.** History replay
  previously re-sent every tool's full output (up to 4 000 chars each) to
  the model on every loop iteration — a long task invited the model to
  echo the whole session as its reply. Only the last 8 tool results keep
  full output now; older ones collapse to stubs, blocks are bounded, and
  the completion-signal list grew the phrasings real models actually use.
- **The thinking block lost its "AI glow"** (the owner: "on the left side
  of it there is a weird AI kind of highlighting"): the accent rails are
  gone from thought rows and the working-section spine — a quiet
  self-contained notes block instead, in the main agent and sub-agents
  alike.
- **The context-window popover waits for intent** — hovering the donut no
  longer snaps open instantly; it opens after ~600 ms of pointer rest
  (focus and click still open immediately).
- **Settings → Models & Providers**: unconfigured preset providers
  (Anthropic / OpenAI / Google without keys) no longer present themselves
  as live rows — they sit in a collapsed "Not configured" group; the
  provider list sizes to its content (with a sensible minimum) instead of
  stretching the full viewport; preset providers hide the base-URL and
  API-format fields ("Preset provider — endpoint and format are fixed";
  custom providers keep them); the disable action is a proper toggle with
  an agent-impact warning; the OpenRouter model catalog no longer leaks
  into custom providers' model lists.
- **Settings → Sub-agents and Advanced are no longer the same page
  twice.** Sub-agents is now the single home for everything sub-agent
  (keys, model, parallelism limits — moved from Advanced, supervision);
  Advanced keeps the engine connection and memory. Deep links unchanged.
- **The chat model picker honors model configuration** — models marked
  hidden in Settings no longer appear (even under "All"), display names
  replace raw ids, and configured models carry a marker.

## [0.57.0] - 2026-08-31

Round 57 — the engine-bundling round. The owner's tenth Windows test
session brought the first HALF of the win: the launcher's app-or-site
question worked, the SITE launched perfectly, and the whole web flow
(dashboard included) ran clean. But the desktop app still could not reach
agent-core — and this time the engine's dying words were finally captured
on stderr: `ERR_MODULE_NOT_FOUND`, on all three startup attempts. That
error named the last packaged-only crash: the installer's bundled
`node_modules` was a pnpm LINK FARM (189 symlinks on the build runner =
189 junctions after extraction) that does not survive
tauri-bundler + NSIS packing — so the installed engine could not import
its very first package and died before its first log line, while the
Linux CI boot check passed happily (Linux preserves links; the owner's
disk does not).

### Fixed

- **The packaged engine now actually bundles** (the owner's words:
  "it needs to be bundled in properly"). The staged sidecar tree is
  installed with pnpm's **hoisted linker** — a classic npm-style
  `node_modules` of REAL directories, zero symlinks, zero junctions —
  so NSIS can pack and extract every byte as plain files. The staged
  tree also shrank from ~302 MB to ~125 MB in the process.
- **A zero-links gate in the staging script**: the build now FAILS if
  any symlink or junction appears anywhere in the tree that will be
  packed into the installer (the 0.56.0 tree carried 189 of them; this
  gate makes that number permanently zero).
- **CI reliability (test-only, same round):** a latent suite flake
  surfaced on the round's own docs commit — a transient-message
  `setTimeout` fired after the test environment tore down and failed
  the whole suite despite every test passing. A new leak-safe
  `useTimeoutClear` hook (cancel-on-unmount, replace-on-reschedule)
  now backs all 11 transient-reset sites; the shipped installer was
  never affected.
- **A Windows pre-pack boot gate in the release build**: before the
  installer is ever built, CI now boots the REAL staged engine with
  the REAL pinned node.exe on a Windows runner — same command line,
  same environment, same `ACUTE_READY` handshake the app waits for —
  and fails the release (printing the engine's stdout/stderr) if it
  does not come up. A dead engine can never be packed into an
  installer again. The R51-era check that "proven the tree bootable"
  ran on Linux only — the exact blind spot that shipped the link farm.

## [0.56.0] - 2026-08-31

Round 56 — the launch-choice round. The owner's report after 0.55.0 was
blunt and actionable: "still not working it failed and I think in the
acute.bat it should ask how to launch the app or the site." Two answers:
the launcher now ASKS (app or site, every run, one keypress), and when the
desktop engine does not come up, the launcher refuses to dead-end — it
shows the engine's own last words and offers retry / site / keep. The
launcher self-update also re-runs itself immediately, so launcher
improvements drive the session they arrive in instead of the next one.

### Added

- **The launch question (the owner's request, verbatim).** Every
  interactive run now asks how you want to use ACUTE-CODE: **[1] the
  desktop app** (the packaged window with the embedded browser) or **[2]
  the site** (local servers + your browser at http://localhost:5173).
  Enter keeps your last choice (first run defaults to the desktop app);
  the answer is remembered in `.acute-launch-pref.json` next to the
  launcher and becomes the next Enter default. Skip the question with a
  command — `ACUTE.bat app` / `ACUTE.bat site` (or `--app` / `--site` /
  `--web` / `--no-desktop`) — and non-interactive runs use the remembered
  choice silently. The plan panel shown at startup reflects the resolved
  mode (or shows both paths honestly while the question is pending).
- **Engine-failure recourse — never a dead console again.** When the
  freshly launched desktop app's engine does not report ready (startup
  failure, timeout, or the app exiting), the launcher now prints the
  engine's log tail AND asks what to do next: **[1] retry the desktop
  app** (close + relaunch, one retry round), **[2] use the SITE instead**
  (closes the app and falls through to the browser flow — the exact
  escape the owner asked for), or **[3] keep the desktop app** (its
  offline screen has Restart-engine + Copy diagnostics). A desktop-engine
  hiccup can no longer leave you with no working app and no choice.
- **`ACUTE.bat status` now reports the launch story:** your remembered
  launch preference, and the engine's last successful boot line from
  `%APPDATA%\acute-code\sidecar.log` (or "no successful boot on record") —
  the two facts that turn a vague "it failed" report into a diagnosable
  one.

### Changed

- **The launcher self-update takes effect THIS session.** The old contract
  was "copied over, runs on the NEXT double-click" — which quietly meant
  every launcher improvement (failure handling, questions, panels)
  arrived exactly one run late, on the run AFTER the one where it
  mattered. The fresh copy is now exec'd in place: the new code drives
  the current session, with the original arguments preserved and a loop
  guard (`ACUTE_LAUNCHER_REEXEC=1`) that makes re-exec failure-safe.
- **The engine watch's timeout is no longer blind.** A cold boot that
  outruns the watch used to print only "did not report ready within 45s"
  with zero diagnostics — the exact silence that hid the EISDIR crash for
  three sessions. The watch now runs 75s (matching the Rust handshake's
  3-attempt worst case more closely) and prints the engine's last output
  lines on timeout, exactly like it already did for explicit startup
  failures.
- The startup line names the version being launched ("ACUTE-CODE 0.56.0
  is running (pid …)") so any report you copy tells us exactly which
  build failed.

## [0.55.0] - 2026-08-31

Round 55 — the engine-boot round. The owner's third desktop session (0.54.0)
finally produced the crash text behind every "Can't reach agent-core" the
packaged app has ever shown: `Error: EISDIR: illegal operation on a
directory, lstat 'C:'` — node.exe dying before the first line of agent-core
code, on every handshake attempt, while the sidecar log also showed "no
provider keys found in Credential Manager" seconds after the launcher had
stored all four keys. Two root causes, both invisible in dev mode, both
fixed at the source.

### Fixed

- **The engine now actually boots in the packaged app (the EISDIR fix).**
  Tauri's `resource_dir()` on Windows returns `\\?\`-prefixed verbatim
  (extended-length) paths, and the shell passed them straight through as the
  node.exe program, the `main.js` script argument, AND the working directory.
  node starts from a verbatim program path but its module resolver
  (`fs.realpathSync` inside `resolveMainPath`) does not support verbatim
  script paths — handed `\\?\C:\…\main.js` it degenerates to `lstat 'C:'`,
  fails with EISDIR, and dies before running a single line of user code.
  Dev mode never saw this because `dev.mjs` passes plain paths. Every path
  that reaches a child process is now stripped of the verbatim prefix first
  (safe: the prefixes exist to exceed MAX_PATH and the install tree is
  nowhere near 260 chars); pinned by unit tests against the exact paths from
  the owner's log.
- **The packaged app now finds the launcher's keys (the Credential Manager
  namespace fix).** The keyring crate derives Windows credential target
  names as `{user}.{service}` — the app was reading and writing
  `api-key.ACUTE-CODE/provider/openrouter` while the launcher's cmdkey
  stores `ACUTE-CODE/provider/openrouter`. Two disjoint namespaces: every
  boot logged "no provider keys found" moments after "stored (length 73)".
  The keyring crate is gone, replaced by direct `CredReadW`/`CredWriteW`
  FFI with exact target-name control: reads and writes now use the
  launcher's canonical `ACUTE-CODE/provider/<id>` targets (byte-identical
  to cmdkey — same type, user, and persistence), the pre-R55 keyring-form
  targets are still read as a legacy fallback so keys saved through older
  app builds keep working, and saving a key in Settings retires the legacy
  entry so there is exactly one namespace from now on. The sidecar spawn
  now injects all four keys (`openrouter`, `openrouter-slot2/3/4`) and
  sidecar.log says so — keys + Restart-engine + a booting engine means the
  whole desktop session works.

### Added

- **The launcher prints what's new after an update.** A version bump used to
  be indistinguishable from "nothing happened": after installing a new
  desktop version, the ACUTE.bat console now shows that version's changelog
  summary ("What's new in 0.55.0 — …") straight from the repo.
- **The post-launch guidance is explicit about how to start the app next
  time** — desktop shortcut or ACUTE.bat (double-click = update + start),
  keys picked up automatically, and what to do if the offline screen ever
  appears.

## [0.54.0] - 2026-08-30

Round 54 — the reliability round. The owner's second desktop session reported
"can't reach agent core" on the packaged app (with Restart-engine not
recovering it), and after deleting the app folder the launcher printed
"installed desktop app 0.53.0 is current" followed by "ACUTE-CODE.exe not
found — using the dev-servers flow" instead of reinstalling. Three root
causes, three fixes, plus a big diagnosability upgrade so the NEXT failure
explains itself.

### Fixed

- **The launcher now trusts the disk, not the registry.** The NSIS uninstall
  entry survives manual deletion of the install folder, so the launcher
  believed "0.53.0 is current" while the exe was gone — and fell back to the
  browser instead of reinstalling. The install is now verified on disk
  (the app exe, the pinned `node.exe`, and the sidecar entry) before the
  "is current" decision; a broken install is repaired by reinstalling, and
  the console says exactly what was missing.
- **The packaged app's engine failures are no longer half-blind.** agent-core
  prints its real startup failure to stderr — but a GUI app has no stderr
  handle, so the old `Stdio::inherit()` sent it nowhere: the app could only
  ever say "stdout closed before the ready line". stderr is piped now and
  drained into `sidecar.log` (`sidecar:stderr] …`), and the failed-startup
  error string carries the engine's recent output.
- **A failed handshake no longer orphans its node.exe.** The old code dropped
  the child on a ready-line/health failure — on Windows the process kept
  running, holding the SQLite database while every Restart-engine attempt
  raced a zombie. Failed attempts now kill the whole child tree.
- **Running instances are closed before install and launch.** Upgrading over
  a live app can leave a hybrid install (locked files), and launching over
  one opens a second window. The launcher now closes exactly the processes
  whose executables live in the install dir (the app + its bundled node —
  never anyone else's node).

### Changed

- **The engine handshake retries (3 attempts, 25s ready budget each) before
  declaring failure.** A cold first boot — Windows Defender scanning a
  freshly installed 200+ MB tree, the first SQLite migration — is exactly the
  launch most likely to outrun a single deadline. The UI's connect deadline
  follows (90s → 150s) so the webview never gives up before the shell's own
  retry loop has had its say.

### Added

- **The offline screen shows the engine log in-app.** Instead of "check
  sidecar.log in %APPDATA%", the screen now renders the last 60 log lines in
  a scrollable box (new `sidecar_log_tail` shell command) with a **Copy
  diagnostics** button that puts the error + log on the clipboard — a
  failure now explains itself on screen.
- **The launcher window watches the engine start.** After launching the
  desktop app, ACUTE.bat polls `sidecar.log` for the "listening on
  127.0.0.1:…" line and prints "agent-core is up — port N" — or the log tail
  when the engine fails — so the console that launched the app tells the
  same story the app window does.
- **Browser-mode folder picking is bounded and honest.** The Add-project
  dialog's Browse button now shows "Opening the system folder dialog…"
  feedback, the dialog fetch is limited to 2 minutes (a hung PowerShell
  dialog used to spin the button forever), and every failure message says
  outright that pasting the folder path always works.

## [0.53.0] - 2026-08-30

Round 53 — the connection round. First run of the packaged desktop app
reported "Could not reach agent-core at http://127.0.0.1:55963 (TypeError:
Failed to fetch)", "Agent core unreachable" in Settings, and keys that looked
missing. All three shared one root cause — fixed at every layer, plus the
diagnostics and recovery the app needed to be self-healing.

### Fixed

- **The stale-port bug (the "55963" error).** The sidecar binds an ephemeral
  port on every launch, and the UI persisted that port (`baseUrl`) plus
  `demoData: false` to localStorage — so the NEXT launch rehydrated a
  previous session's dead endpoint and every request died with "Failed to
  fetch". Inside the desktop app NOTHING is persisted anymore: every boot
  starts from safe defaults and adopts the live endpoint in memory
  (pre-R53 localStorage blobs are retired on read; browser dev keeps its
  stable-port persistence).
- **The handshake race (why the port went stale in the first place).** The
  shell used to answer the UI's `sidecar_info` call exactly once — while its
  own sidecar handshake (up to 25s of blocking startup inside `setup`) was
  still running. Losing that race left the app pointed at the dead port for
  the whole session. The handshake now runs on a background thread (the
  window paints immediately) and the UI POLLS until the engine is actually
  up.
- **The invisible startup failure.** If the sidecar failed to start in the
  packaged app, the only error went to a console that doesn't exist in a GUI
  process. Every lifecycle line (spawn command, ready, health, injected
  provider keys, failures, exits) is now appended to
  `%APPDATA%\acute-code\sidecar.log`, and the failure reason surfaces IN THE
  APP.

### Added

- **Connection splash + offline screen.** The app gates its whole tree on
  the engine: a branded "Connecting to agent-core…" splash while the engine
  boots (no screen can fire requests at a dead endpoint anymore), and — if
  the engine fails — a clear screen with the REAL error, a one-click
  **Restart engine** button (the shell tears down and re-runs the full
  lifecycle; no app restart), and the sidecar.log pointer.
- **Mid-session watchdog.** The shell watches the engine process; if it dies
  while you work, the app notices within ~20s, shows the exit reason, and
  the same Restart engine button recovers it (all data is safe on disk —
  reconnecting re-fetches everything).
- **Live diagnostics for support.** `sidecar_status` (the lifecycle phase +
  error) and `restart_sidecar` are new shell commands; sidecar.log rotates
  at 1 MB; provider keys injected at spawn are logged by id + length only
  (never values).

## [0.52.0] - 2026-08-30

Round 52 — command supervision, sub-agent control, the real Usage screen,
and the plugin-based tool system. The headline fix: a background command
(`start /B node server.js > server.log 2>&1`) can never stall an agent turn
again — and the agent always knows how to check on what it started.

### Added

- **Background jobs — commands that outlive their tool call are now
  first-class citizens.** When `run_command` launches something detached
  (Windows `start /B … > log 2>&1`, Unix `… > log 2>&1 &`, `nohup`), the
  call returns IMMEDIATELY with a job id, the captured output, and exact
  polling instructions — never a silent "running…" for ten minutes. A hard
  watchdog kills any command whose shell never exits within the timeout
  (60s default) and reports the partial output. Two new tools, `job_status`
  (list/inspect, with the live output tail and the log-file tail) and
  `job_stop`, let the agent — and the main agent supervising sub-agents —
  poll and stop what it started; the prompt now teaches verify-after-start
  and poll-don't-wait as discipline. The Terminal panel gained a
  "Background jobs" section: live status, output tails on click, and a
  Stop button per running job.
- **Live terminal output in the chat.** Running commands stream their
  stdout/stderr into the working section while they execute (a compact
  live tail under the command pill, stick-to-bottom), in the sub-agent
  panel, and in the expanded command detail — the "terminal interface"
  of every command, not just its final result.
- **Sub-agents are stoppable and watchable.** The Stop control now works
  on sub-agents exactly like the main agent — a Stop button on the
  sub-agent panel header (and the API route behind it) aborts just that
  child; the parent gets an honest "sub-agent was STOPPED BY THE OWNER"
  report instead of a silent hang. While a child runs, the supervisor
  samples it every 15s and the panel shows a live watch line (last
  activity, elapsed, tool count, todo progress); a child with no activity
  for 5 minutes (configurable) is auto-stopped and reported as stalled,
  and the main agent is taught to act on those reports. The heartbeat
  cadence and the stall timeout are configurable in Settings →
  Sub-agents.
- **The real Usage screen.** The in-app Usage page (previously a
  placeholder) is now a full analytics view over the local ledger:
  overview stat cards, a token activity chart with a 7/14/30/90-day range
  selector, a tool leaderboard with failure counts, model cards with
  token/cost splits, and a projects → sessions drill-down with sub-agent
  runs nested under their parents and click-through to each chat.
- **A plugin-based tool system (DeepSeek-harness style, pragmatic).**
  Every built-in tool group (filesystem, search, git, terminal+jobs, web,
  browser, memory, todo, delegation) is now a self-contained plugin module
  behind a registry — the tool catalog is COMPUTED from the real plugin
  declarations, so the UI's tool list can never drift from the backend
  again. External plugins load from disk: drop a `.mjs` file into
  `~/.acute/plugins/` (on by default) or the project's
  `.acute/plugins/` (opt-in via settings) to add your own tools with the
  standard name/grammar/collision rules, fail-soft loading, and caps.
  See ADR-0025 for the decision record and MAINTENANCE.md for the
  add-a-tool recipe.

### Fixed

- **The ten-minute command hang (owner-reported).** Node's `close` event
  only fires when the stdio pipes close — a detached grandchild inherits
  those pipe handles and holds them for its whole lifetime, so the tool
  promise never resolved and nothing ever checked status. `exit` and
  `close` are now tracked separately; a pipe-holding grandchild becomes a
  tracked background job, a never-exiting shell is tree-killed by the
  watchdog, and a Unix `&` launch registers a detached job whose liveness
  is probed via its process group (found live in the round's battery: the
  fully-redirected Unix case closed its pipes instantly and used to
  vanish from tracking entirely).
- **The model-selector flyout no longer snaps shut on the way to it.**
  Crossing the gap between a provider row and its models flyout used to
  fire the row's mouse-leave instantly and close the menu before the
  pointer arrived; the flyout now has the same ~220ms hover-bridge the
  context donut got in R51 (leave schedules a close, entering the flyout
  cancels it).
- **The dev webapp at `http://[::1]:5173` now works.** The IPv6 loopback
  literal origin was missing from the sidecar's CORS allowlist, so every
  preflight died 401 and the app silently fell back to demo data.

### Changed

- The system prompt's terminal section now bakes in the
  background-process discipline (launch detached, verify with
  `job_status`, poll between steps, stop when done), and the supervision
  section teaches the main agent to act deliberately when a child stalls
  or is stopped by the owner.

## [0.51.0] - 2026-08-30

Round 51 — the desktop shell finally ships to the owner, plus the
fourth-test-round polish pass across the composer, the sub-agent panel,
the main agent's efficiency, and the dashboard.

### Added

- **The Windows desktop app, installable in one click.** The launcher now
  downloads the release installer and sets up the real desktop app
  silently (no admin required): the full Tauri shell with the native
  Chromium browser, the bundled agent backend (a pinned Node 24 runtime +
  the sidecar, no local Node needed), and the owner's OpenRouter keys
  seeded straight into Windows Credential Manager. Everything the browser
  rounds were building toward — the embedded browser finally activates on
  the owner's machine, and the browser panel shows which engine is live
  ("Chromium (native)" / "Proxy fallback") with an automatic fallback to
  the proxy renderer if the native engine ever fails. If anything in the
  desktop flow fails, the launcher falls back to the previous
  dev-servers-in-your-browser flow untouched. The app window can no
  longer be shrunk below a usable size (min 1000×620), and the composer's
  toolbar wraps instead of ever overlapping its controls.
- **A fast smoke suite: `pnpm smoke`.** One command runs a curated set of
  the critical-path tests (320 tests, ~17 seconds) and reports a green/red
  verdict — the quick "did I break the spine?" check between full gates.
- **The Usage page on the public dashboard** (with `pnpm usage:export` in
  the app): per-project and per-session usage statistics — tokens, cost,
  duration, model, status, every tool call broken out, sub-agent runs
  nested under their delegating session — rendered as a clean, modern
  page with overview cards, an activity chart, tool leaderboards, and
  expandable drill-downs.
- **A loop-hygiene guard in the agent runtime.** A model that re-calls
  the same tool with the same arguments now gets a corrective nudge after
  3 repeats, and an honest, retryable stop after 5 identical calls (or 6
  consecutive failures) — no more burning turns in circles.
- **Main-agent / sub-agent / combined session stats** in the context
  popover: the session's own usage, the summed usage of its sub-agents,
  and the combined total, each with requests, tokens, and cost.

### Changed

- **The main agent is now explicitly taught to work efficiently.** The
  system prompt gained an EFFICIENCY section — understand first with one
  batch of parallel reads, plan once, execute directly, verify only when
  risk exists — and lost the old mandatory re-read-after-every-write
  rule and the "use your 80-round-trip budget" step-incentive.
- **The composer's controls, per the owner's spec:** Add Context is now
  just the paperclip icon; the model button shows only the model name
  (provider on the tooltip); the provider→model flyout measures the
  viewport and can no longer be cut off at the bottom or right; the
  context donut dropped its inline percentage (details on hover) and its
  popover now stays open while you move the pointer into it, with
  amber/red warning colors as the window fills.
- **The sub-agent panel, de-sloped:** the final report no longer carries
  the accent left rail (it reads like every other message, with a quiet
  label); the todo card shows the FULL checklist with per-item status
  instead of just a progress bar; the stats footer is centered and
  visually refined.
- **Delegations and file edits stand out in the transcript:** collapsed
  tool rows for `delegate_task` and file edits now carry a tinted icon
  chip so agent calls and file changes are visible at a glance, without
  expanding anything.

## [0.50.0] - 2026-08-30

Round 50 — the owner's third test round: a real embedded browser, live
sub-agent streaming, and the fully-specified chat composer.

### Added

- **A native embedded browser.** The browser tab now renders through real
  Chromium: every tab is a WebView2 child webview hosted inside the app
  window, positioned exactly over the panel's page area — no proxy, no
  tickets, no URL rewriting, so every site loads with its real CSS/JS.
  Tabs share one persistent browser profile (logins survive app restarts
  and are isolated from the system browser); the address bar, history
  buttons, and viewport presets drive the webview while the agent's
  `browser_control` tool stays in sync with what you actually see. The
  fetch-proxy iframe remains as the fallback outside the desktop shell.
- **Sub-agents stream their raw thinking and text live.** A delegated
  sub-agent's panel now shows the actual tokens — thinking and text — as
  they are generated, exactly like the main chat, plus its tool calls as
  they happen.
- **A stats bar at the bottom of the sub-agent live view:** total time,
  tokens sent, tokens received, tokens per second, and the model in use —
  live while it works, authoritative values after it finishes.
- **Five attempts on rate limits.** Provider calls previously gave up
  after three attempts (the SDK default); they now retry five times with
  exponential backoff.
- **A redesigned chat composer** (the controls live inside the message
  box): **Add Context** — attach files via the Windows file picker, pick
  project files from a searchable list, `@`-mention files, or drag and
  drop; **permission modes** — Full Access / Ask (default) / Plan
  (read-only research) / Editor (file edits without a terminal);
  **thinking level** — Default / Low / High / Max; **a model picker** that
  opens your providers and shows each one's models on hover with a
  Manage-Models shortcut to the settings; and **a context donut** — a ring
  of the current context usage that opens a detailed breakdown (messages,
  system prompt, system tools, memory, meta), the cache hit rate, and the
  session's token and cost totals. An empty chat centers the composer in
  the lower half of the screen.
- **The Models & Providers page reworked:** the provider list and the
  detail pane scroll independently; models are added from a searchable
  catalog picker with multi-select (free/paid badges, pricing
  pre-filled); every model's advanced configuration is editable — input,
  output, and cached-input prices per million tokens, context window, max
  output tokens, thinking support, and picker visibility.

### Fixed

- Clearing a model's price never persisted (an explicit empty field was
  silently treated as "keep the old value"), and re-adding an existing
  model reset its "supports thinking" flag. Both are now field-precise.
- The context meter now reads the model's real context window from its
  configuration (previously a fixed 200k assumption for unknown models).

### Changed

- Plan mode restricts the agent to read-only tools; Editor mode removes
  the terminal; Full Access auto-approves permission asks (hard-blocked
  commands like `sudo`/`rm -rf` are still refused in every mode).
- Sub-agent sessions inherit the parent's permission mode.

## [0.49.0] - 2026-08-29

Round 49 — the file-tools repair round: every entry below fixes something
found while actually using the app on Windows (the owner's second test
session).

### Fixed

- **Agents have their file tools back.** On every install created before
  the orchestration rounds, the default "Acute" agent silently lost its
  entire project tool set (list_dir, read_file, write_file, edit_file,
  create_dir, delete_file, search, git, run_command, …) — two older
  migrations appended new tools to the agent's "all tools" allowlist and,
  in doing so, turned it into an explicit allowlist of exactly those five
  appended tools. Both the main agent and every sub-agent (children run
  the same agent row) then honestly reported "I have no write_file or
  list_dir". Migration 0019 repairs the damaged allowlist back to "all
  tools" — fingerprint-scoped so deliberate restrictions are never
  touched.
- **The embedded browser renders full pages.** Pages loaded but appeared
  as blank, unstyled HTML — every rewritten stylesheet/script/image URL
  was path-relative, and the document's injected `<base href>` (pointing
  at the upstream site) made the browser request them FROM THE UPSTREAM
  SITE, which 404'd them. Rewrites are now absolute URLs pointing at the
  sidecar proxy. Failed sub-resource fetches (404/500 CSS or JS) return an
  empty body instead of an HTML error page, so the console stays clean.
- **Saving from the browser works again.** The backend's cross-origin
  allow-list was missing the PUT method — every PUT-shaped save from the
  UI (settings toggles, API-key pool slots) failed silently at the
  browser's preflight check. Found while live-verifying the new memory
  switch.
- **A model that "announces" a tool call without making one gets one
  correction.** Free models sometimes answer a work request by writing the
  tool call as a code block in plain text; the turn used to end right
  there with nothing done. The agent now receives one in-turn nudge
  ("actually call the tool") when — and only when — the reply evidences
  tool intent; conversational replies still end immediately, and the
  nudge never appears in the chat log.

### Added

- **Nested sub-agents.** A sub-agent can itself delegate to further
  sub-agents (same tools, same workings, its own context and API key —
  the only differences), up to a fixed depth of 3 levels; beyond the cap
  the delegation tool is withheld so the fan-out stays bounded.
- **The memory master switch** (Settings → Advanced). Turn the whole
  agent-memory system off: no memory digest is injected into any system
  prompt, the memory tools are not offered, and the Memory panel says so.
  Saved memories are kept and restored when re-enabled.
- **Sub-agents run on their own context alone.** The project memory digest
  is no longer injected into sub-agent turns at all (main sessions keep it
  while the switch is on) — stale memories can no longer teach a
  sub-agent wrong facts about its own tool set.

### Changed

- **The app mark is now a cat.** The logo, favicon and Windows icon are a
  white cat-face silhouette (pointed ears, almond eyes, tiny nose) on the
  orange gradient tile.
- **The standalone Sessions screen is gone** — route, component and all.
  Sessions live on inside each project's chat, where they always actually
  belonged.

## [0.48.0] - 2026-08-29

Round 48 — the owner-test round: every entry below fixes something found while
actually using the app on Windows.

### Added

- Sub-agents can now ask for permission. A sub-agent that hits a
  needs-approval action (a non-read-only command, a web fetch or browser
  navigation outside the trusted-host list) pauses and asks you, exactly like
  the main agent: the approval card appears in the parent chat labelled with
  the sub-agent's code and role, and Allow / Always allow / Deny releases it.
  Channel-less runs (background retries) still fail fast instead of hanging.
- Sub-agents now work live in the UI. The Delegated card in the chat shows
  each running sub-agent with its code, role, progress and latest activity,
  and clicking it opens that sub-agent in the right sidebar — no more
  "Running… Running…" with nothing to click.
- The right-sidebar sub-agent view is now a real chat transcript — the task,
  the assistant's replies, every tool call with its result, todo progress and
  approval events, styled like the main chat — with a per-second clock.
- Every sub-agent now carries a short code (like `K7F2`), shown in the chat
  cards, the tab picker and the sub-agent tab title, so you can tell two
  running agents apart at a glance.
- Stopping the parent turn now also stops its sub-agents (pending approvals
  deny fail-closed; children stop cleanly between tool iterations).
- The Files action in the right sidebar now opens a real file explorer:
  the project tree on the left (folders expand, files open on click) and the
  file's contents on the right, with a Search button that still opens the
  file/command search palette.
- Projects now get distinct colors. New projects draw from an 8-color palette
  (least-used first) and existing projects are re-colored on first launch
  after this update, so the sidebar no longer shows a wall of identical
  orange. The active project highlights in its own color.
- A favicon (the new logo mark) for the browser dev setup.

### Changed

- The Sessions entry is gone from the left sidebar. Sessions live where they
  are used — under their projects — and the sessions screen remains reachable
  by its direct link only.
- New, sharper app logo: a solid "A_" prompt mark replacing the two-stroke A.
- Collapsed sidebar rail: the selected project now shows a clean inset ring
  instead of an oversized clipped outline, and the rail scrolls.

### Fixed

- The embedded browser no longer flashes and reload-loop every second, and
  no longer dies with "Browser proxy ticket missing, expired or invalid"
  after navigating or changing the viewport. Root cause: every navigate and
  viewport change silently rotated the browser-proxy ticket the panel was
  still using; tickets now stay valid (a fresh one is only minted by the
  explicit session re-mint), plus a bounded recovery loop as a safety net.
- The Browse button in the new-project dialog now opens the modern Windows
  folder picker (the File-Explorer-style one), and it appears ON TOP of your
  windows instead of hiding behind them — both in the browser/launcher setup
  and in the desktop app. The old-style tree dialog remains only as a
  fallback if the modern one cannot load.
- Sub-agents actually run their tools now: the approval gate previously
  failed every ask-tier action silently, which made browser control and most
  commands impossible for them and made delegation look stuck.
- Memory entries in the right sidebar dropped the colored left-bar accent in
  favor of clean uniform cards.

## [0.47.0] - 2026-08-29

### Added

- Provider management, cleaned up: the "Models & Providers" settings tab now
  runs on one shared API layer, its connection test can target the primary
  key or any key-pool slot and optionally a concrete model (a real one-token
  probe with measured latency instead of a bare reachability ping), and
  pasting a key in the browser-dev setup honestly warns that it lives in
  server memory only until restart.
- Model catalog from the server: the sub-agent model picker and the agent
  form now read the live model catalog (pricing, context window, tool and
  vision support) from the backend instead of each carrying their own
  hand-maintained copy, so newly shipped models appear everywhere at once.
  The agent form's provider dropdown also lists custom providers you added
  in Settings, and model fields suggest known ids while still accepting
  free text.
- Disabling a provider now actually stops it: turns against a disabled
  provider fail fast with a clear "enable it in Settings" message instead
  of quietly proceeding.

### Fixed

- Security: the launcher template and launcher no longer ship any real API
  keys (the round-44 baked-in sub-agent defaults were removed) — every
  credential value now comes from you and only you, and the launcher never
  writes key values into your credentials file.
- Security: an API route that returned a provider key in plain text (unused
  by the app) was removed.
- The launcher could never actually read the optional sub-agent pool keys
  from credentials.txt (names containing digits were skipped by the
  credentials parser), so your own pool-key values were silently ignored.
- Adding a key-pool slot in Settings could silently overwrite an existing
  slot's key when earlier slots had gaps (e.g. slots 2 and 4 occupied → the
  next add targeted 4 again); the next free slot is now computed correctly.

## [0.46.0] - 2026-08-28

### Added

- Context compaction: when a long session would overflow the model's context
  window, the over-budget history is now summarized by the model itself into a
  dense briefing (task, decisions, files touched, errors fixed, open steps)
  instead of being silently dropped. The summary persists as part of the
  session (fork and revert keep working), it is reused until the window
  overflows again, and a summarizer failure safely falls back to the old
  trim behavior.
- Relevance-ranked agent memory: `memory_recall` now scores results by
  multi-token relevance (content match strength, kind, importance and
  recency) instead of plain substring matching, the auto-injected memory
  digest ranks durable decisions above casual notes, and saving the same
  fact twice refreshes the existing memory instead of duplicating it.
- File restore from checkpoints: the diff view for agent file edits gained a
  "Restore" action (with confirmation) that reverts the file on disk to its
  pre-edit content — the round-25 checkpoint backend is finally reachable
  from the UI. The diff view also no longer misses the recorded snapshot
  while session events are still loading.
- Browser cookie persistence: the embedded in-app browser now keeps cookies
  in the project database, so logged-in sessions survive a restart. Cookies
  never appear in logs or agent-visible output.

### Fixed

- The first file-diff card in a session could permanently show "no snapshot
  recorded" because it rendered before the checkpoint list finished loading.

### Changed

- Terminal session behavior is now covered by black-box end-to-end tests
  (create → input → streamed output → exit → cleanup), in addition to the
  existing unit suite.

## [0.45.0] - 2026-08-28

### Added

- Persistent interactive terminal sessions per project: a real PTY shell when
  `node-pty` is available, a pure-Node fallback otherwise, exposed as a
  "Shell" mode in the Terminal panel that keeps its state between commands
  (idle shells are reaped, and each project gets a session cap).
- Packaging v1: version numbers are now single-sourced across the root
  package, agent-core, shared and the Tauri config (`pnpm version:set`
  writes all four, `pnpm version:check` gates CI), this changelog exists, and
  a release workflow assembles a downloadable launcher kit (CRLF-safe
  `ACUTE.bat` + launcher scripts + credentials template + changelog) with a
  draft GitHub release for every `v*` tag.
- A drift-guard test keeps the agent-form tool catalog in lockstep with the
  backend tool list — the silent "15 checkboxes vs 21 tools" gap found in
  round 44 cannot happen again.

### Security

- Provider API keys are no longer passed to child processes spawned by agent
  tools; children get an allowlisted environment only.
- The automatic read-only command tier is now contained to the project
  folder: absolute paths outside the project, `~`-relative paths and `..`
  escapes demote the command to interactive approval.
- Web tools now go through the approval engine: `web_fetch` and browser
  navigation are host-gated against an editable allowlist (with
  "always allow" per host), and web-search queries are scrubbed of secrets
  before leaving the machine.

### Fixed

- The Sessions screen search is usable on phones: a full-width search row
  under the header and a vertical results list while searching (was a cramped
  170px input plus horizontal scrolling through filtered results).

## [0.44.0] - 2026-08-27

### Added

- Persistent agent memory: agents save facts, decisions and preferences per
  project and get them injected into every later turn; a Memory panel in the
  right sidebar shows and prunes what was learned.
- Real web search: `web_search` queries the general web (DuckDuckGo) with an
  honest fallback chain, instead of returning encyclopedia-only results.
- Session intelligence: search across titles and message text, fork (copy a
  whole conversation under a new session) and revert-to-message (rewind the
  chat to any earlier user message).
- Streaming terminal: live command output with exit codes and a Stop button.
- Sub-agent API keys are auto-provisioned from `credentials.txt` — the
  sub-agent key pool fills itself, no manual entry in Settings.

### Fixed

- Sessions no longer stay "running" forever after a finished turn; revert and
  stop behave correctly on finished conversations.
- Recent-activity cards open the actual conversation instead of an
  unreachable screen; the Sub-agents settings tab is reachable from the
  sidebar navigation.
- The agent form's tool checkboxes were missing delegation, browser control
  and the memory tools (a stale frontend catalog).

## [0.43.0] - 2026-08-26

### Added

- Embedded browser panel plus a `browser_control` agent tool (navigate,
  history, viewport presets) so the agent can drive the user's browser panel.
- Free-model catalog: curated free OpenRouter models with an automatic
  fallback chain when a model is unavailable.
- Turn error cards in the chat with one-click retry.
- Sub-agent provider settings (per-sub-agent model overrides).

### Changed

- Chat geometry: messages use the intended reading width and center correctly
  at every window size.

### Fixed

- `delegate_task` was missing from every existing database's tool allowlist —
  delegation was silently unreachable for all seeded agents; a migration
  repairs old databases.
- CI repaired and green again.

## [0.42.0] - 2026-08-26

### Added

- Desktop notifications that fire even with the window closed (Web Push +
  service worker); turns complete in the background after you disconnect, and
  an explicit Stop button ends them.
- The launcher opens the browser automatically once the app is up; the
  embedded browser panel works in launcher/web mode, not just the desktop
  shell.

### Fixed

- The notification menu no longer cuts off at the screen edge; the chat keeps
  a minimum width while the right sidebar shrinks smoothly; sessions
  auto-name after the first reply and survive sidecar restarts.

## [0.41.0] - 2026-08-26

### Added

- Per-session sidebar state: expanded folders and the selected file/agent
  snap back per session instead of leaking across sessions.
- Desktop notifications while the app window is open, and automatic session
  naming from the first message.
- Embedded browser panel in the Tauri desktop app.

### Fixed

- Command-palette auto-open glitch on session/project switch; the
  notification menu is positioned fully on-screen at every window size.

## [0.40.0] - 2026-08-26

### Fixed

- Sub-agents had every tool silently stripped by an empty-allowlist sentinel —
  delegated children could not actually work; the system prompt no longer
  misreports the tools a child can reach.

### Added

- Notification center (bell menu) surfacing task events; click-to-open for
  files referenced in chat; chat width and sidebar dropdown bounds tuned.

## [0.39.0] - 2026-08-25

### Added

- Browser-style tabs in the right sidebar (Files, Browser, Terminal,
  Sub-agents) — each tab keeps its own state and new ones open from a menu.
- Background sessions: streams keep running while you navigate elsewhere, with
  a live running animation in the sidebar.
- Sub-agent multi-turn conversations.

### Fixed

- Short conversations sit against the composer instead of floating in the
  middle of a large empty pane.

## [0.38.0] - 2026-08-25

### Added

- Right sidebar with Files, Terminal, Browser and Sub-agents panels — the
  previously empty right side of the chat is now usable.

### Changed

- User messages restyled (soft accent-tinted bubble) and smooth
  collapse/expand animations for the working section and thoughts.

### Fixed

- Sessions no longer mix state across projects; sessions auto-title after the
  first reply; a newline-encoding bug garbled sub-agent prompts.

## [0.37.0] and earlier - 2026-08-25

Rounds 1–37 built the foundation: the spec and architecture skeleton, the
first live agent conversation, the setup wizard, the one-double-click Windows
launcher, the agentic MVP (projects, sandboxed tools, live-proven file
writes), the demo-parity chat UI with streaming replies and per-reply
telemetry, project indexing and code search, multi-turn agentic continuation,
sub-agent orchestration, the approval engine and structured logging. The full
history lives in `docs/agent/ORCHESTRATION-WORKLOG.md`; round reports in
`docs/ui-iterations/`.
