<!-- last-reviewed: 2026-09-11 round-90 -->
# Round 73 — the task modes round: the agent now carries posture modules it switches on the basis of the task (six built-in stances, custom modes from .acute/agents/*.md, three access paths, twenty skills, one reminder renderer)

**Date:** 2026-09-07 · **Branch:** `main` · **Version:** 0.73.0 ·
**Provenance:** no new owner field report — R73 answers the owner's
standing directive ("adding proper detailed system prompts which the
agent accesses when required and on the basis of the task and such like
various in built skills"). R72 answered its skills half
("various in-built skills" — the 18-skill library, the deterministic
task-signal line, references depth); R73 completes the architecture the
directive implies with the POSTURE tier: a mode is a detailed
system-prompt module that changes HOW THE AGENT APPROACHES a class of
work — what it refuses to do first (edit, theorize, widen, praise), what
it must produce before anything else (a spec, a reproduction, a safety
net, a map), what "done" means in that stance. The R73-plan design
turned it into four workstreams in three waves: **a** (the modes core —
six builtin posture bodies + custom-mode discovery), **d** (the
generalized system-reminder renderer + skills 18→20, parallel wave 1),
**b** (the backend integration — prompt sections, the switch_mode tool,
the REST surface, the turn threading), **c** (the frontend — the
composer picker + the /mode slash). One deliberate deferral, recorded:
`delegate_task` task_id/background/resume moves to R74 — the
orchestrator is the most delicate concurrency surface and the owner's
own "don't rush" applies; modes is the named directive.

| ID | Workstream | Files owned |
|---|---|---|
| a | Modes core: TaskMode, six builtin POSTURE bodies (plan/debug/build/review/explore/refactor), custom-mode discovery `.acute/agents/*.md` (frontmatter name/description/tools, caps, diagnostics, shadowing), resolveEffectiveModes (pure + sync) | NEW `agent-core/src/agents/modes.ts`, NEW `agent-core/tests/r73-modes-core.test.ts` |
| d | The generalized system-reminder injector (ONE renderer + the per-turn ReminderBudget; dir-conventions migrated BYTE-IDENTICALLY) + two new builtin skills (spec-planning, performance — 18→20) | NEW `agent-core/src/agents/system-reminders.ts`, `agent-core/src/tools/dir-conventions.ts`, `agent-core/src/storage/skills.ts`, NEW `agent-core/tests/r73-system-reminders.test.ts` + `r73-skills-round.test.ts`, re-pins `r72-skills-expansion` + `r71-skills-round` + `r70-skills-system` |
| b | Backend integration: prompt-registry +2 sections (task-modes index + active-mode deep body, both after skills, strictly ctx-gated), prompts composition + mode-hints line, computeModeHints (shared scorer), sessions.active_mode + migration 0027, PATCH /sessions/:id activeMode + GET /projects/:id/modes, prepareTurn threading (stale-mode sweep + custom-mode tool narrowing), NEW switch_mode tool + registration | `agent-core/src/agents/prompt-registry.ts`, `agent-core/src/agents/prompts.ts`, `agent-core/src/agents/task-hints.ts`, `agent-core/src/agents/runtime.ts`, `agent-core/src/storage/sessions.ts` + `agents.ts`, NEW `agent-core/src/storage/migrations/0027_task_modes.sql`, NEW `agent-core/src/tools/plugins/modes.ts`, `agent-core/src/tools/index.ts` + `registry.ts`, `agent-core/src/server.ts`, NEW `agent-core/tests/r73-modes-backend.test.ts`, strengthened `prompt-registry`/`storage`/`projects-tools`/`r52-plugin-registry`/`memory-tools`/`models-catalog` tests |
| c | Frontend: the composer TaskModePicker (ModeSwitcher's mirror), the /mode slash intercept at the send entry, optimistic PATCH + rollback, the api client surface | `src/lib/api.ts`, NEW `src/components/project-chat/composer/TaskModePicker.tsx` + `.test.tsx`, `src/components/project-chat/composer/Composer.tsx` (seam-only), `src/components/project-chat/AgentChatPanel.tsx` + `.test.tsx` |
| verify | Full CI-mirror verification (this round's counts below) + a LIVE HTTP smoke of the mode routes against a real sidecar spin | — |
| docs | The docs round (this file + the runbooks + CHANGELOG + HANDOFF + IMPLEMENTED-API + TESTING + EXTENSIBILITY + indexes + status.json) + the version bump ×4 | `docs/**`, `CHANGELOG.md`, `HANDOFF.md`, the four version files |

## Why this round (the directive, read literally)

R61/R70/R71/R72 built the agent's capability stack from the bottom up:
methodology (skills — 20 trigger-rich bodies loadable via read_skill),
depth (references/), guidance (the deterministic task-signal line), and
conventions (the root ladder + per-directory reminders). The owner's
directive — "proper detailed system prompts which the agent accesses
when required and on the basis of the task" — names a thing none of
those tiers is: a **detailed system prompt that arrives when the task
calls for it**. A skill body is instructions the agent READS; a mode is
a stance the agent HOLDS. "Fix this bug" doesn't just want the
debugging method nearby — it wants an agent that will not propose a fix
before it can state the root cause in one sentence. "Plan this" wants
an agent that will not touch a file. "Review this" wants one that will
not edit the diff it is judging. R72's matcher even had the trigger
surface already: the descriptions score, but there was nothing to
switch INTO — the posture had nowhere to live. Four gaps, one theme:
**the three-tier architecture the directive implies** — SKILLS =
methodology (R61/R70/R72), MODES = posture (this round), REFERENCES =
depth (R72-c) — with the Task-signal lines (R72-a's deterministic
matcher, extended) naming both a skill AND a mode on the basis of the
incoming message, and nothing auto-activating anywhere (progressive
disclosure stays the contract).

## A — the modes core: six postures + the custom-mode tier (a, D1–D7)

**Root cause:** "operating posture" existed only as prose scattered
inside the prompt's discipline sections — nothing addressable, nothing
switchable, nothing project-customizable. The kilocode/claude custom
modes pattern (`.md` files that define agent stances) had no ACUTE
equivalent.

**Fix (NEW `agent-core/src/agents/modes.ts`, 640 lines):** the
module header writes the division of labor — *SKILLS are METHODOLOGY
(HOW a class of work is executed); MODES are POSTURE (how the agent
HOLDS ITSELF for a class of task: what it refuses first, what it must
produce first, what done means)* — and the pairing rule: every builtin
body ends with a PAIRS WITH line steering toward the skills that carry
its method.

`TaskMode {id, name, description, body, source: "builtin"|"file",
filePath?, tools?, sortOrder}` — the description is the MATCHER-facing
one-liner (the R71 trigger-rich convention: quoted verbatim phrasings
+ NOT-for negative scope, so R73-b's computeModeHints can score it with
the untouched R72-a scorer); the body is the detailed system-prompt
module (the same depth band as a skill body, about behavior not
method). `BUILTIN_MODES` — exactly six postures, sortOrder 10-60,
frozen ARRAY AND entries (immutability by construction; callers share
the objects from resolveEffectiveModes):

| Mode | Desc / Body | The posture it carries |
|---|---|---|
| `plan` | 475 / 2,546 | SPEC-FIRST: the deliverable is a decision-ready spec, not code. Iron law NO EDITS; the 7-question interrogation (goal, scope, non-goals, constraints, interfaces, risks, binary acceptance criteria); the batched-questions-with-defaults budget; the 7-section spec document; present-and-wait (never proceed on silence). PAIRS WITH spec-planning + zero-hallucination |
| `debug` | 469 / 2,159 | DIAGNOSIS-FIRST: reproduce before you theorize. Iron law NEVER propose a fix until the root cause is one sentence + a failing case; REPRODUCE → DIAGNOSE → FIX → VERIFY with the method explicitly delegated to the paired skills ("the full METHOD … is not re-taught here — it lives in the paired skills; load them instead of improvising a shallower version"); hypothesis discipline (one at a time, each a testable prediction); the honesty rule (an unreproduced bug is a rumor — NEVER "fix" what you cannot see); the Escalation section (three failed fix attempts → STOP, report, narrow — R71's 3-strike discipline, tied into the posture). PAIRS WITH debugging + focused-fix |
| `build` | 475 / 2,084 | IMPLEMENTATION: vertical slices, smallest working version first. Iron law VERIFY AFTER EVERY STEP (receipts, not claims); the 5-step order (spec → skeleton → thin end-to-end slice with [HARDCODED] markers → verify → widen); YAGNI as law; commit points are working states only; a failed step's successor is ALWAYS the fix. PAIRS WITH tdd + project-init |
| `review` | 447 / 2,372 | READ-ONLY CRITICAL: findings first, evidence for every claim, no drive-by edits. Iron law NO EDITS (a reviewer who edits is no longer reviewing); the 5-line checklist (correctness, boundaries, security, contracts, tests); the findings format (SEVERITY — file:line — claim — EVIDENCE quoted — the fix; no praise paragraphs); the mandatory WHAT-I-DID-NOT-CHOOSE devil's advocate; the one-line verdict. PAIRS WITH code-review + security-review |
| `explore` | 481 / 2,345 | RECONNAISSANCE: map the territory before anyone touches it. Iron law ZERO EDITS, ZERO SIDE-EFFECTING COMMANDS; what to map (entry points, data flow, invariants, where-X-lives with file:line, topology); the honesty markers ([READ]/[INFERRED]/[UNKNOWN] — "an inferred map presented as a read map is a hallucination with extra steps"); bounded reconnaissance (depth where the question points; a partial map delivered honestly beats a complete one never finished). PAIRS WITH web-research |
| `refactor` | 477 / 2,149 | BEHAVIOR-PRESERVING: characterization tests FIRST, one mechanical move per step. Iron law NO BEHAVIOR CHANGE MEANS NO BEHAVIOR CHANGE (behavior change = switch to build/debug and say so); the 4-step order (safety net → plan → one move + verify → stop when done); the discipline lines (a half-renamed API is a broken API; dead code deleted in its own move); the own-excuses red flags. PAIRS WITH refactoring |

**Custom modes (`.acute/agents/*.md` in the project root — the
kilocode/claude pattern):** frontmatter `name`/`description`/`tools`
parsed by the SAME tolerant parser as file skills
(`parseSkillFrontmatter`/`stripSkillFrontmatter`, reused from
skills-files.ts); the body becomes the active mode's prompt module.
Rules, every one honest and tested: flat `*.md` one level deep;
hidden/underscore files silently skipped (house convention); a
subdirectory or non-regular entry → the "not-a-file" diagnostic (modes
are flat); name = frontmatter (≤64, truncated) else the file stem; id =
slugified name ("Release Notes!" → "release-notes"; empty slug →
skipped); description ≤500 with the honest marker + the
"description-capped" diagnostic, missing → an honest fallback line +
"missing-description" (the mode still loads — but the user must know
the matcher has nothing to match); body ≤16,000 with the house marker
line + "capped", empty → skipped ("empty-body" — a mode with no
instructions is noise); `tools` comma/space-split, trimmed, deduped,
slug-shaped (`^[a-z_][a-z0a9_]*$` — invalid names dropped +
"invalid-tools", stored RAW; semantic validation against the real
registry is the integration wave's); ≤8 customs per project
("too-many-modes", first 8 by file-name order); a same-id custom
collision is a silent first-file-wins (the skills-files taken-name
pattern); files >512KB skipped (bounds the read). **A custom mode
whose id equals a builtin id SHADOWS the builtin** — the user's
override lever, one entry, custom wins. **Trust:** files under
`.acute/agents/` live in the project root — the SAME trust level as
`.acute/prompts/` overrides and `.acuterules` (the prompt-registry's
own words: they do NOT bypass the bearer wall or tool allowlists).

`resolveEffectiveModes(projectRoot?)` — pure + synchronous + fs-scoped
(no db, no server, no async, NEVER throws; the prompt-registry /
skills-files module contract): builtins always; customs only when a
root is given (undefined or "" → builtins only, discovery not
attempted); sorted sortOrder asc then name asc; `findMode` exact
case-sensitive id. The 8 diagnostic kinds render through
`renderModeDiagnostics` (the promptOverrideDiagnostics pattern: one
".acute/agents/<file>: …" line per kind, empty = no news).

**Evidence:** `r73-modes-core.test.ts` (28 tests): the D1 shape pins
(fixed order + sortOrder + frozen array/entries + count; bodies
1,200–3,000 distinct with posture statements; descriptions 280–500
with Use when/quoted phrase/NOT for; PAIRS WITH names real skills; a
computeTaskHints cross-validation — 'fix this bug' → Debug, 'clean this
up' → Refactor, 'plan this for me' → Plan, 'review this' does NOT
surface Build); discovery (happy path with byte-exact stripped body +
absolute filePath + sortOrder 100/101; absent-is-clean; undefined + ""
roots; silent skips; determinism + a zero-writes snapshot proof);
name→id (frontmatter wins, stem fallback, slugify, the 64 cap,
first-file-wins); shadowing (ONE debug entry custom-wins, 5 builtins
intact); caps (16K exact marker + diagnostics toEqual'd, 500, 9
files → 8 + too-many-modes, invalid-tools, dedup); the failure family
(missing-description exact fallback text, empty-body, subdirectory
not-a-file, chmod-000 unreadable — never throws); findMode + all
8 diagnostic kinds rendered.

## B — the reminder renderer + skills 18→20 (d, D1–D7)

**Root cause one:** the R73 queue's own words — "a generalized
system-reminder injector — ONE mechanism for AGENTS.md injections,
mode-switch notices, lessons-ledger affordances instead of bespoke
strings". R72-d shipped the first such reminder (read_file's
per-directory conventions) with a bespoke string builder; R73-b was
about to add a second consumer (switch_mode's activation notice); the
lessons ledger is queued. A bespoke format per consumer would drift
apart — each re-inventing fences, labels, and separation disclaimers,
and each re-inventing its own anti-noise discipline.

**Fix (NEW `agent-core/src/agents/system-reminders.ts`, 134 lines, ZERO
imports — pure):** `renderReminder({kind, label, text})` →
`\n\n--- <label>\n<text>\n<closing fence>` — the R72-d structure
generalized. `ReminderKind` = "conventions" | "task-mode" | "note"
(the generic escape hatch); the closer table per kind (conventions
BYTE-PINNED to the R72-d line; task-mode/note the same shape — name
what ended, disclaim what the reminder is not part of). Pure and dumb:
no caps, no validation, no fs, no db — content policy lives at the
call sites. **The migration is the proof:** `conventionReminder()`
(tools/dir-conventions.ts:140-145) now delegates to
`renderReminder({kind:"conventions", …})` — ONE composition site, the
rest of the file untouched — and `r72-dir-conventions.test.ts` stayed
**20/20 GREEN UNMODIFIED** (run first, before writing anything else,
and again at the end: byte-identity proven, not asserted). Plus
`ReminderBudget` — R71's anti-question-padding / anti-noise
discipline, made reusable: at most `REMINDER_BUDGET_DEFAULT` (3)
DISTINCT reminders per turn, each keyed, instance-scoped (one per
turn, constructed by the turn integration — deliberately not module
state), `mark` idempotent and a no-op at an exhausted budget (the
ledger never lies), nothing ever throws (a reminder, not a gate).

**Root cause two:** the library's stated destination is the reference
repos' breadth with ACUTE's density, and the R72 round file itself
queued "two more skills (performance, spec-planning)" — the two crafts
the mode pairings most wanted (the plan mode's methodology and the
performance conversation ACUTE had no answer for).

**Fix (`storage/skills.ts`, sortOrder 18/19, fixed ids, INSERT OR
IGNORE — fresh AND existing DBs converge on 20; user edits persist;
deletes refused/revive):** `spec-planning` (body 1,898 chars, 26
lines — the spec-as-DECISION-DOCUMENT methodology: the 8 canonical
sections in order with INTERFACES FIRST "because they are the expensive
decisions — other code binds to them"; the ≤5-questions-batched-once-
each-with-a-default budget; the approval gate ("a spec is DONE when
the owner approves it, not when it is long"); the 4-entry
anti-patterns table; ends "Pairs with the plan task mode.") and
`performance` (body 1,895 chars, 30 lines — the measurement-first
methodology: the MEASURE-FIRST iron law ("NO OPTIMIZATION WITHOUT A
BEFORE-NUMBER AND A NAMED BOTTLENECK"); the premature-optimization
red-flags list; the 3-rung profiling ladder cheapest-first; 20/80 +
complexity-before-constants; benchmark receipts with variance noted;
the stop condition). Descriptions 474/479 chars, trigger-rich (6 quoted
phrasings each + Delivers + NOT for).

**Evidence:** `r73-system-reminders.test.ts` (16 tests — byte-identity
for 3 realistic convention inputs + the delegation pin
(renderReminder === conventionReminder over 3 real DirConventions) +
render purity; task-mode/note SHAPE pins; ReminderBudget
allows/mark/idempotence/default-3/custom-max/no-op-at-max/snapshot/
instance purity) and `r73-skills-round.test.ts` (17 tests — the
TWENTY-builtin count pin with names/ids/sortOrders 0-19, per-skill
trigger-rich + house-format it.each over the two, distinctness,
INSERT OR IGNORE idempotence + the deleted-row-revives convergence
→ 20, user-edit persistence, disable-hides, the flow-through: all 20
render in the prompt SKILLS section). **The 18→20 surface mechanically
moved 13 count pins in the three older skills suites — re-pinned
strengthened-only, the R72-b house pattern** (r72-skills-expansion 32
tests count unchanged; r71-skills-round 75→83; r70-skills-system
51→53).

## C — the backend integration: sections, storage, routes, the tool (b, D1–D10)

**Root cause:** the core had no seams — nothing composed the index or
the body into a prompt, nothing persisted an active mode, nothing
switched it, and the model-facing/tool-facing/user-facing surfaces had
to agree on ONE resolution so they could never disagree.

**Fix, in layer order:**

- **The prompt sections (prompt-registry 21→23, both DIRECTLY after
  skills; prompts.ts):** "task-modes" — the INDEX
  (`## TASK MODES (posture modules — activate with switch_mode)` at
  prompts.ts:515-542): the division line ("Skills carry methodology you
  read with read_skill; a task mode changes your operating POSTURE for
  a class of work … nothing auto-activates"), one
  `- id: name — description` line per mode, the per-turn mode signal
  (1 hint → `Task signal: this request looks like the **debug**
  posture — consider switch_mode { mode: "debug" } FIRST.`; 2 →
  "(and possibly **refactor**)"), and the bracketed clearedModeNote
  when a stale custom mode was swept. "active-mode" — the DEEP module
  (prompts.ts:551-558): `## ACTIVE TASK MODE — Debug (debug)` + the
  activation note (ends "Clear with switch_mode { mode: \"none\" }.")
  + the body verbatim — the ONE place a mode body is ever composed;
  everything else stays progressive disclosure. Both ride
  beginSection id-stamping, so `.acute/prompts/task-modes.md` /
  `active-mode.md` overrides work automatically (tested). Both are
  STRICTLY gated on the new ctx fields (taskModes/modeHints/
  activeTaskMode/clearedModeNote, all optional) — **the golden
  fixture is BYTE-STABLE: a ctx without the fields composes
  identically; md5 `3a5d2c7d695149e6031711836a6d698b`, untouched,
  no regen performed or needed.**
- **The matcher extension (task-hints.ts):** the scoring core
  EXTRACTED into `scoreQualified` (:163 — message prep + phrase ×5 +
  stopword-filtered tokens +1 + threshold, today's algorithm verbatim)
  so `computeTaskHints` keeps its signature/shape/tie-break
  (**r72-task-hints 27/27 GREEN UNMODIFIED — the hard gate, run first
  and again at the end**) while `computeModeHints(userMessage, modes)`
  (:230) → `ModeHint{modeId, score}` reuses the same constants, ties
  broken by ID asc (switch_mode addresses ids).
- **The storage + migration:** `Session.activeMode: string | null`
  (garbage reads as null — fail-open to the default posture; create
  starts modeless; fork carries the posture like permissionMode) +
  `updateSessionActiveMode` — the ONE storage-level writer the PATCH
  route, switch_mode, AND the stale sweep all reuse (updated_at bump
  included). Migration `0027_task_modes.sql` (56 lines): the house
  one-shot `ALTER TABLE sessions ADD COLUMN active_mode TEXT` (NULL
  default — every existing session stays exactly today's behavior) +
  the 0026-pattern allowlist append for `switch_mode` (template +
  default-agent rows only; `[]`-means-ALL respected; the COMPANION
  rule — a row whose allowlist lacks read_skill gets nothing appended,
  "a mode-capable agent is one that can read skills"; NOT EXISTS
  idempotency) + the audit_log row.
- **The REST surface (server.ts):** `PATCH /sessions/:id` extended to
  `{ title?, activeMode? }` (each independently optional; absent =
  untouched; null = clear; string = resolved against the session's
  project root — projectless resolves builtins only; **an unknown id
  is a 400 VALIDATION carrying `availableModes`, validated BEFORE any
  write so a bad mode never renames the session as a side effect**;
  title-only callers keep the round-33 behavior). NEW
  `GET /projects/:id/modes` (:1701-1716) → `{modes: [{id, name,
  description, source}]}` — **METADATA ONLY** (bodies are
  prompt-side; GET /skills' honesty — REST never serves a mode body),
  404 unknown project, resolved through the same resolver as
  prepareTurn and switch_mode so picker + prompt + tool can never
  disagree.
- **The tool (NEW `tools/plugins/modes.ts`, 187 lines,
  core-modes/1.0.0):** one tool, `switch_mode {mode?}` — ALWAYS
  REGISTERED (the read_skill declaration-context pattern: the catalog
  declares it with an inert db; the real gate is execute-time
  db+sessionId). Three calls: **absent → LIST** (the index + which
  mode is active + the usage line); **`{ mode: "none" }`** (also
  "off"/"auto"/"" + an actual JSON null) **→ DEACTIVATE**, idempotent
  with an honest no-op when nothing was active; **`{ mode: "<id>" }`
  → ACTIVATE** — the session row's active_mode is set (via
  updateSessionActiveMode, no raw SQL) and the FULL posture guide
  returns ONCE, immediately, followed by the fenced task-mode reminder
  (R73-d's renderReminder — "This guide now rides the ACTIVE TASK MODE
  section of the system prompt every following turn. Deactivate with
  switch_mode { mode: \"none\" }."); from then on the prompt carries
  it. An unknown id → ok:false + the available ids + the
  `.acute/agents/*.md` hint. The tool description teaches the
  schema-clean sentinel `"none"` (not JSON null — a nullable union
  does not validate cleanly on every strict provider; both are
  ACCEPTED, the reliable one is TAUGHT).
- **The turn threading (runtime.ts prepareTurn):** modes resolved ONCE
  before buildProjectTools (`resolveEffectiveModes(project?.rootPath)`,
  :1371); the session's activeMode → findMode; a VANISHED custom mode
  (its file removed) → best-effort `updateSessionActiveMode(null)` +
  the honest one-turn clearedModeNote (:1383-1388 — the session keeps
  running in the default posture instead of silently resurrecting a
  vanished guide); **custom-mode tool narrowing** —
  `narrowAllowListByTaskMode` (:245) intersects the
  post-permission-mode allowlist with a FILE-mode's `tools` list:
  NARROW-ONLY (never widens — the permission-mode rule, one step
  later), names validated against the real TOOL_NAMES (unknown names
  drop honestly; a custom mode can never conjure a tool that doesn't
  exist), all-unknown or empty intersection → the NO_TOOLS sentinel
  (buildProjectTools treats [] as ALL — the same empty-case semantics),
  builtins declare no tools → byte-identical toolset. `modeHints`
  computed from the turn's user message (:1428-1429, ephemeral, both
  turn paths via the single shared prepareTurn); ctx threads
  taskModes + the gated fields (:1491-1500). **PLAN_MODE_TOOLS gains
  switch_mode** (:147) — the R70-b read_skill D4 dark-tools honesty
  rule applied to the mode surface: plan PERMISSION mode advertises the
  TASK MODES index + the "consider switch_mode FIRST" signal line, so
  the switch must not be dark there (and plan × plan is the natural
  pairing). Registration: modesPlugin in `BUILT_IN_PLUGINS`
  (13→14, tools/registry.ts:134 — the canonical single source of
  truth; tools/index.ts re-exports + documents) + `TOOL_NAMES` gains
  switch_mode (storage/agents.ts:76, migration 0027 repairs
  template/default rows).

**Evidence:** `r73-modes-backend.test.ts` (45 tests: the 23-section
registry pin + after-skills positions + strict-gating byte-identity
incl. tail checks; computeModeHints scoring/threshold/top-2/ties and
the builtin cross-validation 'fix this bug' → debug; storage + the
0027 migration matrix; the PATCH/GET route family — set/clear/null/
untouched/unknown-400-with-ids/no-side-effect-rename/404/title+mode/
metadata-only no-body-leak/customs + shadowing + resolver parity;
switch_mode's three calls + sentinels + idempotence + the custom-id
path; the runtime e2e — index/signal/ACTIVE-body on both turn paths,
the vanished-mode sweep + one-turn note, the live tools-narrowing +
the narrowAllowListByTaskMode unit matrix incl. NO_TOOLS cases) + the
strengthened neighbor pins (prompt-registry 22 — the golden's toolNames
frozen to the fixture's exact vocabulary + MODES_CTX + order pins;
storage/projects-tools/r52-plugin-registry/memory-tools/models-catalog
— the vocabulary re-pins).

## D — the frontend: the picker + the slash (c, D1–D6)

**Root cause:** posture is a per-session choice the OWNER makes too —
"don't let the agent touch files while I ask it to plan" is a user
sentence, not just a model decision. The picker is the user-side
access path; the slash is its keyboard sibling.

**Fix:** `src/lib/api.ts` (+67 — `Session.activeMode`, TOOL_CATALOG's
`switch_mode` (repairing the R45 drift-guard the TOOL_NAMES growth had
left red — tool-catalog-drift 2/2 green, and AgentFormDialog's
checkboxes now offer it like every other tool), `TaskModeInfo`,
`fetchProjectModes`, `patchSessionActiveMode`). NEW
`composer/TaskModePicker.tsx` (216 lines) — the ModeSwitcher pill
mirrored exactly (h-7 px-2 rounded-[10px], the Compass trigger icon —
posture = heading — label + ChevronDown, useDismiss, aria pattern):
the label is the active mode's NAME, the RAW id while the list hasn't
resolved it (a session row saying a mode is active must never render
"Auto" — the backend sweeps vanished customs next turn), "Mode: Auto"
only when truly none. The dropdown: "Auto (no mode)" first (clears),
one row per mode — name + the trigger-rich description clamped
line-clamp-2 with the FULL text on the row title, the Check reserved
for selection, row icons plan:ClipboardList/debug:Bug/build:Hammer/
review:FileSearch/explore:Compass/refactor:Wrench (Compass fallback
for customs), menuitemradio + aria-checked, a mono "custom" chip on
file-source rows. `AgentChatPanel.tsx` (+191): the modes list via
react-query (the project-scoped key pattern), `activeTaskMode` state
synced from the session row exactly like permissionMode;
`onTaskModeChange` — onModeChange's optimistic pattern exactly
(patchCache on the list + detail keys, PATCH, rollback + the
"Task mode change failed" toast); **the /mode slash intercept at
runTurn's top** — `parseModeSlash` matches "/mode" as a WORD
(`^\/mode(?:\s|$)/i` — "/moderation" and every other slash fall
through untouched), the command answers as local toasts (list / set /
clear / unknown-with-available-ids + the `.acute/agents/*.md` hint),
clears the composer input, and returns WITHOUT a message or stream;
`/mode <name>` resolves id OR name case-insensitively (exact word
match — "deb" is not "debug", the tool's same exactness); the
fresh-session carry (a mode picked pre-session PATCHes onto the
first turn — the permissionMode carry's mirror). The picker is
disabled while a turn streams or a PATCH is in flight (modes apply at
TURN time — a mid-stream switch would silently miss the running
turn). `Composer.tsx` (+34, seam-only prop-threading — zero
behavioral change to the composer's own logic; the pill renders in
the left toolbar cluster after ModeSwitcher).

**Evidence:** `TaskModePicker.test.tsx` (10 — pill labels + aria +
the raw-id fallback; menu rows + descriptions + the line-clamp pin +
the full text on the row title; the custom chip on file-source rows
only; selection reports the id + closes; Auto reports null; the
current-mode no-op; disabled keeps the menu closed; Escape dismissal)
+ `AgentChatPanel.test.tsx` strengthened (23→32 — the activeMode sync
from the session row, the optimistic GUI path, the failed-PATCH
rollback + toast, the /mode intercept set/clear/bogus/bare-list/
capitalized-NAME, the not-intercepted "mode change please" running a
full turn, the pill's toolbar placement next to ModeSwitcher).

## The architecture (one picture)

```
THE THREE-TIER STACK (what the owner's directive completes)
  SKILLS (R61/R70/R71/R72/R73-d)    = METHODOLOGY — HOW work is done
  MODES (this round, R73-a/b/c)     = POSTURE — how the agent HOLDS ITSELF
  REFERENCES (R72-c)                = DEPTH — the deep material

THE TURN (runtime.ts prepareTurn)
  user message ──► scoreQualified (task-hints.ts:163, the R72-a core)
  │                 scores BOTH the effective skills' descriptions
  │                 (computeTaskHints → the SKILLS Task signal) AND
  │                 the resolved modes' descriptions (computeModeHints
  │                 → the TASK MODES Task signal, id-keyed)
  ├─► system prompt, after SKILLS (both strictly ctx-gated):
  │     ## TASK MODES — the index + the division line + ONE
  │     "Task signal: … the **debug** posture — consider switch_mode
  │      { mode: "debug" } FIRST" line   (NEW, advisory only)
  │     ## ACTIVE TASK MODE — name (id) + the body VERBATIM, every
  │      turn while active (NEW — the only place a body rides)
  └─► the toolset: a FILE-mode's frontmatter `tools` NARROWS the
        allowlist (narrowAllowListByTaskMode — never widens; unknown
        names drop; empty → NO_TOOLS sentinel)

THE ACCESS PATHS (nothing auto-activates — disclosure stays the contract)
  switch_mode {mode:"<id>"}  the AGENT side — sets active_mode, returns
                             the full guide ONCE + the fenced reminder
                             (system-reminders.ts renderReminder, the
                             ONE renderer; r72-dir-conventions byte-
                             identical on it — the proof)
  the picker + /mode         the USER side — PATCH /sessions/:id
                             {activeMode} (null clears, unknown → 400
                             with the available ids)
  the Task signal line       the ADVISORY side — the same deterministic
                             matcher, zero cost, per-turn ephemeral
CUSTOMS: .acute/agents/*.md — frontmatter + body, ≤8 × 16K, shadow
builtins, discovered per turn (no DB rows, no persistence by design)
```

## Verification (re-run fresh this round — R73-e's receipts)

| Suite | R72 | R73 | Delta |
|---|---|---|---|
| root `pnpm test` | 2423 (133 files) | **2558 (138 files — 2,546 passed + 12 e2e env-gated skips)** | +135 |
| agent-core standalone | 1521/1521 (70 files) | **1637/1637 (74 files)** | +116 |
| frontend `src/` | 890 (61 files) | **909/909 (62 files — 61 src/ + shared/index per the workspace convention)** | +19 |
| sidecar e2e | 12 | **12** (env-gated without dist) | 0 |
| `r73-modes-core` (NEW) | — | **28** | — |
| `r73-system-reminders` (NEW) | — | **16** | — |
| `r73-skills-round` (NEW) | — | **17** | — |
| `r73-modes-backend` (NEW) | — | **45** | — |
| re-pins / strengthened | — | skills trio (r71 75→**83** · r70 51→**53** · r72 count unchanged) + 5 vocabulary suites; AgentChatPanel 23→**32**; TaskModePicker **10** | — |

- The arithmetic reconciles exactly: 1,637 + 909 + 12 = 2,558 ✓
  (74 + 62 + 2 = 138 files ✓) — measured by R73-e's fresh runs (root
  153.3 s; agent-core 77.8 s; frontend 79.0 s). +135 = +116 agent-core
  (the four new suites 106 + the skills re-pins +10) + +19 frontend
  (picker 10 + panel +9).
- **The golden fixture is BYTE-IDENTICAL** — prompt-registry green AND
  the file untouched: md5 `3a5d2c7d695149e6031711836a6d698b`, the same
  digest recorded before the round started. Both new sections are
  strictly ctx-gated; no regen performed or needed.
- `pnpm typecheck` exit 0; `pnpm lint` exit 0; `pnpm license:audit`
  CLEAN — 134 production dependencies, zero dependency changes.
- **A LIVE HTTP e2e smoke** (the thing unit tests can't prove — the
  real Fastify app built the house way, listening on 127.0.0.1:0,
  plain fetch, a temp DB + a temp project carrying a custom
  `.acute/agents/release-notes.md`): GET /modes → 200 with the six
  builtins in order + the custom (source "file", no body field ever
  served); PATCH set "debug" → 200; PATCH bogus → 400 VALIDATION with
  availableModes and NO side-effect write; PATCH null → 200 cleared.
  All green; the temp files deleted after — the tree back to exactly
  the R73 change set.
- **Diff hygiene exact:** 10 NEW + 25 MODIFIED files, nothing extra,
  nothing missing; zero stray console.log/debugger/TODO, zero new
  emoji, zero absolute URLs in added code.
- Zero Rust/`src-tauri` files touched — `cargo check` not re-run
  locally; CI's windows-latest gate rides the same untouched code as
  the green v0.72.0 build. `pnpm docs:check` clean after this round's
  stamps; `pnpm version:check` 0.73.0 ×4.

## Live gates for the owner (what to watch on real Windows)

These are the questions CI cannot answer — the round is
construction-pinned in a headless Linux sandbox, exactly as
R69–R72 were:

1. **Does the TASK MODES section + Task signal line appear on real
   task-shaped messages?** Send "fix this bug" and watch the debug
   card's full-turn export: the turn's system prompt should carry the
   TASK MODES index after SKILLS and a `Task signal: this request
   looks like the **debug** posture — consider switch_mode FIRST`
   line. A clear phrasing with no line means the mode description's
   quoted phrases need a tuning pass (report the phrasing).
2. **Does switch_mode activate — and does the ACTIVE TASK MODE section
   ride the following turns?** Ask the agent to switch posture (or
   watch it do so on the signal); the switch_mode result returns the
   full guide once + the fenced reminder, and the NEXT turn's export
   should carry `## ACTIVE TASK MODE — Debug (debug)` with the body.
   `/mode none` (or the picker's Auto) should remove it.
3. **Do the picker + the /mode slash work in the composer?** Set,
   clear, and list (`/mode`, `/mode debug`, `/mode Debug`, `/mode
   none`); custom modes from `.acute/agents/*.md` should appear in
   the dropdown with the "custom" chip — and a mode picked before the
   first message should ride the first turn.
4. **Do the two new skills trigger?** "write a spec" / "before we
   build" → spec-planning; "make it faster" / "this is slow" →
   performance (the descriptions quote exactly these).
5. **Do custom-mode tool narrowings actually narrow?** Drop
   `.acute/agents/ro.md` with `tools: read_file, search_code` in its
   frontmatter and activate it: the session should be read-only while
   it is active (the allowlist is intersected narrow-only; an unknown
   name drops honestly).
6. **Carried from R69–R72 (still awaiting the field run):** the R69
   Windows checklist (docs/runbooks/COMPUTER-USE.md), the R70 gates,
   the R71 gates, and the R72 gates (the skill Task-signal line, the
   six crafts' triggers, references loading, nested-dir conventions).

## What this round does NOT claim (known limitations)

- **The matcher is still substring-advisory** — modes inherit the
  r72 honesty: "word-boundary-ish" on purpose, honest for a nudge,
  not a precision matcher; a hint never auto-activates anything (the
  model still decides; the owner still decides; the prompt still says
  so).
- **Custom-mode description/body updates reach the next turn only** —
  customs are resolved per turn from disk (no DB rows, no caching, no
  persistence BY DESIGN): edit the file, the next turn carries the new
  text. BUILTIN bodies are code, not rows — they reach every database
  immediately on upgrade.
- **Children/sub-agents start modeless by construction** — posture is
  a main-session property this round (SessionInput has no activeMode;
  the orchestrator's createSession needs nothing); children DO see the
  TASK MODES index and can switch_mode themselves.
- **The context meter does not yet reflect custom-mode tool
  narrowing** — the meter's system-tools slice can over-report while
  a narrowing mode is active (the effectiveToolNames route sits one
  intersection behind the turn's; an R74 pickup).
- **The 0027 skill-count upgrade path note** — INSERT OR IGNORE
  seeding keeps existing rows (user edits persist; deleted rows get
  the new text on revive), exactly the standing R71/R72 note for the
  two new skills.
- **All live behavior is the field gate** — whether a real model
  actually calls switch_mode mid-task, whether the postures change
  real behavior, whether the owner finds the picker: construction
  pins the contract, the field decides the wording. The tag/release/
  DASHBOARD sync are the orchestrator's close-out steps, not this
  round's.

## What's next (the R74 queue — a deliberate re-prioritization, recorded)

- **`delegate_task` task_id/background/resume** — DEFERRED from the
  R73 queue BY DESIGN (the R73-plan decision): the orchestrator is
  the most delicate concurrency surface and deserved its own round —
  the owner's "don't rush" instruction applied. The last unshipped
  piece of the R71 sub-agent discipline.
- **External plugin ctx enrichment** (cline's appendContext seam) and
  the **lessons-ledger affordance** as the reminder injector's THIRD
  consumer (dir-conventions and switch_mode are its first two).
- **Ratings-driven prompt tuning** — the ratings capture now has
  three prompt tiers (skills, modes, references) worth tuning
  against.
- Plus the standing queue from the Unreleased section: the
  R69–R73 live gates, edit-linting (SWE-agent's ACI #1 finding),
  installer code-signing, and the deepseek-harness future candidates.
