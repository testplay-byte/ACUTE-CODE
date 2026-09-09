# Task-Mode Consolidation — Implementation Spec (RESEARCH, no code changed)

**Task ID:** 4 (Research Agent A) · **Date:** 2026-09-09 · **Base:** commit 6e9e3d7 (R80.5 docs round on top of 6f512aa "R80 close-out")
**Directive being spec'd:** REPLACE the two user-facing selectors — (1) the six task modes (R73/R75) and (2) the four permission modes (R50-c1) — with ONE unified picker of exactly THREE operating modes: **Full Access / Plan / Ask**. The six posture bodies survive as INTERNAL posture guidance the agent self-selects in Full Access/Ask. Custom `.acute/agents/*.md` modes preserved as an extension surface if feasible.

Every file/line/identifier below was verified by reading the source. Nothing is guessed; where a choice is open it is flagged **[DECISION]**.

---

## §1 Current-state map — every touchpoint of both systems

### 1.1 System A: Task Modes (R73 core, R73-b integration, R75 hard enforcement)

#### `agent-core/src/agents/modes.ts` (645 lines) — the posture core
Exports (all consumed elsewhere — grep-verified):

| Export | Line | Consumed by |
|---|---|---|
| `interface TaskMode` | 84 | runtime.ts:55 (type), mode-policy.ts:57 (type) |
| `interface CustomModeDiagnostic` | 113 | modes.ts internal + tests |
| `CUSTOM_MODES_CAP = 8` | 131 | tests (r73-modes-core) |
| `CUSTOM_MODE_BODY_CAP = 16_000` | 133 | tests |
| `CUSTOM_MODE_DESC_CAP = 500` | 135 | tests |
| `BUILTIN_MODES: ReadonlyArray<TaskMode>` | 337–392 | runtime (via resolveEffectiveModes), server.ts:180, plugins/modes.ts:37, tests pin `EXPECTED_IDS = ["plan","debug","build","review","explore","refactor"]` (r73-modes-core.test.ts:111) |
| `BUILTIN_MODE_COUNT` | 395 | tests only |
| `resolveEffectiveModes(projectRoot?)` | 587 | runtime.ts:1241, server.ts:1729 + 2590, plugins/modes.ts:124/156 |
| `findMode(modes, id)` | 612 | runtime.ts:1252, server.ts:2591, plugins/modes.ts:125/169/195 |
| `renderModeDiagnostics(diags)` | 623 | tests only today |

Internals: `PLAN_MODE_BODY` (160), `DEBUG_MODE_BODY` (196), `BUILD_MODE_BODY` (218), `REVIEW_MODE_BODY` (240), `EXPLORE_MODE_BODY` (275), `REFACTOR_MODE_BODY` (306) — the six prose modules (~1.5–2.6 KB each; the bodies are the OWNER-VALUED content that must survive). `discoverCustomModes` (420, `.acute/agents/*.md` + frontmatter `name/description/tools`), `slugify` (400), caps and `TOOL_SLUG_RE` (156). Custom mode with id equal to a builtin id SHADOWS the builtin (line 598).

#### `agent-core/src/agents/mode-policy.ts` (154 lines) — the R75 hard enforcement
| Export | Line | Consumed by |
|---|---|---|
| `PLAN_MODE_TOOLS` (15 read-only tool ids) | 70–95 | runtime.ts:133–134 (re-export + use), mode-policy itself, tests (permission-modes.test.ts:152) |
| `TASK_MODE_READ_ONLY = {plan, review, explore}` | 113 | plugins/modes.ts owner-pin; server.ts:29 → `readOnly` flag in GET /modes (1739); tests pin `["explore","plan","review"]` (r75:114) |
| `TASK_MODE_TOOL_POLICY` | 122–126 | `narrowAllowListByTaskModePolicy` |
| `narrowAllowListByTaskModePolicy(allowList, activeTaskMode)` | 136–149 | runtime.ts:1268 |
| `isReadOnlyTaskMode(modeId)` | 152–154 | server.ts:29, plugins/modes.ts:36 |

`READ_ONLY_EXTRAS` (104–110): `git_status, git_diff, git_log, analyze_image, job_status`. Policy map: `plan → PLAN_MODE_TOOLS`; `review`/`explore → PLAN_MODE_TOOLS + READ_ONLY_EXTRAS`; `debug`/`build`/`refactor`/custom → no narrowing (debug's gate lives in approvals.ts).

#### `agent-core/src/tools/plugins/modes.ts` (219 lines) — the `switch_mode` tool
- `modesPlugin` (65, id `"core-modes"`), tool `name: "switch_mode"` (82). Registered in `tools/registry.ts` `BUILT_IN_PLUGINS` (line 134) and re-exported by `tools/index.ts:58`. Always registered (declaration-context pattern; gated on `toolDeps` at execute).
- Three call shapes: `{mode:"<id>"}` ACTIVATE (194–214: `updateSessionActiveMode` + returns the body ONCE + `activationReminder` via `renderReminder({kind:"task-mode",…})`), `{mode:"none"|"off"|"auto"|""|null}` DEACTIVATE (179–192, `CLEAR_SENTINELS` line 47), `{}` LIST (158–176).
- **OWNER-PIN logic (112–141):** while `session.activeMode` is read-only (`isReadOnlyTaskMode`), any model-initiated switch away or clear is refused with the "a read-only posture the OWNER set" note.
- Reads `getSession` (107), writes `updateSessionActiveMode` (187, 205) — both from `storage/sessions.ts`.

#### `agent-core/src/agents/runtime.ts` (3,192 lines) — the composition chokepoint
- Imports: `findMode, resolveEffectiveModes, type TaskMode` (55); `narrowAllowListByTaskModePolicy` (135); `PLAN_MODE_TOOLS` re-export (133).
- `modeAllowList(mode)` (146–150): permission-mode → allowlist. `"plan"`→`PLAN_MODE_TOOLS`; `"editor"`→`TOOL_NAMES` minus `run_command`; `"ask"`/`"full"`→undefined.
- `sessionToolAllowList(session, agent, depth?)` (160–186): agent allowlist → delegation-depth (children at cap lose `delegate_task`) → permission-mode intersection; empty product → `NO_TOOLS` sentinel.
- `effectiveToolNames(db, session, agent)` (198–210): context-meter route's projection of the same list.
- `narrowAllowListByTaskMode(allowList, activeTaskMode)` (232–257): the R73 custom-mode frontmatter `tools` intersection (only `source === "file"` modes; validates names against `TOOL_NAMES`).
- `prepareTurn` (~1104–1421):
  - 1151 `const permissionMode = session.permissionMode;`
  - 1202 `permissionMode` rides `toolDeps` (→ approval gates).
  - 1233 `allowListWithMode = sessionToolAllowList(session, agent, depth)`
  - 1241 `modeResolution = resolveEffectiveModes(project?.rootPath)`
  - 1249–1259 `activeTaskMode` resolution from `session.activeMode`; stale custom mode → `updateSessionActiveMode(db, id, null)` + `clearedModeNote`.
  - 1260 `allowListWithTaskMode = narrowAllowListByTaskMode(allowListWithMode, activeTaskMode)`
  - 1268 `allowListWithModePolicy = narrowAllowListByTaskModePolicy(allowListWithTaskMode, activeTaskMode)` — **the composition order: agent allowlist → delegation depth → permission mode → custom-mode frontmatter → task-mode policy.**
  - 1269–1272 `buildProjectTools(root, allowListWithModePolicy, toolDeps)`; prompt `toolNames` derives from the same object (1278–1283).
  - 1306–1307 `modeHints = computeModeHints(turnUserMessage, modeResolution.modes)` (advisory "Task signal" line).
  - 1352 `permissionMode` → prompt ctx.
  - 1379–1383 `taskModes` index → prompt ctx; 1384 `modeHints`; 1392–1395 `activeTaskMode {id,name,body}` + `clearedModeNote`.

#### Approvals (`agent-core/src/approvals.ts`, 968 lines)
- Tier system: `categorize()` (172–203) → `auto | confirm | blocked | destructive` (`ToolPermission` + "destructive"; AUTO_PREFIXES 60–86 read-only/build/test; BLOCKED 116–130 denylist-supreme; DESTRUCTIVE_PATTERNS 133–137 always-ask). `decideCommand` (310–346) adds project "always allow" rules + R45 path containment.
- `requestCommandApproval` (543–703) — the gate order:
  1. deny (blocked) — 552;
  2. run (auto/rule) — 555;
  3. **R75 debug task-mode tier (571–577): `getSession(...)?.activeMode === "debug"` → ASK-tier commands DENIED** with the switch_mode note — checked BEFORE full-mode widening;
  4. **R50-c1 full widening (584–589): `deps.permissionMode === "full"` → auto-approve**;
  5. non-interactive fail-fast (591–596);
  6. interactive wait (approval row + notification + 120 s).
- `requestWebFetchApproval` (839–967): same shape; full widening at 857–862. `decideWebFetch` (808–831) + `DEFAULT_WEB_HOST_ALLOWLIST` (714–767).
- `ApprovalRequestDeps.permissionMode?: PermissionMode` (524).

#### `agent-core/src/tools/approval-deps.ts` (57 lines)
`buildApprovalDeps(toolDeps)` (32–56) — `permissionMode` is a **LIVE GETTER** re-reading the session row (R64-d mid-turn mode change honored). Also `tools/index.ts` `ToolDeps.permissionMode` (111) and `NO_TOOLS` sentinel (130). `tools/plugins/computer-use.ts:233` reads `toolDeps.permissionMode !== "full"` for the act-consent gate.

#### Storage — `agent-core/src/storage/sessions.ts` (1,108 lines)
- `Session.permissionMode` (30), `Session.activeMode` (41), `Session.taskId` (51); `SessionInput.permissionMode` (64) / `activeMode` (70); `SessionRow.permission_mode` (110) / `active_mode` (113); `PERMISSION_MODE_VALUES` (126).
- `toSession` (128–156): unknown permission_mode reads as `"ask"` (fail-closed); garbage active_mode reads as `null` (fail-open).
- `createSession` (172–239): conditional column insert (`hasActiveMode` 205, pairs 222).
- `updateSessionPermissionMode` (455–468) — the PATCH /permissions writer.
- `updateSessionActiveMode` (478–493) — the PATCH /sessions/:id + switch_mode + stale-sweep writer.
- `forkSession` (~1000–1030): copies `permissionMode` (1010) and `activeMode` (1014) into the fork (INSERT at 1018–1019).

#### Migrations (verified: **NO CHECK constraints** on either column)
- `0020_permission_modes_attachments.sql`: `ALTER TABLE sessions ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'ask';` (line 24) — plain column, no CHECK.
- `0027_task_modes.sql`: `ALTER TABLE sessions ADD COLUMN active_mode TEXT;` (36, nullable) + appends `switch_mode` to template agents' allowlists (38–45) + audit row. No CHECK.

#### Prompts
- `agent-core/src/agents/prompts.ts` ctx fields: `permissionMode` (77), `taskModes` (96), `modeHints` (99), `activeTaskMode` (101), `clearedModeNote` (103).
- `PERMISSION_MODE_PROMPTS: Record<PermissionMode,string>` (837–846) — full/ask/plan/editor one-liners.
- Sections: `permission-mode` (268–273; only when `!== "ask"`), `task-modes` index (527–554, id+name+description + mode-signal line + cleared-mode note), `active-mode` deep module (563–570, body verbatim).
- `agent-core/src/agents/prompt-registry.ts`: entries `permission-mode` (68–72), `task-modes` (139–143), `active-mode` (145–149); order pinned by prompt-registry.test.ts:194–196 (`task-modes` directly after `skills`; `active-mode` directly after `task-modes`).
- `agent-core/src/agents/task-hints.ts`: `computeModeHints` (230) — the R72-a deterministic scorer reused for mode descriptions.

#### Server routes (`agent-core/src/server.ts`, 5,086 lines)
- `GET /projects/:id/modes` (1723–1742): metadata only (id/name/description/source/**readOnly** via `isReadOnlyTaskMode`).
- `PATCH /sessions/:id` (2544–2626): `{ title?, activeMode?: string|null }` — validates activeMode against `resolveEffectiveModes` (2590–2591), 400 with `availableModes`.
- `PATCH /sessions/:id/permissions` (2636–2664): `{ mode }` validated against `PERMISSION_MODES` (shared) → `updateSessionPermissionMode`.
- `GET /sessions/:id/context` (context meter): `buildSystemPromptSections({... permissionMode: session.permissionMode})` at 2740.
- `readComposerSendFields` (563–660): **composer sends carry ONLY `thinkingLevel` + `attachments` (+ `content`, `model`)** — no mode fields; mode is PATCHed before/at send. `ComposerSendFields` interface (547).
- SSE stream route (3860+): approval.requested/resolved, text/tool frames, subagent events, debug analyst frames — **no mode-switch frames** (mode changes are PATCH + session-row reflected).

#### Delegation — `agent-core/src/agents/orchestrator.ts`
`createChildSession` (843–877): child copies `permissionMode: parent.permissionMode` (864) and `activeMode: parent.activeMode` (871) — the "delegated work can never outrun the owner's posture" rule (R50-c1 + R75).

### 1.2 System B: Permission Modes (R50-c1)
- `shared/src/index.ts`: `PermissionMode = "full" | "ask" | "plan" | "editor"` (37), `PERMISSION_MODES` (40), `ToolPermission` (21).
- Enforcement: `modeAllowList`/`sessionToolAllowList` (runtime 146–186) + approvals widening (full) + prompts narration.
- Storage: `sessions.permission_mode` (migration 0020, default `'ask'`).
- `editor` semantics: everything except `run_command`.

### 1.3 Frontend touchpoints
- `src/lib/api.ts`: re-export `PermissionMode` (20); `Session.permissionMode?/activeMode?` (236–242); `patchSessionPermissions` (1848–1856, PATCH `/sessions/:id/permissions` `{mode}`); `TaskModeInfo` (1869–1883, incl. `readOnly?`); `fetchProjectModes` (1894–1897, GET `/projects/:id/modes`); `patchSessionActiveMode` (1909–1917, PATCH `/sessions/:id` `{activeMode}`).
- `src/components/project-chat/AgentChatPanel.tsx` (2,932 lines):
  - `modesQuery = useQuery(fetchProjectModes)` (1673–1678).
  - State: `permissionMode` (1691, `session?.permissionMode ?? "ask"`), `activeTaskMode` (1698, `session?.activeMode ?? null`), `taskModePatching` (1703); sync effects 1715–1722.
  - `onModeChange` (1737–1767): optimistic + `patchSessionPermissions` + rollback.
  - `onTaskModeChange` (1776–1809): optimistic + `patchSessionActiveMode` + rollback.
  - `/mode` slash: `ModeSlashCommand` (155), `parseModeSlash` (167), `resolveModeByWord` (184), `applyModeSlash` (1815–1849, local toasts only, never sends a turn); slash detection at send entry (1949).
  - First-send carry: re-PATCH `permissionMode` (2065–2067) and `activeTaskMode` (2077–2079) before the stream POST when a session was just created.
  - Composer props 2398–2408.
- `src/components/project-chat/composer/Composer.tsx`: props (101–154) — `permissionMode/onModeChange/taskModes/activeTaskMode/onTaskModeChange/taskModeDisabled`; renders `ModeSwitcher` (601) + `TaskModePicker` (605–612) in the left cluster.
- `src/components/project-chat/composer/ModeSwitcher.tsx` (127 lines): 4-mode dropdown (icons via `ICONS` map).
- `src/components/project-chat/composer/TaskModePicker.tsx` (224 lines): posture pill ("Mode: Auto" default, `AUTO_LABEL` 34), per-id icons (22–29), read-only badge, "custom" chip.
- `src/components/project-chat/composer/composer-utils.ts`: `ModeOption` (104), `MODE_OPTIONS` (113–138: full/ask/plan/editor with labels + descriptions), `modeOption` (140).
- Fixtures: `src/lib/session-fixtures.ts` has no permissionMode/activeMode (fields optional in `Session`).
- Mode badges in chat UI: none in `ChatView.tsx` (only the composer pills). `stream-store.ts` has no mode frames.

### 1.4 Test files pinning the current behavior (grep-verified counts)
agent-core/tests: `r73-modes-backend.test.ts` (107 hits), `r75-mode-policy.test.ts` (66), `permission-modes.test.ts` (47), `r73-modes-core.test.ts` (43), `approval-deps.test.ts` (19), `r73-system-reminders.test.ts` (4), `prompt-registry.test.ts` (6), `prompts-overrides.test.ts` (2), `r70-prompt-round.test.ts` (2 — permissionMode "editor"/"plan" ctx gating of FILE EDITING lines), `context-report.test.ts` (1 — ctx `permissionMode:"plan"`), `r65-honesty-patch.test.ts` (1 — ctx `permissionMode:"ask"`), plus light references in `storage.test.ts`, `migration-0020.test.ts`, `memory-tools.test.ts`, `models-catalog.test.ts`, `r52-plugin-registry.test.ts`, `r73-skills-round.test.ts`, `projects-tools.test.ts`, `r71-prompt-discipline.test.ts`.
Frontend: `TaskModePicker.test.tsx` (19), `AgentChatPanel.test.tsx` (7 — the R73-c mode-panel suite at ~1283–1400), `Composer.test.tsx` (3), `api.test.ts` (2 — `patchSessionPermissions` "plan" pin at ~1376).
E2E (`tests/e2e/sidecar.e2e.test.mjs`): uses run-mode `"single"` only — unaffected.

Docs that describe the current system (must be updated in the implementation round): `docs/decisions/0026-task-mode-tool-policy.md` (ADR — needs superseding ADR), `docs/runbooks/EXTENSIBILITY.md` (task-mode sections at lines 22, 113, 205–260, 347, 505–519), `docs/architecture/api/IMPLEMENTED-API.md` (PATCH /permissions + GET /modes + PATCH /sessions activeMode), `docs/decisions/0019` (allowlist truth), `AGENTS.md`/`README.md` if they enumerate modes (verify during implementation).

---

## §2 The unified-mode design

### 2.1 The three modes

| id (wire value) | Display name | Semantics | Tool policy | Approval behavior |
|---|---|---|---|---|
| `full` | **Full Access** | All tools; agent decides autonomously whether to research/plan/build/debug/edit; **no approval prompts ever** (denylist-supreme refusals remain — sudo/rm -rf/curl still hard-blocked) | no narrowing (undefined) | every ASK tier auto-approves (today's `full` behavior in approvals.ts:584/857) |
| `plan` | **Plan** | Read-only: plan/read/research/web/todos/memory/delegation; **cannot edit project files or run mutating commands** | `PLAN_MODE_TOOLS` intersection (today's plan permission + task-mode policy merged) | run_command/web gating moot (tools absent); denylist behavior unchanged |
| `ask` | **Ask** (default) | Full tool access BUT approval gates before important commands/changes | no narrowing | today's `ask` behavior exactly (interactive wait, 120 s, notifications) |

**[DECISION — RECOMMENDED] Keep the ids `full`/`ask`/`plan`** (they already exist on the wire, in the DB, and in `PermissionMode`); the union simply loses `editor`. Display labels stay "Full Access / Ask / Plan". Alternative `full_access` id rejected: it would force remapping every stored row + shared union + every test for zero semantic gain.

### 2.2 Policy mapping table (old → new)

**Permission mode:**
| old | new | rationale |
|---|---|---|
| `full` | `full` | identity |
| `ask` | `ask` | identity (default) |
| `plan` | `plan` | identity (absorbs old plan semantics verbatim) |
| `editor` | `ask` | **fail-closed**: editor had no terminal at all; `ask` is the only new mode that gates commands. Editing remains available in all three modes, so nothing is lost except "never even ask about commands" — the closest safe mapping. (Do NOT map to `full`: that would silently GRANT unattended terminal access the owner never had.) |

**Task mode (`active_mode`) → posture (internal guidance, no enforcement):**
| old active_mode | posture retained? | permission mapping on migration |
|---|---|---|
| `plan` | yes (posture) | if session was read-only-by-posture, set `permission_mode='plan'` when the old permission was `ask`/`editor`/`full` (all were read-only in practice under R75) |
| `debug` / `build` / `refactor` | yes (posture) | permission unchanged (these never gated tools — debug only gated ask-tier commands; that gate is retired) |
| `review` / `explore` | yes (posture) | same as `plan`: owner had a read-only posture → `permission_mode='plan'` |
| custom `.acute/agents/*.md` id | yes (posture, incl. frontmatter `tools` narrowing) | permission unchanged (custom tools-list narrowing continues to compose as posture-level narrowing **only in Full/Ask**; see §6 risk) |
| `null` | — | permission from the table above |

**[DECISION — flag to owner]** whether a session that had `activeMode='review'|'explore'` + `permissionMode='ask'` should become `plan` (read-only) or `ask` (the postures no longer enforce). Recommendation: **→ `plan`** (the owner demonstrably wanted read-only; erring read-only is fail-closed; they can switch to Ask in one click).

### 2.3 The posture-guidance mechanism (Full Access / Ask)

**[DECISION — the single biggest design decision, see §8-recommendation]** Two viable mechanisms:

- **Option A (RECOMMENDED) — `switch_mode` becomes a posture-only self-selection.** Keep the tool, keep `sessions.active_mode` as the *active posture pointer*, keep the ACTIVE MODE prompt section. Strip ALL policy coupling: `TASK_MODE_TOOL_POLICY`/`narrowAllowListByTaskModePolicy` deleted (postures never touch the allowlist in Full/Ask; in unified `plan` the permission gate already narrows), the R75 debug tier in approvals deleted, the owner-pin block in plugins/modes.ts deleted (a posture change can no longer change safety properties, so pinning is moot). The prompt's TASK MODES index is rewritten as "OPERATING POSTURES — self-select on the basis of the task; switching is free and encouraged as the task's shape changes". The six bodies survive verbatim except their "Iron law … ENFORCED (R75) … OWNER-PINNED" paragraphs must be rewritten to posture language ("in Full Access you MAY act on this; the posture disciplines HOW, not what's possible"). Delegation children keep copying `activeMode` (posture guidance inherits; harmless).
- **Option B — postures become skills**: move the 6 bodies into the skills system (`read_skill` progressive disclosure), delete `switch_mode`, `active_mode`, the prompt sections, and plugins/modes.ts entirely. Smaller prompt, but loses the "persistent posture rides the prompt" semantics the R73 design deliberately built, breaks `.acute/agents` compat, and is a bigger blast radius (migration must null the column, tool registry changes, TOOLS list changes).

Option A preserves the owner-valued prose with the smallest diff; Option B is the "cleanest" end-state. **This spec details Option A** (Option B deltas noted per file).

### 2.4 Custom modes (extension surface)
Preserved unchanged as `.acute/agents/*.md` postures: discovery, shadowing, caps, diagnostics all stay (`modes.ts` untouched except body text edits). The frontmatter `tools` list continues to narrow the allowlist **while that posture is active** — now ONLY as an additional narrowing on top of the unified mode (a custom posture in `plan` mode intersects with `PLAN_MODE_TOOLS`; in `full`/`ask` it is the only narrowing). `GET /projects/:id/modes` stays as the posture-metadata source (agent-side + any future UI); the `readOnly` flag becomes `false`-always (or is dropped — the pickers no longer badge it).

---

## §3 File-by-file change list

### Backend

| # | File | Change | Size | Risk |
|---|---|---|---|---|
| 1 | `shared/src/index.ts` | `PermissionMode` → `"full" \| "ask" \| "plan"`; `PERMISSION_MODES` → 3 values; doc comment rewrite. | ~10 lines | **HIGH** (type flows everywhere; compile-driven) |
| 2 | NEW `agent-core/src/storage/migrations/0029_unified_modes.sql` | `UPDATE sessions SET permission_mode='ask' WHERE permission_mode='editor';` then `UPDATE sessions SET permission_mode='plan' WHERE active_mode IN ('plan','review','explore');` then `UPDATE sessions SET active_mode=NULL WHERE active_mode IN ('plan','debug','build','review','explore')` **[DECISION: see §2.2 — Option A keeps active_mode, so this last statement is dropped]**; audit_log row. No CHECK constraints exist to alter (verified). | ~25 lines | MEDIUM (data migration; must be idempotent + tested like migration-0020.test.ts) |
| 3 | `agent-core/src/storage/sessions.ts` | `PERMISSION_MODE_VALUES` → 3; `toSession` remap `editor`→`ask` (un-migrated DBs fail-closed); `SessionInput`/docs; `createSession` default `"ask"` unchanged; `forkSession` unchanged (copies both fields); **Option A: keep `updateSessionActiveMode`** (posture writer). | ~20 lines | LOW |
| 4 | `agent-core/src/agents/mode-policy.ts` | **Gut the module → one exported `PLAN_MODE_TOOLS` + `narrowAllowListByPermissionMode`.** Delete `TASK_MODE_TOOL_POLICY`, `TASK_MODE_READ_ONLY`, `narrowAllowListByTaskModePolicy`, `isReadOnlyTaskMode`, `READ_ONLY_EXTRAS` (or keep `isReadOnlyTaskMode` returning false — see #10). Update header docs. | ~-60 lines | MEDIUM (4 consumers: runtime, server, plugins/modes, tests) |
| 5 | `agent-core/src/agents/runtime.ts` | `modeAllowList`: drop `editor` branch; `sessionToolAllowList`/`effectiveToolNames` type narrow; `prepareTurn`: delete line 1268 (`narrowAllowListByTaskModePolicy` call — Option A) or keep posture narrowing only for `full`/`ask` **[DECISION: simplest = delete entirely; frontmatter `tools` narrowing via `narrowAllowListByTaskMode` (1260) remains]**; ctx `permissionMode` narration now 3-valued. | ~30 lines | **HIGH** (the chokepoint; golden fixture + byte-identity pins) |
| 6 | `agent-core/src/approvals.ts` | Delete the R75 debug tier block (571–577). `PermissionMode` union shrinks (comment at 524). Full widening (584, 857) unchanged — now means unified Full Access. | ~-15 lines | LOW |
| 7 | `agent-core/src/tools/plugins/modes.ts` | Delete owner-pin block (112–141) and its `isReadOnlyTaskMode` import. Rewrite tool description: posture self-selection ("internal posture guidance; does not change your tool access — the owner's mode picker does"). `DEACTIVATED_OUTPUT`/activation reminder text updates. | ~40 lines | MEDIUM |
| 8 | `agent-core/src/agents/modes.ts` | Rewrite the 6 bodies' "Iron law/ENFORCED (R75)/OWNER-PINNED" paragraphs (plan:166, debug:202, review:246, explore:281) to posture prose; update module header + descriptions to posture-selection voice. **Keep all exports/shape.** | ~80 lines of prose | LOW (pure text; r73-modes-core pins check structure not prose — verify) |
| 9 | `agent-core/src/agents/prompts.ts` | `PERMISSION_MODE_PROMPTS`: 3 entries, rewrite "full" body to include autonomous posture selection + "plan" absorbs task-mode plan narration; permission-mode section gate `!== "ask"` stays. TASK MODES section (527–554) → "OPERATING POSTURES (self-select with switch_mode)" voice; ACTIVE MODE section (563–570) header + lead-in line reworded (no "set via the mode picker"). | ~60 lines | MEDIUM (golden fixture r61 must be regenerated if it includes these sections — **verified: the golden fixture does NOT include task-modes/active-mode/permission-mode** (rg found no hits in `fixtures/prompt-golden-r61.txt`); r70/r71 prompt tests do pin permission-mode-gated tool lines — those survive) |
| 10 | `agent-core/src/agents/prompt-registry.ts` | Entry descriptions for `permission-mode`/`task-modes`/`active-mode` reworded (ids stay — `.acute/prompts/*.md` override compatibility). | ~6 lines | LOW |
| 11 | `agent-core/src/server.ts` | `GET /projects/:id/modes`: drop `readOnly` flag (or always false). `PATCH /sessions/:id` activeMode path unchanged (posture validation). `PATCH /sessions/:id/permissions`: validation now via the 3-value `PERMISSION_MODES` (rejects `editor` with a clear 400 — old clients get an honest error). Context route 2740 unchanged. | ~15 lines | LOW |
| 12 | `agent-core/src/tools/index.ts` + `tools/registry.ts` | No change (switch_mode stays registered). Doc-comment touch-ups only. | ~5 lines | LOW |
| 13 | `agent-core/src/agents/orchestrator.ts` | No code change (copies both fields; posture inheritance is desired under Option A). Comment update at 859–871. | ~5 lines | LOW |
| 14 | `agent-core/src/tools/approval-deps.ts` | No change (live getter still works — union narrower). Comment touch. | ~3 lines | LOW |

### Frontend

| # | File | Change | Size | Risk |
|---|---|---|---|---|
| 15 | `src/lib/api.ts` | `PermissionMode` re-export auto-narrows (from shared). `patchSessionPermissions` unchanged (route same). `TaskModeInfo.readOnly` field removed. `patchSessionActiveMode`/`fetchProjectModes` **kept only if any UI still consumes postures — under the unified picker nothing does → delete both + `TaskModeInfo`** (Option A UI: no posture UI). | ~-40 lines | MEDIUM |
| 16 | `src/components/project-chat/composer/composer-utils.ts` | `MODE_OPTIONS` → 3 entries (full/ask/plan) with owner-directed descriptions ("All tools, no permission asks — the agent decides how to work", "Read-only — research and plan, no edits or commands", "Full tools; asks before important commands and changes"). `modeOption` fallback index unchanged (points at `ask`). | ~10 lines | LOW |
| 17 | `src/components/project-chat/composer/ModeSwitcher.tsx` | Icons: drop `editor`/`clipboard` variants as needed; aria-labels fine. | ~5 lines | LOW |
| 18 | `src/components/project-chat/composer/TaskModePicker.tsx` | **DELETE** (+ its test). | ~-224 lines | LOW |
| 19 | `src/components/project-chat/composer/Composer.tsx` | Remove `taskModes/activeTaskMode/onTaskModeChange/taskModeDisabled` props + `<TaskModePicker>` render (605–612). | ~-20 lines | MEDIUM (props threading) |
| 20 | `src/components/project-chat/AgentChatPanel.tsx` | Delete `modesQuery` (1673–1678), `activeTaskMode`/`taskModePatching` state (1698–1703), sync effect (1720–1722), `onTaskModeChange` (1776–1809), `/mode` slash (`ModeSlashCommand` 155, `parseModeSlash` 167, `resolveModeByWord` 184, `applyModeSlash` 1815–1849, slash detection 1949), the first-send activeMode re-PATCH (2077–2079), Composer props (2406–2408). `permissionMode` state/onModeChange/first-send PATCH (2065–2067) STAY. | ~-120 lines | **HIGH** (2,932-line god file; careful diff) |
| 21 | `src/lib/session-fixtures.ts` / `agent-fixtures.ts` | No change required (fields optional); optionally add `permissionMode` defaults. | 0–5 lines | LOW |

### Migrations + docs

| # | File | Change | Size | Risk |
|---|---|---|---|---|
| 22 | NEW `migrations/0029_unified_modes.sql` | See #2. Companion `agent-core/tests/migration-0029.test.ts` (pattern: migration-0020.test.ts). | ~80 lines w/ test | MEDIUM |
| 23 | `docs/decisions/0029-unified-operating-modes.md` (NEW ADR) | Supersedes the picker halves of ADR-0026 + the R50-c1 picker; documents the 3 modes, posture self-selection, editor→ask mapping rationale. | ~80 lines | LOW |
| 24 | `docs/runbooks/EXTENSIBILITY.md`, `docs/architecture/api/IMPLEMENTED-API.md`, `docs/runbooks/PROMPT-MODULES.md` (permission-mode/task-modes/active-mode entries), `AGENTS.md` if it lists modes | Update the mode descriptions, remove the user-facing posture picker references, note `.acute/agents` = posture library for self-selection. | ~60 lines | LOW |

**Estimated total:** ~500–700 changed lines backend+frontend+tests (Option A); roughly double if Option B.

---

## §4 Test impact inventory

| Test file | What pins must change |
|---|---|
| `agent-core/tests/r73-modes-core.test.ts` | Structure pins (order, caps, shadowing, diagnostics) SURVIVE under Option A. Only prose-derived assertions (if any body-text checks) + `EXPECTED_IDS` stays valid. **Verify; likely ~0–10 line changes.** |
| `agent-core/tests/r73-modes-backend.test.ts` | The 107-hit suite: GET /modes `readOnly` flags (645), PATCH activeMode (555–558), switch_mode owner-pin refusals (~760–840), prepareTurn policy integration (202–269 prompt sections), `BUILTIN_MODES` body "ENFORCED" text (1014). Rewrite to posture semantics; keep the route/round-trip pins. **~40% of the suite changes.** |
| `agent-core/tests/r75-mode-policy.test.ts` | **The core R75 suite — mostly DELETED/rewritten**: `TASK_MODE_READ_ONLY` pin (114), allowlist narrowing (129+), debug command tier (286–325), owner pin (406–440), delegation inheritance (341–358 — becomes "children copy posture pointer, no tool effect"). Keep only the permission-plan narrowing tests (move into permission-modes.test.ts). **~80% rewritten.** |
| `agent-core/tests/permission-modes.test.ts` | `modeAllowList("editor")` pin (153) removed; 4-value loops (203, 270) → 3; delegation inheritance (511–527) stays; approval-widening (414–492) stays. **~15% changes.** |
| `agent-core/tests/approval-deps.test.ts` | Live-getter tests stay (full/ask). Add a case: legacy `editor` row reads as `ask` post-migration. ~5 lines. |
| `agent-core/tests/prompt-registry.test.ts` | Section-order pins (194–196) stay (ids unchanged). Registry-completeness pins stay. ~0 lines. |
| `agent-core/tests/prompts-overrides.test.ts` | permission-mode override tests stay (gating `!== "ask"` unchanged). ~0–5 lines. |
| `agent-core/tests/r70-prompt-round.test.ts` | editor-mode tool-gating case (483–489) → delete or convert to plan; plan case stays. ~10 lines. |
| `agent-core/tests/context-report.test.ts`, `r65-honesty-patch.test.ts` | ctx `permissionMode` values stay valid ("plan"/"ask"). ~0 lines. |
| `agent-core/tests/r73-system-reminders.test.ts` | task-mode reminder kind stays (posture switch notice). ~0 lines. |
| NEW `agent-core/tests/migration-0029.test.ts` | editor→ask, read-only-posture→plan, idempotency, audit row. ~80 lines. |
| `src/components/project-chat/composer/TaskModePicker.test.tsx` | **DELETE** (component gone). |
| `src/components/project-chat/Composer.test.tsx` | Remove TaskModePicker assertions/props; MODE_OPTIONS count 4→3. ~20 lines. |
| `src/components/project-chat/AgentChatPanel.test.tsx` | Delete the R73-c mode-panel suite (1283–1400: activeMode sync, optimistic PATCH, /mode slash). Keep permission-mode tests. ~-120 lines. |
| `src/lib/api.test.ts` | `patchSessionPermissions` "plan" pin stays; remove any TaskModeInfo/fetchProjectModes/patchSessionActiveMode tests. ~-20 lines. |
| Golden fixture `fixtures/prompt-golden-r61.txt` | **Verified unaffected** (no task-modes/active-mode/permission-mode content — those sections are ctx-gated and the golden ctx omits them). |
| `tests/e2e/sidecar.e2e.test.mjs` | Unaffected (run-mode only). |

---

## §5 Wire / API compatibility

**Recommendation: keep every route + field name; only the VALUE SET shrinks.**

- `PATCH /sessions/:id/permissions` — body `{ mode: "full" | "ask" | "plan" }` (was 4 values). Old `editor` value → **400 VALIDATION** with a message naming the mapping ("editor was removed — use ask"). The 400 shape is the existing `errorBody("VALIDATION", …)` convention.
- `PATCH /sessions/:id { activeMode }` — **[DECISION]** Under Option A keep it (posture pointer, still validated against `resolveEffectiveModes`); it is no longer called by the shipped UI but remains the switch_mode/CLI surface. Under Option B remove.
- `GET /projects/:id/modes` — stays (posture metadata; `readOnly` removed or always false).
- Composer send body (`POST /sessions/:id/messages[/stream]`) — **unchanged**: `{ content, model?, thinkingLevel?, attachments? }`. Mode was never a send field (it rides the session row via PATCH); the unified picker keeps that contract, so `readComposerSendFields` needs no change.
- `Session` JSON: `permissionMode` now 3-valued; `activeMode` semantics become "posture pointer" (Option A) — both field names stay, so cached older UI builds degrade gracefully (they may render an Editor option that the server will reject on PATCH — the honest 400 handles it).
- `shared` `PermissionMode` union: frontend + sidecar compile against the same package, so both must ship in lockstep (the monorepo does this today).

**Exact new request shape (no change):**
```jsonc
PATCH /api/v1/sessions/:id/permissions   { "mode": "full" | "ask" | "plan" }
PATCH /api/v1/sessions/:id               { "activeMode": "<posture-id>" | null }   // Option A only
GET   /api/v1/projects/:id/modes         { "modes": [{ id, name, description, source }] }
```

---

## §6 Risks + edge cases

1. **Owner-pinned read-only sessions (the R75 guarantee) disappear at the posture tier.** A session migrated to `plan` IS still hard read-only (permission gate). But a Full/Ask session whose owner had *pinned* plan-by-task-mode silently regains write tools unless migration maps read-only postures → `plan` (spec'd in §2.2). **The migration's `active_mode IN ('plan','review','explore') → permission_mode='plan'` statement is the safety net — do not skip it.**
2. **Custom modes with frontmatter `tools` can still narrow** in Full/Ask (if `narrowAllowListByTaskMode` is kept). That preserves the extension surface but means "Full Access" is not literally always-full. Alternative: drop frontmatter narrowing too (then `.acute/agents` files are pure prompt bodies). **[DECISION — recommend KEEP; it is opt-in per project file and only narrows.]**
3. **Custom mode shadowing a builtin id** ("plan") continues to shadow; under the unified design a custom "plan" posture no longer implies read-only — only `permissionMode='plan'` does. Document in EXTENSIBILITY.md.
4. **Delegation inheritance:** children copy `permissionMode` (keep — the "never outrun the owner's mode" rule) and `activeMode` (posture guidance; Option A keeps). A `plan` parent's children stay read-only via the permission copy — the R50-c1 line still holds with no orchestrator change.
5. **Mode switch events:** none exist on SSE today (verified); mode changes are PATCH + session-row. The stale-custom-mode sweep (runtime 1249–1259) still clears vanished postures with the one-turn note. No new frame types needed; old sessions reload with the migrated row.
6. **Old sessions / old clients:** un-migrated DBs: `toSession` remaps `editor`→`ask` at read time (fail-closed) so a pre-0029 database opened by new code is safe; migration 0029 makes it durable. Old frontend builds (if any cached) can send `editor` and get an honest 400.
7. **Byte-identity / golden pins:** the permission-mode prompt section only renders when mode ≠ ask, so default-ask sessions compose byte-identically. Task-modes/active-mode sections are ctx-gated — the golden fixture is unaffected (verified). r70/r71 tool-gating pins survive because plan-mode toolset is unchanged.
8. **The R75 debug command tier removal** means a Full-Access session in a "debug" posture can run ask-tier commands unattended. Accepted by design (postures are guidance-only in Full/Ask); note in the ADR.
9. **`switch_mode` in PLAN_MODE_TOOLS:** the read-only set includes `switch_mode` (mode-policy.ts:94). Under Option A this stays correct (posture switching is an observation-level act) — but if the posture picker semantic changes, re-check the PLAN-mode prompt line "consider switch_mode FIRST" (mode-policy comment 88–93; prompts task-modes signal line 543–545).
10. **Editor-mode orphans:** agents' `allowedTools` rows were never permission-mode-scoped (migration 0027 only appended `switch_mode`), so no agent-row cleanup is needed for editor removal.
11. **Two "Plan" concepts** could confuse: unified Plan mode (permission) vs "plan" posture (self-selected in Full/Ask). Prompt wording must clearly separate "you are in PLAN MODE (owner-set, read-only)" from the plan posture body.

---

## §7 Recommended implementation order (smallest safe steps)

1. **Step 0 — decide** the two [DECISION]s: (a) posture mechanism Option A vs B (§2.3); (b) migration mapping for read-only postures + editor (§2.2 — recommended: read-only posture→plan, editor→ask).
2. **Step 1 — shared union + storage remap** (`shared/src/index.ts`, `sessions.ts` `PERMISSION_MODE_VALUES` + `toSession` editor→ask). Compile; fix only type errors. (No behavior change yet: editor is rejected on PATCH, read as ask.)
3. **Step 2 — migration 0029 + test** (`migration-0029.test.ts`). Data-only; behavior-neutral.
4. **Step 3 — runtime de-coupling:** delete the `narrowAllowListByTaskModePolicy` call (runtime.ts:1268), the debug tier (approvals.ts:571–577), and `modeAllowList("editor")`. Prompt still says old text (harmless for one step). Run r75/permission suites — expect the documented failures; update tests in the same commit.
5. **Step 4 — mode-policy.ts slim-down + switch_mode de-pin** (plugins/modes.ts 112–141 removal, tool description rewrite). r75-mode-policy.test.ts rewritten to the permission-only core.
6. **Step 5 — prompts** (`PERMISSION_MODE_PROMPTS` 3 entries, task-modes/active-mode section rewording, registry descriptions, the 6 posture bodies' enforcement paragraphs). Run prompt suites + r73 suites.
7. **Step 6 — server routes** (readOnly flag, editor 400 message, activeMode route docs).
8. **Step 7 — frontend**: composer-utils MODE_OPTIONS → 3; delete TaskModePicker + its test; Composer props; AgentChatPanel mode-state surgery; api.ts TaskModeInfo/readOnly cleanup. Frontend tests updated.
9. **Step 8 — docs**: ADR-0029, EXTENSIBILITY, IMPLEMENTED-API, PROMPT-MODULES; `node scripts/docs/check-stale.mjs` gate.
10. **Step 9 — full gates**: `pnpm -r test` (agent-core + frontend + shared), `scripts/smoke.mjs`, CI watch. Manual live check: switch modes mid-session (the live-getter path), delegation from plan parent, old-session reload.

---

## §8 The single most important design decision

**What happens to `switch_mode` + `sessions.active_mode` (the posture mechanism).** Option A (keep as non-enforcing posture self-selection — recommended: preserves all six bodies, `.acute/agents` compat, delegation inheritance, and the ACTIVE MODE prompt section, with the smallest diff) vs Option B (fold postures into skills and delete the whole tier — cleaner end-state, bigger blast radius). Everything else in this spec is mechanical once that is fixed.
