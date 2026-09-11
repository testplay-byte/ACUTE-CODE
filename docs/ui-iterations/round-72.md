<!-- last-reviewed: 2026-09-11 round-88 -->
# Round 72 — the adaptive capability round: the agent now picks skills on the basis of the task (deterministic, free), carries eighteen built-in crafts, reads skills to reference depth, and honors the conventions of the directory it edits

**Date:** 2026-09-07 · **Branch:** `main` · **Version:** 0.72.0 ·
**Provenance:** no new owner field report — R72 answers the owner's
post-R71 directive ("much more robust, much more capable, much better —
proper detailed system prompts which the agent accesses when required
and on the basis of the task, various in-built skills, plan properly,
use sub-agents"). The research base is the R71 passes (the four
reference repos: karpathy-skills, alirezarezvani/claude-skills, cline,
kilocode — their findings still open on disk), and the R72-d design
round turned the directive into four disjoint workstreams executed in
parallel: **a** (task hints — the "on the basis of the task" engine),
**b** (skills 12→18), **c** (references/ depth for file skills), **d**
(per-directory conventions, the kilocode pattern). No new screens, no
new REST routes (one additive response field), zero frontend files —
this round lives in the seam between what the user just said and which
capability the model reaches for first.

| ID | Workstream | Files owned |
|---|---|---|
| a | Task hints: the deterministic (no-LLM, zero-cost, zero-latency) task→skill matcher; ONE advisory "Task signal" line in the SKILLS prompt section; both turn paths; golden byte-stable | NEW `agent-core/src/agents/task-hints.ts`, `agent-core/src/agents/prompts.ts`, `agent-core/src/agents/runtime.ts`, NEW `agent-core/tests/r72-task-hints.test.ts` |
| b | Skills expansion 12→18: six engineering-craft builtins — tdd, api-design, frontend-craft, typescript-craft, security-review, refactoring | `agent-core/src/storage/skills.ts`, NEW `agent-core/tests/r72-skills-expansion.test.ts`, re-pins `r70-skills-system` + `r71-skills-round` |
| c | References depth: file skills gain a `references/` subdirectory (the Agent-Skills standard's second tier); `read_skill` gains the optional `reference` param; `GET /skills` carries the metadata | `agent-core/src/storage/skills-files.ts`, `agent-core/src/tools/plugins/skills.ts`, `agent-core/src/server.ts` (comment only), NEW `agent-core/tests/r72-references.test.ts` |
| d | Per-directory conventions: `read_file` appends a capped, clearly-fenced reminder quoting the DEEPEST AGENTS.md/CLAUDE.md strictly below project root (kilocode pattern; root skipped — already in the system prompt) | NEW `agent-core/src/tools/dir-conventions.ts`, `agent-core/src/tools/plugins/filesystem.ts`, NEW `agent-core/tests/r72-dir-conventions.test.ts` |
| verify | Full CI-mirror verification (this round's counts below) | — |
| docs | The docs round (this file + the runbooks + CHANGELOG + HANDOFF + IMPLEMENTED-API + TESTING + EXTENSIBILITY + indexes + status.json) + the version bump ×4 | `docs/**`, `CHANGELOG.md`, `HANDOFF.md`, the four version files |

## Why this round (the directive, read literally)

R70 built the agent's brain and R71 taught it discipline; both rounds
left one gap the owner's R72 directive names exactly: the capabilities
were *advertised* (the SKILLS section, 12 trigger-rich lines) but
*chosen blind*. The model saw a one-line description per skill and had
to decide — on turn one, before reading anything — whether "my test
keeps failing" is a debugging task or a testing task or a tdd task,
with no signal but its own guess. The same blindness ran two levels
deep: a loaded skill body is 1.2–1.9KB of discipline, but the Agent
Skills standard (and the R71 research repos) carry a *second tier* —
`references/` files for the deep material — which ACUTE's file skills
ignored entirely; and a repo with per-directory rules ("everything
under `src/embedded/` follows MISRA-C", "tests here are vitest, never
jest") hid those rules from every read_file, because readCustomRules
loads only the ROOT convention files. And the library itself had
process discipline (R71's four) but none of the six engineering
*crafts* (test-first, API contract, components, typing, security,
refactoring) that the reference-skill repos consider the core canon.
Four gaps, four workstreams, one theme: **the right instructions arrive
on the basis of what the task actually is** — decided deterministically
where determinism suffices, loaded progressively where depth is needed.

## A — task hints: the "on the basis of the task" engine (a, D1–D4)

**Root cause:** the SKILLS prompt section is a static index — the same
18 lines whether the user just said "fix this bug" or "design the API
for the uploads route". Progressive disclosure (R61/R70) deliberately
keeps bodies out of the prompt; the trigger decision is the model's
alone, and R71's own live-gate list says that decision is the weakest
link (skill triggers need field observation; the descriptions were
rewritten trigger-rich precisely because the choice fails in the
field). The missing piece is a *bridge from the message to the index* —
and the R71 trigger-rich convention already wrote the bridge's raw
material: every builtin description now quotes the verbatim user
phrasings it answers to.

**Fix (NEW `agent-core/src/agents/task-hints.ts`, 181 lines):**
`computeTaskHints(userMessage, skills)` — a **deterministic matcher:
NO LLM, no async, no cost, no latency** (the module header documents
the choice: an extra model call per turn just to pick a skill would be
the opposite of robust). Scoring per skill, against the incoming
message:

- **Quoted phrases ×5** — every `'single'`/`"double"` quoted string in
  the description (≥2 chars, deduped) that appears in the message
  (case-insensitive substring — "word-boundary-ish" on purpose:
  'deploy' may also surface inside "deployment", which is signal, not
  noise) scores its **word count × 5**. Phrases are the strong signal
  — they ARE the verbatim phrasings the R71 convention embedded — and
  any ONE phrase hit alone qualifies the skill.
- **Tokens +1** — description tokens (lowercase, split
  non-alphanumeric, ≥3 chars, an internal STOPWORDS set of grammatical
  glue dropped — without it, every R71 description's "Use when the user
  says…" opening would match every message) present as whole words in
  the message score 1 each.
- **Qualify** at total ≥ 2 OR ≥1 phrase hit; sort score desc then name
  asc (deterministic ties); **top 2** (`MAX_HINTS`, task-hints.ts:66 —
  a longer shortlist would just be a second skill list; the advisory is
  one sentence).

Hygiene (task-hints.ts header + pinned): empty/whitespace message →
no hints; no skills → no hints; the message is capped at 8,000 chars
before matching (a pasted log wall must not become a quadratic scan);
**contractions are flattened on BOTH sides** ("don't" → "dont", straight
and typographic apostrophes) so the quoted phrase 'don't hallucinate'
extracts as ONE phrase and no bare 'don' fragment can leak out of an
apostrophe.

**The rendering (`prompts.ts:473-486`, ctx field at `:83-93`):** ONE
advisory line, AFTER the skill list and BEFORE the reload affordance,
honest "looks like" wording —
`Task signal: this request looks like it matches **debugging** —
consider calling read_skill with that name FIRST and following it for
the rest of the task.`
(two names get `(and possibly **<second>**)`; the renderer caps at two
even if a caller passes more). The line renders **only inside the
SKILLS section** — no skills → no line (a pinned decision: advice
about a list that doesn't exist is noise). **Nothing is auto-loaded**
— progressive disclosure stays the contract; the hint only raises the
odds the model opens the right skill on turn one.

**The wiring (`runtime.ts`):** `prepareTurn` gains the trailing
`turnUserMessage` parameter (`:1081-1087` — prepareTurn runs BEFORE
the message.user event is appended, so the incoming text can only
arrive by parameter; raw, nothing stripped). The **effective skills
are hoisted** (`:1321-1333`) so the SKILLS section and the matcher
share ONE list — a hint can never name a skill the section doesn't
list, and the computer-use gate + per-agent allowlist are inherited by
construction. Hints are computed there (`:1333-1334`) and passed into
the prompt ctx only when non-empty (`:1386-1388`). **Both turn paths**
thread their `content` through the shared call — the sync/sub-agent
path (`runSingleAgentTurn`, prepareTurn at `:1459`, content at
`:1469`) and the streamed path (`runStreamedAgentTurn`, prepareTurn at
`:2044`, content at `:2061`) — so plain turns, streamed turns, and
sub-agent children all get the same advisory. **Per-turn ephemeral**:
hints live only in that turn's system prompt, never persisted.

**Golden stability — proven, not asserted:** `ctx.taskHints` is
OPTIONAL and the golden fixture's ctx does not set it. The
prompt-registry byte-identity suite is green AND the fixture file
itself is untouched (md5 `3a5d2c7d695149e6031711836a6d698b`,
git-clean — the same digest R72-a recorded before any change). No
regeneration was performed or needed: the ctx field is purely additive.

**Evidence:** `r72-task-hints.test.ts` (27 tests: 13 matcher pins —
phrase ×5 dominance with exact scores, case-insensitivity, token
accumulation, the stopword filter, the score-1 threshold, phrase-alone
qualification, the top-2 cap, name-asc tie-break, empty/whitespace,
both quote types, contraction flattening positive + no-fragment-leak
negative, the 8K cap, and the real builtin `debugging` description
scoring ≥10 on the canonical message; 6 rendering pins — the exact
one-name and two-name lines, placement, the renderer's own 2-name cap,
absent/`[]`/`undefined` → byte-identity, hints-without-skills → no
line; 8 e2e pins on BOTH paths — the system-capturing chatStream and
chat patterns, the exact debugging advisory for "my test keeps
failing, fix this bug", unrelated messages → no line, the dark-skill
pin (computer-use off → no section/no line; on → the line names it),
per-turn ephemerality).

## B — the skills library: 12 → 18, the six engineering crafts (b, D1–D3)

**Root cause:** R71's four additions were *process* disciplines
(scope-fix, evidence, self-scoring, ship gating). The reference-skill
canon (and the owner's "various in-built skills") calls for the
*crafts* — the six recurring engineering situations every real session
hits: writing the code test-first, designing an HTTP surface, building
a component tree, typing a domain model, checking a diff for the big
five, restructuring without behavior change. None existed; the model
met those situations with general knowledge and no discipline
contract.

**Fix (`storage/skills.ts:749-802`, sortOrder 12-17, fixed ids,
`INSERT OR IGNORE`):** six builtins in the exact R71 house style —
trigger-rich descriptions 447-490 chars (measured this docs pass;
≤500 storage cap) each quoting the phrasings a user actually types and
naming the nearest adjacent skill in the negative scope; bodies
1,636-1,891 chars (the 1.2-1.9K band), ≤60 lines, `# Skill:` prefix,
imperative voice, iron laws in caps, pre-built output-format blocks,
ACUTE's real tool names, no emoji:

| Skill | Body | The contract it carries |
|---|---|---|
| `tdd` | 1,871 | IRON LAW **NEVER WRITE THE TEST AFTER THE CODE TO FIT IT**; RED→GREEN→REFACTOR with "RUN it (run_command, the project's real test command — find it first) and WATCH it fail — a test you have not watched fail proves nothing"; minimum-to-green YAGNI; refactor only on green; triangulation (the second case that forces the general solution); a 4-row anti-pattern table where each row means STOP; the TEST FIRST output block |
| `api-design` | 1,885 | IRON LAW **THE CONTRACT IS WRITTEN BEFORE THE HANDLER** — method+path+request+response+errors named first; fail-closed boundary validation; ONE error envelope `{code+message+detail}` everywhere; additive-only evolution ("a response that shifted is someone else's outage"); pagination + caps; the API CONTRACT block |
| `frontend-craft` | 1,879 | IRON LAW **STATE LIVES AS CLOSE TO ITS CONSUMERS AS POSSIBLE** — lift only on proven sharing; stable-identity keys, never array index; derived state computed, not stored; controlled inputs; semantic HTML ("a click handler on a div is a bug"); the a11y floor (Tab/Enter/Space, focus VISIBLE, aria last); Tailwind discipline; the COMPONENT PLAN block |
| `typescript-craft` | 1,866 | IRON LAW **IF A STATE IS ILLEGAL, ITS TYPE MUST MAKE IT UNREPRESENTABLE** — unions+literals over flag soup; discriminated-union narrowing with never-exhaustiveness; NEVER cast to bypass ("a cast is a confession"); the `any` ban → `unknown` + narrowing at truly dynamic boundaries; inference over annotation except at published boundaries; the TYPE PLAN block |
| `security-review` | 1,636 | the **big five with the EXACT test each**: injection → parameterized SQL + argument arrays; traversal → `resolve` + `startsWith(root + sep)`; secrets → `git_diff`/`search_code` the change BEFORE commit; authz → checked where the DATA is fetched, not where the UI hides the button, per-route not per-habit; fail-closed → errors deny ("converted an exception into a bypass"); the SECURITY VERDICT block with severity + the exact exploit path or CLEAN with what was checked |
| `refactoring` | 1,891 | IRON LAW **NO MOVE WITHOUT A GREEN CHARACTERIZATION TEST FIRST** — "or the refactor is refused"; behavior PRESERVED with the honesty rule (a behavior change is a rewrite — name it and plan it); ONE mechanical move per step, never two unverified; rename before restructure; STOP when the pain is gone; the `todo_write` step ledger; 3 red flags; the REFACTOR PLAN block |

Same seeding contract as every builtin family: fresh AND existing DBs
converge on 18 rows at next open; user edits persist; deletes refused
/ deleted rows revive on reopen. The SKILLS section grows ~2.8K chars
for 18 descriptions — the section is budgeted separately from the 22K
default-composition bound (which pins a skills-less composition; the
prompt suites are green, no gate violated).

**Evidence:** `r72-skills-expansion.test.ts` (32 tests): the
18-in-fixed-order pin (names + ids + sortOrder 0-17 + enabled); a
per-skill trigger-rich contract `it.each` over all six (Use when +
Delivers + NOT for + the exact quoted phrase + the exact negative
scope + the 160-500 char band); slug + distinctness pins (18 unique
descriptions); house-format `it.each` (prefix + 1.2-1.9KB + ≤60 lines
+ no emoji + the skill's real tool names); six deep discipline-contract
tests (iron laws, ordered rules, anti-pattern/red-flag lines, output
blocks); key-rules-verbatim pins (2-3 highest-value lines per skill);
idempotent double re-seed → exactly 18; the deleted-row-revives
convergence (15 → 18 across a real close/reopen); user-edit
persistence (body + description, no dupes); disable-hides; and the D4
flow-through — all 18 full descriptions render verbatim in the prompt
SKILLS section. **Re-pins, strengthened never weakened:**
`r71-skills-round` 51→75 (the expected-builtin/trigger-phrase/negative-
scope tables extended to 18, "TWELVE"→"EIGHTEEN" order pin, the
converge test deletes R71+R72 rows → 15 → 18, house-format + emoji
discipline extended to the six) and `r70-skills-system` 45→51 (18-seed
pin + sortOrder 0-17, the NEW_BUILTINS `it.each` 11→17 entries, the
end-to-end loop includes the six new names).

## C — references depth: file skills get their second tier (c, D1–D4)

**Root cause:** a SKILL.md body is capped at 1.2-1.9KB of discipline —
good for the contract, useless for the deep material (the full
checklist, the protocol walkthrough, the reference table). The Agent
Skills standard defines exactly this second tier: a `references/`
subdirectory, one level deep, of additional .md files the skill body
can point at. ACUTE's file-skill machinery (R70) had discovery, body
loading, the merged listing — and nothing below the body.

**Fix (`storage/skills-files.ts` + `tools/plugins/skills.ts` +
the `GET /skills` note):**

- **Discovery (`discoverSkillReferences`, skills-files.ts:333):** a
  dir-form skill's `<skillDir>/references/` is listed as **METADATA
  ONLY** — `{name (the fileName stem), fileName, bytes}`, sorted by
  fileName (byte order, pinned), **capped at 8 files**
  (`FILE_SKILL_REFERENCES_CAP`, :81) with an honest
  `skills_files.reference_cap` log when more exist, `.md` extension
  case-sensitively, hidden/underscore-prefixed files skipped,
  subdirectories not traversed (one level, the standard), files over
  **64KB skipped + logged** (`FILE_SKILL_REFERENCE_SIZE_CAP`, :87 —
  everything listed is loadable; unusable stems skipped + logged). A
  missing/unreadable references/ dir (the common case) → `[]`, never a
  throw. Flat-file skills and DB skills always `[]`. No content reads
  at discovery — progressive disclosure is unchanged.
- **The loader (`readSkillReference`, skills-files.ts:460):** accepts
  the skill DIR or the SKILL.md path; **sanitizes FIRST** (traversal
  and separators rejected with the reason — the same
  `referenceNameRejection` single source); strips the reference's OWN
  frontmatter at read time; caps at 64KB with the honest
  `…[reference truncated: N of M chars shown]…` marker; ENOENT honest.
- **`read_skill` gains the optional `reference` param**
  (plugins/skills.ts:88-91 — "optional: load a deeper reference file
  instead of the main body (the body output lists available
  references)"). A **name-only file-skill call appends the listing
  block** when references exist —
  `references available: <a>, <b> — load with read_skill { name: "<skill>", reference: "<first-ref>" }`
  (copy-pasteable: the first listed name rides the example; DB skills
  and reference-less file skills unchanged, byte-identical). A
  name+reference call resolves through the SAME effective-skills
  index first — **computer-use gate and agent allowlist fire
  identically with or without the reference param** (resolve, then
  load) — then the honest error family: traversal → the rejection with
  the reason; DB skill + reference → "database skills carry no
  reference files"; unknown reference → the listing with the exact
  call syntax; the loaded output is
  `# Skill: <name> — reference: <ref>` + the body, trimmed to the 60K
  output budget WITH an honest marker (r71-e2 discipline — no silent
  cuts in new code). The core-skills plugin manifest bumps
  1.1.0 → 1.2.0 (manifest-level only).
- **`GET /skills` carries the metadata** — file-skill entries gain
  `references: FileSkillReference[]` (possibly empty; DB rows OMIT the
  field), riding `listAllSkillsMerged` additively through
  EffectiveSkill (skills-files.ts:502-506) and MergedSkillRecord
  (:588-592). Zero route changes, zero frontend changes (the field is
  additive; the settings listing stays metadata-only by design —
  reference content is never served over REST).

**Evidence:** `r72-references.test.ts` (27 tests): discovery metadata
deep-equal (sorted, bytes, the byte-order pin), frontmatter counted at
discovery/stripped at read, the cap-8 + honest log capture
(ACUTE_LOG_PATH redirect + restore), non-.md/.MD/hidden/underscore/
nested-dir ignored, >64KB skipped + at-cap kept, unusable stem
skipped, flat + no-dir skills → `[]`, effective-index carry + DB-shadow
removal; the loader's dir + SKILL.md-path forms, ENOENT, the traversal
set ("../../secret", "a/b", "a\b", "con:x", "") with exact rejection
pins, the growth-race 64KB marker; read_skill's listing-block
endsWith pin, the no-listing-block pins, the {name, reference} exact
output, unknown-reference listing, traversal rejected, DB+reference,
no-refs+reference, computer-use gate parity, allowlist gating (allowed
+ blocked), the 60K-window honest-marker trim, switch-ON parity; the
`GET /skills` references + DB-rows-omit + no-content-leak pins; the
storage-level merged listing; and the buildProjectTools end-to-end
(body listing block + reference load through the full registry).

## D — per-directory conventions: the rules of where you're about to edit (d, D1–D3)

**Root cause:** readCustomRules (R70) loads the ROOT AGENTS.md /
CLAUDE.md / override / local ladder into every turn's system prompt —
repo-wide policy. But the kilocode insight (R71-b3) is that
conventions apply **where you are about to edit**: a repo often
carries DEEPER AGENTS.md/CLAUDE.md files scoping extra rules to a
subtree, and a model reading a file six levels deep has no idea the
subtree carries its own rules — until it edits the wrong way. ACUTE's
only AGENTS.md was the root one, so nothing in-tree ever hit the gap;
real repos will.

**Fix (NEW `agent-core/src/tools/dir-conventions.ts`, ~175 lines +
`plugins/filesystem.ts:84-86`):** `read_file` of a path appends —
ONLY on `ok:true`, after the byte-exact numbered content — a
clearly-fenced reminder quoting the **deepest** AGENTS.md (or
CLAUDE.md) **strictly below the project root** on the path to that
file:

```
\n\n--- [conventions from a/b/AGENTS.md apply to this file]\n<excerpt ≤ 2,000 chars>\n--- (end conventions — the file content above is unaffected)
```

(the source names the ACTUAL file — AGENTS.md or CLAUDE.md). The
design decisions, all deliberate and documented in the module header:

- **ROOT is skipped** — readCustomRules already injects it (with
  @-import expansion + caps) into every turn's system prompt;
  appending it again would double-bill the context for zero new
  information. A file directly in the root gets no reminder (it has
  no ancestor below root).
- **Deepest wins** — the walk (`findDeepestConvention`, :97) starts at
  the read file's own directory and climbs toward (never reaching)
  root, nearest level first; AGENTS.md before CLAUDE.md per level; a
  wrong-shaped candidate (a DIRECTORY named AGENTS.md) or an
  unreadable one falls through to the next candidate/level.
- **EXACT CASE ONLY** — no agents.md/claude.md fallbacks: the
  exact-case names are the cross-tool convention, and a
  case-insensitive probe would silently pick up unrelated files on
  case-insensitive filesystems (macOS/Windows) while behaving
  differently on Linux — the R70 OS-divergence lesson, generalized.
- **Fresh read every call** — no cache, not even mtime-keyed:
  convention files change mid-session, the read is one small file,
  and a stale reminder is worse than a re-read.
- **Once per (session, dir)** — `shouldInject` (:156) check-and-marks
  a module Map keyed `sessionId::dir`; the first read under a
  directory carries the reminder, later reads stay clean. With NO
  session (bare builds: tests, REST raw contexts) it injects every
  time — deterministic, and the only choice that keeps sessionless
  tests honest.
- **Honest failures** — unreadable/absent/wrong-shaped → null → NO
  reminder (a reminder, not a gate: a broken convention file must
  never break the read that would carry it); the excerpt is capped at
  2,000 chars (`EXCERPT_CAP`, :60) with the honest `…[truncated, 2000
  of N chars]…` marker.

The wiring (`plugins/filesystem.ts:84-86`) reads the session from
`ctx.toolDeps.sessionId` (the same place R71-e2's edit-streak reads
it); failure paths and every other tool (write/edit/list_dir/
create_dir/delete_file/snapshots, the RAW readFile behind the REST
file-viewer) are untouched — the UI never sees reminders. The
read_file tool DESCRIPTION (:58) gained the honest teaching line:
"read_file may append a [conventions from <dir>/AGENTS.md] reminder
when a deeper directory carries its own AGENTS.md/CLAUDE.md — it is a
reminder, not file content."

**Evidence:** `r72-dir-conventions.test.ts` (20 tests): walk pins
(deepest wins over root-adjacent + backslash input; CLAUDE.md
fallback; same-level AGENTS.md > CLAUDE.md + deeper CLAUDE.md beats
shallower AGENTS.md; root-only → null; no files → null; root-level
file → null; bad paths → null; wrong-shaped AGENTS.md-directory falls
through; the 2,000-char cap + marker; within-cap verbatim excerpt);
format pins (the exact reminder string, CLAUDE.md source named);
dedup pins (same pair twice, other dir/session, sessionless
always-true + records nothing, the test-seam reset); toolset pins via
buildProjectTools (bare-build exact-output pin — reminder after the
numbered content; session dedup first/second/other-dir/other-session;
root file exact output with root AGENTS.md present; RAW readFile
back-compat; failure path no reminder; the description teaching
line). The exact-output read pins of the two neighbor suites
(r70-tool-feedback, r71-tool-reliability — fixtures without nested
AGENTS.md) re-verified UNAFFECTED, the design's own prediction.

## The architecture (one picture)

```
THE TURN (runtime.ts prepareTurn)
  user message ──► computeTaskHints (NEW, task-hints.ts:141)
  │                 deterministic: quoted phrases ×5 / tokens +1
  │                 (stopwords), ≥2 or a phrase, top-2, 8K cap
  │                 scored against the HOISTED effectiveSkills
  │                 (one resolver: computer-use gate + allowlist)
  └─► system prompt SKILLS section
        18 trigger-rich lines (12 old + 6 NEW crafts)
        + "Task signal: this request looks like it matches **X** —
           consider calling read_skill FIRST"   (NEW, one line)

THE TOOLS
  read_skill {name}        ─► body + "references available: a, b —
  read_skill {name,        │   load with read_skill { name, …,
    reference} (NEW)       │     reference: "a" }"        (NEW, R72-c)
                           └─► references/<x>.md (≤8, ≤64KB, sanitized,
                                frontmatter stripped, honest truncation)
  read_file <path>         ─► numbered content +, when a DEEPER
                               AGENTS.md/CLAUDE.md governs the path
                               (NEW dir-conventions.ts, root skipped):
                               [conventions from a/b/AGENTS.md apply
                               to this file] ≤ 2K, once per (session,
                               dir) — a reminder, not file content
```

## Verification (re-run fresh this round — the docs pass's own receipts)

| Suite | R71 | R72 | Delta |
|---|---|---|---|
| root `pnpm test` | 2287 (129 files) | **2423 (131 passed + 2 skipped files — 2411 passed + 12 e2e env-gated skips)** | +136 |
| agent-core standalone | 1385/1385 (66 files) | **1521/1521 (70 files)** | +136 |
| frontend `src/` | 890 (61 files) | **890/890** | 0 — zero frontend files touched |
| sidecar e2e | 12 | **12** (env-gated without dist) | 0 |
| `r72-task-hints` (NEW) | — | **27** | — |
| `r72-skills-expansion` (NEW) | — | **32** | — |
| `r72-references` (NEW) | — | **27** | — |
| `r72-dir-conventions` (NEW) | — | **20** | — |
| re-pins | — | r71-skills-round 51→**75** · r70-skills-system 45→**51** | +30 |

- The +136 = 106 new tests (27 + 32 + 27 + 20) + 30 re-pin growth —
  measured this docs pass by re-running everything above (agent-core
  full 1521/1521 in 70 files, 70.9 s; root 2423 in 133 files, 142.7 s;
  the scoped R72 batch 254/254 incl. prompt-registry's 22).
- **The golden fixture is BYTE-IDENTICAL** — prompt-registry green AND
  the file untouched: md5 `3a5d2c7d695149e6031711836a6d698b`, the same
  digest recorded before the round started. `ctx.taskHints` never
  appears in the golden ctx; no regen performed or needed.
- `pnpm typecheck` exit 0, `pnpm lint` exit 0 — both re-run by this
  docs pass.
- Zero Rust / `src-tauri` files touched — `cargo check` not re-run
  locally; CI's windows-latest gate rides the same untouched code as
  the green v0.71.0 build.
- `pnpm docs:check` clean after this round's stamps (see below);
  `pnpm version:check` 0.72.0 ×4.

## Live gates for the owner (what to watch on real Windows)

These are the questions CI cannot answer — the round is
construction-pinned in a headless Linux sandbox, exactly as
R69/R70/R71 were:

1. **Does the task-signal line appear on real messages?** Send "my
   test keeps failing, fix this bug" and watch the engine log (or the
   debug card's full-turn export): the turn's system prompt should
   carry `Task signal: this request looks like it matches
   **debugging** — consider calling read_skill …` in the SKILLS
   section. A task-shaped message with NO line (hints need score ≥2 or
   a phrase hit) is fine for genuinely ambiguous asks — but a clear
   phrasing with no line means the description's quoted phrases need
   a tuning pass (report the phrasing).
2. **Do the six new skills trigger on their phrasings?** "write the
   test first" → tdd, "add an endpoint" / "design the API for…" →
   api-design, "build this UI" / "fix the layout" → frontend-craft,
   "fix the any" / "type this properly" → typescript-craft, "is this
   safe" / "does this leak secrets" → security-review, "clean this
   up" / "refactor" (without behavior change) → refactoring. The
   descriptions quote exactly these; a real phrasing that does NOT
   trigger its skill means the description needs tuning (editable in
   Settings → Skills).
3. **Do references load?** Drop a SKILL.md file skill with a
   `references/` subdirectory into `.acute/skills/<name>/` (any .md
   files, ≤8, ≤64KB each): the read_skill body output should list
   them ("references available: … load with read_skill { name: …,
   reference: … }") and the reference call should return the
   `# Skill: <name> — reference: <ref>` body.
4. **Do nested-dir conventions appear on real repos?** Open a repo
   that carries a non-root AGENTS.md or CLAUDE.md (common in
   monorepos) and have the agent read a file under it: the first
   read_file output should end with the fenced
   `[conventions from <dir>/AGENTS.md apply to this file]` excerpt;
   the second read under the same directory should NOT repeat it (and
   root-level files never carry one — root rules are already in the
   system prompt).
5. **Carried from R69/R70/R71 (still awaiting the field run):** the
   R69 Windows checklist (docs/runbooks/COMPUTER-USE.md), the R70
   gates (skill-body tuning, root-AGENTS.md loading, the grounded
   TERMINAL syntax), and the R71 gates (receipts + 🟢🟡🔴 in real
   replies, edit-escalation ending flail loops, overflow recovery
   saving long sessions).

## What this round does NOT claim (known limitations)

- **The matcher is advisory and substring-based** — "word-boundary-ish"
  by design ('deploy' may surface inside "deployment"): honest for a
  nudge, not a precision matcher. The stopword list is curated, not
  linguistic; new description conventions may need it extended
  (internal, behavior-tested). A future builtin quoting the canonical
  defect phrasings more strongly than `debugging` would need the
  default-agent e2e pin re-pinned (one line).
- **Hints never auto-load anything** — they raise the odds the model
  opens the right skill on turn one; the model can still ignore the
  line. That is the progressive-disclosure contract, deliberately.
- **Description/body updates do not reach pre-R72 databases** (INSERT
  OR IGNORE keeps existing rows — by design, user edits persist;
  deleted rows DO get the new text on revive) — the same upgrade-path
  note R71 recorded; an UPDATE-where-unchanged migration stays
  deferred unless the owner asks.
- **The SKILLS section grew ~2.8K chars** with 18 descriptions — the
  section is composed from the effective skills at runtime and
  budgeted separately from the 22K default-composition bound (which
  pins a skills-less composition); no gate is violated, but the
  per-turn prompt with all 18 enabled is visibly longer.
- **The convention dedup map is in-process** — a sidecar restart
  re-injects once per (session, dir) (harmless); sessionless bare
  builds inject on EVERY read by design (deterministic for tests; the
  REST raw route is unaffected). Reading the convention file itself
  (a/AGENTS.md) carries its own reminder once — arguably correct; the
  fences make it unambiguous. Excerpts are raw text (no @-import
  expansion — that is readCustomRules' root-only machinery, kept out
  of the hot read path).
- **Reference content is unbounded by the frontend** — the 64KB cap is
  the only limit; the settings listing stays metadata-only (REST never
  serves reference bodies; only read_skill loads them).
- **All live behavior is the field gate** — the matcher's phrasing
  coverage, the six crafts' trigger surface, and the per-dir reminders
  are construction-pinned; the owner's real tasks decide whether the
  wording lands. The tag/release/DASHBOARD sync are the orchestrator's
  close-out steps, not this round's.

## What's next (the R73 queue, recorded from R72-d)

- **`delegate_task` task_id/background/resume** — addressable,
  resumable sub-agent tasks with the depth guard (B9's runtime half;
  the last unshipped piece of the R71 sub-agent discipline).
- **A generalized system-reminder injector** — ONE mechanism for
  AGENTS.md injections, mode-switch notices, and lessons-ledger
  affordances instead of bespoke strings (the per-dir reminder joins
  this family as its second consumer).
- **Custom modes** (`.acute/agents/*.md` — user-defined agents with
  body-as-prompt, the slash-command/mode surface) and **external
  plugin ctx enrichment** (cline's appendContext seam).
- **Two more skills** (performance, spec-planning) — the R72-b house
  pattern extends; the library's stated destination is the reference
  repos' breadth with ACUTE's density.
- Plus the standing queue from the Unreleased section: the
  R69/R70/R71/R72 live gates, edit-linting (SWE-agent's ACI #1
  finding), installer code-signing, ratings-driven prompt tuning, and
  the deepseek-harness future candidates.
