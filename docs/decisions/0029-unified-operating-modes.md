<!-- last-reviewed: 2026-09-17 round-102 -->
# ADR-0029: Unified operating modes — one picker, three modes

- **Status:** ACCEPTED
- **Date:** 2026-09-09 (round 81; owner-directed)
- **Tags:** modes, permissions, breaking (value-set shrink, fail-closed migration)
- **Supersedes:** the picker halves of ADR-0026 (task-mode tool policy + owner
  pinning) and the R50-c1 four-value permission switcher.

## Context

The owner's R81 directive: the TWO user-facing selectors — the six-builtin
task-mode picker (plan/debug/build/review/explore/refactor, R73/R75) and the
four-value access-level switcher (full/ask/plan/editor, R50-c1) — "are
definitely not good" and must become ONE picker of exactly THREE modes:

- **Full Access** — everything, no permission asks ever; the agent decides
  autonomously whether to research, plan, build, debug, or edit, and switches
  approach as the task's shape changes.
- **Plan** — read-only: plan, read files, research; cannot edit the project.
- **Ask** — full tool access, but asks before important commands/changes.

The postures' guidance prose is valuable and survives — as INTERNAL
self-selection by the agent, not an owner-set permission.

Constraints: the R75 read-only guarantee for historical sessions must not
silently regress; "editor" must map fail-closed; the `.acute/agents/*.md`
custom-mode extension surface should survive; the wire field names stay
(`permissionMode`/`activeMode`) for graceful degradation.

## Options considered

- **Option A — keep `switch_mode` + `sessions.active_mode` as a NON-ENFORCING
  posture pointer.** All enforcement moves to the permission tier (which
  already exists and is proven); the six posture bodies, custom modes, the
  prompt sections, and delegation posture inheritance all survive with the
  smallest diff. Cons: two concepts still exist under the hood (mode vs
  posture), and the prompt must clearly separate them.
- **Option B — fold postures into the skills system and delete the task-mode
  tier entirely.** Cleaner end-state, but ~2× blast radius: breaks
  `.acute/agents` compat, deletes switch_mode, nulls the column, rewrites
  every R73/R75 test.
- **Option C — keep both pickers and merely relabel.** Rejected by the owner's
  explicit "combine these two options together into one single option".

## Decision

**Option A.** Exactly three operating modes on the permission tier
(`full` / `ask` / `plan`; ids unchanged, `editor` retired). ONE picker in the
composer (the R50 ModeSwitcher slot); the TaskModePicker is deleted.

- **Enforcement** lives solely in `modeAllowList` + approvals: `plan` →
  `PLAN_MODE_TOOLS` intersection (now INCLUDING the retired review/explore
  read-only extras: `git_status`/`git_diff`/`git_log`/`analyze_image`/
  `job_status`); `full` → ask-tier auto-approve; `ask` → interactive gates.
  The R75 task-mode policy tier (`TASK_MODE_TOOL_POLICY`,
  `narrowAllowListByTaskModePolicy`, `TASK_MODE_READ_ONLY`, the debug command
  tier, the owner-pin) is DELETED.
- **Postures** are non-enforcing guidance: the agent self-selects via
  `switch_mode` (the tool's description now says so); the prompt sections
  read "OPERATING POSTURES (self-select with switch_mode)" / "ACTIVE
  POSTURE"; the six bodies keep their discipline prose, rewritten from
  "ENFORCED/OWNER-PINNED" to "Discipline, not permission (R81)" — a posture
  in Full/Ask shapes HOW the agent works, while PLAN mode removes the tools
  outright.
- **Migration 0029** (data-only, idempotent): `permission_mode='editor'` →
  `'ask'` (fail-closed: editor had no terminal; ask is the only mode that
  still gates commands — nothing widens); `active_mode IN
  ('plan','review','explore')` → `permission_mode='plan'` (the R75 guarantee,
  preserved — those sessions were hard read-only in practice). `active_mode`
  itself is KEPT as the posture pointer.
- **Read-time remap** (`sessions.ts`): an un-migrated `editor` row reads as
  `ask` — a pre-0029 database opened by new code stays fail-closed.
- **Wire compatibility**: `PATCH /sessions/:id/permissions` rejects `editor`
  with 400 + an honest hint naming the mapping; `GET /projects/:id/modes`
  keeps the `readOnly` field as always-false (posture metadata only);
  `PATCH /sessions/:id { activeMode }` remains the posture surface for
  programmatic use (no shipped UI calls it post-R81).

## Consequences

- The owner's one-click mental model: one picker, three modes, honest
  behavior in each. Full Access agents self-manage postures (the "auto"
  behavior the old picker defaulted to, now explicit in the prompt).
- A session in Full/Ask with a "plan" posture CAN technically edit (the
  posture is prose). The posture bodies say not to; PLAN mode is the hard
  gate. This is the accepted trade for simplicity — documented here and in
  EXTENSIBILITY.md.
- Custom `.acute/agents/*.md` modes keep their `tools` frontmatter narrowing
  (opt-in, narrow-only) — "Full Access" is full modulo an explicit project
  file asking for less.
- Delegation: children copy both fields (mode hard, posture guidance).
- The R75 debug command tier is gone: a debug posture in Full/Ask runs
  ask-tier commands per the OPERATING mode (the posture prose steers toward
  diagnostics-first but no longer denies).
- Verified live (R81 battery): PLAN turn — the model attempts `write_file`,
  the call cannot execute (tool absent from the turn's registry), no file
  written, honest text back; FULL turn — `write_file` executes; ASK turn —
  auto-tier commands run, ask-tier refused; `switch_mode` — posture
  self-selection persists (`activeMode=explore`).
