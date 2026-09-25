<!-- last-reviewed: 2026-09-25 round-126 -->
# AI-AGENT-PLAYBOOK — how an AI agent behaves on this project

**Status:** normative · **Established:** round-126 · **Audience:** every AI
agent (orchestrator or sub-agent) that works on ACUTE-CODE, from a cold start

Owner R126 directive (verbatim): *"you did all the things properly and such.
Everything is in order… you properly verified the things along the way. You
properly followed the workflow… you managed the to-do list properly. You
properly utilized the sub-agents properly… I would like you to document, plan,
and create proper workflows for yourself based on this… like in the setup
section or the readme files for behavior on things, like how you need to
behave… so that if any new AI agent apparently decides to work on this
project, then that new AI agent will already know and would already have all
the necessary details which it would need to perform in a similar way."*

This file is the behavior contract distilled from the sessions the owner has
explicitly approved (R28's cognitive method, R126's wave method). It sits
BESIDE [WORKFLOW](WORKFLOW.md) (the mechanical session spine: branch policy,
gates, push/CI/ntfy order) and [ORCHESTRATOR-METHOD](ORCHESTRATOR-METHOD.md)
(the cognitive method: planning, verification ladder, sent-back protocol). If
they conflict: WORKFLOW wins mechanics, ORCHESTRATOR-METHOD wins thinking,
THIS file wins **how a session is structured and how sub-agents are driven**.
A new agent reads all three, in the order §1 gives, before touching anything.

---

## 1. The reading order (a cold agent starts here)

1. `AGENTS.md` (repo root) — the hard rules (stack, licenses, secrets, gates).
2. `HANDOFF.md` §3 (state) + §9 (what's next).
3. `docs/runbooks/AGENT-MEMORY.md` — every numbered lesson; these are mistakes
   that already cost a round. Re-reading them is how you avoid paying twice.
4. The tail of `docs/agent/ORCHESTRATION-WORKLOG.md` — where the last session
   actually ended (the shared worklog snapshot).
5. THIS file + [WORKFLOW](WORKFLOW.md) + [ORCHESTRATOR-METHOD](ORCHESTRATOR-METHOD.md).
6. The runbook for the task at hand ([TESTING](TESTING.md),
   [MAINTENANCE](MAINTENANCE.md), [MODULE-BOUNDARIES](MODULE-BOUNDARIES.md),
   [DOC-STANDARDS](DOC-STANDARDS.md)).

If the work is UI: `docs/design-language/` (TOKENS / MOTION / COMPONENTS /
SCREENS / README) is the constitution — it outranks personal taste, always
(§6). If the work is large: read §4 (the wave protocol) before dispatching
anything.

## 2. The behavior laws (non-negotiable)

These are the behaviors the owner has explicitly praised and expects from
every future agent. They are observable from the output alone — he can tell
when they were skipped.

1. **Quality over speed, unbounded time.** *"Not limited time — you can spend
   hours and hours on the tasks… do not rush."* (R126). A session ends when
   the close-out checklist is green, not when the clock feels long.
2. **Plan before code.** Survey the real code first (line numbers, counts —
   never from memory), write the plan down, and for anything >3 workstreams
   have the plan reviewed before executing it.
3. **Extract EVERY requirement into a todo list.** The owner writes long
   section-by-section messages; item #7 of 9 is easy to miss. Use the todo
   tool, keep it in the owner's priority order, and **update it in real time**
   — mark items completed the moment they are, keep exactly one in-progress,
   and never let the list drift from reality. The owner reads the todo state
   as evidence of management.
4. **One surface at a time.** For multi-surface work (a redesign, a sweep):
   complete one page/screen/panel fully — code + tests + gates + verification
   + record — before starting the next. Never leave a half-done surface when
   moving on.
5. **Only touch what is 100% certain to be wrong.** *"Only make changes to
   things which you are a hundred percent sure that are wrong or need
   fixing."* (R126). Uncertainty is reported, not acted on.
6. **Verify everything yourself.** Never report a gate you did not run and
   read with your own eyes this session. "It compiled" / "the server is up"
   is never sufficient — run the interaction, open the screen, exercise the
   flow (§5).
7. **Record as you go.** The shared worklog (`/home/z/my-project/worklog.md`
   in the sandbox; snapshot to `docs/agent/ORCHESTRATION-WORKLOG.md` at
   close-out) is append-only, Task-ID'd, and written by EVERY agent including
   sub-agents (§4.6). Work without a record did not happen.
8. **Report honestly.** Every record carries its caveats: what is
   kept-by-design, what was verified-at-pin-level-only, what an interrupted
   run contributed. Over-claiming is the fastest way to lose the owner's
   trust; the honest caveat list is a feature of the house style.
9. **Never infer approval from praise.** "Good work" is encouragement, not a
   verdict. A round closes only on an explicit APPROVE.
10. **Never leave work silently truncated.** If scope exceeds the session,
    say so WITH a plan. The owner's rule: *"don't leave anything behind for
    the next sessions."*

## 3. The session arc (the R126 shape)

The arc below carried the largest single round in project history (the full
PC UI redesign, 12 waves, ~90 drift spellings retired, all gates green) with
zero sent-back defects. It is the default shape for any large round.

1. **Open** per §1's reading order; re-read the owner's message top-to-bottom
   and extract the todo list.
2. **Backup branch FIRST** (the rollback door): before any risky/wholesale
   change, `git branch backup/<slug>` at the current green tip and PUSH it.
   Name it so the owner can find it (`backup/pre-redesign-r126`). This is the
   owner's explicit directive: *"first create a backup branch… so we can
   always roll back."* Never delete it without the owner's say-so.
3. **Inventory before plan**: enumerate every page/screen/component the work
   will touch (an honest, complete list — the R126 inventory covered all 12
   waves up front). The plan's credibility rests on this list being complete.
4. **Constitution before code** (UI work): write/refresh the design-language
   docs (tokens, motion, components, screens) FIRST, so every wave implements
   a written spec instead of each sub-agent's interpretation. The constitution
   is the contract between waves; it is what keeps twelve parallel surfaces
   coherent.
5. **Execute in waves** (§4) — foundation work inline by the orchestrator;
   surface work delegated to review-gated sub-agent waves.
6. **Integrate + close out**: full gate stack (§5), final visual sweep, docs
   (round file, CHANGELOG, version ×7 manifests, status.json), commit, push,
   tag, watch CI, publish the release (§7), worklog snapshot, ntfy.

## 4. The wave protocol (sub-agent-driven implementation)

**The revision, on record.** The 2023-08-23 owner revision said sub-agents
are OPTIONAL, research/review-only, implementation inline. R126's owner
direction explicitly revised this for large surface work: *"Use sub-agents in
parallel, letting them work independently and properly on separate
things… use proper prompt engineering for the sub-agents… strictly review
every sub-agent's output, not letting any errors slip past."* The two rules
coexist:

- **Default mode** (unchanged): inline implementation by the orchestrator;
  sub-agents for research, audits, plan review. Small fixes never dispatch.
- **Wave mode** (R126+): when the owner directs a large multi-surface effort
  (a redesign, a sweep across many files), the orchestrator may delegate
  implementation to sub-agent waves — ONE surface per wave, each wave
  review-gated by the orchestrator before the next starts. The gates and the
  review discipline are what make this safe; without them it is forbidden.

### 4.1 When a wave is justified

- ≥3 parallelizable surfaces, each independently testable (own file(s), own
  test file(s)).
- The spec for each surface can be written down completely (constitution
  docs, recipes, "the letter") — a wave must never be dispatched to discover
  its own spec.
- The orchestrator has the review capacity to strictly read every wave's
  full diff. If not, do it inline, sequentially.

### 4.2 The wave brief (the prompt engineering that worked)

Every wave dispatch carries ALL of these, in this order. The R126 waves that
followed this template produced zero sent-back defects; treat it as law.

1. **Task ID** (`R126-3e` style: round-wave) + the wave's name and one-line
   intent.
2. **The worklog duty**: read `/home/z/my-project/worklog.md` (the tail +
   the sibling waves' entries) BEFORE starting; append the wave's own record
   on completion (the template: Task ID / Agent / Task / Work Log / Stage
   Summary / Honest Caveats). Work without the record does not count.
3. **The mandatory reading list, in order** — the exact files + sections:
   the constitution sections the wave implements (e.g. TOKENS §1d/§9/§10/§11,
   COMPONENTS §3/§7, SCREENS §3), the sibling docs (MOTION), then EVERY owned
   file IN FULL plus its test file's pin sites, plus the read-only neighbors'
   relevant sections.
4. **Ownership boundaries**: the files the wave OWNS (may edit) vs the files
   it READS ONLY (a sibling wave's or a prior round's — flagged by name).
   Cross-boundary edits are forbidden; needed changes there are reported in
   the caveats instead.
5. **The letter of the spec**: the itemized material/behavior contracts with
   file:line anchors — exact class spellings, token names, formulas, and for
   each item what "done" means (the computed style it must produce, the test
   pin that must hold). Specificity is the whole value; a vague brief
   produces a vague wave.
6. **The re-pin rule**: tests are updated ONLY for contracts this wave
   changed — re-pin the changed visual/behavior contracts with
   `R<NNN>-commented` test names, never re-pin what you did not touch, never
   delete a failing assertion without replacing its truth.
7. **The gate stack** (§5) the wave must run green itself: tsc → targeted
   vitest → FULL vitest (report the file/test counts against the baseline) →
   eslint on owned files → design-audit.
8. **The live verification** (§6) where applicable: open the real screen in
   both modes, capture computed-style proofs, screenshots to the shots dir.
9. **The return format**: what it did (item-by-item against the brief),
   artifacts (files, tests, screenshots), the gate outputs with counts, the
   honest caveats, and anything flagged for sibling waves.

### 4.3 The review gate (the orchestrator's side — mandatory, strict)

*"Strictly review every sub-agent's output, not letting any errors slip
past."* For every wave, the orchestrator:

1. **Reads the full diff** (`git diff` over every owned file) — not the
   summary, the diff. R126's reviews caught wrong-import deletions,
   letter-gap spellings, and un-sanctioned materials this way.
2. **Audits item-by-item against the brief** — every numbered contract gets
   a verdict (✓ / letter-gap found / violation).
3. **Runs the gates independently** — never trust a sub-agent's "green";
   re-run at minimum tsc + the targeted suite + the full suite count.
4. **Verifies live where the wave claims it** — the screen opens, the
   computed styles match the token literals verbatim.
5. **Rolls back on error**: *"if you find errors, roll back to the correct
   state and then fix them."* A wave whose review fails is reverted (git
   checkout of the owned files) and either fixed inline or re-briefed — the
   error and the fix both go into the record.

### 4.4 The interrupted-run successor pattern

Sub-agents die at turn ceilings mid-wave — the tree arrives with the code
written, tests re-pinned, sometimes green, but no gates, no record, no
verification. This happened on five of twelve R126 waves and is EXPECTED.
The successor's protocol:

1. NEVER assume the interrupted run's work is correct. Audit it item-by-item
   against the brief exactly as §4.3 prescribes — the audit IS the work.
2. Complete what was cut off: the missing pieces, the gates, the live
   verification, the screenshots.
3. Append the record YOURSELF, crediting the interrupted run honestly:
   "the tree arrived ~N% converted by an interrupted prior run; this
   session's contribution is the item-by-item audit, the letter-gap
   tightenings, the gates, and this record."
4. The orchestrator's completion pass follows the same rule when IT finishes
   a cut-off sub-agent's wave.

### 4.5 Concurrency + sequencing

- Max 2 waves running concurrently (sandbox resource limit); serialize the
  rest. Waves sharing files NEVER run concurrently.
- Foundation work (tokens, shared primitives, the store) lands INLINE and
  gated BEFORE wave 1 dispatches — waves must build on green foundations.
- Sibling waves' flagged debts (a read-only neighbor needing a change) are
  collected and closed by a dedicated final coherence wave (R126-3h's
  pattern) — nothing is left dangling.

### 4.6 The worklog discipline (every agent, every wave)

One shared worklog (`/home/z/my-project/worklog.md`), append-only, sections
separated by `---`, each with Task ID / Agent / Task / Work Log / Stage
Summary. Read-before-work and append-after-work are both mandatory — it is
the only shared memory between concurrent agents. At session close the
orchestrator snapshots it into `docs/agent/ORCHESTRATION-WORKLOG.md`
(commit: "Worklog snapshot refresh: <round>") per WORKFLOW §5.

## 5. The gate stack (what "green" means, in order)

Every wave and every round close runs, at minimum, this exact stack — with
the outputs READ, the counts RECORDED, and the baseline COMPARED:

| # | Gate | Command (repo root) | The discipline |
|---|------|---------------------|----------------|
| 1 | Typecheck | `npx tsc --noEmit -p tsconfig.json` (+ agent-core's) | zero errors, every time |
| 2 | Targeted suite | `npx vitest run <owned test files>` | the wave's own files first |
| 3 | FULL suite | `npx vitest run` | **record the file/test counts** (R126: 274 files / 4,835 → 4,840) — the count is the tripwire; drift means something broke silently |
| 4 | Lint | `npx eslint <owned files>` (whole repo at close) | zero |
| 5 | Design audit | `node scripts/design-audit.mjs` | hardcoded-hex / arbitrary-value / JS-hover counts only go DOWN; record before→after |
| 6 | Build | `pnpm build` | green at round close |
| 7 | E2E | the e2e battery vs the built dist | 12/12 |
| 8 | License | the license audit | CLEAN |
| 9 | Docs | `pnpm docs:check` | N/0/0; a mass failure is the stamp cohort aging (DOC-STANDARDS §8) |

Baseline discipline: the full-suite count is carried in every record. A wave
that ends 4,837 when the session baseline was 4,840 has explaining to do.
`pnpm verify` bundles 1+3+4+6+8 — it is the fast pre-push gate, but it does
NOT replace the stack above at a round close.

## 6. Live verification (UI work — the standard of done)

Pinned tests prove the contract; only a live browser pass proves the screen.
For every converted surface:

1. **Boot the real stack** (dev server; localStorage `acute.setupDone=1`
   where the wizard must be skipped).
2. **Open the surface through its real nav path** (not just the deep link —
   lesson #63), both dark AND light mode.
3. **Computed-style proofs**: the agent-browser's computed styles must match
   the TOKENS literals VERBATIM (fill, rim color+width, radius, shadow legs,
   font stacks). Record the numbers in the wave record.
4. **Screenshots** into `shots/<round>/<surface>-{dark,light}.png`.
5. **VLM pass** on the screenshots (the vision model against a checklist:
   material coherence, no unsanctioned hues, contrast, the owner's specific
   complaints dead). R126's VLM verdicts are the model — quote them in the
   record.
6. **Zero console errors tolerated.**

When the real backend is unavailable in dev mode, an additive fetch shim
mirroring the API shapes field-for-field is the sanctioned fallback — and
the record says so honestly (verified-via-shim, not verified-live).

## 7. The release ritual (the close of a version round)

1. Version bump across ALL 7 manifests (root + agent-core + mobile + …);
   `pnpm version:check` must agree.
2. `CHANGELOG.md` entry with the user-facing story; the round file complete.
3. Commit (the full round, one commit, the message tells the whole story in
   the house style), push `main`, tag `v<version>` AFTER CI on the commit
   shows green (R125's lesson: never tag a red commit; if CI fails, fix,
   re-push, delete the stale tag + draft, re-tag at the green commit).
4. **Watch ALL FIVE workflows** to SUCCESS (CI, Rust Checks, Mobile CI,
   Release, Mobile APK) — poll the run ids; a client timeout is not a CI
   failure.
5. **Publish the draft release**: PATCH the release (draft:false,
   make_latest:true), name + body from the CHANGELOG section; verify
   `/releases/latest` answers the new version and 7/7 assets are attached;
   verify zero drafts remain.
6. status.json close-out sync (round.current, plan, milestones, ci, quality)
   in the final docs commit; `pnpm docs:check` green; push.
7. One ntfy on the round close-out per the R28 ruling:
   `curl -d "<no secrets>" https://ntfy.sh/TASKISDONE`.

## 8. Anti-patterns (each of these got a round sent back or a lesson filed)

- Dispatching a wave without the full §4.2 brief — the sub-agent invents its
  own spec and the review gate catches it expensively.
- Trusting a sub-agent's "green" without re-running the gates.
- Letting the todo list go stale (the owner reads it as management evidence).
- Deleting a failing test to make a gate pass; re-pinning contracts you did
  not change.
- Reporting "done" for a surface verified only at pin level without saying
  so (the honest caveat is mandatory, §2.8).
- Tagging before CI is green on the commit (R125).
- Skipping the backup branch before wholesale change (R126's rollback door).
- Editing a sibling wave's read-only files instead of flagging the debt.
- Inferring approval from praise; truncating a 9-item message to 6 todos.

---

**End of AI-AGENT-PLAYBOOK.** A new agent that reads §1's list, follows §2's
laws, and executes §3's arc with §4's discipline will perform the way the
owner has learned to expect from this project's agents. Quality over speed,
always.
