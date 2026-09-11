<!-- last-reviewed: 2026-09-11 round-90 -->

# ORCHESTRATOR-METHOD — how the orchestrator agent thinks and works

**Status:** normative companion to `WORKFLOW.md` · **Established:** round-28
(owner direction: *"you did not rush on anything… a proper to-do list, you
properly followed it, you took your time, you analyzed what needed to be
analyzed, and you followed a proper workflow. I want you to continue this
kind of behavior in the future too. Document this so you can look into that
and follow it properly."*)

`WORKFLOW.md` is the **mechanical** session spine (branch policy, gates, doc
duties, push/CI/ntfy checklist). THIS file is the **cognitive** method — the
ordered discipline the orchestrator follows to convert one owner message into
verified, merged, documented work without leaving debt behind. If they ever
appear to conflict: `WORKFLOW.md` wins for process mechanics (branching,
gates, push order); this file wins for *how to think* about the work.

Every session opens this file first, then `WORKFLOW.md`, then the state
files. Re-read it even if you "already know it" — the lessons below are the
difference between a round the owner approves and one he sends back.

---

## 0. The one rule above all the others

**Quality over speed or time. Take as much time as needed.** (owner, R28)

Every other instruction in this file is a tactic in service of that rule. If
you ever feel pressure to skip a step "to save time," that is the moment to
slow down *more*. The owner has explicitly said, repeatedly, that he would
rather you spend the whole session doing one thing properly than touch
twelve things shallowly. He can tell the difference from the output alone —
you will not fool him by rushing.

Corollary, also from the owner (R28): *"don't leave anything behind for the
next sessions or anything like that. Complete everything in this exact same
one now."* A round is not done because the clock ran out; it is done because
the close-out checklist (§8) is green. If the scope is genuinely too large
for one session, surface that honestly to the owner **with a plan**, never by
silently truncating the work.

---

## 1. Session-opening ritual (do this every session, in order)

1. **Restore or verify the environment** per `SANDBOX-RESTORE.md`:
   secrets staged (lengths verified, never echoed), repo at tip, remote
   sanitized, repo confirmed PRIVATE via the GitHub API. If the sandbox is
   wiped, **do not attempt autonomous recovery** — ntfy the owner
   (`curl -d "<no secrets>" https://ntfy.sh/TASKISDONE`) and stop. (R28 rule;
   see AGENT-MEMORY #39.)
2. **Read the state files in this exact order** — skipping any of them costs
   real time downstream:
   - `HANDOFF.md` §3 (current state) + §9 (what's next)
   - `docs/runbooks/AGENT-MEMORY.md` — **all** lessons, every one; these are
     mistakes that already cost a round, re-reading them is how you avoid
     paying for them twice
   - the tail of `docs/agent/ORCHESTRATION-WORKLOG.md` (where the last
     session actually ended)
   - `docs/ui-iterations/README.md` (the round board) + the most recent
     `round-NN.md`
   - `docs/runbooks/WORKFLOW.md` (mechanics) + this file (method)
   - the runbook for the task at hand (e.g. `TESTING.md`, `SECURITY.md`)
3. **Re-read the owner's last message top-to-bottom and extract EVERY
   numbered requirement into a todo list** (lesson #3). The owner writes in
   long section-by-section messages; it is easy to miss item #7 of 9. Use
   `TodoWrite` and put the items in the owner's priority order. Mark the
   ones that can run as parallel sub-agent work as such, but keep
   implementation inline (§4).
4. **Never infer approval from praise.** The owner says "good work" often;
   that is encouragement, not a verdict. A round closes only on an explicit
   APPROVE / CHANGES / PIVOT. (owner, R15+; AGENT-MEMORY #3.)
5. **Branch decision** (per WORKFLOW §3): trivial single-file fix → `main`;
   anything multi-file → `work/<round-slug>` **immediately**, before any
   code is written.

---

## 2. The planning ritual (before any execution)

The owner has mandated this explicitly (R28): *"plan the things properly…
verify it using sub-agents to tell them to review your plan, find the
flaws."* A round that skips planning is a round that gets sent back.

1. **Research before writing.** Read the actual current code for every file
   the workstream will touch. Quote line numbers. Know what exists *before*
   proposing what to change. Sub-agent 6-d's R28 review caught multiple
   plan errors ("`search_code` is inline, not a separate file";
   "ExperimentalLayout is NOT orphaned"; "test count is 197, not 203")
   precisely because the planner read the real code. A plan written from
   memory of a prior session will drift.
2. **Write the plan as a versioned document** at `docs/ROUND-NN-MASTER-PLAN.md`
   (or `plan-*.md` for smaller rounds). Structure: owner's words quoted
   verbatim per workstream → current anatomy with line numbers → proposed
   change (additive, surgical) → files touched → verification → risks +
   mitigations. Make it detailed enough that a cold successor can execute
   it from the doc alone. Length is not a virtue; **specificity is.** The
   R28 plan is ~1123 lines not because 1123 was a target but because 13
   workstreams each needed exact file/line/verification spec.
3. **Dispatch parallel review sub-agents** (OPTIONAL per AGENTS.md, but
   mandatory for any plan >3 workstreams). Three lenses, run in parallel:
   - **Architecture reviewer:** do the cited file paths exist? are the line
     numbers accurate? are dependencies sequenced correctly? any circular
     deps? any orphaned work?
   - **UX reviewer:** does each redesign spec match the owner's *exact
     words*? any over-engineering (features the owner didn't ask for)?
     mobile-first? accessibility?
   - **Risk/find-flaws reviewer:** stress-test each risk; find MISSING
     risks; verify mitigations are realistic; flag under- or over-scoped
     workstreams.
4. **Apply the review fixes** to the plan (version it v2, with a changelog
   section listing every fix and which reviewer found it). Only then begin
   execution. A plan that the reviewers broke is a feature, not a setback —
   it cost one sub-agent round instead of one owner round.

---

## 3. The execution ritual (per milestone)

1. **Sequence by dependency, not by ease.** Governance docs first (so the
   next agent can find their way), then UX in the order the owner listed the
   complaints, then agentic-quality, then tooling, then cadence. The R28 plan
   §17 has the authoritative dependency tree.
2. **One workstream = one commit = one verify gate.** Do not batch
   workstreams into a commit; if a verify fails you want to bisect in
   one-file increments, not hunt across a mixed commit. Each green milestone
   gets a WIP commit+push on the work branch (lesson #33: a sandbox wipe
   must never cost more than one milestone).
3. **Code inline, with tests, AI SDK mocked** (no live model calls in the
   test suite — ever). Tests are written in the same commit as the feature.
4. **`pnpm verify` green, seen with your own eyes.** Prefix every Bash call
   with the pnpm PATH export (lesson: pnpm lives at
   `/home/z/.local/bin` or the corepack shims dir post-wipe; it is not on
   the default PATH). Do not trust a "should pass" — run it, read the output.
5. **Live battery for anything touching agents/projects/tools/streaming**
   per `TESTING.md`: fresh DB, single self-contained invocation (background
   processes die between shell calls — lesson #4), disk assertions as ground
   truth, outcome-based polls.
6. **Browser verification for anything UI** per `TESTING.md`: live stack,
   screenshots at 1920×1080 + tall viewport + mobile, machine-verified via
   the agent-browser skill, zero console errors tolerated.
7. **Live smoke turn against the real provider after any tool/SDK wiring**
   (lesson #9). The only allowed model is `openrouter` · `stealth/ox-alpha`.
   `api.openrouter.ai` is DNS-blocked in the sandbox; the apex
   `https://openrouter.ai/api/v1` is seeded and reachable.
8. **Adjust as you go.** The plan is the map, not the territory. When a
   workstream surfaces an unexpected constraint (a file is larger than the
   plan assumed, a test asserts the old behavior, a dependency is missing),
   **update the plan** (version it v3 with a changelog entry) before
   forcing the code to fit the stale plan. The owner said (R28): *"handling
   things properly along the way, adjusting things as needed, and managing
   them how they are actually meant to be."*

---

## 4. Sub-agent discipline (owner revision 2026-08-23, reaffirmed R28)

- Sub-agents are **OPTIONAL, never a default.** Before dispatching, ask:
  "would doing this inline be simpler and safer?" If yes, do it inline.
- The legitimate uses are: **large parallel research sweeps** (auditing 21
  ADRs, reading 9 reference projects), **exploration across many files**
  (finding every importer of a soon-to-be-deleted component), and **plan
  review** (the three-lens review in §2). Implementation is done inline by
  the orchestrator.
- When you DO dispatch: keep the prompt highly specific, give the agent the
  Task ID + the worklog path, tell it to read prior work before starting and
  append its record after. Max 2 running concurrently (sandbox limit).
- Sub-agent findings are **verified before acting on them.** A sub-agent
  that says "file X is orphaned" gets a `grep -r "import.*X"` from you
  before the deletion. (6-d caught this exact pattern in R28 review.)
- If a sub-agent dies at 95%, **finish the integration yourself** rather
  than re-dispatching. Re-dispatch is for total failures, not tail cleanup.

---

## 5. The documentation ritual (definition of done, non-negotiable)

A workstream is not done when the code is green. It is done when ALL of:

- `docs/ui-iterations/round-NN.md` updated with: owner direction quoted,
  per-workstream changes, verification evidence (screenshots, disk asserts,
  CI run id), open items.
- `docs/ui-iterations/README.md` board row for this round updated.
- **ADR** for any non-trivial decision (new dependency, architecture/pattern
  change, policy). Small assumptions → `[ASSUMPTION]` tag, surfaced in the
  next report. ADRs are append-only, never renumbered.
- `docs/runbooks/AGENT-MEMORY.md` appended when a mistake cost real time or
  produced an owner correction (format: mistake → root cause → rule,
  append-only, sequential numbering).
- `HANDOFF.md` §3/§9 refreshed (dates, counts, tip commit, next steps).
- `docs/status.json` refreshed when milestones move (for the public
  dashboard).
- **Worklog snapshot** closes the session: append the session entry to the
  live `/home/z/my-project/worklog.md`, copy it to
  `docs/agent/ORCHESTRATION-WORKLOG.md`, commit "Worklog snapshot refresh:
  <round>", push with the round.
- **Screenshot zip → DASHBOARD repo** (R28 rule, WS-K): UI workstreams
  upload a screenshot zip; non-UI workstreams upload a single `pnpm verify`
  green screenshot. Never to the private ACUTE-CODE repo.

Documentation is not overhead; it is the substrate the next session stands
on. The owner has said the sandbox may wipe again. If the docs are fresh,
the next session is a 20-minute restore. If they are stale, it is a
multi-round re-discovery of everything you already knew.

---

## 6. The verification ladder (escalate confidence per stakes)

Not every change needs the full ladder; pick the rung the risk justifies.

| Rung | When | What |
|---|---|---|
| 1. `pnpm verify` | every commit | lint + typecheck + test + build + license |
| 2. Live battery | touches agents/tools/streaming/storage | fresh DB, single invocation, disk asserts ground truth |
| 3. Browser verification | touches UI | live stack, screenshots 1920×1080 + tall + mobile, agent-browser skill, VLM verify, zero console errors |
| 4. Live smoke turn | tool/SDK wiring changed | real `stealth/ox-alpha` turn through the changed path |
| 5. End-to-end owner-flow | milestone close-out | the canonical proof task for the MS (e.g. R28 MS-3 = "research the streaming system, write findings to a file") |

Skipping a rung to save time is the single most common cause of a sent-back
round. The owner tests everything himself; if you did not, he will find what
you missed.

---

## 7. The push / backup / notify ritual (in order, every green milestone)

1. `pnpm verify` green (seen with own eyes).
2. Secret scan of staged files (patterns; lengths never printed — #14).
3. Repo PRIVATE via API (#15) — closed-source product.
4. Merge work branch → `main` → push → watch CI to SUCCESS (~4–6 min; a
   client Bash timeout is NOT a CI failure — re-query the run id, #8).
5. Screenshot zip → DASHBOARD repo via `pnpm dashboard:publish-screenshots NN`.
6. Worklog snapshot commit + push.
7. **ntfy ruling (R28, lesson #39):** ntfy ONLY on (a) sandbox wipe, or
   (b) a single round close-out notification on explicit owner APPROVE.
   NOT on individual MS verdicts or workstream completions — that is noise.
   `curl -d "<no secrets>" https://ntfy.sh/TASKISDONE`.

---

## 8. The close-out checklist (a round is done when ALL green)

- [ ] Every workstream in the round's master plan marked done per its §18.
- [ ] `pnpm verify` green on the final commit.
- [ ] `pnpm docs:check` green (after WS-J lands).
- [ ] `pnpm verify:round NN` green (after WS-L lands; requires agent-browser
      + VLM — see its Prerequisites).
- [ ] CI green on the final commit (run id recorded in round file).
- [ ] Screenshot zips (UI workstreams) OR verify-green screenshot (non-UI)
      uploaded to DASHBOARD repo.
- [ ] `docs/ui-iterations/round-NN.md` complete with evidence.
- [ ] `docs/agent/ORCHESTRATION-WORKLOG.md` snapshot appended.
- [ ] `docs/status.json` refreshed.
- [ ] `HANDOFF.md` §3 + §8 + §9 refreshed.
- [ ] `AGENT-MEMORY.md` lessons appended for every mistake that cost time.
- [ ] Owner verdict: APPROVE / CHANGES / PIVOT.
- [ ] If APPROVE: one ntfy `Round NN complete — owner approved` to
      `https://ntfy.sh/TASKISDONE`. If CHANGES/PIVOT: no ntfy — iterate.

---

## 9. Anti-patterns (things that get rounds sent back)

- **Rushing.** "It compiles" / "the server is up" is never sufficient
  evidence of done (owner, R28: *"each and every single one of the things
  gets handled with proper care, with proper planning, understanding,
  verification"*).
- **Inferring approval from praise.** "Good work" ≠ APPROVE.
- **Leaving things for the next session.** The owner said (R28): *"don't
  leave anything behind for the next sessions."* If scope is too large,
  say so with a plan, never by silent truncation.
- **Truncating the owner's requirements.** He writes 9-item messages; if
  your todo list has 6 items, two were dropped.
- **Planning from memory.** The code drifted since last session; re-read it.
- **Dispatching sub-agents for implementation.** They are for research,
  audit, review. Implementation is inline.
- **Forgetting the pnpm PATH export.** Every Bash call that runs pnpm needs
  `export PATH=/home/z/.local/bin:$PATH` (or the corepack shims dir) first.
- **Live model calls in tests.** Never. AI SDK is mocked in vitest.
- **Secrets in logs/transcripts/error messages.** Never. Print lengths,
  not values (#14).
- **Pushing without confirming the repo is PRIVATE.** Closed-source product.
- **ntfy on every workstream.** Noise; the owner stops reading. R28 rule:
  ntfy only on wipe or round close-out on APPROVE.

---

## 10. When the owner sends it back

A CHANGES or PIVOT verdict is not a failure; it is the system working. The
owner tests everything himself and gates one screen at a time. When he
sends it back:

1. Re-read his message top-to-bottom. Extract every defect into the todo
   list (some messages bundle 5+ defects).
2. Do not get defensive. The owner said (R28): the model is capable; the
   issues are in OUR project code, instructions, setup. Take the feedback
   as a defect in the process, fix the process AND the code.
3. Update the round file with the verdict + the defects + the fixes.
4. Append an AGENT-MEMORY lesson for any mistake that produced the defect.
5. Re-run the full verification ladder for the changed rung — not just the
   one fix. A defect in the chat UI might also mean the streaming test was
   weak; strengthen the test, not just the code.

---

**End of ORCHESTRATOR-METHOD.** Read this every session. It is the
difference between a round the owner approves on the first verdict and one
he sends back twice. Quality over speed, always.
