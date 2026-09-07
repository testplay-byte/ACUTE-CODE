/**
 * ROUND-61 (R61): SKILLS storage — the owner's directive: "the ability to
 * add multiple skills". A skill is a SKILL.md-style prompt module with
 * PROGRESSIVE DISCLOSURE (the doc-09 pattern): the system prompt lists only
 * name + description; the BODY is loaded on demand via the read_skill tool.
 *
 * Built-ins (source='builtin') are seeded at database open with INSERT OR
 * IGNORE (one fixed id per skill — reapplied only when the row is missing,
 * so a user EDIT persists; deletion of built-ins is REFUSED with a note —
 * disable instead, which hides the prompt line + the read_skill listing).
 * User skills: full CRUD.
 *
 * ROUND-70 (R70-b, D2): the built-in family grew from one (computer-use)
 * to EIGHT — code-review, debugging, testing, git-workflow, web-research,
 * project-init, browser-use (R70-B recommendation #4). Same seeding
 * contract, one fixed id each. File-based skills (R70-b D1) merge with
 * these at the RESOLUTION layer — storage/skills-files.ts (DB rows shadow
 * same-name files; the DB stays the editable source of truth).
 *
 * ROUND-71 (R71-e3, D1+D2): the trigger-surface round. (1) All EIGHT
 * descriptions rewritten per the Pocock/karpathy convention — "Use when
 * [verbatim user phrasings]. [what it delivers]. NOT for [adjacent case]."
 * The description is the ONLY thing the model sees at trigger time (the
 * SKILLS prompt line carries name + description; the body loads on demand
 * via read_skill), so every word must earn its place. Bodies UNCHANGED.
 * (2) FOUR new builtins (12 total): focused-fix, zero-hallucination,
 * self-eval, ship-gate — adapted from the R71-b1 research source material
 * (alirezarezvani/claude-skills), with iron laws in caps, pre-built output
 * blocks, and ACUTE's real tool names. Same INSERT OR IGNORE contract:
 * fresh AND existing DBs get the new rows on the next open.
 *
 * ROUND-72 (R72-b, D1): the capability-expansion round — SIX craft-skill
 * builtins (18 total, sortOrder 12-17): tdd, api-design, frontend-craft,
 * typescript-craft, security-review, refactoring. Same house style as the
 * R71 discipline four (trigger-rich descriptions with quoted phrasings +
 * negative scope; 1.2-1.9KB bodies; iron laws in caps; pre-built
 * output-format blocks; ACUTE's real tool names; no emoji). Same INSERT OR
 * IGNORE contract — fresh AND existing DBs converge on 18; user edits to
 * the six new rows persist like every other builtin.
 */
import type { SqliteDatabase } from "./db.js";

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  body: string;
  source: "builtin" | "user";
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface SkillRow {
  id: string;
  name: string;
  description: string;
  body: string;
  source: string;
  enabled: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

function toSkill(row: SkillRow): SkillRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    body: row.body,
    source: row.source === "builtin" ? "builtin" : "user",
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ── the built-in seed: the computer-use skill (doc 09, condensed) ────────── */

export const COMPUTER_USE_SKILL_ID = "skill_builtin_computer_use";

/**
 * The built-in COMPUTER-USE skill body — the behavioral contract from doc
 * 09-agent-skill-prompt.md, condensed to the operating core (the full doc
 * lives in docs/runbooks/COMPUTER-USE.md). Overridable like any skill
 * (edit the row; the prompt rides YOUR text).
 *
 * ROUND-64-a (R64-a): rewritten around the honest Windows surface — the
 * accessibility-first loop (no vision needed), app resolution by
 * processName OR title, the runningApps recovery payload, and
 * verify-after-every-write discipline.
 *
 * ROUND-66-2-d (R66-2-d): the BIG APPS paragraph — find_elements (the
 * server-side tree search) before screenshots in Chromium-sized windows
 * (the owner's live Edge failure: the agent looped screenshots because it
 * could not locate one control in a thousands-element tree).
 *
 * ROUND-67 (R67-E): the TAB-WALK DISCOVERY paragraph — the Windows key
 * tool now sends REAL SendInput chords (R68-C) and every key receipt
 * names the FOCUSED element, so walking Tab discovers the controls (the
 * owner's technique) — plus the embedded-browser boundary (browser_control
 * only, never computer-use tools on the in-app panel).
 *
 * ROUND-68 (R68-C): the browser-tree truth + chain discipline — the web
 * a11y tree IS searched (the Chromium poke activates it), screenshots are
 * the fallback for browser content, and the observe→act chain is
 * IMMEDIATE (frames valid 30s; verify with a small zoom crop). The
 * frontmost line teaches the AUTO-activation (a mismatch refusal now
 * means that activation failed).
 *
 * ROUND-69 (R69, verifier task 5): the observation-receipt loop — every
 * mutating action receipt now CARRIES the post-action observation (fresh
 * frame id, screenChanged, focusedElementName, activeApp title), so the
 * R68 "verify with a small zoom crop after the action" line is RETIRED
 * here (that zoom WAS the owner's screenshot-spam complaint). The body
 * now matches prompts.ts' R69 CHAIN DISCIPLINE: read the receipt, never
 * screenshot/zoom after acting; unchanged → adjust strategy, element
 * first; wait() after navigation reports what changed; a screen_unchanged
 * refusal means act or change strategy — never re-capture.
 */
export const COMPUTER_USE_SKILL_BODY = `# Skill: computer-use

Main-agent only. Never delegate Computer Use to a subagent (subagents lack the session-bound snapshot/frame state). UIA/AT-SPI element actions are the PRIMARY path: they need no vision and never steal the user's focus.

## Core loop
1. If readiness is unknown, call request_access once.
2. ALWAYS start with list_apps. name = the app's window TITLE ("Untitled - Notepad"); processName = the executable ("notepad"); both + pid are in every entry.
3. get_app_state resolves app_ref by pid (best), window title, processName, or a unique substring. If it refuses app_not_found, the payload's runningApps lists what IS running — pick the correct pid and retry with {pid}; never guess a pid. Two matches → ambiguous_app_ref lists the candidates; scope with pid.
4. If the user names an app that is absent, call open_application ONCE with the EXACT user-provided name — character-for-character (case, spaces, punctuation, suffixes like "app"). Never translate, normalize, shorten, retry spellings, or substitute a different running app.
5. After open_application, wait 0.5-1s (the wait tool, or return_state) for the window to exist BEFORE get_app_state.
6. If the target is in the tree, use an ELEMENT action ({type:"element", stateId, index}) — set_value / perform_action / left_click element. detail:"full" gives bounds + the element's advertised actions.
7. Only when the tree cannot locate or express the target, take a screenshot and use frame-bound coordinates ({type:"coordinate", x, y} copied UNCHANGED from the latest returned image — never pre-scale, never attach appRef/stateId).
8. VERIFY AFTER EVERY WRITE: the action receipt CARRIES a post-action observation (return_state defaults to "compact") — a fresh frame id, screenChanged, focusedElementName, the active app's title. READ the receipt; do NOT screenshot or zoom after acting. Only re-observe with get_app_state when the observation is missing or ambiguous.
9. Actions return receipts. action_sent=true means it MAY have happened — never blindly replay. The receipt's observation is the FIRST verification read; an external oracle (file exists, process exit code) is the strong one. An UNCHANGED screen means the action may not have registered: check focusedElementName, adjust strategy, switch to element targeting.

## Big apps (browsers, Edge, VS Code)
- get_app_state on a browser/IDE window returns a HUGE tree (Chromium exposes thousands of elements). Do NOT read it whole — SEARCH it: find_elements {appRef, query:"Sign in", kind:"button"} returns just the matching elements with indexes + bounds, far cheaper than get_app_state detail:"full".
- Browser pages (Edge/Chrome): the WEB accessibility tree IS searched — find_elements by name finds links, buttons, inputs (the tree is activated automatically). Element targets are the primary path for browser content; screenshots only when the tree genuinely misses.
- Prefer find_elements + element clicks (left_click/set_value with the returned stateId + index) over screenshots in big apps.
- Never loop screenshots when the tree can answer: find_elements by name first; screenshot/zoom only when names genuinely cannot identify the control. An empty result tells you the query and how many elements were searched — retry with a shorter substring or read the tree.
- CHAIN DISCIPLINE: screenshot → act IMMEDIATELY (frames stay valid 30s) — never re-screenshot between observing and acting, and never re-capture after acting: the receipt's observation is the post-action read. After navigation (Enter, links), call wait() — its receipt reports what changed while you waited. A screen_unchanged refusal means act or change strategy, not re-capture. middle_click a link = open in new tab.

## Tab-walk discovery (R67)
- Pressing key "tab" highlights the next focusable control on screen, and every key receipt names the FOCUSED element — walk Tab repeatedly to discover what is interactive when find_elements comes back empty or names cannot identify the target, then act on the element you reached. Combine with find_elements (search by name) when the app is big.

## The embedded browser is NOT a desktop app
- The app's EMBEDDED browser panel (the right-sidebar webview) is driven ONLY with browser_control (read_dom → click/type the returned selector paths) — NEVER with these computer-use tools. If the task is a web page, it is browser_control work; computer use is for the user's REAL apps.

## Discipline
- type REPLACES a field's contents (select first to insert). set_value is the preferred semantic write. Prefer set_value/perform_action over raw input.
- Raw input (coordinate clicks, key chords, app-scoped typing) on Windows/Linux needs the target frontmost — the raw-input tools now ACTIVATE their target automatically (R68: verified activation + one retry). A frontmost_pid_mismatch refusal means that auto-activation failed: check the app still runs (list_apps), re-observe, retry ONCE.
- scroll has no accessibility path — always coordinate. double/triple click are raw-only (coordinate). middle_click and right_click DO take element targets (R69): middle routes a raw click at the element's center; right clicks the center when the element has no menu.
- Modifiers: macOS uses "cmd"; Windows/Linux use "ctrl".
- Never send targetless type/key — scope with an element target or appRef.
- An unexpected modal dialog may be intercepting your action: inspect its contents FIRST; dismiss (Escape / its Cancel) only when it is NOT the task.
- An occlusion_owner_mismatch refusal names the covering window: re-activate the intended app; NEVER move/resize/close the reported window.
- After any element WRITE the stateId is consumed — get_app_state again before the next element action.
- Your OWN app window is not off-limits: if it covers the target, minimize it (key "win+down" with appRef {pid} of the ACUTE process, or element actions on its minimize button) — but only as much as needed to reach the target app.
- When the task is done, call stop_computer_control (releases held buttons); after it: no more computer-use calls, end the turn.

## Safety
- Destructive or hard-to-reverse actions (delete, overwrite, send, pay) need the user's explicit go-ahead unless durably authorized.
- NEVER type credentials (passwords, API keys, OTPs) into anything.
- Outward-facing sends are publishing — confirm unless told to proceed.
- Report outcomes faithfully; UI truth is not world truth.`;

/* ── ROUND-70 (R70-b, D2): the SEVEN new built-ins ───────────────────────────
 *
 * R70-B recommendation #4 — the agent's expanded brain, shipped as seeded
 * DB content (same INSERT OR IGNORE pattern as computer-use: one fixed id
 * per skill, user edits persist, deletion refused, disable hides). Bodies
 * 800–2,200 chars, Claude-skill style: terse, high-signal, imperative —
 * these are instructions the model will FOLLOW, not documentation it will
 * skim. The SKILLS prompt line carries only the description; the body
 * loads on demand via read_skill (progressive disclosure).
 *
 * `browser-use` deliberately COMPACTS the prompt's browser-panel teaching
 * into a loadable module (R70-c will trim the prompt section to essentials
 * and point here) — the body stays self-contained. `project-init` writes
 * AGENTS.md (R70-c makes the file auto-loadable; this skill creates it). */

export const CODE_REVIEW_SKILL_BODY = `# Skill: code-review

Review the CHANGE, not the whole repo. Scope to what the diff touches.

## Method
1. Read the diff first: git_diff (the touched paths). No diff to review = say so and stop.
2. Read enough surrounding code (read_file on the touched files) to judge the change in context — a hunk that looks right can break its caller.
3. Walk the checklist, then report.

## Checklist
- Correctness: error paths, nil/undefined returns, off-by-one, empty collections, unicode, timezone, rounding.
- Boundary conditions: inputs at min/max/empty/0/NULL; repeated or concurrent calls; what happens when the callee fails.
- Security: injection (SQL, command, path traversal), secrets in code or logs, auth checks on new routes, untrusted deserialization.
- API misuse: wrong types, stale contracts, breaking renames, missing migrations.
- Tests: do existing tests cover the changed behavior? Which case is now wrong?

## Report
Findings FIRST, ordered **critical** (correctness/security) > **bug** > **risk** (works but fragile) > **style** (only when it hides a bug).
Each finding: path:line + what is wrong + the concrete fix (a sentence or a snippet).
No praise. No restating what the diff obviously does.
End with a one-line verdict: approve / approve with N fixes / request changes.
If nothing is wrong, say exactly that and list the strongest check you ran.`;

export const DEBUGGING_SKILL_BODY = `# Skill: debugging

Fix the cause, never the symptom. Never "fix" a failure you cannot reproduce.

## Method
1. REPRODUCE. Run the failing case. No reproduction = no fix — report what you know and what you still need.
2. READ THE ERROR FULLY before reacting. The message names the file, the line, and usually the wrong value — half of all bugs die here. Do not skim; do not chase a different bug than the one reported.
3. ISOLATE. Narrow to the smallest input and the first wrong line:
   - git_log + git_diff the touched files — what changed recently?
   - Comment out or stub suspects; re-run after each cut.
   - search_code for the failing symbol — find where the bad value originates.
4. LOCATE the root cause. Trace the wrong value upstream to its source, then state it in one sentence: "X is null because Y only runs on the first mount."
5. FIX the root cause with a minimal change in the style of the surrounding code.
6. VERIFY: re-run the exact failing case, then the adjacent tests for that area.
7. GUARD: add a regression test that fails without the fix and passes with it.

## Discipline
- One hypothesis at a time: change one thing, re-run, observe.
- When two fixes both "work", prefer the one that also explains the error message.
- If you cannot locate the cause in a small number of steps, STOP and report what you ruled out — a pile of speculative edits is damage, not progress.`;

export const TESTING_SKILL_BODY = `# Skill: testing

A change is not done until its tests run and pass.

## Discipline
- Behavior spec'd but unwritten → write the failing test FIRST; watch it fail for the right reason; then implement.
- One behavior per test. A test that can fail for three different reasons explains none of them.
- Assert the error path, not only the happy path: the thrown message, the rejected promise, the empty result. A test that never fails proves nothing about failure.
- Run the affected suite after EVERY edit, not once at the end.
- NEVER weaken an assertion, delete a test, or widen a tolerance to make a suite green. A red test is information — making it green without understanding it is lying.
- A flaky test is a bug: isolate it (repeat, reduce, check time/random/order dependencies) or report it; never silently skip it.

## Commands
Find the project's REAL commands before inventing any: AGENTS.md, package.json scripts, the repo's CI config. Run the narrowest suite covering your change first (a file or a -t filter), the full affected package before claiming done. If no test setup exists, say so and propose one instead of pretending.`;

export const GIT_WORKFLOW_SKILL_BODY = `# Skill: git-workflow

The working tree belongs to the USER. Read-only by default.

## Rules
- Commit ONLY when the user asks. A finished task needs no commit — say what is uncommitted instead.
- NEVER revert, overwrite, or discard the user's uncommitted changes. NEVER git reset --hard, NEVER checkout -- over a modified file, NEVER git clean.
- If the worktree holds changes you did not make, STOP and report them before touching anything — a surprise in the tree is a signal, not noise.
- Stage related files explicitly: git add <path> ... . NEVER git add -A / git add . unless asked — commit exactly what the task changed.
- Before editing: git_status + git_diff to know what is already dirty.

## Commits (when asked)
- Conventional commits: type(scope): summary — feat/fix/refactor/test/docs/chore; imperative subject <= 72 chars, no trailing period.
- The body answers WHY (the what is in the diff). Reference the issue/PR when one exists.
- Verify the staged set (git diff --cached) BEFORE committing: the task's changes and nothing else.

## Branches & PRs
- Risky or experimental work: create a descriptive kebab-case branch first, when asked.
- PR description = WHAT changed + WHY + HOW IT WAS TESTED, three short paragraphs.
- Never amend, rebase, or force-push a branch you do not own.`;

export const WEB_RESEARCH_SKILL_BODY = `# Skill: web-research

Research ends in a DECISION, not a link dump.

## Method
1. SEARCH first (web_search) — 2-3 precise queries with the exact technical nouns, before fetching anything.
2. FETCH the 2-3 most authoritative hits (web_fetch). Prefer primary sources in this order: official docs / the project's source / the spec or RFC, then release notes and maintainer answers, then blog posts last (a blog may restate an old version).
3. When it matters (a version number, a breaking change, a security note), cross-check the claim across TWO independent sources.
4. Note the version AND date of what you read ("React 19 docs, updated 2025") — a right answer for the wrong version is still wrong.
5. SYNTHESIZE: the direct answer first, the evidence under it (one line per source, URL inline), then the open questions.

## Discipline
- Prefer documentation hosts (github.com, npmjs.com, MDN, nodejs.org) — they fetch freely.
- If sources disagree, say so and name the disagreement — never average two answers into a wrong one.
- Dated info: say when the newest source is old ("latest post is 2023 — this may have changed").
- Never invent a URL. Cite only what you actually fetched.`;

export const PROJECT_INIT_SKILL_BODY = `# Skill: project-init

Write the project's AGENTS.md — the convention file coding agents auto-load at session start. Goal: a fresh agent works in this repo correctly on turn one.

## Analyze first
1. list_dir the root. Read the README, the manifests (package.json / pyproject.toml / Cargo.toml / go.mod — whatever exists), and the CI config (.github/workflows, .gitlab-ci.yml).
2. Sample 5-10 real source files (the largest and most central, not config). Note the ACTUAL conventions: quote style, naming, error handling, where tests live, import order.
3. Run index_project; skim the summary for the package structure.

## Write AGENTS.md (<= 150 lines)
Terse sections:
- **What this is** — 2-3 sentences from the README, in your own words.
- **Stack** — languages, frameworks, package manager, key versions.
- **Commands** — setup, dev, build, test, lint, typecheck. ONLY commands you verified or copied from scripts/CI; mark unverified ones.
- **Conventions** — the rules a patch must follow (style, naming, test placement, commit style if evident).
- **Directory map** — one line per top-level directory.
- **Gotchas** — the traps you hit or can see (codegen, quirky build steps, platform notes, "don't edit X, it is generated").

## Rules
- Write only what you OBSERVED, never what a typical project of this type would have — a wrong command is worse than a missing one.
- write_file the result at the repo root, then report what you included and what you skipped.`;

export const BROWSER_USE_SKILL_BODY = `# Skill: browser-use

The embedded browser panel (browser_control) — a real webview the user watches live. It is NOT the user's desktop: never narrate panel actions as machine actions.

## Core loop
1. navigate to the absolute http(s) URL. Omit sessionId → it drives THIS session's own tab (auto-opened in the panel).
2. read_dom — the structured page outline (headings, links, buttons, inputs, forms with short selectors). This is how you know the page; screenshots only for layout/visual questions.
3. Act on DOM IDENTITY, never pixel coordinates: click by the returned selector or visible text; type into the returned selector.
4. VERIFY with get_state (currentUrl, title, canBack/canForward) — the navigation you expected, not the one you hoped for; read (fresh server text) or read_dom when the check must be about content.

## Forms
- Submit deliberately: type {selector, submit:true}, or press_key Enter (native form submission), or click the submit button by text. Typing alone never submits.
- Never eval a manual form click when the submit path above exists.

## Bot walls (CAPTCHA / Cloudflare / age gates)
- A result warning of a verification wall → STOP retrying. Call wait_for_verification: the user gets a countdown card, solves the wall in the panel, marks it done; you receive the honest re-probe result.
- Never hammer a walled page; never attempt to solve a CAPTCHA yourself.

## Discipline
- read = fresh server-side text; read_dom/click/type/eval = the LIVE page. They can disagree (logins, JS) — say which you used.
- eval runs as a function body in the page — end with return; use it only when read_dom/read/source cannot answer.
- Announce viewport changes (set_viewport) in one line — the user sees the panel live.
- source for the page's html/css/js; screenshot only when pixels are the question.`;

/* ── ROUND-71 (R71-e3, D2): the FOUR new built-ins ───────────────────────────
 *
 * Source material: R71-b1 research (/tmp/r71-research/skills-repos.md,
 * clones at /tmp/research/alirez-skills) — focused-fix, self-eval, ship-gate
 * (engineering/skills/) and zero-hallucination-coder (engineering/),
 * adapted to ACUTE's real tool surface (read_file, search_code,
 * run_command, git_diff, git_status, todo_write, edit_file) and the R70
 * house style: 1.2-1.8KB bodies, imperative voice, iron laws in caps,
 * pre-built output-format blocks the model fills verbatim, anti-
 * rationalization red-flag tables quoting the model's own excuses, and
 * STOP conditions instead of "be careful". No emoji except self-eval's
 * 🟢🟡🔴 confidence tags (the R71-b1 quality-loop convention). */

export const FOCUSED_FIX_SKILL_BODY = `# Skill: focused-fix

IRON LAW: NO FIXES WITHOUT COMPLETING SCOPE → TRACE → DIAGNOSE FIRST. Complete all three steps below BEFORE proposing any fix.

## The 3-step contract (in order)
1. SCOPE — restate the bug's exact observable SYMPTOMS and the EXPECTED behavior, side by side. An unobserved symptom is a guess — write it as a question, not a fact.
2. TRACE — follow the actual code path. Reproduce with a failing test or command (run_command); read the real code (read_file, search_code). NEVER fix from a guess, a memory, or the error message alone.
3. DIAGNOSE — name the root cause in ONE sentence BEFORE editing: "X is null because Y only runs on the first mount." No sentence? You are not done diagnosing.

## Output format (fill before touching code)
SCOPE REPORT: symptom / expected / actual / how reproduced
TRACE: files + symbols read (path:line) + the reproduction command
DIAGNOSIS: the one-sentence root cause

## 3-Strike escalation
3 failed fixes to the same problem = STOP — the bug is probably NOT where you are editing; every fix surfacing a NEW problem elsewhere is the signature of an architectural cause. Re-diagnose with the new evidence or escalate to the user. Never attempt fix #4.

## Red flags — your own excuses
- "It's a small fix, no need to reproduce." → STOP. No reproduction = nothing to verify against.
- "I'm sure it's this line." → STOP. Sure is not evidence; trace the path.
- "I'll just try the change and see." → STOP. Random edits are damage, not progress.
- "One more fix should do it" (after 2) → STOP. Strike three is approaching.

## The fix
The SMALLEST change that fixes the diagnosed cause, in the style of the surrounding code (edit_file, one hunk). Verify with the reproduction from SCOPE — the same command or test must now pass — then the adjacent tests, then a regression test that fails without the fix.`;

export const ZERO_HALLUCINATION_SKILL_BODY = `# Skill: zero-hallucination

Zero invented APIs. Zero assumed imports. Zero placeholder code. The discipline: before using any API, symbol, config key, or CLI flag you have NOT read in THIS session, tag it — then act on the tag.

## Evidence tags
- [KNOWN] — you read it this session; cite it (file:line). Use freely.
- [ASSUMED] — a reasonable inference from code you did read; state the assumption in a comment and in your reply.
- [UNKNOWN] — no evidence at all.

NEVER WRITE CODE THAT DEPENDS ON AN [UNKNOWN]. Resolve it first: read_file or search_code the source, or ask the user. An [ASSUMED] on a load-bearing path (auth, data, money, migrations) gets verified the same way before you build on it.

## The 6-rung YAGNI ladder — the best code is the code you never wrote
Before implementing any unit of work, stop at the FIRST rung that holds:
1. Does this code need to exist at all? No requirement asking for it = kill it.
2. Does the stdlib / language itself already do it? Use it.
3. Does a native platform/runtime feature do it? Use it.
4. Does an ALREADY-INSTALLED dependency do it? (Check what you read, not what you remember.)
5. Can it be a trivial one-liner, inline? Write it, no abstraction.
6. Write the minimum that works — no abstraction for one use, no config system for one value.

Never on the chopping block: validation at trust boundaries, error handling for data loss, security checks.

## Anti-hallucination rules (always on)
- Never invent imports, flags, paths, or option names. Unsure it exists = it is [UNKNOWN].
- When the docs disagree with the source, the SOURCE wins.
- When the source disagrees with the runtime, the REPRODUCTION wins.
- No placeholders: no "rest of implementation", no silently unimplemented stubs.`;

export const SELF_EVAL_SKILL_BODY = `# Skill: self-eval

Before claiming a task is done, score it. Do NOT pick a number and rationalize it — rate the two axes, then READ THE MATRIX, don't override it.

## The two axes (0-3 each)
- AMBITION — how completely the request is solved, edge cases included. 0 = abandoned/dodged; 1 = happy path only; 2 = the request as asked; 3 = plus its real edge cases.
- EXECUTION — verified-by-receipts quality. 0 = nothing verified; 1 = ran something, result unclear; 2 = core claims verified; 3 = every claim has a quoted receipt (command + exit code, or test output).

## The matrix (ambition × execution) → total 0-5
       e0  e1  e2  e3
  a0    0   1   1   1
  a1    1   1   2   2   ← LOW AMBITION CAPS THE TOTAL AT 2
  a2    1   2   3   4
  a3    2   3   4   5
A 5 requires complete ambition AND receipted execution — rare. The honest score for solid ordinary work is 3.

## Anti-grade-inflation
- A claim without a receipt scores 0 on execution — "should work" is not a receipt.
- The confidence tag must MATCH the evidence: 🟢 everything cited, 🟡 partially verified, 🔴 unverified. Never 🟢 on assertion alone.

## Mandatory devil's advocate
One line, always: the strongest counter-argument to the claimed result ("only the reported case is tested — the general class is unguarded"). If you cannot write one, you have not looked hard enough.

## The checklist
All todos completed (todo_write clean)? Checks green — actually run this turn? Receipts quoted, not summarized? Zero scope creep — every change traces to the request? Campsite clean — no debug leftovers?

## Output format
VERDICT: <total>/5 (ambition <a>/3, execution <e>/3)
DEVIL'S ADVOCATE: <the counter-argument>
CONFIDENCE: 🟢|🟡|🔴 — <why it matches the evidence>
GAPS: <what remains unverified, or "none">`;

export const SHIP_GATE_SKILL_BODY = `# Skill: ship-gate

Intercept every ship moment. When you or the user say "done", "ship it", "commit and push", "deploy", "release", "go live" — do NOT proceed on the feeling of finished. Run the gate, report, THEN ship (or don't).

## CRITICAL — any failure = DO NOT SHIP
- Tests, lint, typecheck: ACTUALLY RUN and green (run_command; quote the command + exit code). "They were green earlier" is not a receipt for this change.
- Build compiles: run the project's real build command, not a hope.
- No new console errors or warnings introduced by this change (read the diff hunks, not your memory).
- No secrets or tokens in what is about to be committed (git_diff + git_status the staged set).

## HIGH — fix, or list explicitly
- Touched-files review: read the FULL git_diff; every hunk traces to the request. An unexplained hunk = stop and explain it first.
- TODOs you introduced: resolved, or tracked (todo_write) with a named follow-up.
- Docs updated where the change alters user-visible or config behavior.

## ADVISORY — note, don't block
- Version bump appropriate? Changelog updated? Follow-ups listed rather than silently dropped?

## Verdicts
- DO NOT SHIP — any CRITICAL failing: name it, fix it, RE-RUN the gate (a fixed gate is re-verified, never assumed).
- SHIP WITH NOTES — CRITICAL clean, HIGH issues listed honestly.
- CLEAR — everything above is receipted.
NEVER claim SHIP on assertion alone — receipts required for every green check.

## Output format
GATE REPORT
CRITICAL: <each check — its receipt (command + exit code), or FAIL: what>
HIGH: <resolved, or the open list>
ADVISORY: <noted>
VERDICT: DO NOT SHIP | SHIP WITH NOTES | CLEAR — <one-line reason>`;

/* ── ROUND-72 (R72-b, D1): the SIX craft built-ins ───────────────────────────
 *
 * The R72-d design: the six engineering CRAFTS the R70/R71 families did
 * not cover — the test-first loop, the HTTP route contract, the component
 * discipline, the typing discipline, the adversarial security pass, and
 * behavior-preserving restructuring. Each is a discipline contract (an
 * iron law in caps, ordered rules, an anti-pattern/red-flag table where
 * the failure mode is a rationalization, and a pre-built output-format
 * block the model fills BEFORE acting), written in the R71 house voice:
 * dense, imperative, honest — instructions the model will FOLLOW, not
 * documentation it will skim. No emoji. */

export const TDD_SKILL_BODY = `# Skill: tdd

IRON LAW: NEVER WRITE THE TEST AFTER THE CODE TO FIT IT. The test is written from the SPEC; the code is written to pass the test — never the reverse.

## The loop (RED → GREEN → REFACTOR, in order)
1. RED — write ONE failing test for the next behavior. RUN it (run_command, the project's real test command — find it first) and WATCH it fail. A test you have not watched fail proves nothing: it may pass for the wrong reason, or never run at all.
2. GREEN — write the MINIMUM code that makes it pass. No speculative generality, no "while I'm here" parameters — YAGNI is the point.
3. REFACTOR — only on green, and only structure: remove the duplication the test just exposed (edit_file), then re-run. Red after a refactor means the refactor broke behavior — revert it.

## Triangulation (the second case)
When green feels like the code special-cased the input, add a SECOND test with a different input that forces the general solution — then generalize. Two examples triangulate the abstraction; one example hardcodes it.

## Anti-patterns — each one means STOP
- Writing the test after the code to match what it already does → STOP. That is not a test, it is a transcript.
- Deleting or skipping a failing test to go green → STOP. A red test is information.
- Weakening an assertion so the suite passes → STOP. That is lying with a green check.
- "Too small to need a test" → STOP. Then it is not a behavior change; if it IS one, it needs a test.

## Guardrails
- Read the existing suite first (search_code, read_file): match its style, runner, fixtures.
- One behavior per test; assert the error path too.
- Track the loop state with todo_write.

## Output format (fill at each step)
TEST FIRST
RED: <test name + command run + the observed failure>
GREEN: <the minimum code written + the passing receipt>
REFACTOR: <what was restructured, or "none needed">`;

export const API_DESIGN_SKILL_BODY = `# Skill: api-design

IRON LAW: THE CONTRACT IS WRITTEN BEFORE THE HANDLER. Method + path + request schema + response schema + error codes, named in a comment block — THEN the code.

## Contract first
Before any handler code, write the block below. search_code the existing routes first — the new route joins a family: match its path grammar, casing, version prefix, status-code habits. Consistency beats local taste.

## Validate at the boundary — fail closed
- Reject early, at the entry point: types checked, ranges bounded, unknown keys rejected or explicitly ignored-and-documented.
- Fail closed: bad input returns an error, never a best-guess interpretation. Silence is the enemy.
- Every input field is either validated or documented as unvalidated — no third state.

## The error envelope — one shape, everywhere
Every error, every route, the same shape: code + message + detail. A stable machine-readable code (SNAKE_CASE), a human message, optional detail. Ad-hoc error shapes are a contract breach even when the status code is right.

## Additive-only evolution
Consumers exist the moment you ship. New fields: optional, with a default. NEVER remove, rename, or repurpose a shipped field — version the route instead. A response that grew is compatible; a response that shifted is someone else's outage.

## Lists: paginate and cap
List endpoints: cursor or page params, a hard max page size, an explicit total or nextCursor — an unbounded list is a future outage.

## Verify
Exercise the route before done: run_command one happy call + one invalid call proving the 4xx envelope.

## Output format (fill before the handler)
API CONTRACT
METHOD /path — <operation in one line>
REQUEST: <fields, types, required/optional, defaults, validation>
RESPONSE: <200 shape>
ERRORS: <code — when> (envelope: code + message + detail)
COMPAT: <what existing consumers see change: nothing>`;

export const FRONTEND_CRAFT_SKILL_BODY = `# Skill: frontend-craft

IRON LAW: STATE LIVES AS CLOSE TO ITS CONSUMERS AS POSSIBLE. Lifting state is a last resort proven by actual sharing — never a preemptive architecture.

## State discipline
- Colocate: a field's value lives in its form component, not a store. Lift ONLY when distant components demonstrably read the same value — and say why at the lift site.
- Keys from STABLE IDENTITY, never array index: index keys corrupt state on reorder (the input keeps its stale value). Use the row's id; generate one if missing.
- Derived state is COMPUTED, not stored: a plain expression or memo beats a useState you must remember to update — stored derived state is a desync waiting to happen.
- Controlled inputs: value + onChange. Uncontrolled-and-read-later hides the truth until submit.

## Semantic HTML first
- A click handler on a div is a bug: use button — keyboard, focus, and disabled for free. Navigation is an anchor.
- label htmlFor the input (or wraps it). Placeholder is not a label.
- Keyboard path: every control Tab-reachable, Enter/Space operable, focus VISIBLE. Test with the keyboard, not the mouse.
- aria ONLY when semantics cannot express it; the right element usually fixes it.

## CSS discipline
- Tailwind utilities composed on the element; NO inline style for non-dynamic values (inline only for genuinely dynamic values, e.g. a computed width).
- Responsive prefixes (sm: md: lg:) over bespoke breakpoint sheets; mobile layout first.
- search_code + read_file the siblings: the existing design system wins.

## Output format (fill before the JSX)
COMPONENT PLAN
PURPOSE: <one sentence — what this component is for>
STATE: <each piece — where it lives, why there>
DERIVED: <what is computed, never stored>
PROPS: <the contract in + the events out>
A11Y: <element choices, labels, keyboard path, focus>
STYLE: <utility composition + responsive notes>`;

export const TYPESCRIPT_CRAFT_SKILL_BODY = `# Skill: typescript-craft

IRON LAW: IF A STATE IS ILLEGAL, ITS TYPE MUST MAKE IT UNREPRESENTABLE. A flag pair that can never be true together is two booleans too many.

## Model the domain
Prefer unions + literal types over flag soup: { kind: "loading" } | { kind: "error"; message: string } — not isLoading + hasError + errorMessage with their legal-but-wrong combinations. Optional fields only where absence is genuinely meaningful.

## Narrow with discriminated unions
- Tag each variant (kind/type), switch on the tag, and prove exhaustiveness: a default that assigns to never turns a missed case into a compile error.
- NEVER cast to bypass a type error. A cast is a confession: either the type is wrong (fix the type) or the value is wrong (fix the code).

## The any ban
- any is banned. At a truly dynamic boundary use unknown + a NARROWING GUARD (typeof, a validator, a type predicate) before use.
- Every cast (as / <>) carries an inline justification comment: WHY the value is what you claim. A cast without a comment is a bug with a syntax light.

## Inference vs annotation
- Annotate EXPORTED signatures — the published contract must be explicit and stable.
- Infer locals: annotation noise hides the drift that matters.

## Generics only when variance is real
A type parameter always instantiated to one type is indirection without payoff. Reach for generics when a function must preserve an input→output type relationship; otherwise concrete types.

## Verify
run_command the typecheck after signature changes (the compiler is the first reviewer); search_code call sites before changing a published signature.

## Output format (fill before code)
TYPE PLAN
DOMAIN: <the states, as a union sketch>
BOUNDARIES: <where unknown enters + the narrowing guard>
BANNED: <the casts avoided, or each with its justification>
EXPORTS: <the annotated signatures>`;

export const SECURITY_REVIEW_SKILL_BODY = `# Skill: security-review

Read the code as an attacker who has the source: what can I make it do that the author did not intend? Run this pass before shipping auth, file handling, exec, or anything user-input-touching, and whenever a diff touches paths, shells, tokens, or SQL.

## The big five — each with its exact test
1. INJECTION — SQL: parameterized statements only, never string-built queries. Commands: argument arrays, never an interpolated shell string — the payload arrives as one inert argument.
2. PATH TRAVERSAL — user-supplied paths: resolve, then check startsWith(root + path separator). Any mismatch → reject. Never normalize-and-hope.
3. SECRETS — nothing in code, logs, or commits. git_diff + search_code the change for token patterns BEFORE commit; scrub inputs from error messages and logs; keys come from env/settings, never literals.
4. AUTHZ — who may call this? Check where the DATA is fetched, not where the UI hides the button — only the server-side check counts. Per-route, not per-habit.
5. FAIL CLOSED — on error, deny. A catch block that swallows the failure and continues with defaults has converted an exception into a bypass.

## Input validation at boundaries
Every external input — HTTP body, query, headers, file contents, sub-agent reports — is validated where it enters: shape, type, length. Internal code trusts internal types; validate where trust begins.

## Output format
SECURITY VERDICT
FINDINGS: <each — SEVERITY (critical|high|medium|low), path:line, the EXACT exploit path (input → code → impact), the concrete fix>
or CLEAN: <the five checks, each named, with what was actually examined>`;

export const REFACTORING_SKILL_BODY = `# Skill: refactoring

IRON LAW: NO MOVE WITHOUT A GREEN CHARACTERIZATION TEST FIRST. If current behavior is not pinned by tests, writing those tests IS the first task — or the refactor is refused.

## The contract
- Behavior is PRESERVED. If observable behavior must change, that is not refactoring — it is a rewrite; name it, plan it, get agreement BEFORE moving (the honesty rule).
- One MECHANICAL move per step: extract the function → run; move the file → run; inline the variable → run. NEVER two unverified moves in a row — a failure must point at the one change you just made.
- Rename BEFORE restructure: renames are near-risk-free moves that make the structure obvious. Do them first, verify, then the structural move.
- Verify each step with the REAL gates (run_command): the narrowest suite over the touched area + the typecheck — both green before the next move.
- STOP when the pain is gone. "Clean" is not a destination; done is when the hurt that triggered this no longer hurts. Campsite rule: leave it cleaner, structurally only.

## The step ledger
todo_write one item per mechanical move; each verified before the next. An unverified item is an open risk, not a completed move.

## Red flags — your own excuses
- "Tests are red but that's expected mid-refactor." → STOP. Red mid-refactor means behavior changed: make it green or revert.
- "I'll run the tests when the refactor is done." → STOP. That is a rewrite with extra steps.
- "One more extract while I'm here." → STOP. Park it — one move per step.

## Output format (fill before the first move)
REFACTOR PLAN
PAIN: <what hurts, in the user's words>
SAFETY NET: <the characterization tests pinning current behavior — or what must be written first>
MOVES: <the ordered mechanical steps, one line each>
VERIFY: <per step — which suite + which typecheck command>
STOP CONDITION: <when the pain is gone — what done means>`;

const BUILTIN_SKILLS: ReadonlyArray<Pick<SkillRecord, "id" | "name" | "description" | "body" | "source" | "sortOrder">> = [
  {
    id: COMPUTER_USE_SKILL_ID,
    name: "computer-use",
    description:
      "Use when the user asks you to operate their REAL desktop apps — 'open Notepad', 'click the save button in Excel', 'close that dialog', 'type into that window' — or any task needs reading or driving an installed GUI application. Delivers accessibility-first element actions with screenshot-coordinate fallback and a post-action observation receipt after every write. NOT for web pages in the embedded browser panel (that is browser-use).",
    body: COMPUTER_USE_SKILL_BODY,
    source: "builtin",
    sortOrder: 0,
  },
  {
    id: "skill_builtin_code_review",
    name: "code-review",
    description:
      "Use when the user says 'review this diff', 'look over my changes', 'is this PR ready', 'check my work before I commit' — a change exists and needs adversarial eyes. Delivers a findings-first review scoped to the diff: every finding carries path:line and a concrete fix, ordered critical/bug/risk/style, ending in an approve or request-changes verdict. NOT for hunting one known bug (debugging) or auditing untouched code.",
    body: CODE_REVIEW_SKILL_BODY,
    source: "builtin",
    sortOrder: 1,
  },
  {
    id: "skill_builtin_debugging",
    name: "debugging",
    description:
      "Use when the user reports a defect — 'this bug', 'my test fails', 'it crashes when I click X', 'fix this error', 'why is this broken' — and the cause is unknown. Delivers the reproduce → read-the-error-fully → isolate → name the root cause in one sentence → minimal fix → verify with the failing case → regression-test loop. NOT for whole-feature multi-file repair (focused-fix) or writing new test suites (testing).",
    body: DEBUGGING_SKILL_BODY,
    source: "builtin",
    sortOrder: 2,
  },
  {
    id: "skill_builtin_testing",
    name: "testing",
    description:
      "Use when the user says 'write tests for this', 'add coverage', 'this test is flaky' — or whenever you are about to call a change done: its affected tests must actually run and pass first. Delivers the discipline: failing test first when behavior is spec'd, one behavior per test, error paths asserted, suite re-run after every edit, never a weakened assertion to go green. NOT for one-off command runs or CI pipeline setup.",
    body: TESTING_SKILL_BODY,
    source: "builtin",
    sortOrder: 3,
  },
  {
    id: "skill_builtin_git_workflow",
    name: "git-workflow",
    description:
      "Use when the user mentions commits, branches, or PRs — 'commit this', 'before I commit', 'make a branch', 'open a PR', 'what changed?' — and before you edit files (git_status first). Delivers safe git habits: the working tree belongs to the user, commit only when asked, conventional commits, explicit staging (never add -A), never revert or hard-reset uncommitted work. NOT for judging a diff's content (code-review).",
    body: GIT_WORKFLOW_SKILL_BODY,
    source: "builtin",
    sortOrder: 4,
  },
  {
    id: "skill_builtin_web_research",
    name: "web-research",
    description:
      "Use when the user says 'search the web', 'look this up', 'what's the latest version of X', 'find the docs for this API', or the answer depends on facts beyond your knowledge. Delivers sourced answers: web_search with precise technical nouns first, fetch the 2-3 most authoritative hits, prefer primary docs over blog restatements, cite fetched URLs inline, synthesize a decision — not a link dump. NOT for codebase searches (search_code).",
    body: WEB_RESEARCH_SKILL_BODY,
    source: "builtin",
    sortOrder: 5,
  },
  {
    id: "skill_builtin_project_init",
    name: "project-init",
    description:
      "Use when the user says 'set up a new project', '/init', 'write an AGENTS.md for this repo', 'onboard to this codebase', or a repo lacks its convention file. Delivers the repo's AGENTS.md (<= 150 lines) built from observed reality — stack, verified setup/build/test/lint commands, conventions, directory map, gotchas — so a fresh agent works correctly on turn one. NOT for exploring or answering questions about existing code.",
    body: PROJECT_INIT_SKILL_BODY,
    source: "builtin",
    sortOrder: 6,
  },
  {
    id: "skill_builtin_browser_use",
    name: "browser-use",
    description:
      "Use when the task is a WEB page — 'open the browser', 'go to this URL', 'log in here', 'fill in this form', 'scrape this page', 'test this site' — in the embedded browser panel the user watches live. Delivers DOM-driven control: read_dom for elements, click/type by selector (never pixel coordinates), submit:true or Enter for forms, the wait_for_verification bot-wall protocol, get_state verification. NOT for desktop apps (computer-use).",
    body: BROWSER_USE_SKILL_BODY,
    source: "builtin",
    sortOrder: 7,
  },
  {
    id: "skill_builtin_focused_fix",
    name: "focused-fix",
    description:
      "Use when a whole feature or module is broken — 'make the auth flow work', 'the export module is broken', 'fix this feature end-to-end', or the same area keeps producing bugs. Delivers the strict SCOPE → TRACE → DIAGNOSE → FIX → VERIFY contract under the Iron Law NO FIXES WITHOUT COMPLETING SCOPE → TRACE → DIAGNOSE FIRST, with 3-strike escalation when fixes cascade. NOT for a single isolated bug (debugging) or refactor requests.",
    body: FOCUSED_FIX_SKILL_BODY,
    source: "builtin",
    sortOrder: 8,
  },
  {
    id: "skill_builtin_zero_hallucination",
    name: "zero-hallucination",
    description:
      "Use when you are about to write code that calls an API, symbol, config key, or CLI flag you have NOT read in this session — and when the user says 'don't hallucinate', 'verify the real API', 'plan carefully before coding'. Delivers [KNOWN]/[ASSUMED]/[UNKNOWN] evidence tagging (never code on an UNKNOWN — read_file/search_code first), the 6-rung YAGNI ladder, and source-beats-docs, reproduction-beats-source rules. NOT for trivial edits or prose work.",
    body: ZERO_HALLUCINATION_SKILL_BODY,
    source: "builtin",
    sortOrder: 9,
  },
  {
    id: "skill_builtin_self_eval",
    name: "self-eval",
    description:
      "Use when you are about to claim work done — before any 'done', 'complete', 'it works', 'am I finished?' statement, or when the user asks 'how well did that go?'. Delivers honest self-scoring: ambition × execution (each 0-3) read from a fixed matrix — low ambition caps the total at 2 — plus a mandatory devil's-advocate line, receipts for every claim, and a 🟢🟡🔴 confidence tag that matches the evidence. NOT for reviewing someone else's code (code-review).",
    body: SELF_EVAL_SKILL_BODY,
    source: "builtin",
    sortOrder: 10,
  },
  {
    id: "skill_builtin_ship_gate",
    name: "ship-gate",
    description:
      "Use when anyone reaches a ship moment — the user says 'commit and push', 'deploy', 'release', 'ship it', 'go live', or you catch yourself declaring 'done' — before the push, deploy, or commit actually happens. Delivers the gate: CRITICAL checks (tests/lint/typecheck actually run + green, build compiles, no new console errors, no secrets committed), HIGH and ADVISORY tiers, and a DO NOT SHIP / SHIP WITH NOTES / CLEAR verdict backed by receipts. NOT for CI/CD pipeline setup or infra provisioning.",
    body: SHIP_GATE_SKILL_BODY,
    source: "builtin",
    sortOrder: 11,
  },
  {
    id: "skill_builtin_tdd",
    name: "tdd",
    description:
      "Use when the user says 'write the test first', 'TDD', 'drive this by tests', or a behavior change is spec'd but unimplemented — and before refactoring anything with no characterization tests. Delivers the RED→GREEN→REFACTOR loop discipline: write the failing test first and RUN it to see it fail, minimum code to green, refactor only on green, never a test written after the code to fit it. NOT for test-suite audits (testing) or exploratory spikes.",
    body: TDD_SKILL_BODY,
    source: "builtin",
    sortOrder: 12,
  },
  {
    id: "skill_builtin_api_design",
    name: "api-design",
    description:
      "Use when the user says 'add an endpoint', 'design the API for', 'expose this as a route', 'what should the response shape be' — any REST/HTTP surface work. Delivers the contract-first discipline: name the operation + inputs + outputs + errors BEFORE the handler, validate inputs fail-closed at the boundary, consistent error envelopes, additive-only evolution (never break a shipped field). NOT for internal function signatures or GraphQL schemas.",
    body: API_DESIGN_SKILL_BODY,
    source: "builtin",
    sortOrder: 13,
  },
  {
    id: "skill_builtin_frontend_craft",
    name: "frontend-craft",
    description:
      "Use when the user says 'build this UI', 'fix the layout', 'make this component', 'the page looks broken', 'add a form' — React/CSS/component work. Delivers the component discipline: colocate state as close to its consumers as possible, keys from stable identity (never array index), derived state computed not stored, controlled inputs, semantic HTML + labels + keyboard paths, Tailwind utility composition over custom CSS. NOT for backend logic or state-library architecture.",
    body: FRONTEND_CRAFT_SKILL_BODY,
    source: "builtin",
    sortOrder: 14,
  },
  {
    id: "skill_builtin_typescript_craft",
    name: "typescript-craft",
    description:
      "Use when you are writing or reviewing TypeScript and types are load-bearing — 'type this properly', 'fix the any', 'these types are wrong', generics/signatures/narrowing questions. Delivers the typing discipline: model the domain so illegal states are unrepresentable, narrow with discriminated unions instead of casting, never any (unknown + narrowing at truly dynamic boundaries), inference over annotation except at published boundaries. NOT for JavaScript without types or build config.",
    body: TYPESCRIPT_CRAFT_SKILL_BODY,
    source: "builtin",
    sortOrder: 15,
  },
  {
    id: "skill_builtin_security_review",
    name: "security-review",
    description:
      "Use when the user says 'is this safe', 'check for vulnerabilities', 'does this leak secrets', before shipping auth, file handling, exec, or anything touching user input — and whenever a diff touches paths, shells, tokens, or SQL. Delivers the adversarial pass: injection, path traversal, secrets in code/logs/commits, authz checked per-route where the data lives, fail-closed error handling. NOT for feature code review (code-review) or dependency CVE scans.",
    body: SECURITY_REVIEW_SKILL_BODY,
    source: "builtin",
    sortOrder: 16,
  },
  {
    id: "skill_builtin_refactoring",
    name: "refactoring",
    description:
      "Use when the user says 'clean this up', 'refactor', 'simplify this module', 'extract this', or the same code hurts three times — WITHOUT behavior change. Delivers the behavior-preserving discipline: characterization tests green BEFORE the first move, one mechanical move per commit-sized step, rename before restructure, verify each step (tests + typecheck), stop when the pain is gone. NOT for bug fixes (debugging) or rewrites (a rewrite is a new module, say so).",
    body: REFACTORING_SKILL_BODY,
    source: "builtin",
    sortOrder: 17,
  },
];

/** Seed built-in skills once per database open (INSERT OR IGNORE). */
export function seedBuiltinSkills(db: SqliteDatabase): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO skills (id, name, description, body, source, enabled, sort_order, created_at, updated_at)
     VALUES (@id, @name, @description, @body, @source, 1, @sortOrder, @createdAt, @createdAt)`,
  );
  const createdAt = new Date().toISOString();
  db.transaction(() => {
    for (const skill of BUILTIN_SKILLS) {
      insert.run({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        body: skill.body,
        source: skill.source,
        sortOrder: skill.sortOrder,
        createdAt,
      });
    }
  })();
}

const SELECT_SKILLS = `SELECT * FROM skills ORDER BY enabled DESC, sort_order ASC, name ASC`;

export function listSkills(db: SqliteDatabase): SkillRecord[] {
  return (db.prepare(SELECT_SKILLS).all() as SkillRow[]).map(toSkill);
}

export function getSkill(db: SqliteDatabase, id: string): SkillRecord | undefined {
  const row = db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as SkillRow | undefined;
  return row ? toSkill(row) : undefined;
}

/** Enabled skills only — what the prompt lists + read_skill exposes. */
export function listEnabledSkills(db: SqliteDatabase): SkillRecord[] {
  return (db.prepare(`${SELECT_SKILLS} `).all() as SkillRow[])
    .map(toSkill)
    .filter((s) => s.enabled);
}

export interface SkillInput {
  name: string;
  description?: string;
  body?: string;
  enabled?: boolean;
  sortOrder?: number;
}

/** Tool-name grammar reused for skill names: a lowercase slug. Exported
 * for skills-files.ts (file-based skill validation shares the contract). */
export const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function createSkill(db: SqliteDatabase, input: SkillInput): SkillRecord {
  const name = input.name.trim();
  if (!NAME_RE.test(name)) {
    throw new Error("skill name must be a lowercase slug (letters, digits, dashes; 2-64 chars)");
  }
  const existing = db.prepare("SELECT id FROM skills WHERE name = ?").get(name);
  if (existing !== undefined) {
    throw new Error(`a skill named '${name}' already exists`);
  }
  const id = `skill_${name.replace(/-/g, "_")}_${Date.now().toString(36)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO skills (id, name, description, body, source, enabled, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    (input.description ?? "").slice(0, 500),
    (input.body ?? "").slice(0, 60000),
    input.enabled === false ? 0 : 1,
    input.sortOrder ?? 100,
    now,
    now,
  );
  return getSkill(db, id) as SkillRecord;
}

export interface SkillPatch {
  name?: string;
  description?: string;
  body?: string;
  enabled?: boolean;
  sortOrder?: number;
}

export function updateSkill(db: SqliteDatabase, id: string, patch: SkillPatch): SkillRecord | undefined {
  const existing = getSkill(db, id);
  if (existing === undefined) return undefined;
  const now = new Date().toISOString();
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!NAME_RE.test(name)) {
      throw new Error("skill name must be a lowercase slug (letters, digits, dashes; 2-64 chars)");
    }
    const clash = db.prepare("SELECT id FROM skills WHERE name = ? AND id != ?").get(name, id);
    if (clash !== undefined) {
      throw new Error(`a skill named '${name}' already exists`);
    }
  }
  db.prepare(
    `UPDATE skills SET
      name = ?, description = ?, body = ?, enabled = ?, sort_order = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.name?.trim() ?? existing.name,
    (patch.description ?? existing.description).slice(0, 500),
    (patch.body ?? existing.body).slice(0, 60000),
    (patch.enabled ?? existing.enabled) ? 1 : 0,
    patch.sortOrder ?? existing.sortOrder,
    now,
    id,
  );
  return getSkill(db, id);
}

/** Built-ins refuse deletion (disable instead — the honest contract). */
export function deleteSkill(db: SqliteDatabase, id: string): { ok: boolean; note?: string } {
  const existing = getSkill(db, id);
  if (existing === undefined) return { ok: false, note: "no such skill" };
  if (existing.source === "builtin") {
    return {
      ok: false,
      note: "built-in skills can be disabled or edited, but not deleted (the seed would recreate them)",
    };
  }
  db.prepare("DELETE FROM skills WHERE id = ?").run(id);
  return { ok: true };
}
