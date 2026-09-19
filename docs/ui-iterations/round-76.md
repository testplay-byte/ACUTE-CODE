<!-- last-reviewed: 2026-09-19 round-108 -->
# Round 76 — The Documentation Round (Accuracy & Structure)

**Owner's report (verbatim ask):**

> "update the documentation all that stuff so everything is up to date and
> well managed now good luck and make sure everything is accurate and
> properly structured"

A docs-only round: **no code changes, no version bump (stays 0.75.0), no
release.** The method: audit first (two research agents — one sweeping
every doc against the R74/R75 code truth, one backfilling the session
history), then apply every finding with the same verification discipline
as a code round.

---

## The audit findings (what "stale" actually meant)

1. **`docs/agent/ORCHESTRATION-WORKLOG.md` — the session history HANDOFF
   §1 tells every new agent to read as "where the last session ended" —
   STOPPED AT R67.** Eight rounds (R68–R75, including the updater-freeze
   fix and the entire reliability round) had no session entries. The
   "refreshed each session" practice lapsed after R67 while the round
   docs and HANDOFF headers kept moving.
2. **`docs/runbooks/AGENT-MEMORY.md` — the owner-mandated lessons file —
   stopped at lesson #71 (round 58).** Seventeen rounds of lessons were
   unrecorded, including the R74 updater freeze (the biggest field
   incident since the launcher era) and R75's fullStream error-PART find.
3. **The R75 stamp refresh had made docs LOOK reviewed while content
   stayed stale** (the hazard of item 75 below): ARCHITECTURE carried a
   round-75 stamp over a §2.4 that still described a `POST
   /internal/shutdown` route that does not exist and a boot sweep that
   "marks sessions failed" — the exact behavior R75 replaced with the
   visible INTERRUPTED event + queued; its module map predated
   mode-policy/error-classification/retry and implied a WS gateway that
   was never built.
4. **IMPLEMENTED-API (the shipped-surface truth doc) stopped at R73** —
   25 tools vs the real 26, no `/modes` `readOnly`, no `meta.retry`, no
   `attempts`, no ROUND-75 section.
5. **EXTENSIBILITY §2b described the task modes as pure posture** — no
   enforcement addendum; DESIGN-SYSTEM's composer anatomy was pre-R50
   ("pill container + footer"); ROADMAP had been **frozen at round-17**
   (P3 "owner-gated" while delegation/sub-agents/approvals shipped
   rounds 36–58); the docs index was missing five runbooks entirely and
   said "ADRs 0001–0021, next = 0022".
6. **Two missing ADRs:** R75's task-mode hard enforcement and the retry
   ladder were accepted, load-bearing decisions with no record — exactly
   what the repo's own ADR bar ("every non-trivial decision gets an ADR")
   requires.
7. Small truths: HANDOFF/AGENTS/SPEC still said "REST + WS" and
   `stealth/ox-alpha`; HANDOFF §3 still said "round-28 DELIVERED" and
   "must be 65246ca or newer"; the CHANGELOG's Unreleased said "the R75
   queue"; status.json's `plan.upcoming` was a round-32-era phase array.

## The work

**Research first (both agents read the worklog + verified against code
before flagging anything):**
- **R76-a** — the staleness sweep: every doc read against the R74+R75
  truth, returning a 20-item edit list with exact line numbers and
  replacement text, priorities (5 HIGH / 7 MEDIUM / 6 LOW), a
  zero-dead-paths confirmation (docs:check's drift guard passes — every
  gap was content, not links), and the honest note that stamp-only
  refreshes mask content drift.
- **R76-b** — the ORCHESTRATION-WORKLOG backfill: 8 entries (R68–R75)
  written from the round docs + git receipts (`git log v0.67.0..v0.75.0`
  + per-commit stats), matching the file's entry format and voice,
  **pure append (+147/−0)**, with source conflicts resolved in the
  commit/tag evidence's favor and noted (the v0.68.0 tag gap, R69's
  "no release" vs the live release, R75's 172→173 docs:check).

**Then the corrections (15 files edited + 2 ADRs + 5 lessons):**
- `ARCHITECTURE.md` — §2.4 rewritten to the shipped shutdown/sweep
  behavior (no session events at shutdown; boot-time `sweepStaleRunning`
  repairs honestly: INTERRUPTED `turn.error` + queued, R75); Mode 1 gains
  the shipped mode-scoped toolsets line; the provider-call ladder line;
  the module-map note (IMPLEMENTED-API is shipped truth; WS never built).
- `IMPLEMENTED-API.md` — refreshed R73→R75: 26 tools, `/modes`
  `readOnly`, plan = the 14-tool `PLAN_MODE_TOOLS` (canonical home
  mode-policy.ts), the classifier's new home, and a full ROUND-75
  section (the `meta.retry` frame, `attempts`, the honest-502 + INTERRUPTED
  sweep, the error-PART re-throw, the enforcement composition order).
- `EXTENSIBILITY.md` — the R75 enforcement block in §2b (read-only
  intersections, owner-pinned switch_mode, delegation inheritance,
  custom∩policy), the readOnly REST field, a new "R75 addendum" section,
  the code map gains mode-policy.ts.
- `MAINTENANCE.md` — the newest migration (0027), the R75 modules in the
  code map, and **recipe g step 2b: `pnpm docs:check` before commit** —
  the stamp-cohort rule (a mass failure is aging, not rot).
- `DOC-STANDARDS.md` §8 — the cohort-aging rule written where the next
  agent will hit it (stamp-all only ADDS stamps; cohort failures are
  fixed by in-place first-line bumps, diff-verified).
- `HANDOFF.md` — §3 "round-75 CLOSED" (v0.75.0 receipts, the round-28
  table kept as history), ADRs 0001–0025 → continue at 0026+, REST+SSE,
  the current model truth, `66e949a`, the verify chain incl. test:e2e.
- `docs/README.md` — IMPLEMENTED-API/EXTENSIBILITY descriptors carried to
  R75, the ADR next-number truth, and **five previously-unindexed
  runbooks added** (DOC-STANDARDS, ORCHESTRATOR-METHOD, REVIEW-CADENCE,
  PROMPT-MODULES, CLI-HARNESS).
- `SECURITY.md` — run_command's real status (ADR-0024 tiers), control 7:
  the task-mode enforcement tier (composition order, owner pinning).
- `DESIGN-SYSTEM.md` — the composer anatomy rewritten (R50 box, R75
  one-row @container, the 5-line autogrow) + the retry/error card states.
- `ROADMAP.md` — unfrozen: refreshed to round-75 reality (P3 shipped
  progressively R36–R58; the R71–R75 reliability layers; the R76 queue;
  the changelog delegation note).
- `CHANGELOG.md` — Unreleased → "the R76 queue"; `README.md` verify line;
  `API.md` the 502 additive-fields note; `SPEC.md`/`AGENTS.md` the model
  truth; `WORKFLOW.md` — docs:check added to the per-round duties.
- **NEW `docs/decisions/0026-task-mode-tool-policy.md`** — the R75
  enforcement decision (options: prompt-only / approval-gating /
  allowlist intersection; the owner pinning; reversal cost LOW).
- **NEW `docs/decisions/0027-transient-api-retry-ladder.md`** — the
  three-layer composition (SDK maxRetries → overflow recovery → the
  ladder), the error-PART precondition, the ~47-min worst case as the
  owner's explicit choice.
- `AGENT-MEMORY.md` — lessons **#72–#76** (drafts-above-published
  ordering; the non-throw failure channel; flex-1 eating inline heights;
  cohort aging vs content rot; "complete but uncommitted" is a claim).
- `docs/ui-iterations/README.md` — the round list carried from round-67
  to **round-75** (8 rows, the v0.68.0 tag gap noted honestly).
- `docs/status.json` — round 76, plan.current = the docs round, the
  stale phase array replaced with the current gates/queue, milestone 36,
  the R75 detail's docs:check 173/0/0 correction.

## Verification

- `pnpm docs:check` — **173/0/0** (all touched docs stamped round-76;
  the drift guard re-verified: zero dead paths).
- Docs-only round: **no source files touched** — the 2613-test suite,
  lint, and typechecks are unchanged by construction (CI re-runs them on
  the push; watching to green is the standing rule 3).
- `status.json` JSON.parse-gated after the edit; ORCHESTRATION-WORKLOG
  diff verified pure-append (+147/−0); every stamp edit diff-verified
  first-line-only.
- No release: the app is byte-identical to v0.75.0 (release 384282923);
  this round ships documentation only.

## Files

- **NEW:** `docs/ui-iterations/round-76.md`, `docs/decisions/0026-task-mode-tool-policy.md`, `docs/decisions/0027-transient-api-retry-ladder.md`
- **EDITED (content):** `docs/agent/ORCHESTRATION-WORKLOG.md` (R68–R75 backfill), `docs/runbooks/AGENT-MEMORY.md` (+5 lessons), `docs/architecture/ARCHITECTURE.md`, `docs/architecture/api/IMPLEMENTED-API.md`, `docs/architecture/api/API.md`, `docs/runbooks/EXTENSIBILITY.md`, `docs/runbooks/MAINTENANCE.md`, `docs/runbooks/DOC-STANDARDS.md`, `docs/runbooks/SECURITY.md`, `docs/runbooks/ROADMAP.md`, `docs/runbooks/WORKFLOW.md`, `docs/design/DESIGN-SYSTEM.md`, `docs/README.md`, `docs/ui-iterations/README.md`, `docs/status.json`, `HANDOFF.md`, `CHANGELOG.md`, `README.md`, `AGENTS.md`, `docs/specs/SPEC.md`
- **EDITED (stamps only):** every doc touched by the round got its
  `last-reviewed` stamp bumped to round-76.
