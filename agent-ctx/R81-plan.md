# R81 Plan — the unified operating modes

**Directive (owner, verbatim intent):** combine the six-builtin task-mode
picker and the four-value access-level switcher into ONE picker of exactly
three modes — Full Access (everything, no asks, the agent decides how to
work and switches along the way), Plan (read-only: plan/read/research, no
edits), Ask (full tools, asks before important commands/changes).

**Research basis:** `agent-ctx/research/task-mode-consolidation.md` (the
file-by-file spec; Option A chosen — switch_mode/active_mode survive as the
non-enforcing posture pointer). Decision record: ADR-0029.

## Steps (all landed)

1. ✅ shared: PermissionMode 3 values; editor retired.
2. ✅ storage: PERMISSION_MODE_VALUES + editor→ask read-time remap.
3. ✅ migration 0029 + test (editor→ask fail-closed; read-only postures→
   permission plan; active_mode kept; idempotent; audited).
4. ✅ runtime: modeAllowList 3-value (plan only); prepareTurn drops the
   task-mode policy call; effectiveToolNames/sessionToolAllowList types.
5. ✅ approvals: R75 debug command tier deleted.
6. ✅ plugins/modes.ts: owner-pin deleted; posture-self-selection copy.
7. ✅ prompts: PERMISSION_MODE_PROMPTS (3 entries, unified voice); sections
   reworded (OPERATING MODE / OPERATING POSTURES / ACTIVE POSTURE); mode
   bodies' ENFORCED paragraphs → "Discipline, not permission (R81)".
8. ✅ mode-policy gutted to PLAN_MODE_TOOLS (now 19 tools — the retired
   review/explore extras folded in).
9. ✅ server: GET /modes readOnly always false; PATCH /permissions 3 values
   + editor 400 hint.
10. ✅ frontend: MODE_OPTIONS 3; TaskModePicker + test deleted; Composer
    props; AgentChatPanel surgery (slash, state, carries, query — gone);
    api.ts TaskModeInfo/fetchProjectModes/patchSessionActiveMode removed.
11. ✅ tests: r81-mode-policy (25), permission-modes, r73-modes-backend,
    migration-0029, golden fixture (2 lines), storage, r70, context-report,
    r71, prompts-overrides, Composer.test, AgentChatPanel.test, api.test.
12. ✅ docs: ADR-0029, round-81.md, CHANGELOG 0.80.0, HANDOFF, status.json,
    board, EXTENSIBILITY, IMPLEMENTED-API, PROMPT-MODULES, DESIGN-SYSTEM,
    docs/README; docs:check 185/0/0.
13. ✅ verification: root suite 2751 (12 skipped), agent-core 1795, e2e
    12/12, lint, typechecks, live battery (plan/full/ask/switch_mode),
    browser + VLM.

## Live battery receipts

- PLAN turn: write_file attempt CANNOT execute — no file, honest model text.
- FULL turn: full-proof.txt written.
- ASK turn: auto-tier commands run; ask-tier refused.
- switch_mode: posture persisted (activeMode=explore).
- Migration 0029: audit row + bookkeeping on fresh DB; editor → 400 + hint.
