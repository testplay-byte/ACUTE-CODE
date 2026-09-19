<!-- last-reviewed: 2026-09-19 round-108 -->
# Round 81 — The Unified Operating Modes (one picker, three modes)

**Provenance:** the owner's verbatim directive (the R81 session):

> "there are six task modes which are okay, but they do not seem good. There
> are also other options for access, like what level of access to give: edit
> files freely, plan, ask, full access. What I would like to do is to combine
> these two options together into one single option."

The three modes, verbatim from the owner's message: **Full Access** ("full
access to everything… it will decide based on the task what it needs to do…
it can switch between them along the way too… it won't be asked for any
permissions"), **Plan** ("only able to plan, read files, do research… it
won't be able to edit files"), **Ask** ("full access too to make edits and
changes… but it will ask for any commands which might be important").

The plan is `agent-ctx/R81-plan.md`; the research basis is
`agent-ctx/research/task-mode-consolidation.md` (the file-by-file spec every
change below was built against). The design decision — Option A of the
spec's §8 — is recorded in **ADR-0029**.

**Everything is implemented, unit-tested (net −13 consolidated pins),
live-verified on the real provider, browser-verified + VLM-passed, and
version 0.80.0.**

---

## 1. The one-picker redesign

| before (two selectors) | after (ONE selector) |
|---|---|
| ModeSwitcher: Full Access / Ask / Plan / Editor (R50-c1) | ModeSwitcher: **Full Access / Ask / Plan** — THE operating mode |
| TaskModePicker: "Mode: Auto" + the 6 postures + custom pills (R73-c) | **DELETED** — postures are agent-side self-selection (switch_mode) |

- `shared` `PermissionMode` = `"full" \| "ask" \| "plan"`; `PERMISSION_MODES`
  3 values; "editor" retired (migration 0029 + read-time remap → "ask",
  fail-closed).
- The composer's LEFT cluster (R77) is now attach + THE mode picker (the
  owner's left-side pair).
- `MODE_OPTIONS` descriptions carry the owner's semantics verbatim: Full
  Access "the agent decides how to work (research, plan, build, debug) and
  switches postures itself"; Ask "full tools; asks before important commands
  and changes"; Plan "read-only — research and plan, no edits or commands".

## 2. Enforcement moves entirely to the operating mode

- `mode-policy.ts` gutted to `PLAN_MODE_TOOLS` — which now ALSO carries the
  retired review/explore read-only extras (`git_status`/`git_diff`/`git_log`/
  `analyze_image`/`job_status`): the unified PLAN mode is the sole read-only
  tier, so it holds the full read-only vocabulary. Deleted:
  `TASK_MODE_TOOL_POLICY`, `narrowAllowListByTaskModePolicy`,
  `TASK_MODE_READ_ONLY`, `isReadOnlyTaskMode`, the R75 debug command tier
  (approvals), the switch_mode owner-pin.
- `modeAllowList(mode)` (runtime): plan → the read-only set; full/ask →
  undefined. `sessionToolAllowList`/`effectiveToolNames` take the 3-value
  union.
- Migration **0029_unified_modes.sql**: `editor`→`ask`;
  `active_mode IN (plan/review/explore)`→`permission_mode='plan'` (the R75
  read-only guarantee preserved — those sessions WERE read-only in
  practice); `active_mode` kept as the posture pointer. Idempotent, audited;
  pinned by `tests/migration-0029.test.ts`.
- Wire: `PATCH /permissions` validates 3 values; `editor` → 400 + the honest
  hint ("mode 'editor' was removed in R81 — use 'ask'…"); `GET /modes`
  `readOnly` always false (kept for cached-client compat).

## 3. Postures become agent self-selection

- `switch_mode` survives as the posture surface: the tool description now
  reads "Postures are GUIDANCE, not permissions… Analyze the task, pick the
  matching posture, and switch freely as the task's shape changes."
- The prompt sections reworded: `## OPERATING POSTURES (self-select with
  switch_mode)`, `## ACTIVE POSTURE — {name}`, `## OPERATING MODE` (the
  permission-mode section, 3-entry narration map).
- The six builtin bodies keep their discipline prose; the R75
  "ENFORCED/OWNER-PINNED" paragraphs became "Discipline, not permission
  (R81)" paragraphs — in PLAN mode the tools are absent (hard); in
  Full/Ask the posture shapes HOW the agent works.
- Custom `.acute/agents/*.md` modes + frontmatter `tools` narrowing survive
  untouched (ADR-0029's extension-surface commitment).

## 4. Frontend surgery

- `TaskModePicker.tsx` + its test **deleted** (224+19 lines).
- `AgentChatPanel.tsx` 2,932 → 2,743 lines: task-mode state, the
  `/mode` slash intercept, the first-send activeMode carry, the modes query,
  and the picker props all removed; the permission-mode surface (the unified
  picker's PATCH path) stays exactly as R50-c2 built it.
- `api.ts`: `TaskModeInfo`/`fetchProjectModes`/`patchSessionActiveMode`
  removed (60 lines — no shipped consumer remains; the backend routes stay
  as the posture surface).
- `Composer.tsx`: task-mode props gone; the left cluster renders the single
  picker.

## 5. Verification (every gate, seen with our own eyes)

- **Unit**: agent-core 1,795/1,795 (r75-mode-policy → r81-mode-policy
  rewritten: 25 tests; permission-modes 3-value loop + editor-400 hint case;
  r73-modes-backend posture pins; golden fixture regenerated — 2 lines, the
  sanctioned UPDATE_GOLDEN=1 path). Root suite 2,739 passed / 12 skipped.
- **e2e**: 12/12 (built sidecar, black-box).
- **Typecheck + lint**: clean.
- **Live battery** (real OpenRouter, fresh scratch DB, real SSE):
  - PLAN turn asked to create a file → the model ATTEMPTED `write_file`
    (free-tier models do this), the call could not execute (the tool is
    absent from the turn's registry — enforcement at the chokepoint), no
    file written, and the turn ended with the honest "this session is in
    PLAN mode (read-only) and no file-writing tool is available".
  - FULL turn → `write_file` executed, `full-proof.txt` written.
  - ASK turn → auto-tier commands ran, ask-tier commands refused (the
    approval gates live).
  - `switch_mode` → posture self-selection persisted
    (`activeMode=explore`), then the agent explored with read-only tools.
  - Migration 0029 audit row + bookkeeping on the fresh DB; `editor` PATCH →
    400 + hint.
- **Browser** (dev stack, agent-browser): the composer renders exactly one
  picker; the menu lists EXACTLY Full Access / Ask (default, checked) /
  Plan; switching Plan → Full Access round-trips the label; zero console
  errors. **VLM pass** on the menu screenshot: all five checklist items
  confirmed (three options, no Editor, no Task mode pill, Ask marked
  default, clean unbroken layout).

## 6. What the owner should check next

- The single picker's three modes against his three descriptions (the
  MODE_OPTIONS text is his, verbatim).
- A PLAN session in the app: ask it to edit something — the model cannot
  (and says so honestly).
- Full Access autonomy: give a mixed task ("research X then implement Y")
  and watch the posture switch in the transcript (switch_mode events).
