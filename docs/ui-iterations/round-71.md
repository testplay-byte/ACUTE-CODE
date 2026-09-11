<!-- last-reviewed: 2026-09-11 round-90 -->
# Round 71 — the discipline & reliability round: the prompt now teaches engineering discipline, the tools now escalate instead of letting the model flail, and the twelve skills carry the trigger surface

**Date:** 2026-09-07 · **Branch:** `main` · **Version:** 0.71.0 ·
**Provenance:** no new owner field report — R71 answers the owner's
post-restore directive ("make the project smarter better much more capable
and reliable", modular mindset, careful planning/testing) using the FOUR
reference repos he supplied. Three research passes opened it: **R71-b1**
(multica-ai/andrej-karpathy-skills — the 4-principle CLAUDE.md compression
masterclass; alirezarezvani/claude-skills — 388 skills of the
anti-hallucination/process school: zero-hallucination, focused-fix,
self-eval, ship-gate), **R71-b2** (cline — failure escalation, provider
error classification, overflow recovery, "rejections are not failures"),
**R71-b3** (kilocode — truncation markers that carry the exact next call,
sub-agent discipline strings). The **R71-c audit** scored the gap
checklist 4 EXISTS / 12 PARTIAL / 13 MISSING and located nearly every gap
in the MODEL-FACING layer (prompt strings, skill trigger surface, failure
feedback) — the runtime itself was already ahead. R71-d turned that into
three disjoint workstreams: **e1** (prompt discipline), **e2** (tool
reliability), **e3** (the skills round). No new screens, no new REST
routes, zero frontend files — this round lives in the space between a
failure and the model's next decision.

| ID | Workstream | Files owned |
|---|---|---|
| e1 | Prompt discipline: the ENGINEERING DISCIPLINE registry section (4 karpathy principles with binary self-tests, [KNOWN]/[ASSUMED]/[UNKNOWN] tagging, 3-strike escalation, the red-flags table), task→verifiable-goal transforms in PLAN, verification receipts + 🟢🟡🔴 confidence tags + devil's advocate + anti-question-padding in COMMUNICATION, sub-agent scope/no-polling discipline | `agent-core/src/agents/prompts.ts`, `agent-core/src/agents/prompt-registry.ts`, the golden fixture |
| e2 | Tool reliability: read_file/run_command markers that teach the exact next call, edit_file consecutive-failure escalation, owner-denial ≠ tool-failure semantics, six-class provider error classification, context-overflow recovery (forced compaction + one retry, visible) | `agent-core/src/tools/fs-ops.ts`, `agent-core/src/tools/exec.ts`, NEW `agent-core/src/tools/edit-streak.ts`, `agent-core/src/tools/plugins/{filesystem,computer-use}.ts`, `agent-core/src/agents/{runtime,compaction}.ts`, `agent-core/src/approvals.ts` |
| e3 | The skills round: all 8 builtin descriptions rewritten trigger-rich ("Use when [phrasings]. NOT for [adjacent case]"), 4 new discipline builtins — focused-fix, zero-hallucination, self-eval, ship-gate (12 total) | `agent-core/src/storage/skills.ts` |
| verify | Full CI-mirror verification + the three sibling suites' convergence (this round's counts below) | — |
| docs | The docs round (this file + the runbooks + CHANGELOG + HANDOFF + IMPLEMENTED-API + TESTING + EXTENSIBILITY + indexes + status.json) + the version bump ×4 | `docs/**`, `CHANGELOG.md`, `HANDOFF.md`, the four version files |

## Why this round (the audit's one-line verdict)

R70 built the agent's *brain*; R71-c then asked the four reference
repos' question — *what does the model do when it is about to fail?* —
and found the answer was "nothing, in five different ways": a stale
edit anchor got the identical one-liner on every retry (no signal, no
escalation before the loop guard killed the turn); a truncation marker
said "use offset/limit" but not *which* offset; a provider error —
rate limit, dead key, genuine context overflow — flattened to the same
generic 502 while only one of those is fixable by compaction; the
user's *denial* of an approval looked like a tool malfunction; and the
prompt taught *what* to do but not the failure discipline the
karpathy/alirez schools build on. All string-and-feedback level, all
high-leverage — the audit scored 12 PARTIAL / 13 MISSING against
4 EXISTS, and this round closes the reliability half (A1/A2/A4/A6/A7),
the discipline half (B1–B9), and the skill trigger surface (C1/C2).

## A — the ENGINEERING DISCIPLINE prompt section (e1, D1)

**Root cause:** the system prompt's discipline teaching was one line
("if a tool call fails: read the error, fix the root cause, retry") plus
R70's verify-after-edit rule. Nothing taught the model to *check itself*
before acting — the failure modes the owner's field reports keep hitting
(silent interpretation picks, hallucinated API behavior, speculative
bloat, drive-by edits) all live in that gap. karpathy's CLAUDE.md is the
proof-by-existence that this fits in ~2.3K chars: mantra, bullets, and a
**binary self-test** the model runs on its own diff.

**Fix (`prompt-registry.ts:96-101` + `prompts.ts:339-363`):** a new
`engineering-discipline` registry id (static, `identity` bucket)
composed unconditionally right after `agentic-loop`, before
`file-editing`. The section (2,312 chars, inside its designed 1.8–2.6K
window):

1. **Four principles, each with a self-test** (the karpathy structure):
   *Don't assume. Don't hide confusion. Surface tradeoffs.* (multiple
   interpretations get presented, never picked silently) · *Minimum code
   that solves the problem. Nothing speculative.* ("if you wrote 200
   lines and 50 would do, rewrite"; self-test: would a senior engineer
   call this overcomplicated?) · *Touch only what you must. Clean up only
   your own mess.* (every changed line traces to the request; the
   **asymmetric orphan rule** — remove imports YOUR change orphaned,
   never pre-existing dead code) · *Define success criteria. Loop until
   verified.* (restate "done" in checkable terms; "if done is not
   checkable, you are not ready to implement").
2. **[KNOWN]/[ASSUMED]/[UNKNOWN] tagging** (the alirez
   zero-hallucination core): facts read this session are [KNOWN],
   inferences are [ASSUMED] (state them when load-bearing), an unread
   library/API/symbol is [UNKNOWN] — and **"NEVER write code that depends
   on an [UNKNOWN]"** (read the source first). Self-test: an untagged
   dependency IS an [UNKNOWN].
3. **THREE-STRIKE ESCALATION** (prompts.ts:357): three failed attempts at
   the same problem = STOP; no 4th fix of the same shape; re-read the
   evidence; consider that the problem is elsewhere (architecture, wrong
   file, wrong assumption); escalate to the user with what was tried.
   The existing "fix the root cause, retry" line stays — it gains the
   escalation gate instead of replacing it.
4. **The red-flags table** (prompts.ts:358-363, five lines): the model's
   own rationalizations quoted back at it — *"It's probably fine to skip
   verification"* → run the check; *"I'll fix that later"* → fix it now
   or todo it; *"The user surely means X"* → ask or state the
   interpretation; *"This small change can't break anything"* → run the
   touched checks; *"I remember the file looking like this"* → re-read
   it; memory of content is not content.

**Evidence:** `r71-prompt-discipline.test.ts` (24 tests) pins the registry
position (== agentic-loop+1, < file-editing), the four mantras, ≥4
self-tests, all three tags + the NEVER rule, the 3-strike rule verbatim
shape, all five red flags with their rebuttals, static/unconditional
composition, and the override-hook cascade (a
`.acute/prompts/engineering-discipline.md` file can replace or empty-drop
it — the R59 prompt-module contract, so the owner can tune the discipline
text per project).

## B — task→goal, receipts, and sub-agent discipline (e1, D2–D4)

**Root cause:** three smaller audit gaps, all model-side: (B5) "fix the
bug" stayed a vague imperative (nothing told the model to turn it into
something verifiable); (B6/B7) R70's verification evidence was "which
checks ran" — an assertion, not a receipt, and no confidence signal; (B8)
replies could still end on a padding question; (B9) delegation had no
scope contract and no no-polling rule (kilocode's strings: "do not
duplicate that work yourself", "DO NOT sleep, poll for progress").

**Fix (`prompts.ts`):**

- **:304** (D2, after both PLAN variants): the task→verifiable-goal
  transform — *"fix the bug" → "write a test that reproduces it, then
  make it pass"; "make it faster" → "define the measurable, then optimize
  until it moves"; "clean this up" → "name the concrete smell, remove
  exactly it"*. Unconditional: it applies with or without `todo_write`.
- **:588-603** (D3, COMMUNICATION): the finish-line rule is now
  **VERIFICATION RECEIPTS** — the exact command + its exit status or key
  output line ("pnpm test → 2165 passed"); *"an assertion without a
  receipt is not verification."* New confidence-tag line: 🟢 = all claims
  receipt-verified, 🟡 = partially verified, 🔴 = unverified — plus one
  line of **devil's advocate** on non-trivial changes (the strongest
  counter-argument to what was just done). Anti-question-padding folded
  into the ambiguity line: never end on a question unless genuinely
  blocked — and then state exactly what is needed ("I need the DB
  password").
- **:270-271** (D4, SUB-AGENTS, `delegate_task`-gated): **SCOPE
  DISCIPLINE** (the child delivers only its brief's scope; the parent
  never duplicates it) and the **no-polling rule** (delegation results
  arrive as tool results — do NOT sleep, wait, or poll for a sub-agent;
  `job_status` exists only for explicitly-backgrounded shell jobs).

**The size bill (e1, D6):** the golden full-ctx composition grew
**20,156 → 23,665 bytes (19,984 → 23,447 chars)** — every byte of the
+3,509 is the mandated discipline content, regenerated by the sanctioned
`UPDATE_GOLDEN=1` procedure and audited line-by-line (no other section
touched). The 22K hard bound could NOT honestly hold the maximal
composition any more: the mandated floor (~2.9K net: mantras + self-tests
+ 3 tags + verbatim 3-strike + 5 red flags + receipts + sub-agent lines)
exceeds the ~1.8K headroom the maximal had under 22K. The bound is
re-pinned where it can honestly hold — the DEFAULT full-tools
composition (what a real session composes before project-injected
content; rules/digest/index/skills are budgeted separately): **14,757 →
18,220 chars, ≤22,000 with 3.8K headroom**, and the maximal is
byte-pinned exactly by the golden fixture itself. The decision and its
math are documented in the D6 test comment (`r71-prompt-discipline.test.ts:374-392`).
Consequence, stated honestly: one-time prompt-cache invalidation for
existing sessions on the first turn after the 0.71.0 upgrade.

**Evidence:** the 24-test suite pins the three task→goal mappings (both
todo_write variants), the receipts wording, the 🟢🟡🔴 tags, the devil's
advocate, the anti-question rule, the sub-agent lines (and their honest
absence without `delegate_task`), plus a PLAN-mode full-path check (the
discipline surfaces present in read-only posture too).
`r70-prompt-round.test.ts` re-pinned — the old "VERIFICATION evidence"
pin replaced by the STRICTER receipts pin (nothing weakened);
`prompt-registry.test.ts` gained the order pin + the regen trail.

## C — tool reliability: the exact next call (e2, D1)

**Root cause (audit A1):** R70 made truncation *honest* but not
*actionable*. The read_file >256KB marker said "use offset/limit to page
through the middle" without saying where the middle starts; the
degenerate single-line cap (a minified asset) said "the file is one long
line" and stopped; run_command's middle-omission marker kept both ends
but offered no way to reach the omitted middle. kilocode's proven
semantic is the exact-continuation marker: the truncation notice itself
carries the exact next call ("Use offset=1891 to continue").

**Fix:**

- `fs-ops.ts:307-313` — the >256KB line-aligned head+tail marker now
  reads `…[file truncated: N bytes omitted between line A and line B of
  T total — use offset=<first omitted line> to continue]…`. Offset = the
  line right after the kept head; paging from there walks the middle, and
  when the model reaches the tail boundary it already holds the tail.
- `fs-ops.ts:253-266` — the degenerate single-line cap reports the total
  line count + byte semantics AND says honestly that **no continuation
  call can reach this middle** (offset/limit pages whole LINES and this
  is one line) — the recovery path is a different tool: `search_code`
  (content match) or `run_command` (grep). A marker that pretends paging
  works where it cannot would send the model into a guess loop.
- `exec.ts:198-210` — run_command's middle-omission marker keeps its
  byte semantics and gains the **spill-to-file recovery path**: "if the
  failure you need is in the omitted middle, re-run with output
  redirected to a file and read_file it in slices" (kilocode's
  pattern — a real, cheap recovery for the 64KB+ log case).
- `plugins/filesystem.ts:54` — the read_file TOOL DESCRIPTION now teaches
  the contract: "When output is truncated, the marker carries the file's
  total line count and the EXACT next call — 'use offset=N to continue' —
  so page from there instead of guessing."

**Evidence:** `r71-tool-reliability.test.ts` D1 block pins the marker
format (totals, boundary lines, the exact offset value), the degenerate
single-line honesty, and the run_command recovery text;
`r70-tool-feedback.test.ts` re-pinned for the changed markers (18 tests,
meaning preserved — the old "use offset/limit" pin replaced by the
stricter exact-offset pin).

## D — edit-failure escalation: the flail loop ends (e2, D2)

**Root cause (audit A2, cline's "crown jewel"):** a model whose
edit_file anchor does not match keeps retrying variations of the SAME
stale anchor. Every failure returned the identical one-liner
("oldString not found"), so the model had no signal that its
understanding of the file was out of date — it burned turns until the
loop guard's consecutive-failure stop (6 calls) killed the whole turn.
The most common real-world flail loop in the audit, and it was entirely
a feedback problem.

**Fix (NEW `agent-core/src/tools/edit-streak.ts` + wiring at
`plugins/filesystem.ts:139-152`):** a per-session counter of CONSECUTIVE
edit_file anchor failures; the failure text escalates as the streak
grows, appended AFTER the existing honest base error (the base keeps
naming the cause; the suffix adds the strategy):

| Streak | The suffix tells the model |
|---|---|
| 1st | nothing — the base error already says exactly what went wrong; advice on a single miss is noise |
| 2nd | re-read the file with read_file and copy the anchor EXACTLY from current content |
| 3rd/4th | you MUST change your approach: read_file the exact region, or write_file to rewrite the whole file — do not retry the same anchor |
| 5th+ | refusing this pattern: stop editing, read the file fresh, state the actual current content, then choose a verified anchor or write_file |

- **Reset on any success** — a success proves the model's file view is
  current again; the streak measures staleness, not model "badness".
- **Only ANCHOR failures count** (the not-found/ambiguous-anchor
  outcomes); a missing file or a containment error is a different
  failure with its own remedy.
- Storage: a module-level Map, in-process, never persisted, capped at
  999 — like the loop-guard streaks, it is machine feedback about a
  flailing pattern, not a fact about the conversation.
- Bare builds (no `toolDeps`/session — tests, CLI) never escalate; the
  edit_file tool description now says failures escalate with concrete
  recovery steps (`plugins/filesystem.ts:110`).

**Evidence:** the D2 block (31-test suite) covers the pure tiers at
every boundary, the reset-on-success, non-anchor failures not counting,
the cap — AND the real-toolset path (buildProjectTools with a session:
three failures produce the three escalating texts verbatim, the fourth
edit succeeding resets the streak).

## E — owner denials are user feedback, not malfunctions (e2, D3)

**Root cause (audit A4):** a user's denial of an approval returned
`ok:false` with the same shape as a tool error — the model apologized
for a failure, retried the denied action, or invented a bug. cline's
semantic: a rejection is NOT a tool or system failure; it is the
USER's answer, and the correct next move is asking or proposing an
alternative.

**Fix (`approvals.ts:675-681`, `:939-945`,
`plugins/computer-use.ts:248`):** owner denials now read *"command
denied by the owner — this is NOT a tool or system failure. The action
was not performed. Ask the user why (one line), or propose an
alternative approach."* (same text for web-request denials and
computer-use consent denials, with the action named). And two states
that used to collapse into "denied" are now distinguished:

- **Timeout** — "approval timed out after Ns — the user may be away; do
  not assume rejection."
- **Aborted before an answer** — "the turn was aborted before the owner
  answered — this is not a rejection; the command was not run."

**Evidence:** D3 block pins the three texts across command/web/computer-
use paths; `approval-flow.test.ts` re-pinned (11 tests — the ok:false
contract unchanged, only the note text).

## F — provider errors get classified before they are flattened (e2, D4)

**Root cause (audit A6):** every provider/stream failure flattened to
the same generic PROVIDER_ERROR 502 with a scrubbed message — the UI,
the owner, and the model on retry could not tell a rate limit from a
dead key from a genuine context overflow, even though the retry policy
(maxRetries 4 + OR-fallback) was already behaving differently for each.

**Fix (`runtime.ts:707-852`, exported `classifyProviderError`):**
classify BEFORE flattening, into **six classes** —
`context_window_exceeded` / `auth` / `rate_limit` / `network` /
`timeout` / `unknown` — each with a class-specific honest one-liner
(`CLASS_MESSAGES`, runtime.ts:813-820):

- **timeout/abort first** (TimeoutError/AbortError names, "timed out"
  wording) — unambiguous, nothing later may steal them;
- **auth BY STATUS ONLY** (401/403 — cline's rule: message-text matching
  for auth misfires on provider bodies that merely quote such words);
- **rate_limit** on 429 or rate-limit wording;
- the **rate-limit VETO**: rate-limit patterns are checked BEFORE the
  context-window patterns because "tokens exceeded" wording also appears
  in TPM (tokens-per-minute) bodies — a misfiled overflow would trigger
  the D5 recovery loop on a request compaction cannot fix;
- **context_window_exceeded** on 8 message patterns or a 413 (a bare
  400/422 is deliberately NOT overflow — providers use them for schema
  errors too);
- **network** on transport patterns or any 5xx; everything else is
  honestly `unknown`.

The status is extracted by a bounded, cycle-safe walk (depth 3, seen-set)
through the AI SDK's error shapes (`extractStatus`, runtime.ts:779-804).
The class rides the existing surfaces **additively**: the user-facing
message gains `(class: …)`, the 502 envelope's `details` gain
`errorClass` + `classMessage` (runtime.ts:1651-1655), and the persisted
`turn.error` event payload gains `errorClass` (runtime.ts:902-918) —
older readers ignore it; the retry policy is UNCHANGED.

**Evidence:** the D4 block is a classifier table — every class with its
triggering shapes, the veto case (a TPM body saying "tokens exceeded"
classifies rate_limit, never overflow), the status-only auth rule, the
413, the 5xx, wrapped/cycle error objects, and non-object inputs.

## G — context-overflow recovery: the long session stops dying (e2, D5)

**Root cause (audit A7):** compaction existed (R46, estimation-triggered)
but a provider-side overflow — the model's context window genuinely
exceeded, our ±15% estimate the thing that missed it — killed the turn
with the generic 502. The one error compaction can actually FIX was
treated like every other error. cline's loop: classify → force-compact →
retry once → honest terminal text if it repeats.

**Fix (`runtime.ts:1616-1643` streamed path, `:2380-2410` sync sub-agent
path, `compaction.ts:106-206` force mode):**

- A classified `context_window_exceeded` on a turn where **nothing from
  this call reached the log yet** (context-window rejections land before
  the first token; on the streamed path `liveStepsEmitted === 0`, on the
  sync path zero tool calls + empty text/thinking) triggers: a visible
  system line — `meta.overflow_recovery` SSE frame carrying
  "[context overflow → auto-compacted conversation → retrying]" — then a
  **forced compaction** (compaction.ts's new `force` flag skips the
  "under budget → nothing to do" gate; the provider's rejection is the
  ground truth, our estimate is the guess), then **ONE retry** of the
  turn.
- **One recovery per turn** (`overflowRecovered`); a second overflow
  lands in the honest terminal message: "context window exceeded even
  after compaction — start a new session or /compact".
- **A retry iteration must remain** — a recovery `continue` on the last
  outer iteration would fall out of the loop with no error set; the turn
  must never swallow an overflow as a fake success.
- **Overflow AFTER partial content streamed = NO recovery** — retrying
  would duplicate persisted work; the honest error path runs instead.
- **Non-overflow errors never trigger compaction** (that is the veto's
  whole job); **first-turn overflow with nothing to compact fails
  honestly** (the empty-to-summarize check in compaction still returns
  null — no invented compaction).

**Evidence:** D5 block covers the force-mode primitive (a compaction
planned even under budget; empty session still null) and BOTH turn
paths: the streamed recovery (visible frame + retry + success), the
second-overflow terminal, the last-iteration guard, the
partial-content no-recovery case, non-overflow errors bypassing
compaction, and the sync-path equivalents.

## H — the skills round: the trigger surface + four discipline skills (e3)

**Root cause (audit C1/C2):** R70 built the skills *machinery* (files,
sticky bodies, allowlist) but the builtin descriptions were written for
humans ("Skill for reviewing code") — while the description is the ONLY
thing the model sees at trigger time (Pocock's rule). The discipline
skills the research validated as highest-value (focused-fix,
zero-hallucination, self-eval, ship-gate) did not exist at all.

**Fix (`storage/skills.ts:449-556`):**

- **All 8 builtin descriptions rewritten trigger-rich** — "Use when
  [verbatim user phrasings]. [what it delivers]. NOT for [adjacent
  case]." Each 416-499 chars (≤500 storage cap), each carrying quoted
  phrasings the user or model would actually think ("open Notepad",
  "review this diff", "my test fails", "before I commit", "search the
  web", "set up a new project", "open the browser"), a Delivers
  sentence, and a negative scope naming the nearest adjacent skill —
  so the model can *choose* between siblings instead of guessing.
  Bodies unchanged (zero contradictions found between the new
  descriptions and the old bodies).
- **Four new discipline builtins** (12 total, fixed ids, sortOrder 8-11,
  same `INSERT OR IGNORE` seeding — fresh installs AND existing DBs get
  the new rows on next open; user edits persist; a deleted row revives
  on reopen):

| Skill | Body | The contract it carries |
|---|---|---|
| `focused-fix` | 1,858 | the Iron Law — **NO FIXES WITHOUT COMPLETING SCOPE → TRACE → DIAGNOSE FIRST**; the SCOPE/TRACE/DIAGNOSIS output block; 3-strike escalation; a red-flags table quoting the model's own excuses; smallest-change + verify-with-the-reproduction |
| `zero-hallucination` | 1,751 | [KNOWN]/[ASSUMED]/[UNKNOWN] tagging + never code on an UNKNOWN; the 6-rung YAGNI ladder ("the best code is the code you never wrote"); source-wins / reproduction-wins |
| `self-eval` | 1,776 | ambition × execution 0-3 matrix (low ambition caps the total at 2); mandatory devil's advocate; a-claim-without-a-receipt-scores-0; 🟢🟡🔴 tags matching the evidence; the VERDICT output block |
| `ship-gate` | 1,680 | intercepts deploy-intent ("commit and push", "deploy", "ship it", "go live", or the model's own "done"); CRITICAL/HIGH/ADVISORY tiers; **DO NOT SHIP** / SHIP WITH NOTES / CLEAR verdicts — never SHIP on assertion alone; the GATE REPORT block |

All four are adapted from the alirez source material, referencing
ACUTE's real tools (run_command, read_file, search_code, git_diff,
git_status, todo_write, edit_file), imperative voice, iron laws in caps.

- **The honest upgrade-path limitation:** description updates do NOT
  propagate to pre-R71 databases (INSERT OR IGNORE keeps existing rows —
  by design, user edits persist). Fresh installs and revived
  (deleted-row) installs get the new text; a UPDATE-where-unchanged
  migration is deliberately deferred (recorded below in what's next).

**Evidence:** `r71-skills-round.test.ts` (51 tests): the 12-in-fixed-
order pin; per-skill trigger-rich contract (Use when + NOT for + a
quoted phrase + the Delivers sentence + 300-500 chars); verbatim
trigger-phrase pins ×12; negative-scope pins ×12; distinctness; the
4 new-body house-format pins (1.0-1.9KB, ≤60 lines, `# Skill:` prefix);
iron-law/output-block content pins per skill; emoji discipline (🟢🟡🔴
only in self-eval); idempotent double re-seed → exactly 12 rows;
deleted-row-revives-on-reopen via a real close/reopen; user-edit
persistence across reseeds; and the D4 flow-through pin — all 12 full
descriptions render verbatim in the prompt's SKILLS section.
`r70-skills-system.test.ts` re-pinned honestly: 8→12 count + order pins,
the it.each body contract EXTENDED to the 4 new skills (strengthened,
not weakened — same 800-2200/≤60-line/desc contract), 41 → 45 tests.

## The architecture (one picture)

```
THE PROMPT (prompts.ts)
  AGENTIC LOOP ── PLAN carries the task→verifiable-goal transform
  ENGINEERING DISCIPLINE (NEW, 2,312 chars) ── 4 mantras + self-tests,
    [KNOWN]/[ASSUMED]/[UNKNOWN] (never code on an UNKNOWN), 3-strike,
    the 5-line red-flags table
  COMMUNICATION ── receipts (command + exit status) + 🟢🟡🔴 +
    devil's advocate, no question-padding
  SUB-AGENTS ── scope discipline + no sleeping/polling
  SKILLS ── 12 trigger-rich lines (Use when / Delivers / NOT for)

THE TURN (runtime.ts + the tools)
  classifyProviderError (NEW) ─► six classes: overflow / auth /
    │    rate_limit / network / timeout / unknown
    ├─ overflow, nothing streamed ─► "[context overflow → auto-
    │    compacted → retrying]" + forced compaction + ONE retry
    └─ anything else ─► class on the 502 envelope + turn.error event
  edit_file anchor miss ─► edit-streak.ts: 2nd re-read / 3rd change-
    approach / 5th refuse-the-pattern (reset on success, never stored)
  read_file >256KB ─► "…of T total — use offset=N to continue"
  run_command 64KB+ ─► spill-to-file recovery path in the marker
  owner denial ─► "NOT a tool or system failure — ask why or propose
    an alternative" (timeout ≠ denial ≠ abort)
```

## Verification (re-run fresh this round — the docs pass's own receipts)

| Suite | R70 | R71 | Delta |
|---|---|---|---|
| root `pnpm test` | 2177 (126 files) | **2287 (127 passed + 2 skipped files)** | +110 |
| agent-core standalone | 1275 (63 files) | **1385/1385 (66 files)** | +110 |
| frontend `src/` | 890 (61 files) | **890/890** | 0 — zero frontend files touched |
| sidecar e2e | 12 | **12** (env-gated without dist) | 0 |
| `r71-prompt-discipline` (NEW) | — | 24 | — |
| `r71-tool-reliability` (NEW) | — | 31 | — |
| `r71-skills-round` (NEW) | — | 51 | — |
| re-pins | — | r70-tool-feedback 18 · approval-flow 11 · r70-skills-system 41→45 · prompt-registry 22 · r70-prompt-round 34 | +4 (skills pins) |

- The +110 = 24 + 31 + 51 new tests + 4 re-pin growth; measured this
  pass by re-running the suites (root 2275 passed | 12 skipped — the 12
  sidecar-e2e run in-suite with a fresh dist; total 2287; agent-core
  1385/1385).
- `pnpm typecheck` exit 0 (root + agent-core), `pnpm lint` exit 0 —
  both re-run by this docs pass.
- The golden fixture regenerated by the sanctioned procedure
  (UPDATE_GOLDEN=1 vitest run + a clean second run): 20,156 → 23,665
  bytes; the diff audited line-by-line = exactly the e1 additions.
- Zero Rust / `src-tauri` files touched — `cargo check` not re-run
  locally; CI's windows-latest gate rides the same untouched code as
  the green v0.70.0 build.
- `pnpm docs:check` 168 docs / 0 failures / 0 warnings after this
  round's stamps (the round-71 files stamped 2026-09-07 round-71; the
  status.json `round` field stays at its shipped 57 convention — see
  round-70's gate-quirk note). `pnpm version:check` 0.71.0 ×4.

## Live gates for the owner (what to watch on real Windows)

These are the questions CI cannot answer — the round is
construction-pinned in a headless Linux sandbox, exactly as R69/R70
were:

1. **Does the discipline section change reply quality?** Watch real
   replies for: verification receipts in the finish line ("pnpm test →
   N passed" with the command named, not just "tests pass"), the 🟢🟡🔴
   confidence tag, the devil's-advocate line on non-trivial changes —
   and whether endings stop padding with questions when not blocked.
2. **Do the new skills trigger on real phrasings?** Say "commit and
   push this" (ship-gate), "make the auth flow work end-to-end"
   (focused-fix), "how well did that go?" (self-eval), or watch whether
   the model loads zero-hallucination before writing code against an
   API it has not read. The 12 descriptions quote the phrasings they
   answer to — if a real phrasing does NOT trigger its skill, the
   description needs a tuning pass (the description is editable in
   Settings → Skills; report the phrasing).
3. **Does edit-escalation end the flail loops?** In a long session
   where an edit misses, watch the second failure's text: it should say
   "re-read the file and copy the anchor EXACTLY" — and the model
   should actually re-read instead of retrying the stale anchor. The
   5th+ refusal text is the safety net; ideally it never appears.
4. **Does overflow recovery save long sessions?** In a session big
   enough to overflow the provider window, look for the "[context
   overflow → auto-compacted conversation → retrying]" line and the
   turn continuing instead of dying with a 502. The SSE frame is on the
   stream; the chat UI does not render unlisted meta frames yet (the
   same family as `meta.compaction`) — the turn continuing is the
   observable.
5. **Carried from R69/R70 (still awaiting the field run):** the R69
   Windows checklist (docs/runbooks/COMPUTER-USE.md) and the R70 gates
   (skill-body tuning, AGENTS.md loading on real repos, the grounded
   TERMINAL syntax).

## What this round does NOT claim (known limitations)

- **The maximal prompt composition now exceeds 22K chars** (23,447) —
  inherent to the mandated discipline floor, documented in the D6 test
  comment; the hard bound is pinned on the DEFAULT composition (18,220
  ≤ 22,000, 3.8K headroom; if the owner wants maximal ≤ 22K back,
  ~1.5K of mandated discipline text must be cut — the recommendation
  was to keep it).
- **The overflow-recovery SSE frame is not rendered in the chat UI** —
  stream-store deliberately ignores unlisted meta frames (the documented
  contract in `src/lib/api.ts`); the frame is on the stream and in the
  engine log, and rendering it is a small future frontend task (zero
  frontend files touched this round, deliberately).
- **Classification is best-effort pattern matching** — statuses first,
  then message shapes; a provider with novel wording lands honestly in
  `unknown` rather than a wrong class. The veto trades a rare missed
  overflow for never recovering on a rate limit — the right trade.
- **Description updates do not reach pre-R71 databases** (INSERT OR
  IGNORE keeps user-visible rows; fresh + revived rows get the new
  text) — an UPDATE-where-unchanged upgrade path is queued for a future
  round if the owner wants it.
- **The edit streak is in-memory per sidecar process** — a restart
  clears it (by design: it is machine feedback about a current flail,
  not conversation state).
- **Overflow recovery retries ONCE, and never after partial content has
  streamed** — a retry there would duplicate persisted work; the honest
  error path runs instead.
- **All live behavior is the field gate** — prompt-text discipline and
  trigger-rich descriptions are construction-pinned; the owner's real
  tasks decide whether the wording lands (exactly as the computer-use
  skill body was re-taught in R69 after the field run contradicted it).
  The tag/release/DASHBOARD sync are the orchestrator's close-out
  steps, not this round's.

## What's next (the R72 queue, recorded from R71-d)

- **Per-directory AGENTS.md injection** — rules from the directory of
  the file being read, injected into read results as a system-reminder
  (kilocode's claims-map pattern; the audit's C3).
- **`references/` for file skills** — one level of additional files a
  SKILL.md can point at (the Agent-Skills convention's second tier;
  C5).
- **`delegate_task` task_id/background/resume** — addressable,
  resumable sub-agent tasks with the depth guard (B9's runtime half).
- **A generalized system-reminder injector** — one mechanism for
  AGENTS.md injections, mode-switch notices, and lessons-ledger
  affordances instead of bespoke strings.
- **Custom modes** (`.acute/agents/*.md` — user-defined agents with
  body-as-prompt, D3's slash-command/mode surface) and **external
  plugin ctx enrichment** (cline's appendContext seam).
- Plus the standing queue from the Unreleased section: the R69/R70/R71
  live gates, edit-linting (SWE-agent's ACI #1 finding), installer
  code-signing, ratings-driven prompt tuning, and the
  deepseek-harness future candidates.
