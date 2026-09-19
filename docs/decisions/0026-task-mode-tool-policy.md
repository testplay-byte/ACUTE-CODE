<!-- last-reviewed: 2026-09-19 round-108 -->
# ADR-0026: Task-mode tool policy — hard enforcement with owner pinning

- **Status:** ACCEPTED
- **Date:** 2026-09-07 (round 75; ADR written round 76)
- **Tags:** none (owner-directed)

## Context

The owner's 0.74.0 field report: "the following do not work properly: plan,
debug, build, review, explore, refactor… When I had it set to plan mode, it
did not only plan, but it also tried to make edits to the files." The R73
task modes were PROMPT-ONLY postures — the mode body said "NO EDITS" in
prose while the turn's toolset still carried `write_file` / `edit_file` /
`run_command`, so any model that ignored the prose simply edited files.
Only the older permission-mode tier (full/ask/plan/editor, R50-c1,
ADR-adjacent allowlist intersection) was hard-enforced, and the two "Plan"
pills sat side-by-side in the composer, indistinguishable to the owner.

Constraints: enforcement must be a NARROWING (a mode must never widen a
session's toolset), must compose with the existing gates (agent allowlist,
delegation depth, permission mode, custom-mode `tools` frontmatter), must
govern builtin + external + MCP tools uniformly through the one
`buildProjectTools` chokepoint, and must keep `switch_mode` available in
read-only modes (ADR-0019 dark-tools honesty: the prompt must not advertise
a tool the turn cannot call — and vice versa).

## Options considered

- **Option A — prompt-only hardening** (rewrite the mode bodies with
  stronger wording). Pros: zero code. Cons: the exact mechanism that just
  failed; prose cannot stop a model that ignores it.
- **Option B — approval-tier gating** (route write tools through the
  approval engine and auto-deny in read-only modes). Pros: reuses ADR-0024.
  Cons: file tools do not pass through approvals today (only `run_command`
  and web gates do); adding them changes the approval contract for every
  mode, not just read-only ones.
- **Option C — allowlist intersection at turn assembly** (the
  permission-mode mechanism, one tier up). Pros: single chokepoint, proven
  semantics (narrow-only, NO_TOOLS sentinel), the prompt's `toolNames`
  derives from the same list for free. Cons: none observed.

## Decision

**Option C: a pure policy module (`agents/mode-policy.ts`) consulted by
`prepareTurn` AFTER the R73 frontmatter narrowing.** plan/review/explore
intersect the turn's allowlist to read-only sets (plan = `PLAN_MODE_TOOLS`
verbatim, moved here as the canonical home; review/explore add the git
inspectors + `analyze_image` + `job_status`); debug keeps the full toolset
but `run_command` demotes to the AUTO tier in `approvals.ts` (ask-tier
commands DENIED with an honest switch_mode note even under Full-Access
permission — the task mode outranks the widening, denylist-supreme
ordering); build/refactor pass through; a custom mode shadowing a
read-only builtin id still gets the policy intersection (frontmatter ∩
policy). Delegated children COPY the parent's `activeMode` at creation
(the R50-c1 rule one tier down — delegated work can never outrun the
owner's posture).

**Owner pinning** (the live-e2e addition): the first live plan-mode test
showed the model discovering its read-only toolset and calling
`switch_mode("build")` to escape and keep editing. `switch_mode` now
REFUSES to leave or clear plan/review/explore ("a read-only posture the
OWNER set — ask the owner to switch"); every non-read-only switch is
unchanged. The mode bodies were rewritten from instruction-only ("NO
EDITS") to instruction+fact ("ENFORCED, not advisory: write tools are
REMOVED from your toolset — you literally cannot call them").

## Consequences

- Easier: reasoning about mode safety (the toolset IS the policy; the
  model never sees a write tool it cannot call), picker honesty (the
  `/modes` route gained `readOnly` so the frontend never duplicates the
  set), sub-agent safety (children inherit the posture).
- Harder: a user who wants a "plan mode that can scaffold one file" must
  switch modes explicitly (by design — the owner asked for exactly this
  rigidity); custom read-only shadows cannot re-add write tools.
- Must do: keep the policy map, `PLAN_MODE_TOOLS`, and the debug tier in
  sync with new tools (a new mutating tool must be excluded from
  read-only sets deliberately); `r75-mode-policy.test.ts` (27) pins the
  contract.
- Reversal cost: LOW — delete the policy map and the two call sites; the
  system degrades gracefully back to R73 prompt-only behavior.
