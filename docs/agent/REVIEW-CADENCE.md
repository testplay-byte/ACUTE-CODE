<!-- last-reviewed: 2026-09-12 round-98 -->

# REVIEW-CADENCE — the round structure

**Status:** normative · **Established:** round-28 (codifies what rounds 9–27
proved) · **Companion to:** `ORCHESTRATOR-METHOD.md` (the cognitive method),
`WORKFLOW.md` (the mechanical spine)

A **round** is one owner-feedback cycle. It starts with an owner message and
ends with an explicit owner verdict (APPROVE / CHANGES / PIVOT). Between those
bookends, the orchestrator works the owner's requirements through a stable
structure that has produced good results across 28 rounds. This file
documents that structure so the next 100 rounds have a reliable spine.

---

## 1. What every round produces (definition of done)

A round is not done when the code compiles. It is done when ALL of:

1. **Code changes** on a `work/round-NN-<slug>` branch (ADR-0020 discipline),
   merged to `main` only after verify green.
2. **`docs/ui-iterations/round-NN.md`** evidence file: owner direction quoted,
   per-request changes, verification evidence (screenshots, disk asserts, CI
   run id), open items.
3. **`docs/ui-iterations/README.md`** board row for the round + round-file
   list entry.
4. **ADR** when a non-trivial decision was made (new dependency, architecture
   or pattern change, policy). Small assumptions → `[ASSUMPTION]` tag.
5. **`docs/agent/AGENT-MEMORY.md`** lesson appended when a mistake cost real
   time or produced an owner correction (mistake → root cause → rule).
6. **`HANDOFF.md`** §3 (state) + §9 (next) refreshed.
7. **`docs/status.json`** refreshed when milestones moved (for the public
   dashboard).
8. **Screenshot zip → DASHBOARD repo** via `pnpm dashboard:publish-screenshots
   NN` (R28 rule — screenshots go to the PUBLIC dashboard, not the private
   ACUTE-CODE repo). UI workstreams upload screenshots; non-UI workstreams
   upload a single `pnpm verify` green screenshot.
9. **Worklog snapshot**: append the session entry to the live
   `/home/z/my-project/worklog.md` + copy to
   `docs/agent/ORCHESTRATION-WORKLOG.md`; commit "Worklog snapshot refresh:
   round-NN"; push with the round.
10. **CI green** on the final commit (record the run id in the round file).
11. **ntfy** ONLY on (a) sandbox wipe, or (b) a single round close-out
    notification on explicit owner APPROVE. NOT on individual workstreams or
    MS verdicts (R28 ruling — that is noise).

---

## 2. The round lifecycle (start to verdict)

### Phase A — Inception (one owner message)
1. Owner sends a long section-by-section message with requirements.
2. Orchestrator re-reads it top-to-bottom and extracts EVERY numbered
   requirement into a todo list (lesson #3 — dropping item #7 of 9 is the
   most common cause of a sent-back round).
3. Orchestrator reads the state files: `HANDOFF.md` §3 + `AGENT-MEMORY.md`
   (ALL lessons) + the tail of `ORCHESTRATION-WORKLOG.md` + the round board.

### Phase B — Planning (before any execution)
4. Research the current code (read files, quote line numbers — a plan from
   memory drifts; the code moved).
5. Write the plan as a versioned doc (`docs/ROUND-NN-MASTER-PLAN.md` or
   `plan-*.md`). Structure per workstream: owner's words quoted verbatim →
   current anatomy with line numbers → proposed change (additive, surgical)
   → files touched → verification → risks + mitigations.
6. Dispatch parallel review sub-agents (OPTIONAL per AGENTS.md, but
   mandatory for any plan >3 workstreams): architecture + UX + risk/find-flaws
   lenses. Apply their fixes to the plan (v2 changelog).
7. Owner reviews the plan if it's a phase-level scope; for round-level
   UX/quality work, the orchestrator proceeds to execution.

### Phase C — Execution (per milestone)
8. Sequence workstreams by dependency, not by ease. Governance first, then
   UX in the order the owner listed the complaints, then agentic-quality,
   then tooling, then cadence.
9. One workstream = one commit = one verify gate. Each green milestone gets
   a WIP commit+push on the work branch (lesson #33: a sandbox wipe must
   never cost more than one milestone).
10. Code inline, with tests, AI SDK mocked (no live model calls in the test
    suite — ever).
11. `pnpm verify` green, seen with your own eyes.
12. Live battery for anything touching agents/projects/tools/streaming.
13. Browser verification for anything UI (agent-browser + VLM).
14. Live smoke turn against the real provider after any tool/SDK wiring.

### Phase D — Close-out
15. `docs/ui-iterations/round-NN.md` complete with evidence.
16. ORCHESTRATION-WORKLOG snapshot appended.
17. status.json refreshed.
18. HANDOFF §3 + §8 + §9 refreshed.
19. AGENT-MEMORY lessons appended for every mistake that cost time.
20. Commit + push to main + watch CI to SUCCESS.
21. Screenshot zip → DASHBOARD repo.
22. **Owner verdict**: APPROVE / CHANGES / PIVOT.
23. If APPROVE → one ntfy `Round NN complete — owner approved` to
    `https://ntfy.sh/TASKISDONE`. If CHANGES/PIVOT → no ntfy, just iterate.

---

## 3. Milestones within a round

Large rounds split into **milestones** (MS-1, MS-2, …). Each MS is a
verifiable chunk of related workstreams. The owner gates each MS (or the
whole round if the MSes are small). MS structure:

- MS opening: list the workstreams + the owner's words for each.
- Each workstream: a sub-section with files touched + verification.
- MS close-out: verify green + live battery/screenshots + round-file
  evidence + push.

The R28 plan had 5 MS (A1+A2+B+C+K1 → D1+D2+D3 → F → G1+G2+H →
I+J+K2+L+M). Smaller rounds may have 1-2 MS.

---

## 4. Sub-agents (OPTIONAL — owner revision 2026-08-23)

Sub-agents are NEVER a default. Before dispatching, ask: "would doing this
inline be simpler and safer?" If yes, do it inline.

Legitimate uses:
- **Large parallel research sweeps** (auditing 21 ADRs, reading 9 reference
  projects).
- **Plan review** (the 3-lens review: architecture + UX + risk).
- **Exploration across many files** (finding every importer of a
  soon-to-be-deleted component).

Implementation is done inline by the orchestrator. When you DO dispatch:
keep prompts specific, give the Task ID + worklog path, max 2 concurrent.
Verify findings before acting on them (a sub-agent that says "X is orphaned"
gets a `grep -r "import.*X"` from you before the deletion).

---

## 5. Question protocol

Batch once per round when genuinely needed: numbered, ≤10, each
`[BLOCKING]`/`[NON-BLOCKING]` with a recommended default. Check docs and
code first — never ask what's already answered.

---

## 6. Sandbox wipe recovery (R28 rule)

If the sandbox is wiped between sessions:
1. **Do NOT attempt autonomous recovery.** The owner re-supplies credentials.
2. ntfy the owner: `curl -d "ACUTE-CODE sandbox wiped — re-supply credentials
   to resume" https://ntfy.sh/TASKISDONE`.
3. Stop. Wait for the owner.

This rule exists because autonomous recovery burns a full round on env
restoration when the owner would rather supply credentials + direct the work.
The GitHub backup (private repo + public DASHBOARD) means nothing is lost.

---

## 7. The anti-rush principle (owner, R28)

*"Quality over speed or time. Take as much time as needed."* If you ever
feel pressure to skip a step "to save time," that is the moment to slow down
MORE. The owner can tell the difference from the output alone. A round that
rushes gets sent back; a round that takes the time gets approved.

Corollary (R28): *"don't leave anything behind for the next sessions.
Complete everything in this exact same one now."* A round closes only when
the close-out checklist (§1) is green. If scope is genuinely too large,
surface that honestly with a plan, never by silent truncation.
