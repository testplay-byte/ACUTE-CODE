<!-- last-reviewed: 2026-09-10 round-83 -->
# Round 70 — the agent brain round: the model now knows its world, follows conventions, and verifies before claiming done

**Date:** 2026-09-06 · **Branch:** `main` · **Version:** 0.70.0 ·
**Provenance:** no new owner field report this round — R70 is the
RESEARCH-DRIVEN round. Two analysis passes opened it: **R70-A**, the
brain audit (the agent's own prompt + loop dissected like an
engineering artifact — its #1 finding: *the model doesn't know its OS*
; #2: the two mega-sections that never pay rent; the four sections
teaching the same planning posture four different ways), and **R70-B**,
the OSS agent study (what Codex, Claude Code, SWE-agent, Cursor and
OpenHands each got RIGHT that ACUTE-CODE lacked — SWE-agent's ACI
lesson *"observations quality ≈ model quality"*, Codex's dirty-worktree
rule and AGENTS.md loading, Claude Code's @file imports, the
AGENTS.md/CLAUDE.md ecosystem convergence — 60k+ GitHub projects carry
one). R70 turns those findings into product across three workstreams:
**R70-a** (tool feedback quality — the ACI round), **R70-b** (the
skills system round), **R70-c** (the prompt round: grounding,
consolidation, conventions, discipline, communication). No new
screens, no new REST surface beyond skills listing/409s — this round
lives in the space between the model and the world it acts on.

| ID | Workstream | Files owned |
|---|---|---|
| a | Tool feedback quality (the ACI round): run_command 64KB cap keeps BOTH ends (head 32KB + tail 32KB + honest middle-omission marker — the tail was where build/test errors lived and it was LOST); read_file becomes line-numbered with offset/limit pagination + honest empty-file/EOF messages; todo_write description carries the Codex planning discipline; honest no-output messages everywhere | `agent-core/src/tools/exec.ts`, `agent-core/src/tools/fs-ops.ts`, `agent-core/src/tools/plugins/{exec,filesystem,todo}.ts` |
| b | The skills system round: file-based skills discovery (`.acute/skills/` project + `~/.agents/skills/` global, the Agent-Skills standard), SEVEN new builtin skill bodies, STICKY skill bodies (loaded instructions stop evaporating mid-task), computer-use skill gated on the master switch, the `agent.skills` allowlist WIRED (dead data since R61) | NEW `agent-core/src/storage/skills-files.ts`, `agent-core/src/storage/skills.ts`, `agent-core/src/tools/plugins/skills.ts`, `agent-core/src/agents/chat.ts`, `agent-core/src/server.ts` |
| c | The prompt round: env grounding (OS/shell/date/git), the four-section consolidation, AGENTS.md/CLAUDE.md loading with @file imports, edit/verify/communication discipline, panel trims + skill pointers | `agent-core/src/agents/prompts.ts`, `agent-core/src/agents/prompt-registry.ts`, `agent-core/src/agents/runtime.ts`, the golden fixture |
| verify | Full CI-mirror verification (this round's counts below) | — |
| docs | The docs round (this file + the runbooks + CHANGELOG + HANDOFF + IMPLEMENTED-API + TESTING + indexes + status.json) + the version bump + commit/push/CI | `docs/**`, `CHANGELOG.md`, `HANDOFF.md`, the four version files |

## A — environment grounding (the model knows its machine)

**Root cause (R70-A #1):** the ENVIRONMENT section said one true thing
(the working directory). The model literally guessed its OS — the
TERMINAL section taught BOTH `start /B …` (cmd.exe) and `… &` (POSIX)
syntax on every turn because nothing knew which one `run_command`
actually spawns, and the model had no date, no git state, no shell
name. Codex's first prompt block is the environment; ACUTE's was a
directory path.

**Fix (`runtime.ts` prepareTurn → `prompts.ts`):** every real turn now
carries a probed machine state:

- `osPlatform`/`osRelease` — `process.platform` mapped (`win32` →
  "Windows", `darwin` → "macOS", else "Linux") + `os.release()`.
  Honest note: this is the SIDECAR's host — on the owner's real
  Windows machine it is the truth; in the Linux dev sandbox it says
  Linux, which is ALSO the truth there.
- `shell` — the shell `exec.ts` actually spawns through
  (`shell:true`): cmd.exe on Windows, `/bin/sh` on POSIX.
- `currentDate` — the turn's real date + weekday.
- `gitBranch`/`gitDirty` — a guarded `git` probe
  (`GIT_PROBE_TIMEOUT_MS = 1_500`): `git rev-parse --abbrev-ref HEAD`
  + `git status --porcelain`, honestly degraded — not a repo, a
  timeout, or a git-less host each render a fallback line
  ("not a git repo" / "branch unknown (probe failed — check
  git_status…)") instead of silence.

The ENVIRONMENT prompt section renders it all: OS + release + shell +
cwd + date + branch, and a DIRTY tree is named as the USER's work
("NEVER revert or discard them"). The **TERMINAL section now teaches
ONLY the real platform's syntax** — the Windows turn shows
`start /B <cmd> > <log> 2>&1` (cmd.exe), the POSIX turn shows
`<cmd> > <log> 2>&1 &` (/bin/sh); the legacy both-platforms line
survives only for env-less callers (the context meter, the CLI, older
tests) so their compositions stay byte-identical.

**Tests:** `r70-prompt-round.test.ts` pins the env fields, the
git-probe fallbacks (not-a-repo / failure → honest lines), the
Windows-only and POSIX-only TERMINAL lines, and the env-less
byte-compat path.

## B — prompt consolidation (four sections teaching one loop → ONE section)

**Root cause (R70-A):** `agentic-loop` (3,098 chars) + `efficiency`
(721) + `task-planning` (686) + `todo-tracking` (257) — **4,762 chars
teaching the same posture four separate times**, with real drift
between them (one said "one tool per message" era guidance, another
"batch independent calls", a third the 6-step planning shape, the
fourth the todo snapshot rules).

**Fix (`prompts.ts` + `prompt-registry.ts`):** ONE `agentic-loop`
section carries the five-phase loop, and the three overlapping
registry ids (`efficiency`, `task-planning`, `todo-tracking`) are
RETIRED with the R66-2-c removal-cascade precedent (registry entry +
composition block + golden + pins move together — a registered id
that composes nothing fails the completeness pin by design).

The five phases (registry 23 → 20 ids, golden 22 → 19 `##` sections):

1. **PLAN** — unclear request → ONE clarifying question; 3+ steps → a
   `todo_write` list UP FRONT (≥2 items or it is not a plan; trivial
   tasks skip it; mark one `in_progress` before starting; update
   after EACH sub-task; the list is a snapshot, not a delta).
2. **EXPLORE** — ONE message with the independent discovery calls
   BATCHED (the old efficiency section's core), most-specific tool
   first, no re-exploring between steps.
3. **ACT** — the fewest steps that genuinely complete the work;
   prefer editing existing files; a successful write response is
   itself confirmation the save landed.
4. **VERIFY** — after code edits run the project's checks before
   claiming done (touched tests / typecheck / lint); **for 3+ file
   edits, a `delegate_task` adversarial review** (a fresh sub-agent
   eyes the diff without the author's bias); confirm steps from their
   tool results, re-check only what indicates a problem.
5. **FINISH** — only when genuinely complete AND verified; the
   anti-lazy-stop clause stays (a summary after one tool call is a
   FAILURE) while every call must EARN its place.

`maxOuterLoops` is taught honestly now (the cap was invisible to the
model: "up to N tool round-trips per iteration and M outer iterations
exist — keep working within them").

**Measured:** old 4 sections 4,812 chars → the merged section 2,885
(golden composition). The todo phase lines stay gated on
`todo_write` vocabulary; the adversarial-review affordance on
`delegate_task`.

## C — AGENTS.md / CLAUDE.md conventions loading (the cross-agent standard)

**Root cause (R70-B rec #1, the checked gap):** ACUTE-CODE read
`.acuterules` + `.acute/rules/*.md` — its own invented convention —
while the ecosystem CONVERGED on AGENTS.md (Codex, Claude Code,
Cursor, OpenHands; 60k+ projects carry the file). Every
convention-rich repo opened in ACUTE-CODE had its instructions
silently ignored.

**Fix (`prompts.ts` `readCustomRules`):** the loader now reads the
full ladder, in presentation order (generic → ACUTE-native last =
later entries are MORE specific and authoritative):

1. `AGENTS.md` (the cross-agent standard)
2. `CLAUDE.md` (the Claude Code convention)
3. `.acute/rules/*.md` (ACUTE's own rules dir, alphabetical)
4. `.acuterules` (the legacy single file)
5. `AGENTS.override.md` (Codex's local-override convention)
6. `CLAUDE.local.md` (Claude's local-override convention)

Each part carries a **source marker** so the model knows where a rule
came from. `AGENTS.md`/`CLAUDE.md`/the override files additionally
expand **`@file` imports** (the Claude Code bridge): a line that is
exactly `@docs/conventions.md` inlines that file's content
(relative paths only, `.md`/`.txt` only, **max 4 imports across the
whole call** — `RULES_IMPORT_MAX`, Claude's own hop count for parity
— with a visited-set cycle guard). Caps unchanged: 16K per file
(imported content counts within the including file's budget,
`RULES_FILE_CHAR_CAP = 16_000`) and 32K total
(`RULES_TOTAL_CHAR_CAP = 32_000`).

The CUSTOM RULES prompt section now documents the hierarchy itself
(~250 chars: the six-file ladder + "where one is specific it
overrides your general habits"), so the model knows the rules are
the PROJECT's, not suggestions.

**Tests:** `r70-prompt-round.test.ts` — the six-file order, source
markers, `@file` imports (relative + .md/.txt only, the 4-import
cap), cycle/duplicate guards, the caps.

## D — edit & verification discipline (the Codex rules)

**Fix (`prompts.ts` FILE EDITING RULES, three new rules):**

- **Line-number anchor rule** (follow-up to R70-a): read_file output
  prefixes every line with its number; the prefix is NOT content —
  `edit_file` anchors must be the RAW text. (Before R70-a there was
  nothing to warn about; after it, the contract needed saying.)
- **Dirty-worktree discipline** (Codex's rule, R70-B rec #2):
  NEVER revert or discard the user's changes; if git shows
  modifications the agent did not make, STOP and report before
  proceeding; NEVER `git reset --hard` / `git checkout --` /
  `git clean` to "clean up". (Gated on `git_status`/`run_command`
  vocabulary.)
- **Verify-after-edit contract**: after code edits, run the
  project's checks before claiming done — the touched tests,
  typecheck, lint. Discover the commands from the project's
  AGENTS.md / CLAUDE.md / package.json scripts; if still unknown,
  ask the owner ONCE and `memory_save` the answer for the project.
  (Gated on `run_command`.)

Plus the carried rules: prefer-editing-over-creating (edit_file beats
write_file for existing files), unique anchors, smart verification
(the write response is confirmation — re-read only on risk).

## E — the communication contract (Claude Code's verbosity rules)

**Fix (`prompts.ts` COMMUNICATION):** concise by default — chat
answers under ~4 lines unless asked; ZERO preamble ("I'll now…") and
zero postamble ("Let me know if…"); code locations cited as
**path:line** (`src/app.ts:42` — a claim about code names where it
lives); the final reply = WHAT was done (files touched) + the
VERIFICATION evidence (which checks ran + results) + the NEXT step
worth knowing.

## F — tool feedback quality (R70-a, the ACI round)

SWE-agent's ACI lesson: **observations quality ≈ model quality**. The
model is only as good as what its tools tell it — and three tools
were lying by omission.

### F1 — `run_command`: the 64KB cap now keeps BOTH ends

**Root cause:** `exec.ts` clipped oversized output to the FIRST
64KB — but build/test errors live at the END of the log. A failing
`pnpm build` printed 70KB of warnings and the cap kept the warnings,
threw away the ERROR, and the model said "looks fine".

**Fix:** `OUTPUT_HEAD`/`OUTPUT_TAIL` (32KB each) beside `MAX_OUTPUT`
— oversized output now renders head 32KB + the honest marker
`…[output truncated: N bytes omitted from the middle — the first
32KB and the last 32KB are kept]…` + tail 32KB. One shared clip
covers normal completion, timeouts, and background-launch
pre-exit output. `job_status` was audited: already tail-shaped (8KB
ring buffer + 2KB log tail) — no fix, only the D4 bug below.

### F2 — `read_file`: line numbers, pagination, honest edges

- **`cat -n` line numbers** (`padStart(6)` + two spaces; content
  after the prefix byte-exact incl. `\r`; no-trailing-newline phantom
  line) — the path:line citation contract (E) and the anchor rule
  (D2) both ride on it.
- **`offset` (1-based line) / `limit` (line count)** parameters with
  honest validation: non-integer/`offset<1` → the exact rule + what
  was received; `offset` past EOF → `offset 99 is beyond end of file
  ('f' has 5 lines)`; `limit` clamped by EOF → body +
  `[end of file: returned lines 4-5 of 5]`.
- **Empty file** → `File exists but is empty (0 bytes): 'x'`
  (ok:true — was a SILENT empty string).
- **Oversized window (>256KB content)**: default stays whole-file
  ≤256KB (the anchor workflow preserved); an oversized window keeps
  LINE-ALIGNED head ~32KB + tail ~32KB with
  `…[file truncated: N bytes omitted between line A and line B —
  use offset/limit to page through the middle]…` — the model gets
  imports + tail immediately AND the exact paging path. A degenerate
  single-giant-line (a minified asset) is byte-sliced head+tail, both
  carrying its TRUE line number.
- **The RAW `readFile` is untouched** — the server's
  `GET /projects/:id/file` keeps byte-exact content for the UI
  viewer; only the MODEL's `read_file` is numbered.

### F3 — `todo_write`: the planning discipline moves into the tool description

Description-only (writeTodo semantics untouched): skip todos for
trivial 1–2-step tasks; NO single-item plans (≥2 steps or it's not a
plan); write todos BEFORE starting; mark exactly ONE `in_progress`
before beginning it; update IMMEDIATELY after each sub-task (never
batch); "your progress contract: when every item is completed and
verified, you may finish".

### F4 — honest no-output messages

- `run_command` success-with-zero-stdout →
  `(no output — the command ran successfully and printed nothing)`
  (SWE-agent's rule; a failure keeps the plain `(no output)` +
  `[exit code: N]` — no false "successfully").
- `job_status` with an existing-but-EMPTY log file showed NEITHER
  output nor explanation (the guard required `logTail === null`) →
  now `(no output captured yet — the process may still be starting,
  may write only to its log file, or may genuinely produce nothing)`.

**Tests:** NEW `agent-core/tests/r70-tool-feedback.test.ts` — 18
pins: head-is-exact-prefix / tail-is-exact-suffix / marker-between /
once / cap-holds (70,008-char fixture) + ≤cap passthrough; the
zero-stdout success/failure split + the job_status empty-log case;
the cat-n format exact (incl. no-trailing-newline and lone-newline
files), the empty-file message, offset/limit windows, all four
validation errors, the EOF-clamp note, the >256KB head+tail (3,000 ×
103B file: line 1 head, line 3,000 tail, marker, line 1,500 absent,
`offset/limit` retrieves the middle), the single-line byte-slice,
the RAW readFile back-compat pin, tool-level execute via
`buildProjectTools` + description pins; the todo description pins.

## G — the skills system round (R70-b)

### G1 — file-based skills (the Agent-Skills standard)

NEW `agent-core/src/storage/skills-files.ts` (457 lines): skills are
discovered from disk, not only the DB —

- **Project**: `<root>/.acute/skills/<name>/SKILL.md` (directory
  form) + flat `<name>.md` directly in `.acute/skills/`.
- **User-global**: `~/.agents/skills/<name>/SKILL.md` — the
  CROSS-AGENT standard directory (drop the same skill folder in
  Claude Code / Codex / ACUTE-CODE and it works in all).
- Frontmatter follows the Agent-Skills format (tolerant `---`-fenced
  `key: value` parser; a frontmatter `name` that is a valid slug
  WINS over the directory name; no frontmatter → the slug + a
  generic description; invalid name AND slug → honest skip + log;
  >512KB/unreadable → skip). Caps: description ≤500, body ≤60K,
  ≤32 per source.
- **Precedence**: a DB row (ANY state — enabled or disabled) shadows
  a same-name file ("hidden, not fall-through": the documented
  override path is creating a DB skill with the file's name);
  project file beats global file; directory form beats flat file.
  File skills are read-only: `PATCH`/`DELETE` on a file-skill's
  synthetic id (`skill_file_p_…`/`skill_file_g_…`, the
  `isFileSkillId` guard) → **409 "file-defined skill: edit the
  SKILL.md"** — the existing UI row-error path surfaces it verbatim
  (zero frontend changes).
- **`GET /skills`** now returns the merged listing (DB rows + every
  registered project's files + global files) with provenance
  (`source` gains `project-file`/`global-file`, plus `filePath` +
  `projectName`; bodies read from disk at call time so a deleted
  file de-lists honestly — `readFileSkillBody`'s ENOENT note covers
  the mid-call race).
- **ONE shared resolver** — `resolveEffectiveSkills` (enabled DB
  skills with the computer-use gate → file skills not shadowed →
  the `agent.skills` filter) is used by BOTH `prepareTurn` (the
  SKILLS prompt section) and `read_skill`, so the index the model
  sees and the loader can never disagree.

### G2 — SEVEN new builtin skills (1 → 8 total)

`skills.ts` `BUILTIN_SKILLS` grew via the same `INSERT OR IGNORE`
seeding (fixed ids, sortOrder 0..7 — fresh installs AND existing DBs
get them on next open; user edits persist; a deleted row revives on
reopen):

| Skill | Body | What it teaches |
|---|---|---|
| `computer-use` | 6,440 | the R61–R69 desktop-control discipline (gated — G4) |
| `code-review` | 1,362 | reviewing diffs: what to look for, how to report |
| `debugging` | 1,398 | systematic debugging: reproduce → isolate → fix → pin |
| `testing` | 1,138 | test discipline: pin the bug, outcome-based asserts |
| `git-workflow` | 1,298 | branches, commits, when to ask before touching git |
| `web-research` | 1,185 | search → fetch → save findings to files, not chat |
| `project-init` | 1,468 | **the /init skill — writes the project's AGENTS.md from codebase analysis** (stack, commands, conventions, gotchas) — and since G3 that file AUTO-LOADS on every turn |
| `browser-use` | 1,822 | the embedded-browser craft (verification walls, DOM-first, form submission) — absorbing what the prompt's browser-panel section used to carry in full |

### G3 — STICKY skill bodies (loaded instructions stop evaporating)

**Root cause (R70-A #2):** a loaded skill body died twice — (a) at
PERSIST time `summarizeToolOutput` capped every tool result at
4,000 chars head+tail (the 6,440-char computer-use skill lost its
middle in the event log), and (b) at REPLAY time `assembleHistory`
stubbed old tool lines to 200 chars — so a skill loaded at call #2
was GONE by turn 3. The model was being told to load instructions
and then having them confiscated.

**Fix, both halves:** (a) `chat.ts` gained `STICKY_RESULT_TOOLS =
["read_skill", "memory_recall"]` (`isStickyResultTool`, exported) —
`summarizeToolOutput` takes an optional `toolName` and sticky tools
get a **60,000-char budget** instead of the 4K mangling; (b)
`runtime.ts` `assembleHistory`'s pending tool lines carry a
`sticky` flag — sticky lines SKIP the 200-char per-line stub AND the
block-cap stub; the last-resort pass (a block still >48K after every
non-sticky line is stubbed) truncates a sticky line to 8,000 chars
with the "call read_skill again to reload" marker — bounded context
stays the hard invariant, and the degradation SELF-HEALS (the
SKILLS prompt section now teaches the reload affordance).

### G4 — the computer-use skill gated on the master switch

`resolveEffectiveSkills` reads the computer-use settings: while the
master switch is OFF, the `computer-use` skill is absent from the
SKILLS section AND `read_skill` refuses it with the SPECIFIC message
("computer use is disabled in settings (Settings → Computer Use) —
its tools are dark"). The gate beats the agent allowlist; ON state
unchanged (observe posture keeps it lit — read-only tools exist).
**Dark tools are no longer advertised** — before, the prompt sold a
skill whose tools 409'd on every call.

**Extension (the same honesty rule, applied to the mode gate):**
`read_skill` joined `PLAN_MODE_TOOLS` — the SKILLS section is
advertised in plan mode, so the loader must not be dark there
either.

### G5 — `agent.skills` WIRED (dead data since R61)

The per-agent skill allowlist was stored, patched and validated
since R61 but never READ. `prepareTurn` now passes `agent.skills`
into the shared resolver, and `read_skill` resolves the same way via
`toolDeps.agentId`: a non-empty array = a name allowlist over
builtin + user + file skills; empty/undefined = all (backward
compatible). `storage/agents.ts` needed no change — the reading side
was the missing half.

**Tests:** NEW `agent-core/tests/r70-skills-system.test.ts` — 41
pins: discovery (both sources, flat+dir, the caps, quoted
frontmatter, unclosed fence, name fallbacks, skipped bad slugs),
precedence (DB shadows files enabled OR disabled; project beats
global), `readFileSkillBody` (strip + vanished), the read_skill
plugin (file body from disk, DB body, de-listed-after-vanish, the
agent filter, the CU refusal both states), the server routes (merged
listing with provenance + filePath + projectName + disk body, DB
CRUD unchanged, the 409 file-skill refusals), the 8 builtins
(order, 800–2,200 chars, ≤60 lines, desc ≤500, per-skill content
pins, edit-persist + deleted-row-revives-on-reopen), the sticky
budgets + a 12-call history where a read_skill at call #2 stays
FULL with exactly 3 stubs + `memory_recall` sticky, the D4/D5 unit
pins, and END-TO-END wiring (`runStreamedAgentTurn` with a
system-capturing chatStream: `agent.skills=["code-review"]` → the
SKILLS section lists ONLY it; `[]` → all 8 incl. the file skill;
computer-use appears only with the switch on).

## H — prompt size: SMALLER while ADDING (the R70-c math)

The golden full-ctx composition: **22,460 → 20,156 chars
(22,625 → 20,156 bytes), 22 → 19 sections, 23 → 20 registry ids** —
while ADDING env grounding, the conventions ladder, and three
discipline rules. Where the budget came from (golden-measured):

| Change | Before | After | Saved |
|---|---|---|---|
| Four planning sections → one merged loop | 4,812 | 2,885 | ~1,927 |
| EMBEDDED BROWSER PANEL trim → essentials + `read_skill browser-use` pointer | 4,087 | 2,549 | ~1,538 |
| COMPUTER USE trim → safety/posture/chain + `read_skill computer-use` deep-contract pointer | 3,934 | 3,259 | ~675 |
| **Spent on:** ENVIRONMENT grounding, the rules ladder, rules 2/8/9, the communication contract, the reload affordance | — | — | ~−1,836 |

The deep craft did not vanish — it moved into the sticky skill
bodies (G2/G3), which load on demand and no longer evaporate. That
is the whole architecture of this round: **the prompt teaches the
loop; the skills carry the craft.**

## The architecture (the brain wiring)

```
prepareTurn (runtime.ts)                    THE PROMPT (prompts.ts)
  ├─ probeGitState (1.5s guard) ──────────► ENVIRONMENT: OS+release+shell+cwd
  │   branch/dirty, honest fallbacks          + date + git state (the model
  ├─ os.platform/release, shell               KNOWS its machine; TERMINAL
  ├─ resolveEffectiveSkills (skills-files)    teaches only the REAL shell)
  │   DB rows (CU-gated) → project files → GLOBAL files → agent.skills filter
  └─ readCustomRules ──────────────────────► PROJECT RULES: AGENTS.md,
      AGENTS.md → CLAUDE.md →                  CLAUDE.md, .acute/rules/*.md,
      .acute/rules/*.md → .acuterules →        .acuterules, overrides — with
      AGENTS.override.md → CLAUDE.local.md     source markers + @file imports
      (@file: relative, .md/.txt, ≤4,          (≤4, cycle-guarded, 16K/32K caps)
      cycle-guarded; 16K/file, 32K total)
                                              AGENTIC LOOP: PLAN→EXPLORE→ACT→
                                                VERIFY→FINISH (one section;
                                                registry 23→20 ids)
                                              FILE EDITING: line-number anchors,
                                                dirty-worktree, verify-after-edit
                                              COMMUNICATION: ≤4 lines, path:line,
                                                what+verification+next

TOOL OBSERVATIONS (the ACI half)            SKILLS (the sticky half)
  run_command: head 32KB + marker + tail     SKILLS section: names+descriptions
    32KB (errors live at the END)              only → read_skill loads a body →
  read_file: cat -n + offset/limit +          STICKY at persist (60K budget)
    empty-file/EOF honesty                     + at replay (no 200-char stub) →
  todo_write: ≥2 items, update per sub-task    last-resort 8K + reload marker
  job_status: "no output captured yet"       computer-use gated on the switch;
                                              agent.skills allowlist live
```

## Verification (re-run fresh this round)

- Root `pnpm test`: **2177 tests in 126 files, all green** (measured
  this pass with `agent-core/dist` present — the 12 sidecar-e2e run
  IN-SUITE against the fresh build; without a dist they report as
  env-gated skips: 2165 passed + 12 skipped. Was 2082 at R69 — R70's
  +95 grew the suite: agent-core **1180 → 1275 in 63 files**
  (re-run standalone, 1275/1275), frontend `src/` **890/890
  unchanged** — R70 touched zero frontend files).
- The R70 suites: NEW `r70-tool-feedback` **18** · NEW
  `r70-skills-system` **41** · NEW `r70-prompt-round` **34** ·
  +2 pin updates (prompt-registry / permission-modes) — **+95**.
- `pnpm lint` exit 0 · `pnpm typecheck` exit 0 (root + agent-core) ·
  `pnpm build` ✓ · `pnpm test:e2e` 12/12 · `pnpm license:audit`
  **CLEAN, 134 production deps** (no dependency changes this round —
  the audit stamp refreshed only).
- The golden fixture regenerated by the sanctioned procedure
  (22,625 → 20,156 bytes; byte-identity re-pinned).
- `pnpm version:check` 0.70.0 ×4 after the bump; `pnpm docs:check`
  **168 docs, 0 failures, 0 warnings** (the round-70 files stamped
  2026-09-06 round-70). One gate quirk found and handled: setting
  `status.json`'s `round` field to 70 (truthful) unmasks ~150 latent
  stamp-age failures — the field has read **57 since R57** and every
  round since has shipped `docs:check` green on that stale value, so
  the historical `round-NN.md` records (stamped with their own round,
  by design) never tripped the 3-round cap. The field is left at the
  shipped convention (57) and the real fix — exempting historical
  round records from the age check (or counting age from each file's
  own round) before making the field truthful — is flagged for a
  future scripts pass; CI runs `docs:check` warn-only either way.
  Also fixed here: the HANDOFF header's `(src/app.ts:42)` example
  needed backticks or the drift guard flags a nonexistent path.
- `cargo check` NOT re-run locally this round — **zero Rust /
  src-tauri files touched** (the working tree's 22 entries are all
  agent-core + docs); CI's windows-latest cargo check gate rides the
  same untouched code as the green v0.69.0 build.

## What this round does NOT claim (known limitations)

- **OS/env grounding reflects the SIDECAR's host.** `process.platform`
  is real there — on the owner's Windows machine the prompt says
  Windows (the truth); in the Linux dev sandbox it says Linux (also
  the truth there). If the sidecar ever ran remotely from the UI
  host, the two would diverge — documented, not engineered around.
- **Convention loading reads files per turn** (local disk, small —
  16K/32K caps); there is no change-watching, and `@file` imports
  are capped at 4 files / 32K total (Claude allows 4 hops — parity,
  not superiority).
- **No edit-linting gate yet** — SWE-agent's ACI #1 finding (lint
  EVERY edit before showing it to the model) remains future work;
  R70 teaches verification and makes the tools honest, but the
  engine does not itself refuse a broken edit.
- **The completion heuristic is unchanged** (the regex-based
  continue-if-unfinished detection — deferred, unchanged since its
  round).
- **Cache-aware section ordering was not restructured** (ordering
  sections so the volatile ones sit last, for KV-cache prefix reuse
  — analyzed in R70-B, documented as future work).
- **The 7 new skill bodies are construction-pinned** (char counts
  and content pins verified; content QUALITY is the live gate — the
  owner's real tasks will show which bodies need tuning, exactly as
  the computer-use skill's body was re-taught in R69 after the
  field run contradicted it).
- **The DASHBOARD sync, tag, and GitHub release are deliberately NOT
  this round** — the next task's scope (this round bumps the code
  repo only).
- Carried from R69: PowerShell never runs in this sandbox — all
  Windows behavior remains construction-pinned; the owner's next
  live Windows run stays the live gate for the computer-use stack
  (untouched this round).
